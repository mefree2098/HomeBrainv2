const WebSocket = require('ws');
const crypto = require('node:crypto');
const net = require('node:net');
const VoiceDevice = require('../models/VoiceDevice');
const VoiceCommand = require('../models/VoiceCommand');
const UserProfile = require('../models/UserProfile');
const wakeWordAssets = require('../utils/wakeWordAssets');
const WakeWordModel = require('../models/WakeWordModel');
const speechService = require('../services/speechService');
const voiceCommandService = require('../services/voiceCommandService');
const settingsService = require('../services/settingsService');
const voiceAcknowledgmentService = require('../services/voiceAcknowledgmentService');
const { validateDeviceCredentials } = require('../services/voiceDeviceLifecycleService');
const reachyMiniService = require('../services/reachyMiniService');

console.log('voiceWebSocket.js loaded with enhanced logging');

const MAX_AUDIO_SESSION_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.HOMEBRAIN_VOICE_AUDIO_SESSION_MAX_BYTES || 20 * 1024 * 1024)
);
const MAX_VOICE_WEBSOCKET_PAYLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_WAKE_WORD_MIN_RMS = 0.004;
const MAX_WAKE_WORD_MIN_RMS = 0.2;
const REACHY_CAPTURE_GRANT_TTL_MS = 7000;
const REACHY_WAKE_TIMESTAMP_MAX_SKEW_MS = 30000;
const REACHY_AUDIO_SESSION_MAX_MS = 30000;
const REACHY_AUDIO_SESSION_MAX_BYTES = 16000 * 2 * 30;
const REACHY_AUDIO_MAX_SEQUENCE = 100000;

function normalizeWakeWordMinRms(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return DEFAULT_WAKE_WORD_MIN_RMS;
  }
  return Math.min(Math.max(numericValue, DEFAULT_WAKE_WORD_MIN_RMS), MAX_WAKE_WORD_MIN_RMS);
}

function redactMessageForLog(message = {}) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return {};
  const redacted = {};
  for (const key of [
    'type',
    'action',
    'status',
    'requestId',
    'commandId',
    'sessionId',
    'sequence',
    'isStart',
    'isFinal',
    'sampleRate',
    'channels',
    'format',
    'timestamp'
  ]) {
    if (['string', 'number', 'boolean'].includes(typeof message[key])) redacted[key] = message[key];
  }
  for (const key of ['registrationCode', 'deviceToken', 'claimToken', 'authorization']) {
    if (Object.prototype.hasOwnProperty.call(message, key)) redacted[key] = '[redacted secret]';
  }
  if (typeof message.audioData === 'string') {
    redacted.audioBytesApprox = Math.floor(message.audioData.length * 3 / 4);
    redacted.audioData = '[redacted audio]';
  }
  for (const key of ['command', 'text', 'transcript', 'originalText', 'processedText', 'responseText']) {
    if (typeof message[key] === 'string') redacted[key] = '[redacted text]';
  }
  return redacted;
}

function sanitizeRemoteAudioConfig(value = {}) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const next = {};
  const copyString = (key) => {
    if (typeof value[key] !== 'string') {
      return;
    }
    const trimmed = value[key].trim();
    if (trimmed) {
      next[key] = trimmed.slice(0, 200);
    }
  };

  for (const key of [
    'recordingDevice',
    'microphoneDevice',
    'preferredInputName',
    'playbackDevice',
    'recorder',
    'recordProgram',
    'audioType'
  ]) {
    copyString(key);
  }

  if (typeof value.sampleRate === 'number' && Number.isFinite(value.sampleRate)) {
    next.sampleRate = Math.max(8000, Math.min(48000, Math.round(value.sampleRate)));
  }
  if (typeof value.channels === 'number' && Number.isFinite(value.channels)) {
    next.channels = Math.max(1, Math.min(2, Math.round(value.channels)));
  }
  if (typeof value.threshold === 'number' && Number.isFinite(value.threshold)) {
    next.threshold = Math.max(0, Math.min(1, value.threshold));
  }

  return Object.keys(next).length > 0 ? next : null;
}

class VoiceWebSocketServer {
  constructor() {
    this.wss = null;
    this.deviceConnections = new Map(); // deviceId -> WebSocket connection
    this.pendingConnections = new Map(); // WebSocket -> pre-auth connection
    this.messageChains = new Map(); // deviceId -> serialized inbound generation queue
    this.heartbeatInterval = 30000; // 30 seconds
    this.heartbeatTimer = null;
    this.audioSessions = new Map(); // deviceId -> audio capture session
    this.settingsCache = { value: null, fetchedAt: 0 };
    this.profileCache = { value: null, fetchedAt: 0 };
    this.upgradeHandlers = [];
    this.reachyCaptureGrantTtlMs = REACHY_CAPTURE_GRANT_TTL_MS;
    this.reachyWakeTimestampMaxSkewMs = REACHY_WAKE_TIMESTAMP_MAX_SKEW_MS;
    this.reachyAudioSessionMaxMs = REACHY_AUDIO_SESSION_MAX_MS;
    this.reachyAudioSessionMaxBytes = REACHY_AUDIO_SESSION_MAX_BYTES;
  }

  initialize(server) {
    if (!this.wss) {
      console.log('Initializing Voice WebSocket Server');

      this.wss = new WebSocket.Server({
        noServer: true,
        maxPayload: MAX_VOICE_WEBSOCKET_PAYLOAD_BYTES,
        verifyClient: (info) => {
          const url = new URL(info.req.url, `http://${info.req.headers.host}`);
          let deviceId = url.searchParams.get('deviceId');

          if (!deviceId) {
            const segments = url.pathname.split('/').filter(Boolean);
            if (segments.length >= 2 && segments[segments.length - 2] === 'voice-device') {
              deviceId = segments[segments.length - 1];
            }
          }

          if (!deviceId || deviceId.length !== 24) {
            console.warn('WebSocket connection rejected: Invalid device ID');
            return false;
          }

          // Attach deviceId to request for later use
          info.req.deviceId = deviceId;

          return true;
        }
      });

      this.wss.on('connection', (ws, req) => {
        console.log('voiceWebSocket.js instrumentation active - connection handler invoked');
        this.handleConnection(ws, req);
      });

      // Start heartbeat monitoring
      this.startHeartbeat();

      console.log('Voice WebSocket Server initialized successfully');
    }

    if (!server || typeof server.on !== 'function') {
      return;
    }

    const upgradeHandler = (request, socket, head) => {
      let pathname;
      try {
        const base = request.headers?.host
          ? `http://${request.headers.host}`
          : 'http://localhost';
        pathname = new URL(request.url, base).pathname;
      } catch (error) {
        socket.destroy();
        return;
      }

      if (!pathname.startsWith('/ws/voice-device')) {
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    };

    server.on('upgrade', upgradeHandler);
    this.upgradeHandlers.push({ server, upgradeHandler });
  }

  async handleConnection(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let deviceId = req.deviceId || url.searchParams.get('deviceId');

    if (!deviceId) {
      const segments = url.pathname.split('/').filter(Boolean);
      deviceId = segments.pop();
    }

    console.log(`Voice device WebSocket connection established: ${deviceId}`);

    const pendingMessages = [];
    let connectionRegistered = false;
    let socketClosed = false;

    const processMessage = (message) => {
      try {
        const parsed = JSON.parse(message.toString());
        console.log('WebSocket message event for voice device', {
          deviceId,
          message: redactMessageForLog(parsed)
        });
      } catch (logError) {
        console.warn('Failed to parse voice device websocket message for logging', {
          deviceId,
          error: logError.message
        });
      }

      if (!connectionRegistered) {
        pendingMessages.push(message);
        console.log('Queued early voice device websocket message until connection setup completes', { deviceId });
        return;
      }

      console.log('Queueing voice device websocket message for processing', { deviceId });
      void this.enqueueMessage(deviceId, message, ws);
    };

    // Attach handlers before any async work so fast clients do not lose their
    // first authenticate message while the device record is loading.
    ws.on('message', processMessage);

    ws.on('close', (code, reason) => {
      socketClosed = true;
      this.handleDisconnection(deviceId, code, reason, ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error for voice device', {
        deviceId,
        error: error?.message || error
      });
      this.handleDisconnection(deviceId, 1006, 'Connection error', ws);
    });

    ws.on('pong', () => {
      const connection = this.deviceConnections.get(deviceId);
      if (connection && connection.ws === ws) {
        connection.lastPing = Date.now();
      }
    });

    try {
      // Verify device exists in database
      const device = await VoiceDevice.findById(deviceId);
      if (!device) {
        console.warn(`WebSocket connection rejected: Device not found ${deviceId}`);
        ws.close(1008, 'Device not found');
        return;
      }

      if (socketClosed || ws.readyState === WebSocket.CLOSED) {
        console.warn('WebSocket connection closed before setup completed for voice device', { deviceId });
        return;
      }

      // Store connection
      const socketPeerAddress = String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, '');
      const forwardedAddresses = String(req.headers?.['x-forwarded-for'] || '')
        .split(',')
        .map((entry) => entry.trim().replace(/^::ffff:/i, ''))
        .filter(Boolean);
      // Only a loopback reverse proxy is trusted, and append-style proxy
      // chains are read from the right. A client-controlled leading XFF value
      // can never become the daemon orchestration address.
      const forwardedPeerAddress = forwardedAddresses.at(-1) || '';
      const peerAddress = ['127.0.0.1', '::1'].includes(socketPeerAddress) && net.isIP(forwardedPeerAddress)
        ? forwardedPeerAddress
        : socketPeerAddress;
      const pendingConnection = {
        ws: ws,
        deviceId,
        device: device,
        peerAddress,
        lastPing: Date.now(),
        authenticated: false,
        credentials: null,
        deviceInfo: null,
        pendingWakeWord: null,
        captureGrant: null
      };
      pendingConnection.generation = crypto.randomUUID();
      pendingConnection.revoked = false;
      this.pendingConnections.set(ws, pendingConnection);
      connectionRegistered = true;

      // Send welcome message
      this.sendToConnection(pendingConnection, {
        type: 'welcome',
        deviceId: deviceId,
        timestamp: new Date().toISOString()
      });

      while (pendingMessages.length > 0) {
        const pendingMessage = pendingMessages.shift();
        console.log('Processing queued early voice device websocket message', { deviceId });
        void this.enqueueMessage(deviceId, pendingMessage, ws);
      }

      console.log(`Voice device ${device.name} connected; waiting for authentication`);

    } catch (error) {
      console.error(`Error handling WebSocket connection for ${deviceId}:`, error);
      ws.close(1011, 'Server error');
    }
  }

  enqueueMessage(deviceId, rawMessage, sourceWs) {
    const id = String(deviceId);
    const previous = this.messageChains.get(id) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.handleMessage(id, rawMessage, sourceWs));
    this.messageChains.set(id, current);
    void current.finally(() => {
      if (this.messageChains.get(id) === current) this.messageChains.delete(id);
    });
    return current;
  }

  async waitForDeviceMessages(deviceId) {
    const pending = this.messageChains.get(String(deviceId));
    if (pending) await pending.catch(() => {});
  }

  isCurrentAuthenticatedConnection(deviceId, connection) {
    return Boolean(
      connection
      && connection.authenticated === true
      && connection.revoked !== true
      && this.deviceConnections.get(String(deviceId)) === connection
      && (!connection.ws || connection.ws.readyState === WebSocket.OPEN)
    );
  }

  async buildWakeWordConfig(device, credentials = {}, deviceInfo = {}) {
    if (typeof credentials === 'string') {
      credentials = { registrationCode: credentials };
    }

    const deviceId = device._id.toString();
    const platform = deviceInfo.platform || null;
    const arch = deviceInfo.arch || null;
    const defaultThreshold = typeof device.settings?.wakeWordThreshold === 'number'
      ? device.settings.wakeWordThreshold
      : 0.55;

    const assets = wakeWordAssets.getAssetsForWakeWords(device.supportedWakeWords, {
      platform,
      arch,
      allowGeneric: true,
      threshold: defaultThreshold
    });

    const clampValue = (value, min, max) => Math.min(Math.max(value, min), max);

    const metadataBySlug = {};
    try {
      const slugs = assets.map((asset) => asset.slug);
      if (slugs.length) {
        const models = await WakeWordModel.find({ slug: { $in: slugs } });
        for (const model of models) {
          metadataBySlug[model.slug] = model.metadata || {};
        }
      }
    } catch (error) {
      console.warn(`Failed to load wake word metadata for device ${device.name}:`, error.message);
    }

    const wakeWordAssetPayload = assets.map((asset) => {
      const buildAssetUrl = (dependencyFileName = null) => {
        const params = new URLSearchParams();
        if (dependencyFileName) {
          params.set('dependency', dependencyFileName);
        }
        if (!credentials.deviceToken && credentials.registrationCode) {
          params.set('code', credentials.registrationCode);
        } else if (!credentials.deviceToken && credentials.claimToken) {
          params.set('claim', credentials.claimToken);
        }
        if (asset.platform || platform) {
          params.set('platform', asset.platform || platform);
        }
        if (asset.arch || arch) {
          params.set('arch', asset.arch || arch);
        }
        return params.toString()
          ? `/api/remote-devices/${deviceId}/wake-words/${asset.slug}?${params.toString()}`
          : `/api/remote-devices/${deviceId}/wake-words/${asset.slug}`;
      };

      const modelMetadata = metadataBySlug[asset.slug] || {};
      const rawThreshold = typeof asset.threshold === 'number'
        ? asset.threshold
        : typeof modelMetadata.threshold === 'number'
          ? modelMetadata.threshold
          : defaultThreshold;
      const rawSensitivity = typeof asset.sensitivity === 'number'
        ? asset.sensitivity
        : typeof modelMetadata.recommendedSensitivity === 'number'
          ? modelMetadata.recommendedSensitivity
          : undefined;

      return {
        label: asset.label,
        slug: asset.slug,
        fileName: asset.fileName,
        checksum: asset.checksum,
        size: asset.size,
        sensitivity: rawSensitivity != null ? clampValue(rawSensitivity, 0, 1) : undefined,
        threshold: clampValue(rawThreshold, 0, 1),
        engine: asset.engine || 'openwakeword',
        format: asset.format,
        updatedAt: asset.updatedAt,
        dependencies: Array.isArray(asset.dependencies) ? asset.dependencies.map((dependency) => ({
          fileName: dependency.fileName,
          checksum: dependency.checksum,
          size: dependency.size,
          updatedAt: dependency.updatedAt,
          downloadUrl: buildAssetUrl(dependency.fileName)
        })) : [],
        metadata: modelMetadata,
        downloadUrl: buildAssetUrl()
      };
    });

    const debounceMs = typeof device.settings?.wakeWordDebounceMs === 'number'
      ? device.settings.wakeWordDebounceMs
      : 1500;
    const vadSettings = device.settings?.wakeWordVad || {};
    const audioSettings = sanitizeRemoteAudioConfig(device.settings?.audio);

    return {
      config: {
        wakeWords: device.supportedWakeWords,
        wakeWord: {
          enabled: device.supportedWakeWords,
          assets: wakeWordAssetPayload,
          debounceMs,
          vad: {
            speechThreshold: typeof vadSettings.speechThreshold === 'number'
              ? clampValue(vadSettings.speechThreshold, 0, 1)
              : 0.35,
            history: typeof vadSettings.history === 'number'
              ? Math.max(1, Math.min(32, Math.round(vadSettings.history)))
              : 8,
            minActivations: typeof vadSettings.minActivations === 'number'
              ? Math.max(1, Math.round(vadSettings.minActivations))
              : 1,
            mode: typeof vadSettings.mode === 'number'
              ? Math.max(0, Math.min(3, Math.round(vadSettings.mode)))
              : 3,
            minRms: normalizeWakeWordMinRms(vadSettings.minRms)
          }
        },
        volume: device.volume,
        microphoneSensitivity: device.microphoneSensitivity,
        ...(audioSettings ? { audio: audioSettings } : {}),
        settings: {
          audioSampleRate: 16000,
          audioChannels: 1,
          wakeWordThreshold: defaultThreshold,
          wakeWordEngine: 'openwakeword'
        }
      },
      assets
    };
  }

  async handleMessage(deviceId, rawMessage, sourceWs = null) {
    const activeConnection = this.deviceConnections.get(deviceId);
    const connection = sourceWs
      ? (activeConnection?.ws === sourceWs ? activeConnection : this.pendingConnections.get(sourceWs))
      : activeConnection;

    if (!connection) {
      console.warn(`Received message from unconnected or superseded device socket: ${deviceId}`);
      sourceWs?.close?.(1008, 'Superseded connection');
      return;
    }

    try {
      const message = JSON.parse(rawMessage.toString());
      if (sourceWs && connection.ws !== sourceWs) {
        console.warn(`Rejected message from superseded voice-device socket: ${deviceId}`);
        sourceWs.close?.(1008, 'Superseded connection');
        return;
      }

      console.log(`WebSocket message from ${deviceId}:`, message.type);

      if (message.type !== 'authenticate' && !connection.authenticated) {
        console.warn(`Rejected unauthenticated ${message.type || 'unknown'} message from device ${deviceId}`);
        this.sendToConnection(connection, {
          type: 'auth_failed',
          message: 'Device authentication required'
        });
        return;
      }

      switch (message.type) {
        case 'authenticate':
          await this.handleAuthentication(deviceId, message, connection);
          break;

        case 'heartbeat':
          await this.handleHeartbeat(deviceId, message, connection);
          break;

        case 'wake_word_detected':
          await this.handleWakeWordDetection(deviceId, message, connection);
          break;

        case 'voice_command':
          await this.handleVoiceCommand(deviceId, message, connection);
          break;

        case 'audio_data':
          await this.handleAudioData(deviceId, message, connection);
          break;

        case 'status_update':
          await this.handleStatusUpdate(deviceId, message, connection);
          break;

        case 'update_status':
          if (connection?.device?.deviceType === 'robot' && message.action === 'prepare_update') {
            reachyMiniService.handleUpdateStatus(deviceId, message);
          } else {
            await this.handleUpdateStatus(deviceId, message, connection);
          }
          break;

        case 'robot_capabilities':
          await reachyMiniService.handleCapabilities(deviceId, message);
          break;

        case 'robot_state':
          await reachyMiniService.handleRobotState(deviceId, message);
          break;

        case 'robot_event':
          await reachyMiniService.handleRobotEvent(deviceId, message);
          break;

        case 'robot_command_result':
          await reachyMiniService.handleCommandResult(deviceId, message);
          break;

        case 'app_management_result':
          await reachyMiniService.handleAppManagementResult(deviceId, message);
          break;

        case 'error':
          await this.handleDeviceError(deviceId, message, connection);
          break;

        default:
          console.warn(`Unknown message type from device ${deviceId}: ${message.type}`);
      }

    } catch (error) {
      console.error(`Error processing message from device ${deviceId}:`, error);
      console.error('Failed message type could not be processed safely');
      this.sendToConnection(connection, {
        type: 'error',
        message: 'Failed to process message'
      });
    }
  }

  async handleAuthentication(deviceId, message, sourceConnection = null) {
    const connection = sourceConnection || this.deviceConnections.get(deviceId);
    if (!connection) return;

    const { registrationCode, claimToken, deviceToken, deviceInfo = {} } = message;

    try {
      const device = await VoiceDevice.findById(deviceId);
      if (!device) {
        this.sendToConnection(connection, {
          type: 'auth_failed',
          message: 'Device not found'
        });
        connection.ws?.close?.(1008, 'Device not found');
        return;
      }

      const credentialAccess = validateDeviceCredentials(device, {
        registrationCode,
        claimToken,
        deviceToken
      });

      if (!credentialAccess.authorized) {
        console.warn(`Authentication failed for device ${deviceId}: Invalid device credentials`);
        this.sendToConnection(connection, {
          type: 'auth_failed',
          message: 'Invalid device credentials'
        });
        connection.ws?.close?.(1008, 'Invalid device credentials');
        return;
      }

      const authenticatedCredentials = {
        registrationCode: credentialAccess.method === 'registrationCode' ? registrationCode : '',
        claimToken: credentialAccess.method === 'claimToken' ? claimToken : '',
        deviceToken: credentialAccess.method === 'deviceToken' ? deviceToken : ''
      };

      // A robot credential is bound to one physical Reachy identity. Complete
      // the atomic first-bind/match check before authentication state changes
      // or auth_success is observable; identity errors are fail-closed.
      let authenticatedDevice = device;
      if (device.deviceType === 'robot') {
        try {
          authenticatedDevice = await reachyMiniService.handleConnected(deviceId, {
            ...deviceInfo,
            peerAddress: connection.peerAddress || null
          });
        } catch (reachyError) {
          connection.authenticated = false;
          connection.credentials = null;
          connection.deviceInfo = null;
          connection.pendingWakeWord = null;
          connection.captureGrant = null;
          this.audioSessions.delete(deviceId);
          console.error(`Rejected Reachy identity during authentication for ${deviceId}:`, reachyError.message);
          this.sendToConnection(connection, {
            type: 'auth_failed',
            code: reachyError.code || 'REACHY_IDENTITY_REJECTED',
            message: 'Reachy hardware identity verification failed'
          });
          connection.ws?.close?.(1008, 'Reachy identity rejected');
          return;
        }
      }

      const authUpdate = {
        status: 'online',
        lastSeen: new Date()
      };
      if (
        device.deviceType !== 'robot'
        && typeof deviceInfo?.version === 'string'
        && deviceInfo.version.trim().length > 0
      ) {
        authUpdate.firmwareVersion = deviceInfo.version.trim();
      }
      const refreshedDevice = await VoiceDevice.findByIdAndUpdate(
        deviceId,
        authUpdate,
        { returnDocument: 'after' }
      );
      if (refreshedDevice) {
        connection.device = refreshedDevice;
        authenticatedDevice = refreshedDevice;
      }

      console.log(`Authenticating device ${deviceId} (${device.name})`);

      const { config, assets } = await this.buildWakeWordConfig(authenticatedDevice, authenticatedCredentials, deviceInfo);
      if (device.deviceType === 'robot') {
        config.robot = reachyMiniService.buildRobotConfig(authenticatedDevice);
      }

      if (!assets.length) {
        console.warn(`No wake word assets available for device ${device.name}. Ensure files exist in server/public/wake-words.`);
      } else {
        const assetLabels = assets.map((asset) => `${asset.label}:${asset.fileName}`).join(', ');
        console.log(`Resolved ${assets.length} wake word asset(s) for ${device.name}: ${assetLabels}`);
      }

      console.log(`Sending auth_success to ${deviceId} with ${assets.length} wake word asset(s)`);

      const activeSource = this.deviceConnections.get(deviceId) === connection;
      const pendingSource = this.pendingConnections.get(connection.ws) === connection;
      if ((!activeSource && !pendingSource) || connection.ws?.readyState !== WebSocket.OPEN) {
        console.warn(`Discarding completed authentication for closed or superseded socket: ${deviceId}`);
        return;
      }

      // Credentials may be rotated while identity checks/config generation are
      // awaiting I/O. Re-read the durable record immediately before promotion;
      // a reissued token can never authenticate from a stale object snapshot.
      const promotionDevice = await VoiceDevice.findById(deviceId);
      const promotionAccess = validateDeviceCredentials(promotionDevice, {
        registrationCode,
        claimToken,
        deviceToken
      });
      if (!promotionAccess.authorized || promotionAccess.method !== credentialAccess.method) {
        connection.authenticated = false;
        connection.credentials = null;
        connection.deviceInfo = null;
        connection.pendingWakeWord = null;
        connection.captureGrant = null;
        this.audioSessions.delete(deviceId);
        this.sendToConnection(connection, {
          type: 'auth_failed',
          message: 'Device credentials changed during authentication'
        });
        connection.ws?.close?.(1008, 'Device credentials changed');
        return;
      }
      const stillActiveSource = this.deviceConnections.get(deviceId) === connection;
      const stillPendingSource = this.pendingConnections.get(connection.ws) === connection;
      if ((!stillActiveSource && !stillPendingSource) || connection.ws?.readyState !== WebSocket.OPEN) {
        console.warn(`Discarding authentication after credential revalidation for closed socket: ${deviceId}`);
        return;
      }

      connection.deviceInfo = deviceInfo;
      connection.credentials = authenticatedCredentials;
      connection.device = promotionDevice || authenticatedDevice;
      connection.authenticated = true;
      const previousConnection = this.deviceConnections.get(deviceId);
      this.deviceConnections.set(deviceId, connection);
      this.pendingConnections.delete(connection.ws);
      this.sendToConnection(connection, {
        type: 'auth_success',
        config
      });
      if (previousConnection && previousConnection !== connection) {
        previousConnection.authenticated = false;
        previousConnection.credentials = null;
        previousConnection.pendingWakeWord = null;
        previousConnection.captureGrant = null;
        previousConnection.ws?.close?.(1008, 'Superseded connection');
      }

      console.log(`Device ${device.name} authenticated successfully`);

    } catch (error) {
      console.error(`Authentication error for device ${deviceId}:`, error);
      connection.authenticated = false;
      connection.credentials = null;
      connection.deviceInfo = null;
      connection.pendingWakeWord = null;
      connection.captureGrant = null;
      this.audioSessions.delete(deviceId);
      this.sendToConnection(connection, {
        type: 'auth_failed',
        message: 'Authentication error'
      });
      connection.ws?.close?.(1008, 'Authentication failed');
    }
  }

  async broadcastWakeWordUpdate(model) {
    try {
      const phrase = typeof model === 'string' ? model : model?.phrase;
      if (!phrase) {
        console.warn('broadcastWakeWordUpdate called without a valid phrase');
        return;
      }

      const devices = await VoiceDevice.find({
        wakeWordSupport: true,
        supportedWakeWords: { $in: [phrase] }
      });

      for (const device of devices) {
        const deviceId = device._id.toString();
        const connection = this.deviceConnections.get(deviceId);
        if (!connection || !connection.authenticated) {
          continue;
        }

        const credentials = connection.credentials || {};
        if (!credentials.registrationCode && !credentials.claimToken && !credentials.deviceToken) {
          console.warn(`Cannot send wake word update to ${device.name}: missing authenticated credentials`);
          continue;
        }

        try {
          const { config, assets } = await this.buildWakeWordConfig(device, credentials, connection.deviceInfo || {});
          console.log(`Dispatching config_update to ${deviceId} for wake word "${phrase}" with ${assets.length} asset(s)`);
          this.sendMessage(deviceId, {
            type: 'config_update',
            config
          });
        } catch (configError) {
          console.error(`Failed to build wake word config for device ${deviceId}:`, configError);
        }
      }
    } catch (error) {
      console.error('Failed to broadcast wake word update:', error);
    }
  }

  async handleHeartbeat(deviceId, message, sourceConnection = null) {
    const { status, batteryLevel, uptime, firmwareVersion } = message;
    const connection = sourceConnection || this.deviceConnections.get(deviceId);
    if (!this.isCurrentAuthenticatedConnection(deviceId, connection)) return;

    try {
      const updateData = {
        lastSeen: new Date(),
        ...(status && { status }),
        ...(typeof batteryLevel === 'number' && { batteryLevel }),
        ...(typeof uptime === 'number' && { uptime })
      };
      if (typeof firmwareVersion === 'string' && firmwareVersion.trim().length > 0) {
        updateData.firmwareVersion = firmwareVersion.trim();
      }

      await VoiceDevice.findByIdAndUpdate(deviceId, updateData);

      if (!this.isCurrentAuthenticatedConnection(deviceId, connection)) return;
      if (connection?.device?.deviceType === 'robot' && message.robotState && typeof message.robotState === 'object') {
        await reachyMiniService.handleRobotState(deviceId, { state: message.robotState });
      }

      this.sendToConnection(connection, {
        type: 'heartbeat_ack',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error(`Heartbeat error for device ${deviceId}:`, error);
    }
  }

  async handleWakeWordDetection(deviceId, message, sourceConnection = null) {
    const connection = sourceConnection || this.deviceConnections.get(deviceId);
    if (!connection || !connection.authenticated) return;
    if (!this.isReachyVoiceInputAllowed(connection)) {
      this.clearRejectedReachyAudio(deviceId, connection);
      return;
    }

    const { wakeWord, confidence, timestamp } = message;
    const isReachy = connection.device?.deviceType === 'robot';
    const normalizeWakePhrase = (value) => String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
    const normalizedWake = normalizeWakePhrase(wakeWord || (isReachy ? '' : 'anna'));
    const serverNow = Date.now();
    let clientTimestamp = timestamp == null ? null : new Date(timestamp);
    if (isReachy) {
      connection.captureGrant = null;
      connection.pendingWakeWord = null;
      const supportedWakeWords = Array.isArray(connection.device?.supportedWakeWords)
        ? connection.device.supportedWakeWords.map(normalizeWakePhrase).filter(Boolean)
        : [];
      const thresholdValue = connection.device?.settings?.wakeWordThreshold;
      const threshold = Number.isFinite(thresholdValue)
        ? Math.max(0, Math.min(1, thresholdValue))
        : 0.55;
      const validTimestamp = clientTimestamp instanceof Date
        && Number.isFinite(clientTimestamp.getTime())
        && Math.abs(serverNow - clientTimestamp.getTime()) <= this.reachyWakeTimestampMaxSkewMs;
      if (
        !normalizedWake
        || !supportedWakeWords.includes(normalizedWake)
        || typeof confidence !== 'number'
        || !Number.isFinite(confidence)
        || confidence < 0
        || confidence > 1
        || confidence < threshold
        || !validTimestamp
      ) {
        console.warn('Rejected invalid Reachy wake-word telemetry', {
          deviceId,
          phraseSupported: supportedWakeWords.includes(normalizedWake),
          confidenceValid: typeof confidence === 'number' && Number.isFinite(confidence),
          thresholdMet: typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= threshold,
          timestampValid: validTimestamp
        });
        return;
      }
    }
    if (!(clientTimestamp instanceof Date) || !Number.isFinite(clientTimestamp.getTime())) {
      clientTimestamp = null;
    }
    // Client time is telemetry only. Authorization and persisted event ordering
    // use the hub clock so a compromised or drifting robot clock cannot extend a
    // capture window or backdate household audio.
    const eventTimestamp = new Date(serverNow);
    const displayWake = typeof wakeWord === 'string' && wakeWord.trim().length > 0
      ? wakeWord.trim()
      : normalizedWake;
    const safeConfidence = typeof confidence === 'number' && Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : null;

    console.log('Wake word detected by voice device', {
      deviceId,
      confidence: safeConfidence
    });

    try {
      // Persist a minimal, schema-compliant VoiceCommand record for wake word events
      const original = `[WAKE_WORD] ${normalizedWake}`;
      const sourceRoom = connection.device?.room || 'unknown';

      const voiceCommand = new VoiceCommand({
        deviceId: deviceId,
        originalText: original,
        processedText: original,
        wakeWord: ['anna', 'henry', 'home-brain', 'computer'].includes(normalizedWake) ? normalizedWake : 'custom',
        sourceRoom,
        intent: {
          action: 'system_control',
          confidence: safeConfidence ?? 1.0,
          entities: {}
        },
        execution: {
          status: 'success',
          startedAt: eventTimestamp,
          completedAt: eventTimestamp
        },
        llmProcessing: {
          provider: 'local',
          model: 'wakeword',
          prompt: '',
          rawResponse: '',
          processingTime: 0,
          tokensUsed: { input: 0, output: 0, total: 0 }
        },
        response: {
          text: 'Wake word detected',
          playedAt: eventTimestamp,
          responseTime: 0
        }
      });

      await voiceCommand.save();

      // Update device last interaction
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        lastInteraction: eventTimestamp,
        lastWakeWord: displayWake,
        lastWakeWordAt: eventTimestamp,
        ...(safeConfidence !== null ? { lastWakeWordConfidence: safeConfidence } : {})
      });

      if (this.deviceConnections.get(deviceId) !== connection || !connection.authenticated) {
        this.clearRejectedReachyAudio(deviceId, connection);
        return;
      }

      connection.pendingWakeWord = {
        wakeWord: normalizedWake,
        timestamp: eventTimestamp,
        clientTimestamp
      };
      if (isReachy) {
        connection.captureGrant = {
          id: crypto.randomUUID(),
          issuedAt: serverNow,
          expiresAt: serverNow + this.reachyCaptureGrantTtlMs,
          wakeWord: normalizedWake
        };
      }

      // A Reachy grant becomes observable only after both event persistence and
      // device-state persistence succeed. The grant is short-lived, server-time
      // based, and consumed by exactly one text or audio capture start.
      const acknowledged = this.sendToConnection(connection, {
        type: 'wake_word_ack',
        message: 'Ready for voice command',
        timeout: Math.min(5000, this.reachyCaptureGrantTtlMs),
        ...(isReachy ? {
          captureGrantId: connection.captureGrant.id,
          sessionId: connection.captureGrant.id
        } : {})
      });
      if (!acknowledged && isReachy) {
        this.clearRejectedReachyAudio(deviceId, connection);
      }

    } catch (error) {
      if (isReachy) this.clearRejectedReachyAudio(deviceId, connection);
      console.error(`Wake word handling error for device ${deviceId}:`, error);
    }
  }

  async getPreferredVoiceId(connection, options = {}) {
    const wakeWord = (options.wakeWord || '').toString().trim();
    if (wakeWord) {
      const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const normalizedWake = wakeWord.toLowerCase();
      const candidates = new Set([normalizedWake]);
      if (!normalizedWake.startsWith('hey ')) {
        candidates.add(`hey ${normalizedWake}`);
      }

      try {
        const wakeWordPatterns = [...candidates].map((candidate) => (
          new RegExp(`^${escapeRegex(candidate)}$`, 'i')
        ));
        const wakeProfile = await UserProfile.findOne({
          active: true,
          wakeWords: { $in: wakeWordPatterns }
        })
          .select('voiceId')
          .sort({ lastUsed: -1, usageCount: -1, name: 1 });

        const wakeVoiceId = wakeProfile?.voiceId;
        if (typeof wakeVoiceId === 'string' && wakeVoiceId.trim().length > 0) {
          return wakeVoiceId.trim();
        }
      } catch (error) {
        console.warn('VoiceWebSocket: Unable to resolve wake word voice:', error.message);
      }
    }

    const deviceSettings = connection?.device?.settings || {};
    const candidateVoices = [
      deviceSettings.voiceId,
      deviceSettings.preferredVoiceId,
      deviceSettings.defaultVoiceId,
      deviceSettings.elevenLabsVoiceId,
      deviceSettings?.voice?.elevenLabsVoiceId,
      deviceSettings?.voice?.defaultVoiceId
    ].filter((value) => typeof value === 'string' && value.trim().length > 0);

    if (candidateVoices.length > 0) {
      return candidateVoices[0].trim();
    }

    const now = Date.now();
    const cacheValid = this.settingsCache.value && now - this.settingsCache.fetchedAt < 30_000;

    if (!cacheValid) {
      try {
        const settings = await settingsService.getSettings();
        this.settingsCache = { value: settings, fetchedAt: now };
      } catch (error) {
        console.warn('VoiceWebSocket: Unable to load settings for voice preference:', error.message);
        this.settingsCache = { value: null, fetchedAt: now };
      }
    }

    const settings = this.settingsCache.value;
    const globalVoice = settings?.elevenlabsDefaultVoiceId;
    if (typeof globalVoice === 'string' && globalVoice.trim().length > 0) {
      return globalVoice.trim();
    }

    const profileCacheValid = this.profileCache.value && now - this.profileCache.fetchedAt < 30_000;
    if (!profileCacheValid) {
      try {
      const profile = await UserProfile.findOne({ active: true })
        .select('voiceId')
        .sort({ lastUsed: -1, usageCount: -1, name: 1 });
        this.profileCache = { value: profile, fetchedAt: now };
      } catch (error) {
        console.warn('VoiceWebSocket: Unable to load active profile voice:', error.message);
        this.profileCache = { value: null, fetchedAt: now };
      }
    }

    const profileVoice = this.profileCache.value?.voiceId;
    if (typeof profileVoice === 'string' && profileVoice.trim().length > 0) {
      return profileVoice.trim();
    }

    return 'default';
  }

  async updateDeviceAudioState(deviceId, updates) {
    try {
      await VoiceDevice.findByIdAndUpdate(deviceId, updates);
    } catch (error) {
      console.warn(`Failed to update audio state for device ${deviceId}:`, error.message);
    }
  }

  stripWakeWordPrefix(commandText, wakeWord) {
    const command = (commandText || '').toString().trim();
    if (!command) {
      return '';
    }

    const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const normalizePhrase = (value) => (value || '')
      .toString()
      .toLowerCase()
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const candidates = new Set();
    const normalizedWake = normalizePhrase(wakeWord);
    if (normalizedWake) {
      candidates.add(normalizedWake);
      candidates.add(normalizedWake.replace(/^hey\s+/, ''));
      if (!normalizedWake.startsWith('hey ')) {
        candidates.add(`hey ${normalizedWake}`);
      }
    } else {
      candidates.add('anna');
      candidates.add('henry');
    }

    const sortedCandidates = [...candidates]
      .map(normalizePhrase)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    for (const candidate of sortedCandidates) {
      const pattern = candidate
        .split(' ')
        .filter(Boolean)
        .map(escapeRegex)
        .join('\\s+');
      const match = command.match(new RegExp(`^${pattern}(?:\\s*[,;:.!?-]+\\s*|\\s+|$)`, 'i'));
      if (match) {
        return command.slice(match[0].length).trim();
      }
    }

    return command;
  }

  async processVoiceCommandText(deviceId, context = {}) {
    const connection = context.sourceConnection || this.deviceConnections.get(deviceId);
    const authorizeExecution = () => this.isCurrentAuthenticatedConnection(deviceId, connection);
    if (!authorizeExecution()) {
      console.warn(`processVoiceCommandText called for unauthenticated device ${deviceId}`);
      return;
    }

    const normalizeLlmProvider = (provider) => {
      const normalized = (provider || '').toString().trim().toLowerCase();
      if (['openai', 'anthropic', 'local'].includes(normalized)) return normalized;
      if (['whisper_local', 'whisper', 'heuristic', 'rules'].includes(normalized)) return 'local';
      return 'local';
    };

    const rawCommand = (context.commandText || context.command || '').toString().trim();
    const command = this.stripWakeWordPrefix(rawCommand, connection.pendingWakeWord?.wakeWord);
    if (!command) {
      console.warn(`Empty command received from device ${deviceId}`);
      this.sendToConnection(connection, {
        type: 'command_error',
        message: 'I did not catch that. Please try again.'
      });
      return;
    }

    const confidence = typeof context.confidence === 'number'
      ? context.confidence
      : typeof context.sttConfidence === 'number'
        ? context.sttConfidence
        : typeof context.stt?.confidence === 'number'
          ? context.stt.confidence
          : 0.5;

    const timestamp = context.receivedAt instanceof Date
      ? context.receivedAt
      : (context.timestamp ? new Date(context.timestamp) : new Date());

    console.log('Voice command received from authenticated device', {
      deviceId,
      characterCount: command.length,
      transport: context?.metadata?.transport || null
    });

    await this.updateDeviceAudioState(deviceId, {
      lastTranscriptText: command,
      lastTranscriptAt: timestamp,
      lastTranscriptConfidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : null,
      lastTranscriptProvider: context?.stt?.provider || null,
      lastTranscriptModel: context?.stt?.model || null,
      lastTranscriptLanguage: context?.stt?.language || null,
      lastTranscriptError: null
    });
    if (!authorizeExecution()) return;

    try {
      const voiceCommand = new VoiceCommand({
        deviceId: deviceId,
        originalText: command,
        processedText: command,
        wakeWord: connection.pendingWakeWord?.wakeWord || 'anna',
        sourceRoom: connection.device.room,
        intent: {
          action: 'unknown',
          confidence: confidence || 0.5,
          entities: {}
        },
        execution: {
          status: 'pending'
        },
        llmProcessing: {
          provider: 'local',
          model: 'unknown'
        },
        quality: {
          speechRecognitionConfidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : undefined
        }
      });

      if (context.sessionId) {
        voiceCommand.sessionId = context.sessionId;
      }

      if (context.stt && typeof context.stt === 'object') {
        voiceCommand.llmProcessing.provider = normalizeLlmProvider(context.stt.provider);
        voiceCommand.llmProcessing.model = context.stt.model || 'stt';
        voiceCommand.llmProcessing.rawResponse = JSON.stringify({
          provider: context.stt.provider,
          model: context.stt.model,
          duration: context.stt.duration,
          processingTimeMs: context.stt.processingTimeMs
        });
      }

      await voiceCommand.save();
      if (!authorizeExecution()) return;

      const wakeWordForVoice = connection.pendingWakeWord?.wakeWord;
      const preferredVoiceId = await this.getPreferredVoiceId(connection, {
        wakeWord: wakeWordForVoice
      });
      let acknowledgment = null;
      try {
        acknowledgment = await voiceAcknowledgmentService.getRandomAcknowledgment(
          wakeWordForVoice,
          preferredVoiceId
        );
      } catch (ackError) {
        console.warn(`Failed to fetch acknowledgment for ${deviceId}:`, ackError.message);
      }

      if (!authorizeExecution()) return;
      this.sendToConnection(connection, {
        type: 'command_processing',
        commandId: voiceCommand._id,
        message: 'Processing your command...',
        acknowledgmentText: acknowledgment?.text || null,
        voice: acknowledgment?.voiceId || preferredVoiceId || 'default'
      });

      const processingStart = Date.now();
      const result = await voiceCommandService.processCommand({
        commandText: command,
        room: connection.device.room,
        wakeWord: connection.pendingWakeWord?.wakeWord || 'anna',
        deviceId,
        stt: context.stt || null,
        originDeviceType: connection.device.deviceType,
        authorizeExecution
      });

      const executionTime = Date.now() - processingStart;
      const responseText = result.responseText || `Command "${command}" received and processed.`;

      voiceCommand.processedText = result.processedText || command;
      voiceCommand.intent.action = result.intent?.action || 'unknown';
      voiceCommand.intent.confidence = typeof result.intent?.confidence === 'number'
        ? Math.max(0, Math.min(1, result.intent.confidence))
        : confidence || 0.5;
      voiceCommand.intent.entities = result.intent?.entities || {};

      voiceCommand.execution.status = result.execution?.status || 'failed';
      voiceCommand.execution.completedAt = new Date();
      voiceCommand.execution.executionTime = executionTime;
      if (Array.isArray(result.execution?.actions)) {
        voiceCommand.execution.actions = result.execution.actions.map((action) => ({
          type: action.type,
          target: action.deviceName || action.sceneId || action.message || '',
          parameters: {
            deviceId: action.deviceId,
            value: action.value
          },
          result: {
            success: Boolean(action.success),
            message: action.message,
            error: action.success ? undefined : action.message
          }
        }));
      }
      if (voiceCommand.execution.status !== 'success') {
        const failure = result.execution?.actions?.find((item) => item && !item.success);
        voiceCommand.execution.errorMessage = failure?.message || 'Failed to complete command';
      } else {
        voiceCommand.execution.errorMessage = undefined;
      }

      const createdAtMs = voiceCommand.createdAt instanceof Date
        ? voiceCommand.createdAt.getTime()
        : Number.NaN;
      voiceCommand.response = {
        text: responseText,
        responseTime: Date.now() - (Number.isFinite(createdAtMs) ? createdAtMs : processingStart)
      };

      const llmInfo = result.llm || {};
      voiceCommand.llmProcessing.provider = normalizeLlmProvider(
        llmInfo.provider || voiceCommand.llmProcessing.provider || 'local'
      );
      voiceCommand.llmProcessing.model = llmInfo.model || voiceCommand.llmProcessing.model || 'unknown';
      voiceCommand.llmProcessing.prompt = llmInfo.prompt || '';
      voiceCommand.llmProcessing.rawResponse = llmInfo.rawResponse || '';
      voiceCommand.llmProcessing.processingTime = llmInfo.processingTimeMs || executionTime;
      voiceCommand.llmProcessing.tokensUsed = llmInfo.tokensUsed || { input: 0, output: 0, total: 0 };

      if (!voiceCommand.quality) {
        voiceCommand.quality = {};
      }
      if (typeof confidence === 'number') {
        voiceCommand.quality.speechRecognitionConfidence = Math.max(0, Math.min(1, confidence));
      } else if (typeof result?.stt?.confidence === 'number') {
        voiceCommand.quality.speechRecognitionConfidence = Math.max(0, Math.min(1, result.stt.confidence));
      }
      voiceCommand.quality.correctionNeeded = false;

      await voiceCommand.save();

      connection.pendingWakeWord = null;
      if (!authorizeExecution()) return;

      this.sendToConnection(connection, {
        type: 'tts_response',
        commandId: voiceCommand._id,
        text: responseText,
        voice: preferredVoiceId || acknowledgment?.voiceId || 'default'
      });

    } catch (error) {
      console.error(`Voice command handling error for device ${deviceId}:`, error);
      console.error('Full error:', error.stack);
      if (connection) {
        connection.pendingWakeWord = null;
      }
      if (!authorizeExecution()) return;
      await this.updateDeviceAudioState(deviceId, {
        lastTranscriptError: error.message || 'Command processing failed',
        lastTranscriptAt: new Date()
      });
      if (!authorizeExecution()) return;
      this.sendToConnection(connection, {
        type: 'command_error',
        message: 'Failed to process voice command'
      });
    }
  }

  isReachyVoiceInputAllowed(connection) {
    if (connection?.device?.deviceType !== 'robot') return true;
    const settings = connection.device.settings?.reachy?.safeSettings || {};
    return settings.microphoneEnabled === true && settings.wakeWordEnabled === true;
  }

  clearRejectedReachyAudio(deviceId, connection) {
    this.audioSessions.delete(String(deviceId));
    if (connection) {
      connection.pendingWakeWord = null;
      connection.captureGrant = null;
    }
  }

  consumeReachyCaptureGrant(connection, presentedGrantId, presentedSessionId = null, requireSessionMatch = false) {
    if (connection?.device?.deviceType !== 'robot') return true;
    const grant = connection.captureGrant;
    connection.captureGrant = null;
    const expected = typeof grant?.id === 'string' ? grant.id : '';
    const presented = typeof presentedGrantId === 'string' ? presentedGrantId : '';
    const matchingGrant = expected.length > 0
      && expected.length === presented.length
      && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
    const session = typeof presentedSessionId === 'string' ? presentedSessionId : '';
    const matchingSession = !requireSessionMatch || (
      expected.length > 0
      && expected.length === session.length
      && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(session))
    );
    if (!grant || !matchingGrant || !matchingSession || !Number.isFinite(grant.expiresAt) || grant.expiresAt < Date.now()) {
      connection.pendingWakeWord = null;
      return false;
    }
    return true;
  }

  sendReachyAudioError(deviceId, connection, sessionId, message) {
    this.clearRejectedReachyAudio(deviceId, connection);
    void this.updateDeviceAudioState(deviceId, {
      audioStreamActive: false,
      lastTranscriptError: message,
      lastTranscriptAt: new Date()
    }).catch((error) => {
      console.warn('Failed to persist rejected Reachy audio state', {
        deviceId: String(deviceId),
        error: error.message
      });
    });
    this.sendToConnection(connection, {
      type: 'audio_error',
      ...(sessionId ? { sessionId } : {}),
      error: message
    });
  }

  decodeCanonicalBase64(value) {
    if (
      typeof value !== 'string'
      || value.length === 0
      || value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ) {
      return null;
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 0 || decoded.toString('base64') !== value) return null;
    return decoded;
  }

  async handleVoiceCommand(deviceId, message, sourceConnection = null) {
    const connection = sourceConnection || this.deviceConnections.get(deviceId);
    if (!connection || !connection.authenticated) return;
    if (!this.isReachyVoiceInputAllowed(connection)) {
      this.clearRejectedReachyAudio(deviceId, connection);
      return;
    }
    if (
      connection.device?.deviceType === 'robot'
      && !this.consumeReachyCaptureGrant(connection, message?.captureGrantId)
    ) {
      console.warn('Rejected Reachy text command without a fresh wake capture grant', { deviceId });
      this.sendToConnection(connection, {
        type: 'command_error',
        message: 'A fresh wake word is required'
      });
      return;
    }
    await this.processVoiceCommandText(deviceId, {
      commandText: message?.command,
      confidence: typeof message?.confidence === 'number' ? message.confidence : undefined,
      timestamp: message?.timestamp,
      metadata: {
        transport: 'websocket',
        source: 'device_message'
      },
      sourceConnection: connection
    });
  }

  async handleAudioData(deviceId, message, sourceConnection = null) {
    const connection = sourceConnection || this.deviceConnections.get(deviceId);
    if (!connection || !connection.authenticated) return;
    if (!this.isReachyVoiceInputAllowed(connection)) {
      this.clearRejectedReachyAudio(deviceId, connection);
      return;
    }

    const {
      sessionId,
      audioData,
      sampleRate,
      channels,
      format,
      isStart,
      isFinal,
      sequence
    } = message;

    if (connection.device?.deviceType === 'robot') {
      await this.handleReachyAudioData(deviceId, connection, {
        sessionId,
        audioData,
        sampleRate,
        channels,
        format,
        isStart,
        isFinal,
        sequence,
        captureGrantId: message.captureGrantId
      });
      return;
    }

    const resolvedSessionId = sessionId || `${deviceId}-${Date.now()}`;
    let session = this.audioSessions.get(deviceId);

    if (
      isStart ||
      !session ||
      session.sessionId !== resolvedSessionId
    ) {
      session = {
        sessionId: resolvedSessionId,
        connection,
        chunks: [],
        sampleRate: typeof sampleRate === 'number' ? sampleRate : 16000,
        channels: typeof channels === 'number' ? channels : 1,
        format: typeof format === 'string' ? format.toUpperCase() : 'S16LE',
        startedAt: new Date(),
        lastSequence: typeof sequence === 'number' ? sequence : -1,
        chunkCount: 0,
        totalBytes: 0
      };
      this.audioSessions.set(deviceId, session);
      console.log(`Started audio session ${resolvedSessionId} for device ${deviceId}`);
      await this.updateDeviceAudioState(deviceId, {
        audioStreamActive: true,
        audioStreamStartedAt: session.startedAt,
        lastTranscriptError: null
      });
    }

    if (typeof sequence === 'number') {
      session.lastSequence = sequence;
    }

    if (audioData) {
      try {
        const chunk = Buffer.from(audioData, 'base64');
        if (session.totalBytes + chunk.length > MAX_AUDIO_SESSION_BYTES) {
          console.warn(`Audio session ${resolvedSessionId} for device ${deviceId} exceeded ${MAX_AUDIO_SESSION_BYTES} bytes; dropping buffered audio`);
          this.audioSessions.delete(deviceId);
          await this.updateDeviceAudioState(deviceId, {
            audioStreamActive: false,
            lastTranscriptError: 'Audio session exceeded maximum size'
          });
          this.sendMessage(deviceId, {
            type: 'audio_error',
            sessionId: resolvedSessionId,
            error: 'Audio session exceeded maximum size'
          });
          return;
        }
        session.chunks.push(chunk);
        session.totalBytes += chunk.length;
      } catch (error) {
        console.error(`Failed to decode audio chunk for device ${deviceId}:`, error.message);
      }
    }

    session.chunkCount += 1;
    session.lastReceivedAt = new Date();

    const bytes = audioData ? Math.ceil((audioData.length * 3) / 4) : 0;

    this.sendMessage(deviceId, {
      type: 'audio_received',
      sessionId: resolvedSessionId,
      bytesReceived: bytes,
      isFinal: Boolean(isFinal)
    });

    if (isFinal) {
      try {
        await this.finalizeAudioSession(deviceId, session);
      } finally {
        this.audioSessions.delete(deviceId);
      }
    }
  }

  async handleReachyAudioData(deviceId, connection, message) {
    const id = String(deviceId);
    const {
      sessionId,
      audioData,
      sampleRate,
      channels,
      format,
      isStart,
      isFinal,
      sequence,
      captureGrantId
    } = message;
    const validSessionId = typeof sessionId === 'string'
      && sessionId.length > 0
      && sessionId.length <= 128
      && sessionId.trim() === sessionId
      && !/[\u0000-\u001f\u007f]/.test(sessionId);
    const fail = (error) => {
      console.warn('Rejected Reachy audio frame', { deviceId: id, error });
      this.sendReachyAudioError(id, connection, validSessionId ? sessionId : null, error);
    };

    if (!validSessionId) {
      fail('Invalid audio session identifier');
      return;
    }

    let session = this.audioSessions.get(id);
    if (isStart === true) {
      const startHasAudio = audioData != null;
      const startSequenceValid = startHasAudio
        ? Number.isSafeInteger(sequence) && sequence === 0
        : sequence == null;
      if (
        session
        || sampleRate !== 16000
        || channels !== 1
        || typeof format !== 'string'
        || format.toUpperCase() !== 'S16LE'
        || isFinal === true
        || !startSequenceValid
      ) {
        fail('Invalid audio session start');
        return;
      }
      const firstChunk = startHasAudio ? this.decodeCanonicalBase64(audioData) : null;
      if (startHasAudio && (!firstChunk || firstChunk.length % 2 !== 0)) {
        fail('Invalid S16LE audio payload');
        return;
      }
      if (!this.consumeReachyCaptureGrant(connection, captureGrantId, sessionId, true)) {
        fail('A fresh wake word is required');
        return;
      }
      const startedAtMs = Date.now();
      session = {
        sessionId,
        connection,
        chunks: firstChunk ? [firstChunk] : [],
        sampleRate: 16000,
        channels: 1,
        format: 'S16LE',
        startedAt: new Date(startedAtMs),
        startedAtMs,
        lastSequence: firstChunk ? 0 : -1,
        chunkCount: firstChunk ? 1 : 0,
        totalBytes: firstChunk?.length || 0
      };
      this.audioSessions.set(id, session);
      try {
        await this.updateDeviceAudioState(id, {
          audioStreamActive: true,
          audioStreamStartedAt: session.startedAt,
          lastTranscriptError: null
        });
      } catch (error) {
        fail('Unable to initialize audio session');
        return;
      }
      if (!this.isCurrentAuthenticatedConnection(id, connection)) {
        this.audioSessions.delete(id);
        return;
      }
      this.sendToConnection(connection, {
        type: 'audio_received',
        sessionId,
        bytesReceived: firstChunk?.length || 0,
        isFinal: false
      });
      return;
    }

    if (!session || session.sessionId !== sessionId) {
      fail('Audio session is not authorized');
      return;
    }
    if (
      !Number.isSafeInteger(sequence)
      || sequence < 0
      || sequence > REACHY_AUDIO_MAX_SEQUENCE
      || sequence !== session.lastSequence + 1
    ) {
      fail('Invalid or replayed audio sequence');
      return;
    }
    if (Date.now() - session.startedAtMs > this.reachyAudioSessionMaxMs) {
      fail('Audio session exceeded maximum duration');
      return;
    }
    if (sampleRate != null && sampleRate !== 16000) {
      fail('Unsupported audio sample rate');
      return;
    }
    if (channels != null && channels !== 1) {
      fail('Unsupported audio channel count');
      return;
    }
    if (format != null && (typeof format !== 'string' || format.toUpperCase() !== 'S16LE')) {
      fail('Unsupported audio format');
      return;
    }

    let chunk = null;
    if (audioData != null) {
      chunk = this.decodeCanonicalBase64(audioData);
      if (!chunk || chunk.length % 2 !== 0) {
        fail('Invalid S16LE audio payload');
        return;
      }
    } else if (isFinal !== true) {
      fail('Audio payload is required');
      return;
    }
    if (session.totalBytes + (chunk?.length || 0) > this.reachyAudioSessionMaxBytes) {
      fail('Audio session exceeded maximum size');
      return;
    }

    if (chunk) {
      session.chunks.push(chunk);
      session.totalBytes += chunk.length;
      session.chunkCount += 1;
    }
    session.lastSequence = sequence;
    session.lastReceivedAt = new Date();
    this.sendToConnection(connection, {
      type: 'audio_received',
      sessionId,
      bytesReceived: chunk?.length || 0,
      isFinal: Boolean(isFinal)
    });

    if (isFinal === true) {
      try {
        await this.finalizeAudioSession(id, session);
      } finally {
        this.audioSessions.delete(id);
      }
    }
  }

  async finalizeAudioSession(deviceId, session) {
    const connection = session?.connection || this.deviceConnections.get(deviceId);
    if (!this.isCurrentAuthenticatedConnection(deviceId, connection)) {
      return;
    }

    const completedAt = new Date();
    const markInactive = async (fields = {}) => {
      await this.updateDeviceAudioState(deviceId, {
        audioStreamActive: false,
        lastTranscriptAt: completedAt,
        ...fields
      });
    };

    if (!session || !Array.isArray(session.chunks) || session.chunks.length === 0) {
      console.warn(`Audio session ${session?.sessionId || 'unknown'} for device ${deviceId} contained no data`);
      await markInactive({
        lastTranscriptText: null,
        lastTranscriptConfidence: null,
        lastTranscriptProvider: null,
        lastTranscriptModel: null,
        lastTranscriptLanguage: null,
        lastTranscriptError: 'No audio received'
      });
      this.sendMessage(deviceId, {
        type: 'command_error',
        message: "I didn't hear anything. Let's try again."
      });
      return;
    }

    const pcmBuffer = Buffer.concat(session.chunks);

    console.log(`Transcribing ${pcmBuffer.length} bytes of audio for device ${deviceId} (session ${session.sessionId})`);

    let transcription;
    try {
      transcription = await speechService.transcribe({
        audioBuffer: pcmBuffer,
        sampleRate: session.sampleRate,
        channels: session.channels,
        format: session.format
      });
      if (!this.isCurrentAuthenticatedConnection(deviceId, connection)) return;
    } catch (error) {
      console.error(`Speech-to-text failed for device ${deviceId}:`, error.message);
      await markInactive({
        lastTranscriptText: null,
        lastTranscriptConfidence: null,
        lastTranscriptProvider: null,
        lastTranscriptModel: null,
        lastTranscriptLanguage: null,
        lastTranscriptError: error.message || 'Speech-to-text failed'
      });
      this.sendMessage(deviceId, {
        type: 'command_error',
        message: 'Sorry, I could not understand the audio.'
      });
      return;
    }

    if (!transcription || !transcription.text) {
      console.warn(`Transcription for device ${deviceId} session ${session.sessionId} returned no text`);
      await markInactive({
        lastTranscriptText: null,
        lastTranscriptConfidence: typeof transcription?.confidence === 'number' ? transcription.confidence : null,
        lastTranscriptProvider: transcription?.provider || null,
        lastTranscriptModel: transcription?.model || null,
        lastTranscriptLanguage: transcription?.language || null,
        lastTranscriptError: 'No speech detected'
      });
      this.sendMessage(deviceId, {
        type: 'command_error',
        message: 'I did not catch that. Please try again.'
      });
      return;
    }

    await markInactive({
      lastTranscriptText: transcription.text,
      lastTranscriptConfidence: typeof transcription.confidence === 'number' ? transcription.confidence : null,
      lastTranscriptProvider: transcription.provider || null,
      lastTranscriptModel: transcription.model || null,
      lastTranscriptLanguage: transcription.language || null,
      lastTranscriptError: null
    });

    await this.processVoiceCommandText(deviceId, {
      commandText: transcription.text,
      confidence: transcription.confidence,
      receivedAt: new Date(),
      sessionId: session.sessionId,
      stt: transcription,
      metadata: {
        transport: 'websocket',
        source: 'audio_stream'
      },
      sourceConnection: connection
    });
  }

  async handleStatusUpdate(deviceId, message, sourceConnection = null) {
    const { status, settings } = message;

    try {
      const connection = sourceConnection || this.deviceConnections.get(deviceId);
      if (this.deviceConnections.get(deviceId) !== connection) return;
      if (connection?.device?.deviceType === 'robot') {
        if (settings?.reachy && typeof settings.reachy === 'object') {
          await reachyMiniService.handleRuntimeStatus(deviceId, settings.reachy);
        } else if (settings?.robotState && typeof settings.robotState === 'object') {
          await reachyMiniService.handleRobotState(deviceId, { state: settings.robotState });
        }
        await VoiceDevice.findByIdAndUpdate(deviceId, {
          lastSeen: new Date(),
          ...(status && { status })
        });
        return;
      }
      const protectedSettingKeys = new Set([
        'registrationCode',
        'registrationExpires',
        'claimToken',
        'claimTokenExpires',
        'registered',
        'deviceTokenHash',
        'deviceTokenCreatedAt',
        'lifecycle'
      ]);
      const $set = { lastSeen: new Date() };
      if (status) $set.status = status;
      if (settings && typeof settings === 'object') {
        Object.entries(settings).forEach(([key, value]) => {
          if (!key || key.includes('.') || key.startsWith('$') || protectedSettingKeys.has(key)) {
            return;
          }
          $set[`settings.${key}`] = value;
        });
      }

      await VoiceDevice.findByIdAndUpdate(deviceId, { $set });

      console.log(`Status updated for device ${deviceId}: ${status}`);

    } catch (error) {
      console.error(`Status update error for device ${deviceId}:`, error);
    }
  }

  async handleUpdateStatus(deviceId, message, sourceConnection = null) {
    const connection = sourceConnection || this.deviceConnections.get(deviceId);
    if (!connection) return;
    if (this.deviceConnections.get(deviceId) !== connection) return;

    const { status, version, error } = message;

    console.log(`Update status received from ${connection.device.name}: ${status} (version: ${version})`);

    try {
      // Import update service
      const remoteUpdateService = require('../services/remoteUpdateService');

      // Update device status using the service
      await remoteUpdateService.updateDeviceStatus(deviceId, status, error, version);

      console.log(`Update status for device ${deviceId} updated to: ${status}`);

    } catch (updateError) {
      console.error(`Error updating device update status for ${deviceId}:`, updateError);
    }
  }

  async handleDeviceError(deviceId, message, sourceConnection = null) {
    const connection = sourceConnection || this.deviceConnections.get(deviceId);
    if (!connection) return;
    if (this.deviceConnections.get(deviceId) !== connection) return;

    const { error, details } = message;

    console.error(`Device error reported by ${connection.device.name}: ${error}`, details);

    try {
      // Update device status to error
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        status: 'error',
        lastSeen: new Date()
      });

    } catch (dbError) {
      console.error(`Failed to update device error status for ${deviceId}:`, dbError);
    }
  }

  async handleDisconnection(deviceId, code, reason, ws = null) {
    console.log(`Voice device ${deviceId} disconnected: ${code} - ${reason}`);
    if (ws && this.pendingConnections.has(ws)) {
      this.pendingConnections.delete(ws);
      console.log('Removed unauthenticated websocket connection', { deviceId });
      return;
    }
    const connection = this.deviceConnections.get(deviceId);
    if (ws && (!connection || connection.ws !== ws)) {
      console.log('Ignoring stale websocket disconnect for voice device', { deviceId });
      return;
    }

    this.deviceConnections.delete(deviceId);
    this.audioSessions.delete(deviceId);

    try {
      // Update device status to offline
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        status: 'offline',
        lastSeen: new Date(),
        audioStreamActive: false
      });
      if (connection?.device?.deviceType === 'robot') {
        await reachyMiniService.handleDisconnected(deviceId);
      }
    } catch (error) {
      console.error(`Error handling disconnection for device ${deviceId}:`, error);
    }
  }

  revokeDeviceCredentials(deviceId, reason = 'Device credentials reissued') {
    const id = String(deviceId);
    this.audioSessions.delete(id);
    const connections = new Set();
    const active = this.deviceConnections.get(id);
    if (active) connections.add(active);
    for (const [ws, pending] of this.pendingConnections.entries()) {
      const pendingDeviceId = String(pending.deviceId || pending.device?._id || '');
      if (pendingDeviceId !== id) continue;
      connections.add(pending);
      this.pendingConnections.delete(ws);
    }
    if (active) this.deviceConnections.delete(id);
    for (const connection of connections) {
      connection.revoked = true;
      connection.authenticated = false;
      connection.credentials = null;
      connection.deviceInfo = null;
      connection.pendingWakeWord = null;
      connection.captureGrant = null;
      connection.ws?.close?.(1008, reason);
    }
    return connections.size;
  }

  async pushConfigToDevice(deviceId) {
    try {
      const connection = this.deviceConnections.get(deviceId);
      if (!connection) {
        throw new Error('Device not connected');
      }
      const device = connection.device || await VoiceDevice.findById(deviceId);
      if (!device) {
        throw new Error('Device not found');
      }
      const credentials = connection.credentials || {};
      const { config } = await this.buildWakeWordConfig(device, credentials, connection.deviceInfo || {});
      if (device.deviceType === 'robot') {
        config.robot = reachyMiniService.buildRobotConfig(device);
      }
      const ok = this.sendMessage(deviceId, { type: 'config_update', config });
      return ok ? { success: true } : { success: false, error: 'WebSocket send failed' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async playTtsToDevice(deviceId, text = 'Ping from hub') {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection) {
      return { success: false, error: 'Device not connected' };
    }
    let voiceId = 'default';
    try {
      voiceId = await this.getPreferredVoiceId(connection);
    } catch (error) {
      console.warn('Failed to resolve preferred voice for device', {
        deviceId: String(deviceId),
        error: error.message
      });
    }
    const payload = { type: 'tts_response', text, voice: voiceId || 'default' };
    const ok = this.sendMessage(deviceId, payload);
    return ok ? { success: true } : { success: false, error: 'Send failed' };
  }

  sendToConnection(connection, message) {
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      if (message && message.type) {
        console.log(`Dispatching message "${message.type}" to voice device socket`);
      } else {
        console.log('Dispatching unnamed message to voice device socket');
      }
      connection.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error('Error sending message to voice device socket:', error);
      return false;
    }
  }

  sendMessage(deviceId, message) {
    return this.sendToConnection(this.deviceConnections.get(String(deviceId)), message);
  }

  isDeviceAuthenticated(deviceId) {
    const connection = this.deviceConnections.get(String(deviceId));
    return Boolean(connection?.authenticated && connection.ws?.readyState === WebSocket.OPEN);
  }

  broadcastToRoom(room, message) {
    let sentCount = 0;
    for (const [deviceId, connection] of this.deviceConnections) {
      if (connection.device.room === room) {
        if (this.sendMessage(deviceId, message)) {
          sentCount++;
        }
      }
    }
    return sentCount;
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();

      for (const [deviceId, connection] of this.deviceConnections) {
        // Check if device hasn't responded to ping in over 1 minute
        if (now - connection.lastPing > 60000) {
          console.warn(`Device ${deviceId} heartbeat timeout, closing connection`);
          connection.ws.close(1001, 'Heartbeat timeout');
          continue;
        }

        // Send ping to check connection
        if (connection.ws.readyState === WebSocket.OPEN) {
          connection.ws.ping();
        }
      }
    }, this.heartbeatInterval);

    console.log('WebSocket heartbeat monitoring started');
  }

  stop() {
    reachyMiniService.shutdown();
    this.messageChains.clear();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.upgradeHandlers.length > 0) {
      this.upgradeHandlers.forEach(({ server, upgradeHandler }) => {
        if (typeof server.off === 'function') {
          server.off('upgrade', upgradeHandler);
        } else {
          server.removeListener('upgrade', upgradeHandler);
        }
      });
      this.upgradeHandlers = [];
    }

    if (this.wss) {
      this.wss.clients.forEach((socket) => {
        try {
          socket.close(1001, 'HomeBrain is shutting down');
        } catch (_error) {
          socket.terminate();
        }
        setTimeout(() => {
          if (socket.readyState !== WebSocket.CLOSED) {
            socket.terminate();
          }
        }, 1000).unref?.();
      });
      this.wss.close();
      this.wss = null;
      this.deviceConnections.clear();
      this.pendingConnections.clear();
      this.audioSessions.clear();
      console.log('Voice WebSocket Server stopped');
    }
  }

  getStats() {
    return {
      connectedDevices: this.deviceConnections.size,
      connections: Array.from(this.deviceConnections.entries()).map(([deviceId, connection]) => ({
        deviceId,
        deviceName: connection.device.name,
        room: connection.device.room,
        authenticated: connection.authenticated,
        lastPing: new Date(connection.lastPing).toISOString()
      }))
    };
  }
}

module.exports = VoiceWebSocketServer;
module.exports.redactMessageForLog = redactMessageForLog;
module.exports.MAX_VOICE_WEBSOCKET_PAYLOAD_BYTES = MAX_VOICE_WEBSOCKET_PAYLOAD_BYTES;

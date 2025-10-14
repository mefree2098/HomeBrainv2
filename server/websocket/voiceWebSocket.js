const WebSocket = require('ws');
const VoiceDevice = require('../models/VoiceDevice');
const VoiceCommand = require('../models/VoiceCommand');
const wakeWordAssets = require('../utils/wakeWordAssets');
const WakeWordModel = require('../models/WakeWordModel');

console.log('voiceWebSocket.js loaded with enhanced logging');

class VoiceWebSocketServer {
  constructor() {
    this.wss = null;
    this.deviceConnections = new Map(); // deviceId -> WebSocket connection
    this.heartbeatInterval = 30000; // 30 seconds
    this.heartbeatTimer = null;
  }

  initialize(server) {
    console.log('Initializing Voice WebSocket Server');

    this.wss = new WebSocket.Server({
      server,
      path: '/ws/voice-device',
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

  async handleConnection(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let deviceId = req.deviceId || url.searchParams.get('deviceId');

    if (!deviceId) {
      const segments = url.pathname.split('/').filter(Boolean);
      deviceId = segments.pop();
    }

    console.log(`Voice device WebSocket connection established: ${deviceId}`);

    try {
      // Verify device exists in database
      const device = await VoiceDevice.findById(deviceId);
      if (!device) {
        console.warn(`WebSocket connection rejected: Device not found ${deviceId}`);
        ws.close(1008, 'Device not found');
        return;
      }

      // Store connection
      this.deviceConnections.set(deviceId, {
        ws: ws,
        device: device,
        lastPing: Date.now(),
        authenticated: false,
        deviceInfo: null
      });

      // Update device status to online
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        status: 'online',
        lastSeen: new Date(),
        ipAddress: req.connection.remoteAddress
      });

      // Set up WebSocket event handlers
      ws.on('message', (message) => {
        try {
          const text = message.toString();
          console.log(`WebSocket message event for ${deviceId}: ${text}`);
        } catch (logError) {
          console.warn(`Failed to log raw message for ${deviceId}:`, logError);
        }
        console.log(`Queueing message for processing for ${deviceId}`);
        this.handleMessage(deviceId, message);
      });

      ws.on('close', (code, reason) => {
        this.handleDisconnection(deviceId, code, reason);
      });

      ws.on('error', (error) => {
        console.error(`WebSocket error for device ${deviceId}:`, error);
        this.handleDisconnection(deviceId, 1006, 'Connection error');
      });

      ws.on('pong', () => {
        const connection = this.deviceConnections.get(deviceId);
        if (connection) {
          connection.lastPing = Date.now();
        }
      });

    // Send welcome message
    this.sendMessage(deviceId, {
      type: 'welcome',
      deviceId: deviceId,
      timestamp: new Date().toISOString()
    });

    // Proactively authenticate device on connect to avoid race/missed auth messages
    try {
      const registrationCode = device.settings?.registrationCode || 'auto';
      const { config } = await this.buildWakeWordConfig(device, registrationCode, {});
      const conn = this.deviceConnections.get(deviceId);
      if (conn) {
        conn.authenticated = true;
        conn.deviceInfo = conn.deviceInfo || {};
      }
      this.sendMessage(deviceId, { type: 'auth_success', config });
      console.log(`Proactive auth_success sent to ${deviceId} (${device.name}) on connection`);
    } catch (autoAuthErr) {
      console.warn(`Failed to proactively authenticate ${deviceId} on connect:`, autoAuthErr.message);
    }

    console.log(`Voice device ${device.name} connected successfully`);

    } catch (error) {
      console.error(`Error handling WebSocket connection for ${deviceId}:`, error);
      ws.close(1011, 'Server error');
    }
  }

  async buildWakeWordConfig(device, registrationCode, deviceInfo = {}) {
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
      const params = new URLSearchParams();
      params.set('code', registrationCode);
      if (asset.platform || platform) {
        params.set('platform', asset.platform || platform);
      }
      if (asset.arch || arch) {
        params.set('arch', asset.arch || arch);
      }

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
        metadata: modelMetadata,
        downloadUrl: `/api/remote-devices/${deviceId}/wake-words/${asset.slug}?${params.toString()}`
      };
    });

    const debounceMs = typeof device.settings?.wakeWordDebounceMs === 'number'
      ? device.settings.wakeWordDebounceMs
      : 1500;
    const vadSettings = device.settings?.wakeWordVad || {};

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
              : 3
          }
        },
        volume: device.volume,
        microphoneSensitivity: device.microphoneSensitivity,
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

  async handleMessage(deviceId, rawMessage) {
    try {
      const message = JSON.parse(rawMessage.toString());
      const connection = this.deviceConnections.get(deviceId);

      console.log(`WebSocket raw message from ${deviceId}: ${rawMessage.toString()}`);

      if (!connection) {
        console.warn(`Received message from unconnected device: ${deviceId}`);
        return;
      }

      console.log(`WebSocket message from ${deviceId}:`, message.type);

      switch (message.type) {
        case 'authenticate':
          await this.handleAuthentication(deviceId, message);
          break;

        case 'heartbeat':
          await this.handleHeartbeat(deviceId, message);
          break;

        case 'wake_word_detected':
          await this.handleWakeWordDetection(deviceId, message);
          break;

        case 'voice_command':
          await this.handleVoiceCommand(deviceId, message);
          break;

        case 'audio_data':
          await this.handleAudioData(deviceId, message);
          break;

        case 'status_update':
          await this.handleStatusUpdate(deviceId, message);
          break;

        case 'update_status':
          await this.handleUpdateStatus(deviceId, message);
          break;

        case 'error':
          await this.handleDeviceError(deviceId, message);
          break;

        default:
          console.warn(`Unknown message type from device ${deviceId}: ${message.type}`);
      }

    } catch (error) {
      console.error(`Error processing message from device ${deviceId}:`, error);
      console.error('Failed message payload:', rawMessage.toString());
      this.sendMessage(deviceId, {
        type: 'error',
        message: 'Failed to process message'
      });
    }
  }

  async handleAuthentication(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection) return;

    const { registrationCode, deviceInfo = {} } = message;

    try {
      const device = await VoiceDevice.findById(deviceId);
      if (!device) {
        this.sendMessage(deviceId, {
          type: 'auth_failed',
          message: 'Device not found'
        });
        return;
      }

      if (device.settings.registrationCode !== registrationCode) {
        console.warn(`Authentication failed for device ${deviceId}: Invalid registration code (${registrationCode || 'none'})`);
        this.sendMessage(deviceId, {
          type: 'auth_failed',
          message: 'Invalid registration code'
        });
        return;
      }

      connection.authenticated = true;
      connection.deviceInfo = deviceInfo;

      console.log(`Authenticating device ${deviceId} (${device.name}) with code ${registrationCode}`);

      const { config, assets } = await this.buildWakeWordConfig(device, registrationCode, deviceInfo);

      if (!assets.length) {
        console.warn(`No wake word assets available for device ${device.name}. Ensure files exist in server/public/wake-words.`);
      } else {
        const assetLabels = assets.map((asset) => `${asset.label}:${asset.fileName}`).join(', ');
        console.log(`Resolved ${assets.length} wake word asset(s) for ${device.name}: ${assetLabels}`);
      }

      console.log(`Sending auth_success to ${deviceId} with ${assets.length} wake word asset(s)`);

      this.sendMessage(deviceId, {
        type: 'auth_success',
        config
      });

      console.log(`Device ${device.name} authenticated successfully`);

    } catch (error) {
      console.error(`Authentication error for device ${deviceId}:`, error);
      this.sendMessage(deviceId, {
        type: 'auth_failed',
        message: 'Authentication error'
      });
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

        const registrationCode = device.settings?.registrationCode;
        if (!registrationCode) {
          console.warn(`Cannot send wake word update to ${device.name}: missing registration code`);
          continue;
        }

        try {
          const { config, assets } = await this.buildWakeWordConfig(device, registrationCode, connection.deviceInfo || {});
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

  async handleHeartbeat(deviceId, message) {
    const { status, batteryLevel, uptime } = message;

    try {
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        lastSeen: new Date(),
        ...(status && { status }),
        ...(typeof batteryLevel === 'number' && { batteryLevel }),
        ...(typeof uptime === 'number' && { uptime })
      });

      this.sendMessage(deviceId, {
        type: 'heartbeat_ack',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error(`Heartbeat error for device ${deviceId}:`, error);
    }
  }

  async handleWakeWordDetection(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection || !connection.authenticated) return;

    const { wakeWord, confidence, timestamp } = message;
    const normalizedWake = (wakeWord || 'anna').toString().toLowerCase();

    console.log(`Wake word detected by ${connection.device.name}: ${normalizedWake} (confidence: ${confidence})`);

    try {
      // Persist a minimal, schema-compliant VoiceCommand record for wake word events
      const now = timestamp ? new Date(timestamp) : new Date();
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
          confidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : 1.0,
          entities: {}
        },
        execution: {
          status: 'success',
          startedAt: now,
          completedAt: now
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
          playedAt: now,
          responseTime: 0
        }
      });

      await voiceCommand.save();

      // Send acknowledgment and prepare for voice command
      this.sendMessage(deviceId, {
        type: 'wake_word_ack',
        message: 'Ready for voice command',
        timeout: 5000 // 5 seconds to speak command
      });

      // Update device last interaction
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        lastInteraction: new Date()
      });

    } catch (error) {
      console.error(`Wake word handling error for device ${deviceId}:`, error);
    }
  }

  async handleVoiceCommand(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection || !connection.authenticated) return;

    const { command, confidence, timestamp } = message;

    console.log(`Voice command received from ${connection.device.name}: ${command}`);

    try {
      // Save voice command to database
      const voiceCommand = new VoiceCommand({
        deviceId: deviceId,
        originalText: command,
        processedText: command,
        wakeWord: 'anna', // Default wake word
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
        }
      });

      await voiceCommand.save();

      // Acknowledge command receipt
      this.sendMessage(deviceId, {
        type: 'command_processing',
        commandId: voiceCommand._id,
        message: 'Processing your command...'
      });

      // Check if this is an automation creation request
      const automationKeywords = ['automation', 'automate', 'when', 'every', 'if', 'create rule'];
      const isAutomationRequest = automationKeywords.some(keyword =>
        command.toLowerCase().includes(keyword)
      );

      if (isAutomationRequest) {
        console.log(`Voice command identified as automation request: ${command}`);

        // Import automation service (do it here to avoid circular dependency)
        const automationService = require('../services/automationService');

        try {
          // Create automation from voice command with room context
          const result = await automationService.createAutomationFromText(
            command,
            connection.device.room
          );

          // Update voice command with success
          voiceCommand.intent.action = 'automation_create';
          voiceCommand.execution.status = 'success';
          voiceCommand.execution.completedAt = new Date();
          voiceCommand.response = {
            text: `Automation "${result.automation.name}" created successfully!`,
            responseTime: Date.now() - voiceCommand.createdAt.getTime()
          };
          await voiceCommand.save();

          // Send success response
          this.sendMessage(deviceId, {
            type: 'tts_response',
            commandId: voiceCommand._id,
            text: `Automation "${result.automation.name}" created successfully!`,
            voice: 'default'
          });

        } catch (automationError) {
          console.error(`Failed to create automation from voice command:`, automationError);

          // Update voice command with failure
          voiceCommand.execution.status = 'failed';
          voiceCommand.execution.completedAt = new Date();
          voiceCommand.execution.errorMessage = automationError.message;
          await voiceCommand.save();

          // Send error response
          this.sendMessage(deviceId, {
            type: 'tts_response',
            commandId: voiceCommand._id,
            text: `Sorry, I couldn't create that automation. ${automationError.message}`,
            voice: 'default'
          });
        }
      } else {
        // Regular command processing (non-automation)
        // Here you would integrate with your LLM service for other commands
        voiceCommand.execution.status = 'success';
        voiceCommand.execution.completedAt = new Date();
        voiceCommand.response = {
          text: `Command "${command}" received and processed.`,
          responseTime: Date.now() - voiceCommand.createdAt.getTime()
        };
        await voiceCommand.save();

        this.sendMessage(deviceId, {
          type: 'tts_response',
          commandId: voiceCommand._id,
          text: `Command "${command}" received and processed.`,
          voice: 'default'
        });
      }

    } catch (error) {
      console.error(`Voice command handling error for device ${deviceId}:`, error);
      console.error('Full error:', error.stack);
      this.sendMessage(deviceId, {
        type: 'command_error',
        message: 'Failed to process voice command'
      });
    }
  }

  async handleAudioData(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection || !connection.authenticated) return;

    const { audioData, sampleRate, channels, format } = message;

    console.log(`Audio data received from ${connection.device.name}: ${audioData.length} bytes`);

    // Here you would process the audio data (speech-to-text, etc.)
    // For now, just acknowledge receipt
    this.sendMessage(deviceId, {
      type: 'audio_received',
      bytesReceived: audioData.length
    });
  }

  async handleStatusUpdate(deviceId, message) {
    const { status, settings } = message;

    try {
      const updateData = { lastSeen: new Date() };
      if (status) updateData.status = status;
      if (settings) updateData.settings = { ...updateData.settings, ...settings };

      await VoiceDevice.findByIdAndUpdate(deviceId, updateData);

      console.log(`Status updated for device ${deviceId}: ${status}`);

    } catch (error) {
      console.error(`Status update error for device ${deviceId}:`, error);
    }
  }

  async handleUpdateStatus(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection) return;

    const { status, version, error } = message;

    console.log(`Update status received from ${connection.device.name}: ${status} (version: ${version})`);

    try {
      // Import update service
      const remoteUpdateService = require('../services/remoteUpdateService');

      // Update device status using the service
      await remoteUpdateService.updateDeviceStatus(deviceId, status, error);

      console.log(`Update status for device ${deviceId} updated to: ${status}`);

    } catch (updateError) {
      console.error(`Error updating device update status for ${deviceId}:`, updateError);
    }
  }

  async handleDeviceError(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection) return;

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

  async handleDisconnection(deviceId, code, reason) {
    console.log(`Voice device ${deviceId} disconnected: ${code} - ${reason}`);

    try {
      // Update device status to offline
      await VoiceDevice.findByIdAndUpdate(deviceId, {
        status: 'offline',
        lastSeen: new Date()
      });

      // Remove from active connections
      this.deviceConnections.delete(deviceId);

    } catch (error) {
      console.error(`Error handling disconnection for device ${deviceId}:`, error);
    }
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
      const registrationCode = device.settings?.registrationCode || 'auto';
      const { config } = await this.buildWakeWordConfig(device, registrationCode, connection.deviceInfo || {});
      const ok = this.sendMessage(deviceId, { type: 'config_update', config });
      return ok ? { success: true } : { success: false, error: 'WebSocket send failed' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  playTtsToDevice(deviceId, text = 'Ping from hub') {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection) {
      return { success: false, error: 'Device not connected' };
    }
    const payload = { type: 'tts_response', text, voice: 'default' };
    const ok = this.sendMessage(deviceId, payload);
    return ok ? { success: true } : { success: false, error: 'Send failed' };
  }

  sendMessage(deviceId, message) {
    const connection = this.deviceConnections.get(deviceId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      if (message && message.type) {
        console.log(`Dispatching message "${message.type}" to device ${deviceId}`);
      } else {
        console.log(`Dispatching unnamed message to device ${deviceId}`);
      }
      connection.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error(`Error sending message to device ${deviceId}:`, error);
      return false;
    }
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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.wss) {
      this.wss.close();
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

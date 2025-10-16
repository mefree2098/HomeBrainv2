#!/usr/bin/env node

const WebSocket = require('ws');
const recorder = require('node-record-lpcm16');
const fetch = require('node-fetch');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const packageInfo = require('./package.json');
let WebRtcVad = null;
try {
  WebRtcVad = require('node-webrtcvad');
} catch (error) {
  console.warn('node-webrtcvad module not available; wake word VAD gating disabled.');
}

const DEFAULT_WAKE_WORD_CONFIDENCE = 0.9;
const DEFAULT_WAKE_WORD_THRESHOLD = 0.55;
const DEFAULT_WAKE_WORD_DEBOUNCE_MS = 1500;
const PCM_SAMPLE_WIDTH_BYTES = 2;
const DEFAULT_VAD_WINDOW_MS = 30;
const DEFAULT_VAD_HISTORY = 8;
const DEFAULT_VAD_THRESHOLD = 0.35;
const PACKAGE_VERSION = packageInfo.version;
const WAKE_WORD_USER_AGENT = `HomeBrain-Remote/${PACKAGE_VERSION}`;
const VAD_BASE_SAMPLE_RATE = 16000;
const VAD_FRAME_SAMPLES = Math.round((DEFAULT_VAD_WINDOW_MS / 1000) * VAD_BASE_SAMPLE_RATE);
const VAD_FRAME_BYTES = VAD_FRAME_SAMPLES * PCM_SAMPLE_WIDTH_BYTES;

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);
const slugify = (value) => {
  if (!value) return '';
  return value.toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
};

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('register', {
    alias: 'r',
    type: 'string',
    description: 'Registration code for device setup'
  })
  .option('config', {
    alias: 'c',
    type: 'string',
    default: './config.json',
    description: 'Path to configuration file'
  })
  .option('hub', {
    alias: 'u',
    type: 'string',
    description: 'Hub URL (e.g., http://localhost:3000)'
  })
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    default: false,
    description: 'Enable verbose logging'
  })
  .option('auto-discover', {
    alias: 'a',
    type: 'boolean',
    default: false,
    description: 'Enable automatic hub discovery'
  })
  .option('device-name', {
    alias: 'n',
    type: 'string',
    description: 'Device name for auto-discovery (e.g., "Kitchen Speaker")'
  })
  .help()
  .argv;

class HomeBrainRemoteDevice {
  constructor(config) {
    this.config = config;
    this.config.audio = this.config.audio || {};
    this.config.wakeWord = this.config.wakeWord || {};
    this.ws = null;
    this.isConnected = false;
    this.isAuthenticated = false;
    this.isRecording = false;
    this.isListening = false;
    this.deviceId = null;
    this.heartbeatInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.recordingStream = null;

    this.configDirectory = path.dirname(path.resolve(argv.config || './config.json'));
    this.packageVersion = PACKAGE_VERSION;
    this.hubHttpBaseUrl = this.deriveInitialHubBaseUrl();
    this.wakeWordCacheDir = this.config.wakeWord?.cacheDir || path.join(this.configDirectory, 'wake-words');
    this.wakeWordAssetSignature = null;

    // Voice capture/recording behavior
    this.voiceConfig = this.config.voice || {};
    // captureMode: 'none' (default), 'simulate', or 'pcm'
    this.captureMode = process.env.HB_CAPTURE_MODE || this.voiceConfig.captureMode || 'none';
    this.recordStopTimer = null;
    this.commandProc = null;
    this.commandSessionId = null;
    this.commandSequence = 0;

    // Wake word detection
    this.wakeWordDisplayNames = ['Anna', 'Henry', 'Home Brain', 'Homebrain'];
    this.wakeWords = this.wakeWordDisplayNames.map((word) => word.toLowerCase());
    this.isWakeWordListening = true;
    this.wakeWordAudioBuffer = Buffer.alloc(0);
    this.wakeWordEngine = 'openwakeword';
    this.wakeWordSessions = [];
    this.wakeWordFrameSamples = 0;
    this.wakeWordSampleRate = this.config.audio.sampleRate || 16000;
    this.wakeWordInputShape = new Map();
    this.onnxRuntime = null;
    this.wakeWordThreshold = clamp(this.config.wakeWord.threshold ?? this.config.wakeWord.defaultThreshold ?? DEFAULT_WAKE_WORD_THRESHOLD, 0, 1);
    this.wakeWordReportedConfidence = clamp(this.config.wakeWord.reportedConfidence ?? DEFAULT_WAKE_WORD_CONFIDENCE, 0, 1);
    this.wakeWordEngineFailed = false;
    this.wakeWordDetectionQueue = Promise.resolve();
    this.wakeWordRestartAttempts = 0;
    this.maxWakeWordRestarts = 3;
    this.testModeActive = false;
    this.testModeListenerAttached = false;
    this.testModeListener = null;
    this.wakeWordDebounceMs = clamp(this.config.wakeWord.debounceMs ?? DEFAULT_WAKE_WORD_DEBOUNCE_MS, 250, 10000);
    this.lastWakeWordAt = 0;
    this.vadEnabled = Boolean(WebRtcVad);
    this.vad = null;
    this.vadBuffer = Buffer.alloc(0);
    this.vadHistory = [];
    this.vadHistoryLength = clamp(this.config.wakeWord?.vad?.history ?? DEFAULT_VAD_HISTORY, 1, 32);
    this.vadSpeechThreshold = clamp(this.config.wakeWord?.vad?.speechThreshold ?? DEFAULT_VAD_THRESHOLD, 0, 1);
    this.vadMinActivations = clamp(this.config.wakeWord?.vad?.minActivations ?? 1, 1, this.vadHistoryLength);
    this.vadActive = !this.vadEnabled;
    if (this.vadEnabled) {
      try {
        const vadMode = clamp(this.config.wakeWord?.vad?.mode ?? 3, 0, 3);
        this.vad = new WebRtcVad(vadMode);
      } catch (error) {
        console.warn(`WebRTC VAD initialization failed (${error.message}); disabling VAD gating.`);
        this.vadEnabled = false;
        this.vad = null;
      }
    }
    if (this.vadEnabled && this.wakeWordSampleRate !== VAD_BASE_SAMPLE_RATE) {
      console.warn(`VAD gating requires ${VAD_BASE_SAMPLE_RATE} Hz audio. Current sample rate ${this.wakeWordSampleRate} Hz is not supported; disabling VAD.`);
      this.vadEnabled = false;
      this.vad = null;
      this.vadActive = true;
    }

    // Auto-discovery
    this.discoveryPort = 12345;
    this.discoverySocket = null;
    this.discoveredHubs = new Map();
    this.isScanning = false;

    // Status tracking
    this.startTime = Date.now();
    this.lastInteraction = null;
    this.stats = {
      wakeWordsDetected: 0,
      commandsProcessed: 0,
      errors: 0,
      uptime: 0
    };

    console.log(`HomeBrain Remote Device v${PACKAGE_VERSION}`);
    if (argv.verbose) {
      console.log('Configuration:', JSON.stringify(this.config, null, 2));
    }
  }

  async initialize() {
    console.log('Initializing HomeBrain Remote Device...');

    try {
      // Initialize audio components
      await this.initializeAudio();

      // Auto-discovery mode
      if (argv['auto-discover']) {
        console.log('Starting auto-discovery mode...');
        await this.startAutoDiscovery();
        return; // Exit early, will continue after discovery
      }

      // If registration code provided, register device
      if (argv.register) {
        await this.registerDevice(argv.register);
      }

      // Load device configuration
      await this.loadDeviceConfig();

      // Connect to hub
      await this.connectToHub();

      if (this.hasLocalWakeWordModels()) {
        await this.startWakeWordDetection();
      } else {
        console.log('Wake word models not yet available; waiting for hub configuration...');
      }

      // Start heartbeat
      this.startHeartbeat();

      console.log('HomeBrain Remote Device initialized successfully');
      console.log(`Device listening for wake words: ${this.wakeWordDisplayNames.join(', ')}`);

    } catch (error) {
      console.error('Failed to initialize remote device:', error.message);
      process.exit(1);
    }
  }

  async initializeAudio() {
    console.log('Initializing audio system...');

    try {
      await this.verifyCommand('arecord');
      await this.verifyCommand('aplay');
      console.log('Audio capture/playback utilities detected (arecord/aplay)');
    } catch (error) {
      console.warn('Audio initialization warning:', error.message);
      console.warn('Recording or playback may fail until required ALSA utilities are installed.');
    }
  }

  async registerDevice(registrationCode) {
    console.log(`Registering device with code: ${registrationCode}`);

    const hubUrl = argv.hub || this.config.hubUrl || process.env.HUB_URL || 'http://localhost:3000';
    console.log(`Using Hub URL: ${hubUrl}`);
    this.config.hubUrl = hubUrl;
    this.config.registrationCode = registrationCode;
    this.setHubHttpBase(hubUrl);

    try {
      // Get network information
      const networkInfo = await this.getNetworkInfo();

      const response = await fetch(`${hubUrl}/api/remote-devices/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          registrationCode: registrationCode,
          ipAddress: networkInfo.ipAddress,
          firmwareVersion: PACKAGE_VERSION
        })
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.message || 'Registration failed');
      }

      // Save device configuration
      this.deviceId = data.device._id;
      this.config.deviceId = this.deviceId;
      this.config.hubUrl = hubUrl;
      this.config.hubWsUrl = data.hubUrl;
      this.setHubHttpBase(data.hubUrl || hubUrl);

      await this.saveConfig();

      console.log(`Device registered successfully: ${data.device.name} (${this.deviceId})`);
      console.log(`Hub WebSocket URL: ${data.hubUrl}`);

    } catch (error) {
      console.error('Device registration failed:', error.message);
      throw error;
    }
  }

  async loadDeviceConfig() {
    if (!this.deviceId && this.config.deviceId) {
      this.deviceId = this.config.deviceId;
    }

    if (!this.deviceId) {
      throw new Error('Device not registered. Use --register <CODE> to register device.');
    }

    console.log(`Device ID: ${this.deviceId}`);
  }

  async connectToHub() {
    const baseHttp = this.getHubHttpBase();
    this.setHubHttpBase(baseHttp);
    const wsUrl = this.buildWebSocketUrl(baseHttp);

    console.log(`Connecting to hub: ${wsUrl}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('Connected to HomeBrain hub');
        this.isConnected = true;
        this.reconnectAttempts = 0;

        // Authenticate with hub
        this.authenticate();
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data).catch((error) => {
          if (argv.verbose) {
            console.error('Failed to process hub message:', error.message);
          }
        });
      });

      this.ws.on('close', (code, reason) => {
        console.log(`Connection closed: ${code} - ${reason}`);
        this.isConnected = false;
        this.isAuthenticated = false;
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
        this.stats.errors++;

        if (!this.isConnected) {
          reject(error);
        }
      });

      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  authenticate() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    console.log('Authenticating with hub...');

    this.sendMessage({
      type: 'authenticate',
      registrationCode: this.config.registrationCode || 'auto',
      deviceInfo: {
        version: PACKAGE_VERSION,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version
      }
    });
  }

  async handleMessage(rawData) {
    let message;
    try {
      message = JSON.parse(rawData.toString());
    } catch (error) {
      console.error('Failed to parse message from hub:', error.message);
      this.stats.errors++;
      return;
    }

    if (argv.verbose) {
      console.log('Received message:', message.type);
    }

    try {
      switch (message.type) {
        case 'welcome':
          console.log('Received welcome from hub');
          break;

        case 'auth_success': {
          console.log('Authentication successful');
          this.isAuthenticated = true;
          if (message.config) {
            const assetCount = Array.isArray(message.config?.wakeWord?.assets)
              ? message.config.wakeWord.assets.length
              : 0;
            console.log(`Auth payload received with ${assetCount} wake word asset(s) and wakeWords=${JSON.stringify(message.config.wakeWords || [])}`);
            const detectorNeedsRestart = await this.applyConfigUpdate(message.config);
            await this.saveConfig();
            if (detectorNeedsRestart) {
              await this.restartWakeWordDetection();
            } else if (!this.isWakeWordDetectorActive() && this.hasLocalWakeWordModels()) {
              await this.startWakeWordDetection();
            }
          }
          break;
        }

        case 'config_update': {
          if (message.config) {
            const assetCount = Array.isArray(message.config?.wakeWord?.assets)
              ? message.config.wakeWord.assets.length
              : 0;
            console.log(`Config update received with ${assetCount} wake word asset(s)`);
            const detectorNeedsRestart = await this.applyConfigUpdate(message.config);
            await this.saveConfig();
            if (detectorNeedsRestart) {
              await this.restartWakeWordDetection();
            }
          }
          break;
        }

        case 'auth_failed':
          console.error('Authentication failed:', message.message);
          process.exit(1);
          break;

        case 'wake_word_ack':
          console.log('Wake word acknowledged, listening for command...');
          this.startVoiceRecording(message.timeout || 5000, true);

          if (this.recordStopTimer) clearTimeout(this.recordStopTimer);
          this.recordStopTimer = setTimeout(() => {
            if (this.isRecording) {
              this.stopVoiceRecording();
            }
          }, message.timeout || 5000);
          break;

        case 'command_processing':
          console.log('Command is being processed...');
          break;

        case 'tts_response':
          console.log('Playing TTS response:', message.text);
          this.playTTSResponse(message.text, message.voice);
          break;

        case 'command_error':
          console.error('Command processing error:', message.message);
          break;

        case 'heartbeat_ack':
          break;

        case 'update_available':
          console.log('Update available:', message.version);
          this.handleUpdateAvailable(message);
          break;

        case 'audio_received':
          if (argv.verbose) {
            console.log('Hub acknowledged audio chunk for session', message.sessionId || 'unknown');
          }
          break;

        case 'error':
          console.error('Hub error:', message.message);
          this.stats.errors++;
          break;

        default:
          console.warn('Unknown message type:', message.type);
      }
    } catch (error) {
      this.stats.errors++;
      console.error('Error processing message from hub:', error.message);
      if (argv.verbose && error.stack) {
        console.error(error.stack);
      }
      throw error;
    }
  }

  sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = {
        ...message,
        timestamp: new Date().toISOString()
      };
      const summary = message?.type ? `type="${message.type}"` : 'no type';
      console.log(`Sending message to hub (${summary}) [readyState=${this.ws.readyState}]`);
      this.ws.send(JSON.stringify(payload), (error) => {
        if (error) {
          console.error(`Failed to send message to hub (${summary}):`, error.message);
        } else {
          console.log(`Message delivered to hub (${summary})`);
        }
      });
      return true;
    }
    console.warn('Attempted to send message while WebSocket not open');
    return false;
  }

  async applyConfigUpdate(config) {
    if (!config) {
      return false;
    }

    let restartNeeded = false;

    if (config.wakeWord) {
      this.config.wakeWord = {
        ...this.config.wakeWord,
        ...config.wakeWord
      };

    }

    if (Array.isArray(config.wakeWords)) {
      this.config.wakeWords = config.wakeWords;
    }

    const previousNamesSignature = JSON.stringify(this.wakeWordDisplayNames);

    if (Array.isArray(config.wakeWord?.enabled) && config.wakeWord.enabled.length > 0) {
      this.wakeWordDisplayNames = config.wakeWord.enabled;
      this.wakeWords = config.wakeWord.enabled.map((w) => w.toLowerCase());
      console.log(`Updated wake words: ${this.wakeWordDisplayNames.join(', ')}`);
    } else if (Array.isArray(config.wakeWords) && config.wakeWords.length > 0) {
      this.wakeWordDisplayNames = config.wakeWords;
      this.wakeWords = config.wakeWords.map((w) => w.toLowerCase());
      console.log(`Updated wake words: ${this.wakeWordDisplayNames.join(', ')}`);
    }

    if (JSON.stringify(this.wakeWordDisplayNames) !== previousNamesSignature) {
      restartNeeded = true;
    }

    if (config.volume !== undefined) {
      console.log(`Volume set to: ${config.volume}%`);
    }

    if (config.microphoneSensitivity !== undefined) {
      console.log(`Microphone sensitivity set to: ${config.microphoneSensitivity}%`);
    }

    if (typeof config.wakeWord?.reportedConfidence === 'number') {
      this.wakeWordReportedConfidence = clamp(config.wakeWord.reportedConfidence, 0, 1);
    }

    if (typeof config.wakeWord?.threshold === 'number') {
      this.wakeWordThreshold = clamp(config.wakeWord.threshold, 0, 1);
    } else if (typeof config.wakeWord?.defaultThreshold === 'number') {
      this.wakeWordThreshold = clamp(config.wakeWord.defaultThreshold, 0, 1);
    }

    const assetsChanged = await this.syncWakeWordAssetsFromConfig(config);
    restartNeeded = restartNeeded || assetsChanged;

    const keywordSummary = Array.isArray(this.config.wakeWord?.keywords) && this.config.wakeWord.keywords.length
      ? this.config.wakeWord.keywords.map((keyword) => `${keyword.label}:${keyword.path}`).join(', ')
      : null;
    if (keywordSummary) {
      console.log(`Wake word keywords active: ${keywordSummary}`);
    } else {
      console.log('No wake word keywords currently active after config update');
    }

    return restartNeeded;
  }

  hasLocalWakeWordModels() {
    const keywords = this.config.wakeWord?.keywords;
    if (!Array.isArray(keywords) || keywords.length === 0) {
      return false;
    }
    return keywords.every((keyword) => keyword.path && fs.existsSync(keyword.path));
  }

  isWakeWordDetectorActive() {
    return Boolean(this.recordingStream && this.wakeWordSessions.length > 0 && !this.wakeWordEngineFailed);
  }

  generateWakeWordAssetSignature(keywords = []) {
    return JSON.stringify(keywords.map((keyword) => ({
      label: keyword.label || '',
      slug: keyword.slug || (keyword.label ? slugify(keyword.label) : ''),
      path: keyword.path ? path.resolve(keyword.path) : '',
      engine: keyword.engine || 'openwakeword',
      sensitivity: typeof keyword.sensitivity === 'number' ? Number(keyword.sensitivity.toFixed(3)) : null,
      threshold: typeof keyword.threshold === 'number' ? Number(keyword.threshold.toFixed(3)) : null
    })));
  }

  async ensureWakeWordDirectory() {
    const targetDir = this.config.wakeWord?.cacheDir || this.wakeWordCacheDir || path.join(this.configDirectory, 'wake-words');
    await fs.promises.mkdir(targetDir, { recursive: true });
    this.wakeWordCacheDir = targetDir;
    this.config.wakeWord = {
      ...this.config.wakeWord,
      cacheDir: targetDir
    };
    console.log(`Wake word cache directory set to ${targetDir}`);
    return targetDir;
  }

  async computeFileChecksum(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (error) => reject(error));
    });
  }

  async needsWakeWordDownload(localPath, expectedChecksum) {
    try {
      await fs.promises.access(localPath, fs.constants.R_OK);
      if (!expectedChecksum) {
        console.log(`Wake word cache hit for ${localPath} (no checksum provided)`);
        return false;
      }
      const currentChecksum = await this.computeFileChecksum(localPath);
      if (currentChecksum !== expectedChecksum) {
        console.log(`Wake word checksum mismatch for ${localPath} (expected ${expectedChecksum}, found ${currentChecksum})`);
      } else {
        console.log(`Wake word checksum validated for ${localPath}`);
      }
      return currentChecksum !== expectedChecksum;
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(`Wake word model missing at ${localPath}`);
        return true;
      }
      throw error;
    }
  }

  async downloadWakeWordAsset(url) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': WAKE_WORD_USER_AGENT,
        'Accept': 'application/octet-stream'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to download wake word asset (${response.status} ${response.statusText})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async syncWakeWordAssetsFromConfig(config) {
    const wakeWordConfig = config?.wakeWord || {};
    const assets = Array.isArray(wakeWordConfig.assets) ? wakeWordConfig.assets : [];

    if (!assets.length) {
      console.log('Wake word configuration provided no assets; skipping synchronization');
      return false;
    }

    const cacheDir = await this.ensureWakeWordDirectory();
    const keywords = [];
    const normalizedAssets = [];
    let assetsChanged = false;

    for (const asset of assets) {
      const label = asset.label || asset.slug || 'wake_word';
      const slug = asset.slug ? slugify(asset.slug) : slugify(label);
      if (!slug) {
        console.warn('Skipping wake word asset with invalid slug:', asset);
        continue;
      }

      const fallbackFormat = typeof asset.format === 'string' && asset.format.trim().length
        ? asset.format.trim().replace(/^\./, '')
        : 'tflite';
      const fileName = asset.fileName && asset.fileName.trim().length
        ? asset.fileName.trim()
        : `${slug}.${fallbackFormat}`;
      const localPath = path.resolve(cacheDir, fileName);
      const downloadUrl = asset.downloadUrl ? this.buildAbsoluteHubUrl(asset.downloadUrl) : null;

      if (!downloadUrl) {
        console.warn(`Wake word asset "${label}" is missing a download URL`);
        continue;
      }

      const expectedChecksum = asset.checksum || null;
      if (await this.needsWakeWordDownload(localPath, expectedChecksum)) {
        console.log(`Downloading wake word model for "${label}"...`);
        const buffer = await this.downloadWakeWordAsset(downloadUrl);
        const actualChecksum = crypto.createHash('sha256').update(buffer).digest('hex');
        if (expectedChecksum && actualChecksum !== expectedChecksum) {
          throw new Error(`Checksum mismatch for wake word "${label}" (expected ${expectedChecksum}, received ${actualChecksum})`);
        }
        await fs.promises.writeFile(localPath, buffer);
        assetsChanged = true;
        console.log(`Saved wake word model for "${label}" to ${localPath}`);
      } else {
        console.log(`Wake word model for "${label}" already up to date at ${localPath}`);
      }

      keywords.push({
        label,
        path: localPath,
        slug,
        engine: asset.engine || 'openwakeword',
        format: asset.format || path.extname(fileName).slice(1),
        threshold: typeof asset.threshold === 'number' ? clamp(asset.threshold, 0, 1) : undefined,
        sensitivity: typeof asset.sensitivity === 'number' ? clamp(asset.sensitivity, 0, 1) : undefined
      });

      normalizedAssets.push({
        ...asset,
        label,
        slug,
        fileName,
        localPath
      });
    }

    if (keywords.length === 0) {
      console.warn('No wake word keywords available after synchronization.');
    }

    const newSignature = this.generateWakeWordAssetSignature(keywords);
    if (newSignature !== this.wakeWordAssetSignature) {
      assetsChanged = true;
      console.log('Wake word keyword set changed; updating signature');
      this.wakeWordAssetSignature = newSignature;
    }

    this.config.wakeWord = {
      ...this.config.wakeWord,
      ...wakeWordConfig,
      cacheDir,
      keywords,
      assets: normalizedAssets
    };

    if (typeof wakeWordConfig.debounceMs === 'number') {
      this.wakeWordDebounceMs = clamp(wakeWordConfig.debounceMs, 250, 10000);
    }
    if (wakeWordConfig.vad && this.vadEnabled) {
      const vadCfg = wakeWordConfig.vad;
      this.vadHistoryLength = clamp(vadCfg.history ?? this.vadHistoryLength, 1, 32);
      this.vadSpeechThreshold = clamp(vadCfg.speechThreshold ?? this.vadSpeechThreshold, 0, 1);
      this.vadMinActivations = clamp(vadCfg.minActivations ?? this.vadMinActivations, 1, this.vadHistoryLength);
      if (this.vad) {
        try {
          const mode = clamp(vadCfg.mode ?? 3, 0, 3);
          this.vad = new WebRtcVad(mode);
        } catch (error) {
          console.warn(`Failed to update VAD mode (${error.message}); disabling VAD gating.`);
          this.vadEnabled = false;
          this.vad = null;
          this.vadActive = true;
        }
      }
      this.vadHistory = [];
    }

    return assetsChanged;
  }

  async restartWakeWordDetection() {
    console.log('Restarting wake word detection with updated configuration...');
    this.disableTestMode();
    this.releaseWakeWordEngine();

    if (this.recordingStream) {
      try {
        this.recordingStream.stop();
      } catch (error) {
        console.warn('Failed to stop existing recording stream during restart:', error.message);
      }
      this.recordingStream = null;
    }

    // Give ALSA a moment to release device
    await new Promise((r) => setTimeout(r, 1000));

    this.isWakeWordListening = false;
    this.wakeWordEngineFailed = false;

    await this.startWakeWordDetection();
  }

  disableTestMode() {
    if (this.testModeListenerAttached && this.testModeListener) {
      process.stdin.removeListener('data', this.testModeListener);
      this.testModeListenerAttached = false;
      this.testModeListener = null;
    }
    this.testModeActive = false;
  }

  async initializeWakeWordEngine() {
    if (this.wakeWordSessions.length > 0) {
      return;
    }

    const wakeWordConfig = this.config.wakeWord || {};
    const seenPaths = new Set();

    const resolveModelPath = (candidate) => {
      if (!candidate || (typeof candidate === 'string' && candidate.trim().length === 0)) {
        return null;
      }

      const rawPath = typeof candidate === 'string' ? candidate.trim() : candidate;
      const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(this.configDirectory, rawPath);

      if (!fs.existsSync(absolutePath)) {
        console.warn(`Wake word model not found on disk: ${absolutePath}`);
        return null;
      }

      return absolutePath;
    };

    const keywordEntries = [];
    const pushKeywordEntry = (entry) => {
      if (!entry) return;

      if (typeof entry === 'string') {
        const resolvedPath = resolveModelPath(entry);
        if (!resolvedPath || seenPaths.has(resolvedPath)) {
          return;
        }
        seenPaths.add(resolvedPath);
        keywordEntries.push({
          label: this.formatWakeWordLabel(entry),
          slug: slugify(entry),
          path: resolvedPath,
          sensitivity: null,
          threshold: null
        });
        return;
      }

      if (typeof entry !== 'object') {
        return;
      }

      const candidatePath = entry.path || entry.file || entry.keywordPath || entry.modelPath;
      const resolvedPath = resolveModelPath(candidatePath);
      if (!resolvedPath || seenPaths.has(resolvedPath)) {
        return;
      }

      seenPaths.add(resolvedPath);

      const labelSource = entry.label || entry.displayName || entry.slug || entry.name || entry.keyword || candidatePath;
      keywordEntries.push({
        label: this.formatWakeWordLabel(labelSource),
        slug: slugify(entry.slug || labelSource),
        path: resolvedPath,
        sensitivity: typeof entry.sensitivity === 'number' ? clamp(entry.sensitivity, 0, 1) : null,
        threshold: typeof entry.threshold === 'number' ? clamp(entry.threshold, 0, 1) : null
      });
    };

    if (Array.isArray(wakeWordConfig.keywords)) {
      wakeWordConfig.keywords.forEach(pushKeywordEntry);
    }

    if (keywordEntries.length === 0 && Array.isArray(wakeWordConfig.keywordPaths)) {
      wakeWordConfig.keywordPaths.forEach(pushKeywordEntry);
    }

    if (keywordEntries.length === 0 && Array.isArray(wakeWordConfig.keywordFiles)) {
      wakeWordConfig.keywordFiles.forEach(pushKeywordEntry);
    }

    if (keywordEntries.length === 0 && wakeWordConfig.keywordPath) {
      pushKeywordEntry(wakeWordConfig.keywordPath);
    }

    if (keywordEntries.length === 0 && wakeWordConfig.customWakeWordFile) {
      pushKeywordEntry(wakeWordConfig.customWakeWordFile);
    }

    if (!keywordEntries.length) {
      throw new Error('No wake word models configured. Await hub configuration or confirm wake word assets were downloaded.');
    }

    const sessions = [];
    let resolvedFrameSamples = 0;

    for (const entry of keywordEntries) {
      if (!entry.path) continue;
      const sessionInfo = await this.createWakeWordSession(entry);
      if (!sessionInfo) {
        console.warn(`Wake word session not initialized for "${entry.label}" (${entry.format || 'unknown'}).`);
        continue;
      }
      if (sessionInfo.frameSamples && (!resolvedFrameSamples || sessionInfo.frameSamples < resolvedFrameSamples)) {
        resolvedFrameSamples = sessionInfo.frameSamples;
      }
      sessions.push(sessionInfo);
    }

    if (!sessions.length) {
      throw new Error('Failed to initialize OpenWakeWord models. No valid models were loaded.');
    }

    this.wakeWordSessions = sessions;
    this.wakeWordFrameSamples = resolvedFrameSamples || this.wakeWordFrameSamples || this.config.audio?.frameSamples || 16000;
    this.wakeWordAudioBuffer = Buffer.alloc(0);
    this.wakeWordEngineFailed = false;

    for (const sessionInfo of this.wakeWordSessions) {
      try {
        await this.warmUpWakeWordSession(sessionInfo);
      } catch (warmupError) {
        console.warn(`Wake word model warm-up skipped for ${sessionInfo.label}: ${warmupError.message}`);
      }
    }

    console.log(`Wake word detection engine initialized (OpenWakeWord) with ${this.wakeWordSessions.length} model(s); frame length ${this.wakeWordFrameSamples} samples.`);
  }

  async createWakeWordSession(entry) {
    if (entry.format && entry.format.toLowerCase() === 'tflite') {
      const session = await this.createTfliteSession(entry);
      if (session) {
        return session;
      }
      const fallbackPath = entry.path.replace(/\.tflite$/i, '.onnx');
      if (fallbackPath && fs.existsSync(fallbackPath)) {
        return this.createOnnxWakeWordSession({
          ...entry,
          path: fallbackPath,
          format: 'onnx'
        });
      }
    }
    return this.createOnnxWakeWordSession(entry);
  }

  async createTfliteSession(entry) {
    try {
      const tflite = require('tflite-node');
      console.log(`Attempting to load TFLite wake word model "${entry.label}"`);
      const modelBuffer = await fsp.readFile(entry.path);
      const interpreter = new tflite.Interpreter(modelBuffer);
      interpreter.allocateTensors();
      const inputDetails = interpreter.getInputDetails()[0];
      const outputDetails = interpreter.getOutputDetails()[0];
      const frameSamples = Array.isArray(inputDetails.shape) ? inputDetails.shape[inputDetails.shape.length - 1] : this.wakeWordFrameSamples;

      const sessionInfo = {
        label: entry.label,
        slug: entry.slug || slugify(entry.label),
        path: entry.path,
        format: 'tflite',
        engine: 'tflite',
        threshold: clamp(entry.threshold ?? entry.sensitivity ?? this.wakeWordThreshold, 0, 1),
        sensitivity: entry.sensitivity,
        frameSamples,
        run: (floatFrame) => {
          try {
            const inputTensor = interpreter.getInputTensor(0);
            inputTensor.copyFrom(floatFrame);
            interpreter.invoke();
            const outputTensor = interpreter.getOutputTensor(outputDetails.index);
            const data = outputTensor.data();
            return Array.isArray(data) ? data[0] : data;
          } catch (error) {
            console.warn(`TFLite inference error for ${entry.label}: ${error.message}`);
            return 0;
          }
        }
      };

      return sessionInfo;
    } catch (error) {
      console.warn(`TFLite runtime unavailable for model "${entry.label}": ${error.message}. Falling back to ONNX.`);
      return null;
    }
  }

  async createOnnxWakeWordSession(entry) {
    let ort;
    try {
      ort = this.onnxRuntime || require('onnxruntime-node');
      this.onnxRuntime = ort;
    } catch (error) {
      throw new Error('onnxruntime-node dependency is required for wake word detection.');
    }

    let session;
    try {
      session = await ort.InferenceSession.create(entry.path);
    } catch (error) {
      console.error(`Failed to create ONNX session for "${entry.label}": ${error.message}`);
      return null;
    }

    const inputNames = Array.isArray(session.inputNames) && session.inputNames.length
      ? session.inputNames
      : Object.keys(session.inputMetadata || {});
    const inputName = inputNames[0] || null;
    const inputMetadata = inputName ? session.inputMetadata?.[inputName] : null;
    // onnxruntime-node exposes dims, not dimensions
    const metaDims = Array.isArray(inputMetadata?.dims) ? inputMetadata.dims.slice() : [];
    // Determine frame length from last positive dim if present
    const positiveDims = metaDims.filter((d) => typeof d === 'number' && d > 0);
    const frameSamples = positiveDims.length ? positiveDims[positiveDims.length - 1] : (this.wakeWordFrameSamples || 16000);

    const sessionInfo = {
      label: entry.label,
      slug: entry.slug || slugify(entry.label),
      path: entry.path,
      format: 'onnx',
      engine: 'onnx',
      threshold: clamp(entry.threshold ?? entry.sensitivity ?? this.wakeWordThreshold, 0, 1),
      sensitivity: entry.sensitivity,
      inputName,
      inputMetadata,
      inputDims: metaDims,
      outputNames: Array.isArray(session.outputNames) && session.outputNames.length
        ? session.outputNames
        : Object.keys(session.outputMetadata || {}),
      session,
      frameSamples
    };

    sessionInfo.run = async (floatFrame) => {
      const feeds = this.buildWakeWordFeeds(floatFrame, sessionInfo);
      const outputs = await sessionInfo.session.run(feeds);
      return this.extractWakeWordScore(outputs, sessionInfo);
    };

    return sessionInfo;
  }

  formatWakeWordLabel(source) {
    if (!source) return 'wake_word';

    const base = typeof source === 'string'
      ? path.basename(source, path.extname(source))
      : String(source);

    return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'wake_word';
  }

  releaseWakeWordEngine() {
    // Ensure sidecar is stopped
    this.stopFeatureSidecar();

    if (Array.isArray(this.wakeWordSessions) && this.wakeWordSessions.length) {
      for (const sessionInfo of this.wakeWordSessions) {
        const session = sessionInfo?.session;
        if (!session) continue;

        try {
          if (typeof session.release === 'function') {
            session.release();
          } else if (typeof session.dispose === 'function') {
            session.dispose();
          }
        } catch (error) {
          console.warn(`Failed to release OpenWakeWord session for ${sessionInfo.label}: ${error.message}`);
        }
      }
    }

    this.wakeWordSessions = [];
    this.wakeWordAudioBuffer = Buffer.alloc(0);
    this.wakeWordEngineFailed = false;
    this.wakeWordDetectionQueue = Promise.resolve();
  }

  async startWakeWordDetection() {
    if (!this.hasLocalWakeWordModels()) {
      console.warn('Wake word models are not available yet; detection will start after assets are synced.');
      return;
    }

    console.log('Starting wake word detection...');

    this.disableTestMode();
    this.isWakeWordListening = false;

    if (this.recordingStream) {
      try {
        this.recordingStream.stop();
      } catch (error) {
        console.warn('Unable to stop existing recording stream cleanly:', error.message);
      }
      this.recordingStream = null;
    }

    try {
      // Use feature-based sidecar for ONNX models when enabled or when ONNX models are present
      const useSidecar = true; // enable by default for now
      const keywordEntries = Array.isArray(this.config?.wakeWord?.keywords) ? this.config.wakeWord.keywords : [];
      const hasOnnx = keywordEntries.some((k) => /\.onnx$/i.test(k.path || ''));

      if (useSidecar && hasOnnx) {
        await this.startFeatureSidecar(keywordEntries);
        this.wakeWordEngineFailed = false;
        this.wakeWordAudioBuffer = Buffer.alloc(0);
        this.wakeWordDetectionQueue = Promise.resolve();

        const recordingOptions = {
          sampleRate: this.wakeWordSampleRate,
          sampleRateHertz: this.wakeWordSampleRate,
          threshold: this.config.audio.threshold ?? 0.5,
          verbose: false,
          recordProgram: this.config.audio.recordProgram || 'arecord',
          device: this.config.audio.recordingDevice || this.config.audio.microphoneDevice || 'default'
        };

        this.recordingStream = recorder.record(recordingOptions);
        const micStream = this.recordingStream.stream();

        micStream.on('data', (data) => {
          if (!this.isWakeWordListening || this.isRecording) {
            return;
          }
          this.enqueueSidecarAudio(data);
        });

        micStream.on('error', (streamError) => {
          this.handleWakeWordEngineFailure(streamError);
        });

        this.isWakeWordListening = true;
        this.wakeWordRestartAttempts = 0;
        console.log('Wake word detection active (FeatureSidecar/OWW)');
        return;
      }

      // Existing in-process engine for TFLite/ONNX with raw-audio models
      await this.initializeWakeWordEngine();

      if (!this.wakeWordSessions.length) {
        throw new Error('No wake word models are ready for OpenWakeWord.');
      }

      this.wakeWordEngineFailed = false;
      this.wakeWordAudioBuffer = Buffer.alloc(0);
      this.wakeWordDetectionQueue = Promise.resolve();

      const recordingOptions = {
        sampleRate: this.wakeWordSampleRate,
        sampleRateHertz: this.wakeWordSampleRate,
        threshold: this.config.audio.threshold ?? 0.5,
        verbose: false,
        recordProgram: this.config.audio.recordProgram || 'arecord',
        device: this.config.audio.recordingDevice || this.config.audio.microphoneDevice || 'default'
      };

      this.recordingStream = recorder.record(recordingOptions);
      const micStream = this.recordingStream.stream();

      micStream.on('data', (data) => {
        if (!this.isWakeWordListening || this.isRecording) {
          return;
        }

        const audioChunk = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data);
        this.wakeWordDetectionQueue = this.wakeWordDetectionQueue
          .then(() => this.processAudioForWakeWord(audioChunk))
          .catch((processingError) => {
            console.error('Wake word processing error:', processingError.message);
            this.handleWakeWordEngineFailure(processingError);
          });
      });

      micStream.on('error', (streamError) => {
        this.handleWakeWordEngineFailure(streamError);
      });

      this.isWakeWordListening = true;
      this.wakeWordRestartAttempts = 0;
      console.log('Wake word detection active (OpenWakeWord)');

    } catch (error) {
      console.error('Failed to start wake word detection:', error.message);
      this.handleWakeWordEngineFailure(error);
    }
  }

  // --- Feature sidecar integration ---
  async startFeatureSidecar(keywordEntries) {
    const { spawn } = require('child_process');
    // Prefer configured interpreter; else local venv; else system python3
    let python = (this.config && this.config.wakeWord && this.config.wakeWord.python) || null;
    if (!python) {
      const venvPy = process.platform === 'win32'
        ? path.join(__dirname, '.venv', 'Scripts', 'python.exe')
        : path.join(__dirname, '.venv', 'bin', 'python');
      if (fs.existsSync(venvPy)) {
        python = venvPy;
      }
    }
    python = python || 'python3';
    const script = path.join(__dirname, 'feature_infer.py');
    const args = [script];
    this.sidecar = spawn(python, args, { stdio: ['pipe', 'pipe', 'inherit'] });

    this.sidecar.on('close', (code) => {
      console.warn(`Feature sidecar exited with code ${code}`);
      this.sidecar = null;
      if (this.isWakeWordListening) {
        this.handleWakeWordEngineFailure(new Error('Feature sidecar exited'));
      }
    });

    // Send config
    const models = keywordEntries.map((k) => ({ label: k.label, path: k.path, threshold: k.threshold ?? this.wakeWordThreshold }));
    // Default frameSamples to 1s of audio at current sample rate if not set
    this.wakeWordFrameSamples = this.wakeWordFrameSamples || this.wakeWordSampleRate || 16000;
    const cfg = { type: 'config', models, sampleRate: this.wakeWordSampleRate, frameSamples: this.wakeWordFrameSamples, cooldownMs: this.wakeWordDebounceMs, vad: { minRms: 0.02 } };
    this.sidecar.stdin.write(JSON.stringify(cfg) + '\n');

    // Prepare chunking into exact frames for the sidecar
    this.sidecarFrameBytes = (this.wakeWordFrameSamples || 16000) * PCM_SAMPLE_WIDTH_BYTES;
    this.sidecarAudioBuffer = Buffer.alloc(0);

    // Read results
    this.sidecarStdoutBuffer = '';
    this.sidecar.stdout.on('data', (chunk) => {
      this.sidecarStdoutBuffer += chunk.toString();
      let idx;
      while ((idx = this.sidecarStdoutBuffer.indexOf('\n')) >= 0) {
        const line = this.sidecarStdoutBuffer.slice(0, idx);
        this.sidecarStdoutBuffer = this.sidecarStdoutBuffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'score' && (argv.verbose || this.config?.wakeWord?.debug)) {
            const s = typeof msg.score === 'number' ? msg.score.toFixed(3) : String(msg.score);
            console.log(`[sidecar] ${msg.model}: ${s}`);
          }
          if (msg.type === 'detect' && typeof msg.model === 'string' && typeof msg.score === 'number') {
            console.log(`[sidecar] DETECT ${msg.model} ${msg.score.toFixed(3)}`);
            this.onWakeWordDetected(msg.model.toLowerCase(), msg.score, msg.model);
          }
        } catch (e) {
          console.warn('Failed to parse sidecar line:', line);
        }
      }
    });
  }

  stopFeatureSidecar() {
    try {
      if (this.sidecar) {
        try { this.sidecar.stdin && this.sidecar.stdin.end(); } catch (_) {}
        try { this.sidecar.kill('SIGTERM'); } catch (_) {}
      }
    } catch (_) {}
    this.sidecar = null;
    this.sidecarAudioBuffer = Buffer.alloc(0);
    this.sidecarStdoutBuffer = '';
  }

  enqueueSidecarAudio(data) {
    if (!this.sidecar || !data) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.sidecarAudioBuffer = Buffer.concat([this.sidecarAudioBuffer, chunk]);
    while (this.sidecarAudioBuffer.length >= (this.sidecarFrameBytes || 32000)) {
      const frame = this.sidecarAudioBuffer.subarray(0, this.sidecarFrameBytes);
      this.sidecarAudioBuffer = this.sidecarAudioBuffer.subarray(this.sidecarFrameBytes);
      const header = Buffer.alloc(8);
      header.write('AUD0', 0);
      header.writeUInt32LE(frame.length, 4);
      try {
        this.sidecar.stdin.write(header);
        this.sidecar.stdin.write(frame);
      } catch (e) {
        console.warn('Failed to write audio to sidecar:', e.message);
        break;
      }
    }
  }

  handleWakeWordEngineFailure(error) {
    if (this.wakeWordEngineFailed) {
      return;
    }

    this.wakeWordEngineFailed = true;
    this.isWakeWordListening = false;
    const errMsg = (error && error.message) ? error.message : 'unknown error';
    console.error('Wake word engine failure:', errMsg);

    // Clean up resources
    this.releaseWakeWordEngine();
    this.wakeWordDetectionQueue = Promise.resolve();

    if (this.recordingStream) {
      try {
        this.recordingStream.stop();
      } catch (streamError) {
        console.warn('Unable to stop recording stream during failure:', streamError.message);
      }
      this.recordingStream = null;
    }

    // Attempt automatic restart a few times before falling back to test mode
    if (this.wakeWordRestartAttempts < this.maxWakeWordRestarts) {
      this.wakeWordRestartAttempts += 1;
      const attempt = this.wakeWordRestartAttempts;
      console.log(`Attempting to restart wake word engine (${attempt}/${this.maxWakeWordRestarts}) in 500ms...`);
      setTimeout(() => {
        this.wakeWordEngineFailed = false;
        this.restartWakeWordDetection().catch((e) => {
          console.error('Wake word engine restart failed:', e.message);
        });
      }, 500);
      return;
    }

    console.log('Falling back to test mode. Press ENTER to simulate wake word triggers while troubleshooting OpenWakeWord.');
    this.startTestMode();
  }

  async processAudioForWakeWord(audioData) {
    if (this.wakeWordEngineFailed || !Array.isArray(this.wakeWordSessions) || !this.wakeWordSessions.length) {
      return;
    }

    if (!audioData || audioData.length === 0) {
      return;
    }

    const bufferData = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);

    if (this.vadEnabled && this.vad) {
      this.vadBuffer = Buffer.concat([this.vadBuffer, bufferData]);
      while (this.vadBuffer.length >= VAD_FRAME_BYTES) {
        const vadFrame = this.vadBuffer.subarray(0, VAD_FRAME_BYTES);
        this.vadBuffer = this.vadBuffer.subarray(VAD_FRAME_BYTES);
        try {
          const speech = this.vad.process(this.wakeWordSampleRate, vadFrame);
          this.updateVadState(Boolean(speech));
        } catch (error) {
          console.warn(`VAD processing error (${error.message}); disabling VAD gating.`);
          this.vadEnabled = false;
          this.vad = null;
          this.vadActive = true;
          break;
        }
      }
    }

    this.wakeWordAudioBuffer = Buffer.concat([this.wakeWordAudioBuffer, bufferData]);

    const frameBytes = this.wakeWordFrameSamples * PCM_SAMPLE_WIDTH_BYTES;

    while (this.wakeWordAudioBuffer.length >= frameBytes) {
      const frameBuffer = this.wakeWordAudioBuffer.subarray(0, frameBytes);
      this.wakeWordAudioBuffer = this.wakeWordAudioBuffer.subarray(frameBytes);

      if (this.vadEnabled && !this.shouldEvaluateWakeWord()) {
        continue;
      }

      try {
        const detection = await this.evaluateWakeWordFrame(frameBuffer);
        if (detection) {
          this.onWakeWordDetected(detection.slug, detection.score, detection.label);
          this.wakeWordAudioBuffer = Buffer.alloc(0);
          break;
        }
      } catch (error) {
        throw error;
      }
    }
  }

  async evaluateWakeWordFrame(frameBuffer) {
    if (!frameBuffer || frameBuffer.length === 0) {
      return null;
    }

    for (const sessionInfo of this.wakeWordSessions) {
      const frameSamples = sessionInfo.frameSamples || this.wakeWordFrameSamples;
      const floatFrame = this.convertPcmFrameToFloat32(frameBuffer, frameSamples);
      let score = 0;

      if (typeof sessionInfo.run === 'function') {
        score = await sessionInfo.run(floatFrame);
      } else if (sessionInfo.session) {
        const feeds = this.buildWakeWordFeeds(floatFrame, sessionInfo);
        const outputs = await sessionInfo.session.run(feeds);
        score = this.extractWakeWordScore(outputs, sessionInfo);
      }

      if (score >= sessionInfo.threshold) {
        return {
          slug: (sessionInfo.slug || sessionInfo.label || 'wake_word').toLowerCase(),
          label: sessionInfo.label || sessionInfo.slug || 'wake_word',
          score: clamp(score, 0, 1)
        };
      }
    }

    return null;
  }

  convertPcmFrameToFloat32(frameBuffer, expectedSamples) {
    const samplesAvailable = Math.floor(frameBuffer.length / PCM_SAMPLE_WIDTH_BYTES);
    const sampleCount = Math.max(0, Math.min(expectedSamples || samplesAvailable, samplesAvailable));
    const floatValues = new Float32Array(expectedSamples || samplesAvailable);

    for (let i = 0; i < sampleCount; i += 1) {
      const sample = frameBuffer.readInt16LE(i * PCM_SAMPLE_WIDTH_BYTES);
      floatValues[i] = sample / 32768;
    }

    if (floatValues.length > sampleCount) {
      floatValues.fill(0, sampleCount);
    }

    return floatValues;
  }

  getWakeWordInputShape(sessionInfo) {
    if (Array.isArray(sessionInfo.inputShape) && sessionInfo.inputShape.length) {
      return sessionInfo.inputShape;
    }

    const frameSamples = this.wakeWordFrameSamples || 16000;
    const metaDims = Array.isArray(sessionInfo.inputDims) ? sessionInfo.inputDims.slice() : null;

    let shape;
    if (metaDims && metaDims.length) {
      // Replace dynamic/non-positive dims: set last dim to frameSamples, others to 1
      shape = metaDims.map((dim, idx) => {
        if (typeof dim === 'number' && dim > 0) return dim;
        // last dimension gets frame length, others default to 1
        return idx === metaDims.length - 1 ? frameSamples : 1;
      });
      // Ensure 3D shape [B, C, T]
      if (shape.length === 2) {
        shape = [shape[0], 1, shape[1]];
      } else if (shape.length === 1) {
        shape = [1, 1, shape[0]];
      }
    } else {
      // Fallback to [1, 1, T]
      shape = [1, 1, frameSamples];
    }

    sessionInfo.inputShape = shape;
    return shape;
  }

  buildWakeWordFeeds(floatData, sessionInfo) {
    if (!this.onnxRuntime?.Tensor) {
      throw new Error('onnxruntime Tensor constructor unavailable');
    }

    const shape = this.getWakeWordInputShape(sessionInfo);
    const elementCount = shape.reduce((total, value) => total * (value > 0 ? value : 1), 1);
    const tensorData = new Float32Array(elementCount);
    const copyLength = Math.min(elementCount, floatData.length);

    tensorData.set(floatData.subarray(0, copyLength));
    if (copyLength < elementCount) {
      tensorData.fill(0, copyLength);
    }

    const inputName = sessionInfo.inputName
      || (Array.isArray(sessionInfo.session?.inputNames) && sessionInfo.session.inputNames[0])
      || Object.keys(sessionInfo.session?.inputMetadata || { audio: null })[0]
      || 'audio';

    const feeds = {};
    feeds[inputName] = new this.onnxRuntime.Tensor('float32', tensorData, shape);
    return feeds;
  }

  extractWakeWordScore(outputs, sessionInfo) {
    if (!outputs || typeof outputs !== 'object') {
      return 0;
    }

    const candidateOutputs = Array.isArray(sessionInfo.outputNames) && sessionInfo.outputNames.length
      ? sessionInfo.outputNames
      : Object.keys(outputs);

    for (const name of candidateOutputs) {
      const value = outputs[name];
      const score = this.coerceWakeWordScore(value);
      if (typeof score === 'number' && !Number.isNaN(score)) {
        return score;
      }
    }

    const fallbackKey = Object.keys(outputs)[0];
    return this.coerceWakeWordScore(outputs[fallbackKey]) || 0;
  }

  coerceWakeWordScore(value) {
    if (value == null) {
      return 0;
    }
    if (typeof value === 'number') {
      return value;
    }
    if (Array.isArray(value)) {
      return typeof value[0] === 'number' ? value[0] : 0;
    }
    if (ArrayBuffer.isView(value) && value.length) {
      return typeof value[0] === 'number' ? value[0] : 0;
    }
    if (typeof value === 'object' && value.data) {
      return this.coerceWakeWordScore(value.data);
    }
    return 0;
  }

  updateVadState(isSpeech) {
    if (!this.vadEnabled) {
      return;
    }
    this.vadHistory.push(isSpeech ? 1 : 0);
    if (this.vadHistory.length > this.vadHistoryLength) {
      this.vadHistory.shift();
    }
    const activations = this.vadHistory.reduce((sum, value) => sum + value, 0);
    const ratio = this.vadHistory.length ? activations / this.vadHistory.length : 0;
    this.vadActive = activations >= this.vadMinActivations && ratio >= this.vadSpeechThreshold;
  }

  shouldEvaluateWakeWord() {
    if (!this.vadEnabled) {
      return true;
    }
    return this.vadActive;
  }

  async warmUpWakeWordSession(sessionInfo) {
    if (!sessionInfo || !sessionInfo.session || !this.onnxRuntime?.Tensor) {
      return;
    }

    const frameSamples = this.wakeWordFrameSamples || 16000;
    const zeroFrame = new Float32Array(frameSamples);
    const feeds = this.buildWakeWordFeeds(zeroFrame, sessionInfo);

    await sessionInfo.session.run(feeds);
  }

  onWakeWordDetected(wakeWord, confidence, displayName) {
    if (!this.isAuthenticated) {
      console.warn('Skipping wake word event: device not authenticated with hub');
      return;
    }

    const now = Date.now();
    if (now - this.lastWakeWordAt < this.wakeWordDebounceMs) {
      return;
    }
    this.lastWakeWordAt = now;

    const normalizedConfidence = clamp(confidence ?? this.wakeWordReportedConfidence, 0, 1);
    const label = displayName || wakeWord;

    console.log(`Wake word detected: "${label}" (confidence: ${normalizedConfidence.toFixed(2)})`);

    this.stats.wakeWordsDetected++;
    this.lastInteraction = new Date();

    this.sendMessage({
      type: 'wake_word_detected',
      wakeWord: wakeWord,
      confidence: normalizedConfidence,
      timestamp: this.lastInteraction.toISOString()
    });

    this.wakeWordAudioBuffer = Buffer.alloc(0);
    if (this.vadEnabled) {
      this.vadHistory = [];
      this.vadActive = false;
    }

    // Brief pause to prevent multiple detections
    this.isWakeWordListening = false;
    setTimeout(() => {
      this.isWakeWordListening = true;
    }, this.wakeWordDebounceMs);
  }

  startVoiceRecording(timeoutMs = 5000, force = false) {
    if (this.isRecording) return;

    // If simulate explicitly requested, run demo path
    if (this.captureMode === 'simulate' && !force) {
      console.log('Starting voice command recording (simulate)...');
      this.isRecording = true;
      setTimeout(() => {
        const testCommands = [
          'Turn on the living room lights',
          'Set the temperature to 72 degrees',
          'Lock all the doors',
          'What\'s the weather like?'
        ];
        const command = testCommands[Math.floor(Math.random() * testCommands.length)];
        this.onVoiceCommandRecorded(command, 0.9);
      }, 2000);
      return;
    }

    // Pause wake word mic to free the device while recording
    this.resumeWakeWordAfterCommand = false;
    this.isWakeWordListening = false;
    if (this.recordingStream) {
      try { this.recordingStream.stop(); } catch (_) {}
      this.recordingStream = null;
      this.resumeWakeWordAfterCommand = true;
    }
    this.stopFeatureSidecar();

    // Default: stream PCM to hub during listening window
    console.log('Starting voice command recording (pcm)...');
    this.isRecording = true;

    const sessionId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    this.commandSessionId = sessionId;
    this.commandSequence = 0;

    this.sendMessage({
      type: 'audio_data',
      sessionId,
      isStart: true,
      sampleRate: this.wakeWordSampleRate,
      channels: 1,
      format: 'S16LE'
    });

    try {
      const { spawn } = require('child_process');
      const device = this.config.audio.recordingDevice || this.config.audio.microphoneDevice || 'default';
      const rate = String(this.wakeWordSampleRate);
      // Prefer arecord directly to avoid sox/rec issues
      let proc = spawn('arecord', ['-q', '-D', device, '-t', 'raw', '-f', 'S16_LE', '-r', rate, '-c', '1'], { stdio: ['ignore', 'pipe', 'inherit'] });
      const attach = (p) => {
        this.commandProc = p;
        p.stdout.on('data', (buf) => {
          if (!this.isRecording || !this.commandSessionId) return;
          const b64 = Buffer.from(buf).toString('base64');
          this.sendMessage({
            type: 'audio_data',
            sessionId: this.commandSessionId,
            sequence: this.commandSequence++,
            audioData: b64,
            sampleRate: this.wakeWordSampleRate,
            channels: 1,
            format: 'S16LE'
          });
        });
        p.on('close', (code) => {
          if (this.isRecording) {
            console.warn(`Command recorder exited with code ${code}`);
          }
        });
      };
      proc.on('error', (err) => {
        console.warn(`arecord failed (${err?.message || err}); attempting rec fallback`);
        try {
          const p2 = spawn('rec', ['-q', '-c', '1', '-r', rate, '-e', 'signed-integer', '-b', '16', '-t', 'raw', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
          attach(p2);
        } catch (e2) {
          console.warn('rec fallback failed:', e2?.message || e2);
        }
      });
      attach(proc);
    } catch (e) {
      console.warn('Failed to start command recording:', e?.message || e);
    }
  }

  stopVoiceRecording() {
    if (!this.isRecording) return;

    console.log('Stopping voice command recording');
    this.isRecording = false;

    if (this.commandRecording) {
      try { this.commandRecording.stop(); } catch (_) {}
      this.commandRecording = null;
    }
    if (this.commandProc) {
      try { this.commandProc.kill('SIGTERM'); } catch (_) {}
      this.commandProc = null;
    }
    if (this.recordStopTimer) {
      clearTimeout(this.recordStopTimer);
      this.recordStopTimer = null;
    }

    const shouldResumeWakeWord = this.resumeWakeWordAfterCommand;
    this.resumeWakeWordAfterCommand = false;

    if (this.commandSessionId) {
      this.sendMessage({
        type: 'audio_data',
        sessionId: this.commandSessionId,
        sequence: this.commandSequence++,
        isFinal: true
      });
      this.commandSessionId = null;
      this.commandSequence = 0;
    }

    if (shouldResumeWakeWord) {
      setTimeout(() => {
        this.restartWakeWordDetection().catch((error) => {
          console.error('Failed to resume wake word detection after command:', error.message);
        });
      }, 250);
    } else {
      this.isWakeWordListening = true;
    }
  }

  onVoiceCommandRecorded(command, confidence) {
    console.log(`Voice command recorded: "${command}" (confidence: ${confidence})`);

    this.stats.commandsProcessed++;

    this.sendMessage({
      type: 'voice_command',
      command: command,
      confidence: confidence,
      timestamp: new Date().toISOString()
    });

    this.stopVoiceRecording();
  }

  async playTTSResponse(text, voice = 'default') {
    console.log(`Playing TTS: "${text}"`);

    // If a specific ElevenLabs voice is provided, fetch audio from the hub and play it.
    // Otherwise, fall back to local TTS or beep.
    const tryExec = (cmd) => new Promise((resolve) => exec(cmd, (err) => resolve(!err)));

    let usedRemote = false;
    try {
      const voiceId = voice && voice !== 'default' ? voice : null;
      if (voiceId) {
        const base = this.getHubHttpBase();
        const params = new URLSearchParams({ code: this.config.registrationCode || 'auto', text });
        params.set('voiceId', voiceId);
        const url = `${base}/api/remote-devices/${this.deviceId}/tts?${params.toString()}`;
        const res = await fetch(url);
        if (res.ok) {
          const arrayBuf = await res.arrayBuffer();
          const buf = Buffer.from(arrayBuf);
          const tmpPath = path.join(os.tmpdir(), `hb_el_${Date.now()}.mp3`);
          await fsp.writeFile(tmpPath, buf);
          // Play via mpg123/ffplay/play/aplay
          const played = await tryExec(`mpg123 -q "${tmpPath}"`) || await tryExec(`ffplay -nodisp -autoexit -loglevel quiet "${tmpPath}"`) || await tryExec(`play -q "${tmpPath}"`) || await tryExec(`aplay -q "${tmpPath}"`);
          try { await fsp.unlink(tmpPath); } catch (_) {}
          if (played) {
            usedRemote = true;
          }
        }
      }
    } catch (e) {
      // ignore and fall back
    }

    if (!usedRemote) {
      // Local TTS
      const escaped = (text || '').replace(/"/g, '\\"');
      let played = false;
      try {
        played = await tryExec(`espeak -s 175 -a 150 "${escaped}" 2>/dev/null`);
        if (!played) {
          const tmpWav = path.join(os.tmpdir(), `hb_tts_${Date.now()}.wav`);
          const ok = await tryExec(`pico2wave -w "${tmpWav}" "${escaped}" && aplay -q "${tmpWav}"`);
          played = ok;
          try { await fsp.unlink(tmpWav); } catch (_) {}
        }
      } catch (_) {}

      if (!played) {
        // Audible beep
        try {
          const sampleRate = 16000;
          const durationSec = 0.35;
          const freq = 880;
          const samples = Math.floor(sampleRate * durationSec);
          const buffer = new Float32Array(samples);
          for (let i = 0; i < samples; i++) {
            buffer[i] = Math.sin(2 * Math.PI * freq * (i / sampleRate)) * 0.3;
          }
          const wav = require('node-wav');
          const wavBuffer = wav.encode([buffer], { sampleRate, float: true, bitDepth: 32 });
          const tmpPath = path.join(os.tmpdir(), `hb_ping_${Date.now()}.wav`);
          await fsp.writeFile(tmpPath, wavBuffer);
          const ok = await tryExec(`aplay -q "${tmpPath}"`) || await tryExec(`play -q "${tmpPath}"`);
          try { await fsp.unlink(tmpPath); } catch (_) {}
          if (!ok) {
            console.warn('No audio player available (aplay/play). Unable to play TTS or beep.');
          }
        } catch (err) {
          console.warn('Failed to render/play audible ping:', err.message);
        }
      }
    }

    console.log(`🔊 TTS Response: "${text}"`);
  }

  verifyCommand(command) {
    return new Promise((resolve, reject) => {
      exec(`command -v ${command}`, (error) => {
        if (error) {
          reject(new Error(`"${command}" executable not found in PATH`));
        } else {
          resolve();
        }
      });
    });
  }

  normaliseHubBaseUrl(value) {
    if (!value) return null;
    let candidate = value.toString().trim();
    if (!candidate) return null;
    if (!/^https?:\/\//i.test(candidate) && !/^wss?:\/\//i.test(candidate)) {
      candidate = `http://${candidate}`;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
        parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        parsed.protocol = 'http:';
      }
      parsed.pathname = '/';
      parsed.search = '';
      parsed.hash = '';
      const normalized = parsed.toString().replace(/\/+$/, '');
      return normalized || null;
    } catch (error) {
      console.warn(`Invalid hub URL "${value}": ${error.message}`);
      return null;
    }
  }

  deriveInitialHubBaseUrl() {
    const candidates = [
      argv.hub,
      this.config.hubUrl,
      process.env.HUB_URL,
      this.config.hubWsUrl
    ];

    for (const candidate of candidates) {
      const normalized = this.normaliseHubBaseUrl(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  setHubHttpBase(value) {
    const normalized = this.normaliseHubBaseUrl(value);
    if (normalized) {
      this.hubHttpBaseUrl = normalized;
    }
    return this.hubHttpBaseUrl;
  }

  getHubHttpBase() {
    if (!this.hubHttpBaseUrl) {
      this.hubHttpBaseUrl = this.deriveInitialHubBaseUrl();
    }
    return this.hubHttpBaseUrl || 'http://localhost:3000';
  }

  buildAbsoluteHubUrl(pathOrUrl) {
    const base = `${this.getHubHttpBase()}/`;
    if (!pathOrUrl) {
      return base.replace(/\/+$/, '');
    }

    try {
      return new URL(pathOrUrl, base).toString();
    } catch (error) {
      console.warn(`Failed to resolve hub URL for ${pathOrUrl}: ${error.message}`);
      const suffix = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
      return `${this.getHubHttpBase()}${suffix}`;
    }
  }

  buildWebSocketUrl(baseUrl) {
    try {
      const url = new URL(baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = '/ws/voice-device';
      url.searchParams.set('deviceId', this.deviceId);
      return url.toString();
    } catch (error) {
      const normalized = baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
      return `${normalized}/ws/voice-device?deviceId=${this.deviceId}`;
    }
  }

  startHeartbeat() {
    console.log('Starting heartbeat...');

    this.heartbeatInterval = setInterval(() => {
      if (this.isAuthenticated) {
        this.sendHeartbeat();
      }
    }, 30000); // Every 30 seconds
  }

  sendHeartbeat() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    this.sendMessage({
      type: 'heartbeat',
      status: 'online',
      uptime: uptime,
      stats: this.stats,
      batteryLevel: this.getBatteryLevel(),
      memoryUsage: process.memoryUsage(),
      lastInteraction: this.lastInteraction?.toISOString()
    });
  }

  getBatteryLevel() {
    // For Raspberry Pi, you might check actual battery if using a HAT
    // For demo, return null (powered)
    return null;
  }

  async getNetworkInfo() {
    const os = require('os');
    const interfaces = os.networkInterfaces();

    let ipAddress = '127.0.0.1';

    // Find first non-internal IPv4 address
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ipAddress = iface.address;
          break;
        }
      }
      if (ipAddress !== '127.0.0.1') break;
    }

    return {
      ipAddress,
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch()
    };
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached. Exiting...');
      process.exit(1);
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`Reconnecting in ${delay/1000} seconds... (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connectToHub().catch((error) => {
        console.error('Reconnection failed:', error.message);
      });
    }, delay);
  }

  startTestMode() {
    if (this.testModeActive) return;

    this.testModeActive = true;
    console.log('Starting test mode - press ENTER to simulate wake word detection');

    try {
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
    } catch (error) {
      console.warn('Unable to initialize test mode input listener:', error.message);
    }

    if (!this.testModeListenerAttached) {
      this.testModeListener = (data) => {
        const input = data.toString().trim();
        if (input === '') {
          this.onWakeWordDetected('anna', 0.95, 'Anna');
        } else if (input.startsWith('/')) {
          const command = input.substring(1);
          if (command === 'stats') {
            console.log('Stats:', this.stats);
          } else if (command === 'quit') {
            this.shutdown();
          }
        }
      };
      process.stdin.on('data', this.testModeListener);
      this.testModeListenerAttached = true;
    }
  }

  async saveConfig() {
    const configPath = argv.config;
    try {
      await fs.promises.writeFile(configPath, JSON.stringify(this.config, null, 2));
      console.log(`Configuration saved to ${configPath}`);
    } catch (error) {
      console.warn('Failed to save configuration:', error.message);
    }
  }

  async startAutoDiscovery() {
    console.log('Starting automatic hub discovery...');

    try {
      // Create UDP socket for discovery
      this.discoverySocket = dgram.createSocket('udp4');

      // Set up message handler
      this.discoverySocket.on('message', (msg, rinfo) => {
        this.handleDiscoveryResponse(msg, rinfo);
      });

      this.discoverySocket.on('error', (err) => {
        console.error('Discovery socket error:', err);
        this.stopAutoDiscovery();
      });

      // Bind socket
      this.discoverySocket.bind(() => {
        this.discoverySocket.setBroadcast(true);
        console.log('Auto-discovery: UDP socket ready');

        // Start scanning for hubs
        this.scanForHubs();
      });

    } catch (error) {
      console.error('Failed to start auto-discovery:', error.message);
      throw error;
    }
  }

  scanForHubs() {
    console.log('Auto-discovery: Scanning network for HomeBrain hubs...');
    this.isScanning = true;
    this.discoveredHubs.clear();

    // Create discovery request
    const discoveryRequest = {
      type: 'homebrain_device_discovery',
      deviceId: this.generateDeviceId(),
      name: argv['device-name'] || `Remote Device ${os.hostname()}`,
      deviceType: 'speaker',
      version: PACKAGE_VERSION,
      capabilities: ['voice_commands', 'wake_word'],
      timestamp: new Date().toISOString()
    };

    const message = JSON.stringify(discoveryRequest);

    // Get broadcast addresses
    const broadcastAddresses = this.getBroadcastAddresses();

    // Send discovery requests
    broadcastAddresses.forEach(address => {
      this.discoverySocket.send(message, 0, message.length, this.discoveryPort, address, (err) => {
        if (err && err.code !== 'ENETUNREACH') {
          console.warn(`Auto-discovery: Failed to send to ${address}:`, err.message);
        }
      });
    });

    console.log(`Auto-discovery: Sent discovery requests to ${broadcastAddresses.length} broadcast addresses`);

    // Stop scanning after timeout
    setTimeout(() => {
      this.stopScanning();
    }, 10000); // 10 seconds
  }

  handleDiscoveryResponse(msg, rinfo) {
    try {
      const response = JSON.parse(msg.toString());

      if (response.type === 'homebrain_hub_response') {
        console.log(`Auto-discovery: Found HomeBrain hub at ${rinfo.address}`);

        const hubInfo = {
          ...response,
          sourceAddress: rinfo.address,
          sourcePort: rinfo.port,
          discoveredAt: new Date()
        };

        this.discoveredHubs.set(response.hubId, hubInfo);

        // Auto-select first discovered hub
        if (this.discoveredHubs.size === 1) {
          console.log(`Auto-discovery: Auto-connecting to hub: ${response.name}`);
          this.connectToDiscoveredHub(hubInfo);
        }
      }

    } catch (error) {
      console.warn('Auto-discovery: Invalid discovery response:', error.message);
    }
  }

  async connectToDiscoveredHub(hubInfo) {
    console.log(`Auto-discovery: Connecting to hub ${hubInfo.name} at ${hubInfo.address}:${hubInfo.port}`);

    try {
      // Stop discovery
      this.stopAutoDiscovery();

      // Update configuration
      this.config.hubUrl = `http://${hubInfo.address}:${hubInfo.port}`;
      this.config.hubId = hubInfo.hubId;

      // Send connection request
      await this.requestAutoConnection(hubInfo);

    } catch (error) {
      console.error('Failed to connect to discovered hub:', error.message);

      // Resume scanning if connection fails
      console.log('Auto-discovery: Resuming hub scanning...');
      setTimeout(() => {
        this.scanForHubs();
      }, 5000);
    }
  }

  async requestAutoConnection(hubInfo) {
    // Create connection request
    const connectionRequest = {
      type: 'homebrain_device_connect',
      deviceId: this.generateDeviceId(),
      name: argv['device-name'] || `Remote Device ${os.hostname()}`,
      deviceType: 'speaker',
      macAddress: this.getMacAddress(),
      firmwareVersion: PACKAGE_VERSION,
      capabilities: ['voice_commands', 'wake_word'],
      timestamp: new Date().toISOString()
    };

    const message = JSON.stringify(connectionRequest);

    // Send connection request
    const socket = dgram.createSocket('udp4');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Connection request timeout'));
      }, 10000);

      socket.on('message', async (msg, rinfo) => {
        try {
          const response = JSON.parse(msg.toString());

          if (response.type === 'homebrain_connect_response') {
            clearTimeout(timeout);
            socket.close();

            if (response.status === 'pending_approval') {
              console.log('Auto-discovery: Connection request sent, awaiting approval...');
              console.log(`Device ID: ${response.deviceId}`);
              console.log('Please approve this device in your HomeBrain web interface.');

              // Set up periodic check for approval
              this.deviceId = response.deviceId;
              this.checkForApproval(hubInfo);
              resolve(response);
            } else {
              reject(new Error(response.message || 'Connection request failed'));
            }
          }

        } catch (error) {
          clearTimeout(timeout);
          socket.close();
          reject(error);
        }
      });

      socket.send(message, 0, message.length, this.discoveryPort, hubInfo.sourceAddress, (err) => {
        if (err) {
          clearTimeout(timeout);
          socket.close();
          reject(err);
        }
      });
    });
  }

  async checkForApproval(hubInfo) {
    console.log('Auto-discovery: Checking for device approval...');

    const checkApproval = async () => {
      try {
        // Try to connect with WebSocket to see if approved
        const wsUrl = `ws://${hubInfo.address}:${hubInfo.port}/ws/voice-device/${this.deviceId}`;

        const testWs = new WebSocket(wsUrl);

        testWs.on('open', () => {
          console.log('Auto-discovery: Device approved! Continuing with normal setup...');
          testWs.close();

          // Continue with normal initialization
          this.config.deviceId = this.deviceId;
          this.config.hubWsUrl = wsUrl;
          this.continueSetup();
        });

        testWs.on('error', () => {
          // Not approved yet, try again
          setTimeout(checkApproval, 5000);
        });

      } catch (error) {
        console.error('Error checking approval:', error.message);
        setTimeout(checkApproval, 5000);
      }
    };

    // Start checking
    setTimeout(checkApproval, 2000);
  }

  async continueSetup() {
    try {
      // Save the configuration
      await this.saveConfig();

      // Load device configuration
      await this.loadDeviceConfig();

      // Connect to hub
      await this.connectToHub();

      // Start wake word detection
      if (this.hasLocalWakeWordModels()) {
        await this.startWakeWordDetection();
      } else {
        console.log('Wake word models not yet available; waiting for hub configuration...');
      }

      // Start heartbeat
      this.startHeartbeat();

      console.log('Auto-discovery: Setup completed successfully');

    } catch (error) {
      console.error('Failed to complete setup after auto-discovery:', error.message);
    }
  }

  stopScanning() {
    if (!this.isScanning) return;

    this.isScanning = false;

    if (this.discoveredHubs.size === 0) {
      console.log('Auto-discovery: No HomeBrain hubs found on the network');
      console.log('Make sure your HomeBrain hub is running and auto-discovery is enabled.');
      this.shutdown();
    } else {
      console.log(`Auto-discovery: Found ${this.discoveredHubs.size} hub(s)`);
    }
  }

  stopAutoDiscovery() {
    if (this.discoverySocket) {
      this.discoverySocket.close();
      this.discoverySocket = null;
    }
    this.isScanning = false;
    console.log('Auto-discovery: Discovery service stopped');
  }

  getBroadcastAddresses() {
    const addresses = [];
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip non-IPv4 and internal addresses
        if (iface.family !== 'IPv4' || iface.internal) {
          continue;
        }

        // Calculate broadcast address
        const ip = iface.address.split('.').map(Number);
        const netmask = iface.netmask.split('.').map(Number);
        const broadcast = ip.map((octet, i) => octet | (255 - netmask[i]));

        addresses.push(broadcast.join('.'));
      }
    }

    // Always include common broadcast address
    if (!addresses.includes('255.255.255.255')) {
      addresses.push('255.255.255.255');
    }

    return addresses;
  }

  getMacAddress() {
    const interfaces = os.networkInterfaces();

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal && iface.mac !== '00:00:00:00:00:00') {
          return iface.mac;
        }
      }
    }

    return null;
  }

  generateDeviceId() {
    return 'device-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  }

  async handleUpdateAvailable(message) {
    const { version, downloadUrl, checksum, size, mandatory } = message;

    console.log('');
    console.log('='.repeat(50));
    console.log('UPDATE AVAILABLE');
    console.log('='.repeat(50));
    console.log(`Current version: ${PACKAGE_VERSION}`);
    console.log(`New version: ${version}`);
    console.log(`Download size: ${(size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`Mandatory: ${mandatory ? 'Yes' : 'No'}`);
    console.log('='.repeat(50));
    console.log('');

    try {
      // Notify hub that update is starting
      this.sendMessage({
        type: 'update_status',
        status: 'downloading',
        version: version
      });

      // Load updater module
      const RemoteDeviceUpdater = require('./updater.js');
      const updater = new RemoteDeviceUpdater();

      await updater.initialize();

      // Perform update
      const result = await updater.performUpdate(downloadUrl, checksum, version);

      if (result.success) {
        console.log('Update completed successfully!');

        // Notify hub of success
        this.sendMessage({
          type: 'update_status',
          status: 'completed',
          version: version
        });

        // Restart device
        await updater.restartDevice();
      }

    } catch (error) {
      console.error('Update failed:', error.message);

      // Notify hub of failure
      this.sendMessage({
        type: 'update_status',
        status: 'failed',
        version: version,
        error: error.message
      });

      console.log('Continuing with current version...');
    }
  }

  shutdown() {
    console.log('Shutting down HomeBrain Remote Device...');

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    if (this.recordingStream) {
      this.recordingStream.stop();
    }

    this.releaseWakeWordEngine();
    this.disableTestMode();
    this.isWakeWordListening = false;

    if (this.ws) {
      this.ws.close();
    }

    if (this.discoverySocket) {
      this.discoverySocket.close();
    }

    process.exit(0);
  }
}

// Load configuration
async function loadConfig() {
  const configPath = argv.config;
  let config = {
    audio: {
      sampleRate: 16000,
      channels: 1,
      recordingDevice: 'default',
      playbackDevice: 'default'
    }
  };

  try {
    if (fs.existsSync(configPath)) {
      const configData = await fs.promises.readFile(configPath, 'utf8');
      config = { ...config, ...JSON.parse(configData) };
      console.log(`Configuration loaded from ${configPath}`);
    } else {
      console.log(`Configuration file not found, using defaults`);
    }
  } catch (error) {
    console.warn(`Failed to load configuration: ${error.message}`);
  }

  return config;
}

// Main execution
async function main() {
  try {
    const config = await loadConfig();
    const device = new HomeBrainRemoteDevice(config);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nReceived SIGINT, shutting down gracefully...');
      device.shutdown();
    });

    process.on('SIGTERM', () => {
      console.log('Received SIGTERM, shutting down gracefully...');
      device.shutdown();
    });

    await device.initialize();

  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

// Start the application
if (require.main === module) {
  main();
}

#!/usr/bin/env node

const WebSocket = require('ws');
const recorder = require('node-record-lpcm16');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const packageInfo = require('./package.json');

const DEFAULT_WAKE_WORD_SENSITIVITY = 0.65;
const DEFAULT_WAKE_WORD_CONFIDENCE = 0.9;
const PCM_SAMPLE_WIDTH_BYTES = 2;
const PACKAGE_VERSION = packageInfo.version;
const WAKE_WORD_USER_AGENT = `HomeBrain-Remote/${PACKAGE_VERSION}`;

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

    // Wake word detection
    this.wakeWordDisplayNames = ['Anna', 'Henry', 'Home Brain', 'Homebrain'];
    this.wakeWords = this.wakeWordDisplayNames.map((word) => word.toLowerCase());
    this.isWakeWordListening = true;
    this.wakeWordAudioBuffer = Buffer.alloc(0);
    this.porcupine = null;
    this.porcupineInitialized = false;
    this.porcupineFrameLength = 0;
    this.porcupineSampleRate = this.config.audio.sampleRate || 16000;
    this.porcupineKeywordLabels = [];
    this.porcupineSensitivities = [];
    this.porcupineReportWords = [];
    this.porcupineAccessKey = this.config.wakeWord.accessKey || process.env.PICOVOICE_ACCESS_KEY || process.env.PV_ACCESS_KEY || null;
    this.wakeWordReportedConfidence = clamp(this.config.wakeWord.reportedConfidence ?? DEFAULT_WAKE_WORD_CONFIDENCE, 0, 1);
    this.wakeWordEngineFailed = false;
    this.testModeActive = false;
    this.testModeListenerAttached = false;
    this.testModeListener = null;

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
          this.startVoiceRecording();

          setTimeout(() => {
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
      console.log(`Sending message to hub (${summary})`);
      this.ws.send(JSON.stringify(payload));
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

      if (typeof config.wakeWord.accessKey === 'string' && config.wakeWord.accessKey.trim().length > 0) {
        this.porcupineAccessKey = config.wakeWord.accessKey.trim();
      }
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
    return Boolean(this.recordingStream && this.porcupineInitialized && !this.wakeWordEngineFailed);
  }

  generateWakeWordAssetSignature(keywords = []) {
    return JSON.stringify(keywords.map((keyword) => ({
      label: keyword.label || '',
      path: keyword.path ? path.resolve(keyword.path) : '',
      sensitivity: typeof keyword.sensitivity === 'number' ? Number(keyword.sensitivity.toFixed(3)) : null
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

      const fileName = asset.fileName || `${slug}.ppn`;
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
    if (this.porcupineInitialized && this.porcupine) {
      return;
    }

    const wakeWordConfig = this.config.wakeWord || {};
    const accessKeyCandidate = typeof wakeWordConfig.accessKey === 'string' && wakeWordConfig.accessKey.trim().length > 0
      ? wakeWordConfig.accessKey.trim()
      : this.porcupineAccessKey || process.env.PICOVOICE_ACCESS_KEY || process.env.PV_ACCESS_KEY;

    if (!accessKeyCandidate) {
      throw new Error('Porcupine AccessKey not configured. Set wakeWord.accessKey in config.json or PICOVOICE_ACCESS_KEY environment variable.');
    }

    this.porcupineAccessKey = accessKeyCandidate;

    let porcupineModule;

    try {
      porcupineModule = require('@picovoice/porcupine-node');
    } catch (error) {
      throw new Error('Porcupine wake-word engine not installed. Run `npm install @picovoice/porcupine-node` on the device.');
    }

    const { Porcupine } = porcupineModule;
    if (!Porcupine) {
      throw new Error('Invalid Porcupine module: missing Porcupine export');
    }

    const keywordPaths = [];
    const keywordLabels = [];
    const keywordSensitivities = [];

    const resolveKeywordPath = (candidate) => {
      if (!candidate || (typeof candidate === 'string' && candidate.trim().length === 0)) {
        return null;
      }

      const rawPath = typeof candidate === 'string' ? candidate.trim() : candidate;
      const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(this.configDirectory, rawPath);

      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Wake word keyword file not found: ${absolutePath}`);
      }

      return absolutePath;
    };

    const addKeyword = (entry) => {
      if (!entry) return;

      if (typeof entry === 'string') {
        const resolved = resolveKeywordPath(entry);
        if (!resolved) return;
        keywordPaths.push(resolved);
        keywordLabels.push(this.formatWakeWordLabel(entry));
        keywordSensitivities.push(null);
      } else if (typeof entry === 'object' && entry.path) {
        const resolved = resolveKeywordPath(entry.path);
        if (!resolved) return;
        keywordPaths.push(resolved);
        keywordLabels.push(entry.label || this.formatWakeWordLabel(entry.path));
        keywordSensitivities.push(typeof entry.sensitivity === 'number' ? entry.sensitivity : null);
      }
    };

    if (Array.isArray(wakeWordConfig.keywordPaths)) {
      wakeWordConfig.keywordPaths.forEach(addKeyword);
    }

    if (Array.isArray(wakeWordConfig.keywords)) {
      wakeWordConfig.keywords.forEach(addKeyword);
    }

    if (Array.isArray(wakeWordConfig.keywordFiles)) {
      wakeWordConfig.keywordFiles.forEach(addKeyword);
    }

    if (wakeWordConfig.keywordPath) {
      addKeyword(wakeWordConfig.keywordPath);
    }

    if (wakeWordConfig.customWakeWordFile) {
      addKeyword(wakeWordConfig.customWakeWordFile);
    }

    if (!keywordPaths.length) {
      throw new Error('No wake-word keyword files configured. Update config.json with wakeWord.keywordPaths or wakeWord.customWakeWordFile.');
    }

    if (Array.isArray(wakeWordConfig.enabled) && wakeWordConfig.enabled.length > 0 && wakeWordConfig.enabled.length !== keywordPaths.length) {
      console.warn(`Wake word configuration mismatch: ${wakeWordConfig.enabled.length} enabled entries but ${keywordPaths.length} keyword files.`);
    }

    const baseSensitivity = clamp(
      typeof wakeWordConfig.sensitivity === 'number' ? wakeWordConfig.sensitivity : DEFAULT_WAKE_WORD_SENSITIVITY,
      0,
      1
    );

    const sensitivityValues = keywordPaths.map((_, index) => {
      if (typeof keywordSensitivities[index] === 'number') {
        return clamp(keywordSensitivities[index], 0, 1);
      }
      return baseSensitivity;
    });

    const sensitivities = Float32Array.from(sensitivityValues);

    const args = [this.porcupineAccessKey, keywordPaths, sensitivities];
    const modelPath = wakeWordConfig.modelPath || process.env.PORCUPINE_MODEL_PATH;
    const libraryPath = wakeWordConfig.libraryPath || process.env.PORCUPINE_LIBRARY_PATH;

    if (modelPath) {
      args.push(modelPath);
      if (libraryPath) {
        args.push(libraryPath);
      }
    }

    try {
      const createPorcupine = typeof Porcupine.fromKeywordPaths === 'function'
        ? Porcupine.fromKeywordPaths.bind(Porcupine)
        : typeof Porcupine.create === 'function'
          ? Porcupine.create.bind(Porcupine)
          : null;

      if (!createPorcupine) {
        throw new Error('Unsupported Porcupine binding version (missing fromKeywordPaths/create factory method)');
      }

      this.porcupine = await createPorcupine(...args);
      this.porcupineFrameLength = this.porcupine.frameLength;
      this.porcupineSampleRate = this.porcupine.sampleRate;
      this.porcupineKeywordLabels = keywordLabels;
      this.porcupineSensitivities = sensitivityValues;
      this.porcupineReportWords = [];
      this.wakeWordAudioBuffer = Buffer.alloc(0);
      this.porcupineInitialized = true;
      this.wakeWordEngineFailed = false;

      const configuredNames = Array.isArray(wakeWordConfig.enabled) ? wakeWordConfig.enabled : null;
      if (configuredNames && configuredNames.length === keywordLabels.length) {
        this.wakeWordDisplayNames = configuredNames;
        this.wakeWords = configuredNames.map((w) => w.toLowerCase());
      } else if (!configuredNames || configuredNames.length === 0) {
        this.wakeWordDisplayNames = keywordLabels;
        this.wakeWords = keywordLabels.map((w) => w.toLowerCase());
      }

      this.porcupineReportWords = this.wakeWords.slice(0, keywordLabels.length);

      if (argv.verbose) {
        keywordPaths.forEach((kp, index) => {
          const label = keywordLabels[index] || kp;
          const sensitivity = sensitivityValues[index];
          console.log(`Porcupine keyword ready: ${label} (path: ${kp}, sensitivity: ${sensitivity.toFixed(2)})`);
        });
      }

    } catch (error) {
      throw new Error(`Failed to initialize Porcupine: ${error.message}`);
    }
  }

  formatWakeWordLabel(source) {
    if (!source) return 'wake_word';

    const base = typeof source === 'string'
      ? path.basename(source, path.extname(source))
      : String(source);

    return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'wake_word';
  }

  releaseWakeWordEngine() {
    if (this.porcupine) {
      try {
        if (typeof this.porcupine.release === 'function') {
          this.porcupine.release();
        }
      } catch (error) {
        console.warn('Failed to release Porcupine engine cleanly:', error.message);
      }
    }

    this.porcupine = null;
    this.porcupineInitialized = false;
    this.wakeWordAudioBuffer = Buffer.alloc(0);
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
      await this.initializeWakeWordEngine();

      this.wakeWordEngineFailed = false;
      this.wakeWordAudioBuffer = Buffer.alloc(0);

      const recordingOptions = {
        sampleRate: this.porcupineSampleRate,
        sampleRateHertz: this.porcupineSampleRate,
        threshold: this.config.audio.threshold ?? 0.5,
        verbose: false,
        recordProgram: this.config.audio.recordProgram || 'arecord',
        device: this.config.audio.recordingDevice || this.config.audio.microphoneDevice || 'default'
      };

      this.recordingStream = recorder.record(recordingOptions);
      const micStream = this.recordingStream.stream();

      micStream.on('data', (data) => {
        if (this.isWakeWordListening && !this.isRecording) {
          this.processAudioForWakeWord(data);
        }
      });

      micStream.on('error', (streamError) => {
        this.handleWakeWordEngineFailure(streamError);
      });

      this.isWakeWordListening = true;
      console.log('Wake word detection active (Porcupine)');

    } catch (error) {
      console.error('Failed to start wake word detection:', error.message);
      this.handleWakeWordEngineFailure(error);
    }
  }

  handleWakeWordEngineFailure(error) {
    if (this.wakeWordEngineFailed) {
      return;
    }

    this.wakeWordEngineFailed = true;
    this.isWakeWordListening = false;
    console.error('Wake word engine failure:', error.message);

    this.releaseWakeWordEngine();

    if (this.recordingStream) {
      try {
        this.recordingStream.stop();
      } catch (streamError) {
        console.warn('Unable to stop recording stream during failure:', streamError.message);
      }
      this.recordingStream = null;
    }

    console.log('Falling back to test mode. Press ENTER to simulate wake word triggers while troubleshooting Porcupine.');
    this.startTestMode();
  }

  processAudioForWakeWord(audioData) {
    if (!this.porcupine || !this.porcupineInitialized) {
      return;
    }

    if (!audioData || audioData.length === 0) {
      return;
    }

    if (!Buffer.isBuffer(audioData)) {
      audioData = Buffer.from(audioData);
    }

    this.wakeWordAudioBuffer = Buffer.concat([this.wakeWordAudioBuffer, audioData]);

    const frameBytes = this.porcupineFrameLength * PCM_SAMPLE_WIDTH_BYTES;

    while (this.wakeWordAudioBuffer.length >= frameBytes) {
      const frameBuffer = this.wakeWordAudioBuffer.subarray(0, frameBytes);
      this.wakeWordAudioBuffer = this.wakeWordAudioBuffer.subarray(frameBytes);

      let keywordIndex = -1;

      try {
        const pcm = new Int16Array(frameBuffer.buffer, frameBuffer.byteOffset, this.porcupineFrameLength);
        keywordIndex = this.porcupine.process(pcm);
      } catch (error) {
        console.error('Porcupine processing error:', error.message);
        this.handleWakeWordEngineFailure(error);
        return;
      }

      if (keywordIndex >= 0) {
        const label = this.porcupineKeywordLabels[keywordIndex] || this.wakeWordDisplayNames[keywordIndex] || `keyword_${keywordIndex}`;
        const reportedWakeWord = this.porcupineReportWords[keywordIndex] || label.toLowerCase();
        const confidenceSource = this.porcupineSensitivities[keywordIndex];
        const confidence = clamp(
          typeof confidenceSource === 'number' ? confidenceSource : this.wakeWordReportedConfidence,
          0,
          1
        );

        this.onWakeWordDetected(reportedWakeWord, confidence, label);
        this.wakeWordAudioBuffer = Buffer.alloc(0);
        break;
      }
    }
  }

  onWakeWordDetected(wakeWord, confidence, displayName) {
    if (!this.isAuthenticated) return;

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

    // Brief pause to prevent multiple detections
    this.isWakeWordListening = false;
    setTimeout(() => {
      this.isWakeWordListening = true;
    }, 2000);
  }

  startVoiceRecording() {
    if (this.isRecording) return;

    console.log('Starting voice command recording...');
    this.isRecording = true;

    // In production, you would record audio and send to hub
    // For demo, we'll simulate command input
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
  }

  stopVoiceRecording() {
    if (!this.isRecording) return;

    console.log('Stopping voice command recording');
    this.isRecording = false;
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

    // In production, you would play actual TTS audio
    // For demo, we'll just log the response
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

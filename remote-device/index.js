#!/usr/bin/env node

const WebSocket = require('ws');
const recorder = require('node-record-lpcm16');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const dgram = require('dgram');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
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
const DEFAULT_WAKE_WORD_MIN_RMS = 0.004;
const MAX_WAKE_WORD_MIN_RMS = 0.2;
const DEFAULT_COMMAND_PREROLL_MS = 2000;
const MAX_COMMAND_PREROLL_MS = 3000;
const PCM_SAMPLE_WIDTH_BYTES = 2;
const DEFAULT_VAD_WINDOW_MS = 30;
const DEFAULT_VAD_HISTORY = 8;
const DEFAULT_VAD_THRESHOLD = 0.35;
const PACKAGE_VERSION = packageInfo.version;
const WAKE_WORD_USER_AGENT = `HomeBrain-Remote/${PACKAGE_VERSION}`;
const VAD_BASE_SAMPLE_RATE = 16000;
const VAD_FRAME_SAMPLES = Math.round((DEFAULT_VAD_WINDOW_MS / 1000) * VAD_BASE_SAMPLE_RATE);
const VAD_FRAME_BYTES = VAD_FRAME_SAMPLES * PCM_SAMPLE_WIDTH_BYTES;
const MAX_WAKE_WORD_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_REGISTRATION_RESPONSE_BYTES = 1024 * 1024;
const MAX_TTS_AUDIO_BYTES = 32 * 1024 * 1024;
const ALLOWED_AUDIO_EXECUTABLES = new Set([
  'aplay',
  'arecord',
  'espeak',
  'ffplay',
  'mpg123',
  'pico2wave',
  'play'
]);
const FEATURE_SIDECAR_LAUNCH_COMMAND = [
  'set -eu',
  'feature_script="$1"',
  'python_can_run_sidecar() {',
  '    candidate="$1"',
  '    "$candidate" - <<\'PYCODE\' >/dev/null 2>&1',
  'import numpy',
  'import onnxruntime',
  'import openwakeword',
  'from openwakeword.utils import AudioFeatures',
  'PYCODE',
  '}',
  'run_python() {',
  '    candidate="$1"',
  '    label="$2"',
  '    if [ -z "$candidate" ]; then',
  '        return 1',
  '    fi',
  '    case "$candidate" in',
  '        */*)',
  '            if [ ! -x "$candidate" ]; then',
  '                echo "wake sidecar python candidate not executable ($label): $candidate" >&2',
  '                return 1',
  '            fi',
  '            command_path="$candidate"',
  '            ;;',
  '        *)',
  '            if ! command_path=$(command -v "$candidate" 2>/dev/null); then',
  '                echo "wake sidecar python candidate not found ($label): $candidate" >&2',
  '                return 1',
  '            fi',
  '            ;;',
  '    esac',
  '    if python_can_run_sidecar "$command_path"; then',
  '        echo "wake sidecar using python ($label): $command_path" >&2',
  '        exec "$command_path" "$feature_script"',
  '    fi',
  '    echo "wake sidecar python candidate missing required modules ($label): $command_path" >&2',
  '    return 1',
  '}',
  'configured_python="${HOMEBRAIN_WAKEWORD_PYTHON:-}"',
  'if [ -n "$configured_python" ]; then',
  '    case "$configured_python" in',
  '        python|python3|python3.10|python3.11|python3.12|python3.13)',
  '            run_python "$configured_python" configured || true',
  '            ;;',
  '        */*)',
  '            run_python "$configured_python" configured || true',
  '            ;;',
  '        *)',
  '            echo "wake sidecar ignoring unsupported configured python: $configured_python" >&2',
  '            ;;',
  '    esac',
  'fi',
  'script_dir=$(CDPATH= cd -- "$(dirname -- "$feature_script")" && pwd)',
  'run_python "$script_dir/.venv/bin/python" bundled-venv || true',
  'run_python python3 system || true',
  'echo "wake sidecar could not find a Python interpreter with numpy, onnxruntime, and openwakeword" >&2',
  'exit 1'
].join('\n');

const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);
const normalizeWakeWordMinRms = (value) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return DEFAULT_WAKE_WORD_MIN_RMS;
  }
  return clamp(numericValue, DEFAULT_WAKE_WORD_MIN_RMS, MAX_WAKE_WORD_MIN_RMS);
};
const slugify = (value) => {
  if (!value) return '';
  const input = value.toString().toLowerCase();
  let result = '';
  let pendingSeparator = false;
  for (const character of input) {
    const isAsciiLetter = character >= 'a' && character <= 'z';
    const isDigit = character >= '0' && character <= '9';
    if (isAsciiLetter || isDigit) {
      if (pendingSeparator && result) result += '-';
      result += character;
      pendingSeparator = false;
    } else if (result) {
      pendingSeparator = true;
    }
  }
  return result;
};

function trimTrailingSlashes(value) {
  const text = String(value || '');
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') end -= 1;
  return text.slice(0, end);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('This HomeBrain remote requires Node.js 20 or newer');
  }
  const signal = options.signal || globalThis.AbortSignal.timeout(timeoutMs);
  // codeql[js/request-forgery] Callers resolve resources against the validated configured HomeBrain origin and reject redirects.
  return globalThis.fetch(url, { ...options, signal });
}

async function readResponseBuffer(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Response exceeded the allowed size');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const fallback = Buffer.from(await response.arrayBuffer());
    if (fallback.length > maxBytes) throw new Error('Response exceeded the allowed size');
    return fallback;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('Response exceeded the allowed size');
        throw new Error('Response exceeded the allowed size');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

function isAllowedHubHostname(hostname) {
  let value = String(hostname || '').toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local')) return true;
  if (!value.includes('.') && !value.includes(':')) return true;
  if (net.isIPv4(value)) {
    const octets = value.split('.').map(Number);
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (net.isIPv6(value)) {
    return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
  }
  return false;
}

function normalizeAudioCommand(command, args = []) {
  if (!ALLOWED_AUDIO_EXECUTABLES.has(command)) {
    throw new Error(`Unsupported audio executable: ${String(command || '')}`);
  }
  if (!Array.isArray(args) || args.length > 64) {
    throw new Error('Invalid audio command argument list');
  }
  return {
    command,
    args: args.map((arg) => {
      if (typeof arg !== 'string' || arg.length > 16_384 || arg.includes('\0')) {
        throw new Error('Invalid audio command argument');
      }
      return arg;
    })
  };
}

function findAllowedAudioExecutable(command) {
  if (!ALLOWED_AUDIO_EXECUTABLES.has(command)) {
    return '';
  }
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch (_error) {
      // Try the next PATH entry.
    }
  }
  return '';
}

function runCommand(command, args = []) {
  let invocation;
  try {
    invocation = normalizeAudioCommand(command, args);
  } catch (_error) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- executable is allowlisted, argv is bounded, and no shell is used.
    const child = spawn(invocation.command, invocation.args, {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
      timeout: 120_000
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function detectAudioFileExtension(buffer, contentType = '') {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (type === 'audio/mpeg' || type === 'audio/mp3') return '.mp3';
  if (type === 'audio/wav' || type === 'audio/wave' || type === 'audio/x-wav') return '.wav';
  if (type === 'audio/ogg' || type === 'application/ogg') return '.ogg';
  if (type === 'audio/flac') return '.flac';

  if (Buffer.isBuffer(buffer) && buffer.length >= 3) {
    if (buffer.subarray(0, 3).toString('ascii') === 'ID3') {
      return '.mp3';
    }
    if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
      return '.mp3';
    }
  }

  if (Buffer.isBuffer(buffer) && buffer.length >= 12) {
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') {
      return '.wav';
    }
    if (buffer.subarray(0, 4).toString('ascii') === 'OggS') {
      return '.ogg';
    }
    if (buffer.subarray(0, 4).toString('ascii') === 'fLaC') {
      return '.flac';
    }
  }

  return '.bin';
}

function getPlaybackDeviceArgs(playbackDevice) {
  const device = typeof playbackDevice === 'string' ? playbackDevice.trim() : '';
  return device && device !== 'default' ? ['-D', device] : [];
}

function getAudioPlaybackCommands(filePath, options = {}) {
  const extension = String(options.extension || path.extname(filePath) || '').toLowerCase();
  const commands = [];

  if (extension === '.mp3') {
    commands.push(['mpg123', ['-q', filePath]]);
    commands.push(['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath]]);
    commands.push(['play', ['-q', filePath]]);
    return commands;
  }

  if (extension === '.wav') {
    commands.push(['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath]]);
    commands.push(['play', ['-q', filePath]]);
    commands.push(['aplay', ['-q', ...getPlaybackDeviceArgs(options.playbackDevice), filePath]]);
    return commands;
  }

  if (extension === '.ogg' || extension === '.flac') {
    commands.push(['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath]]);
    commands.push(['play', ['-q', filePath]]);
    return commands;
  }

  // Unknown compressed/remote audio must not fall through to aplay. aplay treats
  // unknown bytes as PCM and produces loud static.
  commands.push(['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath]]);
  commands.push(['play', ['-q', filePath]]);
  return commands;
}

async function playAudioFile(filePath, options = {}) {
  for (const [command, args] of getAudioPlaybackCommands(filePath, options)) {
    if (await runCommand(command, args)) {
      return true;
    }
  }
  return false;
}

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('register', {
    alias: 'r',
    type: 'string',
    description: 'Registration code for device setup'
  })
  .option('claim-token', {
    type: 'string',
    description: 'One-time claim token for device setup'
  })
  .option('register-only', {
    type: 'boolean',
    default: false,
    description: 'Activate the device, save config, and exit without starting the listener'
  })
  .option('device-id', {
    type: 'string',
    description: 'HomeBrain device ID to activate when using a claim token'
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
    this.sidecar = null;
    this.stoppingSidecars = new WeakSet();
    this.sidecarFrameBytes = 0;
    this.sidecarAudioBuffer = Buffer.alloc(0);
    this.sidecarStdoutBuffer = '';
    this.sidecarStderrBuffer = '';
    this.recordingStderrBuffer = '';
    this.captureDeviceProbeCache = null;

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
    this.commandAudioSource = null;
    this.pendingCommandPreRollBuffer = null;

    // Wake word detection
    this.wakeWordDisplayNames = ['Anna', 'Henry', 'Home Brain', 'Homebrain'];
    this.wakeWords = this.wakeWordDisplayNames.map((word) => word.toLowerCase());
    this.isWakeWordListening = true;
    this.wakeWordAudioBuffer = Buffer.alloc(0);
    this.wakeWordPreRollBuffer = Buffer.alloc(0);
    this.wakeWordEngine = 'openwakeword';
    this.wakeWordSessions = [];
    this.wakeWordFrameSamples = 0;
    this.wakeWordSampleRate = this.config.audio.sampleRate || 16000;
    this.wakeWordInputShape = new Map();
    this.onnxRuntime = null;
    this.wakeWordThreshold = clamp(this.config.wakeWord.threshold ?? this.config.wakeWord.defaultThreshold ?? DEFAULT_WAKE_WORD_THRESHOLD, 0, 1);
    this.wakeWordReportedConfidence = clamp(this.config.wakeWord.reportedConfidence ?? DEFAULT_WAKE_WORD_CONFIDENCE, 0, 1);
    this.commandPreRollMs = clamp(
      this.config.wakeWord.commandPreRollMs ?? this.voiceConfig.commandPreRollMs ?? DEFAULT_COMMAND_PREROLL_MS,
      0,
      MAX_COMMAND_PREROLL_MS
    );
    this.wakeWordEngineFailed = false;
    this.wakeWordDetectionQueue = Promise.resolve();
    this.wakeWordRestartAttempts = 0;
    this.maxWakeWordRestarts = 3;
    this.testModeActive = false;
    this.testModeListenerAttached = false;
    this.testModeListener = null;
    this.wakeWordDebounceMs = clamp(this.config.wakeWord.debounceMs ?? DEFAULT_WAKE_WORD_DEBOUNCE_MS, 250, 10000);
    this.wakeWordRuntimeReportIntervalMs = clamp(this.config.wakeWord.runtimeReportIntervalMs ?? 30000, 5000, 300000);
    this.lastWakeWordRuntimeReportAt = 0;
    this.wakeWordRuntime = null;
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

      // If onboarding credentials were provided, activate this device
      if (argv.register || argv['claim-token']) {
        await this.registerDevice({
          registrationCode: argv.register,
          claimToken: argv['claim-token'],
          deviceId: argv['device-id']
        });
        if (argv['register-only']) {
          console.log('Registration-only mode complete; listener startup is managed separately.');
          return;
        }
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

  async registerDevice({ registrationCode = '', claimToken = '', deviceId = '' } = {}) {
    const normalizedRegistrationCode = typeof registrationCode === 'string' ? registrationCode.trim() : '';
    const normalizedClaimToken = typeof claimToken === 'string' ? claimToken.trim() : '';
    const normalizedDeviceId = typeof deviceId === 'string' ? deviceId.trim() : '';

    if (!normalizedRegistrationCode && !normalizedClaimToken) {
      throw new Error('Registration code or claim token is required');
    }

    if (normalizedClaimToken && !normalizedDeviceId) {
      throw new Error('Device ID is required when registering with a claim token');
    }

    console.log(normalizedClaimToken ? 'Registering device with claim token' : `Registering device with code: ${normalizedRegistrationCode}`);

    const requestedHubUrl = argv.hub || this.config.hubUrl || process.env.HUB_URL || 'http://localhost:3000';
    const hubUrl = this.setHubHttpBase(requestedHubUrl);
    if (!hubUrl) {
      throw new Error('A valid HomeBrain hub URL is required for registration');
    }
    console.log(`Using Hub URL: ${hubUrl}`);
    this.config.hubUrl = hubUrl;
    this.config.registrationCode = normalizedRegistrationCode || null;
    this.config.claimToken = normalizedClaimToken || null;
    if (normalizedDeviceId) {
      this.config.deviceId = normalizedDeviceId;
      this.deviceId = normalizedDeviceId;
    }
    try {
      // Get network information
      const networkInfo = await this.getNetworkInfo();

      const activationUrl = this.buildAbsoluteHubUrl('/api/remote-devices/activate');
      const response = await fetchWithTimeout(activationUrl, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          registrationCode: normalizedRegistrationCode || undefined,
          claimToken: normalizedClaimToken || undefined,
          deviceId: normalizedDeviceId || undefined,
          ipAddress: networkInfo.ipAddress,
          firmwareVersion: PACKAGE_VERSION
        })
      }, 15_000);

      const data = JSON.parse((await readResponseBuffer(response, MAX_REGISTRATION_RESPONSE_BYTES)).toString('utf8'));

      if (!data.success) {
        throw new Error(data.message || 'Registration failed');
      }

      // Save device configuration
      this.deviceId = data.device._id;
      this.config.deviceId = this.deviceId;
      this.config.hubUrl = hubUrl;
      this.config.hubWsUrl = data.hubUrl;
      if (data.deviceToken) {
        this.config.deviceToken = data.deviceToken;
      }
      this.config.registrationCode = null;
      this.config.claimToken = null;
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

    const authMessage = {
      type: 'authenticate',
      deviceInfo: {
        version: PACKAGE_VERSION,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version
      }
    };

    if (this.config.deviceToken) {
      authMessage.deviceToken = this.config.deviceToken;
    }
    if (this.config.registrationCode) {
      authMessage.registrationCode = this.config.registrationCode;
    }
    if (this.config.claimToken) {
      authMessage.claimToken = this.config.claimToken;
    }

    this.sendMessage(authMessage);
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
          {
            const requestedTimeout = Number(message.timeout);
            const timeoutMs = Number.isFinite(requestedTimeout)
              ? Math.max(250, Math.min(30_000, Math.round(requestedTimeout)))
              : 5000;
            this.startVoiceRecording(timeoutMs, true);

            if (this.recordStopTimer) clearTimeout(this.recordStopTimer);
            // lgtm[js/resource-exhaustion] The hub-provided timeout is clamped to 250-30,000 ms immediately above.
            this.recordStopTimer = setTimeout(() => {
              if (this.isRecording) {
                this.stopVoiceRecording();
              }
            }, timeoutMs);
          }
          break;

        case 'command_processing':
          console.log('Command is being processed...');
          if (typeof message.acknowledgmentText === 'string' && message.acknowledgmentText.trim().length > 0) {
            const ackText = message.acknowledgmentText.trim();
            const ackVoice = typeof message.voice === 'string' && message.voice.trim().length > 0
              ? message.voice.trim()
              : 'default';
            void this.playTTSResponse(ackText, ackVoice).catch((error) => {
              console.warn(`Failed to play acknowledgment prompt: ${error.message}`);
            });
          }
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
    const previousRecordingSignature = this.getRecordingOptionsSignature();

    if (config.wakeWord) {
      this.config.wakeWord = {
        ...this.config.wakeWord,
        ...config.wakeWord
      };

    }

    if (Array.isArray(config.wakeWords)) {
      this.config.wakeWords = config.wakeWords;
    }

    if (config.audio && typeof config.audio === 'object') {
      const audioUpdate = this.sanitizeAudioConfig(config.audio);
      if (Object.keys(audioUpdate).length > 0) {
        this.config.audio = {
          ...this.config.audio,
          ...audioUpdate
        };
        if (typeof audioUpdate.sampleRate === 'number') {
          this.wakeWordSampleRate = audioUpdate.sampleRate;
        }
        restartNeeded = restartNeeded || previousRecordingSignature !== this.getRecordingOptionsSignature();
        console.log(`Audio config updated: recorder=${this.config.audio.recorder || this.config.audio.recordProgram || 'arecord'}, recordingDevice=${this.config.audio.recordingDevice || this.config.audio.microphoneDevice || 'default'}`);
      }
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
    return keywords.every((keyword) => {
      if (!keyword.path || !fs.existsSync(keyword.path)) {
        return false;
      }
      return !Array.isArray(keyword.dependencies) || keyword.dependencies.every((dependency) => (
        dependency.path && fs.existsSync(dependency.path)
      ));
    });
  }

  isWakeWordDetectorActive() {
    return Boolean(
      this.recordingStream
      && !this.wakeWordEngineFailed
      && (this.wakeWordSessions.length > 0 || this.sidecar)
    );
  }

  sanitizeAudioConfig(config = {}) {
    const next = {};
    const copyString = (key) => {
      if (typeof config[key] !== 'string') {
        return;
      }
      const value = config[key].trim();
      if (value) {
        next[key] = value.slice(0, 200);
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

    if (typeof config.sampleRate === 'number' && Number.isFinite(config.sampleRate)) {
      next.sampleRate = Math.max(8000, Math.min(48000, Math.round(config.sampleRate)));
    }
    if (typeof config.channels === 'number' && Number.isFinite(config.channels)) {
      next.channels = Math.max(1, Math.min(2, Math.round(config.channels)));
    }
    if (typeof config.threshold === 'number' && Number.isFinite(config.threshold)) {
      next.threshold = clamp(config.threshold, 0, 1);
    }

    return next;
  }

  getRecordingOptionsSignature() {
    const options = this.buildRecordingOptions();
    return JSON.stringify({
      sampleRate: options.sampleRate,
      channels: options.channels,
      recorder: options.recorder,
      audioType: options.audioType,
      device: options.device
    });
  }

  isAutoRecordingDevice(device) {
    const value = (device || '').toString().trim().toLowerCase();
    return value === 'auto' || value === 'jabra' || value === 'usb';
  }

  parseAlsaCaptureDevices(output = '') {
    const isDigits = (text) => Boolean(text) && [...text].every((char) => char >= '0' && char <= '9');
    const parseBracketedSegment = (segment = '') => {
      const openIndex = segment.indexOf('[');
      const closeIndex = openIndex >= 0 ? segment.indexOf(']', openIndex + 1) : -1;
      if (openIndex >= 0 && closeIndex > openIndex) {
        return {
          id: segment.slice(0, openIndex).trim(),
          name: segment.slice(openIndex + 1, closeIndex).trim()
        };
      }
      return { id: segment.trim(), name: '' };
    };

    return output
      .replaceAll('\r', '')
      .split('\n')
      .map((rawLine) => {
        const line = rawLine.trim();
        if (!line.toLowerCase().startsWith('card ')) {
          return null;
        }

        const cardSeparator = line.indexOf(':', 5);
        if (cardSeparator < 0) {
          return null;
        }

        const cardNumber = line.slice(5, cardSeparator).trim();
        if (!isDigits(cardNumber)) {
          return null;
        }

        const afterCard = line.slice(cardSeparator + 1).trim();
        const deviceMarker = afterCard.indexOf(', device ');
        if (deviceMarker < 0) {
          return null;
        }

        const cardSegment = afterCard.slice(0, deviceMarker).trim();
        const afterDevice = afterCard.slice(deviceMarker + ', device '.length).trim();
        const deviceSeparator = afterDevice.indexOf(':');
        if (deviceSeparator < 0) {
          return null;
        }

        const deviceNumber = afterDevice.slice(0, deviceSeparator).trim();
        if (!isDigits(deviceNumber)) {
          return null;
        }

        const deviceSegment = afterDevice.slice(deviceSeparator + 1).trim();
        const { id: cardId, name: cardName } = parseBracketedSegment(cardSegment);
        const { id: deviceName, name: deviceDescription } = parseBracketedSegment(deviceSegment);
        const label = [cardId, cardName, deviceName, deviceDescription]
          .filter(Boolean)
          .join(' ');
        return {
          cardNumber,
          cardId,
          cardName,
          deviceNumber,
          deviceName: deviceName.trim(),
          deviceDescription: deviceDescription.trim(),
          label,
          line: line.trim(),
          device: `plughw:${cardNumber},${deviceNumber}`
        };
      })
      .filter(Boolean);
  }

  isSafeAlsaIdentifier(value = '') {
    return Boolean(value) && [...value].every((char) => (
      (char >= 'a' && char <= 'z')
      || (char >= 'A' && char <= 'Z')
      || (char >= '0' && char <= '9')
      || char === '_'
      || char === '-'
    ));
  }

  rankAlsaCaptureDevices(devices = [], preferredName = '') {
    if (!Array.isArray(devices) || devices.length === 0) {
      return [];
    }

    const preferred = preferredName.toString().trim().toLowerCase();
    const scored = devices.map((device, index) => {
      const text = `${device.label || ''} ${device.line || ''}`.toLowerCase();
      let score = 0;
      if (preferred && text.includes(preferred)) score += 100;
      if (text.includes('jabra')) score += 80;
      if (/\busb\b/.test(text)) score += 25;
      if (/speakerphone|speak|microphone|\bmic\b/.test(text)) score += 10;
      if (/loopback|hdmi/.test(text)) score -= 50;
      return { device, index, score };
    });

    scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    return scored.map((entry) => entry.device);
  }

  selectAlsaCaptureDevice(devices = [], preferredName = '') {
    return this.rankAlsaCaptureDevices(devices, preferredName)[0] || null;
  }

  buildCaptureDeviceCandidates(devices = []) {
    const candidates = [];
    const seen = new Set();
    const push = (source, device, kind) => {
      if (!device || seen.has(device)) {
        return;
      }
      seen.add(device);
      candidates.push({
        device,
        kind,
        label: source.label,
        source
      });
    };

    for (const source of devices) {
      if (!source || !source.deviceNumber) {
        continue;
      }
      const hasCardId = this.isSafeAlsaIdentifier(source.cardId);
      if (hasCardId) {
        push(source, `plughw:CARD=${source.cardId},DEV=${source.deviceNumber}`, 'plughw-card');
        push(source, `sysdefault:CARD=${source.cardId}`, 'sysdefault-card');
        push(source, `dsnoop:CARD=${source.cardId},DEV=${source.deviceNumber}`, 'dsnoop-card');
      }
      if (source.cardNumber) {
        push(source, `plughw:${source.cardNumber},${source.deviceNumber}`, 'plughw-number');
      }
      if (hasCardId) {
        push(source, `hw:CARD=${source.cardId},DEV=${source.deviceNumber}`, 'hw-card');
      }
      if (source.cardNumber) {
        push(source, `hw:${source.cardNumber},${source.deviceNumber}`, 'hw-number');
      }
    }

    push({ label: 'ALSA default' }, 'default', 'default');
    return candidates;
  }

  listAlsaCaptureDevices() {
    const result = spawnSync('arecord', ['-l'], {
      encoding: 'utf8',
      timeout: 2000
    });

    if (result.error) {
      return {
        devices: [],
        error: result.error.message,
        output: ''
      };
    }

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    return {
      devices: this.parseAlsaCaptureDevices(output),
      error: result.status === 0 ? null : (result.stderr || `arecord -l exited with code ${result.status}`),
      output
    };
  }

  probeCaptureDevice(device, audioConfig = {}) {
    const sampleRate = String(audioConfig.sampleRate || this.wakeWordSampleRate || 16000);
    const channels = String(audioConfig.channels || 1);
    const result = spawnSync('arecord', [
      '-D', device,
      '-q',
      '-r', sampleRate,
      '-c', channels,
      '-t', 'raw',
      '-f', 'S16_LE',
      '-d', '1',
      '/dev/null'
    ], {
      encoding: 'utf8',
      timeout: 3500,
      maxBuffer: 64 * 1024
    });

    const stderr = [result.stderr, result.stdout]
      .filter(Boolean)
      .join('\n')
      .trim()
      .slice(-500);

    return {
      ok: !result.error && result.status === 0,
      exit: result.error ? result.error.message : (result.signal ? `signal ${result.signal}` : `code ${result.status}`),
      stderr: stderr || null
    };
  }

  detectPreferredCaptureDevice(preferredName = '', audioConfig = {}) {
    const cacheKey = JSON.stringify({
      preferredName,
      sampleRate: audioConfig.sampleRate || this.wakeWordSampleRate || 16000,
      channels: audioConfig.channels || 1
    });
    if (this.captureDeviceProbeCache?.key === cacheKey) {
      return this.captureDeviceProbeCache.selected;
    }

    const listed = this.listAlsaCaptureDevices();
    if (listed.error && listed.devices.length === 0) {
      console.warn(`Unable to list ALSA capture devices: ${listed.error}`);
      this.config.audio.lastCaptureProbe = {
        at: new Date().toISOString(),
        error: listed.error,
        attempts: []
      };
      return null;
    }

    const rankedDevices = this.rankAlsaCaptureDevices(listed.devices, preferredName);
    const candidates = this.buildCaptureDeviceCandidates(rankedDevices).slice(0, 16);
    if (!candidates.length) {
      console.warn('No ALSA capture devices were discovered by arecord -l');
      this.config.audio.lastCaptureProbe = {
        at: new Date().toISOString(),
        error: 'No ALSA capture devices were discovered by arecord -l',
        attempts: []
      };
      return null;
    }

    const attempts = [];
    for (const candidate of candidates) {
      const probe = this.probeCaptureDevice(candidate.device, audioConfig);
      const attempt = {
        device: candidate.device,
        kind: candidate.kind,
        label: candidate.label,
        ok: probe.ok,
        exit: probe.exit,
        stderr: probe.stderr
      };
      attempts.push(attempt);
      if (probe.ok) {
        const selected = {
          ...candidate.source,
          device: candidate.device,
          label: candidate.label
        };
        this.config.audio.lastCaptureProbe = {
          at: new Date().toISOString(),
          selected: candidate.device,
          selectedLabel: candidate.label,
          attempts
        };
        this.captureDeviceProbeCache = { key: cacheKey, selected };
        console.log(`Selected ALSA capture device ${candidate.device} (${candidate.label}) after probe`);
        return selected;
      }
    }

    const fallback = candidates[0];
    const selected = fallback ? {
      ...fallback.source,
      device: fallback.device,
      label: fallback.label
    } : null;
    this.config.audio.lastCaptureProbe = {
      at: new Date().toISOString(),
      selected: selected?.device || null,
      selectedLabel: selected?.label || null,
      error: 'No ALSA capture candidate completed a one-second probe',
      attempts
    };
    this.captureDeviceProbeCache = { key: cacheKey, selected };
    console.warn('No ALSA capture candidate completed a one-second probe; using the highest-ranked candidate for telemetry.');
    return selected;
  }

  resolveRecordingDevice(audioConfig = {}) {
    const configuredDevice = (audioConfig.recordingDevice || audioConfig.microphoneDevice || 'default').toString().trim() || 'default';
    if (!this.isAutoRecordingDevice(configuredDevice)) {
      return configuredDevice;
    }

    const preferredName = audioConfig.preferredInputName || (configuredDevice === 'auto' ? '' : configuredDevice);
    const detected = this.detectPreferredCaptureDevice(preferredName, audioConfig);
    if (detected?.device) {
      this.config.audio = {
        ...this.config.audio,
        resolvedRecordingDevice: detected.device,
        resolvedRecordingDeviceName: detected.label
      };
      return detected.device;
    }

    console.warn('Falling back to ALSA default capture device after auto selection failed.');
    return 'default';
  }

  buildRecordingOptions() {
    const audioConfig = this.config.audio || {};
    const recorderName = audioConfig.recorder || audioConfig.recordProgram || 'arecord';
    const audioType = audioConfig.audioType || 'raw';
    const device = this.resolveRecordingDevice(audioConfig);

    return {
      sampleRate: this.wakeWordSampleRate,
      sampleRateHertz: this.wakeWordSampleRate,
      channels: audioConfig.channels || 1,
      threshold: audioConfig.threshold ?? 0.5,
      verbose: false,
      recorder: recorderName,
      recordProgram: recorderName,
      audioType,
      device
    };
  }

  resetWakeWordRuntime(engine, recordingOptions = {}, extra = {}) {
    this.wakeWordRuntime = {
      engine,
      active: false,
      listening: false,
      restartedAt: new Date().toISOString(),
      recording: {
        recorder: recordingOptions.recorder || recordingOptions.recordProgram || 'arecord',
        device: recordingOptions.device || 'default',
        deviceName: this.config.audio?.resolvedRecordingDeviceName || null,
        probe: this.config.audio?.lastCaptureProbe || null,
        audioType: recordingOptions.audioType || 'raw',
        sampleRate: recordingOptions.sampleRate || recordingOptions.sampleRateHertz || this.wakeWordSampleRate,
        channels: recordingOptions.channels || 1,
        command: null,
        exit: null,
        stderr: null,
        stderrAt: null
      },
      sidecar: {
        ready: false,
        models: [],
        frameSamples: this.wakeWordFrameSamples || this.wakeWordSampleRate || 16000,
        minRms: extra.minRms ?? null,
        stderr: null,
        stderrAt: null
      },
      audio: {
        chunks: 0,
        bytes: 0,
        frames: 0,
        lastAudioAt: null,
        lastFrameRms: null,
        peakFrameRms: 0
      },
      lastScore: null,
      lastDetect: null,
      lastError: null,
      updatedAt: new Date().toISOString()
    };
  }

  updateWakeWordRuntime(updates = {}) {
    if (!this.wakeWordRuntime) {
      this.resetWakeWordRuntime(this.wakeWordEngine || 'openwakeword', this.buildRecordingOptions());
    }

    if (updates.sidecar && typeof updates.sidecar === 'object') {
      this.wakeWordRuntime.sidecar = {
        ...this.wakeWordRuntime.sidecar,
        ...updates.sidecar
      };
    }
    if (updates.recording && typeof updates.recording === 'object') {
      this.wakeWordRuntime.recording = {
        ...this.wakeWordRuntime.recording,
        ...updates.recording
      };
    }
    if (updates.audio && typeof updates.audio === 'object') {
      this.wakeWordRuntime.audio = {
        ...this.wakeWordRuntime.audio,
        ...updates.audio
      };
    }

    for (const key of ['lastScore', 'lastDetect', 'lastError']) {
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        this.wakeWordRuntime[key] = updates[key];
      }
    }

    this.wakeWordRuntime.active = this.isWakeWordDetectorActive();
    this.wakeWordRuntime.listening = Boolean(this.isWakeWordListening);
    this.wakeWordRuntime.updatedAt = new Date().toISOString();
  }

  normalizeErrorMessage(error, fallback = 'unknown error') {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }
    if (error && typeof error === 'object') {
      const details = [];
      for (const key of ['message', 'code', 'errno', 'syscall', 'path', 'spawnargs', 'signal']) {
        const value = error[key];
        if (value == null || value === '') {
          continue;
        }
        details.push(`${key}=${Array.isArray(value) ? value.join(' ') : String(value)}`);
      }
      if (details.length) {
        return details.join(' ');
      }
      try {
        const serialized = JSON.stringify(error);
        if (serialized && serialized !== '{}') {
          return serialized;
        }
      } catch (_) {}
    }
    return fallback;
  }

  attachRecordingDiagnostics() {
    const recordingProcess = this.recordingStream?.process;
    if (!recordingProcess) {
      return;
    }

    this.recordingStderrBuffer = '';
    const command = [this.recordingStream.cmd, ...(this.recordingStream.args || [])].filter(Boolean).join(' ');
    this.updateWakeWordRuntime({
      recording: {
        command: command || null,
        exit: null,
        stderr: null,
        stderrAt: null
      }
    });

    if (recordingProcess.stderr && typeof recordingProcess.stderr.on === 'function') {
      recordingProcess.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        if (!text) {
          return;
        }
        this.recordingStderrBuffer = `${this.recordingStderrBuffer}${text}`.slice(-4000);
        const trimmed = text.trim();
        if (trimmed) {
          console.warn(`[recorder] ${trimmed}`);
        }
        this.updateWakeWordRuntime({
          recording: {
            stderr: this.recordingStderrBuffer.slice(-2000),
            stderrAt: new Date().toISOString()
          }
        });
        this.reportWakeWordRuntimeStatus(false, 'recording_stderr');
      });
    }

    recordingProcess.on('close', (code, signal) => {
      this.updateWakeWordRuntime({
        recording: {
          exit: signal ? `signal ${signal}` : `code ${code}`,
          stderr: this.recordingStderrBuffer ? this.recordingStderrBuffer.slice(-2000) : this.wakeWordRuntime?.recording?.stderr || null,
          stderrAt: this.recordingStderrBuffer ? new Date().toISOString() : this.wakeWordRuntime?.recording?.stderrAt || null
        }
      });
      this.reportWakeWordRuntimeStatus(false, 'recording_exit');
    });
  }

  handleRecordingStreamError(streamError) {
    const baseMessage = this.normalizeErrorMessage(streamError, 'Recording stream error');
    const stderrTail = this.recordingStderrBuffer.trim().slice(-1000);
    const message = stderrTail && !baseMessage.includes(stderrTail)
      ? `${baseMessage}: ${stderrTail}`
      : baseMessage;
    this.updateWakeWordRuntime({
      lastError: {
        message,
        at: new Date().toISOString()
      },
      recording: {
        stderr: this.recordingStderrBuffer ? this.recordingStderrBuffer.slice(-2000) : this.wakeWordRuntime?.recording?.stderr || null,
        stderrAt: this.recordingStderrBuffer ? new Date().toISOString() : this.wakeWordRuntime?.recording?.stderrAt || null
      }
    });
    this.reportWakeWordRuntimeStatus(true, 'recording_error');
    this.handleWakeWordEngineFailure(new Error(message));
  }

  calculatePcmRms(frameBuffer) {
    if (!frameBuffer || frameBuffer.length < PCM_SAMPLE_WIDTH_BYTES) {
      return 0;
    }

    const sampleCount = Math.floor(frameBuffer.length / PCM_SAMPLE_WIDTH_BYTES);
    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const sample = frameBuffer.readInt16LE(i * PCM_SAMPLE_WIDTH_BYTES) / 32768;
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / sampleCount);
  }

  getCommandPreRollByteLimit() {
    if (!this.commandPreRollMs || this.commandPreRollMs <= 0) {
      return 0;
    }
    const sampleRate = this.wakeWordSampleRate || this.config.audio?.sampleRate || 16000;
    return Math.max(0, Math.round((this.commandPreRollMs / 1000) * sampleRate * PCM_SAMPLE_WIDTH_BYTES));
  }

  appendWakeWordPreRoll(data) {
    const limit = this.getCommandPreRollByteLimit();
    if (!limit || !data || data.length === 0) {
      return;
    }
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.wakeWordPreRollBuffer = Buffer.concat([this.wakeWordPreRollBuffer, chunk]);
    if (this.wakeWordPreRollBuffer.length > limit) {
      this.wakeWordPreRollBuffer = this.wakeWordPreRollBuffer.subarray(this.wakeWordPreRollBuffer.length - limit);
    }
  }

  captureCommandPreRoll() {
    const limit = this.getCommandPreRollByteLimit();
    if (!limit || !this.wakeWordPreRollBuffer?.length) {
      return null;
    }
    const start = Math.max(0, this.wakeWordPreRollBuffer.length - limit);
    return Buffer.from(this.wakeWordPreRollBuffer.subarray(start));
  }

  streamCommandAudioChunk(data, metadata = {}) {
    if (!this.isRecording || !this.commandSessionId || !data) {
      return false;
    }

    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!chunk.length) {
      return false;
    }

    this.sendMessage({
      type: 'audio_data',
      sessionId: this.commandSessionId,
      sequence: this.commandSequence++,
      audioData: chunk.toString('base64'),
      sampleRate: this.wakeWordSampleRate,
      channels: 1,
      format: 'S16LE',
      ...metadata
    });
    return true;
  }

  getWakeWordMinRms() {
    return normalizeWakeWordMinRms(this.config.wakeWord?.vad?.minRms);
  }

  shouldProcessWakeWordFrame(frameBuffer, rms = null) {
    const minRms = this.getWakeWordMinRms();
    if (minRms <= 0) {
      return true;
    }
    const frameRms = typeof rms === 'number' ? rms : this.calculatePcmRms(frameBuffer);
    return frameRms >= minRms;
  }

  reportWakeWordRuntimeStatus(force = false, reason = 'periodic') {
    if (!this.isAuthenticated || !this.wakeWordRuntime) {
      return false;
    }

    const now = Date.now();
    if (!force && now - this.lastWakeWordRuntimeReportAt < this.wakeWordRuntimeReportIntervalMs) {
      return false;
    }

    this.lastWakeWordRuntimeReportAt = now;
    this.updateWakeWordRuntime();
    return this.sendMessage({
      type: 'status_update',
      status: 'online',
      settings: {
        wakeWordRuntime: {
          ...this.wakeWordRuntime,
          reason
        }
      }
    });
  }

  generateWakeWordAssetSignature(keywords = []) {
    return JSON.stringify(keywords.map((keyword) => ({
      label: keyword.label || '',
      slug: keyword.slug || (keyword.label ? slugify(keyword.label) : ''),
      path: keyword.path ? path.resolve(keyword.path) : '',
      engine: keyword.engine || 'openwakeword',
      sensitivity: typeof keyword.sensitivity === 'number' ? Number(keyword.sensitivity.toFixed(3)) : null,
      threshold: typeof keyword.threshold === 'number' ? Number(keyword.threshold.toFixed(3)) : null,
      dependencies: Array.isArray(keyword.dependencies)
        ? keyword.dependencies.map((dependency) => ({
          fileName: dependency.fileName || '',
          path: dependency.path ? path.resolve(dependency.path) : ''
        }))
        : []
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

  normalizeWakeWordFileName(fileName, fallbackFileName) {
    const raw = typeof fileName === 'string' ? fileName.trim() : '';
    const fallback = typeof fallbackFileName === 'string' ? fallbackFileName.trim() : 'wake-word.tflite';
    const candidate = raw || fallback;
    const baseName = path.basename(candidate);
    if (!baseName || baseName !== candidate || baseName.includes('/') || baseName.includes('\\')) {
      throw new Error(`Invalid wake word asset file name: ${candidate}`);
    }
    return baseName;
  }

  async syncWakeWordFile({ label, localPath, downloadUrl, expectedChecksum, kind = 'model' }) {
    if (await this.needsWakeWordDownload(localPath, expectedChecksum)) {
      console.log(`Downloading wake word ${kind} for "${label}"...`);
      const buffer = await this.downloadWakeWordAsset(downloadUrl);
      const actualChecksum = crypto.createHash('sha256').update(buffer).digest('hex');
      if (expectedChecksum && actualChecksum !== expectedChecksum) {
        throw new Error(`Checksum mismatch for wake word ${kind} "${label}" (expected ${expectedChecksum}, received ${actualChecksum})`);
      }
      await fs.promises.writeFile(localPath, buffer);
      console.log(`Saved wake word ${kind} for "${label}" to ${localPath}`);
      return true;
    }

    console.log(`Wake word ${kind} for "${label}" already up to date at ${localPath}`);
    return false;
  }

  async downloadWakeWordAsset(url) {
    const downloadUrl = this.buildAbsoluteHubUrl(url);
    const response = await fetchWithTimeout(downloadUrl, {
      method: 'GET',
      redirect: 'error',
      headers: {
        'User-Agent': WAKE_WORD_USER_AGENT,
        'Accept': 'application/octet-stream',
        ...this.getDeviceAuthHeaders()
      }
    }, 15_000);

    if (!response.ok) {
      throw new Error(`Failed to download wake word asset (${response.status} ${response.statusText})`);
    }

    return readResponseBuffer(response, MAX_WAKE_WORD_ASSET_BYTES);
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
      const fileName = this.normalizeWakeWordFileName(asset.fileName, `${slug}.${fallbackFormat}`);
      const localPath = path.resolve(cacheDir, fileName);
      const downloadUrl = asset.downloadUrl ? this.buildAbsoluteHubUrl(asset.downloadUrl) : null;

      if (!downloadUrl) {
        console.warn(`Wake word asset "${label}" is missing a download URL`);
        continue;
      }

      if (await this.syncWakeWordFile({
        label,
        localPath,
        downloadUrl,
        expectedChecksum: asset.checksum || null,
        kind: 'model'
      })) {
        assetsChanged = true;
      }

      const dependencies = [];
      for (const dependency of Array.isArray(asset.dependencies) ? asset.dependencies : []) {
        const dependencyFileName = this.normalizeWakeWordFileName(dependency.fileName, '');
        const dependencyUrl = dependency.downloadUrl ? this.buildAbsoluteHubUrl(dependency.downloadUrl) : null;
        if (!dependencyUrl) {
          console.warn(`Wake word dependency "${dependencyFileName}" for "${label}" is missing a download URL`);
          continue;
        }
        const dependencyPath = path.resolve(cacheDir, dependencyFileName);
        if (await this.syncWakeWordFile({
          label,
          localPath: dependencyPath,
          downloadUrl: dependencyUrl,
          expectedChecksum: dependency.checksum || null,
          kind: `dependency ${dependencyFileName}`
        })) {
          assetsChanged = true;
        }
        dependencies.push({
          ...dependency,
          fileName: dependencyFileName,
          localPath: dependencyPath
        });
      }

      keywords.push({
        label,
        path: localPath,
        slug,
        engine: asset.engine || 'openwakeword',
        format: asset.format || path.extname(fileName).slice(1),
        threshold: typeof asset.threshold === 'number' ? clamp(asset.threshold, 0, 1) : undefined,
        sensitivity: typeof asset.sensitivity === 'number' ? clamp(asset.sensitivity, 0, 1) : undefined,
        dependencies: dependencies.map((dependency) => ({
          fileName: dependency.fileName,
          path: dependency.localPath
        }))
      });

      normalizedAssets.push({
        ...asset,
        label,
        slug,
        fileName,
        localPath,
        dependencies
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
    this.isWakeWordListening = false;
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
        const recordingOptions = this.buildRecordingOptions();
        const minRms = this.getWakeWordMinRms();
        this.resetWakeWordRuntime('FeatureSidecar/OWW', recordingOptions, { minRms });
        await this.startFeatureSidecar(keywordEntries);
        this.wakeWordEngineFailed = false;
        this.wakeWordAudioBuffer = Buffer.alloc(0);
        this.wakeWordDetectionQueue = Promise.resolve();

        this.recordingStream = recorder.record(recordingOptions);
        this.attachRecordingDiagnostics();
        const micStream = this.recordingStream.stream();

        micStream.on('data', (data) => {
          const audioChunk = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data);
          if (this.isRecording) {
            this.streamCommandAudioChunk(audioChunk, { source: 'wake_stream' });
            return;
          }
          if (!this.isWakeWordListening) {
            this.appendWakeWordPreRoll(audioChunk);
            return;
          }
          this.enqueueSidecarAudio(audioChunk);
        });

        micStream.on('error', (streamError) => {
          if (!this.isWakeWordListening) {
            return;
          }
          this.handleRecordingStreamError(streamError);
        });

        this.isWakeWordListening = true;
        this.wakeWordRestartAttempts = 0;
        console.log('Wake word detection active (FeatureSidecar/OWW)');
        this.reportWakeWordRuntimeStatus(true, 'started');
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

      const recordingOptions = this.buildRecordingOptions();
      this.resetWakeWordRuntime('OpenWakeWord', recordingOptions);

      this.recordingStream = recorder.record(recordingOptions);
      this.attachRecordingDiagnostics();
      const micStream = this.recordingStream.stream();

      micStream.on('data', (data) => {
        const audioChunk = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data);
        if (this.isRecording) {
          this.streamCommandAudioChunk(audioChunk, { source: 'wake_stream' });
          return;
        }
        if (!this.isWakeWordListening) {
          this.appendWakeWordPreRoll(audioChunk);
          return;
        }

        this.wakeWordDetectionQueue = this.wakeWordDetectionQueue
          .then(() => this.processAudioForWakeWord(audioChunk))
          .catch((processingError) => {
            console.error('Wake word processing error:', processingError.message);
            this.handleWakeWordEngineFailure(processingError);
          });
      });

      micStream.on('error', (streamError) => {
        if (!this.isWakeWordListening) {
          return;
        }
        this.handleRecordingStreamError(streamError);
      });

      this.isWakeWordListening = true;
      this.wakeWordRestartAttempts = 0;
      console.log('Wake word detection active (OpenWakeWord)');
      this.reportWakeWordRuntimeStatus(true, 'started');

    } catch (error) {
      console.error('Failed to start wake word detection:', error.message);
      this.updateWakeWordRuntime({
        lastError: {
          message: error.message,
          at: new Date().toISOString()
        }
      });
      this.reportWakeWordRuntimeStatus(true, 'start_failed');
      this.handleWakeWordEngineFailure(error);
    }
  }

  // --- Feature sidecar integration ---
  buildFeatureSidecarLaunchEnvironment() {
    const env = { ...process.env };
    const configuredPython = String(this.config?.wakeWord?.python || '').trim();
    if (configuredPython) {
      env.HOMEBRAIN_WAKEWORD_PYTHON = configuredPython;
    } else {
      delete env.HOMEBRAIN_WAKEWORD_PYTHON;
    }
    return env;
  }

  async startFeatureSidecar(keywordEntries) {
    const { spawn } = require('child_process');
    const featureScript = path.join(__dirname, 'feature_infer.py');
    const sidecar = spawn('sh', ['-c', FEATURE_SIDECAR_LAUNCH_COMMAND, 'homebrain-feature-sidecar', featureScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.buildFeatureSidecarLaunchEnvironment()
    });
    this.sidecar = sidecar;
    this.sidecarStderrBuffer = '';

    sidecar.on('error', (error) => {
      if (this.sidecar !== sidecar) {
        return;
      }

      const message = error?.message || String(error);
      console.warn(`Feature sidecar failed to start: ${message}`);
      this.sidecar = null;
      this.updateWakeWordRuntime({
        lastError: {
          message: `Feature sidecar failed to start: ${message}`,
          at: new Date().toISOString()
        }
      });
      this.reportWakeWordRuntimeStatus(true, 'sidecar_error');
      if (this.isWakeWordListening) {
        this.handleWakeWordEngineFailure(error);
      }
    });

    sidecar.stderr.on('data', (chunk) => {
      if (this.sidecar !== sidecar) {
        return;
      }

      const text = chunk.toString();
      if (!text) {
        return;
      }

      this.sidecarStderrBuffer = `${this.sidecarStderrBuffer}${text}`.slice(-4000);
      const trimmed = text.trim();
      if (trimmed) {
        console.warn(`[sidecar] ${trimmed}`);
      }
      this.updateWakeWordRuntime({
        sidecar: {
          stderr: this.sidecarStderrBuffer.slice(-2000),
          stderrAt: new Date().toISOString()
        }
      });
      this.reportWakeWordRuntimeStatus(false, 'sidecar_stderr');
    });

    sidecar.on('close', (code, signal) => {
      const intentionallyStopped = this.stoppingSidecars.has(sidecar);
      this.stoppingSidecars.delete(sidecar);
      if (this.sidecar !== sidecar) {
        return;
      }

      const details = signal ? `signal ${signal}` : `code ${code}`;
      this.sidecar = null;
      if (intentionallyStopped) {
        return;
      }

      console.warn(`Feature sidecar exited with ${details}`);
      const stderrTail = this.sidecarStderrBuffer.trim().slice(-1000);
      const message = stderrTail
        ? `Feature sidecar exited with ${details}: ${stderrTail}`
        : `Feature sidecar exited with ${details}`;
      this.updateWakeWordRuntime({
        lastError: {
          message,
          at: new Date().toISOString()
        }
      });
      this.reportWakeWordRuntimeStatus(true, 'sidecar_closed');
      if (this.isWakeWordListening) {
        this.handleWakeWordEngineFailure(new Error(message));
      }
    });

    // Send config
    const models = keywordEntries.map((k) => ({ label: k.label, path: k.path, threshold: k.threshold ?? this.wakeWordThreshold }));
    // Default frameSamples to 1s of audio at current sample rate if not set
    this.wakeWordFrameSamples = this.wakeWordFrameSamples || this.wakeWordSampleRate || 16000;
    const minRms = this.getWakeWordMinRms();
    const cfg = { type: 'config', models, sampleRate: this.wakeWordSampleRate, frameSamples: this.wakeWordFrameSamples, cooldownMs: this.wakeWordDebounceMs, vad: { minRms } };

    // Prepare chunking into exact frames for the sidecar
    this.sidecarFrameBytes = (this.wakeWordFrameSamples || 16000) * PCM_SAMPLE_WIDTH_BYTES;
    this.sidecarAudioBuffer = Buffer.alloc(0);

    // Read results
    this.sidecarStdoutBuffer = '';
    sidecar.stdout.on('data', (chunk) => {
      if (this.sidecar !== sidecar) {
        return;
      }

      this.sidecarStdoutBuffer += chunk.toString();
      let idx;
      while ((idx = this.sidecarStdoutBuffer.indexOf('\n')) >= 0) {
        const line = this.sidecarStdoutBuffer.slice(0, idx);
        this.sidecarStdoutBuffer = this.sidecarStdoutBuffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ready') {
            this.updateWakeWordRuntime({
              sidecar: {
                ready: true,
                models: Array.isArray(msg.models) ? msg.models : [],
                readyAt: new Date().toISOString()
              }
            });
            this.reportWakeWordRuntimeStatus(true, 'sidecar_ready');
            if (argv.verbose || this.config?.wakeWord?.debug) {
              console.log(`[sidecar] ready: ${JSON.stringify(msg.models || [])}`);
            }
          }
          if (msg.type === 'error') {
            this.updateWakeWordRuntime({
              lastError: {
                message: msg.message || 'unknown sidecar error',
                at: new Date().toISOString()
              }
            });
            this.reportWakeWordRuntimeStatus(true, 'sidecar_error');
            console.warn(`[sidecar] error: ${msg.message || 'unknown error'}`);
          }
          if (msg.type === 'score') {
            this.updateWakeWordRuntime({
              lastScore: {
                model: msg.model || 'unknown',
                score: typeof msg.score === 'number' ? msg.score : null,
                at: new Date().toISOString()
              }
            });
            this.reportWakeWordRuntimeStatus(false, 'score');
            if (argv.verbose || this.config?.wakeWord?.debug) {
              const s = typeof msg.score === 'number' ? msg.score.toFixed(3) : String(msg.score);
              console.log(`[sidecar] ${msg.model}: ${s}`);
            }
          }
          if (msg.type === 'detect' && typeof msg.model === 'string' && typeof msg.score === 'number') {
            this.updateWakeWordRuntime({
              lastDetect: {
                model: msg.model,
                score: msg.score,
                at: new Date().toISOString()
              }
            });
            this.reportWakeWordRuntimeStatus(true, 'detect');
            console.log(`[sidecar] DETECT ${msg.model} ${msg.score.toFixed(3)}`);
            this.onWakeWordDetected(msg.model.toLowerCase(), msg.score, msg.model);
          }
        } catch (e) {
          console.warn('Failed to parse sidecar line:', line);
        }
      }
    });

    sidecar.stdin.write(JSON.stringify(cfg) + '\n');
  }

  stopFeatureSidecar() {
    try {
      if (this.sidecar) {
        const sidecar = this.sidecar;
        this.stoppingSidecars.add(sidecar);
        try { sidecar.stdin && sidecar.stdin.end(); } catch (_) {}
        try { sidecar.kill('SIGTERM'); } catch (_) {}
      }
    } catch (_) {}
    this.sidecar = null;
    this.sidecarAudioBuffer = Buffer.alloc(0);
    this.sidecarStdoutBuffer = '';
    this.sidecarStderrBuffer = '';
  }

  enqueueSidecarAudio(data) {
    if (!this.sidecar || !data) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.appendWakeWordPreRoll(chunk);
    const chunkStats = this.wakeWordRuntime?.audio || {};
    this.updateWakeWordRuntime({
      audio: {
        chunks: (chunkStats.chunks || 0) + 1,
        bytes: (chunkStats.bytes || 0) + chunk.length,
        lastAudioAt: new Date().toISOString()
      }
    });
    this.sidecarAudioBuffer = Buffer.concat([this.sidecarAudioBuffer, chunk]);
    while (this.sidecarAudioBuffer.length >= (this.sidecarFrameBytes || 32000)) {
      const frame = this.sidecarAudioBuffer.subarray(0, this.sidecarFrameBytes);
      this.sidecarAudioBuffer = this.sidecarAudioBuffer.subarray(this.sidecarFrameBytes);
      const rms = this.calculatePcmRms(frame);
      const audioStats = this.wakeWordRuntime?.audio || {};
      this.updateWakeWordRuntime({
        audio: {
          frames: (audioStats.frames || 0) + 1,
          lastFrameRms: Number(rms.toFixed(6)),
          peakFrameRms: Number(Math.max(audioStats.peakFrameRms || 0, rms).toFixed(6)),
          lastAudioAt: new Date().toISOString()
        }
      });
      this.reportWakeWordRuntimeStatus(false, 'audio_frame');
      if (!this.shouldProcessWakeWordFrame(frame, rms)) {
        continue;
      }
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
    const errMsg = this.normalizeErrorMessage(error, 'unknown error');
    console.error('Wake word engine failure:', errMsg);
    this.updateWakeWordRuntime({
      lastError: {
        message: errMsg,
        at: new Date().toISOString()
      }
    });
    this.reportWakeWordRuntimeStatus(true, 'engine_failure');

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
    this.appendWakeWordPreRoll(bufferData);
    const chunkStats = this.wakeWordRuntime?.audio || {};
    this.updateWakeWordRuntime({
      audio: {
        chunks: (chunkStats.chunks || 0) + 1,
        bytes: (chunkStats.bytes || 0) + bufferData.length,
        lastAudioAt: new Date().toISOString()
      }
    });

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
      const rms = this.calculatePcmRms(frameBuffer);
      const audioStats = this.wakeWordRuntime?.audio || {};
      this.updateWakeWordRuntime({
        audio: {
          frames: (audioStats.frames || 0) + 1,
          lastFrameRms: Number(rms.toFixed(6)),
          peakFrameRms: Number(Math.max(audioStats.peakFrameRms || 0, rms).toFixed(6)),
          lastAudioAt: new Date().toISOString()
        }
      });
      this.reportWakeWordRuntimeStatus(false, 'audio_frame');
      if (!this.shouldProcessWakeWordFrame(frameBuffer, rms)) {
        continue;
      }

      if (this.vadEnabled && !this.shouldEvaluateWakeWord()) {
        continue;
      }

      try {
        const detection = await this.evaluateWakeWordFrame(frameBuffer);
        if (detection) {
          this.updateWakeWordRuntime({
            lastDetect: {
              model: detection.label,
              score: detection.score,
              at: new Date().toISOString()
            }
          });
          this.reportWakeWordRuntimeStatus(true, 'detect');
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

      this.updateWakeWordRuntime({
        lastScore: {
          model: sessionInfo.label || sessionInfo.slug || 'wake_word',
          score: typeof score === 'number' ? score : null,
          at: new Date().toISOString()
        }
      });

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
    this.updateWakeWordRuntime({
      lastDetect: {
        model: label,
        score: normalizedConfidence,
        at: this.lastInteraction.toISOString()
      }
    });

    this.sendMessage({
      type: 'wake_word_detected',
      wakeWord: wakeWord,
      confidence: normalizedConfidence,
      timestamp: this.lastInteraction.toISOString()
    });
    this.reportWakeWordRuntimeStatus(true, 'wake_word_detected');

    this.pendingCommandPreRollBuffer = this.captureCommandPreRoll();
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

    // Reuse the wake-word mic stream for command audio when it is already open.
    // USB speakerphones are much more reliable when ALSA is not torn down and
    // reopened between wake detection and command capture.
    const reuseWakeStream = Boolean(this.recordingStream);
    this.resumeWakeWordAfterCommand = false;
    this.isWakeWordListening = false;
    if (reuseWakeStream) {
      this.resumeWakeWordAfterCommand = true;
      this.commandAudioSource = 'wake_stream';
    } else {
      this.commandAudioSource = 'arecord';
    }
    this.stopFeatureSidecar();

    // Default: stream PCM to hub during listening window
    console.log(`Starting voice command recording (pcm via ${this.commandAudioSource})...`);
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

    const preRollBuffer = this.pendingCommandPreRollBuffer;
    this.pendingCommandPreRollBuffer = null;
    if (Buffer.isBuffer(preRollBuffer) && preRollBuffer.length > 0) {
      this.streamCommandAudioChunk(preRollBuffer, {
        preRoll: true
      });
    }

    if (reuseWakeStream) {
      return;
    }

    const startCommandCapture = (attempt = 0) => {
      if (!this.isRecording) return;
      try {
        const { spawn } = require('child_process');
        const recordingOptions = this.buildRecordingOptions();
        const device = recordingOptions.device || 'default';
        const rate = String(recordingOptions.sampleRate || recordingOptions.sampleRateHertz || this.wakeWordSampleRate);
        const channels = String(recordingOptions.channels || 1);
        let sawAudio = false;
        // Prefer arecord directly to avoid sox/rec issues
        console.log(`Starting voice command capture on ${device}`);
        let proc = spawn('arecord', ['-q', '-D', device, '-t', 'raw', '-f', 'S16_LE', '-r', rate, '-c', channels], { stdio: ['ignore', 'pipe', 'inherit'] });
        const attach = (p) => {
          this.commandProc = p;
          p.stdout.on('data', (buf) => {
            sawAudio = true;
            this.streamCommandAudioChunk(buf, { source: 'arecord' });
          });
          p.on('close', (code) => {
            if (this.isRecording) {
              console.warn(`Command recorder exited with code ${code}`);
              if (!sawAudio && attempt < 1) {
                setTimeout(() => startCommandCapture(attempt + 1), 400);
              }
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
    };

    const delayMs = this.resumeWakeWordAfterCommand ? 250 : 0;
    setTimeout(() => startCommandCapture(), delayMs);
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
    this.commandAudioSource = null;

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

    // Ask the hub for TTS first; the hub decides whether S2 Pro, ElevenLabs, or
    // another provider should generate the audio.
    let usedRemote = false;
    try {
      const base = this.getHubHttpBase();
      const params = new URLSearchParams({ text });
      if (!this.config.deviceToken) {
        if (this.config.registrationCode) {
          params.set('code', this.config.registrationCode);
        } else if (this.config.claimToken) {
          params.set('claim', this.config.claimToken);
        }
      }
      const voiceId = voice && voice !== 'default' ? voice : null;
      if (voiceId) {
        params.set('voiceId', voiceId);
      }
      const url = `${base}/api/remote-devices/${this.deviceId}/tts?${params.toString()}`;
      const res = await fetchWithTimeout(url, {
        redirect: 'error',
        headers: this.getDeviceAuthHeaders()
      }, 30_000);
      if (res.ok) {
        const buf = await readResponseBuffer(res, MAX_TTS_AUDIO_BYTES);
        const contentType = typeof res.headers?.get === 'function' ? res.headers.get('content-type') : '';
        const extension = detectAudioFileExtension(buf, contentType);
        const tmpPath = path.join(os.tmpdir(), `hb_tts_${Date.now()}${extension}`);
        await fsp.writeFile(tmpPath, buf);
        const played = await playAudioFile(tmpPath, {
          extension,
          playbackDevice: this.config.audio?.playbackDevice
        });
        try { await fsp.unlink(tmpPath); } catch (_) {}
        if (played) {
          usedRemote = true;
        }
      }
    } catch (e) {
      // ignore and fall back
    }

    if (!usedRemote) {
      // Local TTS
      const ttsText = String(text || '');
      let played = false;
      try {
        played = await runCommand('espeak', ['-s', '175', '-a', '150', ttsText]);
        if (!played) {
          const tmpWav = path.join(os.tmpdir(), `hb_tts_${Date.now()}.wav`);
          const rendered = await runCommand('pico2wave', ['-w', tmpWav, ttsText]);
          played = rendered && await playAudioFile(tmpWav, {
            extension: '.wav',
            playbackDevice: this.config.audio?.playbackDevice
          });
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
          const wavBuffer = wav.encode([buffer], { sampleRate, float: false, bitDepth: 16 });
          const tmpPath = path.join(os.tmpdir(), `hb_ping_${Date.now()}.wav`);
          await fsp.writeFile(tmpPath, wavBuffer);
          const ok = await playAudioFile(tmpPath, {
            extension: '.wav',
            playbackDevice: this.config.audio?.playbackDevice
          });
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
    if (!findAllowedAudioExecutable(command)) {
      return Promise.reject(new Error(`"${command}" executable not found in PATH`));
    }
    return Promise.resolve();
  }

  normaliseHubBaseUrl(value) {
    if (!value) return null;
    let candidate = value.toString().trim();
    if (!candidate) return null;
    if (!candidate.toLowerCase().startsWith('http://')
      && !candidate.toLowerCase().startsWith('https://')
      // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
      && !candidate.toLowerCase().startsWith('ws://') // Private/loopback LAN hubs may use HTTP.
      && !candidate.toLowerCase().startsWith('wss://')) {
      candidate = `http://${candidate}`;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
        parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      if (parsed.username || parsed.password) {
        return null;
      }
      if (parsed.protocol === 'http:' && !isAllowedHubHostname(parsed.hostname)) {
        console.warn('Public HomeBrain hub URLs must use HTTPS');
        return null;
      }
      parsed.pathname = '/';
      parsed.search = '';
      parsed.hash = '';
      const normalized = parsed.origin;
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

  getDeviceAuthHeaders() {
    if (this.config.deviceToken) {
      return {
        'X-HomeBrain-Device-Token': this.config.deviceToken
      };
    }

    if (this.config.registrationCode) {
      return {
        'X-HomeBrain-Registration-Code': this.config.registrationCode
      };
    }

    if (this.config.claimToken) {
      return {
        'X-HomeBrain-Claim-Token': this.config.claimToken
      };
    }

    return {};
  }

  buildAbsoluteHubUrl(pathOrUrl) {
    const base = `${this.getHubHttpBase()}/`;
    if (!pathOrUrl) {
      return trimTrailingSlashes(base);
    }

    const baseUrl = new URL(base);
    const resolved = new URL(pathOrUrl, baseUrl);
    if (resolved.origin !== baseUrl.origin || resolved.username || resolved.password) {
      throw new Error('Hub resource URL must use the configured HomeBrain origin');
    }
    resolved.hash = '';
    return resolved.toString();
  }

  buildWebSocketUrl(baseUrl) {
    const normalizedBaseUrl = this.normaliseHubBaseUrl(baseUrl);
    if (!normalizedBaseUrl) throw new Error('A valid HomeBrain hub URL is required');
    const url = new URL(normalizedBaseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws/voice-device';
    url.searchParams.set('deviceId', this.deviceId);
    return url.toString();
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
      firmwareVersion: PACKAGE_VERSION,
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
      this.config.hubUrl = hubInfo.baseUrl || `http://${hubInfo.address}:${hubInfo.port}`;
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
        // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
        const wsUrl = `ws://${hubInfo.address}:${hubInfo.port}/ws/voice-device/${this.deviceId}`; // UDP discovery yields a local-LAN address.

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
      const updater = new RemoteDeviceUpdater({
        allowedOrigin: this.getHubHttpBase(),
        maxDownloadBytes: Number.isFinite(Number(size)) && Number(size) > 0
          ? Math.min(Math.ceil(Number(size) * 1.1), 256 * 1024 * 1024)
          : undefined
      });

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
    },
    deviceToken: null,
    registrationCode: null,
    claimToken: null
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

module.exports = {
  HomeBrainRemoteDevice,
  loadConfig,
  detectAudioFileExtension,
  getAudioPlaybackCommands,
  normalizeAudioCommand
};

// Start the application
if (require.main === module) {
  main();
}

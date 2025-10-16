const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const WhisperConfig = require('../models/WhisperConfig');

const AVAILABLE_MODELS = [
  {
    name: 'tiny',
    sizeLabel: '~75 MB',
    languages: ['multi'],
    notes: 'Fastest, lowest accuracy'
  },
  {
    name: 'base',
    sizeLabel: '~142 MB',
    languages: ['multi'],
    notes: 'Good compromise for simple commands'
  },
  {
    name: 'small',
    sizeLabel: '~466 MB',
    languages: ['multi'],
    notes: 'Recommended for Jetson Orin Nano'
  },
  {
    name: 'small.en',
    sizeLabel: '~466 MB',
    languages: ['en'],
    notes: 'English-optimized variant'
  },
  {
    name: 'medium',
    sizeLabel: '~1.5 GB',
    languages: ['multi'],
    notes: 'Highest accuracy, heaviest resource usage'
  }
];

const PYTHON_BIN = process.env.WHISPER_PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const SERVER_SCRIPT = path.join(__dirname, '..', 'scripts', 'whisper_server.py');
const DOWNLOAD_SCRIPT = path.join(__dirname, '..', 'scripts', 'download_whisper_model.py');
const DEFAULT_MODEL_DIR = path.join(__dirname, '..', 'data', 'whisper', 'models');
const LOG_LIMIT = 500;

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function pcmToWav(pcmBuffer, sampleRate, channels, bitsPerSample = 16) {
  if (!Buffer.isBuffer(pcmBuffer)) {
    throw new Error('Audio data must be a Buffer');
  }
  const header = Buffer.alloc(44);
  const subchunk2Size = pcmBuffer.length;
  const chunkSize = 36 + subchunk2Size;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  header.write('RIFF', 0);
  header.writeUInt32LE(chunkSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(subchunk2Size, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function formatSpawnError(command, args, error) {
  return new Error(
    `Failed to execute ${command} ${args.join(' ')}: ${error.message || error}`
  );
}

class WhisperRuntime {
  constructor({ modelName, modelDir, device, computeType }) {
    this.modelName = modelName;
    this.modelDir = modelDir;
    this.device = device;
    this.computeType = computeType;
    this.child = null;
    this.stdoutBuffer = '';
    this.logBuffer = [];
    this.pending = new Map();
  }

  async start(preload = true) {
    if (this.child) {
      return;
    }

    ensureDirectory(this.modelDir);

    return new Promise((resolve, reject) => {
      let resolved = false;
      const args = [
        SERVER_SCRIPT,
        '--model',
        this.modelName,
        '--model-dir',
        this.modelDir,
        '--device',
        this.device,
        '--compute-type',
        this.computeType
      ];
      if (preload) {
        args.push('--preload');
      }

      const childEnv = {
        ...process.env,
        WHISPER_DEVICE: this.device,
        WHISPER_COMPUTE_TYPE: this.computeType
      };
      if (this.device === 'cuda' && childEnv.CUDA_VISIBLE_DEVICES === undefined) {
        childEnv.CUDA_VISIBLE_DEVICES = process.env.WHISPER_CUDA_VISIBLE_DEVICES ?? '0';
      }

      this.child = spawn(PYTHON_BIN, args, {
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.child.once('spawn', () => {
        resolved = true;
        this._attachListeners();
        resolve();
      });

      this.child.once('error', (error) => {
        if (!resolved) {
          reject(error);
        }
      });

      this.child.stderr.on('data', (data) => {
        const text = data.toString();
        this._pushLog(text.trim());
      });

      this.child.on('exit', (code, signal) => {
        const message = `Whisper runtime exited with code ${code} signal ${signal}`;
        this._pushLog(message);
        this.child = null;
        if (!resolved) {
          reject(new Error(message));
          resolved = true;
        }
        for (const [, entry] of this.pending) {
          entry.reject(new Error('Whisper runtime stopped'));
        }
        this.pending.clear();
      });
    });
  }

  _attachListeners() {
    if (!this.child) {
      return;
    }
    this.child.stdout.on('data', (chunk) => {
      this.stdoutBuffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = this.stdoutBuffer.slice(0, newlineIndex);
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
        this._handleMessage(line);
      }
    });
  }

  _handleMessage(line) {
    if (!line.trim()) {
      return;
    }
    let payload;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      this._pushLog(`Failed to parse whisper line: ${line}`);
      return;
    }

    const { id } = payload;
    if (!id || !this.pending.has(id)) {
      return;
    }

    const entry = this.pending.get(id);
    clearTimeout(entry.timeout);
    this.pending.delete(id);

    if (payload.success === false) {
      entry.reject(new Error(payload.error || 'Whisper transcription failed'));
    } else {
      entry.resolve(payload);
    }
  }

  _pushLog(line) {
    const entries = line.split('\n').map((entry) => entry.trim()).filter(Boolean);
    for (const entry of entries) {
      this.logBuffer.push(`[${new Date().toISOString()}] ${entry}`);
      if (this.logBuffer.length > LOG_LIMIT) {
        this.logBuffer.shift();
      }
    }
  }

  async stop(signal = 'SIGTERM') {
    if (!this.child) {
      return;
    }

    try {
      await this._send({ action: 'shutdown' }, 3000);
    } catch (error) {
      this.child.kill(signal);
    }
  }

  async transcribe({ file, language }) {
    if (!this.child) {
      throw new Error('Whisper runtime is not running');
    }
    return this._send(
      {
        action: 'transcribe',
        id: crypto.randomUUID(),
        file,
        language,
        vad_filter: true
      },
      60_000
    ).then((payload) => {
      const info = payload?.info || {};
      if (info.compute_type) {
        this.computeType = info.compute_type;
      }
      if (info.device) {
        this.device = info.device;
      }
      if (info.compute_type && !payload.compute_type) {
        payload.compute_type = info.compute_type;
      }
      if (info.device && !payload.device) {
        payload.device = info.device;
      }
      return payload;
    });
  }

    async status() {
      if (!this.child) {
        return { running: false, model: null, computeType: null, device: null };
      }
      try {
        const response = await this._send(
          {
            action: 'status',
            id: crypto.randomUUID()
          },
          2000
        );
        const resolvedCompute = response?.compute_type || this.computeType || null;
        const resolvedDevice = response?.device || this.device || null;
        this.computeType = resolvedCompute || this.computeType;
        this.device = resolvedDevice || this.device;
        return { running: true, model: response.model, computeType: resolvedCompute, device: resolvedDevice };
      } catch (error) {
        const stillAlive = this.child && this.child.exitCode === null && !this.child.killed;
        return {
          running: stillAlive,
          model: stillAlive ? this.modelName : null,
          computeType: stillAlive ? this.computeType : null,
          device: stillAlive ? this.device : null
        };
      }
    }

  _send(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) {
        return reject(new Error('Whisper runtime is not running'));
      }

      const id = payload.id || crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Whisper runtime request timed out'));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

class WhisperService {
  constructor() {
    this.runtime = null;
    this.initializing = null;
  }

  async _detectDependencies() {
    const config = await this._getConfig();
    try {
      await this._runCommand(PYTHON_BIN, ['-c', 'import importlib; importlib.import_module("faster_whisper")']);
      if (!config.isInstalled) {
        config.isInstalled = true;
        await config.save();
      }
      return true;
    } catch (error) {
      if (config.isInstalled) {
        config.isInstalled = false;
        await config.save();
      }
      return false;
    }
  }

  async initialize() {
    const config = await this._getConfig();
    if (!config.modelDirectory) {
      config.modelDirectory = DEFAULT_MODEL_DIR;
      await config.save();
    }

    const installed = await this._detectDependencies();

    if (config.autoStart) {
      try {
        if (!installed) {
          console.log('Whisper Service: Dependencies not yet installed, skipping auto-start');
        } else {
          await this.startService();
        }
      } catch (error) {
        await config.setError(error.message);
        console.error('Failed to auto-start Whisper service:', error.message);
      }
    }
  }

  async _getConfig() {
    const config = await WhisperConfig.getConfig();
    if (!config.modelDirectory) {
      config.modelDirectory = DEFAULT_MODEL_DIR;
      await config.save();
    }
    return config;
  }

  _resolveComputeCandidates(requested = 'auto', device = 'auto') {
    const normalized = (requested || 'auto').toLowerCase();
    const preferGpu = device === 'cuda';
    const candidates = [];
    const add = (value) => {
      if (value && !candidates.includes(value)) {
        candidates.push(value);
      }
    };

    if (normalized === 'auto' || normalized === 'default') {
      if (preferGpu) {
        add('float16');
        add('int8_float16');
        add('float32');
        add('int8');
      } else {
        add('float32');
        add('int8');
      }
      add('auto');
    } else {
      add(normalized);
      if (preferGpu && normalized !== 'float16') {
        add('float16');
      }
      if (preferGpu && normalized !== 'int8_float16') {
        add('int8_float16');
      }
      add('int8');
      if (normalized !== 'float32') {
        add('float32');
      }
      add('auto');
    }

    return candidates;
  }

  _isJetson() {
    return (
      os.platform() === 'linux' &&
      os.arch() === 'arm64' &&
      fs.existsSync('/etc/nv_tegra_release')
    );
  }

  _hasCudaSupport() {
    if (process.env.WHISPER_DISABLE_CUDA === '1') {
      return false;
    }

    if (this._isJetson()) {
      return true;
    }

    if (process.platform === 'linux') {
      try {
        const result = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
          stdio: 'ignore'
        });
        if (result && result.status === 0) {
          return true;
        }
      } catch (error) {
        // nvidia-smi not available; ignore
      }
    }

    if (fs.existsSync('/usr/local/cuda')) {
      return true;
    }

    return false;
  }

  _resolveDeviceCandidates(preference = 'auto') {
    const normalized = (preference || 'auto').toLowerCase();
    const hasCuda = this._hasCudaSupport();
    const candidates = [];
    const add = (value) => {
      if (value && !candidates.includes(value)) {
        candidates.push(value);
      }
    };

    if (normalized === 'auto' || normalized === 'default') {
      if (hasCuda) {
        add('cuda');
      }
      add('auto');
      add('cpu');
    } else {
      add(normalized);
      if (normalized !== 'cuda' && hasCuda) {
        add('cuda');
      }
      if (normalized !== 'auto') {
        add('auto');
      }
      add('cpu');
    }

    return candidates;
  }

  _getCudaArch() {
    if (process.env.CT2_CUDA_ARCH) {
      return process.env.CT2_CUDA_ARCH;
    }
    if (this._isJetson()) {
      return '87';
    }
    return null;
  }

  async _verifyCudaRuntime() {
    if (!this._hasCudaSupport()) {
      return false;
    }

    try {
      const result = await this._runCommand(
        PYTHON_BIN,
        [
          '-c',
          'import json; from ctranslate2 import get_supported_compute_types; types = get_supported_compute_types("cuda"); print(json.dumps(types))'
        ],
        { cwd: process.cwd() }
      );
      const output = (result?.stdout || '').trim().split(/\r?\n/).pop() || '[]';
      let types = [];
      try {
        types = JSON.parse(output);
      } catch (parseError) {
        // ignore parse errors; treat as failure
        types = [];
      }
      if (!Array.isArray(types) || !types.length) {
        throw new Error('No CUDA compute types reported by ctranslate2');
      }
      console.log(
        `Whisper Service: CUDA compute types available -> ${types.join(', ')}`
      );
      return true;
    } catch (error) {
      console.warn(
        'Whisper Service: CUDA verification failed. Falling back to CPU. Details:',
        error.message
      );
      return false;
    }
  }

  async installDependencies() {
    const config = await this._getConfig();
    config.serviceStatus = 'installing';
    await config.save();

    const cwd = process.cwd();
    const hasCuda = this._hasCudaSupport();
    let attemptedCudaInstall = false;
    let cudaWheelInstalled = false;
    let cudaReady = false;

    const pipInstall = async (packages, options = {}) => {
      const args = ['-m', 'pip', 'install', ...packages];
      await this._runCommand(PYTHON_BIN, args, { cwd, ...options });
    };

    const pipUninstall = async (packages) => {
      try {
        const args = ['-m', 'pip', 'uninstall', '-y', ...packages];
        await this._runCommand(PYTHON_BIN, args, { cwd });
      } catch (error) {
        console.warn(`Whisper Service: pip uninstall warning: ${error.message}`);
      }
    };

    await pipInstall(['--upgrade', 'pip']);
    await pipInstall(['--upgrade', 'setuptools', 'wheel', 'numpy']);
    await pipInstall(['--upgrade', 'huggingface-hub', 'tokenizers', 'tqdm']);
    await pipInstall(['--upgrade', 'faster-whisper']);

    if (hasCuda) {
      try {
        attemptedCudaInstall = true;
        await pipUninstall(['ctranslate2']);
        await pipInstall(['--only-binary=:all:', '--no-cache-dir', 'ctranslate2>=4.4,<5']);
        cudaWheelInstalled = true;
      } catch (error) {
        console.warn(
          `Whisper Service: CUDA-enabled CTranslate2 wheel install failed (${error.message}); falling back to CPU build`
        );
        cudaWheelInstalled = false;
      }
    }

    await pipInstall(['--upgrade', 'soundfile']);

    if (cudaWheelInstalled) {
      cudaReady = await this._verifyCudaRuntime();
      if (!cudaReady) {
        console.warn(
          'Whisper Service: CUDA runtime unavailable after installation; GPU mode will fall back to CPU.'
        );
      }
    }

    await this._detectDependencies();
    config.serviceStatus = 'stopped';
    await config.save();

    const suffix = attemptedCudaInstall
      ? (cudaWheelInstalled
          ? (cudaReady ? ' (CUDA ready)' : ' (CUDA wheel installed but runtime not ready, using CPU)')
          : ' (CUDA wheel unavailable, using CPU)')
      : '';

    return {
      success: true,
      message: `faster-whisper installed successfully${suffix}`
    };
  }

  async _ensureInstalled() {
    const config = await this._getConfig();
    if (!config.isInstalled) {
      const detected = await this._detectDependencies();
      if (!detected) {
        throw new Error('Whisper dependencies are not installed yet');
      }
    }
    if (!config.isInstalled) {
      throw new Error('Whisper dependencies are not installed yet');
    }
  }

  async startService(modelName) {
    await this._ensureInstalled();
    const config = await this._getConfig();

    const targetModel = modelName || config.activeModel || 'small';
    config.serviceStatus = 'starting';
    await config.save();

    if (this.runtime) {
      await this.runtime.stop();
      this.runtime = null;
    }

    const devicePreference = process.env.WHISPER_DEVICE || 'auto';
    const computePreference = process.env.WHISPER_COMPUTE_TYPE || 'auto';
    const deviceCandidates = this._resolveDeviceCandidates(devicePreference);
    let startError = null;

    for (const device of deviceCandidates) {
      const computeCandidates = this._resolveComputeCandidates(computePreference, device);
      for (const computeType of computeCandidates) {
        const runtime = new WhisperRuntime({
          modelName: targetModel,
          modelDir: config.modelDirectory || DEFAULT_MODEL_DIR,
          device,
          computeType
        });

        try {
          await runtime.start(true);
          const runtimeStatus = await runtime.status();
          if (!runtimeStatus.running) {
            throw new Error('Whisper runtime exited before reporting ready');
          }

          const resolvedDevice = runtimeStatus.device || device;
          const resolvedCompute = runtimeStatus.computeType || computeType;

          this.runtime = runtime;
          config.serviceStatus = 'running';
          config.servicePid = runtime.child?.pid || null;
          config.serviceOwner = os.userInfo().username;
          config.activeModel = targetModel;
          config.activeDevice = resolvedDevice;
          config.activeComputeType = resolvedCompute;
          config.lastError = null;
          await config.save();
          return {
            success: true,
            message: `Whisper service started (${resolvedDevice}, ${resolvedCompute})`,
            pid: config.servicePid,
            device: resolvedDevice,
            computeType: resolvedCompute
          };
        } catch (error) {
          startError = error;
          console.warn(
            `Whisper Service: failed to start with device=${device} computeType=${computeType}:`,
            error.message
          );
          try {
            await runtime.stop('SIGKILL');
          } catch (stopError) {
            console.warn('Whisper Service: error while stopping failed runtime:', stopError.message);
          }
          this.runtime = null;
        }
      }
    }

    config.serviceStatus = 'error';
    config.servicePid = null;
    config.serviceOwner = null;
    config.activeDevice = null;
    config.activeComputeType = null;
    await config.setError(startError?.message || 'Failed to start Whisper service');
    await config.save();
    throw startError || new Error('Failed to start Whisper service');
  }

  async stopService() {
    const config = await this._getConfig();
    if (this.runtime) {
      await this.runtime.stop();
      this.runtime = null;
    }

    config.serviceStatus = 'stopped';
    config.servicePid = null;
    config.serviceOwner = null;
    config.activeDevice = null;
    config.activeComputeType = null;
    await config.save();

    return { success: true, message: 'Whisper service stopped' };
  }

  async restartService(modelName) {
    await this.stopService();
    return this.startService(modelName);
  }

  async getStatus() {
    const config = await this._getConfig();
    const runtimeStatus = await (this.runtime ? this.runtime.status() : { running: false });

    return {
      isInstalled: config.isInstalled,
      serviceStatus: config.serviceStatus,
      serviceRunning: Boolean(runtimeStatus.running),
      servicePid: config.servicePid,
      serviceOwner: config.serviceOwner,
      activeModel: config.activeModel,
      activeDevice: config.activeDevice || runtimeStatus.device || null,
      activeComputeType: config.activeComputeType || runtimeStatus.computeType || null,
      installedModels: config.installedModels,
      availableModels: AVAILABLE_MODELS,
      modelDirectory: config.modelDirectory,
      lastError: config.lastError,
      logs: this.runtime?.logBuffer?.slice(-100) || []
    };
  }

  async listInstalledModels() {
    const config = await this._getConfig();
    return config.installedModels;
  }

  async listAvailableModels() {
    return AVAILABLE_MODELS;
  }

  async downloadModel(modelName) {
    await this._ensureInstalled();
    const config = await this._getConfig();
    const target = AVAILABLE_MODELS.find((model) => model.name === modelName);
    if (!target) {
      throw new Error(`Model "${modelName}" is not supported`);
    }

    const args = [DOWNLOAD_SCRIPT, '--model', modelName, '--output-dir', config.modelDirectory];
    await this._runCommand(PYTHON_BIN, args, { cwd: process.cwd() });

    const modelPath = path.join(config.modelDirectory, modelName);
    const sizeBytes = await this._calculateDirectorySize(modelPath);

    await config.upsertModel({
      name: modelName,
      variant: target.languages.includes('en') && target.languages.length === 1 ? 'english' : 'multilingual',
      sizeBytes,
      computeType: process.env.WHISPER_COMPUTE_TYPE || 'float16',
      languages: target.languages,
      path: modelPath,
      downloadedAt: new Date()
    });

    return { success: true, message: `Model "${modelName}" downloaded` };
  }

  async setActiveModel(modelName) {
    await this._ensureInstalled();
    const config = await this._getConfig();
    const modelExists = config.installedModels.some((model) => model.name === modelName);
    if (!modelExists) {
      throw new Error(`Model "${modelName}" has not been downloaded`);
    }

    config.activeModel = modelName;
    await config.save();

    if (this.runtime) {
      await this.restartService(modelName);
    }

    return {
      success: true,
      message: `Active Whisper model set to ${modelName}`
    };
  }

  async transcribe({ audioBuffer, sampleRate = 16000, channels = 1, language = 'en' }) {
    await this._ensureInstalled();
    const config = await this._getConfig();
    if (!this.runtime) {
      if (config.autoStart) {
        await this.startService(config.activeModel);
      } else {
        throw new Error('Whisper service is not running');
      }
    }
    const wavBuffer = pcmToWav(audioBuffer, sampleRate, channels);
    const tmpDir = ensureDirectory(path.join(os.tmpdir(), 'homebrain-whisper'));
    const filename = `${Date.now()}-${crypto.randomUUID()}.wav`;
    const filePath = path.join(tmpDir, filename);
    await fs.promises.writeFile(filePath, wavBuffer);

    try {
      const started = Date.now();
      const result = await this.runtime.transcribe({
        file: filePath,
        language: language === 'auto' ? null : language
      });
      const duration = Date.now() - started;
        return {
          text: (result.text || '').trim(),
          segments: Array.isArray(result.segments) ? result.segments : [],
          language: result?.info?.language || language,
          avgLogProb: result?.info?.avg_logprob ?? null,
          provider: 'whisper_local',
          model: config.activeModel,
          device: this.runtime?.device || config.activeDevice || null,
          computeType: this.runtime?.computeType || config.activeComputeType || null,
          processingTimeMs: duration
        };
    } finally {
      fs.promises.unlink(filePath).catch(() => {});
    }
  }

  async _runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout = [];
      const stderr = [];

      child.stdout.on('data', (data) => stdout.push(data.toString()));
      child.stderr.on('data', (data) => stderr.push(data.toString()));

      child.on('error', (error) => {
        reject(formatSpawnError(command, args, error));
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout: stdout.join(''), stderr: stderr.join('') });
        } else {
          const error = new Error(
            `${command} ${args.join(' ')} exited with code ${code}\n${stderr.join('')}`
          );
          reject(error);
        }
      });
    });
  }

  async _calculateDirectorySize(dirPath) {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      let totalSize = 0;
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          totalSize += await this._calculateDirectorySize(entryPath);
        } else if (entry.isFile()) {
          const stat = await fs.promises.stat(entryPath);
          totalSize += stat.size;
        }
      }
      return totalSize;
    } catch (error) {
      return 0;
    }
  }
}

module.exports = new WhisperService();

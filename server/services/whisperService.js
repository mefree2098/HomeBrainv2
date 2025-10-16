/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const WhisperConfig = require('../models/WhisperConfig');

const AVAILABLE_MODELS = [
  { name: 'tiny',     sizeLabel: '~75 MB',  languages: ['multi'], notes: 'Fastest, lowest accuracy' },
  { name: 'base',     sizeLabel: '~142 MB', languages: ['multi'], notes: 'Good compromise for simple commands' },
  { name: 'small',    sizeLabel: '~466 MB', languages: ['multi'], notes: 'Recommended for Jetson Orin Nano' },
  { name: 'small.en', sizeLabel: '~466 MB', languages: ['en'],    notes: 'English-optimized variant' },
  { name: 'medium',   sizeLabel: '~1.5 GB', languages: ['multi'], notes: 'Highest accuracy, heaviest resource usage' }
];

const PYTHON_BIN = process.env.WHISPER_PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const SERVER_SCRIPT = path.join(__dirname, '..', 'scripts', 'whisper_server.py');
const DOWNLOAD_SCRIPT = path.join(__dirname, '..', 'scripts', 'download_whisper_model.py');
const DEFAULT_MODEL_DIR = path.join(__dirname, '..', 'data', 'whisper', 'models');
const LOG_LIMIT = 500;

// Default LD paths that make Jetson happy (CT2 in /usr/local/lib; CUDA in /usr/local/cuda*/lib64)
const DEFAULT_LD_LIBRARY_PATHS = [
  '/usr/local/lib',
  '/usr/local/cuda/lib64',
  '/usr/local/cuda-12/lib64',
  '/usr/local/cuda-12.6/lib64',
  '/usr/lib/aarch64-linux-gnu',
];

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function pcmToWav(pcmBuffer, sampleRate, channels, bitsPerSample = 16) {
  if (!Buffer.isBuffer(pcmBuffer)) throw new Error('Audio data must be a Buffer');
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
  return new Error(`Failed to execute ${command} ${args.join(' ')}: ${error.message || error}`);
}

function dedupePath(list) {
  const seen = new Set();
  return list.filter(p => {
    if (!p) return false;
    if (seen.has(p)) return false;
    seen.add(p);
    return fs.existsSync(p);
  });
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
    if (this.child) return;

    ensureDirectory(this.modelDir);

    return new Promise((resolve, reject) => {
      let resolved = false;
      const args = [
        SERVER_SCRIPT,
        '--model', this.modelName,
        '--model-dir', this.modelDir,
        '--device', this.device,
        '--compute-type', this.computeType
      ];
      if (preload) args.push('--preload');

      // Build LD_LIBRARY_PATH for the Python child
      const cudaHome = WhisperService._staticResolveCudaHome();
      const ldPaths = dedupePath([
        ...(process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH.split(':') : []),
        ...DEFAULT_LD_LIBRARY_PATHS,
        cudaHome && path.join(cudaHome, 'lib64'),
      ]);

      const childEnv = {
        ...process.env,
        WHISPER_DEVICE: this.device,
        WHISPER_COMPUTE_TYPE: this.computeType,
        LD_LIBRARY_PATH: ldPaths.join(':')
      };
      if (this.device === 'cuda' && childEnv.CUDA_VISIBLE_DEVICES === undefined) {
        childEnv.CUDA_VISIBLE_DEVICES = process.env.WHISPER_CUDA_VISIBLE_DEVICES ?? '0';
      }

      this.child = spawn(PYTHON_BIN, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });

      this.child.once('spawn', () => {
        resolved = true;
        this._attachListeners();
        resolve();
      });

      this.child.once('error', (error) => { if (!resolved) reject(error); });

      this.child.stderr.on('data', (data) => {
        const text = data.toString();
        this._pushLog(text.trim());
      });

      this.child.on('exit', (code, signal) => {
        const message = `Whisper runtime exited with code ${code} signal ${signal}`;
        this._pushLog(message);
        this.child = null;
        if (!resolved) { reject(new Error(message)); resolved = true; }
        for (const [, entry] of this.pending) entry.reject(new Error('Whisper runtime stopped'));
        this.pending.clear();
      });
    });
  }

  _attachListeners() {
    if (!this.child) return;
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
    if (!line.trim()) return;
    let payload;
    try { payload = JSON.parse(line); }
    catch { this._pushLog(`Failed to parse whisper line: ${line}`); return; }

    const { id } = payload;
    if (!id || !this.pending.has(id)) return;

    const entry = this.pending.get(id);
    clearTimeout(entry.timeout);
    this.pending.delete(id);

    if (payload.success === false) entry.reject(new Error(payload.error || 'Whisper transcription failed'));
    else entry.resolve(payload);
  }

  _pushLog(line) {
    const entries = line.split('\n').map(s => s.trim()).filter(Boolean);
    for (const entry of entries) {
      this.logBuffer.push(`[${new Date().toISOString()}] ${entry}`);
      if (this.logBuffer.length > LOG_LIMIT) this.logBuffer.shift();
    }
  }

  async stop(signal = 'SIGTERM') {
    if (!this.child) return;
    try { await this._send({ action: 'shutdown' }, 3000); }
    catch { this.child.kill(signal); }
  }

  async transcribe({ file, language }) {
    if (!this.child) throw new Error('Whisper runtime is not running');
    return this._send({ action: 'transcribe', id: crypto.randomUUID(), file, language, vad_filter: true }, 60_000)
      .then((payload) => {
        const info = payload?.info || {};
        if (info.compute_type) this.computeType = info.compute_type;
        if (info.device) this.device = info.device;
        if (info.compute_type && !payload.compute_type) payload.compute_type = info.compute_type;
        if (info.device && !payload.device) payload.device = info.device;
        return payload;
      });
  }

  async status() {
    if (!this.child) return { running: false, model: null, computeType: null, device: null };
    try {
      const response = await this._send({ action: 'status', id: crypto.randomUUID() }, 2000);
      const resolvedCompute = response?.compute_type || this.computeType || null;
      const resolvedDevice  = response?.device || this.device || null;
      this.computeType = resolvedCompute || this.computeType;
      this.device = resolvedDevice || this.device;
      return { running: true, model: response.model, computeType: resolvedCompute, device: resolvedDevice };
    } catch {
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
      if (!this.child || !this.child.stdin.writable) return reject(new Error('Whisper runtime is not running'));
      const id = payload.id || crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Whisper runtime request timed out'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }
}

class WhisperService {
  constructor() {
    this.runtime = null;
    this.initializing = null;
  }

  static _staticResolveCudaHome() {
    const candidates = [
      process.env.WHISPER_CUDA_HOME,
      process.env.CUDA_HOME,
      '/usr/local/cuda-12.6',
      '/usr/local/cuda-12',
      '/usr/local/cuda'
    ];
    return candidates.find((p) => p && fs.existsSync(p)) || null;
  }

  async _detectDependencies() {
    const config = await this._getConfig();
    let ok = false;
    try {
      await this._runCommand(PYTHON_BIN, ['-c', 'import importlib; importlib.import_module("faster_whisper")']);
      ok = true;
    } catch {
      ok = false;
    }
    // Only mark installed if faster-whisper is importable AND CT2 (if present) reports CUDA on a CUDA-capable host
    if (ok && this._hasCudaSupport()) {
      const cudaOk = await this._verifyCudaRuntime();
      ok = cudaOk; // require CUDA to be actually usable on Jetson/GPUs
    }
    if (ok !== !!config.isInstalled) {
      config.isInstalled = ok;
      await config.save();
    }
    return ok;
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
    const add = (v) => { if (v && !candidates.includes(v)) candidates.push(v); };

    if (normalized === 'auto' || normalized === 'default') {
      if (preferGpu) { add('float16'); add('int8_float16'); add('float32'); add('int8'); }
      else { add('float32'); add('int8'); }
      add('auto');
    } else {
      add(normalized);
      if (preferGpu && normalized !== 'float16') add('float16');
      if (preferGpu && normalized !== 'int8_float16') add('int8_float16');
      add('int8');
      if (normalized !== 'float32') add('float32');
      add('auto');
    }
    return candidates;
  }

  _isJetson() {
    return (os.platform() === 'linux' && os.arch() === 'arm64' && fs.existsSync('/etc/nv_tegra_release'));
  }

  _hasCudaSupport() {
    if (process.env.WHISPER_DISABLE_CUDA === '1') return false;
    if (this._isJetson()) return true;
    if (process.platform === 'linux') {
      try {
        const res = spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { stdio: 'ignore' });
        if (res && res.status === 0) return true;
      } catch { /* ignore */ }
    }
    if (fs.existsSync('/usr/local/cuda') || fs.existsSync('/usr/local/cuda-12') || fs.existsSync('/usr/local/cuda-12.6')) {
      return true;
    }
    return false;
  }

  _resolveDeviceCandidates(preference = 'auto') {
    const normalized = (preference || 'auto').toLowerCase();
    const hasCuda = this._hasCudaSupport();
    const candidates = [];
    const add = (v) => { if (v && !candidates.includes(v)) candidates.push(v); };

    if (normalized === 'auto' || normalized === 'default') {
      if (hasCuda) add('cuda');
      add('auto');
      add('cpu');
    } else {
      add(normalized);
      if (normalized !== 'cuda' && hasCuda) add('cuda');
      if (normalized !== 'auto') add('auto');
      add('cpu');
    }
    return candidates;
  }

  _getCudaArch() { return process.env.CT2_CUDA_ARCH || (this._isJetson() ? '87' : null); }

  async _verifyCudaRuntime() {
    if (!this._hasCudaSupport()) return false;

    try {
      const result = await this._runCommand(
        PYTHON_BIN,
        ['-c',
         'import json,ctranslate2 as ct2; ' +
         'print(json.dumps({"v":getattr(ct2,"__version__",None), "types":getattr(ct2,"get_supported_compute_types")("cuda")}))'
        ],
        { cwd: process.cwd(), env: this._augmentedEnv() }
      );
      const line = (result?.stdout || '').trim().split(/\r?\n/).pop() || '{}';
      const obj = JSON.parse(line);
      const types = Array.isArray(obj.types) ? obj.types : [];
      if (!types.length) throw new Error('No CUDA compute types reported by ctranslate2');
      console.log(`Whisper Service: CUDA compute types -> ${types.join(', ')} (ct2 ${obj.v || 'unknown'})`);
      return true;
    } catch (error) {
      console.warn('Whisper Service: CUDA verification failed. Falling back to CPU. Details:', error.message);
      if (error.stdout?.trim()) console.warn(`Whisper Service: CUDA verification stdout:\n${error.stdout.trim().slice(0, 2000)}`);
      if (error.stderr?.trim()) console.warn(`Whisper Service: CUDA verification stderr:\n${error.stderr.trim().slice(0, 2000)}`);
      return false;
    }
  }

  _augmentedEnv() {
    const env = { ...process.env };
    const cudaHome = WhisperService._staticResolveCudaHome();
    const ldParts = [
      ...(env.LD_LIBRARY_PATH ? env.LD_LIBRARY_PATH.split(':') : []),
      ...DEFAULT_LD_LIBRARY_PATHS,
      cudaHome && path.join(cudaHome, 'lib64')
    ];
    env.LD_LIBRARY_PATH = dedupePath(ldParts).join(':');
    if (cudaHome) {
      env.CUDA_HOME = cudaHome;
      env.CUDA_TOOLKIT_ROOT_DIR = cudaHome;
      env.PATH = [path.join(cudaHome, 'bin'), env.PATH || ''].filter(Boolean).join(':');
    }
    return env;
  }

  async _buildCTranslate2FromSource() {
    const ensureTool = async (name, command, args, installHint) => {
      try { await this._runCommand(command, args, { cwd: process.cwd() }); }
      catch { throw new Error(`${name} is required to build CTranslate2 but is not available. Install it (e.g., ${installHint}).`); }
    };

    await ensureTool('cmake', 'cmake', ['--version'], 'sudo apt-get install cmake');
    await ensureTool('ninja', 'ninja', ['--version'], 'sudo apt-get install ninja-build');
    await ensureTool('python build module', PYTHON_BIN, ['-m', 'pip', '--version'], 'sudo apt-get install python3-pip');

    const sourceRoot = path.join(os.tmpdir(), 'ctranslate2-src');
    console.log(`Whisper Service: Preparing CTranslate2 source in ${sourceRoot}`);
    await fs.promises.rm(sourceRoot, { recursive: true, force: true });

    await this._runCommand('git', ['clone', '--recursive', 'https://github.com/OpenNMT/CTranslate2.git', sourceRoot]);

    const buildDir = path.join(sourceRoot, 'build');
    await fs.promises.mkdir(buildDir, { recursive: true });

    const buildEnv = this._augmentedEnv(); // includes CUDA paths + LD_LIBRARY_PATH

    const cmakeArgs = [
      '-G','Ninja','..',
      '-DCMAKE_BUILD_TYPE=Release',
      '-DWITH_CUDA=ON',
      '-DWITH_CUDNN=ON',
      `-DCMAKE_CUDA_ARCHITECTURES=${this._getCudaArch() || '87'}`,
      '-DOPENMP_RUNTIME=COMP',
      '-DWITH_MKL=OFF',
      '-DWITH_DNNL=OFF',
      '-DWITH_OPENBLAS=ON',
      '-DBUILD_CTRANSLATE2_CLI=OFF'
    ];

    console.log('Whisper Service: Configuring CTranslate2 (cmake)');
    await this._runCommand('cmake', cmakeArgs, { cwd: buildDir, env: buildEnv });

    const jobs = Math.max(1, Array.isArray(os.cpus()) ? os.cpus().length : 4).toString();
    console.log(`Whisper Service: Building CTranslate2 (ninja -j${jobs})`);
    await this._runCommand('ninja', ['-j', jobs], { cwd: buildDir, env: buildEnv });

    // Build + install Python wheel (no deps so we don't pull PyPI CPU wheel)
    const pythonDir = path.join(sourceRoot, 'python');
    console.log('Whisper Service: Building Python wheel for CTranslate2');
    await this._runCommand(PYTHON_BIN, ['-m', 'pip', 'install', '--upgrade', 'build', 'pybind11'], { cwd: pythonDir, env: buildEnv });
    await this._runCommand(PYTHON_BIN, ['-m', 'build'], { cwd: pythonDir, env: buildEnv });

    const distDir = path.join(pythonDir, 'dist');
    const wheels = await fs.promises.readdir(distDir);
    const wheel = wheels.find((file) => file.endsWith('.whl'));
    if (!wheel) throw new Error('CTranslate2 wheel build completed but no dist/*.whl was produced');

    const wheelPath = path.join(distDir, wheel);
    console.log(`Whisper Service: Installing Python wheel ${wheelPath}`);
    await this._runCommand(PYTHON_BIN, ['-m', 'pip', 'install', '--force-reinstall', '--no-deps', wheelPath], { cwd: pythonDir, env: buildEnv });

    // Optional: cleanup
    await fs.promises.rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
  }

  async installDependencies() {
    const config = await this._getConfig();
    config.serviceStatus = 'installing';
    await config.save();

    const cwd = process.cwd();
    const hasCuda = this._hasCudaSupport();
    let attemptedCudaInstall = false;
    let cudaInstallSucceeded = false;
    let cudaReady = false;

    const maxLogLength = 2000;
    const trimOutput = (text) => text.length > maxLogLength ? `${text.slice(0, maxLogLength)}...` : text;

    const runPip = async (label, args, options = {}) => {
      console.log(`Whisper Service: ${label} -> pip ${args.join(' ')}`);
      const result = await this._runCommand(PYTHON_BIN, ['-m', 'pip', ...args], { cwd, env: this._augmentedEnv(), ...options });
      if (result?.stdout?.trim()) console.log(`Whisper Service: ${label} output:\n${trimOutput(result.stdout.trim())}`);
      if (result?.stderr?.trim()) console.warn(`Whisper Service: ${label} warnings:\n${trimOutput(result.stderr.trim())}`);
      return result;
    };

    const pipInstall   = async (label, packages, options = {}) => { await runPip(label, ['install', ...packages], options); };
    const pipUninstall = async (label, packages) => {
      try { await runPip(label, ['uninstall', '-y', ...packages]); }
      catch (error) { console.warn(`Whisper Service: ${label} warning: ${error.message}`); }
    };

    await pipInstall('Upgrade pip', ['--upgrade', 'pip']);
    await pipInstall('Upgrade setuptools/wheel/numpy', ['--upgrade', 'setuptools', 'wheel', 'numpy']);
    await pipInstall('Upgrade huggingface hub toolchain', ['--upgrade', 'huggingface-hub', 'tokenizers', 'tqdm']);
    await pipInstall('Install faster-whisper', ['--upgrade', 'faster-whisper']);

    if (hasCuda) {
      attemptedCudaInstall = true;
      if (this._isJetson()) {
        console.log('Whisper Service: Detected Jetson platform, building CTranslate2 from source with CUDA.');
        try {
          await pipUninstall('Remove existing ctranslate2', ['ctranslate2']);
          await this._buildCTranslate2FromSource();
          cudaInstallSucceeded = true;
        } catch (error) {
          console.error('Whisper Service: Failed to build CTranslate2 with CUDA support:', error.message);
          if (error.stdout?.trim()) console.error(`Whisper Service: build stdout:\n${trimOutput(error.stdout.trim())}`);
          if (error.stderr?.trim()) console.error(`Whisper Service: build stderr:\n${trimOutput(error.stderr.trim())}`);
        }
      } else {
        try {
          await pipUninstall('Remove existing ctranslate2', ['ctranslate2']);
          await pipInstall('Install CUDA-enabled ctranslate2 wheel', ['--only-binary=:all:', '--no-cache-dir', 'ctranslate2>=4.4,<5']);
          cudaInstallSucceeded = true;
        } catch (error) {
          console.warn(`Whisper Service: CUDA-enabled CTranslate2 wheel install failed (${error.message})`);
        }
      }
    }

    await pipInstall('Install soundfile', ['--upgrade', 'soundfile']);

    if (cudaInstallSucceeded) {
      cudaReady = await this._verifyCudaRuntime();
      if (!cudaReady) console.warn('Whisper Service: CUDA installed but runtime not ready; using CPU.');
    }

    const finalInstalled = await this._detectDependencies();
    config.serviceStatus = 'stopped';
    await config.save();

    const suffix = attemptedCudaInstall
      ? (cudaInstallSucceeded ? (cudaReady ? ' (CUDA ready)' : ' (CUDA installed but runtime not ready, CPU fallback)') : ' (CUDA install failed, CPU fallback)')
      : '';

    return { success: finalInstalled, message: `faster-whisper installed ${finalInstalled ? 'successfully' : 'with issues'}${suffix}` };
  }

  async _ensureInstalled() {
    const config = await this._getConfig();
    if (!config.isInstalled) {
      const detected = await this._detectDependencies();
      if (!detected) throw new Error('Whisper dependencies are not installed yet');
    }
  }

  async startService(modelName) {
    await this._ensureInstalled();
    const config = await this._getConfig();

    const targetModel = modelName || config.activeModel || 'small';
    config.serviceStatus = 'starting';
    await config.save();

    if (this.runtime) { await this.runtime.stop(); this.runtime = null; }

    const devicePreference  = process.env.WHISPER_DEVICE || 'auto';
    const computePreference = process.env.WHISPER_COMPUTE_TYPE || 'auto';
    const deviceCandidates  = this._resolveDeviceCandidates(devicePreference);
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
          if (!runtimeStatus.running) throw new Error('Whisper runtime exited before reporting ready');

          const resolvedDevice  = runtimeStatus.device || device;
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
          console.warn(`Whisper Service: failed to start with device=${device} computeType=${computeType}:`, error.message);
          try { await runtime.stop('SIGKILL'); } catch (stopError) { console.warn('Whisper Service: error while stopping failed runtime:', stopError.message); }
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
    if (this.runtime) { await this.runtime.stop(); this.runtime = null; }
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
    const target = AVAILABLE_MODELS.find((m) => m.name === modelName);
    if (!target) throw new Error(`Model "${modelName}" is not supported`);

    const args = [DOWNLOAD_SCRIPT, '--model', modelName, '--output-dir', config.modelDirectory];
    await this._runCommand(PYTHON_BIN, args, { cwd: process.cwd(), env: this._augmentedEnv() });

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
    const modelExists = config.installedModels.some((m) => m.name === modelName);
    if (!modelExists) throw new Error(`Model "${modelName}" has not been downloaded`);

    config.activeModel = modelName;
    await config.save();

    if (this.runtime) await this.restartService(modelName);

    return { success: true, message: `Active Whisper model set to ${modelName}` };
  }

  async transcribe({ audioBuffer, sampleRate = 16000, channels = 1, language = 'en' }) {
    await this._ensureInstalled();
    const config = await this._getConfig();
    if (!this.runtime) {
      if (config.autoStart) await this.startService(config.activeModel);
      else throw new Error('Whisper service is not running');
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
      child.stdout.on('data', (d) => stdout.push(d.toString()));
      child.stderr.on('data', (d) => stderr.push(d.toString()));
      child.on('error', (error) => reject(formatSpawnError(command, args, error)));
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout: stdout.join(''), stderr: stderr.join('') });
        else {
          const error = new Error(`${command} ${args.join(' ')} exited with code ${code}\n${stderr.join('')}`);
          error.stdout = stdout.join('');
          error.stderr = stderr.join('');
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
        if (entry.isDirectory()) totalSize += await this._calculateDirectorySize(entryPath);
        else if (entry.isFile())  totalSize += (await fs.promises.stat(entryPath)).size;
      }
      return totalSize;
    } catch {
      return 0;
    }
  }
}

module.exports = new WhisperService();

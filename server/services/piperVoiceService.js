const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const axios = require('axios');
const crypto = require('crypto');
const fsExtra = require('fs-extra');
const { spawn } = require('child_process');

const VOICES_ROOT = path.join(__dirname, '..', 'data', 'wake-word', 'voices');
const HUGGING_FACE_BASE_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';
const HUGGING_FACE_VOICES_URL = `${HUGGING_FACE_BASE_URL}/voices.json`;
const DEFAULT_VOICE_ID = 'en_US-amy-medium';
const CATALOG_TTL_MS = 1000 * 60 * 60; // 1 hour

let cachedCatalog = null;
let catalogFetchedAt = 0;
let autoDownloadAttempted = false;

async function ensureVoiceDirectory() {
  await fsp.mkdir(VOICES_ROOT, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function encodeVoicePath(relPath) {
  return relPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function resolveVoiceUrl(relPath) {
  return `${HUGGING_FACE_BASE_URL}/${encodeVoicePath(relPath)}`;
}

function formatLanguageLabel(language = {}) {
  const english = language.name_english || language.code || 'Unknown';
  const region = language.country_english || language.region || '';
  if (!region || region === english) {
    return english;
  }
  return `${english} (${region})`;
}

function titleCase(value) {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function normaliseVoiceEntry(id, entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const files = Object.entries(entry.files || {}).map(([relPath, fileInfo = {}]) => ({
    relPath,
    fileName: path.basename(relPath),
    sizeBytes: typeof fileInfo.size_bytes === 'number' ? fileInfo.size_bytes : null,
    md5: fileInfo.md5_digest || null
  }));

  const modelFile = files.find((file) => file.fileName.endsWith('.onnx'));
  const configFile = files.find((file) => file.fileName.endsWith('.onnx.json'));

  if (!modelFile || !configFile) {
    return null;
  }

  const sizeBytes = files.reduce((total, file) => total + (file.sizeBytes || 0), 0);
  let speakerId = null;
  const speakerMap = entry.speaker_id_map || {};
  if (speakerMap && typeof speakerMap === 'object' && Object.keys(speakerMap).length > 0) {
    const firstKey = Object.keys(speakerMap)[0];
    const value = speakerMap[firstKey];
    if (typeof value === 'number') {
      speakerId = value;
    }
  }

  return {
    id,
    name: titleCase(entry.name || id),
    quality: entry.quality || 'standard',
    language: entry.language || {},
    languageLabel: formatLanguageLabel(entry.language),
    downloadFiles: [modelFile, configFile],
    modelFile,
    configFile,
    sizeBytes: sizeBytes || null,
    speakerId
  };
}

async function loadVoiceCatalog(force = false) {
  if (!force && cachedCatalog && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return cachedCatalog;
  }

  try {
    const response = await axios.get(HUGGING_FACE_VOICES_URL, {
      responseType: 'json',
      headers: { Accept: 'application/json' },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    const rawCatalog = response.data || {};
    const catalogueMap = new Map();
    Object.entries(rawCatalog).forEach(([id, entry]) => {
      const normalised = normaliseVoiceEntry(id, entry);
      if (normalised) {
        catalogueMap.set(id, normalised);
      }
    });
    cachedCatalog = catalogueMap;
    catalogFetchedAt = Date.now();
    return cachedCatalog;
  } catch (error) {
    throw new Error(`Unable to fetch Piper voice catalogue: ${error.message}`);
  }
}

async function getVoiceMetadataById(id) {
  const catalog = await loadVoiceCatalog();
  const meta = catalog.get(id);
  if (!meta) {
    throw new Error(`Unknown Piper voice id: ${id}`);
  }
  return meta;
}

async function computeInstalledSize(meta, voiceDir) {
  let total = 0;
  for (const file of meta.downloadFiles) {
    const filePath = path.join(voiceDir, file.fileName);
    try {
      const stat = await fsp.stat(filePath);
      if (stat.isFile()) {
        total += stat.size;
      }
    } catch (error) {
      // Ignore missing files; installation status is handled by the caller.
    }
  }
  return total || meta.sizeBytes || null;
}

async function getInstalledVoiceInfo(meta) {
  const voiceDir = path.join(VOICES_ROOT, meta.id);
  const requiredFiles = meta.downloadFiles.map((file) => path.join(voiceDir, file.fileName));
  const checks = await Promise.all(requiredFiles.map(fileExists));
  if (!checks.every(Boolean)) {
    return null;
  }

  const modelPath = path.join(voiceDir, meta.modelFile.fileName);
  const configPath = path.join(voiceDir, meta.configFile.fileName);
  const sizeBytes = await computeInstalledSize(meta, voiceDir);

  return {
    id: meta.id,
    name: meta.name,
    language: meta.languageLabel,
    languageCode: meta.language.code || null,
    speaker: meta.name,
    speakerId: meta.speakerId,
    quality: meta.quality,
    modelPath,
    configPath,
    sizeBytes
  };
}

function mapVoiceWithInstallation(meta, installedInfo = null) {
  if (!installedInfo) {
    return {
      id: meta.id,
      name: meta.name,
      language: meta.languageLabel,
      languageCode: meta.language.code || null,
      speaker: meta.name,
      speakerId: meta.speakerId,
      quality: meta.quality,
      sizeBytes: meta.sizeBytes,
      installed: false,
      modelPath: null,
      configPath: null
    };
  }

  return {
    id: meta.id,
    name: meta.name,
    language: installedInfo.language,
    languageCode: installedInfo.languageCode,
    speaker: installedInfo.speaker,
    speakerId: installedInfo.speakerId ?? meta.speakerId ?? null,
    quality: installedInfo.quality,
    sizeBytes: installedInfo.sizeBytes || meta.sizeBytes,
    installed: true,
    modelPath: installedInfo.modelPath,
    configPath: installedInfo.configPath
  };
}

async function listVoices() {
  await ensureVoiceDirectory();
  await ensureDefaultVoiceInstalled();
  const catalog = await loadVoiceCatalog();
  const voices = [];

  for (const meta of catalog.values()) {
    const installedInfo = await getInstalledVoiceInfo(meta);
    voices.push(mapVoiceWithInstallation(meta, installedInfo));
  }

  return voices.sort((a, b) => {
    if (a.installed && !b.installed) return -1;
    if (!a.installed && b.installed) return 1;
    const languageCompare = (a.language || '').localeCompare(b.language || '');
    if (languageCompare !== 0) return languageCompare;
    return (a.name || '').localeCompare(b.name || '');
  });
}

async function listInstalledVoices() {
  await ensureVoiceDirectory();
  const catalog = await loadVoiceCatalog();
  const installed = [];

  for (const meta of catalog.values()) {
    const info = await getInstalledVoiceInfo(meta);
    if (info) {
      installed.push(info);
    }
  }

  return installed;
}

async function downloadFile(url, destination, expectedMd5 = null) {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream'
  });

  await fsExtra.ensureDir(path.dirname(destination));
  const tempPath = `${destination}.download`;
  const hash = expectedMd5 ? crypto.createHash('md5') : null;

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tempPath);

    response.data.on('data', (chunk) => {
      if (hash) {
        hash.update(chunk);
      }
    });

    response.data.on('error', async (error) => {
      await fsExtra.remove(tempPath).catch(() => {});
      reject(error);
    });

    writer.on('finish', async () => {
      try {
        if (hash) {
          const digest = hash.digest('hex');
          if (digest !== expectedMd5) {
            await fsExtra.remove(tempPath).catch(() => {});
            reject(new Error(`Checksum mismatch fetched=${digest}, expected=${expectedMd5}`));
            return;
          }
        }
        await fsExtra.move(tempPath, destination, { overwrite: true });
        resolve();
      } catch (error) {
        await fsExtra.remove(tempPath).catch(() => {});
        reject(error);
      }
    });

    writer.on('error', async (error) => {
      await fsExtra.remove(tempPath).catch(() => {});
      reject(error);
    });

    response.data.pipe(writer);
  });
}

async function downloadVoice(id) {
  const meta = await getVoiceMetadataById(id);
  const installedInfo = await getInstalledVoiceInfo(meta);
  if (installedInfo) {
    return mapVoiceWithInstallation(meta, installedInfo);
  }

  await ensureVoiceDirectory();
  const voiceDir = path.join(VOICES_ROOT, meta.id);
  await fsExtra.ensureDir(voiceDir);

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `piper-voice-${meta.id}-`));
  try {
    for (const file of meta.downloadFiles) {
      const url = resolveVoiceUrl(file.relPath);
      const tempPath = path.join(tempDir, file.fileName);
      const destinationPath = path.join(voiceDir, file.fileName);
      await downloadFile(url, tempPath, file.md5);
      await fsExtra.move(tempPath, destinationPath, { overwrite: true });
    }
  } catch (error) {
    await fsExtra.remove(voiceDir).catch(() => {});
    throw new Error(`Failed to download Piper voice ${meta.id}: ${error.message}`);
  } finally {
    await fsExtra.remove(tempDir).catch(() => {});
  }

  const info = await getInstalledVoiceInfo(meta);
  return mapVoiceWithInstallation(meta, info);
}

async function removeVoice(id) {
  await ensureVoiceDirectory();
  const voiceDir = path.join(VOICES_ROOT, id);
  await fsExtra.remove(voiceDir);

  const remaining = await listInstalledVoices();
  if (remaining.length === 0) {
    autoDownloadAttempted = false;
  }
}

async function ensureDefaultVoiceInstalled() {
  if (autoDownloadAttempted) {
    return;
  }
  autoDownloadAttempted = true;

  try {
    const meta = await getVoiceMetadataById(DEFAULT_VOICE_ID);
    const installed = await getInstalledVoiceInfo(meta);
    if (!installed) {
      await downloadVoice(meta.id);
    }
  } catch (error) {
    autoDownloadAttempted = false;
    console.warn(
      `[wakeword] Failed to auto-download default Piper voice (${DEFAULT_VOICE_ID}): ${error.message}`
    );
  }
}

async function getInstalledVoicesForTraining() {
  await ensureDefaultVoiceInstalled();
  const installed = await listInstalledVoices();
  return installed.map((voice) => ({
    id: voice.id,
    name: voice.name,
    language: voice.language,
    speaker: voice.speaker,
    speakerId: voice.speakerId ?? null,
    quality: voice.quality,
    modelPath: voice.modelPath,
    configPath: voice.configPath
  }));
}

function resolvePiperExecutable() {
  const envPath = process.env.WAKEWORD_PIPER_EXEC;
  if (envPath && fs.existsSync(envPath)) return envPath;
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const which = spawn(whichCmd, ['piper']);
    return new Promise((resolve) => {
      let out = '';
      which.stdout.on('data', (d) => (out += d.toString()));
      which.on('close', () => {
        const line = out.split(/\r?\n/).find((l) => l.trim());
        if (line && fs.existsSync(line.trim())) return resolve(line.trim());
        resolve(null);
      });
      which.on('error', () => resolve(null));
    });
  } catch (_) {
    // fall through
  }
  const candidates = process.platform === 'win32'
    ? [
        path.join(__dirname, '..', '.wakeword-venv', 'Scripts', 'piper.exe'),
        'C:/Program Files/piper/piper.exe',
        'C:/Program Files (x86)/piper/piper.exe'
      ]
    : [
        path.join(__dirname, '..', '.wakeword-venv', 'bin', 'piper'),
        '/usr/bin/piper',
        '/usr/local/bin/piper',
        '/bin/piper'
      ];
  for (const cand of candidates) {
    try { if (fs.existsSync(cand)) return Promise.resolve(cand); } catch (_) {}
  }
  return Promise.resolve(null);
}

async function detectPiperDevice() {
  const installed = await getInstalledVoicesForTraining();
  const voice = installed[0] || null;
  const execPath = await resolvePiperExecutable();
  if (!execPath) {
    return {
      using: 'cpu',
      provider: 'unknown',
      reason: 'Piper executable not found. Install Piper and set WAKEWORD_PIPER_EXEC if needed.',
      executable: null,
      voices: installed.length,
      platform: process.platform,
      gpuAvailable: false,
      cudaDeviceCount: 0
    };
  }

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'piper-probe-'));
  const outFile = path.join(tmpDir, 'probe.wav');

  const args = ['--model'];
  if (voice && voice.modelPath) {
    args.push(voice.modelPath);
  } else {
    // If no voice installed, use a dummy path; Piper will likely fail but may still log EPs
    args.push(path.join(tmpDir, 'missing.onnx'));
  }
  args.push('--output_file', outFile);

  const env = { ...process.env, ORT_LOG_SEVERITY_LEVEL: process.env.ORT_LOG_SEVERITY_LEVEL || '1', ORT_LOG_VERBOSITY_LEVEL: process.env.ORT_LOG_VERBOSITY_LEVEL || '1' };

  const logs = await new Promise((resolve) => {
    try {
      const child = spawn(execPath, args, { env });
      let stderr = '';
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('close', () => resolve(`${stderr}\n${stdout}`));
      child.on('error', () => resolve(''));
      // write a trivial text line to satisfy stdin (if needed)
      try { child.stdin.write('probe\n'); child.stdin.end(); } catch (_) {}
    } catch (_) {
      resolve('');
    }
  });

  const text = String(logs || '').toLowerCase();
  let provider = 'CPUExecutionProvider';
  let using = 'cpu';
  if (text.includes('cudaexecutionprovider') || text.includes('cuda execution provider')) {
    provider = 'CUDAExecutionProvider';
    using = 'gpu';
  } else if (text.includes('dmlexecutionprovider') || text.includes('directml') || text.includes('dml')) {
    provider = 'DmlExecutionProvider';
    using = 'gpu';
  } else if (text.includes('rocmexecutionprovider') || text.includes('rocm')) {
    provider = 'ROCMExecutionProvider';
    using = 'gpu';
  } else if (text.includes('coremlexecutionprovider') || text.includes('coreml')) {
    provider = 'CoreMLExecutionProvider';
    using = 'gpu';
  } else if (text.includes('openvinoexecutionprovider') || text.includes('openvino')) {
    provider = 'OpenVINOExecutionProvider';
    using = 'gpu';
  } else if (text.includes('cpuexecutionprovider') || text.includes('cpu execution provider')) {
    provider = 'CPUExecutionProvider';
    using = 'cpu';
  }

  let reason = '';
  const gpuAvailable = false; // Node server not checking CUDA; keep generic
  const cudaDeviceCount = 0;
  if (using === 'cpu') {
    reason = 'No compatible GPU provider detected in Piper logs or Piper build lacks GPU EP support.';
  }

  // cleanup
  try { await fsExtra.remove(tmpDir); } catch (_) {}

  return {
    using,
    provider,
    reason,
    executable: execPath,
    voices: installed.length,
    platform: process.platform,
    gpuAvailable,
    cudaDeviceCount
  };
}

module.exports = {
  VOICES_ROOT,
  listVoices,
  listInstalledVoices,
  downloadVoice,
  removeVoice,
  getInstalledVoicesForTraining,
  detectPiperDevice
};

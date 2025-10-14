const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const axios = require('axios');
const crypto = require('crypto');
const fsExtra = require('fs-extra');

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

module.exports = {
  VOICES_ROOT,
  listVoices,
  listInstalledVoices,
  downloadVoice,
  removeVoice,
  getInstalledVoicesForTraining
};

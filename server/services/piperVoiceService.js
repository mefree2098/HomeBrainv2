const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const axios = require('axios');
const tar = require('tar');
const fsExtra = require('fs-extra');

const VOICES_ROOT = path.join(__dirname, '..', 'data', 'wake-word', 'voices');

const AVAILABLE_VOICES = [
  {
    id: 'en_US-amy-medium',
    name: 'Amy',
    language: 'en-US',
    speaker: 'Amy',
    quality: 'medium',
    sizeBytes: 56623104,
    archiveUrl: 'https://github.com/rhasspy/piper/releases/download/2024.11.12/en_US-amy-medium.tar.gz',
    files: {
      model: 'en_US-amy-medium.onnx',
      config: 'en_US-amy-medium.onnx.json'
    }
  },
  {
    id: 'en_US-kathleen-high',
    name: 'Kathleen',
    language: 'en-US',
    speaker: 'Kathleen',
    quality: 'high',
    sizeBytes: 63229184,
    archiveUrl: 'https://github.com/rhasspy/piper/releases/download/2024.11.12/en_US-kathleen-high.tar.gz',
    files: {
      model: 'en_US-kathleen-high.onnx',
      config: 'en_US-kathleen-high.onnx.json'
    }
  },
  {
    id: 'en_GB-semaine-medium',
    name: 'Semaine',
    language: 'en-GB',
    speaker: 'Semaine',
    quality: 'medium',
    sizeBytes: 56098816,
    archiveUrl: 'https://github.com/rhasspy/piper/releases/download/2024.11.12/en_GB-semaine-medium.tar.gz',
    files: {
      model: 'en_GB-semaine-medium.onnx',
      config: 'en_GB-semaine-medium.onnx.json'
    }
  },
  {
    id: 'es_ES-dario-medium',
    name: 'Dario',
    language: 'es-ES',
    speaker: 'Dario',
    quality: 'medium',
    sizeBytes: 56000000,
    archiveUrl: 'https://github.com/rhasspy/piper/releases/download/2024.11.12/es_ES-dario-medium.tar.gz',
    files: {
      model: 'es_ES-dario-medium.onnx',
      config: 'es_ES-dario-medium.onnx.json'
    }
  }
];

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

async function computeInstalledSize(voice) {
  let total = 0;
  const expectedFiles = new Set([voice.files.model, voice.files.config]);
  const legacyPrefix = voice.id.replace(/-/g, '_');

  try {
    const entries = await fsp.readdir(VOICES_ROOT);
    for (const name of entries) {
      if (!expectedFiles.has(name) && !name.startsWith(voice.id) && !name.startsWith(legacyPrefix)) {
        continue;
      }

      try {
        const stat = await fsp.stat(path.join(VOICES_ROOT, name));
        if (stat.isFile()) {
          total += stat.size;
        }
      } catch (error) {
        // ignore individual file errors
      }
    }
  } catch (error) {
    // ignore directory read errors
  }

  return total || voice.sizeBytes || null;
}

function mapVoiceWithInstallation(voice, installedInfo = null) {
  if (!installedInfo) {
    return {
      ...voice,
      installed: false,
      modelPath: null,
      configPath: null
    };
  }
  return {
    ...voice,
    installed: true,
    modelPath: installedInfo.modelPath,
    configPath: installedInfo.configPath,
    sizeBytes: installedInfo.sizeBytes ?? voice.sizeBytes ?? null
  };
}

async function getInstalledVoiceInfo(voice) {
  const modelPath = path.join(VOICES_ROOT, voice.files.model);
  const configPath = path.join(VOICES_ROOT, voice.files.config);
  const installed = await fileExists(modelPath) && await fileExists(configPath);
  if (!installed) {
    return null;
  }

  const sizeBytes = await computeInstalledSize(voice);

  return {
    id: voice.id,
    name: voice.name,
    language: voice.language,
    speaker: voice.speaker,
    quality: voice.quality,
    modelPath,
    configPath,
    sizeBytes
  };
}

async function listVoices() {
  await ensureVoiceDirectory();
  await ensureDefaultVoiceInstalled();

  const results = [];
  for (const voice of AVAILABLE_VOICES) {
    const installedInfo = await getInstalledVoiceInfo(voice);
    results.push(mapVoiceWithInstallation(voice, installedInfo));
  }
  return results;
}

async function listInstalledVoices() {
  await ensureVoiceDirectory();
  const installed = [];
  for (const voice of AVAILABLE_VOICES) {
    const info = await getInstalledVoiceInfo(voice);
    if (info) {
      installed.push(info);
    }
  }
  return installed;
}

async function ensureDefaultVoiceInstalled() {
  if (autoDownloadAttempted) {
    return;
  }

  const installedVoices = await listInstalledVoices();
  if (installedVoices.length > 0) {
    autoDownloadAttempted = true;
    return;
  }

  autoDownloadAttempted = true;

  const defaultVoice = AVAILABLE_VOICES[0];
  if (!defaultVoice) {
    return;
  }

  try {
    const installed = await getInstalledVoiceInfo(defaultVoice);
    if (!installed) {
      await downloadVoice(defaultVoice.id);
    }
  } catch (error) {
    autoDownloadAttempted = false;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `[wakeword] Failed to auto-download default Piper voice (${defaultVoice.id}): ${reason}`
    );
  }
}

async function downloadVoice(id) {
  const voice = AVAILABLE_VOICES.find((entry) => entry.id === id);
  if (!voice) {
    throw new Error(`Unknown Piper voice id: ${id}`);
  }
  const installedInfo = await getInstalledVoiceInfo(voice);
  if (installedInfo) {
    return mapVoiceWithInstallation(voice, installedInfo);
  }

  await ensureVoiceDirectory();

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'piper-voice-'));
  const archivePath = path.join(tempDir, `${voice.id}.tar.gz`);

  try {
    const response = await axios({
      method: 'GET',
      url: voice.archiveUrl,
      responseType: 'stream'
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(archivePath);
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    await tar.x({
      file: archivePath,
      cwd: VOICES_ROOT
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to download Piper voice ${voice.id}: ${reason}`);
  } finally {
    await fsExtra.remove(tempDir).catch(() => {});
  }

  const info = await getInstalledVoiceInfo(voice);
  return mapVoiceWithInstallation(voice, info);
}

async function removeVoice(id) {
  const voice = AVAILABLE_VOICES.find((entry) => entry.id === id);
  if (!voice) {
    throw new Error(`Unknown Piper voice id: ${id}`);
  }
  await ensureVoiceDirectory();

  const entries = await fsp.readdir(VOICES_ROOT);
  const modelBase = voice.files.model.replace(/\.onnx$/, '');
  const configBase = voice.files.config.replace(/\.onnx\.json$/, '');

  await Promise.all(entries
    .filter((name) => {
      return name.startsWith(modelBase) || name.startsWith(configBase) || name.startsWith(voice.id);
    })
    .map(async (name) => {
      const filePath = path.join(VOICES_ROOT, name);
      await fsExtra.remove(filePath);
    }));

  const remaining = await listInstalledVoices();
  if (remaining.length === 0) {
    autoDownloadAttempted = false;
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
    quality: voice.quality,
    modelPath: voice.modelPath,
    configPath: voice.configPath
  }));
}

module.exports = {
  AVAILABLE_VOICES,
  VOICES_ROOT,
  listVoices,
  listInstalledVoices,
  downloadVoice,
  removeVoice,
  getInstalledVoicesForTraining
};

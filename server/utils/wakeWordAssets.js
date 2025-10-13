const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WAKE_WORD_ROOT = path.join(__dirname, '..', 'public', 'wake-words');
const SUPPORTED_EXTENSIONS = ['.tflite', '.onnx', '.ppn'];

const ensureDirectory = () => {
  try {
    fs.mkdirSync(WAKE_WORD_ROOT, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
};

const slugify = (value) => {
  if (!value) return '';
  return value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

const listWakeWordFiles = () => {
  ensureDirectory();
  try {
    return fs.readdirSync(WAKE_WORD_ROOT).filter((file) => {
      const extension = path.extname(file).toLowerCase();
      return SUPPORTED_EXTENSIONS.includes(extension);
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

const computeFileHash = (absolutePath) => {
  const hash = crypto.createHash('sha256');
  const fileHandle = fs.openSync(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(fileHandle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fileHandle);
  }
  return hash.digest('hex');
};

const normalisePlatform = (platform) => {
  if (!platform) return null;
  return platform.toString().toLowerCase().replace(/[^a-z0-9]+/g, '-');
};

const normaliseArch = (arch) => {
  if (!arch) return null;
  return arch.toString().toLowerCase().replace(/[^a-z0-9]+/g, '-');
};

const buildCandidateFileNames = (slug, platform, arch) => {
  const candidates = new Set();
  const normalisedPlatform = normalisePlatform(platform);
  const normalisedArch = normaliseArch(arch);

  for (const extension of SUPPORTED_EXTENSIONS) {
    if (normalisedPlatform && normalisedArch) {
      candidates.add(`${slug}_${normalisedPlatform}_${normalisedArch}${extension}`);
    }
    if (normalisedPlatform) {
      candidates.add(`${slug}_${normalisedPlatform}${extension}`);
    }
    if (normalisedArch) {
      candidates.add(`${slug}_${normalisedArch}${extension}`);
    }
    candidates.add(`${slug}${extension}`);
  }

  return Array.from(candidates);
};

const findFileForWakeWord = (slug, platform, arch) => {
  const files = listWakeWordFiles();
  if (files.length === 0) {
    return null;
  }

  const candidates = buildCandidateFileNames(slug, platform, arch);
  for (const candidate of candidates) {
    const match = files.find((file) => file.toLowerCase() === candidate.toLowerCase());
    if (match) {
      return match;
    }
  }

  // Fallback: any file containing slug
  const fallback = files.find((file) => file.toLowerCase().startsWith(`${slug}_`));
  if (fallback) {
    return fallback;
  }

  return null;
};

const getAssetForWakeWord = (label, options = {}) => {
  const slug = options.slug || slugify(label);
  if (!slug) return null;

  const fileName = findFileForWakeWord(slug, options.platform, options.arch) ||
    (options.allowGeneric ? findFileForWakeWord(slug, null, null) : null);

  if (!fileName) {
    return null;
  }

  const absolutePath = path.join(WAKE_WORD_ROOT, fileName);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  const stats = fs.statSync(absolutePath);
  const extension = path.extname(fileName).toLowerCase();
  const format = extension.replace('.', '');
  const engine = extension === '.ppn' ? 'porcupine' : 'openwakeword';

  return {
    label,
    slug,
    fileName,
    absolutePath,
    size: stats.size,
    checksum: computeFileHash(absolutePath),
    updatedAt: stats.mtime,
    platform: options.platform || null,
    arch: options.arch || null,
    sensitivity: typeof options.sensitivity === 'number' ? options.sensitivity : null,
    threshold: typeof options.threshold === 'number' ? options.threshold : null,
    format,
    engine
  };
};

const getAssetsForWakeWords = (wakeWords = [], options = {}) => {
  if (!Array.isArray(wakeWords)) return [];

  const results = [];
  for (const label of wakeWords) {
    const asset = getAssetForWakeWord(label, options);
    if (asset) {
      results.push(asset);
    }
  }

  return results;
};

const listAllAssets = (options = {}) => {
  const files = listWakeWordFiles();
  return files.map((fileName) => {
    const absolutePath = path.join(WAKE_WORD_ROOT, fileName);
    const stats = fs.statSync(absolutePath);
    return {
      fileName,
      absolutePath,
      size: stats.size,
      checksum: computeFileHash(absolutePath),
      updatedAt: stats.mtime,
      platform: options.platform || null,
      arch: options.arch || null,
      format: path.extname(fileName).slice(1),
      engine: path.extname(fileName).toLowerCase() === '.ppn' ? 'porcupine' : 'openwakeword'
    };
  });
};

module.exports = {
  slugify,
  getAssetForWakeWord,
  getAssetsForWakeWords,
  listAllAssets,
  WAKE_WORD_ROOT
};

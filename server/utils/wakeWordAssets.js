const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { toAsciiSlug } = require('./stringSafety');

const WAKE_WORD_ROOT = path.join(__dirname, '..', 'public', 'wake-words');
const SUPPORTED_EXTENSIONS = ['.tflite', '.onnx', '.ppn'];
const SUPPORTED_DEPENDENCY_SUFFIXES = ['.data'];
const MAX_WAKE_WORD_SLUG_LENGTH = 100;

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
  return value ? toAsciiSlug(value, { maxLength: MAX_WAKE_WORD_SLUG_LENGTH }) : '';
};

const resolveAssetPath = (fileName) => {
  const normalizedName = typeof fileName === 'string' ? fileName.trim() : '';
  if (!normalizedName || normalizedName !== path.basename(normalizedName) || normalizedName.includes('\0')) {
    return null;
  }
  const root = path.resolve(WAKE_WORD_ROOT);
  const resolved = path.resolve(root, normalizedName);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
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

const getFileDescriptor = (fileName) => {
  const absolutePath = resolveAssetPath(fileName);
  if (!absolutePath) {
    return null;
  }
  if (!fs.existsSync(absolutePath)) {
    return null;
  }

  const stats = fs.statSync(absolutePath);
  return {
    fileName,
    absolutePath,
    size: stats.size,
    checksum: computeFileHash(absolutePath),
    updatedAt: stats.mtime
  };
};

const normalisePlatform = (platform) => {
  if (!platform) return null;
  return toAsciiSlug(platform) || null;
};

const normaliseArch = (arch) => {
  if (!arch) return null;
  return toAsciiSlug(arch) || null;
};

const buildCandidateFileNames = (slug, platform, arch) => {
  const candidates = new Set();
  const normalisedSlug = slugify(slug);
  if (!normalisedSlug) return [];
  const normalisedPlatform = normalisePlatform(platform);
  const normalisedArch = normaliseArch(arch);

  for (const extension of SUPPORTED_EXTENSIONS) {
    if (normalisedPlatform && normalisedArch) {
      candidates.add(`${normalisedSlug}_${normalisedPlatform}_${normalisedArch}${extension}`);
    }
    if (normalisedPlatform) {
      candidates.add(`${normalisedSlug}_${normalisedPlatform}${extension}`);
    }
    if (normalisedArch) {
      candidates.add(`${normalisedSlug}_${normalisedArch}${extension}`);
    }
    candidates.add(`${normalisedSlug}${extension}`);
  }

  return Array.from(candidates);
};

const findFileForWakeWord = (slug, platform, arch) => {
  const normalisedSlug = slugify(slug);
  if (!normalisedSlug) return null;
  const files = listWakeWordFiles();
  if (files.length === 0) {
    return null;
  }

  // Strictly prefer TFLite when available; then fall back to ONNX; then Porcupine PPN.
  const exts = ['.tflite', '.onnx', '.ppn'];
  const buildCandidatesFor = (ext) => {
    const c = new Set();
    const p = normalisePlatform(platform);
    const a = normaliseArch(arch);
    if (p && a) c.add(`${normalisedSlug}_${p}_${a}${ext}`);
    if (p) c.add(`${normalisedSlug}_${p}${ext}`);
    if (a) c.add(`${normalisedSlug}_${a}${ext}`);
    c.add(`${normalisedSlug}${ext}`);
    return Array.from(c);
  };

  for (const ext of exts) {
    const candidates = buildCandidatesFor(ext);
    for (const candidate of candidates) {
      const match = files.find((file) => file.toLowerCase() === candidate.toLowerCase());
      if (match) {
        return match;
      }
    }
  }

  // Fallback: any file starting with slug (any extension)
  const fallback = files.find((file) => file.toLowerCase().startsWith(`${normalisedSlug}_`));
  if (fallback) {
    return fallback;
  }

  return null;
};

const getDependenciesForWakeWordFile = (fileName) => {
  const dependencies = [];
  const seen = new Set();

  for (const suffix of SUPPORTED_DEPENDENCY_SUFFIXES) {
    const dependencyFileName = `${fileName}${suffix}`;
    const descriptor = getFileDescriptor(dependencyFileName);
    if (descriptor && !seen.has(dependencyFileName.toLowerCase())) {
      dependencies.push(descriptor);
      seen.add(dependencyFileName.toLowerCase());
    }
  }

  return dependencies;
};

const getAssetForWakeWord = (label, options = {}) => {
  const slug = slugify(options.slug || label);
  if (!slug) return null;

  const fileName = findFileForWakeWord(slug, options.platform, options.arch) ||
    (options.allowGeneric ? findFileForWakeWord(slug, null, null) : null);

  if (!fileName) {
    return null;
  }

  const descriptor = getFileDescriptor(fileName);
  if (!descriptor) {
    return null;
  }

  const extension = path.extname(fileName).toLowerCase();
  const format = extension.replace('.', '');
  const engine = extension === '.ppn' ? 'porcupine' : 'openwakeword';

  return {
    label,
    slug,
    fileName,
    absolutePath: descriptor.absolutePath,
    size: descriptor.size,
    checksum: descriptor.checksum,
    updatedAt: descriptor.updatedAt,
    platform: options.platform || null,
    arch: options.arch || null,
    sensitivity: typeof options.sensitivity === 'number' ? options.sensitivity : null,
    threshold: typeof options.threshold === 'number' ? options.threshold : null,
    format,
    engine,
    dependencies: getDependenciesForWakeWordFile(fileName)
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
    const absolutePath = resolveAssetPath(fileName);
    if (!absolutePath) return null;
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
  }).filter(Boolean);
};

module.exports = {
  slugify,
  getAssetForWakeWord,
  getAssetsForWakeWords,
  listAllAssets,
  getDependenciesForWakeWordFile,
  resolveAssetPath,
  WAKE_WORD_ROOT
};

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', 'reachy-homebrain-app');
const EXCLUDED_SEGMENTS = new Set(['.git', '.venv', '.pytest_cache', '__pycache__']);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 128;
const ROOT_FILE_ALLOWLIST = new Set([
  'pyproject.toml',
  'README.md',
  'LICENSE',
  'config.example.json',
  'artifact-manifest.json',
  'MANIFEST.in',
  'install.sh',
  'index.html',
  'style.css'
]);
const SOURCE_FILE_PATTERN = /^src\/reachy_homebrain\/[A-Za-z0-9_./-]+\.(?:py|json|txt|typed)$/;
const RUNTIME_ROOT_FILE_ALLOWLIST = new Set(['pyproject.toml', 'artifact-manifest.json']);
const STABLE_LAUNCHER_FILES = new Set([
  'src/reachy_homebrain/__init__.py',
  'src/reachy_homebrain/__main__.py',
  'src/reachy_homebrain/main.py',
  'src/reachy_homebrain/releases.py',
  'src/reachy_homebrain/launcher_constants.py',
  'src/reachy_homebrain/sdk_compat.py'
]);

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value
    && !normalized.startsWith('/')
    && normalized !== '..'
    && !normalized.startsWith('../')
    && normalized.split('/').every((segment) => segment && segment !== '.' && !EXCLUDED_SEGMENTS.has(segment))
    && (ROOT_FILE_ALLOWLIST.has(normalized) || SOURCE_FILE_PATTERN.test(normalized));
}

function isRuntimeRelativePath(value) {
  return isSafeRelativePath(value)
    && !STABLE_LAUNCHER_FILES.has(value)
    && (RUNTIME_ROOT_FILE_ALLOWLIST.has(value) || value.startsWith('src/reachy_homebrain/'));
}

function readVersionFromPyproject(content) {
  const match = String(content || '').match(/^version\s*=\s*["']([^"']+)["']/m);
  return match ? match[1].trim() : '0.0.0';
}

function readTomlStringArray(content, sectionName, key) {
  const source = String(content || '');
  const sectionStart = source.indexOf(`[${sectionName}]`);
  if (sectionStart < 0) return [];
  const sectionBodyStart = sectionStart + sectionName.length + 2;
  const nextSectionOffset = source.slice(sectionBodyStart).search(/^\s*\[/m);
  const section = nextSectionOffset >= 0
    ? source.slice(sectionBodyStart, sectionBodyStart + nextSectionOffset)
    : source.slice(sectionBodyStart);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = section.match(new RegExp(`^\\s*${escapedKey}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm'));
  if (!match) return [];
  return Array.from(match[1].matchAll(/["']([^"']+)["']/g), (entry) => entry[1].trim()).filter(Boolean);
}

function dependencyFingerprintFromPyproject(content) {
  const dependencies = readTomlStringArray(content, 'project', 'dependencies');
  const optionalInstalled = readTomlStringArray(content, 'project.optional-dependencies', 'wakeword')
    .map((dependency) => `${dependency} (optional-installed)`);
  if (dependencies.length === 0) {
    throw new Error('Reachy package is missing declared runtime dependencies');
  }
  return crypto.createHash('sha256').update([...dependencies, ...optionalInstalled].join('\n'), 'utf8').digest('hex');
}

function launcherFingerprintFromSource(metadata = {}, sourceRoot = SOURCE_ROOT) {
  const declaredFiles = Array.isArray(metadata?.stableLauncherFiles)
    ? metadata.stableLauncherFiles
    : [];
  const expectedFiles = [...STABLE_LAUNCHER_FILES].sort(compareUtf8);
  const normalizedFiles = [...new Set(declaredFiles.map((value) => String(value || '')))].sort(compareUtf8);
  if (
    normalizedFiles.length !== expectedFiles.length
    || normalizedFiles.some((value, index) => value !== expectedFiles[index])
  ) {
    throw new Error('Reachy stable launcher inventory metadata is incomplete or unexpected');
  }
  const aggregate = crypto.createHash('sha256');
  for (const relativePath of normalizedFiles) {
    const absolutePath = path.join(sourceRoot, ...relativePath.split('/'));
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Reachy stable launcher file is missing or unsafe: ${relativePath}`);
    }
    const buffer = fs.readFileSync(absolutePath);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    aggregate.update(relativePath, 'utf8');
    aggregate.update('\0');
    aggregate.update(String(buffer.length), 'ascii');
    aggregate.update('\0');
    aggregate.update(digest, 'ascii');
    aggregate.update('\n');
  }
  return aggregate.digest('hex');
}

function normalizeCompatibility(metadata, pyproject, computedLauncherFingerprint = null) {
  const compatibility = metadata?.compatibility;
  const launcherApi = Number(compatibility?.launcherApi);
  const dependencyFingerprint = String(compatibility?.dependencyFingerprint || '').toLowerCase();
  const launcherFingerprint = String(compatibility?.launcherFingerprint || '').toLowerCase();
  if (!Number.isInteger(launcherApi) || launcherApi < 1) {
    throw new Error('Reachy package compatibility launcherApi is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(dependencyFingerprint)) {
    throw new Error('Reachy package dependency fingerprint is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(launcherFingerprint)) {
    throw new Error('Reachy package stable launcher fingerprint is invalid');
  }
  const computedFingerprint = dependencyFingerprintFromPyproject(pyproject);
  if (dependencyFingerprint !== computedFingerprint) {
    throw new Error('Reachy package dependency metadata changed and requires a manual reinstall');
  }
  const actualLauncherFingerprint = computedLauncherFingerprint || launcherFingerprintFromSource(metadata);
  if (launcherFingerprint !== actualLauncherFingerprint) {
    throw new Error('Reachy stable launcher files changed and require a manual reinstall');
  }
  return {
    launcherApi,
    dependencyFingerprint,
    launcherFingerprint,
    requiresManualReinstall: compatibility.requiresManualReinstall === true
  };
}

async function sha256File(absolutePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absolutePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

async function walkFiles(directory, relativeDirectory = '') {
  const entries = await fsPromises.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => compareUtf8(left.name, right.name))) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...await walkFiles(absolutePath, relativePath));
    } else if (entry.isFile() && isSafeRelativePath(relativePath)) {
      files.push({ path: relativePath, absolutePath });
    }
    if (files.length > MAX_FILES) {
      throw new Error(`Reachy app package exceeds the ${MAX_FILES}-file safety limit`);
    }
  }
  return files;
}

class ReachyMiniPackageService {
  constructor() {
    this.cache = new Map();
  }

  async buildManifest(options = {}) {
    const now = Date.now();
    const runtimeOnly = options.runtimeOnly === true;
    const cacheKey = runtimeOnly ? 'runtime' : 'bootstrap';
    const cached = this.cache.get(cacheKey);
    if (options.force !== true && cached && cached.expiresAt > now) {
      return JSON.parse(JSON.stringify(cached.manifest));
    }
    const rootStat = await fsPromises.stat(SOURCE_ROOT).catch(() => null);
    if (!rootStat?.isDirectory()) {
      const error = new Error('Reachy companion source package is unavailable');
      error.status = 503;
      throw error;
    }
    const candidates = (await walkFiles(SOURCE_ROOT))
      .filter((candidate) => !runtimeOnly || isRuntimeRelativePath(candidate.path))
      .sort((left, right) => compareUtf8(left.path, right.path));
    let totalSize = 0;
    const files = [];
    for (const candidate of candidates) {
      const stat = await fsPromises.stat(candidate.absolutePath);
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(`Reachy package file exceeds safety limit: ${candidate.path}`);
      }
      totalSize += stat.size;
      if (totalSize > MAX_PACKAGE_BYTES) {
        throw new Error('Reachy app package exceeds aggregate safety limit');
      }
      files.push({
        path: candidate.path,
        size: stat.size,
        sha256: await sha256File(candidate.absolutePath)
      });
    }
    const pyproject = await fsPromises.readFile(path.join(SOURCE_ROOT, 'pyproject.toml'), 'utf8');
    const version = readVersionFromPyproject(pyproject);
    let artifactMetadata;
    try {
      artifactMetadata = JSON.parse(await fsPromises.readFile(path.join(SOURCE_ROOT, 'artifact-manifest.json'), 'utf8'));
    } catch (error) {
      throw new Error(`Reachy artifact metadata is invalid: ${error.message}`);
    }
    if (artifactMetadata?.artifact !== 'reachy-homebrain-app' || artifactMetadata?.version !== version) {
      throw new Error('Reachy artifact metadata identity/version does not match pyproject.toml');
    }
    const compatibility = normalizeCompatibility(artifactMetadata, pyproject);
    const aggregate = crypto.createHash('sha256');
    files.forEach((file) => {
      aggregate.update(file.path, 'utf8');
      aggregate.update('\0');
      aggregate.update(String(file.size), 'utf8');
      aggregate.update('\0');
      aggregate.update(file.sha256, 'utf8');
      aggregate.update('\n');
    });
    const manifest = {
      schemaVersion: 1,
      artifact: 'reachy-homebrain-app',
      version,
      aggregateSha256: aggregate.digest('hex'),
      compatibility,
      files,
      fileCount: files.length,
      totalSize,
      generatedAt: new Date().toISOString()
    };
    this.cache.set(cacheKey, { manifest, expiresAt: now + 30_000 });
    return JSON.parse(JSON.stringify(manifest));
  }

  async resolveFile(relativePath, options = {}) {
    const runtimeOnly = options.runtimeOnly === true;
    if (!isSafeRelativePath(relativePath) || (runtimeOnly && !isRuntimeRelativePath(relativePath))) {
      const error = new Error('Invalid Reachy package file path');
      error.status = 400;
      throw error;
    }
    const manifest = await this.buildManifest({ runtimeOnly });
    const entry = manifest.files.find((file) => file.path === relativePath);
    if (!entry) {
      const error = new Error('Reachy package file not found');
      error.status = 404;
      throw error;
    }
    const absolutePath = path.resolve(SOURCE_ROOT, ...relativePath.split('/'));
    const relative = path.relative(SOURCE_ROOT, absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      const error = new Error('Invalid Reachy package file path');
      error.status = 400;
      throw error;
    }
    const before = await fsPromises.lstat(absolutePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== entry.size) {
      const error = new Error('Reachy package file changed after manifest generation');
      error.status = 409;
      throw error;
    }
    const realPath = await fsPromises.realpath(absolutePath);
    const realRelative = path.relative(await fsPromises.realpath(SOURCE_ROOT), realPath);
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      const error = new Error('Reachy package file escaped the source root');
      error.status = 400;
      throw error;
    }
    const buffer = await fsPromises.readFile(realPath);
    const after = await fsPromises.lstat(realPath);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (before.ino !== after.ino || before.size !== after.size || buffer.length !== entry.size || digest !== entry.sha256) {
      const error = new Error('Reachy package file failed post-open integrity verification');
      error.status = 409;
      throw error;
    }
    return { ...entry, buffer };
  }
}

module.exports = new ReachyMiniPackageService();
module.exports.ReachyMiniPackageService = ReachyMiniPackageService;
module.exports.SOURCE_ROOT = SOURCE_ROOT;
module.exports.isSafeRelativePath = isSafeRelativePath;
module.exports.isRuntimeRelativePath = isRuntimeRelativePath;
module.exports.STABLE_LAUNCHER_FILES = STABLE_LAUNCHER_FILES;
module.exports.readVersionFromPyproject = readVersionFromPyproject;
module.exports.readTomlStringArray = readTomlStringArray;
module.exports.dependencyFingerprintFromPyproject = dependencyFingerprintFromPyproject;
module.exports.launcherFingerprintFromSource = launcherFingerprintFromSource;
module.exports.normalizeCompatibility = normalizeCompatibility;
module.exports.compareUtf8 = compareUtf8;

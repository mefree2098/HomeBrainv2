const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const OllamaConfig = require('../models/OllamaConfig');
const Settings = require('../models/Settings');
const os = require('os');

const execAsync = promisify(exec);
const fsp = fs.promises;

const MAX_LOG_LINES = 2000;
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_BYTES = 1_048_576; // 1 MB
const LOG_LINE_SPLIT_REGEX = /\r?\n/;
const MAX_OPERATION_LOG_LINES = 4000;
const VERSION_REGEX = /v?(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?)/i;
const MAX_MANIFEST_SCAN_FILES = 5000;
const OLLAMA_LIBRARY_BASE_URL = 'https://ollama.com';
const OLLAMA_SEARCH_MAX_PAGES = 100;
const OLLAMA_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const OLLAMA_SEARCH_TIMEOUT_MS = 12000;
const OLLAMA_CAPABILITY_ALLOWLIST = new Set(['vision', 'tools', 'thinking', 'embedding', 'cloud']);

function decodeHtmlEntities(text = '') {
  return String(text)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function stripTags(text = '') {
  return decodeHtmlEntities(String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

function parseHumanNumber(value = '') {
  const normalized = String(value).trim().toUpperCase().replace(/,/g, '');
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)([KMB])?$/);
  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1]);
  const suffix = match[2] || '';
  if (!Number.isFinite(amount)) {
    return null;
  }

  if (suffix === 'B') {
    return amount * 1_000_000_000;
  }
  if (suffix === 'M') {
    return amount * 1_000_000;
  }
  if (suffix === 'K') {
    return amount * 1_000;
  }
  return amount;
}

function parseParameterTokenToBillions(token = '') {
  const normalized = String(token).trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const moeMatch = normalized.match(/^([0-9]+(?:\.[0-9]+)?)x([0-9]+(?:\.[0-9]+)?)b$/);
  if (moeMatch) {
    const experts = Number.parseFloat(moeMatch[1]);
    const perExpert = Number.parseFloat(moeMatch[2]);
    if (Number.isFinite(experts) && Number.isFinite(perExpert)) {
      return experts * perExpert;
    }
  }

  const billionsMatch = normalized.match(/^([0-9]+(?:\.[0-9]+)?)b$/);
  if (billionsMatch) {
    const value = Number.parseFloat(billionsMatch[1]);
    return Number.isFinite(value) ? value : null;
  }

  const millionsMatch = normalized.match(/^([0-9]+(?:\.[0-9]+)?)m$/);
  if (millionsMatch) {
    const value = Number.parseFloat(millionsMatch[1]);
    return Number.isFinite(value) ? value / 1000 : null;
  }

  return null;
}

function parseRelativeAgeToDays(value = '') {
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === 'today') {
    return 0;
  }
  if (normalized === 'yesterday') {
    return 1;
  }

  const match = normalized.match(/^([0-9]+)\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\s+ago$/);
  if (!match) {
    return null;
  }

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const unit = match[2];
  if (unit.startsWith('minute')) {
    return amount / (60 * 24);
  }
  if (unit.startsWith('hour')) {
    return amount / 24;
  }
  if (unit.startsWith('day')) {
    return amount;
  }
  if (unit.startsWith('week')) {
    return amount * 7;
  }
  if (unit.startsWith('month')) {
    return amount * 30;
  }
  if (unit.startsWith('year')) {
    return amount * 365;
  }
  return null;
}

async function commandExists(command) {
  try {
    await execAsync(`command -v ${command}`, { timeout: 2000 });
    return true;
  } catch (error) {
    return false;
  }
}

async function isReadableFile(filePath) {
  try {
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) {
      return false;
    }
    await fsp.access(filePath, fs.constants.R_OK);
    return true;
  } catch (error) {
    return false;
  }
}

async function readLastLines(filePath, maxLines) {
  const stats = await fsp.stat(filePath);

  if (!stats.isFile() || stats.size === 0) {
    return [];
  }

  const chunkSize = Math.min(stats.size, MAX_LOG_BYTES);
  const buffer = Buffer.alloc(chunkSize);
  const offset = Math.max(stats.size - chunkSize, 0);
  const fileHandle = await fsp.open(filePath, 'r');

  try {
    const { bytesRead } = await fileHandle.read(buffer, 0, chunkSize, offset);
    if (bytesRead === 0) {
      return [];
    }
    const content = buffer.toString('utf8', 0, bytesRead);
    const lines = content.split(LOG_LINE_SPLIT_REGEX);
    if (lines.length && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.length > maxLines ? lines.slice(-maxLines) : lines;
  } finally {
    await fileHandle.close();
  }
}

function buildLogCandidatePaths() {
  const candidates = [];
  const homeDir = os.homedir ? os.homedir() : null;

  if (homeDir) {
    const logsDir = path.join(homeDir, '.ollama', 'logs');
    ['ollama.log', 'server.log', 'ollama-service.log', 'ollama.jsonl', 'serve.log'].forEach((name) => {
      candidates.push(path.join(logsDir, name));
    });

    if (process.platform === 'darwin') {
      candidates.push(path.join(homeDir, 'Library', 'Logs', 'Ollama', 'ollama.log'));
    }

    if (process.platform === 'win32') {
      candidates.push(path.join(homeDir, 'AppData', 'Local', 'Ollama', 'Logs', 'ollama.log'));
    }
  }

  candidates.push('/var/log/ollama.log');
  candidates.push('/var/log/ollama/ollama.log');
  candidates.push('/var/log/ollama-service.log');

  return Array.from(new Set(candidates.filter(Boolean)));
}

async function isReadableDirectory(dirPath) {
  try {
    const stats = await fsp.stat(dirPath);
    if (!stats.isDirectory()) {
      return false;
    }
    await fsp.access(dirPath, fs.constants.R_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function normalizeOllamaRootPath(candidate) {
  if (!candidate || typeof candidate !== 'string') {
    return null;
  }

  const normalized = path.resolve(candidate.trim());
  if (!normalized) {
    return null;
  }

  if (path.basename(normalized) === 'models') {
    return path.dirname(normalized);
  }

  return normalized;
}

function buildModelStoreCandidateRoots() {
  const candidates = new Set();
  const homeDir = os.homedir ? os.homedir() : null;

  if (homeDir) {
    candidates.add(path.join(homeDir, '.ollama'));
  }

  candidates.add('/usr/share/ollama/.ollama');
  candidates.add('/var/lib/ollama/.ollama');
  candidates.add('/home/ollama/.ollama');
  candidates.add('/root/.ollama');

  const envModelPath = normalizeOllamaRootPath(process.env.OLLAMA_MODELS);
  if (envModelPath) {
    candidates.add(envModelPath);
  }

  return Array.from(candidates);
}

async function collectManifestFiles(manifestRoot, limit = MAX_MANIFEST_SCAN_FILES) {
  const files = [];
  const pending = [manifestRoot];

  while (pending.length && files.length < limit) {
    const current = pending.pop();

    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }

      if (entry.isFile()) {
        files.push(fullPath);
        if (files.length >= limit) {
          break;
        }
      }
    }
  }

  return files;
}

function deriveModelFromManifestPath(manifestPath, manifestRoot) {
  const relative = path.relative(manifestRoot, manifestPath);
  if (!relative || relative.startsWith('..')) {
    return null;
  }

  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const tag = parts[parts.length - 1];
  const model = parts[parts.length - 2];
  if (!model || !tag) {
    return null;
  }

  let fullModelName = model;
  const possibleNamespace = parts[parts.length - 3];
  if (possibleNamespace && possibleNamespace !== 'library' && possibleNamespace !== 'models') {
    fullModelName = `${possibleNamespace}/${model}`;
  }

  return {
    name: `${fullModelName}:${tag}`,
    tag
  };
}

function normalizeVersionString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return null;
  }

  const match = trimmed.match(VERSION_REGEX);
  if (!match || !match[1]) {
    return trimmed;
  }

  return match[1];
}

function parseVersion(value) {
  const normalized = normalizeVersionString(value);
  if (!normalized) {
    return null;
  }

  const [core, preRelease = null] = normalized.split('-', 2);
  const numbers = core.split('.').map((segment) => Number.parseInt(segment, 10));
  if (numbers.some((part) => Number.isNaN(part))) {
    return { normalized, numbers: [], preRelease };
  }

  return { normalized, numbers, preRelease };
}

function compareVersionStrings(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);

  if (!left || !right) {
    return null;
  }

  if (!left.numbers.length || !right.numbers.length) {
    return left.normalized.localeCompare(right.normalized, undefined, { numeric: true, sensitivity: 'base' });
  }

  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.numbers[index] || 0;
    const rightPart = right.numbers[index] || 0;

    if (leftPart < rightPart) {
      return -1;
    }
    if (leftPart > rightPart) {
      return 1;
    }
  }

  if (left.preRelease === right.preRelease) {
    return 0;
  }

  if (!left.preRelease && right.preRelease) {
    return 1;
  }

  if (left.preRelease && !right.preRelease) {
    return -1;
  }

  return left.preRelease.localeCompare(right.preRelease, undefined, { numeric: true, sensitivity: 'base' });
}

function parseOllamaSearchResponse(html = '') {
  const models = [];
  const modelBlocks = String(html).match(/<li x-test-model[\s\S]*?<\/li>/g) || [];

  for (const block of modelBlocks) {
    const hrefMatch = block.match(/<a href="(\/library\/[^"]+)"/);
    const titleMatch = block.match(/x-test-search-response-title>([\s\S]*?)<\/span>/);
    const descriptionMatch = block.match(/<p class="max-w-lg[^"]*">([\s\S]*?)<\/p>/);
    const sizeMatches = [...block.matchAll(/x-test-size[^>]*>([\s\S]*?)<\/span>/g)];
    const capabilityMatches = [...block.matchAll(/x-test-capability[^>]*>([\s\S]*?)<\/span>/g)];
    const pullMatch = block.match(/x-test-pull-count>([\s\S]*?)<\/span>/);
    const tagCountMatch = block.match(/x-test-tag-count>([\s\S]*?)<\/span>/);
    const updatedMatch = block.match(/x-test-updated>([\s\S]*?)<\/span>/);

    const nameFromHref = hrefMatch?.[1]
      ? hrefMatch[1].replace('/library/', '').trim()
      : '';
    const name = stripTags(titleMatch?.[1] || nameFromHref);
    if (!name) {
      continue;
    }

    const parameterSizes = sizeMatches
      .map((match) => stripTags(match?.[1] || ''))
      .filter(Boolean);
    const capabilities = capabilityMatches
      .map((match) => stripTags(match?.[1] || '').toLowerCase())
      .filter(Boolean);
    const pullCount = stripTags(pullMatch?.[1] || '');
    const tagCount = stripTags(tagCountMatch?.[1] || '');
    const updated = stripTags(updatedMatch?.[1] || '');
    const description = stripTags(descriptionMatch?.[1] || '');
    const parameterValues = parameterSizes
      .map(parseParameterTokenToBillions)
      .filter((value) => Number.isFinite(value));
    const smallestParameterB = parameterValues.length
      ? Math.min(...parameterValues)
      : null;

    models.push({
      name,
      description,
      parameterSizes,
      parameterSize: parameterSizes.join(', '),
      capabilities,
      pullCount: pullCount || null,
      pullCountValue: parseHumanNumber(pullCount),
      tagCount: tagCount || null,
      tagCountValue: Number.isFinite(Number.parseInt(tagCount, 10)) ? Number.parseInt(tagCount, 10) : null,
      updated: updated || null,
      updatedDaysAgo: parseRelativeAgeToDays(updated),
      smallestParameterB,
      nanoFit: Number.isFinite(smallestParameterB) ? smallestParameterB <= 8 : false,
      size: parameterSizes.join(', '),
      libraryUrl: hrefMatch?.[1] ? `${OLLAMA_LIBRARY_BASE_URL}${hrefMatch[1]}` : `${OLLAMA_LIBRARY_BASE_URL}/library/${name}`
    });
  }

  const nextPageMatch = String(html).match(/hx-get="\/search\?page=([0-9]+)[^"]*"/);
  const nextPage = nextPageMatch?.[1] ? Number.parseInt(nextPageMatch[1], 10) : null;

  return {
    models,
    nextPage: Number.isFinite(nextPage) ? nextPage : null
  };
}

class OllamaService {
  constructor() {
    this.apiUrl = 'http://localhost:11434';
    this.operationLogs = [];
    this.availableModelsCache = new Map();
  }

  syncApiUrl(config) {
    if (config?.configuration?.apiUrl) {
      this.apiUrl = config.configuration.apiUrl;
    }
  }

  addOperationLog(scope, message) {
    if (typeof message !== 'string') {
      return;
    }

    const lines = message
      .split(LOG_LINE_SPLIT_REGEX)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    if (!lines.length) {
      return;
    }

    for (const line of lines) {
      this.operationLogs.push(`[${new Date().toISOString()}] [${scope}] ${line}`);
    }

    if (this.operationLogs.length > MAX_OPERATION_LOG_LINES) {
      this.operationLogs = this.operationLogs.slice(-MAX_OPERATION_LOG_LINES);
    }
  }

  addCommandOutputToOperationLogs(scope, output, stream = 'stdout') {
    if (!output || typeof output !== 'string') {
      return;
    }

    const lines = output
      .split(LOG_LINE_SPLIT_REGEX)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    for (const line of lines) {
      this.addOperationLog(scope, `${stream}: ${line}`);
    }
  }

  getOperationLogLines(maxLines) {
    if (!Number.isFinite(maxLines) || maxLines <= 0) {
      return [];
    }
    return this.operationLogs.slice(-maxLines);
  }

  isUpdateAvailable(currentVersion, latestVersion) {
    const normalizedCurrent = normalizeVersionString(currentVersion);
    const normalizedLatest = normalizeVersionString(latestVersion);

    if (!normalizedCurrent || !normalizedLatest) {
      return Boolean(normalizedCurrent && normalizedLatest && normalizedCurrent !== normalizedLatest);
    }

    const comparison = compareVersionStrings(normalizedCurrent, normalizedLatest);
    if (comparison === null) {
      return normalizedCurrent !== normalizedLatest;
    }

    return comparison < 0;
  }

  extractVersionFromOutput(...outputs) {
    for (const output of outputs) {
      const normalized = normalizeVersionString(output);
      if (normalized) {
        return normalized;
      }
    }

    return 'unknown';
  }

  getOllamaHostForEnv() {
    try {
      const parsed = new URL(this.apiUrl);
      if (parsed.host) {
        return parsed.host;
      }
    } catch (error) {
      // Fall back to raw API URL parsing.
    }

    const fallback = (this.apiUrl || '').replace(/^https?:\/\//i, '').replace(/\/$/, '').trim();
    return fallback || '127.0.0.1:11434';
  }

  async pullModelWithCli(modelName, timeoutMs = 3600000) {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        OLLAMA_HOST: this.getOllamaHostForEnv()
      };

      const child = spawn('ollama', ['pull', modelName], { env });
      let timedOut = false;
      let timeoutRef = null;

      if (timeoutMs > 0) {
        timeoutRef = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => {
            child.kill('SIGKILL');
          }, 2000);
        }, timeoutMs);
      }

      child.stdout?.on('data', (chunk) => {
        this.addCommandOutputToOperationLogs('model', chunk.toString(), 'stdout');
      });

      child.stderr?.on('data', (chunk) => {
        this.addCommandOutputToOperationLogs('model', chunk.toString(), 'stderr');
      });

      child.once('error', (error) => {
        if (timeoutRef) {
          clearTimeout(timeoutRef);
        }
        reject(error);
      });

      child.once('close', (code, signal) => {
        if (timeoutRef) {
          clearTimeout(timeoutRef);
        }

        if (timedOut) {
          reject(new Error(`ollama pull timed out after ${timeoutMs}ms`));
          return;
        }

        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`ollama pull exited with code ${code}${signal ? ` (${signal})` : ''}`));
      });
    });
  }

  transformApiModels(models = []) {
    return models.map((model) => {
      const modelName = model.name || '';
      const tagIndex = modelName.lastIndexOf(':');
      const parsedTag = tagIndex > -1 ? modelName.slice(tagIndex + 1) : 'latest';

      return {
        name: modelName,
        tag: parsedTag || 'latest',
        size: model.size || 0,
        digest: model.digest || '',
        modifiedAt: model.modified_at ? new Date(model.modified_at) : new Date(),
        family: model.details?.family || '',
        parameterSize: model.details?.parameter_size || '',
        quantizationLevel: model.details?.quantization_level || '',
        format: model.details?.format || '',
        details: {
          ...(model.details || {}),
          availableInService: true,
          sources: ['service_api']
        }
      };
    });
  }

  async fetchModelsFromApi() {
    const response = await axios.get(`${this.apiUrl}/api/tags`, { timeout: 10000 });
    const models = Array.isArray(response.data?.models) ? response.data.models : [];
    return this.transformApiModels(models);
  }

  async fetchModelsFromCli() {
    if (!(await commandExists('ollama'))) {
      return [];
    }

    try {
      const { stdout } = await execAsync('ollama list', {
        timeout: 10000,
        maxBuffer: MAX_LOG_BYTES * 2
      });

      const lines = String(stdout || '')
        .split(LOG_LINE_SPLIT_REGEX)
        .map((line) => line.trim())
        .filter(Boolean);

      if (!lines.length) {
        return [];
      }

      const dataLines = lines[0].toLowerCase().startsWith('name') ? lines.slice(1) : lines;
      const models = [];

      for (const line of dataLines) {
        const name = line.split(/\s+/)[0];
        if (!name) {
          continue;
        }

        const tagIndex = name.lastIndexOf(':');
        const parsedTag = tagIndex > -1 ? name.slice(tagIndex + 1) : 'latest';

        models.push({
          name,
          tag: parsedTag || 'latest',
          size: 0,
          digest: '',
          modifiedAt: new Date(),
          family: '',
          parameterSize: '',
          quantizationLevel: '',
          format: '',
          details: {
            availableInService: false,
            sources: ['cli_list']
          }
        });
      }

      return models;
    } catch (error) {
      this.addOperationLog('model', `CLI model query failed: ${error.message}`);
      return [];
    }
  }

  async discoverFilesystemModels() {
    const roots = buildModelStoreCandidateRoots();
    const modelMap = new Map();

    for (const root of roots) {
      const manifestRoot = path.join(root, 'models', 'manifests');
      if (!(await isReadableDirectory(manifestRoot))) {
        continue;
      }

      const files = await collectManifestFiles(manifestRoot);
      for (const manifestFile of files) {
        const modelInfo = deriveModelFromManifestPath(manifestFile, manifestRoot);
        if (!modelInfo) {
          continue;
        }

        let stats;
        try {
          stats = await fsp.stat(manifestFile);
        } catch (error) {
          continue;
        }

        const existing = modelMap.get(modelInfo.name);
        if (!existing) {
          modelMap.set(modelInfo.name, {
            name: modelInfo.name,
            tag: modelInfo.tag || 'latest',
            size: 0,
            digest: '',
            modifiedAt: stats.mtime || new Date(),
            family: '',
            parameterSize: '',
            quantizationLevel: '',
            format: '',
            details: {
              availableInService: false,
              sources: ['filesystem_manifest'],
              manifestPaths: [manifestFile],
              modelStoreRoots: [root]
            }
          });
          continue;
        }

        if (stats.mtime && new Date(existing.modifiedAt).getTime() < stats.mtime.getTime()) {
          existing.modifiedAt = stats.mtime;
        }

        const paths = Array.isArray(existing.details?.manifestPaths) ? existing.details.manifestPaths : [];
        if (!paths.includes(manifestFile)) {
          paths.push(manifestFile);
        }
        existing.details.manifestPaths = paths;

        const stores = Array.isArray(existing.details?.modelStoreRoots) ? existing.details.modelStoreRoots : [];
        if (!stores.includes(root)) {
          stores.push(root);
        }
        existing.details.modelStoreRoots = stores;
      }
    }

    return Array.from(modelMap.values());
  }

  mergeServiceAndFilesystemModels(serviceModels = [], filesystemModels = []) {
    const modelMap = new Map();

    for (const serviceModel of serviceModels) {
      modelMap.set(serviceModel.name, {
        ...serviceModel,
        details: {
          ...(serviceModel.details || {}),
          availableInService: true
        }
      });
    }

    for (const fsModel of filesystemModels) {
      const existing = modelMap.get(fsModel.name);
      if (!existing) {
        modelMap.set(fsModel.name, fsModel);
        continue;
      }

      const existingPaths = Array.isArray(existing.details?.manifestPaths) ? existing.details.manifestPaths : [];
      const fsPaths = Array.isArray(fsModel.details?.manifestPaths) ? fsModel.details.manifestPaths : [];
      const manifestPaths = Array.from(new Set([...existingPaths, ...fsPaths]));

      const existingRoots = Array.isArray(existing.details?.modelStoreRoots) ? existing.details.modelStoreRoots : [];
      const fsRoots = Array.isArray(fsModel.details?.modelStoreRoots) ? fsModel.details.modelStoreRoots : [];
      const modelStoreRoots = Array.from(new Set([...existingRoots, ...fsRoots]));

      existing.details = {
        ...(existing.details || {}),
        manifestPaths,
        modelStoreRoots,
        availableInService:
          Boolean(existing.details?.availableInService) ||
          Boolean(fsModel.details?.availableInService)
      };
    }

    return Array.from(modelMap.values()).sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Check if Ollama is installed
   */
  async checkInstallation() {
    try {
      console.log('Checking Ollama installation status...');

      // Check if ollama command exists
      try {
        const { stdout } = await execAsync('which ollama', { timeout: 5000 });
        if (!stdout.trim()) {
          return { isInstalled: false, version: null };
        }
      } catch (error) {
        return { isInstalled: false, version: null };
      }

      // Get version
      const versionCommands = ['ollama --version', 'ollama version'];
      for (const command of versionCommands) {
        try {
          const { stdout, stderr } = await execAsync(command, { timeout: 5000 });
          const version = this.extractVersionFromOutput(stdout, stderr);
          console.log(`Ollama is installed, version: ${version}`);
          return { isInstalled: true, version };
        } catch (error) {
          console.error(`Error getting Ollama version with "${command}":`, error.message || error);
        }
      }

      return { isInstalled: true, version: 'unknown' };
    } catch (error) {
      console.error('Error checking Ollama installation:', error);
      throw error;
    }
  }

  /**
   * Check if Ollama service is running
   */
  async checkServiceStatus() {
    try {
      console.log('Checking Ollama service status...');
      const response = await axios.get(`${this.apiUrl}/api/tags`, { timeout: 3000 });
      return { running: true, error: null };
    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        return { running: false, error: 'Service not running' };
      }
      return { running: false, error: error.message };
    }
  }

  async detectPrivilegeContext() {
    let currentUser = 'unknown';
    try {
      const { stdout } = await execAsync('whoami', { timeout: 2000 });
      currentUser = stdout.trim();
      console.log(`Running as user: ${currentUser}`);
    } catch (error) {
      console.log('Could not determine current user');
    }

    const isRoot = currentUser === 'root';
    let hasSudoBinary = false;
    let hasPasswordlessSudo = false;

    if (!isRoot) {
      hasSudoBinary = await commandExists('sudo');
      if (!hasSudoBinary) {
        console.log('sudo command not found');
      } else {
        try {
          await execAsync('sudo -n true', { timeout: 2000 });
          hasPasswordlessSudo = true;
          console.log('sudo command found and user has passwordless sudo privileges');
        } catch (error) {
          console.log('sudo found but user does not have passwordless sudo privileges');
        }
      }
    }

    return {
      currentUser,
      isRoot,
      hasSudoBinary,
      hasPasswordlessSudo
    };
  }

  async runSudoShellCommandWithPassword(command, sudoPassword, scope, timeout = 300000) {
    return new Promise((resolve, reject) => {
      const child = spawn('sudo', ['-S', '-p', '', 'sh', '-c', command], {
        env: process.env
      });

      let stdout = '';
      let stderr = '';
      let finished = false;
      let timeoutHandle = null;

      const complete = (error, result = null) => {
        if (finished) {
          return;
        }
        finished = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      };

      if (timeout > 0) {
        timeoutHandle = setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 2000);
          complete(new Error(`Command timed out after ${timeout}ms`));
        }, timeout);
      }

      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        this.addCommandOutputToOperationLogs(scope, text, 'stdout');
      });

      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        this.addCommandOutputToOperationLogs(scope, text, 'stderr');
      });

      child.once('error', (error) => {
        complete(error);
      });

      child.once('close', (code, signal) => {
        if (code === 0) {
          complete(null, { stdout, stderr });
          return;
        }

        const stderrLower = String(stderr || '').toLowerCase();
        if (stderrLower.includes('sorry, try again')
            || stderrLower.includes('incorrect password')
            || stderrLower.includes('authentication failure')) {
          complete(new Error('Invalid sudo password.'));
          return;
        }

        if (stderrLower.includes('a password is required')
            || stderrLower.includes('no tty present')
            || stderrLower.includes('terminal is required')) {
          complete(new Error('Unable to read sudo password in this environment.'));
          return;
        }

        complete(new Error(`sudo command failed with code ${code}${signal ? ` (${signal})` : ''}`));
      });

      child.stdin?.write(`${sudoPassword || ''}\n`);
      child.stdin?.end();
    });
  }

  /**
   * Install Ollama
   */
  async install({ sudoPassword = null } = {}) {
    try {
      console.log('Starting Ollama installation...');

      const config = await OllamaConfig.getConfig();
      this.syncApiUrl(config);
      this.addOperationLog('install', 'Starting Ollama installation');
      config.serviceStatus = 'installing';
      await config.save();

      const {
        currentUser,
        isRoot,
        hasSudoBinary,
        hasPasswordlessSudo
      } = await this.detectPrivilegeContext();
      const hasSudoPassword = !isRoot
        && hasSudoBinary
        && typeof sudoPassword === 'string'
        && sudoPassword.length > 0;

      // If we're not root and don't have working sudo, installation cannot proceed
      if (!isRoot && (!hasSudoBinary || (!hasPasswordlessSudo && !hasSudoPassword))) {
        const errorMessage = hasSudoBinary
          ? `Ollama installation requires sudo privileges. This service is running as "${currentUser}" and cannot use sudo non-interactively. Re-run installation and provide your sudo password, or configure passwordless sudo for this service user.`
          : `Ollama installation requires root privileges. This system is running as user "${currentUser}" and sudo is not available. Please contact your system administrator for assistance.`;

        console.error(errorMessage);

        const config = await OllamaConfig.getConfig();
        config.serviceStatus = 'error';
        await config.setError(errorMessage);
        this.addOperationLog('install', errorMessage);

        throw new Error(errorMessage);
      }

      // Prepare installation command
      const installScriptCommand = 'curl -fsSL https://ollama.com/install.sh | sh';
      let commandResult;
      if (isRoot) {
        console.log('Running Ollama installation script as root...');
        commandResult = await execAsync(installScriptCommand, {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 300000 // 5 minutes timeout
        });
      } else if (hasPasswordlessSudo) {
        console.log('Running Ollama installation script with passwordless sudo...');
        commandResult = await execAsync('curl -fsSL https://ollama.com/install.sh | sudo sh', {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 300000 // 5 minutes timeout
        });
      } else {
        console.log('Running Ollama installation script with provided sudo password...');
        this.addOperationLog('install', 'Running installation command (sudo password provided)');
        commandResult = await this.runSudoShellCommandWithPassword(
          installScriptCommand,
          sudoPassword,
          'install',
          300000
        );
      }

      const { stdout, stderr } = commandResult;

      this.addCommandOutputToOperationLogs('install', stdout, 'stdout');
      this.addCommandOutputToOperationLogs('install', stderr, 'stderr');
      console.log('Ollama installation output:', stdout);
      if (stderr) {
        console.log('Ollama installation stderr:', stderr);
      }

      // Verify installation
      const installStatus = await this.checkInstallation();

      if (!installStatus.isInstalled) {
        throw new Error('Ollama installation failed - binary not found after installation');
      }

      // Start Ollama service
      console.log('Starting Ollama service...');
      await this.startService();

      // Update config
      await config.updateInstallation(installStatus.version, true);
      this.addOperationLog('install', `Installation completed successfully at version ${installStatus.version}`);

      console.log('Ollama installation completed successfully');
      return { success: true, version: installStatus.version };
    } catch (error) {
      console.error('Error installing Ollama:', error);
      this.addOperationLog('install', `Installation failed: ${error.message}`);

      const config = await OllamaConfig.getConfig();
      config.serviceStatus = 'error';
      await config.setError(`Installation failed: ${error.message}`);

      throw error;
    }
  }

  /**
   * Start Ollama service
   */
  async startService() {
    const config = await OllamaConfig.getConfig();
    this.syncApiUrl(config);

    try {
      console.log('Starting Ollama service...');
      this.addOperationLog('service', `Starting Ollama service (api: ${this.apiUrl})`);

      const status = await this.checkServiceStatus();
      if (status.running) {
        console.log('Ollama service is already running');
        const ownedProcess = await this.findOwnedOllamaProcess();
        if (!ownedProcess) {
          this.addOperationLog('service', 'Detected external Ollama process. Attempting to switch back to managed service.');
          const stopResult = await this.stopSystemService();
          if (!stopResult.success) {
            const processes = await this.listOllamaProcesses();
            const external = processes[0] || null;
            config.serviceStatus = 'running_external';
            config.servicePid = external?.pid || null;
            config.serviceOwner = external?.user || 'external';
            config.lastError = null;
            await config.save();
            this.addOperationLog(
              'service',
              `Could not stop external service (${stopResult.message}). Continuing to use externally managed Ollama.`
            );
            return {
              success: true,
              message: `Service already running externally (managed by ${config.serviceOwner})`
            };
          }

          const stopped = await this.waitForServiceStopped(8, 500);
          if (!stopped) {
            const processes = await this.listOllamaProcesses();
            const external = processes[0] || null;
            config.serviceStatus = 'running_external';
            config.servicePid = external?.pid || null;
            config.serviceOwner = external?.user || 'external';
            config.lastError = null;
            await config.save();
            this.addOperationLog(
              'service',
              `External service still running after stop attempt. Using externally managed Ollama (${config.serviceOwner}).`
            );
            return {
              success: true,
              message: `Service already running externally (managed by ${config.serviceOwner})`
            };
          }
        } else {
          config.serviceStatus = 'running';
          config.servicePid = ownedProcess.pid;
          config.serviceOwner = ownedProcess.user;
          config.lastError = null;
          await config.save();
          return { success: true, message: 'Service already running' };
        }
      }

      const childEnv = {
        ...process.env,
        OLLAMA_HOST: this.getOllamaHostForEnv()
      };

      const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
        env: childEnv
      });

      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', resolve);
      });

      const childPid = child.pid;
      config.servicePid = childPid;
      config.serviceOwner = this.getCurrentUser();
      config.serviceStatus = 'running';
      config.lastError = null;
      await config.save();

      child.unref();

      const started = await this.waitForServiceReady();
      if (!started) {
        await this.terminateManagedProcess(childPid);
        config.servicePid = null;
        config.serviceOwner = null;
        config.serviceStatus = 'error';
        await config.setError('Failed to start Ollama service within timeout.');
        throw new Error('Failed to start Ollama service');
      }

      console.log('Ollama service started successfully');
      this.addOperationLog('service', `Ollama service started (pid: ${childPid})`);
      return { success: true, message: 'Service started' };
    } catch (error) {
      console.error('Error starting Ollama service:', error);
      this.addOperationLog('service', `Failed to start Ollama service: ${error.message}`);
      config.servicePid = null;
      config.serviceOwner = null;
      config.serviceStatus = 'error';
      await config.setError(`Start service failed: ${error.message}`);
      await config.save();
      throw error;
    }
  }

  /**
   * Stop Ollama service
   */
  async stopService() {
    const config = await OllamaConfig.getConfig();
    this.syncApiUrl(config);

    try {
      console.log('Stopping Ollama service...');
      this.addOperationLog('service', `Stopping Ollama service (api: ${this.apiUrl})`);

      const candidates = [];
      const currentUser = this.getCurrentUser();
      const serviceOwner = config.serviceOwner || currentUser;
      const isExternalOwner = serviceOwner && serviceOwner !== currentUser;

      if (config.servicePid) {
        candidates.push({ pid: config.servicePid, managed: !isExternalOwner, owner: serviceOwner });
      } else {
        const ownedProcess = await this.findOwnedOllamaProcess();
        if (ownedProcess) {
          candidates.push({
            pid: ownedProcess.pid,
            managed: ownedProcess.user === currentUser,
            owner: ownedProcess.user
          });
        }
      }

      if (candidates.length === 0) {
        const processes = await this.listOllamaProcesses();
        if (processes.length) {
          const external = processes[0];
          const message = `Ollama service is managed by user "${external.user}". Attempting to stop via system service...`;
          console.warn(message);
          this.addOperationLog('service', message);
          const stopResult = await this.stopSystemService();
          if (!stopResult.success) {
            config.serviceStatus = 'running_external';
            config.servicePid = external.pid;
            config.serviceOwner = external.user;
            await config.setError(stopResult.message);
            await config.save();
            this.addOperationLog('service', `Unable to stop external service: ${stopResult.message}`);
            return { success: false, message: stopResult.message };
          }
          await this.delay(1000);
          return this.finalizeStoppedState(config, 'Service stopped via system service');
        }

        const status = await this.checkServiceStatus();
        if (status.running) {
          return this.finalizeStoppedState(config, 'Service stopped');
        }

        config.serviceStatus = 'stopped';
        config.servicePid = null;
        config.serviceOwner = null;
        config.lastError = null;
        await config.save();
        this.addOperationLog('service', 'Service was not running');
        return { success: true, message: 'Service was not running' };
      }

      for (const candidate of candidates) {
        if (!candidate.managed) {
          const stopResult = await this.stopSystemService();
          if (!stopResult.success) {
            config.serviceStatus = 'running_external';
            config.serviceOwner = candidate.owner || config.serviceOwner || 'external';
            await config.setError(stopResult.message);
            await config.save();
            this.addOperationLog('service', `Unable to stop external service: ${stopResult.message}`);
            return { success: false, message: stopResult.message };
          }
          await this.delay(1000);
          return this.finalizeStoppedState(config, 'Service stopped via system service');
        }

        const result = await this.terminateManagedProcess(candidate.pid);
        if (result.success) {
          console.log('Ollama service stopped');
          return this.finalizeStoppedState(config, 'Service stopped');
        }

        if (result.reason === 'permission') {
          console.warn('Unable to terminate managed process due to insufficient permissions. Escalating to privileged stop.');
          this.addOperationLog('service', 'Managed process stop required elevated privileges. Escalating.');
          break;
        }

        if (result.reason === 'still_running') {
          throw new Error('Failed to stop Ollama service: process still running after signals.');
        }
      }

      const pkillResult = await this.stopServiceWithPkill();
      if (pkillResult.success) {
        return this.finalizeStoppedState(config, pkillResult.message || 'Service stopped');
      }

      await config.setError(pkillResult.message || 'Failed to stop Ollama service');
      await config.save();
      return pkillResult;
    } catch (error) {
      console.error('Error stopping Ollama service:', error);
      this.addOperationLog('service', `Stop service failed: ${error.message}`);
      await config.setError(`Stop service failed: ${error.message}`);
      config.servicePid = null;
      config.serviceOwner = null;
      await config.save();
      throw error;
    }
  }

  async stopServiceWithPkill() {
    try {
      await execAsync('pkill -f "ollama serve"');
      console.log('Ollama service stopped using pkill');
      this.addOperationLog('service', 'Stopped Ollama with pkill');
      return { success: true, message: 'Service stopped' };
    } catch (error) {
      if (error.code === 1) {
        return { success: true, message: 'Service was not running' };
      }

      const errorOutput = `${error.stderr || ''}${error.stdout || ''}`.toLowerCase();

      if (errorOutput.includes('operation not permitted') || error.code === 126 || error.code === 127) {
        console.warn('Initial attempt to stop Ollama failed due to insufficient permissions. Trying sudo...');
        try {
          await execAsync('sudo -n pkill -f "ollama serve"');
          console.log('Ollama service stopped via sudo');
          this.addOperationLog('service', 'Stopped Ollama with sudo pkill');
          return { success: true, message: 'Service stopped with elevated privileges' };
        } catch (sudoError) {
          const sudoOutput = `${sudoError.stderr || ''}${sudoError.stdout || ''}`.toLowerCase();

          if (sudoError.code === 1 && sudoOutput.includes('no process found')) {
            return { success: true, message: 'Service was not running' };
          }

          if (sudoOutput.includes('command not found')) {
            const message = 'Unable to stop Ollama service: sudo command not available. Please stop the service manually or install sudo.';
            console.error(message);
            this.addOperationLog('service', message);
            throw new Error(message);
          }

          if (sudoOutput.includes('a password is required') || sudoOutput.includes('permission denied')) {
            const message = 'Insufficient privileges to stop the Ollama service. Please run "sudo pkill -f \\"ollama serve\\"" manually, add this service to sudoers, or stop the system-level Ollama service (e.g., "sudo systemctl stop ollama").';
            console.error(message);
            this.addOperationLog('service', message);
            throw new Error(message);
          }

          console.error('Error stopping Ollama service with sudo:', sudoError);
          throw sudoError;
        }
      }

      throw error;
    }
  }

  async waitForServiceReady(retries = 10, delayMs = 500) {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const status = await this.checkServiceStatus();
      if (status.running) {
        return true;
      }
      await this.delay(delayMs);
    }
    return false;
  }

  async waitForServiceStopped(retries = 12, delayMs = 500) {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const status = await this.checkServiceStatus();
      const processes = await this.listOllamaProcesses();
      if (!status.running && processes.length === 0) {
        return true;
      }
      await this.delay(delayMs);
    }
    return false;
  }

  async finalizeStoppedState(config, successMessage) {
    const stopped = await this.waitForServiceStopped();
    if (!stopped) {
      const processes = await this.listOllamaProcesses();
      const processInfo = processes[0] || null;
      const owner = processInfo?.user || config.serviceOwner || 'another user';
      const failureMessage =
        `Stop command completed but Ollama is still running as "${owner}". ` +
        'Stop the system service manually (for example, "sudo systemctl stop ollama") or grant HomeBrain permission to manage it.';

      config.serviceStatus = 'running_external';
      config.servicePid = processInfo?.pid || null;
      config.serviceOwner = owner;
      await config.setError(failureMessage);
      await config.save();
      this.addOperationLog('service', failureMessage);
      return { success: false, message: failureMessage };
    }

    config.servicePid = null;
    config.serviceOwner = null;
    config.serviceStatus = 'stopped';
    config.lastError = null;
    await config.save();
    this.addOperationLog('service', successMessage);
    return { success: true, message: successMessage };
  }

  async findOwnedOllamaProcess() {
    const processes = await this.listOllamaProcesses();
    if (!processes.length) {
      return null;
    }
    const currentUser = this.getCurrentUser();
    return processes.find(proc => proc.user === currentUser) || null;
  }

  async listOllamaProcesses() {
    try {
      const { stdout } = await execAsync('ps -eo pid=,user=,command= | grep "ollama serve" | grep -v grep');
      const lines = stdout.split('\n').map(line => line.trim()).filter(Boolean);
      return lines.map((line) => {
        const match = line.match(/^(\d+)\s+(\S+)\s+(.*)$/);
        if (!match) {
          return null;
        }
        return {
          pid: Number(match[1]),
          user: match[2],
          command: match[3]
        };
      }).filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  getCurrentUser() {
    try {
      return os.userInfo().username;
    } catch (error) {
      return process.env.SUDO_USER || process.env.USER || process.env.LOGNAME || 'unknown';
    }
  }

  async terminateManagedProcess(pid) {
    if (!pid) {
      return { success: true };
    }

    const sendSignal = (signal) => {
      try {
        process.kill(-pid, signal);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') {
          return false;
        }
        if (error.code === 'EPERM') {
          return 'permission';
        }
        try {
          process.kill(pid, signal);
          return true;
        } catch (innerError) {
          if (innerError.code === 'ESRCH') {
            return false;
          }
          if (innerError.code === 'EPERM') {
            return 'permission';
          }
          throw innerError;
        }
      }
    };

    const termResult = sendSignal('SIGTERM');
    if (termResult === 'permission') {
      return { success: false, reason: 'permission' };
    }
    if (termResult === false) {
      return { success: true };
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!this.isProcessRunning(pid)) {
        return { success: true };
      }
      await this.delay(300);
    }

    const killResult = sendSignal('SIGKILL');
    if (killResult === 'permission') {
      return { success: false, reason: 'permission' };
    }
    if (killResult === false) {
      return { success: true };
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!this.isProcessRunning(pid)) {
        return { success: true };
      }
      await this.delay(300);
    }

    return { success: false, reason: 'still_running' };
  }

  isProcessRunning(pid) {
    if (!pid) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'EPERM') {
        return true;
      }
      return false;
    }
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async stopSystemService() {
    const commands = [];
    const currentUser = this.getCurrentUser();

    if (currentUser === 'root') {
      commands.push('systemctl stop ollama');
      commands.push('service ollama stop');
      if (process.platform === 'darwin') {
        commands.push('launchctl stop com.ollama.ollama');
      }
    }

    commands.push('sudo -n systemctl stop ollama');
    commands.push('sudo -n service ollama stop');
    if (process.platform === 'darwin') {
      commands.push('sudo -n launchctl stop com.ollama.ollama');
    }
    commands.push('sudo -n pkill -f "ollama serve"');

    let lastError = null;

    for (const command of commands) {
      try {
        await execAsync(command);
        console.log(`Executed command: ${command}`);
        this.addOperationLog('service', `Executed stop command: ${command}`);
        return { success: true, message: `Service stopped using "${command}"` };
      } catch (error) {
        lastError = error;
        const output = `${error.stderr || ''}${error.stdout || ''}`.toLowerCase();

        if (error.code === 1 && output.includes('no process')) {
          return { success: true, message: 'Service was not running' };
        }
        if (output.includes('password') || output.includes('permission denied')) {
          this.addOperationLog('service', `Permission denied while executing "${command}"`);
          return {
            success: false,
            message:
              'Insufficient privileges to stop the Ollama service. Grant HomeBrain sudo access or stop it manually (e.g., "sudo systemctl stop ollama").'
          };
        }
        if (output.includes('command not found')) {
          continue;
        }

        this.addOperationLog(
          'service',
          `Stop command failed (${command}): ${(error && error.message) || 'Unknown error'}`
        );
      }
    }

    if (lastError) {
      return { success: false, message: lastError.message || 'Failed to stop system service' };
    }

    return { success: false, message: 'Unable to stop system service' };
  }

  /**
   * Check for Ollama updates
   */
  async checkForUpdates() {
    try {
      console.log('Checking for Ollama updates...');

      const config = await OllamaConfig.getConfig();
      this.syncApiUrl(config);
      this.addOperationLog('update', 'Checking for Ollama updates');

      // Get current version
      const installStatus = await this.checkInstallation();
      if (!installStatus.isInstalled) {
        config.updateAvailable = false;
        config.latestVersion = null;
        config.lastUpdateCheck = new Date();
        await config.save();
        return { updateAvailable: false, currentVersion: null, latestVersion: null };
      }

      // Get latest version from GitHub API
      try {
        const response = await axios.get('https://api.github.com/repos/ollama/ollama/releases/latest', {
          timeout: 10000
        });

        const latestVersion = normalizeVersionString(response.data.tag_name) || response.data.tag_name;
        const currentVersion = normalizeVersionString(installStatus.version) || installStatus.version;
        const updateAvailable = this.isUpdateAvailable(currentVersion, latestVersion);

        // Update config
        config.updateAvailable = updateAvailable;
        config.latestVersion = latestVersion;
        config.lastUpdateCheck = new Date();
        await config.save();
        this.addOperationLog(
          'update',
          `Update check result - current: ${currentVersion}, latest: ${latestVersion}, available: ${updateAvailable}`
        );

        console.log(`Update check complete. Current: ${currentVersion}, Latest: ${latestVersion}, Update available: ${updateAvailable}`);

        return {
          updateAvailable,
          currentVersion,
          latestVersion
        };
      } catch (error) {
        console.error('Error fetching latest version from GitHub:', error);
        config.updateAvailable = false;
        config.latestVersion = config.latestVersion || 'unknown';
        config.lastUpdateCheck = new Date();
        await config.save();
        this.addOperationLog('update', `Update check failed: ${error.message}`);
        return {
          updateAvailable: false,
          currentVersion: normalizeVersionString(installStatus.version) || installStatus.version,
          latestVersion: 'unknown',
          error: 'Could not check for updates'
        };
      }
    } catch (error) {
      console.error('Error checking for updates:', error);
      throw error;
    }
  }

  /**
   * Update Ollama to latest version
   */
  async update({ sudoPassword = null } = {}) {
    let serviceWasRunning = false;
    let serviceStoppedForUpdate = false;

    try {
      console.log('Starting Ollama update...');

      const config = await OllamaConfig.getConfig();
      this.syncApiUrl(config);
      this.addOperationLog('update', 'Starting Ollama update');
      config.serviceStatus = 'installing';
      await config.save();

      const preUpdateStatus = await this.checkInstallation();
      const previousVersion = normalizeVersionString(preUpdateStatus.version) || preUpdateStatus.version;

      const {
        currentUser,
        isRoot,
        hasSudoBinary,
        hasPasswordlessSudo
      } = await this.detectPrivilegeContext();
      const hasSudoPassword = !isRoot
        && hasSudoBinary
        && typeof sudoPassword === 'string'
        && sudoPassword.length > 0;

      // If we're not root and don't have working sudo, update cannot proceed
      if (!isRoot && (!hasSudoBinary || (!hasPasswordlessSudo && !hasSudoPassword))) {
        const errorMessage = hasSudoBinary
          ? `Ollama update requires sudo privileges. This service is running as "${currentUser}" and cannot use sudo non-interactively. Re-run update and provide your sudo password, or configure passwordless sudo for this service user.`
          : `Ollama update requires root privileges. This system is running as user "${currentUser}" and sudo is not available. Please contact your system administrator for assistance.`;
        console.error(errorMessage);

        const config = await OllamaConfig.getConfig();
        config.serviceStatus = 'error';
        await config.setError(errorMessage);
        this.addOperationLog('update', errorMessage);

        throw new Error(errorMessage);
      }

      const currentServiceStatus = await this.checkServiceStatus();
      const runningProcesses = await this.listOllamaProcesses();
      serviceWasRunning = Boolean(currentServiceStatus.running || runningProcesses.length);

      if (serviceWasRunning) {
        this.addOperationLog('update', 'Stopping Ollama service before updating');
        try {
          const stopResult = await this.stopService();
          if (!stopResult.success) {
            this.addOperationLog(
              'update',
              `Pre-update stop did not fully succeed: ${stopResult.message}. Continuing update anyway.`
            );
          } else {
            serviceStoppedForUpdate = true;
          }
        } catch (stopError) {
          this.addOperationLog(
            'update',
            `Pre-update stop failed (${stopError.message}). Continuing update anyway.`
          );
        }
      }

      // Prepare update command
      const updateScriptCommand = 'curl -fsSL https://ollama.com/install.sh | sh';
      let commandResult;
      if (isRoot) {
        console.log('Running Ollama update script as root...');
        this.addOperationLog('update', 'Running update command (root)');
        commandResult = await execAsync(updateScriptCommand, {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 300000
        });
      } else if (hasPasswordlessSudo) {
        console.log('Running Ollama update script with passwordless sudo...');
        this.addOperationLog('update', 'Running update command (passwordless sudo)');
        commandResult = await execAsync('curl -fsSL https://ollama.com/install.sh | sudo sh', {
          maxBuffer: 10 * 1024 * 1024,
          timeout: 300000
        });
      } else {
        console.log('Running Ollama update script with provided sudo password...');
        this.addOperationLog('update', 'Running update command (sudo password provided)');
        commandResult = await this.runSudoShellCommandWithPassword(
          updateScriptCommand,
          sudoPassword,
          'update',
          300000
        );
      }

      const { stdout, stderr } = commandResult;

      this.addCommandOutputToOperationLogs('update', stdout, 'stdout');
      this.addCommandOutputToOperationLogs('update', stderr, 'stderr');
      console.log('Ollama update output:', stdout);
      if (stderr) {
        console.log('Ollama update stderr:', stderr);
      }

      // Verify update
      const installStatus = await this.checkInstallation();
      if (!installStatus.isInstalled) {
        throw new Error('Ollama update failed - binary not found after update');
      }

      const installedVersion = normalizeVersionString(installStatus.version) || installStatus.version;
      const comparisonWithPrevious = compareVersionStrings(installedVersion, previousVersion);
      if (comparisonWithPrevious !== null && comparisonWithPrevious < 0) {
        throw new Error(
          `Installed version ${installStatus.version} is older than pre-update version ${preUpdateStatus.version}`
        );
      }

      if (serviceWasRunning && serviceStoppedForUpdate) {
        this.addOperationLog('update', 'Restarting Ollama service after update');
        await this.startService();
        serviceStoppedForUpdate = false;
      } else if (serviceWasRunning) {
        const postUpdateServiceStatus = await this.checkServiceStatus();
        if (!postUpdateServiceStatus.running) {
          this.addOperationLog('update', 'Service not detected after update. Attempting to start.');
          await this.startService();
        } else {
          this.addOperationLog('update', 'Service remained running through update.');
        }
      }

      await config.updateInstallation(installStatus.version, true);

      const updateCheck = await this.checkForUpdates();
      const latestVersion = normalizeVersionString(updateCheck.latestVersion) || updateCheck.latestVersion;
      const comparisonWithLatest = compareVersionStrings(installedVersion, latestVersion);

      if (comparisonWithLatest !== null && comparisonWithLatest < 0) {
        throw new Error(
          `Update script completed but installed version ${installStatus.version} is still behind latest ${updateCheck.latestVersion}`
        );
      }

      config.updateAvailable = Boolean(updateCheck.updateAvailable);
      config.latestVersion = updateCheck.latestVersion || config.latestVersion;
      config.lastUpdateCheck = new Date();
      config.lastError = null;
      await config.save();
      this.addOperationLog('update', `Ollama update completed successfully at version ${installStatus.version}`);

      console.log('Ollama update completed successfully');
      return {
        success: true,
        version: installStatus.version,
        updateAvailable: config.updateAvailable,
        latestVersion: config.latestVersion
      };
    } catch (error) {
      console.error('Error updating Ollama:', error);
      this.addOperationLog('update', `Update failed: ${error.message}`);

      if (serviceStoppedForUpdate) {
        try {
          await this.startService();
          this.addOperationLog('update', 'Service restarted after update failure');
        } catch (restartError) {
          this.addOperationLog('update', `Failed to restart service after update error: ${restartError.message}`);
        }
      }

      const config = await OllamaConfig.getConfig();
      config.serviceStatus = 'error';
      await config.setError(`Update failed: ${error.message}`);

      throw error;
    }
  }

  /**
   * List installed models
   */
  async listModels() {
    try {
      console.log('Fetching installed Ollama models...');
      const config = await OllamaConfig.getConfig();
      this.syncApiUrl(config);
      let serviceModels = [];
      let serviceError = null;

      try {
        serviceModels = await this.fetchModelsFromApi();
        this.addOperationLog(
          'model',
          `Service reported ${serviceModels.length} model${serviceModels.length === 1 ? '' : 's'}`
        );
      } catch (error) {
        serviceError = error;
        this.addOperationLog('model', `Service model query failed: ${error.message}`);
      }

      const filesystemModels = await this.discoverFilesystemModels();
      if (filesystemModels.length) {
        this.addOperationLog(
          'model',
          `Filesystem scan discovered ${filesystemModels.length} model${filesystemModels.length === 1 ? '' : 's'}`
        );
      }

      const cliModels = await this.fetchModelsFromCli();
      if (cliModels.length) {
        this.addOperationLog(
          'model',
          `CLI list discovered ${cliModels.length} model${cliModels.length === 1 ? '' : 's'}`
        );
      }

      const discoveredModels = [...filesystemModels, ...cliModels];
      const mergedModels = this.mergeServiceAndFilesystemModels(serviceModels, discoveredModels);
      console.log(`Found ${mergedModels.length} installed model entries`);

      // Update config
      await config.updateModels(mergedModels);

      if (!mergedModels.length && serviceError?.code === 'ECONNREFUSED') {
        throw new Error('Ollama service is not running');
      }

      return mergedModels;
    } catch (error) {
      console.error('Error listing Ollama models:', error);
      if (error.code === 'ECONNREFUSED') {
        throw new Error('Ollama service is not running');
      }
      throw error;
    }
  }

  /**
   * Pull/download a model
   */
  async pullModel(modelName) {
    try {
      console.log(`Starting download of model: ${modelName}`);
      this.addOperationLog('model', `Starting model pull for ${modelName}`);

      const config = await OllamaConfig.getConfig();
      this.syncApiUrl(config);

      let modelBefore = null;
      try {
        const beforeModels = await this.listModels();
        modelBefore = beforeModels.find((model) => model.name === modelName) || null;
      } catch (beforeError) {
        this.addOperationLog('model', `Pre-pull model state unavailable: ${beforeError.message}`);
      }

      const serviceStatus = await this.checkServiceStatus();
      if (!serviceStatus.running) {
        this.addOperationLog('model', 'Ollama service is not running. Attempting to start before model pull.');
        await this.startService();
      }

      let usedCliFallback = false;
      let statusMessage = 'Pull completed';

      try {
        const response = await axios.post(
          `${this.apiUrl}/api/pull`,
          {
            model: modelName,
            stream: false
          },
          {
            timeout: 3600000 // 60 minutes timeout for large models
          }
        );

        statusMessage = response.data?.status || statusMessage;
      } catch (apiError) {
        const apiDetail =
          apiError?.response?.data?.error ||
          apiError?.response?.data?.message ||
          apiError.message;

        const shouldFallbackToCli =
          apiError?.response?.status === 404 ||
          apiError?.response?.status === 405 ||
          /unknown field|not found|unsupported/i.test(String(apiDetail || ''));

        if (!shouldFallbackToCli) {
          throw apiError;
        }

        usedCliFallback = true;
        this.addOperationLog(
          'model',
          `Ollama API pull unavailable (${apiDetail}). Falling back to CLI pull.`
        );
        await this.pullModelWithCli(modelName);
        statusMessage = 'Pull completed via CLI fallback';
      }

      this.addOperationLog('model', `${modelName}: ${statusMessage}`);
      console.log(`Model ${modelName} downloaded successfully`);
      if (usedCliFallback) {
        console.log(`Model ${modelName} was pulled using CLI fallback`);
      }

      // Refresh model list
      const refreshedModels = await this.listModels();
      const modelAfter = refreshedModels.find((model) => model.name === modelName) || null;

      const beforeDigest = modelBefore?.digest || null;
      const afterDigest = modelAfter?.digest || null;
      const beforeModified = modelBefore?.modifiedAt ? new Date(modelBefore.modifiedAt).getTime() : 0;
      const afterModified = modelAfter?.modifiedAt ? new Date(modelAfter.modifiedAt).getTime() : 0;

      const modelChanged = !modelBefore ||
        !modelAfter ||
        (beforeDigest && afterDigest && beforeDigest !== afterDigest) ||
        (afterModified > beforeModified);

      const message = !modelBefore
        ? `Model ${modelName} downloaded successfully`
        : modelChanged
          ? `Model ${modelName} refreshed successfully`
          : `Model ${modelName} is already up to date`;

      this.addOperationLog('model', message);

      return {
        success: true,
        message,
        modelUpdated: modelChanged,
        wasInstalled: Boolean(modelBefore)
      };
    } catch (error) {
      console.error(`Error pulling model ${modelName}:`, error);
      const detail =
        error?.response?.data?.error ||
        error?.response?.data?.message ||
        error.message;
      this.addOperationLog('model', `Failed to pull ${modelName}: ${detail}`);

      if (error?.response?.data?.error) {
        throw new Error(`Failed to download model: ${error.response.data.error}`);
      }

      throw new Error(`Failed to download model: ${error.message}`);
    }
  }

  /**
   * Delete a model
   */
  async deleteModel(modelName) {
    try {
      console.log(`Deleting model: ${modelName}`);

      const deleteCommand = `ollama rm ${modelName}`;
      await execAsync(deleteCommand, { timeout: 30000 });

      console.log(`Model ${modelName} deleted successfully`);

      // Refresh model list
      const config = await OllamaConfig.getConfig();
      await this.listModels();

      // If deleted model was active, clear active model
      if (config.activeModel === modelName) {
        config.activeModel = null;
        await config.save();
      }

      try {
        const settings = await Settings.getSettings();
        let settingsUpdated = false;

        if (settings.localLlmModel === modelName) {
          settings.localLlmModel = '';
          settingsUpdated = true;
        }

        if (settings.homebrainLocalLlmModel === modelName) {
          settings.homebrainLocalLlmModel = '';
          settingsUpdated = true;
        }

        if (settings.spamFilterLocalLlmModel === modelName) {
          settings.spamFilterLocalLlmModel = '';
          settingsUpdated = true;
        }

        if (settingsUpdated) {
          await settings.save();
        }
      } catch (settingsError) {
        console.warn(`OllamaService: Failed to clear deleted-model role assignments for ${modelName}: ${settingsError.message}`);
      }

      return { success: true, message: `Model ${modelName} deleted successfully` };
    } catch (error) {
      console.error(`Error deleting model ${modelName}:`, error);
      throw new Error(`Failed to delete model: ${error.message}`);
    }
  }

  /**
   * Set active model
   */
  async setActiveModel(modelName) {
    try {
      console.log(`Setting active model to: ${modelName}`);

      const config = await OllamaConfig.getConfig();
      await config.setActiveModel(modelName);

      // Preserve explicit HomeBrain/spam model role assignments. Activation only changes the Ollama default.
      try {
        const settings = await Settings.getSettings();
        settings.localLlmModel = modelName;
        await settings.save();
      } catch (settingsError) {
        console.warn(`OllamaService: Failed to sync Settings.localLlmModel to ${modelName}: ${settingsError.message}`);
      }

      console.log(`Active model set to ${modelName}`);
      return { success: true, activeModel: modelName };
    } catch (error) {
      console.error(`Error setting active model:`, error);
      throw error;
    }
  }

  /**
   * Chat with model
   */
  async chat(modelName, messages, stream = false) {
    try {
      console.log(`Sending chat request to model: ${modelName}`);

      const config = await OllamaConfig.getConfig();
      this.syncApiUrl(config);

      const requestBody = {
        model: modelName,
        messages: messages,
        stream: stream
      };

      const response = await axios.post(
        `${this.apiUrl}/api/chat`,
        requestBody,
        {
          timeout: 120000, // 2 minutes
          responseType: stream ? 'stream' : 'json'
        }
      );

      if (stream) {
        return response.data; // Return stream
      }

      const assistantMessage = response.data.message.content;

      // Save to chat history
      await config.addChatMessage('assistant', assistantMessage, modelName);

      console.log(`Chat response received from ${modelName}`);

      return {
        message: assistantMessage,
        model: modelName,
        done: response.data.done,
        totalDuration: response.data.total_duration,
        loadDuration: response.data.load_duration,
        promptEvalDuration: response.data.prompt_eval_duration,
        evalDuration: response.data.eval_duration,
      };
    } catch (error) {
      console.error(`Error during chat with ${modelName}:`, error);
      if (error.response?.data) {
        throw new Error(`Chat failed: ${error.response.data.error || error.message}`);
      }
      throw new Error(`Chat failed: ${error.message}`);
    }
  }

  /**
   * Generate text completion (non-chat)
   */
  async generate(modelName, prompt) {
    try {
      console.log(`Generating text with model: ${modelName}`);
      const config = await OllamaConfig.getConfig();
      this.syncApiUrl(config);

      const response = await axios.post(
        `${this.apiUrl}/api/generate`,
        {
          model: modelName,
          prompt: prompt,
          stream: false
        },
        { timeout: 120000 }
      );

      console.log(`Generation complete for ${modelName}`);

      return {
        response: response.data.response,
        model: modelName,
        done: response.data.done,
        totalDuration: response.data.total_duration
      };
    } catch (error) {
      console.error(`Error during generation with ${modelName}:`, error);
      throw new Error(`Generation failed: ${error.message}`);
    }
  }

  /**
   * Get chat history
   */
  async getChatHistory(limit = 100) {
    try {
      const config = await OllamaConfig.getConfig();

      // Get last N messages
      const history = config.chatHistory.slice(-limit);

      return history;
    } catch (error) {
      console.error('Error getting chat history:', error);
      throw error;
    }
  }

  /**
   * Clear chat history
   */
  async clearChatHistory() {
    try {
      console.log('Clearing chat history...');

      const config = await OllamaConfig.getConfig();
      config.chatHistory = [];
      await config.save();

      console.log('Chat history cleared');
      return { success: true, message: 'Chat history cleared' };
    } catch (error) {
      console.error('Error clearing chat history:', error);
      throw error;
    }
  }

  /**
   * Get full status
   */
  async getStatus() {
    try {
      console.log('Getting Ollama full status...');

      const config = await OllamaConfig.getConfig();
      this.syncApiUrl(config);
      console.log('Got config from database');

      const installStatus = await Promise.race([
        this.checkInstallation(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Installation check timeout')), 10000))
      ]).catch(error => {
        console.error('Installation check failed:', error.message);
        return { isInstalled: false, version: null };
      });
      console.log('Installation status checked:', installStatus);

      const serviceStatus = await Promise.race([
        this.checkServiceStatus(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Service check timeout')), 5000))
      ]).catch(error => {
        console.error('Service check failed:', error.message);
        return { running: false, error: error.message };
      });
      console.log('Service status checked:', serviceStatus);

      let serviceRunning = false;
      let externalProcess = null;

      if (config.servicePid && this.isProcessRunning(config.servicePid)) {
        serviceRunning = true;
      } else if (serviceStatus.running) {
        const ownedProcess = await this.findOwnedOllamaProcess();
        if (ownedProcess) {
          serviceRunning = true;
          config.servicePid = ownedProcess.pid;
          config.serviceOwner = ownedProcess.user;
        } else {
          const processes = await this.listOllamaProcesses();
          if (processes.length) {
            externalProcess = processes[0];
            config.servicePid = externalProcess.pid;
            config.serviceOwner = externalProcess.user;
            serviceRunning = true;
          }
        }
      } else {
        config.servicePid = null;
        config.serviceOwner = null;
      }

      // Update config with current status
      if (serviceRunning && externalProcess) {
        config.serviceStatus = 'running_external';
      } else if (serviceRunning) {
        config.serviceStatus = 'running';
      } else if (installStatus.isInstalled) {
        config.serviceStatus = 'stopped';
      } else {
        config.serviceStatus = 'not_installed';
      }

      if (installStatus.isInstalled) {
        const currentVersion = normalizeVersionString(installStatus.version) || installStatus.version;
        const latestVersion = normalizeVersionString(config.latestVersion) || config.latestVersion;
        const comparison = compareVersionStrings(currentVersion, latestVersion);
        if (comparison !== null && comparison >= 0 && config.updateAvailable) {
          config.updateAvailable = false;
        }
      }

      await config.save();

      const settings = await Settings.getSettings();

      return {
        isInstalled: installStatus.isInstalled,
        version: installStatus.version,
        serviceRunning,
        serviceStatus: config.serviceStatus,
        serviceOwner: config.serviceOwner,
        installedModels: config.installedModels,
        activeModel: config.activeModel,
        homebrainLocalLlmModel: settings.homebrainLocalLlmModel || settings.localLlmModel || null,
        spamFilterLocalLlmModel: settings.spamFilterLocalLlmModel || settings.homebrainLocalLlmModel || settings.localLlmModel || null,
        configuration: config.configuration,
        updateAvailable: config.updateAvailable,
        latestVersion: config.latestVersion,
        lastUpdateCheck: config.lastUpdateCheck,
        statistics: config.statistics,
        lastError: config.lastError
      };
    } catch (error) {
      console.error('Error getting Ollama status:', error);
      throw error;
    }
  }

  /**
   * Get available models to download
   */
  getFallbackAvailableModels() {
    return [
      { name: 'llama3.2:latest', description: 'Meta Llama 3.2 - Latest version', size: '3b', parameterSize: '3b', parameterSizes: ['3b'], capabilities: [], nanoFit: true, smallestParameterB: 3 },
      { name: 'llama3.2:1b', description: 'Meta Llama 3.2 1B', size: '1b', parameterSize: '1b', parameterSizes: ['1b'], capabilities: [], nanoFit: true, smallestParameterB: 1 },
      { name: 'qwen2.5:latest', description: 'Qwen 2.5 - Latest', size: '7b', parameterSize: '7b', parameterSizes: ['7b'], capabilities: [], nanoFit: true, smallestParameterB: 7 },
      { name: 'phi4-mini:latest', description: 'Microsoft Phi-4 Mini', size: '3.8b', parameterSize: '3.8b', parameterSizes: ['3.8b'], capabilities: ['tools'], nanoFit: true, smallestParameterB: 3.8 },
      { name: 'mistral:latest', description: 'Mistral 7B - Latest version', size: '7b', parameterSize: '7b', parameterSizes: ['7b'], capabilities: [], nanoFit: true, smallestParameterB: 7 },
      { name: 'codellama:latest', description: 'Code Llama for coding', size: '7b', parameterSize: '7b', parameterSizes: ['7b'], capabilities: [], nanoFit: true, smallestParameterB: 7 },
      { name: 'gemma2:2b', description: 'Google Gemma 2 2B', size: '2b', parameterSize: '2b', parameterSizes: ['2b'], capabilities: [], nanoFit: true, smallestParameterB: 2 },
      { name: 'phi3:latest', description: 'Microsoft Phi-3', size: '3.8b', parameterSize: '3.8b', parameterSizes: ['3.8b'], capabilities: [], nanoFit: true, smallestParameterB: 3.8 },
      { name: 'llama3.1:8b', description: 'Meta Llama 3.1 8B', size: '8b', parameterSize: '8b', parameterSizes: ['8b'], capabilities: [], nanoFit: true, smallestParameterB: 8 },
      { name: 'gemma2:9b', description: 'Google Gemma 2 9B', size: '9b', parameterSize: '9b', parameterSizes: ['9b'], capabilities: [], nanoFit: false, smallestParameterB: 9 },
      { name: 'deepseek-coder:latest', description: 'DeepSeek Coder', size: '6.7b', parameterSize: '6.7b', parameterSizes: ['6.7b'], capabilities: [], nanoFit: true, smallestParameterB: 6.7 },
      { name: 'mixtral:latest', description: 'Mixtral 8x7B MoE', size: '8x7b', parameterSize: '8x7b', parameterSizes: ['8x7b'], capabilities: [], nanoFit: false, smallestParameterB: 56 },
      { name: 'llama3.1:70b', description: 'Meta Llama 3.1 70B', size: '70b', parameterSize: '70b', parameterSizes: ['70b'], capabilities: [], nanoFit: false, smallestParameterB: 70 },
    ];
  }

  buildAvailableModelsCacheKey({ query = '', capabilities = [], sort = 'popular', maxPages = OLLAMA_SEARCH_MAX_PAGES }) {
    return JSON.stringify({
      query: query.trim().toLowerCase(),
      capabilities: [...new Set(capabilities.map((item) => String(item).trim().toLowerCase()).filter(Boolean))].sort(),
      sort: sort === 'newest' ? 'newest' : 'popular',
      maxPages
    });
  }

  async fetchAvailableModelsFromOllamaSearch({ query = '', capabilities = [], sort = 'popular', maxPages = OLLAMA_SEARCH_MAX_PAGES }) {
    const modelMap = new Map();
    let page = 1;
    let pagesFetched = 0;

    while (pagesFetched < maxPages) {
      const params = new URLSearchParams();
      if (query) {
        params.set('q', query);
      }
      if (page > 1) {
        params.set('page', String(page));
      }
      if (sort === 'newest') {
        params.set('o', 'newest');
      }
      for (const capability of capabilities) {
        params.append('c', capability);
      }

      const url = `${OLLAMA_LIBRARY_BASE_URL}/search${params.toString() ? `?${params.toString()}` : ''}`;
      const response = await axios.get(url, {
        timeout: OLLAMA_SEARCH_TIMEOUT_MS,
        responseType: 'text',
        headers: {
          'HX-Request': 'true',
          Accept: 'text/html',
          'User-Agent': 'HomeBrain-OllamaCatalog/1.0'
        }
      });

      const { models, nextPage } = parseOllamaSearchResponse(response.data || '');
      for (const model of models) {
        const existing = modelMap.get(model.name);
        if (!existing) {
          modelMap.set(model.name, model);
          continue;
        }

        const mergedSizes = [...new Set([...(existing.parameterSizes || []), ...(model.parameterSizes || [])])];
        const mergedCapabilities = [...new Set([...(existing.capabilities || []), ...(model.capabilities || [])])];
        const existingSmallest = Number.isFinite(existing.smallestParameterB) ? existing.smallestParameterB : null;
        const modelSmallest = Number.isFinite(model.smallestParameterB) ? model.smallestParameterB : null;
        const smallestParameterB = existingSmallest === null
          ? modelSmallest
          : modelSmallest === null
            ? existingSmallest
            : Math.min(existingSmallest, modelSmallest);

        modelMap.set(model.name, {
          ...existing,
          ...model,
          parameterSizes: mergedSizes,
          parameterSize: mergedSizes.join(', '),
          capabilities: mergedCapabilities,
          smallestParameterB,
          nanoFit: Number.isFinite(smallestParameterB) ? smallestParameterB <= 8 : false,
          pullCountValue: Number.isFinite(existing.pullCountValue) && Number.isFinite(model.pullCountValue)
            ? Math.max(existing.pullCountValue, model.pullCountValue)
            : (Number.isFinite(existing.pullCountValue) ? existing.pullCountValue : model.pullCountValue),
          tagCountValue: Number.isFinite(existing.tagCountValue) && Number.isFinite(model.tagCountValue)
            ? Math.max(existing.tagCountValue, model.tagCountValue)
            : (Number.isFinite(existing.tagCountValue) ? existing.tagCountValue : model.tagCountValue),
          updatedDaysAgo: Number.isFinite(existing.updatedDaysAgo) && Number.isFinite(model.updatedDaysAgo)
            ? Math.min(existing.updatedDaysAgo, model.updatedDaysAgo)
            : (Number.isFinite(existing.updatedDaysAgo) ? existing.updatedDaysAgo : model.updatedDaysAgo),
          size: mergedSizes.join(', ')
        });
      }

      pagesFetched += 1;
      if (!nextPage || nextPage <= page) {
        break;
      }
      page = nextPage;
    }

    return Array.from(modelMap.values());
  }

  async getAvailableModels(options = {}) {
    const query = typeof options.query === 'string' ? options.query.trim() : '';
    const sort = options.sort === 'newest' ? 'newest' : 'popular';
    const maxPagesRaw = Number.parseInt(String(options.maxPages || ''), 10);
    const maxPages = Number.isFinite(maxPagesRaw)
      ? Math.min(Math.max(maxPagesRaw, 1), OLLAMA_SEARCH_MAX_PAGES)
      : OLLAMA_SEARCH_MAX_PAGES;
    const capabilities = Array.isArray(options.capabilities)
      ? options.capabilities
        .map((item) => String(item).trim().toLowerCase())
        .filter((item) => OLLAMA_CAPABILITY_ALLOWLIST.has(item))
      : [];

    const cacheKey = this.buildAvailableModelsCacheKey({
      query,
      capabilities,
      sort,
      maxPages
    });
    const cached = this.availableModelsCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < OLLAMA_SEARCH_CACHE_TTL_MS) {
      return cached.models;
    }

    try {
      const models = await this.fetchAvailableModelsFromOllamaSearch({
        query,
        capabilities,
        sort,
        maxPages
      });

      const finalModels = models.length ? models : this.getFallbackAvailableModels();
      this.availableModelsCache.set(cacheKey, {
        timestamp: Date.now(),
        models: finalModels
      });
      return finalModels;
    } catch (error) {
      this.addOperationLog('model', `Falling back to static model list: ${error.message}`);
      return this.getFallbackAvailableModels();
    }
  }

  /**
   * Retrieve Ollama service logs for diagnostics
   */
  async getServiceLogs(options = {}) {
    const rawLines = typeof options.lines === 'number' ? options.lines : parseInt(options.lines, 10);
    const maxLines = Number.isFinite(rawLines)
      ? Math.min(Math.max(rawLines, 20), MAX_LOG_LINES)
      : DEFAULT_LOG_LINES;

    const logAttempts = [];
    const operationLines = this.getOperationLogLines(maxLines);

    const combineWithOperationLogs = (payload) => {
      if (!operationLines.length) {
        return payload;
      }

      const baseLines = Array.isArray(payload.lines) ? payload.lines : [];
      const combinedLines = [...baseLines, ...operationLines].slice(-maxLines);

      return {
        ...payload,
        source: payload.source ? `${payload.source} + homebrain:operations` : 'homebrain:operations',
        sourceType: payload.sourceType ? `${payload.sourceType}+operation` : 'operation',
        lines: combinedLines,
        lineCount: combinedLines.length,
        truncated: payload.truncated || combinedLines.length >= maxLines
      };
    };

    if (await commandExists('journalctl')) {
      const units = ['ollama', 'ollama.service'];
      for (const unit of units) {
        try {
          const { stdout } = await execAsync(`journalctl -u ${unit} --no-pager -n ${maxLines}`, {
            timeout: 7000,
            maxBuffer: MAX_LOG_BYTES * 4
          });
          const lines = (stdout || '')
            .split(LOG_LINE_SPLIT_REGEX)
            .map(line => line.trimEnd())
            .filter(line => line.length > 0);

          if (lines.length) {
            return combineWithOperationLogs({
              source: `journalctl:${unit}`,
              sourceType: 'journalctl',
              lines: lines.slice(-maxLines),
              lineCount: Math.min(lines.length, maxLines),
              truncated: lines.length >= maxLines
            });
          }

          logAttempts.push({ type: 'journalctl', target: unit, message: 'No output' });
        } catch (error) {
          logAttempts.push({
            type: 'journalctl',
            target: unit,
            error: error.message || 'Unknown error'
          });
        }
      }
    } else {
      logAttempts.push({ type: 'journalctl', target: 'command', error: 'journalctl not available' });
    }

    const candidateFiles = buildLogCandidatePaths();
    for (const filePath of candidateFiles) {
      try {
        if (!(await isReadableFile(filePath))) {
          logAttempts.push({ type: 'file', target: filePath, error: 'unreadable' });
          continue;
        }

        const lines = await readLastLines(filePath, maxLines);
        if (lines.length) {
          return combineWithOperationLogs({
            source: filePath,
            sourceType: 'file',
            lines,
            lineCount: lines.length,
            truncated: lines.length >= maxLines
          });
        }

        logAttempts.push({ type: 'file', target: filePath, message: 'No content' });
      } catch (error) {
        logAttempts.push({
          type: 'file',
          target: filePath,
          error: error.message || 'Unknown error'
        });
      }
    }

    console.warn('OllamaService: No service logs available', logAttempts);

    if (operationLines.length) {
      return {
        source: 'homebrain:operations',
        sourceType: 'operation',
        lines: operationLines,
        lineCount: operationLines.length,
        truncated: operationLines.length >= maxLines,
        message: 'Showing HomeBrain operation logs (service logs unavailable).'
      };
    }

    return {
      source: null,
      sourceType: null,
      lines: [],
      lineCount: 0,
      truncated: false,
      message: 'No Ollama logs available. The service may not have emitted any logs yet.'
    };
  }
}

module.exports = new OllamaService();

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const axios = require('axios');
const semver = require('semver');
const Device = require('../models/Device');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const directRadioProtocolCatalogService = require('./directRadioProtocolCatalogService');
const {
  MATTER_SOURCE,
  MATTER_TRANSPORTS,
  buildMatterFeatureProperties,
  featureSupport,
  inferFeaturesFromMatterDescriptor,
  inferHomeBrainTypeFromFeatures,
  matterFeatureLabels,
  normalizeClusterId,
  normalizeFeatureList
} = require('./matterDeviceCatalog');

const MATTER_DATA_DIR = process.env.HOMEBRAIN_MATTER_DATA_DIR
  || path.join(__dirname, '..', 'data', 'matter');
const MATTER_CONFIG_PATH = path.join(MATTER_DATA_DIR, 'config.json');
const MATTER_SESSIONS_PATH = path.join(MATTER_DATA_DIR, 'commissioning-sessions.json');
const MATTER_STORAGE_DIR = path.join(MATTER_DATA_DIR, 'matter-js-storage');
const THREAD_FLASH_JOBS_DIR = path.join(MATTER_DATA_DIR, 'firmware-flashes');
const THREAD_KERNEL_JOBS_DIR = path.join(MATTER_DATA_DIR, 'thread-kernel-jobs');
const THREAD_KERNEL_POST_REBOOT_PATH = path.join(MATTER_DATA_DIR, 'thread-kernel-post-reboot.json');
const THREAD_FLASH_MANAGED_VENV_DIR = path.join(MATTER_DATA_DIR, 'silabs-flasher-venv');
const DEFAULT_OTBR_REST_URL = process.env.HOMEBRAIN_OTBR_REST_URL || 'http://127.0.0.1:8081';
const DEFAULT_COMMISSIONING_TIMEOUT_SECONDS = Math.max(20, Number(process.env.HOMEBRAIN_MATTER_COMMISSIONING_TIMEOUT_SECONDS || 90));
const THREAD_FLASH_CONFIRMATION = 'FLASH OPENTHREAD RCP';
const THREAD_OTBR_CONFIRMATION = 'START THREAD BORDER ROUTER';
const THREAD_KERNEL_CONFIRMATION = 'REBUILD JETSON KERNEL FOR FULL THREAD';
const THREAD_KERNEL_REBOOT_CONFIRMATION = 'REBOOT JETSON AFTER KERNEL INSTALL';
const THREAD_FLASH_MAX_FIRMWARE_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.HOMEBRAIN_THREAD_FLASH_MAX_BYTES || 6 * 1024 * 1024)
);
const THREAD_FLASH_LOG_LIMIT = Math.max(50, Number(process.env.HOMEBRAIN_THREAD_FLASH_LOG_LIMIT || 250));
const THREAD_OTBR_LOG_LIMIT = Math.max(50, Number(process.env.HOMEBRAIN_THREAD_OTBR_LOG_LIMIT || 250));
const THREAD_OTBR_START_TIMEOUT_MS = Math.max(60_000, Number(process.env.HOMEBRAIN_THREAD_OTBR_START_TIMEOUT_MS || 60 * 60_000));
const THREAD_OTBR_HELPER_PATH = process.env.HOMEBRAIN_OTBR_HELPER_PATH || '/usr/local/lib/homebrain/homebrain-otbr-control.sh';
const THREAD_KERNEL_LOG_LIMIT = Math.max(50, Number(process.env.HOMEBRAIN_THREAD_KERNEL_LOG_LIMIT || 500));
const THREAD_KERNEL_BUILD_TIMEOUT_MS = Math.max(30 * 60_000, Number(process.env.HOMEBRAIN_THREAD_KERNEL_BUILD_TIMEOUT_MS || 4 * 60 * 60_000));
const THREAD_KERNEL_MONITOR_INTERVAL_MS = Math.max(5_000, Number(process.env.HOMEBRAIN_THREAD_KERNEL_MONITOR_INTERVAL_MS || 10_000));
const THREAD_KERNEL_START_GRACE_MS = Math.max(10_000, Number(process.env.HOMEBRAIN_THREAD_KERNEL_START_GRACE_MS || 30_000));
const THREAD_KERNEL_HELPER_PATH = process.env.HOMEBRAIN_THREAD_KERNEL_HELPER_PATH || '/usr/local/lib/homebrain/homebrain-jetson-kernel-control.sh';
const THREAD_KERNEL_HELPER_LOG_PATH = process.env.HOMEBRAIN_THREAD_KERNEL_LOG_PATH || '/var/lib/homebrain/thread-kernel/last-build.log';
const MATTER_CONTROLLER_ID = 'homebrain-matter-controller';
const THREAD_FLASH_ACTIVE_STATUSES = new Set(['queued', 'preparing', 'flashing']);
const THREAD_KERNEL_ACTIVE_STATUSES = new Set(['queued', 'preparing', 'building', 'installing']);
const UNIVERSAL_SILABS_FLASHER_REPO_URL = 'https://github.com/NabuCasa/universal-silabs-flasher';
const UNIVERSAL_SILABS_FLASHER_INSTALL_HINT = 'HomeBrain can install universal-silabs-flasher into its managed Matter venv when flashing starts.';
const SONOFF_DONGLE_HARDWARE_BASE_URL = 'https://dongle.sonoff.tech/dongle-flasher/dongle-hardware';
const SONOFF_FIRMWARE_MANIFEST_URL = `${SONOFF_DONGLE_HARDWARE_BASE_URL}/FIRMWARE_LIST.json`;
const SONOFF_MG24_ASIN = 'B0FMJD288B';
const SONOFF_MG24_FLASHER_URL = 'https://dongle.sonoff.tech/sonoff-dongle-flasher/';
const SONOFF_MG24_OPENTHREAD_GUIDE_URL = 'https://dongle.sonoff.tech/guide/dongle-pmg24/how_to_flash_openthread_firmware/';
const SONOFF_MG24_FLASHER_ADDON_URL = 'https://github.com/iHost-Open-Source-Project/hassio-ihost-addon/tree/master/hassio-ihost-sonoff-dongle-flasher';
const OPENTHREAD_OTBR_GUIDE_URL = 'https://openthread.io/guides/border-router';
const JETSONHACKS_KERNEL_BUILDER_URL = 'https://github.com/jetsonhacks/jetson-orin-kernel-builder';
const NVIDIA_JETSON_KERNEL_CUSTOMIZATION_URL = 'https://docs.nvidia.com/jetson/archives/r36.3/DeveloperGuide/SD/Kernel/KernelCustomization.html';

const MATTER_CONTROLLER_HARDWARE = Object.freeze({
  asin: SONOFF_MG24_ASIN,
  name: 'SONOFF Zigbee/Thread USB Dongle Plus MG24',
  chipset: 'Silicon Labs EFR32MG24',
  usbBridge: 'Silicon Labs CP210x',
  supportedFirmware: [
    'OpenThread RCP',
    'Zigbee NCP',
    'Zigbee/OpenThread MultiPAN RCP'
  ],
  role: 'Thread RCP for OpenThread Border Router; Matter over IP via Ethernet/Wi-Fi/Thread',
  flasherUrl: SONOFF_MG24_FLASHER_URL,
  openThreadGuideUrl: SONOFF_MG24_OPENTHREAD_GUIDE_URL,
  flasherAddOnUrl: SONOFF_MG24_FLASHER_ADDON_URL,
  otbrGuideUrl: OPENTHREAD_OTBR_GUIDE_URL
});

const MATTER_ACTION_CLUSTER_HINTS = Object.freeze({
  onOff: 6,
  level: 8,
  color: 768,
  doorLock: 257,
  windowCovering: 258,
  thermostat: 513,
  fan: 514
});

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeLower(value) {
  return normalizeString(value).toLowerCase();
}

function envFlagEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(normalizeLower(value));
}

function isThreadKernelRebuildEnabled() {
  return envFlagEnabled(process.env.HOMEBRAIN_ENABLE_THREAD_KERNEL_REBUILD);
}

function isAllowedLocalOtbrHost(hostname) {
  let host = normalizeLower(hostname);
  if (host.startsWith('[')) {
    host = host.slice(1);
  }
  if (host.endsWith(']')) {
    host = host.slice(0, -1);
  }
  if (!host) {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.local')) {
    return true;
  }
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }

  const ipv4Parts = host.split('.');
  if (ipv4Parts.length !== 4 || ipv4Parts.some((part) => !part || part.length > 3)) {
    return false;
  }
  const octets = ipv4Parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = octets;
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
}

function normalizeOtbrRestUrl(value, fallback = DEFAULT_OTBR_REST_URL) {
  const raw = normalizeString(value) || fallback;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    parsed = new URL(fallback);
  }

  let protocol = parsed.protocol === 'https:' ? 'https:' : 'http:';
  if (!isAllowedLocalOtbrHost(parsed.hostname)) {
    parsed = new URL(fallback);
    protocol = parsed.protocol === 'https:' ? 'https:' : 'http:';
  }
  parsed.protocol = protocol;
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';

  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.split('/').filter(Boolean).join('/');
  return `${parsed.protocol}//${parsed.host}${pathname ? `/${pathname}` : ''}`;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toTimeMs(value) {
  const text = normalizeString(value);
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function clampPercent(value) {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function safeJsonClone(value) {
  if (value === null || value === undefined) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value, (_key, rawValue) => (
      typeof rawValue === 'bigint' ? rawValue.toString() : rawValue
    )));
  } catch (_error) {
    return null;
  }
}

function stripSensitiveConfig(config = {}) {
  return {
    ...config,
    wifi: {
      ...(config.wifi || {}),
      credentials: config.wifi?.credentials ? 'configured' : ''
    },
    thread: {
      ...(config.thread || {}),
      operationalDataset: config.thread?.operationalDataset ? 'configured' : ''
    }
  };
}

function redactSession(session = {}) {
  const clone = safeJsonClone(session) || {};
  if (clone.request) {
    if (clone.request.wifiCredentials) {
      clone.request.wifiCredentials = 'configured';
    }
    if (clone.request.threadOperationalDataset) {
      clone.request.threadOperationalDataset = 'configured';
    }
    if (clone.request.setupCode) {
      clone.request.setupCode = clone.request.setupCode.replace(/.(?=.{4})/g, '*');
    }
    if (clone.request.manualCode) {
      clone.request.manualCode = clone.request.manualCode.replace(/.(?=.{4})/g, '*');
    }
  }
  return clone;
}

function createSessionId() {
  return `matter-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeTransport(value) {
  const normalized = normalizeLower(value);
  if (['thread', 'otbr'].includes(normalized)) {
    return MATTER_TRANSPORTS.thread;
  }
  if (['wifi', 'wi-fi'].includes(normalized)) {
    return MATTER_TRANSPORTS.wifi;
  }
  if (['ethernet', 'lan'].includes(normalized)) {
    return MATTER_TRANSPORTS.ethernet;
  }
  if (['ble', 'bluetooth'].includes(normalized)) {
    return MATTER_TRANSPORTS.ble;
  }
  return MATTER_TRANSPORTS.ip;
}

function resolveLocalSerialById() {
  const byIdDir = '/dev/serial/by-id';
  try {
    return fs.readdirSync(byIdDir)
      .map((entry) => {
        const stablePath = path.join(byIdDir, entry);
        let realPath = '';
        try {
          realPath = fs.realpathSync(stablePath);
        } catch (_error) {
          realPath = '';
        }
        return {
          stablePath,
          realPath,
          label: entry
        };
      });
  } catch (_error) {
    return [];
  }
}

function resolveRealPath(serialPath) {
  const normalizedPath = normalizeString(serialPath);
  if (!normalizedPath) {
    return '';
  }

  try {
    return fs.realpathSync(normalizedPath);
  } catch (_error) {
    return normalizedPath;
  }
}

function buildFallbackSerialPort(pathValue, stableLink = null) {
  const resolvedPath = resolveRealPath(pathValue);
  const stablePath = normalizeString(stableLink?.stablePath);
  const label = normalizeString(stableLink?.label) || (stablePath ? path.basename(stablePath) : path.basename(pathValue));

  return {
    path: resolvedPath || pathValue,
    pnpId: label,
    friendlyName: label,
    stablePath,
    realPath: resolvedPath
  };
}

function hasPortCandidate(candidates, serialPath) {
  const normalizedPath = normalizeString(serialPath);
  if (!normalizedPath) {
    return true;
  }

  const resolvedPath = resolveRealPath(normalizedPath);
  return candidates.some((candidate) => {
    const candidatePath = normalizeString(candidate?.path || candidate?.comName || candidate?.device || candidate?.pnpId);
    const candidateStablePath = normalizeString(candidate?.stablePath);
    const candidateRealPath = resolveRealPath(candidatePath);
    return candidatePath === normalizedPath
      || candidateStablePath === normalizedPath
      || candidateRealPath === resolvedPath
      || (candidateRealPath && resolvedPath && candidateRealPath === resolvedPath);
  });
}

function addFallbackSerialPortCandidates(rawPorts = [], stableLinks = resolveLocalSerialById()) {
  const candidates = Array.isArray(rawPorts) ? [...rawPorts] : [];

  stableLinks.forEach((stableLink) => {
    const candidatePath = stableLink.realPath || stableLink.stablePath;
    if (candidatePath && !hasPortCandidate(candidates, candidatePath)) {
      candidates.push(buildFallbackSerialPort(candidatePath, stableLink));
    }
  });

  return candidates;
}

function looksLikeSonoffMg24Port(port = {}) {
  const descriptor = [
    port.path,
    port.rawPath,
    port.stablePath,
    port.realPath,
    port.manufacturer,
    port.friendlyName,
    port.serialNumber,
    port.vendorId,
    port.productId,
    port.pnpId
  ]
    .map((value) => normalizeString(value).toLowerCase())
    .filter(Boolean)
    .join(' ');

  if (!descriptor) {
    return false;
  }

  const isMg24Family = /(?:^|[^a-z0-9])(?:mg24|pmg24|dongle[-_ ]?m|dongle[-_ ]?plus[-_ ]?mg24|efr32mg24)(?=$|[^a-z0-9])/.test(descriptor);
  const isKnownVendor = /\b(?:sonoff|itead|silicon labs|cp210)\b/.test(descriptor)
    || (normalizeLower(port.vendorId) === '10c4' && normalizeLower(port.productId) === 'ea60');

  return isMg24Family
    && isKnownVendor
    && !/\b(zooz|zst10|zwave|z-wave|zw090|zwave js)\b/.test(descriptor);
}

function normalizeSerialPort(port = {}, stableLinks = resolveLocalSerialById()) {
  const pathValue = normalizeString(port.path || port.comName || port.device || port.pnpId);
  const realPath = resolveRealPath(pathValue);
  const stableMatch = stableLinks.find((entry) => (
    entry.stablePath === pathValue
      || (entry.realPath && realPath && entry.realPath === realPath)
      || (entry.realPath && pathValue && entry.realPath.endsWith(path.basename(pathValue)))
  ));
  const stablePath = normalizeString(port.stablePath) || stableMatch?.stablePath || '';
  return {
    path: stablePath || pathValue,
    rawPath: pathValue || null,
    stablePath: stablePath || null,
    realPath: realPath || null,
    manufacturer: port.manufacturer || null,
    serialNumber: port.serialNumber || null,
    vendorId: port.vendorId || null,
    productId: port.productId || null,
    pnpId: port.pnpId || null,
    friendlyName: port.friendlyName || null,
    isExpectedMatterThreadStick: false
  };
}

function buildSerialPortDescriptor(port = {}) {
  return [
    port.path,
    port.rawPath,
    port.stablePath,
    port.realPath,
    port.manufacturer,
    port.friendlyName,
    port.serialNumber,
    port.vendorId,
    port.productId,
    port.pnpId
  ]
    .map((value) => normalizeString(value).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function serialPortMatchesPath(port = {}, serialPath = '') {
  const requestedPath = normalizeString(serialPath);
  if (!requestedPath) {
    return false;
  }

  const requestedRealPath = resolveRealPath(requestedPath);
  return [port.path, port.rawPath, port.stablePath, port.realPath]
    .map(normalizeString)
    .filter(Boolean)
    .some((candidatePath) => (
      candidatePath === requestedPath
        || (requestedRealPath && resolveRealPath(candidatePath) === requestedRealPath)
    ));
}

function inferSonoffThreadFirmwareTarget(port = {}) {
  const descriptor = buildSerialPortDescriptor(port);
  if (!descriptor || !looksLikeSonoffMg24Port(port)) {
    return null;
  }

  const evidence = [
    port.stablePath ? 'stablePath' : null,
    port.pnpId ? 'pnpId' : null,
    port.serialNumber ? 'serialNumber' : null,
    port.manufacturer ? 'manufacturer' : null
  ].filter(Boolean);

  if (/(?:^|[^a-z0-9])(?:dongle[-_ ]?plus[-_ ]?mg24|pmg24)(?=$|[^a-z0-9])/.test(descriptor)) {
    return {
      dongleType: 'Dongle-PMG24',
      chipModel: 'mg24',
      productName: 'SONOFF Dongle Plus MG24',
      firmwareType: 'OpenThread',
      evidence
    };
  }

  if (/(?:^|[^a-z0-9])(?:dongle[-_ ]?m|dongle[-_ ]?max[-_ ]?mg24)(?=$|[^a-z0-9])/.test(descriptor)) {
    return {
      dongleType: 'Dongle-M',
      chipModel: 'mg24',
      productName: 'SONOFF Dongle Max MG24',
      firmwareType: 'OpenThread',
      evidence
    };
  }

  return null;
}

function firmwareVersionTime(value) {
  const normalized = normalizeString(value);
  if (/^\d{8}$/.test(normalized)) {
    const year = Number(normalized.slice(0, 4));
    const month = Number(normalized.slice(4, 6)) - 1;
    const day = Number(normalized.slice(6, 8));
    const time = Date.UTC(year, month, day);
    return Number.isFinite(time) ? time : Number.NaN;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function compareFirmwareEntries(left = {}, right = {}) {
  const leftVersion = normalizeString(left.version);
  const rightVersion = normalizeString(right.version);
  const leftSemver = semver.valid(leftVersion);
  const rightSemver = semver.valid(rightVersion);
  if (leftSemver && rightSemver) {
    return semver.rcompare(leftSemver, rightSemver);
  }
  if (leftSemver) {
    return -1;
  }
  if (rightSemver) {
    return 1;
  }

  const leftTime = firmwareVersionTime(leftVersion);
  const rightTime = firmwareVersionTime(rightVersion);
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) {
    return rightTime - leftTime;
  }
  if (!Number.isNaN(leftTime)) {
    return -1;
  }
  if (!Number.isNaN(rightTime)) {
    return 1;
  }

  return rightVersion.localeCompare(leftVersion, undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

function normalizeSonoffFirmwareEntry(entry = {}) {
  const name = sanitizeFirmwareFileName(entry.name);
  return {
    name,
    dongleType: normalizeString(entry.dongleType),
    chipModel: normalizeString(entry.chipModel).toLowerCase(),
    firmwareType: normalizeString(entry.firmwareType),
    firmwareDesc: normalizeString(entry.firmwareDesc),
    version: normalizeString(entry.version),
    baudRate: normalizeString(entry.baudRate),
    sdkVersion: normalizeString(entry.sdkVersion),
    url: `${SONOFF_DONGLE_HARDWARE_BASE_URL}/${encodeURIComponent(name)}`
  };
}

function selectLatestSonoffThreadFirmware(firmwareList = [], target = {}) {
  const dongleType = normalizeString(target.dongleType);
  const chipModel = normalizeString(target.chipModel).toLowerCase();
  const firmwareType = normalizeString(target.firmwareType) || 'OpenThread';
  const candidates = (Array.isArray(firmwareList) ? firmwareList : [])
    .map((entry) => {
      try {
        return normalizeSonoffFirmwareEntry(entry);
      } catch (_error) {
        return null;
      }
    })
    .filter((entry) => (
      entry
        && entry.dongleType === dongleType
        && entry.firmwareType === firmwareType
        && (!chipModel || entry.chipModel === chipModel)
    ));

  const stableCandidates = candidates.filter((entry) => entry.firmwareDesc.toLowerCase() === 'stable');
  const sortable = stableCandidates.length > 0 ? stableCandidates : candidates;
  return sortable.sort(compareFirmwareEntries)[0] || null;
}

function normalizeThreadFirmwareFlashConfirmation(value) {
  return normalizeString(value).toUpperCase() === THREAD_FLASH_CONFIRMATION;
}

function sanitizeFirmwareFileName(value) {
  const rawName = path.basename(normalizeString(value) || 'openthread-rcp.gbl');
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+/, '');
  const finalName = safeName || 'openthread-rcp.gbl';
  const lowerName = finalName.toLowerCase();
  if (!lowerName.endsWith('.gbl')) {
    const error = new Error('Thread firmware must be a Silicon Labs .gbl image.');
    error.status = 400;
    throw error;
  }
  return finalName;
}

function isTrustedSonoffFirmwareUrl(value) {
  const rawUrl = normalizeString(value);
  if (!rawUrl) {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    return false;
  }

  const firmwareBaseUrl = new URL(SONOFF_DONGLE_HARDWARE_BASE_URL);
  return parsed.protocol === 'https:'
    && parsed.hostname.toLowerCase() === firmwareBaseUrl.hostname.toLowerCase()
    && parsed.pathname.startsWith(`${firmwareBaseUrl.pathname}/`)
    && parsed.pathname.toLowerCase().endsWith('.gbl')
    && parsed.username === ''
    && parsed.password === '';
}

function firmwareNameFromUrl(value) {
  try {
    const parsed = new URL(value);
    return sanitizeFirmwareFileName(decodeURIComponent(path.basename(parsed.pathname || 'openthread-rcp.gbl')));
  } catch (_error) {
    return sanitizeFirmwareFileName('openthread-rcp.gbl');
  }
}

function splitCommandSpec(value) {
  const spec = normalizeString(value);
  if (!spec) {
    return [];
  }

  const parts = [];
  let current = '';
  let quote = '';
  for (const char of spec) {
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function buildThreadFirmwareFlashToolCandidates() {
  const candidates = [];
  const envSpec = splitCommandSpec(process.env.HOMEBRAIN_SILABS_FLASHER_COMMAND);
  if (envSpec.length > 0) {
    candidates.push({
      command: envSpec[0],
      baseArgs: envSpec.slice(1),
      label: process.env.HOMEBRAIN_SILABS_FLASHER_COMMAND,
      source: 'env'
    });
  }

  candidates.push({
    command: path.join(THREAD_FLASH_MANAGED_VENV_DIR, process.platform === 'win32' ? 'Scripts/universal-silabs-flasher.exe' : 'bin/universal-silabs-flasher'),
    baseArgs: [],
    label: 'HomeBrain managed universal-silabs-flasher',
    source: 'managed-venv'
  });
  candidates.push({
    command: 'universal-silabs-flasher',
    baseArgs: [],
    label: 'universal-silabs-flasher',
    source: 'path'
  });

  const pythonBin = process.env.PYTHON_BIN || 'python3';
  candidates.push({
    command: pythonBin,
    baseArgs: ['-m', 'universal_silabs_flasher'],
    label: `${pythonBin} -m universal_silabs_flasher`,
    source: 'python-module'
  });

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\0${candidate.baseArgs.join('\0')}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function probeThreadFirmwareFlashTool(candidate) {
  const args = [...candidate.baseArgs, '--help'];
  const result = spawnSync(candidate.command, args, {
    encoding: 'utf8',
    timeout: 5000
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const available = result.status === 0 && /universal-silabs-flasher|silicon labs flasher/i.test(output);
  return {
    ...candidate,
    available,
    error: available ? null : (result.error?.message || output.split('\n').find(Boolean) || `Exited with ${result.status}`),
    versionText: available ? output.split('\n').slice(0, 3).join('\n') : ''
  };
}

function resolveThreadFirmwareFlashTool() {
  const probes = buildThreadFirmwareFlashToolCandidates().map(probeThreadFirmwareFlashTool);
  const selected = probes.find((probe) => probe.available) || null;
  return {
    available: Boolean(selected),
    command: selected?.command || null,
    baseArgs: selected?.baseArgs || [],
    label: selected?.label || null,
    source: selected?.source || null,
    canAutoInstall: true,
    installHint: UNIVERSAL_SILABS_FLASHER_INSTALL_HINT,
    docsUrl: UNIVERSAL_SILABS_FLASHER_REPO_URL,
    candidates: probes.map((probe) => ({
      label: probe.label,
      source: probe.source,
      available: probe.available,
      error: probe.available ? null : probe.error
    }))
  };
}

function buildUniversalSilabsFlasherArgs({ devicePath, firmwarePath, verbose = false }) {
  const args = [];
  if (verbose) {
    args.push('--verbose');
  }
  args.push(
    '--device',
    devicePath,
    '--bootloader-reset',
    'rts_dtr',
    'flash',
    '--firmware',
    firmwarePath
  );
  return args;
}

function buildThreadFirmwareFlashCommand(tool, options) {
  return {
    command: tool.command,
    args: [
      ...(tool.baseArgs || []),
      ...buildUniversalSilabsFlasherArgs(options)
    ]
  };
}

function normalizeThreadOtbrConfirmation(value) {
  return normalizeString(value).toUpperCase() === THREAD_OTBR_CONFIRMATION;
}

function normalizeThreadKernelConfirmation(value) {
  return normalizeString(value).toUpperCase() === THREAD_KERNEL_CONFIRMATION;
}

function normalizeThreadKernelRebootConfirmation(value) {
  return normalizeString(value).toUpperCase() === THREAD_KERNEL_REBOOT_CONFIRMATION;
}

function normalizeThreadBackboneRouterMode(value, fallback = 'auto') {
  const normalized = normalizeLower(value);
  if (['full', 'enabled', 'enable', 'true', 'yes', 'on', '1'].includes(normalized)) {
    return 'full';
  }
  if (['no-bbr', 'limited', 'disabled', 'disable', 'false', 'no', 'off', '0'].includes(normalized)) {
    return 'no-bbr';
  }
  return fallback;
}

function normalizeThreadBaudRate(value, fallback = '460800') {
  const text = normalizeString(value) || fallback;
  return /^[0-9]{4,8}$/.test(text) ? text : fallback;
}

function buildOtbrRadioUrl(devicePath, baudRate = '460800') {
  const pathValue = normalizeString(devicePath);
  if (!pathValue.startsWith('/dev/')) {
    throw new Error('OTBR radio device must be a local /dev serial path');
  }
  return `spinel+hdlc+uart://${pathValue}?uart-baudrate=${normalizeThreadBaudRate(baudRate)}`;
}

function parseHexDatasetFromText(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^[0-9a-f]+$/i.test(line)) || '';
}

function normalizeThreadOtbrState(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .find((line) => ['disabled', 'detached', 'child', 'router', 'leader'].includes(line)) || '';
}

function isThreadOtbrAttachedState(value) {
  return ['child', 'router', 'leader'].includes(normalizeThreadOtbrState(value));
}

function resolveThreadActiveDataset({
  configuredDataset = '',
  otbrDataset = '',
  hostDataset = ''
} = {}) {
  const configured = normalizeString(configuredDataset);
  const fromOtbr = normalizeString(otbrDataset);
  const fromHost = normalizeString(hostDataset);
  if (configured) {
    return { dataset: configured, source: 'homebrain-config' };
  }
  if (fromOtbr) {
    return { dataset: fromOtbr, source: 'otbr-rest' };
  }
  if (fromHost) {
    return { dataset: fromHost, source: 'otbr-host' };
  }
  return { dataset: '', source: null };
}

function serializeMatterControllerError(error, depth = 0) {
  if (!error || depth > 4) {
    return null;
  }

  const detail = {
    name: normalizeString(error.name) || 'Error',
    message: normalizeString(error.message) || String(error)
  };

  if (error.code) {
    detail.code = String(error.code);
  }
  if (error.errno) {
    detail.errno = String(error.errno);
  }
  if (error.syscall) {
    detail.syscall = String(error.syscall);
  }
  if (error.subject?.constructor?.name) {
    detail.subject = error.subject.constructor.name;
  }
  if (error.recovery) {
    detail.recovery = error.recovery;
  }
  if (error.stack) {
    detail.stack = String(error.stack).split('\n').slice(0, 8).join('\n');
  }
  if (error.cause) {
    detail.cause = serializeMatterControllerError(error.cause, depth + 1);
  }
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    detail.errors = error.errors.slice(0, 5).map((entry) => serializeMatterControllerError(entry, depth + 1));
  }

  return detail;
}

function summarizeMatterControllerError(error) {
  const detail = serializeMatterControllerError(error);
  if (!detail) {
    return '';
  }
  const messages = [];
  let cursor = detail;
  while (cursor) {
    if (cursor.message && !messages.includes(cursor.message)) {
      messages.push(cursor.message);
    }
    cursor = cursor.cause;
  }
  return messages.join(': ');
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function listMatterControllerStoreEntries(controllerStorePath) {
  try {
    return await fsp.readdir(controllerStorePath);
  } catch (_error) {
    return [];
  }
}

function matterControllerStoreMayContainPairedNodes(entries = []) {
  return entries.some((entry) => (
    /^peers?\b/i.test(entry)
    || /\.peers?\b/i.test(entry)
    || /\.commissioningClient\./i.test(entry)
    || /\.networkClient\./i.test(entry)
  ));
}

function runSync(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout || 5000,
    ...options
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal,
    stdout: normalizeString(result.stdout),
    stderr: normalizeString(result.stderr),
    error: result.error?.message || ''
  };
}

function commandExists(command) {
  const result = runSync('bash', ['-lc', `command -v ${command} 2>/dev/null`]);
  return result.ok && Boolean(result.stdout);
}

function systemctlValue(args = []) {
  const result = runSync('systemctl', args, { timeout: 4000 });
  return result.stdout || result.stderr || '';
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(normalizeString(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function parseJsonObjectFromOutput(value) {
  const normalized = normalizeString(value);
  const direct = parseJsonObject(normalized);
  if (direct) {
    return direct;
  }

  for (let start = normalized.indexOf('{'); start >= 0; start = normalized.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < normalized.length; index += 1) {
      const char = normalized[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseJsonObject(normalized.slice(start, index + 1));
          if (parsed) {
            return parsed;
          }
          break;
        }
      }
    }
  }

  return null;
}

function truncateDiagnostic(value, maxLength = 4000) {
  const normalized = normalizeString(value);
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function buildThreadKernelValidationFallback(probe = {}) {
  const detail = normalizeString(probe.stderr || probe.error)
    || (probe.signal ? `Thread kernel helper exited with signal ${probe.signal}` : '')
    || (probe.status !== null && probe.status !== undefined ? `Thread kernel helper exited with status ${probe.status}` : '')
    || 'Thread kernel preflight did not return validation details.';

  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    error: detail,
    checks: [
      {
        name: 'preflight helper returned validation details',
        ok: false,
        detail
      }
    ],
    warnings: [],
    diagnostics: {
      helperExitStatus: probe.status ?? null,
      helperSignal: probe.signal || null,
      stderr: truncateDiagnostic(probe.stderr),
      stdout: truncateDiagnostic(probe.stdout),
      error: truncateDiagnostic(probe.error)
    }
  };
}

function findCompletedThreadFirmwareFlash(firmwareFlash = {}, selectedPath = '') {
  const selected = normalizeString(selectedPath);
  const jobs = Array.isArray(firmwareFlash?.recentJobs) ? firmwareFlash.recentJobs : [];
  return jobs.find((job) => {
    if (job?.status !== 'completed') {
      return false;
    }
    const jobPath = normalizeString(job.devicePath);
    const type = normalizeLower(job?.firmware?.firmwareType || job?.firmware?.target?.firmwareType);
    return (!selected || jobPath === selected) && type === 'openthread';
  }) || null;
}

function normalizePersistedThreadFirmwareFlashJob(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const id = normalizeString(record.id);
  if (!id) {
    return null;
  }
  const now = new Date().toISOString();
  const status = normalizeString(record.status) || 'failed';
  return {
    id,
    status,
    phase: normalizeString(record.phase) || status,
    createdAt: normalizeString(record.createdAt) || normalizeString(record.updatedAt) || now,
    updatedAt: normalizeString(record.updatedAt) || normalizeString(record.createdAt) || now,
    finishedAt: normalizeString(record.finishedAt) || null,
    error: normalizeString(record.error) || null,
    devicePath: normalizeString(record.devicePath),
    firmware: record.firmware && typeof record.firmware === 'object' ? record.firmware : null,
    commandPreview: normalizeString(record.commandPreview) || null,
    tool: record.tool && typeof record.tool === 'object' ? record.tool : null,
    logs: Array.isArray(record.logs) ? record.logs.slice(-THREAD_FLASH_LOG_LIMIT) : []
  };
}

function normalizePersistedThreadKernelJob(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const id = normalizeString(record.id);
  if (!id) {
    return null;
  }
  const now = new Date().toISOString();
  const status = normalizeString(record.status) || 'failed';
  return {
    id,
    status,
    phase: normalizeString(record.phase) || status,
    createdAt: normalizeString(record.createdAt) || normalizeString(record.updatedAt) || now,
    updatedAt: normalizeString(record.updatedAt) || normalizeString(record.createdAt) || now,
    finishedAt: normalizeString(record.finishedAt) || null,
    error: normalizeString(record.error) || null,
    autoReboot: Boolean(record.autoReboot),
    enableFullOtbrAfterReboot: record.enableFullOtbrAfterReboot !== false,
    networkName: normalizeString(record.networkName) || 'HomeBrain Thread',
    commandPreview: normalizeString(record.commandPreview) || null,
    result: record.result && typeof record.result === 'object' ? record.result : null,
    logs: Array.isArray(record.logs) ? record.logs.slice(-THREAD_KERNEL_LOG_LIMIT) : []
  };
}

function threadKernelHelperResultMatchesJob(lastResult, job) {
  if (!lastResult || typeof lastResult !== 'object' || !job?.id) {
    return false;
  }

  const resultJobId = normalizeString(lastResult.jobId);
  if (resultJobId) {
    return resultJobId === job.id;
  }

  const resultUpdatedAt = toTimeMs(lastResult.updatedAt);
  const jobCreatedAt = toTimeMs(job.createdAt);
  if (resultUpdatedAt === null || jobCreatedAt === null) {
    return false;
  }

  return resultUpdatedAt >= jobCreatedAt - 60_000;
}

function buildThreadKernelJobUpdateFromHelperStatus(job, helperStatus, options = {}) {
  const lastResult = helperStatus?.lastResult;
  if (!threadKernelHelperResultMatchesJob(lastResult, job)) {
    return null;
  }

  const resultStatus = normalizeLower(lastResult.status);
  const message = normalizeString(lastResult.message);
  const finishedAt = normalizeString(lastResult.updatedAt) || new Date().toISOString();
  const processRunning = options.processRunning;

  if (resultStatus === 'completed') {
    return {
      status: 'completed',
      phase: job.autoReboot ? 'completed-reboot-scheduled' : 'completed-reboot-required',
      finishedAt,
      error: null,
      result: helperStatus
    };
  }

  if (resultStatus === 'failed' || resultStatus === 'error') {
    return {
      status: 'failed',
      phase: 'failed',
      finishedAt,
      error: message || 'Thread kernel helper failed. See the last build log for details.',
      result: helperStatus
    };
  }

  if (resultStatus === 'running') {
    if (processRunning === false) {
      return {
        status: 'failed',
        phase: 'failed',
        finishedAt: new Date().toISOString(),
        error: 'Thread kernel helper is no longer running. See the last build log for details.',
        result: helperStatus
      };
    }

    return {
      status: 'building',
      phase: 'building-and-installing-kernel',
      finishedAt: null,
      error: null,
      result: null
    };
  }

  return null;
}

function normalizeThreadKernelHelperLastResult(lastResult, options = {}) {
  if (!lastResult || typeof lastResult !== 'object') {
    return null;
  }

  const resultStatus = normalizeLower(lastResult.status);
  const activeJob = options.activeJob || null;
  const helperProcess = options.helperProcess || null;
  const matchesActiveJob = activeJob ? threadKernelHelperResultMatchesJob(lastResult, activeJob) : false;
  const helperKnownStopped = helperProcess?.available === true && helperProcess.running === false;

  if (resultStatus === 'running' && !matchesActiveJob && helperKnownStopped) {
    return {
      ...lastResult,
      status: 'stale',
      stale: true,
      message: 'Previous Thread kernel helper status is stale; no rebuild helper is currently running.'
    };
  }

  return lastResult;
}

function buildThreadSetupGuidance({
  expectedPorts = [],
  selectedPort = null,
  otbr = {},
  otbrHost = {},
  activeDataset = '',
  firmwareFlash = null,
  threadKernel = null
}) {
  const selectedPath = selectedPort?.path || selectedPort?.stablePath || selectedPort?.rawPath || '';
  const canServerFlash = Boolean(firmwareFlash?.tool?.available || firmwareFlash?.tool?.canAutoInstall);
  const completedFlash = findCompletedThreadFirmwareFlash(firmwareFlash, selectedPath);
  const threadAttached = isThreadOtbrAttachedState(otbrHost?.state);
  const threadState = normalizeThreadOtbrState(otbrHost?.state);
  const ipv6Mroute = normalizeLower(otbrHost?.ipv6Mroute);
  const backboneRouterMode = normalizeLower(otbrHost?.backboneRouterMode);
  const backboneRouterLimited = ipv6Mroute === 'unsupported' || backboneRouterMode === 'no-bbr';
  const kernelSupportsFullThread = Boolean(threadKernel?.kernelSupportsFullThread);
  const kernelNeedsRebuild = Boolean(threadKernel?.needsRebuild);
  const kernelRebuildEnabled = Boolean(threadKernel?.rebuildEnabled);
  const actions = [];

  actions.push({
    id: 'connect-mg24',
    label: 'Connect SONOFF MG24',
    status: expectedPorts.length > 0 ? 'complete' : 'required',
    detail: expectedPorts.length > 0
      ? `${expectedPorts.length} SONOFF MG24 Thread-capable stick${expectedPorts.length === 1 ? '' : 's'} detected.`
      : 'Plug in the SONOFF Dongle Plus MG24 so HomeBrain can bind it to OpenThread.'
  });

  if (expectedPorts.length > 1) {
    actions.push({
      id: 'select-thread-port',
      label: 'Select Thread stick',
      status: selectedPort ? 'complete' : 'required',
      detail: selectedPath
        ? `HomeBrain will use ${selectedPath} for Thread.`
        : 'Choose the MG24 stick that should be reserved for Thread.'
    });
  }

  actions.push({
    id: 'flash-openthread-rcp',
    label: 'Flash OpenThread RCP firmware',
    status: (threadAttached || completedFlash) ? 'complete' : (expectedPorts.length > 0 ? 'recommended' : 'blocked'),
    detail: threadAttached
      ? 'OTBR is attached, so the Thread radio path is active.'
      : completedFlash
        ? `OpenThread RCP firmware ${completedFlash?.firmware?.version || completedFlash?.firmware?.name || ''} was flashed successfully.`
        : otbr.online
          ? 'OTBR is responding, but the Thread interface is not attached yet.'
          : canServerFlash
            ? 'Use HomeBrain to download the latest matching SONOFF OpenThread RCP firmware and flash the selected MG24 stick, then start OTBR.'
            : 'Install universal-silabs-flasher on the HomeBrain host, or use the SONOFF Dongle Flasher with the stick attached to the browser computer.',
    url: SONOFF_MG24_FLASHER_URL,
    guideUrl: SONOFF_MG24_OPENTHREAD_GUIDE_URL,
    addOnUrl: SONOFF_MG24_FLASHER_ADDON_URL
  });

  actions.push({
    id: 'start-otbr',
    label: 'Start OpenThread Border Router',
    status: (otbr.online && threadAttached) ? 'complete' : 'required',
    detail: otbr.online && threadAttached
      ? `OTBR REST is online at ${otbr.baseUrl} and Thread is ${threadState}.`
      : otbr.online
        ? `OTBR REST is online, but Thread is ${threadState || 'not attached'}; restart OTBR and check diagnostics.`
        : completedFlash
          ? 'Start HomeBrain-managed OTBR so the flashed MG24 can provide an active Thread dataset.'
          : 'OTBR is not answering yet; flash the MG24 with OpenThread RCP, then start the border router.',
    guideUrl: OPENTHREAD_OTBR_GUIDE_URL
  });

  actions.push({
    id: 'host-backbone-router',
    label: 'Host Backbone Router support',
    status: kernelSupportsFullThread && !backboneRouterLimited ? 'complete' : (kernelNeedsRebuild || backboneRouterLimited ? 'limited' : 'checking'),
    detail: kernelSupportsFullThread && !backboneRouterLimited
      ? 'The host kernel and OTBR build can support Thread 1.2 Backbone Router multicast forwarding.'
      : backboneRouterLimited && !threadKernel
        ? 'This Jetson kernel does not expose IPv6 multicast routing, so HomeBrain will run OTBR without Thread 1.2 Backbone Router multicast forwarding.'
      : kernelNeedsRebuild && kernelRebuildEnabled
        ? 'This Jetson kernel does not expose the multicast routing options OTBR Backbone Router needs; HomeBrain can rebuild a custom Thread kernel, or keep the safe no-BBR fallback.'
      : kernelNeedsRebuild
        ? 'This Jetson kernel does not expose the multicast routing options OTBR Backbone Router needs. HomeBrain is keeping OTBR in the safe no-BBR fallback; the automatic Jetson kernel rebuild path is disabled.'
        : backboneRouterLimited
          ? 'This Jetson kernel does not expose IPv6 multicast routing, so HomeBrain will run OTBR without Thread 1.2 Backbone Router multicast forwarding.'
          : 'HomeBrain is checking host multicast routing support before enabling OTBR Backbone Router.'
  });

  actions.push({
    id: 'attach-thread-network',
    label: 'Attach Thread network',
    status: threadAttached ? 'complete' : 'required',
    detail: threadAttached
      ? `OpenThread reports ${threadState}.`
      : `OpenThread is ${threadState || 'not reporting a state'}; Thread devices cannot be commissioned until the border router attaches.`
  });

  actions.push({
    id: 'active-thread-dataset',
    label: 'Provide active Thread dataset',
    status: activeDataset ? 'complete' : 'required',
    detail: activeDataset
      ? 'HomeBrain can read the active Thread dataset.'
      : 'Start OTBR or paste the active operational dataset in Matter setup.'
  });

  return {
    desiredFirmware: 'OpenThread RCP',
    selectedPortPath: selectedPath || null,
    flasher: {
      label: 'SONOFF Dongle Flasher',
      url: SONOFF_MG24_FLASHER_URL,
      openThreadGuideUrl: SONOFF_MG24_OPENTHREAD_GUIDE_URL,
      addOnUrl: SONOFF_MG24_FLASHER_ADDON_URL,
      canFlashInBrowser: true,
      serverSideFlashingAvailable: canServerFlash,
      serverSideConfirmation: THREAD_FLASH_CONFIRMATION
    },
    otbr: {
      restUrl: otbr.baseUrl || DEFAULT_OTBR_REST_URL,
      guideUrl: OPENTHREAD_OTBR_GUIDE_URL,
      serverSideConfirmation: THREAD_OTBR_CONFIRMATION
    },
    kernel: {
      serverSideConfirmation: THREAD_KERNEL_CONFIRMATION,
      rebootConfirmation: THREAD_KERNEL_REBOOT_CONFIRMATION,
      rebuildEnabled: kernelRebuildEnabled,
      builderUrl: JETSONHACKS_KERNEL_BUILDER_URL,
      nvidiaGuideUrl: NVIDIA_JETSON_KERNEL_CUSTOMIZATION_URL
    },
    actions
  };
}

function getSerialPortListFunction(serialportModule) {
  const SerialPort = serialportModule?.SerialPort || serialportModule;
  return typeof SerialPort?.list === 'function' ? SerialPort.list.bind(SerialPort) : null;
}

function parseKnownAddress(value, defaultPort = 5540) {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes('://')) {
    try {
      const url = new URL(trimmed);
      return {
        ip: url.hostname,
        port: Number(url.port || defaultPort),
        type: url.protocol.replace(':', '') === 'tcp' ? 'tcp' : 'udp'
      };
    } catch (_error) {
      return null;
    }
  }

  const [host, portText] = trimmed.split(':');
  const port = Number(portText || defaultPort);
  return {
    ip: host,
    port: Number.isFinite(port) ? port : defaultPort,
    type: 'udp'
  };
}

function buildManualSteps({ transport, hasThreadDataset, hasBle }) {
  const steps = [];
  steps.push('Put the Matter device into commissioning mode using its manufacturer reset or pairing instructions.');
  steps.push('Enter or scan the Matter setup code from the device, box, or manufacturer app.');

  if (transport === MATTER_TRANSPORTS.thread) {
    steps.push('Make sure the SONOFF MG24 stick is flashed with OpenThread RCP firmware and attached to the Jetson.');
    steps.push(hasThreadDataset
      ? 'HomeBrain will provide the active Thread dataset to the device during commissioning.'
      : 'Start OpenThread Border Router or paste the active Thread operational dataset before commissioning Thread devices.');
  } else if (transport === MATTER_TRANSPORTS.wifi) {
    steps.push('Provide Wi-Fi SSID and credentials if the Matter device is not already on your IP network.');
  } else {
    steps.push('For Matter-over-IP devices already on Wi-Fi or Ethernet, keep the device on the same LAN as HomeBrain.');
  }

  if (!hasBle && [MATTER_TRANSPORTS.thread, MATTER_TRANSPORTS.wifi, MATTER_TRANSPORTS.ble].includes(transport)) {
    steps.push('If this device requires Bluetooth commissioning, enable Bluetooth on the Jetson and install the BLE runtime dependency.');
  }

  return steps;
}

function normalizeMatterNodeId(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value).toString();
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}

function endpointDescriptorFromRecord(record = {}) {
  return {
    nodeId: record.nodeId,
    endpointId: record.endpointId,
    name: record.name,
    productName: record.productName,
    vendorName: record.vendorName,
    endpointName: record.endpointName,
    clusterIds: record.clusterIds || [],
    clusterNames: record.clusterNames || [],
    deviceTypeNames: record.deviceTypeNames || []
  };
}

class MatterService {
  constructor() {
    this.started = false;
    this.startError = null;
    this.config = null;
    this.sessions = [];
    this.controller = null;
    this.controllerStartPromise = null;
    this.controllerError = null;
    this.controllerRecovery = null;
    this.runtime = null;
    this.detectedSerialPorts = [];
    this.lastThreadStatus = null;
    this.threadFirmwareFlashJobs = new Map();
    this.activeThreadFirmwareFlashJobId = null;
    this.threadFirmwareFlashJobsLoaded = false;
    this.threadOtbrJobs = new Map();
    this.activeThreadOtbrJobId = null;
    this.threadKernelJobs = new Map();
    this.activeThreadKernelJobId = null;
    this.threadKernelJobsLoaded = false;
    this.threadKernelPostRebootResumeQueued = false;
    this.threadFirmwareFlashToolCache = null;
    this.sonoffFirmwareManifestCache = null;
  }

  async ensureDataDir() {
    await fsp.mkdir(MATTER_DATA_DIR, { recursive: true });
    await fsp.mkdir(MATTER_STORAGE_DIR, { recursive: true });
    await fsp.mkdir(THREAD_FLASH_JOBS_DIR, { recursive: true });
    await fsp.mkdir(THREAD_KERNEL_JOBS_DIR, { recursive: true });
  }

  async loadConfig() {
    await this.ensureDataDir();
    if (this.config) {
      return this.config;
    }

    let existing = {};
    try {
      existing = JSON.parse(await fsp.readFile(MATTER_CONFIG_PATH, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`MatterService: Failed to read config, recreating defaults: ${error.message}`);
      }
    }

    const config = {
      enabled: existing.enabled !== false,
      adminFabricLabel: normalizeString(existing.adminFabricLabel) || 'HomeBrain Matter',
      adminVendorId: Number.isFinite(Number(existing.adminVendorId)) ? Number(existing.adminVendorId) : 0xfff1,
      adminFabricId: Number.isFinite(Number(existing.adminFabricId)) ? Number(existing.adminFabricId) : 1,
      storagePath: normalizeString(existing.storagePath) || MATTER_STORAGE_DIR,
      otbrRestUrl: normalizeOtbrRestUrl(existing.otbrRestUrl, DEFAULT_OTBR_REST_URL),
      thread: {
        networkName: normalizeString(existing.thread?.networkName) || '',
        operationalDataset: normalizeString(existing.thread?.operationalDataset) || ''
      },
      wifi: {
        ssid: normalizeString(existing.wifi?.ssid) || '',
        credentials: normalizeString(existing.wifi?.credentials) || ''
      },
      preferredThreadPort: normalizeString(existing.preferredThreadPort) || '',
      autoStartController: existing.autoStartController !== false
    };

    this.config = config;
    await this.saveConfig();
    return this.config;
  }

  async saveConfig() {
    await this.ensureDataDir();
    await fsp.writeFile(MATTER_CONFIG_PATH, JSON.stringify(this.config || {}, null, 2));
  }

  async loadSessions() {
    await this.ensureDataDir();
    try {
      const parsed = JSON.parse(await fsp.readFile(MATTER_SESSIONS_PATH, 'utf8'));
      this.sessions = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`MatterService: Failed to read commissioning sessions: ${error.message}`);
      }
      this.sessions = [];
    }
    return this.sessions;
  }

  async saveSessions() {
    await this.ensureDataDir();
    const recentSessions = this.sessions
      .slice()
      .sort((left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0))
      .slice(0, 50);
    this.sessions = recentSessions;
    await fsp.writeFile(MATTER_SESSIONS_PATH, JSON.stringify(recentSessions, null, 2));
  }

  async start() {
    if (this.started) {
      await this.ensureControllerIfConfigured();
      return this.getStatus();
    }

    this.started = true;
    this.startError = null;

    try {
      await this.loadConfig();
      await this.loadSessions();
      this.detectedSerialPorts = await this.detectSerialPorts();
      this.lastThreadStatus = await this.getThreadStatus({ refreshPorts: false });
      this.queueThreadKernelPostRebootResume();
      await this.ensureControllerIfConfigured();
    } catch (error) {
      this.recordControllerStartupError(error);
      console.warn(`MatterService: Startup failed: ${this.startError}`);
    }

    return this.getStatus();
  }

  async shutdown() {
    if (this.controller && typeof this.controller.close === 'function') {
      await this.controller.close();
    }
    this.controller = null;
    this.controllerStartPromise = null;
    this.started = false;
  }

  async ensureControllerIfConfigured() {
    const config = await this.loadConfig();
    if (!config.autoStartController || !config.enabled || this.controller || this.controllerStartPromise) {
      return;
    }

    try {
      await this.ensureController();
      this.startError = null;
      this.controllerError = null;
    } catch (error) {
      this.recordControllerStartupError(error);
      console.warn(`MatterService: Matter controller startup deferred: ${this.startError}`);
    }
  }

  recordControllerStartupError(error) {
    this.controllerError = serializeMatterControllerError(error);
    this.startError = summarizeMatterControllerError(error) || error.message;
  }

  async detectSerialPorts() {
    try {
      const serialportModule = require('serialport');
      const listSerialPorts = getSerialPortListFunction(serialportModule);
      if (!listSerialPorts) {
        throw new Error('serialport.list is not available');
      }
      const ports = await listSerialPorts();
      const stableLinks = resolveLocalSerialById();
      return addFallbackSerialPortCandidates(ports, stableLinks)
        .map((port) => normalizeSerialPort(port, stableLinks))
        .map((port) => ({
          ...port,
          isExpectedMatterThreadStick: looksLikeSonoffMg24Port(port)
        }));
    } catch (error) {
      console.warn(`MatterService: Unable to list serial ports: ${error.message}`);
      return [];
    }
  }

  async checkOtbrRest(restUrl = DEFAULT_OTBR_REST_URL) {
    const baseUrl = normalizeOtbrRestUrl(restUrl);
    const candidates = [
      '/node/dataset/active',
      '/node/dataset/active/tlvs',
      '/node/active-dataset-tlvs'
    ];

    for (const endpoint of candidates) {
      try {
        const response = await axios.get(`${baseUrl}${endpoint}`, {
          timeout: 2500,
          validateStatus: (status) => status >= 200 && status < 500
        });
        if (response.status >= 200 && response.status < 300) {
          return {
            online: true,
            baseUrl,
            endpoint,
            dataset: this.extractOperationalDataset(response.data),
            rawShape: Array.isArray(response.data) ? 'array' : typeof response.data
          };
        }
      } catch (_error) {
        // Try the next known OTBR REST shape.
      }
    }

    return {
      online: false,
      baseUrl,
      endpoint: null,
      dataset: '',
      rawShape: null
    };
  }

  extractOperationalDataset(payload) {
    if (typeof payload === 'string') {
      const trimmed = payload.trim();
      return /^[0-9a-f]+$/i.test(trimmed) ? trimmed : '';
    }
    if (!payload || typeof payload !== 'object') {
      return '';
    }

    const candidates = [
      payload.activeDatasetTlvs,
      payload.activeDatasetTLVs,
      payload.datasetTlvs,
      payload.datasetTLVs,
      payload.tlvs,
      payload.tlv,
      payload.operationalDataset,
      payload.activeOperationalDataset,
      payload?.ActiveDataset?.Tlvs,
      payload?.ActiveDataset?.TLVs
    ];

    for (const candidate of candidates) {
      const dataset = normalizeString(candidate);
      if (/^[0-9a-f]+$/i.test(dataset)) {
        return dataset;
      }
    }

    return '';
  }

  async getThreadOtbrHostStatus(options = {}) {
    const activeJob = this.activeThreadOtbrJobId
      ? this.threadOtbrJobs.get(this.activeThreadOtbrJobId)
      : null;
    const recentJobs = Array.from(this.threadOtbrJobs.values())
      .sort((left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0))
      .slice(0, 5)
      .map((job) => this.serializeThreadOtbrJob(job, { includeLogs: options.includeLogs !== false }));
    const helperAvailable = fs.existsSync(THREAD_OTBR_HELPER_PATH);
    const helperProbe = helperAvailable
      ? runSync('sudo', ['-n', THREAD_OTBR_HELPER_PATH, 'status'], { timeout: 25_000 })
      : null;
    const helperStatus = parseJsonObjectFromOutput(helperProbe?.stdout || '');
    const serviceActive = normalizeString(helperStatus?.active) || systemctlValue(['is-active', 'otbr-agent']);
    const serviceEnabled = normalizeString(helperStatus?.enabled) || systemctlValue(['is-enabled', 'otbr-agent']);
    const mainPid = normalizeString(helperStatus?.mainPid) || systemctlValue(['show', '-p', 'MainPID', '--value', 'otbr-agent']);
    const otbrAgentInstalled = commandExists('otbr-agent') || fs.existsSync('/usr/sbin/otbr-agent') || fs.existsSync('/usr/local/sbin/otbr-agent');
    const otCtlInstalled = commandExists('ot-ctl') || fs.existsSync('/usr/sbin/ot-ctl') || fs.existsSync('/usr/local/bin/ot-ctl');
    const datasetProbe = (!helperStatus && otCtlInstalled) ? runSync('bash', ['-lc', 'ot-ctl dataset active -x 2>/dev/null || true'], { timeout: 7000 }) : null;
    const stateProbe = (!helperStatus && otCtlInstalled) ? runSync('bash', ['-lc', 'ot-ctl state 2>/dev/null || true'], { timeout: 7000 }) : null;
    const state = normalizeThreadOtbrState(helperStatus?.state || stateProbe?.stdout || '');
    const dataset = parseHexDatasetFromText(helperStatus?.dataset || datasetProbe?.stdout || '');
    const mode = normalizeString(helperStatus?.mode || '');
    const routerEligible = normalizeString(helperStatus?.routerEligible || '');
    const version = normalizeString(helperStatus?.version || '');
    const bbrState = normalizeString(helperStatus?.bbrState || '');
    const ipv6Mroute = normalizeString(helperStatus?.ipv6Mroute || '');
    const backboneRouterMode = normalizeString(helperStatus?.backboneRouterMode || '');
    const installedBackboneRouterMode = normalizeString(helperStatus?.installedBackboneRouterMode || '');

    return {
      confirmationPhrase: THREAD_OTBR_CONFIRMATION,
      helperPath: THREAD_OTBR_HELPER_PATH,
      helperAvailable,
      canAutoInstall: helperAvailable,
      serviceName: 'otbr-agent',
      serviceActive: serviceActive || 'unknown',
      serviceEnabled: serviceEnabled || 'unknown',
      mainPid: mainPid && mainPid !== '0' ? mainPid : null,
      otbrAgentInstalled,
      otCtlInstalled,
      state,
      attached: isThreadOtbrAttachedState(state),
      dataset,
      mode,
      routerEligible,
      version,
      bbrState,
      ipv6Mroute,
      backboneRouterMode,
      installedBackboneRouterMode,
      backboneRouterLimited: Boolean(
        normalizeLower(ipv6Mroute) === 'unsupported'
        || normalizeLower(backboneRouterMode) === 'no-bbr'
      ),
      diagnostics: {
        helperStatusAvailable: Boolean(helperStatus),
        helperError: helperStatus ? null : normalizeString(helperProbe?.stderr || helperProbe?.error || ''),
        systemctl: normalizeString(helperStatus?.diagnostics?.systemctl || ''),
        journal: normalizeString(helperStatus?.diagnostics?.journal || '')
      },
      activeJob: activeJob ? this.serializeThreadOtbrJob(activeJob, { includeLogs: options.includeLogs !== false }) : null,
      recentJobs
    };
  }

  async readThreadKernelPostRebootMarker() {
    try {
      const parsed = JSON.parse(await fsp.readFile(THREAD_KERNEL_POST_REBOOT_PATH, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`MatterService: Failed to read Thread kernel post-reboot marker: ${error.message}`);
      }
      return null;
    }
  }

  async writeThreadKernelPostRebootMarker(marker = {}) {
    await this.ensureDataDir();
    await fsp.writeFile(THREAD_KERNEL_POST_REBOOT_PATH, JSON.stringify({
      createdAt: new Date().toISOString(),
      networkName: normalizeString(marker.networkName) || 'HomeBrain Thread',
      requestedBackboneRouterMode: 'full',
      sourceJobId: normalizeString(marker.sourceJobId) || null,
      attemptCount: Number.isFinite(Number(marker.attemptCount)) ? Number(marker.attemptCount) : 0,
      lastAttemptAt: normalizeString(marker.lastAttemptAt) || null,
      lastError: normalizeString(marker.lastError) || null
    }, null, 2));
  }

  async clearThreadKernelPostRebootMarker() {
    try {
      await fsp.unlink(THREAD_KERNEL_POST_REBOOT_PATH);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`MatterService: Failed to clear Thread kernel post-reboot marker: ${error.message}`);
      }
    }
  }

  queueThreadKernelPostRebootResume() {
    if (this.threadKernelPostRebootResumeQueued) {
      return;
    }
    this.threadKernelPostRebootResumeQueued = true;
    setTimeout(() => {
      this.threadKernelPostRebootResumeQueued = false;
      this.resumeThreadKernelPostRebootIfReady().catch((error) => {
        console.warn(`MatterService: Thread kernel post-reboot resume failed: ${error.message}`);
      });
    }, 5000);
  }

  async resumeThreadKernelPostRebootIfReady() {
    const marker = await this.readThreadKernelPostRebootMarker();
    if (!marker) {
      return null;
    }

    const kernelStatus = await this.getThreadKernelStatus({ includeLogs: false });
    if (!kernelStatus?.kernelSupportsFullThread || kernelStatus?.pendingReboot) {
      return null;
    }

    const attempts = Number(marker.attemptCount || 0);
    if (attempts >= 3) {
      return null;
    }

    await this.writeThreadKernelPostRebootMarker({
      ...marker,
      attemptCount: attempts + 1,
      lastAttemptAt: new Date().toISOString()
    });

    try {
      const job = await this.startThreadBorderRouter({
        confirmOtbr: THREAD_OTBR_CONFIRMATION,
        networkName: marker.networkName || 'HomeBrain Thread',
        backboneRouterMode: 'full'
      });
      await this.clearThreadKernelPostRebootMarker();
      return job;
    } catch (error) {
      await this.writeThreadKernelPostRebootMarker({
        ...marker,
        attemptCount: attempts + 1,
        lastAttemptAt: new Date().toISOString(),
        lastError: error.message
      });
      return null;
    }
  }

  serializeThreadKernelJob(job, options = {}) {
    if (!job) {
      return null;
    }
    return {
      id: job.id,
      status: job.status,
      phase: job.phase,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      autoReboot: job.autoReboot,
      enableFullOtbrAfterReboot: job.enableFullOtbrAfterReboot,
      networkName: job.networkName,
      commandPreview: job.commandPreview,
      result: job.result,
      logs: options.includeLogs === false ? [] : job.logs.slice(-THREAD_KERNEL_LOG_LIMIT)
    };
  }

  async persistThreadKernelJob(job) {
    if (!job?.id) {
      return;
    }
    try {
      await this.ensureDataDir();
      await fsp.writeFile(
        path.join(THREAD_KERNEL_JOBS_DIR, `${job.id}.json`),
        JSON.stringify(this.serializeThreadKernelJob(job), null, 2)
      );
    } catch (error) {
      console.warn(`MatterService: Failed to persist Thread kernel job: ${error.message}`);
    }
  }

  getThreadKernelHelperStatusSync() {
    if (!fs.existsSync(THREAD_KERNEL_HELPER_PATH)) {
      return null;
    }
    const probe = runSync('sudo', ['-n', THREAD_KERNEL_HELPER_PATH, 'status'], { timeout: 30_000 });
    return parseJsonObjectFromOutput(probe?.stdout || '');
  }

  getThreadKernelHelperProcessStatus(jobId = '') {
    const probe = runSync('ps', ['-eo', 'pid=,args='], { timeout: 4000 });
    const normalizedJobId = normalizeString(jobId);
    if (!probe.ok && !probe.stdout) {
      return {
        available: false,
        running: null,
        matches: [],
        error: probe.stderr || probe.error || 'Unable to inspect running processes.'
      };
    }

    const matches = normalizeString(probe.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => (
        line.includes('homebrain-jetson-kernel-control.sh')
        && /\b(apply|rebuild)\b/.test(line)
        && (!normalizedJobId || line.includes(normalizedJobId))
      ))
      .slice(0, 10);

    return {
      available: true,
      running: matches.length > 0,
      matches
    };
  }

  async readThreadKernelHelperLogTail() {
    try {
      const text = await fsp.readFile(THREAD_KERNEL_HELPER_LOG_PATH, 'utf8');
      const stat = await fsp.stat(THREAD_KERNEL_HELPER_LOG_PATH).catch(() => null);
      const at = stat?.mtime instanceof Date ? stat.mtime.toISOString() : new Date().toISOString();
      return text
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .slice(-THREAD_KERNEL_LOG_LIMIT)
        .map((line) => ({
          at,
          stream: 'log',
          line: line.slice(0, 1000)
        }));
    } catch (_error) {
      return [];
    }
  }

  async refreshThreadKernelJobLogsFromHelper(job) {
    const logs = await this.readThreadKernelHelperLogTail();
    if (logs.length > 0) {
      job.logs = logs;
      job.updatedAt = new Date().toISOString();
    }
  }

  async failThreadKernelJob(job, error, result = null) {
    await this.refreshThreadKernelJobLogsFromHelper(job);
    await this.updateThreadKernelJob(job, {
      status: 'failed',
      phase: 'failed',
      error: error.message || String(error),
      finishedAt: new Date().toISOString(),
      result
    });
    if (this.activeThreadKernelJobId === job.id) {
      this.activeThreadKernelJobId = null;
    }
    if (job.enableFullOtbrAfterReboot) {
      await this.clearThreadKernelPostRebootMarker();
    }
  }

  async applyThreadKernelHelperJobUpdate(job, update) {
    await this.refreshThreadKernelJobLogsFromHelper(job);
    await this.updateThreadKernelJob(job, update);
    if (!THREAD_KERNEL_ACTIVE_STATUSES.has(update.status)) {
      if (this.activeThreadKernelJobId === job.id) {
        this.activeThreadKernelJobId = null;
      }
      if (update.status === 'failed' && job.enableFullOtbrAfterReboot) {
        await this.clearThreadKernelPostRebootMarker();
      }
      this.lastThreadStatus = null;
    }
  }

  async loadThreadKernelJobs(options = {}) {
    if (this.threadKernelJobsLoaded && !options.forceRefresh) {
      return;
    }

    await this.ensureDataDir();
    let entries = [];
    try {
      entries = await fsp.readdir(THREAD_KERNEL_JOBS_DIR, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`MatterService: Failed to list Thread kernel jobs: ${error.message}`);
      }
      this.threadKernelJobsLoaded = true;
      return;
    }

    const reconciledJobs = [];
    const recoveredJobs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(THREAD_KERNEL_JOBS_DIR, entry.name);
      try {
        const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
        const job = normalizePersistedThreadKernelJob(parsed);
        if (!job) {
          continue;
        }
        const isCurrentInMemoryJob = this.activeThreadKernelJobId === job.id && THREAD_KERNEL_ACTIVE_STATUSES.has(job.status);
        if (isCurrentInMemoryJob) {
          continue;
        }
        if (THREAD_KERNEL_ACTIVE_STATUSES.has(job.status) && !isCurrentInMemoryJob) {
          const helperStatus = this.getThreadKernelHelperStatusSync();
          const processStatus = this.getThreadKernelHelperProcessStatus(job.id);
          const update = buildThreadKernelJobUpdateFromHelperStatus(job, helperStatus, {
            processRunning: processStatus.available ? processStatus.running : null
          });

          if (update) {
            Object.assign(job, update, {
              updatedAt: new Date().toISOString()
            });
            await this.refreshThreadKernelJobLogsFromHelper(job);
            reconciledJobs.push(job);
            if (THREAD_KERNEL_ACTIVE_STATUSES.has(job.status)) {
              recoveredJobs.push(job);
            } else if (job.status === 'failed' && job.enableFullOtbrAfterReboot) {
              await this.clearThreadKernelPostRebootMarker();
            }
          } else {
            job.status = 'failed';
            job.phase = 'failed';
            job.finishedAt = job.finishedAt || new Date().toISOString();
            job.error = job.error || 'HomeBrain restarted and the kernel helper is no longer reporting this rebuild job.';
            await this.refreshThreadKernelJobLogsFromHelper(job);
            reconciledJobs.push(job);
            if (job.enableFullOtbrAfterReboot) {
              await this.clearThreadKernelPostRebootMarker();
            }
          }
        }
        this.threadKernelJobs.set(job.id, job);
      } catch (error) {
        console.warn(`MatterService: Failed to load Thread kernel job ${entry.name}: ${error.message}`);
      }
    }

    this.activeThreadKernelJobId = Array.from(this.threadKernelJobs.values())
      .find((job) => THREAD_KERNEL_ACTIVE_STATUSES.has(job.status))?.id || null;
    this.threadKernelJobsLoaded = true;

    await Promise.all(reconciledJobs.map((job) => this.persistThreadKernelJob(job)));
    recoveredJobs.forEach((job) => {
      setImmediate(() => {
        this.monitorThreadKernelRebuildJob(job, { recovered: true }).catch((error) => {
          this.failThreadKernelJob(job, error).catch(() => {});
        });
      });
    });
  }

  appendThreadKernelJobLog(job, streamName, chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .forEach((line) => {
        job.logs.push({
          at: new Date().toISOString(),
          stream: streamName,
          line: line.slice(0, 1000)
        });
      });
    if (job.logs.length > THREAD_KERNEL_LOG_LIMIT) {
      job.logs.splice(0, job.logs.length - THREAD_KERNEL_LOG_LIMIT);
    }
    job.updatedAt = new Date().toISOString();
  }

  async updateThreadKernelJob(job, updates = {}) {
    Object.assign(job, updates, {
      updatedAt: new Date().toISOString()
    });
    await this.persistThreadKernelJob(job);
  }

  async getThreadKernelStatus(options = {}) {
    await this.loadThreadKernelJobs(options);
    const activeJob = this.activeThreadKernelJobId
      ? this.threadKernelJobs.get(this.activeThreadKernelJobId)
      : null;
    const recentJobs = Array.from(this.threadKernelJobs.values())
      .sort((left, right) => new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0))
      .slice(0, 5)
      .map((job) => this.serializeThreadKernelJob(job, { includeLogs: options.includeLogs !== false }));
    const helperAvailable = fs.existsSync(THREAD_KERNEL_HELPER_PATH);
    const helperProbe = helperAvailable
      ? runSync('sudo', ['-n', THREAD_KERNEL_HELPER_PATH, 'status'], { timeout: 30_000 })
      : null;
    const helperStatus = parseJsonObjectFromOutput(helperProbe?.stdout || '');
    const helperProcess = this.getThreadKernelHelperProcessStatus(activeJob?.id || '');
    const helperLastResult = normalizeThreadKernelHelperLastResult(helperStatus?.lastResult || null, {
      activeJob,
      helperProcess
    });
    let postRebootAction = await this.readThreadKernelPostRebootMarker();
    if (postRebootAction?.sourceJobId && !helperStatus?.pendingReboot) {
      const sourceJob = this.threadKernelJobs.get(postRebootAction.sourceJobId);
      if (sourceJob?.status === 'failed') {
        await this.clearThreadKernelPostRebootMarker();
        postRebootAction = null;
      }
    }
    const needsRebuild = helperStatus
      ? Boolean(helperStatus.needsRebuild)
      : true;
    const kernelSupportsFullThread = helperStatus
      ? Boolean(helperStatus.kernelSupportsFullThread)
      : false;
    const rebuildEnabled = isThreadKernelRebuildEnabled();

    return {
      confirmationPhrase: THREAD_KERNEL_CONFIRMATION,
      rebootConfirmationPhrase: THREAD_KERNEL_REBOOT_CONFIRMATION,
      helperPath: THREAD_KERNEL_HELPER_PATH,
      helperAvailable,
      canAutoInstall: helperAvailable && rebuildEnabled,
      rebuildEnabled,
      builderUrl: JETSONHACKS_KERNEL_BUILDER_URL,
      nvidiaGuideUrl: NVIDIA_JETSON_KERNEL_CUSTOMIZATION_URL,
      isJetsonOrin: Boolean(helperStatus?.isJetsonOrin),
      unameRelease: normalizeString(helperStatus?.unameRelease) || null,
      l4tRelease: normalizeString(helperStatus?.l4tRelease) || null,
      kernelConfig: helperStatus?.kernelConfig || null,
      runtimeIpv6Mroute: normalizeString(helperStatus?.runtimeIpv6Mroute) || null,
      kernelSupportsFullThread,
      needsRebuild,
      pendingReboot: helperStatus?.pendingReboot || null,
      validation: helperStatus?.validation || null,
      lastResult: helperLastResult,
      builder: helperStatus?.builder || null,
      source: helperStatus?.source || null,
      boot: helperStatus?.boot || null,
      postRebootAction,
      warnings: rebuildEnabled
        ? [
          'This changes the Jetson boot kernel and modules. A failed kernel install can require local console or SD/NVMe recovery.',
          'The build can take a long time on the Jetson and should only run with stable power and network.',
          'NVIDIA JetPack/L4T updates may replace the boot kernel. HomeBrain will detect missing multicast routing again and fall back to OTBR no-BBR until you reapply this kernel support.'
        ]
        : [
          'Automatic Jetson kernel rebuilds are disabled. HomeBrain will keep OTBR in the safe no-BBR fallback on kernels without multicast routing support.'
        ],
      diagnostics: {
        helperStatusAvailable: Boolean(helperStatus),
        helperError: helperStatus ? null : normalizeString(helperProbe?.stderr || helperProbe?.error || ''),
        helperExitStatus: helperProbe?.status ?? null,
        helperProcess,
        staleLastResult: Boolean(helperLastResult?.stale)
      },
      activeJob: activeJob ? this.serializeThreadKernelJob(activeJob, { includeLogs: options.includeLogs !== false }) : null,
      recentJobs
    };
  }

  async validateThreadKernelPreflight() {
    if (!fs.existsSync(THREAD_KERNEL_HELPER_PATH)) {
      const error = new Error('The HomeBrain Thread kernel helper has not been installed on this host yet.');
      error.status = 503;
      throw error;
    }

    const probe = runSync('sudo', ['-n', THREAD_KERNEL_HELPER_PATH, 'validate'], { timeout: 60_000 });
    const validation = parseJsonObjectFromOutput(probe.stdout || '');
    const status = await this.getThreadKernelStatus({ includeLogs: false, forceRefresh: true });
    if (!validation) {
      const fallbackValidation = buildThreadKernelValidationFallback(probe);
      return {
        success: false,
        validation: fallbackValidation,
        status: {
          ...status,
          validation: fallbackValidation
        }
      };
    }

    return {
      success: Boolean(validation.ok),
      validation,
      status
    };
  }

  createThreadKernelJob({ autoReboot, enableFullOtbrAfterReboot, networkName }) {
    const id = `thread-kernel-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const job = {
      id,
      status: 'queued',
      phase: 'queued',
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      error: null,
      autoReboot: Boolean(autoReboot),
      enableFullOtbrAfterReboot: enableFullOtbrAfterReboot !== false,
      networkName: normalizeString(networkName) || 'HomeBrain Thread',
      commandPreview: null,
      result: null,
      logs: []
    };
    this.threadKernelJobs.set(id, job);
    this.activeThreadKernelJobId = id;
    return job;
  }

  async startThreadKernelRebuild(payload = {}) {
    if (!isThreadKernelRebuildEnabled()) {
      const error = new Error('Automatic Jetson kernel rebuilds are disabled. HomeBrain will keep OTBR in the safe no-BBR fallback until a rollback-safe kernel installer is available.');
      error.status = 403;
      throw error;
    }

    if (!normalizeThreadKernelConfirmation(payload.confirmKernel || payload.confirm || payload.confirmRebuild)) {
      const error = new Error(`Type ${THREAD_KERNEL_CONFIRMATION} to rebuild and install a HomeBrain Thread kernel.`);
      error.status = 400;
      throw error;
    }
    const autoReboot = payload.autoReboot !== false;
    if (autoReboot && !normalizeThreadKernelRebootConfirmation(payload.confirmReboot || payload.rebootConfirmation)) {
      const error = new Error(`Type ${THREAD_KERNEL_REBOOT_CONFIRMATION} to let HomeBrain reboot after the kernel installs.`);
      error.status = 400;
      throw error;
    }
    if (!fs.existsSync(THREAD_KERNEL_HELPER_PATH)) {
      const error = new Error('The HomeBrain Thread kernel helper has not been installed on this host yet. Run setup-services refresh-privileges first.');
      error.status = 503;
      throw error;
    }
    if (this.activeThreadKernelJobId) {
      const active = this.threadKernelJobs.get(this.activeThreadKernelJobId);
      if (active && THREAD_KERNEL_ACTIVE_STATUSES.has(active.status)) {
        const error = new Error('A Thread kernel rebuild is already running.');
        error.status = 409;
        throw error;
      }
    }

    const config = await this.loadConfig();
    const networkName = normalizeString(payload.networkName || config.thread?.networkName) || 'HomeBrain Thread';
    const job = this.createThreadKernelJob({
      autoReboot,
      enableFullOtbrAfterReboot: payload.enableFullOtbrAfterReboot !== false,
      networkName
    });
    await this.persistThreadKernelJob(job);
    if (job.enableFullOtbrAfterReboot) {
      await this.writeThreadKernelPostRebootMarker({
        sourceJobId: job.id,
        networkName
      });
    }

    setImmediate(() => {
      this.runThreadKernelRebuildJob(job, payload).catch((error) => {
        this.failThreadKernelJob(job, error).catch(() => {});
      });
    });

    return this.serializeThreadKernelJob(job);
  }

  async runThreadKernelRebuildJob(job, payload = {}) {
    await this.updateThreadKernelJob(job, { status: 'preparing', phase: 'preparing' });

    const args = [
      '-n',
      THREAD_KERNEL_HELPER_PATH,
      'apply',
      '--job-id',
      job.id,
      '--confirm',
      THREAD_KERNEL_CONFIRMATION
    ];
    if (job.autoReboot) {
      args.push('--auto-reboot', '--reboot-confirm', THREAD_KERNEL_REBOOT_CONFIRMATION);
    }
    const jobs = toNumber(payload.jobs);
    if (jobs && jobs > 0) {
      args.push('--jobs', String(Math.round(jobs)));
    }
    if (payload.forceSources === true) {
      args.push('--force-sources');
    }

    job.commandPreview = args.join(' ');
    await this.updateThreadKernelJob(job, {
      status: 'building',
      phase: 'building-and-installing-kernel',
      commandPreview: job.commandPreview
    });

    await new Promise((resolve, reject) => {
      const child = spawn('sudo', args, {
        cwd: path.dirname(THREAD_KERNEL_HELPER_PATH),
        detached: true,
        stdio: 'ignore'
      });
      const timer = setTimeout(() => resolve(), 500);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('spawn', () => {
        clearTimeout(timer);
        child.unref();
        resolve();
      });
    });

    await this.monitorThreadKernelRebuildJob(job);
  }

  async monitorThreadKernelRebuildJob(job, options = {}) {
    const startedAt = Date.now();
    let helperSeen = options.recovered === true;

    while (Date.now() - startedAt < THREAD_KERNEL_BUILD_TIMEOUT_MS) {
      await this.refreshThreadKernelJobLogsFromHelper(job);
      const helperStatus = this.getThreadKernelHelperStatusSync();
      const processStatus = this.getThreadKernelHelperProcessStatus(job.id);
      const update = buildThreadKernelJobUpdateFromHelperStatus(job, helperStatus, {
        processRunning: processStatus.available ? processStatus.running : null
      });

      if (update) {
        helperSeen = true;
        await this.applyThreadKernelHelperJobUpdate(job, update);
        if (!THREAD_KERNEL_ACTIVE_STATUSES.has(update.status)) {
          return;
        }
      } else if (!helperSeen && Date.now() - startedAt >= THREAD_KERNEL_START_GRACE_MS) {
        throw new Error('Thread kernel helper did not start or did not record build state.');
      } else if (helperSeen && processStatus.available && !processStatus.running) {
        throw new Error('Thread kernel helper stopped before recording completion.');
      }

      await sleep(THREAD_KERNEL_MONITOR_INTERVAL_MS);
    }

    throw new Error(`Thread kernel helper timed out after ${Math.round(THREAD_KERNEL_BUILD_TIMEOUT_MS / 60000)} minutes`);
  }

  createThreadOtbrJob({ devicePath, baudRate, networkName, backboneRouterMode }) {
    const id = `thread-otbr-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const job = {
      id,
      status: 'queued',
      phase: 'queued',
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      error: null,
      devicePath,
      baudRate,
      radioUrl: buildOtbrRadioUrl(devicePath, baudRate),
      networkName,
      backboneRouterMode: normalizeThreadBackboneRouterMode(backboneRouterMode),
      logs: [],
      result: null
    };
    this.threadOtbrJobs.set(id, job);
    this.activeThreadOtbrJobId = id;
    return job;
  }

  serializeThreadOtbrJob(job, options = {}) {
    if (!job) {
      return null;
    }
    return {
      id: job.id,
      status: job.status,
      phase: job.phase,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      devicePath: job.devicePath,
      baudRate: job.baudRate,
      radioUrl: job.radioUrl,
      networkName: job.networkName,
      backboneRouterMode: job.backboneRouterMode,
      result: job.result,
      logs: options.includeLogs === false ? [] : job.logs.slice(-THREAD_OTBR_LOG_LIMIT)
    };
  }

  updateThreadOtbrJob(job, updates = {}) {
    Object.assign(job, updates, {
      updatedAt: new Date().toISOString()
    });
    return job;
  }

  appendThreadOtbrLog(job, stream, chunk) {
    String(chunk || '')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .forEach((line) => {
        job.logs.push({
          at: new Date().toISOString(),
          stream,
          line
        });
      });
    if (job.logs.length > THREAD_OTBR_LOG_LIMIT) {
      job.logs.splice(0, job.logs.length - THREAD_OTBR_LOG_LIMIT);
    }
    job.updatedAt = new Date().toISOString();
  }

  async startThreadBorderRouter(payload = {}) {
    if (!normalizeThreadOtbrConfirmation(payload.confirmOtbr || payload.confirm || payload.confirmStart)) {
      const error = new Error(`Type ${THREAD_OTBR_CONFIRMATION} to start HomeBrain-managed OTBR.`);
      error.status = 400;
      throw error;
    }

    if (this.activeThreadOtbrJobId) {
      const active = this.threadOtbrJobs.get(this.activeThreadOtbrJobId);
      if (active && ['queued', 'preparing', 'starting'].includes(active.status)) {
        const error = new Error('An OTBR start job is already running.');
        error.status = 409;
        throw error;
      }
    }

    const config = await this.loadConfig();
    const threadStatus = await this.getThreadStatus();
    const selectedPort = threadStatus.selectedPort;
    const devicePath = selectedPort?.path || selectedPort?.stablePath || selectedPort?.rawPath || '';
    if (!devicePath) {
      const error = new Error('No SONOFF MG24 Thread stick is selected.');
      error.status = 400;
      throw error;
    }

    const latestFirmware = threadStatus?.firmwareFlash?.latestFirmware?.firmware;
    const baudRate = normalizeThreadBaudRate(payload.baudRate || latestFirmware?.baudRate || '460800');
    const networkName = normalizeString(payload.networkName || config.thread?.networkName) || 'HomeBrain Thread';
    const backboneRouterMode = normalizeThreadBackboneRouterMode(payload.backboneRouterMode || payload.bbrMode);
    const job = this.createThreadOtbrJob({ devicePath, baudRate, networkName, backboneRouterMode });

    void this.runThreadBorderRouterJob(job).catch((error) => {
      this.updateThreadOtbrJob(job, {
        status: 'failed',
        phase: 'failed',
        finishedAt: new Date().toISOString(),
        error: error.message || 'OTBR start failed'
      });
      this.activeThreadOtbrJobId = null;
      this.lastThreadStatus = null;
    });

    return this.serializeThreadOtbrJob(job);
  }

  async runThreadBorderRouterJob(job) {
    this.updateThreadOtbrJob(job, { status: 'preparing', phase: 'preparing' });

    await new Promise((resolve, reject) => {
      const args = [
        '-n',
        THREAD_OTBR_HELPER_PATH,
        'start',
        '--device',
        job.devicePath,
        '--baud',
        job.baudRate,
        '--radio-url',
        job.radioUrl,
        '--network-name',
        job.networkName
      ];

      const child = spawn('sudo', args, {
        cwd: path.dirname(THREAD_OTBR_HELPER_PATH),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          HOMEBRAIN_OTBR_BACKBONE_ROUTER: job.backboneRouterMode || 'auto'
        }
      });
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`OTBR helper timed out after ${Math.round(THREAD_OTBR_START_TIMEOUT_MS / 1000)} seconds`));
      }, THREAD_OTBR_START_TIMEOUT_MS);

      this.updateThreadOtbrJob(job, { status: 'starting', phase: 'starting' });
      child.stdout.on('data', (chunk) => this.appendThreadOtbrLog(job, 'stdout', chunk));
      child.stderr.on('data', (chunk) => this.appendThreadOtbrLog(job, 'stderr', chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`OTBR helper exited with ${signal || `code ${code}`}`));
      });
    });

    const config = await this.loadConfig();
    let otbr = await this.checkOtbrRest(config.otbrRestUrl);
    for (let attempt = 0; attempt < 10 && (!otbr.online || !otbr.dataset); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      otbr = await this.checkOtbrRest(config.otbrRestUrl);
    }

    const otbrHost = await this.getThreadOtbrHostStatus({ includeLogs: false });
    const hasDataset = Boolean(otbr.dataset || otbrHost.dataset);
    const attached = isThreadOtbrAttachedState(otbrHost.state);
    const completed = Boolean(otbr.online && hasDataset && attached);
    const failureReason = !otbr.online
      ? 'OTBR started, but the REST API is not responding.'
      : !hasDataset
        ? 'OTBR started, but HomeBrain could not read an active Thread dataset from OTBR.'
        : `OTBR has a dataset, but OpenThread is ${otbrHost.state || 'not attached'} instead of leader/router/child.`;
    this.updateThreadOtbrJob(job, {
      status: completed ? 'completed' : 'failed',
      phase: completed ? 'completed' : 'failed',
      finishedAt: new Date().toISOString(),
      error: completed ? null : failureReason,
      result: {
        otbr,
        otbrHost
      }
    });
    this.activeThreadOtbrJobId = null;
    this.lastThreadStatus = null;

    if (!job.error && !this.controller) {
      await this.ensureControllerIfConfigured();
    }
  }

  createThreadFirmwareFlashJob(devicePath, tool) {
    const id = `thread-flash-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const job = {
      id,
      status: 'queued',
      phase: 'queued',
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      error: null,
      devicePath,
      firmware: null,
      commandPreview: null,
      tool: {
        available: Boolean(tool.available),
        canAutoInstall: Boolean(tool.canAutoInstall),
        label: tool.label || 'HomeBrain managed universal-silabs-flasher',
        source: tool.source || 'managed-venv',
        docsUrl: tool.docsUrl || UNIVERSAL_SILABS_FLASHER_REPO_URL
      },
      logs: []
    };
    this.threadFirmwareFlashJobs.set(id, job);
    this.activeThreadFirmwareFlashJobId = id;
    return job;
  }

  redactThreadFirmwareFlashJob(job, options = {}) {
    if (!job) {
      return null;
    }
    return {
      id: job.id,
      status: job.status,
      phase: job.phase,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      devicePath: job.devicePath,
      firmware: job.firmware,
      commandPreview: job.commandPreview,
      tool: job.tool,
      logs: options.includeLogs === false ? [] : job.logs.slice(-THREAD_FLASH_LOG_LIMIT)
    };
  }

  async persistThreadFirmwareFlashJob(job) {
    if (!job?.id) {
      return;
    }
    try {
      await this.ensureDataDir();
      await fsp.writeFile(
        path.join(THREAD_FLASH_JOBS_DIR, `${job.id}.json`),
        JSON.stringify(this.redactThreadFirmwareFlashJob(job), null, 2)
      );
    } catch (error) {
      console.warn(`MatterService: Failed to persist Thread firmware flash job: ${error.message}`);
    }
  }

  async loadThreadFirmwareFlashJobs(options = {}) {
    if (this.threadFirmwareFlashJobsLoaded && !options.forceRefresh) {
      return;
    }

    await this.ensureDataDir();
    let entries = [];
    try {
      entries = await fsp.readdir(THREAD_FLASH_JOBS_DIR, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`MatterService: Failed to list Thread firmware flash jobs: ${error.message}`);
      }
      this.threadFirmwareFlashJobsLoaded = true;
      return;
    }

    const interruptedJobs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(THREAD_FLASH_JOBS_DIR, entry.name);
      try {
        const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
        const job = normalizePersistedThreadFirmwareFlashJob(parsed);
        if (!job) {
          continue;
        }
        if (THREAD_FLASH_ACTIVE_STATUSES.has(job.status)) {
          job.status = 'failed';
          job.phase = 'failed';
          job.finishedAt = job.finishedAt || new Date().toISOString();
          job.error = job.error || 'HomeBrain restarted before this firmware flash job completed.';
          interruptedJobs.push(job);
        }
        this.threadFirmwareFlashJobs.set(job.id, job);
      } catch (error) {
        console.warn(`MatterService: Failed to load Thread firmware flash job ${entry.name}: ${error.message}`);
      }
    }

    this.activeThreadFirmwareFlashJobId = Array.from(this.threadFirmwareFlashJobs.values())
      .find((job) => THREAD_FLASH_ACTIVE_STATUSES.has(job.status))?.id || null;
    this.threadFirmwareFlashJobsLoaded = true;

    await Promise.all(interruptedJobs.map((job) => this.persistThreadFirmwareFlashJob(job)));
  }

  appendThreadFirmwareFlashLog(job, streamName, chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .forEach((line) => {
        job.logs.push({
          at: new Date().toISOString(),
          stream: streamName,
          line: line.slice(0, 1000)
        });
      });
    if (job.logs.length > THREAD_FLASH_LOG_LIMIT) {
      job.logs.splice(0, job.logs.length - THREAD_FLASH_LOG_LIMIT);
    }
    job.updatedAt = new Date().toISOString();
  }

  async updateThreadFirmwareFlashJob(job, updates = {}) {
    Object.assign(job, updates, {
      updatedAt: new Date().toISOString()
    });
    await this.persistThreadFirmwareFlashJob(job);
  }

  async fetchSonoffFirmwareManifest(options = {}) {
    const now = Date.now();
    if (
      !options.forceRefresh
      && this.sonoffFirmwareManifestCache
      && now - this.sonoffFirmwareManifestCache.fetchedAt < 5 * 60_000
    ) {
      return this.sonoffFirmwareManifestCache;
    }

    const response = await axios.get(SONOFF_FIRMWARE_MANIFEST_URL, {
      timeout: 15000,
      validateStatus: (status) => status >= 200 && status < 300,
      params: {
        timeStamp: Date.now()
      }
    });
    const firmwareList = Array.isArray(response.data?.firmwareList)
      ? response.data.firmwareList
      : [];
    if (firmwareList.length === 0) {
      const error = new Error('SONOFF firmware manifest did not include firmware entries.');
      error.status = 502;
      throw error;
    }

    this.sonoffFirmwareManifestCache = {
      sourceUrl: SONOFF_FIRMWARE_MANIFEST_URL,
      fetchedAt: now,
      firmwareList
    };
    return this.sonoffFirmwareManifestCache;
  }

  async getLatestThreadFirmwareForPort(port, options = {}) {
    const target = inferSonoffThreadFirmwareTarget(port);
    if (!target) {
      return {
        available: false,
        error: 'The selected serial device is not a verified SONOFF MG24 Thread stick.',
        target: null,
        firmware: null,
        manifest: {
          sourceUrl: SONOFF_FIRMWARE_MANIFEST_URL,
          fetchedAt: null
        }
      };
    }

    try {
      const manifest = await this.fetchSonoffFirmwareManifest(options);
      const firmware = selectLatestSonoffThreadFirmware(manifest.firmwareList, target);
      if (!firmware) {
        return {
          available: false,
          error: `No ${target.firmwareType} firmware was found for ${target.dongleType}.`,
          target,
          firmware: null,
          manifest: {
            sourceUrl: manifest.sourceUrl,
            fetchedAt: new Date(manifest.fetchedAt).toISOString()
          }
        };
      }

      return {
        available: true,
        error: null,
        target,
        firmware,
        manifest: {
          sourceUrl: manifest.sourceUrl,
          fetchedAt: new Date(manifest.fetchedAt).toISOString()
        },
        verification: {
          selectedPath: port?.path || port?.stablePath || port?.rawPath || null,
          serialNumber: port?.serialNumber || null,
          pnpId: port?.pnpId || null,
          evidence: target.evidence || []
        }
      };
    } catch (error) {
      return {
        available: false,
        error: error.message || 'Unable to check the SONOFF firmware manifest.',
        target,
        firmware: null,
        manifest: {
          sourceUrl: SONOFF_FIRMWARE_MANIFEST_URL,
          fetchedAt: null
        }
      };
    }
  }

  async resolveThreadFirmwareImage(payload = {}, jobDir, selectedPort = null, latestFirmware = null) {
    const firmwareUrl = normalizeString(payload.firmwareUrl);
    const firmwareBase64 = normalizeString(payload.firmwareBase64);
    if (firmwareUrl) {
      const error = new Error('Firmware URL downloads are not supported. Let HomeBrain download the official latest firmware, or upload a local .gbl file.');
      error.status = 400;
      throw error;
    }
    const automaticFirmware = !firmwareBase64
      ? (latestFirmware || await this.getLatestThreadFirmwareForPort(selectedPort, { forceRefresh: true }))
      : null;

    if (automaticFirmware) {
      if (automaticFirmware && !automaticFirmware.available) {
        const error = new Error(automaticFirmware.error || 'Unable to resolve the latest SONOFF OpenThread firmware for this stick.');
        error.status = 502;
        throw error;
      }
      const effectiveFirmwareUrl = automaticFirmware?.firmware?.url;
      if (!effectiveFirmwareUrl || !isTrustedSonoffFirmwareUrl(effectiveFirmwareUrl)) {
        const error = new Error('The SONOFF firmware manifest returned an untrusted firmware URL.');
        error.status = 502;
        throw error;
      }
      const fileName = automaticFirmware?.firmware?.name || firmwareNameFromUrl(effectiveFirmwareUrl);
      const response = await axios.get(effectiveFirmwareUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxRedirects: 0,
        maxContentLength: THREAD_FLASH_MAX_FIRMWARE_BYTES,
        maxBodyLength: THREAD_FLASH_MAX_FIRMWARE_BYTES,
        validateStatus: (status) => status >= 200 && status < 300
      });
      const buffer = Buffer.from(response.data);
      if (buffer.length <= 0 || buffer.length > THREAD_FLASH_MAX_FIRMWARE_BYTES) {
        const error = new Error('Firmware image is empty or exceeds the configured size limit.');
        error.status = 400;
        throw error;
      }
      const firmwarePath = path.join(jobDir, fileName);
      await fsp.writeFile(firmwarePath, buffer);
      return {
        path: firmwarePath,
        name: fileName,
        size: buffer.length,
        source: 'sonoff-latest',
        url: effectiveFirmwareUrl,
        version: automaticFirmware?.firmware?.version || null,
        sdkVersion: automaticFirmware?.firmware?.sdkVersion || null,
        firmwareType: automaticFirmware?.firmware?.firmwareType || null,
        firmwareDesc: automaticFirmware?.firmware?.firmwareDesc || null,
        target: automaticFirmware?.target || null,
        verification: automaticFirmware?.verification || null
      };
    }

    let encoded = firmwareBase64;
    const dataUrlMatch = encoded.match(/^data:[^,]+,(.+)$/);
    if (dataUrlMatch) {
      encoded = dataUrlMatch[1];
    }
    encoded = encoded.replace(/\s/g, '');
    if (!/^[a-z0-9+/=]+$/i.test(encoded)) {
      const error = new Error('Firmware upload was not valid base64.');
      error.status = 400;
      throw error;
    }
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.length <= 0 || buffer.length > THREAD_FLASH_MAX_FIRMWARE_BYTES) {
      const error = new Error('Firmware image is empty or exceeds the configured size limit.');
      error.status = 400;
      throw error;
    }
    const fileName = sanitizeFirmwareFileName(payload.firmwareName);
    const firmwarePath = path.join(jobDir, fileName);
    await fsp.writeFile(firmwarePath, buffer);
    return {
      path: firmwarePath,
      name: fileName,
      size: buffer.length,
      source: 'upload'
    };
  }

  async runThreadFirmwareFlashCommand(job, command, args, options = {}) {
    this.appendThreadFirmwareFlashLog(job, 'system', `$ ${[command, ...args].join(' ')}`);
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd || MATTER_DATA_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PIP_DISABLE_PIP_VERSION_CHECK: '1'
        }
      });

      child.stdout.on('data', (chunk) => this.appendThreadFirmwareFlashLog(job, 'stdout', chunk));
      child.stderr.on('data', (chunk) => this.appendThreadFirmwareFlashLog(job, 'stderr', chunk));
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`${command} exited with ${signal || `code ${code}`}`));
      });
    });
  }

  async installThreadFirmwareFlashTool(job) {
    await this.updateThreadFirmwareFlashJob(job, {
      status: 'preparing',
      phase: 'installing-universal-silabs-flasher'
    });

    const pythonBin = process.env.PYTHON_BIN || 'python3';
    await this.runThreadFirmwareFlashCommand(job, pythonBin, ['-m', 'venv', THREAD_FLASH_MANAGED_VENV_DIR], {
      cwd: MATTER_DATA_DIR
    });

    const managedPython = path.join(
      THREAD_FLASH_MANAGED_VENV_DIR,
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    );
    await this.runThreadFirmwareFlashCommand(
      job,
      managedPython,
      ['-m', 'pip', 'install', '--upgrade', 'pip', 'universal-silabs-flasher'],
      { cwd: MATTER_DATA_DIR }
    );

    this.threadFirmwareFlashToolCache = null;
    const tool = this.getThreadFirmwareFlashTool({ forceRefresh: true });
    if (!tool.available) {
      const error = new Error('HomeBrain installed universal-silabs-flasher, but the flasher command is still unavailable.');
      error.status = 503;
      throw error;
    }
    await this.updateThreadFirmwareFlashJob(job, {
      tool: {
        available: true,
        canAutoInstall: true,
        label: tool.label,
        source: tool.source,
        docsUrl: tool.docsUrl || UNIVERSAL_SILABS_FLASHER_REPO_URL
      }
    });
    return tool;
  }

  getThreadFirmwareFlashTool(options = {}) {
    const now = Date.now();
    if (
      !options.forceRefresh
      && this.threadFirmwareFlashToolCache
      && now - this.threadFirmwareFlashToolCache.checkedAt < 30_000
    ) {
      return this.threadFirmwareFlashToolCache.tool;
    }
    const tool = resolveThreadFirmwareFlashTool();
    this.threadFirmwareFlashToolCache = {
      checkedAt: now,
      tool
    };
    return tool;
  }

  async getThreadFirmwareFlashStatus(options = {}) {
    await this.loadThreadFirmwareFlashJobs();
    const tool = this.getThreadFirmwareFlashTool(options);
    const jobs = Array.from(this.threadFirmwareFlashJobs.values())
      .sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
    const activeJob = this.activeThreadFirmwareFlashJobId
      ? this.threadFirmwareFlashJobs.get(this.activeThreadFirmwareFlashJobId)
      : null;
    const latestFirmware = options.selectedPort
      ? await this.getLatestThreadFirmwareForPort(options.selectedPort, options)
      : null;
    return {
      confirmationPhrase: THREAD_FLASH_CONFIRMATION,
      maxFirmwareBytes: THREAD_FLASH_MAX_FIRMWARE_BYTES,
      tool,
      latestFirmware,
      activeJob: this.redactThreadFirmwareFlashJob(activeJob, options),
      recentJobs: jobs.slice(0, 5).map((job) => this.redactThreadFirmwareFlashJob(job, options))
    };
  }

  async startThreadFirmwareFlash(payload = {}) {
    if (!normalizeThreadFirmwareFlashConfirmation(payload.confirmFlash || payload.confirmation)) {
      const error = new Error(`Type ${THREAD_FLASH_CONFIRMATION} to confirm Thread firmware flashing.`);
      error.status = 400;
      throw error;
    }
    const firmwareUrl = normalizeString(payload.firmwareUrl);
    const firmwareBase64 = normalizeString(payload.firmwareBase64);
    if (firmwareUrl) {
      const error = new Error('Firmware URL downloads are not supported. Let HomeBrain download the official latest firmware, or upload a local .gbl file.');
      error.status = 400;
      throw error;
    }
    if (firmwareBase64) {
      sanitizeFirmwareFileName(payload.firmwareName);
    }

    const activeJob = this.activeThreadFirmwareFlashJobId
      ? this.threadFirmwareFlashJobs.get(this.activeThreadFirmwareFlashJobId)
      : null;
    if (activeJob && ['queued', 'preparing', 'flashing'].includes(activeJob.status)) {
      const error = new Error('A Thread firmware flash is already running.');
      error.status = 409;
      throw error;
    }

    const threadStatus = await this.getThreadStatus();
    const selectedPort = threadStatus.selectedPort;
    if (!selectedPort?.isExpectedMatterThreadStick) {
      const error = new Error('Select a detected SONOFF MG24 Thread stick before flashing firmware.');
      error.status = 400;
      throw error;
    }
    const devicePath = selectedPort.path || selectedPort.stablePath || selectedPort.rawPath || selectedPort.realPath;
    if (!devicePath) {
      const error = new Error('The selected Thread stick does not expose a usable serial path.');
      error.status = 400;
      throw error;
    }
    const latestFirmware = !firmwareBase64
      ? await this.getLatestThreadFirmwareForPort(selectedPort, { forceRefresh: true })
      : null;
    if (latestFirmware && !latestFirmware.available) {
      const error = new Error(latestFirmware.error || 'Unable to resolve the latest SONOFF OpenThread firmware for this stick.');
      error.status = 502;
      throw error;
    }

    const tool = this.getThreadFirmwareFlashTool({ forceRefresh: true });

    const job = this.createThreadFirmwareFlashJob(devicePath, tool);
    await this.persistThreadFirmwareFlashJob(job);
    setImmediate(() => {
      this.runThreadFirmwareFlashJob(job, payload, selectedPort, devicePath, tool, latestFirmware).catch((error) => {
        this.updateThreadFirmwareFlashJob(job, {
          status: 'failed',
          phase: 'failed',
          error: error.message,
          finishedAt: new Date().toISOString()
        }).catch(() => {});
        this.activeThreadFirmwareFlashJobId = null;
      });
    });

    return this.redactThreadFirmwareFlashJob(job);
  }

  async runThreadFirmwareFlashJob(job, payload, selectedPort, devicePath, tool, latestFirmware = null) {
    let effectiveTool = tool;
    if (!effectiveTool.available) {
      effectiveTool = await this.installThreadFirmwareFlashTool(job);
    }

    await this.updateThreadFirmwareFlashJob(job, {
      status: 'preparing',
      phase: 'writing-firmware-image'
    });
    const jobDir = path.join(THREAD_FLASH_JOBS_DIR, job.id);
    await fsp.mkdir(jobDir, { recursive: true });
    const firmware = await this.resolveThreadFirmwareImage(payload, jobDir, selectedPort, latestFirmware);
    const flashCommand = buildThreadFirmwareFlashCommand(effectiveTool, {
      devicePath,
      firmwarePath: firmware.path,
      verbose: true
    });

    await this.updateThreadFirmwareFlashJob(job, {
      status: 'flashing',
      phase: 'running-universal-silabs-flasher',
      firmware: {
        name: firmware.name,
        size: firmware.size,
        source: firmware.source,
        url: firmware.url || null,
        version: firmware.version || null,
        sdkVersion: firmware.sdkVersion || null,
        firmwareType: firmware.firmwareType || null,
        firmwareDesc: firmware.firmwareDesc || null,
        target: firmware.target || null,
        verification: firmware.verification || null
      },
      commandPreview: [
        flashCommand.command,
        ...flashCommand.args.map((arg) => arg === firmware.path ? firmware.name : arg)
      ].join(' ')
    });

    await new Promise((resolve, reject) => {
      const child = spawn(flashCommand.command, flashCommand.args, {
        cwd: jobDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      child.stdout.on('data', (chunk) => this.appendThreadFirmwareFlashLog(job, 'stdout', chunk));
      child.stderr.on('data', (chunk) => this.appendThreadFirmwareFlashLog(job, 'stderr', chunk));
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`universal-silabs-flasher exited with ${signal || `code ${code}`}`));
      });
    });

    await this.updateThreadFirmwareFlashJob(job, {
      status: 'completed',
      phase: 'completed',
      finishedAt: new Date().toISOString()
    });
    this.activeThreadFirmwareFlashJobId = null;
    this.lastThreadStatus = null;
  }

  async getThreadStatus(options = {}) {
    const config = await this.loadConfig();
    const serialPorts = options.refreshPorts === false
      ? this.detectedSerialPorts
      : await this.detectSerialPorts();
    if (options.refreshPorts !== false) {
      this.detectedSerialPorts = serialPorts;
    }

    const expectedPorts = serialPorts.filter((port) => port.isExpectedMatterThreadStick);
    const selectedPort = expectedPorts.find((port) => serialPortMatchesPath(port, config.preferredThreadPort))
      || expectedPorts[0]
      || null;
    const firmwareFlash = await this.getThreadFirmwareFlashStatus({
      includeLogs: false,
      selectedPort
    });
    const otbrHost = await this.getThreadOtbrHostStatus({
      includeLogs: false,
      selectedPort
    });
    const threadKernel = await this.getThreadKernelStatus({
      includeLogs: false
    });
    const otbr = await this.checkOtbrRest(config.otbrRestUrl);
    const activeDataset = resolveThreadActiveDataset({
      configuredDataset: config.thread?.operationalDataset,
      otbrDataset: otbr.dataset,
      hostDataset: otbrHost.dataset
    });
    const setup = buildThreadSetupGuidance({
      expectedPorts,
      selectedPort,
      otbr,
      otbrHost,
      threadKernel,
      activeDataset: activeDataset.dataset,
      firmwareFlash
    });
    const otbrAttached = isThreadOtbrAttachedState(otbrHost.state);

    const status = {
      hardware: MATTER_CONTROLLER_HARDWARE,
      rcpDetected: expectedPorts.length > 0,
      selectedPort,
      expectedPorts,
      serialPorts,
      otbr: {
        restUrl: otbr.baseUrl,
        online: otbr.online,
        datasetEndpoint: otbr.endpoint,
        dataset: activeDataset.dataset,
        hasActiveDataset: Boolean(activeDataset.dataset),
        activeDatasetSource: activeDataset.source,
        attached: otbrAttached,
        state: otbrHost.state || ''
      },
      otbrHost,
      kernel: threadKernel,
      readyForThreadCommissioning: Boolean(expectedPorts.length > 0 && activeDataset.dataset && otbr.online && otbrAttached),
      setup,
      firmwareFlash,
      manualSteps: buildManualSteps({
        transport: MATTER_TRANSPORTS.thread,
        hasThreadDataset: Boolean(activeDataset.dataset),
        hasBle: this.isBleRuntimeAvailable()
      })
    };

    this.lastThreadStatus = status;
    return status;
  }

  isBleRuntimeAvailable() {
    try {
      require.resolve('@matter/nodejs-ble');
      return true;
    } catch (_error) {
      return false;
    }
  }

  loadMatterRuntime() {
    if (this.runtime) {
      return this.runtime;
    }

    const runtime = {};
    runtime.Environment = require('@matter/main').Environment;
    runtime.StorageService = require('@matter/main').StorageService;
    runtime.singleton = require('@matter/main').singleton;
    runtime.GeneralCommissioning = require('@matter/main/clusters').GeneralCommissioning;
    runtime.clusters = require('@matter/main/clusters');
    runtime.types = require('@matter/main/types');
    runtime.NodeJsEnvironment = require('@matter/nodejs').NodeJsEnvironment;
    runtime.CommissioningController = require('@project-chip/matter.js').CommissioningController;
    try {
      runtime.NodeJsBle = require('@matter/nodejs-ble').NodeJsBle;
      runtime.Ble = require('@matter/main/protocol').Ble;
    } catch (error) {
      runtime.bleError = error.message;
    }

    this.runtime = runtime;
    return this.runtime;
  }

  async ensureController() {
    const config = await this.loadConfig();
    if (!config.enabled) {
      throw new Error('Matter support is disabled in HomeBrain settings');
    }
    if (this.controller) {
      return this.controller;
    }
    if (this.controllerStartPromise) {
      return this.controllerStartPromise;
    }

    this.controllerStartPromise = (async () => {
      try {
        const controller = await this.createMatterController(config);
        this.controller = controller;
        this.controllerError = null;
        return controller;
      } catch (error) {
        const recovery = await this.recoverMatterControllerStoreIfSafe(config, error);
        if (!recovery?.attempted) {
          throw error;
        }

        this.controllerRecovery = recovery;
        try {
          this.runtime = null;
          const controller = await this.createMatterController(config);
          this.controller = controller;
          this.controllerError = null;
          this.startError = null;
          return controller;
        } catch (retryError) {
          retryError.recovery = recovery;
          throw retryError;
        }
      }
    })();

    try {
      return await this.controllerStartPromise;
    } finally {
      this.controllerStartPromise = null;
    }
  }

  async createMatterController(config) {
    const runtime = this.loadMatterRuntime();
    await fsp.mkdir(config.storagePath, { recursive: true });
    const environment = runtime.NodeJsEnvironment();
    environment.vars.set('storage.path', config.storagePath);
    environment.get(runtime.StorageService).location = config.storagePath;

    if (runtime.NodeJsBle && runtime.Ble) {
      runtime.Ble.get = runtime.singleton(() => new runtime.NodeJsBle({ environment }));
    }

    let controller = null;
    try {
      controller = new runtime.CommissioningController({
        environment: {
          environment,
          id: MATTER_CONTROLLER_ID
        },
        autoConnect: false,
        adminFabricLabel: config.adminFabricLabel,
        adminVendorId: config.adminVendorId,
        adminFabricId: BigInt(config.adminFabricId),
        basicInformation: {
          nodeLabel: 'HomeBrain',
          productName: 'HomeBrain Matter Controller',
          vendorName: 'HomeBrain',
          productId: 0x8001,
          hardwareVersion: 1,
          hardwareVersionString: '1.0',
          softwareVersion: 1,
          softwareVersionString: process.env.npm_package_version || '1.0.0'
        }
      });

      await controller.start();
      this.controllerRecovery = null;
      return controller;
    } catch (error) {
      if (controller && typeof controller.close === 'function') {
        try {
          await controller.close();
        } catch (_closeError) {
          // The original startup error is more useful here.
        }
      }
      throw error;
    }
  }

  async recoverMatterControllerStoreIfSafe(config, error) {
    const controllerStorePath = path.join(config.storagePath, MATTER_CONTROLLER_ID);
    const exists = await pathExists(controllerStorePath);
    if (!exists) {
      return {
        attempted: false,
        reason: 'controller-store-missing',
        error: serializeMatterControllerError(error)
      };
    }

    const entries = await listMatterControllerStoreEntries(controllerStorePath);
    let matterDeviceCount = 0;
    try {
      matterDeviceCount = await Device.countDocuments({
        $or: [
          { 'properties.source': MATTER_SOURCE },
          { 'properties.matter.nodeId': { $exists: true, $ne: '' } }
        ]
      });
    } catch (countError) {
      return {
        attempted: false,
        reason: 'matter-device-count-unavailable',
        entryCount: entries.length,
        error: serializeMatterControllerError(error),
        countError: serializeMatterControllerError(countError)
      };
    }
    if (matterDeviceCount > 0 || matterControllerStoreMayContainPairedNodes(entries)) {
      return {
        attempted: false,
        reason: 'controller-store-may-contain-commissioned-nodes',
        matterDeviceCount,
        entryCount: entries.length,
        error: serializeMatterControllerError(error)
      };
    }

    const backupPath = `${controllerStorePath}.failed-${timestampForPath()}`;
    await fsp.rename(controllerStorePath, backupPath);
    return {
      attempted: true,
      reason: 'controller-start-failed-empty-store-backed-up',
      backupPath,
      entryCount: entries.length,
      error: serializeMatterControllerError(error)
    };
  }

  parseSetupPayload(payload = {}) {
    const runtime = this.loadMatterRuntime();
    const setupCode = normalizeString(payload.setupCode || payload.manualCode || payload.qrCode || payload.pairingCode);
    const manualCode = normalizeString(payload.manualCode);
    const qrCode = normalizeString(payload.qrCode);
    const passcode = toNumber(payload.passcode);
    const discriminator = toNumber(payload.discriminator);
    const parsed = {
      passcode,
      longDiscriminator: discriminator,
      shortDiscriminator: null,
      discoveryCapabilities: {},
      vendorId: toNumber(payload.vendorId),
      productId: toNumber(payload.productId),
      pairingCode: setupCode
    };

    if (qrCode || setupCode.startsWith('MT:')) {
      const decoded = runtime.types.QrPairingCodeCodec.decode(qrCode || setupCode);
      const entry = Array.isArray(decoded) ? decoded[0] : decoded;
      parsed.passcode = toNumber(entry.passcode);
      parsed.longDiscriminator = toNumber(entry.discriminator);
      parsed.vendorId = toNumber(entry.vendorId);
      parsed.productId = toNumber(entry.productId);
      parsed.discoveryCapabilities = entry.discoveryCapabilities || {};
      return parsed;
    }

    if (manualCode || setupCode) {
      const decoded = runtime.types.ManualPairingCodeCodec.decode(manualCode || setupCode);
      parsed.passcode = toNumber(decoded.passcode);
      parsed.shortDiscriminator = toNumber(decoded.shortDiscriminator);
      parsed.vendorId = toNumber(decoded.vendorId);
      parsed.productId = toNumber(decoded.productId);
      return parsed;
    }

    return parsed;
  }

  async updateConfig(update = {}) {
    const config = await this.loadConfig();
    const nextConfig = {
      ...config,
      enabled: typeof update.enabled === 'boolean' ? update.enabled : config.enabled,
      adminFabricLabel: normalizeString(update.adminFabricLabel) || config.adminFabricLabel,
      otbrRestUrl: config.otbrRestUrl,
      preferredThreadPort: normalizeString(update.preferredThreadPort) || config.preferredThreadPort,
      autoStartController: typeof update.autoStartController === 'boolean' ? update.autoStartController : config.autoStartController,
      thread: {
        ...config.thread,
        networkName: normalizeString(update.threadNetworkName ?? update.networkName) || config.thread.networkName,
        operationalDataset: normalizeString(update.threadOperationalDataset ?? update.operationalDataset)
          || config.thread.operationalDataset
      },
      wifi: {
        ...config.wifi,
        ssid: normalizeString(update.wifiSsid ?? update.ssid) || config.wifi.ssid,
        credentials: normalizeString(update.wifiCredentials ?? update.credentials) || config.wifi.credentials
      }
    };

    this.config = nextConfig;
    await this.saveConfig();
    return stripSensitiveConfig(this.config);
  }

  getCommissioningSessions() {
    return this.sessions.map(redactSession);
  }

  getSession(sessionId) {
    return this.sessions.find((session) => session.id === sessionId) || null;
  }

  async updateSession(sessionId, updates) {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }
    Object.assign(session, updates, { updatedAt: new Date().toISOString() });
    await this.saveSessions();
    return session;
  }

  async startCommissioning(payload = {}) {
    await this.start();
    const config = await this.loadConfig();
    const transport = normalizeTransport(payload.transport);
    const threadStatus = transport === MATTER_TRANSPORTS.thread
      ? await this.getThreadStatus()
      : this.lastThreadStatus;
    const hasThreadDataset = Boolean(
      normalizeString(payload.threadOperationalDataset)
      || normalizeString(config.thread.operationalDataset)
      || threadStatus?.otbr?.hasActiveDataset
    );
    const hasBle = this.isBleRuntimeAvailable();
    const session = {
      id: createSessionId(),
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodeId: null,
      deviceId: null,
      error: null,
      request: {
        transport,
        knownAddress: normalizeString(payload.knownAddress),
        setupCode: normalizeString(payload.setupCode || payload.manualCode || payload.qrCode || payload.pairingCode),
        room: normalizeString(payload.room) || 'Unassigned',
        name: normalizeString(payload.name),
        wifiSsid: normalizeString(payload.wifiSsid),
        wifiCredentials: normalizeString(payload.wifiCredentials),
        threadNetworkName: normalizeString(payload.threadNetworkName),
        threadOperationalDataset: normalizeString(payload.threadOperationalDataset)
      },
      manualSteps: buildManualSteps({ transport, hasThreadDataset, hasBle }),
      warnings: []
    };

    if (!session.request.setupCode && toNumber(payload.passcode) === null) {
      session.status = 'action_required';
      session.error = 'Matter setup code or passcode is required.';
    }
    if (transport === MATTER_TRANSPORTS.thread && !hasThreadDataset) {
      session.warnings.push('No Thread operational dataset is available yet. Start OTBR or paste the active dataset before commissioning Thread devices.');
    }
    if ([MATTER_TRANSPORTS.thread, MATTER_TRANSPORTS.wifi, MATTER_TRANSPORTS.ble].includes(transport) && !hasBle) {
      session.warnings.push('Bluetooth commissioning support is not available. Matter-over-IP commissioning can still work for devices already on the LAN.');
    }

    this.sessions.unshift(session);
    await this.saveSessions();

    if (session.status !== 'action_required') {
      void this.runCommissioningSession(session.id, payload).catch((error) => {
        this.updateSession(session.id, {
          status: 'failed',
          error: error.message
        }).catch((saveError) => {
          console.warn(`MatterService: Failed to persist commissioning failure: ${saveError.message}`);
        });
      });
    }

    return redactSession(session);
  }

  async runCommissioningSession(sessionId, payload = {}) {
    await this.updateSession(sessionId, { status: 'commissioning', error: null });
    const parsed = this.parseSetupPayload(payload);
    if (!Number.isFinite(parsed.passcode)) {
      throw new Error('Matter passcode could not be read from the setup code');
    }

    const config = await this.loadConfig();
    const transport = normalizeTransport(payload.transport);
    const controller = await this.ensureController();
    const runtime = this.loadMatterRuntime();
    const threadStatus = transport === MATTER_TRANSPORTS.thread ? await this.getThreadStatus() : null;
    const threadOperationalDataset = normalizeString(payload.threadOperationalDataset)
      || normalizeString(config.thread.operationalDataset)
      || normalizeString(threadStatus?.otbr?.hasActiveDataset ? await this.getThreadOperationalDataset() : '');
    const threadNetworkName = normalizeString(payload.threadNetworkName)
      || normalizeString(config.thread.networkName)
      || 'HomeBrain Thread';
    const wifiSsid = normalizeString(payload.wifiSsid) || normalizeString(config.wifi.ssid);
    const wifiCredentials = normalizeString(payload.wifiCredentials) || normalizeString(config.wifi.credentials);
    const knownAddress = parseKnownAddress(payload.knownAddress || payload.ipAddress, toNumber(payload.port) || 5540);
    const commissioning = {
      regulatoryLocation: runtime.GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
      regulatoryCountryCode: normalizeString(payload.countryCode).slice(0, 2).toUpperCase() || 'US'
    };

    if (transport === MATTER_TRANSPORTS.thread && threadOperationalDataset) {
      commissioning.threadNetwork = {
        networkName: threadNetworkName,
        operationalDataset: threadOperationalDataset
      };
    }
    if (transport === MATTER_TRANSPORTS.wifi && wifiSsid && wifiCredentials) {
      commissioning.wifiNetwork = {
        wifiSsid,
        wifiCredentials
      };
    }

    const identifierData = {};
    if (parsed.longDiscriminator !== null && parsed.longDiscriminator !== undefined) {
      identifierData.longDiscriminator = parsed.longDiscriminator;
    } else if (parsed.shortDiscriminator !== null && parsed.shortDiscriminator !== undefined) {
      identifierData.shortDiscriminator = parsed.shortDiscriminator;
    }
    if (parsed.vendorId !== null && parsed.vendorId !== undefined) {
      identifierData.vendorId = parsed.vendorId;
    }
    if (parsed.productId !== null && parsed.productId !== undefined) {
      identifierData.productId = parsed.productId;
    }

    const discoveryCapabilities = {
      ...(parsed.discoveryCapabilities || {}),
      ble: [MATTER_TRANSPORTS.thread, MATTER_TRANSPORTS.wifi, MATTER_TRANSPORTS.ble].includes(transport)
    };
    const nodeOptions = {
      commissioning,
      discovery: {
        identifierData,
        knownAddress: knownAddress || undefined,
        discoveryCapabilities,
        timeout: DEFAULT_COMMISSIONING_TIMEOUT_SECONDS
      },
      passcode: parsed.passcode,
      autoSubscribe: true
    };

    const nodeId = await controller.commissionNode(nodeOptions, {
      connectNodeAfterCommissioning: true
    });
    const nodeIdText = normalizeMatterNodeId(nodeId);
    await this.updateSession(sessionId, { status: 'syncing', nodeId: nodeIdText });
    const node = await controller.getNode(nodeId);
    if (!node.isConnected) {
      node.connect({ autoSubscribe: true });
    }
    if (!node.initialized && node.events?.initializedFromRemote) {
      await Promise.race([
        node.events.initializedFromRemote,
        new Promise((resolve) => setTimeout(resolve, 20_000))
      ]);
    }

    const syncedDevices = await this.syncNodeToDevices(node, {
      requestedName: payload.name,
      requestedRoom: payload.room,
      transport
    });

    await this.updateSession(sessionId, {
      status: 'completed',
      nodeId: nodeIdText,
      deviceId: syncedDevices[0]?._id?.toString?.() || syncedDevices[0]?._id || null,
      devices: syncedDevices.map((device) => ({
        id: device._id?.toString?.() || device._id,
        name: device.name,
        type: device.type
      }))
    });
  }

  async getThreadOperationalDataset() {
    const config = await this.loadConfig();
    const configured = normalizeString(config.thread?.operationalDataset);
    if (configured) {
      return configured;
    }
    const otbr = await this.checkOtbrRest(config.otbrRestUrl);
    return normalizeString(otbr.dataset);
  }

  getEndpointDescriptor(node, endpoint, options = {}) {
    const endpointId = endpoint?.number ?? endpoint?.getNumber?.();
    const endpointState = safeJsonClone(endpoint?.state || {});
    const rootState = safeJsonClone(node?.state || {});
    const basicInformation = safeJsonClone(node?.basicInformation || rootState?.basicInformation || {});
    const descriptor = endpointState?.descriptor || {};
    const deviceTypes = typeof endpoint?.getDeviceTypes === 'function' ? endpoint.getDeviceTypes() : [];
    const deviceTypeNames = (Array.isArray(deviceTypes) ? deviceTypes : [deviceTypes])
      .map((entry) => normalizeString(entry?.name || entry?.deviceTypeName || entry?.typeName || entry?.code || entry?.deviceType))
      .filter(Boolean);
    const deviceTypeIds = (Array.isArray(deviceTypes) ? deviceTypes : [deviceTypes])
      .map((entry) => normalizeClusterId(entry?.id ?? entry?.deviceTypeId ?? entry?.code ?? entry?.deviceType))
      .filter((value) => value !== null);
    const clusterIds = [
      ...(Array.isArray(descriptor.serverList) ? descriptor.serverList : []),
      ...(Array.isArray(descriptor.clientList) ? descriptor.clientList : [])
    ].map(normalizeClusterId).filter((value) => value !== null);
    const clusterNames = endpoint && typeof endpoint.getAllClusterClients === 'function'
      ? endpoint.getAllClusterClients()
        .map((cluster) => normalizeString(cluster?.name || cluster?.id || cluster?.cluster?.name))
        .filter(Boolean)
      : [];
    const nodeId = normalizeMatterNodeId(node?.nodeId);
    const endpointName = normalizeString(endpoint?.name) || `Endpoint ${endpointId}`;
    const productName = normalizeString(basicInformation.productName);
    const vendorName = normalizeString(basicInformation.vendorName);
    const name = normalizeString(options.requestedName)
      || normalizeString(basicInformation.nodeLabel)
      || normalizeString(descriptor.endpointUniqueId)
      || productName
      || endpointName
      || `Matter Node ${nodeId}`;

    const matterDescriptor = {
      nodeId,
      endpointId,
      name,
      endpointName,
      productName,
      vendorName,
      deviceTypeIds: Array.from(new Set(deviceTypeIds)).sort((a, b) => a - b),
      deviceTypeNames,
      clusterIds: Array.from(new Set(clusterIds)).sort((a, b) => a - b),
      clusterNames,
      basicInformation,
      state: endpointState
    };
    const features = inferFeaturesFromMatterDescriptor(matterDescriptor);
    return {
      ...matterDescriptor,
      features,
      homeBrainType: inferHomeBrainTypeFromFeatures(features, matterDescriptor),
      room: normalizeString(options.requestedRoom) || 'Unassigned'
    };
  }

  async syncNodeToDevices(node, options = {}) {
    const endpoints = typeof node?.getDevices === 'function' ? node.getDevices() : [];
    const usableEndpoints = endpoints.length > 0
      ? endpoints
      : (node?.getRootEndpoint ? [node.getRootEndpoint()].filter(Boolean) : []);
    const synced = [];

    for (const endpoint of usableEndpoints) {
      const descriptor = this.getEndpointDescriptor(node, endpoint, options);
      if (!descriptor.nodeId || descriptor.endpointId === undefined || descriptor.endpointId === null) {
        continue;
      }
      const device = await this.upsertMatterDeviceFromDescriptor(descriptor, {
        transport: options.transport
      });
      synced.push(device);
    }

    if (synced.length > 0) {
      deviceUpdateEmitter.emit('devices:update', deviceUpdateEmitter.normalizeDevices(synced));
    }

    return synced;
  }

  async upsertMatterDeviceFromDescriptor(descriptor, options = {}) {
    const transport = normalizeTransport(options.transport);
    const catalogEntry = await directRadioProtocolCatalogService.lookupMatterCatalogEntry({
      ...descriptor,
      transport
    });
    const threadCatalogEntry = transport === MATTER_TRANSPORTS.thread
      ? await directRadioProtocolCatalogService.lookupThreadCatalogEntry({
          ...descriptor,
          transport
        })
      : null;
    const features = normalizeFeatureList([
      ...(descriptor.features?.length
        ? descriptor.features
        : inferFeaturesFromMatterDescriptor(endpointDescriptorFromRecord(descriptor))),
      ...(catalogEntry?.matterFeatures || [])
    ]);
    const homeBrainType = descriptor.homeBrainType || catalogEntry?.homeBrainType || inferHomeBrainTypeFromFeatures(features, descriptor);
    const state = this.extractStateFromMatterDescriptor(descriptor);
    const identity = {
      source: MATTER_SOURCE,
      nodeId: normalizeMatterNodeId(descriptor.nodeId),
      endpointId: Number(descriptor.endpointId)
    };
    const existing = await Device.findOne({
      'properties.source': MATTER_SOURCE,
      'properties.matter.nodeId': identity.nodeId,
      'properties.matter.endpointId': identity.endpointId
    });
    const name = normalizeString(descriptor.name)
      || normalizeString(descriptor.productName)
      || `Matter ${identity.nodeId}/${identity.endpointId}`;
    const update = {
      name,
      type: homeBrainType,
      room: normalizeString(descriptor.room) || existing?.room || 'Unassigned',
      status: state.status,
      isOnline: true,
      lastSeen: new Date(),
      brand: normalizeString(descriptor.vendorName) || existing?.brand || undefined,
      model: normalizeString(descriptor.productName) || existing?.model || undefined,
      properties: {
        ...(existing?.properties && typeof existing.properties === 'object' ? existing.properties : {}),
        ...buildMatterFeatureProperties(features),
        source: MATTER_SOURCE,
        matterFeatures: features,
        matterFeatureLabels: matterFeatureLabels(features),
        matter: {
          ...(existing?.properties?.matter && typeof existing.properties.matter === 'object'
            ? existing.properties.matter
            : {}),
          nodeId: identity.nodeId,
          endpointId: identity.endpointId,
          transport,
          clusterIds: descriptor.clusterIds || [],
          clusterNames: descriptor.clusterNames || [],
          deviceTypeIds: descriptor.deviceTypeIds || [],
          deviceTypeNames: descriptor.deviceTypeNames || [],
          productName: descriptor.productName || '',
          vendorName: descriptor.vendorName || '',
          endpointName: descriptor.endpointName || '',
          catalog: directRadioProtocolCatalogService.buildCatalogReference(catalogEntry),
          threadCatalog: directRadioProtocolCatalogService.buildCatalogReference(threadCatalogEntry),
          lastSyncedAt: new Date().toISOString()
        },
        matterDeviceCatalog: directRadioProtocolCatalogService.compactCatalogForDevice(catalogEntry),
        matterCapabilities: catalogEntry?.capabilities || [],
        threadDeviceCatalog: threadCatalogEntry ? directRadioProtocolCatalogService.compactCatalogForDevice(threadCatalogEntry) : undefined,
        threadCapabilities: threadCatalogEntry?.capabilities || undefined,
        matterState: state.rawState || {}
      }
    };

    if (state.batteryLevel !== null) {
      update.properties.matterBatteryLevel = state.batteryLevel;
    }
    if (state.brightness !== null) {
      update.brightness = state.brightness;
    }
    if (state.temperature !== null) {
      update.temperature = state.temperature;
    }
    if (state.targetTemperature !== null) {
      update.targetTemperature = state.targetTemperature;
    }
    if (state.colorTemperature !== null) {
      update.colorTemperature = state.colorTemperature;
    }
    if (state.color) {
      update.color = state.color;
    }

    if (existing) {
      Object.assign(existing, update);
      await existing.save();
      return existing;
    }

    const device = new Device(update);
    await device.save();
    return device;
  }

  extractStateFromMatterDescriptor(descriptor = {}) {
    const rawState = descriptor.state || {};
    const flattened = [];
    const visit = (value, pathParts = []) => {
      if (!value || typeof value !== 'object' || pathParts.length > 6) {
        flattened.push([pathParts.join('.'), value]);
        return;
      }
      Object.entries(value).forEach(([key, child]) => visit(child, [...pathParts, key]));
    };
    visit(rawState, []);

    const valueFor = (patterns) => {
      const entry = flattened.find(([key, value]) => (
        value !== undefined
        && value !== null
        && patterns.some((pattern) => pattern.test(key))
      ));
      return entry ? entry[1] : null;
    };

    const onOff = valueFor([/onOff\.onOff$/i, /\.onOff$/i, /booleanState\.stateValue$/i, /\.stateValue$/i]);
    const lockState = valueFor([/doorLock\.lockState$/i, /\.lockState$/i]);
    const battery = clampPercent(valueFor([/batPercentRemaining$/i, /batteryPercentRemaining$/i, /batteryLevel$/i]));
    const brightness = clampPercent(valueFor([/currentLevel$/i, /\.level$/i]));
    const temperature = toNumber(valueFor([/measuredValue$/i, /temperatureMeasurement/i]));
    const targetTemperature = toNumber(valueFor([/occupiedCoolingSetpoint$/i, /occupiedHeatingSetpoint$/i, /localTemperatureCalibration$/i]));
    const colorTemperature = toNumber(valueFor([/colorTemperatureMireds$/i, /colorTempPhysical/i]));

    let status = false;
    if (typeof onOff === 'boolean') {
      status = onOff;
    } else if (typeof lockState === 'number') {
      status = lockState === 1;
    } else if (typeof lockState === 'string') {
      status = /locked/i.test(lockState);
    }

    return {
      status,
      batteryLevel: battery,
      brightness,
      temperature: temperature === null ? null : Math.round((temperature / 100) * 10) / 10,
      targetTemperature: targetTemperature === null ? null : Math.round((targetTemperature / 100) * 10) / 10,
      colorTemperature: colorTemperature === null ? null : Math.round(1000000 / colorTemperature),
      color: '',
      rawState
    };
  }

  isMatterDevice(device) {
    return normalizeLower(device?.properties?.source) === MATTER_SOURCE
      || Boolean(device?.properties?.matter?.nodeId);
  }

  async refreshMatterDeviceState(device) {
    if (!this.isMatterDevice(device)) {
      return null;
    }

    const controller = await this.ensureController();
    const nodeId = normalizeMatterNodeId(device?.properties?.matter?.nodeId);
    const endpointId = Number(device?.properties?.matter?.endpointId || 1);
    if (!nodeId) {
      return null;
    }

    const node = await controller.getNode(BigInt(nodeId), true);
    if (!node.isConnected) {
      node.connect({ autoSubscribe: true });
    }
    const endpoint = node.getDeviceById(endpointId);
    if (!endpoint) {
      return {
        isOnline: false,
        lastSeen: new Date(),
        'properties.matterLastError': `Matter endpoint ${endpointId} was not found`
      };
    }
    const descriptor = this.getEndpointDescriptor(node, endpoint, {
      requestedName: device.name,
      requestedRoom: device.room
    });
    const state = this.extractStateFromMatterDescriptor(descriptor);
    const update = {
      status: state.status,
      isOnline: true,
      lastSeen: new Date(),
      'properties.matterState': state.rawState,
      'properties.matter.lastSyncedAt': new Date().toISOString()
    };
    if (state.batteryLevel !== null) {
      update['properties.matterBatteryLevel'] = state.batteryLevel;
    }
    if (state.brightness !== null) {
      update.brightness = state.brightness;
    }
    if (state.temperature !== null) {
      update.temperature = state.temperature;
    }
    if (state.targetTemperature !== null) {
      update.targetTemperature = state.targetTemperature;
    }
    return update;
  }

  getClusterClient(node, endpointId, clusterName, clusterId) {
    const runtime = this.loadMatterRuntime();
    const cluster = runtime.clusters?.[clusterName];
    if (cluster?.Complete && typeof node.getClusterClientForDevice === 'function') {
      return node.getClusterClientForDevice(endpointId, cluster.Complete)
        || node.getClusterClientForDevice(endpointId, cluster.Cluster);
    }
    const endpoint = node.getDeviceById(endpointId);
    if (endpoint && typeof endpoint.getClusterClientById === 'function') {
      return endpoint.getClusterClientById(clusterId);
    }
    return null;
  }

  async controlDevice(device, normalizedAction, commandValue, updateData = {}) {
    if (!this.isMatterDevice(device)) {
      throw new Error('Device is not a Matter-backed HomeBrain device');
    }

    const controller = await this.ensureController();
    const nodeId = normalizeMatterNodeId(device?.properties?.matter?.nodeId);
    const endpointId = Number(device?.properties?.matter?.endpointId || 1);
    if (!nodeId || !Number.isFinite(endpointId)) {
      throw new Error('Matter node identity is missing from this device');
    }

    const node = await controller.getNode(BigInt(nodeId), true);
    if (!node.isConnected) {
      node.connect({ autoSubscribe: true });
    }

    switch (normalizedAction) {
      case 'toggle': {
        const client = this.getClusterClient(node, endpointId, 'OnOff', MATTER_ACTION_CLUSTER_HINTS.onOff);
        if (!client?.toggle) {
          throw new Error('Matter On/Off toggle is not available for this device');
        }
        await client.toggle();
        break;
      }
      case 'turnon':
      case 'turnoff': {
        const client = this.getClusterClient(node, endpointId, 'OnOff', MATTER_ACTION_CLUSTER_HINTS.onOff);
        const methodName = normalizedAction === 'turnon' ? 'on' : 'off';
        if (!client?.[methodName]) {
          throw new Error('Matter On/Off control is not available for this device');
        }
        await client[methodName]();
        break;
      }
      case 'alarmoff':
      case 'turnoffalarm':
      case 'silencealarm': {
        const client = this.getClusterClient(node, endpointId, 'OnOff', MATTER_ACTION_CLUSTER_HINTS.onOff);
        if (client?.off) {
          await client.off();
          break;
        }
        throw new Error('Matter alarm output does not expose a silence/off command');
      }
      case 'setbrightness': {
        const client = this.getClusterClient(node, endpointId, 'LevelControl', MATTER_ACTION_CLUSTER_HINTS.level);
        const level = Math.round(Math.max(0, Math.min(100, Number(commandValue))) * 254 / 100);
        if (client?.moveToLevelWithOnOff) {
          await client.moveToLevelWithOnOff({ level, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
        } else if (client?.moveToLevel) {
          await client.moveToLevel({ level, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
        } else {
          throw new Error('Matter brightness control is not available for this device');
        }
        break;
      }
      case 'setcolortemperature': {
        const client = this.getClusterClient(node, endpointId, 'ColorControl', MATTER_ACTION_CLUSTER_HINTS.color);
        const kelvin = Math.max(1000, Math.min(10000, Number(commandValue)));
        const colorTemperatureMireds = Math.round(1000000 / kelvin);
        if (!client?.moveToColorTemperature) {
          throw new Error('Matter color temperature control is not available for this device');
        }
        await client.moveToColorTemperature({ colorTemperatureMireds, transitionTime: 0, optionsMask: {}, optionsOverride: {} });
        break;
      }
      case 'lock':
      case 'unlock': {
        const client = this.getClusterClient(node, endpointId, 'DoorLock', MATTER_ACTION_CLUSTER_HINTS.doorLock);
        const methodName = normalizedAction === 'lock' ? 'lockDoor' : 'unlockDoor';
        if (!client?.[methodName]) {
          throw new Error('Matter door lock control is not available for this device');
        }
        await client[methodName]({});
        break;
      }
      case 'open':
      case 'close': {
        const client = this.getClusterClient(node, endpointId, 'WindowCovering', MATTER_ACTION_CLUSTER_HINTS.windowCovering);
        const methodName = normalizedAction === 'open' ? 'upOrOpen' : 'downOrClose';
        if (!client?.[methodName]) {
          throw new Error('Matter closure control is not available for this device');
        }
        await client[methodName]();
        break;
      }
      case 'settemperature':
      case 'setmode':
        throw new Error('Matter thermostat writes are recognized but require endpoint-specific mode/setpoint mapping');
      default:
        throw new Error(`Unsupported Matter action: ${normalizedAction}`);
    }

    Object.assign(updateData, {
      isOnline: true,
      lastSeen: new Date(),
      'properties.matter.lastCommandAt': new Date().toISOString(),
      'properties.matter.lastCommand': normalizedAction
    });
    return updateData;
  }

  async removeMatterDevice(deviceId, options = {}) {
    const device = await Device.findById(deviceId);
    if (!device) {
      const error = new Error('Matter device not found');
      error.status = 404;
      throw error;
    }
    if (!this.isMatterDevice(device)) {
      const error = new Error('Device is not a Matter device');
      error.status = 400;
      throw error;
    }

    const nodeId = normalizeMatterNodeId(device?.properties?.matter?.nodeId);
    if (nodeId && options.decommission !== false) {
      try {
        const controller = await this.ensureController();
        const node = await controller.getNode(BigInt(nodeId), true);
        await node.decommission();
      } catch (error) {
        if (options.force !== true) {
          throw error;
        }
        console.warn(`MatterService: Force-removing Matter device after decommission failed: ${error.message}`);
      }
    }

    await Device.deleteOne({ _id: device._id });
    return device;
  }

  async listMatterDevices() {
    return Device.find({
      $or: [
        { 'properties.source': MATTER_SOURCE },
        { 'properties.matter.nodeId': { $exists: true, $ne: '' } }
      ]
    }).sort({ room: 1, name: 1 }).lean();
  }

  async syncCommissionedNodesToDevices() {
    const controller = await this.ensureController();
    const nodeIds = controller.getCommissionedNodes();
    const synced = [];

    for (const nodeId of nodeIds) {
      try {
        const node = await controller.getNode(nodeId, true);
        if (!node.isConnected) {
          node.connect({ autoSubscribe: true });
        }
        const devices = await this.syncNodeToDevices(node, {
          transport: MATTER_TRANSPORTS.ip
        });
        synced.push(...devices);
      } catch (error) {
        console.warn(`MatterService: Failed to sync commissioned node ${normalizeMatterNodeId(nodeId)}: ${error.message}`);
      }
    }

    return synced;
  }

  async getStatus() {
    const config = await this.loadConfig();
    const thread = this.lastThreadStatus || await this.getThreadStatus({ refreshPorts: false });
    const commissionedNodes = [];

    if (this.controller) {
      try {
        this.controller.getCommissionedNodes().forEach((nodeId) => {
          commissionedNodes.push(normalizeMatterNodeId(nodeId));
        });
      } catch (error) {
        console.warn(`MatterService: Failed to enumerate commissioned nodes: ${error.message}`);
      }
    }

    return {
      enabled: config.enabled,
      started: this.started,
      controllerStarted: Boolean(this.controller),
      startError: this.startError,
      controllerError: this.controllerError,
      controllerRecovery: this.controllerRecovery,
      hardware: MATTER_CONTROLLER_HARDWARE,
      config: stripSensitiveConfig(config),
      thread,
      bleAvailable: this.isBleRuntimeAvailable(),
      commissionedNodeIds: commissionedNodes,
      sessionCount: this.sessions.length,
      activeSessions: this.getCommissioningSessions().filter((session) => (
        ['queued', 'commissioning', 'syncing'].includes(session.status)
      )),
      capabilities: this.getCapabilities()
    };
  }

  getCapabilities() {
    return {
      source: MATTER_SOURCE,
      transports: Object.values(MATTER_TRANSPORTS),
      hardware: MATTER_CONTROLLER_HARDWARE,
      features: featureSupport(Object.keys(require('./matterDeviceCatalog').MATTER_FEATURE_LABELS)),
      commissioning: [
        'Manual setup code',
        'QR setup code',
        'Known IP address',
        'Matter-over-IP discovery',
        'SONOFF MG24 OpenThread RCP setup guidance',
        'Automatic latest SONOFF OpenThread firmware selection',
        'Admin-confirmed SONOFF MG24 OpenThread RCP firmware flashing',
        'Thread credentials through OpenThread Border Router',
        'Safe OTBR no-BBR fallback when the host kernel lacks multicast routing support',
        'Wi-Fi credentials through BLE commissioning when Bluetooth is available'
      ]
    };
  }
}

const matterService = new MatterService();
matterService.MatterService = MatterService;
matterService._test = {
  addFallbackSerialPortCandidates,
  buildOtbrRadioUrl,
  buildThreadFirmwareFlashCommand,
  buildManualSteps,
  buildThreadSetupGuidance,
  buildUniversalSilabsFlasherArgs,
  compareFirmwareEntries,
  endpointDescriptorFromRecord,
  inferSonoffThreadFirmwareTarget,
  getSerialPortListFunction,
  isAllowedLocalOtbrHost,
  isThreadOtbrAttachedState,
  isTrustedSonoffFirmwareUrl,
  looksLikeSonoffMg24Port,
  normalizePersistedThreadFirmwareFlashJob,
  normalizePersistedThreadKernelJob,
  buildThreadKernelJobUpdateFromHelperStatus,
  normalizeThreadKernelHelperLastResult,
  threadKernelHelperResultMatchesJob,
  normalizeThreadBackboneRouterMode,
  normalizeThreadBaudRate,
  normalizeThreadFirmwareFlashConfirmation,
  normalizeThreadKernelConfirmation,
  normalizeThreadKernelRebootConfirmation,
  normalizeThreadOtbrConfirmation,
  normalizeThreadOtbrState,
  normalizeSerialPort,
  normalizeOtbrRestUrl,
  normalizeTransport,
  normalizeSonoffFirmwareEntry,
  parseJsonObjectFromOutput,
  parseHexDatasetFromText,
  parseKnownAddress,
  resolveThreadActiveDataset,
  matterControllerStoreMayContainPairedNodes,
  serializeMatterControllerError,
  sanitizeFirmwareFileName,
  summarizeMatterControllerError,
  selectLatestSonoffThreadFirmware,
  serialPortMatchesPath,
  splitCommandSpec
};

module.exports = matterService;

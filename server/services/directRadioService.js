const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const mongoose = require('mongoose');
const os = require('os');
const path = require('path');
const Device = require('../models/Device');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const directRadioEngineLogService = require('./directRadioEngineLogService');
const {
  DIRECT_RADIO_SOURCES,
  buildDirectFeatureProperties,
  buildMigrationPlan,
  inferFeaturesFromSmartThings,
  isDirectRadioDevice,
  normalizeFeature
} = require('./directRadioDeviceCatalog');
const {
  inferDirectDeviceType,
  isDirectLightContext
} = require('./deviceTypeClassification');

const DATA_DIR = process.env.HOMEBRAIN_DIRECT_RADIO_DATA_DIR
  || path.join(__dirname, '..', 'data', 'direct-radios');
const ZIGBEE_DIR = path.join(DATA_DIR, 'zigbee');
const ZWAVE_DIR = path.join(DATA_DIR, 'zwave');
const CONFIG_PATH = path.join(DATA_DIR, 'controller-config.json');
const DEFAULT_PAIRING_SECONDS = 120;
const MAX_PAIRING_SECONDS = 900;
const DEFAULT_HARDWARE_SCAN_INTERVAL_MS = 60_000;
const DIRECT_DEVICE_PROJECTION = 'name type room groups status brightness color colorTemperature temperature targetTemperature isOnline lastSeen properties brand model';
const FALLBACK_SERIAL_DEVICE_PATTERNS = [
  /^ttyUSB\d+$/i,
  /^ttyACM\d+$/i
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseEnabledFlag(value, fallback = true) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  return fallback;
}

function boundedSeconds(value, fallback = DEFAULT_PAIRING_SECONDS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(5, Math.min(MAX_PAIRING_SECONDS, Math.round(parsed)));
}

function boundedIntervalMs(value, fallback = DEFAULT_HARDWARE_SCAN_INTERVAL_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(15_000, Math.min(10 * 60_000, Math.round(parsed)));
}

function enumMemberName(enumObject, value) {
  if (enumObject && value !== undefined && value !== null && enumObject[value] !== undefined) {
    return String(enumObject[value]);
  }
  return value === undefined || value === null ? 'unknown' : String(value);
}

function getNumericNodeId(value) {
  const nodeId = Number(value?.nodeId ?? value?.id ?? value);
  return Number.isFinite(nodeId) ? nodeId : null;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeSourceText(value) {
  return trimString(value).toLowerCase();
}

function normalizeObjectId(value, label = 'Device id') {
  const id = trimString(value);
  if (!/^[0-9a-fA-F]{24}$/.test(id) || !mongoose.Types.ObjectId.isValid(id)) {
    const error = new Error(`${label} is invalid`);
    error.status = 400;
    throw error;
  }
  return id;
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  ensureDirSync(path.dirname(filePath));
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function randomByteArray(length) {
  return Array.from(crypto.randomBytes(length));
}

function randomHex(length = 16) {
  return crypto.randomBytes(length).toString('hex');
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
  const normalizedPath = trimString(serialPath);
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
  const stablePath = trimString(stableLink?.stablePath);
  const label = trimString(stableLink?.label) || (stablePath ? path.basename(stablePath) : path.basename(pathValue));

  return {
    path: resolvedPath || pathValue,
    pnpId: label,
    friendlyName: label,
    description: label,
    stablePath,
    realPath: resolvedPath
  };
}

function hasPortCandidate(candidates, serialPath) {
  const normalizedPath = trimString(serialPath);
  if (!normalizedPath) {
    return true;
  }

  const resolvedPath = resolveRealPath(normalizedPath);
  return candidates.some((candidate) => {
    const candidatePath = trimString(candidate?.path || candidate?.comName || candidate?.device || candidate?.pnpId);
    const candidateStablePath = trimString(candidate?.stablePath);
    const candidateRealPath = resolveRealPath(candidatePath);
    return candidatePath === normalizedPath
      || candidateStablePath === normalizedPath
      || candidateRealPath === resolvedPath
      || (candidateRealPath && resolvedPath && candidateRealPath === resolvedPath);
  });
}

function listFallbackSerialDevicePaths() {
  try {
    return fs.readdirSync('/dev')
      .filter((fileName) => FALLBACK_SERIAL_DEVICE_PATTERNS.some((pattern) => pattern.test(fileName)))
      .map((fileName) => path.join('/dev', fileName))
      .sort((left, right) => left.localeCompare(right));
  } catch (_error) {
    return [];
  }
}

function addFallbackSerialPortCandidates(rawPorts = [], stableLinks = resolveLocalSerialById()) {
  const candidates = Array.isArray(rawPorts) ? [...rawPorts] : [];

  stableLinks.forEach((stableLink) => {
    const candidatePath = stableLink.realPath || stableLink.stablePath;
    if (candidatePath && !hasPortCandidate(candidates, candidatePath)) {
      candidates.push(buildFallbackSerialPort(candidatePath, stableLink));
    }
  });

  listFallbackSerialDevicePaths().forEach((serialPath) => {
    if (!hasPortCandidate(candidates, serialPath)) {
      const stableLink = stableLinks.find((entry) => entry.realPath && resolveRealPath(serialPath) === entry.realPath);
      candidates.push(buildFallbackSerialPort(serialPath, stableLink || null));
    }
  });

  return candidates;
}

function normalizeSerialPort(rawPort = {}, stableLinks = resolveLocalSerialById()) {
  const pathValue = trimString(rawPort.path || rawPort.comName || rawPort.device || rawPort.pnpId);
  let realPath = '';
  if (pathValue) {
    try {
      realPath = fs.realpathSync(pathValue);
    } catch (_error) {
      realPath = pathValue;
    }
  }

  const stableMatch = stableLinks.find((entry) => (
    entry.stablePath === pathValue
      || (entry.realPath && realPath && entry.realPath === realPath)
      || (entry.realPath && pathValue && entry.realPath.endsWith(path.basename(pathValue)))
  ));
  const stablePath = stableMatch?.stablePath || '';
  const text = [
    rawPort.manufacturer,
    rawPort.vendorId,
    rawPort.productId,
    rawPort.serialNumber,
    rawPort.pnpId,
    rawPort.locationId,
    rawPort.friendlyName,
    rawPort.product,
    rawPort.description,
    stableMatch?.label,
    stablePath,
    pathValue
  ].map(trimString).filter(Boolean).join(' ').toLowerCase();

  return {
    path: stablePath || pathValue,
    rawPath: pathValue,
    stablePath: stablePath || null,
    realPath: realPath || null,
    manufacturer: rawPort.manufacturer || null,
    vendorId: rawPort.vendorId || null,
    productId: rawPort.productId || null,
    serialNumber: rawPort.serialNumber || null,
    pnpId: rawPort.pnpId || null,
    friendlyName: rawPort.friendlyName || rawPort.product || rawPort.description || null,
    descriptor: text
  };
}

function serialDescriptorSearchText(port = {}) {
  const descriptor = trimString(port?.descriptor).toLowerCase();
  return `${descriptor} ${descriptor.replace(/[_-]+/g, ' ')}`;
}

function enrichSerialPortForDirectRadios(port) {
  const zigbeeScore = scorePortForProtocol(port, 'zigbee');
  const zwaveScore = scorePortForProtocol(port, 'zwave');
  const likelyZigbee = zigbeeScore >= 8;
  const likelyZWave = zwaveScore >= 8;
  const likelyThread = looksLikeSonoffMg24ThreadStick(port);
  const preferredProtocol = Math.max(zigbeeScore, zwaveScore) > 0
    ? (zigbeeScore > zwaveScore
      ? 'zigbee'
      : zwaveScore > zigbeeScore
        ? 'zwave'
        : null)
    : null;

  return {
    ...port,
    scores: {
      zigbee: zigbeeScore,
      zwave: zwaveScore
    },
    likelyZigbee,
    likelyZWave,
    likelyThread,
    preferredProtocol
  };
}

function looksLikeSonoffMg24ThreadStick(port = {}) {
  const descriptor = serialDescriptorSearchText(port);
  const vendorId = trimString(port?.vendorId).toLowerCase();
  const productId = trimString(port?.productId).toLowerCase();
  return /(?:^|[^a-z0-9])(?:mg24|pmg24|dongle[-_ ]?m|dongle[-_ ]?plus[-_ ]?mg24|efr32mg24)(?=$|[^a-z0-9])/.test(descriptor)
    && (
      /\b(?:sonoff|itead|silicon labs|cp210)\b/.test(descriptor)
        || (vendorId === '10c4' && productId === 'ea60')
    );
}

function scorePortForProtocol(port, protocol) {
  const descriptor = serialDescriptorSearchText(port);
  const vendorId = trimString(port?.vendorId).toLowerCase();
  const productId = trimString(port?.productId).toLowerCase();
  const isThreadCapableMg24 = looksLikeSonoffMg24ThreadStick(port);
  let score = 0;

  if (protocol === 'zigbee') {
    if (/\b(?:zbdongle|zbdongle-p|zbdongle p|zigbee|cc2652|cc1352|z-stack|z stack|zstack)\b/.test(descriptor)) score += 12;
    if (/\b(?:sonoff|itead)\b/.test(descriptor) && /\b(?:zigbee|zbdongle|cc2652|cc1352)\b/.test(descriptor)) score += 2;
    if (/\b(?:cp2102|cp210x|silicon labs)\b/.test(descriptor)) score += 2;
    if (vendorId === '10c4' && productId === 'ea60') score += 2;
    if (isThreadCapableMg24) score -= 10;
    if (/\b(?:z-wave|z wave|zwave|zst39|zooz|700 series|800 series|uzb)\b/.test(descriptor)) score -= 8;
  } else if (protocol === 'zwave') {
    if (/\b(?:z-wave|z wave|zwave|zst39|zooz|800 series|700 series|uzb|serialapi|serial api)\b/.test(descriptor)) score += 12;
    if (/\b(?:cp2102|cp210x|silicon labs)\b/.test(descriptor)) score += 2;
    if (vendorId === '10c4' && productId === 'ea60') score += 2;
    if (isThreadCapableMg24) score -= 6;
    if (/\b(?:sonoff|itead|zbdongle|zigbee|cc2652|cc1352|z-stack|z stack|zstack)\b/.test(descriptor)) score -= 8;
  }

  return score;
}

function choosePortForProtocol(ports, protocol, usedPaths = new Set()) {
  const ranked = ports
    .filter((port) => port.path && !usedPaths.has(port.path))
    .map((port) => ({ port, score: scorePortForProtocol(port, protocol) }))
    .sort((left, right) => right.score - left.score);

  const strong = ranked.find((entry) => entry.score >= 8);
  if (strong) {
    return strong.port;
  }

  const weak = ranked.find((entry) => entry.score > 0);
  if (weak && ranked.length === 1) {
    return weak.port;
  }

  if (ranked.length === 1 && /linux/i.test(os.type())) {
    return ranked[0].port;
  }

  return null;
}

function describeSerialEndpoints(ports = []) {
  const visible = ports
    .map((port) => trimString(port?.path || port?.stablePath || port?.rawPath || port?.realPath))
    .filter(Boolean);

  if (visible.length === 0) {
    return 'no serial endpoints';
  }

  const preview = visible.slice(0, 6).join(', ');
  return visible.length > 6
    ? `${preview}, and ${visible.length - 6} more`
    : preview;
}

function protocolSource(protocol) {
  return protocol === 'zigbee' ? DIRECT_RADIO_SOURCES.zigbee : DIRECT_RADIO_SOURCES.zwave;
}

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPercent(value) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function hexToRgbPercent(color) {
  const normalized = trimString(color).replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    return null;
  }

  return {
    red: Math.round((parseInt(normalized.slice(0, 2), 16) / 255) * 255),
    green: Math.round((parseInt(normalized.slice(2, 4), 16) / 255) * 255),
    blue: Math.round((parseInt(normalized.slice(4, 6), 16) / 255) * 255)
  };
}

function kelvinToMired(kelvin) {
  const numeric = Number(kelvin);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(1000000 / numeric);
}

function readZigbeeEndpoint(zigbeeDevice) {
  if (!zigbeeDevice) {
    return null;
  }

  if (typeof zigbeeDevice.getEndpoint === 'function') {
    return zigbeeDevice.getEndpoint(1)
      || zigbeeDevice.getEndpoint(2)
      || null;
  }

  if (Array.isArray(zigbeeDevice.endpoints)) {
    return zigbeeDevice.endpoints.find((endpoint) => endpoint.ID === 1 || endpoint.ID === 2)
      || zigbeeDevice.endpoints[0]
      || null;
  }

  return null;
}

function extractZigbeeDefinition(converters, zigbeeDevice) {
  try {
    return converters?.findByDevice?.(zigbeeDevice) || null;
  } catch (_error) {
    return null;
  }
}

function inferFeaturesFromZigbeeDefinition(definition, zigbeeDevice) {
  const features = new Set();
  const exposes = Array.isArray(definition?.exposes) ? definition.exposes : [];
  const deviceText = [
    definition?.model,
    definition?.vendor,
    definition?.description,
    zigbeeDevice?.modelID,
    zigbeeDevice?.manufacturerName
  ].filter(Boolean).join(' ').toLowerCase();

  const visitExpose = (expose) => {
    if (!expose || typeof expose !== 'object') {
      return;
    }
    const name = trimString(expose.name || expose.property || expose.type).toLowerCase();
    const candidates = [
      [/\bstate\b|\bswitch\b/, 'switch'],
      [/\bbrightness\b/, 'brightness'],
      [/\bcolor_xy\b|\bcolor_hs\b|\bcolor\b/, 'color'],
      [/\bcolor_temp\b|\bcolortemp\b/, 'colorTemperature'],
      [/\bcontact\b/, 'contact'],
      [/\bmotion\b|\boccupancy\b/, 'motion'],
      [/\btemperature\b/, 'temperature'],
      [/\bhumidity\b/, 'humidity'],
      [/\billuminance\b/, 'illuminance'],
      [/\bbattery\b|\bbattery_low\b/, 'battery'],
      [/\btamper\b/, 'tamper'],
      [/\baction\b|\bbutton\b/, 'button'],
      [/\bwater_leak\b|\bwater\b/, 'water'],
      [/\bpower\b/, 'power'],
      [/\benergy\b/, 'energy'],
      [/\block\b/, 'lock']
    ];
    candidates.forEach(([pattern, feature]) => {
      if (pattern.test(name)) {
        features.add(feature);
      }
    });
    if (Array.isArray(expose.features)) {
      expose.features.forEach(visitExpose);
    }
  };

  exposes.forEach(visitExpose);
  if (isDirectLightContext(deviceText)) {
    features.add('light');
    features.add('switch');
  }

  return Array.from(features).sort();
}

function getZWaveValue(node, valueDef) {
  try {
    return node?.valueDB?.getValue?.(valueDef?.id || valueDef);
  } catch (_error) {
    return undefined;
  }
}

function valueMetadataLabel(entry) {
  return trimString(entry?.metadata?.label || entry?.propertyName || entry?.property || entry?.propertyKey);
}

function findZWaveValueByLabel(node, pattern) {
  try {
    const matches = node.valueDB.findValues((id) => {
      const label = [
        id.property,
        id.propertyKey,
        node.valueDB.getMetadata(id)?.label
      ].filter(Boolean).join(' ').toLowerCase();
      return pattern.test(label);
    });
    return matches[0]?.value;
  } catch (_error) {
    return undefined;
  }
}

class DirectRadioService {
  constructor() {
    this.started = false;
    this.startPromise = null;
    this.serialPorts = [];
    this.detected = {
      zigbee: null,
      zwave: null
    };
    this.lastSerialScanSummary = '';
    this.hardwareMonitorTimer = null;
    this.zigbee = {
      controller: null,
      converters: null,
      started: false,
      error: null,
      permitJoinUntil: null,
      lastStartResult: null
    };
    this.zwave = {
      driver: null,
      started: false,
      error: null,
      inclusionUntil: null,
      exclusionUntil: null,
      s2DskPin: '',
      pendingDsk: null,
      addNodeStatusEnum: null,
      removeNodeStatusEnum: null
    };
    this.activeMigrations = new Map();
  }

  publishLog(input = {}) {
    return directRadioEngineLogService.publish(input);
  }

  log(level, protocol, message, details = {}) {
    return this.publishLog({
      level,
      protocol,
      message,
      details
    });
  }

  async start(options = {}) {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this._start(options)
      .finally(() => {
        this.startPromise = null;
      });

    return this.startPromise;
  }

  async _start(options = {}) {
    if (this.started && !options.force) {
      return this.getStatus();
    }

    this.started = true;
    this.log('info', 'system', 'Starting direct radio runtime', {
      force: options.force === true
    });
    ensureDirSync(DATA_DIR);
    ensureDirSync(ZIGBEE_DIR);
    ensureDirSync(ZWAVE_DIR);
    await this.ensureControllerConfig();

    if (!parseEnabledFlag(process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED, true)) {
      this.log('warn', 'system', 'Direct radio runtime is disabled by configuration');
      return this.getStatus();
    }

    await this.detectSerialPorts();

    const shouldStartZigbee = parseEnabledFlag(process.env.HOMEBRAIN_ZIGBEE_ENABLED, true);
    const shouldStartZWave = parseEnabledFlag(process.env.HOMEBRAIN_ZWAVE_ENABLED, true);

    if (shouldStartZigbee && this.detected.zigbee?.path && !this.zigbee.started) {
      await this.startZigbee(this.detected.zigbee.path);
    }
    if (shouldStartZWave && this.detected.zwave?.path && !this.zwave.started) {
      await this.startZWave(this.detected.zwave.path);
    }

    const status = await this.getStatus();
    this.ensureHardwareMonitor();
    this.log('info', 'system', 'Direct radio startup check complete', {
      zigbeeStarted: status.controllers?.zigbee?.started === true,
      zwaveStarted: status.controllers?.zwave?.started === true,
      zigbeePort: status.controllers?.zigbee?.detectedPort || null,
      zwavePort: status.controllers?.zwave?.detectedPort || null
    });
    return status;
  }

  ensureHardwareMonitor() {
    if (this.hardwareMonitorTimer || !parseEnabledFlag(process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED, true)) {
      return;
    }

    const intervalMs = boundedIntervalMs(process.env.HOMEBRAIN_DIRECT_RADIO_SCAN_INTERVAL_MS);
    this.hardwareMonitorTimer = setInterval(() => {
      if (this.zigbee.started && this.zwave.started) {
        return;
      }

      void this.refreshHardwareStatus({ log: false }).catch((error) => {
        this.log('warn', 'system', 'Direct radio hardware monitor refresh failed', {
          error: error.message
        });
      });
    }, intervalMs);

    if (typeof this.hardwareMonitorTimer.unref === 'function') {
      this.hardwareMonitorTimer.unref();
    }
  }

  async ensureControllerConfig() {
    const existing = await readJsonFile(CONFIG_PATH, {});
    const next = {
      zigbee: {
        panID: Number(existing?.zigbee?.panID) || (0x1a00 + crypto.randomInt(0, 0x3ff)),
        extendedPanID: Array.isArray(existing?.zigbee?.extendedPanID) && existing.zigbee.extendedPanID.length === 8
          ? existing.zigbee.extendedPanID
          : randomByteArray(8),
        networkKey: Array.isArray(existing?.zigbee?.networkKey) && existing.zigbee.networkKey.length === 16
          ? existing.zigbee.networkKey
          : randomByteArray(16),
        channelList: Array.isArray(existing?.zigbee?.channelList) && existing.zigbee.channelList.length > 0
          ? existing.zigbee.channelList
          : [15]
      },
      zwave: {
        securityKeys: {
          S2_AccessControl: trimString(existing?.zwave?.securityKeys?.S2_AccessControl) || randomHex(16),
          S2_Authenticated: trimString(existing?.zwave?.securityKeys?.S2_Authenticated) || randomHex(16),
          S2_Unauthenticated: trimString(existing?.zwave?.securityKeys?.S2_Unauthenticated) || randomHex(16),
          S0_Legacy: trimString(existing?.zwave?.securityKeys?.S0_Legacy) || randomHex(16)
        },
        securityKeysLongRange: {
          S2_AccessControl: trimString(existing?.zwave?.securityKeysLongRange?.S2_AccessControl) || randomHex(16),
          S2_Authenticated: trimString(existing?.zwave?.securityKeysLongRange?.S2_Authenticated) || randomHex(16)
        }
      }
    };
    await writeJsonFile(CONFIG_PATH, next);
    return next;
  }

  async detectSerialPorts(options = {}) {
    const logScan = options.log !== false;
    if (logScan) {
      this.log('info', 'system', 'Scanning serial ports for Zigbee and Z-Wave adapters');
    }
    let SerialPortModule;
    try {
      SerialPortModule = require('serialport');
    } catch (error) {
      this.serialPorts = [];
      this.detected.zigbee = null;
      this.detected.zwave = null;
      this.zigbee.error = `serialport unavailable: ${error.message}`;
      this.zwave.error = `serialport unavailable: ${error.message}`;
      if (logScan) {
        this.log('error', 'system', 'Serial port module unavailable for direct radio scan', {
          error: error.message
        });
      }
      return this.serialPorts;
    }

    let rawPorts = [];
    try {
      rawPorts = await SerialPortModule.list();
    } catch (error) {
      this.serialPorts = [];
      this.zigbee.error = `Failed to list serial ports: ${error.message}`;
      this.zwave.error = `Failed to list serial ports: ${error.message}`;
      if (logScan) {
        this.log('error', 'system', 'Failed to list serial ports for direct radio scan', {
          error: error.message
        });
      }
      return this.serialPorts;
    }

    const stableLinks = resolveLocalSerialById();
    const rawCandidates = addFallbackSerialPortCandidates(rawPorts, stableLinks);
    this.serialPorts = rawCandidates
      .map((port) => normalizeSerialPort(port, stableLinks))
      .filter((port) => Boolean(port.path))
      .map(enrichSerialPortForDirectRadios);

    const used = new Set();
    const configuredZigbee = trimString(process.env.HOMEBRAIN_ZIGBEE_PORT);
    const configuredZWave = trimString(process.env.HOMEBRAIN_ZWAVE_PORT);

    this.detected.zigbee = configuredZigbee
      ? { path: configuredZigbee, configured: true, score: 100 }
      : choosePortForProtocol(this.serialPorts, 'zigbee', used);
    if (this.detected.zigbee?.path) {
      used.add(this.detected.zigbee.path);
    }

    this.detected.zwave = configuredZWave
      ? { path: configuredZWave, configured: true, score: 100 }
      : choosePortForProtocol(this.serialPorts, 'zwave', used);
    if (this.detected.zwave?.path) {
      used.add(this.detected.zwave.path);
    }

    const scanSummary = JSON.stringify({
      ports: this.serialPorts.map((port) => ({
        path: port.path,
        stablePath: port.stablePath,
        preferredProtocol: port.preferredProtocol,
        scores: port.scores
      })),
      zigbeePort: this.detected.zigbee?.path || null,
      zwavePort: this.detected.zwave?.path || null
    });
    const scanChanged = this.lastSerialScanSummary !== scanSummary;
    this.lastSerialScanSummary = scanSummary;

    if (logScan || scanChanged) {
      this.log('info', 'system', 'Serial port scan complete', {
        serialPortCount: this.serialPorts.length,
        zigbeePort: this.detected.zigbee?.path || null,
        zigbeeScore: this.detected.zigbee?.scores?.zigbee ?? this.detected.zigbee?.score ?? null,
        zwavePort: this.detected.zwave?.path || null,
        zwaveScore: this.detected.zwave?.scores?.zwave ?? this.detected.zwave?.score ?? null,
        likelyDirectRadioPorts: this.serialPorts
          .filter((port) => port.likelyZigbee || port.likelyZWave)
          .map((port) => ({
            path: port.path,
            stablePath: port.stablePath,
            preferredProtocol: port.preferredProtocol,
            scores: port.scores
          }))
      });
    }

    return this.serialPorts;
  }

  async refreshHardwareStatus(options = {}) {
    await this.start();

    if (!parseEnabledFlag(process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED, true)) {
      return this.getStatus();
    }

    await this.detectSerialPorts({ log: options.log !== false });

    const shouldStartZigbee = parseEnabledFlag(process.env.HOMEBRAIN_ZIGBEE_ENABLED, true);
    const shouldStartZWave = parseEnabledFlag(process.env.HOMEBRAIN_ZWAVE_ENABLED, true);

    if (shouldStartZigbee && this.detected.zigbee?.path && !this.zigbee.started) {
      this.log('info', 'zigbee', 'Detected Zigbee adapter during refresh; attempting coordinator start', {
        serialPath: this.detected.zigbee.path
      });
      await this.startZigbee(this.detected.zigbee.path);
    }

    if (shouldStartZWave && this.detected.zwave?.path && !this.zwave.started) {
      this.log('info', 'zwave', 'Detected Z-Wave adapter during refresh; attempting controller start', {
        serialPath: this.detected.zwave.path
      });
      await this.startZWave(this.detected.zwave.path);
    }

    return this.getStatus();
  }

  async startZigbee(serialPath) {
    try {
      this.log('info', 'zigbee', 'Starting Zigbee coordinator', {
        serialPath
      });
      const { Controller } = require('zigbee-herdsman');
      this.zigbee.converters = require('zigbee-herdsman-converters');
      const config = await this.ensureControllerConfig();
      const controller = new Controller({
        network: {
          panID: config.zigbee.panID,
          extendedPanID: config.zigbee.extendedPanID,
          channelList: config.zigbee.channelList,
          networkKey: config.zigbee.networkKey,
          networkKeyDistribute: false
        },
        serialPort: {
          path: serialPath,
          adapter: 'zstack',
          baudRate: Number(process.env.HOMEBRAIN_ZIGBEE_BAUD_RATE || 115200),
          rtscts: parseEnabledFlag(process.env.HOMEBRAIN_ZIGBEE_RTSCTS, false)
        },
        databasePath: path.join(ZIGBEE_DIR, 'database.db'),
        databaseBackupPath: path.join(ZIGBEE_DIR, 'database.backup.db'),
        backupPath: path.join(ZIGBEE_DIR, 'coordinator-backup.json'),
        adapter: {
          disableLED: process.env.HOMEBRAIN_ZIGBEE_DISABLE_LED === 'true',
          transmitPower: Number(process.env.HOMEBRAIN_ZIGBEE_TRANSMIT_POWER || 20)
        },
        acceptJoiningDeviceHandler: async () => true
      });

      controller.on('deviceJoined', (payload) => {
        this.log('info', 'zigbee', 'Zigbee device joined', {
          ieeeAddr: payload?.device?.ieeeAddr || null,
          modelID: payload?.device?.modelID || null
        });
        void this.handleZigbeeDeviceChanged(payload?.device, 'deviceJoined');
      });
      controller.on('deviceInterview', (payload) => {
        this.log(payload?.status === 'successful' ? 'info' : 'warn', 'zigbee', 'Zigbee device interview update', {
          status: payload?.status || null,
          ieeeAddr: payload?.device?.ieeeAddr || null,
          modelID: payload?.device?.modelID || null
        });
        if (payload?.status === 'successful') {
          void this.handleZigbeeDeviceChanged(payload.device, 'deviceInterview');
        }
      });
      controller.on('deviceAnnounce', (payload) => {
        this.log('info', 'zigbee', 'Zigbee device announced', {
          ieeeAddr: payload?.device?.ieeeAddr || null,
          networkAddress: payload?.device?.networkAddress || null
        });
        void this.handleZigbeeDeviceChanged(payload?.device, 'deviceAnnounce');
      });
      controller.on('message', (payload) => {
        this.log('info', 'zigbee', 'Zigbee message received', {
          ieeeAddr: payload?.device?.ieeeAddr || null,
          cluster: payload?.cluster || null,
          type: payload?.type || null
        });
        void this.handleZigbeeDeviceChanged(payload?.device, 'message');
      });
      controller.on('adapterDisconnected', () => {
        this.zigbee.started = false;
        this.zigbee.error = 'Zigbee adapter disconnected';
        this.log('error', 'zigbee', 'Zigbee adapter disconnected', {
          serialPath
        });
      });

      this.zigbee.controller = controller;
      this.zigbee.lastStartResult = await controller.start();
      this.zigbee.started = true;
      this.zigbee.error = null;
      this.log('info', 'zigbee', 'Zigbee coordinator started', {
        serialPath,
        lastStartResult: this.zigbee.lastStartResult || null
      });
      await this.syncZigbeeDevices();
    } catch (error) {
      this.zigbee.started = false;
      this.zigbee.error = error.message;
      this.log('error', 'zigbee', 'Zigbee coordinator failed to start', {
        serialPath,
        error: error.message
      });
      console.warn(`DirectRadioService: Zigbee controller failed to start: ${error.message}`);
    }
  }

  async startZWave(serialPath) {
    try {
      this.log('info', 'zwave', 'Starting Z-Wave controller', {
        serialPath
      });
      const zwave = require('zwave-js');
      const config = await this.ensureControllerConfig();
      const keyBuffer = (hex) => Buffer.from(hex, 'hex');
      const driver = new zwave.Driver(serialPath, {
        storage: {
          cacheDir: path.join(ZWAVE_DIR, 'cache'),
          throttle: process.env.HOMEBRAIN_ZWAVE_CACHE_THROTTLE || 'normal'
        },
        securityKeys: {
          S2_AccessControl: keyBuffer(config.zwave.securityKeys.S2_AccessControl),
          S2_Authenticated: keyBuffer(config.zwave.securityKeys.S2_Authenticated),
          S2_Unauthenticated: keyBuffer(config.zwave.securityKeys.S2_Unauthenticated),
          S0_Legacy: keyBuffer(config.zwave.securityKeys.S0_Legacy)
        },
        securityKeysLongRange: {
          S2_AccessControl: keyBuffer(config.zwave.securityKeysLongRange.S2_AccessControl),
          S2_Authenticated: keyBuffer(config.zwave.securityKeysLongRange.S2_Authenticated)
        },
        inclusionUserCallbacks: this.buildZWaveInclusionCallbacks(zwave)
      });
      this.attachZWaveMigrationRequestHandlers(driver, zwave);

      driver.on('driver ready', () => {
        this.zwave.started = true;
        this.zwave.error = null;
        this.attachZWaveControllerMigrationListeners(driver.controller);
        this.log('info', 'zwave', 'Z-Wave driver ready', {
          serialPath,
          homeId: driver.controller?.homeId || null
        });
        void this.syncZWaveNodes();
      });
      driver.on('all nodes ready', () => {
        this.log('info', 'zwave', 'All Z-Wave nodes ready', {
          nodeCount: driver.controller?.nodes?.size ?? null
        });
        void this.syncZWaveNodes();
      });
      driver.on('node added', (node) => {
        this.log('info', 'zwave', 'Z-Wave node added', {
          nodeId: node?.id || null
        });
        void this.handleZWaveNodeChanged(node, 'node added');
      });
      driver.on('node removed', (node, reason) => {
        this.log('info', 'zwave', 'Z-Wave node removed', {
          nodeId: node?.id || null,
          reason: reason === undefined ? null : String(reason)
        });
        this.recordZWaveNodeRemoved(node, reason);
      });
      driver.on('node ready', (node) => {
        this.log('info', 'zwave', 'Z-Wave node ready', {
          nodeId: node?.id || null,
          manufacturer: node?.manufacturer || null,
          productLabel: node?.productLabel || null
        });
        void this.handleZWaveNodeChanged(node, 'node ready');
      });
      driver.on('node value updated', (node) => {
        this.log('info', 'zwave', 'Z-Wave node value updated', {
          nodeId: node?.id || null
        });
        void this.handleZWaveNodeChanged(node, 'node value updated');
      });
      driver.on('error', (error) => {
        this.zwave.error = error.message;
        this.log('error', 'zwave', 'Z-Wave driver error', {
          serialPath,
          error: error.message
        });
      });

      this.zwave.driver = driver;
      await driver.start();
      this.zwave.started = true;
      this.zwave.error = null;
      this.log('info', 'zwave', 'Z-Wave controller started', {
        serialPath
      });
    } catch (error) {
      this.zwave.started = false;
      this.zwave.error = error.message;
      this.log('error', 'zwave', 'Z-Wave controller failed to start', {
        serialPath,
        error: error.message
      });
      console.warn(`DirectRadioService: Z-Wave controller failed to start: ${error.message}`);
    }
  }

  buildZWaveInclusionCallbacks(zwave) {
    return {
      grantSecurityClasses: async (requested) => ({
        securityClasses: Array.isArray(requested?.securityClasses)
          ? requested.securityClasses
          : [
              zwave.SecurityClass.S2_AccessControl,
              zwave.SecurityClass.S2_Authenticated,
              zwave.SecurityClass.S2_Unauthenticated,
              zwave.SecurityClass.S0_Legacy
            ].filter((entry) => entry !== undefined),
        clientSideAuth: false
      }),
      validateDSKAndEnterPIN: async (dsk) => {
        this.zwave.pendingDsk = dsk;
        const configuredPin = trimString(this.zwave.s2DskPin || process.env.HOMEBRAIN_ZWAVE_S2_DSK_PIN);
        if (/^\d{5}$/.test(configuredPin)) {
          this.log('info', 'zwave', 'Z-Wave S2 DSK PIN supplied from configuration', {
            dsk
          });
          return configuredPin;
        }
        this.log('warn', 'zwave', 'Z-Wave S2 DSK PIN required', {
          dsk
        });
        console.warn(`DirectRadioService: Z-Wave S2 DSK PIN required for ${dsk}`);
        return false;
      },
      abort: () => {
        this.zwave.pendingDsk = null;
        this.log('warn', 'zwave', 'Z-Wave inclusion user callback aborted');
      }
    };
  }

  attachZWaveMigrationRequestHandlers(driver, zwave) {
    if (!driver || driver.__homebrainMigrationRequestHandlersAttached || typeof driver.registerRequestHandler !== 'function') {
      return;
    }

    try {
      const serialApi = require('@zwave-js/serial/serialapi');
      this.zwave.removeNodeStatusEnum = serialApi.RemoveNodeStatus;
      this.zwave.addNodeStatusEnum = serialApi.AddNodeStatus;

      if (!driver.__homebrainMigrationWaitWrapped && typeof driver.waitForMessage === 'function') {
        const waitForMessage = driver.waitForMessage.bind(driver);
        driver.waitForMessage = async (...args) => {
          const message = await waitForMessage(...args);
          this.observeZWaveMigrationMessage(message);
          return message;
        };
        driver.__homebrainMigrationWaitWrapped = true;
      }

      driver.registerRequestHandler(zwave.FunctionType.RemoveNodeFromNetwork, (message) => {
        this.observeZWaveMigrationMessage(message);
        return false;
      });
      driver.registerRequestHandler(zwave.FunctionType.AddNodeToNetwork, (message) => {
        this.observeZWaveMigrationMessage(message);
        return false;
      });
      driver.__homebrainMigrationRequestHandlersAttached = true;
    } catch (error) {
      this.log('warn', 'zwave', 'Unable to attach Z-Wave migration status handlers', {
        error: error.message
      });
    }
  }

  attachZWaveControllerMigrationListeners(controller) {
    if (!controller || controller.__homebrainMigrationListenersAttached || typeof controller.on !== 'function') {
      return;
    }

    controller.on('exclusion failed', () => {
      this.recordZWaveExclusionFailed('The Z-Wave controller reported that exclusion failed.');
    });
    controller.on('inclusion failed', () => {
      this.recordZWaveInclusionFailed('The Z-Wave controller reported that inclusion failed.');
    });
    controller.__homebrainMigrationListenersAttached = true;
  }

  observeZWaveMigrationMessage(message) {
    if (!message || message.status === undefined || message.status === null) {
      return;
    }

    const functionName = enumMemberName({ 74: 'AddNodeToNetwork', 75: 'RemoveNodeFromNetwork' }, message.functionType);
    const constructorName = message.constructor?.name || '';
    if (functionName === 'RemoveNodeFromNetwork' || constructorName === 'RemoveNodeFromNetworkRequestStatusReport') {
      this.recordZWaveExclusionStatus(message.status, message.statusContext || {});
    } else if (functionName === 'AddNodeToNetwork' || constructorName === 'AddNodeToNetworkRequestStatusReport') {
      this.recordZWaveInclusionStatus(message.status, message.statusContext || {});
    }
  }

  appendMigrationEvent(migration, event) {
    if (!migration) {
      return;
    }
    const events = Array.isArray(migration.zwaveEvents) ? migration.zwaveEvents : [];
    migration.zwaveEvents = [...events.slice(-19), event];
    migration.updatedAt = event.timestamp || new Date().toISOString();
  }

  findCurrentMigrationSession(protocol, statuses = []) {
    const statusSet = new Set(statuses.filter(Boolean));
    const now = Date.now();
    return Array.from(this.activeMigrations.values())
      .filter((migration) => migration?.protocol === protocol)
      .filter((migration) => statusSet.size === 0 || statusSet.has(migration.status))
      .filter((migration) => {
        if (migration.status === 'completed' || migration.status === 'excluded') {
          return true;
        }
        return Number(migration.expiresAt || 0) > now || Number(migration.exclusionExpiresAt || 0) > now;
      })
      .sort((left, right) => (
        new Date(right.updatedAt || right.startedAt || 0).getTime()
        - new Date(left.updatedAt || left.startedAt || 0).getTime()
      ))[0] || null;
  }

  findMigrationSession({ migrationId, deviceId, protocol } = {}) {
    const safeMigrationId = trimString(migrationId);
    if (safeMigrationId && this.activeMigrations.has(safeMigrationId)) {
      return this.activeMigrations.get(safeMigrationId);
    }

    const safeDeviceId = trimString(deviceId);
    const candidates = Array.from(this.activeMigrations.values())
      .filter((migration) => !safeDeviceId || String(migration.sourceDeviceId) === safeDeviceId)
      .filter((migration) => !protocol || migration.protocol === protocol)
      .sort((left, right) => (
        new Date(right.updatedAt || right.startedAt || 0).getTime()
        - new Date(left.updatedAt || left.startedAt || 0).getTime()
      ));
    return candidates[0] || null;
  }

  recordZWaveExclusionStatus(status, statusContext = {}) {
    const migration = this.findCurrentMigrationSession('zwave', ['excluding']);
    if (!migration || status === undefined || status === null) {
      return;
    }

    const timestamp = new Date().toISOString();
    const statusName = enumMemberName(this.zwave.removeNodeStatusEnum, status);
    const nodeId = getNumericNodeId(statusContext);
    this.appendMigrationEvent(migration, {
      kind: 'exclusion',
      status,
      statusName,
      nodeId,
      timestamp
    });

    if (statusName === 'NodeFound') {
      migration.exclusionNodeFoundAt = timestamp;
    }
    if (['RemovingSlave', 'RemovingController'].includes(statusName) && nodeId !== null) {
      migration.exclusionNodeId = nodeId;
    }
    if (statusName === 'Done') {
      migration.status = 'excluded';
      migration.exclusionStatus = 'verified';
      migration.exclusionVerifiedAt = timestamp;
      migration.exclusionNodeId = nodeId ?? migration.exclusionNodeId ?? null;
      migration.expiresAt = Math.max(Number(migration.expiresAt || 0), Date.now() + 15 * 60 * 1000);
      this.log('info', 'zwave', 'Z-Wave exclusion verified by controller status', {
        migrationId: migration.id,
        deviceId: migration.sourceDeviceId,
        nodeId: migration.exclusionNodeId
      });
    }
    if (statusName === 'Failed') {
      migration.status = 'exclusion_failed';
      migration.exclusionStatus = 'failed';
      migration.exclusionFailedAt = timestamp;
      this.log('warn', 'zwave', 'Z-Wave exclusion failed during migration', {
        migrationId: migration.id,
        deviceId: migration.sourceDeviceId
      });
    }
  }

  recordZWaveNodeRemoved(node, reason) {
    const migration = this.findCurrentMigrationSession('zwave', ['excluding']);
    if (!migration) {
      return;
    }

    const timestamp = new Date().toISOString();
    const nodeId = getNumericNodeId(node);
    this.appendMigrationEvent(migration, {
      kind: 'node_removed',
      statusName: 'NodeRemoved',
      nodeId,
      reason: reason === undefined ? null : String(reason),
      timestamp
    });
    migration.status = 'excluded';
    migration.exclusionStatus = 'verified';
    migration.exclusionVerifiedAt = migration.exclusionVerifiedAt || timestamp;
    migration.exclusionNodeId = nodeId ?? migration.exclusionNodeId ?? null;
    migration.expiresAt = Math.max(Number(migration.expiresAt || 0), Date.now() + 15 * 60 * 1000);
  }

  recordZWaveExclusionFailed(message) {
    const migration = this.findCurrentMigrationSession('zwave', ['excluding']);
    if (!migration) {
      return;
    }

    const timestamp = new Date().toISOString();
    this.appendMigrationEvent(migration, {
      kind: 'exclusion_failed',
      statusName: 'Failed',
      message,
      timestamp
    });
    migration.status = 'exclusion_failed';
    migration.exclusionStatus = 'failed';
    migration.exclusionFailedAt = timestamp;
  }

  recordZWaveInclusionStatus(status, statusContext = {}) {
    const migration = this.findCurrentMigrationSession('zwave', ['pairing']);
    if (!migration || status === undefined || status === null) {
      return;
    }

    const timestamp = new Date().toISOString();
    const statusName = enumMemberName(this.zwave.addNodeStatusEnum, status);
    const nodeId = getNumericNodeId(statusContext);
    this.appendMigrationEvent(migration, {
      kind: 'inclusion',
      status,
      statusName,
      nodeId,
      timestamp
    });

    if (['AddingSlave', 'AddingController'].includes(statusName) && nodeId !== null) {
      migration.inclusionNodeId = nodeId;
    }
    if (statusName === 'Failed') {
      migration.status = 'pairing_failed';
      migration.inclusionStatus = 'failed';
      migration.inclusionFailedAt = timestamp;
      this.log('warn', 'zwave', 'Z-Wave inclusion failed during migration', {
        migrationId: migration.id,
        deviceId: migration.sourceDeviceId
      });
    }
  }

  recordZWaveInclusionFailed(message) {
    const migration = this.findCurrentMigrationSession('zwave', ['pairing']);
    if (!migration) {
      return;
    }

    const timestamp = new Date().toISOString();
    this.appendMigrationEvent(migration, {
      kind: 'inclusion_failed',
      statusName: 'Failed',
      message,
      timestamp
    });
    migration.status = 'pairing_failed';
    migration.inclusionStatus = 'failed';
    migration.inclusionFailedAt = timestamp;
  }

  getZWaveController() {
    return this.zwave.driver?.controller || null;
  }

  async syncZigbeeDevices() {
    const devices = this.zigbee.controller?.getDevices?.() || [];
    this.log('info', 'zigbee', 'Synchronizing Zigbee device inventory', {
      reportedDeviceCount: devices.length
    });
    for (const zigbeeDevice of devices) {
      if (zigbeeDevice?.type === 'Coordinator') {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.handleZigbeeDeviceChanged(zigbeeDevice, 'sync');
    }
  }

  async syncZWaveNodes() {
    const nodes = this.getZWaveController()?.nodes;
    if (!nodes || typeof nodes.values !== 'function') {
      this.log('warn', 'zwave', 'Z-Wave node sync skipped because controller nodes are unavailable');
      return;
    }

    this.log('info', 'zwave', 'Synchronizing Z-Wave node inventory', {
      reportedNodeCount: nodes.size ?? null
    });
    for (const node of nodes.values()) {
      if (!node || node.isControllerNode) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.handleZWaveNodeChanged(node, 'sync');
    }
  }

  normalizeZigbeeDevice(zigbeeDevice, reason = 'sync') {
    if (!zigbeeDevice) {
      return null;
    }

    const definition = extractZigbeeDefinition(this.zigbee.converters, zigbeeDevice);
    const features = inferFeaturesFromZigbeeDefinition(definition, zigbeeDevice);
    const directId = trimString(zigbeeDevice.ieeeAddr);
    if (!directId) {
      return null;
    }

    const name = trimString(definition?.description)
      || trimString(zigbeeDevice.modelID)
      || trimString(zigbeeDevice.manufacturerName)
      || `Zigbee ${directId.slice(-6)}`;
    const status = zigbeeDevice.interviewCompleted !== false;

    return {
      identity: {
        protocol: 'zigbee',
        id: directId,
        source: DIRECT_RADIO_SOURCES.zigbee
      },
      update: {
        name,
        type: this.inferDeviceTypeFromFeatures(features, {
          name,
          model: definition?.model || zigbeeDevice.modelID,
          vendor: definition?.vendor,
          description: definition?.description,
          manufacturerName: zigbeeDevice.manufacturerName
        }),
        room: 'Unassigned',
        status: false,
        isOnline: status,
        lastSeen: new Date(),
        brand: trimString(definition?.vendor || zigbeeDevice.manufacturerName) || undefined,
        model: trimString(definition?.model || zigbeeDevice.modelID) || undefined,
        properties: {
          source: DIRECT_RADIO_SOURCES.zigbee,
          homebrainDirect: {
            protocol: 'zigbee',
            ieeeAddr: directId,
            networkAddress: zigbeeDevice.networkAddress,
            modelID: zigbeeDevice.modelID || null,
            manufacturerName: zigbeeDevice.manufacturerName || null,
            interviewCompleted: zigbeeDevice.interviewCompleted !== false,
            lastReason: reason,
            lastSeen: new Date().toISOString()
          },
          directRadioFeatures: features,
          ...buildDirectFeatureProperties(features)
        }
      }
    };
  }

  normalizeZWaveNode(node, reason = 'sync') {
    if (!node) {
      return null;
    }

    const zwave = require('zwave-js');
    const nodeId = Number(node.id);
    if (!Number.isFinite(nodeId)) {
      return null;
    }

    const hasValue = (valueDef) => {
      try {
        return node.valueDB?.hasValue?.(valueDef.id || valueDef);
      } catch (_error) {
        return false;
      }
    };
    const features = new Set();
    if (hasValue(zwave.BinarySwitchCCValues.currentValue) || hasValue(zwave.BinarySwitchCCValues.targetValue)) features.add('switch');
    if (hasValue(zwave.MultilevelSwitchCCValues.currentValue) || hasValue(zwave.MultilevelSwitchCCValues.targetValue)) {
      features.add('switch');
      features.add('brightness');
    }
    if (hasValue(zwave.DoorLockCCValues.currentMode) || hasValue(zwave.DoorLockCCValues.targetMode)) {
      features.add('lock');
      features.add('battery');
    }
    if (hasValue(zwave.BatteryCCValues.level)) features.add('battery');
    if (hasValue(zwave.ColorSwitchCCValues.hexColor)) features.add('color');
    if (hasValue(zwave.SoundSwitchCCValues.toneId) || hasValue(zwave.SoundSwitchCCValues.volume)) features.add('alarm');
    if (hasValue(zwave.ThermostatModeCCValues.thermostatMode)) features.add('thermostat');
    if (findZWaveValueByLabel(node, /\btemperature\b/i) !== undefined) features.add('temperature');
    if (findZWaveValueByLabel(node, /\bhumidity\b/i) !== undefined) features.add('humidity');
    if (findZWaveValueByLabel(node, /\billuminance|luminance|light\b/i) !== undefined) features.add('illuminance');
    if (findZWaveValueByLabel(node, /\bpower\b/i) !== undefined) features.add('power');
    if (findZWaveValueByLabel(node, /\benergy\b/i) !== undefined) features.add('energy');
    if (findZWaveValueByLabel(node, /\bwater|leak\b/i) !== undefined) features.add('water');
    if (findZWaveValueByLabel(node, /\btamper\b/i) !== undefined) features.add('tamper');

    const currentLockMode = getZWaveValue(node, zwave.DoorLockCCValues.currentMode);
    const binaryValue = getZWaveValue(node, zwave.BinarySwitchCCValues.currentValue);
    const multilevelValue = getZWaveValue(node, zwave.MultilevelSwitchCCValues.currentValue);
    const batteryLevel = clampPercent(getZWaveValue(node, zwave.BatteryCCValues.level));
    const brightness = clampPercent(multilevelValue);
    const locked = currentLockMode === zwave.DoorLockMode.Secured || currentLockMode === true || currentLockMode === 'Secured';
    const hasLock = features.has('lock');
    const hasSwitch = features.has('switch');
    const nodeName = trimString(node.name)
      || trimString(node.deviceConfig?.label)
      || trimString(node.productLabel)
      || `Z-Wave Node ${nodeId}`;

    const directFeatures = Array.from(features).sort();
    return {
      identity: {
        protocol: 'zwave',
        id: String(nodeId),
        source: DIRECT_RADIO_SOURCES.zwave
      },
      update: {
        name: nodeName,
        type: this.inferDeviceTypeFromFeatures(directFeatures, {
          name: nodeName,
          productLabel: node.productLabel,
          manufacturer: node.deviceConfig?.manufacturer,
          deviceConfig: node.deviceConfig
        }),
        room: trimString(node.location) || 'Unassigned',
        status: hasLock ? locked : hasSwitch ? Boolean(binaryValue || (brightness && brightness > 0)) : false,
        brightness: brightness ?? undefined,
        isOnline: node.status !== 0,
        lastSeen: new Date(),
        brand: trimString(node.deviceConfig?.manufacturer) || undefined,
        model: trimString(node.deviceConfig?.label || node.productLabel) || undefined,
        properties: {
          source: DIRECT_RADIO_SOURCES.zwave,
          homebrainDirect: {
            protocol: 'zwave',
            nodeId,
            manufacturerId: node.manufacturerId || null,
            productType: node.productType || null,
            productId: node.productId || null,
            interviewStage: String(node.interviewStage || ''),
            status: node.status,
            isListening: node.isListening,
            isFrequentListening: node.isFrequentListening,
            lastReason: reason,
            lastSeen: new Date().toISOString()
          },
          homeBrainBatteryLevel: batteryLevel,
          directRadioFeatures: directFeatures,
          ...buildDirectFeatureProperties(directFeatures)
        }
      }
    };
  }

  inferDeviceTypeFromFeatures(features = [], context = {}) {
    return inferDirectDeviceType(features.map(normalizeFeature), context);
  }

  async handleZigbeeDeviceChanged(zigbeeDevice, reason) {
    const normalized = this.normalizeZigbeeDevice(zigbeeDevice, reason);
    if (!normalized) {
      return null;
    }
    this.log('info', 'zigbee', 'Zigbee device state normalized', {
      reason,
      ieeeAddr: normalized.identity?.id || null,
      features: normalized.update?.properties?.directRadioFeatures || []
    });
    return this.upsertDirectDevice(normalized.identity, normalized.update);
  }

  async handleZWaveNodeChanged(node, reason) {
    const normalized = this.normalizeZWaveNode(node, reason);
    if (!normalized) {
      return null;
    }
    this.log('info', 'zwave', 'Z-Wave node state normalized', {
      reason,
      nodeId: normalized.identity?.id || null,
      features: normalized.update?.properties?.directRadioFeatures || []
    });
    return this.upsertDirectDevice(normalized.identity, normalized.update);
  }

  async upsertDirectDevice(identity, update) {
    const activeMigration = this.findActiveMigration(identity.protocol);
    if (activeMigration?.sourceDeviceId) {
      return this.completeMigration(activeMigration.id, identity, update);
    }

    const query = identity.protocol === 'zigbee'
      ? { 'properties.homebrainDirect.ieeeAddr': identity.id }
      : { 'properties.homebrainDirect.nodeId': Number(identity.id) };
    const existing = await Device.findOne(query);
    const mergedProperties = {
      ...(existing?.properties && typeof existing.properties === 'object' ? existing.properties : {}),
      ...(update.properties || {})
    };

    const payload = {
      ...update,
      properties: mergedProperties
    };

    const device = existing
      ? await Device.findByIdAndUpdate(existing._id, payload, { returnDocument: 'after', runValidators: true })
      : await new Device(payload).save();

    this.log('info', identity.protocol, existing ? 'Direct radio device updated' : 'Direct radio device created', {
      deviceId: device?._id?.toString?.() || null,
      name: device?.name || update?.name || null,
      identity: identity.id
    });
    this.emitDeviceUpdate(device);
    return device;
  }

  findActiveMigration(protocol) {
    const now = Date.now();
    for (const migration of this.activeMigrations.values()) {
      if (migration.protocol === protocol && migration.expiresAt > now && migration.status === 'pairing') {
        return migration;
      }
    }
    return null;
  }

  async completeMigration(migrationId, identity, update) {
    const migration = this.activeMigrations.get(migrationId);
    if (!migration?.sourceDeviceId) {
      return this.upsertDirectDevice(identity, update);
    }

    const existing = await Device.findById(migration.sourceDeviceId);
    if (!existing) {
      this.activeMigrations.delete(migrationId);
      return this.upsertDirectDevice(identity, update);
    }

    const previousProperties = existing.properties && typeof existing.properties === 'object'
      ? existing.properties
      : {};
    const source = protocolSource(identity.protocol);
    const features = uniqueStrings([
      ...(Array.isArray(update.properties?.directRadioFeatures) ? update.properties.directRadioFeatures : []),
      ...inferFeaturesFromSmartThings(existing)
    ]);
    const validation = this.buildMigrationValidation(existing, update, features);
    const migratedProperties = {
      ...previousProperties,
      ...(update.properties || {}),
      source,
      directRadioFeatures: features,
      ...buildDirectFeatureProperties(features),
      smartThingsMigration: {
        migratedAt: new Date().toISOString(),
        previousSource: previousProperties.source || 'smartthings',
        smartThingsDeviceId: previousProperties.smartThingsDeviceId || null,
        migrationId,
        validation
      }
    };

    const updated = await Device.findByIdAndUpdate(existing._id, {
      status: update.status,
      brightness: update.brightness,
      isOnline: update.isOnline !== false,
      lastSeen: new Date(),
      brand: existing.brand || update.brand,
      model: existing.model || update.model,
      properties: migratedProperties
    }, { returnDocument: 'after', runValidators: true });

    migration.status = 'completed';
    migration.completedAt = new Date().toISOString();
    migration.inclusionStatus = 'verified';
    migration.inclusionVerifiedAt = migration.completedAt;
    migration.updatedAt = migration.completedAt;
    migration.directIdentity = identity;
    migration.directDeviceId = updated?._id?.toString?.() || existing._id?.toString?.() || null;
    migration.validation = validation;
    this.log('info', identity.protocol, 'SmartThings migration completed on direct radio', {
      migrationId,
      deviceId: updated?._id?.toString?.() || existing._id?.toString?.() || null,
      identity: identity.id,
      validation
    });
    this.emitDeviceUpdate(updated);
    return updated;
  }

  buildMigrationValidation(existingDevice, directUpdate, features = []) {
    const previousProperties = existingDevice?.properties && typeof existingDevice.properties === 'object'
      ? existingDevice.properties
      : {};
    const directProperties = directUpdate?.properties && typeof directUpdate.properties === 'object'
      ? directUpdate.properties
      : {};
    const smartThingsBattery = clampPercent(
      previousProperties.smartThingsBatteryLevel
      ?? previousProperties.batteryLevel
      ?? previousProperties.battery
      ?? previousProperties.smartThingsAttributeValues?.battery?.battery
    );
    const directBattery = clampPercent(
      directProperties.homeBrainBatteryLevel
      ?? directProperties.directBatteryLevel
      ?? directProperties.batteryLevel
      ?? directProperties.battery
    );
    const featureSet = new Set(features.map(normalizeFeature));
    const checks = [
      {
        key: 'state',
        label: 'Primary state',
        previous: Boolean(existingDevice?.status),
        homebrain: Boolean(directUpdate?.status),
        matched: Boolean(existingDevice?.status) === Boolean(directUpdate?.status)
      },
      {
        key: 'battery',
        label: 'Battery level',
        previous: smartThingsBattery,
        homebrain: directBattery,
        matched: smartThingsBattery === null || directBattery !== null,
        required: featureSet.has('battery')
      },
      {
        key: 'features',
        label: 'Feature coverage',
        previous: inferFeaturesFromSmartThings(existingDevice),
        homebrain: Array.from(featureSet).sort(),
        matched: inferFeaturesFromSmartThings(existingDevice)
          .every((feature) => featureSet.has(normalizeFeature(feature)))
      }
    ];

    return {
      validatedAt: new Date().toISOString(),
      status: checks.every((check) => check.matched) ? 'passed' : 'needs_review',
      checks
    };
  }

  emitDeviceUpdate(device) {
    if (!device) {
      return;
    }
    const payload = deviceUpdateEmitter.normalizeDevices([device]);
    if (payload.length > 0) {
      deviceUpdateEmitter.emit('devices:update', payload);
    }
  }

  async getMigrationPlan(deviceId, options = {}) {
    const safeDeviceId = normalizeObjectId(deviceId);
    const device = await Device.findById(safeDeviceId).lean();
    if (!device) {
      const error = new Error('Device not found');
      error.status = 404;
      throw error;
    }
    return buildMigrationPlan(device, options);
  }

  async startMigration({ deviceId, protocol, durationSeconds, dskPin, migrationId } = {}) {
    const safeDeviceId = normalizeObjectId(deviceId);
    const device = await Device.findById(safeDeviceId).lean();
    if (!device) {
      const error = new Error('Device not found');
      error.status = 404;
      throw error;
    }

    const plan = buildMigrationPlan(device, { protocol });
    const targetProtocol = ['zigbee', 'zwave'].includes(protocol) ? protocol : plan.recommendedProtocol;
    if (!['zigbee', 'zwave'].includes(targetProtocol)) {
      const error = new Error('Choose Zigbee or Z-Wave before starting migration');
      error.status = 400;
      throw error;
    }
    if (!plan.supported) {
      const error = new Error('This SmartThings device looks cloud-only or virtual and cannot be migrated to a direct radio.');
      error.status = 400;
      throw error;
    }

    const seconds = boundedSeconds(durationSeconds);
    const now = Date.now();
    const requestedMigrationId = trimString(migrationId);
    let migration = null;
    if (requestedMigrationId) {
      migration = this.activeMigrations.get(requestedMigrationId) || null;
      if (!migration) {
        const error = new Error('Migration session not found. Restart the guided migration from HomeBrain.');
        error.status = 404;
        throw error;
      }
    } else if (targetProtocol === 'zwave') {
      migration = Array.from(this.activeMigrations.values())
        .filter((entry) => entry.sourceDeviceId === safeDeviceId && entry.protocol === 'zwave')
        .filter((entry) => ['excluded', 'excluding'].includes(entry.status))
        .sort((left, right) => (
          new Date(right.updatedAt || right.startedAt || 0).getTime()
          - new Date(left.updatedAt || left.startedAt || 0).getTime()
        ))[0] || null;
    }

    if (targetProtocol === 'zwave') {
      if (!migration || migration.sourceDeviceId !== safeDeviceId || !migration.exclusionVerifiedAt) {
        const error = new Error('Z-Wave exclusion has not been verified yet. Keep this workflow on the exclusion step until HomeBrain receives the controller confirmation.');
        error.status = 409;
        throw error;
      }
    }

    if (!migration || migration.status === 'completed') {
      migration = {
        id: requestedMigrationId || `migration-${now}-${crypto.randomBytes(4).toString('hex')}`,
        sourceDeviceId: String(device._id),
        smartThingsDeviceId: device.properties?.smartThingsDeviceId || null,
        protocol: targetProtocol,
        startedAt: new Date(now).toISOString()
      };
    }

    Object.assign(migration, {
      sourceDeviceId: String(device._id),
      smartThingsDeviceId: device.properties?.smartThingsDeviceId || null,
      protocol: targetProtocol,
      status: 'pairing',
      pairingStartedAt: new Date(now).toISOString(),
      expiresAt: now + seconds * 1000,
      plan,
      updatedAt: new Date(now).toISOString()
    });
    this.activeMigrations.set(migration.id, migration);

    try {
      if (targetProtocol === 'zigbee') {
        await this.startPairing('zigbee', { durationSeconds: seconds });
      } else {
        this.zwave.s2DskPin = trimString(dskPin);
        await this.startPairing('zwave', { durationSeconds: seconds });
      }
    } catch (error) {
      migration.status = 'pairing_failed';
      migration.inclusionStatus = 'failed';
      migration.inclusionFailedAt = new Date().toISOString();
      migration.updatedAt = migration.inclusionFailedAt;
      throw error;
    }

    return {
      migration,
      plan: {
        ...plan,
        recommendedProtocol: targetProtocol,
        manualSteps: plan.manualSteps
      }
    };
  }

  buildMigrationVerificationResult(migration, result = {}) {
    const expiresAt = result.expiresAt ?? migration.exclusionExpiresAt ?? migration.expiresAt ?? null;
    const secondsRemaining = expiresAt
      ? Math.max(0, Math.ceil((Number(expiresAt) - Date.now()) / 1000))
      : 0;
    return {
      migrationId: migration.id,
      deviceId: migration.sourceDeviceId || null,
      protocol: migration.protocol,
      phase: result.phase || null,
      status: result.status || 'pending',
      verified: result.status === 'verified',
      canAdvance: result.status === 'verified',
      message: result.message || '',
      guidance: result.guidance || [],
      evidence: {
        exclusionVerifiedAt: migration.exclusionVerifiedAt || null,
        inclusionVerifiedAt: migration.inclusionVerifiedAt || null,
        completedAt: migration.completedAt || null,
        directIdentity: migration.directIdentity || null,
        directDeviceId: migration.directDeviceId || null,
        validation: migration.validation || null,
        zwaveEvents: Array.isArray(migration.zwaveEvents) ? migration.zwaveEvents.slice(-8) : [],
        expiresAt,
        secondsRemaining
      }
    };
  }

  verifyMigrationExclusion(migration) {
    if (migration.exclusionVerifiedAt) {
      return this.buildMigrationVerificationResult(migration, {
        phase: 'physical_exclusion',
        status: 'verified',
        message: 'Z-Wave exclusion verified. The controller received the device removal confirmation, so HomeBrain can open inclusion next.'
      });
    }

    if (migration.status === 'exclusion_failed' || migration.exclusionFailedAt) {
      return this.buildMigrationVerificationResult(migration, {
        phase: 'physical_exclusion',
        status: 'failed',
        message: 'Z-Wave exclusion failed. Re-open exclusion and repeat the physical exclude action at the switch.',
        guidance: [
          'Tap the local on/up paddle once, then wait a few seconds.',
          'If nothing reports back, toggle on/up and off/down quickly 3 times.',
          'Keep the switch powered and make sure the Zooz stick is close enough to hear the device.'
        ]
      });
    }

    const expiresAt = Number(migration.exclusionExpiresAt || migration.expiresAt || 0);
    if (expiresAt > Date.now()) {
      return this.buildMigrationVerificationResult(migration, {
        phase: 'physical_exclusion',
        status: 'pending',
        message: 'HomeBrain has not received the Z-Wave exclusion confirmation yet. Stay on this step until the controller reports Done.',
        guidance: [
          'Tap the local on/up paddle once.',
          'If the switch does not exclude, quickly toggle on/up and off/down 3 times.',
          'Do not start inclusion until this step verifies.'
        ],
        expiresAt
      });
    }

    return this.buildMigrationVerificationResult(migration, {
      phase: 'physical_exclusion',
      status: 'failed',
      message: 'The Z-Wave exclusion window closed without a controller confirmation.',
      guidance: [
        'Start Z-Wave exclusion again from HomeBrain.',
        'Repeat the physical exclude action at the switch while the window is open.',
        'Move the switch or Zooz stick closer if the controller still does not report the removal.'
      ],
      expiresAt
    });
  }

  verifyMigrationInclusion(migration) {
    const phase = migration.protocol === 'zigbee' ? 'physical_pairing' : 'physical_inclusion';
    if (migration.status === 'completed' && migration.inclusionVerifiedAt) {
      return this.buildMigrationVerificationResult(migration, {
        phase,
        status: 'verified',
        message: migration.protocol === 'zigbee'
          ? 'Zigbee pairing verified. HomeBrain created or updated the native device record from coordinator data.'
          : 'Z-Wave inclusion verified. HomeBrain received the new node and updated the native device record.'
      });
    }

    if (migration.status === 'pairing_failed' || migration.inclusionFailedAt) {
      return this.buildMigrationVerificationResult(migration, {
        phase,
        status: 'failed',
        message: migration.protocol === 'zigbee'
          ? 'Zigbee pairing failed before HomeBrain discovered the device.'
          : 'Z-Wave inclusion failed before HomeBrain received a verified node.',
        guidance: migration.protocol === 'zigbee'
          ? [
              'Open pairing again and factory reset the device while permit-join is active.',
              'Keep battery devices awake until HomeBrain captures the interview data.'
            ]
          : [
              'Open inclusion again only after exclusion has verified.',
              'Tap the local paddle once; if no node appears, use the quick 3-toggle sequence.',
              'Leave the switch powered until HomeBrain reports the interview.'
            ]
      });
    }

    const expiresAt = Number(migration.expiresAt || 0);
    if (expiresAt > Date.now()) {
      return this.buildMigrationVerificationResult(migration, {
        phase,
        status: 'pending',
        message: migration.protocol === 'zigbee'
          ? 'HomeBrain has not discovered the Zigbee device yet. Stay on this step while permit-join is open.'
          : 'HomeBrain has not received the new Z-Wave node yet. Stay on this step until inclusion verifies.',
        guidance: migration.protocol === 'zigbee'
          ? [
              'Keep the device in pairing mode until HomeBrain shows the native device.',
              'Wake battery sensors again if discovery starts but attributes are missing.'
            ]
          : [
              'Tap the local on/up paddle once or press the module button once.',
              'If no node appears, use the quick 3-toggle sequence.',
              'Do not finish migration until HomeBrain verifies the included node.'
            ],
        expiresAt
      });
    }

    return this.buildMigrationVerificationResult(migration, {
      phase,
      status: 'failed',
      message: migration.protocol === 'zigbee'
        ? 'The Zigbee pairing window closed without a verified HomeBrain device.'
        : 'The Z-Wave inclusion window closed without a verified HomeBrain node.',
      guidance: migration.protocol === 'zigbee'
        ? [
            'Open pairing again and repeat the device reset/pair action.',
            'Move the device closer to the SONOFF coordinator for the first join.'
          ]
        : [
            'Open inclusion again and repeat the switch include action.',
            'If inclusion repeatedly times out, run exclusion again first, then retry inclusion close to the Zooz stick.'
          ],
      expiresAt
    });
  }

  async verifyMigrationReadiness(migration) {
    if (migration.status !== 'completed') {
      return this.verifyMigrationInclusion(migration);
    }

    const device = await Device.findById(migration.sourceDeviceId).lean();
    const expectedSource = protocolSource(migration.protocol);
    const directProtocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol);
    const directRouteReady = normalizeSourceText(device?.properties?.source) === expectedSource
      && directProtocol === migration.protocol
      && device?.isOnline !== false;

    return this.buildMigrationVerificationResult(migration, directRouteReady
      ? {
          phase: 'verification',
          status: 'verified',
          message: 'HomeBrain verified the native route, online state, and migration metadata. Keep SmartThings available until you are satisfied the real control path behaves correctly.'
        }
      : {
          phase: 'verification',
          status: 'failed',
          message: 'HomeBrain found the migration session, but the native route is not ready on the device record yet.',
          guidance: [
            'Wait for the radio interview to finish and refresh the device details.',
            'Do not retire the SmartThings route until HomeBrain shows the native route online.'
          ]
        });
  }

  async verifyMigrationStep({ migrationId, deviceId, protocol, phase, stepId } = {}) {
    const safeDeviceId = trimString(deviceId) ? normalizeObjectId(deviceId) : '';
    const normalizedProtocol = normalizeSourceText(protocol);
    const migration = this.findMigrationSession({
      migrationId,
      deviceId: safeDeviceId,
      protocol: ['zigbee', 'zwave'].includes(normalizedProtocol) ? normalizedProtocol : undefined
    });
    if (!migration) {
      const error = new Error('Migration session not found. Start the guided migration from HomeBrain before verifying this step.');
      error.status = 404;
      throw error;
    }
    if (safeDeviceId && migration.sourceDeviceId !== safeDeviceId) {
      const error = new Error('Migration session does not match this device.');
      error.status = 409;
      throw error;
    }

    const normalizedPhase = normalizeSourceText(phase);
    let verification;
    if (normalizedPhase === 'physical_exclusion' || normalizedPhase === 'exclusion') {
      verification = this.verifyMigrationExclusion(migration);
    } else if (['physical_inclusion', 'physical_pairing', 'permit_join', 'inclusion'].includes(normalizedPhase)) {
      verification = this.verifyMigrationInclusion(migration);
    } else if (normalizedPhase === 'verification') {
      verification = await this.verifyMigrationReadiness(migration);
    } else {
      verification = this.buildMigrationVerificationResult(migration, {
        phase: normalizedPhase || null,
        status: 'verified',
        message: 'Step does not require radio verification.'
      });
    }

    return {
      verification: {
        ...verification,
        stepId: stepId || null
      },
      migration
    };
  }

  async startPairing(protocol, options = {}) {
    await this.start();
    const seconds = boundedSeconds(options.durationSeconds);
    if (protocol === 'zigbee') {
      if (!this.zigbee.controller || !this.zigbee.started) {
        this.log('warn', 'zigbee', 'Cannot open Zigbee permit-join because the coordinator is not ready', {
          requestedSeconds: seconds,
          detectedPort: this.detected.zigbee?.path || null,
          error: this.zigbee.error || null
        });
        const error = new Error('Zigbee controller is not ready. Plug in the SONOFF ZBDongle-P or set HOMEBRAIN_ZIGBEE_PORT.');
        error.status = 503;
        throw error;
      }
      this.log('info', 'zigbee', 'Opening Zigbee permit-join window', {
        durationSeconds: seconds,
        serialPath: this.detected.zigbee?.path || null
      });
      await this.zigbee.controller.permitJoin(seconds);
      this.zigbee.permitJoinUntil = new Date(Date.now() + seconds * 1000).toISOString();
      this.log('info', 'zigbee', 'Zigbee permit-join window is open', {
        expiresAt: this.zigbee.permitJoinUntil
      });
      return { protocol, mode: 'permit_join', expiresAt: this.zigbee.permitJoinUntil };
    }

    if (protocol === 'zwave') {
      const controller = this.getZWaveController();
      if (!controller || !this.zwave.started) {
        this.log('warn', 'zwave', 'Cannot open Z-Wave inclusion because the controller is not ready', {
          requestedSeconds: seconds,
          detectedPort: this.detected.zwave?.path || null,
          error: this.zwave.error || null
        });
        const error = new Error('Z-Wave controller is not ready. Plug in the Zooz ZST39 LR stick or set HOMEBRAIN_ZWAVE_PORT.');
        error.status = 503;
        throw error;
      }
      const zwave = require('zwave-js');
      this.log('info', 'zwave', 'Opening Z-Wave inclusion window', {
        durationSeconds: seconds,
        serialPath: this.detected.zwave?.path || null
      });
      await controller.beginInclusion({ strategy: zwave.InclusionStrategy.Default });
      this.zwave.inclusionUntil = new Date(Date.now() + seconds * 1000).toISOString();
      const stopTimer = setTimeout(() => {
        void this.stopPairing('zwave').catch((error) => {
          console.warn(`DirectRadioService: Failed to auto-stop Z-Wave inclusion: ${error.message}`);
        });
      }, seconds * 1000);
      if (typeof stopTimer.unref === 'function') {
        stopTimer.unref();
      }
      this.log('info', 'zwave', 'Z-Wave inclusion window is open', {
        expiresAt: this.zwave.inclusionUntil
      });
      return { protocol, mode: 'inclusion', expiresAt: this.zwave.inclusionUntil };
    }

    const error = new Error('Protocol must be zigbee or zwave');
    error.status = 400;
    throw error;
  }

  async startExclusion(protocol, options = {}) {
    await this.start();
    if (protocol !== 'zwave') {
      const error = new Error('Only Z-Wave supports controller-driven exclusion.');
      error.status = 400;
      throw error;
    }

    const controller = this.getZWaveController();
    if (!controller || !this.zwave.started) {
      this.log('warn', 'zwave', 'Cannot open Z-Wave exclusion because the controller is not ready', {
        detectedPort: this.detected.zwave?.path || null,
        error: this.zwave.error || null
      });
      const error = new Error('Z-Wave controller is not ready.');
      error.status = 503;
      throw error;
    }

    const seconds = boundedSeconds(options.durationSeconds);
    let migration = null;
    const safeDeviceId = trimString(options.deviceId) ? normalizeObjectId(options.deviceId) : '';
    if (safeDeviceId) {
      const device = await Device.findById(safeDeviceId).lean();
      if (!device) {
        const error = new Error('Device not found');
        error.status = 404;
        throw error;
      }
      const plan = buildMigrationPlan(device, { protocol: 'zwave' });
      if (!plan.supported) {
        const error = new Error('This SmartThings device looks cloud-only or virtual and cannot be migrated to a direct radio.');
        error.status = 400;
        throw error;
      }

      const requestedMigrationId = trimString(options.migrationId);
      const existingMigration = requestedMigrationId
        ? this.activeMigrations.get(requestedMigrationId)
        : Array.from(this.activeMigrations.values())
          .filter((entry) => entry.sourceDeviceId === safeDeviceId && entry.protocol === 'zwave')
          .filter((entry) => !['completed'].includes(entry.status))
          .sort((left, right) => (
            new Date(right.updatedAt || right.startedAt || 0).getTime()
            - new Date(left.updatedAt || left.startedAt || 0).getTime()
          ))[0];
      const now = Date.now();
      migration = existingMigration || {
        id: requestedMigrationId || `migration-${now}-${crypto.randomBytes(4).toString('hex')}`,
        sourceDeviceId: String(device._id),
        smartThingsDeviceId: device.properties?.smartThingsDeviceId || null,
        protocol: 'zwave',
        startedAt: new Date(now).toISOString()
      };
      Object.assign(migration, {
        sourceDeviceId: String(device._id),
        smartThingsDeviceId: device.properties?.smartThingsDeviceId || null,
        protocol: 'zwave',
        status: 'excluding',
        exclusionStatus: 'waiting',
        exclusionStartedAt: new Date(now).toISOString(),
        exclusionExpiresAt: now + seconds * 1000,
        expiresAt: now + seconds * 1000,
        plan,
        updatedAt: new Date(now).toISOString()
      });
      this.activeMigrations.set(migration.id, migration);
    }

    const zwave = require('zwave-js');
    this.log('info', 'zwave', 'Opening Z-Wave exclusion window', {
      durationSeconds: seconds,
      serialPath: this.detected.zwave?.path || null,
      migrationId: migration?.id || null
    });
    try {
      await controller.beginExclusion({ strategy: zwave.ExclusionStrategy.ExcludeOnly });
    } catch (error) {
      if (migration) {
        migration.status = 'exclusion_failed';
        migration.exclusionStatus = 'failed';
        migration.exclusionFailedAt = new Date().toISOString();
        migration.updatedAt = migration.exclusionFailedAt;
      }
      throw error;
    }
    this.zwave.exclusionUntil = new Date(Date.now() + seconds * 1000).toISOString();
    const stopTimer = setTimeout(() => {
      void this.stopPairing('zwave').catch(() => {});
    }, seconds * 1000);
    if (typeof stopTimer.unref === 'function') {
      stopTimer.unref();
    }
    this.log('info', 'zwave', 'Z-Wave exclusion window is open', {
      expiresAt: this.zwave.exclusionUntil,
      migrationId: migration?.id || null
    });
    return {
      protocol,
      mode: 'exclusion',
      expiresAt: this.zwave.exclusionUntil,
      migration
    };
  }

  async stopPairing(protocol = 'all') {
    if ((protocol === 'zigbee' || protocol === 'all') && this.zigbee.controller && this.zigbee.started) {
      await this.zigbee.controller.permitJoin(0);
      this.zigbee.permitJoinUntil = null;
      this.log('info', 'zigbee', 'Zigbee permit-join window closed');
    }

    if ((protocol === 'zwave' || protocol === 'all') && this.getZWaveController()) {
      const controller = this.getZWaveController();
      if (typeof controller.stopInclusion === 'function') {
        await controller.stopInclusion().catch(() => {});
      }
      if (typeof controller.stopExclusion === 'function') {
        await controller.stopExclusion().catch(() => {});
      }
      this.zwave.inclusionUntil = null;
      this.zwave.exclusionUntil = null;
      this.log('info', 'zwave', 'Z-Wave inclusion/exclusion windows closed');
    }

    return this.getStatus();
  }

  getDirectNodeForDevice(device) {
    if (!isDirectRadioDevice(device)) {
      return null;
    }
    const protocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol)
      || (normalizeSourceText(device?.properties?.source) === DIRECT_RADIO_SOURCES.zigbee ? 'zigbee' : 'zwave');

    if (protocol === 'zigbee') {
      const ieeeAddr = trimString(device?.properties?.homebrainDirect?.ieeeAddr);
      return ieeeAddr ? this.zigbee.controller?.getDeviceByIeeeAddr?.(ieeeAddr) || null : null;
    }

    if (protocol === 'zwave') {
      const nodeId = Number(device?.properties?.homebrainDirect?.nodeId);
      if (!Number.isFinite(nodeId)) {
        return null;
      }
      return this.getZWaveController()?.nodes?.get?.(nodeId) || this.zwave.driver?.getNode?.(nodeId) || null;
    }

    return null;
  }

  async controlDevice(device, normalizedAction, commandValue, updateData = {}) {
    await this.start();
    const protocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol)
      || (normalizeSourceText(device?.properties?.source) === DIRECT_RADIO_SOURCES.zigbee ? 'zigbee' : 'zwave');

    if (protocol === 'zigbee') {
      await this.controlZigbeeDevice(device, normalizedAction, commandValue, updateData);
      return;
    }

    if (protocol === 'zwave') {
      await this.controlZWaveDevice(device, normalizedAction, commandValue, updateData);
      return;
    }

    throw new Error('Direct radio protocol is not configured for this device');
  }

  async controlZigbeeDevice(device, normalizedAction, commandValue, updateData = {}) {
    const zigbeeDevice = this.getDirectNodeForDevice(device);
    const endpoint = readZigbeeEndpoint(zigbeeDevice);
    if (!endpoint || typeof endpoint.command !== 'function') {
      throw new Error('Zigbee device endpoint is not ready');
    }

    this.log('info', 'zigbee', 'Sending Zigbee device command', {
      deviceId: device?._id?.toString?.() || null,
      name: device?.name || null,
      action: normalizedAction,
      value: commandValue ?? null
    });

    switch (normalizedAction) {
      case 'toggle':
      case 'turnon':
      case 'turnoff': {
        const command = commandValue === true || normalizedAction === 'turnon'
          ? 'on'
          : normalizedAction === 'toggle'
            ? 'toggle'
            : 'off';
        await endpoint.command('genOnOff', command, {});
        break;
      }
      case 'setbrightness': {
        const level = Math.round((Math.max(0, Math.min(100, Number(commandValue))) / 100) * 254);
        await endpoint.command('genLevelCtrl', 'moveToLevelWithOnOff', { level, transtime: 0 });
        break;
      }
      case 'setcolor': {
        const rgb = hexToRgbPercent(commandValue);
        if (!rgb) throw new Error('Color value must be a valid hex color string');
        await endpoint.command('lightingColorCtrl', 'moveToColor', {
          colorx: Math.round((rgb.red / 255) * 65279),
          colory: Math.round((rgb.green / 255) * 65279),
          transtime: 0
        });
        break;
      }
      case 'setcolortemperature': {
        const colortemp = kelvinToMired(commandValue);
        if (!colortemp) throw new Error('Color temperature must be a valid kelvin value');
        await endpoint.command('lightingColorCtrl', 'moveToColorTemp', { colortemp, transtime: 0 });
        break;
      }
      case 'lock':
        await endpoint.command('closuresDoorLock', 'lockDoor', {});
        break;
      case 'unlock':
        await endpoint.command('closuresDoorLock', 'unlockDoor', {});
        break;
      default:
        throw new Error('This Zigbee device does not support the requested action yet');
    }

    updateData.isOnline = true;
    updateData.lastSeen = new Date();
    this.log('info', 'zigbee', 'Zigbee device command accepted', {
      deviceId: device?._id?.toString?.() || null,
      name: device?.name || null,
      action: normalizedAction
    });
  }

  async setZWaveValue(node, valueDef, value, options = {}) {
    const result = await node.setValue(valueDef.id || valueDef, value, options);
    const status = result?.status;
    const zwave = require('zwave-js');
    if (status === zwave.SetValueStatus.Fail || status === zwave.SetValueStatus.NoDeviceSupport || status === zwave.SetValueStatus.NotImplemented) {
      throw new Error(result?.message || 'Z-Wave command was not accepted by the device');
    }
    return result;
  }

  async controlZWaveDevice(device, normalizedAction, commandValue, updateData = {}) {
    const node = this.getDirectNodeForDevice(device);
    if (!node) {
      throw new Error('Z-Wave node is not ready');
    }
    const zwave = require('zwave-js');
    this.log('info', 'zwave', 'Sending Z-Wave device command', {
      deviceId: device?._id?.toString?.() || null,
      name: device?.name || null,
      nodeId: device?.properties?.homebrainDirect?.nodeId || null,
      action: normalizedAction,
      value: commandValue ?? null
    });

    switch (normalizedAction) {
      case 'toggle':
      case 'turnon':
      case 'turnoff': {
        const target = normalizedAction === 'toggle' ? Boolean(commandValue) : normalizedAction === 'turnon';
        if (device?.properties?.supportsBrightness || device?.brightness > 0) {
          await this.setZWaveValue(node, zwave.MultilevelSwitchCCValues.targetValue, target ? Math.max(1, Number(device?.brightness) || 99) : 0);
        } else {
          await this.setZWaveValue(node, zwave.BinarySwitchCCValues.targetValue, target);
        }
        break;
      }
      case 'setbrightness':
        await this.setZWaveValue(node, zwave.MultilevelSwitchCCValues.targetValue, Math.max(0, Math.min(99, Math.round(Number(commandValue)))));
        break;
      case 'setcolor':
        await this.setZWaveValue(node, zwave.ColorSwitchCCValues.hexColor, trimString(commandValue).replace(/^#/, ''));
        break;
      case 'settemperature': {
        const mode = normalizeSourceText(device?.properties?.hvacMode || device?.properties?.zwaveThermostatMode || '');
        const setpointType = mode === 'cool' ? 2 : 1;
        await this.setZWaveValue(node, zwave.ThermostatSetpointCCValues.setpoint(setpointType), Number(commandValue));
        break;
      }
      case 'setmode': {
        const modeMap = {
          off: zwave.ThermostatMode.Off,
          heat: zwave.ThermostatMode.Heat,
          cool: zwave.ThermostatMode.Cool,
          auto: zwave.ThermostatMode.Auto
        };
        const mode = modeMap[normalizeSourceText(commandValue)];
        if (mode === undefined) {
          throw new Error('Unsupported thermostat mode');
        }
        await this.setZWaveValue(node, zwave.ThermostatModeCCValues.thermostatMode, mode);
        break;
      }
      case 'lock':
        await this.setZWaveValue(node, zwave.DoorLockCCValues.targetMode, zwave.DoorLockMode.Secured);
        break;
      case 'unlock':
        await this.setZWaveValue(node, zwave.DoorLockCCValues.targetMode, zwave.DoorLockMode.Unsecured);
        break;
      case 'alarmoff':
      case 'turnoffalarm':
        if (device?.properties?.supportsAlarm) {
          await this.setZWaveValue(node, zwave.BinarySwitchCCValues.targetValue, false).catch(async () => {
            await this.setZWaveValue(node, zwave.SoundSwitchCCValues.volume, 0);
          });
        }
        break;
      default:
        throw new Error('This Z-Wave device does not support the requested action yet');
    }

    updateData.isOnline = true;
    updateData.lastSeen = new Date();
    this.log('info', 'zwave', 'Z-Wave device command accepted', {
      deviceId: device?._id?.toString?.() || null,
      name: device?.name || null,
      action: normalizedAction
    });
  }

  async refreshDirectDeviceState(device) {
    if (!isDirectRadioDevice(device)) {
      return null;
    }

    const node = this.getDirectNodeForDevice(device);
    if (!node) {
      return null;
    }

    const protocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol);
    const normalized = protocol === 'zigbee'
      ? this.normalizeZigbeeDevice(node, 'refresh')
      : this.normalizeZWaveNode(node, 'refresh');
    return normalized?.update || null;
  }

  getDetectedPortDetails(protocol) {
    const detectedPath = this.detected?.[protocol]?.path;
    if (!detectedPath) {
      return null;
    }

    const match = this.serialPorts.find((port) => (
      port.path === detectedPath
      || port.stablePath === detectedPath
      || port.rawPath === detectedPath
      || port.realPath === detectedPath
    ));

    return match || {
      path: detectedPath,
      configured: this.detected?.[protocol]?.configured === true,
      scores: {
        [protocol]: this.detected?.[protocol]?.score ?? null
      }
    };
  }

  buildControllerDiagnostics(protocol, portDetails = null) {
    const controller = protocol === 'zigbee' ? this.zigbee : this.zwave;
    const detected = this.detected?.[protocol];
    const configuredPort = trimString(protocol === 'zigbee'
      ? process.env.HOMEBRAIN_ZIGBEE_PORT
      : process.env.HOMEBRAIN_ZWAVE_PORT);
    const protocolEnabled = parseEnabledFlag(protocol === 'zigbee'
      ? process.env.HOMEBRAIN_ZIGBEE_ENABLED
      : process.env.HOMEBRAIN_ZWAVE_ENABLED, true);
    const label = protocol === 'zigbee' ? 'Zigbee' : 'Z-Wave';
    const expected = protocol === 'zigbee'
      ? 'SONOFF ZBDongle-P / TI CC2652P coordinator'
      : 'Zooz ZST39 LR / 800-series Z-Wave stick';
    const likelyCount = this.serialPorts.filter((port) => (
      protocol === 'zigbee' ? port.likelyZigbee : port.likelyZWave
    )).length;
    const diagnostics = [];

    if (!parseEnabledFlag(process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED, true)) {
      diagnostics.push('Direct Zigbee/Z-Wave radios are disabled by HOMEBRAIN_DIRECT_RADIOS_ENABLED.');
      return diagnostics;
    }

    if (!protocolEnabled) {
      diagnostics.push(`${label} runtime is disabled by configuration.`);
      return diagnostics;
    }

    if (!detected?.path) {
      diagnostics.push(`No ${label} USB adapter detected. Expected ${expected}; HomeBrain currently sees ${describeSerialEndpoints(this.serialPorts)}.`);
      diagnostics.push('Check the Jetson USB connection, container/device passthrough if applicable, and read permissions for the HomeBrain service user. Stable USB adapters should appear under /dev/serial/by-id/.');
      return diagnostics;
    }

    if (!configuredPort && likelyCount === 0 && portDetails?.path) {
      diagnostics.push(`${label} is using ${portDetails.path}, but the serial descriptor did not strongly identify the expected adapter. If this is correct, set ${protocol === 'zigbee' ? 'HOMEBRAIN_ZIGBEE_PORT' : 'HOMEBRAIN_ZWAVE_PORT'} to the stable /dev/serial/by-id path.`);
    }

    if (!controller.started) {
      diagnostics.push(controller.error
        ? `${label} adapter was detected at ${detected.path}, but the controller did not start: ${controller.error}`
        : `${label} adapter was detected at ${detected.path}, but the controller is not started yet.`);
    }

    if (controller.error && controller.started) {
      diagnostics.push(`${label} controller last reported: ${controller.error}`);
    }

    return diagnostics;
  }

  async getStatus() {
    const zigbeeDevices = this.zigbee.controller?.getDevices?.() || [];
    const zwaveNodes = this.getZWaveController()?.nodes;
    const activeMigrations = Array.from(this.activeMigrations.values())
      .filter((migration) => (
        ['excluding', 'excluded', 'pairing', 'exclusion_failed', 'pairing_failed'].includes(migration.status)
        && (Number(migration.expiresAt || 0) > Date.now() || Number(migration.exclusionExpiresAt || 0) > Date.now() || migration.status === 'excluded')
      ));
    const zigbeePortDetails = this.getDetectedPortDetails('zigbee');
    const zwavePortDetails = this.getDetectedPortDetails('zwave');
    const zigbeeDiagnostics = this.buildControllerDiagnostics('zigbee', zigbeePortDetails);
    const zwaveDiagnostics = this.buildControllerDiagnostics('zwave', zwavePortDetails);

    return {
      enabled: parseEnabledFlag(process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED, true),
      dataDir: DATA_DIR,
      serialPorts: this.serialPorts,
      diagnostics: [...zigbeeDiagnostics, ...zwaveDiagnostics],
      controllers: {
        zigbee: {
          expectedHardware: 'SONOFF ZBDongle-P / TI CC2652P Z-Stack coordinator',
          source: DIRECT_RADIO_SOURCES.zigbee,
          detectedPort: this.detected.zigbee?.path || null,
          detectedPortDetails: zigbeePortDetails,
          configuredPort: trimString(process.env.HOMEBRAIN_ZIGBEE_PORT) || null,
          started: this.zigbee.started,
          error: this.zigbee.error,
          diagnostics: zigbeeDiagnostics,
          permitJoinUntil: this.zigbee.permitJoinUntil,
          lastStartResult: this.zigbee.lastStartResult,
          pairedDeviceCount: zigbeeDevices.filter((device) => device?.type !== 'Coordinator').length
        },
        zwave: {
          expectedHardware: 'Zooz ZST39 LR / 800-series Z-Wave SerialAPI USB stick',
          source: DIRECT_RADIO_SOURCES.zwave,
          detectedPort: this.detected.zwave?.path || null,
          detectedPortDetails: zwavePortDetails,
          configuredPort: trimString(process.env.HOMEBRAIN_ZWAVE_PORT) || null,
          started: this.zwave.started,
          error: this.zwave.error,
          diagnostics: zwaveDiagnostics,
          inclusionUntil: this.zwave.inclusionUntil,
          exclusionUntil: this.zwave.exclusionUntil,
          pendingDsk: this.zwave.pendingDsk,
          pairedNodeCount: zwaveNodes && typeof zwaveNodes.size === 'number' ? zwaveNodes.size : 0
        }
      },
      migrations: activeMigrations
    };
  }

  async shutdown() {
    if (this.hardwareMonitorTimer) {
      clearInterval(this.hardwareMonitorTimer);
      this.hardwareMonitorTimer = null;
    }
    await this.stopPairing('all').catch(() => {});
    if (this.zigbee.controller) {
      try {
        await this.zigbee.controller.stop();
      } catch (error) {
        console.warn(`DirectRadioService: Failed to stop Zigbee controller: ${error.message}`);
      }
    }
    if (this.zwave.driver) {
      try {
        await this.zwave.driver.destroy();
      } catch (error) {
        console.warn(`DirectRadioService: Failed to destroy Z-Wave driver: ${error.message}`);
      }
    }
    this.zigbee.started = false;
    this.zwave.started = false;
  }
}

const directRadioService = new DirectRadioService();
directRadioService.DirectRadioService = DirectRadioService;
directRadioService._test = {
  addFallbackSerialPortCandidates,
  choosePortForProtocol,
  enrichSerialPortForDirectRadios,
  looksLikeSonoffMg24ThreadStick,
  normalizeSerialPort,
  scorePortForProtocol
};

module.exports = directRadioService;

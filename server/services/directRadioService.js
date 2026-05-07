const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const mongoose = require('mongoose');
const os = require('os');
const path = require('path');
const Device = require('../models/Device');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const {
  DIRECT_RADIO_SOURCES,
  buildDirectFeatureProperties,
  buildMigrationPlan,
  inferFeaturesFromSmartThings,
  isDirectRadioDevice,
  normalizeFeature
} = require('./directRadioDeviceCatalog');

const DATA_DIR = process.env.HOMEBRAIN_DIRECT_RADIO_DATA_DIR
  || path.join(__dirname, '..', 'data', 'direct-radios');
const ZIGBEE_DIR = path.join(DATA_DIR, 'zigbee');
const ZWAVE_DIR = path.join(DATA_DIR, 'zwave');
const CONFIG_PATH = path.join(DATA_DIR, 'controller-config.json');
const DEFAULT_PAIRING_SECONDS = 120;
const MAX_PAIRING_SECONDS = 900;
const DIRECT_DEVICE_PROJECTION = 'name type room groups status brightness color colorTemperature temperature targetTemperature isOnline lastSeen properties brand model';

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

function scorePortForProtocol(port, protocol) {
  const descriptor = port?.descriptor || '';
  const vendorId = trimString(port?.vendorId).toLowerCase();
  const productId = trimString(port?.productId).toLowerCase();
  let score = 0;

  if (protocol === 'zigbee') {
    if (/\b(?:sonoff|itead|zbdongle|zbdongle-p|zigbee|cc2652|cc1352|z-stack|zstack)\b/.test(descriptor)) score += 12;
    if (/\b(?:cp2102|cp210x|silicon labs)\b/.test(descriptor)) score += 2;
    if (vendorId === '10c4' && productId === 'ea60') score += 2;
    if (/\b(?:z-wave|zwave|zst39|zooz|700 series|800 series|uzb)\b/.test(descriptor)) score -= 8;
  } else if (protocol === 'zwave') {
    if (/\b(?:z-wave|zwave|zst39|zooz|800 series|700 series|uzb|serialapi|serial api)\b/.test(descriptor)) score += 12;
    if (/\b(?:cp2102|cp210x|silicon labs)\b/.test(descriptor)) score += 2;
    if (vendorId === '10c4' && productId === 'ea60') score += 2;
    if (/\b(?:sonoff|itead|zbdongle|zigbee|cc2652|cc1352|z-stack|zstack)\b/.test(descriptor)) score -= 8;
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
  if (/\b(?:bulb|light|lamp|led)\b/.test(deviceText)) {
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
      pendingDsk: null
    };
    this.activeMigrations = new Map();
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
    ensureDirSync(DATA_DIR);
    ensureDirSync(ZIGBEE_DIR);
    ensureDirSync(ZWAVE_DIR);
    await this.ensureControllerConfig();

    if (!parseEnabledFlag(process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED, true)) {
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

    return this.getStatus();
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

  async detectSerialPorts() {
    let SerialPortModule;
    try {
      SerialPortModule = require('serialport');
    } catch (error) {
      this.serialPorts = [];
      this.detected.zigbee = null;
      this.detected.zwave = null;
      this.zigbee.error = `serialport unavailable: ${error.message}`;
      this.zwave.error = `serialport unavailable: ${error.message}`;
      return this.serialPorts;
    }

    let rawPorts = [];
    try {
      rawPorts = await SerialPortModule.list();
    } catch (error) {
      this.serialPorts = [];
      this.zigbee.error = `Failed to list serial ports: ${error.message}`;
      this.zwave.error = `Failed to list serial ports: ${error.message}`;
      return this.serialPorts;
    }

    const stableLinks = resolveLocalSerialById();
    this.serialPorts = rawPorts.map((port) => normalizeSerialPort(port, stableLinks));

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

    return this.serialPorts;
  }

  async startZigbee(serialPath) {
    try {
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
        void this.handleZigbeeDeviceChanged(payload?.device, 'deviceJoined');
      });
      controller.on('deviceInterview', (payload) => {
        if (payload?.status === 'successful') {
          void this.handleZigbeeDeviceChanged(payload.device, 'deviceInterview');
        }
      });
      controller.on('deviceAnnounce', (payload) => {
        void this.handleZigbeeDeviceChanged(payload?.device, 'deviceAnnounce');
      });
      controller.on('message', (payload) => {
        void this.handleZigbeeDeviceChanged(payload?.device, 'message');
      });
      controller.on('adapterDisconnected', () => {
        this.zigbee.started = false;
        this.zigbee.error = 'Zigbee adapter disconnected';
      });

      this.zigbee.controller = controller;
      this.zigbee.lastStartResult = await controller.start();
      this.zigbee.started = true;
      this.zigbee.error = null;
      await this.syncZigbeeDevices();
    } catch (error) {
      this.zigbee.started = false;
      this.zigbee.error = error.message;
      console.warn(`DirectRadioService: Zigbee controller failed to start: ${error.message}`);
    }
  }

  async startZWave(serialPath) {
    try {
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

      driver.on('driver ready', () => {
        this.zwave.started = true;
        this.zwave.error = null;
        void this.syncZWaveNodes();
      });
      driver.on('all nodes ready', () => {
        void this.syncZWaveNodes();
      });
      driver.on('node added', (node) => {
        void this.handleZWaveNodeChanged(node, 'node added');
      });
      driver.on('node ready', (node) => {
        void this.handleZWaveNodeChanged(node, 'node ready');
      });
      driver.on('node value updated', (node) => {
        void this.handleZWaveNodeChanged(node, 'node value updated');
      });
      driver.on('error', (error) => {
        this.zwave.error = error.message;
      });

      this.zwave.driver = driver;
      await driver.start();
      this.zwave.started = true;
      this.zwave.error = null;
    } catch (error) {
      this.zwave.started = false;
      this.zwave.error = error.message;
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
          return configuredPin;
        }
        console.warn(`DirectRadioService: Z-Wave S2 DSK PIN required for ${dsk}`);
        return false;
      },
      abort: () => {
        this.zwave.pendingDsk = null;
      }
    };
  }

  getZWaveController() {
    return this.zwave.driver?.controller || null;
  }

  async syncZigbeeDevices() {
    const devices = this.zigbee.controller?.getDevices?.() || [];
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
      return;
    }

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
        type: this.inferDeviceTypeFromFeatures(features),
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
        type: this.inferDeviceTypeFromFeatures(directFeatures),
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

  inferDeviceTypeFromFeatures(features = []) {
    const featureSet = new Set(features.map(normalizeFeature));
    if (featureSet.has('lock')) return 'lock';
    if (featureSet.has('thermostat')) return 'thermostat';
    if (featureSet.has('color') || featureSet.has('colorTemperature') || featureSet.has('brightness')) return 'light';
    if (featureSet.has('contact') || featureSet.has('motion') || featureSet.has('water') || featureSet.has('smoke') || featureSet.has('battery')) return 'sensor';
    if (featureSet.has('switch') || featureSet.has('power') || featureSet.has('energy')) return 'switch';
    if (featureSet.has('alarm')) return 'switch';
    return 'sensor';
  }

  async handleZigbeeDeviceChanged(zigbeeDevice, reason) {
    const normalized = this.normalizeZigbeeDevice(zigbeeDevice, reason);
    if (!normalized) {
      return null;
    }
    return this.upsertDirectDevice(normalized.identity, normalized.update);
  }

  async handleZWaveNodeChanged(node, reason) {
    const normalized = this.normalizeZWaveNode(node, reason);
    if (!normalized) {
      return null;
    }
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
    migration.directIdentity = identity;
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

  async startMigration({ deviceId, protocol, durationSeconds, dskPin } = {}) {
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
    const migrationId = `migration-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const migration = {
      id: migrationId,
      sourceDeviceId: String(device._id),
      smartThingsDeviceId: device.properties?.smartThingsDeviceId || null,
      protocol: targetProtocol,
      status: 'pairing',
      startedAt: new Date().toISOString(),
      expiresAt: Date.now() + seconds * 1000,
      plan
    };
    this.activeMigrations.set(migrationId, migration);

    if (targetProtocol === 'zigbee') {
      await this.startPairing('zigbee', { durationSeconds: seconds });
    } else {
      this.zwave.s2DskPin = trimString(dskPin);
      await this.startPairing('zwave', { durationSeconds: seconds });
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

  async startPairing(protocol, options = {}) {
    await this.start();
    const seconds = boundedSeconds(options.durationSeconds);
    if (protocol === 'zigbee') {
      if (!this.zigbee.controller || !this.zigbee.started) {
        const error = new Error('Zigbee controller is not ready. Plug in the SONOFF ZBDongle-P or set HOMEBRAIN_ZIGBEE_PORT.');
        error.status = 503;
        throw error;
      }
      await this.zigbee.controller.permitJoin(seconds);
      this.zigbee.permitJoinUntil = new Date(Date.now() + seconds * 1000).toISOString();
      return { protocol, mode: 'permit_join', expiresAt: this.zigbee.permitJoinUntil };
    }

    if (protocol === 'zwave') {
      const controller = this.getZWaveController();
      if (!controller || !this.zwave.started) {
        const error = new Error('Z-Wave controller is not ready. Plug in the Zooz ZST39 LR stick or set HOMEBRAIN_ZWAVE_PORT.');
        error.status = 503;
        throw error;
      }
      const zwave = require('zwave-js');
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
      const error = new Error('Z-Wave controller is not ready.');
      error.status = 503;
      throw error;
    }

    const seconds = boundedSeconds(options.durationSeconds);
    const zwave = require('zwave-js');
    await controller.beginExclusion({ strategy: zwave.ExclusionStrategy.ExcludeOnly });
    this.zwave.exclusionUntil = new Date(Date.now() + seconds * 1000).toISOString();
    const stopTimer = setTimeout(() => {
      void this.stopPairing('zwave').catch(() => {});
    }, seconds * 1000);
    if (typeof stopTimer.unref === 'function') {
      stopTimer.unref();
    }
    return { protocol, mode: 'exclusion', expiresAt: this.zwave.exclusionUntil };
  }

  async stopPairing(protocol = 'all') {
    if ((protocol === 'zigbee' || protocol === 'all') && this.zigbee.controller && this.zigbee.started) {
      await this.zigbee.controller.permitJoin(0);
      this.zigbee.permitJoinUntil = null;
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

  async getStatus() {
    const zigbeeDevices = this.zigbee.controller?.getDevices?.() || [];
    const zwaveNodes = this.getZWaveController()?.nodes;
    const activeMigrations = Array.from(this.activeMigrations.values())
      .filter((migration) => migration.expiresAt > Date.now() && migration.status === 'pairing');

    return {
      enabled: parseEnabledFlag(process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED, true),
      dataDir: DATA_DIR,
      serialPorts: this.serialPorts,
      controllers: {
        zigbee: {
          expectedHardware: 'SONOFF ZBDongle-P / TI CC2652P Z-Stack coordinator',
          source: DIRECT_RADIO_SOURCES.zigbee,
          detectedPort: this.detected.zigbee?.path || null,
          configuredPort: trimString(process.env.HOMEBRAIN_ZIGBEE_PORT) || null,
          started: this.zigbee.started,
          error: this.zigbee.error,
          permitJoinUntil: this.zigbee.permitJoinUntil,
          lastStartResult: this.zigbee.lastStartResult,
          pairedDeviceCount: zigbeeDevices.filter((device) => device?.type !== 'Coordinator').length
        },
        zwave: {
          expectedHardware: 'Zooz ZST39 LR / 800-series Z-Wave SerialAPI USB stick',
          source: DIRECT_RADIO_SOURCES.zwave,
          detectedPort: this.detected.zwave?.path || null,
          configuredPort: trimString(process.env.HOMEBRAIN_ZWAVE_PORT) || null,
          started: this.zwave.started,
          error: this.zwave.error,
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
  choosePortForProtocol,
  normalizeSerialPort,
  scorePortForProtocol
};

module.exports = directRadioService;

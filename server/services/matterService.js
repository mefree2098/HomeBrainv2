const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const Device = require('../models/Device');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
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
const DEFAULT_OTBR_REST_URL = process.env.HOMEBRAIN_OTBR_REST_URL || 'http://127.0.0.1:8081';
const DEFAULT_COMMISSIONING_TIMEOUT_SECONDS = Math.max(20, Number(process.env.HOMEBRAIN_MATTER_COMMISSIONING_TIMEOUT_SECONDS || 90));
const SONOFF_MG24_ASIN = 'B0FMJD288B';

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
  role: 'Thread RCP for OpenThread Border Router; Matter over IP via Ethernet/Wi-Fi/Thread'
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

function looksLikeSonoffMg24Port(port = {}) {
  const descriptor = [
    port.path,
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

  return /\b(sonoff|itead|dongle.?m|dongle.?plus.?mg24|mg24|efr32mg24|silicon labs|cp210)\b/.test(descriptor)
    && !/\b(zooz|zst10|zwave|z-wave|zw090|zwave js)\b/.test(descriptor);
}

function normalizeSerialPort(port = {}) {
  return {
    path: port.path,
    manufacturer: port.manufacturer || null,
    serialNumber: port.serialNumber || null,
    vendorId: port.vendorId || null,
    productId: port.productId || null,
    pnpId: port.pnpId || null,
    friendlyName: port.friendlyName || null,
    isExpectedMatterThreadStick: looksLikeSonoffMg24Port(port)
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
    this.runtime = null;
    this.detectedSerialPorts = [];
    this.lastThreadStatus = null;
  }

  async ensureDataDir() {
    await fsp.mkdir(MATTER_DATA_DIR, { recursive: true });
    await fsp.mkdir(MATTER_STORAGE_DIR, { recursive: true });
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
      otbrRestUrl: normalizeOtbrRestUrl(DEFAULT_OTBR_REST_URL),
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
      return this.getStatus();
    }

    this.started = true;
    this.startError = null;

    try {
      await this.loadConfig();
      await this.loadSessions();
      this.detectedSerialPorts = await this.detectSerialPorts();
      this.lastThreadStatus = await this.getThreadStatus({ refreshPorts: false });
      if (this.config.autoStartController && this.config.enabled) {
        await this.ensureController().catch((error) => {
          this.startError = error.message;
          console.warn(`MatterService: Matter controller startup deferred: ${error.message}`);
        });
      }
    } catch (error) {
      this.startError = error.message;
      console.warn(`MatterService: Startup failed: ${error.message}`);
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

  async detectSerialPorts() {
    try {
      const serialportModule = require('serialport');
      const listSerialPorts = getSerialPortListFunction(serialportModule);
      if (!listSerialPorts) {
        throw new Error('serialport.list is not available');
      }
      const ports = await listSerialPorts();
      return ports.map(normalizeSerialPort);
    } catch (error) {
      console.warn(`MatterService: Unable to list serial ports: ${error.message}`);
      return [];
    }
  }

  async checkOtbrRest() {
    const baseUrl = normalizeOtbrRestUrl(DEFAULT_OTBR_REST_URL);
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

  async getThreadStatus(options = {}) {
    const config = await this.loadConfig();
    const serialPorts = options.refreshPorts === false
      ? this.detectedSerialPorts
      : await this.detectSerialPorts();
    if (options.refreshPorts !== false) {
      this.detectedSerialPorts = serialPorts;
    }

    const expectedPorts = serialPorts.filter((port) => port.isExpectedMatterThreadStick);
    const selectedPort = expectedPorts.find((port) => port.path === config.preferredThreadPort)
      || expectedPorts[0]
      || null;
    const otbr = await this.checkOtbrRest();
    const configuredDataset = normalizeString(config.thread?.operationalDataset);
    const activeDataset = configuredDataset || otbr.dataset || '';

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
        hasActiveDataset: Boolean(activeDataset),
        activeDatasetSource: configuredDataset ? 'homebrain-config' : (otbr.dataset ? 'otbr-rest' : null)
      },
      readyForThreadCommissioning: Boolean(expectedPorts.length > 0 && activeDataset),
      manualSteps: buildManualSteps({
        transport: MATTER_TRANSPORTS.thread,
        hasThreadDataset: Boolean(activeDataset),
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
      const runtime = this.loadMatterRuntime();
      await fsp.mkdir(config.storagePath, { recursive: true });
      const environment = runtime.NodeJsEnvironment();
      environment.vars.set('storage.path', config.storagePath);
      environment.get(runtime.StorageService).location = config.storagePath;

      if (runtime.NodeJsBle && runtime.Ble) {
        runtime.Ble.get = runtime.singleton(() => new runtime.NodeJsBle({ environment }));
      }

      const controller = new runtime.CommissioningController({
        environment: {
          environment,
          id: 'homebrain-matter-controller'
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
      this.controller = controller;
      return controller;
    })();

    try {
      return await this.controllerStartPromise;
    } finally {
      this.controllerStartPromise = null;
    }
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
    const otbr = await this.checkOtbrRest();
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
    const features = normalizeFeatureList(descriptor.features?.length
      ? descriptor.features
      : inferFeaturesFromMatterDescriptor(endpointDescriptorFromRecord(descriptor)));
    const homeBrainType = descriptor.homeBrainType || inferHomeBrainTypeFromFeatures(features, descriptor);
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
          transport: normalizeTransport(options.transport),
          clusterIds: descriptor.clusterIds || [],
          clusterNames: descriptor.clusterNames || [],
          deviceTypeNames: descriptor.deviceTypeNames || [],
          productName: descriptor.productName || '',
          vendorName: descriptor.vendorName || '',
          endpointName: descriptor.endpointName || '',
          lastSyncedAt: new Date().toISOString()
        },
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
        'Thread credentials through OpenThread Border Router',
        'Wi-Fi credentials through BLE commissioning when Bluetooth is available'
      ]
    };
  }
}

const matterService = new MatterService();
matterService.MatterService = MatterService;
matterService._test = {
  buildManualSteps,
  endpointDescriptorFromRecord,
  getSerialPortListFunction,
  isAllowedLocalOtbrHost,
  looksLikeSonoffMg24Port,
  normalizeSerialPort,
  normalizeOtbrRestUrl,
  normalizeTransport,
  parseKnownAddress
};

module.exports = matterService;

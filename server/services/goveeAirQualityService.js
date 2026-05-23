const axios = require('axios');
const dgram = require('dgram');
const os = require('os');
const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const Device = require('../models/Device');
const GoveeIntegration = require('../models/GoveeIntegration');
const TelemetrySample = require('../models/TelemetrySample');
const telemetryService = require('./telemetryService');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');

const DEFAULT_API_BASE = 'https://openapi.api.govee.com';
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_HTTP_TIMEOUT_MS = 12000;
const DEFAULT_HISTORY_HOURS = 24;
const DEFAULT_HISTORY_LIMIT = 240;
const DEFAULT_LAN_DISCOVERY_TIMEOUT_MS = 3500;
const GOVEE_LAN_MULTICAST_ADDRESS = '239.255.255.250';
const GOVEE_LAN_SCAN_PORT = 4001;
const GOVEE_LAN_LISTEN_PORT = 4002;
const GOVEE_LAN_CONTROL_PORT = 4003;
const GOVEE_SOURCE_TYPE = 'govee_air_quality';
const GOVEE_STREAM_TYPE = 'govee_air_quality_sample';
const GOVEE_LAN_MULTICAST_TARGET = `${GOVEE_LAN_MULTICAST_ADDRESS}:${GOVEE_LAN_SCAN_PORT}`;
const GOVEE_LAN_MAX_SUBNET_SWEEP_HOSTS = 512;

const trimString = (value, fallback = '') => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

const isDatabaseUnavailableForTest = () => (
  process.env.NODE_ENV === 'test' && mongoose.connection.readyState === 0
);

const maskSecret = (value) => {
  const trimmed = trimString(value, '');
  if (!trimmed) {
    return '';
  }

  if (trimmed.length <= 4) {
    return '*'.repeat(trimmed.length);
  }

  return `${'*'.repeat(Math.max(8, trimmed.length - 4))}${trimmed.slice(-4)}`;
};

const isMaskedSecret = (value) => {
  const trimmed = trimString(value, '');
  return /^[*•]+$/.test(trimmed) || /^[*•]{4,}[^*•\s]+$/.test(trimmed);
};

const toNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (value && typeof value === 'object') {
    return toNumber(value.value);
  }

  return null;
};

const roundNumber = (value, digits = 1) => {
  const numeric = toNumber(value);
  if (numeric === null) {
    return null;
  }

  const multiplier = 10 ** digits;
  return Math.round(numeric * multiplier) / multiplier;
};

const clampPollIntervalMs = (value) => {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return Math.max(60 * 1000, Math.min(60 * 60 * 1000, numeric));
};

const normalizeConnectionMode = (value) => {
  const normalized = trimString(value, 'auto').toLowerCase();
  return ['auto', 'cloud', 'local'].includes(normalized) ? normalized : 'auto';
};

const clampUdpPort = (value, fallback = GOVEE_LAN_CONTROL_PORT) => {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 65535) {
    return fallback;
  }
  return numeric;
};

const normalizeLanTimeoutMs = (value) => {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric)) {
    return DEFAULT_LAN_DISCOVERY_TIMEOUT_MS;
  }
  if (numeric <= 1_000) {
    return 1_000;
  }
  if (numeric <= 2_500) {
    return 2_500;
  }
  if (numeric <= 5_000) {
    return 5_000;
  }
  if (numeric <= 7_500) {
    return 7_500;
  }
  return 10_000;
};

const normalizeLanCommand = (value) => (
  trimString(value, '').toLowerCase() === 'devstatus' ? 'devStatus' : 'scan'
);

const normalizeLanTarget = (target, fallbackPort = GOVEE_LAN_SCAN_PORT) => {
  if (target && typeof target === 'object') {
    const host = trimString(target.host || target.ip || target.address || target.target, '');
    if (!host) {
      return null;
    }

    return {
      host,
      port: clampUdpPort(target.port || fallbackPort, fallbackPort),
      command: normalizeLanCommand(target.command || target.cmd)
    };
  }

  const raw = trimString(target, '');
  if (!raw) {
    return null;
  }

  const bracketMatch = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
  const hostPort = bracketMatch
    ? { host: bracketMatch[1], port: bracketMatch[2] }
    : (() => {
        const lastColon = raw.lastIndexOf(':');
        if (lastColon > -1 && raw.indexOf(':') === lastColon) {
          const possiblePort = raw.slice(lastColon + 1);
          if (/^\d+$/.test(possiblePort)) {
            return { host: raw.slice(0, lastColon), port: possiblePort };
          }
        }
        return { host: raw, port: null };
      })();

  const host = trimString(hostPort.host, '');
  if (!host) {
    return null;
  }

  return {
    host,
    port: clampUdpPort(hostPort.port || fallbackPort, fallbackPort),
    command: 'scan'
  };
};

const normalizeLanTargetList = (value) => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeLanTargetList(entry));
  }

  if (value && typeof value === 'object') {
    const normalized = normalizeLanTarget(value);
    return normalized ? [normalized] : [];
  }

  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((entry) => normalizeLanTarget(entry))
    .filter(Boolean);
};

const ipv4ToInteger = (address) => {
  const parts = trimString(address, '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((acc, part) => ((acc << 8) | part) >>> 0, 0);
};

const integerToIpv4 = (value) => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255
].join('.');

const getInterfaceBroadcastTargets = () => {
  const interfaces = os.networkInterfaces();
  const targets = [];

  Object.values(interfaces).flat().forEach((entry) => {
    if (!entry || entry.family !== 'IPv4' || entry.internal) {
      return;
    }

    const address = ipv4ToInteger(entry.address);
    const netmask = ipv4ToInteger(entry.netmask);
    if (address === null || netmask === null) {
      return;
    }

    const broadcast = (address | (~netmask >>> 0)) >>> 0;
    const broadcastAddress = integerToIpv4(broadcast);
    if (broadcastAddress && broadcastAddress !== entry.address) {
      targets.push({
        host: broadcastAddress,
        port: GOVEE_LAN_SCAN_PORT,
        command: 'scan'
      });
    }
  });

  return targets;
};

const getInterfaceSubnetSweepTargets = ({ maxHosts = GOVEE_LAN_MAX_SUBNET_SWEEP_HOSTS } = {}) => {
  const interfaces = os.networkInterfaces();
  const targets = [];
  const hostLimit = Math.max(0, Math.trunc(Number(maxHosts)) || GOVEE_LAN_MAX_SUBNET_SWEEP_HOSTS);

  Object.values(interfaces).flat().forEach((entry) => {
    if (!entry || entry.family !== 'IPv4' || entry.internal) {
      return;
    }

    const address = ipv4ToInteger(entry.address);
    const netmask = ipv4ToInteger(entry.netmask);
    if (address === null || netmask === null) {
      return;
    }

    const network = (address & netmask) >>> 0;
    const broadcast = (address | (~netmask >>> 0)) >>> 0;
    const hostCount = Math.max(0, broadcast - network - 1);
    if (hostCount <= 0 || hostCount > hostLimit) {
      return;
    }

    for (let cursor = network + 1; cursor < broadcast; cursor += 1) {
      if (cursor === address) {
        continue;
      }
      targets.push({
        host: integerToIpv4(cursor),
        port: GOVEE_LAN_CONTROL_PORT,
        command: 'devStatus'
      });
    }
  });

  return targets;
};

const buildLanDiscoveryTargets = ({ targets, localDeviceIp, includeSubnetSweep = true } = {}) => {
  const byKey = new Map();
  const add = (target, commandOverride = null) => {
    const normalized = typeof target === 'string' ? normalizeLanTarget(target) : target;
    if (!normalized?.host) {
      return;
    }
    const command = normalizeLanCommand(commandOverride || normalized.command);
    const key = `${normalized.host}:${normalized.port || GOVEE_LAN_SCAN_PORT}:${command}`;
    byKey.set(key, {
      host: normalized.host,
      port: clampUdpPort(normalized.port || GOVEE_LAN_SCAN_PORT, GOVEE_LAN_SCAN_PORT),
      command
    });
  };

  add(GOVEE_LAN_MULTICAST_TARGET, 'scan');
  add({ host: '255.255.255.255', port: GOVEE_LAN_SCAN_PORT, command: 'scan' });
  getInterfaceBroadcastTargets().forEach(add);
  normalizeLanTargetList(process.env.GOVEE_LAN_SCAN_TARGETS).forEach(add);
  normalizeLanTargetList(targets).forEach(add);

  const configuredIp = trimString(localDeviceIp, '');
  if (configuredIp) {
    add({ host: configuredIp, port: GOVEE_LAN_SCAN_PORT, command: 'scan' });
    add({ host: configuredIp, port: GOVEE_LAN_CONTROL_PORT, command: 'devStatus' });
  }

  if (includeSubnetSweep && process.env.GOVEE_LAN_DISABLE_SUBNET_SWEEP !== 'true') {
    getInterfaceSubnetSweepTargets().forEach(add);
  }

  return Array.from(byKey.values());
};

const normalizeInstanceName = (value) => trimString(value, '')
  .replace(/[^a-z0-9]/gi, '')
  .toLowerCase();

const getCapabilityValue = (capability) => {
  if (!capability || typeof capability !== 'object') {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(capability, 'state')) {
    const state = capability.state;
    if (state && typeof state === 'object' && Object.prototype.hasOwnProperty.call(state, 'value')) {
      return state.value;
    }
    return state;
  }

  if (Object.prototype.hasOwnProperty.call(capability, 'value')) {
    return capability.value;
  }

  return null;
};

const getCapabilityUnit = (capability) => {
  const candidates = [
    capability?.unit,
    capability?.state?.unit,
    capability?.state?.value?.unit,
    capability?.value?.unit,
    capability?.parameters?.unit,
    capability?.parameters?.units,
    capability?.parameters?.dataType?.unit
  ];

  return candidates
    .map((candidate) => trimString(candidate, '').toLowerCase())
    .find(Boolean) || '';
};

const cToF = (value) => Number(((value * 9) / 5 + 32).toFixed(1));
const fToC = (value) => Number(((value - 32) * 5 / 9).toFixed(1));

function normalizeTemperature(rawValue, capability, integration = {}) {
  const numeric = toNumber(rawValue);
  if (numeric === null) {
    return { temperatureF: null, temperatureC: null };
  }

  const unit = getCapabilityUnit(capability);
  let temperatureF;
  let temperatureC;

  if (unit.includes('celsius') || unit === 'c' || unit.includes('°c')) {
    temperatureC = roundNumber(numeric, 1);
    temperatureF = cToF(numeric);
  } else if (unit.includes('fahrenheit') || unit === 'f' || unit.includes('°f')) {
    temperatureF = roundNumber(numeric, 1);
    temperatureC = fToC(numeric);
  } else if (numeric <= 45) {
    temperatureC = roundNumber(numeric, 1);
    temperatureF = cToF(numeric);
  } else {
    temperatureF = roundNumber(numeric, 1);
    temperatureC = fToC(numeric);
  }

  const offset = Number(integration?.tempOffsetF || 0);
  if (Number.isFinite(offset) && offset !== 0 && temperatureF !== null) {
    temperatureF = roundNumber(temperatureF + offset, 1);
    temperatureC = fToC(temperatureF);
  }

  return { temperatureF, temperatureC };
}

function deriveUsAqiFromPm25(pm25) {
  const concentration = toNumber(pm25);
  if (concentration === null || concentration < 0) {
    return null;
  }

  const breakpoints = [
    { cLow: 0.0, cHigh: 9.0, iLow: 0, iHigh: 50 },
    { cLow: 9.1, cHigh: 35.4, iLow: 51, iHigh: 100 },
    { cLow: 35.5, cHigh: 55.4, iLow: 101, iHigh: 150 },
    { cLow: 55.5, cHigh: 125.4, iLow: 151, iHigh: 200 },
    { cLow: 125.5, cHigh: 225.4, iLow: 201, iHigh: 300 },
    { cLow: 225.5, cHigh: 500.4, iLow: 301, iHigh: 500 }
  ];

  const bucket = breakpoints.find((entry) => concentration >= entry.cLow && concentration <= entry.cHigh);
  if (!bucket) {
    return 500;
  }

  const aqi = ((bucket.iHigh - bucket.iLow) / (bucket.cHigh - bucket.cLow)) * (concentration - bucket.cLow) + bucket.iLow;
  return Math.round(aqi);
}

function describeAirQuality(aqi, pm25) {
  const value = toNumber(aqi) ?? deriveUsAqiFromPm25(pm25);
  if (value === null) {
    return {
      usAqi: null,
      qualityLabel: 'Unknown',
      qualityCategory: 'unknown',
      qualityAdvice: 'No indoor air quality reading has been received yet.'
    };
  }

  if (value <= 50) {
    return {
      usAqi: Math.round(value),
      qualityLabel: 'Good',
      qualityCategory: 'good',
      qualityAdvice: 'Indoor particulate levels look comfortable.'
    };
  }

  if (value <= 100) {
    return {
      usAqi: Math.round(value),
      qualityLabel: 'Moderate',
      qualityCategory: 'moderate',
      qualityAdvice: 'Indoor air is acceptable, with some sensitivity risk.'
    };
  }

  if (value <= 150) {
    return {
      usAqi: Math.round(value),
      qualityLabel: 'Sensitive',
      qualityCategory: 'sensitive',
      qualityAdvice: 'Sensitive people may notice indoor air quality changes.'
    };
  }

  if (value <= 200) {
    return {
      usAqi: Math.round(value),
      qualityLabel: 'Unhealthy',
      qualityCategory: 'unhealthy',
      qualityAdvice: 'Consider ventilation or filtration checks.'
    };
  }

  return {
    usAqi: Math.round(value),
    qualityLabel: 'Very Unhealthy',
    qualityCategory: 'very_unhealthy',
    qualityAdvice: 'Indoor air needs attention before extended exposure.'
  };
}

function isAirQualityDevice(device) {
  const sku = trimString(device?.sku, '').toUpperCase();
  const type = trimString(device?.type || device?.deviceType, '').toLowerCase();
  const capabilities = Array.isArray(device?.capabilities) ? device.capabilities : [];
  const capabilityText = capabilities
    .map((capability) => [
      capability?.type,
      capability?.instance,
      capability?.eventState?.instance,
      capability?.state?.instance
    ].filter(Boolean).join(' '))
    .join(' ')
    .toLowerCase();

  return sku === 'H5106'
    || type.includes('air_quality')
    || type.includes('air quality')
    || type.includes('sensor')
    || capabilityText.includes('sensortemperature')
    || capabilityText.includes('sensorhumidity')
    || capabilityText.includes('pm25')
    || capabilityText.includes('pm2.5')
    || capabilityText.includes('airquality')
    || capabilityText.includes('carbondioxide');
}

function compactDiscoveredDevice(device = {}) {
  const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];

  return {
    sku: trimString(device.sku, ''),
    device: trimString(device.device, ''),
    deviceName: trimString(device.deviceName || device.name, 'Govee Indoor Air Monitor'),
    type: trimString(device.type || device.deviceType, ''),
    isAirQualityDevice: isAirQualityDevice(device),
    capabilities: capabilities.map((capability = {}) => ({
      type: trimString(capability.type, ''),
      instance: trimString(capability.instance || capability.eventState?.instance || capability.state?.instance, ''),
      parameters: capability.parameters || null
    }))
  };
}

function parseLanMessagePayload(message) {
  const raw = Buffer.isBuffer(message) ? message.toString('utf8') : trimString(message, '');
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function normalizeLocalScanResponse(payload, remote = {}) {
  const data = payload?.msg?.data || payload?.data || payload || {};
  const sku = trimString(data.sku || data.model || data.productName, '').toUpperCase();
  const device = trimString(data.device || data.deviceId || data.mac, '');
  const ip = trimString(data.ip || remote.address, '');

  if (!sku || (!device && !ip)) {
    return null;
  }

  return {
    sku,
    device: device || ip,
    deviceName: trimString(data.deviceName || data.name || data.productName, `${sku} Local Device`),
    type: trimString(data.type || data.deviceType || 'govee_lan', 'govee_lan'),
    isAirQualityDevice: isAirQualityDevice({ sku, device, type: data.type, capabilities: data.capabilities }),
    ip,
    port: clampUdpPort(data.port || GOVEE_LAN_CONTROL_PORT),
    lanApiSupported: true,
    capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
    firmware: {
      bleHardware: trimString(data.bleVersionHard, ''),
      bleSoftware: trimString(data.bleVersionSoft, ''),
      wifiHardware: trimString(data.wifiVersionHard, ''),
      wifiSoftware: trimString(data.wifiVersionSoft, '')
    }
  };
}

function getFirstPresentValue(source, keys) {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null && source[key] !== '') {
      return source[key];
    }
  }

  return undefined;
}

function buildSyntheticCapability(instance, value, unit) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const capability = {
    type: 'govee.lan.property',
    instance,
    state: { value }
  };

  if (unit) {
    capability.parameters = { unit };
  }

  return capability;
}

function normalizeLocalStatusDiscoveryResponse(payload, remote = {}) {
  const command = normalizeLanCommand(payload?.msg?.cmd || payload?.cmd);
  const data = payload?.msg?.data || payload?.data || {};
  const ip = trimString(remote.address || data.ip, '');
  if (command !== 'devStatus' || !ip || !data || typeof data !== 'object') {
    return null;
  }

  const stateKeys = [
    'online',
    'isOnline',
    'onOff',
    'powerState',
    'brightness',
    'colorTemInKelvin',
    'sensorTemperature',
    'temperature',
    'temp',
    'tempF',
    'temperatureF',
    'tempC',
    'temperatureC',
    'sensorHumidity',
    'humidity',
    'humidityPct',
    'pm25',
    'pm2_5',
    'pm2.5',
    'pm25UgM3',
    'particulateMatter25',
    'airQualityIndex',
    'usAqi',
    'aqi'
  ];
  const hasState = stateKeys.some((key) => Object.prototype.hasOwnProperty.call(data, key));
  if (!hasState) {
    return null;
  }

  const temperature = getFirstPresentValue(data, ['sensorTemperature', 'temperature', 'temp', 'tempF', 'temperatureF', 'tempC', 'temperatureC']);
  const humidity = getFirstPresentValue(data, ['sensorHumidity', 'humidity', 'humidityPct']);
  const pm25 = getFirstPresentValue(data, ['pm25', 'pm2_5', 'pm2.5', 'pm25UgM3', 'particulateMatter25']);
  const aqi = getFirstPresentValue(data, ['airQualityIndex', 'usAqi', 'aqi']);
  const capabilities = [
    buildSyntheticCapability('sensorTemperature', temperature),
    buildSyntheticCapability('sensorHumidity', humidity, 'percent'),
    buildSyntheticCapability('pm25', pm25, 'ug/m3'),
    buildSyntheticCapability('airQualityIndex', aqi)
  ].filter(Boolean);
  const sku = trimString(data.sku || data.model || data.productName, 'LAN').toUpperCase();
  const device = trimString(data.device || data.deviceId || data.mac, ip);

  return {
    sku,
    device,
    deviceName: trimString(data.deviceName || data.name || data.productName, `Govee LAN ${ip}`),
    type: trimString(data.type || data.deviceType || 'govee_lan', 'govee_lan'),
    isAirQualityDevice: isAirQualityDevice({ sku, device, type: data.type, capabilities }),
    ip,
    port: GOVEE_LAN_CONTROL_PORT,
    lanApiSupported: true,
    capabilities,
    firmware: {
      bleHardware: trimString(data.bleVersionHard, ''),
      bleSoftware: trimString(data.bleVersionSoft, ''),
      wifiHardware: trimString(data.wifiVersionHard, ''),
      wifiSoftware: trimString(data.wifiVersionSoft, '')
    }
  };
}

function normalizeLocalStateResponse(localResponse = {}, selectedDevice = {}, integration = {}) {
  const data = localResponse?.msg?.data || localResponse?.data || localResponse || {};
  const capabilities = [];
  const online = getFirstPresentValue(data, ['online', 'isOnline']);
  const onOff = getFirstPresentValue(data, ['onOff', 'powerState']);
  const temperature = getFirstPresentValue(data, ['sensorTemperature', 'temperature', 'temp', 'tempF', 'temperatureF', 'tempC', 'temperatureC']);
  const humidity = getFirstPresentValue(data, ['sensorHumidity', 'humidity', 'humidityPct']);
  const pm25 = getFirstPresentValue(data, ['pm25', 'pm2_5', 'pm2.5', 'pm25UgM3', 'particulateMatter25']);
  const aqi = getFirstPresentValue(data, ['airQualityIndex', 'usAqi', 'aqi']);
  const co2 = getFirstPresentValue(data, ['co2', 'co2Ppm', 'carbonDioxide']);
  const tvoc = getFirstPresentValue(data, ['tvoc', 'tvocPpb', 'voc']);
  const timestamp = getFirstPresentValue(data, ['observedAt', 'updatedAt', 'timestamp']);

  capabilities.push(buildSyntheticCapability('online', online ?? (onOff == null ? undefined : true)));

  const tempUnit = Object.prototype.hasOwnProperty.call(data, 'tempF') || Object.prototype.hasOwnProperty.call(data, 'temperatureF')
    ? 'fahrenheit'
    : (Object.prototype.hasOwnProperty.call(data, 'tempC') || Object.prototype.hasOwnProperty.call(data, 'temperatureC') ? 'celsius' : undefined);

  capabilities.push(buildSyntheticCapability('temperature', temperature, tempUnit));
  capabilities.push(buildSyntheticCapability('humidity', humidity, 'percent'));
  capabilities.push(buildSyntheticCapability('pm25', pm25, 'ug/m3'));
  capabilities.push(buildSyntheticCapability('airQualityIndex', aqi));
  capabilities.push(buildSyntheticCapability('co2', co2, 'ppm'));
  capabilities.push(buildSyntheticCapability('tvoc', tvoc, 'ppb'));

  const normalized = normalizeStateResponse({
    data: {
      sku: selectedDevice.sku,
      device: selectedDevice.device,
      capabilities: capabilities.filter(Boolean).map((capability) => timestamp ? { ...capability, updatedAt: timestamp } : capability)
    }
  }, selectedDevice, integration);

  return {
    ...normalized,
    source: 'local_lan',
    localIp: trimString(selectedDevice.ip || integration?.localDeviceIp, ''),
    localPayload: data
  };
}

function sampleHasIndoorMetrics(sample) {
  return sample?.temperatureF != null
    || sample?.humidityPct != null
    || sample?.pm25UgM3 != null
    || sample?.co2Ppm != null
    || sample?.tvocPpb != null
    || sample?.usAqi != null;
}

function normalizeDeviceList(responseData) {
  const data = responseData?.data ?? responseData;
  const devices = Array.isArray(data?.devices)
    ? data.devices
    : Array.isArray(data)
      ? data
      : [];

  return devices.map(compactDiscoveredDevice).filter((device) => device.device && device.sku);
}

function normalizeStateCapabilities(stateResponse) {
  const containers = [
    stateResponse?.payload,
    stateResponse?.data?.payload,
    stateResponse?.body?.payload,
    stateResponse?.data,
    stateResponse
  ].filter(Boolean);

  for (const container of containers) {
    if (Array.isArray(container?.capabilities)) {
      return container.capabilities;
    }
    if (Array.isArray(container?.properties)) {
      return container.properties;
    }
    if (Array.isArray(container)) {
      return container;
    }
  }

  return [];
}

function getStateResponseDeviceIdentity(stateResponse = {}) {
  return [
    stateResponse?.payload,
    stateResponse?.data?.payload,
    stateResponse?.body?.payload,
    stateResponse?.data,
    stateResponse
  ].find((container) => container && typeof container === 'object' && !Array.isArray(container)) || {};
}

function normalizeStateResponse(stateResponse, selectedDevice = {}, integration = {}) {
  const capabilities = normalizeStateCapabilities(stateResponse);
  const responseIdentity = getStateResponseDeviceIdentity(stateResponse);
  const metricBag = {};
  const rawValues = {};
  const stateInstances = [];
  let isOnline = null;
  let observedAt = null;

  capabilities.forEach((capability) => {
    const instance = trimString(capability?.instance || capability?.state?.instance || capability?.eventState?.instance, '');
    const normalized = normalizeInstanceName(instance);
    const rawValue = getCapabilityValue(capability);
    const numeric = toNumber(rawValue);

    if (instance) {
      stateInstances.push(instance);
      rawValues[instance] = rawValue;
    }

    const timestamp = capability?.updatedAt || capability?.updateTime || capability?.timestamp || capability?.state?.updatedAt;
    if (timestamp && !observedAt) {
      observedAt = timestamp;
    }

    if (normalized.includes('online')) {
      const booleanValue = typeof rawValue === 'boolean' ? rawValue : numeric != null ? numeric >= 0.5 : null;
      if (booleanValue !== null) {
        isOnline = booleanValue;
        metricBag.online = booleanValue ? 1 : 0;
      }
      return;
    }

    if (normalized.includes('sensortemperature') || normalized === 'temperature' || normalized.includes('temperature')) {
      const { temperatureF, temperatureC } = normalizeTemperature(rawValue, capability, integration);
      if (temperatureF !== null) {
        metricBag.temperature_f = temperatureF;
        metricBag.temperature_c = temperatureC;
      }
      return;
    }

    if (normalized.includes('sensorhumidity') || normalized === 'humidity' || normalized.includes('humidity')) {
      if (numeric !== null) {
        metricBag.humidity_pct = roundNumber(numeric + Number(integration?.humidityOffsetPct || 0), 1);
      }
      return;
    }

    if (normalized.includes('pm25') || normalized.includes('pm2') || normalized.includes('particulate') || normalized.includes('fineparticle')) {
      if (numeric !== null) {
        metricBag.pm2_5_ugm3 = Math.max(0, roundNumber(numeric + Number(integration?.pm25OffsetUgM3 || 0), 1));
      }
      return;
    }

    if (normalized.includes('airqualityindex') || normalized === 'aqi' || normalized.includes('usaqi')) {
      if (numeric !== null) {
        metricBag.air_quality_index = Math.round(numeric);
      }
      return;
    }

    if (normalized === 'airquality' || normalized.includes('airquality')) {
      if (numeric !== null) {
        const unit = getCapabilityUnit(capability);
        if (unit.includes('aqi') || unit.includes('index')) {
          metricBag.air_quality_index = Math.round(numeric);
        } else {
          metricBag.pm2_5_ugm3 = Math.max(0, roundNumber(numeric + Number(integration?.pm25OffsetUgM3 || 0), 1));
        }
      }
      return;
    }

    if (normalized.includes('carbondioxide') || normalized === 'co2' || normalized.includes('co2')) {
      if (numeric !== null) {
        metricBag.co2_ppm = Math.round(numeric);
      }
      return;
    }

    if (normalized.includes('tvoc') || normalized.includes('voc')) {
      if (numeric !== null) {
        metricBag.tvoc_ppb = roundNumber(numeric, 1);
      }
    }
  });

  const airQuality = describeAirQuality(metricBag.air_quality_index, metricBag.pm2_5_ugm3);
  if (airQuality.usAqi !== null) {
    metricBag.air_quality_index = airQuality.usAqi;
  }

  const recordedAt = observedAt && !Number.isNaN(new Date(observedAt).getTime())
    ? new Date(observedAt)
    : new Date();

  return {
    device: trimString(selectedDevice.device || responseIdentity.device, ''),
    sku: trimString(selectedDevice.sku || responseIdentity.sku, ''),
    deviceName: trimString(selectedDevice.deviceName || selectedDevice.name, 'Govee Indoor Air Monitor'),
    deviceType: trimString(selectedDevice.type || selectedDevice.deviceType, ''),
    room: trimString(integration?.room, 'Inside'),
    isOnline,
    observedAt: recordedAt.toISOString(),
    temperatureF: metricBag.temperature_f ?? null,
    temperatureC: metricBag.temperature_c ?? null,
    humidityPct: metricBag.humidity_pct ?? null,
    pm25UgM3: metricBag.pm2_5_ugm3 ?? null,
    co2Ppm: metricBag.co2_ppm ?? null,
    tvocPpb: metricBag.tvoc_ppb ?? null,
    usAqi: metricBag.air_quality_index ?? null,
    qualityLabel: airQuality.qualityLabel,
    qualityCategory: airQuality.qualityCategory,
    qualityAdvice: airQuality.qualityAdvice,
    metrics: metricBag,
    rawValues,
    stateInstances
  };
}

class GoveeAirQualityService {
  constructor() {
    this.apiBase = trimString(process.env.GOVEE_API_BASE, DEFAULT_API_BASE).replace(/\/+$/, '');
    this.backgroundEnabled = process.env.NODE_ENV !== 'test';
    this.initialized = false;
    this.pollTimer = null;
    this.syncPromise = null;
  }

  async initialize() {
    if (!this.backgroundEnabled || this.initialized) {
      return;
    }

    this.initialized = true;
    await this.syncNow({ reason: 'initialize', allowDisabled: false }).catch((error) => {
      console.warn('GoveeAirQualityService: initial sync skipped:', error.message);
    });
    await this.restartPollTimer();
  }

  async shutdown() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.initialized = false;
  }

  async restartPollTimer() {
    if (!this.backgroundEnabled) {
      return;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    const integration = await GoveeIntegration.getIntegration();
    if (!this.canPoll(integration)) {
      return;
    }

    this.pollTimer = setInterval(() => {
      this.syncNow({ reason: 'scheduled-poll', allowDisabled: false }).catch((error) => {
        console.warn('GoveeAirQualityService: scheduled poll failed:', error.message);
      });
    }, clampPollIntervalMs(integration.pollIntervalMs));

    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  resolveApiKey(integration, overrideApiKey) {
    const candidate = trimString(overrideApiKey, '');
    if (candidate && !isMaskedSecret(candidate)) {
      return candidate;
    }
    return trimString(integration?.apiKey, '') || trimString(process.env.GOVEE_API_KEY, '');
  }

  apiHeaders(apiKey) {
    return {
      'Govee-API-Key': apiKey,
      'Content-Type': 'application/json'
    };
  }

  canPoll(integration) {
    const mode = normalizeConnectionMode(integration?.connectionMode);
    return integration?.enabled === true && (mode !== 'cloud' || Boolean(this.resolveApiKey(integration)));
  }

  async requestDeviceList(apiKey) {
    const response = await axios.get(`${this.apiBase}/router/api/v1/user/devices`, {
      headers: this.apiHeaders(apiKey),
      timeout: DEFAULT_HTTP_TIMEOUT_MS
    });

    return normalizeDeviceList(response.data);
  }

  async requestDeviceState(apiKey, device) {
    const response = await axios.post(`${this.apiBase}/router/api/v1/device/state`, {
      requestId: randomUUID(),
      payload: {
        sku: device.sku,
        device: device.device
      }
    }, {
      headers: this.apiHeaders(apiKey),
      timeout: DEFAULT_HTTP_TIMEOUT_MS
    });

    return response.data;
  }

  discoverLocalDevices({ timeoutMs = DEFAULT_LAN_DISCOVERY_TIMEOUT_MS, targets = [], localDeviceIp = '' } = {}) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const devices = new Map();
      const lanTimeoutMs = normalizeLanTimeoutMs(timeoutMs);
      const scanTargets = buildLanDiscoveryTargets({ targets, localDeviceIp });
      let settled = false;

      const cleanup = () => {
        try {
          socket.close();
        } catch (_error) {
          // Socket may already be closed after an error.
        }
      };

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(Array.from(devices.values()));
      };

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      socket.on('message', (message, remote) => {
        const payload = parseLanMessagePayload(message);
        const device = normalizeLocalScanResponse(payload, remote)
          || normalizeLocalStatusDiscoveryResponse(payload, remote);
        if (!device) {
          return;
        }
        devices.set(`${device.sku}:${device.device}:${device.ip}`, device);
      });

      socket.on('error', fail);

      socket.bind(GOVEE_LAN_LISTEN_PORT, () => {
        try {
          socket.setBroadcast(true);
          socket.setMulticastTTL(2);
        } catch (_error) {
          // Some host network stacks do not allow multicast tuning; discovery can still try.
        }

        const scanPayload = Buffer.from(JSON.stringify({
          msg: {
            cmd: 'scan',
            data: {
              account_topic: 'reserve'
            }
          }
        }));
        const statusPayload = Buffer.from(JSON.stringify({
          msg: {
            cmd: 'devStatus',
            data: {}
          }
        }));

        scanTargets.forEach((target) => {
          const payload = target.command === 'devStatus' ? statusPayload : scanPayload;
          socket.send(payload, target.port, target.host, (error) => {
            if (error && target.host === GOVEE_LAN_MULTICAST_ADDRESS) {
              fail(error);
            }
          });
        });
      });

      setTimeout(finish, lanTimeoutMs);
    });
  }

  requestLocalDeviceState(localDevice, { timeoutMs = DEFAULT_LAN_DISCOVERY_TIMEOUT_MS } = {}) {
    const host = trimString(localDevice?.ip || localDevice?.localDeviceIp, '');
    const port = clampUdpPort(localDevice?.port || localDevice?.localDevicePort, GOVEE_LAN_CONTROL_PORT);
    if (!host) {
      throw new Error('Enter a local IP address or run local Govee discovery before testing LAN mode.');
    }

    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const lanTimeoutMs = normalizeLanTimeoutMs(timeoutMs);
      let settled = false;

      const cleanup = () => {
        try {
          socket.close();
        } catch (_error) {
          // Socket may already be closed after an error.
        }
      };

      const finish = (payload) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(payload);
      };

      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      socket.on('message', (message) => {
        const payload = parseLanMessagePayload(message);
        const command = trimString(payload?.msg?.cmd || payload?.cmd, '');
        if (command && command !== 'devStatus') {
          return;
        }
        finish(payload);
      });

      socket.on('error', fail);

      socket.bind(GOVEE_LAN_LISTEN_PORT, () => {
        const payload = Buffer.from(JSON.stringify({
          msg: {
            cmd: 'devStatus',
            data: {}
          }
        }));

        socket.send(payload, port, host, (error) => {
          if (error) {
            fail(error);
          }
        });
      });

      setTimeout(() => {
        fail(new Error(`No Govee LAN response from ${host}:${port}. Make sure the device supports LAN Control and is on the same network.`));
      }, lanTimeoutMs);
    });
  }

  async getStatus() {
    if (isDatabaseUnavailableForTest()) {
      return {
        integration: {
          apiKey: '',
          apiKeyConfigured: Boolean(process.env.GOVEE_API_KEY),
          apiKeySource: process.env.GOVEE_API_KEY ? 'environment' : 'none',
          connectionMode: normalizeConnectionMode(process.env.GOVEE_CONNECTION_MODE),
          enabled: false,
          room: 'Inside',
          selectedDevice: '',
          selectedSku: '',
          selectedDeviceName: '',
          selectedDeviceType: '',
          pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
          tempOffsetF: 0,
          humidityOffsetPct: 0,
          pm25OffsetUgM3: 0,
          localDeviceIp: trimString(process.env.GOVEE_LOCAL_DEVICE_IP, ''),
          localDevicePort: clampUdpPort(process.env.GOVEE_LOCAL_DEVICE_PORT),
          localDiscoveredDevices: [],
          lastLocalDiscoveryAt: null,
          lastLocalSyncAt: null,
          lastLocalError: '',
          lastSampleSource: '',
          isConnected: false,
          lastDiscoveryAt: null,
          lastSyncAt: null,
          lastSampleAt: null,
          lastError: ''
        },
        health: {
          configured: Boolean(process.env.GOVEE_API_KEY),
          enabled: false,
          isConnected: false,
          lastDiscoveryAt: null,
          lastSyncAt: null,
          lastSampleAt: null,
          lastError: '',
          selectedDeviceOnline: null,
          lastLocalDiscoveryAt: null,
          lastLocalSyncAt: null,
          lastLocalError: '',
          lastSampleSource: ''
        },
        selectedDevice: null,
        devices: [],
        localDevices: [],
        latestSample: null
      };
    }

    const integration = await GoveeIntegration.getIntegration();
    const devices = Array.isArray(integration.discoveredDevices) ? integration.discoveredDevices : [];
    const selectedDevice = this.resolveSelectedDevice(integration, devices);
    const latestSample = await this.getLatestSnapshot().catch(() => null);

    return {
      integration: {
        ...integration.toSanitized(),
        apiKey: integration.apiKey ? maskSecret(integration.apiKey) : ''
      },
      health: {
        configured: Boolean(this.resolveApiKey(integration)),
        enabled: integration.enabled === true,
        isConnected: integration.isConnected === true,
        lastDiscoveryAt: integration.lastDiscoveryAt,
        lastSyncAt: integration.lastSyncAt,
        lastSampleAt: integration.lastSampleAt,
        lastError: integration.lastError || '',
        selectedDeviceOnline: selectedDevice ? latestSample?.isOnline ?? null : null,
        lastLocalDiscoveryAt: integration.lastLocalDiscoveryAt,
        lastLocalSyncAt: integration.lastLocalSyncAt,
        lastLocalError: integration.lastLocalError || '',
        lastSampleSource: integration.lastSampleSource || ''
      },
      selectedDevice,
      localDevices: Array.isArray(integration.localDiscoveredDevices) ? integration.localDiscoveredDevices : [],
      devices,
      latestSample
    };
  }

  resolveSelectedDevice(integration, devices = []) {
    const selectedDevice = trimString(integration?.selectedDevice, '');
    const selectedSku = trimString(integration?.selectedSku, '');

    if (selectedDevice && selectedSku) {
      const match = devices.find((device) => device.device === selectedDevice && device.sku === selectedSku);
      return match || {
        device: selectedDevice,
        sku: selectedSku,
        deviceName: trimString(integration?.selectedDeviceName, 'Govee Indoor Air Monitor'),
        type: trimString(integration?.selectedDeviceType, ''),
        isAirQualityDevice: true,
        capabilities: []
      };
    }

    return devices.find((device) => device.isAirQualityDevice) || devices[0] || null;
  }

  async testConnection({ apiKey } = {}) {
    const integration = await GoveeIntegration.getIntegration();
    const resolvedApiKey = this.resolveApiKey(integration, apiKey);

    if (!resolvedApiKey) {
      throw new Error('Enter a Govee API key before testing the indoor air integration.');
    }

    const devices = await this.requestDeviceList(resolvedApiKey);
    const airQualityDevices = devices.filter((device) => device.isAirQualityDevice);

    return {
      success: true,
      devices,
      airQualityDevices,
      message: airQualityDevices.length > 0
        ? `Found ${airQualityDevices.length} Govee sensor${airQualityDevices.length === 1 ? '' : 's'} with air quality or climate capabilities.`
        : 'The Govee API key works, but no exposed indoor air monitor was discovered for this account.'
    };
  }

  resolveSelectedLocalDevice(integration, localDevices = []) {
    const selectedDevice = trimString(integration?.selectedDevice, '');
    const selectedSku = trimString(integration?.selectedSku, '');
    const localIp = trimString(integration?.localDeviceIp, '');

    if (selectedDevice && selectedSku) {
      const match = localDevices.find((device) => device.device === selectedDevice && device.sku === selectedSku);
      if (match) {
        return match;
      }
    }

    if (localIp) {
      const match = localDevices.find((device) => device.ip === localIp);
      return match || {
        sku: selectedSku || 'LAN',
        device: selectedDevice || localIp,
        deviceName: trimString(integration?.selectedDeviceName, 'Govee Local Device'),
        type: trimString(integration?.selectedDeviceType, 'govee_lan'),
        isAirQualityDevice: selectedSku === 'H5106',
        ip: localIp,
        port: clampUdpPort(integration?.localDevicePort),
        lanApiSupported: true,
        capabilities: []
      };
    }

    return localDevices.find((device) => device.isAirQualityDevice) || localDevices[0] || null;
  }

  async testLocalConnection(payload = {}) {
    const integration = await GoveeIntegration.getIntegration();
    const localIp = trimString(payload.localDeviceIp, integration.localDeviceIp || '');
    const localPort = clampUdpPort(payload.localDevicePort || integration.localDevicePort);
    const shouldDiscover = payload.discover !== false && !localIp;
    const devices = shouldDiscover ? await this.discoverLocalDevices({ timeoutMs: payload.timeoutMs }) : [];
    const integrationObject = typeof integration.toObject === 'function' ? integration.toObject() : integration;
    const selectedDevice = this.resolveSelectedLocalDevice({
      ...integrationObject,
      localDeviceIp: localIp,
      localDevicePort: localPort
    }, devices);

    if (!selectedDevice) {
      return {
        success: false,
        devices,
        selectedDevice: null,
        sample: null,
        message: 'No Govee LAN devices responded. The H5106 may not expose Govee LAN Control; use Auto mode with a cloud API key if local testing keeps returning no devices.'
      };
    }

    try {
      const stateResponse = await this.requestLocalDeviceState(selectedDevice, { timeoutMs: payload.timeoutMs });
      const sample = normalizeLocalStateResponse(stateResponse, selectedDevice, integration);
      if (!sampleHasIndoorMetrics(sample)) {
        return {
          success: false,
          devices,
          selectedDevice,
          sample,
          message: 'The local Govee LAN API responded, but it did not expose temperature, humidity, PM2.5, or AQI metrics for this device.'
        };
      }

      return {
        success: true,
        devices,
        selectedDevice,
        sample,
        message: `Local Govee LAN readings are available from ${selectedDevice.deviceName || selectedDevice.sku}.`
      };
    } catch (error) {
      return {
        success: false,
        devices,
        selectedDevice,
        sample: null,
        message: error.message || 'Local Govee LAN test failed.'
      };
    }
  }

  async configureIntegration(payload = {}) {
    const integration = await GoveeIntegration.getIntegration();
    const nextApiKey = trimString(payload.apiKey, '');

    if (nextApiKey && !isMaskedSecret(nextApiKey)) {
      integration.apiKey = nextApiKey;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'enabled')) {
      integration.enabled = payload.enabled === true;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'connectionMode')) {
      integration.connectionMode = normalizeConnectionMode(payload.connectionMode);
    }

    integration.room = trimString(payload.room, integration.room || 'Inside');
    integration.pollIntervalMs = clampPollIntervalMs(payload.pollIntervalMs ?? integration.pollIntervalMs);
    integration.tempOffsetF = Number(payload.tempOffsetF || 0);
    integration.humidityOffsetPct = Number(payload.humidityOffsetPct || 0);
    integration.pm25OffsetUgM3 = Number(payload.pm25OffsetUgM3 || 0);
    integration.localDeviceIp = trimString(payload.localDeviceIp, integration.localDeviceIp || '');
    integration.localDevicePort = clampUdpPort(payload.localDevicePort || integration.localDevicePort);

    const selectedDevice = trimString(payload.selectedDevice, '');
    const selectedSku = trimString(payload.selectedSku, '');
    if (selectedDevice && selectedSku) {
      integration.selectedDevice = selectedDevice;
      integration.selectedSku = selectedSku;
      integration.selectedDeviceName = trimString(payload.selectedDeviceName, integration.selectedDeviceName || 'Govee Indoor Air Monitor');
      integration.selectedDeviceType = trimString(payload.selectedDeviceType, integration.selectedDeviceType || '');
    } else if (payload.autoSelect === true) {
      integration.selectedDevice = '';
      integration.selectedSku = '';
      integration.selectedDeviceName = '';
      integration.selectedDeviceType = '';
    }

    await integration.save();

    let syncResult = { skipped: true, reason: 'disabled' };
    if (integration.enabled) {
      syncResult = await this.syncNow({ reason: 'configure', allowDisabled: false }).catch(async (error) => {
        integration.lastError = error.message;
        integration.isConnected = false;
        await integration.save();
        throw error;
      });
    }

    await this.restartPollTimer();
    const status = await this.getStatus();
    return {
      ...status,
      sync: syncResult
    };
  }

  async syncNow({ reason = 'manual-sync', allowDisabled = true } = {}) {
    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = this.performSync({ reason, allowDisabled })
      .finally(() => {
        this.syncPromise = null;
      });

    return this.syncPromise;
  }

  async performSync({ reason, allowDisabled }) {
    const integration = await GoveeIntegration.getIntegration();
    const apiKey = this.resolveApiKey(integration);
    const connectionMode = normalizeConnectionMode(integration.connectionMode);

    if (!integration.enabled && !allowDisabled) {
      return { success: true, skipped: true, reason: 'disabled' };
    }

    let localError = null;
    if (connectionMode !== 'cloud') {
      try {
        const localResult = await this.syncFromLocal(integration);
        const persisted = await this.persistSyncSample(integration, {
          ...localResult,
          sampleSource: 'local_lan'
        });
        return {
          success: true,
          skipped: false,
          reason,
          connectionMode,
          sampleSource: 'local_lan',
          ...persisted
        };
      } catch (error) {
        localError = error;
        integration.lastLocalError = error.message || 'Local Govee LAN sync failed.';
        integration.lastLocalSyncAt = new Date();
        if (connectionMode === 'local') {
          integration.isConnected = false;
          integration.lastError = integration.lastLocalError;
          await integration.save();
          return {
            success: false,
            skipped: true,
            reason: 'local-sync-failed',
            connectionMode,
            message: integration.lastLocalError
          };
        }
      }
    }

    if (!apiKey) {
      integration.isConnected = false;
      integration.lastError = localError
        ? `${integration.lastLocalError} No Govee API key is configured for cloud fallback.`
        : 'No Govee API key is configured.';
      await integration.save();
      return { success: false, skipped: true, reason: 'missing-api-key', connectionMode };
    }

    const cloudResult = await this.syncFromCloud(integration, apiKey);
    const persisted = await this.persistSyncSample(integration, {
      ...cloudResult,
      sampleSource: 'cloud_api',
      preserveLocalError: Boolean(localError)
    });

    return {
      success: true,
      skipped: false,
      reason,
      connectionMode,
      sampleSource: 'cloud_api',
      localFallbackReason: localError?.message || '',
      ...persisted
    };
  }

  async syncFromCloud(integration, apiKey) {
    const devices = await this.requestDeviceList(apiKey);
    integration.discoveredDevices = devices;
    integration.lastDiscoveryAt = new Date();

    const selectedDevice = this.resolveSelectedDevice(integration, devices);
    if (!selectedDevice) {
      integration.isConnected = false;
      integration.lastError = 'The Govee API did not return any devices for this account.';
      await integration.save();
      throw new Error(integration.lastError);
    }

    const stateResponse = await this.requestDeviceState(apiKey, selectedDevice);
    const sample = {
      ...normalizeStateResponse(stateResponse, selectedDevice, integration),
      source: 'cloud_api'
    };

    return {
      selectedDevice,
      sample
    };
  }

  async syncFromLocal(integration) {
    let localDevices = Array.isArray(integration.localDiscoveredDevices) ? integration.localDiscoveredDevices : [];
    if (!trimString(integration.localDeviceIp, '')) {
      localDevices = await this.discoverLocalDevices();
      integration.localDiscoveredDevices = localDevices;
      integration.lastLocalDiscoveryAt = new Date();
    }

    const selectedDevice = this.resolveSelectedLocalDevice(integration, localDevices);
    if (!selectedDevice) {
      throw new Error('No local Govee LAN device is configured or discoverable.');
    }

    const stateResponse = await this.requestLocalDeviceState(selectedDevice);
    const sample = normalizeLocalStateResponse(stateResponse, selectedDevice, integration);
    if (!sampleHasIndoorMetrics(sample)) {
      throw new Error('The local Govee LAN API responded but did not expose indoor air metrics for this device.');
    }

    if (!integration.localDeviceIp && selectedDevice.ip) {
      integration.localDeviceIp = selectedDevice.ip;
      integration.localDevicePort = clampUdpPort(selectedDevice.port);
    }

    return {
      selectedDevice,
      sample,
      localDevices
    };
  }

  async persistSyncSample(integration, { selectedDevice, sample, sampleSource, localDevices = null, preserveLocalError = false }) {
    if (!integration.selectedDevice || !integration.selectedSku) {
      integration.selectedDevice = selectedDevice.device;
      integration.selectedSku = selectedDevice.sku;
      integration.selectedDeviceName = selectedDevice.deviceName;
      integration.selectedDeviceType = selectedDevice.type;
    }

    if (Array.isArray(localDevices)) {
      integration.localDiscoveredDevices = localDevices;
      integration.lastLocalDiscoveryAt = new Date();
    }

    const sampleWithMode = {
      ...sample,
      source: sampleSource
    };
    const device = await this.upsertHomeBrainDevice(integration, selectedDevice, sampleWithMode);
    const telemetryPayload = await this.recordTelemetrySample(device, integration, selectedDevice, sampleWithMode);

    const sampleWithSource = {
      ...sampleWithMode,
      id: telemetryPayload.sample?._id?.toString?.() || `${sample.device}:${sample.observedAt}`,
      sourceId: telemetryPayload.sourceId,
      sourceKey: telemetryPayload.sourceKey
    };

    integration.lastSample = sampleWithSource;
    integration.lastSampleSource = sampleSource;
    integration.lastSampleAt = new Date(sample.observedAt);
    integration.lastSyncAt = new Date();
    if (sampleSource === 'local_lan') {
      integration.lastLocalSyncAt = new Date();
      integration.lastLocalError = '';
    }
    integration.isConnected = true;
    integration.lastError = '';
    if (!preserveLocalError && sampleSource === 'cloud_api') {
      integration.lastLocalError = '';
    }
    await integration.save();

    return {
      selectedDevice,
      sample: sampleWithSource
    };
  }

  async upsertHomeBrainDevice(integration, selectedDevice, sample) {
    const query = {
      'properties.source': 'govee',
      'properties.govee.deviceId': selectedDevice.device
    };
    let device = await Device.findOne(query);

    const name = sample.deviceName || selectedDevice.deviceName || 'Govee Indoor Air Monitor';
    const room = trimString(integration.room, 'Inside');
    const properties = {
      ...(device?.properties && typeof device.properties === 'object' ? device.properties : {}),
      source: 'govee',
      govee: {
        deviceId: selectedDevice.device,
        sku: selectedDevice.sku,
        deviceName: name,
        deviceType: selectedDevice.type || '',
        connectionMode: normalizeConnectionMode(integration.connectionMode),
        sampleSource: sample.source || integration.lastSampleSource || '',
        localIp: selectedDevice.ip || sample.localIp || integration.localDeviceIp || '',
        lastSample: sample,
        capabilities: Array.isArray(selectedDevice.capabilities) ? selectedDevice.capabilities : []
      }
    };

    if (!device) {
      device = await Device.create({
        name,
        type: 'sensor',
        room,
        groups: ['Weather', 'Indoor Air'],
        status: sample.isOnline !== false,
        brand: 'Govee',
        model: selectedDevice.sku || 'Govee',
        isOnline: sample.isOnline !== false,
        lastSeen: new Date(sample.observedAt),
        properties
      });
      deviceUpdateEmitter.emit('devices:update', deviceUpdateEmitter.normalizeDevice(device));
      return device;
    }

    device.name = name;
    device.room = room;
    device.groups = Array.from(new Set([...(Array.isArray(device.groups) ? device.groups : []), 'Weather', 'Indoor Air']));
    device.status = sample.isOnline !== false;
    device.brand = device.brand || 'Govee';
    device.model = selectedDevice.sku || device.model || 'Govee';
    device.isOnline = sample.isOnline !== false;
    device.lastSeen = new Date(sample.observedAt);
    device.properties = properties;
    await device.save();
    deviceUpdateEmitter.emit('devices:update', deviceUpdateEmitter.normalizeDevice(device));
    return device;
  }

  async recordTelemetrySample(device, integration, selectedDevice, sample) {
    const sourceId = String(device?._id || selectedDevice.device);
    const sourceKey = `${GOVEE_SOURCE_TYPE}:${sourceId}`;
    const metricKeys = Object.keys(sample.metrics || {}).sort();
    const payload = {
      sourceType: GOVEE_SOURCE_TYPE,
      sourceId,
      sourceKey,
      sourceName: sample.deviceName || selectedDevice.deviceName || 'Govee Indoor Air Monitor',
      sourceCategory: 'Indoor Air',
      sourceRoom: trimString(integration.room, 'Inside'),
      sourceOrigin: sample.source === 'local_lan' ? 'govee_lan' : 'govee',
      streamType: GOVEE_STREAM_TYPE,
      metricKeys,
      metrics: sample.metrics,
      metadata: {
        sku: selectedDevice.sku,
        device: selectedDevice.device,
        deviceType: selectedDevice.type || '',
        sampleSource: sample.source || '',
        localIp: selectedDevice.ip || sample.localIp || '',
        qualityLabel: sample.qualityLabel,
        qualityCategory: sample.qualityCategory,
        stateInstances: sample.stateInstances,
        rawValues: sample.rawValues
      },
      recordedAt: new Date(sample.observedAt)
    };

    const telemetrySample = await TelemetrySample.create(payload);
    await telemetryService.updateSourceSummaryForSample({ ...payload, _id: telemetrySample._id }, { sampleInserted: true });

    return {
      sourceId,
      sourceKey,
      sample: telemetrySample
    };
  }

  async getLatestSnapshot() {
    if (isDatabaseUnavailableForTest()) {
      return null;
    }

    const integration = await GoveeIntegration.getIntegration();
    if (integration.lastSample) {
      return integration.lastSample;
    }

    const selectedDevice = trimString(integration.selectedDevice, '');
    const query = selectedDevice
      ? { sourceType: GOVEE_SOURCE_TYPE, 'metadata.device': selectedDevice }
      : { sourceType: GOVEE_SOURCE_TYPE };
    const latest = await TelemetrySample.findOne(query).sort({ recordedAt: -1 }).lean();
    if (!latest) {
      return null;
    }

    return this.sampleFromTelemetry(latest);
  }

  sampleFromTelemetry(sample) {
    const metrics = sample?.metrics instanceof Map
      ? Object.fromEntries(sample.metrics)
      : (sample?.metrics || {});
    const metadata = sample?.metadata || {};

    return {
      id: sample?._id?.toString?.() || `${sample?.sourceKey || 'govee'}:${sample?.recordedAt}`,
      sourceId: sample?.sourceId || '',
      sourceKey: sample?.sourceKey || '',
      device: metadata.device || '',
      sku: metadata.sku || '',
      deviceName: sample?.sourceName || 'Govee Indoor Air Monitor',
      deviceType: metadata.deviceType || '',
      source: metadata.sampleSource || (sample?.sourceOrigin === 'govee_lan' ? 'local_lan' : 'cloud_api'),
      localIp: metadata.localIp || '',
      room: sample?.sourceRoom || 'Inside',
      isOnline: metrics.online == null ? null : Number(metrics.online) >= 0.5,
      observedAt: sample?.recordedAt instanceof Date ? sample.recordedAt.toISOString() : sample?.recordedAt || null,
      temperatureF: metrics.temperature_f ?? null,
      temperatureC: metrics.temperature_c ?? null,
      humidityPct: metrics.humidity_pct ?? null,
      pm25UgM3: metrics.pm2_5_ugm3 ?? null,
      co2Ppm: metrics.co2_ppm ?? null,
      tvocPpb: metrics.tvoc_ppb ?? null,
      usAqi: metrics.air_quality_index ?? null,
      qualityLabel: metadata.qualityLabel || describeAirQuality(metrics.air_quality_index, metrics.pm2_5_ugm3).qualityLabel,
      qualityCategory: metadata.qualityCategory || describeAirQuality(metrics.air_quality_index, metrics.pm2_5_ugm3).qualityCategory,
      qualityAdvice: describeAirQuality(metrics.air_quality_index, metrics.pm2_5_ugm3).qualityAdvice,
      metrics
    };
  }

  async getSamples({ hours = DEFAULT_HISTORY_HOURS, limit = DEFAULT_HISTORY_LIMIT } = {}) {
    if (isDatabaseUnavailableForTest()) {
      return [];
    }

    const normalizedHours = Math.max(1, Math.min(24 * 365, Number(hours) || DEFAULT_HISTORY_HOURS));
    const normalizedLimit = Math.max(1, Math.min(720, Number(limit) || DEFAULT_HISTORY_LIMIT));
    const since = new Date(Date.now() - normalizedHours * 60 * 60 * 1000);
    const latest = await this.getLatestSnapshot().catch(() => null);
    const query = {
      sourceType: GOVEE_SOURCE_TYPE,
      recordedAt: { $gte: since }
    };

    if (latest?.sourceKey) {
      query.sourceKey = latest.sourceKey;
    }

    const samples = await TelemetrySample.find(query)
      .sort({ recordedAt: -1 })
      .limit(normalizedLimit)
      .lean();

    return samples.reverse().map((sample) => this.sampleFromTelemetry(sample));
  }

  async getDashboardData({ hours = DEFAULT_HISTORY_HOURS, limit = DEFAULT_HISTORY_LIMIT } = {}) {
    const [status, samples] = await Promise.all([
      this.getStatus(),
      this.getSamples({ hours, limit }).catch(() => [])
    ]);

    return {
      available: Boolean(status.latestSample),
      monitor: status.latestSample,
      samples,
      health: status.health
    };
  }
}

const service = new GoveeAirQualityService();

service.__testHooks = {
  compactDiscoveredDevice,
  deriveUsAqiFromPm25,
  describeAirQuality,
  isAirQualityDevice,
  normalizeConnectionMode,
  normalizeLanTarget,
  buildLanDiscoveryTargets,
  normalizeLanTimeoutMs,
  normalizeDeviceList,
  normalizeLocalScanResponse,
  normalizeLocalStatusDiscoveryResponse,
  normalizeLocalStateResponse,
  normalizeStateResponse
};

module.exports = service;

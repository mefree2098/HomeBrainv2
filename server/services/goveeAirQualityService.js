const axios = require('axios');
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
const GOVEE_SOURCE_TYPE = 'govee_air_quality';
const GOVEE_STREAM_TYPE = 'govee_air_quality_sample';

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
  const data = stateResponse?.data ?? stateResponse ?? {};
  if (Array.isArray(data?.capabilities)) {
    return data.capabilities;
  }
  if (Array.isArray(data?.properties)) {
    return data.properties;
  }
  if (Array.isArray(stateResponse?.capabilities)) {
    return stateResponse.capabilities;
  }
  return [];
}

function normalizeStateResponse(stateResponse, selectedDevice = {}, integration = {}) {
  const capabilities = normalizeStateCapabilities(stateResponse);
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
    device: trimString(selectedDevice.device || stateResponse?.data?.device, ''),
    sku: trimString(selectedDevice.sku || stateResponse?.data?.sku, ''),
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
    if (!integration.enabled || !this.resolveApiKey(integration)) {
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

  async getStatus() {
    if (isDatabaseUnavailableForTest()) {
      return {
        integration: {
          apiKey: '',
          apiKeyConfigured: Boolean(process.env.GOVEE_API_KEY),
          apiKeySource: process.env.GOVEE_API_KEY ? 'environment' : 'none',
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
          selectedDeviceOnline: null
        },
        selectedDevice: null,
        devices: [],
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
        selectedDeviceOnline: selectedDevice ? latestSample?.isOnline ?? null : null
      },
      selectedDevice,
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

  async configureIntegration(payload = {}) {
    const integration = await GoveeIntegration.getIntegration();
    const nextApiKey = trimString(payload.apiKey, '');

    if (nextApiKey && !isMaskedSecret(nextApiKey)) {
      integration.apiKey = nextApiKey;
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'enabled')) {
      integration.enabled = payload.enabled === true;
    }

    integration.room = trimString(payload.room, integration.room || 'Inside');
    integration.pollIntervalMs = clampPollIntervalMs(payload.pollIntervalMs ?? integration.pollIntervalMs);
    integration.tempOffsetF = Number(payload.tempOffsetF || 0);
    integration.humidityOffsetPct = Number(payload.humidityOffsetPct || 0);
    integration.pm25OffsetUgM3 = Number(payload.pm25OffsetUgM3 || 0);

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

    if (!integration.enabled && !allowDisabled) {
      return { success: true, skipped: true, reason: 'disabled' };
    }

    if (!apiKey) {
      integration.isConnected = false;
      integration.lastError = 'No Govee API key is configured.';
      await integration.save();
      return { success: false, skipped: true, reason: 'missing-api-key' };
    }

    const devices = await this.requestDeviceList(apiKey);
    integration.discoveredDevices = devices;
    integration.lastDiscoveryAt = new Date();

    const selectedDevice = this.resolveSelectedDevice(integration, devices);
    if (!selectedDevice) {
      integration.isConnected = false;
      integration.lastError = 'The Govee API did not return any devices for this account.';
      await integration.save();
      return { success: false, skipped: true, reason: 'no-devices' };
    }

    if (!integration.selectedDevice || !integration.selectedSku) {
      integration.selectedDevice = selectedDevice.device;
      integration.selectedSku = selectedDevice.sku;
      integration.selectedDeviceName = selectedDevice.deviceName;
      integration.selectedDeviceType = selectedDevice.type;
    }

    const stateResponse = await this.requestDeviceState(apiKey, selectedDevice);
    const sample = normalizeStateResponse(stateResponse, selectedDevice, integration);
    const device = await this.upsertHomeBrainDevice(integration, selectedDevice, sample);
    const telemetryPayload = await this.recordTelemetrySample(device, integration, selectedDevice, sample);

    const sampleWithSource = {
      ...sample,
      id: telemetryPayload.sample?._id?.toString?.() || `${sample.device}:${sample.observedAt}`,
      sourceId: telemetryPayload.sourceId,
      sourceKey: telemetryPayload.sourceKey
    };

    integration.lastSample = sampleWithSource;
    integration.lastSampleAt = new Date(sample.observedAt);
    integration.lastSyncAt = new Date();
    integration.isConnected = true;
    integration.lastError = '';
    await integration.save();

    return {
      success: true,
      skipped: false,
      reason,
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
      sourceOrigin: 'govee',
      streamType: GOVEE_STREAM_TYPE,
      metricKeys,
      metrics: sample.metrics,
      metadata: {
        sku: selectedDevice.sku,
        device: selectedDevice.device,
        deviceType: selectedDevice.type || '',
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
  normalizeDeviceList,
  normalizeStateResponse
};

module.exports = service;

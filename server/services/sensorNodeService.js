const crypto = require('crypto');

const Device = require('../models/Device');
const SensorNode = require('../models/SensorNode');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');

const SENSOR_SCHEMA = 'homebrain.sensor.reading.v1';
const CONFIG_SCHEMA = 'homebrain.sensor.config.v1';
const DEFAULT_HUB_URL = 'http://homebrain.local:3000';
const SETUP_CODE_TTL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.HOMEBRAIN_SENSOR_SETUP_CODE_TTL_MS || 7 * 24 * 60 * 60 * 1000)
);
const OFFLINE_SCAN_INTERVAL_MS = Math.max(
  15_000,
  Number(process.env.HOMEBRAIN_SENSOR_OFFLINE_SCAN_INTERVAL_MS || 60_000)
);

const PROFILE_DEFINITIONS = Object.freeze({
  auto: Object.freeze({
    label: 'Auto Detect',
    deviceType: 'indoor_climate_sensor',
    defaultPowerSource: 'battery',
    defaultReportingIntervalSeconds: 300,
    defaultDeepSleepEnabled: true
  }),
  'air-station': Object.freeze({
    label: 'Atmosphere Air Station',
    deviceType: 'air_quality_monitor',
    defaultPowerSource: 'wired',
    defaultReportingIntervalSeconds: 30,
    defaultDeepSleepEnabled: false
  }),
  climate: Object.freeze({
    label: 'Climate Pod',
    deviceType: 'indoor_climate_sensor',
    defaultPowerSource: 'battery',
    defaultReportingIntervalSeconds: 300,
    defaultDeepSleepEnabled: true
  }),
  presence: Object.freeze({
    label: 'Presence + Climate Pod',
    deviceType: 'indoor_climate_sensor',
    defaultPowerSource: 'wired',
    defaultReportingIntervalSeconds: 15,
    defaultDeepSleepEnabled: false
  })
});

function serviceError(message, status = 400, details = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, details);
  return error;
}

function trimString(value, maximum = 512) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function normalizeProfile(value) {
  const profile = trimString(value, 32).toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROFILE_DEFINITIONS, profile) ? profile : 'auto';
}

function normalizePowerSource(value, profile) {
  const powerSource = trimString(value, 16).toLowerCase();
  if (powerSource === 'wired' || powerSource === 'battery') {
    return powerSource;
  }
  return PROFILE_DEFINITIONS[profile].defaultPowerSource;
}

function clampNumber(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, numeric));
}

function normalizeSettings(input = {}, profile = 'auto', powerSource = 'battery') {
  const definition = PROFILE_DEFINITIONS[profile] || PROFILE_DEFINITIONS.auto;
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const defaultDeepSleep = powerSource === 'battery' && definition.defaultDeepSleepEnabled;

  return {
    reportingIntervalSeconds: Math.round(clampNumber(
      source.reportingIntervalSeconds ?? source.reporting_interval_seconds,
      definition.defaultReportingIntervalSeconds,
      10,
      86400
    )),
    deepSleepEnabled: typeof (source.deepSleepEnabled ?? source.deep_sleep_enabled) === 'boolean'
      ? Boolean(source.deepSleepEnabled ?? source.deep_sleep_enabled)
      : defaultDeepSleep,
    temperatureOffsetC: clampNumber(
      source.temperatureOffsetC ?? source.temperature_offset_c,
      0,
      -20,
      20
    ),
    humidityOffsetPct: clampNumber(
      source.humidityOffsetPct ?? source.humidity_offset_pct,
      0,
      -50,
      50
    ),
    altitudeMeters: clampNumber(
      source.altitudeMeters ?? source.altitude_meters,
      0,
      -500,
      9000
    ),
    presenceHoldSeconds: Math.round(clampNumber(
      source.presenceHoldSeconds ?? source.presence_hold_seconds,
      30,
      0,
      3600
    ))
  };
}

function normalizeHubUrl(value) {
  const candidate = trimString(value, 1024) || DEFAULT_HUB_URL;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return DEFAULT_HUB_URL;
    }
    return parsed.origin;
  } catch (_error) {
    return DEFAULT_HUB_URL;
  }
}

function toPlain(value) {
  if (!value) {
    return value;
  }
  if (typeof value.toObject === 'function') {
    return value.toObject();
  }
  return value;
}

function toId(value) {
  return trimString(value?._id?.toString?.() || value?.id || value, 96);
}

function hashSecret(nodeId, secret) {
  return crypto
    .createHash('sha256')
    .update(`homebrain-sensor:v1:${toId(nodeId)}:${trimString(secret, 512)}`, 'utf8')
    .digest('hex');
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(trimString(left, 256), 'utf8');
  const rightBuffer = Buffer.from(trimString(right, 256), 'utf8');
  return leftBuffer.length > 0
    && leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createSetupCode() {
  const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
  return raw.match(/.{1,4}/g).join('-');
}

function createDeviceToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function normalizeCapabilityList(value) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((entry) => trimString(entry, 48).toLowerCase())
    .filter((entry) => /^[a-z0-9][a-z0-9._-]{0,47}$/.test(entry))))
    .slice(0, 32)
    .sort();
}

function readPath(source, ...keys) {
  for (const key of keys) {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key];
    }
  }
  return undefined;
}

function addBoundedNumber(target, key, value, minimum, maximum, digits = 3) {
  if (value === undefined || value === null || value === '') {
    return;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
    return;
  }
  const multiplier = 10 ** digits;
  target[key] = Math.round(numeric * multiplier) / multiplier;
}

function addBoolean(target, key, value) {
  if (typeof value === 'boolean') {
    target[key] = value;
    return;
  }
  if (value === 0 || value === 1 || value === '0' || value === '1') {
    target[key] = Number(value) === 1;
  }
}

function normalizeReadingPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw serviceError('Sensor reading payload must be a JSON object.');
  }

  const schema = trimString(payload.schema, 96) || SENSOR_SCHEMA;
  if (schema !== SENSOR_SCHEMA) {
    throw serviceError(`Unsupported sensor reading schema: ${schema}`);
  }

  const sourceReadings = payload.readings && typeof payload.readings === 'object' ? payload.readings : {};
  const sourcePower = payload.power && typeof payload.power === 'object' ? payload.power : {};
  const sourceDiagnostics = payload.diagnostics && typeof payload.diagnostics === 'object' ? payload.diagnostics : {};
  const readings = {};
  const power = {};
  const diagnostics = {};

  addBoundedNumber(readings, 'temperature_c', readPath(sourceReadings, 'temperature_c', 'temperatureC'), -60, 100);
  addBoundedNumber(readings, 'temperature_f', readPath(sourceReadings, 'temperature_f', 'temperatureF'), -76, 212);
  if (readings.temperature_c !== undefined && readings.temperature_f === undefined) {
    readings.temperature_f = Math.round(((readings.temperature_c * 9 / 5) + 32) * 1000) / 1000;
  }
  if (readings.temperature_f !== undefined && readings.temperature_c === undefined) {
    readings.temperature_c = Math.round(((readings.temperature_f - 32) * 5 / 9) * 1000) / 1000;
  }

  addBoundedNumber(readings, 'humidity_pct', readPath(sourceReadings, 'humidity_pct', 'humidityPct'), 0, 100);
  addBoundedNumber(readings, 'dew_point_c', readPath(sourceReadings, 'dew_point_c', 'dewPointC'), -80, 80);
  addBoundedNumber(readings, 'dew_point_f', readPath(sourceReadings, 'dew_point_f', 'dewPointF'), -112, 176);
  addBoundedNumber(readings, 'absolute_humidity_gm3', readPath(sourceReadings, 'absolute_humidity_gm3', 'absoluteHumidityGm3'), 0, 100);
  addBoundedNumber(readings, 'pressure_hpa', readPath(sourceReadings, 'pressure_hpa', 'pressureHpa'), 250, 1200);
  addBoundedNumber(readings, 'gas_resistance_ohms', readPath(sourceReadings, 'gas_resistance_ohms', 'gasResistanceOhms'), 0, 100000000, 0);
  addBoundedNumber(readings, 'air_quality_score', readPath(sourceReadings, 'air_quality_score', 'airQualityScore'), 0, 100, 1);
  addBoundedNumber(readings, 'voc_trend_index', readPath(sourceReadings, 'voc_trend_index', 'vocTrendIndex'), 0, 500, 1);
  addBoundedNumber(readings, 'comfort_score', readPath(sourceReadings, 'comfort_score', 'comfortScore'), 0, 100, 1);
  addBoundedNumber(readings, 'mold_risk_score', readPath(sourceReadings, 'mold_risk_score', 'moldRiskScore'), 0, 100, 1);
  addBoundedNumber(readings, 'co2_ppm', readPath(sourceReadings, 'co2_ppm', 'co2Ppm'), 0, 50000, 0);
  addBoundedNumber(readings, 'pm1_0_ugm3', readPath(sourceReadings, 'pm1_0_ugm3', 'pm1Ugm3'), 0, 5000, 1);
  addBoundedNumber(readings, 'pm2_5_ugm3', readPath(sourceReadings, 'pm2_5_ugm3', 'pm25Ugm3'), 0, 5000, 1);
  addBoundedNumber(readings, 'pm10_ugm3', readPath(sourceReadings, 'pm10_ugm3', 'pm10Ugm3'), 0, 5000, 1);
  addBoundedNumber(readings, 'illuminance_lux', readPath(sourceReadings, 'illuminance_lux', 'illuminanceLux'), 0, 200000, 1);
  addBoolean(readings, 'presence_present', readPath(sourceReadings, 'presence_present', 'presencePresent'));
  addBoundedNumber(readings, 'moving_distance_cm', readPath(sourceReadings, 'moving_distance_cm', 'movingDistanceCm'), 0, 1200, 0);
  addBoundedNumber(readings, 'stationary_distance_cm', readPath(sourceReadings, 'stationary_distance_cm', 'stationaryDistanceCm'), 0, 1200, 0);
  addBoundedNumber(readings, 'moving_energy_pct', readPath(sourceReadings, 'moving_energy_pct', 'movingEnergyPct'), 0, 100, 0);
  addBoundedNumber(readings, 'stationary_energy_pct', readPath(sourceReadings, 'stationary_energy_pct', 'stationaryEnergyPct'), 0, 100, 0);

  addBoundedNumber(power, 'battery_volts', readPath(sourcePower, 'battery_volts', 'batteryVolts'), 0, 6);
  addBoundedNumber(power, 'battery_pct', readPath(sourcePower, 'battery_pct', 'batteryPct'), 0, 100, 1);
  addBoolean(power, 'usb_powered', readPath(sourcePower, 'usb_powered', 'usbPowered'));

  addBoundedNumber(diagnostics, 'signal_rssi_dbm', readPath(sourceDiagnostics, 'signal_rssi_dbm', 'rssi_dbm', 'rssiDbm'), -150, 20, 0);
  addBoundedNumber(diagnostics, 'uptime_ms', readPath(sourceDiagnostics, 'uptime_ms', 'uptimeMs'), 0, Number.MAX_SAFE_INTEGER, 0);
  addBoundedNumber(diagnostics, 'wake_count', readPath(sourceDiagnostics, 'wake_count', 'wakeCount'), 0, Number.MAX_SAFE_INTEGER, 0);
  addBoundedNumber(diagnostics, 'free_heap_bytes', readPath(sourceDiagnostics, 'free_heap_bytes', 'freeHeapBytes'), 0, Number.MAX_SAFE_INTEGER, 0);
  for (const module of ['bme680', 'scd41', 'veml7700', 'pms5003', 'ld2410', 'dht11']) {
    addBoolean(diagnostics, `${module}_available`, sourceDiagnostics[`${module}_available`]);
  }
  if (['bme680', 'scd41', 'dht11'].includes(sourceDiagnostics.temperature_source)) {
    diagnostics.temperature_source = sourceDiagnostics.temperature_source;
  }
  const reportedIp = trimString(readPath(sourceDiagnostics, 'ip_address', 'ipAddress'), 64);
  if (reportedIp) {
    diagnostics.ip_address = reportedIp;
  }

  if (Object.keys(readings).length === 0 && Object.keys(power).length === 0) {
    throw serviceError('Sensor reading contained no valid measurements.');
  }

  return {
    schema: SENSOR_SCHEMA,
    profile: normalizeProfile(payload.profile),
    firmwareVersion: trimString(payload.firmware_version || payload.firmwareVersion, 96),
    hardwareId: trimString(payload.hardware_id || payload.hardwareId, 96),
    capabilities: normalizeCapabilityList(payload.capabilities),
    sequence: Math.round(clampNumber(payload.sequence, 0, 0, Number.MAX_SAFE_INTEGER)),
    readings,
    power,
    diagnostics
  };
}

function inferCapabilities(reading) {
  const capabilities = new Set(reading.capabilities || []);
  const values = reading.readings || {};
  if (values.temperature_c !== undefined || values.humidity_pct !== undefined) capabilities.add('climate');
  if (values.pressure_hpa !== undefined) capabilities.add('pressure');
  if (values.gas_resistance_ohms !== undefined) capabilities.add('voc-trend');
  if (values.co2_ppm !== undefined) capabilities.add('co2');
  if (values.pm2_5_ugm3 !== undefined) capabilities.add('particulate');
  if (values.illuminance_lux !== undefined) capabilities.add('illuminance');
  if (values.presence_present !== undefined) capabilities.add('presence');
  if (reading.power?.battery_volts !== undefined) capabilities.add('battery');
  return Array.from(capabilities).sort();
}

function sensorDeviceType(profile) {
  return (PROFILE_DEFINITIONS[profile] || PROFILE_DEFINITIONS.auto).deviceType;
}

function buildDeviceProperties(node, existing = {}, reading = null) {
  const current = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const previousSensor = current.homebrainSensor && typeof current.homebrainSensor === 'object'
    ? current.homebrainSensor
    : {};

  return {
    ...current,
    source: 'homebrain-sensor',
    homebrainSensor: {
      ...previousSensor,
      nodeId: toId(node),
      profile: node.profile,
      hardwareProfile: node.hardwareProfile,
      powerSource: node.powerSource,
      firmwareVersion: node.firmwareVersion || '',
      hardwareId: node.hardwareId || '',
      reportingIntervalSeconds: node.settings?.reportingIntervalSeconds,
      lastReadingAt: node.lastReadingAt || null,
      capabilities: normalizeCapabilityList(node.capabilities),
      readings: reading?.readings || previousSensor.readings || {},
      power: reading?.power || previousSensor.power || {},
      diagnostics: reading?.diagnostics || previousSensor.diagnostics || {},
      schema: reading?.schema || previousSensor.schema || SENSOR_SCHEMA
    }
  };
}

function nodeFreshnessWindowMs(node) {
  const intervalSeconds = clampNumber(
    node?.settings?.reportingIntervalSeconds,
    PROFILE_DEFINITIONS[normalizeProfile(node?.profile)].defaultReportingIntervalSeconds,
    10,
    86400
  );
  return Math.max(90_000, intervalSeconds * 3 * 1000);
}

function nodeIsFresh(node, now = Date.now()) {
  const lastSeen = node?.lastSeen ? new Date(node.lastSeen).getTime() : 0;
  return Number.isFinite(lastSeen) && lastSeen > 0 && now - lastSeen <= nodeFreshnessWindowMs(node);
}

function serializeNode(input, now = Date.now()) {
  const node = toPlain(input) || {};
  const profile = normalizeProfile(node.profile);
  const status = node.status === 'online' && !nodeIsFresh(node, now) ? 'offline' : (node.status || 'offline');

  return {
    id: toId(node),
    name: trimString(node.name, 128),
    room: trimString(node.room, 128),
    profile,
    profileLabel: PROFILE_DEFINITIONS[profile].label,
    hardwareProfile: node.hardwareProfile || 'seeed-xiao-esp32-c6',
    powerSource: node.powerSource || PROFILE_DEFINITIONS[profile].defaultPowerSource,
    status,
    deviceId: toId(node.deviceId) || null,
    hardwareId: trimString(node.hardwareId, 96),
    firmwareVersion: trimString(node.firmwareVersion, 96),
    capabilities: normalizeCapabilityList(node.capabilities),
    ipAddress: trimString(node.ipAddress, 64),
    settings: normalizeSettings(node.settings, profile, node.powerSource),
    latestReading: node.latestReading || null,
    readingSequence: Number(node.readingSequence || 0),
    lastReadingAt: node.lastReadingAt || null,
    lastSeen: node.lastSeen || null,
    lastError: trimString(node.lastError, 512),
    setupCodeExpiresAt: node.setupCodeExpiresAt || null,
    setupCodeUsedAt: node.setupCodeUsedAt || null,
    deviceTokenCreatedAt: node.deviceTokenCreatedAt || null,
    deviceTokenVersion: Number(node.deviceTokenVersion || 0),
    createdAt: node.createdAt || null,
    updatedAt: node.updatedAt || null
  };
}

function buildRuntimeConfig(node) {
  const serialized = serializeNode(node);
  const firmwareUpdate = require('./sensorFirmwareService').firmwareCommand(node);
  return {
    schema: CONFIG_SCHEMA,
    node_id: serialized.id,
    profile: serialized.profile,
    reporting_interval_seconds: serialized.settings.reportingIntervalSeconds,
    deep_sleep_enabled: serialized.settings.deepSleepEnabled,
    calibration: {
      temperature_offset_c: serialized.settings.temperatureOffsetC,
      humidity_offset_pct: serialized.settings.humidityOffsetPct,
      altitude_meters: serialized.settings.altitudeMeters
    },
    presence_hold_seconds: serialized.settings.presenceHoldSeconds,
    token_version: serialized.deviceTokenVersion,
    ...(firmwareUpdate ? { firmware_update: firmwareUpdate } : {})
  };
}

function buildProvisioning(node, setupCode, hubUrl) {
  const serialized = serializeNode(node);
  return {
    hubUrl: normalizeHubUrl(hubUrl),
    nodeId: serialized.id,
    setupCode: setupCode || null,
    profile: serialized.profile,
    portalName: `HomeBrain-Sensor-${serialized.hardwareId ? serialized.hardwareId.slice(-6).toUpperCase() : 'XXXXXX'}`,
    expiresAt: serialized.setupCodeExpiresAt,
    firmwareFields: {
      HOMEBRAIN_HUB_URL: normalizeHubUrl(hubUrl),
      HOMEBRAIN_NODE_ID: serialized.id,
      HOMEBRAIN_SETUP_CODE: setupCode || ''
    }
  };
}

async function resolveQuery(query) {
  if (query && typeof query.lean === 'function') {
    return query.lean();
  }
  return query;
}

class SensorNodeService {
  constructor(options = {}) {
    this.SensorNode = options.SensorNodeModel || SensorNode;
    this.Device = options.DeviceModel || Device;
    this.deviceUpdateEmitter = options.deviceUpdateEmitter || deviceUpdateEmitter;
    this.offlineTimer = null;
  }

  async listNodes() {
    const query = this.SensorNode.find({}).sort({ room: 1, name: 1 });
    const nodes = await resolveQuery(query);
    return (Array.isArray(nodes) ? nodes : []).map((node) => serializeNode(node));
  }

  async getNodeById(nodeId) {
    const node = await this.SensorNode.findById(nodeId);
    if (!node) {
      throw serviceError('Sensor node not found.', 404);
    }
    return node;
  }

  serializeNode(node) {
    return serializeNode(node);
  }

  async getNodeWithSecrets(nodeId) {
    const query = this.SensorNode.findById(nodeId);
    const node = query && typeof query.select === 'function'
      ? await query.select('+setupCodeHash +deviceTokenHash')
      : await query;
    if (!node) {
      throw serviceError('Sensor node not found.', 404);
    }
    return node;
  }

  async registerNode(input = {}, hubUrl = DEFAULT_HUB_URL) {
    const name = trimString(input.name, 128);
    const room = trimString(input.room, 128);
    if (!name || !room) {
      throw serviceError('Sensor node name and room are required.');
    }

    const profile = normalizeProfile(input.profile);
    const powerSource = normalizePowerSource(input.powerSource, profile);
    const setupCode = createSetupCode();
    const hardwareId = trimString(input.hardwareId, 96).toUpperCase();
    if (hardwareId && !/^XIAO-C6-[A-Fa-f0-9]{12}$/.test(hardwareId)) {
      throw serviceError('Invalid sensor hardware identifier.');
    }
    const node = new this.SensorNode({
      name,
      room,
      profile,
      hardwareProfile: 'seeed-xiao-esp32-c6',
      powerSource,
      status: 'provisioning',
      settings: normalizeSettings(input.settings, profile, powerSource),
      setupCodeExpiresAt: new Date(Date.now() + SETUP_CODE_TTL_MS),
      deviceTokenVersion: 0
    });
    if (hardwareId) node.hardwareId = hardwareId;
    node.setupCodeHash = hashSecret(node, setupCode);
    await node.save();

    let device;
    try {
      device = await this.Device.create({
        name,
        room,
        type: sensorDeviceType(profile),
        status: false,
        isOnline: false,
        brand: 'HomeBrain',
        model: 'XIAO ESP32-C6 Sensor Node',
        properties: buildDeviceProperties(node)
      });
      node.deviceId = device._id;
      await node.save();
    } catch (error) {
      if (device) await this.Device.deleteOne({ _id: device._id }).catch(() => {});
      await this.SensorNode.deleteOne({ _id: node._id }).catch(() => {});
      throw error;
    }

    return {
      node: serializeNode(node),
      provisioning: buildProvisioning(node, setupCode, hubUrl)
    };
  }

  // The authenticated onboarding client transfers this short-lived credential
  // over encrypted BLE. It is never presented as a user-entered setup field.
  async onboardNode(input = {}, hubUrl = DEFAULT_HUB_URL) {
    const hardwareId = trimString(input.hardwareId, 96).toUpperCase();
    if (!/^XIAO-C6-[A-Fa-f0-9]{12}$/.test(hardwareId)) {
      throw serviceError('A discovered HomeBrain sensor is required.');
    }
    const existing = await this.SensorNode.findOne({ hardwareId });
    if (existing) {
      if (existing.setupCodeUsedAt || existing.deviceTokenCreatedAt) {
        return { node: serializeNode(existing), provisioning: buildProvisioning(existing, null, hubUrl), alreadyRegistered: true };
      }
      // Only rotate an unfinished claim. A concurrent activation must never
      // have its newly issued device token revoked by an onboarding retry.
      const setupCode = createSetupCode();
      const resumed = await this.SensorNode.findOneAndUpdate({
        _id: existing._id, setupCodeUsedAt: null, deviceTokenCreatedAt: null
      }, { $set: {
        setupCodeHash: hashSecret(existing, setupCode),
        setupCodeExpiresAt: new Date(Date.now() + SETUP_CODE_TTL_MS)
      } }, { new: true });
      if (!resumed) {
        const current = await this.getNodeById(toId(existing));
        return { node: serializeNode(current), provisioning: buildProvisioning(current, null, hubUrl), alreadyRegistered: true };
      }
      return { node: serializeNode(resumed), provisioning: buildProvisioning(resumed, setupCode, hubUrl), alreadyRegistered: false };
    }
    const profile = normalizeProfile(input.profile);
    const result = await this.registerNode({
      ...input,
      hardwareId,
      profile,
      name: trimString(input.name, 128) || `${PROFILE_DEFINITIONS[profile].label} ${hardwareId.slice(-6)}`,
      room: trimString(input.room, 128) || 'Unassigned'
    }, hubUrl);
    return { ...result, alreadyRegistered: false };
  }

  async updateNode(nodeId, input = {}) {
    const node = await this.getNodeById(nodeId);
    const profile = input.profile === undefined ? node.profile : normalizeProfile(input.profile);
    const powerSource = input.powerSource === undefined
      ? node.powerSource
      : normalizePowerSource(input.powerSource, profile);

    if (input.name !== undefined) {
      const name = trimString(input.name, 128);
      if (!name) throw serviceError('Sensor node name cannot be empty.');
      node.name = name;
    }
    if (input.room !== undefined) {
      const room = trimString(input.room, 128);
      if (!room) throw serviceError('Sensor node room cannot be empty.');
      node.room = room;
    }
    node.profile = profile;
    node.powerSource = powerSource;
    if (input.settings !== undefined || input.profile !== undefined || input.powerSource !== undefined) {
      node.settings = normalizeSettings({
        ...toPlain(node.settings),
        ...(input.settings || {})
      }, profile, powerSource);
    }
    await node.save();

    if (node.deviceId) {
      const device = await this.Device.findById(node.deviceId);
      if (device) {
        device.name = node.name;
        device.room = node.room;
        device.type = sensorDeviceType(profile);
        device.properties = buildDeviceProperties(node, device.properties);
        await device.save();
        this.emitDevice(device);
      }
    }

    return serializeNode(node);
  }

  async deleteNode(nodeId) {
    const node = await this.getNodeById(nodeId);
    const serialized = serializeNode(node);
    if (node.deviceId) {
      await this.Device.deleteOne({ _id: node.deviceId });
    }
    await this.SensorNode.deleteOne({ _id: node._id });
    return serialized;
  }

  async rotateSetupCode(nodeId, hubUrl = DEFAULT_HUB_URL) {
    const node = await this.getNodeWithSecrets(nodeId);
    const setupCode = createSetupCode();
    node.setupCodeHash = hashSecret(node, setupCode);
    node.setupCodeExpiresAt = new Date(Date.now() + SETUP_CODE_TTL_MS);
    node.setupCodeUsedAt = null;
    node.deviceTokenHash = undefined;
    node.deviceTokenCreatedAt = null;
    node.deviceTokenVersion = Number(node.deviceTokenVersion || 0) + 1;
    node.status = 'provisioning';
    await node.save();
    await this.markLinkedDeviceOffline(node);

    return {
      node: serializeNode(node),
      provisioning: buildProvisioning(node, setupCode, hubUrl)
    };
  }

  async getProvisioningStatus(nodeId, hubUrl = DEFAULT_HUB_URL) {
    const node = await this.getNodeById(nodeId);
    return {
      node: serializeNode(node),
      provisioning: buildProvisioning(node, null, hubUrl),
      requiresSetupCodeRotation: true
    };
  }

  async activateNode(nodeId, setupCode, payload = {}, context = {}) {
    let node = await this.getNodeWithSecrets(nodeId);
    const suppliedHash = hashSecret(node, setupCode);
    if (!node.setupCodeHash || !secureEqual(node.setupCodeHash, suppliedHash)) {
      throw serviceError('Invalid sensor setup code.', 401);
    }
    if (node.setupCodeUsedAt) {
      throw serviceError('This sensor setup code has already been used. Rotate it in HomeBrain to provision again.', 409);
    }
    if (!node.setupCodeExpiresAt || new Date(node.setupCodeExpiresAt).getTime() < Date.now()) {
      throw serviceError('This sensor setup code has expired. Rotate it in HomeBrain to provision again.', 410);
    }

    const hardwareId = trimString(payload.hardware_id || payload.hardwareId, 96);
    if (hardwareId && !/^[A-Za-z0-9:._-]{1,96}$/.test(hardwareId)) {
      throw serviceError('Invalid sensor hardware identifier.');
    }
    if (node.hardwareId && node.hardwareId !== hardwareId) {
      throw serviceError('Setup belongs to a different physical sensor.', 409);
    }
    if (hardwareId) {
      const existing = await this.SensorNode.findOne({
        hardwareId,
        _id: { $ne: node._id }
      });
      if (existing) {
        throw serviceError('This physical sensor is already assigned to another HomeBrain node.', 409);
      }
    }

    const token = createDeviceToken();
    const now = new Date();
    // Consume the one-time code in the same database operation that issues the
    // token. Concurrent activation or rotation must not issue a second token.
    node = await this.SensorNode.findOneAndUpdate({
      _id: node._id,
      setupCodeHash: suppliedHash,
      setupCodeUsedAt: null,
      setupCodeExpiresAt: { $gt: now }
    }, {
      $set: {
        deviceTokenHash: hashSecret(node, token),
        deviceTokenCreatedAt: now,
        setupCodeUsedAt: now,
        status: 'online',
        lastSeen: now,
        lastError: '',
        ...(hardwareId ? { hardwareId } : {}),
        firmwareVersion: trimString(payload.firmware_version || payload.firmwareVersion, 96) || node.firmwareVersion,
        capabilities: normalizeCapabilityList(payload.capabilities || node.capabilities),
        ipAddress: trimString(context.ipAddress, 64) || node.ipAddress,
        updatedAt: now
      },
      $inc: { deviceTokenVersion: 1 }
    }, { new: true, runValidators: true });
    if (!node) {
      throw serviceError('This sensor setup code was used, expired or rotated. Request a new code in HomeBrain.', 409);
    }

    if (node.deviceId) {
      const device = await this.Device.findById(node.deviceId);
      if (device) {
        device.isOnline = true;
        device.lastSeen = now;
        device.properties = buildDeviceProperties(node, device.properties);
        await device.save();
        this.emitDevice(device);
      }
    }

    return {
      node: serializeNode(node),
      deviceToken: token,
      config: buildRuntimeConfig(node)
    };
  }

  async authenticateToken(nodeId, token) {
    const node = await this.getNodeWithSecrets(nodeId);
    const suppliedHash = hashSecret(node, token);
    if (!node.deviceTokenHash || !secureEqual(node.deviceTokenHash, suppliedHash)) {
      throw serviceError('Invalid sensor device token.', 401);
    }
    return node;
  }

  async getRuntimeConfig(nodeId, token) {
    const node = await this.authenticateToken(nodeId, token);
    return buildRuntimeConfig(node);
  }

  async ingestReading(nodeId, token, payload = {}, context = {}) {
    const node = await this.authenticateToken(nodeId, token);
    const reading = normalizeReadingPayload(payload);
    const now = new Date();

    // 1.2.0 used a truncated EUI-64. Preserve the existing claim/history when
    // its authenticated sensor first reports the corrected six-byte MAC.
    const mac = /^XIAO-C6-([A-F0-9]{12})$/.exec(reading.hardwareId || '')?.[1];
    const legacyId = mac ? `XIAO-C6-${mac.slice(6, 8)}FEFF${mac.slice(4, 6)}${mac.slice(2, 4)}${mac.slice(0, 2)}` : '';
    const migratesLegacyId = node.firmwareVersion === '1.2.0' && payload.ota_protocol === 1
      && legacyId === node.hardwareId;
    if (reading.hardwareId && node.hardwareId && reading.hardwareId !== node.hardwareId && !migratesLegacyId) {
      throw serviceError('Sensor hardware identifier does not match the activated node.', 409);
    }

    node.status = 'online';
    node.lastSeen = now;
    node.lastReadingAt = now;
    node.lastError = '';
    node.readingSequence = Math.max(Number(node.readingSequence || 0), reading.sequence);
    node.hardwareId = reading.hardwareId || node.hardwareId;
    node.firmwareVersion = reading.firmwareVersion || node.firmwareVersion;
    node.otaProtocol = payload.ota_protocol === 1 ? 1 : 0;
    node.capabilities = inferCapabilities(reading);
    node.ipAddress = reading.diagnostics.ip_address
      || trimString(context.ipAddress, 64)
      || node.ipAddress;
    node.latestReading = {
      ...reading,
      received_at: now.toISOString()
    };
    await node.save();

    let device = null;
    if (node.deviceId) {
      device = await this.Device.findById(node.deviceId);
    }
    if (device) {
      device.isOnline = true;
      device.lastSeen = now;
      device.temperature = reading.readings.temperature_f;
      device.status = reading.readings.presence_present !== undefined
        ? reading.readings.presence_present
        : node.profile === 'presence' ? undefined : true;
      device.properties = buildDeviceProperties(node, device.properties, reading);
      await device.save();
      this.emitDevice(device);
    }

    return {
      accepted: true,
      receivedAt: now,
      node: serializeNode(node),
      config: buildRuntimeConfig(node)
    };
  }

  emitDevice(device) {
    const payload = this.deviceUpdateEmitter.normalizeDevices([device]);
    if (payload.length > 0) {
      this.deviceUpdateEmitter.emit('devices:update', payload);
    }
  }

  async markLinkedDeviceOffline(node) {
    if (!node?.deviceId) return;
    const device = await this.Device.findById(node.deviceId);
    if (!device) return;
    device.isOnline = false;
    device.status = false;
    await device.save();
    this.emitDevice(device);
  }

  async markStaleNodesOffline(now = Date.now()) {
    const query = this.SensorNode.find({ status: 'online' });
    const nodes = await resolveQuery(query);
    const staleNodes = (Array.isArray(nodes) ? nodes : []).filter((node) => !nodeIsFresh(node, now));

    for (const snapshot of staleNodes) {
      const node = await this.SensorNode.findById(toId(snapshot));
      if (!node || node.status !== 'online' || nodeIsFresh(node, now)) continue;
      node.status = 'offline';
      await node.save();
      await this.markLinkedDeviceOffline(node);
    }

    return staleNodes.length;
  }

  initialize() {
    if (this.offlineTimer) return;
    this.offlineTimer = setInterval(() => {
      void this.markStaleNodesOffline().catch((error) => {
        console.warn('SensorNodeService: offline scan failed: %s', error.message);
      });
    }, OFFLINE_SCAN_INTERVAL_MS);
    this.offlineTimer.unref?.();
  }

  shutdown() {
    if (this.offlineTimer) {
      clearInterval(this.offlineTimer);
      this.offlineTimer = null;
    }
  }
}

const sensorNodeService = new SensorNodeService();

module.exports = sensorNodeService;
module.exports.SensorNodeService = SensorNodeService;
module.exports.PROFILE_DEFINITIONS = PROFILE_DEFINITIONS;
module.exports.SENSOR_SCHEMA = SENSOR_SCHEMA;
module.exports.CONFIG_SCHEMA = CONFIG_SCHEMA;
module.exports._private = {
  buildProvisioning,
  buildRuntimeConfig,
  hashSecret,
  nodeIsFresh,
  normalizeReadingPayload,
  normalizeSettings,
  secureEqual,
  serializeNode
};

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const mongoose = require('mongoose');
const os = require('os');
const path = require('path');
const Device = require('../models/Device');
const EventStreamEvent = require('../models/EventStreamEvent');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const directRadioEngineLogService = require('./directRadioEngineLogService');
const eventStreamService = require('./eventStreamService');
const {
  DIRECT_RADIO_SOURCES,
  buildDirectFeatureProperties,
  buildNormalizedCapabilities,
  buildMigrationPlan,
  inferFeaturesFromSmartThings,
  isDirectRadioDevice,
  normalizeFeature
} = require('./directRadioDeviceCatalog');
const directRadioProtocolCatalogService = require('./directRadioProtocolCatalogService');
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
const ZWAVE_NODE_STATUS = Object.freeze({
  UNKNOWN: 0,
  ASLEEP: 1,
  AWAKE: 2,
  DEAD: 3,
  ALIVE: 4
});
const FALLBACK_SERIAL_DEVICE_PATTERNS = [
  /^ttyUSB\d+$/i,
  /^ttyACM\d+$/i
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeZWaveStatus(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim().toLowerCase();
    if (/^-?\d+$/.test(normalized)) {
      return Number(normalized);
    }
    switch (normalized) {
      case 'unknown':
        return ZWAVE_NODE_STATUS.UNKNOWN;
      case 'asleep':
        return ZWAVE_NODE_STATUS.ASLEEP;
      case 'awake':
        return ZWAVE_NODE_STATUS.AWAKE;
      case 'dead':
        return ZWAVE_NODE_STATUS.DEAD;
      case 'alive':
        return ZWAVE_NODE_STATUS.ALIVE;
      default:
        return null;
    }
  }
  return null;
}

function isZWaveStatusUnavailable(status) {
  const normalized = normalizeZWaveStatus(status);
  return normalized === ZWAVE_NODE_STATUS.UNKNOWN || normalized === ZWAVE_NODE_STATUS.DEAD;
}

function isZWaveNodeOnline(node) {
  if (!node) {
    return false;
  }
  if (node.ready !== true) {
    return false;
  }
  return !isZWaveStatusUnavailable(node.status);
}

function isZWaveNodeCommandReady(node) {
  if (!node) {
    return false;
  }
  if (node.ready === false || isZWaveStatusUnavailable(node.status)) {
    return false;
  }
  return true;
}

function isTerminalPairingStatus(status) {
  return ['completed', 'failed', 'expired', 'stopped'].includes(status);
}

function isZWavePairingCompletionReason(reason) {
  return ['node ready', 'ready', 'interview completed'].includes(trimString(reason).toLowerCase());
}

function buildDirectDeviceQuery(identity) {
  if (identity?.protocol === 'zigbee') {
    return { 'properties.homebrainDirect.ieeeAddr': identity.id };
  }

  return {
    $or: [
      { 'properties.homebrainDirect.nodeId': Number(identity?.id) },
      { 'properties.homebrainDirect.nodeId': String(identity?.id) }
    ]
  };
}

function isZWaveDirectUpdateInterviewComplete(update = {}, reason = '') {
  const properties = update?.properties && typeof update.properties === 'object'
    ? update.properties
    : {};
  const direct = properties.homebrainDirect && typeof properties.homebrainDirect === 'object'
    ? properties.homebrainDirect
    : {};
  const normalizedReason = trimString(reason || direct.lastReason).toLowerCase();
  if (normalizedReason === 'node added' || normalizedReason === 'interview failed') {
    return false;
  }

  const ready = direct.ready === true;
  if (!ready || isZWaveStatusUnavailable(direct.status)) {
    return false;
  }

  const features = Array.isArray(properties.directRadioFeatures)
    ? properties.directRadioFeatures.map(normalizeFeature).filter(Boolean)
    : [];
  const hasStableIdentity = direct.manufacturerId !== null && direct.manufacturerId !== undefined
    || direct.productType !== null && direct.productType !== undefined
    || direct.productId !== null && direct.productId !== undefined
    || Boolean(direct.catalog)
    || Boolean(trimString(update.brand))
    || Boolean(trimString(update.model));

  return isZWavePairingCompletionReason(normalizedReason)
    || features.length > 0
    || hasStableIdentity;
}

function normalizeDirectRoom(value) {
  return trimString(value) || 'Unassigned';
}

function shouldReplaceGeneratedDirectName(existing, generated, previousGenerated) {
  const existingName = trimString(existing);
  const generatedName = trimString(generated);
  const previousGeneratedName = trimString(previousGenerated);

  if (!existingName) {
    return true;
  }
  if (!generatedName) {
    return false;
  }
  if (existingName === generatedName || (previousGeneratedName && existingName === previousGeneratedName)) {
    return true;
  }

  return /^(?:z-wave node|zigbee device|direct radio device)\b/i.test(existingName);
}

function shouldReplaceGeneratedDirectRoom(existing, generated, previousGenerated) {
  const existingRoom = normalizeDirectRoom(existing);
  const generatedRoom = normalizeDirectRoom(generated);
  const previousGeneratedRoom = normalizeDirectRoom(previousGenerated);

  if (!trimString(existing)) {
    return true;
  }
  if (existingRoom === generatedRoom || existingRoom === previousGeneratedRoom) {
    return true;
  }

  return existingRoom.toLowerCase() === 'unassigned';
}

function inferFeaturesFromExistingDirectRecord(record) {
  if (!record || typeof record !== 'object') {
    return [];
  }

  const properties = record.properties && typeof record.properties === 'object'
    ? record.properties
    : {};
  const features = [];
  const add = (feature) => {
    const normalized = normalizeFeature(feature);
    if (normalized) {
      features.push(normalized);
    }
  };

  inferFeaturesFromDirectRadioState(properties.directRadioState).forEach(add);

  const supportFlags = {
    supportsBattery: 'battery',
    supportsContactSensor: 'contact',
    supportsMotionSensor: 'motion',
    supportsTemperatureSensor: 'temperature',
    supportsHumiditySensor: 'humidity',
    supportsIlluminanceSensor: 'illuminance',
    supportsTamperSensor: 'tamper',
    supportsAccelerationSensor: 'acceleration',
    supportsVibrationSensor: 'vibration',
    supportsWaterSensor: 'water',
    supportsColorTemperature: 'colorTemperature',
    supportsColor: 'color',
    supportsBrightness: 'brightness',
    supportsPowerMeter: 'power',
    supportsEnergyMeter: 'energy',
    supportsVoltage: 'voltage',
    supportsCurrent: 'current'
  };
  Object.entries(supportFlags).forEach(([flag, feature]) => {
    if (properties[flag] === true) {
      add(feature);
    }
  });

  const text = [
    record.name,
    record.type,
    record.brand,
    record.model,
    properties.homebrainDirect?.generatedName,
    properties.homebrainDirect?.modelID,
    properties.homebrainDirect?.manufacturerName
  ].filter(Boolean).join(' ').toLowerCase();
  const isSensor = trimString(record.type).toLowerCase() === 'sensor' || /\bsensor\b/.test(text);

  if (/\b(?:door|window|contact|open[\s-]?close|multipurpose)\b/.test(text)) {
    add('contact');
    add('battery');
    add('tamper');
    add('temperature');
  }
  if (/\b(?:motion|occupancy)\b/.test(text)) {
    add('motion');
    add('battery');
  }
  if (/\b(?:vibration|accelerat|tilt|shake)\b/.test(text)) {
    add('vibration');
    add('acceleration');
    add('battery');
  }
  if (/\b(?:water|leak|flood)\b/.test(text)) {
    add('water');
    add('battery');
  }
  if (/\b(?:temperature|temp|thermometer)\b/.test(text)) {
    add('temperature');
    add('battery');
  }
  if (/\b(?:humidity|humid)\b/.test(text)) {
    add('humidity');
    add('battery');
  }
  if (/\b(?:illuminance|lux|light level)\b/.test(text)) {
    add('illuminance');
    add('battery');
  }
  if (isSensor && features.length === 0) {
    add('battery');
  }

  return uniqueStrings(features).sort();
}

function mergeDirectDeviceUpdateForExisting(existing, update = {}) {
  const existingProperties = existing?.properties && typeof existing.properties === 'object'
    ? existing.properties
    : {};
  const existingDirect = existingProperties.homebrainDirect && typeof existingProperties.homebrainDirect === 'object'
    ? existingProperties.homebrainDirect
    : {};
  const updateProperties = update.properties && typeof update.properties === 'object'
    ? update.properties
    : {};
  const updateDirect = updateProperties.homebrainDirect && typeof updateProperties.homebrainDirect === 'object'
    ? updateProperties.homebrainDirect
    : {};
  const updateFeatures = Array.isArray(updateProperties.directRadioFeatures)
    ? updateProperties.directRadioFeatures.map(normalizeFeature).filter(Boolean)
    : [];
  const existingFeatures = Array.isArray(existingProperties.directRadioFeatures)
    ? existingProperties.directRadioFeatures.map(normalizeFeature).filter(Boolean)
    : [];
  const inferredSmartThingsFeatures = inferFeaturesFromSmartThings(existing)
    .map(normalizeFeature)
    .filter(Boolean);
  const inferredExistingDirectFeatures = inferFeaturesFromExistingDirectRecord(existing);

  const generatedName = trimString(update.name);
  const generatedRoom = normalizeDirectRoom(update.room);
  const mergedDirect = {
    ...existingDirect,
    ...updateDirect
  };
  ['manufacturerId', 'productType', 'productId', 'catalog'].forEach((key) => {
    const incoming = updateDirect[key];
    const existingValue = existingDirect[key];
    if ((incoming === null || incoming === undefined || incoming === '')
      && existingValue !== null
      && existingValue !== undefined
      && existingValue !== '') {
      mergedDirect[key] = existingValue;
    }
  });

  if (generatedName) {
    mergedDirect.generatedName = generatedName;
  }
  if (generatedRoom) {
    mergedDirect.generatedRoom = generatedRoom;
  }

  const merged = {
    ...update,
    properties: {
      ...existingProperties,
      ...updateProperties,
      directRadioState: {
        ...(existingProperties.directRadioState && typeof existingProperties.directRadioState === 'object'
          ? existingProperties.directRadioState
          : {}),
        ...(updateProperties.directRadioState && typeof updateProperties.directRadioState === 'object'
          ? updateProperties.directRadioState
          : {})
      },
      homebrainDirect: mergedDirect
    }
  };
  if ((updateProperties.directRadioCatalog === null || updateProperties.directRadioCatalog === undefined)
    && existingProperties.directRadioCatalog) {
    merged.properties.directRadioCatalog = existingProperties.directRadioCatalog;
  }
  if (Object.keys(merged.properties.directRadioState).length === 0) {
    delete merged.properties.directRadioState;
  }
  let mergedFeatures = uniqueStrings([
    ...updateFeatures,
    ...existingFeatures,
    ...inferredSmartThingsFeatures,
    ...inferredExistingDirectFeatures
  ]).sort();
  const updateSource = normalizeSourceText(updateProperties.source);
  const updateProtocol = normalizeSourceText(updateProperties.homebrainDirect?.protocol);
  const updateIsZWaveLock = (updateSource === DIRECT_RADIO_SOURCES.zwave || updateProtocol === 'zwave')
    && updateFeatures.includes('lock');
  if (updateIsZWaveLock && !updateFeatures.includes('lockCodes')) {
    mergedFeatures = mergedFeatures.filter((feature) => feature !== 'lockCodes');
  }
  if (mergedFeatures.length > 0) {
    merged.properties.directRadioFeatures = mergedFeatures;
    merged.properties.directRadioCapabilities = buildNormalizedCapabilities(
      mergedFeatures,
      mergedDirect.protocol || updateProperties.source || existingProperties.source || 'unknown'
    );
    Object.assign(merged.properties, buildDirectFeatureProperties(mergedFeatures));
  }
  if (updateIsZWaveLock && !updateFeatures.includes('lockCodes')) {
    merged.properties.supportsLockCodes = false;
    if (merged.properties.lockCodes && typeof merged.properties.lockCodes === 'object') {
      merged.properties.lockCodes = {
        ...merged.properties.lockCodes,
        supported: false,
        unavailableReason: 'secure_access_control_missing'
      };
    }
  }
  const nativeBatteryPending = updateIsZWaveLock && updateProperties.homeBrainBatteryReportPending === true;
  if (nativeBatteryPending && merged.properties.directRadioState) {
    delete merged.properties.directRadioState.batteryLevel;
    delete merged.properties.directRadioState.batteryLow;
    if (Object.keys(merged.properties.directRadioState).length === 0) {
      delete merged.properties.directRadioState;
    }
  }

  if (existing) {
    if (!Object.prototype.hasOwnProperty.call(update, 'status') || update.status === undefined) {
      merged.status = existing.status;
    }

    if (!Object.prototype.hasOwnProperty.call(update, 'brightness') || update.brightness === undefined) {
      merged.brightness = existing.brightness;
    }

    if (!Object.prototype.hasOwnProperty.call(update, 'color') || update.color === undefined) {
      merged.color = existing.color;
    }

    if (!Object.prototype.hasOwnProperty.call(update, 'colorTemperature') || update.colorTemperature === undefined) {
      merged.colorTemperature = existing.colorTemperature;
    }

    if (!Object.prototype.hasOwnProperty.call(update, 'temperature') || update.temperature === undefined) {
      merged.temperature = existing.temperature;
    }

    const existingStableCatalogName = trimString(
      existingProperties.directRadioCatalog?.label
      || existingDirect.catalog?.label
      || existing.model
    );
    if (isGenericDirectRadioName(generatedName) && directFeatureCount(existing) > 0) {
      merged.name = isGenericDirectRadioName(existing.name) && existingStableCatalogName
        ? existingStableCatalogName
        : existing.name;
    } else if (!shouldReplaceGeneratedDirectName(existing.name, generatedName, existingDirect.generatedName)) {
      merged.name = existing.name;
    }

    if (!shouldReplaceGeneratedDirectRoom(existing.room, generatedRoom, existingDirect.generatedRoom)) {
      merged.room = existing.room;
    }

    if (!trimString(merged.type)) {
      merged.type = existing.type;
    }

    if (trimString(existing.type) && merged.type === 'sensor' && existing.type !== 'sensor') {
      merged.type = existing.type;
    }
  }

  return merged;
}

function directFeatureCount(record) {
  const features = Array.isArray(record?.properties?.directRadioFeatures)
    ? record.properties.directRadioFeatures
    : [];
  return features.filter((feature) => trimString(feature).length > 0).length;
}

function directRecordTimestamp(record) {
  const value = record?.updatedAt || record?.lastSeen || record?.createdAt;
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function isGenericDirectRadioName(value) {
  return /^(?:z-wave node \d+|zigbee device\b|direct radio device\b)/i.test(trimString(value));
}

function isIncompleteDirectRadioDuplicate(record) {
  return directFeatureCount(record) === 0
    && isGenericDirectRadioName(record?.name)
    && record?.type === 'sensor';
}

function directRecordMatchesIdentity(record, identity = {}) {
  const direct = record?.properties?.homebrainDirect;
  if (!direct || typeof direct !== 'object') {
    return false;
  }

  if (identity.protocol === 'zigbee') {
    return trimString(direct.ieeeAddr).toLowerCase() === trimString(identity.id).toLowerCase();
  }

  if (identity.protocol === 'zwave') {
    const recordNodeId = Number(direct.nodeId);
    const identityNodeId = Number(identity.id);
    return Number.isFinite(recordNodeId)
      && Number.isFinite(identityNodeId)
      && recordNodeId === identityNodeId;
  }

  return false;
}

function isDuplicateDirectRadioRecord(record, primary, identity) {
  if (!record || !primary) {
    return false;
  }
  if (String(record?._id || '') === String(primary?._id || '')) {
    return false;
  }
  if (!directRecordMatchesIdentity(record, identity)) {
    return false;
  }
  if (isIncompleteDirectRadioDuplicate(record)) {
    return true;
  }

  return directFeatureCount(primary) > 0 && directFeatureCount(record) > 0;
}

function selectPrimaryDirectDeviceRecord(records = []) {
  const candidates = Array.isArray(records) ? records.filter(Boolean) : [];
  if (candidates.length === 0) {
    return null;
  }

  return candidates
    .slice()
    .sort((left, right) => {
      const leftScore = (directFeatureCount(left) * 100)
        + (isGenericDirectRadioName(left?.name) ? 0 : 20)
        + (left?.isOnline === true ? 10 : 0)
        + (['switch', 'light', 'lock', 'thermostat', 'garage', 'siren'].includes(left?.type) ? 5 : 0);
      const rightScore = (directFeatureCount(right) * 100)
        + (isGenericDirectRadioName(right?.name) ? 0 : 20)
        + (right?.isOnline === true ? 10 : 0)
        + (['switch', 'light', 'lock', 'thermostat', 'garage', 'siren'].includes(right?.type) ? 5 : 0);

      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }

      return directRecordTimestamp(right) - directRecordTimestamp(left);
    })[0];
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function parseOptionalBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === undefined || value === null) {
    return fallback;
  }
  return parseEnabledFlag(value, fallback);
}

function normalizeZWaveSecurityMode(value, fallback = 'insecure') {
  const normalized = trimString(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['insecure', 'none', 'no_security', 'no-security', 'standard', 'switch'].includes(normalized)) {
    return 'insecure';
  }
  if (['s0', 'security_s0', 'security-s0'].includes(normalized)) {
    return 's0';
  }
  if (['s2', 'security_s2', 'security-s2', 'secure'].includes(normalized)) {
    return 's2';
  }
  if (['default', 'auto'].includes(normalized)) {
    return 'default';
  }
  return fallback;
}

function shouldUseSecureZWaveMigration(device = {}, plan = {}) {
  const values = [
    device.type,
    device.name,
    device.category,
    device.properties?.smartThingsDeviceType,
    device.properties?.smartThingsDeviceCategory,
    device.properties?.smartThingsPresentation?.dashboard?.states?.[0]?.label
  ];
  const features = [
    ...(Array.isArray(plan.features) ? plan.features : []),
    ...(Array.isArray(device.properties?.directRadioFeatures) ? device.properties.directRadioFeatures : []),
    ...(Array.isArray(device.capabilities) ? device.capabilities : [])
  ];
  const text = [...values, ...features]
    .map((entry) => trimString(entry).toLowerCase())
    .filter(Boolean)
    .join(' ');
  return /\block\b|garage|barrier|access\s*control|door\s*control|alarm|siren|security/.test(text);
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeSourceText(value) {
  return trimString(value).toLowerCase();
}

function getDeviceIdString(device) {
  return trimString(device?._id?.toString?.() || device?._id || device?.id);
}

function getDeviceProperties(device) {
  return device?.properties && typeof device.properties === 'object'
    ? device.properties
    : {};
}

function toPlainDeviceSnapshot(device) {
  if (!device) {
    return {};
  }
  if (typeof device.toObject === 'function') {
    return device.toObject({ depopulate: true });
  }
  return { ...device };
}

function getSmartThingsMigration(device) {
  const migration = getDeviceProperties(device).smartThingsMigration;
  return migration && typeof migration === 'object' && !Array.isArray(migration)
    ? migration
    : null;
}

function isRetiredSmartThingsMigrationSource(device) {
  const migration = getSmartThingsMigration(device);
  return migration?.retiredSource === true
    || normalizeSourceText(migration?.status) === 'finalized_source';
}

function normalizeMigrationNameTokens(...values) {
  const ignored = new Set([
    'a',
    'an',
    'and',
    'device',
    'sensor',
    'the'
  ]);
  return new Set(values
    .map((value) => trimString(value).toLowerCase())
    .filter(Boolean)
    .flatMap((value) => value
      .replace(/open\s*\/\s*closed/g, 'open closed')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !ignored.has(token))));
}

function scoreTokenOverlap(left, right) {
  if (!(left instanceof Set) || !(right instanceof Set) || left.size === 0 || right.size === 0) {
    return 0;
  }
  let overlap = 0;
  left.forEach((token) => {
    if (right.has(token)) {
      overlap += 1;
    }
  });
  return overlap / Math.max(left.size, right.size);
}

function smartThingsNetworkTypeMatchesProtocol(properties = {}, protocol = '') {
  const networkType = normalizeSourceText(properties.smartThingsDeviceNetworkType)
    .replace(/[^a-z0-9]+/g, '');
  if (protocol === 'zigbee') {
    return networkType === 'zigbee';
  }
  if (protocol === 'zwave') {
    return networkType === 'zwave' || networkType === 'zw';
  }
  return false;
}

function readSmartThingsBatteryLevel(device) {
  const properties = getDeviceProperties(device);
  return clampPercent(
    properties.smartThingsBatteryLevel
    ?? properties.batteryLevel
    ?? properties.battery
    ?? properties.smartThingsAttributeValues?.battery?.battery
    ?? properties.smartThingsAttributeValues?.battery?.batteryLevel
  );
}

function readSmartThingsTemperatureF(device) {
  const topLevel = toFiniteNumber(device?.temperature);
  if (topLevel !== null) {
    return topLevel;
  }

  const properties = getDeviceProperties(device);
  const temperature = toFiniteNumber(
    properties.smartThingsAttributeValues?.temperatureMeasurement?.temperature
    ?? properties.smartThingsAttributeValues?.temperature?.temperature
    ?? properties.smartThingsAttributeValues?.temperature
  );
  if (temperature === null) {
    return null;
  }

  const unit = trimString(
    properties.smartThingsAttributeMetadata?.temperatureMeasurement?.temperature?.unit
    ?? properties.smartThingsAttributeMetadata?.temperature?.temperature?.unit
    ?? properties.smartThingsAttributeMetadata?.temperature?.unit
  ).toUpperCase();
  return unit === 'C' || unit === 'CELSIUS'
    ? celsiusToFahrenheit(temperature)
    : temperature;
}

function copySmartThingsHistoryProperties(sourceProperties = {}) {
  const history = {};
  Object.entries(sourceProperties).forEach(([key, value]) => {
    if (/^smartthings/i.test(key) || key === 'componentIds') {
      history[key] = value;
    }
  });
  return history;
}

function mergeSmartThingsTelemetryFallback(snapshot = {}, sourceDevice = null) {
  const next = {
    ...snapshot,
    properties: {
      ...(snapshot.properties && typeof snapshot.properties === 'object' ? snapshot.properties : {})
    }
  };
  const directState = next.properties.directRadioState && typeof next.properties.directRadioState === 'object'
    ? { ...next.properties.directRadioState }
    : {};

  const temperatureF = readSmartThingsTemperatureF(sourceDevice);
  if (temperatureF !== null) {
    if (directState.temperatureF === undefined) {
      directState.temperatureF = temperatureF;
    }
    if (directState.temperatureC === undefined) {
      directState.temperatureC = Math.round(((temperatureF - 32) * 5 / 9) * 10) / 10;
    }
    if (!Object.prototype.hasOwnProperty.call(next, 'temperature') || next.temperature === undefined) {
      next.temperature = temperatureF;
    }
  }

  const nativeBatteryPending = next.properties.homeBrainBatteryReportPending === true;
  const batteryLevel = nativeBatteryPending ? null : readSmartThingsBatteryLevel(sourceDevice);
  if (batteryLevel !== null && directState.batteryLevel === undefined) {
    directState.batteryLevel = batteryLevel;
  }
  if (batteryLevel !== null) {
    next.properties.homeBrainBatteryLevel ??= batteryLevel;
    next.properties.batteryLevel ??= batteryLevel;
  }

  if (Object.keys(directState).length > 0) {
    next.properties.directRadioState = directState;
  }

  return next;
}

function normalizeSmartThingsState(value) {
  return trimString(value).toUpperCase();
}

function isSmartThingsDeviceGoneError(error) {
  const status = Number(error?.status ?? error?.response?.status);
  return [404, 410].includes(status);
}

function getSmartThingsHubId(device = {}) {
  return trimString(device?.parentDeviceId || device?.zwave?.hubId || device?.zigbee?.hubId || device?.hubId);
}

function getSmartThingsProvisioningState(device = {}) {
  return normalizeSmartThingsState(
    device?.zwave?.provisioningState
      || device?.zigbee?.provisioningState
      || device?.provisioningState
  );
}

function isSmartThingsUnprovisionedState(value) {
  return [
    'EXCLUDED',
    'REMOVED',
    'DELETED',
    'UNPROVISIONED',
    'NOT_PROVISIONED',
    'NOT PROVISIONED'
  ].includes(normalizeSmartThingsState(value));
}

function getNewestSmartThingsTimestamp(value) {
  let newest = 0;
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    for (const item of Object.values(entry)) {
      if (item && typeof item === 'object') {
        visit(item);
      } else if (typeof item === 'string') {
        const parsed = Date.parse(item);
        if (Number.isFinite(parsed) && parsed > newest) {
          newest = parsed;
        }
      }
    }
  };
  visit(value);
  return newest > 0 ? new Date(newest).toISOString() : null;
}

function summarizeSmartThingsExclusionEvidence({
  device = null,
  health = null,
  hubHealth = null,
  status = null,
  localDevice = null,
  source = ''
} = {}) {
  const localHealth = localDevice?.properties?.smartThingsHealthState || null;
  const resolvedHealth = health || localHealth || null;
  return {
    source: source || null,
    deviceId: device?.deviceId || localDevice?.properties?.smartThingsDeviceId || null,
    deviceType: device?.type || localDevice?.properties?.smartThingsDeviceNetworkType || null,
    label: device?.label || localDevice?.name || null,
    provisioningState: getSmartThingsProvisioningState(device) || null,
    healthState: resolvedHealth?.state || null,
    healthUpdatedAt: resolvedHealth?.lastUpdatedDate || null,
    hubId: getSmartThingsHubId(device) || null,
    hubConnectivity: hubHealth?.connectivity || null,
    hubRadioState: hubHealth?.hubRadioState || null,
    newestStatusAt: getNewestSmartThingsTimestamp(status || localDevice?.properties?.smartThingsStatus || null),
    observedAt: new Date().toISOString()
  };
}

function collectSmartThingsExclusionCounters(value, pathParts = [], counters = []) {
  if (!value || typeof value !== 'object') {
    return counters;
  }

  for (const [key, item] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    const normalizedPath = nextPath.join('.').toLowerCase();
    if (
      typeof item === 'number'
      && Number.isFinite(item)
      && /exclu/.test(normalizedPath)
    ) {
      counters.push({
        path: nextPath.join('.'),
        value: item
      });
    } else if (item && typeof item === 'object') {
      collectSmartThingsExclusionCounters(item, nextPath, counters);
    }
  }

  return counters;
}

function findSmartThingsExclusionCounterIncrease(before, after) {
  const previous = new Map(
    collectSmartThingsExclusionCounters(before).map((entry) => [entry.path, entry.value])
  );
  return collectSmartThingsExclusionCounters(after).find((entry) => {
    const oldValue = previous.get(entry.path);
    return typeof oldValue === 'number' && entry.value > oldValue;
  }) || null;
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

function normalizeZWaveBatteryReport(value, options = {}) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return {
      level: null,
      low: false,
      pending: options.pendingWhenMissing === true
    };
  }

  if (numeric === 255) {
    return {
      level: 1,
      low: true,
      pending: false
    };
  }

  if (numeric === 0 && options.zeroIsUnknown === true) {
    return {
      level: null,
      low: false,
      pending: true
    };
  }

  const level = clampPercent(numeric);
  return {
    level,
    low: level !== null && level <= 5,
    pending: false
  };
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

function miredToKelvin(mired) {
  const numeric = Number(mired);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  return Math.round(1000000 / numeric);
}

function roundTo(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  const multiplier = 10 ** digits;
  return Math.round(numeric * multiplier) / multiplier;
}

function celsiusToFahrenheit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return roundTo((numeric * 9) / 5 + 32, 1);
}

async function withTimeout(promise, timeoutMs, message) {
  let timeoutHandle;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(message || 'Operation timed out'));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

const ZIGBEE_COMMON_ENDPOINT_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 242];

function getZigbeeEndpointId(endpoint) {
  const numeric = Number(endpoint?.ID ?? endpoint?.id ?? endpoint?.endpointID ?? endpoint?.endpointId);
  return Number.isFinite(numeric) ? numeric : null;
}

function collectZigbeeEndpointClusterTokens(endpoint) {
  const tokens = new Set();

  [
    endpoint?.inputClusters,
    endpoint?.outputClusters,
    endpoint?.profile?.inputClusters,
    endpoint?.profile?.outputClusters,
    endpoint?.simpleDescriptor?.inputClusters,
    endpoint?.simpleDescriptor?.outputClusters
  ].forEach((clusters) => {
    if (!Array.isArray(clusters)) {
      return;
    }
    clusters.forEach((cluster) => {
      const token = normalizeZigbeeClusterToken(cluster);
      if (token) {
        tokens.add(token);
      }
    });
  });

  if (endpoint?.clusters && typeof endpoint.clusters === 'object') {
    Object.keys(endpoint.clusters).forEach((cluster) => {
      const token = normalizeZigbeeClusterToken(cluster);
      if (token) {
        tokens.add(token);
      }
    });
  }

  return tokens;
}

function getZigbeeEndpoints(zigbeeDevice) {
  if (!zigbeeDevice) {
    return [];
  }

  const endpoints = [];
  const seen = new Set();
  const seenObjects = new Set();
  const addEndpoint = (endpoint) => {
    if (!endpoint || typeof endpoint !== 'object') {
      return;
    }
    if (seenObjects.has(endpoint)) {
      return;
    }
    const id = getZigbeeEndpointId(endpoint);
    const key = id === null ? `object:${endpoints.length}` : `id:${id}`;
    if (seen.has(key)) {
      return;
    }
    seenObjects.add(endpoint);
    seen.add(key);
    endpoints.push(endpoint);
  };

  if (Array.isArray(zigbeeDevice.endpoints)) {
    zigbeeDevice.endpoints.forEach(addEndpoint);
  }

  if (typeof zigbeeDevice.getEndpoint === 'function') {
    const knownIds = Array.isArray(zigbeeDevice.endpoints)
      ? zigbeeDevice.endpoints.map(getZigbeeEndpointId).filter((id) => id !== null)
      : [];
    uniqueStrings([...knownIds, ...ZIGBEE_COMMON_ENDPOINT_IDS].map(String)).forEach((candidateId) => {
      try {
        addEndpoint(zigbeeDevice.getEndpoint(Number(candidateId)));
      } catch (_error) {
        // Some zigbee-herdsman device shims throw for missing endpoint IDs.
      }
    });
  }

  return endpoints;
}

function getZigbeeClusterPreferenceForAction(action) {
  switch (normalizeSourceText(action)) {
    case 'setbrightness':
      return ['genLevelCtrl', 'genlevelctrl', 8, 'genOnOff', 'genonoff', 6];
    case 'setcolor':
    case 'setcolortemperature':
      return ['lightingColorCtrl', 'lightingcolorctrl', 768];
    case 'lock':
    case 'unlock':
      return ['closuresDoorLock', 'closuresdoorlock', 257];
    case 'toggle':
    case 'turnon':
    case 'turnoff':
    default:
      return ['genOnOff', 'genonoff', 6];
  }
}

function scoreZigbeeEndpoint(endpoint, action) {
  const id = getZigbeeEndpointId(endpoint);
  const clusters = collectZigbeeEndpointClusterTokens(endpoint);
  const preferredClusters = getZigbeeClusterPreferenceForAction(action)
    .map(normalizeZigbeeClusterToken)
    .filter(Boolean);
  let score = 0;

  if (typeof endpoint?.command === 'function') {
    score += 100;
  }
  preferredClusters.forEach((cluster) => {
    if (clusters.has(cluster)) {
      score += 35;
    }
  });
  ['genonoff', 'genlevelctrl', 'lightingcolorctrl', 'closuresdoorlock'].forEach((cluster) => {
    if (clusters.has(cluster)) {
      score += 8;
    }
  });
  if (id === 1) {
    score += 8;
  } else if (id === 2 || id === 3) {
    score += 6;
  } else if (id !== null && id > 3 && id < 20) {
    score += 2;
  } else if (id === 242) {
    score -= 60;
  }

  return score;
}

function readZigbeeEndpoint(zigbeeDevice, action = null) {
  const endpoints = getZigbeeEndpoints(zigbeeDevice);
  if (endpoints.length === 0) {
    return null;
  }

  return endpoints
    .slice()
    .sort((left, right) => scoreZigbeeEndpoint(right, action) - scoreZigbeeEndpoint(left, action))[0]
    || null;
}

function readZigbeeEndpointAttribute(endpoint, clusterCandidates = [], attributeCandidates = []) {
  if (!endpoint) {
    return undefined;
  }

  if (typeof endpoint.getClusterAttributeValue === 'function') {
    for (const cluster of clusterCandidates) {
      for (const attribute of attributeCandidates) {
        try {
          const value = endpoint.getClusterAttributeValue(cluster, attribute);
          if (value !== undefined && value !== null) {
            return value;
          }
        } catch (_error) {
          // Try the next cluster/attribute representation.
        }
      }
    }
  }

  const clusters = endpoint.clusters && typeof endpoint.clusters === 'object'
    ? endpoint.clusters
    : null;
  if (!clusters) {
    return undefined;
  }

  for (const cluster of clusterCandidates) {
    const clusterValue = clusters[cluster] || clusters[String(cluster)] || clusters[normalizeZigbeeClusterToken(cluster)];
    if (!clusterValue || typeof clusterValue !== 'object') {
      continue;
    }

    for (const attribute of attributeCandidates) {
      const directValue = clusterValue[attribute];
      if (directValue !== undefined && directValue !== null) {
        return directValue;
      }

      const attributeValue = clusterValue.attributes?.[attribute];
      if (attributeValue !== undefined && attributeValue !== null) {
        return attributeValue;
      }
    }
  }

  return undefined;
}

function normalizeZigbeeSwitchState(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['on', 'true', '1', 'open', 'opened', 'active'].includes(normalized)) {
    return true;
  }
  if (['off', 'false', '0', 'closed', 'inactive'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function normalizeZigbeePercent(value, scale = 'percent') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }

  if (scale === 'level') {
    return clampPercent(Math.round((Math.max(0, Math.min(254, numeric)) / 254) * 100));
  }

  return clampPercent(numeric);
}

function normalizeZigbeeActiveState(value) {
  return normalizeZigbeeSwitchState(value);
}

function normalizeZigbeeContactOpen(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return !value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value <= 0;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['open', 'opened', 'active', 'detected', 'alarm'].includes(normalized)) {
    return true;
  }
  if (['closed', 'close', 'inactive', 'clear', 'cleared', 'normal'].includes(normalized)) {
    return false;
  }
  if (['true', '1', 'yes'].includes(normalized)) {
    return false;
  }
  if (['false', '0', 'no'].includes(normalized)) {
    return true;
  }
  return undefined;
}

function normalizeZigbeeBatteryPercent(value, key = '') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }

  const normalizedKey = normalizeSourceText(key);
  if (normalizedKey.includes('percentage') && numeric > 100 && numeric <= 200) {
    return clampPercent(numeric / 2);
  }
  if (numeric > 100 && numeric <= 200) {
    return clampPercent(numeric / 2);
  }
  return clampPercent(numeric);
}

function normalizeZigbeeBatteryVoltage(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  if (numeric > 1000) {
    return roundTo(numeric / 1000, 2);
  }
  if (numeric > 10) {
    return roundTo(numeric / 10, 2);
  }
  return roundTo(numeric, 2);
}

function looksLikeBatteryVoltage(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return false;
  }
  return numeric <= 50 || (numeric >= 1000 && numeric <= 10000);
}

function normalizeZigbeeBatteryVoltageFromState(value) {
  return looksLikeBatteryVoltage(value)
    ? normalizeZigbeeBatteryVoltage(value)
    : undefined;
}

function inferZigbeeBatteryPercentFromVoltage(value) {
  const volts = normalizeZigbeeBatteryVoltage(value);
  if (!Number.isFinite(volts)) {
    return undefined;
  }

  if (volts >= 2 && volts <= 3.3) {
    return clampPercent(((volts - 2.1) / 0.9) * 100);
  }

  if (volts >= 1 && volts <= 1.8) {
    return clampPercent(((volts - 1) / 0.6) * 100);
  }

  if (volts >= 4 && volts <= 6.6) {
    return clampPercent(((volts - 4.2) / 1.8) * 100);
  }

  return undefined;
}

function fillBatteryPercentFromVoltage(directState) {
  if (!directState || directState.batteryLevel !== undefined || directState.batteryVoltage === undefined) {
    return;
  }
  assignDefined(directState, 'batteryLevel', inferZigbeeBatteryPercentFromVoltage(directState.batteryVoltage));
}

function coerceZigbeeNumericValue(value) {
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : null;
  }

  const direct = toFiniteNumber(value);
  if (direct !== null) {
    return direct;
  }

  if (Array.isArray(value)) {
    const parts = value.map((entry) => toFiniteNumber(entry));
    if (parts.some((entry) => entry === null)) {
      return null;
    }
    if (parts.length === 1) {
      return parts[0];
    }
    return parts.reduce((total, part) => (total * 65536) + part, 0);
  }

  if (value && typeof value === 'object') {
    for (const key of ['value', 'rawValue', 'measuredValue', 'measuredvalue', 'data']) {
      const nested = coerceZigbeeNumericValue(value[key]);
      if (nested !== null) {
        return nested;
      }
    }
    const low = coerceZigbeeNumericValue(value.low ?? value.lo ?? value.lsb);
    const high = coerceZigbeeNumericValue(value.high ?? value.hi ?? value.msb);
    if (low !== null && high !== null) {
      return (high * 65536) + low;
    }
  }

  return null;
}

function normalizeZigbeeScaledNumber(value, multiplier = 1, divisor = 1, digits = 2) {
  const numeric = coerceZigbeeNumericValue(value);
  if (numeric === null) {
    return undefined;
  }

  const numericMultiplier = coerceZigbeeNumericValue(multiplier) ?? 1;
  const numericDivisor = coerceZigbeeNumericValue(divisor) ?? 1;
  if (!Number.isFinite(numericMultiplier) || !Number.isFinite(numericDivisor) || numericDivisor === 0) {
    return undefined;
  }

  return roundTo((numeric * numericMultiplier) / numericDivisor, digits);
}

function normalizeZigbeePowerWatts(value, multiplier = 1, divisor = 1) {
  return normalizeZigbeeScaledNumber(value, multiplier, divisor, 2);
}

function normalizeZigbeeEnergyKwh(value, multiplier = 1, divisor = 1) {
  return normalizeZigbeeScaledNumber(value, multiplier, divisor, 4);
}

function normalizeZigbeeVoltageVolts(value, multiplier = 1, divisor = 1) {
  const scaled = normalizeZigbeeScaledNumber(value, multiplier, divisor, 2);
  if (scaled === undefined) {
    return undefined;
  }
  if (Math.abs(scaled) > 1000) {
    return roundTo(scaled / 1000, 2);
  }
  if (Math.abs(scaled) > 400) {
    return roundTo(scaled / 10, 2);
  }
  return scaled;
}

function normalizeZigbeeCurrentAmps(value, multiplier = 1, divisor = 1) {
  const scaled = normalizeZigbeeScaledNumber(value, multiplier, divisor, 3);
  if (scaled === undefined) {
    return undefined;
  }
  if (Math.abs(scaled) > 100) {
    return roundTo(scaled / 1000, 3);
  }
  return scaled;
}

function normalizeZigbeeTemperatureC(value, scale = 'auto') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  if (scale === 'centi' || Math.abs(numeric) > 200) {
    return roundTo(numeric / 100, 1);
  }
  return roundTo(numeric, 1);
}

function normalizeZigbeeHumidityPercent(value, scale = 'auto') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  const percent = scale === 'centi' || numeric > 100 ? numeric / 100 : numeric;
  return clampPercent(percent);
}

function normalizeZigbeeIlluminanceLux(value, scale = 'auto') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  if (scale === 'zcl') {
    if (numeric <= 0) {
      return 0;
    }
    return roundTo(10 ** ((numeric - 1) / 10000), 1);
  }
  return Math.max(0, roundTo(numeric, 1));
}

function normalizeZigbeeColorTemperatureKelvin(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  if (numeric >= 1000) {
    return Math.round(numeric);
  }
  return miredToKelvin(numeric);
}

function readZigbeeStateObjectValue(zigbeeDevice, keys = []) {
  const stateObjects = [
    zigbeeDevice?.state,
    zigbeeDevice?.meta?.state,
    zigbeeDevice?.properties?.state,
    zigbeeDevice?.latestState
  ].filter((entry) => entry && typeof entry === 'object');

  for (const stateObject of stateObjects) {
    for (const key of keys) {
      const value = stateObject[key];
      if (value !== undefined && value !== null) {
        return value;
      }
    }
  }

  return undefined;
}

function assignDefined(target, key, value) {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
}

function assignDefinedIfMissing(target, key, value) {
  if (!Object.prototype.hasOwnProperty.call(target, key)) {
    assignDefined(target, key, value);
  }
}

function readZigbeeMessageData(message) {
  return message?.data && typeof message.data === 'object' && !Array.isArray(message.data)
    ? message.data
    : {};
}

function hasDirectFeature(features, feature) {
  const expected = normalizeFeature(feature).toLowerCase();
  return (Array.isArray(features) ? features : [])
    .map((entry) => normalizeFeature(entry).toLowerCase())
    .includes(expected);
}

function applyZoneStatusToDirectState(directState, zoneStatus, features = []) {
  const numeric = Number(zoneStatus);
  if (!Number.isFinite(numeric)) {
    return;
  }

  const alarmActive = Boolean(numeric & 0x0001 || numeric & 0x0002);
  assignDefined(directState, 'tamper', Boolean(numeric & 0x0004));
  assignDefined(directState, 'tamperActive', Boolean(numeric & 0x0004));
  assignDefined(directState, 'batteryLow', Boolean(numeric & 0x0008));

  if (hasDirectFeature(features, 'water')) {
    assignDefined(directState, 'waterDetected', alarmActive);
    return;
  }
  if (hasDirectFeature(features, 'motion')) {
    assignDefined(directState, 'motionActive', alarmActive);
    assignDefined(directState, 'motion', alarmActive ? 'active' : 'inactive');
    return;
  }
  if (hasDirectFeature(features, 'vibration') || hasDirectFeature(features, 'acceleration')) {
    assignDefined(directState, 'vibrationActive', alarmActive);
    assignDefined(directState, 'vibration', alarmActive ? 'active' : 'inactive');
    assignDefined(directState, 'accelerationActive', alarmActive);
    assignDefined(directState, 'acceleration', alarmActive ? 'active' : 'inactive');
    return;
  }

  assignDefined(directState, 'contactOpen', alarmActive);
  assignDefined(directState, 'contact', alarmActive ? 'open' : 'closed');
}

function extractZigbeeMessageState(message, features = []) {
  const directState = {};
  const data = readZigbeeMessageData(message);
  const cluster = normalizeZigbeeClusterToken(message?.cluster ?? message?.clusterID ?? message?.clusterId);

  if (cluster === 'ssiaszone') {
    applyZoneStatusToDirectState(directState, data.zoneStatus ?? data.zonestatus, features);
  }

  if (cluster === 'genpowercfg') {
    const batteryLevel = normalizeZigbeeBatteryPercent(
      data.batteryPercentageRemaining ?? data.batterypercentageremaining ?? data.battery ?? data.batteryLevel,
      data.batteryPercentageRemaining !== undefined || data.batterypercentageremaining !== undefined
        ? 'batteryPercentageRemaining'
        : 'battery'
    );
    assignDefined(directState, 'batteryLevel', batteryLevel);
    assignDefined(directState, 'batteryVoltage', normalizeZigbeeBatteryVoltage(data.batteryVoltage ?? data.batteryvoltage));
    const low = normalizeZigbeeActiveState(data.batteryLow ?? data.battery_low);
    assignDefined(directState, 'batteryLow', low);
  }

  if (cluster === 'mstemperaturemeasurement') {
    const temperatureC = normalizeZigbeeTemperatureC(data.measuredValue ?? data.measuredvalue ?? data.temperature, 'centi');
    assignDefined(directState, 'temperatureC', temperatureC);
    assignDefined(directState, 'temperatureF', celsiusToFahrenheit(temperatureC));
  }

  if (cluster === 'msrelativehumidity') {
    assignDefined(directState, 'humidity', normalizeZigbeeHumidityPercent(data.measuredValue ?? data.measuredvalue ?? data.humidity, 'centi'));
  }

  if (cluster === 'msilluminancemeasurement') {
    assignDefined(directState, 'illuminance', normalizeZigbeeIlluminanceLux(data.measuredValue ?? data.measuredvalue ?? data.illuminance, 'zcl'));
  }

  if (cluster === 'lightingcolorctrl') {
    const colorTemperatureK = normalizeZigbeeColorTemperatureKelvin(
      data.colorTemperature ?? data.colorTemperatureMireds ?? data.colorTemp ?? data.colortemp ?? data.color_temp
    );
    assignDefined(directState, 'colorTemperatureK', colorTemperatureK);
    assignDefined(directState, 'colorTemperatureMired', colorTemperatureK ? kelvinToMired(colorTemperatureK) : undefined);
  }

  if (cluster === 'haelectricalmeasurement') {
    const powerMultiplier = data.acPowerMultiplier ?? data.acpowermultiplier ?? data.powerMultiplier ?? data.multiplier;
    const powerDivisor = data.acPowerDivisor ?? data.acpowerdivisor ?? data.powerDivisor ?? data.divisor;
    const voltageMultiplier = data.acVoltageMultiplier ?? data.acvoltagemultiplier ?? data.voltageMultiplier ?? data.multiplier;
    const voltageDivisor = data.acVoltageDivisor ?? data.acvoltagedivisor ?? data.voltageDivisor ?? data.divisor;
    const currentMultiplier = data.acCurrentMultiplier ?? data.accurrentmultiplier ?? data.currentMultiplier ?? data.multiplier;
    const currentDivisor = data.acCurrentDivisor ?? data.accurrentdivisor ?? data.currentDivisor ?? data.divisor;

    assignDefined(directState, 'powerW', normalizeZigbeePowerWatts(
      data.activePower ?? data.activepower ?? data.power,
      powerMultiplier,
      powerDivisor
    ));
    assignDefined(directState, 'voltageV', normalizeZigbeeVoltageVolts(
      data.rmsVoltage ?? data.rmsvoltage ?? data.voltage,
      voltageMultiplier,
      voltageDivisor
    ));
    assignDefined(directState, 'currentA', normalizeZigbeeCurrentAmps(
      data.rmsCurrent ?? data.rmscurrent ?? data.current,
      currentMultiplier,
      currentDivisor
    ));
  }

  if (cluster === 'semetering') {
    assignDefined(directState, 'energyKwh', normalizeZigbeeEnergyKwh(
      data.currentSummDelivered ?? data.currentsummdelivered ?? data.energy,
      data.multiplier,
      data.divisor
    ));
  }

  if (cluster === 'genonoff') {
    assignDefined(directState, 'switch', normalizeZigbeeSwitchState(data.onOff ?? data.onoff ?? data.state));
  }

  if (cluster === 'genlevelctrl') {
    assignDefined(directState, 'brightness', normalizeZigbeePercent(data.currentLevel ?? data.current_level ?? data.level, 'level'));
  }

  return directState;
}

function mergeDirectState(target, source) {
  Object.entries(source || {}).forEach(([key, value]) => {
    assignDefined(target, key, value);
  });
  return target;
}

function readZigbeeStateObject(zigbeeDevice, directState) {
  const contactOpen = normalizeZigbeeContactOpen(readZigbeeStateObjectValue(zigbeeDevice, ['contact', 'door', 'window']));
  assignDefinedIfMissing(directState, 'contactOpen', contactOpen);
  if (contactOpen !== undefined && directState.contact === undefined) {
    directState.contact = contactOpen ? 'open' : 'closed';
  }

  const motionActive = normalizeZigbeeActiveState(readZigbeeStateObjectValue(zigbeeDevice, ['motion', 'occupancy', 'presence']));
  assignDefinedIfMissing(directState, 'motionActive', motionActive);
  if (motionActive !== undefined && directState.motion === undefined) {
    directState.motion = motionActive ? 'active' : 'inactive';
  }

  const vibrationActive = normalizeZigbeeActiveState(readZigbeeStateObjectValue(zigbeeDevice, ['vibration', 'vibration_detected']));
  assignDefinedIfMissing(directState, 'vibrationActive', vibrationActive);
  if (vibrationActive !== undefined && directState.vibration === undefined) {
    directState.vibration = vibrationActive ? 'active' : 'inactive';
  }

  const accelerationActive = normalizeZigbeeActiveState(readZigbeeStateObjectValue(zigbeeDevice, ['acceleration', 'acceleration_x']));
  assignDefinedIfMissing(directState, 'accelerationActive', accelerationActive);
  if (accelerationActive !== undefined && directState.acceleration === undefined) {
    directState.acceleration = accelerationActive ? 'active' : 'inactive';
  }

  const tamperActive = normalizeZigbeeActiveState(readZigbeeStateObjectValue(zigbeeDevice, ['tamper', 'tamper_alarm']));
  assignDefinedIfMissing(directState, 'tamper', tamperActive);
  assignDefinedIfMissing(directState, 'tamperActive', tamperActive);

  const waterDetected = normalizeZigbeeActiveState(readZigbeeStateObjectValue(zigbeeDevice, ['water_leak', 'water', 'leak']));
  assignDefinedIfMissing(directState, 'waterDetected', waterDetected);

  const batteryLevel = normalizeZigbeeBatteryPercent(
    readZigbeeStateObjectValue(zigbeeDevice, ['battery', 'batteryLevel', 'battery_level']),
    'battery'
  );
  assignDefinedIfMissing(directState, 'batteryLevel', batteryLevel);
  assignDefinedIfMissing(directState, 'batteryVoltage', normalizeZigbeeBatteryVoltage(
    readZigbeeStateObjectValue(zigbeeDevice, ['batteryVoltage', 'battery_voltage'])
  ));
  assignDefinedIfMissing(directState, 'batteryVoltage', normalizeZigbeeBatteryVoltageFromState(
    readZigbeeStateObjectValue(zigbeeDevice, ['voltage'])
  ));
  assignDefinedIfMissing(directState, 'batteryLow', normalizeZigbeeActiveState(readZigbeeStateObjectValue(zigbeeDevice, ['battery_low', 'batteryLow'])));

  const temperatureC = normalizeZigbeeTemperatureC(readZigbeeStateObjectValue(zigbeeDevice, ['temperature']), 'auto');
  assignDefinedIfMissing(directState, 'temperatureC', temperatureC);
  assignDefinedIfMissing(directState, 'temperatureF', celsiusToFahrenheit(temperatureC));
  assignDefinedIfMissing(directState, 'humidity', normalizeZigbeeHumidityPercent(readZigbeeStateObjectValue(zigbeeDevice, ['humidity']), 'auto'));
  assignDefinedIfMissing(directState, 'illuminance', normalizeZigbeeIlluminanceLux(readZigbeeStateObjectValue(zigbeeDevice, ['illuminance', 'illuminance_lux']), 'auto'));

  const colorTemperatureK = normalizeZigbeeColorTemperatureKelvin(
    readZigbeeStateObjectValue(zigbeeDevice, ['color_temp', 'colorTemperature', 'color_temperature', 'colortemp'])
  );
  assignDefinedIfMissing(directState, 'colorTemperatureK', colorTemperatureK);
  assignDefinedIfMissing(directState, 'colorTemperatureMired', colorTemperatureK ? kelvinToMired(colorTemperatureK) : undefined);
  assignDefinedIfMissing(directState, 'powerW', normalizeZigbeePowerWatts(
    readZigbeeStateObjectValue(zigbeeDevice, ['power_w', 'powerW', 'activePower', 'active_power', 'power'])
  ));
  assignDefinedIfMissing(directState, 'energyKwh', normalizeZigbeeEnergyKwh(
    readZigbeeStateObjectValue(zigbeeDevice, ['energy_kwh', 'energyKwh', 'energy', 'currentSummDelivered', 'current_summ_delivered'])
  ));
  assignDefinedIfMissing(directState, 'voltageV', normalizeZigbeeVoltageVolts(
    readZigbeeStateObjectValue(zigbeeDevice, ['voltage_v', 'voltageV', 'rmsVoltage', 'rms_voltage', 'mainsVoltage', 'mains_voltage', 'voltage'])
  ));
  assignDefinedIfMissing(directState, 'currentA', normalizeZigbeeCurrentAmps(
    readZigbeeStateObjectValue(zigbeeDevice, ['current_a', 'currentA', 'rmsCurrent', 'rms_current', 'current'])
  ));
}

function readZigbeeEndpointSensorAttributes(zigbeeDevice, directState, features = []) {
  for (const endpoint of getZigbeeEndpoints(zigbeeDevice)) {
    if (directState.contactOpen === undefined && directState.motionActive === undefined && directState.waterDetected === undefined) {
      applyZoneStatusToDirectState(
        directState,
        readZigbeeEndpointAttribute(endpoint, ['ssIasZone', 'ssiaszone', 1280], ['zoneStatus', 'zonestatus']),
        features
      );
    }

    if (directState.batteryLevel === undefined) {
      assignDefined(directState, 'batteryLevel', normalizeZigbeeBatteryPercent(
        readZigbeeEndpointAttribute(endpoint, ['genPowerCfg', 'genpowercfg', 1], ['batteryPercentageRemaining', 'batterypercentageremaining']),
        'batteryPercentageRemaining'
      ));
    }
    if (directState.batteryVoltage === undefined) {
      assignDefined(directState, 'batteryVoltage', normalizeZigbeeBatteryVoltage(
        readZigbeeEndpointAttribute(endpoint, ['genPowerCfg', 'genpowercfg', 1], ['batteryVoltage', 'batteryvoltage'])
      ));
    }

    if (directState.temperatureC === undefined) {
      const temperatureC = normalizeZigbeeTemperatureC(
        readZigbeeEndpointAttribute(endpoint, ['msTemperatureMeasurement', 'mstemperaturemeasurement', 1026], ['measuredValue', 'measuredvalue']),
        'centi'
      );
      assignDefined(directState, 'temperatureC', temperatureC);
      assignDefined(directState, 'temperatureF', celsiusToFahrenheit(temperatureC));
    }

    if (directState.humidity === undefined) {
      assignDefined(directState, 'humidity', normalizeZigbeeHumidityPercent(
        readZigbeeEndpointAttribute(endpoint, ['msRelativeHumidity', 'msrelativehumidity', 1029], ['measuredValue', 'measuredvalue']),
        'centi'
      ));
    }

    if (directState.illuminance === undefined) {
      assignDefined(directState, 'illuminance', normalizeZigbeeIlluminanceLux(
        readZigbeeEndpointAttribute(endpoint, ['msIlluminanceMeasurement', 'msilluminancemeasurement', 1024], ['measuredValue', 'measuredvalue']),
        'zcl'
      ));
    }

    if (directState.colorTemperatureK === undefined) {
      const colorTemperatureK = normalizeZigbeeColorTemperatureKelvin(readZigbeeEndpointAttribute(
        endpoint,
        ['lightingColorCtrl', 'lightingcolorctrl', 768],
        ['colorTemperature', 'colorTemperatureMireds', 'colorTemp', 'colortemp', 'color_temp']
      ));
      assignDefined(directState, 'colorTemperatureK', colorTemperatureK);
      assignDefined(directState, 'colorTemperatureMired', colorTemperatureK ? kelvinToMired(colorTemperatureK) : undefined);
    }

    const electricalClusters = ['haElectricalMeasurement', 'haelectricalmeasurement', 2820];
    if (directState.powerW === undefined) {
      assignDefined(directState, 'powerW', normalizeZigbeePowerWatts(
        readZigbeeEndpointAttribute(endpoint, electricalClusters, ['activePower', 'activepower', 'power']),
        readZigbeeEndpointAttribute(endpoint, electricalClusters, ['acPowerMultiplier', 'acpowermultiplier', 'powerMultiplier', 'multiplier']),
        readZigbeeEndpointAttribute(endpoint, electricalClusters, ['acPowerDivisor', 'acpowerdivisor', 'powerDivisor', 'divisor'])
      ));
    }
    if (directState.voltageV === undefined) {
      assignDefined(directState, 'voltageV', normalizeZigbeeVoltageVolts(
        readZigbeeEndpointAttribute(endpoint, electricalClusters, ['rmsVoltage', 'rmsvoltage', 'voltage']),
        readZigbeeEndpointAttribute(endpoint, electricalClusters, ['acVoltageMultiplier', 'acvoltagemultiplier', 'voltageMultiplier', 'multiplier']),
        readZigbeeEndpointAttribute(endpoint, electricalClusters, ['acVoltageDivisor', 'acvoltagedivisor', 'voltageDivisor', 'divisor'])
      ));
    }
    if (directState.currentA === undefined) {
      assignDefined(directState, 'currentA', normalizeZigbeeCurrentAmps(
        readZigbeeEndpointAttribute(endpoint, electricalClusters, ['rmsCurrent', 'rmscurrent', 'current']),
        readZigbeeEndpointAttribute(endpoint, electricalClusters, ['acCurrentMultiplier', 'accurrentmultiplier', 'currentMultiplier', 'multiplier']),
        readZigbeeEndpointAttribute(endpoint, electricalClusters, ['acCurrentDivisor', 'accurrentdivisor', 'currentDivisor', 'divisor'])
      ));
    }

    if (directState.energyKwh === undefined) {
      const meteringClusters = ['seMetering', 'semetering', 1794];
      assignDefined(directState, 'energyKwh', normalizeZigbeeEnergyKwh(
        readZigbeeEndpointAttribute(endpoint, meteringClusters, ['currentSummDelivered', 'currentsummdelivered', 'energy']),
        readZigbeeEndpointAttribute(endpoint, meteringClusters, ['multiplier']),
        readZigbeeEndpointAttribute(endpoint, meteringClusters, ['divisor'])
      ));
    }
  }
}

function directStateToTopLevel(directState = {}) {
  const topLevel = {};
  if (Object.prototype.hasOwnProperty.call(directState, 'contactOpen')) {
    topLevel.status = Boolean(directState.contactOpen);
  } else if (Object.prototype.hasOwnProperty.call(directState, 'motionActive')) {
    topLevel.status = Boolean(directState.motionActive);
  } else if (Object.prototype.hasOwnProperty.call(directState, 'vibrationActive')) {
    topLevel.status = Boolean(directState.vibrationActive);
  } else if (Object.prototype.hasOwnProperty.call(directState, 'accelerationActive')) {
    topLevel.status = Boolean(directState.accelerationActive);
  } else if (Object.prototype.hasOwnProperty.call(directState, 'waterDetected')) {
    topLevel.status = Boolean(directState.waterDetected);
  } else if (Object.prototype.hasOwnProperty.call(directState, 'tamperActive')) {
    topLevel.status = Boolean(directState.tamperActive);
  }

  assignDefined(topLevel, 'temperature', directState.temperatureF);
  assignDefined(topLevel, 'colorTemperature', directState.colorTemperatureK);
  return topLevel;
}

function inferFeaturesFromDirectRadioState(directState = {}) {
  const features = [];
  if (directState.contactOpen !== undefined || directState.contact !== undefined) features.push('contact');
  if (directState.motionActive !== undefined || directState.motion !== undefined) features.push('motion');
  if (directState.vibrationActive !== undefined || directState.vibration !== undefined) features.push('vibration');
  if (directState.accelerationActive !== undefined || directState.acceleration !== undefined) features.push('acceleration');
  if (directState.tamper !== undefined || directState.tamperActive !== undefined) features.push('tamper');
  if (directState.batteryLevel !== undefined || directState.batteryLow !== undefined || directState.batteryVoltage !== undefined) features.push('battery');
  if (directState.temperatureC !== undefined || directState.temperatureF !== undefined) features.push('temperature');
  if (directState.humidity !== undefined) features.push('humidity');
  if (directState.illuminance !== undefined) features.push('illuminance');
  if (directState.waterDetected !== undefined) features.push('water');
  if (directState.colorTemperatureK !== undefined) features.push('colorTemperature');
  if (directState.powerW !== undefined) features.push('power');
  if (directState.energyKwh !== undefined) features.push('energy');
  if (directState.voltageV !== undefined) features.push('voltage');
  if (directState.currentA !== undefined) features.push('current');
  return uniqueStrings(features.map(normalizeFeature)).sort();
}

function readZigbeeDirectRadioState(zigbeeDevice, options = {}) {
  const directState = {};
  mergeDirectState(directState, extractZigbeeMessageState(options.message, options.features));
  readZigbeeStateObject(zigbeeDevice, directState);
  readZigbeeEndpointSensorAttributes(zigbeeDevice, directState, options.features);
  fillBatteryPercentFromVoltage(directState);
  return directState;
}

function readZigbeeRuntimeState(zigbeeDevice, options = {}) {
  const endpoints = getZigbeeEndpoints(zigbeeDevice);
  let status = normalizeZigbeeSwitchState(readZigbeeStateObjectValue(zigbeeDevice, [
    'state',
    'switch',
    'power',
    'onOff',
    'on_off',
    'on'
  ]));

  if (status === undefined) {
    for (const endpoint of endpoints) {
      status = normalizeZigbeeSwitchState(readZigbeeEndpointAttribute(
        endpoint,
        ['genOnOff', 'genonoff', 6],
        ['onOff', 'onoff', 'state']
      ));
      if (status !== undefined) {
        break;
      }
    }
  }

  let brightness = normalizeZigbeePercent(readZigbeeStateObjectValue(zigbeeDevice, [
    'brightness',
    'level'
  ]));
  if (brightness === undefined) {
    for (const endpoint of endpoints) {
      brightness = normalizeZigbeePercent(readZigbeeEndpointAttribute(
        endpoint,
        ['genLevelCtrl', 'genlevelctrl', 8],
        ['currentLevel', 'current_level']
      ), 'level');
      if (brightness !== undefined) {
        break;
      }
    }
  }

  const directState = readZigbeeDirectRadioState(zigbeeDevice, options);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(brightness !== undefined ? { brightness } : {}),
    ...directStateToTopLevel(directState),
    ...(Object.keys(directState).length > 0 ? { directRadioState: directState } : {})
  };
}

function scoreDetachedSmartThingsMigrationSource(directDevice, sourceDevice, protocol) {
  if (!directDevice || !sourceDevice || isRetiredSmartThingsMigrationSource(sourceDevice)) {
    return -Infinity;
  }
  const sourceProperties = getDeviceProperties(sourceDevice);
  if (!smartThingsNetworkTypeMatchesProtocol(sourceProperties, protocol)) {
    return -Infinity;
  }

  let score = 0;
  if (normalizeSourceText(sourceProperties.source) === 'smartthings') {
    score += 15;
  }
  if (normalizeSourceText(directDevice.room) && normalizeSourceText(directDevice.room) === normalizeSourceText(sourceDevice.room)) {
    score += 30;
  }
  if (normalizeSourceText(directDevice.type) && normalizeSourceText(directDevice.type) === normalizeSourceText(sourceDevice.type)) {
    score += 20;
  }

  const directTokens = normalizeMigrationNameTokens(
    directDevice.name,
    directDevice.brand,
    directDevice.model,
    directDevice.properties?.homebrainDirect?.manufacturerName,
    directDevice.properties?.homebrainDirect?.modelID,
    directDevice.properties?.homebrainDirect?.generatedName
  );
  const sourceTokens = normalizeMigrationNameTokens(
    sourceDevice.name,
    sourceDevice.brand,
    sourceDevice.model,
    sourceProperties.smartThingsLabel,
    sourceProperties.smartThingsDeviceName,
    sourceProperties.smartThingsManufacturer,
    sourceProperties.smartThingsDeviceTypeName
  );
  score += Math.round(scoreTokenOverlap(directTokens, sourceTokens) * 35);

  const directFeatures = new Set([
    ...(Array.isArray(directDevice.properties?.directRadioFeatures) ? directDevice.properties.directRadioFeatures : []),
    ...inferFeaturesFromExistingDirectRecord(directDevice)
  ].map(normalizeFeature).filter(Boolean));
  const sourceFeatures = new Set(inferFeaturesFromSmartThings(sourceDevice).map(normalizeFeature).filter(Boolean));
  let featureOverlap = 0;
  directFeatures.forEach((feature) => {
    if (sourceFeatures.has(feature)) {
      featureOverlap += 1;
    }
  });
  score += Math.min(30, featureOverlap * 10);

  const directManufacturer = normalizeSourceText(directDevice.brand || directDevice.properties?.homebrainDirect?.manufacturerName);
  const sourceManufacturer = normalizeSourceText(sourceProperties.smartThingsManufacturer || sourceDevice.brand);
  if (directManufacturer && sourceManufacturer && (
    directManufacturer === sourceManufacturer
    || directManufacturer.includes(sourceManufacturer)
    || sourceManufacturer.includes(directManufacturer)
  )) {
    score += 15;
  }

  return score;
}

function buildRecoveredSmartThingsMigrationSnapshot({
  directDevice,
  sourceDevice,
  protocol,
  migrationId,
  validation
} = {}) {
  const directProperties = getDeviceProperties(directDevice);
  const sourceProperties = getDeviceProperties(sourceDevice);
  const sourceDeviceId = getDeviceIdString(sourceDevice);
  const directDeviceId = getDeviceIdString(directDevice);
  const features = uniqueStrings([
    ...(Array.isArray(directProperties.directRadioFeatures) ? directProperties.directRadioFeatures : []),
    ...inferFeaturesFromExistingDirectRecord(directDevice),
    ...inferFeaturesFromSmartThings(sourceDevice)
  ].map(normalizeFeature)).sort();
  const recoveredAt = new Date().toISOString();
  const baseSnapshot = mergeSmartThingsTelemetryFallback({
    name: directDevice.name,
    type: directDevice.type,
    room: directDevice.room,
    groups: directDevice.groups,
    status: directDevice.status,
    brightness: directDevice.brightness,
    color: directDevice.color,
    colorTemperature: directDevice.colorTemperature,
    temperature: directDevice.temperature,
    targetTemperature: directDevice.targetTemperature,
    isOnline: directDevice.isOnline !== false,
    lastSeen: directDevice.lastSeen || new Date(),
    brand: directDevice.brand,
    model: directDevice.model,
    properties: {
      ...copySmartThingsHistoryProperties(sourceProperties),
      ...directProperties,
      source: protocolSource(protocol),
      directRadioFeatures: features,
      directRadioCapabilities: buildNormalizedCapabilities(features, protocol),
      ...buildDirectFeatureProperties(features)
    }
  }, sourceDevice);

  baseSnapshot.properties.smartThingsMigration = {
    ...(getSmartThingsMigration(directDevice) || {}),
    migratedAt: getSmartThingsMigration(directDevice)?.migratedAt || recoveredAt,
    recoveredAt,
    previousSource: sourceProperties.source || 'smartthings',
    smartThingsDeviceId: sourceProperties.smartThingsDeviceId || null,
    sourceDeviceId,
    sourceDeviceName: sourceDevice.name || null,
    sourceRoom: sourceDevice.room || null,
    directDeviceId,
    migrationId: trimString(migrationId)
      || getSmartThingsMigration(directDevice)?.migrationId
      || `recovered-${sourceDeviceId}-${directDeviceId}`,
    validation
  };

  return baseSnapshot;
}

function extractZigbeeOnOffReadResponse(response) {
  if (!response || typeof response !== 'object') {
    return undefined;
  }

  const candidate = response.onOff
    ?? response.onoff
    ?? response.state
    ?? response.switch
    ?? response.power;
  return normalizeZigbeeSwitchState(candidate);
}

function extractZigbeeBrightnessReadResponse(response) {
  if (!response || typeof response !== 'object') {
    return undefined;
  }

  return normalizeZigbeePercent(response.currentLevel ?? response.current_level ?? response.level, 'level');
}

function extractZigbeeColorTemperatureReadResponse(response) {
  if (!response || typeof response !== 'object') {
    return undefined;
  }

  return normalizeZigbeeColorTemperatureKelvin(
    response.colorTemperature
    ?? response.colorTemperatureMireds
    ?? response.colorTemp
    ?? response.colortemp
    ?? response.color_temp
  );
}

function normalizeZigbeeClusterToken(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'number') {
    const clusterNames = {
      1: 'genpowercfg',
      6: 'genonoff',
      8: 'genlevelctrl',
      257: 'closuresdoorlock',
      768: 'lightingcolorctrl',
      1024: 'msilluminancemeasurement',
      1026: 'mstemperaturemeasurement',
      1029: 'msrelativehumidity',
      1280: 'ssiaszone',
      1794: 'semetering',
      2820: 'haelectricalmeasurement'
    };
    return clusterNames[value] || String(value);
  }

  return String(value).trim().toLowerCase().replace(/[\s_-]/g, '');
}

function collectZigbeeClusterTokens(zigbeeDevice) {
  const endpoints = getZigbeeEndpoints(zigbeeDevice);
  const tokens = new Set();

  endpoints.forEach((endpoint) => {
    collectZigbeeEndpointClusterTokens(endpoint).forEach((token) => tokens.add(token));
  });

  return tokens;
}

function extractZigbeeDefinition(converters, zigbeeDevice) {
  try {
    const definition = converters?.findByDevice?.(zigbeeDevice) || null;
    return definition && typeof definition.then === 'function' ? null : definition;
  } catch (_error) {
    return null;
  }
}

function inferFeaturesFromZigbeeDefinition(definition, zigbeeDevice) {
  const features = new Set();
  const exposes = Array.isArray(definition?.exposes) ? definition.exposes : [];
  const clusters = collectZigbeeClusterTokens(zigbeeDevice);
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
      [/\bvibration\b|\baccelerat/, 'vibration'],
      [/\baccelerat/, 'acceleration'],
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
  if (clusters.has('genonoff')) features.add('switch');
  if (clusters.has('genlevelctrl')) features.add('brightness');
  if (clusters.has('lightingcolorctrl')) {
    features.add('color');
    features.add('colorTemperature');
  }
  if (clusters.has('haelectricalmeasurement')) features.add('power');
  if (clusters.has('semetering')) features.add('energy');
  if (clusters.has('genpowercfg')) features.add('battery');
  if (clusters.has('closuresdoorlock')) features.add('lock');
  if (clusters.has('msilluminancemeasurement')) features.add('illuminance');
  if (clusters.has('mstemperaturemeasurement')) features.add('temperature');
  if (clusters.has('msrelativehumidity')) features.add('humidity');
  if (clusters.has('ssiaszone')) features.add('contact');
  if (/\b(?:plug|outlet|socket|relay|switch)\b/.test(deviceText) || /\bsp\s*224\b/.test(deviceText)) {
    features.add('switch');
  }
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

function normalizeNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeInteger(value) {
  const numeric = normalizeNumber(value);
  return numeric === null ? null : Math.round(numeric);
}

function normalizeCatalogVolumeOptions(options = []) {
  return (Array.isArray(options) ? options : [])
    .map((option) => {
      const value = normalizeInteger(option?.value);
      const label = trimString(option?.label || option?.name || option?.value);
      if (value === null || !label) {
        return null;
      }
      return { label, value };
    })
    .filter(Boolean);
}

const normalizeCatalogSoundOptions = normalizeCatalogVolumeOptions;

function isSirenVolumeParameter(parameter) {
  if (!parameter || typeof parameter !== 'object') {
    return false;
  }
  if (parameter.readOnly === true || parameter.writeOnly === true || parameter.hidden === true) {
    return false;
  }
  const parameterNumber = normalizeInteger(parameter.parameter);
  if (parameterNumber === null) {
    return false;
  }
  const label = [
    parameter.label,
    parameter.name,
    parameter.purpose,
    parameter.description
  ].map((entry) => trimString(entry).toLowerCase()).filter(Boolean).join(' ');
  return /\bvolume\b/.test(label);
}

function isSirenSoundParameter(parameter) {
  if (!parameter || typeof parameter !== 'object') {
    return false;
  }
  if (parameter.readOnly === true || parameter.writeOnly === true || parameter.hidden === true) {
    return false;
  }
  const parameterNumber = normalizeInteger(parameter.parameter);
  if (parameterNumber === null) {
    return false;
  }
  const label = [
    parameter.label,
    parameter.name,
    parameter.purpose,
    parameter.description
  ].map((entry) => trimString(entry).toLowerCase()).filter(Boolean).join(' ');
  if (/\bvolume\b/.test(label)) {
    return false;
  }
  return /\b(?:sound|tone)\b/.test(label);
}

function getSirenVolumeConfigParameterFromCatalog(catalog) {
  const parameters = Array.isArray(catalog?.configParameters)
    ? catalog.configParameters
    : [];
  const candidates = parameters.filter(isSirenVolumeParameter);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.slice().sort((left, right) => {
    const leftLabel = trimString(left.label).toLowerCase();
    const rightLabel = trimString(right.label).toLowerCase();
    if (leftLabel === 'volume' && rightLabel !== 'volume') return -1;
    if (rightLabel === 'volume' && leftLabel !== 'volume') return 1;
    return normalizeInteger(left.parameter) - normalizeInteger(right.parameter);
  })[0];
}

function getSirenSoundConfigParameterFromCatalog(catalog) {
  const parameters = Array.isArray(catalog?.configParameters)
    ? catalog.configParameters
    : [];
  const candidates = parameters.filter(isSirenSoundParameter);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.slice().sort((left, right) => {
    const leftLabel = trimString(left.label).toLowerCase();
    const rightLabel = trimString(right.label).toLowerCase();
    const leftExact = /\b(?:default\s+)?siren\s+sound\b/.test(leftLabel);
    const rightExact = /\b(?:default\s+)?siren\s+sound\b/.test(rightLabel);
    if (leftExact && !rightExact) return -1;
    if (rightExact && !leftExact) return 1;
    return normalizeInteger(left.parameter) - normalizeInteger(right.parameter);
  })[0];
}

function getSirenVolumeOptionsFromParameter(parameter) {
  const explicitOptions = normalizeCatalogVolumeOptions(parameter?.options);
  if (explicitOptions.length > 0) {
    return explicitOptions;
  }

  const min = normalizeInteger(parameter?.minValue);
  const max = normalizeInteger(parameter?.maxValue);
  if (min === null || max === null || max < min || max - min > 8) {
    return [];
  }

  return Array.from({ length: max - min + 1 }, (_entry, index) => {
    const value = min + index;
    return { label: String(value), value };
  });
}

function getSirenSoundOptionsFromParameter(parameter) {
  const explicitOptions = normalizeCatalogSoundOptions(parameter?.options);
  if (explicitOptions.length > 0) {
    return explicitOptions;
  }

  const min = normalizeInteger(parameter?.minValue);
  const max = normalizeInteger(parameter?.maxValue);
  if (min === null || max === null || max < min || max - min > 32) {
    return [];
  }

  return Array.from({ length: max - min + 1 }, (_entry, index) => {
    const value = min + index;
    return { label: String(value), value };
  });
}

function getSirenVolumeRangeFromParameter(parameter) {
  const options = getSirenVolumeOptionsFromParameter(parameter);
  const optionValues = options.map((option) => option.value);
  const min = normalizeInteger(parameter?.minValue) ?? (optionValues.length > 0 ? Math.min(...optionValues) : null);
  const max = normalizeInteger(parameter?.maxValue) ?? (optionValues.length > 0 ? Math.max(...optionValues) : null);
  return { min, max, options };
}

function getSirenSoundRangeFromParameter(parameter) {
  const options = getSirenSoundOptionsFromParameter(parameter);
  const optionValues = options.map((option) => option.value);
  const min = normalizeInteger(parameter?.minValue) ?? (optionValues.length > 0 ? Math.min(...optionValues) : null);
  const max = normalizeInteger(parameter?.maxValue) ?? (optionValues.length > 0 ? Math.max(...optionValues) : null);
  return { min, max, options };
}

function resolveSirenVolumeValue(rawValue, parameter = null) {
  const { min, max, options } = getSirenVolumeRangeFromParameter(parameter);
  let nextValue = normalizeInteger(rawValue);
  if (nextValue === null && typeof rawValue === 'string') {
    const normalizedLabel = rawValue.trim().toLowerCase();
    const matched = options.find((option) => option.label.toLowerCase() === normalizedLabel);
    if (matched) {
      nextValue = matched.value;
    }
  }

  if (nextValue === null) {
    throw new Error('Siren volume must be a number');
  }

  if (min !== null && nextValue < min) {
    throw new Error(`Siren volume must be at least ${min}`);
  }
  if (max !== null && nextValue > max) {
    throw new Error(`Siren volume must be at most ${max}`);
  }

  const allowedValues = new Set(options.map((option) => option.value));
  const allowManualEntry = parameter?.allowManualEntry !== false;
  if (allowedValues.size > 0 && !allowedValues.has(nextValue) && !allowManualEntry) {
    throw new Error('Siren volume must match one of the supported options');
  }

  return nextValue;
}

function resolveSirenSoundValue(rawValue, parameter = null) {
  const { min, max, options } = getSirenSoundRangeFromParameter(parameter);
  let nextValue = normalizeInteger(rawValue);
  if (nextValue === null && typeof rawValue === 'string') {
    const normalizedLabel = rawValue.trim().toLowerCase();
    const matched = options.find((option) => option.label.toLowerCase() === normalizedLabel);
    if (matched) {
      nextValue = matched.value;
    }
  }

  if (nextValue === null) {
    throw new Error('Siren sound must be a number');
  }

  if (min !== null && nextValue < min) {
    throw new Error(`Siren sound must be at least ${min}`);
  }
  if (max !== null && nextValue > max) {
    throw new Error(`Siren sound must be at most ${max}`);
  }

  const allowedValues = new Set(options.map((option) => option.value));
  const allowManualEntry = parameter?.allowManualEntry !== false;
  if (allowedValues.size > 0 && !allowedValues.has(nextValue) && !allowManualEntry) {
    throw new Error('Siren sound must match one of the supported options');
  }

  return nextValue;
}

function buildSirenVolumeProperties(parameter, value) {
  if (!parameter) {
    return {};
  }
  const options = getSirenVolumeOptionsFromParameter(parameter);
  const properties = {
    supportsSirenVolume: true
  };
  const numericValue = normalizeInteger(value);
  if (numericValue !== null) {
    properties.sirenVolume = numericValue;
  }
  if (options.length > 0) {
    properties.sirenVolumeOptions = options;
  }
  return properties;
}

function buildSirenSoundProperties(parameter, value) {
  if (!parameter) {
    return {};
  }
  const options = getSirenSoundOptionsFromParameter(parameter);
  const properties = {
    supportsSirenSound: true
  };
  const numericValue = normalizeInteger(value);
  if (numericValue !== null) {
    properties.sirenSound = numericValue;
  }
  if (options.length > 0) {
    properties.sirenSoundOptions = options;
  }
  return properties;
}

function hasZWaveValue(node, valueDef) {
  try {
    return node?.valueDB?.hasValue?.(valueDef?.id || valueDef) === true;
  } catch (_error) {
    return false;
  }
}

function normalizeLockCodeSlot(value) {
  const slot = Number(value);
  return Number.isInteger(slot) && slot > 0 ? slot : null;
}

function normalizeLockCodeName(value, fallback) {
  return trimString(value).slice(0, 80) || fallback;
}

function normalizeLockPin(value, limits = {}) {
  const pin = trimString(value);
  const minLength = Number.isFinite(Number(limits.minPinLength)) ? Number(limits.minPinLength) : 4;
  const maxLength = Number.isFinite(Number(limits.maxPinLength)) ? Number(limits.maxPinLength) : 10;
  if (!/^\d+$/.test(pin) || pin.length < minLength || pin.length > maxLength) {
    throw new Error(`PIN must be ${minLength}-${maxLength} digits.`);
  }
  return pin;
}

function enumLabel(enumObject, value, fallback = 'unknown') {
  if (value === undefined || value === null) {
    return fallback;
  }
  return enumObject?.[value] || enumObject?.[String(value)] || String(value);
}

function operationSucceeded(result, okEnum) {
  if (result === undefined) {
    return true;
  }
  if (typeof result === 'number') {
    return result === okEnum;
  }
  if (result?.status !== undefined) {
    return Number(result.status) >= 254;
  }
  return result === okEnum;
}

function getLockCodeAssignments(device) {
  const assignments = device?.properties?.lockCodes?.assignments;
  return assignments && typeof assignments === 'object' && !Array.isArray(assignments)
    ? assignments
    : {};
}

function getAssignmentForSlot(device, slot) {
  const assignments = getLockCodeAssignments(device);
  const entry = assignments[String(slot)];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
}

function getZWaveAccessControl(node) {
  const candidates = [
    node,
    (() => {
      try {
        return node?.getEndpoint?.(0);
      } catch (_error) {
        return null;
      }
    })(),
    (() => {
      try {
        return node?.getEndpoint?.(1);
      } catch (_error) {
        return null;
      }
    })()
  ];

  for (const candidate of candidates) {
    if (candidate?.accessControl) {
      return candidate.accessControl;
    }
  }

  return null;
}

function getZWaveLockCodeCapabilities(node, accessControl) {
  const zwave = require('zwave-js');
  const userCapabilities = accessControl?.getUserCapabilitiesCached?.() || {};
  const credentialCapabilities = accessControl?.getCredentialCapabilitiesCached?.() || {};
  const pinCapabilities = credentialCapabilities?.supportedCredentialTypes?.get?.(zwave.UserCredentialType.PINCode)
    || credentialCapabilities?.supportedCredentialTypes?.values?.().next?.()?.value
    || {};
  const maxSlots = Number(userCapabilities.maxUsers || pinCapabilities.numberOfCredentialSlots || 0);
  const minPinLength = Number(pinCapabilities.minCredentialLength || 4);
  const maxPinLength = Number(pinCapabilities.maxCredentialLength || 10);

  return {
    supported: Boolean(accessControl),
    maxSlots: Number.isFinite(maxSlots) && maxSlots > 0 ? maxSlots : 0,
    minPinLength: Number.isFinite(minPinLength) && minPinLength > 0 ? minPinLength : 4,
    maxPinLength: Number.isFinite(maxPinLength) && maxPinLength > 0 ? maxPinLength : 10,
    supportsNames: Number(userCapabilities.maxUserNameLength || 0) > 0,
    maxNameLength: Number(userCapabilities.maxUserNameLength || 0) || null,
    supportsAdminCode: credentialCapabilities.supportsAdminCode === true,
    supportsAdminCodeDeactivation: credentialCapabilities.supportsAdminCodeDeactivation === true,
    supportsLockAudit: Boolean(node?.commandClasses?.['Door Lock Logging']?.getRecord)
  };
}

function codeNameForSlot(device, slot, userData = {}) {
  const assignment = getAssignmentForSlot(device, slot);
  return normalizeLockCodeName(assignment.name || userData.userName, `Code ${slot}`);
}

function lockEventActionFromLabel(label) {
  const normalized = trimString(label).toLowerCase();
  if (!normalized) {
    return 'unknown';
  }
  if (normalized.includes('illegal') || normalized.includes('invalid')) {
    return 'invalid_code';
  }
  if (normalized.includes('code') && normalized.includes('delete')) {
    return 'code_deleted';
  }
  if (normalized.includes('code') && (normalized.includes('add') || normalized.includes('change'))) {
    return 'code_changed';
  }
  if (normalized.includes('unlock')) {
    return 'unlock';
  }
  if (normalized.includes('lock')) {
    return 'lock';
  }
  return 'unknown';
}

function extractLockUserId(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = trimString(key).toLowerCase();
    const numeric = Number(entry);
    if (
      Number.isInteger(numeric)
      && numeric > 0
      && (
        normalizedKey === 'userid'
        || normalizedKey === 'user id'
        || normalizedKey === 'user'
        || (normalizedKey.includes('user') && normalizedKey.includes('id'))
      )
    ) {
      return numeric;
    }
  }

  return null;
}

function serializeLockCodeSlot(device, userData = {}) {
  const slot = normalizeLockCodeSlot(userData.userId);
  if (!slot) {
    return null;
  }
  const assignment = getAssignmentForSlot(device, slot);
  return {
    slot,
    name: codeNameForSlot(device, slot, userData),
    enabled: userData.active !== false,
    occupied: true,
    userType: enumLabel(require('zwave-js').UserCredentialUserType, userData.userType, 'General'),
    source: assignment.source || 'lock',
    updatedAt: assignment.updatedAt || null,
    updatedBy: assignment.updatedBy || null
  };
}

function serializeDoorLockLogRecord(device, record, index) {
  if (!record || typeof record !== 'object') {
    return null;
  }
  const zwave = require('zwave-js');
  const userId = normalizeLockCodeSlot(record.userId);
  const eventType = enumLabel(zwave.DoorLockLoggingEventType, record.eventType, 'Unknown');
  const label = trimString(record.label) || eventType;
  return {
    id: `lock-record-${index}-${record.timestamp || Date.now()}`,
    source: 'lock',
    type: 'door_lock_log',
    action: lockEventActionFromLabel(label || eventType),
    label,
    slot: userId,
    codeName: userId ? codeNameForSlot(device, userId) : null,
    createdAt: record.timestamp || null
  };
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
      pendingDskRequest: null,
      addNodeStatusEnum: null,
      removeNodeStatusEnum: null
    };
    this.activeMigrations = new Map();
    this.activePairings = new Map();
    this.directDeviceUpsertLocks = new Map();
    this.pairingTimers = {
      zigbee: null,
      zwave: null
    };
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

  buildDirectDeviceUpsertLockKey(identity = {}) {
    const protocol = trimString(identity.protocol).toLowerCase();
    const id = trimString(identity.id);
    return protocol && id ? `${protocol}:${id}` : '';
  }

  async withDirectDeviceUpsertLock(identity, action) {
    const lockKey = this.buildDirectDeviceUpsertLockKey(identity);
    if (!lockKey || typeof action !== 'function') {
      return action?.();
    }

    const previous = this.directDeviceUpsertLocks.get(lockKey) || Promise.resolve();
    let releaseCurrent = null;
    const current = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = previous.catch(() => {}).then(() => current);
    this.directDeviceUpsertLocks.set(lockKey, queued);

    await previous.catch(() => {});
    try {
      return await action();
    } finally {
      releaseCurrent?.();
      if (this.directDeviceUpsertLocks.get(lockKey) === queued) {
        this.directDeviceUpsertLocks.delete(lockKey);
      }
    }
  }

  clearPairingTimer(protocol) {
    const timer = this.pairingTimers?.[protocol];
    if (timer) {
      clearTimeout(timer);
      this.pairingTimers[protocol] = null;
    }
  }

  getZWaveInclusionStateLabel(zwave = null) {
    const controller = this.getZWaveController();
    const state = controller?.inclusionState;
    if (state === undefined || state === null) {
      return null;
    }

    let zwaveModule = zwave;
    if (!zwaveModule) {
      try {
        zwaveModule = require('zwave-js');
      } catch (_error) {
        zwaveModule = null;
      }
    }
    return enumMemberName(zwaveModule?.InclusionState, state);
  }

  async closeZWavePairingWindow(options = {}) {
    const controller = this.getZWaveController();
    this.clearPairingTimer('zwave');
    this.zwave.inclusionUntil = null;
    this.zwave.exclusionUntil = null;
    this.zwave.pendingDsk = null;
    this.resolvePendingZWaveDsk(false);

    const beforeState = this.getZWaveInclusionStateLabel(options.zwave);
    const result = {
      beforeState,
      afterState: beforeState,
      stoppedInclusion: false,
      stoppedExclusion: false,
      inclusionStopError: null,
      exclusionStopError: null
    };

    if (controller) {
      if (typeof controller.stopInclusion === 'function') {
        try {
          result.stoppedInclusion = await controller.stopInclusion();
        } catch (error) {
          result.inclusionStopError = error.message;
          this.log('warn', 'zwave', 'Failed to stop existing Z-Wave inclusion window', {
            error: error.message,
            reason: options.reason || null,
            beforeState
          });
        }
      }

      if (typeof controller.stopExclusion === 'function') {
        try {
          result.stoppedExclusion = await controller.stopExclusion();
        } catch (error) {
          result.exclusionStopError = error.message;
          this.log('warn', 'zwave', 'Failed to stop existing Z-Wave exclusion window', {
            error: error.message,
            reason: options.reason || null,
            beforeState
          });
        }
      }
      result.afterState = this.getZWaveInclusionStateLabel(options.zwave);
    }

    const session = options.markSession === false ? null : this.activePairings.get('zwave');
    if (session && !isTerminalPairingStatus(session.status)) {
      session.status = 'stopped';
      session.stoppedAt = new Date().toISOString();
      session.message = options.sessionMessage || 'Previous Z-Wave pairing was stopped before starting a new request.';
      this.appendPairingEvent('zwave', {
        kind: 'stopped',
        message: session.message,
        details: {
          reason: options.reason || null,
          beforeState: result.beforeState,
          afterState: result.afterState,
          stoppedInclusion: result.stoppedInclusion,
          stoppedExclusion: result.stoppedExclusion
        }
      });
    }

    if (result.stoppedInclusion || result.stoppedExclusion || beforeState === 'Including' || beforeState === 'Excluding') {
      this.log('info', 'zwave', 'Closed existing Z-Wave inclusion/exclusion window', {
        reason: options.reason || null,
        ...result
      });
    }

    return result;
  }

  getPairingBaseline(protocol) {
    if (protocol === 'zigbee') {
      const devices = this.zigbee.controller?.getDevices?.() || [];
      return devices
        .filter((device) => device?.type !== 'Coordinator')
        .map((device) => trimString(device?.ieeeAddr))
        .filter(Boolean);
    }

    if (protocol === 'zwave') {
      const nodes = this.getZWaveController()?.nodes;
      if (!nodes || typeof nodes.values !== 'function') {
        return [];
      }
      return Array.from(nodes.values())
        .filter((node) => node && !node.isControllerNode)
        .map((node) => String(node.id || '').trim())
        .filter(Boolean);
    }

    return [];
  }

  createPairingSession(protocol, seconds, options = {}) {
    const now = Date.now();
    const session = {
      id: `pairing-${protocol}-${now}-${crypto.randomBytes(4).toString('hex')}`,
      protocol,
      mode: protocol === 'zigbee' ? 'permit_join' : 'inclusion',
      status: 'opening',
      startedAt: new Date(now).toISOString(),
      expiresAt: now + seconds * 1000,
      baselineIdentities: this.getPairingBaseline(protocol),
      detectedIdentity: null,
      directDeviceId: null,
      directDeviceName: null,
      pendingDsk: null,
      message: options.message || null,
      events: []
    };
    this.activePairings.set(protocol, session);
    return session;
  }

  appendPairingEvent(protocol, event = {}) {
    const session = this.activePairings.get(protocol);
    if (!session) {
      return null;
    }
    const timestamp = event.timestamp || new Date().toISOString();
    session.events = [
      ...(Array.isArray(session.events) ? session.events : []).slice(-19),
      {
        ...event,
        timestamp
      }
    ];
    session.updatedAt = timestamp;
    return session;
  }

  markPairingFailed(protocol, message, details = {}) {
    const session = this.activePairings.get(protocol);
    if (!session || isTerminalPairingStatus(session.status)) {
      return session || null;
    }
    const timestamp = new Date().toISOString();
    session.status = 'failed';
    session.failedAt = timestamp;
    session.message = message || `${protocol} pairing failed.`;
    this.appendPairingEvent(protocol, {
      kind: 'failed',
      message: session.message,
      details,
      timestamp
    });
    return session;
  }

  markPairingActive(protocol, message) {
    const session = this.activePairings.get(protocol);
    if (!session || isTerminalPairingStatus(session.status)) {
      return session || null;
    }
    session.status = 'active';
    if (message) {
      session.message = message;
    }
    session.updatedAt = new Date().toISOString();
    return session;
  }

  markPairingDetected(protocol, identity, device, reason) {
    const session = this.activePairings.get(protocol);
    if (!session || isTerminalPairingStatus(session.status)) {
      return session || null;
    }

    const identityId = trimString(identity?.id);
    if (!identityId) {
      return session;
    }

    const timestamp = new Date().toISOString();
    session.status = protocol === 'zwave' ? 'interviewing' : 'active';
    session.detectedIdentity = identity || null;
    session.directDeviceId = device?._id?.toString?.() || session.directDeviceId || null;
    session.directDeviceName = device?.name || session.directDeviceName || null;
    session.message = protocol === 'zwave'
      ? `Z-Wave node ${identityId} was detected. HomeBrain is waiting for the interview to finish before saving it as a usable device.`
      : session.message;
    this.appendPairingEvent(protocol, {
      kind: 'detected',
      reason,
      identity: identity || null,
      directDeviceId: session.directDeviceId,
      directDeviceName: session.directDeviceName,
      timestamp
    });
    return session;
  }

  completePairingSession(protocol, identity, device, reason) {
    const session = this.activePairings.get(protocol);
    if (!session || isTerminalPairingStatus(session.status)) {
      return session || null;
    }

    const identityId = trimString(identity?.id);
    const strongReason = protocol === 'zwave'
      ? isZWaveDirectUpdateInterviewComplete(device, reason)
      : ['deviceJoined', 'deviceInterview'].includes(reason);
    const isNewIdentity = identityId && !session.baselineIdentities.includes(identityId);
    if (protocol === 'zwave' && !strongReason) {
      if (isNewIdentity) {
        return this.markPairingDetected(protocol, identity, device, reason);
      }
      return session;
    }
    if (!strongReason && !isNewIdentity) {
      return session;
    }

    const timestamp = new Date().toISOString();
    session.status = 'completed';
    session.completedAt = timestamp;
    session.detectedIdentity = identity || null;
    session.directDeviceId = device?._id?.toString?.() || null;
    session.directDeviceName = device?.name || null;
    session.message = device?.name
      ? `${device.name} joined HomeBrain.`
      : `${protocol === 'zwave' ? 'Z-Wave' : 'Zigbee'} device joined HomeBrain.`;
    this.appendPairingEvent(protocol, {
      kind: 'completed',
      reason,
      identity: identity || null,
      directDeviceId: session.directDeviceId,
      directDeviceName: session.directDeviceName,
      timestamp
    });
    this.clearPairingTimer(protocol);
    void this.stopPairing(protocol).catch((error) => {
      console.warn(`DirectRadioService: Failed to close ${protocol} pairing after completion: ${error.message}`);
    });
    return session;
  }

  async reconcileActiveZWavePairingFromController() {
    const session = this.activePairings.get('zwave');
    if (!session || ['completed', 'failed', 'expired', 'stopped'].includes(session.status)) {
      return null;
    }
    if (Device.db?.readyState !== 1) {
      return null;
    }

    const nodes = this.getZWaveController()?.nodes;
    if (!nodes || typeof nodes.values !== 'function') {
      return null;
    }

    for (const node of nodes.values()) {
      if (!node || node.isControllerNode) {
        continue;
      }
      const identityId = String(node.id || '').trim();
      if (!identityId || session.baselineIdentities.includes(identityId)) {
        continue;
      }
      this.log('info', 'zwave', 'Z-Wave pairing detected a new controller node before interview completion', {
        nodeId: node.id || null,
        pairingId: session.id,
        securityMode: session.zwaveSecurityMode || null
      });
      this.attachZWaveNodeStatusListeners(node);
      return this.handleZWaveNodeChanged(node, node.ready === true ? 'node ready' : 'node added');
    }

    return null;
  }

  armPairingTimer(protocol, sessionId, seconds) {
    this.clearPairingTimer(protocol);
    const timer = setTimeout(() => {
      const session = this.activePairings.get(protocol);
      if (session?.id === sessionId && !['completed', 'failed', 'stopped'].includes(session.status)) {
        session.status = 'expired';
        session.expiredAt = new Date().toISOString();
        session.message = `${protocol === 'zwave' ? 'Z-Wave inclusion' : 'Zigbee pairing'} window expired before HomeBrain detected a completed device.`;
        this.appendPairingEvent(protocol, {
          kind: 'expired',
          message: session.message
        });
      }
      void this.stopPairing(protocol).catch((error) => {
        console.warn(`DirectRadioService: Failed to auto-stop ${protocol} pairing: ${error.message}`);
      });
    }, seconds * 1000);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.pairingTimers[protocol] = timer;
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
          type: payload?.type || null,
          dataKeys: payload?.data && typeof payload.data === 'object' ? Object.keys(payload.data).slice(0, 12) : []
        });
        void this.handleZigbeeDeviceChanged(payload?.device, 'message', { message: payload });
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

      driver.on('driver ready', () => {
        this.zwave.started = true;
        this.zwave.error = null;
        this.attachZWaveMigrationRequestHandlers(driver, zwave);
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
        this.attachZWaveNodeStatusListeners(node);
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
        this.attachZWaveNodeStatusListeners(node);
        void this.handleZWaveNodeChanged(node, 'node ready');
      });
      driver.on('node value updated', (node) => {
        this.log('info', 'zwave', 'Z-Wave node value updated', {
          nodeId: node?.id || null
        });
        this.attachZWaveNodeStatusListeners(node);
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
          this.zwave.pendingDsk = null;
          this.log('info', 'zwave', 'Z-Wave S2 DSK PIN supplied from configuration', {
            dsk
          });
          return configuredPin;
        }
        this.log('warn', 'zwave', 'Z-Wave S2 DSK PIN required', {
          dsk
        });
        this.markZWaveDskRequired(dsk);
        console.warn(`DirectRadioService: Z-Wave S2 DSK PIN required for ${dsk}`);
        const submittedPin = await this.waitForZWaveDskPin(dsk);
        if (/^\d{5}$/.test(submittedPin)) {
          this.zwave.pendingDsk = null;
          this.log('info', 'zwave', 'Z-Wave S2 DSK PIN submitted for active inclusion', {
            dsk
          });
          return submittedPin;
        }
        this.markPairingFailed('zwave', 'Z-Wave S2 pairing timed out waiting for the 5 digit DSK PIN.', {
          dsk
        });
        return false;
      },
      abort: () => {
        this.zwave.pendingDsk = null;
        this.resolvePendingZWaveDsk(false);
        this.markPairingFailed('zwave', 'Z-Wave inclusion was aborted before security completed.');
        this.log('warn', 'zwave', 'Z-Wave inclusion user callback aborted');
      }
    };
  }

  buildZWaveInclusionOptions(zwave, securityMode) {
    const mode = normalizeZWaveSecurityMode(securityMode, 'insecure');
    switch (mode) {
      case 's2':
        return {
          mode,
          options: { strategy: zwave.InclusionStrategy.Security_S2 }
        };
      case 's0':
        return {
          mode,
          options: { strategy: zwave.InclusionStrategy.Security_S0 }
        };
      case 'default':
        return {
          mode,
          options: { strategy: zwave.InclusionStrategy.Default }
        };
      case 'insecure':
      default:
        return {
          mode: 'insecure',
          options: { strategy: zwave.InclusionStrategy.Insecure }
        };
    }
  }

  markZWaveDskRequired(dsk) {
    const session = this.activePairings.get('zwave');
    if (!session || isTerminalPairingStatus(session.status)) {
      return null;
    }
    session.status = 'awaiting_dsk';
    session.pendingDsk = dsk;
    session.message = 'Z-Wave S2 security requires the first 5 digits from the device DSK label or QR code. If you do not have that label, stop this attempt, exclude/reset the partial node, and retry with Standard/no PIN inclusion.';
    this.appendPairingEvent('zwave', {
      kind: 'dsk_required',
      dsk,
      message: session.message
    });
    return session;
  }

  waitForZWaveDskPin(dsk) {
    this.resolvePendingZWaveDsk(false);
    const session = this.activePairings.get('zwave');
    const expiresAt = Number(session?.expiresAt || 0);
    const timeoutMs = Math.max(10_000, Math.min(120_000, expiresAt > Date.now() ? expiresAt - Date.now() : 90_000));

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.resolvePendingZWaveDsk(false);
      }, timeoutMs);
      if (typeof timeout.unref === 'function') {
        timeout.unref();
      }
      this.zwave.pendingDskRequest = {
        dsk,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
        timeout,
        resolve
      };
    });
  }

  resolvePendingZWaveDsk(value) {
    const pending = this.zwave.pendingDskRequest;
    if (!pending) {
      return false;
    }
    this.zwave.pendingDskRequest = null;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    pending.resolve(value);
    return true;
  }

  submitZWaveDskPin(pin) {
    const safePin = trimString(pin);
    if (!/^\d{5}$/.test(safePin)) {
      const error = new Error('Enter the 5 digit DSK PIN printed on the Z-Wave device label or QR code.');
      error.status = 400;
      throw error;
    }

    const hadPendingRequest = this.resolvePendingZWaveDsk(safePin);
    this.zwave.s2DskPin = safePin;
    this.zwave.pendingDsk = null;
    this.markPairingActive('zwave', hadPendingRequest
      ? 'Z-Wave S2 PIN submitted. Keep the switch powered while HomeBrain finishes the interview.'
      : 'Z-Wave S2 PIN saved for the active inclusion attempt.');
    this.appendPairingEvent('zwave', {
      kind: 'dsk_pin_submitted',
      pendingRequest: hadPendingRequest
    });

    return {
      accepted: true,
      pendingRequest: hadPendingRequest,
      pairing: this.serializePairingSession(this.activePairings.get('zwave'))
    };
  }

  async refreshZWaveNodeInfo(nodeId, options = {}) {
    await this.start();
    const { node } = this.getZWaveNode(nodeId);
    if (typeof node.refreshInfo !== 'function') {
      const error = new Error('This Z-Wave node does not support a HomeBrain re-interview request');
      error.status = 501;
      throw error;
    }

    this.attachZWaveNodeStatusListeners(node);
    const numericNodeId = Number(node.id);
    const waitForWakeup = parseOptionalBoolean(options.waitForWakeup, false);
    const resetSecurityClasses = parseOptionalBoolean(options.resetSecurityClasses, false);
    const pingFirst = parseOptionalBoolean(options.pingFirst, true);
    const before = this.serializeZWaveNodeSummary(node);
    let ping = null;
    let pingError = null;

    if (pingFirst && typeof node.ping === 'function') {
      try {
        ping = await node.ping(true);
      } catch (error) {
        ping = false;
        pingError = error.message;
      }
    }

    this.log('info', 'zwave', 'Z-Wave node re-interview requested', {
      nodeId: numericNodeId,
      waitForWakeup,
      resetSecurityClasses,
      ping,
      pingError
    });

    await node.refreshInfo({
      resetSecurityClasses,
      waitForWakeup
    });

    await this.handleZWaveNodeChanged(node, 'refresh-info requested').catch((error) => {
      this.log('warn', 'zwave', 'Failed to save Z-Wave node after re-interview request', {
        nodeId: numericNodeId,
        error: error.message
      });
    });

    return {
      node: this.serializeZWaveNodeSummary(node),
      before,
      ping,
      pingError,
      waitForWakeup,
      resetSecurityClasses,
      message: `HomeBrain requested a fresh Z-Wave interview for node ${numericNodeId}.`
    };
  }

  async removeFailedZWaveNode(nodeId, options = {}) {
    await this.start();
    const { controller, node } = this.getZWaveNode(nodeId);
    const numericNodeId = Number(node.id);
    const confirm = parseOptionalBoolean(options.confirm, false);
    const force = parseOptionalBoolean(options.force, false);
    if (!confirm) {
      const error = new Error('Confirm failed-node removal before deleting a Z-Wave node from HomeBrain');
      error.status = 400;
      throw error;
    }
    if (typeof controller.removeFailedNode !== 'function') {
      const error = new Error('This Z-Wave controller does not support failed-node removal');
      error.status = 501;
      throw error;
    }

    let failed = null;
    if (typeof controller.isFailedNode === 'function') {
      try {
        failed = await controller.isFailedNode(numericNodeId);
      } catch (error) {
        this.log('warn', 'zwave', 'Unable to verify Z-Wave failed-node status before removal', {
          nodeId: numericNodeId,
          error: error.message
        });
      }
    }

    if (failed === false && !force) {
      const error = new Error(`Z-Wave node ${numericNodeId} is still responding. Re-interview it first, or force removal only after confirming it is a ghost node.`);
      error.status = 409;
      error.failed = false;
      throw error;
    }

    await controller.removeFailedNode(numericNodeId);
    if (typeof controller.nodes?.delete === 'function') {
      try {
        controller.nodes.delete(numericNodeId);
      } catch (error) {
        this.log('warn', 'zwave', 'Unable to evict removed Z-Wave node from the live node cache', {
          nodeId: numericNodeId,
          error: error.message
        });
      }
    }
    const query = {
      'properties.homebrainDirect.protocol': 'zwave',
      'properties.homebrainDirect.nodeId': {
        $in: [numericNodeId, String(numericNodeId)]
      }
    };
    const matchingDevices = await Device.find(query).select('_id name').lean();
    let deletedDeviceCount = 0;
    const deletionCleanups = [];
    const deletionErrors = [];
    if (matchingDevices.length > 0) {
      const deviceService = require('./deviceService');
      for (const device of matchingDevices) {
        try {
          const deletedDevice = await deviceService.deleteDevice(device._id);
          deletedDeviceCount += 1;
          if (deletedDevice?.deletionCleanup) {
            deletionCleanups.push({
              deviceId: String(device._id),
              name: device.name || deletedDevice.name || null,
              cleanup: deletedDevice.deletionCleanup
            });
          }
        } catch (error) {
          const deletionError = {
            deviceId: String(device._id),
            name: device.name || null,
            message: error?.message || String(error || 'Unknown device deletion error')
          };
          deletionErrors.push(deletionError);
          this.log('warn', 'zwave', 'Z-Wave failed node removed, but matching HomeBrain device cleanup failed', {
            nodeId: numericNodeId,
            ...deletionError
          });
        }
      }
    }

    this.log('warn', 'zwave', 'Z-Wave failed node removed from HomeBrain', {
      nodeId: numericNodeId,
      failed,
      force,
      deletedDeviceCount,
      deletionCleanups,
      deletionErrors
    });

    return {
      nodeId: numericNodeId,
      failed,
      force,
      deletedDeviceCount,
      deletionCleanups,
      deletionErrors,
      message: `Z-Wave node ${numericNodeId} was removed from the controller.`
    };
  }

  serializePairingSession(session) {
    if (!session) {
      return null;
    }
    const expiresAt = Number(session.expiresAt || 0);
    return {
      id: session.id,
      protocol: session.protocol,
      mode: session.mode,
      status: session.status,
      zwaveSecurityMode: session.zwaveSecurityMode || null,
      startedAt: session.startedAt || null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      secondsRemaining: expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : 0,
      pendingDsk: session.pendingDsk || null,
      detectedIdentity: session.detectedIdentity || null,
      directDeviceId: session.directDeviceId || null,
      directDeviceName: session.directDeviceName || null,
      message: session.message || null,
      completedAt: session.completedAt || null,
      failedAt: session.failedAt || null,
      expiredAt: session.expiredAt || null,
      events: Array.isArray(session.events) ? session.events.slice(-8) : []
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
    controller.on('inclusion started', (strategy) => {
      this.log('info', 'zwave', 'Z-Wave controller inclusion started', {
        strategy: strategy === undefined ? null : String(strategy),
        state: this.getZWaveInclusionStateLabel()
      });
    });
    controller.on('exclusion started', () => {
      this.log('info', 'zwave', 'Z-Wave controller exclusion started', {
        state: this.getZWaveInclusionStateLabel()
      });
    });
    controller.on('inclusion stopped', () => {
      this.log('info', 'zwave', 'Z-Wave controller inclusion stopped', {
        state: this.getZWaveInclusionStateLabel()
      });
    });
    controller.on('exclusion stopped', () => {
      this.log('info', 'zwave', 'Z-Wave controller exclusion stopped', {
        state: this.getZWaveInclusionStateLabel()
      });
    });
    controller.on('inclusion state changed', (state) => {
      this.log('info', 'zwave', 'Z-Wave controller inclusion state changed', {
        state: enumMemberName(require('zwave-js').InclusionState, state)
      });
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

  getZWaveNode(nodeId, options = {}) {
    const numericNodeId = getNumericNodeId(nodeId);
    if (!Number.isInteger(numericNodeId) || numericNodeId <= 0) {
      const error = new Error('Z-Wave node id is invalid');
      error.status = 400;
      throw error;
    }

    const controller = this.getZWaveController();
    if (!controller?.nodes || typeof controller.nodes.get !== 'function') {
      const error = new Error('Z-Wave controller nodes are not available yet');
      error.status = 503;
      throw error;
    }

    const node = controller.nodes.get(numericNodeId);
    if (!node) {
      const error = new Error(`Z-Wave node ${numericNodeId} is not present on the controller`);
      error.status = 404;
      throw error;
    }
    if (node.isControllerNode && options.allowController !== true) {
      const error = new Error('The Z-Wave controller node cannot be repaired as a device');
      error.status = 400;
      throw error;
    }

    return {
      controller,
      node,
      nodeId: numericNodeId
    };
  }

  getZWaveNodeFeatures(node) {
    try {
      return this.normalizeZWaveNode(node, 'status')?.update?.properties?.directRadioFeatures || [];
    } catch (_error) {
      return [];
    }
  }

  serializeZWaveNodeSummary(node) {
    if (!node) {
      return null;
    }
    const nodeId = getNumericNodeId(node);
    const features = this.getZWaveNodeFeatures(node);
    const manufacturer = trimString(node.deviceConfig?.manufacturer || node.manufacturer);
    const productLabel = trimString(node.deviceConfig?.label || node.productLabel);
    const interviewStage = node.interviewStage === undefined || node.interviewStage === null
      ? null
      : String(node.interviewStage);

    return {
      id: nodeId,
      name: trimString(node.name) || productLabel || (nodeId ? `Z-Wave Node ${nodeId}` : 'Z-Wave Node'),
      isControllerNode: node.isControllerNode === true,
      ready: node.ready === true,
      status: node.status === undefined ? null : node.status,
      isOnline: isZWaveNodeOnline(node),
      interviewStage,
      isListening: node.isListening === undefined ? null : node.isListening,
      isFrequentListening: node.isFrequentListening === undefined ? null : node.isFrequentListening,
      manufacturerId: node.manufacturerId || null,
      productType: node.productType || null,
      productId: node.productId || null,
      manufacturer: manufacturer || null,
      productLabel: productLabel || null,
      features,
      incomplete: node.isControllerNode !== true && (
        node.ready !== true
        || features.length === 0
        || (!node.manufacturerId && !node.productType && !node.productId && !manufacturer && !productLabel)
      )
    };
  }

  getZWaveNodeSummaries() {
    const nodes = this.getZWaveController()?.nodes;
    if (!nodes || typeof nodes.values !== 'function') {
      return [];
    }

    return Array.from(nodes.values())
      .map((node) => this.serializeZWaveNodeSummary(node))
      .filter(Boolean)
      .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
  }

  async findDeviceForZWaveNode(node) {
    const nodeId = normalizeLockCodeSlot(node?.id);
    if (!nodeId || Device.db?.readyState !== 1) {
      return null;
    }

    return Device.findOne({
      $or: [
        { 'properties.homebrainDirect.nodeId': nodeId },
        { 'properties.homebrainDirect.nodeId': String(nodeId) }
      ]
    });
  }

  async publishZWaveLockCodeEvent(node, event = {}) {
    const device = await this.findDeviceForZWaveNode(node);
    if (!device || device.type !== 'lock') {
      return null;
    }

    const slot = normalizeLockCodeSlot(event.slot || event.userId);
    const payload = {
      deviceId: device._id?.toString?.() || String(device._id || ''),
      deviceName: device.name || null,
      nodeId: normalizeLockCodeSlot(node?.id),
      slot,
      codeName: slot ? codeNameForSlot(device, slot) : null,
      action: event.action || 'unknown',
      label: event.label || null,
      source: event.source || 'zwave',
      actor: event.actor || null,
      notification: event.notification || null
    };

    return eventStreamService.publishSafe({
      type: event.type || 'lock_code.used',
      source: 'homebrain-zwave',
      category: 'security',
      severity: event.severity || 'info',
      payload,
      tags: ['lock', 'pin', 'zwave', `device:${payload.deviceId}`]
    });
  }

  handleZWaveLockNotification(node, endpoint, ccId, args = {}) {
    const label = trimString(args.eventLabel || args.label);
    const eventText = `${label} ${trimString(args.label)}`.toLowerCase();
    if (!/\b(lock|unlock|code|keypad|access)\b/.test(eventText)) {
      return;
    }

    const userId = extractLockUserId(args.parameters);
    void this.publishZWaveLockCodeEvent(node, {
      type: userId ? 'lock_code.used' : 'lock.state_event',
      action: lockEventActionFromLabel(label),
      userId,
      label,
      notification: {
        endpoint: endpoint?.index ?? null,
        commandClass: ccId ?? null,
        type: args.type ?? null,
        event: args.event ?? null,
        parameters: args.parameters || null
      }
    }).catch((error) => {
      this.log('warn', 'zwave', 'Failed to record Z-Wave lock notification', {
        nodeId: node?.id || null,
        error: error.message
      });
    });
  }

  handleZWaveLockUserChanged(node, eventType, args = {}) {
    const slot = normalizeLockCodeSlot(args.userId || args.credentialSlot);
    if (!slot) {
      return;
    }

    const type = eventType === 'deleted'
      ? 'lock_code.deleted'
      : eventType === 'added'
        ? 'lock_code.added'
        : 'lock_code.modified';
    void this.publishZWaveLockCodeEvent(node, {
      type,
      action: `code_${eventType}`,
      userId: slot,
      label: `Lock code ${eventType}`
    }).catch((error) => {
      this.log('warn', 'zwave', 'Failed to record Z-Wave lock code change event', {
        nodeId: node?.id || null,
        slot,
        error: error.message
      });
    });
  }

  attachZWaveNodeStatusListeners(node) {
    if (!node || node.__homebrainStatusListenersAttached || typeof node.on !== 'function') {
      return;
    }

    const updateFromNode = (reason) => {
      if (node.isControllerNode) {
        return;
      }
      this.log('info', 'zwave', `Z-Wave node ${reason}`, {
        nodeId: node.id || null,
        interviewStage: node.interviewStage === undefined ? null : String(node.interviewStage),
        ready: node.ready === undefined ? null : Boolean(node.ready)
      });
      void this.handleZWaveNodeChanged(node, reason).catch((error) => {
        this.log('warn', 'zwave', 'Failed to update Z-Wave node after status event', {
          nodeId: node.id || null,
          reason,
          error: error.message
        });
      });
    };

    node.on('interview completed', () => updateFromNode('interview completed'));
    node.on('interview failed', () => updateFromNode('interview failed'));
    node.on('ready', () => updateFromNode('ready'));
    node.on('node info received', () => updateFromNode('node info received'));
    node.on('notification', (...args) => this.handleZWaveLockNotification(node, ...args));
    node.on('user added', (_endpoint, args) => this.handleZWaveLockUserChanged(node, 'added', args));
    node.on('user modified', (_endpoint, args) => this.handleZWaveLockUserChanged(node, 'modified', args));
    node.on('user deleted', (_endpoint, args) => this.handleZWaveLockUserChanged(node, 'deleted', args));
    node.__homebrainStatusListenersAttached = true;
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
      this.attachZWaveNodeStatusListeners(node);
      // eslint-disable-next-line no-await-in-loop
      await this.handleZWaveNodeChanged(node, 'sync');
    }
  }

  normalizeZigbeeDevice(zigbeeDevice, reason = 'sync', options = {}) {
    if (!zigbeeDevice) {
      return null;
    }

    const catalogMatchInput = {
      modelID: zigbeeDevice.modelID,
      manufacturerName: zigbeeDevice.manufacturerName
    };
    let definition = null;
    let catalogEntry = directRadioProtocolCatalogService.findZigbeeCatalogEntry(catalogMatchInput);
    if (!catalogEntry) {
      definition = extractZigbeeDefinition(this.zigbee.converters, zigbeeDevice);
      catalogEntry = directRadioProtocolCatalogService.findZigbeeCatalogEntry({
        ...catalogMatchInput,
        definition
      });
    }
    const baseFeatures = uniqueStrings([
      ...inferFeaturesFromZigbeeDefinition(definition, zigbeeDevice),
      ...(Array.isArray(catalogEntry?.homebrainFeatures) ? catalogEntry.homebrainFeatures : [])
    ].map(normalizeFeature)).sort();
    const directId = trimString(zigbeeDevice.ieeeAddr);
    if (!directId) {
      return null;
    }

    const name = trimString(catalogEntry?.description || definition?.description)
      || trimString(zigbeeDevice.modelID)
      || trimString(zigbeeDevice.manufacturerName)
      || `Zigbee ${directId.slice(-6)}`;
    const status = zigbeeDevice.interviewCompleted !== false;

    const runtimeState = readZigbeeRuntimeState(zigbeeDevice, {
      features: baseFeatures,
      message: options.message
    });
    const { directRadioState, ...runtimeUpdate } = runtimeState;
    const features = uniqueStrings([
      ...baseFeatures,
      ...inferFeaturesFromDirectRadioState(directRadioState)
    ].map(normalizeFeature)).sort();

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
          model: catalogEntry?.model || definition?.model || zigbeeDevice.modelID,
          vendor: catalogEntry?.vendor || definition?.vendor,
          description: catalogEntry?.description || definition?.description,
          manufacturerName: zigbeeDevice.manufacturerName
        }),
        room: 'Unassigned',
        ...runtimeUpdate,
        isOnline: status,
        lastSeen: new Date(),
        brand: trimString(catalogEntry?.vendor || definition?.vendor || zigbeeDevice.manufacturerName) || undefined,
        model: trimString(catalogEntry?.model || definition?.model || zigbeeDevice.modelID) || undefined,
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
            lastSeen: new Date().toISOString(),
            catalog: directRadioProtocolCatalogService.buildCatalogReference(catalogEntry)
          },
          ...(directRadioState ? { directRadioState } : {}),
          ...(directRadioState?.batteryLevel !== undefined ? { homeBrainBatteryLevel: directRadioState.batteryLevel, batteryLevel: directRadioState.batteryLevel } : {}),
          directRadioFeatures: features,
          directRadioCapabilities: buildNormalizedCapabilities(features, 'zigbee'),
          directRadioCatalog: directRadioProtocolCatalogService.compactCatalogForDevice(catalogEntry),
          ...buildDirectFeatureProperties(features)
        }
      }
    };
  }

  normalizeZWaveNode(node, reason = 'sync') {
    if (!node) {
      return null;
    }

    const nodeId = Number(node.id);
    if (!Number.isFinite(nodeId)) {
      return null;
    }
    if (node.isControllerNode === true) {
      return null;
    }

    const zwave = require('zwave-js');
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
    const accessControl = getZWaveAccessControl(node);
    if (accessControl) {
      features.add('lockCodes');
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

    const catalogEntry = directRadioProtocolCatalogService.getZWaveNodeCatalogEntry(node);
    const directRadioCatalog = directRadioProtocolCatalogService.compactCatalogForDevice(catalogEntry);
    const sirenVolumeParameter = getSirenVolumeConfigParameterFromCatalog(directRadioCatalog);
    const sirenSoundParameter = getSirenSoundConfigParameterFromCatalog(directRadioCatalog);
    const sirenVolumeValue = sirenVolumeParameter
      ? getZWaveValue(node, zwave.ConfigurationCCValues.paramInformation(
        normalizeInteger(sirenVolumeParameter.parameter),
        normalizeInteger(sirenVolumeParameter.valueBitMask) ?? undefined
      ))
      : getZWaveValue(node, zwave.SoundSwitchCCValues.volume);
    const sirenSoundValue = sirenSoundParameter
      ? getZWaveValue(node, zwave.ConfigurationCCValues.paramInformation(
        normalizeInteger(sirenSoundParameter.parameter),
        normalizeInteger(sirenSoundParameter.valueBitMask) ?? undefined
      ))
      : getZWaveValue(node, zwave.SoundSwitchCCValues.defaultToneId);
    const sirenVolumeProperties = sirenVolumeParameter
      ? buildSirenVolumeProperties(sirenVolumeParameter, sirenVolumeValue)
      : hasZWaveValue(node, zwave.SoundSwitchCCValues.volume)
        ? { supportsSirenVolume: true, ...(normalizeInteger(sirenVolumeValue) !== null ? { sirenVolume: normalizeInteger(sirenVolumeValue) } : {}) }
        : {};
    const sirenSoundProperties = sirenSoundParameter
      ? buildSirenSoundProperties(sirenSoundParameter, sirenSoundValue)
      : hasZWaveValue(node, zwave.SoundSwitchCCValues.defaultToneId)
        ? { supportsSirenSound: true, ...(normalizeInteger(sirenSoundValue) !== null ? { sirenSound: normalizeInteger(sirenSoundValue) } : {}) }
        : {};
    (Array.isArray(catalogEntry?.homebrainFeatures) ? catalogEntry.homebrainFeatures : [])
      .map(normalizeFeature)
      .filter(Boolean)
      .forEach((feature) => features.add(feature));

    const currentLockMode = getZWaveValue(node, zwave.DoorLockCCValues.currentMode);
    const binaryValue = getZWaveValue(node, zwave.BinarySwitchCCValues.currentValue);
    const multilevelValue = getZWaveValue(node, zwave.MultilevelSwitchCCValues.currentValue);
    const brightness = clampPercent(multilevelValue);
    const locked = currentLockMode === zwave.DoorLockMode.Secured || currentLockMode === true || currentLockMode === 'Secured';
    const hasLock = features.has('lock');
    const batteryReport = normalizeZWaveBatteryReport(getZWaveValue(node, zwave.BatteryCCValues.level), {
      zeroIsUnknown: hasLock,
      pendingWhenMissing: hasLock && features.has('battery')
    });
    const directRadioState = {};
    if (batteryReport.level !== null) {
      directRadioState.batteryLevel = batteryReport.level;
    }
    if (batteryReport.low) {
      directRadioState.batteryLow = true;
    }
    const hasSwitch = features.has('switch');
    const nodeName = trimString(node.name)
      || trimString(node.deviceConfig?.label)
      || trimString(node.productLabel)
      || trimString(catalogEntry?.label || catalogEntry?.model)
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
        isOnline: isZWaveNodeOnline(node),
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
            ready: node.ready === undefined ? null : Boolean(node.ready),
            status: node.status,
            isListening: node.isListening,
            isFrequentListening: node.isFrequentListening,
            lastReason: reason,
            lastSeen: new Date().toISOString(),
            catalog: directRadioProtocolCatalogService.buildCatalogReference(catalogEntry)
          },
          homeBrainBatteryLevel: batteryReport.level,
          batteryLevel: batteryReport.level,
          homeBrainBatteryLow: batteryReport.low,
          homeBrainBatteryReportPending: batteryReport.pending,
          ...(Object.keys(directRadioState).length > 0 ? { directRadioState } : {}),
          directRadioFeatures: directFeatures,
          directRadioCapabilities: buildNormalizedCapabilities(directFeatures, 'zwave'),
          directRadioCatalog,
          ...sirenVolumeProperties,
          ...sirenSoundProperties,
          ...buildDirectFeatureProperties(directFeatures)
        }
      }
    };
  }

  inferDeviceTypeFromFeatures(features = [], context = {}) {
    return inferDirectDeviceType(features.map(normalizeFeature), context);
  }

  async handleZigbeeDeviceChanged(zigbeeDevice, reason, options = {}) {
    const normalized = this.normalizeZigbeeDevice(zigbeeDevice, reason, options);
    if (!normalized) {
      return null;
    }
    this.log('info', 'zigbee', 'Zigbee device state normalized', {
      reason,
      ieeeAddr: normalized.identity?.id || null,
      features: normalized.update?.properties?.directRadioFeatures || [],
      observedStatus: Object.prototype.hasOwnProperty.call(normalized.update || {}, 'status')
        ? normalized.update.status
        : null,
      observedBrightness: Object.prototype.hasOwnProperty.call(normalized.update || {}, 'brightness')
        ? normalized.update.brightness
        : null,
      observedColorTemperature: Object.prototype.hasOwnProperty.call(normalized.update || {}, 'colorTemperature')
        ? normalized.update.colorTemperature
        : null,
      directStateKeys: normalized.update?.properties?.directRadioState
        ? Object.keys(normalized.update.properties.directRadioState)
        : []
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
    if (!isZWaveDirectUpdateInterviewComplete(normalized.update, reason)) {
      this.markPairingDetected('zwave', normalized.identity, null, reason);
      const activeMigration = this.findActiveMigration('zwave');
      if (activeMigration?.sourceDeviceId) {
        const timestamp = new Date().toISOString();
        activeMigration.inclusionStatus = 'interviewing';
        activeMigration.directIdentity = normalized.identity;
        activeMigration.pendingDirectName = normalized.update?.name || null;
        activeMigration.updatedAt = timestamp;
      }
      if (Device.db?.readyState !== 1) {
        this.log('info', 'zwave', 'Z-Wave node interview is not complete; skipping partial device persistence until the database is ready', {
          reason,
          nodeId: normalized.identity?.id || null
        });
        return null;
      }
      const updatedExisting = await this.upsertDirectDevice(normalized.identity, normalized.update, {
        allowCreate: false,
        skipActiveMigration: true,
        suppressPairingCompletion: true
      });
      if (!updatedExisting) {
        this.log('info', 'zwave', 'Z-Wave node interview is not complete; deferring HomeBrain device creation', {
          reason,
          nodeId: normalized.identity?.id || null,
          ready: normalized.update?.properties?.homebrainDirect?.ready ?? null,
          status: normalized.update?.properties?.homebrainDirect?.status ?? null
        });
      }
      return updatedExisting;
    }
    return this.upsertDirectDevice(normalized.identity, normalized.update);
  }

  async upsertDirectDevice(identity, update, options = {}) {
    const activeMigration = options.skipActiveMigration ? null : this.findActiveMigration(identity.protocol);
    if (activeMigration?.sourceDeviceId) {
      return this.completeMigration(activeMigration.id, identity, update);
    }

    return this.withDirectDeviceUpsertLock(identity, () => this.upsertDirectDeviceRecord(identity, update, options));
  }

  async upsertDirectDeviceRecord(identity, update, options = {}) {
    const query = buildDirectDeviceQuery(identity);
    const existingRecords = await Device.find(query);
    const existing = selectPrimaryDirectDeviceRecord(existingRecords);
    if (!existing && options.allowCreate === false) {
      return null;
    }
    const payload = mergeDirectDeviceUpdateForExisting(existing, update);

    let device = existing
      ? await Device.findByIdAndUpdate(existing._id, payload, { returnDocument: 'after', runValidators: true })
      : await new Device(payload).save();

    device = await this.attachRecoveredSmartThingsMigrationIfMatched(device, identity);

    this.log('info', identity.protocol, existing ? 'Direct radio device updated' : 'Direct radio device created', {
      deviceId: device?._id?.toString?.() || null,
      name: device?.name || update?.name || null,
      identity: identity.id
    });

    const duplicateRecords = (existingRecords || [])
      .filter((record) => isDuplicateDirectRadioRecord(record, device, identity));
    if (duplicateRecords.length > 0 && directFeatureCount(device) > 0) {
      const deviceService = require('./deviceService');
      const deletedDeviceIds = [];
      const deletionErrors = [];
      for (const duplicate of duplicateRecords) {
        try {
          const deletedDevice = await deviceService.deleteDevice(duplicate._id);
          deletedDeviceIds.push(deletedDevice?._id?.toString?.() || String(duplicate._id));
        } catch (error) {
          const stillExists = duplicate?._id ? await Device.exists({ _id: duplicate._id }) : true;
          if (!stillExists) {
            deletedDeviceIds.push(String(duplicate._id));
            continue;
          }
          deletionErrors.push({
            deviceId: String(duplicate?._id || ''),
            message: error?.message || String(error || 'Unknown duplicate cleanup error')
          });
        }
      }
      this.log(deletionErrors.length > 0 ? 'warn' : 'info', identity.protocol, 'Removed duplicate direct radio device records', {
        deviceId: device?._id?.toString?.() || null,
        identity: identity.id,
        duplicateCount: deletedDeviceIds.length,
        deletedDeviceIds,
        deletionErrors
      });
    }
    this.emitDeviceUpdate(device);
    if (!options.suppressPairingCompletion) {
      this.completePairingSession(identity.protocol, identity, device, update?.properties?.homebrainDirect?.lastReason || 'direct device update');
    }
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

  async findDetachedSmartThingsMigrationSource(directDevice, protocol) {
    const directDeviceId = getDeviceIdString(directDevice);
    if (!directDeviceId || !['zigbee', 'zwave'].includes(protocol)) {
      return null;
    }

    const networkTypes = protocol === 'zigbee'
      ? ['ZIGBEE', 'zigbee', 'Zigbee']
      : ['ZWAVE', 'zwave', 'ZWave', 'ZW', 'zw'];
    const candidates = await Device.find({
      _id: { $ne: directDeviceId },
      $and: [
        {
          $or: [
            { 'properties.source': 'smartthings' },
            { 'properties.smartThingsDeviceId': { $exists: true, $ne: null } }
          ]
        },
        {
          $or: [
            { 'properties.smartThingsMigration.retiredSource': { $exists: false } },
            { 'properties.smartThingsMigration.retiredSource': { $ne: true } }
          ]
        },
        { 'properties.smartThingsDeviceNetworkType': { $in: networkTypes } }
      ]
    });

    const scored = (Array.isArray(candidates) ? candidates : [])
      .map((candidate) => ({
        candidate,
        score: scoreDetachedSmartThingsMigrationSource(directDevice, candidate, protocol)
      }))
      .filter((entry) => entry.score >= 55)
      .sort((left, right) => right.score - left.score);

    return scored[0]?.candidate || null;
  }

  buildRecoveredSmartThingsMigrationSnapshot(directDevice, sourceDevice, protocol, migrationId = null) {
    const baseSnapshot = toPlainDeviceSnapshot(directDevice);
    const features = uniqueStrings([
      ...(Array.isArray(getDeviceProperties(baseSnapshot).directRadioFeatures)
        ? getDeviceProperties(baseSnapshot).directRadioFeatures
        : []),
      ...inferFeaturesFromExistingDirectRecord(baseSnapshot),
      ...inferFeaturesFromSmartThings(sourceDevice)
    ].map(normalizeFeature)).sort();
    const directUpdate = mergeSmartThingsTelemetryFallback({
      ...baseSnapshot,
      properties: {
        ...getDeviceProperties(baseSnapshot),
        directRadioFeatures: features
      }
    }, sourceDevice);
    const validation = this.buildMigrationValidation(sourceDevice, directUpdate, features);
    return buildRecoveredSmartThingsMigrationSnapshot({
      directDevice: directUpdate,
      sourceDevice,
      protocol,
      migrationId,
      validation
    });
  }

  async attachRecoveredSmartThingsMigrationIfMatched(device, identity, migrationId = null) {
    const protocol = identity?.protocol;
    if (!device || !['zigbee', 'zwave'].includes(protocol) || getSmartThingsMigration(device)) {
      return device;
    }

    const sourceDevice = await this.findDetachedSmartThingsMigrationSource(device, protocol);
    if (!sourceDevice) {
      return device;
    }

    const snapshot = this.buildRecoveredSmartThingsMigrationSnapshot(device, sourceDevice, protocol, migrationId);
    const updated = await Device.findByIdAndUpdate(device._id, {
      temperature: snapshot.temperature,
      properties: snapshot.properties,
      updatedAt: new Date()
    }, { returnDocument: 'after', runValidators: true });

    this.log('info', protocol, 'Recovered SmartThings migration context for detached native device', {
      deviceId: getDeviceIdString(updated || device),
      sourceDeviceId: getDeviceIdString(sourceDevice),
      migrationId: snapshot.properties.smartThingsMigration?.migrationId || null
    });

    return updated || device;
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
      directRadioCapabilities: buildNormalizedCapabilities(features, identity.protocol),
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

  buildMigrationFinalizationValidation(device, protocol, reason) {
    const properties = device?.properties && typeof device.properties === 'object'
      ? device.properties
      : {};
    const direct = properties.homebrainDirect && typeof properties.homebrainDirect === 'object'
      ? properties.homebrainDirect
      : {};
    const expectedSource = protocolSource(protocol);
    const source = normalizeSourceText(properties.source);
    const directProtocol = normalizeSourceText(direct.protocol);
    const features = uniqueStrings(Array.isArray(properties.directRadioFeatures)
      ? properties.directRadioFeatures
      : []);
    const featureSet = new Set(features.map(normalizeFeature));
    const previousFeatures = inferFeaturesFromSmartThings(device);
    const optionalSmartThingsFeatures = new Set(['firmware', 'health']);
    const requiredPreviousFeatures = previousFeatures
      .map(normalizeFeature)
      .filter((feature) => feature && !optionalSmartThingsFeatures.has(feature));
    const identity = protocol === 'zigbee'
      ? trimString(direct.ieeeAddr)
      : trimString(direct.nodeId);
    const checks = [
      {
        key: 'native_route',
        label: 'Native HomeBrain route',
        previous: properties.smartThingsMigration?.previousSource || 'smartthings',
        homebrain: source,
        matched: source === expectedSource && directProtocol === protocol,
        required: true
      },
      {
        key: 'identity',
        label: 'Direct radio identity',
        previous: properties.smartThingsMigration?.smartThingsDeviceId || properties.smartThingsDeviceId || null,
        homebrain: identity || null,
        matched: Boolean(identity),
        required: true
      },
      {
        key: 'online',
        label: 'Online state',
        previous: null,
        homebrain: device?.isOnline !== false,
        matched: device?.isOnline !== false,
        required: true
      },
      {
        key: 'features',
        label: 'Feature coverage',
        previous: requiredPreviousFeatures.length > 0 ? requiredPreviousFeatures : previousFeatures,
        homebrain: features,
        matched: requiredPreviousFeatures.length === 0
          ? features.length > 0
          : requiredPreviousFeatures.every((feature) => featureSet.has(normalizeFeature(feature))),
        required: true
      }
    ];

    return {
      validatedAt: new Date().toISOString(),
      status: checks.every((check) => check.matched) ? 'passed' : 'needs_review',
      finalized: checks.every((check) => check.matched),
      method: 'native_route_confirmation',
      reason: trimString(reason) || 'Native HomeBrain route and controls verified',
      checks
    };
  }

  async markSmartThingsMigrationSourceRetired(sourceDevice, directDevice, finalization, migration = {}) {
    const sourceDeviceId = getDeviceIdString(sourceDevice);
    const directDeviceId = getDeviceIdString(directDevice);
    if (!sourceDeviceId || !directDeviceId || sourceDeviceId === directDeviceId) {
      return null;
    }

    const sourceProperties = getDeviceProperties(sourceDevice);
    const sourceMigration = getSmartThingsMigration(sourceDevice) || {};
    const finalizedAt = finalization?.finalizedAt || new Date().toISOString();
    const nextProperties = {
      ...sourceProperties,
      smartThingsMigration: {
        ...sourceMigration,
        migratedAt: sourceMigration.migratedAt || migration.migratedAt || finalizedAt,
        previousSource: sourceMigration.previousSource || sourceProperties.source || 'smartthings',
        smartThingsDeviceId: sourceMigration.smartThingsDeviceId || sourceProperties.smartThingsDeviceId || null,
        sourceDeviceId,
        sourceDeviceName: sourceDevice.name || null,
        directDeviceId,
        replacementDeviceId: directDeviceId,
        migrationId: migration.migrationId || sourceMigration.migrationId || null,
        finalizedAt,
        finalizedBy: 'homebrain',
        retiredAt: finalizedAt,
        retiredSource: true,
        status: 'finalized_source',
        validation: finalization?.validation || migration.validation || null
      }
    };

    const updatedSource = await Device.findByIdAndUpdate(sourceDeviceId, {
      properties: nextProperties,
      updatedAt: new Date()
    }, { returnDocument: 'after', runValidators: true });

    this.log('info', 'smartthings', 'Retired SmartThings source after native migration finalization', {
      sourceDeviceId,
      directDeviceId,
      migrationId: nextProperties.smartThingsMigration.migrationId
    });
    this.emitDeviceUpdate(updatedSource);
    return updatedSource;
  }

  async finalizeDeviceMigration({ deviceId, migrationId, reason } = {}) {
    const safeDeviceId = normalizeObjectId(deviceId);
    let device = await Device.findById(safeDeviceId);
    if (!device) {
      const error = new Error('Device not found');
      error.status = 404;
      throw error;
    }

    let properties = getDeviceProperties(device);
    const direct = properties.homebrainDirect && typeof properties.homebrainDirect === 'object'
      ? properties.homebrainDirect
      : {};
    const protocol = normalizeSourceText(direct.protocol)
      || (normalizeSourceText(properties.source) === DIRECT_RADIO_SOURCES.zigbee ? 'zigbee' : '')
      || (normalizeSourceText(properties.source) === DIRECT_RADIO_SOURCES.zwave ? 'zwave' : '');
    if (!['zigbee', 'zwave'].includes(protocol)) {
      const error = new Error('Native direct-radio protocol is not ready for this migrated device.');
      error.status = 409;
      throw error;
    }

    let migration = getSmartThingsMigration(device);
    let sourceDevice = null;
    if (!migration) {
      sourceDevice = await this.findDetachedSmartThingsMigrationSource(device, protocol);
      if (!sourceDevice) {
        const error = new Error('This device does not have an open SmartThings migration to finalize.');
        error.status = 400;
        throw error;
      }
      const recoveredSnapshot = this.buildRecoveredSmartThingsMigrationSnapshot(
        device,
        sourceDevice,
        protocol,
        migrationId
      );
      device = {
        ...toPlainDeviceSnapshot(device),
        ...recoveredSnapshot,
        properties: recoveredSnapshot.properties
      };
      properties = recoveredSnapshot.properties;
      migration = getSmartThingsMigration(device);
    } else if (migration.sourceDeviceId) {
      const maybeSource = await Device.findById(migration.sourceDeviceId).catch(() => null);
      if (maybeSource && getDeviceIdString(maybeSource) !== safeDeviceId) {
        sourceDevice = maybeSource;
      }
    }

    const validation = this.buildMigrationFinalizationValidation(device, protocol, reason);
    if (validation.status !== 'passed') {
      const error = new Error('HomeBrain cannot finalize this migration until the native radio route is ready.');
      error.status = 409;
      error.validation = validation;
      throw error;
    }

    const finalizedAt = new Date().toISOString();
    const nextProperties = {
      ...properties,
      source: protocolSource(protocol),
      smartThingsMigration: {
        ...migration,
        migrationId: trimString(migrationId) || migration.migrationId || null,
        finalizedAt,
        finalizedBy: 'homebrain',
        validation: {
          ...(migration.validation && typeof migration.validation === 'object' ? migration.validation : {}),
          ...validation,
          finalizedAt,
          finalized: true,
          status: 'passed'
        }
      }
    };

    const updated = await Device.findByIdAndUpdate(device._id, {
      temperature: device.temperature,
      properties: nextProperties,
      isOnline: device.isOnline !== false,
      updatedAt: new Date()
    }, { returnDocument: 'after', runValidators: true });

    const retiredSourceDevice = sourceDevice
      ? await this.markSmartThingsMigrationSourceRetired(sourceDevice, updated || device, {
        finalizedAt,
        validation: nextProperties.smartThingsMigration.validation
      }, nextProperties.smartThingsMigration)
      : null;

    this.log('info', protocol, 'SmartThings migration finalized on direct radio', {
      deviceId: updated?._id?.toString?.() || safeDeviceId,
      name: updated?.name || device.name || null,
      protocol,
      migrationId: nextProperties.smartThingsMigration.migrationId,
      validation: nextProperties.smartThingsMigration.validation
    });
    this.emitDeviceUpdate(updated);

    return {
      device: updated,
      retiredSourceDevice,
      finalization: {
        deviceId: updated?._id?.toString?.() || safeDeviceId,
        protocol,
        finalizedAt,
        validation: nextProperties.smartThingsMigration.validation
      }
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

  async startMigration({ deviceId, protocol, durationSeconds, dskPin, migrationId, zwaveSecurityMode, securityMode } = {}) {
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
        const error = new Error('Z-Wave exclusion has not been verified yet. Keep this workflow on the SmartThings exclusion step until HomeBrain verifies that SmartThings removed the device.');
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
      if (targetProtocol === 'zigbee' && migration.smartThingsDeviceId && !migration.smartThingsRemovalRequest) {
        const removalRequest = await this.requestSmartThingsDeviceRemoval(migration, device);
        this.log(removalRequest.status === 'failed' ? 'warn' : 'info', 'zigbee', 'Requested SmartThings Zigbee device removal before opening HomeBrain pairing', {
          migrationId: migration.id,
          deviceId: migration.sourceDeviceId,
          smartThingsDeviceId: migration.smartThingsDeviceId,
          removalRequestStatus: removalRequest.status
        });
      }
      if (targetProtocol === 'zigbee') {
        await this.startPairing('zigbee', { durationSeconds: seconds });
      } else {
        this.zwave.s2DskPin = trimString(dskPin);
        await this.startPairing('zwave', {
          durationSeconds: seconds,
          zwaveSecurityMode: normalizeZWaveSecurityMode(
            zwaveSecurityMode ?? securityMode,
            shouldUseSecureZWaveMigration(device, plan) ? 'default' : 'insecure'
          )
        });
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
        smartThings: migration.smartThingsExclusionEvidence || null,
        expiresAt,
        secondsRemaining
      }
    };
  }

  getSmartThingsService() {
    return this.smartThingsService || require('./smartThingsService');
  }

  async getLocalMigrationDevice(migration) {
    const sourceDeviceId = trimString(migration?.sourceDeviceId);
    if (!sourceDeviceId || Device.db?.readyState !== 1) {
      return null;
    }

    try {
      return await Device.findById(sourceDeviceId).lean();
    } catch (error) {
      console.warn(`DirectRadioService: Failed to load migration source device ${sourceDeviceId}: ${error.message}`);
      return null;
    }
  }

  async collectSmartThingsExclusionEvidence(migration) {
    const smartThingsDeviceId = trimString(migration.smartThingsDeviceId);
    const smartThings = this.getSmartThingsService();
    const evidence = {
      device: null,
      health: null,
      hubHealth: null,
      status: null,
      localDevice: await this.getLocalMigrationDevice(migration),
      gone: false,
      error: null
    };

    try {
      evidence.device = await smartThings.getDevice(smartThingsDeviceId);
    } catch (error) {
      if (isSmartThingsDeviceGoneError(error)) {
        evidence.gone = true;
        migration.smartThingsExclusionEvidence = summarizeSmartThingsExclusionEvidence({
          localDevice: evidence.localDevice,
          source: 'missing_device'
        });
        return evidence;
      }
      evidence.error = error;
      return evidence;
    }

    const hubId = getSmartThingsHubId(evidence.device);
    if (typeof smartThings.getDeviceHealth === 'function') {
      try {
        evidence.health = await smartThings.getDeviceHealth(smartThingsDeviceId);
      } catch (error) {
        this.log('warn', migration.protocol || 'smartthings', 'SmartThings device health was not available during migration verification', {
          migrationId: migration.id,
          smartThingsDeviceId,
          error: error.message
        });
      }
    }

    if (hubId && typeof smartThings.getHubHealth === 'function') {
      try {
        evidence.hubHealth = await smartThings.getHubHealth(hubId);
      } catch (error) {
        this.log('warn', migration.protocol || 'smartthings', 'SmartThings hub health was not available during migration verification', {
          migrationId: migration.id,
          smartThingsDeviceId,
          hubId,
          error: error.message
        });
      }
    }

    if (typeof smartThings.getDeviceStatus === 'function') {
      try {
        evidence.status = await smartThings.getDeviceStatus(smartThingsDeviceId);
      } catch (error) {
        this.log('warn', migration.protocol || 'smartthings', 'SmartThings device status was not available during migration verification', {
          migrationId: migration.id,
          smartThingsDeviceId,
          error: error.message
        });
      }
    }

    migration.smartThingsExclusionEvidence = summarizeSmartThingsExclusionEvidence({
      device: evidence.device,
      health: evidence.health,
      hubHealth: evidence.hubHealth,
      status: evidence.status,
      localDevice: evidence.localDevice,
      source: 'smartthings_api'
    });
    return evidence;
  }

  markSmartThingsExclusionVerified(migration, { source, message, removalVerified = false } = {}) {
    const timestamp = new Date().toISOString();
    migration.status = 'excluded';
    migration.exclusionStatus = 'verified';
    migration.exclusionVerifiedAt = timestamp;
    migration.smartThingsExclusionVerifiedAt = timestamp;
    if (removalVerified) {
      migration.smartThingsRemovalVerifiedAt = timestamp;
    }
    migration.smartThingsExclusionVerificationSource = source || 'smartthings_api';
    migration.updatedAt = timestamp;
    migration.expiresAt = Math.max(Number(migration.expiresAt || 0), Date.now() + 15 * 60 * 1000);
    this.log('info', migration.protocol || 'smartthings', 'SmartThings migration exclusion verified', {
      migrationId: migration.id,
      deviceId: migration.sourceDeviceId,
      smartThingsDeviceId: migration.smartThingsDeviceId,
      source: migration.smartThingsExclusionVerificationSource
    });
    return this.buildMigrationVerificationResult(migration, {
      phase: 'physical_exclusion',
      status: 'verified',
      message: message || 'SmartThings no longer has a live route to this device. HomeBrain can now open native inclusion.'
    });
  }

  async requestSmartThingsDeviceRemoval(migration, sourceDevice) {
    const smartThingsDeviceId = trimString(migration?.smartThingsDeviceId || sourceDevice?.properties?.smartThingsDeviceId);
    if (!smartThingsDeviceId) {
      return { status: 'skipped', reason: 'missing_smartthings_device_id' };
    }

    const smartThings = this.getSmartThingsService();
    let deviceDetails = null;
    if (typeof smartThings.getDevice === 'function') {
      try {
        deviceDetails = await smartThings.getDevice(smartThingsDeviceId);
      } catch (error) {
        if (isSmartThingsDeviceGoneError(error)) {
          migration.smartThingsRemovalRequest = {
            status: 'already_missing',
            requestedAt: new Date().toISOString()
          };
          migration.smartThingsExclusionEvidence = summarizeSmartThingsExclusionEvidence({
            localDevice: sourceDevice,
            source: 'already_missing'
          });
          return migration.smartThingsRemovalRequest;
        }
        migration.smartThingsRemovalRequest = {
          status: 'failed',
          requestedAt: new Date().toISOString(),
          error: error.message,
          statusCode: Number(error?.status ?? error?.response?.status) || null
        };
        return migration.smartThingsRemovalRequest;
      }
    }

    const hubId = getSmartThingsHubId(deviceDetails);
    if (hubId && typeof smartThings.getHubHealth === 'function') {
      try {
        migration.smartThingsHubHealthBeforeExclusion = await smartThings.getHubHealth(hubId);
      } catch (error) {
        this.log('warn', migration.protocol || 'smartthings', 'SmartThings hub baseline was not available before removal request', {
          migrationId: migration.id,
          smartThingsDeviceId,
          hubId,
          error: error.message
        });
      }
    }

    try {
      const response = typeof smartThings.deleteDevice === 'function'
        ? await smartThings.deleteDevice(smartThingsDeviceId)
        : null;
      migration.smartThingsRemovalRequest = {
        status: 'requested',
        requestedAt: new Date().toISOString(),
        response: response || null
      };
      return migration.smartThingsRemovalRequest;
    } catch (error) {
      if (isSmartThingsDeviceGoneError(error)) {
        migration.smartThingsRemovalRequest = {
          status: 'already_missing',
          requestedAt: new Date().toISOString()
        };
        return migration.smartThingsRemovalRequest;
      }
      migration.smartThingsRemovalRequest = {
        status: 'failed',
        requestedAt: new Date().toISOString(),
        error: error.message,
        statusCode: Number(error?.status ?? error?.response?.status) || null
      };
      this.log('warn', migration.protocol || 'smartthings', 'SmartThings device removal request failed during migration start', {
        migrationId: migration.id,
        smartThingsDeviceId,
        error: error.message,
        statusCode: migration.smartThingsRemovalRequest.statusCode
      });
      return migration.smartThingsRemovalRequest;
    }
  }

  async verifySmartThingsExclusion(migration) {
    const smartThingsDeviceId = trimString(migration.smartThingsDeviceId);
    if (!smartThingsDeviceId) {
      return this.buildMigrationVerificationResult(migration, {
        phase: 'physical_exclusion',
        status: 'failed',
        message: 'This migration does not have a SmartThings device ID to verify against.',
        guidance: [
          'Refresh the device details and restart the guided migration from the SmartThings-backed device record.'
        ]
      });
    }

    const evidence = await this.collectSmartThingsExclusionEvidence(migration);
    if (evidence.gone) {
      return this.markSmartThingsExclusionVerified(migration, {
        source: 'missing_device',
        removalVerified: true,
        message: 'SmartThings no longer reports this device. HomeBrain can now open native inclusion.'
      });
    }
    if (evidence.error) {
      return this.buildMigrationVerificationResult(migration, {
        phase: 'physical_exclusion',
        status: 'pending',
        message: `HomeBrain could not verify SmartThings exclusion yet: ${evidence.error.message}`,
        guidance: [
          'Start SmartThings removal again from HomeBrain, or use the hub Z-Wave exclusion utility if SmartThings rejects the API request.',
          'Trigger the physical exclude action at the switch while the SmartThings hub is in exclusion/removal mode.',
          'Then tap Verify SmartThings exclusion again.'
        ]
      });
    }

    const counterIncrease = findSmartThingsExclusionCounterIncrease(
      migration.smartThingsHubHealthBeforeExclusion?.hubRadioState || migration.smartThingsHubHealthBeforeExclusion,
      evidence.hubHealth?.hubRadioState || evidence.hubHealth
    );
    if (counterIncrease) {
      migration.smartThingsExclusionCounter = counterIncrease;
      return this.markSmartThingsExclusionVerified(migration, {
        source: 'hub_exclusion_counter',
        message: `SmartThings reported an exclusion counter increase at ${counterIncrease.path}. HomeBrain can now open native inclusion.`
      });
    }

    const hubConnectivity = normalizeSmartThingsState(evidence.hubHealth?.connectivity);
    const healthState = normalizeSmartThingsState(
      evidence.health?.state || evidence.localDevice?.properties?.smartThingsHealthState?.state
    );
    const provisioningState = getSmartThingsProvisioningState(evidence.device);
    if (isSmartThingsUnprovisionedState(provisioningState)) {
      return this.markSmartThingsExclusionVerified(migration, {
        source: 'device_unprovisioned',
        message: 'SmartThings reports this device is no longer provisioned on its old radio network. HomeBrain can now open native inclusion.'
      });
    }
    if (healthState === 'OFFLINE' && hubConnectivity !== 'DISCONNECTED') {
      return this.markSmartThingsExclusionVerified(migration, {
        source: 'device_health_offline',
        message: 'SmartThings still has a stale device tile, but its device health is OFFLINE. HomeBrain will treat the old SmartThings radio route as gone and can now open native inclusion.'
      });
    }

    const expiresAt = Number(migration.exclusionExpiresAt || migration.expiresAt || 0);
    const timedOut = expiresAt > 0 && expiresAt <= Date.now();
    return this.buildMigrationVerificationResult(migration, {
      phase: 'physical_exclusion',
      status: timedOut ? 'failed' : 'pending',
      message: timedOut
        ? 'SmartThings still reports this device as reachable after the exclusion window. HomeBrain will not start native inclusion yet.'
        : 'SmartThings still reports this device as reachable. Stay on this step until SmartThings removal, the hub exclusion counter, or device health verifies.',
      guidance: [
        'Use HomeBrain Start SmartThings removal to request SmartThings removal over API, or open Hub > Z-Wave utilities > Z-Wave exclusion if SmartThings rejects the API request.',
        'At the switch, tap the local on/up paddle once. If it does not exclude, toggle on/up and off/down quickly 3 times.',
        'Do not start HomeBrain inclusion until SmartThings removal, exclusion counter, unprovisioned state, or OFFLINE health verifies.'
      ],
      expiresAt
    });
  }

  async verifyMigrationExclusion(migration) {
    if (
      migration.status === 'awaiting_smartthings_exclusion'
      || migration.exclusionStatus === 'waiting_smartthings'
      || migration.smartThingsDeviceId
    ) {
      return this.verifySmartThingsExclusion(migration);
    }

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
      verification = await this.verifyMigrationExclusion(migration);
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
      this.clearPairingTimer('zigbee');
      const session = this.createPairingSession('zigbee', seconds);
      this.log('info', 'zigbee', 'Opening Zigbee permit-join window', {
        durationSeconds: seconds,
        serialPath: this.detected.zigbee?.path || null,
        pairingId: session.id
      });
      await this.zigbee.controller.permitJoin(seconds);
      this.zigbee.permitJoinUntil = new Date(Date.now() + seconds * 1000).toISOString();
      session.status = 'active';
      session.expiresAt = Date.now() + seconds * 1000;
      session.message = 'Zigbee permit-join is open. HomeBrain will finish as soon as a device joins or interviews.';
      this.armPairingTimer('zigbee', session.id, seconds);
      this.log('info', 'zigbee', 'Zigbee permit-join window is open', {
        expiresAt: this.zigbee.permitJoinUntil,
        pairingId: session.id
      });
      return {
        protocol,
        mode: 'permit_join',
        expiresAt: this.zigbee.permitJoinUntil,
        pairing: this.serializePairingSession(session)
      };
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
      const resetResult = await this.closeZWavePairingWindow({
        zwave,
        reason: 'start_inclusion',
        sessionMessage: 'Previous Z-Wave add/remove window was stopped before starting inclusion.'
      });
      const { mode: zwaveSecurityMode, options: inclusionOptions } = this.buildZWaveInclusionOptions(
        zwave,
        options.zwaveSecurityMode ?? options.securityMode
      );
      const session = this.createPairingSession('zwave', seconds, {
        message: zwaveSecurityMode === 'insecure'
          ? 'Z-Wave standard inclusion is opening without S2 security, so no DSK PIN is required.'
          : 'Z-Wave secure inclusion is opening. HomeBrain may ask for the first 5 digits from the device DSK label.'
      });
      session.zwaveSecurityMode = zwaveSecurityMode;
      this.zwave.s2DskPin = trimString(options.dskPin);
      this.zwave.pendingDsk = null;
      this.log('info', 'zwave', 'Opening Z-Wave inclusion window', {
        durationSeconds: seconds,
        serialPath: this.detected.zwave?.path || null,
        pairingId: session.id,
        securityMode: zwaveSecurityMode,
        previousWindow: resetResult
      });
      let inclusionStarted = false;
      try {
        inclusionStarted = await controller.beginInclusion(inclusionOptions);
      } catch (error) {
        this.markPairingFailed('zwave', error.message || 'Z-Wave inclusion failed to start.');
        throw error;
      }
      if (inclusionStarted !== true) {
        await this.closeZWavePairingWindow({
          zwave,
          reason: 'retry_inclusion_after_busy',
          markSession: false,
          sessionMessage: 'HomeBrain reset the Z-Wave controller after the first inclusion start did not open.'
        });
        await delay(350);
        try {
          inclusionStarted = await controller.beginInclusion(inclusionOptions);
        } catch (error) {
          this.markPairingFailed('zwave', error.message || 'Z-Wave inclusion failed to start.');
          throw error;
        }
      }
      if (inclusionStarted !== true) {
        const state = this.getZWaveInclusionStateLabel(zwave);
        const message = state
          ? `Z-Wave inclusion did not start because the controller is still ${state}. HomeBrain reset the stale window, but the controller did not accept the new inclusion request.`
          : 'Z-Wave inclusion did not start because the controller reported it was already busy after HomeBrain reset the stale window.';
        this.markPairingFailed('zwave', message, {
          state,
          previousWindow: resetResult
        });
        this.zwave.inclusionUntil = null;
        const error = new Error(message);
        error.status = 409;
        error.code = 'ZWAVE_INCLUSION_NOT_STARTED';
        throw error;
      }
      this.zwave.inclusionUntil = new Date(Date.now() + seconds * 1000).toISOString();
      session.status = 'active';
      session.expiresAt = Date.now() + seconds * 1000;
      session.message = zwaveSecurityMode === 'insecure'
        ? 'Z-Wave standard inclusion is open. No DSK PIN is required; HomeBrain will finish as soon as the controller reports the new node.'
        : 'Z-Wave secure inclusion is open. If prompted, enter the first 5 digits printed on the device DSK label or QR code.';
      this.armPairingTimer('zwave', session.id, seconds);
      this.log('info', 'zwave', 'Z-Wave inclusion window is open', {
        expiresAt: this.zwave.inclusionUntil,
        pairingId: session.id,
        securityMode: zwaveSecurityMode
      });
      return {
        protocol,
        mode: 'inclusion',
        expiresAt: this.zwave.inclusionUntil,
        pairing: this.serializePairingSession(session)
      };
    }

    const error = new Error('Protocol must be zigbee or zwave');
    error.status = 400;
    throw error;
  }

  async startExclusion(protocol, options = {}) {
    if (protocol !== 'zwave') {
      const error = new Error('Only Z-Wave supports controller-driven exclusion.');
      error.status = 400;
      throw error;
    }

    const seconds = boundedSeconds(options.durationSeconds);
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

      const smartThingsDeviceId = trimString(device.properties?.smartThingsDeviceId);
      if (smartThingsDeviceId) {
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
        const migration = existingMigration || {
          id: requestedMigrationId || `migration-${now}-${crypto.randomBytes(4).toString('hex')}`,
          sourceDeviceId: String(device._id),
          smartThingsDeviceId,
          protocol: 'zwave',
          startedAt: new Date(now).toISOString()
        };
        Object.assign(migration, {
          sourceDeviceId: String(device._id),
          smartThingsDeviceId,
          protocol: 'zwave',
          status: 'awaiting_smartthings_exclusion',
          exclusionStatus: 'waiting_smartthings',
          exclusionStartedAt: new Date(now).toISOString(),
          exclusionExpiresAt: now + seconds * 1000,
          expiresAt: now + seconds * 1000,
          plan,
          updatedAt: new Date(now).toISOString()
        });
        const removalRequest = await this.requestSmartThingsDeviceRemoval(migration, device);
        if (removalRequest.status === 'already_missing') {
          this.markSmartThingsExclusionVerified(migration, {
            source: 'missing_device_at_start',
            removalVerified: true,
            message: 'SmartThings no longer reports this device. HomeBrain can now open native Z-Wave inclusion.'
          });
        }
        this.activeMigrations.set(migration.id, migration);
        this.log('info', 'zwave', 'Requested SmartThings Z-Wave removal and prepared exclusion verification', {
          migrationId: migration.id,
          deviceId: migration.sourceDeviceId,
          smartThingsDeviceId,
          removalRequestStatus: removalRequest.status
        });
        return {
          protocol,
          mode: removalRequest.status === 'requested' ? 'smartthings_api_exclusion' : 'smartthings_exclusion',
          expiresAt: new Date(migration.exclusionExpiresAt).toISOString(),
          smartThingsRemovalRequest: removalRequest,
          migration
        };
      }
    }

    await this.start();
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

    let migration = null;
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
    const resetResult = await this.closeZWavePairingWindow({
      zwave,
      reason: 'start_exclusion',
      sessionMessage: 'Previous Z-Wave add/remove window was stopped before starting exclusion.'
    });
    this.log('info', 'zwave', 'Opening Z-Wave exclusion window', {
      durationSeconds: seconds,
      serialPath: this.detected.zwave?.path || null,
      migrationId: migration?.id || null,
      previousWindow: resetResult
    });
    let exclusionStarted = false;
    try {
      exclusionStarted = await controller.beginExclusion({ strategy: zwave.ExclusionStrategy.ExcludeOnly });
    } catch (error) {
      if (migration) {
        migration.status = 'exclusion_failed';
        migration.exclusionStatus = 'failed';
        migration.exclusionFailedAt = new Date().toISOString();
        migration.updatedAt = migration.exclusionFailedAt;
      }
      throw error;
    }
    if (exclusionStarted !== true) {
      await this.closeZWavePairingWindow({
        zwave,
        reason: 'retry_exclusion_after_busy',
        markSession: false,
        sessionMessage: 'HomeBrain reset the Z-Wave controller after the first exclusion start did not open.'
      });
      await delay(350);
      try {
        exclusionStarted = await controller.beginExclusion({ strategy: zwave.ExclusionStrategy.ExcludeOnly });
      } catch (error) {
        if (migration) {
          migration.status = 'exclusion_failed';
          migration.exclusionStatus = 'failed';
          migration.exclusionFailedAt = new Date().toISOString();
          migration.updatedAt = migration.exclusionFailedAt;
        }
        throw error;
      }
    }
    if (exclusionStarted !== true) {
      const state = this.getZWaveInclusionStateLabel(zwave);
      const message = state
        ? `Z-Wave exclusion did not start because the controller is still ${state}. HomeBrain reset the stale window, but the controller did not accept the new exclusion request.`
        : 'Z-Wave exclusion did not start because the controller reported it was already busy after HomeBrain reset the stale window.';
      if (migration) {
        migration.status = 'exclusion_failed';
        migration.exclusionStatus = 'failed';
        migration.exclusionFailedAt = new Date().toISOString();
        migration.updatedAt = migration.exclusionFailedAt;
      }
      this.zwave.exclusionUntil = null;
      this.log('warn', 'zwave', 'Z-Wave exclusion window did not start', {
        migrationId: migration?.id || null,
        state,
        previousWindow: resetResult
      });
      const error = new Error(message);
      error.status = 409;
      error.code = 'ZWAVE_EXCLUSION_NOT_STARTED';
      throw error;
    }
    this.zwave.exclusionUntil = new Date(Date.now() + seconds * 1000).toISOString();
    const stopTimer = setTimeout(() => {
      void this.stopPairing('zwave').catch(() => {});
    }, seconds * 1000);
    if (typeof stopTimer.unref === 'function') {
      stopTimer.unref();
    }
    this.pairingTimers.zwave = stopTimer;
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
      this.clearPairingTimer('zigbee');
      await this.zigbee.controller.permitJoin(0);
      this.zigbee.permitJoinUntil = null;
      const session = this.activePairings.get('zigbee');
      if (session && !['completed', 'failed', 'expired'].includes(session.status)) {
        session.status = 'stopped';
        session.stoppedAt = new Date().toISOString();
        session.message = session.message || 'Zigbee pairing was stopped.';
      }
      this.log('info', 'zigbee', 'Zigbee permit-join window closed');
    }

    if ((protocol === 'zwave' || protocol === 'all') && this.getZWaveController()) {
      await this.closeZWavePairingWindow({
        reason: 'stop_pairing',
        sessionMessage: 'Z-Wave pairing was stopped.'
      });
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

  async getNativeZWaveLockContext(deviceId) {
    const device = await Device.findById(deviceId);
    if (!device) {
      const error = new Error('Device not found');
      error.status = 404;
      throw error;
    }
    if (device.type !== 'lock') {
      const error = new Error('Lock PIN management is only available for lock devices');
      error.status = 400;
      throw error;
    }

    const source = normalizeSourceText(device?.properties?.source);
    const protocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol);
    if (source !== DIRECT_RADIO_SOURCES.zwave && protocol !== 'zwave') {
      const error = new Error('Lock PIN management requires a HomeBrain-native Z-Wave lock. Migrate this SmartThings lock to HomeBrain Z-Wave first.');
      error.status = 400;
      throw error;
    }

    await this.start();
    const node = this.getDirectNodeForDevice(device);
    if (!node) {
      const error = new Error('Z-Wave node is not ready for this lock');
      error.status = 409;
      throw error;
    }

    const accessControl = getZWaveAccessControl(node);
    if (!accessControl) {
      const error = new Error('This Z-Wave lock is paired without secure User Code/User Credential support. Exclude it from Z-Wave and add it again with secure Z-Wave/S2 access-control inclusion so HomeBrain can manage PIN slots.');
      error.code = 'ZWAVE_LOCK_ACCESS_CONTROL_UNAVAILABLE';
      error.status = 400;
      throw error;
    }

    return { device, node, accessControl };
  }

  async readZWaveLockUsers(device, accessControl, options = {}) {
    const refresh = options.refresh === true;
    let users = [];
    if (!refresh && typeof accessControl.getUsersCached === 'function') {
      users = accessControl.getUsersCached() || [];
    }
    if ((refresh || users.length === 0) && typeof accessControl.getUsers === 'function') {
      users = await accessControl.getUsers();
    }

    return users
      .map((user) => serializeLockCodeSlot(device, user))
      .filter(Boolean)
      .sort((left, right) => left.slot - right.slot);
  }

  async readZWaveLockAuditFromDevice(device, node, options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 25));
    const api = node?.commandClasses?.['Door Lock Logging'];
    if (!api || typeof api.getRecord !== 'function') {
      return [];
    }

    let count = 0;
    if (typeof api.getRecordsCount === 'function') {
      try {
        count = Number(await api.getRecordsCount()) || 0;
      } catch (error) {
        this.log('warn', 'zwave', 'Unable to read Z-Wave door lock audit count', {
          deviceId: device?._id?.toString?.() || null,
          nodeId: node?.id || null,
          error: error.message
        });
      }
    }

    const records = [];
    const maxRecord = count > 0 ? Math.min(count, limit) : limit;
    for (let recordNumber = 1; recordNumber <= maxRecord; recordNumber += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const record = await api.getRecord(recordNumber);
        const serialized = serializeDoorLockLogRecord(device, record, recordNumber);
        if (serialized) {
          records.push(serialized);
        }
      } catch (error) {
        this.log('warn', 'zwave', 'Unable to read Z-Wave door lock audit record', {
          deviceId: device?._id?.toString?.() || null,
          nodeId: node?.id || null,
          recordNumber,
          error: error.message
        });
        break;
      }
    }

    return records;
  }

  async readHomeBrainLockAudit(device, node, options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 25));
    if (EventStreamEvent.db?.readyState !== 1) {
      return [];
    }

    const deviceId = device?._id?.toString?.() || String(device?._id || '');
    const nodeId = normalizeLockCodeSlot(node?.id || device?.properties?.homebrainDirect?.nodeId);
    const query = {
      category: 'security',
      type: { $in: ['lock_code.used', 'lock.state_event', 'lock_code.added', 'lock_code.modified', 'lock_code.deleted', 'lock_code.set'] },
      $or: [
        { 'payload.deviceId': deviceId },
        ...(nodeId ? [{ 'payload.nodeId': nodeId }] : [])
      ]
    };

    const docs = await EventStreamEvent.find(query)
      .sort({ createdAt: -1 })
      .limit(limit);

    return docs.map((doc) => {
      const event = typeof doc.toObject === 'function' ? doc.toObject() : doc;
      const payload = event.payload || {};
      return {
        id: event._id?.toString?.() || String(event._id || ''),
        source: 'homebrain',
        type: event.type,
        action: payload.action || 'unknown',
        label: payload.label || event.type,
        slot: normalizeLockCodeSlot(payload.slot),
        codeName: payload.codeName || (payload.slot ? codeNameForSlot(device, payload.slot) : null),
        actor: payload.actor || null,
        createdAt: event.createdAt || null
      };
    }).reverse();
  }

  async getLockCodeState(deviceId, options = {}) {
    const { device, node, accessControl } = await this.getNativeZWaveLockContext(deviceId);
    const capabilities = getZWaveLockCodeCapabilities(node, accessControl);
    const slots = await this.readZWaveLockUsers(device, accessControl, {
      refresh: options.refresh === true
    });
    const maxSlots = capabilities.maxSlots || Math.max(0, ...slots.map((slot) => slot.slot));
    const occupied = new Set(slots.map((slot) => slot.slot));

    return {
      deviceId: device._id?.toString?.() || String(device._id || ''),
      deviceName: device.name,
      nodeId: normalizeLockCodeSlot(node.id),
      native: true,
      capabilities: {
        ...capabilities,
        maxSlots
      },
      slots,
      availableSlots: Array.from({ length: maxSlots }, (_value, index) => index + 1)
        .filter((slot) => !occupied.has(slot))
    };
  }

  async setLockCode(deviceId, payload = {}, options = {}) {
    const { device, node, accessControl } = await this.getNativeZWaveLockContext(deviceId);
    const capabilities = getZWaveLockCodeCapabilities(node, accessControl);
    const zwave = require('zwave-js');
    const slot = normalizeLockCodeSlot(payload.slot || payload.userId);
    if (!slot || (capabilities.maxSlots > 0 && slot > capabilities.maxSlots)) {
      throw new Error(`Lock code slot must be between 1 and ${capabilities.maxSlots || 'the supported slot count'}.`);
    }

    const name = normalizeLockCodeName(payload.name, `Code ${slot}`);
    const enabled = payload.enabled !== false;
    const pinProvided = trimString(payload.pin).length > 0;

    if (pinProvided) {
      const pin = normalizeLockPin(payload.pin, capabilities);
      if (capabilities.supportsNames) {
        await accessControl.setUser(slot, { active: true, userName: name });
      }
      const credentialResult = await accessControl.setCredential(
        slot,
        zwave.UserCredentialType.PINCode,
        slot,
        pin
      );
      if (!operationSucceeded(credentialResult, zwave.SetCredentialResult.OK)) {
        throw new Error(`Lock rejected PIN update: ${enumLabel(zwave.SetCredentialResult, credentialResult, 'unknown')}`);
      }
    }

    if (typeof accessControl.setUser === 'function' && (pinProvided || Object.prototype.hasOwnProperty.call(payload, 'enabled') || capabilities.supportsNames)) {
      const userResult = await accessControl.setUser(slot, {
        active: enabled,
        ...(capabilities.supportsNames ? { userName: name } : {})
      });
      if (!operationSucceeded(userResult, zwave.SetUserResult.OK)) {
        throw new Error(`Lock rejected user update: ${enumLabel(zwave.SetUserResult, userResult, 'unknown')}`);
      }
    }

    const now = new Date().toISOString();
    const actor = trimString(options.actor || payload.actor) || 'unknown';
    await Device.updateOne(
      { _id: device._id },
      {
        $set: {
          [`properties.lockCodes.assignments.${slot}`]: {
            name,
            enabled,
            source: 'homebrain',
            updatedAt: now,
            updatedBy: actor
          },
          'properties.lockCodes.lastManagedAt': now,
          'properties.lockCodes.lastManagedBy': actor
        }
      }
    );

    await this.publishZWaveLockCodeEvent(node, {
      type: 'lock_code.set',
      action: pinProvided ? 'code_set' : 'code_named',
      userId: slot,
      label: pinProvided ? 'Lock PIN set' : 'Lock PIN label updated',
      actor,
      source: 'homebrain'
    });

    return this.getLockCodeState(deviceId, { refresh: false });
  }

  async deleteLockCode(deviceId, slotValue, options = {}) {
    const { device, node, accessControl } = await this.getNativeZWaveLockContext(deviceId);
    const slot = normalizeLockCodeSlot(slotValue);
    if (!slot) {
      throw new Error('Lock code slot is required');
    }

    const zwave = require('zwave-js');
    const result = await accessControl.deleteUser(slot);
    if (!operationSucceeded(result, zwave.SetUserResult.OK)) {
      throw new Error(`Lock rejected PIN deletion: ${enumLabel(zwave.SetUserResult, result, 'unknown')}`);
    }

    const now = new Date().toISOString();
    const actor = trimString(options.actor) || 'unknown';
    await Device.updateOne(
      { _id: device._id },
      {
        $unset: {
          [`properties.lockCodes.assignments.${slot}`]: ''
        },
        $set: {
          'properties.lockCodes.lastManagedAt': now,
          'properties.lockCodes.lastManagedBy': actor
        }
      }
    );

    await this.publishZWaveLockCodeEvent(node, {
      type: 'lock_code.deleted',
      action: 'code_deleted',
      userId: slot,
      label: 'Lock PIN deleted',
      actor,
      source: 'homebrain'
    });

    return this.getLockCodeState(deviceId, { refresh: false });
  }

  async getLockCodeAudit(deviceId, options = {}) {
    const { device, node } = await this.getNativeZWaveLockContext(deviceId);
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    const [homebrain, lock] = await Promise.all([
      this.readHomeBrainLockAudit(device, node, { limit }),
      options.includeDeviceLog === false
        ? Promise.resolve([])
        : this.readZWaveLockAuditFromDevice(device, node, { limit })
    ]);

    return {
      deviceId: device._id?.toString?.() || String(device._id || ''),
      deviceName: device.name,
      nodeId: normalizeLockCodeSlot(node.id),
      events: [...homebrain, ...lock]
        .filter((event) => event && event.createdAt)
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        .slice(0, limit)
    };
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

  async readZigbeeOnOffState(endpoint, device) {
    if (!endpoint) {
      return undefined;
    }

    if (typeof endpoint.read === 'function') {
      try {
        const response = await withTimeout(
          endpoint.read('genOnOff', ['onOff']),
          5_000,
          'Zigbee on/off readback timed out'
        );
        const status = extractZigbeeOnOffReadResponse(response);
        if (status !== undefined) {
          return status;
        }
      } catch (error) {
        this.log('warn', 'zigbee', 'Zigbee on/off readback failed after command', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          error: error.message
        });
      }
    }

    return normalizeZigbeeSwitchState(readZigbeeEndpointAttribute(
      endpoint,
      ['genOnOff', 'genonoff', 6],
      ['onOff', 'onoff', 'state']
    ));
  }

  async readZigbeeBrightnessState(endpoint, device) {
    if (!endpoint) {
      return undefined;
    }

    if (typeof endpoint.read === 'function') {
      try {
        const response = await withTimeout(
          endpoint.read('genLevelCtrl', ['currentLevel']),
          5_000,
          'Zigbee brightness readback timed out'
        );
        const brightness = extractZigbeeBrightnessReadResponse(response);
        if (brightness !== undefined) {
          return brightness;
        }
      } catch (error) {
        this.log('warn', 'zigbee', 'Zigbee brightness readback failed after command', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          error: error.message
        });
      }
    }

    return normalizeZigbeePercent(readZigbeeEndpointAttribute(
      endpoint,
      ['genLevelCtrl', 'genlevelctrl', 8],
      ['currentLevel', 'current_level']
    ), 'level');
  }

  async readZigbeeColorTemperatureState(endpoint, device) {
    if (!endpoint) {
      return undefined;
    }

    if (typeof endpoint.read === 'function') {
      try {
        const response = await withTimeout(
          endpoint.read('lightingColorCtrl', ['colorTemperature']),
          5_000,
          'Zigbee color temperature readback timed out'
        );
        const colorTemperature = extractZigbeeColorTemperatureReadResponse(response);
        if (colorTemperature !== undefined) {
          return colorTemperature;
        }
      } catch (error) {
        this.log('warn', 'zigbee', 'Zigbee color temperature readback failed after command', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          error: error.message
        });
      }
    }

    return normalizeZigbeeColorTemperatureKelvin(readZigbeeEndpointAttribute(
      endpoint,
      ['lightingColorCtrl', 'lightingcolorctrl', 768],
      ['colorTemperature', 'colorTemperatureMireds', 'colorTemp', 'colortemp', 'color_temp']
    ));
  }

  async controlZigbeeDevice(device, normalizedAction, commandValue, updateData = {}) {
    const zigbeeDevice = this.getDirectNodeForDevice(device);
    const endpoint = readZigbeeEndpoint(zigbeeDevice, normalizedAction);
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
        await withTimeout(
          endpoint.command('genOnOff', command, {}),
          10_000,
          'Zigbee on/off command timed out before the device acknowledged it'
        );
        const observedStatus = await this.readZigbeeOnOffState(endpoint, device);
        if (observedStatus !== undefined) {
          updateData.status = observedStatus;
        }
        this.log('info', 'zigbee', 'Zigbee on/off command readback completed', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          action: normalizedAction,
          expectedStatus: command === 'toggle' ? null : command === 'on',
          observedStatus: observedStatus ?? null
        });
        break;
      }
      case 'setbrightness': {
        const level = Math.round((Math.max(0, Math.min(100, Number(commandValue))) / 100) * 254);
        await withTimeout(
          endpoint.command('genLevelCtrl', 'moveToLevelWithOnOff', { level, transtime: 0 }),
          10_000,
          'Zigbee brightness command timed out before the device acknowledged it'
        );
        const observedBrightness = await this.readZigbeeBrightnessState(endpoint, device);
        if (observedBrightness !== undefined) {
          updateData.brightness = observedBrightness;
          updateData.status = observedBrightness > 0;
        }
        this.log('info', 'zigbee', 'Zigbee brightness command readback completed', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          expectedBrightness: Math.max(0, Math.min(100, Number(commandValue))),
          observedBrightness: observedBrightness ?? null
        });
        break;
      }
      case 'setcolor': {
        const rgb = hexToRgbPercent(commandValue);
        if (!rgb) throw new Error('Color value must be a valid hex color string');
        await withTimeout(
          endpoint.command('lightingColorCtrl', 'moveToColor', {
            colorx: Math.round((rgb.red / 255) * 65279),
            colory: Math.round((rgb.green / 255) * 65279),
            transtime: 0
          }),
          10_000,
          'Zigbee color command timed out before the device acknowledged it'
        );
        break;
      }
      case 'setcolortemperature': {
        const colortemp = kelvinToMired(commandValue);
        if (!colortemp) throw new Error('Color temperature must be a valid kelvin value');
        await withTimeout(
          endpoint.command('lightingColorCtrl', 'moveToColorTemp', { colortemp, transtime: 0 }),
          10_000,
          'Zigbee color temperature command timed out before the device acknowledged it'
        );
        const observedColorTemperature = await this.readZigbeeColorTemperatureState(endpoint, device);
        updateData.colorTemperature = observedColorTemperature ?? Math.round(Number(commandValue));
        updateData.status = true;
        this.log('info', 'zigbee', 'Zigbee color temperature command readback completed', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          expectedColorTemperature: Math.round(Number(commandValue)),
          observedColorTemperature: observedColorTemperature ?? null
        });
        break;
      }
      case 'lock':
        await withTimeout(
          endpoint.command('closuresDoorLock', 'lockDoor', {}),
          10_000,
          'Zigbee lock command timed out before the device acknowledged it'
        );
        break;
      case 'unlock':
        await withTimeout(
          endpoint.command('closuresDoorLock', 'unlockDoor', {}),
          10_000,
          'Zigbee unlock command timed out before the device acknowledged it'
        );
        break;
      case 'alarmoff':
      case 'turnoffalarm':
      case 'silencealarm': {
        await withTimeout(
          endpoint.command('genOnOff', 'off', {}),
          10_000,
          'Zigbee alarm off command timed out before the device acknowledged it'
        );
        const observedStatus = await this.readZigbeeOnOffState(endpoint, device);
        updateData.status = observedStatus ?? false;
        break;
      }
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

  normalizeSirenVolumeCommand(device, rawValue) {
    const parameter = getSirenVolumeConfigParameterFromCatalog(device?.properties?.directRadioCatalog);
    const value = resolveSirenVolumeValue(rawValue, parameter);
    return {
      value,
      parameter,
      options: parameter ? getSirenVolumeOptionsFromParameter(parameter) : []
    };
  }

  normalizeSirenSoundCommand(device, rawValue) {
    const parameter = getSirenSoundConfigParameterFromCatalog(device?.properties?.directRadioCatalog);
    const value = resolveSirenSoundValue(rawValue, parameter);
    return {
      value,
      parameter,
      options: parameter ? getSirenSoundOptionsFromParameter(parameter) : []
    };
  }

  isSirenLikeDirectDevice(device) {
    const features = Array.isArray(device?.properties?.directRadioFeatures)
      ? device.properties.directRadioFeatures.map(normalizeFeature)
      : [];
    const descriptor = [
      device?.type,
      device?.name,
      device?.brand,
      device?.model
    ].map((entry) => trimString(entry).toLowerCase()).filter(Boolean).join(' ');
    return device?.type === 'siren'
      || device?.properties?.supportsAlarm === true
      || features.includes('alarm')
      || features.includes('chime')
      || /\b(?:siren|alarm|sounder|chime)\b/.test(descriptor);
  }

  supportsSirenVolumeControl(device) {
    const protocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol)
      || (normalizeSourceText(device?.properties?.source) === DIRECT_RADIO_SOURCES.zwave ? 'zwave' : '');
    if (protocol !== 'zwave') {
      return false;
    }
    if (!this.isSirenLikeDirectDevice(device)) {
      return false;
    }
    return Boolean(
      getSirenVolumeConfigParameterFromCatalog(device?.properties?.directRadioCatalog)
      || device?.properties?.supportsSirenVolume === true
    );
  }

  supportsSirenSoundControl(device) {
    const protocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol)
      || (normalizeSourceText(device?.properties?.source) === DIRECT_RADIO_SOURCES.zwave ? 'zwave' : '');
    if (protocol !== 'zwave') {
      return false;
    }
    if (!this.isSirenLikeDirectDevice(device)) {
      return false;
    }
    return Boolean(
      getSirenSoundConfigParameterFromCatalog(device?.properties?.directRadioCatalog)
      || device?.properties?.supportsSirenSound === true
    );
  }

  async setZWaveSirenVolume(device, node, rawValue, updateData = {}) {
    const zwave = require('zwave-js');
    const command = this.normalizeSirenVolumeCommand(device, rawValue);

    if (command.parameter) {
      await this.setZWaveValue(
        node,
        zwave.ConfigurationCCValues.paramInformation(
          normalizeInteger(command.parameter.parameter),
          normalizeInteger(command.parameter.valueBitMask) ?? undefined
        ),
        command.value
      );
    } else if (hasZWaveValue(node, zwave.SoundSwitchCCValues.volume)) {
      await this.setZWaveValue(node, zwave.SoundSwitchCCValues.volume, command.value);
    } else {
      throw new Error('Siren volume control is not available for this Z-Wave device');
    }

    updateData.properties = {
      ...(device?.properties && typeof device.properties === 'object' ? device.properties : {}),
      ...(updateData.properties && typeof updateData.properties === 'object' ? updateData.properties : {}),
      supportsSirenVolume: true,
      sirenVolume: command.value,
      ...(command.options.length > 0 ? { sirenVolumeOptions: command.options } : {})
    };
  }

  async setZWaveSirenSound(device, node, rawValue, updateData = {}) {
    const zwave = require('zwave-js');
    const command = this.normalizeSirenSoundCommand(device, rawValue);

    if (command.parameter) {
      await this.setZWaveValue(
        node,
        zwave.ConfigurationCCValues.paramInformation(
          normalizeInteger(command.parameter.parameter),
          normalizeInteger(command.parameter.valueBitMask) ?? undefined
        ),
        command.value
      );
    } else if (hasZWaveValue(node, zwave.SoundSwitchCCValues.defaultToneId)) {
      await this.setZWaveValue(node, zwave.SoundSwitchCCValues.defaultToneId, command.value);
    } else {
      throw new Error('Siren sound control is not available for this Z-Wave device');
    }

    updateData.properties = {
      ...(device?.properties && typeof device.properties === 'object' ? device.properties : {}),
      ...(updateData.properties && typeof updateData.properties === 'object' ? updateData.properties : {}),
      supportsSirenSound: true,
      sirenSound: command.value,
      ...(command.options.length > 0 ? { sirenSoundOptions: command.options } : {})
    };
  }

  async controlZWaveDevice(device, normalizedAction, commandValue, updateData = {}) {
    const node = this.getDirectNodeForDevice(device);
    if (!isZWaveNodeCommandReady(node)) {
      throw new Error('Z-Wave node is not ready');
    }
    let effectiveAction = normalizedAction;
    if (device?.type === 'lock') {
      if (normalizedAction === 'turnon') {
        effectiveAction = 'lock';
      } else if (normalizedAction === 'turnoff') {
        effectiveAction = 'unlock';
      } else if (normalizedAction === 'toggle') {
        effectiveAction = device?.status ? 'unlock' : 'lock';
      }
    }
    const zwave = require('zwave-js');
    this.log('info', 'zwave', 'Sending Z-Wave device command', {
      deviceId: device?._id?.toString?.() || null,
      name: device?.name || null,
      nodeId: device?.properties?.homebrainDirect?.nodeId || null,
      action: effectiveAction,
      requestedAction: normalizedAction === effectiveAction ? undefined : normalizedAction,
      value: commandValue ?? null
    });

    switch (effectiveAction) {
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
      case 'setsirenvolume':
        await this.setZWaveSirenVolume(device, node, commandValue, updateData);
        break;
      case 'setsirensound':
        await this.setZWaveSirenSound(device, node, commandValue, updateData);
        break;
      case 'alarmoff':
      case 'turnoffalarm':
      case 'silencealarm':
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
      action: effectiveAction
    });
  }

  async refreshDirectDeviceState(device, options = {}) {
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
    if (!normalized?.update) {
      return null;
    }

    const merged = mergeDirectDeviceUpdateForExisting(device, normalized.update);
    const commandState = options?.preserveCommandState && typeof options.preserveCommandState === 'object'
      ? options.preserveCommandState
      : null;
    if (commandState) {
      if (!Object.prototype.hasOwnProperty.call(normalized.update, 'status')
        && Object.prototype.hasOwnProperty.call(commandState, 'status')) {
        merged.status = commandState.status;
      }
      if (!Object.prototype.hasOwnProperty.call(normalized.update, 'brightness')
        && Object.prototype.hasOwnProperty.call(commandState, 'brightness')) {
        merged.brightness = commandState.brightness;
      }
      if (!Object.prototype.hasOwnProperty.call(normalized.update, 'color')
        && Object.prototype.hasOwnProperty.call(commandState, 'color')) {
        merged.color = commandState.color;
      }
      if (!Object.prototype.hasOwnProperty.call(normalized.update, 'colorTemperature')
        && Object.prototype.hasOwnProperty.call(commandState, 'colorTemperature')) {
        merged.colorTemperature = commandState.colorTemperature;
      }
      const commandProperties = commandState.properties && typeof commandState.properties === 'object'
        ? commandState.properties
        : null;
      if (commandProperties) {
        merged.properties = merged.properties && typeof merged.properties === 'object'
          ? merged.properties
          : {};
        const normalizedProperties = normalized.update.properties && typeof normalized.update.properties === 'object'
          ? normalized.update.properties
          : {};
        ['supportsSirenVolume', 'sirenVolume', 'sirenVolumeOptions', 'supportsSirenSound', 'sirenSound', 'sirenSoundOptions'].forEach((key) => {
          if (!Object.prototype.hasOwnProperty.call(normalizedProperties, key)
            && Object.prototype.hasOwnProperty.call(commandProperties, key)) {
            merged.properties[key] = commandProperties[key];
          }
        });
      }
    }

    return merged;
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
    await this.reconcileActiveZWavePairingFromController().catch((error) => {
      this.log('warn', 'zwave', 'Unable to reconcile active Z-Wave pairing from controller nodes', {
        error: error.message
      });
    });

    const zigbeeDevices = this.zigbee.controller?.getDevices?.() || [];
    const zwaveNodes = this.getZWaveController()?.nodes;
    const activeMigrations = Array.from(this.activeMigrations.values())
      .filter((migration) => (
        ['awaiting_smartthings_exclusion', 'excluding', 'excluded', 'pairing', 'exclusion_failed', 'pairing_failed'].includes(migration.status)
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
          inclusionState: this.getZWaveInclusionStateLabel(),
          pendingDsk: this.zwave.pendingDsk,
          pairedNodeCount: zwaveNodes && typeof zwaveNodes.size === 'number' ? zwaveNodes.size : 0,
          nodes: this.getZWaveNodeSummaries()
        }
      },
      pairings: {
        zigbee: this.serializePairingSession(this.activePairings.get('zigbee')),
        zwave: this.serializePairingSession(this.activePairings.get('zwave'))
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
  inferFeaturesFromZigbeeDefinition,
  getSirenVolumeConfigParameterFromCatalog,
  getSirenVolumeOptionsFromParameter,
  isDuplicateDirectRadioRecord,
  isZWaveNodeCommandReady,
  isZWaveNodeOnline,
  looksLikeSonoffMg24ThreadStick,
  mergeSmartThingsTelemetryFallback,
  mergeDirectDeviceUpdateForExisting,
  normalizeSerialPort,
  selectPrimaryDirectDeviceRecord,
  scoreDetachedSmartThingsMigrationSource,
  scorePortForProtocol
};

module.exports = directRadioService;

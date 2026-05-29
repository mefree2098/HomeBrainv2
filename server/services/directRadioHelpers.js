'use strict';

// Module-level helpers + constants for the native radio engine, extracted
// from directRadioService.js (Phase 5b full decomposition).

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const mongoose = require('mongoose');
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
const {
  resolveLocalSerialById,
  resolveRealPath,
  buildFallbackSerialPort,
  hasPortCandidate,
  listFallbackSerialDevicePaths,
  addFallbackSerialPortCandidates,
  normalizeSerialPort,
  serialDescriptorSearchText,
  enrichSerialPortForDirectRadios,
  looksLikeSonoffMg24ThreadStick,
  scorePortForProtocol,
  choosePortForProtocol,
  describeSerialEndpoints
} = require('./directRadio/serialPorts');
const {
  toFiniteNumber,
  clampPercent,
  normalizeZWaveBatteryReport,
  hexToRgbPercent,
  kelvinToMired,
  miredToKelvin,
  roundTo,
  celsiusToFahrenheit
} = require('./directRadio/conversions');

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

function countTokenOverlap(left, right) {
  if (!(left instanceof Set) || !(right instanceof Set) || left.size === 0 || right.size === 0) {
    return 0;
  }

  let overlap = 0;
  left.forEach((token) => {
    if (right.has(token)) {
      overlap += 1;
    }
  });
  return overlap;
}

function filterStrongMigrationTokens(tokens) {
  const weakTokens = new Set([
    'battery',
    'closed',
    'contact',
    'generic',
    'open',
    'sensor',
    'smartthings',
    'zw',
    'zwave',
    'wave',
    'z'
  ]);

  return new Set(Array.from(tokens || [])
    .map((token) => trimString(token).toLowerCase())
    .filter((token) => token && !weakTokens.has(token) && !/^\d+$/.test(token)));
}

function hasManufacturerIdentityMatch(directManufacturer, sourceManufacturer) {
  const direct = normalizeSourceText(directManufacturer);
  const source = normalizeSourceText(sourceManufacturer);
  if (!direct || !source || source.includes('smartthings')) {
    return false;
  }
  return direct === source || direct.includes(source) || source.includes(direct);
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

function protocolSource(protocol) {
  return protocol === 'zigbee' ? DIRECT_RADIO_SOURCES.zigbee : DIRECT_RADIO_SOURCES.zwave;
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

function endpointHasZigbeeCluster(endpoint, clusterCandidates = []) {
  const endpointClusters = collectZigbeeEndpointClusterTokens(endpoint);
  return clusterCandidates
    .map(normalizeZigbeeClusterToken)
    .some((cluster) => cluster && endpointClusters.has(cluster));
}

function readZigbeeAttributeFromResponse(response, attributeCandidates = []) {
  if (!response || typeof response !== 'object') {
    return undefined;
  }

  for (const attribute of attributeCandidates) {
    if (response[attribute] !== undefined && response[attribute] !== null) {
      return response[attribute];
    }
    const normalized = normalizeSourceText(attribute);
    if (response[normalized] !== undefined && response[normalized] !== null) {
      return response[normalized];
    }
  }

  return undefined;
}

async function readZigbeeLiveSensorState(zigbeeDevice, options = {}) {
  const endpoints = getZigbeeEndpoints(zigbeeDevice)
    .filter((endpoint) => endpointHasZigbeeCluster(endpoint, ['ssIasZone', 'ssiaszone', 1280]));
  if (endpoints.length === 0) {
    return {};
  }

  const timeoutMs = Number(options.timeoutMs || process.env.HOMEBRAIN_ZIGBEE_SENSOR_READ_TIMEOUT_MS || 2500);
  for (const endpoint of endpoints) {
    if (typeof endpoint?.read !== 'function') {
      continue;
    }
    try {
      const response = await withTimeout(
        endpoint.read('ssIasZone', ['zoneStatus'], { sendPolicy: 'immediate' }),
        timeoutMs,
        'Timed out reading Zigbee IAS zone status'
      );
      const zoneStatus = readZigbeeAttributeFromResponse(response, ['zoneStatus', 'zonestatus']);
      if (zoneStatus !== undefined && zoneStatus !== null) {
        return { zoneStatus };
      }
    } catch (_error) {
      // Sleepy IAS devices are only readable during their brief awake/check-in window.
    }
  }

  return {};
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
  if (options.liveSensorState?.zoneStatus !== undefined && options.liveSensorState?.zoneStatus !== null) {
    applyZoneStatusToDirectState(directState, options.liveSensorState.zoneStatus, options.features);
  }
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
  const directNameTokens = filterStrongMigrationTokens(normalizeMigrationNameTokens(
    directDevice.name,
    directDevice.properties?.homebrainDirect?.generatedName
  ));
  const sourceNameTokens = filterStrongMigrationTokens(normalizeMigrationNameTokens(
    sourceDevice.name,
    sourceProperties.smartThingsLabel
  ));
  const directIdentityTokens = filterStrongMigrationTokens(normalizeMigrationNameTokens(
    directDevice.brand,
    directDevice.model,
    directDevice.properties?.homebrainDirect?.manufacturerName,
    directDevice.properties?.homebrainDirect?.modelID,
    directDevice.properties?.homebrainDirect?.generatedName
  ));
  const sourceIdentityTokens = filterStrongMigrationTokens(normalizeMigrationNameTokens(
    sourceDevice.brand,
    sourceDevice.model,
    sourceProperties.smartThingsManufacturer,
    sourceProperties.smartThingsDeviceTypeName,
    sourceProperties.smartThingsDeviceName
  ));
  const directManufacturer = normalizeSourceText(directDevice.brand || directDevice.properties?.homebrainDirect?.manufacturerName);
  const sourceManufacturer = normalizeSourceText(sourceProperties.smartThingsManufacturer || sourceDevice.brand);
  const nameEvidence = countTokenOverlap(directNameTokens, sourceNameTokens);
  const identityEvidence = countTokenOverlap(directIdentityTokens, sourceIdentityTokens);
  const manufacturerEvidence = hasManufacturerIdentityMatch(directManufacturer, sourceManufacturer);
  if (nameEvidence === 0 && !(manufacturerEvidence && identityEvidence >= 2)) {
    return -Infinity;
  }

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

  if (manufacturerEvidence) {
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

module.exports = {
  DATA_DIR,
  ZIGBEE_DIR,
  ZWAVE_DIR,
  CONFIG_PATH,
  DEFAULT_PAIRING_SECONDS,
  MAX_PAIRING_SECONDS,
  DEFAULT_HARDWARE_SCAN_INTERVAL_MS,
  DIRECT_DEVICE_PROJECTION,
  ZWAVE_NODE_STATUS,
  trimString,
  normalizeZWaveStatus,
  isZWaveStatusUnavailable,
  isZWaveNodeOnline,
  isZWaveNodeCommandReady,
  isTerminalPairingStatus,
  isZWavePairingCompletionReason,
  buildDirectDeviceQuery,
  isZWaveDirectUpdateInterviewComplete,
  normalizeDirectRoom,
  shouldReplaceGeneratedDirectName,
  shouldReplaceGeneratedDirectRoom,
  inferFeaturesFromExistingDirectRecord,
  mergeDirectDeviceUpdateForExisting,
  directFeatureCount,
  directRecordTimestamp,
  isGenericDirectRadioName,
  isIncompleteDirectRadioDuplicate,
  directRecordMatchesIdentity,
  isDuplicateDirectRadioRecord,
  selectPrimaryDirectDeviceRecord,
  parseEnabledFlag,
  boundedSeconds,
  boundedIntervalMs,
  delay,
  enumMemberName,
  getNumericNodeId,
  parseOptionalBoolean,
  normalizeZWaveSecurityMode,
  shouldUseSecureZWaveMigration,
  uniqueStrings,
  normalizeSourceText,
  getDeviceIdString,
  getDeviceProperties,
  toPlainDeviceSnapshot,
  getSmartThingsMigration,
  isRetiredSmartThingsMigrationSource,
  normalizeMigrationNameTokens,
  scoreTokenOverlap,
  countTokenOverlap,
  filterStrongMigrationTokens,
  hasManufacturerIdentityMatch,
  smartThingsNetworkTypeMatchesProtocol,
  readSmartThingsBatteryLevel,
  readSmartThingsTemperatureF,
  copySmartThingsHistoryProperties,
  mergeSmartThingsTelemetryFallback,
  normalizeSmartThingsState,
  isSmartThingsDeviceGoneError,
  getSmartThingsHubId,
  getSmartThingsProvisioningState,
  isSmartThingsUnprovisionedState,
  getNewestSmartThingsTimestamp,
  summarizeSmartThingsExclusionEvidence,
  collectSmartThingsExclusionCounters,
  findSmartThingsExclusionCounterIncrease,
  normalizeObjectId,
  ensureDirSync,
  readJsonFile,
  writeJsonFile,
  randomByteArray,
  randomHex,
  protocolSource,
  withTimeout,
  ZIGBEE_COMMON_ENDPOINT_IDS,
  getZigbeeEndpointId,
  collectZigbeeEndpointClusterTokens,
  getZigbeeEndpoints,
  getZigbeeClusterPreferenceForAction,
  scoreZigbeeEndpoint,
  readZigbeeEndpoint,
  readZigbeeEndpointAttribute,
  endpointHasZigbeeCluster,
  readZigbeeAttributeFromResponse,
  readZigbeeLiveSensorState,
  normalizeZigbeeSwitchState,
  normalizeZigbeePercent,
  normalizeZigbeeActiveState,
  normalizeZigbeeContactOpen,
  normalizeZigbeeBatteryPercent,
  normalizeZigbeeBatteryVoltage,
  looksLikeBatteryVoltage,
  normalizeZigbeeBatteryVoltageFromState,
  inferZigbeeBatteryPercentFromVoltage,
  fillBatteryPercentFromVoltage,
  coerceZigbeeNumericValue,
  normalizeZigbeeScaledNumber,
  normalizeZigbeePowerWatts,
  normalizeZigbeeEnergyKwh,
  normalizeZigbeeVoltageVolts,
  normalizeZigbeeCurrentAmps,
  normalizeZigbeeTemperatureC,
  normalizeZigbeeHumidityPercent,
  normalizeZigbeeIlluminanceLux,
  normalizeZigbeeColorTemperatureKelvin,
  readZigbeeStateObjectValue,
  assignDefined,
  assignDefinedIfMissing,
  readZigbeeMessageData,
  hasDirectFeature,
  applyZoneStatusToDirectState,
  extractZigbeeMessageState,
  mergeDirectState,
  readZigbeeStateObject,
  readZigbeeEndpointSensorAttributes,
  directStateToTopLevel,
  inferFeaturesFromDirectRadioState,
  readZigbeeDirectRadioState,
  readZigbeeRuntimeState,
  scoreDetachedSmartThingsMigrationSource,
  buildRecoveredSmartThingsMigrationSnapshot,
  extractZigbeeOnOffReadResponse,
  extractZigbeeBrightnessReadResponse,
  extractZigbeeColorTemperatureReadResponse,
  normalizeZigbeeClusterToken,
  collectZigbeeClusterTokens,
  extractZigbeeDefinition,
  inferFeaturesFromZigbeeDefinition,
  getZWaveValue,
  valueMetadataLabel,
  findZWaveValueByLabel,
  normalizeNumber,
  normalizeInteger,
  normalizeCatalogVolumeOptions,
  normalizeCatalogSoundOptions,
  isSirenVolumeParameter,
  isSirenSoundParameter,
  getSirenVolumeConfigParameterFromCatalog,
  getSirenSoundConfigParameterFromCatalog,
  getSirenVolumeOptionsFromParameter,
  getSirenSoundOptionsFromParameter,
  getSirenVolumeRangeFromParameter,
  getSirenSoundRangeFromParameter,
  resolveSirenVolumeValue,
  resolveSirenSoundValue,
  buildSirenVolumeProperties,
  buildSirenSoundProperties,
  hasZWaveValue,
  normalizeLockCodeSlot,
  normalizeLockCodeName,
  normalizeLockPin,
  enumLabel,
  operationSucceeded,
  getLockCodeAssignments,
  getAssignmentForSlot,
  getZWaveAccessControl,
  getZWaveLockCodeCapabilities,
  codeNameForSlot,
  lockEventActionFromLabel,
  extractLockUserId,
  serializeLockCodeSlot,
  serializeDoorLockLogRecord
};

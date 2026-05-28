const fs = require('fs');
const path = require('path');
const {
  buildFeatureSupport,
  buildNormalizedCapabilities,
  normalizeFeature
} = require('./directRadioDeviceCatalog');

const ZIGBEE_PACKAGE = 'zigbee-herdsman-converters';
const ZWAVE_CONFIG_PACKAGE = '@zwave-js/config';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10_000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map(trimString).filter(Boolean)));
}

function normalizeLookupKey(value) {
  return trimString(value).toLowerCase();
}

function readPackageInfo(packageName) {
  try {
    const packagePath = require.resolve(`${packageName}/package.json`);
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return {
      name: packageJson.name || packageName,
      version: packageJson.version || null,
      packagePath,
      packageDir: path.dirname(packagePath)
    };
  } catch (error) {
    return {
      name: packageName,
      version: null,
      packagePath: null,
      packageDir: null,
      error: error.message
    };
  }
}

function parseLimit(value, fallback = DEFAULT_LIMIT) {
  if (String(value || '').trim().toLowerCase() === 'all') {
    return MAX_LIMIT;
  }

  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(MAX_LIMIT, parsed);
}

function parseBoolean(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function sanitizeValue(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (depth >= 6) {
    return undefined;
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeValue(entry, depth + 1, seen))
      .filter((entry) => entry !== undefined);
  }
  if (value instanceof Map) {
    return Array.from(value.entries())
      .map(([key, entry]) => ({
        key: sanitizeValue(key, depth + 1, seen),
        value: sanitizeValue(entry, depth + 1, seen)
      }))
      .filter((entry) => entry.value !== undefined);
  }

  const result = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (typeof entry === 'function' || typeof entry === 'symbol') {
      return;
    }
    const sanitized = sanitizeValue(entry, depth + 1, seen);
    if (sanitized !== undefined) {
      result[key] = sanitized;
    }
  });
  seen.delete(value);
  return result;
}

function serializeExpose(expose) {
  if (!expose || typeof expose !== 'object') {
    return null;
  }

  const keys = [
    'type',
    'name',
    'label',
    'property',
    'access',
    'endpoint',
    'category',
    'description',
    'unit',
    'value_on',
    'value_off',
    'value_toggle',
    'value_min',
    'value_max',
    'value_step',
    'presets',
    'values'
  ];
  const output = {};
  keys.forEach((key) => {
    if (expose[key] !== undefined) {
      output[key] = sanitizeValue(expose[key]);
    }
  });
  if (Array.isArray(expose.features)) {
    output.features = expose.features.map(serializeExpose).filter(Boolean);
  }
  return output;
}

function converterName(converter) {
  if (!converter || typeof converter !== 'object') {
    return null;
  }
  return trimString(converter.name)
    || trimString(converter.cluster)
    || trimString(converter.type)
    || trimString(converter.constructor?.name)
    || null;
}

function serializeFromZigbeeConverter(converter) {
  if (!converter || typeof converter !== 'object') {
    return null;
  }
  return {
    name: converterName(converter),
    cluster: trimString(converter.cluster) || null,
    type: toArray(converter.type).map(trimString).filter(Boolean)
  };
}

function serializeToZigbeeConverter(converter) {
  if (!converter || typeof converter !== 'object') {
    return null;
  }
  return {
    name: converterName(converter),
    keys: toArray(converter.key).flat().map(trimString).filter(Boolean)
  };
}

function addFeature(features, feature) {
  const normalized = normalizeFeature(feature);
  if (normalized) {
    features.add(normalized);
  }
}

function inferZigbeeFeaturesFromExposes(exposes = [], definition = {}) {
  const features = new Set();
  const visitExpose = (expose) => {
    if (!expose || typeof expose !== 'object') {
      return;
    }
    const text = [
      expose.type,
      expose.name,
      expose.property,
      expose.label,
      expose.description,
      expose.unit
    ].map((entry) => trimString(entry).toLowerCase()).filter(Boolean).join(' ');

    if (/\bswitch\b|\bstate\b|\bon[\s_-]?off\b/.test(text)) addFeature(features, 'switch');
    if (/\blight\b/.test(text)) {
      addFeature(features, 'light');
      addFeature(features, 'switch');
    }
    if (/\bbrightness\b|\blevel\b/.test(text)) addFeature(features, 'brightness');
    if (/\bcolor_xy\b|\bcolor_hs\b|\bcolor\b|\brgb\b/.test(text)) addFeature(features, 'color');
    if (/\bcolor[\s_-]?temp\b|\bcolortemp\b/.test(text)) addFeature(features, 'colorTemperature');
    if (/\bcontact\b|\bopen\b|\bclosed\b/.test(text)) addFeature(features, 'contact');
    if (/\bmotion\b|\boccupancy\b|\bpir\b/.test(text)) addFeature(features, 'motion');
    if (/\btemperature\b/.test(text)) addFeature(features, 'temperature');
    if (/\bhumidity\b/.test(text)) addFeature(features, 'humidity');
    if (/\billuminance\b|\blux\b|\bluminance\b/.test(text)) addFeature(features, 'illuminance');
    if (/\bbattery\b|\bbattery_low\b/.test(text)) addFeature(features, 'battery');
    if (/\btamper\b/.test(text)) addFeature(features, 'tamper');
    if (/\bvibration\b/.test(text)) addFeature(features, 'vibration');
    if (/\baccelerat/.test(text)) addFeature(features, 'acceleration');
    if (/\baction\b|\bbutton\b|\bscene\b/.test(text)) addFeature(features, 'button');
    if (/\bwater\b|\bleak\b|\bflood\b/.test(text)) addFeature(features, 'water');
    if (/\bsmoke\b/.test(text)) addFeature(features, 'smoke');
    if (/\bcarbon_monoxide\b|\bcarbon monoxide\b|\bco\b/.test(text)) addFeature(features, 'carbonMonoxide');
    if (/\bpower\b|\bwatt\b/.test(text)) addFeature(features, 'power');
    if (/\benergy\b|\bkwh\b/.test(text)) addFeature(features, 'energy');
    if (/\bvoltage\b/.test(text)) addFeature(features, 'voltage');
    if (/\block\b/.test(text)) addFeature(features, 'lock');
    if (/\bcover\b|\bshade\b|\bblind\b|\bcurtain\b|\bposition\b/.test(text)) addFeature(features, 'cover');
    if (/\bthermostat\b|\bheating\b|\bcooling\b|\bsetpoint\b/.test(text)) addFeature(features, 'thermostat');
    if (/\bfan\b/.test(text)) addFeature(features, 'fan');
    if (/\bvalve\b/.test(text)) addFeature(features, 'valve');
    if (/\bpressure\b/.test(text)) addFeature(features, 'pressure');

    if (Array.isArray(expose.features)) {
      expose.features.forEach(visitExpose);
    }
  };

  exposes.forEach(visitExpose);
  const descriptor = [
    definition.model,
    definition.vendor,
    definition.description,
    ...toArray(definition.zigbeeModel)
  ].map((entry) => trimString(entry).toLowerCase()).filter(Boolean).join(' ');
  if (/\b(?:plug|outlet|socket|relay|switch|repeater|extender)\b/.test(descriptor)) addFeature(features, 'switch');
  if (/\b(?:bulb|lamp|light|led|strip)\b/.test(descriptor)) {
    addFeature(features, 'light');
    addFeature(features, 'switch');
  }
  if (/\b(?:lock|deadbolt)\b/.test(descriptor)) addFeature(features, 'lock');
  if (/\b(?:motion|occupancy|pir)\b/.test(descriptor)) addFeature(features, 'motion');
  if (/\b(?:contact|door|window)\b/.test(descriptor)) addFeature(features, 'contact');
  if (/\b(?:button|remote|fob)\b/.test(descriptor)) addFeature(features, 'button');

  return Array.from(features).sort();
}

function buildZigbeeEntryFromDefinition(definition = {}, options = {}) {
  const packageInfo = options.packageInfo || readPackageInfo(ZIGBEE_PACKAGE);
  const exposes = toArray(definition.exposes).map(serializeExpose).filter(Boolean);
  const homebrainFeatures = inferZigbeeFeaturesFromExposes(exposes, definition);
  const zigbeeModels = uniqueStrings(toArray(definition.zigbeeModel));
  const fingerprints = toArray(definition.fingerprint)
    .map((fingerprint) => sanitizeValue(fingerprint))
    .filter(Boolean);
  const whiteLabels = toArray(definition.whiteLabel)
    .map((whiteLabel) => sanitizeValue(whiteLabel))
    .filter(Boolean);
  const model = trimString(definition.model);
  const vendor = trimString(definition.vendor);

  return {
    protocol: 'zigbee',
    source: ZIGBEE_PACKAGE,
    sourceVersion: packageInfo.version,
    sourceFile: options.sourceFile || null,
    model: model || null,
    vendor: vendor || null,
    description: trimString(definition.description) || null,
    zigbeeModels,
    fingerprints,
    whiteLabels,
    exposes,
    fromZigbee: toArray(definition.fromZigbee).map(serializeFromZigbeeConverter).filter(Boolean),
    toZigbee: toArray(definition.toZigbee).map(serializeToZigbeeConverter).filter(Boolean),
    options: toArray(definition.options).map(serializeExpose).filter(Boolean),
    ota: Boolean(definition.ota),
    meta: sanitizeValue(definition.meta || {}),
    homebrainFeatures,
    featureSupport: buildFeatureSupport(homebrainFeatures, 'zigbee'),
    capabilities: buildNormalizedCapabilities(homebrainFeatures, 'zigbee')
  };
}

function pushIndexed(index, key, entry) {
  const normalized = normalizeLookupKey(key);
  if (!normalized) {
    return;
  }
  if (!index.has(normalized)) {
    index.set(normalized, []);
  }
  index.get(normalized).push(entry);
}

let zigbeeCatalogCache = null;

function loadZigbeeCatalog() {
  if (zigbeeCatalogCache) {
    return zigbeeCatalogCache;
  }

  const packageInfo = readPackageInfo(ZIGBEE_PACKAGE);
  const entries = [];
  const byModel = new Map();
  const byZigbeeModel = new Map();
  const byFingerprintModel = new Map();
  const byVendor = new Map();
  const errors = [];

  if (!packageInfo.packageDir) {
    zigbeeCatalogCache = {
      packageInfo,
      entries,
      byModel,
      byZigbeeModel,
      byFingerprintModel,
      byVendor,
      errors: [packageInfo.error || `${ZIGBEE_PACKAGE} is unavailable`]
    };
    return zigbeeCatalogCache;
  }

  const devicesDir = path.join(packageInfo.packageDir, 'dist', 'devices');
  let converters;
  try {
    converters = require(ZIGBEE_PACKAGE);
  } catch (error) {
    errors.push(error.message);
  }

  fs.readdirSync(devicesDir)
    .filter((fileName) => fileName.endsWith('.js') && fileName !== 'index.js')
    .sort()
    .forEach((fileName) => {
      const filePath = path.join(devicesDir, fileName);
      let definitions = [];
      try {
        definitions = require(filePath).definitions || [];
      } catch (error) {
        errors.push(`${fileName}: ${error.message}`);
        return;
      }

      definitions.forEach((definition) => {
        try {
          const prepared = converters?.prepareDefinition
            ? converters.prepareDefinition(definition)
            : definition;
          const entry = buildZigbeeEntryFromDefinition(prepared, {
            packageInfo,
            sourceFile: fileName
          });
          entries.push(entry);
          pushIndexed(byModel, entry.model, entry);
          pushIndexed(byVendor, entry.vendor, entry);
          entry.zigbeeModels.forEach((model) => pushIndexed(byZigbeeModel, model, entry));
          entry.fingerprints.forEach((fingerprint) => {
            pushIndexed(byFingerprintModel, fingerprint?.modelID, entry);
          });
        } catch (error) {
          errors.push(`${fileName}: ${error.message}`);
        }
      });
    });

  zigbeeCatalogCache = {
    packageInfo,
    entries,
    byModel,
    byZigbeeModel,
    byFingerprintModel,
    byVendor,
    errors
  };
  return zigbeeCatalogCache;
}

function selectBestZigbeeEntry(candidates, input = {}) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length <= 1) {
    return list[0] || null;
  }

  const manufacturer = normalizeLookupKey(input.manufacturerName || input.vendor);
  if (manufacturer) {
    const exact = list.find((entry) => normalizeLookupKey(entry.vendor) === manufacturer);
    if (exact) {
      return exact;
    }
    const fingerprintMatch = list.find((entry) => entry.fingerprints.some((fingerprint) => {
      const fingerprintManufacturer = normalizeLookupKey(fingerprint?.manufacturerName);
      return fingerprintManufacturer && fingerprintManufacturer === manufacturer;
    }));
    if (fingerprintMatch) {
      return fingerprintMatch;
    }
    const contains = list.find((entry) => {
      const vendor = normalizeLookupKey(entry.vendor);
      return vendor && (manufacturer.includes(vendor) || vendor.includes(manufacturer));
    });
    if (contains) {
      return contains;
    }
  }

  return list[0];
}

function findZigbeeCatalogEntry(input = {}) {
  if (input.definition && typeof input.definition === 'object') {
    return buildZigbeeEntryFromDefinition(input.definition, {
      sourceFile: input.sourceFile || 'runtime-definition'
    });
  }

  const catalog = loadZigbeeCatalog();
  const model = input.modelID || input.zigbeeModel || input.model;
  const candidates = [
    ...(catalog.byZigbeeModel.get(normalizeLookupKey(model)) || []),
    ...(catalog.byFingerprintModel.get(normalizeLookupKey(model)) || []),
    ...(catalog.byModel.get(normalizeLookupKey(model)) || [])
  ];
  return selectBestZigbeeEntry(candidates, input);
}

function entrySearchText(entry) {
  return [
    entry.protocol,
    entry.source,
    entry.vendor,
    entry.manufacturer,
    entry.model,
    entry.label,
    entry.description,
    entry.sourceFile,
    ...(entry.zigbeeModels || []),
    ...(entry.homebrainFeatures || [])
  ].map((value) => trimString(value).toLowerCase()).filter(Boolean).join(' ');
}

function compactZigbeeEntry(entry, options = {}) {
  if (!entry) {
    return null;
  }
  const includeExposes = options.includeExposes !== false;
  return {
    protocol: entry.protocol,
    source: entry.source,
    sourceVersion: entry.sourceVersion,
    sourceFile: entry.sourceFile,
    model: entry.model,
    vendor: entry.vendor,
    description: entry.description,
    zigbeeModels: entry.zigbeeModels,
    fingerprints: entry.fingerprints,
    whiteLabels: entry.whiteLabels,
    exposes: includeExposes ? entry.exposes : undefined,
    fromZigbee: entry.fromZigbee,
    toZigbee: entry.toZigbee,
    options: includeExposes ? entry.options : undefined,
    ota: entry.ota,
    meta: entry.meta,
    homebrainFeatures: entry.homebrainFeatures,
    featureSupport: entry.featureSupport,
    capabilities: entry.capabilities
  };
}

function searchZigbeeCatalog(options = {}) {
  const catalog = loadZigbeeCatalog();
  const query = normalizeLookupKey(options.q || options.query);
  const vendor = normalizeLookupKey(options.vendor);
  const model = normalizeLookupKey(options.model || options.modelID || options.zigbeeModel);
  const limit = parseLimit(options.limit);
  const includeExposes = parseBoolean(options.includeExposes, query || model ? true : false);

  let entries = catalog.entries;
  if (vendor) {
    entries = entries.filter((entry) => normalizeLookupKey(entry.vendor).includes(vendor));
  }
  if (model) {
    entries = entries.filter((entry) => (
      normalizeLookupKey(entry.model).includes(model)
      || entry.zigbeeModels.some((entryModel) => normalizeLookupKey(entryModel).includes(model))
      || entry.fingerprints.some((fingerprint) => normalizeLookupKey(fingerprint?.modelID).includes(model))
    ));
  }
  if (query) {
    entries = entries.filter((entry) => entrySearchText(entry).includes(query));
  }

  return {
    protocol: 'zigbee',
    source: catalog.packageInfo.name,
    sourceVersion: catalog.packageInfo.version,
    count: entries.length,
    limit,
    entries: entries.slice(0, limit).map((entry) => compactZigbeeEntry(entry, { includeExposes })),
    errors: catalog.errors.slice(0, 10)
  };
}

function formatZWaveHex(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value.trim())) {
    return `0x${Number.parseInt(value, 16).toString(16).padStart(4, '0')}`;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return `0x${numeric.toString(16).padStart(4, '0')}`;
}

function parseZWaveId(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'string' && value.trim().toLowerCase().startsWith('0x')) {
    const parsed = Number.parseInt(value, 16);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferZWaveFeaturesFromText(parts = []) {
  const text = parts.map((entry) => trimString(entry).toLowerCase()).filter(Boolean).join(' ');
  const features = new Set();
  if (/\b(?:switch|outlet|plug|relay|paddle|module)\b/.test(text)) addFeature(features, 'switch');
  if (/\b(?:dimmer|multilevel)\b/.test(text)) {
    addFeature(features, 'switch');
    addFeature(features, 'brightness');
  }
  if (/\b(?:bulb|lamp|rgb|color|led strip)\b/.test(text)) {
    addFeature(features, 'light');
    addFeature(features, 'switch');
  }
  if (/\b(?:lock|deadbolt)\b/.test(text)) {
    addFeature(features, 'lock');
    addFeature(features, 'battery');
  }
  if (/\b(?:motion|occupancy|pir)\b/.test(text)) {
    addFeature(features, 'motion');
    addFeature(features, 'battery');
  }
  if (/\b(?:contact|door\/window|door window|window\/door|window door)\b/.test(text)) {
    addFeature(features, 'contact');
    addFeature(features, 'battery');
  }
  if (/\b(?:temperature|temp sensor)\b/.test(text)) addFeature(features, 'temperature');
  if (/\bhumidity\b/.test(text)) addFeature(features, 'humidity');
  if (/\b(?:illuminance|luminance|lux|light sensor)\b/.test(text)) addFeature(features, 'illuminance');
  if (/\b(?:battery|wakeup|wake up)\b/.test(text)) addFeature(features, 'battery');
  if (/\btamper\b/.test(text)) addFeature(features, 'tamper');
  if (/\b(?:power|watt|meter)\b/.test(text)) addFeature(features, 'power');
  if (/\b(?:energy|kwh)\b/.test(text)) addFeature(features, 'energy');
  if (/\bvoltage\b/.test(text)) addFeature(features, 'voltage');
  if (/\b(?:water|leak|flood)\b/.test(text)) addFeature(features, 'water');
  if (/\bsmoke\b/.test(text)) addFeature(features, 'smoke');
  if (/\b(?:carbon monoxide|\bco\b)\b/.test(text)) addFeature(features, 'carbonMonoxide');
  if (/\b(?:siren|alarm|sound switch)\b/.test(text)) addFeature(features, 'alarm');
  if (/\bchime\b/.test(text)) addFeature(features, 'chime');
  if (/\b(?:button|scene controller|remote)\b/.test(text)) addFeature(features, 'button');
  if (/\b(?:thermostat|setpoint|heating|cooling)\b/.test(text)) addFeature(features, 'thermostat');
  if (/\bfan\b/.test(text)) addFeature(features, 'fan');
  if (/\b(?:garage|barrier)\b/.test(text)) addFeature(features, 'garage');
  if (/\b(?:cover|shade|blind|shutter|curtain)\b/.test(text)) addFeature(features, 'cover');
  if (/\bvalve\b/.test(text)) addFeature(features, 'valve');
  if (/\bfirmware\b/.test(text)) addFeature(features, 'firmware');
  return Array.from(features).sort();
}

function serializeZWaveDeviceIds(devices = []) {
  return toArray(devices).map((device) => ({
    productType: formatZWaveHex(device.productType),
    productId: formatZWaveHex(device.productId),
    zwaveAllianceId: device.zwaveAllianceId || null
  }));
}

function serializeZWaveParameter(parameter, key = null) {
  if (!parameter || typeof parameter !== 'object') {
    return null;
  }
  const parameterNumber = parameter.parameterNumber
    ?? parameter.parameter
    ?? parameter['#']
    ?? key?.parameter
    ?? key;
  return {
    parameter: Number.isFinite(Number(parameterNumber)) ? Number(parameterNumber) : parameterNumber,
    valueBitMask: parameter.valueBitMask ?? key?.valueBitMask ?? null,
    label: trimString(parameter.label) || null,
    description: trimString(parameter.description) || null,
    valueSize: parameter.valueSize ?? null,
    minValue: parameter.minValue ?? null,
    maxValue: parameter.maxValue ?? null,
    defaultValue: parameter.defaultValue ?? null,
    recommendedValue: parameter.recommendedValue ?? null,
    unit: trimString(parameter.unit) || null,
    readOnly: parameter.readOnly === true,
    writeOnly: parameter.writeOnly === true,
    allowManualEntry: parameter.allowManualEntry !== false,
    destructive: parameter.destructive === true,
    hidden: parameter.hidden === true,
    purpose: trimString(parameter.purpose) || null,
    options: toArray(parameter.options).map((option) => sanitizeValue(option)).filter(Boolean)
  };
}

function serializeZWaveParameters(paramInformation) {
  if (!paramInformation) {
    return [];
  }
  if (typeof paramInformation.entries === 'function') {
    return Array.from(paramInformation.entries())
      .map(([key, parameter]) => serializeZWaveParameter(parameter, key))
      .filter(Boolean)
      .sort((left, right) => Number(left.parameter || 0) - Number(right.parameter || 0));
  }
  if (Array.isArray(paramInformation)) {
    return paramInformation
      .map((parameter) => serializeZWaveParameter(parameter))
      .filter(Boolean);
  }
  if (typeof paramInformation === 'object') {
    return Object.entries(paramInformation)
      .map(([key, parameter]) => serializeZWaveParameter({ ...parameter, parameterNumber: key }))
      .filter(Boolean);
  }
  return [];
}

function serializeZWaveAssociations(associations) {
  if (!associations) {
    return [];
  }
  const entries = typeof associations.entries === 'function'
    ? Array.from(associations.entries())
    : Object.entries(associations);
  return entries.map(([groupId, association]) => ({
    groupId: Number(association?.groupId ?? groupId),
    label: trimString(association?.label) || null,
    description: trimString(association?.description) || null,
    maxNodes: association?.maxNodes ?? null,
    isLifeline: association?.isLifeline === true,
    multiChannel: association?.multiChannel || null
  })).filter((entry) => Number.isFinite(entry.groupId));
}

function buildZWaveEntryFromConfig(config = {}, options = {}) {
  const packageInfo = options.packageInfo || readPackageInfo(ZWAVE_CONFIG_PACKAGE);
  const devices = serializeZWaveDeviceIds(config.devices || options.devices || []);
  const metadata = sanitizeValue(config.metadata || {});
  const associations = serializeZWaveAssociations(config.associations);
  const configParameters = serializeZWaveParameters(config.paramInformation);
  const manufacturerId = formatZWaveHex(config.manufacturerId ?? options.manufacturerId);
  const homebrainFeatures = inferZWaveFeaturesFromText([
    config.manufacturer,
    config.label,
    config.description,
    metadata?.inclusion,
    metadata?.exclusion,
    metadata?.reset,
    metadata?.manual
  ]);

  return {
    protocol: 'zwave',
    source: ZWAVE_CONFIG_PACKAGE,
    sourceVersion: packageInfo.version,
    sourceFile: options.sourceFile || config.filename || null,
    manufacturer: trimString(config.manufacturer) || null,
    manufacturerId,
    label: trimString(config.label) || null,
    description: trimString(config.description) || null,
    devices,
    firmwareVersion: sanitizeValue(config.firmwareVersion || null),
    preferred: config.preferred === true,
    metadata,
    associations,
    configParameters,
    compat: sanitizeValue(config.compat || {}),
    homebrainFeatures,
    featureSupport: buildFeatureSupport(homebrainFeatures, 'zwave'),
    capabilities: buildNormalizedCapabilities(homebrainFeatures, 'zwave')
  };
}

let zwaveCatalogPromise = null;

async function loadZWaveCatalog() {
  if (zwaveCatalogPromise) {
    return zwaveCatalogPromise;
  }

  zwaveCatalogPromise = (async () => {
    const packageInfo = readPackageInfo(ZWAVE_CONFIG_PACKAGE);
    const entries = [];
    const byFingerprint = new Map();
    const byManufacturer = new Map();
    const errors = [];
    let configManager = null;

    if (!packageInfo.packageDir) {
      return {
        packageInfo,
        configManager,
        entries,
        byFingerprint,
        byManufacturer,
        errors: [packageInfo.error || `${ZWAVE_CONFIG_PACKAGE} is unavailable`]
      };
    }

    try {
      const { ConfigManager } = require(ZWAVE_CONFIG_PACKAGE);
      configManager = new ConfigManager();
      await configManager.loadAll();
    } catch (error) {
      errors.push(error.message);
    }

    const index = configManager?.getIndex?.() || [];
    index.forEach((indexEntry) => {
      const entry = buildZWaveEntryFromConfig({
        manufacturer: indexEntry.manufacturer,
        manufacturerId: indexEntry.manufacturerId,
        label: indexEntry.label,
        description: indexEntry.description,
        devices: [{
          productType: indexEntry.productType,
          productId: indexEntry.productId
        }],
        firmwareVersion: indexEntry.firmwareVersion,
        preferred: indexEntry.preferred
      }, {
        packageInfo,
        sourceFile: indexEntry.filename
      });
      entries.push(entry);
      pushIndexed(byManufacturer, entry.manufacturerId, entry);
      pushIndexed(byManufacturer, entry.manufacturer, entry);
      const fingerprint = [
        entry.manufacturerId,
        entry.devices[0]?.productType,
        entry.devices[0]?.productId
      ].filter(Boolean).join(':');
      pushIndexed(byFingerprint, fingerprint, entry);
    });

    return {
      packageInfo,
      configManager,
      entries,
      byFingerprint,
      byManufacturer,
      errors
    };
  })();

  return zwaveCatalogPromise;
}

function compactZWaveEntry(entry, options = {}) {
  if (!entry) {
    return null;
  }
  const includeConfig = options.includeConfig === true;
  return {
    protocol: entry.protocol,
    source: entry.source,
    sourceVersion: entry.sourceVersion,
    sourceFile: entry.sourceFile,
    manufacturer: entry.manufacturer,
    manufacturerId: entry.manufacturerId,
    label: entry.label,
    description: entry.description,
    devices: entry.devices,
    firmwareVersion: entry.firmwareVersion,
    preferred: entry.preferred,
    metadata: entry.metadata,
    associations: includeConfig ? entry.associations : undefined,
    configParameters: includeConfig ? entry.configParameters : undefined,
    configParameterCount: entry.configParameters?.length || 0,
    associationGroupCount: entry.associations?.length || 0,
    compat: includeConfig ? entry.compat : undefined,
    homebrainFeatures: entry.homebrainFeatures,
    featureSupport: entry.featureSupport,
    capabilities: entry.capabilities
  };
}

async function searchZWaveCatalog(options = {}) {
  const catalog = await loadZWaveCatalog();
  const query = normalizeLookupKey(options.q || options.query);
  const manufacturer = normalizeLookupKey(options.manufacturer || options.manufacturerId);
  const productType = formatZWaveHex(options.productType);
  const productId = formatZWaveHex(options.productId);
  const limit = parseLimit(options.limit);
  const includeConfig = parseBoolean(options.includeConfig, false);

  let entries = catalog.entries;
  if (manufacturer) {
    entries = entries.filter((entry) => (
      normalizeLookupKey(entry.manufacturer).includes(manufacturer)
      || normalizeLookupKey(entry.manufacturerId).includes(manufacturer)
    ));
  }
  if (productType) {
    entries = entries.filter((entry) => entry.devices.some((device) => device.productType === productType));
  }
  if (productId) {
    entries = entries.filter((entry) => entry.devices.some((device) => device.productId === productId));
  }
  if (query) {
    entries = entries.filter((entry) => entrySearchText(entry).includes(query));
  }

  return {
    protocol: 'zwave',
    source: catalog.packageInfo.name,
    sourceVersion: catalog.packageInfo.version,
    count: entries.length,
    limit,
    entries: entries.slice(0, limit).map((entry) => compactZWaveEntry(entry, { includeConfig })),
    errors: catalog.errors.slice(0, 10)
  };
}

async function lookupZWaveCatalogEntry(input = {}) {
  const catalog = await loadZWaveCatalog();
  const manufacturerId = parseZWaveId(input.manufacturerId);
  const productType = parseZWaveId(input.productType);
  const productId = parseZWaveId(input.productId);

  if (catalog.configManager && manufacturerId !== null && productType !== null && productId !== null) {
    const deviceConfig = await catalog.configManager.lookupDevice(
      manufacturerId,
      productType,
      productId,
      input.firmwareVersion
    );
    if (deviceConfig) {
      const sourceEntry = catalog.entries.find((entry) => (
        entry.manufacturerId === formatZWaveHex(manufacturerId)
        && entry.devices.some((device) => (
          device.productType === formatZWaveHex(productType)
          && device.productId === formatZWaveHex(productId)
        ))
      ));
      return buildZWaveEntryFromConfig(deviceConfig, {
        packageInfo: catalog.packageInfo,
        sourceFile: sourceEntry?.sourceFile || null,
        manufacturerId
      });
    }
  }

  const fingerprint = [formatZWaveHex(manufacturerId), formatZWaveHex(productType), formatZWaveHex(productId)]
    .filter(Boolean)
    .join(':');
  return (catalog.byFingerprint.get(normalizeLookupKey(fingerprint)) || [])[0] || null;
}

function getZWaveNodeCatalogEntry(node = {}) {
  if (!node?.deviceConfig) {
    return null;
  }
  return buildZWaveEntryFromConfig(node.deviceConfig, {
    manufacturerId: node.manufacturerId,
    devices: [{
      productType: node.productType,
      productId: node.productId
    }],
    sourceFile: node.deviceConfig.filename || null
  });
}

function buildCatalogReference(entry) {
  if (!entry) {
    return null;
  }
  if (entry.protocol === 'zigbee') {
    return {
      protocol: 'zigbee',
      source: entry.source,
      sourceVersion: entry.sourceVersion,
      vendor: entry.vendor,
      model: entry.model,
      description: entry.description,
      sourceFile: entry.sourceFile,
      featureCount: entry.homebrainFeatures.length,
      exposeCount: entry.exposes.length
    };
  }
  return {
    protocol: 'zwave',
    source: entry.source,
    sourceVersion: entry.sourceVersion,
    manufacturer: entry.manufacturer,
    manufacturerId: entry.manufacturerId,
    label: entry.label,
    description: entry.description,
    sourceFile: entry.sourceFile,
    featureCount: entry.homebrainFeatures.length,
    configParameterCount: entry.configParameters.length,
    associationGroupCount: entry.associations.length
  };
}

function compactCatalogForDevice(entry) {
  if (!entry) {
    return null;
  }
  return entry.protocol === 'zigbee'
    ? compactZigbeeEntry(entry, { includeExposes: true })
    : compactZWaveEntry(entry, { includeConfig: true });
}

async function getSummary() {
  const zigbee = loadZigbeeCatalog();
  const zwave = await loadZWaveCatalog();
  const zigbeeVendors = new Set(zigbee.entries.map((entry) => normalizeLookupKey(entry.vendor)).filter(Boolean));
  const zwaveManufacturers = new Set(zwave.entries.map((entry) => normalizeLookupKey(entry.manufacturerId || entry.manufacturer)).filter(Boolean));
  const zigbeeFeatures = {};
  const zwaveFeatures = {};

  zigbee.entries.forEach((entry) => {
    entry.homebrainFeatures.forEach((feature) => {
      zigbeeFeatures[feature] = (zigbeeFeatures[feature] || 0) + 1;
    });
  });
  zwave.entries.forEach((entry) => {
    entry.homebrainFeatures.forEach((feature) => {
      zwaveFeatures[feature] = (zwaveFeatures[feature] || 0) + 1;
    });
  });

  return {
    generatedAt: new Date().toISOString(),
    zigbee: {
      source: zigbee.packageInfo.name,
      sourceVersion: zigbee.packageInfo.version,
      definitionCount: zigbee.entries.length,
      vendorCount: zigbeeVendors.size,
      zigbeeModelCount: Array.from(zigbee.byZigbeeModel.keys()).length,
      fingerprintModelCount: Array.from(zigbee.byFingerprintModel.keys()).length,
      exposesCount: zigbee.entries.reduce((sum, entry) => sum + entry.exposes.length, 0),
      featureCounts: zigbeeFeatures,
      errors: zigbee.errors.slice(0, 10)
    },
    zwave: {
      source: zwave.packageInfo.name,
      sourceVersion: zwave.packageInfo.version,
      deviceConfigCount: zwave.entries.length,
      manufacturerCount: zwaveManufacturers.size,
      featureCounts: zwaveFeatures,
      errors: zwave.errors.slice(0, 10)
    }
  };
}

module.exports = {
  buildCatalogReference,
  buildZigbeeEntryFromDefinition,
  buildZWaveEntryFromConfig,
  compactCatalogForDevice,
  findZigbeeCatalogEntry,
  getSummary,
  getZWaveNodeCatalogEntry,
  lookupZWaveCatalogEntry,
  parseBoolean,
  parseLimit,
  searchZigbeeCatalog,
  searchZWaveCatalog,
  _test: {
    formatZWaveHex,
    inferZigbeeFeaturesFromExposes,
    inferZWaveFeaturesFromText,
    serializeExpose,
    serializeZWaveParameter
  }
};

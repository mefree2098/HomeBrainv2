const fs = require('fs');
const path = require('path');
const {
  buildFeatureSupport,
  buildNormalizedCapabilities,
  normalizeFeature
} = require('./directRadioDeviceCatalog');
const {
  inferFeaturesFromMatterDescriptor,
  inferHomeBrainTypeFromFeatures,
  normalizeFeatureList: normalizeMatterFeatureList
} = require('./matterDeviceCatalog');

const ZIGBEE_PACKAGE = 'zigbee-herdsman-converters';
const ZWAVE_CONFIG_PACKAGE = '@zwave-js/config';
const MATTER_MODEL_PACKAGE = '@matter/model';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10_000;
const DEVICE_LIBRARY_DATA_DIR = process.env.HOMEBRAIN_DEVICE_LIBRARY_DATA_DIR
  || path.join(__dirname, '..', 'data', 'device-library');
const MATTER_DCL_MODELS_URL = process.env.HOMEBRAIN_MATTER_DCL_MODELS_URL
  || 'https://on.dcl.csa-iot.org/dcl/model/models';
const THREAD_CERTIFIED_PRODUCTS_URL = process.env.HOMEBRAIN_THREAD_CERTIFIED_PRODUCTS_URL
  || 'https://threadgroup.org/Certified-Products';
const INSTEON_DEVICE_LIST_CSV_URL = process.env.HOMEBRAIN_INSTEON_DEVICE_LIST_CSV_URL
  || 'https://docs.google.com/spreadsheets/d/15rDwnWCxCHJCzwRlTihqx_6vF5MLmqbBAdAcndgc8LM/pub?output=csv';
const INSTEON_DEVICE_LIST_PAGE_URL = 'https://madreporite.com/insteon/Insteon_device_list.htm';
const MATTER_DCL_SNAPSHOT_FILE = 'matter-dcl-models.json';
const THREAD_CERTIFIED_PRODUCTS_FILE = 'thread-certified-products.json';
const INSTEON_DEVICE_LIST_FILE = 'insteon-device-list.json';
const DEVICE_LIBRARY_UPDATE_STATE_FILE = 'device-library-update-state.json';
const DEFAULT_SOURCE_PAGE_LIMIT = 1000;
const DEVICE_LIBRARY_REFRESH_INTERVAL_MS = Math.max(
  24 * 60 * 60 * 1000,
  Number(process.env.HOMEBRAIN_DEVICE_LIBRARY_REFRESH_INTERVAL_MS || 30 * 24 * 60 * 60 * 1000)
);
const DEVICE_LIBRARY_HTTP_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.HOMEBRAIN_DEVICE_LIBRARY_HTTP_TIMEOUT_MS || 20000)
);
const MATTER_FEATURE_ALIASES = Object.freeze({
  doorState: 'contact',
  windowCovering: 'cover',
  soilMoisture: 'humidity',
  airQuality: 'health',
  camera: 'camera',
  doorbell: 'button',
  speaker: 'chime'
});

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
    let packagePath = null;
    try {
      packagePath = require.resolve(`${packageName}/package.json`);
    } catch (error) {
      let modulePath = require.resolve(packageName);
      let currentDir = path.dirname(modulePath);
      while (currentDir && currentDir !== path.dirname(currentDir)) {
        const candidatePath = path.join(currentDir, 'package.json');
        if (fs.existsSync(candidatePath)) {
          packagePath = candidatePath;
          break;
        }
        currentDir = path.dirname(currentDir);
      }
      if (!packagePath) {
        throw error;
      }
    }
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

function getDataDir(options = {}) {
  return options.dataDir || DEVICE_LIBRARY_DATA_DIR;
}

function snapshotPath(fileName, options = {}) {
  return path.join(getDataDir(options), fileName);
}

function readJsonFileSync(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

async function writeJsonFile(filePath, payload) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function readSnapshot(fileName, fallback, options = {}) {
  return readJsonFileSync(snapshotPath(fileName, options), fallback);
}

async function writeSnapshot(fileName, payload, options = {}) {
  await writeJsonFile(snapshotPath(fileName, options), payload);
}

function decodeHtmlEntities(value) {
  const entities = {
    nbsp: ' ',
    '#39': "'",
    quot: '"',
    amp: '&',
    lt: '<',
    gt: '>'
  };
  return trimString(value).replace(/&(nbsp|#39|quot|amp|lt|gt);/g, (match, entity) => (
    Object.prototype.hasOwnProperty.call(entities, entity) ? entities[entity] : match
  ));
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseProtocolId(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || /^\(?no response\)?$/i.test(trimmed)) {
      return null;
    }
    const parsed = /^0x/i.test(trimmed)
      ? Number.parseInt(trimmed.slice(2), 16)
      : Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    return parseProtocolId(value.id ?? value.value ?? value.code);
  }
  return null;
}

function formatProtocolHex(value, width = 4) {
  const parsed = parseProtocolId(value);
  return parsed === null ? null : `0x${parsed.toString(16).padStart(width, '0')}`;
}

function normalizeCatalogFeatures(features = []) {
  return uniqueStrings(toArray(features)
    .map((feature) => MATTER_FEATURE_ALIASES[feature] || feature)
    .map(normalizeFeature))
    .sort();
}

function mergeFeatureLists(...featureLists) {
  return normalizeCatalogFeatures(featureLists.flatMap((features) => toArray(features)));
}

function camelNameToLabel(value) {
  return trimString(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readResponseText(response) {
  if (response && typeof response.text === 'function') {
    return response.text();
  }
  if (typeof response === 'string') {
    return response;
  }
  return Promise.resolve('');
}

async function fetchWithTimeout(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation is available for device library updates');
  }

  let timeout = null;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (controller && options.timeoutMs !== 0) {
    timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEVICE_LIBRARY_HTTP_TIMEOUT_MS);
    timeout.unref?.();
  }

  try {
    const response = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
    if (response?.ok === false) {
      const text = await readResponseText(response).catch(() => '');
      throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    return response;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  if (response && typeof response.json === 'function') {
    return response.json();
  }
  const text = await readResponseText(response);
  return JSON.parse(text);
}

async function fetchText(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  return readResponseText(response);
}

function mergeNewEntries(existingEntries = [], incomingEntries = [], keyFn) {
  const seen = new Set(existingEntries.map(keyFn).filter(Boolean));
  const entries = existingEntries.slice();
  let addedCount = 0;
  incomingEntries.forEach((entry) => {
    const key = keyFn(entry);
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push(entry);
    addedCount += 1;
  });
  return { entries, addedCount };
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
    if (/\b(?:siren|alarm|warning|warning_mode|warningmode)\b/.test(text)) addFeature(features, 'alarm');
    if (/\b(?:chime|melody|tone|sound)\b/.test(text)) addFeature(features, 'chime');
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
  if (/\b(?:siren|alarm|sounder|warning)\b/.test(descriptor)) addFeature(features, 'alarm');
  if (/\b(?:chime|melody|tone)\b/.test(descriptor)) addFeature(features, 'chime');

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

function matterModelKey(model = {}) {
  const vendorId = formatProtocolHex(model.vid ?? model.vendorId, 4);
  const productId = formatProtocolHex(model.pid ?? model.productId, 4);
  if (!vendorId || !productId) {
    return null;
  }
  return `${vendorId}:${productId}`;
}

function matterDeviceTypeKey(value) {
  const hex = formatProtocolHex(value, 4);
  return hex ? normalizeLookupKey(hex) : null;
}

function serializeMatterRequirement(requirement) {
  if (!requirement || typeof requirement !== 'object') {
    return null;
  }
  return {
    name: trimString(requirement.name) || null,
    id: parseProtocolId(requirement.id),
    idHex: formatProtocolHex(requirement.id, 4),
    tag: trimString(requirement.tag) || null,
    conformance: trimString(requirement.conformance?.definition) || null
  };
}

function buildMatterEntryFromDeviceType(deviceType, options = {}) {
  const packageInfo = options.packageInfo || readPackageInfo(MATTER_MODEL_PACKAGE);
  const deviceTypeId = parseProtocolId(deviceType?.id);
  const deviceTypeName = trimString(deviceType?.name);
  const requirements = toArray(deviceType?.children)
    .filter((child) => child?.tag === 'requirement')
    .map(serializeMatterRequirement)
    .filter(Boolean);
  const requiredClusters = requirements.filter((requirement) => requirement.conformance === 'M');
  const clusterIds = uniqueStrings(requiredClusters.map((requirement) => requirement.idHex))
    .map(parseProtocolId)
    .filter((id) => id !== null);
  const clusterNames = uniqueStrings(requiredClusters.map((requirement) => requirement.name));
  const matterFeatures = normalizeMatterFeatureList(inferFeaturesFromMatterDescriptor({
    deviceTypeNames: [deviceTypeName, camelNameToLabel(deviceTypeName)],
    clusterIds,
    clusterNames
  }));
  const homebrainFeatures = normalizeCatalogFeatures(matterFeatures);

  return {
    protocol: 'matter',
    source: MATTER_MODEL_PACKAGE,
    sourceVersion: packageInfo.version,
    sourceUrl: 'https://github.com/project-chip/matter.js/tree/main/packages/model',
    entryKind: 'standard-device-type',
    deviceTypeId,
    deviceTypeIdHex: formatProtocolHex(deviceTypeId, 4),
    deviceTypeName,
    label: camelNameToLabel(deviceTypeName),
    classification: trimString(deviceType?.classification) || null,
    revision: deviceType?.revision ?? null,
    requirements,
    clusterIds,
    clusterNames,
    matterFeatures,
    homebrainFeatures,
    homeBrainType: inferHomeBrainTypeFromFeatures(matterFeatures, {
      deviceTypeNames: [deviceTypeName, camelNameToLabel(deviceTypeName)]
    }),
    featureSupport: buildFeatureSupport(homebrainFeatures, 'matter'),
    capabilities: buildNormalizedCapabilities(homebrainFeatures, 'matter')
  };
}

function buildMatterDclEntry(model = {}, standardCatalog = {}) {
  const vendorId = parseProtocolId(model.vid ?? model.vendorId);
  const productId = parseProtocolId(model.pid ?? model.productId);
  const deviceTypeId = parseProtocolId(model.deviceTypeId);
  const standardEntry = (standardCatalog.byDeviceTypeId?.get(matterDeviceTypeKey(deviceTypeId)) || [])[0] || null;
  const productName = trimString(model.productName);
  const productLabel = trimString(model.productLabel);
  const descriptor = {
    productName,
    vendorName: trimString(model.vendorName),
    deviceTypeNames: uniqueStrings([
      standardEntry?.deviceTypeName,
      standardEntry?.label,
      productName,
      productLabel
    ]),
    clusterIds: standardEntry?.clusterIds || [],
    clusterNames: standardEntry?.clusterNames || []
  };
  const matterFeatures = normalizeMatterFeatureList([
    ...(standardEntry?.matterFeatures || []),
    ...inferFeaturesFromMatterDescriptor(descriptor)
  ]);
  const homebrainFeatures = mergeFeatureLists(standardEntry?.homebrainFeatures || [], matterFeatures);

  return {
    protocol: 'matter',
    source: 'CSA Matter DCL',
    sourceVersion: null,
    sourceUrl: MATTER_DCL_MODELS_URL,
    entryKind: 'certified-product-model',
    vendorId,
    vendorIdHex: formatProtocolHex(vendorId, 4),
    productId,
    productIdHex: formatProtocolHex(productId, 4),
    deviceTypeId,
    deviceTypeIdHex: formatProtocolHex(deviceTypeId, 4),
    deviceTypeName: standardEntry?.deviceTypeName || null,
    productName: productName || null,
    productLabel: productLabel || null,
    partNumber: trimString(model.partNumber) || null,
    userManualUrl: trimString(model.userManualUrl) || null,
    supportUrl: trimString(model.supportUrl) || null,
    productUrl: trimString(model.productUrl) || null,
    commissioningCustomFlowUrl: trimString(model.commissioningCustomFlowUrl) || null,
    rawModel: sanitizeValue(model),
    matterFeatures,
    homebrainFeatures,
    homeBrainType: inferHomeBrainTypeFromFeatures(matterFeatures, descriptor),
    featureSupport: buildFeatureSupport(homebrainFeatures, 'matter'),
    capabilities: buildNormalizedCapabilities(homebrainFeatures, 'matter'),
    standardDeviceType: standardEntry ? buildCatalogReference(standardEntry) : null
  };
}

function buildMatterRuntimeEntry(descriptor = {}) {
  const matterFeatures = normalizeMatterFeatureList(descriptor.features?.length
    ? descriptor.features
    : inferFeaturesFromMatterDescriptor(descriptor));
  const homebrainFeatures = normalizeCatalogFeatures(matterFeatures);
  if (matterFeatures.length === 0 && homebrainFeatures.length === 0) {
    return null;
  }
  return {
    protocol: 'matter',
    source: 'runtime-matter-descriptor',
    sourceVersion: null,
    sourceUrl: null,
    entryKind: 'runtime-descriptor',
    deviceTypeIds: toArray(descriptor.deviceTypeIds || descriptor.deviceTypeId)
      .map(parseProtocolId)
      .filter((id) => id !== null),
    deviceTypeNames: uniqueStrings(toArray(descriptor.deviceTypeNames)),
    clusterIds: Array.from(new Set(toArray(descriptor.clusterIds).map(parseProtocolId).filter((id) => id !== null))).sort((a, b) => a - b),
    clusterNames: uniqueStrings(toArray(descriptor.clusterNames)),
    productName: trimString(descriptor.productName) || null,
    vendorName: trimString(descriptor.vendorName) || null,
    matterFeatures,
    homebrainFeatures,
    homeBrainType: inferHomeBrainTypeFromFeatures(matterFeatures, descriptor),
    featureSupport: buildFeatureSupport(homebrainFeatures, 'matter'),
    capabilities: buildNormalizedCapabilities(homebrainFeatures, 'matter')
  };
}

let matterCatalogPromise = null;

async function loadMatterCatalog(options = {}) {
  if (!options.dataDir && matterCatalogPromise) {
    return matterCatalogPromise;
  }

  const loader = (async () => {
    const packageInfo = readPackageInfo(MATTER_MODEL_PACKAGE);
    const standardEntries = [];
    const productEntries = [];
    const byDeviceTypeId = new Map();
    const byDeviceTypeName = new Map();
    const byProduct = new Map();
    const errors = [];

    try {
      const { Matter } = await import(MATTER_MODEL_PACKAGE);
      const visit = (node) => {
        if (!node || typeof node !== 'object') {
          return;
        }
        if (node.tag === 'deviceType' && parseProtocolId(node.id) !== null) {
          const entry = buildMatterEntryFromDeviceType(node, { packageInfo });
          standardEntries.push(entry);
          pushIndexed(byDeviceTypeId, entry.deviceTypeIdHex, entry);
          pushIndexed(byDeviceTypeName, entry.deviceTypeName, entry);
          pushIndexed(byDeviceTypeName, entry.label, entry);
        }
        toArray(node.children).forEach(visit);
      };
      visit(Matter);
    } catch (error) {
      errors.push(`${MATTER_MODEL_PACKAGE}: ${error.message}`);
    }

    const standardCatalog = { byDeviceTypeId };
    const snapshot = readSnapshot(MATTER_DCL_SNAPSHOT_FILE, { models: [] }, options);
    toArray(snapshot.models).forEach((model) => {
      const entry = buildMatterDclEntry(model, standardCatalog);
      productEntries.push(entry);
      pushIndexed(byProduct, matterModelKey(model), entry);
      pushIndexed(byDeviceTypeId, entry.deviceTypeIdHex, entry);
    });

    return {
      packageInfo,
      standardEntries,
      productEntries,
      entries: [...productEntries, ...standardEntries],
      byDeviceTypeId,
      byDeviceTypeName,
      byProduct,
      snapshot,
      errors
    };
  })();

  if (!options.dataDir) {
    matterCatalogPromise = loader;
  }
  return loader;
}

function compactMatterEntry(entry) {
  if (!entry) {
    return null;
  }
  return {
    protocol: entry.protocol,
    source: entry.source,
    sourceVersion: entry.sourceVersion,
    sourceUrl: entry.sourceUrl,
    entryKind: entry.entryKind,
    vendorId: entry.vendorId,
    vendorIdHex: entry.vendorIdHex,
    productId: entry.productId,
    productIdHex: entry.productIdHex,
    deviceTypeId: entry.deviceTypeId,
    deviceTypeIdHex: entry.deviceTypeIdHex,
    deviceTypeName: entry.deviceTypeName,
    deviceTypeNames: entry.deviceTypeNames,
    label: entry.label,
    classification: entry.classification,
    revision: entry.revision,
    productName: entry.productName,
    productLabel: entry.productLabel,
    partNumber: entry.partNumber,
    vendorName: entry.vendorName,
    requirements: entry.requirements,
    clusterIds: entry.clusterIds,
    clusterNames: entry.clusterNames,
    userManualUrl: entry.userManualUrl,
    supportUrl: entry.supportUrl,
    productUrl: entry.productUrl,
    matterFeatures: entry.matterFeatures,
    homebrainFeatures: entry.homebrainFeatures,
    homeBrainType: entry.homeBrainType,
    featureSupport: entry.featureSupport,
    capabilities: entry.capabilities,
    standardDeviceType: entry.standardDeviceType
  };
}

function matterSearchText(entry) {
  return [
    entry.protocol,
    entry.source,
    entry.entryKind,
    entry.vendorIdHex,
    entry.productIdHex,
    entry.deviceTypeIdHex,
    entry.deviceTypeName,
    entry.label,
    entry.productName,
    entry.productLabel,
    entry.partNumber,
    entry.vendorName,
    ...(entry.deviceTypeNames || []),
    ...(entry.clusterNames || []),
    ...(entry.homebrainFeatures || [])
  ].map((value) => trimString(value).toLowerCase()).filter(Boolean).join(' ');
}

async function searchMatterCatalog(options = {}) {
  const catalog = await loadMatterCatalog(options);
  const query = normalizeLookupKey(options.q || options.query);
  const vendorId = formatProtocolHex(options.vendorId ?? options.vendorID ?? options.vid, 4);
  const productId = formatProtocolHex(options.productId ?? options.productID ?? options.pid, 4);
  const deviceTypeId = formatProtocolHex(options.deviceTypeId, 4);
  const limit = parseLimit(options.limit);

  let entries = catalog.entries;
  if (vendorId) {
    entries = entries.filter((entry) => entry.vendorIdHex === vendorId);
  }
  if (productId) {
    entries = entries.filter((entry) => entry.productIdHex === productId);
  }
  if (deviceTypeId) {
    entries = entries.filter((entry) => entry.deviceTypeIdHex === deviceTypeId);
  }
  if (query) {
    entries = entries.filter((entry) => matterSearchText(entry).includes(query));
  }

  return {
    protocol: 'matter',
    source: `${MATTER_MODEL_PACKAGE} + CSA Matter DCL`,
    sourceVersion: catalog.packageInfo.version,
    count: entries.length,
    limit,
    entries: entries.slice(0, limit).map(compactMatterEntry),
    snapshot: {
      sourceUrl: MATTER_DCL_MODELS_URL,
      modelCount: catalog.productEntries.length,
      lastUpdatedAt: catalog.snapshot.updatedAt || null
    },
    errors: catalog.errors.slice(0, 10)
  };
}

async function lookupMatterCatalogEntry(input = {}) {
  const catalog = await loadMatterCatalog();
  const basic = input.basicInformation || {};
  const vendorId = formatProtocolHex(
    input.vendorId ?? input.vendorID ?? input.vid ?? basic.vendorId ?? basic.vendorID,
    4
  );
  const productId = formatProtocolHex(
    input.productId ?? input.productID ?? input.pid ?? basic.productId ?? basic.productID,
    4
  );
  if (vendorId && productId) {
    const productMatch = (catalog.byProduct.get(normalizeLookupKey(`${vendorId}:${productId}`)) || [])[0];
    if (productMatch) {
      return productMatch;
    }
  }

  const deviceTypeIds = uniqueStrings([
    ...toArray(input.deviceTypeIds),
    ...toArray(input.deviceTypeId),
    ...toArray(input.deviceTypes).map((entry) => entry?.id ?? entry?.deviceTypeId ?? entry?.code)
  ].map((id) => formatProtocolHex(id, 4))).filter(Boolean);
  for (const id of deviceTypeIds) {
    const match = (catalog.byDeviceTypeId.get(normalizeLookupKey(id)) || [])[0];
    if (match) {
      return match;
    }
  }

  const deviceTypeNames = uniqueStrings([
    ...toArray(input.deviceTypeNames),
    ...toArray(input.deviceTypes).map((entry) => entry?.name || entry?.deviceTypeName)
  ]);
  for (const name of deviceTypeNames) {
    const match = (catalog.byDeviceTypeName.get(normalizeLookupKey(name)) || [])[0];
    if (match) {
      return match;
    }
  }

  return buildMatterRuntimeEntry(input);
}

function inferThreadFeaturesFromText(parts = []) {
  return inferZWaveFeaturesFromText(parts);
}

function parseThreadCertifiedProductsHtml(html) {
  const products = [];
  const sections = String(html || '').match(/<div\s+id=["']prod-sec2["'][\s\S]*?(?=<div\s+id=["']prod-sec2["']|<\/span>|$)/gi) || [];
  sections.forEach((section) => {
    const name = stripHtml((section.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
    if (!name) {
      return;
    }
    const paragraph = (section.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
    const description = stripHtml(paragraph.replace(/Product Details[\s\S]*$/i, ''));
    products.push({
      name,
      description: description || null,
      sourceUrl: THREAD_CERTIFIED_PRODUCTS_URL
    });
  });
  return products;
}

function threadProductKey(product = {}) {
  const key = [product.name, product.company, product.model, product.description]
    .map((value) => normalizeLookupKey(value))
    .filter(Boolean)
    .join(':');
  return key || null;
}

function buildThreadEntry(product = {}) {
  const homebrainFeatures = inferThreadFeaturesFromText([
    product.name,
    product.description,
    product.deviceType,
    product.subCategory
  ]);
  return {
    protocol: 'thread',
    source: 'Thread Group Certified Products',
    sourceVersion: null,
    sourceUrl: product.sourceUrl || THREAD_CERTIFIED_PRODUCTS_URL,
    entryKind: 'thread-certified-product',
    name: trimString(product.name) || null,
    description: trimString(product.description) || null,
    company: trimString(product.company) || null,
    model: trimString(product.model) || null,
    deviceType: trimString(product.deviceType) || null,
    subCategory: trimString(product.subCategory) || null,
    homebrainFeatures,
    featureSupport: buildFeatureSupport(homebrainFeatures, 'thread'),
    capabilities: buildNormalizedCapabilities(homebrainFeatures, 'thread')
  };
}

function compactThreadEntry(entry) {
  if (!entry) {
    return null;
  }
  return {
    protocol: entry.protocol,
    source: entry.source,
    sourceVersion: entry.sourceVersion,
    sourceUrl: entry.sourceUrl,
    entryKind: entry.entryKind,
    name: entry.name,
    description: entry.description,
    company: entry.company,
    model: entry.model,
    deviceType: entry.deviceType,
    subCategory: entry.subCategory,
    matterCatalog: entry.matterCatalog,
    homebrainFeatures: entry.homebrainFeatures,
    featureSupport: entry.featureSupport,
    capabilities: entry.capabilities
  };
}

let threadCatalogCache = null;

function loadThreadCatalog(options = {}) {
  if (!options.dataDir && threadCatalogCache) {
    return threadCatalogCache;
  }
  const snapshot = readSnapshot(THREAD_CERTIFIED_PRODUCTS_FILE, { products: [] }, options);
  const entries = toArray(snapshot.products).map(buildThreadEntry);
  const catalog = {
    entries,
    snapshot,
    errors: []
  };
  if (!options.dataDir) {
    threadCatalogCache = catalog;
  }
  return catalog;
}

async function lookupThreadCatalogEntry(input = {}) {
  const transport = normalizeLookupKey(input.transport || input?.matter?.transport);
  const matterEntry = await lookupMatterCatalogEntry(input);
  if (!matterEntry && transport !== 'thread') {
    return null;
  }
  const homebrainFeatures = matterEntry?.homebrainFeatures || normalizeCatalogFeatures(input.features || []);
  return {
    protocol: 'thread',
    source: 'Matter over Thread descriptor',
    sourceVersion: matterEntry?.sourceVersion || null,
    sourceUrl: THREAD_CERTIFIED_PRODUCTS_URL,
    entryKind: 'matter-over-thread-runtime',
    name: trimString(input.productName || input.name) || null,
    description: 'Thread is the IPv6 mesh transport; HomeBrain uses the Matter catalog for device capabilities.',
    matterCatalog: matterEntry ? buildCatalogReference(matterEntry) : null,
    homebrainFeatures,
    featureSupport: buildFeatureSupport(homebrainFeatures, 'thread'),
    capabilities: buildNormalizedCapabilities(homebrainFeatures, 'thread')
  };
}

function searchThreadCatalog(options = {}) {
  const catalog = loadThreadCatalog(options);
  const query = normalizeLookupKey(options.q || options.query);
  const limit = parseLimit(options.limit);
  let entries = catalog.entries;
  if (query) {
    entries = entries.filter((entry) => [
      entry.name,
      entry.description,
      entry.company,
      entry.model,
      entry.deviceType,
      entry.subCategory,
      ...(entry.homebrainFeatures || [])
    ].map((value) => trimString(value).toLowerCase()).join(' ').includes(query));
  }
  return {
    protocol: 'thread',
    source: 'Thread Group Certified Products',
    sourceUrl: THREAD_CERTIFIED_PRODUCTS_URL,
    count: entries.length,
    limit,
    entries: entries.slice(0, limit).map(compactThreadEntry),
    snapshot: {
      productCount: catalog.entries.length,
      lastUpdatedAt: catalog.snapshot.updatedAt || null
    },
    errors: catalog.errors.slice(0, 10)
  };
}

function formatInsteonByte(value) {
  const parsed = parseProtocolId(value);
  return parsed === null ? null : `0x${parsed.toString(16).padStart(2, '0')}`;
}

const INSTEON_CATEGORY_LIBRARY = Object.freeze([
  { category: 0x00, label: 'Generalized Controllers', examples: 'ControLinc, RemoteLinc, SignaLinc', features: ['button'] },
  { category: 0x01, label: 'Dimmable Lighting Control', examples: 'Dimmable light switches, dimmable plug-in modules', features: ['switch', 'light', 'brightness'] },
  { category: 0x02, label: 'Switched Lighting Control', examples: 'Relay switches, relay plug-in modules', features: ['switch', 'light'] },
  { category: 0x03, label: 'Network Bridges', examples: 'PowerLinc controllers, bridges', features: ['health'] },
  { category: 0x04, label: 'Irrigation Control', examples: 'Sprinkler controllers', features: ['valve'] },
  { category: 0x05, label: 'Climate Control', examples: 'Thermostats, HVAC, fans, indoor air quality', features: ['thermostat', 'temperature', 'fan'] },
  { category: 0x06, label: 'Pool and Spa Control', examples: 'Pumps, heaters, chemical controllers', features: ['switch', 'temperature'] },
  { category: 0x07, label: 'Sensors and Actuators', examples: 'Sensors, contact closures', features: ['contact', 'motion', 'battery'] },
  { category: 0x08, label: 'Home Entertainment', examples: 'Audio/video equipment', features: ['button'] },
  { category: 0x09, label: 'Energy Management', examples: 'Energy displays and meters', features: ['power', 'energy'] },
  { category: 0x0E, label: 'Window Coverings', examples: 'Blinds, curtains, shades', features: ['cover'] },
  { category: 0x0F, label: 'Access Control', examples: 'Locks, doors, garage controls', features: ['lock', 'contact', 'battery'] },
  { category: 0x10, label: 'Security, Health, Safety', examples: 'Smoke, carbon monoxide, water, motion sensors', features: ['smoke', 'carbonMonoxide', 'water', 'motion', 'battery'] }
]);

function inferInsteonFeaturesFromParts(parts = [], category = null) {
  const base = new Set((INSTEON_CATEGORY_LIBRARY.find((entry) => entry.category === category)?.features || []).map(normalizeFeature));
  const text = parts.map((entry) => trimString(entry).toLowerCase()).filter(Boolean).join(' ');
  if (/\b(?:dimmer|dimmable|lamplinc|keypadlinc)\b/.test(text)) {
    addFeature(base, 'switch');
    addFeature(base, 'light');
    addFeature(base, 'brightness');
  }
  if (/\b(?:switch|on\/off|relay|appliance|outlet|plug)\b/.test(text)) addFeature(base, 'switch');
  if (/\b(?:fanlinc|fan)\b/.test(text)) addFeature(base, 'fan');
  if (/\b(?:thermostat|climate)\b/.test(text)) addFeature(base, 'thermostat');
  if (/\b(?:motion|occupancy)\b/.test(text)) addFeature(base, 'motion');
  if (/\b(?:door|window|contact|open\/close)\b/.test(text)) addFeature(base, 'contact');
  if (/\b(?:leak|water|flood)\b/.test(text)) addFeature(base, 'water');
  if (/\b(?:smoke)\b/.test(text)) addFeature(base, 'smoke');
  if (/\b(?:carbon monoxide|\bco\b)\b/.test(text)) addFeature(base, 'carbonMonoxide');
  if (/\b(?:lock|deadbolt)\b/.test(text)) addFeature(base, 'lock');
  if (/\b(?:shade|blind|curtain|cover)\b/.test(text)) addFeature(base, 'cover');
  if (/\b(?:energy|meter|power)\b/.test(text)) {
    addFeature(base, 'power');
    addFeature(base, 'energy');
  }
  if (/\b(?:remote|mini remote|button|controller)\b/.test(text)) addFeature(base, 'button');
  return Array.from(base).filter(Boolean).sort();
}

function buildInsteonCategoryEntry(categoryEntry) {
  const homebrainFeatures = inferInsteonFeaturesFromParts([
    categoryEntry.label,
    categoryEntry.examples
  ], categoryEntry.category);
  return {
    protocol: 'insteon',
    source: 'INSTEON Developer Guide device categories',
    sourceVersion: '2009-02',
    sourceUrl: 'https://cache.insteon.com/developer/developer-guide-022009-en.pdf',
    entryKind: 'device-category',
    category: categoryEntry.category,
    categoryHex: formatInsteonByte(categoryEntry.category),
    subcategory: null,
    subcategoryHex: null,
    label: categoryEntry.label,
    description: categoryEntry.examples,
    model: null,
    productKey: null,
    engine: null,
    firmwareVersion: null,
    homebrainFeatures,
    featureSupport: buildFeatureSupport(homebrainFeatures, 'insteon'),
    capabilities: buildNormalizedCapabilities(homebrainFeatures, 'insteon')
  };
}

function buildInsteonEntryFromRow(row = {}) {
  const category = parseProtocolId(row.devCat ?? row.deviceCategory ?? row.category);
  const subcategory = parseProtocolId(row.subCat ?? row.subcategory ?? row.deviceSubcategory);
  const model = trimString(row.productId ?? row.model);
  const productKey = trimString(row.productKey ?? row.ipk);
  const name = trimString(row.deviceName ?? row.name);
  const categoryLabel = INSTEON_CATEGORY_LIBRARY.find((entry) => entry.category === category)?.label || null;
  const homebrainFeatures = inferInsteonFeaturesFromParts([
    name,
    model,
    categoryLabel
  ], category);
  return {
    protocol: 'insteon',
    source: 'Madreporite INSTEON device list',
    sourceVersion: null,
    sourceUrl: INSTEON_DEVICE_LIST_PAGE_URL,
    entryKind: 'product',
    category,
    categoryHex: formatInsteonByte(category),
    subcategory,
    subcategoryHex: formatInsteonByte(subcategory),
    categoryLabel,
    label: name || model || categoryLabel,
    description: name || categoryLabel,
    model: model || null,
    productKey: productKey || null,
    engine: trimString(row.engine) || null,
    firmwareVersion: trimString(row.firmwareVersion) || null,
    labelOnDevice: trimString(row.labelOnDevice) || null,
    purchaseDate: trimString(row.purchaseDate) || null,
    homebrainFeatures,
    featureSupport: buildFeatureSupport(homebrainFeatures, 'insteon'),
    capabilities: buildNormalizedCapabilities(homebrainFeatures, 'insteon')
  };
}

function insteonFingerprint(category, subcategory) {
  const categoryHex = formatInsteonByte(category);
  const subcategoryHex = formatInsteonByte(subcategory);
  return categoryHex && subcategoryHex ? `${categoryHex}:${subcategoryHex}` : null;
}

function insteonRowKey(row = {}) {
  const model = normalizeLookupKey(row.productId || row.model);
  const productKey = normalizeLookupKey(row.productKey || row.ipk);
  const fingerprint = insteonFingerprint(
    row.devCat ?? row.deviceCategory ?? row.category,
    row.subCat ?? row.subcategory ?? row.deviceSubcategory
  );
  if (model && fingerprint) {
    return `${model}:${fingerprint}`;
  }
  if (productKey && fingerprint) {
    return `${productKey}:${fingerprint}`;
  }
  return [
    normalizeLookupKey(row.deviceName || row.name),
    model,
    productKey,
    fingerprint
  ].filter(Boolean).join(':') || null;
}

let insteonCatalogCache = null;

function loadInsteonCatalog(options = {}) {
  if (!options.dataDir && insteonCatalogCache) {
    return insteonCatalogCache;
  }
  const snapshot = readSnapshot(INSTEON_DEVICE_LIST_FILE, { devices: [] }, options);
  const entries = [
    ...toArray(snapshot.devices).map(buildInsteonEntryFromRow),
    ...INSTEON_CATEGORY_LIBRARY.map(buildInsteonCategoryEntry)
  ];
  const byFingerprint = new Map();
  const byCategory = new Map();
  const byModel = new Map();
  const byProductKey = new Map();
  entries.forEach((entry) => {
    pushIndexed(byFingerprint, insteonFingerprint(entry.category, entry.subcategory), entry);
    pushIndexed(byCategory, entry.categoryHex, entry);
    pushIndexed(byModel, entry.model, entry);
    pushIndexed(byProductKey, entry.productKey, entry);
  });
  const catalog = {
    entries,
    snapshot,
    byFingerprint,
    byCategory,
    byModel,
    byProductKey,
    errors: []
  };
  if (!options.dataDir) {
    insteonCatalogCache = catalog;
  }
  return catalog;
}

function compactInsteonEntry(entry) {
  if (!entry) {
    return null;
  }
  return {
    protocol: entry.protocol,
    source: entry.source,
    sourceVersion: entry.sourceVersion,
    sourceUrl: entry.sourceUrl,
    entryKind: entry.entryKind,
    category: entry.category,
    categoryHex: entry.categoryHex,
    subcategory: entry.subcategory,
    subcategoryHex: entry.subcategoryHex,
    categoryLabel: entry.categoryLabel,
    label: entry.label,
    description: entry.description,
    model: entry.model,
    productKey: entry.productKey,
    engine: entry.engine,
    firmwareVersion: entry.firmwareVersion,
    labelOnDevice: entry.labelOnDevice,
    homebrainFeatures: entry.homebrainFeatures,
    featureSupport: entry.featureSupport,
    capabilities: entry.capabilities
  };
}

function selectBestInsteonEntry(candidates = [], input = {}) {
  const list = candidates.filter(Boolean);
  if (list.length <= 1) {
    return list[0] || null;
  }
  const model = normalizeLookupKey(input.productKey || input.model || input.productId || input.insteonType);
  if (model) {
    const modelMatch = list.find((entry) => (
      normalizeLookupKey(entry.model) === model
      || normalizeLookupKey(entry.productKey) === model
    ));
    if (modelMatch) {
      return modelMatch;
    }
  }
  const productEntry = list.find((entry) => entry.entryKind === 'product');
  return productEntry || list[0];
}

function lookupInsteonCatalogEntry(input = {}) {
  const catalog = loadInsteonCatalog();
  const category = input.category ?? input.deviceCategory ?? input.devCat;
  const subcategory = input.subcategory ?? input.deviceSubcategory ?? input.subCat;
  const model = input.productKey || input.model || input.productId || input.insteonType;
  const candidates = [
    ...(catalog.byModel.get(normalizeLookupKey(model)) || []),
    ...(catalog.byProductKey.get(normalizeLookupKey(model)) || []),
    ...(catalog.byFingerprint.get(normalizeLookupKey(insteonFingerprint(category, subcategory))) || []),
    ...(catalog.byCategory.get(normalizeLookupKey(formatInsteonByte(category))) || [])
  ];
  return selectBestInsteonEntry(candidates, input);
}

function searchInsteonCatalog(options = {}) {
  const catalog = loadInsteonCatalog(options);
  const query = normalizeLookupKey(options.q || options.query);
  const model = normalizeLookupKey(options.model || options.productKey || options.productId);
  const category = formatInsteonByte(options.category ?? options.deviceCategory ?? options.devCat);
  const subcategory = formatInsteonByte(options.subcategory ?? options.deviceSubcategory ?? options.subCat);
  const limit = parseLimit(options.limit);
  let entries = catalog.entries;
  if (model) {
    entries = entries.filter((entry) => (
      normalizeLookupKey(entry.model).includes(model)
      || normalizeLookupKey(entry.productKey).includes(model)
    ));
  }
  if (category) {
    entries = entries.filter((entry) => entry.categoryHex === category);
  }
  if (subcategory) {
    entries = entries.filter((entry) => entry.subcategoryHex === subcategory);
  }
  if (query) {
    entries = entries.filter((entry) => [
      entry.label,
      entry.description,
      entry.model,
      entry.productKey,
      entry.categoryLabel,
      ...(entry.homebrainFeatures || [])
    ].map((value) => trimString(value).toLowerCase()).join(' ').includes(query));
  }
  return {
    protocol: 'insteon',
    source: 'INSTEON Developer Guide + Madreporite device list',
    count: entries.length,
    limit,
    entries: entries.slice(0, limit).map(compactInsteonEntry),
    snapshot: {
      sourceUrl: INSTEON_DEVICE_LIST_CSV_URL,
      deviceCount: toArray(catalog.snapshot.devices).length,
      lastUpdatedAt: catalog.snapshot.updatedAt || null
    },
    errors: catalog.errors.slice(0, 10)
  };
}

function parseCsvRows(csvText) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const text = String(csvText || '');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseInsteonDeviceListCsv(csvText) {
  return parseCsvRows(csvText)
    .slice(2)
    .map((row) => ({
      deviceName: trimString(row[0]),
      productId: trimString(row[1]),
      devCat: trimString(row[2]),
      subCat: trimString(row[3]),
      engine: trimString(row[4]),
      firmwareVersion: trimString(row[5]),
      productKey: trimString(row[6]),
      labelOnDevice: trimString(row[7]),
      purchaseDate: trimString(row[8])
    }))
    .filter((row) => row.deviceName && (row.productId || row.devCat || row.subCat));
}

async function fetchMatterDclModels(options = {}) {
  const models = [];
  let nextKey = null;
  const limit = Math.max(1, Math.min(1000, Number(options.limit || DEFAULT_SOURCE_PAGE_LIMIT)));
  do {
    const url = new URL(options.url || MATTER_DCL_MODELS_URL);
    url.searchParams.set('pagination.limit', String(limit));
    if (nextKey) {
      url.searchParams.set('pagination.key', nextKey);
    }
    const payload = await fetchJson(url.toString(), options);
    models.push(...toArray(payload.model || payload.models));
    nextKey = payload.pagination?.next_key || payload.pagination?.nextKey || null;
  } while (nextKey);
  return models;
}

async function fetchThreadCertifiedProducts(options = {}) {
  const html = await fetchText(options.url || THREAD_CERTIFIED_PRODUCTS_URL, options);
  return parseThreadCertifiedProductsHtml(html);
}

async function fetchInsteonDeviceRows(options = {}) {
  const csv = await fetchText(options.url || INSTEON_DEVICE_LIST_CSV_URL, options);
  return parseInsteonDeviceListCsv(csv);
}

function readUpdateState(options = {}) {
  return readSnapshot(DEVICE_LIBRARY_UPDATE_STATE_FILE, {
    lastRunAt: null,
    lastSuccessAt: null,
    refreshIntervalMs: DEVICE_LIBRARY_REFRESH_INTERVAL_MS,
    sources: {},
    errors: []
  }, options);
}

function getUpdateStatus(options = {}) {
  const state = readUpdateState(options);
  const matterSnapshot = readSnapshot(MATTER_DCL_SNAPSHOT_FILE, { models: [] }, options);
  const threadSnapshot = readSnapshot(THREAD_CERTIFIED_PRODUCTS_FILE, { products: [] }, options);
  const insteonSnapshot = readSnapshot(INSTEON_DEVICE_LIST_FILE, { devices: [] }, options);
  const lastSuccessMs = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : 0;
  const nextDueAt = lastSuccessMs
    ? new Date(lastSuccessMs + DEVICE_LIBRARY_REFRESH_INTERVAL_MS).toISOString()
    : null;
  return {
    ...state,
    refreshIntervalMs: DEVICE_LIBRARY_REFRESH_INTERVAL_MS,
    nextDueAt,
    due: !lastSuccessMs || Date.now() - lastSuccessMs >= DEVICE_LIBRARY_REFRESH_INTERVAL_MS,
    snapshots: {
      matter: {
        count: toArray(matterSnapshot.models).length,
        updatedAt: matterSnapshot.updatedAt || null,
        sourceUrl: MATTER_DCL_MODELS_URL
      },
      thread: {
        count: toArray(threadSnapshot.products).length,
        updatedAt: threadSnapshot.updatedAt || null,
        sourceUrl: THREAD_CERTIFIED_PRODUCTS_URL
      },
      insteon: {
        count: toArray(insteonSnapshot.devices).length,
        updatedAt: insteonSnapshot.updatedAt || null,
        sourceUrl: INSTEON_DEVICE_LIST_CSV_URL
      }
    }
  };
}

async function refreshExternalCatalogs(options = {}) {
  const startedAt = new Date();
  const force = options.force === true;
  const currentStatus = getUpdateStatus(options);
  if (!force && currentStatus.lastSuccessAt) {
    const elapsedMs = startedAt.getTime() - Date.parse(currentStatus.lastSuccessAt);
    if (elapsedMs < DEVICE_LIBRARY_REFRESH_INTERVAL_MS) {
      return {
        success: true,
        skipped: true,
        reason: 'not_due',
        nextDueAt: currentStatus.nextDueAt,
        status: currentStatus
      };
    }
  }

  const sources = {};
  const errors = [];

  const runSource = async (key, updater) => {
    try {
      sources[key] = await updater();
    } catch (error) {
      const message = error.message || String(error);
      errors.push({ source: key, message });
      sources[key] = {
        success: false,
        addedCount: 0,
        error: message
      };
    }
  };

  await runSource('matter', async () => {
    const existing = readSnapshot(MATTER_DCL_SNAPSHOT_FILE, { models: [] }, options);
    const incoming = await fetchMatterDclModels(options);
    const merged = mergeNewEntries(toArray(existing.models), incoming, matterModelKey);
    const snapshot = {
      source: 'CSA Matter DCL',
      sourceUrl: MATTER_DCL_MODELS_URL,
      updatedAt: new Date().toISOString(),
      models: merged.entries
    };
    await writeSnapshot(MATTER_DCL_SNAPSHOT_FILE, snapshot, options);
    return {
      success: true,
      sourceUrl: MATTER_DCL_MODELS_URL,
      existingCount: toArray(existing.models).length,
      fetchedCount: incoming.length,
      addedCount: merged.addedCount,
      totalCount: merged.entries.length
    };
  });

  await runSource('thread', async () => {
    const existing = readSnapshot(THREAD_CERTIFIED_PRODUCTS_FILE, { products: [] }, options);
    const incoming = await fetchThreadCertifiedProducts(options);
    const merged = mergeNewEntries(toArray(existing.products), incoming, threadProductKey);
    const snapshot = {
      source: 'Thread Group Certified Products',
      sourceUrl: THREAD_CERTIFIED_PRODUCTS_URL,
      updatedAt: new Date().toISOString(),
      products: merged.entries
    };
    await writeSnapshot(THREAD_CERTIFIED_PRODUCTS_FILE, snapshot, options);
    return {
      success: true,
      sourceUrl: THREAD_CERTIFIED_PRODUCTS_URL,
      existingCount: toArray(existing.products).length,
      fetchedCount: incoming.length,
      addedCount: merged.addedCount,
      totalCount: merged.entries.length
    };
  });

  await runSource('insteon', async () => {
    const existing = readSnapshot(INSTEON_DEVICE_LIST_FILE, { devices: [] }, options);
    const incoming = await fetchInsteonDeviceRows(options);
    const merged = mergeNewEntries(toArray(existing.devices), incoming, insteonRowKey);
    const snapshot = {
      source: 'Madreporite INSTEON device list',
      sourceUrl: INSTEON_DEVICE_LIST_CSV_URL,
      referenceUrl: INSTEON_DEVICE_LIST_PAGE_URL,
      updatedAt: new Date().toISOString(),
      devices: merged.entries
    };
    await writeSnapshot(INSTEON_DEVICE_LIST_FILE, snapshot, options);
    return {
      success: true,
      sourceUrl: INSTEON_DEVICE_LIST_CSV_URL,
      existingCount: toArray(existing.devices).length,
      fetchedCount: incoming.length,
      addedCount: merged.addedCount,
      totalCount: merged.entries.length
    };
  });

  const finishedAt = new Date();
  const state = {
    lastRunAt: startedAt.toISOString(),
    lastSuccessAt: errors.length === 0 ? finishedAt.toISOString() : currentStatus.lastSuccessAt || null,
    refreshIntervalMs: DEVICE_LIBRARY_REFRESH_INTERVAL_MS,
    sources,
    errors,
    finishedAt: finishedAt.toISOString()
  };
  await writeSnapshot(DEVICE_LIBRARY_UPDATE_STATE_FILE, state, options);

  matterCatalogPromise = null;
  threadCatalogCache = null;
  insteonCatalogCache = null;

  return {
    success: errors.length === 0,
    skipped: false,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    sources,
    errors,
    status: getUpdateStatus(options)
  };
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
  if (entry.protocol === 'matter') {
    return {
      protocol: 'matter',
      source: entry.source,
      sourceVersion: entry.sourceVersion,
      entryKind: entry.entryKind,
      vendorId: entry.vendorIdHex,
      productId: entry.productIdHex,
      deviceTypeId: entry.deviceTypeIdHex,
      deviceTypeName: entry.deviceTypeName || entry.label || null,
      productName: entry.productName || null,
      featureCount: entry.homebrainFeatures?.length || 0
    };
  }
  if (entry.protocol === 'thread') {
    return {
      protocol: 'thread',
      source: entry.source,
      sourceVersion: entry.sourceVersion,
      entryKind: entry.entryKind,
      name: entry.name,
      model: entry.model,
      featureCount: entry.homebrainFeatures?.length || 0
    };
  }
  if (entry.protocol === 'insteon') {
    return {
      protocol: 'insteon',
      source: entry.source,
      sourceVersion: entry.sourceVersion,
      entryKind: entry.entryKind,
      category: entry.categoryHex,
      subcategory: entry.subcategoryHex,
      model: entry.model,
      productKey: entry.productKey,
      label: entry.label,
      featureCount: entry.homebrainFeatures?.length || 0
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
  if (entry.protocol === 'zigbee') {
    return compactZigbeeEntry(entry, { includeExposes: true });
  }
  if (entry.protocol === 'zwave') {
    return compactZWaveEntry(entry, { includeConfig: true });
  }
  if (entry.protocol === 'matter') {
    return compactMatterEntry(entry);
  }
  if (entry.protocol === 'thread') {
    return compactThreadEntry(entry);
  }
  if (entry.protocol === 'insteon') {
    return compactInsteonEntry(entry);
  }
  return sanitizeValue(entry);
}

async function getSummary() {
  const zigbee = loadZigbeeCatalog();
  const zwave = await loadZWaveCatalog();
  const matter = await loadMatterCatalog();
  const thread = loadThreadCatalog();
  const insteon = loadInsteonCatalog();
  const updateStatus = getUpdateStatus();
  const zigbeeVendors = new Set(zigbee.entries.map((entry) => normalizeLookupKey(entry.vendor)).filter(Boolean));
  const zwaveManufacturers = new Set(zwave.entries.map((entry) => normalizeLookupKey(entry.manufacturerId || entry.manufacturer)).filter(Boolean));
  const matterProductVendors = new Set(matter.productEntries.map((entry) => entry.vendorIdHex).filter(Boolean));
  const insteonCategories = new Set(insteon.entries.map((entry) => entry.categoryHex).filter(Boolean));
  const zigbeeFeatures = {};
  const zwaveFeatures = {};
  const matterFeatures = {};
  const threadFeatures = {};
  const insteonFeatures = {};

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
  matter.entries.forEach((entry) => {
    entry.homebrainFeatures.forEach((feature) => {
      matterFeatures[feature] = (matterFeatures[feature] || 0) + 1;
    });
  });
  thread.entries.forEach((entry) => {
    entry.homebrainFeatures.forEach((feature) => {
      threadFeatures[feature] = (threadFeatures[feature] || 0) + 1;
    });
  });
  insteon.entries.forEach((entry) => {
    entry.homebrainFeatures.forEach((feature) => {
      insteonFeatures[feature] = (insteonFeatures[feature] || 0) + 1;
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
    },
    matter: {
      source: `${matter.packageInfo.name} + CSA Matter DCL`,
      sourceVersion: matter.packageInfo.version,
      standardDeviceTypeCount: matter.standardEntries.length,
      certifiedProductCount: matter.productEntries.length,
      vendorProductCount: matterProductVendors.size,
      featureCounts: matterFeatures,
      snapshot: updateStatus.snapshots.matter,
      errors: matter.errors.slice(0, 10)
    },
    thread: {
      source: 'Thread Group Certified Products + Matter over Thread descriptors',
      certifiedProductCount: thread.entries.length,
      featureCounts: threadFeatures,
      snapshot: updateStatus.snapshots.thread,
      note: 'Thread is a mesh transport; HomeBrain uses Matter descriptors/catalog entries for Matter-over-Thread device capabilities.',
      errors: thread.errors.slice(0, 10)
    },
    insteon: {
      source: 'INSTEON Developer Guide + Madreporite device list',
      productEntryCount: toArray(insteon.snapshot.devices).length,
      categoryCount: insteonCategories.size,
      entryCount: insteon.entries.length,
      featureCounts: insteonFeatures,
      snapshot: updateStatus.snapshots.insteon,
      errors: insteon.errors.slice(0, 10)
    },
    updates: {
      lastRunAt: updateStatus.lastRunAt,
      lastSuccessAt: updateStatus.lastSuccessAt,
      nextDueAt: updateStatus.nextDueAt,
      due: updateStatus.due,
      refreshIntervalMs: updateStatus.refreshIntervalMs,
      sources: updateStatus.sources,
      errors: updateStatus.errors
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
  getUpdateStatus,
  getZWaveNodeCatalogEntry,
  lookupInsteonCatalogEntry,
  lookupMatterCatalogEntry,
  lookupThreadCatalogEntry,
  lookupZWaveCatalogEntry,
  parseBoolean,
  parseLimit,
  refreshExternalCatalogs,
  searchInsteonCatalog,
  searchMatterCatalog,
  searchThreadCatalog,
  searchZigbeeCatalog,
  searchZWaveCatalog,
  _test: {
    fetchInsteonDeviceRows,
    fetchMatterDclModels,
    fetchThreadCertifiedProducts,
    formatZWaveHex,
    parseCsvRows,
    parseInsteonDeviceListCsv,
    parseThreadCertifiedProductsHtml,
    inferZigbeeFeaturesFromExposes,
    inferZWaveFeaturesFromText,
    loadInsteonCatalog,
    loadMatterCatalog,
    loadThreadCatalog,
    lookupInsteonCatalogEntry,
    lookupMatterCatalogEntry,
    lookupThreadCatalogEntry,
    resetCatalogCaches() {
      zigbeeCatalogCache = null;
      zwaveCatalogPromise = null;
      matterCatalogPromise = null;
      threadCatalogCache = null;
      insteonCatalogCache = null;
    },
    serializeExpose,
    serializeZWaveParameter
  }
};

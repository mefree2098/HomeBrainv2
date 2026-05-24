const STANDARD_DEVICE_SOURCE_OPTIONS = Object.freeze([
  { value: 'homebrain-zigbee', label: 'Zigbee', aliases: ['zigbee'] },
  { value: 'homebrain-zwave', label: 'Z-Wave', aliases: ['zwave', 'z-wave'] },
  { value: 'homebrain-thread', label: 'Thread', aliases: ['thread'] },
  { value: 'homebrain-matter', label: 'Matter', aliases: ['matter'] },
  { value: 'ecobee', label: 'Ecobee', aliases: [] },
  { value: 'govee', label: 'Govee', aliases: [] },
  { value: 'harmony', label: 'Harmony', aliases: [] },
  { value: 'insteon', label: 'Insteon', aliases: [] },
  { value: 'rainmachine', label: 'RainMachine', aliases: [] },
  { value: 'sense', label: 'Sense', aliases: [] },
  { value: 'smartthings', label: 'SmartThings', aliases: [] },
  { value: 'tempest', label: 'Tempest', aliases: [] }
]);

const SOURCE_OPTIONS_BY_VALUE = new Map();
const SOURCE_ALIASES = new Map();

for (const option of STANDARD_DEVICE_SOURCE_OPTIONS) {
  SOURCE_OPTIONS_BY_VALUE.set(option.value, option);
  SOURCE_ALIASES.set(option.value, option.value);
  for (const alias of option.aliases || []) {
    SOURCE_ALIASES.set(alias, option.value);
  }
}

SOURCE_ALIASES.set('homebrain', 'local');
SOURCE_ALIASES.set('manual', 'local');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function normalizeSourceToken(value) {
  return normalizeString(value).toLowerCase();
}

function normalizeRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(normalizeRecord(value), key);
}

function escapeRegexLiteral(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactRegex(value) {
  return new RegExp(`^${escapeRegexLiteral(value)}$`, 'i');
}

function canonicalizeDeviceSource(source) {
  const normalized = normalizeSourceToken(source);
  return SOURCE_ALIASES.get(normalized) || normalized;
}

function getSourceAliases(canonicalSource) {
  const canonical = canonicalizeDeviceSource(canonicalSource);
  const option = SOURCE_OPTIONS_BY_VALUE.get(canonical);
  return [canonical, ...(option?.aliases || [])].filter(Boolean);
}

function getDeviceSource(device = {}) {
  const properties = normalizeRecord(device.properties);
  const explicitSource = canonicalizeDeviceSource(device.source || properties.source);
  if (explicitSource) {
    return explicitSource;
  }

  const direct = normalizeRecord(properties.homebrainDirect);
  const directProtocol = normalizeSourceToken(direct.protocol);
  if (directProtocol === 'zigbee') {
    return 'homebrain-zigbee';
  }
  if (directProtocol === 'zwave' || directProtocol === 'z-wave') {
    return 'homebrain-zwave';
  }

  const matter = normalizeRecord(properties.matter);
  if (hasOwn(matter, 'nodeId') || hasOwn(properties, 'matterNodeId') || hasOwn(properties, 'matterFeatures')) {
    return 'homebrain-matter';
  }

  if (properties.smartThingsDeviceId || properties.smartThingsId) {
    return 'smartthings';
  }
  if (properties.harmonyDeviceId || properties.harmonyHubIp) {
    return 'harmony';
  }
  if (properties.insteonAddress || properties.insteonDeviceId) {
    return 'insteon';
  }
  if (properties.senseDeviceId || properties.senseMonitorId) {
    return 'sense';
  }
  if (properties.ecobeeThermostatIdentifier || properties.ecobeeDeviceId) {
    return 'ecobee';
  }
  if (properties.govee || properties.goveeDevice || properties.goveeDeviceId) {
    return 'govee';
  }
  if (properties.rainmachine) {
    return 'rainmachine';
  }
  if (properties.tempestStationId || properties.tempestDeviceId) {
    return 'tempest';
  }

  return 'local';
}

function getDeviceSourceFacets(device = {}) {
  const properties = normalizeRecord(device.properties);
  const matter = normalizeRecord(properties.matter);
  const transports = [
    matter.transport,
    properties.matterTransport,
    properties.transport,
    properties.networkTransport
  ].map(normalizeSourceToken);
  const facets = new Set([getDeviceSource(device)]);

  if (transports.includes('thread')) {
    facets.add('homebrain-thread');
  }

  return Array.from(facets).filter(Boolean);
}

function getDeviceSourceLabel(source) {
  const canonical = canonicalizeDeviceSource(source);
  if (!canonical) {
    return 'Unknown';
  }

  const known = SOURCE_OPTIONS_BY_VALUE.get(canonical);
  if (known) {
    return known.label;
  }
  if (canonical === 'local') {
    return 'HomeBrain';
  }

  return canonical
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sourceRegexQuery(canonicalSource) {
  const sourceAliases = getSourceAliases(canonicalSource);
  return {
    $or: sourceAliases.map((source) => ({ 'properties.source': exactRegex(source) }))
  };
}

function buildDeviceSourceFilterQuery(source) {
  const canonical = canonicalizeDeviceSource(source);

  if (!canonical || canonical === 'all') {
    return {};
  }

  if (canonical === 'unknown') {
    return {
      $or: [
        { 'properties.source': { $exists: false } },
        { 'properties.source': null },
        { 'properties.source': '' }
      ]
    };
  }

  if (canonical === 'local') {
    return {
      $or: [
        { 'properties.source': exactRegex('local') },
        { 'properties.source': exactRegex('homebrain') },
        { 'properties.source': exactRegex('manual') },
        {
          $and: [
            {
              $or: [
                { 'properties.source': { $exists: false } },
                { 'properties.source': null },
                { 'properties.source': '' }
              ]
            },
            {
              $nor: [
                { 'properties.homebrainDirect.protocol': { $exists: true } },
                { 'properties.matter.nodeId': { $exists: true } },
                { 'properties.matterNodeId': { $exists: true } },
                { 'properties.matterFeatures': { $exists: true } },
                { 'properties.smartThingsDeviceId': { $exists: true } },
                { 'properties.smartThingsId': { $exists: true } },
                { 'properties.harmonyDeviceId': { $exists: true } },
                { 'properties.harmonyHubIp': { $exists: true } },
                { 'properties.insteonAddress': { $exists: true } },
                { 'properties.insteonDeviceId': { $exists: true } },
                { 'properties.senseDeviceId': { $exists: true } },
                { 'properties.senseMonitorId': { $exists: true } },
                { 'properties.ecobeeThermostatIdentifier': { $exists: true } },
                { 'properties.ecobeeDeviceId': { $exists: true } },
                { 'properties.rainmachine': { $exists: true } },
                { 'properties.tempestStationId': { $exists: true } },
                { 'properties.tempestDeviceId': { $exists: true } }
              ]
            }
          ]
        }
      ]
    };
  }

  if (canonical === 'homebrain-zigbee') {
    return {
      $or: [
        ...getSourceAliases(canonical).map((source) => ({ 'properties.source': exactRegex(source) })),
        { 'properties.homebrainDirect.protocol': exactRegex('zigbee') }
      ]
    };
  }

  if (canonical === 'homebrain-zwave') {
    return {
      $or: [
        ...getSourceAliases(canonical).map((source) => ({ 'properties.source': exactRegex(source) })),
        { 'properties.homebrainDirect.protocol': exactRegex('zwave') },
        { 'properties.homebrainDirect.protocol': exactRegex('z-wave') }
      ]
    };
  }

  if (canonical === 'homebrain-thread') {
    return {
      $or: [
        ...getSourceAliases(canonical).map((source) => ({ 'properties.source': exactRegex(source) })),
        { 'properties.matter.transport': exactRegex('thread') },
        { 'properties.matterTransport': exactRegex('thread') },
        { 'properties.transport': exactRegex('thread') },
        { 'properties.networkTransport': exactRegex('thread') }
      ]
    };
  }

  if (canonical === 'homebrain-matter') {
    return {
      $or: [
        ...getSourceAliases(canonical).map((source) => ({ 'properties.source': exactRegex(source) })),
        { 'properties.matter.nodeId': { $exists: true } },
        { 'properties.matterNodeId': { $exists: true } },
        { 'properties.matterFeatures': { $exists: true } }
      ]
    };
  }

  return sourceRegexQuery(canonical);
}

function buildDeviceSourceOptions(devices = [], options = {}) {
  const includeUnknown = options.includeUnknown === true;
  const sources = new Set(STANDARD_DEVICE_SOURCE_OPTIONS.map((source) => source.value));

  for (const device of devices) {
    for (const source of getDeviceSourceFacets(device)) {
      if (source) {
        sources.add(source);
      }
    }
  }

  if (includeUnknown) {
    sources.add('unknown');
  }

  return Array.from(sources)
    .sort((left, right) => getDeviceSourceLabel(left).localeCompare(getDeviceSourceLabel(right)))
    .map((source) => ({ value: source, label: getDeviceSourceLabel(source) }));
}

module.exports = {
  STANDARD_DEVICE_SOURCE_OPTIONS,
  buildDeviceSourceFilterQuery,
  buildDeviceSourceOptions,
  canonicalizeDeviceSource,
  getDeviceSource,
  getDeviceSourceFacets,
  getDeviceSourceLabel,
  getSourceAliases
};

const MATTER_SOURCE = 'homebrain-matter';

const MATTER_TRANSPORTS = Object.freeze({
  ip: 'ip',
  wifi: 'wifi',
  ethernet: 'ethernet',
  thread: 'thread',
  ble: 'ble'
});

const MATTER_FEATURE_LABELS = Object.freeze({
  switch: 'On/off switching',
  brightness: 'Brightness / dimming',
  color: 'RGB color',
  colorTemperature: 'Color temperature',
  contact: 'Open/closed contact state',
  motion: 'Motion / occupancy',
  temperature: 'Temperature',
  humidity: 'Humidity',
  illuminance: 'Illuminance',
  battery: 'Battery level',
  lock: 'Lock / unlock',
  doorState: 'Door state',
  garage: 'Garage / closure control',
  windowCovering: 'Window covering / shade',
  thermostat: 'Thermostat mode and setpoints',
  fan: 'Fan control',
  power: 'Instant power',
  energy: 'Energy total',
  smoke: 'Smoke alarm state',
  carbonMonoxide: 'Carbon monoxide alarm state',
  water: 'Water / leak state',
  pressure: 'Pressure',
  soilMoisture: 'Soil moisture',
  airQuality: 'Air quality',
  camera: 'Camera stream metadata',
  doorbell: 'Doorbell event metadata',
  chime: 'Chime / tone',
  speaker: 'Audio playback',
  valve: 'Valve control',
  firmware: 'Firmware status',
  health: 'Health / online state'
});

const MATTER_CLUSTER_FEATURES = Object.freeze({
  6: ['switch'],
  8: ['brightness'],
  47: ['battery'],
  69: ['contact'],
  80: ['health'],
  92: ['smoke', 'carbonMonoxide'],
  113: ['doorState'],
  129: ['valve'],
  144: ['power'],
  145: ['energy'],
  257: ['lock', 'doorState'],
  258: ['windowCovering', 'garage'],
  513: ['thermostat'],
  514: ['fan'],
  768: ['color', 'colorTemperature'],
  1024: ['illuminance'],
  1026: ['temperature'],
  1027: ['pressure'],
  1029: ['humidity'],
  1030: ['motion'],
  1032: ['soilMoisture'],
  1036: ['carbonMonoxide'],
  1037: ['airQuality'],
  1296: ['power', 'energy'],
  1297: ['energy']
});

const DEVICE_TYPE_FEATURE_HINTS = [
  { pattern: /\b(on.?off|plug|outlet|switch)\b/i, features: ['switch'], homeBrainType: 'switch' },
  { pattern: /\b(light|bulb|lamp)\b/i, features: ['switch', 'brightness'], homeBrainType: 'light' },
  { pattern: /\b(color|rgb)\b/i, features: ['color', 'brightness'], homeBrainType: 'light' },
  { pattern: /\b(contact|door.?window)\b/i, features: ['contact', 'battery'], homeBrainType: 'sensor' },
  { pattern: /\b(occupancy|motion)\b/i, features: ['motion', 'battery'], homeBrainType: 'sensor' },
  { pattern: /\b(temperature|thermometer)\b/i, features: ['temperature', 'battery'], homeBrainType: 'sensor' },
  { pattern: /\b(humidity)\b/i, features: ['humidity', 'battery'], homeBrainType: 'sensor' },
  { pattern: /\b(illuminance|light sensor)\b/i, features: ['illuminance', 'battery'], homeBrainType: 'sensor' },
  { pattern: /\b(lock|deadbolt)\b/i, features: ['lock', 'doorState', 'battery'], homeBrainType: 'lock' },
  { pattern: /\b(thermostat)\b/i, features: ['thermostat', 'temperature'], homeBrainType: 'thermostat' },
  { pattern: /\b(fan)\b/i, features: ['fan', 'switch'], homeBrainType: 'switch' },
  { pattern: /\b(garage|closure|shade|covering|blind|drape|awning|gate)\b/i, features: ['windowCovering'], homeBrainType: 'garage' },
  { pattern: /\b(smoke|co|carbon monoxide)\b/i, features: ['smoke', 'carbonMonoxide', 'battery'], homeBrainType: 'sensor' },
  { pattern: /\b(water|leak|flood)\b/i, features: ['water', 'battery'], homeBrainType: 'sensor' },
  { pattern: /\b(camera|video)\b/i, features: ['camera'], homeBrainType: 'camera' },
  { pattern: /\b(doorbell)\b/i, features: ['doorbell', 'camera'], homeBrainType: 'camera' },
  { pattern: /\b(chime)\b/i, features: ['chime'], homeBrainType: 'speaker' },
  { pattern: /\b(speaker|audio)\b/i, features: ['speaker'], homeBrainType: 'speaker' },
  { pattern: /\b(valve)\b/i, features: ['valve'], homeBrainType: 'switch' },
  { pattern: /\b(soil)\b/i, features: ['soilMoisture', 'temperature'], homeBrainType: 'sensor' },
  { pattern: /\b(air quality)\b/i, features: ['airQuality'], homeBrainType: 'sensor' }
];

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeClusterId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = trimmed.startsWith('0x')
      ? Number.parseInt(trimmed.slice(2), 16)
      : Number(trimmed);
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  if (value && typeof value === 'object') {
    return normalizeClusterId(value.id ?? value.clusterId ?? value.code);
  }
  return null;
}

function normalizeFeatureList(features = []) {
  return Array.from(new Set(
    (Array.isArray(features) ? features : [])
      .map((feature) => normalizeString(feature))
      .filter((feature) => MATTER_FEATURE_LABELS[feature])
  )).sort();
}

function featureSupport(features = []) {
  return normalizeFeatureList(features).map((key) => ({
    key,
    label: MATTER_FEATURE_LABELS[key] || key,
    supported: true,
    support: 'native'
  }));
}

function inferFeaturesFromMatterDescriptor(descriptor = {}) {
  const features = new Set();
  const clusterIds = Array.isArray(descriptor.clusterIds) ? descriptor.clusterIds : [];
  const clusterNames = Array.isArray(descriptor.clusterNames) ? descriptor.clusterNames : [];
  const deviceTypeNames = Array.isArray(descriptor.deviceTypeNames) ? descriptor.deviceTypeNames : [];

  clusterIds.forEach((rawClusterId) => {
    const clusterId = normalizeClusterId(rawClusterId);
    (MATTER_CLUSTER_FEATURES[clusterId] || []).forEach((feature) => features.add(feature));
  });

  const haystack = [
    descriptor.name,
    descriptor.productName,
    descriptor.vendorName,
    descriptor.endpointName,
    ...clusterNames,
    ...deviceTypeNames
  ]
    .map((value) => normalizeString(value).toLowerCase())
    .filter(Boolean)
    .join(' ');

  DEVICE_TYPE_FEATURE_HINTS.forEach((hint) => {
    if (hint.pattern.test(haystack)) {
      hint.features.forEach((feature) => features.add(feature));
    }
  });

  return normalizeFeatureList(Array.from(features));
}

function inferHomeBrainTypeFromFeatures(features = [], descriptor = {}) {
  const featureSet = new Set(normalizeFeatureList(features));
  if (featureSet.has('lock')) {
    return 'lock';
  }
  if (featureSet.has('thermostat')) {
    return 'thermostat';
  }
  if (featureSet.has('camera') || featureSet.has('doorbell')) {
    return 'camera';
  }
  if (featureSet.has('speaker') || featureSet.has('chime')) {
    return 'speaker';
  }
  if (featureSet.has('garage') || featureSet.has('windowCovering')) {
    return 'garage';
  }
  if (
    featureSet.has('contact')
    || featureSet.has('motion')
    || featureSet.has('temperature')
    || featureSet.has('humidity')
    || featureSet.has('illuminance')
    || featureSet.has('smoke')
    || featureSet.has('carbonMonoxide')
    || featureSet.has('water')
    || featureSet.has('soilMoisture')
    || featureSet.has('airQuality')
  ) {
    return 'sensor';
  }
  if (featureSet.has('switch') || featureSet.has('fan') || featureSet.has('valve')) {
    const descriptorText = [
      descriptor.name,
      descriptor.productName,
      descriptor.endpointName,
      ...(Array.isArray(descriptor.deviceTypeNames) ? descriptor.deviceTypeNames : [])
    ].map((value) => normalizeString(value).toLowerCase()).join(' ');
    return /\b(light|bulb|lamp)\b/.test(descriptorText) || featureSet.has('brightness') || featureSet.has('color')
      ? 'light'
      : 'switch';
  }

  return 'switch';
}

function buildMatterFeatureProperties(features = []) {
  const featureSet = new Set(normalizeFeatureList(features));
  return {
    supportsBrightness: featureSet.has('brightness'),
    supportsColor: featureSet.has('color'),
    supportsColorTemperature: featureSet.has('colorTemperature'),
    supportsAlarm: featureSet.has('smoke') || featureSet.has('carbonMonoxide') || featureSet.has('chime')
  };
}

function matterFeatureLabels(features = []) {
  return normalizeFeatureList(features).map((feature) => MATTER_FEATURE_LABELS[feature] || feature);
}

module.exports = {
  MATTER_SOURCE,
  MATTER_TRANSPORTS,
  MATTER_FEATURE_LABELS,
  MATTER_CLUSTER_FEATURES,
  buildMatterFeatureProperties,
  featureSupport,
  inferFeaturesFromMatterDescriptor,
  inferHomeBrainTypeFromFeatures,
  matterFeatureLabels,
  normalizeClusterId,
  normalizeFeatureList
};

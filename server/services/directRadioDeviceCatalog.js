const DIRECT_RADIO_SOURCES = Object.freeze({
  zigbee: 'homebrain-zigbee',
  zwave: 'homebrain-zwave'
});

const SOURCE_PROTOCOLS = Object.freeze({
  [DIRECT_RADIO_SOURCES.zigbee]: 'zigbee',
  [DIRECT_RADIO_SOURCES.zwave]: 'zwave'
});

const FEATURE_LABELS = Object.freeze({
  switch: 'On/off switching',
  brightness: 'Brightness / dimming',
  color: 'RGB color',
  colorTemperature: 'Color temperature',
  contact: 'Open/closed contact state',
  motion: 'Motion state',
  temperature: 'Temperature',
  humidity: 'Humidity',
  illuminance: 'Illuminance',
  battery: 'Battery level',
  tamper: 'Tamper state',
  acceleration: 'Acceleration / vibration',
  axis: 'Three-axis movement',
  lock: 'Lock / unlock',
  lockCodes: 'Lock code metadata',
  power: 'Instant power',
  energy: 'Energy total',
  alarm: 'Siren / alarm',
  chime: 'Chime / tone',
  button: 'Button / key fob events',
  presence: 'Presence',
  water: 'Water / leak state',
  smoke: 'Smoke state',
  carbonMonoxide: 'Carbon monoxide state',
  thermostat: 'Thermostat mode and setpoints',
  fan: 'Thermostat fan mode',
  pressure: 'Pressure',
  weight: 'Weight',
  voltage: 'Voltage',
  firmware: 'Firmware status',
  health: 'Health / online state'
});

const SMARTTHINGS_CAPABILITY_FEATURES = Object.freeze({
  switch: ['switch'],
  switchLevel: ['brightness'],
  colorControl: ['color', 'brightness'],
  colorTemperature: ['colorTemperature'],
  contactSensor: ['contact'],
  motionSensor: ['motion'],
  temperatureMeasurement: ['temperature'],
  relativeHumidityMeasurement: ['humidity'],
  illuminanceMeasurement: ['illuminance'],
  battery: ['battery'],
  tamperAlert: ['tamper'],
  accelerationSensor: ['acceleration'],
  threeAxis: ['axis'],
  lock: ['lock'],
  lockCodes: ['lockCodes'],
  powerMeter: ['power'],
  energyMeter: ['energy'],
  alarm: ['alarm'],
  chime: ['chime'],
  button: ['button'],
  presenceSensor: ['presence'],
  waterSensor: ['water'],
  smokeDetector: ['smoke'],
  carbonMonoxideDetector: ['carbonMonoxide'],
  thermostat: ['thermostat'],
  thermostatCoolingSetpoint: ['thermostat'],
  thermostatHeatingSetpoint: ['thermostat'],
  thermostatMode: ['thermostat'],
  thermostatFanMode: ['fan'],
  thermostatOperatingState: ['thermostat'],
  pressureMeasurement: ['pressure'],
  weightMeasurement: ['weight'],
  voltageMeasurement: ['voltage'],
  firmwareUpdate: ['firmware'],
  healthCheck: ['health']
});

const ZIGBEE_PREFERRED_FEATURES = new Set([
  'switch',
  'brightness',
  'color',
  'colorTemperature',
  'contact',
  'motion',
  'temperature',
  'humidity',
  'illuminance',
  'battery',
  'tamper',
  'acceleration',
  'axis',
  'power',
  'energy',
  'button',
  'presence',
  'water'
]);

const ZWAVE_PREFERRED_FEATURES = new Set([
  'switch',
  'brightness',
  'lock',
  'lockCodes',
  'alarm',
  'chime',
  'contact',
  'motion',
  'temperature',
  'humidity',
  'illuminance',
  'battery',
  'tamper',
  'power',
  'energy',
  'water',
  'smoke',
  'carbonMonoxide',
  'thermostat',
  'fan',
  'voltage'
]);

const CLOUD_ONLY_KEYWORDS = [
  'arlo',
  'camera',
  'doorbell',
  'harmony',
  'ring',
  'samsung tv',
  'smartthings home monitor',
  'sthm',
  'television',
  'tv',
  'virtual',
  'web request'
];

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeToken(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value === 'object') {
    return normalizeString(value.id || value.capabilityId || value.name || value.value);
  }

  return String(value).trim();
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getSmartThingsCapabilities(device) {
  const properties = device?.properties || {};
  return uniqueStrings([
    ...(Array.isArray(properties.smartThingsCapabilities) ? properties.smartThingsCapabilities : []),
    ...(Array.isArray(properties.smartthingsCapabilities) ? properties.smartthingsCapabilities : []),
    ...(Array.isArray(device?.capabilities) ? device.capabilities : [])
  ].map(normalizeToken));
}

function getSmartThingsCategories(device) {
  const properties = device?.properties || {};
  return uniqueStrings([
    ...(Array.isArray(properties.smartThingsCategories) ? properties.smartThingsCategories : []),
    ...(Array.isArray(properties.smartthingsCategories) ? properties.smartthingsCategories : []),
    ...(Array.isArray(device?.categories) ? device.categories : [])
  ].map(normalizeToken).map((entry) => entry.toLowerCase()));
}

function getDeviceDescriptor(device) {
  return [
    device?.name,
    device?.type,
    device?.brand,
    device?.model,
    device?.room,
    device?.properties?.source,
    device?.properties?.smartThingsDeviceTypeName,
    device?.properties?.smartThingsPresentationId,
    device?.properties?.smartThingsManufacturerName,
    device?.properties?.smartThingsDeviceNetworkType,
    ...getSmartThingsCategories(device),
    ...getSmartThingsCapabilities(device)
  ]
    .map((entry) => normalizeToken(entry).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function inferFeaturesFromSmartThings(device) {
  const features = new Set();
  const capabilities = getSmartThingsCapabilities(device);
  const categories = getSmartThingsCategories(device);
  const descriptor = getDeviceDescriptor(device);

  capabilities.forEach((capability) => {
    (SMARTTHINGS_CAPABILITY_FEATURES[capability] || []).forEach((feature) => features.add(feature));
  });

  if (categories.includes('siren')) {
    features.add('alarm');
  }
  if (categories.includes('light')) {
    features.add('switch');
    features.add('brightness');
  }
  if (categories.includes('lock')) {
    features.add('lock');
  }
  if (categories.includes('motion')) {
    features.add('motion');
  }
  if (categories.includes('contact')) {
    features.add('contact');
  }
  if (/\b(?:dimmer|bulb|light|led|rgb)\b/.test(descriptor)) {
    features.add('switch');
    features.add('brightness');
  }
  if (/\b(?:plug|outlet|switch|repeater|extender)\b/.test(descriptor)) {
    features.add('switch');
  }
  if (/\b(?:deadbolt|lock)\b/.test(descriptor)) {
    features.add('lock');
    features.add('battery');
  }
  if (/\b(?:siren|alarm)\b/.test(descriptor)) {
    features.add('alarm');
  }
  if (/\b(?:fob|button|keypad|scene controller)\b/.test(descriptor)) {
    features.add('button');
    features.add('battery');
  }

  return Array.from(features).sort();
}

function isDirectRadioDevice(device) {
  const source = normalizeString(device?.properties?.source).toLowerCase();
  if (SOURCE_PROTOCOLS[source]) {
    return true;
  }

  return Boolean(device?.properties?.homebrainDirect?.protocol);
}

function getDirectProtocol(device) {
  const source = normalizeString(device?.properties?.source).toLowerCase();
  if (SOURCE_PROTOCOLS[source]) {
    return SOURCE_PROTOCOLS[source];
  }

  const protocol = normalizeString(device?.properties?.homebrainDirect?.protocol).toLowerCase();
  return protocol === 'zigbee' || protocol === 'zwave' ? protocol : null;
}

function inferProtocolFromSmartThings(device) {
  const descriptor = getDeviceDescriptor(device);
  const capabilities = new Set(getSmartThingsCapabilities(device));
  const categories = new Set(getSmartThingsCategories(device));
  const features = inferFeaturesFromSmartThings(device);

  let zigbeeScore = 0;
  let zwaveScore = 0;

  features.forEach((feature) => {
    if (ZIGBEE_PREFERRED_FEATURES.has(feature)) {
      zigbeeScore += 1;
    }
    if (ZWAVE_PREFERRED_FEATURES.has(feature)) {
      zwaveScore += 1;
    }
  });

  if (capabilities.has('lock') || capabilities.has('lockCodes') || categories.has('lock')) {
    zwaveScore += 6;
  }
  if (capabilities.has('alarm') || categories.has('siren') || /\b(?:aeotec|utilitech|z-wave|zwave|z wave)\b/.test(descriptor)) {
    zwaveScore += 4;
  }
  if (/\b(?:deadbolt|zooz|linear|schlage|kwikset|yale|jasco|ge)\b/.test(descriptor)) {
    zwaveScore += 3;
  }
  if (/\b(?:smartthings|multipurpose|iris|centralite|sonoff|hue|sengled|aqara|ikea|tradfri|cree|zigbee)\b/.test(descriptor)) {
    zigbeeScore += 3;
  }
  if (capabilities.has('threeAxis') || capabilities.has('accelerationSensor')) {
    zigbeeScore += 2;
  }
  if (capabilities.has('colorControl') || capabilities.has('colorTemperature')) {
    zigbeeScore += 2;
  }
  if (capabilities.has('zwMultichannel')) {
    zwaveScore += 5;
  }

  if (zwaveScore >= zigbeeScore + 2) {
    return 'zwave';
  }
  if (zigbeeScore >= zwaveScore + 2) {
    return 'zigbee';
  }

  return 'unknown';
}

function isCloudOrVirtualOnly(device) {
  const source = normalizeString(device?.properties?.source).toLowerCase();
  const descriptor = getDeviceDescriptor(device);

  if (source && source !== 'smartthings') {
    return false;
  }

  if (device?.properties?.smartThingsDeviceNetworkType === 'CLOUD') {
    return true;
  }

  return CLOUD_ONLY_KEYWORDS.some((keyword) => descriptor.includes(keyword));
}

function normalizeFeature(feature) {
  return normalizeString(feature)
    .replace(/[^a-zA-Z0-9]/g, '')
    .replace(/^colour/i, 'color')
    .replace(/^colourtemperature/i, 'colorTemperature');
}

function buildFeatureSupport(features, protocol = 'unknown') {
  const preferred = protocol === 'zigbee'
    ? ZIGBEE_PREFERRED_FEATURES
    : protocol === 'zwave'
      ? ZWAVE_PREFERRED_FEATURES
      : new Set([...ZIGBEE_PREFERRED_FEATURES, ...ZWAVE_PREFERRED_FEATURES]);

  return uniqueStrings(features.map(normalizeFeature))
    .sort()
    .map((feature) => ({
      key: feature,
      label: FEATURE_LABELS[feature] || feature,
      supported: preferred.has(feature),
      support: preferred.has(feature) ? 'native' : 'best_effort'
    }));
}

function getManualResetGuidance(protocol, device) {
  const name = normalizeString(device?.name) || 'the device';
  const features = new Set(inferFeaturesFromSmartThings(device));

  if (protocol === 'zwave') {
    const lockNote = features.has('lock')
      ? 'For a door lock, keep it close to the Zooz stick during inclusion, start inclusion from HomeBrain, then enter the lock pairing/exclusion sequence at the keypad or interior button so S2 security can complete.'
      : 'For powered Z-Wave modules, run exclusion first if the device was ever joined to SmartThings, then start inclusion from HomeBrain and trigger the device pair action.';
    return [
      `Start Z-Wave exclusion from HomeBrain for ${name}.`,
      'Trigger the device exclusion/reset sequence from the manufacturer instructions.',
      lockNote,
      'After HomeBrain sees the node, verify lock/switch/sensor state and battery before removing or ignoring the old SmartThings entry.'
    ];
  }

  if (protocol === 'zigbee') {
    return [
      `Put ${name} into factory reset or pairing mode. Most Zigbee sensors require holding the reset/pair button until the LED begins blinking.`,
      'Start Zigbee permit-join from HomeBrain.',
      'Keep battery sensors awake near the SONOFF coordinator until HomeBrain reports the interview as complete.',
      'Verify state, temperature, battery, and any tamper/acceleration attributes before removing or ignoring the old SmartThings entry.'
    ];
  }

  return [
    `Choose Zigbee or Z-Wave for ${name} after checking the product label or the SmartThings device details.`,
    'Run exclusion/reset first for Z-Wave devices; run factory reset/pair mode for Zigbee devices.',
    'Start the matching HomeBrain pairing flow and validate state plus battery before retiring the SmartThings entry.'
  ];
}

function buildMigrationPlan(device, options = {}) {
  const overrideProtocol = normalizeString(options.protocol).toLowerCase();
  const inferredProtocol = inferProtocolFromSmartThings(device);
  const protocol = ['zigbee', 'zwave'].includes(overrideProtocol) ? overrideProtocol : inferredProtocol;
  const features = inferFeaturesFromSmartThings(device);
  const cloudOnly = isCloudOrVirtualOnly(device);
  const source = normalizeString(device?.properties?.source).toLowerCase();
  const smartThingsDeviceId = normalizeString(device?.properties?.smartThingsDeviceId);

  const warnings = [];
  if (!smartThingsDeviceId && source !== 'smartthings') {
    warnings.push('This device is not currently identified as SmartThings-backed, so migration will not preserve a SmartThings device id.');
  }
  if (cloudOnly) {
    warnings.push('This looks like a cloud, virtual, camera, TV, Harmony, or SmartThings Home Monitor helper. HomeBrain direct Zigbee/Z-Wave should not replace it.');
  }
  if (protocol === 'unknown') {
    warnings.push('HomeBrain could not infer whether this is Zigbee or Z-Wave from SmartThings metadata. The UI will let you choose the radio manually.');
  }
  if (features.includes('lock')) {
    warnings.push('Door locks must be migrated carefully with S2 security. Keep the lock close to the Zooz controller until inclusion completes.');
  }
  if (features.includes('battery')) {
    warnings.push('Battery devices may need to be awakened repeatedly during interview so HomeBrain can capture battery and sensor metadata.');
  }

  const supportedFeatures = buildFeatureSupport(features, protocol);
  const unsupportedFeatures = supportedFeatures.filter((entry) => entry.supported === false);
  if (unsupportedFeatures.length > 0) {
    warnings.push(`Some uncommon attributes will be captured as raw telemetry first: ${unsupportedFeatures.map((entry) => entry.label).join(', ')}.`);
  }

  return {
    deviceId: normalizeString(device?._id?.toString?.() || device?._id || device?.id) || null,
    smartThingsDeviceId: smartThingsDeviceId || null,
    name: normalizeString(device?.name) || 'Unnamed SmartThings device',
    room: normalizeString(device?.room) || null,
    currentSource: source || 'unknown',
    recommendedProtocol: protocol,
    inferredProtocol,
    protocolLocked: protocol === 'zigbee' || protocol === 'zwave',
    supported: !cloudOnly,
    cloudOrVirtualOnly: cloudOnly,
    features,
    featureSupport: supportedFeatures,
    manualSteps: getManualResetGuidance(protocol, device),
    warnings,
    canPreserveDeviceRecord: Boolean(device?._id),
    targetSource: protocol === 'zigbee'
      ? DIRECT_RADIO_SOURCES.zigbee
      : protocol === 'zwave'
        ? DIRECT_RADIO_SOURCES.zwave
        : null
  };
}

function buildDirectFeatureProperties(features) {
  const featureSet = new Set(features.map(normalizeFeature));
  return {
    supportsBrightness: featureSet.has('brightness'),
    supportsColor: featureSet.has('color'),
    supportsColorTemperature: featureSet.has('colorTemperature'),
    supportsBattery: featureSet.has('battery'),
    supportsPowerMeter: featureSet.has('power'),
    supportsEnergyMeter: featureSet.has('energy'),
    supportsThermostat: featureSet.has('thermostat'),
    supportsAlarm: featureSet.has('alarm'),
    supportsLockCodes: featureSet.has('lockCodes')
  };
}

module.exports = {
  DIRECT_RADIO_SOURCES,
  SOURCE_PROTOCOLS,
  FEATURE_LABELS,
  buildDirectFeatureProperties,
  buildFeatureSupport,
  buildMigrationPlan,
  getDirectProtocol,
  getSmartThingsCapabilities,
  getSmartThingsCategories,
  inferFeaturesFromSmartThings,
  inferProtocolFromSmartThings,
  isCloudOrVirtualOnly,
  isDirectRadioDevice,
  normalizeFeature
};

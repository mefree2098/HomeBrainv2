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
  light: 'Light fixture / bulb',
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
  vibration: 'Vibration state',
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
  cover: 'Cover / shade position',
  garage: 'Garage / barrier operator',
  valve: 'Valve state',
  pressure: 'Pressure',
  weight: 'Weight',
  voltage: 'Voltage',
  current: 'Current',
  repeater: 'Mesh repeater / router',
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
  vibrationSensor: ['vibration'],
  accelerationSensor: ['acceleration', 'vibration'],
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
  currentMeasurement: ['current'],
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
  'vibration',
  'acceleration',
  'axis',
  'alarm',
  'chime',
  'power',
  'energy',
  'button',
  'presence',
  'water',
  'repeater'
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
  'vibration',
  'power',
  'energy',
  'water',
  'smoke',
  'carbonMonoxide',
  'thermostat',
  'fan',
  'voltage',
  'current'
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

const SMARTTHINGS_NON_DIRECT_RADIO_NETWORK_TYPES = new Set([
  'ble',
  'cloud',
  'edgechild',
  'endpointapp',
  'hub',
  'lan',
  'matter',
  'ocf',
  'viper',
  'virtual'
]);

const SMARTTHINGS_DIRECT_RADIO_NETWORK_TYPES = new Set([
  'zigbee',
  'zw',
  'zwave'
]);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function descriptorHasKeyword(descriptor, keyword) {
  const pattern = escapeRegex(keyword).replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${pattern}\\b`).test(descriptor);
}

function normalizeSmartThingsNetworkType(value) {
  return normalizeString(value)
    .toLowerCase()
    .replace(/[\s_-]/g, '');
}

function hasSmartThingsDirectRadioNetworkType(device) {
  const networkType = normalizeSmartThingsNetworkType(device?.properties?.smartThingsDeviceNetworkType);
  return SMARTTHINGS_DIRECT_RADIO_NETWORK_TYPES.has(networkType);
}

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
    device?.properties?.smartThingsManufacturer,
    device?.properties?.smartThingsManufacturerName,
    device?.properties?.smartThingsDeviceNetworkType,
    ...getSmartThingsCategories(device),
    ...getSmartThingsCapabilities(device)
  ]
    .map((entry) => normalizeToken(entry).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function getUserFacingDeviceDescriptor(device) {
  return [
    device?.name,
    device?.label,
    device?.properties?.smartThingsLabel
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
  const userFacingDescriptor = getUserFacingDeviceDescriptor(device);
  const userNamedRepeater = /\b(?:repeater|extender|range extender|signal)\b/.test(userFacingDescriptor);
  const userNamedControllable = /\b(?:plug|outlet|socket|switch|relay|light|bulb|dimmer)\b/.test(userFacingDescriptor);

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
  if (/\b(?:plug|outlet|socket|switch|relay)\b/.test(descriptor)) {
    features.add('switch');
  }
  if (/\b(?:repeater|extender|range extender|signal repeater|signal booster)\b/.test(descriptor)) {
    features.add('repeater');
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
  if (userNamedRepeater && !userNamedControllable) {
    features.add('repeater');
    features.delete('switch');
    features.delete('power');
    features.delete('energy');
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
  const networkType = normalizeSmartThingsNetworkType(device?.properties?.smartThingsDeviceNetworkType);
  if (networkType === 'zigbee') {
    return 'zigbee';
  }
  if (networkType === 'zwave' || networkType === 'zw') {
    return 'zwave';
  }

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
  const networkType = normalizeSmartThingsNetworkType(device?.properties?.smartThingsDeviceNetworkType);

  if (source && source !== 'smartthings') {
    return false;
  }

  if (hasSmartThingsDirectRadioNetworkType(device)) {
    return false;
  }

  if (device?.properties?.smartThingsDeviceNetworkType === 'CLOUD') {
    return true;
  }
  if (networkType && SMARTTHINGS_NON_DIRECT_RADIO_NETWORK_TYPES.has(networkType)) {
    return true;
  }

  return CLOUD_ONLY_KEYWORDS.some((keyword) => descriptorHasKeyword(descriptor, keyword));
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

function buildNormalizedCapabilities(features, protocol = 'unknown') {
  const featureSet = new Set(uniqueStrings(features.map(normalizeFeature)));
  const readable = true;
  const capabilityProtocol = protocol === DIRECT_RADIO_SOURCES.zigbee
    ? 'zigbee'
    : protocol === DIRECT_RADIO_SOURCES.zwave
      ? 'zwave'
      : protocol;
  const capabilityByFeature = {
    switch: {
      type: 'switch',
      property: 'power',
      readable,
      writable: true,
      values: ['on', 'off']
    },
    light: {
      type: 'light',
      property: 'power',
      readable,
      writable: true,
      values: ['on', 'off']
    },
    brightness: {
      type: 'dimmer',
      property: 'brightness',
      readable,
      writable: true,
      min: 0,
      max: 100,
      unit: '%'
    },
    color: {
      type: 'color',
      property: 'color',
      readable,
      writable: true
    },
    colorTemperature: {
      type: 'color_temperature',
      property: 'color_temperature',
      readable,
      writable: true
    },
    contact: {
      type: 'contact_sensor',
      property: 'contact',
      readable,
      writable: false,
      values: ['open', 'closed']
    },
    motion: {
      type: 'motion_sensor',
      property: 'motion',
      readable,
      writable: false
    },
    temperature: {
      type: 'temperature_sensor',
      property: 'temperature',
      readable,
      writable: false
    },
    humidity: {
      type: 'humidity_sensor',
      property: 'humidity',
      readable,
      writable: false,
      unit: '%'
    },
    illuminance: {
      type: 'illuminance_sensor',
      property: 'illuminance',
      readable,
      writable: false,
      unit: 'lx'
    },
    battery: {
      type: 'battery',
      property: 'battery_level',
      readable,
      writable: false,
      unit: '%'
    },
    tamper: {
      type: 'tamper_sensor',
      property: 'tamper',
      readable,
      writable: false
    },
    vibration: {
      type: 'vibration_sensor',
      property: 'vibration',
      readable,
      writable: false
    },
    acceleration: {
      type: 'acceleration_sensor',
      property: 'acceleration',
      readable,
      writable: false
    },
    axis: {
      type: 'axis_sensor',
      property: 'axis',
      readable,
      writable: false
    },
    lock: {
      type: 'lock',
      property: 'lock',
      readable,
      writable: true,
      values: ['locked', 'unlocked']
    },
    lockCodes: {
      type: 'lock_codes',
      property: 'lock_codes',
      readable,
      writable: true
    },
    power: {
      type: 'power_meter',
      property: 'power',
      readable,
      writable: false,
      unit: 'W'
    },
    energy: {
      type: 'energy_meter',
      property: 'energy',
      readable,
      writable: false,
      unit: 'kWh'
    },
    alarm: {
      type: 'alarm',
      property: 'alarm',
      readable,
      writable: true
    },
    chime: {
      type: 'chime',
      property: 'chime',
      readable,
      writable: true
    },
    button: {
      type: 'button',
      property: 'button',
      readable,
      writable: false
    },
    presence: {
      type: 'presence_sensor',
      property: 'presence',
      readable,
      writable: false
    },
    water: {
      type: 'water_sensor',
      property: 'water',
      readable,
      writable: false
    },
    smoke: {
      type: 'smoke_sensor',
      property: 'smoke',
      readable,
      writable: false
    },
    carbonMonoxide: {
      type: 'carbon_monoxide_sensor',
      property: 'carbon_monoxide',
      readable,
      writable: false
    },
    thermostat: {
      type: 'thermostat',
      property: 'thermostat',
      readable,
      writable: true
    },
    fan: {
      type: 'fan',
      property: 'fan',
      readable,
      writable: true
    },
    cover: {
      type: 'cover',
      property: 'position',
      readable,
      writable: true,
      min: 0,
      max: 100,
      unit: '%'
    },
    garage: {
      type: 'garage',
      property: 'door',
      readable,
      writable: true
    },
    valve: {
      type: 'valve',
      property: 'valve',
      readable,
      writable: true
    },
    pressure: {
      type: 'pressure_sensor',
      property: 'pressure',
      readable,
      writable: false
    },
    weight: {
      type: 'weight_sensor',
      property: 'weight',
      readable,
      writable: false
    },
    voltage: {
      type: 'voltage_sensor',
      property: 'voltage',
      readable,
      writable: false,
      unit: 'V'
    },
    current: {
      type: 'current_sensor',
      property: 'current',
      readable,
      writable: false,
      unit: 'A'
    },
    repeater: {
      type: 'mesh_repeater',
      property: 'route',
      readable,
      writable: false
    },
    firmware: {
      type: 'firmware',
      property: 'firmware',
      readable,
      writable: false
    },
    health: {
      type: 'health',
      property: 'health',
      readable,
      writable: false
    }
  };

  return Array.from(featureSet)
    .sort()
    .map((feature) => capabilityByFeature[feature] || {
      type: feature,
      property: feature,
      readable,
      writable: false
    })
    .map((capability) => ({
      ...capability,
      protocol: capabilityProtocol
    }));
}

function buildGuidedStep({
  id,
  title,
  phase,
  protocol,
  action = 'user_confirm',
  automatic = false,
  durationSeconds = null,
  instructions = [],
  confirmLabel = 'Done'
}) {
  return {
    id,
    title,
    phase,
    protocol,
    action,
    automatic,
    durationSeconds,
    instructions: uniqueStrings(instructions.map(normalizeString)),
    confirmLabel
  };
}

function instructionProfile(key, label, confidence, options = {}) {
  return {
    key,
    label,
    confidence,
    reference: options.reference || null
  };
}

function getZWavePhysicalInstructions(device, features = new Set()) {
  const descriptor = getDeviceDescriptor(device);
  const name = normalizeString(device?.name) || 'the device';

  if (features.has('lock') || /\b(?:deadbolt|lock)\b/.test(descriptor)) {
    if (/\bschlage\b/.test(descriptor)) {
      return {
        profile: instructionProfile('zwave-lock-schlage-connect', 'Schlage Connect Z-Wave lock', 'high', {
          reference: 'Schlage Connect uses Schlage logo, 6-digit programming code, then 0; BE469ZP can use the red enroll/unenroll button.'
        }),
        exclusion: [
          `Keep ${name} awake and within strong Z-Wave range of the Zooz stick; fresh batteries matter for secure lock pairing.`,
          'At the outside keypad, press the Schlage logo, enter the 6-digit programming code from the inside label, then press 0.',
          'For BE469ZP/Z-Wave Plus models with an interior red enroll/unenroll button, press and release that red button instead if the keypad sequence is not accepted.',
          'Wait for the green check or success tone before continuing.'
        ],
        inclusion: [
          `Keep ${name} close to the Zooz stick until S2/S0 security and interview complete.`,
          'At the outside keypad, press the Schlage logo, enter the 6-digit programming code, then press 0.',
          'For BE469ZP/Z-Wave Plus models, press and release the interior red enroll/unenroll button if that is the model installed.',
          'If HomeBrain asks for the DSK PIN, enter the first 5 digits from the lock or module label.'
        ]
      };
    }

    if (/\b(?:kwikset|weiser|smartcode)\b/.test(descriptor)) {
      return {
        profile: instructionProfile('zwave-lock-kwikset-smartcode', 'Kwikset/Weiser SmartCode Z-Wave lock', 'high', {
          reference: 'Kwikset SmartCode 916 / 99160-002 Z-Wave locks use the interior A/Program button during controller inclusion and exclusion.'
        }),
        exclusion: [
          `Remove the interior cover on ${name} and keep the door open with the lock powered.`,
          'After SmartThings starts API removal or hub Z-Wave exclusion, press and release interior button A once. On older SmartCode models this may be labeled Program.',
          'Wait for the lock status LED or keypad to report success before moving to inclusion.'
        ],
        inclusion: [
          `Keep ${name} near the Zooz stick until secure inclusion finishes.`,
          'Press and release interior button A once. On older SmartCode models, press Program once.',
          'Leave the battery cover off until HomeBrain finishes the secure interview and battery/lock state are visible.'
        ]
      };
    }

    if (/\byale\b|\bassure\b/.test(descriptor)) {
      return {
        profile: instructionProfile('zwave-lock-yale-assure', 'Yale Assure Z-Wave lock', 'medium', {
          reference: 'Yale Assure Z-Wave modules use the lock Network Module menu; remove and add use different menu choices.'
        }),
        exclusion: [
          `Wake ${name}'s keypad and keep the door open while the Zooz stick is excluding.`,
          'Enter the master PIN, press the gear key, press 7, press the gear key, press 3, then press the gear key to remove the Z-Wave module from its old network.',
          'Wait for the lock confirmation tone before continuing.'
        ],
        inclusion: [
          `Keep ${name} close to the Zooz stick until HomeBrain finishes secure interview.`,
          'Enter the master PIN, press the gear key, press 7, press the gear key, press 1, then press the gear key to include the Z-Wave module.',
          'If HomeBrain requests the DSK PIN, use the first 5 digits printed on the Z-Wave module label.'
        ]
      };
    }

    return {
      profile: instructionProfile('zwave-lock-general', 'Z-Wave door lock', 'medium', {
        reference: 'SmartThings identified this as a lock but did not expose a precise lock manufacturer/model.'
      }),
      exclusion: [
        `Keep ${name} close to the Zooz stick with fresh batteries and the door open.`,
        'Use the matching lock action: Schlage Connect uses Schlage logo + 6-digit programming code + 0; Kwikset/Weiser SmartCode uses interior A/Program once; Yale Assure uses master PIN + gear + 7 + gear + 3 + gear.',
        'Wait for a green check, success beep, or HomeBrain exclusion event before continuing.'
      ],
      inclusion: [
        `Keep ${name} close to the Zooz stick until secure inclusion and interview complete.`,
        'Use the matching lock action: Schlage Connect uses Schlage logo + programming code + 0; Kwikset/Weiser SmartCode uses interior A/Program once; Yale Assure uses master PIN + gear + 7 + gear + 1 + gear.',
        'If HomeBrain requests the DSK PIN, enter the first 5 digits from the lock or Z-Wave module label.'
      ]
    };
  }

  if (features.has('alarm') || /\b(?:aeotec|siren|alarm)\b/.test(descriptor)) {
    return {
      profile: instructionProfile('zwave-siren', 'Z-Wave siren/alarm', 'medium', {
        reference: 'Aeotec Siren models use the Action button for Z-Wave inclusion and exclusion; newer Siren 8 uses a double-click.'
      }),
      exclusion: [
        `Keep ${name} powered on and close enough that HomeBrain can hear the exclusion event.`,
        'Press the siren Action/Z-Wave button. For Aeotec Siren 8, double-click the Action button. For older Aeotec Gen5/6 sirens, press the Action button once unless the model label says otherwise.',
        'The LED should flash rapidly or show the model-specific success pattern.'
      ],
      inclusion: [
        `Keep ${name} plugged in until HomeBrain completes interview.`,
        'Press the siren Action/Z-Wave button. For Aeotec Siren 8, double-click the Action button.',
        'After pairing, verify alarm, chime, tamper, and switch-off commands before using it in Security Center.'
      ]
    };
  }

  if (/\b(?:garage door opener|linear|gd00z|fortrezz)\b/.test(descriptor)) {
    return {
      profile: instructionProfile('zwave-garage-controller', 'Z-Wave garage controller', 'medium'),
      exclusion: [
        `Stand near ${name} and locate the Z-Wave/link button on the controller module.`,
        'After SmartThings starts API removal or hub Z-Wave exclusion, press and release the Z-Wave/link button once. Many Linear/GoControl garage modules beep once when the command is accepted.'
      ],
      inclusion: [
        `Keep ${name}'s controller module powered and near the Zooz stick if possible.`,
        'Press and release the Z-Wave/link button once, then wait for HomeBrain to finish interview and expose door/barrier state.'
      ]
    };
  }

  if (features.has('switch') || features.has('brightness') || features.has('power') || features.has('energy')) {
    return {
      profile: instructionProfile('zwave-switch-dimmer-outlet', 'Z-Wave switch, dimmer, outlet, or meter', 'medium'),
      exclusion: [
        `Go to ${name} and identify the local paddle, switch, service button, or Z-Wave button.`,
        'After SmartThings starts API removal or hub Z-Wave exclusion, tap the local on/up paddle once. If it does not exclude, toggle on/up and off/down quickly 3 times; many Zooz/GE/Jasco style devices use that sequence.',
        'For plug-in modules, press the physical button once or three times quickly if one tap does not work.'
      ],
      inclusion: [
        `Keep ${name} powered while HomeBrain inclusion is open.`,
        'Tap the local on/up paddle once, or press the plug/module button once. If no node appears, use the quick 3-toggle sequence.',
        'For metering devices, leave the device powered for the full interview so power and energy command classes are discovered.'
      ]
    };
  }

  return {
    profile: instructionProfile('zwave-generic', 'Generic Z-Wave device', 'low'),
    exclusion: [
      `Put ${name} near the Zooz stick if it is portable or battery powered.`,
      'After SmartThings starts API removal or hub Z-Wave exclusion, press the device Z-Wave, learn, program, link, or action button once. If the device is a wall control, try the on/up paddle once, then the quick 3-toggle sequence if needed.'
    ],
    inclusion: [
      `Keep ${name} powered and awake while HomeBrain inclusion is open.`,
      'Press the device Z-Wave, learn, program, link, or action button once. Wake battery devices again if HomeBrain shows interview data is still incomplete.'
    ]
  };
}

function getZigbeePhysicalInstructions(device, features = new Set()) {
  const descriptor = getDeviceDescriptor(device);
  const name = normalizeString(device?.name) || 'the device';

  if (features.has('alarm') || /\b(?:siren|alarm|sounder)\b/.test(descriptor)) {
    return {
      profile: instructionProfile('zigbee-siren-alarm', 'Zigbee siren/alarm', 'medium', {
        reference: 'Zigbee sirens usually enter pairing mode from a hold-to-reset or recessed pair button while permit-join is open.'
      }),
      pairing: [
        `Plug in or power ${name} near the SONOFF coordinator before opening pairing.`,
        'Hold the siren reset, pair, or link button until the LED enters its pairing blink pattern.',
        'After discovery, verify alarm off, chime/tone, tamper, and battery attributes that the device exposes before using it in Security Center.'
      ]
    };
  }

  if (/\b(?:multipurpose|multifunctional|smartthings.*contact|contactsensor|bf69d6e0|7c42baaf)\b/.test(descriptor) || features.has('contact')) {
    return {
      profile: instructionProfile('zigbee-smartthings-contact-multipurpose', 'SmartThings/Aeotec contact or multipurpose sensor', 'high', {
        reference: 'SmartThings multipurpose/contact sensors reset from the interior Connect button until the LED begins its pairing blink.'
      }),
      pairing: [
        `Open ${name}'s cover so you can reach the small Connect/reset button.`,
        'After HomeBrain opens Zigbee permit-join, hold the Connect button for about 5 seconds.',
        'Release when the LED starts blinking red. A blue double-blink or repeated blink pattern means the sensor is trying to join.',
        'Tap the button once more if HomeBrain discovers it but the battery, temperature, acceleration, or axis interview stalls.'
      ]
    };
  }

  if (features.has('motion') || /\b(?:motion|bedc1499|635a866e)\b/.test(descriptor)) {
    return {
      profile: instructionProfile('zigbee-motion-sensor', 'Zigbee motion sensor', 'medium'),
      pairing: [
        `Open ${name}'s battery cover and keep it near the SONOFF coordinator.`,
        'Hold the reset/connect button for 5 to 10 seconds until the LED begins blinking.',
        'Release the button and keep the sensor awake. If HomeBrain finds it but battery or temperature is missing, press the button once to wake it again.'
      ]
    };
  }

  if (features.has('button') || /\b(?:button|fob|remotecontroller|key fob)\b/.test(descriptor)) {
    return {
      profile: instructionProfile('zigbee-button-fob', 'Zigbee button or key fob', 'medium'),
      pairing: [
        `Bring ${name} close to the SONOFF coordinator.`,
        'Hold the main button or recessed reset button until the LED starts blinking.',
        'Press each button once after discovery so HomeBrain can map button events before you finish migration.'
      ]
    };
  }

  if (features.has('repeater') && !features.has('switch') && !features.has('power')) {
    return {
      profile: instructionProfile('zigbee-signal-repeater', 'Zigbee signal repeater', 'medium'),
      pairing: [
        `Plug in ${name} near the SONOFF coordinator for initial pairing.`,
        'Hold the reset or pair button for 5 to 10 seconds until the LED starts blinking rapidly.',
        'Leave it powered until HomeBrain confirms the Zigbee route/repeater interview.'
      ]
    };
  }

  if (features.has('switch') || features.has('power') || /\b(?:plug|outlet|socket)\b/.test(descriptor)) {
    return {
      profile: instructionProfile('zigbee-plug-outlet-repeater', 'Zigbee plug, outlet, or repeater', 'medium'),
      pairing: [
        `Plug in ${name} near the SONOFF coordinator for initial pairing.`,
        'Hold the power/pair button for 5 to 10 seconds until the LED blinks rapidly.',
        'Leave it powered until HomeBrain confirms switch, power, and route/repeater metadata.'
      ]
    };
  }

  if (features.has('color') || features.has('colorTemperature') || features.has('brightness') || /\b(?:bulb|light|led|strip|spotlight)\b/.test(descriptor)) {
    return {
      profile: instructionProfile('zigbee-light-bulb-strip', 'Zigbee light, bulb, strip, or dimmer', 'medium'),
      pairing: [
        `Power ${name} from a nearby switch or outlet while HomeBrain permit-join is open.`,
        'If it is already paired, reset it with the brand-specific power-cycle sequence, commonly on/off 5 or 6 times until the light blinks.',
        'Leave it on after the blink so HomeBrain can interview on/off, level, color temperature, and color clusters.'
      ]
    };
  }

  return {
    profile: instructionProfile('zigbee-generic', 'Generic Zigbee device', 'low'),
    pairing: [
      `Bring ${name} close to the SONOFF coordinator if it is battery powered.`,
      'Hold the reset, connect, or pair button until the LED blinks. For many SmartThings-family sensors this is about 5 seconds.',
      'Wake battery devices again during interview if HomeBrain has not yet captured battery or sensor attributes.'
    ]
  };
}

function buildGuidedMigrationSteps(protocol, device) {
  const name = normalizeString(device?.name) || 'the device';
  const features = new Set(inferFeaturesFromSmartThings(device));

  if (protocol === 'zwave') {
    const guidance = getZWavePhysicalInstructions(device, features);
    return {
      instructionProfile: guidance.profile,
      guidedSteps: [
        buildGuidedStep({
          id: 'start-homebrain-zwave-exclusion',
          title: 'Start SmartThings Z-Wave removal',
          phase: 'exclusion',
          protocol: 'zwave',
          action: 'start_zwave_exclusion',
          automatic: true,
          durationSeconds: 120,
          instructions: [
            'HomeBrain will ask SmartThings to remove this Z-Wave device over the SmartThings API.',
            'SmartThings should put the owning hub into Z-Wave exclusion mode; HomeBrain records the hub radio baseline and watches for removal, an exclusion-counter increase, or device health going offline.'
          ],
          confirmLabel: 'Start SmartThings removal'
        }),
        buildGuidedStep({
          id: 'trigger-device-zwave-exclusion',
          title: `Remove ${name} from SmartThings`,
          phase: 'physical_exclusion',
          protocol: 'zwave',
          instructions: [
            'After HomeBrain starts SmartThings removal, perform the physical Z-Wave exclude action on the device.',
            'If SmartThings rejected the API removal request, open Hub > Z-Wave utilities > Z-Wave exclusion and then perform the same physical action.',
            ...guidance.exclusion
          ],
          confirmLabel: 'Verify SmartThings exclusion'
        }),
        buildGuidedStep({
          id: 'start-homebrain-zwave-inclusion',
          title: 'Open HomeBrain Z-Wave inclusion',
          phase: 'inclusion',
          protocol: 'zwave',
          action: 'start_direct_migration',
          automatic: true,
          durationSeconds: features.has('lock') ? 240 : 180,
          instructions: [
            'HomeBrain will start secure Z-Wave inclusion and keep the existing HomeBrain device identity ready for replacement.',
            features.has('lock')
              ? 'Locks should stay close to the Zooz stick until S2/S0 security and interview finish.'
              : 'Leave the device powered and awake until the interview finishes.'
          ],
          confirmLabel: 'Start inclusion'
        }),
        buildGuidedStep({
          id: 'trigger-device-zwave-inclusion',
          title: `Include ${name} into HomeBrain`,
          phase: 'physical_inclusion',
          protocol: 'zwave',
          instructions: guidance.inclusion,
          confirmLabel: 'Verify inclusion'
        }),
        buildGuidedStep({
          id: 'verify-homebrain-zwave-migration',
          title: 'Verify HomeBrain control',
          phase: 'verification',
          protocol: 'zwave',
          instructions: [
            'Wait for HomeBrain to show the new direct Z-Wave node as interviewed and online.',
            'Verify primary state, battery if present, and each important feature before retiring the SmartThings entry.',
            'After validation, keep the SmartThings integration installed but use the HomeBrain-native device in automations and Security Center.'
          ],
          confirmLabel: 'Verify HomeBrain route'
        })
      ]
    };
  }

  if (protocol === 'zigbee') {
    const guidance = getZigbeePhysicalInstructions(device, features);
    return {
      instructionProfile: guidance.profile,
      guidedSteps: [
        buildGuidedStep({
          id: 'start-homebrain-zigbee-permit-join',
          title: 'Open HomeBrain Zigbee pairing',
          phase: 'permit_join',
          protocol: 'zigbee',
          action: 'start_direct_migration',
          automatic: true,
          durationSeconds: features.has('battery') ? 600 : 300,
          instructions: [
            'HomeBrain will ask SmartThings to remove the old Zigbee device record, then open Zigbee permit-join on the SONOFF coordinator and prepare to preserve this HomeBrain device record.',
            'Factory reset or pair the device only after permit-join is open.'
          ],
          confirmLabel: 'Start pairing'
        }),
        buildGuidedStep({
          id: 'trigger-device-zigbee-pairing',
          title: `Put ${name} into Zigbee pairing mode`,
          phase: 'physical_pairing',
          protocol: 'zigbee',
          instructions: guidance.pairing,
          confirmLabel: 'Verify pairing'
        }),
        buildGuidedStep({
          id: 'verify-homebrain-zigbee-migration',
          title: 'Verify HomeBrain control',
          phase: 'verification',
          protocol: 'zigbee',
          instructions: [
            'Wait for HomeBrain to complete the Zigbee interview.',
            'Verify primary state, temperature, battery, tamper, acceleration, axis, color, power, or energy fields that apply to this device.',
            'Wake battery sensors again if any expected attributes are missing before retiring the SmartThings entry.'
          ],
          confirmLabel: 'Verify HomeBrain route'
        })
      ]
    };
  }

  return {
    instructionProfile: instructionProfile('choose-radio', 'Choose Zigbee or Z-Wave', 'low'),
    guidedSteps: [
      buildGuidedStep({
        id: 'choose-radio',
        title: `Choose the native radio for ${name}`,
        phase: 'choose_protocol',
        protocol: 'unknown',
        instructions: [
          'Check the product label, battery compartment, or SmartThings details for Zigbee or Z-Wave.',
          'Use the Zigbee workflow for SmartThings/Aeotec sensors, Zigbee bulbs, buttons, and plugs.',
          'Use the Z-Wave workflow for deadbolts, Z-Wave sirens, wall switches, dimmers, outlets, and Z-Wave meters.'
        ],
        confirmLabel: 'Choose radio'
      })
    ]
  };
}

function flattenGuidedSteps(guidedSteps) {
  return guidedSteps.map((step) => {
    const instructions = Array.isArray(step.instructions) ? step.instructions.join(' ') : '';
    return `${step.title}: ${instructions}`;
  });
}

function getManualResetGuidance(protocol, device) {
  return flattenGuidedSteps(buildGuidedMigrationSteps(protocol, device).guidedSteps);
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
  const guidance = cloudOnly
    ? { instructionProfile: null, guidedSteps: [] }
    : buildGuidedMigrationSteps(protocol, device);

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
    manualSteps: cloudOnly ? [] : getManualResetGuidance(protocol, device),
    guidedSteps: guidance.guidedSteps,
    instructionProfile: guidance.instructionProfile,
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
    supportsContactSensor: featureSet.has('contact'),
    supportsMotionSensor: featureSet.has('motion'),
    supportsTemperatureSensor: featureSet.has('temperature'),
    supportsHumiditySensor: featureSet.has('humidity'),
    supportsIlluminanceSensor: featureSet.has('illuminance'),
    supportsTamperSensor: featureSet.has('tamper'),
    supportsAccelerationSensor: featureSet.has('acceleration'),
    supportsVibrationSensor: featureSet.has('vibration'),
    supportsWaterSensor: featureSet.has('water'),
    supportsPowerMeter: featureSet.has('power'),
    supportsEnergyMeter: featureSet.has('energy'),
    supportsVoltage: featureSet.has('voltage'),
    supportsCurrent: featureSet.has('current'),
    supportsRepeater: featureSet.has('repeater'),
    supportsThermostat: featureSet.has('thermostat'),
    supportsAlarm: featureSet.has('alarm'),
    supportsChime: featureSet.has('chime'),
    supportsLockCodes: featureSet.has('lockCodes'),
    supportsCover: featureSet.has('cover'),
    supportsGarage: featureSet.has('garage'),
    supportsValve: featureSet.has('valve')
  };
}

module.exports = {
  DIRECT_RADIO_SOURCES,
  SOURCE_PROTOCOLS,
  FEATURE_LABELS,
  buildDirectFeatureProperties,
  buildFeatureSupport,
  buildNormalizedCapabilities,
  buildGuidedMigrationSteps,
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

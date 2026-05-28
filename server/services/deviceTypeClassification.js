function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeToken(value) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value && typeof value === 'object') {
    return normalizeString(value.id || value.capabilityId || value.name || value.value);
  }

  return '';
}

function toNormalizedSet(values = [], { lower = false } = {}) {
  const source = values instanceof Set ? Array.from(values) : Array.isArray(values) ? values : [];
  return new Set(source
    .map(normalizeToken)
    .filter(Boolean)
    .map((value) => (lower ? value.toLowerCase() : value)));
}

function buildDescriptor(...parts) {
  return parts
    .flat()
    .map((part) => normalizeToken(part).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function hasToken(tokenSet, token) {
  const expected = normalizeString(token).toLowerCase();
  if (!expected) {
    return false;
  }

  for (const value of tokenSet || []) {
    if (normalizeToken(value).toLowerCase() === expected) {
      return true;
    }
  }

  return false;
}

function smartThingsDescriptor(device = {}, categories = []) {
  return buildDescriptor(
    device.name,
    device.label,
    device.deviceTypeName,
    device.presentationId,
    device.manufacturerName,
    device.manufacturer,
    device.brand,
    device.model,
    categories
  );
}

function directDescriptor(context = {}) {
  if (typeof context === 'string') {
    return context.toLowerCase();
  }

  return buildDescriptor(
    context.name,
    context.label,
    context.description,
    context.model,
    context.modelID,
    context.productLabel,
    context.manufacturer,
    context.manufacturerName,
    context.vendor,
    context.deviceConfig?.label,
    context.deviceConfig?.manufacturer
  );
}

function looksLikeSwitchHardware(descriptor) {
  return /\b(?:switch|dimmer|outlet|plug|relay|repeater|extender|energy monitor|power monitor|scene|trigger|button|remote|controller|fan|module)\b/i
    .test(descriptor || '');
}

function looksLikeActualLight(descriptor) {
  return /\b(?:bulb|lamp|light|lighting|led|strip|sconce|chandelier|fixture|spotlight|downlight|recessed|can light|accent)\b/i
    .test(descriptor || '');
}

function mapSmartThingsDeviceType(capabilities = new Set(), categories = new Set(), device = {}) {
  const capabilitySet = toNormalizedSet(capabilities, { lower: true });
  const categorySet = toNormalizedSet(categories, { lower: true });
  const hasCapability = (capability) => capabilitySet.has(capability.toLowerCase());
  const hasCategory = (category) => categorySet.has(category.toLowerCase());
  const descriptor = smartThingsDescriptor(device, Array.from(categorySet));
  const switchLike = hasCategory('switch') || looksLikeSwitchHardware(descriptor);

  if (
    hasCapability('thermostat') ||
    hasCapability('thermostatMode') ||
    hasCapability('thermostatOperatingState') ||
    hasCapability('thermostatSetpoint') ||
    hasCapability('thermostatCoolingSetpoint') ||
    hasCapability('thermostatHeatingSetpoint') ||
    hasCapability('thermostatFanMode') ||
    hasCategory('thermostat')
  ) {
    return 'thermostat';
  }

  if (hasCapability('lock') || hasCategory('lock')) {
    return 'lock';
  }

  if (hasCapability('alarm') || hasCategory('siren')) {
    return 'siren';
  }

  if (hasCapability('garageDoorControl') || hasCapability('doorControl') || hasCategory('garageDoor') || hasCategory('garage')) {
    return 'garage';
  }

  if (
    hasCategory('camera') ||
    hasCategory('visionSensor') ||
    hasCapability('videoStream') ||
    hasCapability('videoCapture') ||
    hasCapability('videoCamera') ||
    hasCapability('imageCapture') ||
    hasCapability('cameraEvent') ||
    hasCapability('webrtc')
  ) {
    return 'camera';
  }

  if (hasCapability('colorControl')) {
    return 'light';
  }

  if (hasCategory('light') && !switchLike) {
    return 'light';
  }

  if (hasCapability('switch') || hasCapability('switchLevel') || hasCategory('switch')) {
    return 'switch';
  }

  if (
    hasCapability('motionSensor') ||
    hasCapability('contactSensor') ||
    hasCapability('presenceSensor') ||
    hasCapability('waterSensor') ||
    hasCapability('humidityMeasurement') ||
    hasCapability('temperatureMeasurement') ||
    hasCapability('tamperAlert') ||
    hasCapability('accelerationSensor') ||
    hasCategory('sensor')
  ) {
    return 'sensor';
  }

  if (hasCapability('audioVolume') || hasCategory('audio') || hasCategory('speaker')) {
    return 'speaker';
  }

  return capabilitySet.size > 0 ? 'switch' : null;
}

function isDirectLightContext(context = {}) {
  const descriptor = directDescriptor(context);
  return looksLikeActualLight(descriptor) && !looksLikeSwitchHardware(descriptor);
}

function inferDirectDeviceType(features = [], context = {}) {
  const featureSet = toNormalizedSet(features, { lower: true });
  const descriptor = directDescriptor(context);

  if (featureSet.has('lock')) return 'lock';
  if (featureSet.has('thermostat')) return 'thermostat';
  if (featureSet.has('alarm') || /\b(?:siren|alarm|sounder)\b/.test(descriptor)) return 'siren';
  if (featureSet.has('speaker') || featureSet.has('chime')) return 'speaker';
  if (featureSet.has('color') || featureSet.has('colortemperature') || featureSet.has('light') || isDirectLightContext(context)) {
    return 'light';
  }
  if (featureSet.has('switch') || featureSet.has('brightness') || featureSet.has('power') || featureSet.has('energy')) {
    return 'switch';
  }
  if (
    featureSet.has('contact') ||
    featureSet.has('motion') ||
    featureSet.has('water') ||
    featureSet.has('smoke') ||
    featureSet.has('battery') ||
    featureSet.has('temperature') ||
    featureSet.has('humidity') ||
    featureSet.has('illuminance') ||
    featureSet.has('tamper') ||
    featureSet.has('vibration') ||
    featureSet.has('acceleration') ||
    featureSet.has('axis')
  ) {
    return 'sensor';
  }

  return 'sensor';
}

module.exports = {
  hasToken,
  inferDirectDeviceType,
  isDirectLightContext,
  looksLikeActualLight,
  looksLikeSwitchHardware,
  mapSmartThingsDeviceType
};

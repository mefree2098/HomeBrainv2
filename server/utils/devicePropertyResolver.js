function getPathSegments(path) {
  if (typeof path !== 'string') {
    return [];
  }

  return path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getNestedValue(source, path) {
  const segments = Array.isArray(path) ? path : getPathSegments(path);
  if (!source || typeof source !== 'object' || segments.length === 0) {
    return undefined;
  }

  let current = source;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function resolveDeviceProperty(device, property, fallbackValue = undefined) {
  if (!device || typeof device !== 'object') {
    return fallbackValue;
  }

  if (!property || property === 'status') {
    return device.status;
  }

  if (property === 'isOnline') {
    return device.isOnline;
  }

  if (Object.prototype.hasOwnProperty.call(device, property)) {
    return device[property];
  }

  if (device.properties && Object.prototype.hasOwnProperty.call(device.properties, property)) {
    return device.properties[property];
  }

  const nestedFromDevice = getNestedValue(device, property);
  if (nestedFromDevice !== undefined) {
    return nestedFromDevice;
  }

  if (typeof property === 'string' && !property.startsWith('properties.')) {
    const nestedFromProperties = getNestedValue(device.properties, property);
    if (nestedFromProperties !== undefined) {
      return nestedFromProperties;
    }
  }

  return fallbackValue;
}

function setNestedValue(target, path, value) {
  const segments = Array.isArray(path) ? path : getPathSegments(path);
  if (!target || typeof target !== 'object' || segments.length === 0) {
    return target;
  }

  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }

  current[segments[segments.length - 1]] = value;
  return target;
}

function applyFlattenedUpdates(document, updates = {}) {
  const next = document && typeof document === 'object'
    ? JSON.parse(JSON.stringify(document))
    : {};

  Object.entries(updates || {}).forEach(([key, value]) => {
    if (key.includes('.')) {
      setNestedValue(next, key, value);
    } else {
      next[key] = value;
    }
  });

  return next;
}

module.exports = {
  applyFlattenedUpdates,
  getNestedValue,
  getPathSegments,
  resolveDeviceProperty,
  setNestedValue
};

const { isSafeObjectKey } = require('./stringSafety');

function getPathSegments(path) {
  if (typeof path !== 'string') {
    return [];
  }

  const segments = path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.every((segment) => isSafeObjectKey(segment)) ? segments : [];
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
    current = Reflect.get(current, segment);
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

  if (isSafeObjectKey(property) && Object.prototype.hasOwnProperty.call(device, property)) {
    return Reflect.get(device, property);
  }

  if (isSafeObjectKey(property) && device.properties && Object.prototype.hasOwnProperty.call(device.properties, property)) {
    return Reflect.get(device.properties, property);
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
    const existing = Object.prototype.hasOwnProperty.call(current, segment)
      ? Reflect.get(current, segment)
      : null;
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      Reflect.set(current, segment, {});
    }
    current = Reflect.get(current, segment);
  }

  Reflect.set(current, segments[segments.length - 1], value);
  return target;
}

function applyFlattenedUpdates(document, updates = {}) {
  const next = document && typeof document === 'object'
    ? JSON.parse(JSON.stringify(document))
    : {};

  Object.entries(updates || {}).forEach(([key, value]) => {
    if (key.includes('.')) {
      setNestedValue(next, key, value);
    } else if (isSafeObjectKey(key)) {
      Reflect.set(next, key, value);
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

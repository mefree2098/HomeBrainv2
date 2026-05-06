function clonePlain(value) {
  if (value === undefined || value === null) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function toPlainDevice(device) {
  if (!device) {
    return null;
  }

  const plain = typeof device.toObject === 'function'
    ? device.toObject({ depopulate: true })
    : clonePlain(device);

  if (plain?._id && typeof plain._id !== 'string') {
    plain._id = String(plain._id);
  }

  if (!plain.id && plain?._id) {
    plain.id = plain._id;
  }

  return plain;
}

function compactSmartThingsByComponent(value, compactEntry) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const compacted = {};
  Object.entries(value).forEach(([componentId, componentValue]) => {
    if (componentId === 'main') {
      return;
    }

    const next = compactEntry(componentValue);
    if (next && typeof next === 'object' && Object.keys(next).length > 0) {
      compacted[componentId] = next;
    }
  });

  return compacted;
}

function compactSmartThingsMetadataLeaf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const hasSmartThingsLeafShape = Object.prototype.hasOwnProperty.call(value, 'timestamp')
    || Object.prototype.hasOwnProperty.call(value, 'unit')
    || Object.prototype.hasOwnProperty.call(value, 'capability')
    || Object.prototype.hasOwnProperty.call(value, 'attribute')
    || Object.prototype.hasOwnProperty.call(value, 'componentId');

  if (hasSmartThingsLeafShape) {
    const compacted = {};
    if (typeof value.unit === 'string' && value.unit.trim()) {
      compacted.unit = value.unit;
    }
    if (typeof value.timestamp === 'string' && value.timestamp.trim()) {
      compacted.timestamp = value.timestamp;
    }
    return compacted;
  }

  const compacted = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (key === 'byComponent') {
      const byComponent = compactSmartThingsByComponent(entry, compactSmartThingsMetadataLeaf);
      if (byComponent && Object.keys(byComponent).length > 0) {
        compacted[key] = byComponent;
      }
      return;
    }

    const next = compactSmartThingsMetadataLeaf(entry);
    if (next !== undefined && next !== null) {
      compacted[key] = next;
    }
  });

  return compacted;
}

function compactSmartThingsValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const compacted = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (key === 'byComponent') {
      const byComponent = compactSmartThingsByComponent(entry, compactSmartThingsValues);
      if (byComponent && Object.keys(byComponent).length > 0) {
        compacted[key] = byComponent;
      }
      return;
    }

    compacted[key] = entry;
  });

  return compacted;
}

function compactDeviceProperties(properties = {}, options = {}) {
  const includeRaw = options.includeRaw === true;
  const compacted = clonePlain(properties) || {};

  if (includeRaw) {
    return compacted;
  }

  delete compacted.smartThingsStatus;
  delete compacted.smartThingsComponents;

  if (compacted.smartThingsAttributeValues) {
    compacted.smartThingsAttributeValues = compactSmartThingsValues(compacted.smartThingsAttributeValues);
  }

  if (compacted.smartThingsAttributeMetadata) {
    compacted.smartThingsAttributeMetadata = compactSmartThingsMetadataLeaf(compacted.smartThingsAttributeMetadata);
  }

  return compacted;
}

function serializeDevice(device, options = {}) {
  const plain = toPlainDevice(device);
  if (!plain) {
    return null;
  }

  plain.properties = compactDeviceProperties(plain.properties || {}, options);
  return plain;
}

function serializeDevices(devices, options = {}) {
  if (!Array.isArray(devices)) {
    return [];
  }

  return devices
    .map((device) => serializeDevice(device, options))
    .filter(Boolean);
}

module.exports = {
  compactDeviceProperties,
  serializeDevice,
  serializeDevices
};

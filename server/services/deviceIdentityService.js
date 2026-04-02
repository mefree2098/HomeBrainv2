const Device = require('../models/Device');

let cachedInsteonService = null;
const getInsteonService = () => {
  if (!cachedInsteonService) {
    cachedInsteonService = require('./insteonService');
  }
  return cachedInsteonService;
};

const trimString = (value, fallback = '') => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || fallback;
  }

  if (value == null) {
    return fallback;
  }

  const trimmed = String(value).trim();
  return trimmed || fallback;
};

const normalizeSource = (value) => trimString(value).toLowerCase();

const normalizeHost = (value) => {
  let host = trimString(value);
  if (!host) {
    return '';
  }

  host = host
    .replace(/^https?:\/\//i, '')
    .replace(/^wss?:\/\//i, '');

  if (host.includes('/')) {
    [host] = host.split('/');
  }

  const bracketedIpv6 = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketedIpv6) {
    return bracketedIpv6[1].trim().toLowerCase();
  }

  const colonCount = (host.match(/:/g) || []).length;
  if (colonCount === 1 && host.includes(':')) {
    const [hostname, port] = host.split(':');
    if (/^\d+$/.test(port)) {
      host = hostname;
    }
  }

  return host.trim().toLowerCase();
};

const normalizeInteger = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.trunc(numeric);
};

function normalizePlatformIdentityProperties(properties = {}) {
  const normalizedProperties = properties && typeof properties === 'object'
    ? { ...properties }
    : {};

  const normalizedSource = normalizeSource(normalizedProperties.source);
  if (normalizedSource) {
    normalizedProperties.source = normalizedSource;
  }

  const rawInsteonAddress = trimString(normalizedProperties.insteonAddress);
  if (rawInsteonAddress) {
    const insteonService = getInsteonService();
    const normalizedAddress = insteonService._normalizePossibleInsteonAddress(rawInsteonAddress);
    if (!normalizedAddress) {
      throw new Error('Invalid INSTEON address');
    }
    normalizedProperties.insteonAddress = normalizedAddress;
  }

  const smartThingsDeviceId = trimString(normalizedProperties.smartThingsDeviceId);
  if (smartThingsDeviceId) {
    normalizedProperties.smartThingsDeviceId = smartThingsDeviceId;
  }

  const harmonyHubIp = normalizeHost(normalizedProperties.harmonyHubIp);
  if (harmonyHubIp) {
    normalizedProperties.harmonyHubIp = harmonyHubIp;
  }

  const harmonyActivityId = trimString(normalizedProperties.harmonyActivityId);
  if (harmonyActivityId) {
    normalizedProperties.harmonyActivityId = harmonyActivityId;
  }

  const ecobeeDeviceType = trimString(normalizedProperties.ecobeeDeviceType).toLowerCase();
  if (ecobeeDeviceType) {
    normalizedProperties.ecobeeDeviceType = ecobeeDeviceType;
  }

  const ecobeeThermostatIdentifier = trimString(normalizedProperties.ecobeeThermostatIdentifier);
  if (ecobeeThermostatIdentifier) {
    normalizedProperties.ecobeeThermostatIdentifier = ecobeeThermostatIdentifier;
  }

  const ecobeeSensorKey = trimString(normalizedProperties.ecobeeSensorKey);
  if (ecobeeSensorKey) {
    normalizedProperties.ecobeeSensorKey = ecobeeSensorKey;
  }

  const rawTempest = normalizedProperties.tempest && typeof normalizedProperties.tempest === 'object'
    ? normalizedProperties.tempest
    : null;
  if (rawTempest) {
    const normalizedTempest = { ...rawTempest };
    const stationId = normalizeInteger(normalizedTempest.stationId);
    if (stationId !== null) {
      normalizedTempest.stationId = stationId;
    }
    normalizedProperties.tempest = normalizedTempest;
  }

  return normalizedProperties;
}

function buildSmartThingsDeviceIdentityQuery(deviceId) {
  const normalizedDeviceId = trimString(deviceId);
  if (!normalizedDeviceId) {
    return null;
  }

  return {
    'properties.smartThingsDeviceId': normalizedDeviceId
  };
}

function buildHarmonyActivityIdentityQuery(hubIp, activityId) {
  const normalizedHubIp = normalizeHost(hubIp);
  const normalizedActivityId = trimString(activityId);
  if (!normalizedHubIp || !normalizedActivityId) {
    return null;
  }

  return {
    'properties.harmonyHubIp': normalizedHubIp,
    'properties.harmonyActivityId': normalizedActivityId
  };
}

function buildEcobeeThermostatIdentityQuery(identifier) {
  const normalizedIdentifier = trimString(identifier);
  if (!normalizedIdentifier) {
    return null;
  }

  return {
    'properties.ecobeeThermostatIdentifier': normalizedIdentifier,
    $or: [
      { 'properties.ecobeeDeviceType': 'thermostat' },
      {
        'properties.ecobeeDeviceType': { $exists: false },
        'properties.ecobeeSensorKey': { $exists: false }
      }
    ]
  };
}

function buildEcobeeSensorIdentityQuery(sensorKey) {
  const normalizedSensorKey = trimString(sensorKey);
  if (!normalizedSensorKey) {
    return null;
  }

  return {
    'properties.ecobeeSensorKey': normalizedSensorKey
  };
}

function buildTempestStationIdentityQuery(stationId) {
  const normalizedStationId = normalizeInteger(stationId);
  if (normalizedStationId === null) {
    return null;
  }

  return {
    'properties.tempest.stationId': {
      $in: [normalizedStationId, String(normalizedStationId)]
    }
  };
}

function buildIdentityDescriptors(properties = {}) {
  const normalizedProperties = normalizePlatformIdentityProperties(properties);
  const descriptors = [];

  const normalizedInsteonAddress = trimString(normalizedProperties.insteonAddress);
  if (normalizedInsteonAddress) {
    descriptors.push({
      label: 'INSTEON address',
      query: getInsteonService()._buildInsteonAddressLookupQuery(normalizedInsteonAddress),
      errorMessage: 'A HomeBrain device with this INSTEON address already exists'
    });
  }

  const smartThingsQuery = buildSmartThingsDeviceIdentityQuery(normalizedProperties.smartThingsDeviceId);
  if (smartThingsQuery) {
    descriptors.push({
      label: 'SmartThings device ID',
      query: smartThingsQuery,
      errorMessage: 'A HomeBrain device with this SmartThings device ID already exists'
    });
  }

  const harmonyQuery = buildHarmonyActivityIdentityQuery(
    normalizedProperties.harmonyHubIp,
    normalizedProperties.harmonyActivityId
  );
  if (harmonyQuery) {
    descriptors.push({
      label: 'Harmony hub/activity',
      query: harmonyQuery,
      errorMessage: 'A HomeBrain device with this Harmony hub/activity already exists'
    });
  }

  const sensorQuery = buildEcobeeSensorIdentityQuery(normalizedProperties.ecobeeSensorKey);
  if (sensorQuery) {
    descriptors.push({
      label: 'Ecobee sensor key',
      query: sensorQuery,
      errorMessage: 'A HomeBrain device with this Ecobee sensor key already exists'
    });
  } else {
    const thermostatQuery = buildEcobeeThermostatIdentityQuery(normalizedProperties.ecobeeThermostatIdentifier);
    if (thermostatQuery) {
      descriptors.push({
        label: 'Ecobee thermostat identifier',
        query: thermostatQuery,
        errorMessage: 'A HomeBrain device with this Ecobee thermostat identifier already exists'
      });
    }
  }

  const tempestStationId = normalizedProperties?.tempest?.stationId;
  const tempestQuery = buildTempestStationIdentityQuery(tempestStationId);
  if (tempestQuery) {
    descriptors.push({
      label: 'Tempest station ID',
      query: tempestQuery,
      errorMessage: 'A HomeBrain device with this Tempest station ID already exists'
    });
  }

  return {
    normalizedProperties,
    descriptors
  };
}

async function ensureUniquePlatformIdentity(properties = {}, excludeDeviceId = null) {
  const { normalizedProperties, descriptors } = buildIdentityDescriptors(properties);

  for (const descriptor of descriptors) {
    const query = { ...descriptor.query };
    if (excludeDeviceId) {
      query._id = { $ne: excludeDeviceId };
    }

    // eslint-disable-next-line no-await-in-loop
    const existingDevice = await Device.findOne(query);
    if (existingDevice) {
      throw new Error(descriptor.errorMessage);
    }
  }

  return normalizedProperties;
}

function compareCanonicalDevices(left, right, preferredDeviceId = null) {
  const scoreDevice = (device) => {
    if (!device || typeof device !== 'object') {
      return Number.NEGATIVE_INFINITY;
    }

    let score = 0;
    const deviceId = String(device?._id || '');
    const trimmedName = trimString(device?.name);
    const trimmedRoom = trimString(device?.room);
    const trimmedBrand = trimString(device?.brand);
    const trimmedModel = trimString(device?.model);

    if (preferredDeviceId && deviceId === preferredDeviceId) {
      score += 10000;
    }
    if (Array.isArray(device?.groups) && device.groups.length > 0) {
      score += 100;
    }
    if (trimmedName) {
      score += 25;
    }
    if (trimmedRoom && trimmedRoom.toLowerCase() !== 'unassigned') {
      score += 10;
    }
    if (trimmedBrand) {
      score += 5;
    }
    if (trimmedModel) {
      score += 5;
    }

    return score;
  };

  const scoreDifference = scoreDevice(right) - scoreDevice(left);
  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const leftCreatedAt = left?.createdAt ? new Date(left.createdAt).getTime() : Number.NaN;
  const rightCreatedAt = right?.createdAt ? new Date(right.createdAt).getTime() : Number.NaN;
  if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt) && leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }

  return String(left?._id || '').localeCompare(String(right?._id || ''));
}

function selectCanonicalDevice(devices = [], preferredDevice = null) {
  if (!Array.isArray(devices) || devices.length === 0) {
    return null;
  }

  const preferredDeviceId = preferredDevice ? String(preferredDevice?._id || '') : null;
  const sortedDevices = [...devices].sort((left, right) => (
    compareCanonicalDevices(left, right, preferredDeviceId)
  ));

  return sortedDevices[0] || null;
}

function mergeDuplicateDeviceGroups(canonicalDevice, duplicateDevices = []) {
  if (!canonicalDevice || typeof canonicalDevice !== 'object' || !Array.isArray(duplicateDevices) || duplicateDevices.length === 0) {
    return false;
  }

  const mergedGroups = Array.isArray(canonicalDevice.groups)
    ? canonicalDevice.groups
        .map((group) => trimString(group))
        .filter(Boolean)
    : [];
  const mergedKeys = new Set(mergedGroups.map((group) => group.toLowerCase()));
  let changed = false;

  duplicateDevices.forEach((device) => {
    if (!device || !Array.isArray(device.groups)) {
      return;
    }

    device.groups.forEach((group) => {
      const trimmedGroup = trimString(group);
      if (!trimmedGroup) {
        return;
      }

      const key = trimmedGroup.toLowerCase();
      if (mergedKeys.has(key)) {
        return;
      }

      mergedKeys.add(key);
      mergedGroups.push(trimmedGroup);
      changed = true;
    });
  });

  if (changed) {
    canonicalDevice.groups = mergedGroups;
  }

  return changed;
}

function describeDevices(devices = []) {
  return devices
    .map((device) => {
      const name = trimString(device?.name, 'Unnamed Device');
      const id = trimString(device?._id, 'unknown-id');
      return `${name} (${id})`;
    })
    .join(', ');
}

module.exports = {
  normalizePlatformIdentityProperties,
  ensureUniquePlatformIdentity,
  buildSmartThingsDeviceIdentityQuery,
  buildHarmonyActivityIdentityQuery,
  buildEcobeeThermostatIdentityQuery,
  buildEcobeeSensorIdentityQuery,
  buildTempestStationIdentityQuery,
  selectCanonicalDevice,
  mergeDuplicateDeviceGroups,
  describeDevices
};

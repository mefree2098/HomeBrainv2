const DeviceEnergySample = require('../models/DeviceEnergySample');

const DEFAULT_HISTORY_HOURS = 24;
const MAX_HISTORY_HOURS = 24 * 30;
const DEFAULT_HISTORY_LIMIT = 720;
const MAX_HISTORY_LIMIT = 5000;

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseOptionalDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(numeric)));
}

class DeviceEnergySampleService {
  normalizeSmartThingsValue(value) {
    if (!value) {
      return '';
    }

    if (typeof value === 'string') {
      return value.trim();
    }

    if (typeof value === 'object') {
      const candidate = value.id || value.capabilityId || value.name;
      if (typeof candidate === 'string') {
        return candidate.trim();
      }
    }

    return '';
  }

  getCapabilitySet(device) {
    const rawCapabilities = [
      ...(Array.isArray(device?.properties?.smartThingsCapabilities)
        ? device.properties.smartThingsCapabilities
        : []),
      ...(Array.isArray(device?.properties?.smartthingsCapabilities)
        ? device.properties.smartthingsCapabilities
        : [])
    ];

    return new Set(rawCapabilities
      .map((entry) => this.normalizeSmartThingsValue(entry))
      .filter(Boolean));
  }

  extractEnergySnapshot(device) {
    const attributeValues = device?.properties?.smartThingsAttributeValues || {};
    const attributeMetadata = device?.properties?.smartThingsAttributeMetadata || {};
    const capabilitySet = this.getCapabilitySet(device);

    const powerValue = toFiniteNumber(attributeValues?.powerMeter?.power);
    const energyValue = toFiniteNumber(attributeValues?.energyMeter?.energy);

    const powerMetadata = attributeMetadata?.powerMeter?.power || {};
    const energyMetadata = attributeMetadata?.energyMeter?.energy || {};

    const powerTimestamp = parseOptionalDate(powerMetadata.timestamp);
    const energyTimestamp = parseOptionalDate(energyMetadata.timestamp);
    const lastSeen = parseOptionalDate(device?.lastSeen);

    const timestamps = [powerTimestamp, energyTimestamp, lastSeen].filter(Boolean);
    const recordedAt = timestamps.length > 0
      ? new Date(Math.max(...timestamps.map((entry) => entry.getTime())))
      : new Date();

    const supportsEnergyMonitoring = capabilitySet.has('powerMeter')
      || capabilitySet.has('energyMeter')
      || powerValue !== null
      || energyValue !== null;

    return {
      supportsEnergyMonitoring,
      recordedAt,
      source: (device?.properties?.source || 'smartthings').toString().toLowerCase() || 'smartthings',
      power: powerValue === null
        ? null
        : {
            value: powerValue,
            unit: typeof powerMetadata.unit === 'string' && powerMetadata.unit.trim()
              ? powerMetadata.unit.trim()
              : 'W',
            timestamp: powerTimestamp
          },
      energy: energyValue === null
        ? null
        : {
            value: energyValue,
            unit: typeof energyMetadata.unit === 'string' && energyMetadata.unit.trim()
              ? energyMetadata.unit.trim()
              : 'kWh',
            timestamp: energyTimestamp
          }
    };
  }

  buildSampleDocument(device, snapshot) {
    return {
      deviceId: device._id,
      source: snapshot.source,
      powerValue: snapshot.power?.value ?? null,
      powerUnit: snapshot.power?.unit ?? '',
      powerTimestamp: snapshot.power?.timestamp ?? null,
      energyValue: snapshot.energy?.value ?? null,
      energyUnit: snapshot.energy?.unit ?? '',
      energyTimestamp: snapshot.energy?.timestamp ?? null,
      recordedAt: snapshot.recordedAt
    };
  }

  isMeaningfulSnapshot(snapshot) {
    return Boolean(snapshot?.power || snapshot?.energy);
  }

  sampleMatches(lastSample, nextSample) {
    if (!lastSample || !nextSample) {
      return false;
    }

    return (lastSample.powerValue ?? null) === (nextSample.powerValue ?? null)
      && (lastSample.powerUnit || '') === (nextSample.powerUnit || '')
      && (lastSample.energyValue ?? null) === (nextSample.energyValue ?? null)
      && (lastSample.energyUnit || '') === (nextSample.energyUnit || '');
  }

  async recordSamplesForDevices(devices = []) {
    const candidates = Array.isArray(devices)
      ? devices
        .filter((device) => device?._id)
        .map((device) => ({
          device,
          snapshot: this.extractEnergySnapshot(device)
        }))
        .filter(({ snapshot }) => snapshot.supportsEnergyMonitoring && this.isMeaningfulSnapshot(snapshot))
      : [];

    if (candidates.length === 0) {
      return { insertedCount: 0, skippedCount: 0 };
    }

    const deviceIds = candidates.map(({ device }) => device._id);
    const latestEntries = await DeviceEnergySample.aggregate([
      { $match: { deviceId: { $in: deviceIds } } },
      { $sort: { recordedAt: -1, createdAt: -1 } },
      { $group: { _id: '$deviceId', sample: { $first: '$$ROOT' } } }
    ]);

    const latestByDeviceId = new Map(
      latestEntries.map((entry) => [String(entry._id), entry.sample])
    );

    const docsToInsert = [];
    let skippedCount = 0;

    candidates.forEach(({ device, snapshot }) => {
      const nextSample = this.buildSampleDocument(device, snapshot);
      const previousSample = latestByDeviceId.get(String(device._id));
      if (this.sampleMatches(previousSample, nextSample)) {
        skippedCount += 1;
        return;
      }

      docsToInsert.push(nextSample);
      latestByDeviceId.set(String(device._id), nextSample);
    });

    if (docsToInsert.length > 0) {
      await DeviceEnergySample.insertMany(docsToInsert, { ordered: false });
    }

    return {
      insertedCount: docsToInsert.length,
      skippedCount
    };
  }

  async getDeviceEnergyHistory(deviceId, options = {}) {
    const hours = clampInteger(options.hours, DEFAULT_HISTORY_HOURS, 1, MAX_HISTORY_HOURS);
    const limit = clampInteger(options.limit, DEFAULT_HISTORY_LIMIT, 10, MAX_HISTORY_LIMIT);

    const query = {
      deviceId,
      recordedAt: {
        $gte: new Date(Date.now() - hours * 60 * 60 * 1000)
      }
    };

    const samples = await DeviceEnergySample.find(query)
      .sort({ recordedAt: -1 })
      .limit(limit);

    return samples
      .map((entry) => ({
        recordedAt: entry.recordedAt,
        source: entry.source || 'smartthings',
        power: entry.powerValue == null
          ? null
          : {
              value: entry.powerValue,
              unit: entry.powerUnit || 'W',
              timestamp: entry.powerTimestamp || entry.recordedAt
            },
        energy: entry.energyValue == null
          ? null
          : {
              value: entry.energyValue,
              unit: entry.energyUnit || 'kWh',
              timestamp: entry.energyTimestamp || entry.recordedAt
            }
      }))
      .reverse();
  }
}

module.exports = new DeviceEnergySampleService();

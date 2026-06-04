const { EventEmitter } = require('events');
const { serializeDevice, serializeDevices } = require('./devicePayloadService');

function normalizeCacheTtlMs(value, fallback = 15_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1_000, parsed) : fallback;
}

const DEFAULT_DEVICE_UPDATE_CACHE_TTL_MS = normalizeCacheTtlMs(
  process.env.HOMEBRAIN_DEVICE_UPDATE_CACHE_TTL_MS
);

function cloneDeviceSnapshot(device) {
  if (!device || typeof device !== 'object') {
    return null;
  }

  return JSON.parse(JSON.stringify(device));
}

function getDeviceSnapshotId(device) {
  const id = device?.id || device?._id;
  return id ? String(id) : '';
}

class DeviceUpdateEmitter extends EventEmitter {
  constructor() {
    super();
    const maxListeners = Math.max(
      10,
      Number.parseInt(process.env.HOMEBRAIN_DEVICE_UPDATE_MAX_LISTENERS, 10) || 100
    );
    this.setMaxListeners(maxListeners);
    this.latestDevices = new Map();
  }

  emit(eventName, ...args) {
    if (eventName === 'devices:update') {
      this.recordLatestDevices(args[0]);
    }

    return super.emit(eventName, ...args);
  }

  normalizeDevice(device) {
    return serializeDevice(device);
  }

  normalizeDevices(devices) {
    return serializeDevices(devices);
  }

  recordLatestDevices(devices, receivedAt = Date.now()) {
    const normalizedDevices = Array.isArray(devices)
      ? this.normalizeDevices(devices)
      : this.normalizeDevices(devices?.devices);

    normalizedDevices.forEach((device) => {
      const id = getDeviceSnapshotId(device);
      if (!id) {
        return;
      }

      this.latestDevices.set(id, {
        receivedAt,
        device: cloneDeviceSnapshot(device)
      });
    });
  }

  pruneLatestDevices(now = Date.now(), ttlMs = DEFAULT_DEVICE_UPDATE_CACHE_TTL_MS) {
    for (const [id, entry] of this.latestDevices.entries()) {
      if (!entry || now - entry.receivedAt > ttlMs) {
        this.latestDevices.delete(id);
      }
    }
  }

  getLatestDeviceSnapshots(deviceIds = [], options = {}) {
    const now = options.now || Date.now();
    const ttlMs = normalizeCacheTtlMs(options.ttlMs, DEFAULT_DEVICE_UPDATE_CACHE_TTL_MS);
    this.pruneLatestDevices(now, ttlMs);

    const ids = Array.isArray(deviceIds)
      ? deviceIds.map((id) => String(id || '')).filter(Boolean)
      : [];
    const entries = ids.length > 0
      ? ids.map((id) => this.latestDevices.get(id)).filter(Boolean)
      : Array.from(this.latestDevices.values());

    return entries
      .filter((entry) => entry && now - entry.receivedAt <= ttlMs)
      .map((entry) => cloneDeviceSnapshot(entry.device))
      .filter(Boolean);
  }

  mergeLatestDevices(devices = [], options = {}) {
    const normalizedDevices = this.normalizeDevices(devices);
    const ids = normalizedDevices.map(getDeviceSnapshotId).filter(Boolean);
    const latestById = new Map(
      this.getLatestDeviceSnapshots(ids, options).map((device) => [getDeviceSnapshotId(device), device])
    );

    return normalizedDevices.map((device) => {
      const id = getDeviceSnapshotId(device);
      return latestById.get(id) || device;
    });
  }

  clearLatestDevices() {
    this.latestDevices.clear();
  }
}

const deviceUpdateEmitter = new DeviceUpdateEmitter();

module.exports = deviceUpdateEmitter;

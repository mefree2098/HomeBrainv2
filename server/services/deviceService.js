const mongoose = require('mongoose');
const Device = require('../models/Device');
const DeviceGroup = require('../models/DeviceGroup');
const AlexaExposure = require('../models/AlexaExposure');
const DeviceCommandClaim = require('../models/DeviceCommandClaim');
const DeviceEnergySample = require('../models/DeviceEnergySample');
const SecurityAlarm = require('../models/SecurityAlarm');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const UserProfile = require('../models/UserProfile');
const RainMachineIntegration = require('../models/RainMachineIntegration');
const smartThingsService = require('./smartThingsService');
const harmonyService = require('./harmonyService');
const ecobeeService = require('./ecobeeService');
const rainMachineService = require('./rainMachineService');
const deviceEnergySampleService = require('./deviceEnergySampleService');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const deviceCommandCoordinatorService = require('./deviceCommandCoordinatorService');
const {
  ensureUniquePlatformIdentity
} = require('./deviceIdentityService');
const {
  buildDeviceSourceFilterQuery,
  canonicalizeDeviceSource
} = require('./deviceSourceCatalog');
const MAX_HARMONY_COMMAND_HOLD_MS = 5000;
const MAX_HARMONY_ACTIVITY_VERIFY_TIMEOUT_MS = 120_000;
const MAX_HARMONY_ACTIVITY_VERIFY_INTERVAL_MS = 15_000;
const MAX_SMARTTHINGS_POST_COMMAND_STATE_AGE_MS = 24 * 60 * 60 * 1000;

function normalizeIdString(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'object' && value._id !== undefined && value._id !== null) {
    return normalizeIdString(value._id);
  }

  return String(value).trim();
}

function clonePlainObject(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }

  if (typeof value.toObject === 'function') {
    return value.toObject({ depopulate: true, versionKey: false });
  }

  return { ...value };
}

function createDeletionCleanupSummary() {
  return {
    alexaExposuresDeleted: 0,
    commandClaimsDeleted: 0,
    energySamplesDeleted: 0,
    securityZonesRemoved: 0,
    securitySirenOutputsRemoved: 0,
    favoriteReferencesRemoved: 0,
    securityPreferenceReferencesRemoved: 0,
    dashboardWidgetsRemoved: 0,
    dashboardDeviceReferencesRemoved: 0,
    userProfilesUpdated: 0,
    securityAlarmsUpdated: 0,
    directRadio: null,
    cleanupErrors: []
  };
}

function recordDeletionCleanupError(cleanup, scope, error, context = {}) {
  if (!cleanup || !Array.isArray(cleanup.cleanupErrors)) {
    return;
  }

  cleanup.cleanupErrors.push({
    scope,
    message: error?.message || String(error || 'Unknown cleanup error'),
    ...context
  });
}

function parseBoundedMs(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

const DEFAULT_HARMONY_ACTIVITY_VERIFY_TIMEOUT_MS = parseBoundedMs(
  process.env.HARMONY_ACTIVITY_VERIFY_TIMEOUT_MS,
  30_000,
  0,
  MAX_HARMONY_ACTIVITY_VERIFY_TIMEOUT_MS
);
const DEFAULT_HARMONY_ACTIVITY_VERIFY_INTERVAL_MS = parseBoundedMs(
  process.env.HARMONY_ACTIVITY_VERIFY_INTERVAL_MS,
  3_000,
  500,
  MAX_HARMONY_ACTIVITY_VERIFY_INTERVAL_MS
);
const DEFAULT_SMARTTHINGS_POST_COMMAND_STATE_AGE_MS = parseBoundedMs(
  process.env.SMARTTHINGS_POST_COMMAND_STATE_MAX_AGE_MS,
  10 * 60 * 1000,
  0,
  MAX_SMARTTHINGS_POST_COMMAND_STATE_AGE_MS
);

const HARMONY_VISIBLE_DEVICE_QUERY = Object.freeze({
  $or: [
    { 'properties.harmonyExcludeFromHomeBrain': { $exists: false } },
    { 'properties.harmonyExcludeFromHomeBrain': { $ne: true } }
  ]
});
const RETIRED_SMARTTHINGS_MIGRATION_SOURCE_QUERY = Object.freeze({
  $or: [
    { 'properties.smartThingsMigration.retiredSource': { $exists: false } },
    { 'properties.smartThingsMigration.retiredSource': { $ne: true } },
    // A native (homebrain-*) device is the live migrated device, never a retired
    // SmartThings source tombstone -- always keep it visible even if a stale
    // retiredSource flag lingered on it.
    { 'properties.source': { $regex: '^homebrain-', $options: 'i' } }
  ]
});
const DIRECT_RADIO_VISIBLE_DEVICE_QUERY = Object.freeze({
  $and: [
    { 'properties.homebrainDirect.isControllerNode': { $ne: true } },
    {
      $nor: [
        {
          'properties.source': 'homebrain-zwave',
          'properties.homebrainDirect.nodeId': 1,
          $or: [
            { name: /^ZST39(?:\s|$)/i },
            { model: /^ZST39(?:\s|$)/i },
            { 'properties.homebrainDirect.productId': 1552 }
          ]
        }
      ]
    }
  ]
});
let cachedInsteonService = null;
const getInsteonService = () => {
  if (!cachedInsteonService) {
    cachedInsteonService = require('./insteonService');
  }
  return cachedInsteonService;
};
let cachedDirectRadioService = null;
const getDirectRadioService = () => {
  if (!cachedDirectRadioService) {
    cachedDirectRadioService = require('./directRadioService');
  }
  return cachedDirectRadioService;
};
let cachedMatterService = null;
const getMatterService = () => {
  if (!cachedMatterService) {
    cachedMatterService = require('./matterService');
  }
  return cachedMatterService;
};

function isDatabaseReadyForPresenceChecks() {
  return mongoose.connection?.readyState === 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readTimestampMs(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

function getNestedValue(source, path) {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  return path.reduce((current, key) => (
    current && typeof current === 'object' ? current[key] : undefined
  ), source);
}

function getSmartThingsVerificationTimestampMs(remoteUpdate = {}) {
  const metadata = remoteUpdate?.['properties.smartThingsAttributeMetadata']
    || remoteUpdate?.properties?.smartThingsAttributeMetadata
    || {};
  const healthState = remoteUpdate?.['properties.smartThingsHealthState']
    || remoteUpdate?.properties?.smartThingsHealthState
    || {};

  const candidates = [
    getNestedValue(metadata, ['byComponent', 'main', 'switch', 'switch', 'timestamp']),
    getNestedValue(metadata, ['switch', 'switch', 'timestamp']),
    getNestedValue(metadata, ['byComponent', 'main', 'switchLevel', 'level', 'timestamp']),
    getNestedValue(metadata, ['switchLevel', 'level', 'timestamp']),
    healthState.lastUpdatedDate,
    remoteUpdate.lastSeen
  ]
    .map(readTimestampMs)
    .filter((value) => Number.isFinite(value));

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function assertSmartThingsPostActionVerified(device, remoteUpdate, expectedStatus, options = {}) {
  if (!remoteUpdate || typeof remoteUpdate !== 'object') {
    const error = new Error('Unable to verify SmartThings state after command');
    error.details = {
      source: 'smartthings',
      deviceId: device?._id?.toString?.() || String(device?._id || ''),
      deviceName: device?.name || null,
      expectedStatus
    };
    throw error;
  }

  if (expectedStatus !== undefined) {
    if (remoteUpdate.status === undefined) {
      const error = new Error('SmartThings verification did not return switch state after command');
      error.details = {
        source: 'smartthings',
        deviceId: device?._id?.toString?.() || String(device?._id || ''),
        deviceName: device?.name || null,
        expectedStatus
      };
      throw error;
    }

    if (remoteUpdate.status !== expectedStatus) {
      const error = new Error(
        `SmartThings verification failed: expected ${expectedStatus ? 'on' : 'off'} but API reported ${remoteUpdate.status ? 'on' : 'off'}`
      );
      error.details = {
        source: 'smartthings',
        deviceId: device?._id?.toString?.() || String(device?._id || ''),
        deviceName: device?.name || null,
        expectedStatus,
        actualStatus: remoteUpdate.status
      };
      throw error;
    }
  }

  const maxStateAgeMs = parseBoundedMs(
    options.maxStateAgeMs,
    DEFAULT_SMARTTHINGS_POST_COMMAND_STATE_AGE_MS,
    0,
    MAX_SMARTTHINGS_POST_COMMAND_STATE_AGE_MS
  );
  if (maxStateAgeMs <= 0) {
    return;
  }

  const verifiedAtMs = getSmartThingsVerificationTimestampMs(remoteUpdate);
  const nowMs = Date.now();
  if (!Number.isFinite(verifiedAtMs) || nowMs - verifiedAtMs > maxStateAgeMs) {
    const ageMs = Number.isFinite(verifiedAtMs) ? nowMs - verifiedAtMs : null;
    const error = new Error('SmartThings verification returned stale state after command');
    error.details = {
      source: 'smartthings',
      deviceId: device?._id?.toString?.() || String(device?._id || ''),
      deviceName: device?.name || null,
      expectedStatus,
      verifiedAt: Number.isFinite(verifiedAtMs) ? new Date(verifiedAtMs).toISOString() : null,
      stateAgeMs: ageMs,
      maxStateAgeMs
    };
    throw error;
  }
}

function normalizeDeviceGroups(groups) {
  const values = Array.isArray(groups)
    ? groups
    : typeof groups === 'string'
      ? groups.split(',')
      : [];

  const seen = new Set();
  const normalized = [];

  values.forEach((entry) => {
    const trimmed = typeof entry === 'string'
      ? entry.trim()
      : String(entry || '').trim();
    if (!trimmed) {
      return;
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    normalized.push(trimmed);
  });

  return normalized;
}

function mergeMongoQuery(baseQuery = {}, extraQuery = {}) {
  const baseHasKeys = baseQuery && typeof baseQuery === 'object' && Object.keys(baseQuery).length > 0;
  const extraHasKeys = extraQuery && typeof extraQuery === 'object' && Object.keys(extraQuery).length > 0;

  if (!baseHasKeys) {
    return extraHasKeys ? { ...extraQuery } : {};
  }
  if (!extraHasKeys) {
    return { ...baseQuery };
  }

  const queryParts = (query) => {
    const keys = Object.keys(query || {});
    return keys.length === 1 && Array.isArray(query.$and) ? query.$and : [query];
  };

  return {
    $and: [
      ...queryParts(baseQuery),
      ...queryParts(extraQuery)
    ]
  };
}

function buildVisibleDeviceQuery(filters = {}, options = {}) {
  let query = { ...filters };
  if (options.includeExcludedHarmony === true) {
    query = options.includeRetiredMigrationSources === true
      ? query
      : mergeMongoQuery(query, RETIRED_SMARTTHINGS_MIGRATION_SOURCE_QUERY);
    return options.includeDirectRadioControllerNodes === true
      ? query
      : mergeMongoQuery(query, DIRECT_RADIO_VISIBLE_DEVICE_QUERY);
  }

  query = mergeMongoQuery(query, HARMONY_VISIBLE_DEVICE_QUERY);
  query = options.includeRetiredMigrationSources === true
    ? query
    : mergeMongoQuery(query, RETIRED_SMARTTHINGS_MIGRATION_SOURCE_QUERY);
  return options.includeDirectRadioControllerNodes === true
    ? query
    : mergeMongoQuery(query, DIRECT_RADIO_VISIBLE_DEVICE_QUERY);
}

async function ensureDeviceGroupRegistryEntries(groups = []) {
  const normalizedGroups = normalizeDeviceGroups(groups);
  if (normalizedGroups.length === 0) {
    return;
  }

  const existingGroups = await DeviceGroup.find({
    normalizedName: { $in: normalizedGroups.map((group) => group.toLowerCase()) }
  }).lean();
  const existingKeys = new Set(existingGroups.map((group) => String(group.normalizedName || '').toLowerCase()));

  for (const groupName of normalizedGroups) {
    const normalizedName = groupName.toLowerCase();
    if (existingKeys.has(normalizedName)) {
      continue;
    }

    try {
      const group = new DeviceGroup({ name: groupName });
      // eslint-disable-next-line no-await-in-loop
      await group.save();
      existingKeys.add(normalizedName);
    } catch (error) {
      if (error?.code !== 11000) {
        throw error;
      }
    }
  }
}

class DeviceService {
  constructor() {
    this.smartThingsPresence = null;
    this.smartThingsPresenceCheckedAt = 0;
    this.smartThingsSyncPromise = null;
    this.lastSmartThingsSyncAt = 0;
    this.smartThingsSyncCooldownMs = Number(process.env.SMARTTHINGS_DEVICE_REFRESH_MS || 5 * 60 * 1000);
    this.harmonyPresence = null;
    this.harmonyPresenceCheckedAt = 0;
    this.harmonySyncPromise = null;
    this.lastHarmonySyncAt = 0;
    this.harmonySyncCooldownMs = Number(process.env.HARMONY_DEVICE_REFRESH_MS || 30 * 1000);
    this.ecobeePresence = null;
    this.ecobeePresenceCheckedAt = 0;
    this.ecobeeSyncPromise = null;
    this.lastEcobeeSyncAt = 0;
    this.ecobeeSyncCooldownMs = Number(process.env.ECOBEE_DEVICE_REFRESH_MS || 2 * 60 * 1000);
    this.rainMachinePresence = null;
    this.rainMachinePresenceCheckedAt = 0;
    this.rainMachineSyncPromise = null;
    this.lastRainMachineSyncAt = 0;
    this.rainMachineSyncCooldownMs = Number(process.env.RAINMACHINE_DEVICE_REFRESH_MS || 60 * 1000);
    const integrationRefreshDebounceMs = Number(process.env.HOMEBRAIN_DEVICE_REFRESH_DEBOUNCE_MS || 1_000);
    this.integrationRefreshPromise = null;
    this.lastIntegrationRefreshScheduledAt = 0;
    this.integrationRefreshDebounceMs = Number.isFinite(integrationRefreshDebounceMs)
      ? Math.max(250, Math.min(10_000, integrationRefreshDebounceMs))
      : 1_000;
  }

  /**
   * Get all devices
   * @param {Object} filters - Optional filters (room, type, status, isOnline, source)
   * @returns {Promise<Array>} Array of devices
   */
  async getAllDevices(filters = {}, options = {}) {
    try {
      console.log('DeviceService: Fetching all devices with filters:', filters);

      this.scheduleIntegrationRefresh({ reason: 'getAllDevices' });

      const query = {};
      if (filters.room) query.room = filters.room;
      if (filters.type) query.type = filters.type;
      if (filters.status !== undefined) query.status = filters.status;
      if (filters.isOnline !== undefined) query.isOnline = filters.isOnline;
      if (filters.source) {
        Object.assign(query, buildDeviceSourceFilterQuery(filters.source));
      }
      
      const visibilityQuery = buildVisibleDeviceQuery(query, options);
      let devices = await Device.find(visibilityQuery).sort({ room: 1, name: 1 });

      if (options.refreshSmartThings) {
        await this.refreshSmartThingsDevices(devices);
        devices = await Device.find(visibilityQuery).sort({ room: 1, name: 1 });
      }

      console.log(`DeviceService: Found ${devices.length} devices`);
      
      return devices;
    } catch (error) {
      console.error('DeviceService: Error fetching all devices:', error.message);
      console.error(error.stack);
      throw new Error('Failed to fetch devices');
    }
  }

  async refreshSmartThingsDevices(devices = []) {
    const smartThingsDevices = Array.isArray(devices)
      ? devices.filter((device) => this.isSmartThingsDevice(device))
      : [];

    if (smartThingsDevices.length === 0) {
      return [];
    }

    const bulkOps = [];
    const updatedDeviceIds = new Set();

    for (const device of smartThingsDevices) {
      try {
        const updates = await this.pollSmartThingsState(device, undefined);
        if (!updates || Object.keys(updates).length === 0) {
          continue;
        }

        bulkOps.push({
          updateOne: {
            filter: { _id: device._id },
            update: { $set: updates }
          }
        });
        updatedDeviceIds.add(String(device._id));
      } catch (error) {
        const smartThingsId = device?.properties?.smartThingsDeviceId || 'unknown-id';
        console.warn(`DeviceService: Failed to refresh SmartThings device ${smartThingsId}: ${error.message}`);
      }
    }

    if (bulkOps.length === 0) {
      return [];
    }

    await Device.bulkWrite(bulkOps, { ordered: false });

    const refreshedDevices = await Device.find({ _id: { $in: Array.from(updatedDeviceIds) } });
    try {
      await deviceEnergySampleService.recordSamplesForDevices(refreshedDevices);
    } catch (error) {
      console.warn(`DeviceService: Failed to persist SmartThings energy samples: ${error.message}`);
    }
    const payload = deviceUpdateEmitter.normalizeDevices(refreshedDevices);
    if (payload.length > 0) {
      deviceUpdateEmitter.emit('devices:update', payload);
    }

    return refreshedDevices;
  }

  /**
   * Get device by ID
   * @param {string} deviceId - Device ID
   * @returns {Promise<Object>} Device object
   */
  async getDeviceById(deviceId) {
    try {
      console.log('DeviceService: Fetching device by ID:', deviceId);

      this.scheduleIntegrationRefresh({ reason: 'getDeviceById' });

      const device = await Device.findById(deviceId);
      if (!device) {
        console.log('DeviceService: Device not found for ID:', deviceId);
        throw new Error('Device not found');
      }
      
      console.log('DeviceService: Successfully found device:', device.name);
      return device;
    } catch (error) {
      console.error('DeviceService: Error fetching device by ID:', error.message);
      console.error(error.stack);
      if (error.message === 'Device not found') {
        throw error;
      }
      throw new Error('Failed to fetch device');
    }
  }

  /**
   * Create a new device
   * @param {Object} deviceData - Device data
   * @returns {Promise<Object>} Created device
   */
  async createDevice(deviceData) {
    try {
      console.log('DeviceService: Creating new device:', deviceData.name);
      
      // Validate required fields
      if (!deviceData.name || !deviceData.type || !deviceData.room) {
        throw new Error('Name, type, and room are required fields');
      }
      
      // Check if device with same name exists in the same room
      const existingDevice = await Device.findOne({
        name: deviceData.name,
        room: deviceData.room
      });
      
      if (existingDevice) {
        throw new Error('A device with this name already exists in this room');
      }
      
      const normalizedDeviceData = {
        ...deviceData,
        groups: normalizeDeviceGroups(deviceData.groups)
      };
      normalizedDeviceData.properties = await ensureUniquePlatformIdentity(deviceData.properties || {});

      const device = new Device(normalizedDeviceData);
      const savedDevice = await device.save();
      await ensureDeviceGroupRegistryEntries(savedDevice.groups);
      
      console.log('DeviceService: Successfully created device:', savedDevice.name, 'with ID:', savedDevice._id);
      return savedDevice;
    } catch (error) {
      console.error('DeviceService: Error creating device:', error.message);
      console.error(error.stack);
      if (error.message.includes('required fields') || error.message.includes('already exists')) {
        throw error;
      }
      throw new Error('Failed to create device');
    }
  }

  /**
   * Update a device
   * @param {string} deviceId - Device ID
   * @param {Object} updateData - Data to update
   * @returns {Promise<Object>} Updated device
   */
  async updateDevice(deviceId, updateData) {
    try {
      console.log('DeviceService: Updating device:', deviceId);
      
      // Check if device exists
      const existingDevice = await Device.findById(deviceId);
      if (!existingDevice) {
        throw new Error('Device not found');
      }
      
      const normalizedUpdateData = { ...updateData };
      if (Object.prototype.hasOwnProperty.call(normalizedUpdateData, 'groups')) {
        normalizedUpdateData.groups = normalizeDeviceGroups(normalizedUpdateData.groups);
      }
      if (Object.prototype.hasOwnProperty.call(normalizedUpdateData, 'properties')) {
        const nextProperties = {
          ...(existingDevice?.properties && typeof existingDevice.properties === 'object'
            ? existingDevice.properties
            : {}),
          ...(normalizedUpdateData.properties && typeof normalizedUpdateData.properties === 'object'
            ? normalizedUpdateData.properties
            : {})
        };
        normalizedUpdateData.properties = await ensureUniquePlatformIdentity(nextProperties, deviceId);
      }

      // If updating name and room, check for duplicates
      if ((normalizedUpdateData.name && normalizedUpdateData.name !== existingDevice.name) ||
          (normalizedUpdateData.room && normalizedUpdateData.room !== existingDevice.room)) {
        const name = normalizedUpdateData.name || existingDevice.name;
        const room = normalizedUpdateData.room || existingDevice.room;
        
        const duplicateDevice = await Device.findOne({
          _id: { $ne: deviceId },
          name: name,
          room: room
        });
        
        if (duplicateDevice) {
          throw new Error('A device with this name already exists in this room');
        }
      }
      
      // Update lastSeen if device comes back online
      if (normalizedUpdateData.isOnline === true && existingDevice.isOnline === false) {
        normalizedUpdateData.lastSeen = new Date();
      }
      
        const updatedDevice = await Device.findByIdAndUpdate(
          deviceId,
          normalizedUpdateData,
          { returnDocument: 'after', runValidators: true }
        );
        
        if (updatedDevice) {
          await ensureDeviceGroupRegistryEntries(updatedDevice.groups);
          const payload = deviceUpdateEmitter.normalizeDevices([updatedDevice]);
          if (payload.length > 0) {
            deviceUpdateEmitter.emit('devices:update', payload);
          }
        }

        console.log('DeviceService: Successfully updated device:', updatedDevice.name);
        return updatedDevice;
    } catch (error) {
      console.error('DeviceService: Error updating device:', error.message);
      console.error(error.stack);
      if (error.message === 'Device not found' || error.message.includes('already exists')) {
        throw error;
      }
      throw new Error('Failed to update device');
    }
  }

  cleanupDashboardViewsForDeletedDevice(views = [], deviceId) {
    const cleanup = {
      dashboardWidgetsRemoved: 0,
      dashboardDeviceReferencesRemoved: 0
    };

    if (!Array.isArray(views) || !deviceId) {
      return { views, cleanup, changed: false };
    }

    let changed = false;
    const nextViews = views.map((view) => {
      const plainView = clonePlainObject(view);
      const widgets = Array.isArray(plainView.widgets) ? plainView.widgets : [];
      const nextWidgets = [];

      widgets.forEach((widget) => {
        const plainWidget = clonePlainObject(widget);
        const settings = clonePlainObject(plainWidget.settings);
        let removeWidget = false;

        if (normalizeIdString(settings.deviceId) === deviceId) {
          removeWidget = true;
          cleanup.dashboardWidgetsRemoved += 1;
        }

        if (Array.isArray(settings.deviceIds)) {
          const beforeLength = settings.deviceIds.length;
          settings.deviceIds = settings.deviceIds.filter((entry) => normalizeIdString(entry) !== deviceId);
          const removedCount = beforeLength - settings.deviceIds.length;
          if (removedCount > 0) {
            changed = true;
            cleanup.dashboardDeviceReferencesRemoved += removedCount;
          }
          if (beforeLength > 0 && settings.deviceIds.length === 0) {
            removeWidget = true;
            cleanup.dashboardWidgetsRemoved += 1;
          }
        }

        if (
          settings.favoriteDeviceSizes &&
          typeof settings.favoriteDeviceSizes === 'object' &&
          !Array.isArray(settings.favoriteDeviceSizes) &&
          Object.prototype.hasOwnProperty.call(settings.favoriteDeviceSizes, deviceId)
        ) {
          settings.favoriteDeviceSizes = { ...settings.favoriteDeviceSizes };
          delete settings.favoriteDeviceSizes[deviceId];
          changed = true;
          cleanup.dashboardDeviceReferencesRemoved += 1;
        }

        if (removeWidget) {
          changed = true;
          return;
        }

        nextWidgets.push({
          ...plainWidget,
          settings
        });
      });

      return {
        ...plainView,
        widgets: nextWidgets
      };
    });

    return { views: nextViews, cleanup, changed };
  }

  async cleanupDeletedDeviceReferences(deletedDevice) {
    const deviceId = normalizeIdString(deletedDevice?._id);
    const cleanup = createDeletionCleanupSummary();

    if (!deviceId) {
      return cleanup;
    }

    const independentCleanups = await Promise.allSettled([
      AlexaExposure.deleteMany({ entityType: 'device', entityId: deviceId }),
      DeviceCommandClaim.deleteMany({ deviceId: deletedDevice._id }),
      DeviceEnergySample.deleteMany({ deviceId: deletedDevice._id })
    ]);
    const [
      alexaResult,
      claimResult,
      energyResult
    ] = independentCleanups;

    if (alexaResult.status === 'fulfilled') {
      cleanup.alexaExposuresDeleted = alexaResult.value?.deletedCount ?? 0;
    } else {
      recordDeletionCleanupError(cleanup, 'alexaExposure', alexaResult.reason, { deviceId });
    }
    if (claimResult.status === 'fulfilled') {
      cleanup.commandClaimsDeleted = claimResult.value?.deletedCount ?? 0;
    } else {
      recordDeletionCleanupError(cleanup, 'deviceCommandClaim', claimResult.reason, { deviceId });
    }
    if (energyResult.status === 'fulfilled') {
      cleanup.energySamplesDeleted = energyResult.value?.deletedCount ?? 0;
    } else {
      recordDeletionCleanupError(cleanup, 'deviceEnergySample', energyResult.reason, { deviceId });
    }

    let alarms = [];
    try {
      alarms = await SecurityAlarm.find({
        $or: [
          { 'zones.deviceId': deviceId },
          { 'sirenOutputs.deviceId': deviceId }
        ]
      });
    } catch (error) {
      recordDeletionCleanupError(cleanup, 'securityAlarm.find', error, { deviceId });
    }

    for (const alarm of alarms) {
      const originalZoneCount = Array.isArray(alarm.zones) ? alarm.zones.length : 0;
      const originalSirenOutputCount = Array.isArray(alarm.sirenOutputs) ? alarm.sirenOutputs.length : 0;

      alarm.zones = (alarm.zones || []).filter((zone) => normalizeIdString(zone?.deviceId) !== deviceId);
      alarm.sirenOutputs = (alarm.sirenOutputs || []).filter((output) => normalizeIdString(output?.deviceId) !== deviceId);

      const removedZoneCount = originalZoneCount - alarm.zones.length;
      const removedSirenOutputCount = originalSirenOutputCount - alarm.sirenOutputs.length;

      if (removedZoneCount > 0 || removedSirenOutputCount > 0) {
        try {
          await alarm.save({ validateBeforeSave: false });
          cleanup.securityZonesRemoved += removedZoneCount;
          cleanup.securitySirenOutputsRemoved += removedSirenOutputCount;
          cleanup.securityAlarmsUpdated += 1;
        } catch (error) {
          recordDeletionCleanupError(cleanup, 'securityAlarm.save', error, {
            deviceId,
            alarmId: normalizeIdString(alarm?._id)
          });
        }
      }
    }

    let profiles = [];
    try {
      profiles = await UserProfile.find({});
    } catch (error) {
      recordDeletionCleanupError(cleanup, 'userProfile.find', error, { deviceId });
    }

    for (const profile of profiles) {
      let changed = false;
      let pendingFavoriteReferencesRemoved = 0;
      let pendingSecurityPreferenceReferencesRemoved = 0;
      let pendingDashboardWidgetsRemoved = 0;
      let pendingDashboardDeviceReferencesRemoved = 0;

      const favorites = profile.favorites || {};
      const favoriteDevices = Array.isArray(favorites.devices) ? favorites.devices : [];
      const nextFavoriteDevices = favoriteDevices.filter((favoriteDeviceId) => normalizeIdString(favoriteDeviceId) !== deviceId);
      const removedFavoriteCount = favoriteDevices.length - nextFavoriteDevices.length;
      if (removedFavoriteCount > 0) {
        profile.favorites = {
          ...favorites,
          devices: nextFavoriteDevices
        };
        pendingFavoriteReferencesRemoved += removedFavoriteCount;
        changed = true;
      }

      const securityPreferences = profile.securityPreferences || {};
      const visibleSensorIds = Array.isArray(securityPreferences.visibleSensorIds)
        ? securityPreferences.visibleSensorIds
        : [];
      const nextVisibleSensorIds = visibleSensorIds.filter((sensorId) => normalizeIdString(sensorId) !== deviceId);
      const removedVisibleSensorCount = visibleSensorIds.length - nextVisibleSensorIds.length;
      if (removedVisibleSensorCount > 0) {
        profile.securityPreferences = {
          ...securityPreferences,
          visibleSensorIds: nextVisibleSensorIds.length > 0 ? nextVisibleSensorIds : undefined
        };
        pendingSecurityPreferenceReferencesRemoved += removedVisibleSensorCount;
        changed = true;
      }

      const dashboardCleanup = this.cleanupDashboardViewsForDeletedDevice(profile.dashboardViews || [], deviceId);
      if (dashboardCleanup.changed) {
        profile.dashboardViews = dashboardCleanup.views;
        pendingDashboardWidgetsRemoved += dashboardCleanup.cleanup.dashboardWidgetsRemoved;
        pendingDashboardDeviceReferencesRemoved += dashboardCleanup.cleanup.dashboardDeviceReferencesRemoved;
        changed = true;
      }

      if (changed) {
        try {
          await profile.save({ validateBeforeSave: false });
          cleanup.favoriteReferencesRemoved += pendingFavoriteReferencesRemoved;
          cleanup.securityPreferenceReferencesRemoved += pendingSecurityPreferenceReferencesRemoved;
          cleanup.dashboardWidgetsRemoved += pendingDashboardWidgetsRemoved;
          cleanup.dashboardDeviceReferencesRemoved += pendingDashboardDeviceReferencesRemoved;
          cleanup.userProfilesUpdated += 1;
        } catch (error) {
          recordDeletionCleanupError(cleanup, 'userProfile.save', error, {
            deviceId,
            profileId: normalizeIdString(profile?._id)
          });
        }
      }
    }

    return cleanup;
  }

  async cleanupDeletedDirectRadioDevice(deletedDevice) {
    const properties = deletedDevice?.properties && typeof deletedDevice.properties === 'object'
      ? deletedDevice.properties
      : {};
    const source = canonicalizeDeviceSource(properties.source || '');
    const protocol = canonicalizeDeviceSource(properties.homebrainDirect?.protocol || '');
    const ieeeAddr = normalizeIdString(properties.homebrainDirect?.ieeeAddr).toLowerCase();
    if ((source !== 'homebrain-zigbee' && protocol !== 'homebrain-zigbee') || !ieeeAddr) {
      return null;
    }

    const directRadioService = require('./directRadioService');
    if (typeof directRadioService.forgetZigbeeDevice !== 'function') {
      return {
        skipped: true,
        reason: 'forgetZigbeeDevice unavailable',
        ieeeAddr
      };
    }

    return directRadioService.forgetZigbeeDevice(ieeeAddr, {
      force: true,
      source: 'device_delete',
      deviceId: normalizeIdString(deletedDevice?._id),
      deviceName: deletedDevice?.name || null
    });
  }

  /**
   * Delete a device
   * @param {string} deviceId - Device ID
   * @returns {Promise<Object>} Deleted device
   */
  async deleteDevice(deviceId) {
    try {
      console.log('DeviceService: Deleting device:', deviceId);
      
      const deletedDevice = await Device.findByIdAndDelete(deviceId);
      if (!deletedDevice) {
        throw new Error('Device not found');
      }
      const deletedDeviceSnapshot = clonePlainObject(deletedDevice);

      let deletionCleanup;
      try {
        deletionCleanup = await this.cleanupDeletedDeviceReferences(deletedDeviceSnapshot);
      } catch (cleanupError) {
        deletionCleanup = createDeletionCleanupSummary();
        recordDeletionCleanupError(deletionCleanup, 'cleanupDeletedDeviceReferences', cleanupError, {
          deviceId: normalizeIdString(deletedDeviceSnapshot?._id)
        });
      }

      try {
        deletionCleanup.directRadio = await this.cleanupDeletedDirectRadioDevice(deletedDeviceSnapshot);
      } catch (cleanupError) {
        recordDeletionCleanupError(deletionCleanup, 'cleanupDeletedDirectRadioDevice', cleanupError, {
          deviceId: normalizeIdString(deletedDeviceSnapshot?._id),
          ieeeAddr: normalizeIdString(deletedDeviceSnapshot?.properties?.homebrainDirect?.ieeeAddr) || undefined
        });
      }

      const deletedDeviceResult = {
        ...deletedDeviceSnapshot,
        deletionCleanup
      };

      const cleanupErrorCount = Array.isArray(deletedDeviceResult.deletionCleanup?.cleanupErrors)
        ? deletedDeviceResult.deletionCleanup.cleanupErrors.length
        : 0;
      if (cleanupErrorCount > 0) {
        console.warn('DeviceService: Deleted device with cleanup warnings:', deletedDeviceResult.name, deletedDeviceResult.deletionCleanup.cleanupErrors);
      }
      
      console.log('DeviceService: Successfully deleted device:', deletedDeviceResult.name, deletedDeviceResult.deletionCleanup);
      return deletedDeviceResult;
    } catch (error) {
      console.error('DeviceService: Error deleting device:', error.message);
      console.error(error.stack);
      if (error.message === 'Device not found') {
        throw error;
      }
      throw new Error('Failed to delete device');
    }
  }

  /**
   * Control a device (toggle, set brightness, temperature, etc.)
   * @param {string} deviceId - Device ID
   * @param {string} action - Action to perform (toggle, setBrightness, setTemperature, etc.)
   * @param {*} value - Value for the action (optional)
   * @returns {Promise<Object>} Updated device
   */
  async controlDevice(deviceId, action, value, options = {}) {
    let coordinatorAdmission = null;

    try {
      console.log('DeviceService: Controlling device:', deviceId, 'action:', action, 'value:', value);

      let device = await Device.findById(deviceId);
      if (!device) {
        throw new Error('Device not found');
      }

      let normalizedAction = this.normalizeAction(action);

      if (!normalizedAction) {
        throw new Error(`Unknown action: ${action}`);
      }
      normalizedAction = this.normalizeDeviceControlAction(device, normalizedAction);

      const commandMetadata = {
        ...(options?.command && typeof options.command === 'object' ? options.command : {}),
        ...(options?.commandMetadata && typeof options.commandMetadata === 'object' ? options.commandMetadata : {})
      };
      [
        'source',
        'commandSource',
        'priority',
        'commandPriority',
        'ttlSeconds',
        'commandTtlSeconds',
        'reason',
        'commandReason',
        'actor',
        'requestedBy',
        'workflowId',
        'workflowName',
        'workflowPriority',
        'automationId',
        'automationName',
        'sceneId',
        'sceneName',
        'triggerType',
        'triggerSource',
        'correlationId',
        'executionCorrelationId'
      ].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(options || {}, key)) {
          commandMetadata[key] = options[key];
        }
      });

      coordinatorAdmission = await deviceCommandCoordinatorService.admitCommand({
        device,
        action: normalizedAction,
        value,
        metadata: commandMetadata
      });

      const isSmartThings = this.isSmartThingsDevice(device);
      const isHarmony = this.isHarmonyDevice(device);
      const isEcobee = this.isEcobeeDevice(device);
      const isRainMachine = this.isRainMachineDevice(device);
      const isInsteon = this.isInsteonDevice(device);
      const isDirectRadio = this.isDirectRadioDevice(device);
      const isMatter = this.isMatterDevice(device);
      const skipIntegrationRefresh = options?.skipIntegrationRefresh === true;
      const skipPostActionVerification = options?.skipPostActionVerification === true;
      const requirePostActionVerification = options?.requirePostActionVerification === true;
      const harmonyVerificationTimeoutMs = parseBoundedMs(
        options?.harmonyVerificationTimeoutMs,
        DEFAULT_HARMONY_ACTIVITY_VERIFY_TIMEOUT_MS,
        0,
        MAX_HARMONY_ACTIVITY_VERIFY_TIMEOUT_MS
      );
      const harmonyVerificationIntervalMs = parseBoundedMs(
        options?.harmonyVerificationIntervalMs,
        DEFAULT_HARMONY_ACTIVITY_VERIFY_INTERVAL_MS,
        500,
        MAX_HARMONY_ACTIVITY_VERIFY_INTERVAL_MS
      );

      if (isSmartThings && !skipIntegrationRefresh) {
        await this.ensureSmartThingsState({ immediate: true });
      }
      if (isHarmony && !skipIntegrationRefresh) {
        await this.ensureHarmonyState({ immediate: true });
      }
      if (isEcobee && !skipIntegrationRefresh) {
        await this.ensureEcobeeState({ immediate: true });
      }
      if (isRainMachine && !skipIntegrationRefresh) {
        await this.ensureRainMachineState({ immediate: true });
      }

      if (isHarmony && normalizedAction === 'toggle' && !skipIntegrationRefresh) {
        const refreshedDevice = await Device.findById(deviceId);
        if (refreshedDevice) {
          device = refreshedDevice;
        }
      }

      if (!device.isOnline) {
        if (isSmartThings) {
          const refreshedOnline = await this.refreshSmartThingsOnlineStatus(device);
          if (!refreshedOnline) {
            const smartThingsId = device?.properties?.smartThingsDeviceId || 'unknown-id';
            console.warn(`DeviceService: SmartThings device ${smartThingsId} still reports offline; attempting command anyway`);
          }
        } else if (isEcobee) {
          const refreshedOnline = await this.refreshEcobeeOnlineStatus(device);
          if (!refreshedOnline) {
            const ecobeeId = device?.properties?.ecobeeThermostatIdentifier || 'unknown-id';
            console.warn(`DeviceService: Ecobee thermostat ${ecobeeId} still reports offline; attempting command anyway`);
          }
        } else if (isHarmony) {
          const refreshedOnline = await this.refreshHarmonyOnlineStatus(device);
          if (!refreshedOnline) {
            const harmonyHubIp = device?.properties?.harmonyHubIp || 'unknown-hub';
            console.warn(`DeviceService: Harmony device on hub ${harmonyHubIp} still reports offline; attempting command anyway`);
          }
        } else if (isRainMachine) {
          const controllerId = device?.properties?.rainmachine?.controllerId || 'unknown-controller';
          console.warn(`DeviceService: RainMachine device ${controllerId} reports offline; attempting command anyway`);
        } else if (isInsteon) {
          const insteonAddress = device?.properties?.insteonAddress || 'unknown-device';
          console.warn(`DeviceService: Insteon device ${insteonAddress} reports offline; attempting command anyway`);
        } else if (isDirectRadio) {
          const directIdentity = device?.properties?.homebrainDirect?.ieeeAddr
            || device?.properties?.homebrainDirect?.nodeId
            || 'unknown-direct-device';
          console.warn(`DeviceService: Direct radio device ${directIdentity} reports offline; attempting command anyway`);
        } else if (isMatter) {
          const matterIdentity = device?.properties?.matter?.nodeId
            ? `${device.properties.matter.nodeId}/${device.properties.matter.endpointId || 1}`
            : 'unknown-matter-device';
          console.warn(`DeviceService: Matter device ${matterIdentity} reports offline; attempting command anyway`);
        } else {
          throw new Error('Device is offline and cannot be controlled');
        }
      }

      if (isInsteon) {
        const updatedDevice = await this.controlInsteonDevice(device, normalizedAction, value, options);
        console.log('DeviceService: Successfully controlled device:', updatedDevice?.name || device.name, 'action:', action);
        return updatedDevice;
      }

      if (isRainMachine) {
        const updatedDevice = await this.controlRainMachineDevice(device, normalizedAction, value);
        console.log('DeviceService: Successfully controlled RainMachine device:', updatedDevice?.name || device.name, 'action:', action);
        return updatedDevice;
      }

      const updateData = { lastSeen: new Date() };
      let commandValue = value;
      const supportsBrightnessControl = this.supportsBrightnessControl(device);
      const supportsColorControl = this.supportsColorControl(device);
      const supportsColorTemperatureControl = this.supportsColorTemperatureControl(device);

      switch (normalizedAction) {
        case 'toggle':
          updateData.status = !device.status;
          if (supportsBrightnessControl && updateData.status === false) {
            updateData.brightness = 0;
          }
          commandValue = updateData.status;
          break;

        case 'turnon':
          updateData.status = true;
          if (supportsBrightnessControl && (device.brightness == null || device.brightness === 0)) {
            updateData.brightness = 75; // Default brightness
          }
          commandValue = updateData.status;
          break;

        case 'turnoff':
          updateData.status = false;
          if (supportsBrightnessControl) {
            updateData.brightness = 0;
          }
          commandValue = updateData.status;
          break;

        case 'alarmoff':
        case 'turnoffalarm':
        case 'silencealarm': {
          const directFeatures = Array.isArray(device?.properties?.directRadioFeatures)
            ? device.properties.directRadioFeatures
            : [];
          const supportsAlarmControl = isDirectRadio && (
            device?.properties?.supportsAlarm === true
            || directFeatures.includes('alarm')
            || directFeatures.includes('chime')
            || /\b(siren|alarm|sounder|chime)\b/i.test(`${device.name || ''} ${device.model || ''} ${device.brand || ''}`)
          ) || isMatter && (
            device?.properties?.supportsAlarm === true
            || (Array.isArray(device?.properties?.matterFeatures)
              && device.properties.matterFeatures.some((feature) => ['chime', 'smoke', 'carbonMonoxide'].includes(feature)))
            || /\b(siren|alarm|sounder|chime)\b/i.test(`${device.name || ''} ${device.model || ''} ${device.brand || ''}`)
          );
          if (!supportsAlarmControl) {
            throw new Error('Alarm silence control is only available for alarm-capable HomeBrain-native devices');
          }
          updateData.status = false;
          commandValue = false;
          break;
        }

        case 'setsirenvolume': {
          if (!isDirectRadio || !getDirectRadioService().supportsSirenVolumeControl(device)) {
            throw new Error('Siren volume control is only available for HomeBrain-native sirens that expose a volume setting');
          }
          const volumeCommand = getDirectRadioService().normalizeSirenVolumeCommand(device, value);
          updateData.properties = {
            ...(device?.properties && typeof device.properties === 'object' ? device.properties : {}),
            supportsSirenVolume: true,
            sirenVolume: volumeCommand.value,
            ...(volumeCommand.options.length > 0 ? { sirenVolumeOptions: volumeCommand.options } : {})
          };
          commandValue = volumeCommand.value;
          break;
        }

        case 'setsirensound': {
          if (!isDirectRadio || !getDirectRadioService().supportsSirenSoundControl(device)) {
            throw new Error('Siren sound control is only available for HomeBrain-native sirens that expose a sound setting');
          }
          const soundCommand = getDirectRadioService().normalizeSirenSoundCommand(device, value);
          updateData.properties = {
            ...(device?.properties && typeof device.properties === 'object' ? device.properties : {}),
            supportsSirenSound: true,
            sirenSound: soundCommand.value,
            ...(soundCommand.options.length > 0 ? { sirenSoundOptions: soundCommand.options } : {})
          };
          commandValue = soundCommand.value;
          break;
        }

        case 'setbrightness': {
          if (!supportsBrightnessControl) {
            throw new Error('Brightness control is only available for dimmable lights or switches');
          }
          const numericBrightness = Number(value);
          if (!Number.isFinite(numericBrightness) || numericBrightness < 0 || numericBrightness > 100) {
            throw new Error('Brightness must be between 0 and 100');
          }
          const roundedBrightness = Math.round(numericBrightness);
          updateData.brightness = roundedBrightness;
          updateData.status = roundedBrightness > 0;
          commandValue = roundedBrightness;
          break;
        }

        case 'setcolor': {
          if (!supportsColorControl) {
            throw new Error('Color control is only available for color-capable lights or switches');
          }
          if (!value || typeof value !== 'string') {
            throw new Error('Color value must be a valid hex color string');
          }
          const normalizedColor = this.normalizeHexColor(value);
          if (!normalizedColor) {
            throw new Error('Color value must be a valid hex color string');
          }
          updateData.color = normalizedColor;
          commandValue = normalizedColor;
          break;
        }

        case 'setcolortemperature': {
          if (!supportsColorTemperatureControl) {
            throw new Error('Color temperature control is only available for supported lights or switches');
          }
          const numericKelvin = Number(value);
          if (!Number.isFinite(numericKelvin) || numericKelvin < 1000 || numericKelvin > 10000) {
            throw new Error('Color temperature must be between 1000 and 10000 kelvin');
          }
          updateData.colorTemperature = Math.round(numericKelvin);
          updateData.status = true;
          commandValue = updateData.colorTemperature;
          break;
        }

        case 'settemperature': {
          if (device.type !== 'thermostat') {
            throw new Error('Temperature control is only available for thermostats');
          }
          const numericTemp = Number(value);
          if (!Number.isFinite(numericTemp) || numericTemp < -50 || numericTemp > 150) {
            throw new Error('Temperature must be between -50 and 150');
          }
          updateData.targetTemperature = numericTemp;
          updateData.status = true;
          commandValue = numericTemp;
          break;
        }

        case 'setmode': {
          if (device.type !== 'thermostat') {
            throw new Error('Thermostat mode control is only available for thermostats');
          }
          const normalizedMode = this.normalizeThermostatMode(value);
          if (!normalizedMode) {
            throw new Error('Thermostat mode must be one of auto, cool, heat, or off');
          }
          updateData.status = normalizedMode !== 'off';
          updateData['properties.hvacMode'] = normalizedMode;
          commandValue = normalizedMode;
          break;
        }

        case 'lock':
          if (device.type !== 'lock') {
            throw new Error('Lock control is only available for locks');
          }
          updateData.status = true; // true = locked
          commandValue = 'lock';
          break;

        case 'unlock':
          if (device.type !== 'lock') {
            throw new Error('Unlock control is only available for locks');
          }
          updateData.status = false; // false = unlocked
          commandValue = 'unlock';
          break;

        case 'open':
          if (device.type !== 'garage') {
            throw new Error('Open control is only available for garage doors');
          }
          updateData.status = true; // true = open
          commandValue = 'open';
          break;

        case 'close':
          if (device.type !== 'garage') {
            throw new Error('Close control is only available for garage doors');
          }
          updateData.status = false; // false = closed
          commandValue = 'close';
          break;

        case 'harmonycommand':
          if (!isHarmony) {
            throw new Error('Harmony raw device commands are only available for Harmony-backed devices');
          }
          commandValue = value;
          break;

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      const expectedStatus = Object.prototype.hasOwnProperty.call(updateData, 'status')
        ? !!updateData.status
        : undefined;
      const commandStartedAt = new Date();

      const buildOptimisticPayload = () => {
        const base =
          typeof device.toObject === 'function'
            ? device.toObject({ depopulate: true })
            : { ...device };

        const snapshot = { ...base, ...updateData };

        if (snapshot._id && typeof snapshot._id !== 'string') {
          try {
            snapshot._id = snapshot._id.toString();
          } catch (error) {
            snapshot._id = String(snapshot._id);
          }
        }

        if (!snapshot.id && snapshot._id) {
          snapshot.id = snapshot._id;
        }

        return deviceUpdateEmitter.normalizeDevices([snapshot]);
      };

      let optimisticPayload = null;

      if (isEcobee) {
        await this.controlEcobeeDevice(device, normalizedAction, commandValue, updateData);

        optimisticPayload = buildOptimisticPayload();
        if (optimisticPayload.length > 0) {
          deviceUpdateEmitter.emit('devices:update', optimisticPayload);
        }

        const remoteUpdate = await this.pollEcobeeState(device, expectedStatus);
        if (remoteUpdate) {
          Object.assign(updateData, remoteUpdate);
        }

        if (updateData.isOnline === undefined) {
          updateData.isOnline = true;
        }
      } else if (isSmartThings) {
        await this.controlSmartThingsDevice(device, normalizedAction, commandValue, updateData);

        optimisticPayload = buildOptimisticPayload();
        if (optimisticPayload.length > 0) {
          deviceUpdateEmitter.emit('devices:update', optimisticPayload);
        }

        const remoteUpdate = await this.pollSmartThingsState(device, expectedStatus);
        if (remoteUpdate) {
          Object.assign(updateData, remoteUpdate);
        }

        if (requirePostActionVerification) {
          assertSmartThingsPostActionVerified(device, remoteUpdate, expectedStatus, {
            commandStartedAt,
            maxStateAgeMs: options?.smartThingsVerificationMaxStateAgeMs
          });
        }

        if (updateData.isOnline === undefined) {
          updateData.isOnline = true;
        }
      } else if (isDirectRadio) {
        await getDirectRadioService().controlDevice(device, normalizedAction, commandValue, updateData);

        optimisticPayload = buildOptimisticPayload();
        if (optimisticPayload.length > 0) {
          deviceUpdateEmitter.emit('devices:update', optimisticPayload);
        }

        const remoteUpdate = await getDirectRadioService().refreshDirectDeviceState(device, {
          preserveCommandState: updateData
        });
        if (remoteUpdate) {
          Object.assign(updateData, remoteUpdate);
        }

        if (updateData.isOnline === undefined) {
          updateData.isOnline = true;
        }
      } else if (isMatter) {
        await getMatterService().controlDevice(device, normalizedAction, commandValue, updateData);

        optimisticPayload = buildOptimisticPayload();
        if (optimisticPayload.length > 0) {
          deviceUpdateEmitter.emit('devices:update', optimisticPayload);
        }

        if (!skipPostActionVerification) {
          const remoteUpdate = await getMatterService().refreshMatterDeviceState(device);
          if (remoteUpdate) {
            Object.assign(updateData, remoteUpdate);
          }
        }

        if (updateData.isOnline === undefined) {
          updateData.isOnline = true;
        }
      } else if (isHarmony) {
        await this.controlHarmonyDevice(device, normalizedAction, commandValue, updateData);

        optimisticPayload = buildOptimisticPayload();
        if (optimisticPayload.length > 0) {
          deviceUpdateEmitter.emit('devices:update', optimisticPayload);
        }

        if (!skipPostActionVerification && this.isHarmonyActivityDevice(device)) {
          const verification = await this.waitForHarmonyActivityState(device, expectedStatus, {
            timeoutMs: requirePostActionVerification ? harmonyVerificationTimeoutMs : 0,
            intervalMs: harmonyVerificationIntervalMs
          });
          const remoteUpdate = verification.remoteUpdate;
          if (remoteUpdate) {
            Object.assign(updateData, remoteUpdate);
          }
          if (requirePostActionVerification) {
            if (!remoteUpdate) {
              const error = new Error('Unable to verify Harmony activity state after command');
              error.details = {
                harmonyHubIp: device?.properties?.harmonyHubIp || null,
                harmonyActivityId: device?.properties?.harmonyActivityId || null,
                verificationAttempts: verification.attempts,
                verificationElapsedMs: verification.elapsedMs,
                verificationTimeoutMs: verification.timeoutMs
              };
              throw error;
            }
            if (expectedStatus !== undefined && remoteUpdate.status !== expectedStatus) {
              const error = new Error(
                `Harmony activity verification failed: expected ${expectedStatus ? 'on' : 'off'} but hub reported ${remoteUpdate.status ? 'on' : 'off'}`
              );
              error.details = {
                expectedStatus,
                actualStatus: remoteUpdate.status,
                harmonyHubIp: device?.properties?.harmonyHubIp || null,
                harmonyActivityId: device?.properties?.harmonyActivityId || null,
                verificationAttempts: verification.attempts,
                verificationElapsedMs: verification.elapsedMs,
                verificationTimeoutMs: verification.timeoutMs
              };
              throw error;
            }
          }
        }

        if (updateData.isOnline === undefined) {
          updateData.isOnline = true;
        }
      } else {
        optimisticPayload = buildOptimisticPayload();
        if (optimisticPayload.length > 0) {
          deviceUpdateEmitter.emit('devices:update', optimisticPayload);
        }
      }

      const updatedDevice = await Device.findByIdAndUpdate(
        deviceId,
        updateData,
        { returnDocument: 'after', runValidators: true }
      );

      if (updatedDevice) {
        if (isSmartThings || isDirectRadio || isMatter) {
          try {
            await deviceEnergySampleService.recordSamplesForDevices([updatedDevice]);
          } catch (error) {
            console.warn(`DeviceService: Failed to persist device energy sample after control: ${error.message}`);
          }
        }

        const payload = deviceUpdateEmitter.normalizeDevices([updatedDevice]);
        if (payload.length > 0) {
          deviceUpdateEmitter.emit('devices:update', payload);
        }
      }

      console.log('DeviceService: Successfully controlled device:', updatedDevice.name, 'action:', action);
      return updatedDevice;
    } catch (error) {
      if (coordinatorAdmission?.accepted && !coordinatorAdmission.disabled) {
        try {
          await deviceCommandCoordinatorService.releaseCommand(coordinatorAdmission.command?.commandId, {
            reason: error?.message || 'Device command failed'
          });
        } catch (releaseError) {
          console.warn(`DeviceService: Failed to release command coordinator claim: ${releaseError.message}`);
        }
      }
      const message = error instanceof Error ? error.message : String(error || 'Failed to control device');
      console.error('DeviceService: Error controlling device:', message);
      if (error?.stack) {
        console.error(error.stack);
      }
      if (error?.code || error?.status || error?.details) {
        throw error;
      }
      throw new Error(message || 'Failed to control device');
    }
  }

  normalizeAction(action) {
    if (!action) {
      return '';
    }
    return action.toString().toLowerCase().replace(/[^a-z]/g, '');
  }

  normalizeDeviceControlAction(device, normalizedAction) {
    if (device?.type === 'lock') {
      if (normalizedAction === 'turnon') {
        return 'lock';
      }
      if (normalizedAction === 'turnoff') {
        return 'unlock';
      }
      if (normalizedAction === 'toggle') {
        return device.status ? 'unlock' : 'lock';
      }
    }
    if (device?.type === 'garage') {
      if (normalizedAction === 'turnon') {
        return 'open';
      }
      if (normalizedAction === 'turnoff') {
        return 'close';
      }
      if (normalizedAction === 'toggle') {
        return device.status ? 'close' : 'open';
      }
    }
    return normalizedAction;
  }

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

  getSmartThingsCapabilitySet(device) {
    const capabilities = [
      ...(Array.isArray(device?.properties?.smartThingsCapabilities)
        ? device.properties.smartThingsCapabilities
        : []),
      ...(Array.isArray(device?.properties?.smartthingsCapabilities)
        ? device.properties.smartthingsCapabilities
        : [])
    ]
      .map((entry) => this.normalizeSmartThingsValue(entry))
      .filter((entry) => entry.length > 0);

    return new Set(capabilities);
  }

  getSmartThingsCategorySet(device) {
    const categories = [
      ...(Array.isArray(device?.properties?.smartThingsCategories)
        ? device.properties.smartThingsCategories
        : []),
      ...(Array.isArray(device?.properties?.smartthingsCategories)
        ? device.properties.smartthingsCategories
        : [])
    ]
      .map((entry) => this.normalizeSmartThingsValue(entry))
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.toLowerCase());

    return new Set(categories);
  }

  looksLikeSmartThingsDimmer(device) {
    const descriptor = [
      device?.properties?.smartThingsDeviceTypeName,
      device?.properties?.smartThingsPresentationId,
      device?.name
    ]
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .join(' ')
      .toLowerCase();

    return /\bdimmer\b/.test(descriptor);
  }

  isInsteonDevice(device) {
    const source = (device?.properties?.source || '').toString().trim().toLowerCase();
    return source === 'insteon' || Boolean(device?.properties?.insteonAddress);
  }

  looksLikeInsteonFader(device) {
    const descriptor = [
      device?.properties?.insteonType,
      device?.properties?.productKey,
      device?.model,
      device?.name
    ]
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .join(' ')
      .toLowerCase();
    const category = Number(device?.properties?.deviceCategory);

    if (category === 0x01 || device?.properties?.supportsBrightness === true) {
      return true;
    }

    return /\b(?:dimmer|fader|fan)\b/.test(descriptor);
  }

  hasSmartThingsLevelState(device) {
    const attributeValues = device?.properties?.smartThingsAttributeValues || {};
    const attributeMetadata = device?.properties?.smartThingsAttributeMetadata || {};
    const levelValue = attributeValues?.switchLevel?.level;
    const levelMetadata = attributeMetadata?.switchLevel?.level;

    return levelValue !== undefined && levelValue !== null
      || (levelMetadata && typeof levelMetadata === 'object' && Object.keys(levelMetadata).length > 0);
  }

  supportsBrightnessControl(device) {
    if (!device) {
      return false;
    }

    if (device.type === 'light') {
      return true;
    }

    if (this.isSmartThingsDevice(device)) {
      const capabilities = this.getSmartThingsCapabilitySet(device);
      if (capabilities.has('switchLevel') || capabilities.has('colorControl')) {
        return true;
      }

      if (device.type === 'switch') {
        const categories = this.getSmartThingsCategorySet(device);
        if (categories.has('light') || this.looksLikeSmartThingsDimmer(device)) {
          return true;
        }
      }

      if (this.hasSmartThingsLevelState(device)) {
        return true;
      }
    }

    if (this.isInsteonDevice(device) && this.looksLikeInsteonFader(device)) {
      return true;
    }

    if (this.isDirectRadioDevice(device)) {
      return Boolean(device?.properties?.supportsBrightness)
        || (Array.isArray(device?.properties?.directRadioFeatures)
          && device.properties.directRadioFeatures.includes('brightness'));
    }

    if (this.isMatterDevice(device)) {
      return Boolean(device?.properties?.supportsBrightness)
        || (Array.isArray(device?.properties?.matterFeatures)
          && device.properties.matterFeatures.includes('brightness'));
    }

    return Boolean(device?.properties?.supportsBrightness);
  }

  supportsColorControl(device) {
    if (!device) {
      return false;
    }

    if (this.isSmartThingsDevice(device)) {
      const capabilities = this.getSmartThingsCapabilitySet(device);
      if (capabilities.has('colorControl')) {
        return true;
      }

      return Boolean(device?.properties?.supportsColor && this.supportsBrightnessControl(device));
    }

    if (device.type === 'light') {
      return true;
    }

    if (this.isDirectRadioDevice(device)) {
      return Boolean(device?.properties?.supportsColor)
        || (Array.isArray(device?.properties?.directRadioFeatures)
          && device.properties.directRadioFeatures.includes('color'));
    }

    if (this.isMatterDevice(device)) {
      return Boolean(device?.properties?.supportsColor)
        || (Array.isArray(device?.properties?.matterFeatures)
          && device.properties.matterFeatures.includes('color'));
    }

    return Boolean(device?.properties?.supportsColor);
  }

  supportsColorTemperatureControl(device) {
    if (!device) {
      return false;
    }

    if (typeof device?.colorTemperature === 'number') {
      return true;
    }

    if (device?.properties?.supportsColorTemperature === true) {
      return true;
    }

    if (this.isSmartThingsDevice(device)) {
      const capabilities = this.getSmartThingsCapabilitySet(device);
      return capabilities.has('colorTemperature') || capabilities.has('colortemperature');
    }

    if (this.isDirectRadioDevice(device)) {
      return Boolean(device?.properties?.supportsColorTemperature)
        || (Array.isArray(device?.properties?.directRadioFeatures)
          && device.properties.directRadioFeatures.includes('colorTemperature'));
    }

    if (this.isMatterDevice(device)) {
      return Boolean(device?.properties?.supportsColorTemperature)
        || (Array.isArray(device?.properties?.matterFeatures)
          && device.properties.matterFeatures.includes('colorTemperature'));
    }

    return false;
  }

  normalizeThermostatMode(mode) {
    if (mode === undefined || mode === null) {
      return '';
    }

    const normalized = mode
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[\s_-]/g, '');

    switch (normalized) {
      case 'auto':
        return 'auto';
      case 'cool':
        return 'cool';
      case 'heat':
      case 'auxheatonly':
      case 'emergencyheat':
        return 'heat';
      case 'off':
        return 'off';
      default:
        return '';
    }
  }

  resolveSmartThingsActiveMode(device) {
    const candidates = [
      device?.properties?.smartThingsLastActiveThermostatMode,
      device?.properties?.smartThingsThermostatMode,
      device?.properties?.hvacMode
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeThermostatMode(candidate);
      if (normalized && normalized !== 'off') {
        return normalized;
      }
    }

    return 'auto';
  }

  isSmartThingsDevice(device) {
    const source = canonicalizeDeviceSource(device?.properties?.source || '');
    const protocol = (device?.properties?.homebrainDirect?.protocol || '').toString().trim().toLowerCase();
    if (
      source === 'homebrain-zigbee'
      || source === 'homebrain-zwave'
      || protocol === 'zigbee'
      || protocol === 'zwave'
    ) {
      return false;
    }
    return (source === 'smartthings' || !source)
      && !!device?.properties?.smartThingsDeviceId;
  }

  isDirectRadioDevice(device) {
    const source = canonicalizeDeviceSource(device?.properties?.source || '');
    const protocol = (device?.properties?.homebrainDirect?.protocol || '').toString().trim().toLowerCase();
    return source === 'homebrain-zigbee'
      || source === 'homebrain-zwave'
      || protocol === 'zigbee'
      || protocol === 'zwave';
  }

  isMatterDevice(device) {
    const source = canonicalizeDeviceSource(device?.properties?.source || '');
    return source === 'homebrain-matter'
      || Boolean(device?.properties?.matter?.nodeId);
  }

  isInsteonDevice(device) {
    const source = (device?.properties?.source || '').toString().toLowerCase();
    return source === 'insteon' && !!device?.properties?.insteonAddress;
  }

  isHarmonyDevice(device) {
    const source = (device?.properties?.source || '').toString().toLowerCase();
    return source === 'harmony' && !!device?.properties?.harmonyHubIp;
  }

  isHarmonyActivityDevice(device) {
    if (!this.isHarmonyDevice(device)) {
      return false;
    }

    const entityType = (device?.properties?.harmonyEntityType || '').toString().trim().toLowerCase();
    if (entityType === 'activity') {
      return true;
    }

    return !entityType && !!device?.properties?.harmonyActivityId;
  }

  isHarmonyCommandDevice(device) {
    if (!this.isHarmonyDevice(device)) {
      return false;
    }

    const entityType = (device?.properties?.harmonyEntityType || '').toString().trim().toLowerCase();
    if (entityType === 'device') {
      return true;
    }

    return !entityType && !!device?.properties?.harmonyDeviceId && !device?.properties?.harmonyActivityId;
  }

  isEcobeeDevice(device) {
    const source = (device?.properties?.source || '').toString().toLowerCase();
    return source === 'ecobee' && !!device?.properties?.ecobeeThermostatIdentifier;
  }

  isRainMachineDevice(device) {
    const source = (device?.properties?.source || '').toString().trim().toLowerCase();
    return source === 'rainmachine' && !!device?.properties?.rainmachine?.controllerId;
  }

  isRainMachineControllerDevice(device) {
    if (!this.isRainMachineDevice(device)) {
      return false;
    }

    return (device?.properties?.rainmachine?.entityType || '').toString().trim().toLowerCase() === 'controller';
  }

  isRainMachineZoneDevice(device) {
    if (!this.isRainMachineDevice(device)) {
      return false;
    }

    return (device?.properties?.rainmachine?.entityType || '').toString().trim().toLowerCase() === 'zone';
  }

  normalizeHexColor(color) {
    if (typeof color !== 'string') {
      return null;
    }
    const trimmed = color.trim().replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(trimmed)) {
      return null;
    }
    return `#${trimmed.toLowerCase()}`;
  }

  hexToSmartThingsColor(color) {
    const normalized = this.normalizeHexColor(color);
    if (!normalized) {
      return null;
    }

    const r = parseInt(normalized.slice(1, 3), 16) / 255;
    const g = parseInt(normalized.slice(3, 5), 16) / 255;
    const b = parseInt(normalized.slice(5, 7), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let hue = 0;
    if (delta !== 0) {
      if (max === r) {
        hue = ((g - b) / delta) % 6;
      } else if (max === g) {
        hue = (b - r) / delta + 2;
      } else {
        hue = (r - g) / delta + 4;
      }
      hue *= 60;
      if (hue < 0) {
        hue += 360;
      }
    }

    const saturation = max === 0 ? 0 : delta / max;
    const value = max;

    return {
      hue: Math.round((hue % 360) / 3.6),
      saturation: Math.round(saturation * 100),
      level: Math.round(value * 100)
    };
  }

  parseHarmonyCommandPayload(value) {
    if (typeof value === 'string') {
      return {
        command: value.trim(),
        holdMs: 0
      };
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        command: '',
        holdMs: 0
      };
    }

    const command = (
      value.command ||
      value.name ||
      value.harmonyCommand ||
      value.label ||
      ''
    ).toString().trim();
    const holdMsRaw = Number(
      Object.prototype.hasOwnProperty.call(value, 'holdMs')
        ? value.holdMs
        : (Object.prototype.hasOwnProperty.call(value, 'hold')
          ? value.hold
          : 0)
    );

    return {
      command,
      holdMs: Number.isFinite(holdMsRaw)
        ? Math.max(0, Math.min(MAX_HARMONY_COMMAND_HOLD_MS, Math.round(holdMsRaw)))
        : 0
    };
  }

  async controlInsteonDevice(device, normalizedAction, value, options = {}) {
    const insteonAddress = device?.properties?.insteonAddress;
    if (!insteonAddress) {
      throw new Error('Insteon address is not configured for this device');
    }

    const insteonService = getInsteonService();
    const deviceId = device?._id?.toString ? device._id.toString() : String(device._id);
    const persistedBrightness = Number(device?.brightness);
    const insteonOptions = options?.insteon && typeof options.insteon === 'object'
      ? options.insteon
      : {};
    const fallbackBrightness = Number.isFinite(persistedBrightness) && persistedBrightness > 0
      ? Math.max(0, Math.min(100, Math.round(persistedBrightness)))
      : 100;

    switch (normalizedAction) {
      case 'toggle':
        if (device.status) {
          await insteonService.turnOff(deviceId, insteonOptions);
        } else {
          await insteonService.turnOn(deviceId, fallbackBrightness, insteonOptions);
        }
        break;

      case 'turnon': {
        const requestedBrightness = Number(value);
        const boundedRequestedBrightness = Number.isFinite(requestedBrightness)
          ? Math.max(0, Math.min(100, Math.round(requestedBrightness)))
          : null;
        const brightness = boundedRequestedBrightness && boundedRequestedBrightness > 0
          ? boundedRequestedBrightness
          : 100;
        await insteonService.turnOn(deviceId, brightness, insteonOptions);
        break;
      }

      case 'turnoff':
        await insteonService.turnOff(deviceId, insteonOptions);
        break;

      case 'setbrightness': {
        const numericBrightness = Number(value);
        if (!Number.isFinite(numericBrightness) || numericBrightness < 0 || numericBrightness > 100) {
          throw new Error('Brightness must be between 0 and 100');
        }
        await insteonService.setBrightness(deviceId, Math.round(numericBrightness), insteonOptions);
        break;
      }

      default:
        throw new Error('Insteon devices support only toggle, turn_on, turn_off, and set_brightness actions');
    }

    const refreshedDevice = await Device.findById(device._id);
    if (!refreshedDevice) {
      throw new Error('Device not found');
    }

    return refreshedDevice;
  }

  async refreshHarmonyOnlineStatus(device) {
    const harmonyHubIp = device?.properties?.harmonyHubIp;
    if (!harmonyHubIp) {
      return device.isOnline;
    }

    try {
      await harmonyService.syncActivityStates({ hubIps: [harmonyHubIp], force: true });
      const refreshed = await Device.findById(device._id).lean();
      if (!refreshed) {
        return device.isOnline;
      }

      device.isOnline = refreshed.isOnline;
      device.status = refreshed.status;
      device.lastSeen = refreshed.lastSeen || device.lastSeen;

      return refreshed.isOnline;
    } catch (error) {
      console.warn(`DeviceService: Unable to refresh Harmony hub ${harmonyHubIp} status: ${error.message}`);
      return device.isOnline;
    }
  }

  async controlHarmonyDevice(device, normalizedAction, commandValue, updateData) {
    const harmonyHubIp = device?.properties?.harmonyHubIp;
    if (!harmonyHubIp) {
      throw new Error('Harmony hub is not configured for this device');
    }

    if (this.isHarmonyActivityDevice(device)) {
      const harmonyActivityId = device?.properties?.harmonyActivityId;
      if (!harmonyActivityId) {
        throw new Error('Harmony hub/activity is not configured for this device');
      }

      switch (normalizedAction) {
        case 'toggle':
        case 'turnon':
          if (normalizedAction === 'turnon' || commandValue) {
            await harmonyService.startActivity(harmonyHubIp, harmonyActivityId.toString());
          } else {
            await harmonyService.turnOffHub(harmonyHubIp);
          }
          break;

        case 'turnoff':
          await harmonyService.turnOffHub(harmonyHubIp);
          break;

        default:
          throw new Error('Harmony activity devices support only turn_on, turn_off, and toggle actions');
      }

      updateData.isOnline = true;
      updateData.lastSeen = new Date();
      return;
    }

    if (!this.isHarmonyCommandDevice(device)) {
      throw new Error('Harmony device type is not supported for direct control');
    }

    const harmonyDeviceId = device?.properties?.harmonyDeviceId || device?.properties?.harmonyDeviceLabel;
    if (!harmonyDeviceId) {
      throw new Error('Harmony device command target is not configured for this device');
    }

    let desiredState = null;
    switch (normalizedAction) {
      case 'harmonycommand': {
        const { command, holdMs } = this.parseHarmonyCommandPayload(commandValue);
        if (!command) {
          throw new Error('Harmony command name is required');
        }

        await harmonyService.sendDeviceCommand(
          harmonyHubIp,
          harmonyDeviceId.toString(),
          command,
          holdMs
        );
        break;
      }

      case 'toggle':
        desiredState = commandValue ? 'on' : 'off';
        break;
      case 'turnon':
        desiredState = 'on';
        break;
      case 'turnoff':
        desiredState = 'off';
        break;
      default:
        throw new Error('Harmony direct devices support turn_on, turn_off, toggle, and harmony_command actions');
    }

    if (desiredState) {
      const repeatPowerCommands = Boolean(device?.properties?.harmonyRepeatPowerCommands);
      await harmonyService.sendPowerCommand(harmonyHubIp, harmonyDeviceId.toString(), desiredState, {
        repeatCount: repeatPowerCommands ? 2 : 1,
        allowToggleFallback: normalizedAction === 'toggle'
      });
    }

    updateData.isOnline = true;
    updateData.lastSeen = new Date();
  }

  async pollHarmonyState(device, expectedStatus) {
    const harmonyHubIp = device?.properties?.harmonyHubIp;
    if (!harmonyHubIp || !this.isHarmonyActivityDevice(device)) {
      return null;
    }

    try {
      await harmonyService.syncActivityStates({ hubIps: [harmonyHubIp], force: true });
      const refreshed = await Device.findById(device._id).lean();
      if (!refreshed) {
        return null;
      }

      const updates = {
        status: !!refreshed.status,
        isOnline: refreshed.isOnline !== false
      };
      if (expectedStatus !== undefined && updates.status !== expectedStatus) {
        // Keep returning remote hub state even when it differs from optimistic status.
      }
      if (refreshed.lastSeen) {
        updates.lastSeen = new Date(refreshed.lastSeen);
      }
      return updates;
    } catch (error) {
      console.warn(`DeviceService: Unable to fetch Harmony state for hub ${harmonyHubIp}: ${error.message}`);
      return null;
    }
  }

  async waitForHarmonyActivityState(device, expectedStatus, options = {}) {
    const timeoutMs = parseBoundedMs(
      options.timeoutMs,
      DEFAULT_HARMONY_ACTIVITY_VERIFY_TIMEOUT_MS,
      0,
      MAX_HARMONY_ACTIVITY_VERIFY_TIMEOUT_MS
    );
    const intervalMs = parseBoundedMs(
      options.intervalMs,
      DEFAULT_HARMONY_ACTIVITY_VERIFY_INTERVAL_MS,
      500,
      MAX_HARMONY_ACTIVITY_VERIFY_INTERVAL_MS
    );
    const startedAt = Date.now();
    let attempts = 0;
    let remoteUpdate = null;

    while (true) {
      attempts += 1;
      // eslint-disable-next-line no-await-in-loop
      const nextUpdate = await this.pollHarmonyState(device, expectedStatus);
      if (nextUpdate) {
        remoteUpdate = nextUpdate;
        if (expectedStatus === undefined || nextUpdate.status === expectedStatus) {
          return {
            remoteUpdate,
            attempts,
            elapsedMs: Date.now() - startedAt,
            timeoutMs
          };
        }
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        return {
          remoteUpdate,
          attempts,
          elapsedMs,
          timeoutMs
        };
      }

      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
    }
  }

  async refreshSmartThingsOnlineStatus(device) {
    const smartThingsId = device?.properties?.smartThingsDeviceId;
    if (!smartThingsId) {
      return device.isOnline;
    }

    try {
      const details = await smartThingsService.getDevice(smartThingsId);
      if (!details) {
        return device.isOnline;
      }

      const online = (details.healthState?.state || '').toUpperCase() === 'ONLINE';
      const lastUpdated = details.healthState?.lastUpdatedDate ? new Date(details.healthState.lastUpdatedDate) : new Date();

      const updatePayload = {
        isOnline: online,
        lastSeen: lastUpdated,
        'properties.smartThingsHealthState': details.healthState || null
      };

      if (details.locationId) {
        updatePayload['properties.smartThingsLocationId'] = details.locationId;
      }

      await Device.updateOne({ _id: device._id }, { $set: updatePayload });

      device.isOnline = online;
      device.lastSeen = lastUpdated;
      device.properties = {
        ...(device.properties || {}),
        smartThingsHealthState: details.healthState || null,
        smartThingsLocationId: details.locationId || device.properties?.smartThingsLocationId || null
      };

      return online;
    } catch (error) {
      console.warn(`DeviceService: Unable to refresh SmartThings device ${smartThingsId} status: ${error.message}`);
      return device.isOnline;
    }
  }

  async refreshEcobeeOnlineStatus(device) {
    const thermostatIdentifier = device?.properties?.ecobeeThermostatIdentifier;
    if (!thermostatIdentifier) {
      return device.isOnline;
    }

    try {
      await ecobeeService.runDeviceStatusSync({
        force: true,
        reason: 'refresh-online-status',
        thermostatIdentifiers: [thermostatIdentifier]
      });

      const refreshed = await Device.findById(device._id).lean();
      if (!refreshed) {
        return device.isOnline;
      }

      device.isOnline = refreshed.isOnline;
      device.status = refreshed.status;
      device.lastSeen = refreshed.lastSeen || device.lastSeen;
      device.temperature = refreshed.temperature;
      device.targetTemperature = refreshed.targetTemperature;
      device.properties = {
        ...(refreshed.properties || {})
      };

      return refreshed.isOnline;
    } catch (error) {
      console.warn(`DeviceService: Unable to refresh Ecobee thermostat ${thermostatIdentifier} status: ${error.message}`);
      return device.isOnline;
    }
  }

  resolveEcobeeActiveMode(device) {
    const currentMode = (device?.properties?.ecobeeHvacMode || '').toString().trim();
    if (currentMode && currentMode.toLowerCase() !== 'off') {
      return currentMode;
    }

    const previousMode = (device?.properties?.ecobeeLastActiveHvacMode || '').toString().trim();
    if (previousMode && previousMode.toLowerCase() !== 'off') {
      return previousMode;
    }

    return 'auto';
  }

  async controlEcobeeDevice(device, normalizedAction, commandValue, updateData) {
    const thermostatIdentifier = device?.properties?.ecobeeThermostatIdentifier;
    if (!thermostatIdentifier) {
      throw new Error('Ecobee thermostat identifier is not configured for this device');
    }

    if (device.type !== 'thermostat' || device?.properties?.ecobeeDeviceType === 'sensor') {
      throw new Error('Ecobee sensors are read-only in HomeBrain');
    }

    switch (normalizedAction) {
      case 'toggle': {
        if (commandValue) {
          const mode = this.resolveEcobeeActiveMode(device);
          await ecobeeService.setHvacMode(thermostatIdentifier, mode);
          updateData.status = true;
          updateData['properties.hvacMode'] = mode;
          updateData['properties.ecobeeHvacMode'] = mode;
          updateData['properties.ecobeeLastActiveHvacMode'] = mode;
        } else {
          await ecobeeService.setHvacMode(thermostatIdentifier, 'off');
          updateData.status = false;
          updateData['properties.hvacMode'] = 'off';
          updateData['properties.ecobeeHvacMode'] = 'off';
        }
        break;
      }

      case 'turnon': {
        const mode = this.resolveEcobeeActiveMode(device);
        await ecobeeService.setHvacMode(thermostatIdentifier, mode);
        updateData.status = true;
        updateData['properties.hvacMode'] = mode;
        updateData['properties.ecobeeHvacMode'] = mode;
        updateData['properties.ecobeeLastActiveHvacMode'] = mode;
        break;
      }

      case 'turnoff':
        await ecobeeService.setHvacMode(thermostatIdentifier, 'off');
        updateData.status = false;
        updateData['properties.hvacMode'] = 'off';
        updateData['properties.ecobeeHvacMode'] = 'off';
        break;

      case 'settemperature': {
        const target = Number(commandValue);
        if (!Number.isFinite(target)) {
          throw new Error('Temperature must be between -50 and 150');
        }
        const mode = this.resolveEcobeeActiveMode(device);
        const currentMode = (device?.properties?.ecobeeHvacMode || '').toString().trim().toLowerCase();
        if (currentMode === 'off') {
          await ecobeeService.setHvacMode(thermostatIdentifier, mode);
          updateData['properties.hvacMode'] = mode;
          updateData['properties.ecobeeHvacMode'] = mode;
          updateData['properties.ecobeeLastActiveHvacMode'] = mode;
        }
        await ecobeeService.setTemperatureHold(thermostatIdentifier, target, mode);
        updateData.targetTemperature = target;
        updateData.status = true;
        break;
      }

      case 'setmode': {
        const mode = this.normalizeThermostatMode(commandValue);
        if (!mode) {
          throw new Error('Thermostat mode must be one of auto, cool, heat, or off');
        }
        await ecobeeService.setHvacMode(thermostatIdentifier, mode);
        updateData.status = mode !== 'off';
        updateData['properties.hvacMode'] = mode;
        updateData['properties.ecobeeHvacMode'] = mode;
        if (mode !== 'off') {
          updateData['properties.ecobeeLastActiveHvacMode'] = mode;
        }
        break;
      }

      default:
        throw new Error('Ecobee thermostats support only turn_on, turn_off, toggle, set_temperature, and set_mode actions');
    }

    updateData.isOnline = true;
    updateData.lastSeen = new Date();
  }

  async controlSmartThingsDevice(device, normalizedAction, commandValue, updateData) {
    const smartThingsId = device?.properties?.smartThingsDeviceId;
    if (!smartThingsId) {
      throw new Error('SmartThings device ID is not configured for this device');
    }

    const capabilities = this.getSmartThingsCapabilitySet(device);
    const hasDeclaredCapabilities = capabilities.size > 0;
    const isThermostat = device.type === 'thermostat';
    const thermostatModeCapability = capabilities.has('thermostatMode')
      ? 'thermostatMode'
      : (capabilities.has('thermostat') ? 'thermostat' : '');
    const supportsThermostatMode = thermostatModeCapability.length > 0;

    switch (normalizedAction) {
      case 'toggle':
        if (isThermostat && supportsThermostatMode) {
          const mode = commandValue ? this.resolveSmartThingsActiveMode(device) : 'off';
          await smartThingsService.sendDeviceCommand(smartThingsId, [{
            component: 'main',
            capability: thermostatModeCapability,
            command: 'setThermostatMode',
            arguments: [mode]
          }]);
          updateData.status = mode !== 'off';
          updateData['properties.hvacMode'] = mode;
          updateData['properties.smartThingsThermostatMode'] = mode;
          if (mode !== 'off') {
            updateData['properties.smartThingsLastActiveThermostatMode'] = mode;
          }
        } else if (commandValue) {
          await smartThingsService.turnDeviceOn(smartThingsId);
        } else {
          await smartThingsService.turnDeviceOff(smartThingsId);
        }
        break;

      case 'turnon':
        if (isThermostat && supportsThermostatMode) {
          const mode = this.resolveSmartThingsActiveMode(device);
          await smartThingsService.sendDeviceCommand(smartThingsId, [{
            component: 'main',
            capability: thermostatModeCapability,
            command: 'setThermostatMode',
            arguments: [mode]
          }]);
          updateData.status = true;
          updateData['properties.hvacMode'] = mode;
          updateData['properties.smartThingsThermostatMode'] = mode;
          updateData['properties.smartThingsLastActiveThermostatMode'] = mode;
        } else {
          await smartThingsService.turnDeviceOn(smartThingsId);
        }
        break;

      case 'turnoff':
        if (isThermostat && supportsThermostatMode) {
          await smartThingsService.sendDeviceCommand(smartThingsId, [{
            component: 'main',
            capability: thermostatModeCapability,
            command: 'setThermostatMode',
            arguments: ['off']
          }]);
          updateData.status = false;
          updateData['properties.hvacMode'] = 'off';
          updateData['properties.smartThingsThermostatMode'] = 'off';
        } else {
          await smartThingsService.turnDeviceOff(smartThingsId);
        }
        break;

      case 'setbrightness':
        if (hasDeclaredCapabilities && !(capabilities.has('switchLevel') || this.hasSmartThingsLevelState(device))) {
          throw new Error('Brightness control is not supported for this SmartThings device');
        }
        await smartThingsService.setDeviceLevel(smartThingsId, commandValue);
        break;

      case 'setcolor': {
        if (hasDeclaredCapabilities && !capabilities.has('colorControl')) {
          throw new Error('Color control is not supported for this SmartThings device');
        }
        const colorPayload = this.hexToSmartThingsColor(commandValue);
        if (!colorPayload) {
          throw new Error('Color value must be a valid hex color string');
        }
        await smartThingsService.sendDeviceCommand(smartThingsId, [{
          component: 'main',
          capability: 'colorControl',
          command: 'setColor',
          arguments: [colorPayload]
        }]);
        if (typeof colorPayload.level === 'number' && updateData.brightness === undefined) {
          updateData.brightness = colorPayload.level;
          updateData.status = colorPayload.level > 0;
        }
        break;
      }

      case 'setcolortemperature': {
        if (hasDeclaredCapabilities && !capabilities.has('colortemperature')) {
          throw new Error('Color temperature control is not supported for this SmartThings device');
        }
        const temperature = Math.round(Number(commandValue));
        if (!Number.isFinite(temperature) || temperature < 1000 || temperature > 10000) {
          throw new Error('Color temperature must be between 1000 and 10000 kelvin');
        }
        await smartThingsService.sendDeviceCommand(smartThingsId, [{
          component: 'main',
          capability: 'colorTemperature',
          command: 'setColorTemperature',
          arguments: [temperature]
        }]);
        updateData.colorTemperature = temperature;
        updateData.status = true;
        break;
      }

      case 'settemperature': {
        const target = Number(commandValue);
        if (!Number.isFinite(target)) {
          throw new Error('Temperature must be between -50 and 150');
        }
        const commands = [];
        if (capabilities.has('thermostatHeatingSetpoint')) {
          commands.push({
            component: 'main',
            capability: 'thermostatHeatingSetpoint',
            command: 'setHeatingSetpoint',
            arguments: [target]
          });
        }
        if (capabilities.has('thermostatCoolingSetpoint')) {
          commands.push({
            component: 'main',
            capability: 'thermostatCoolingSetpoint',
            command: 'setCoolingSetpoint',
            arguments: [target]
          });
        }
        if (commands.length === 0) {
          commands.push({
            component: 'main',
            capability: 'thermostatSetpoint',
            command: 'setThermostatSetpoint',
            arguments: [target]
          });
        }
        await smartThingsService.sendDeviceCommand(smartThingsId, commands);
        break;
      }

      case 'setmode': {
        if (!isThermostat || !supportsThermostatMode) {
          throw new Error('Thermostat mode control is not supported for this SmartThings device');
        }

        const mode = this.normalizeThermostatMode(commandValue);
        if (!mode) {
          throw new Error('Thermostat mode must be one of auto, cool, heat, or off');
        }

        await smartThingsService.sendDeviceCommand(smartThingsId, [{
          component: 'main',
          capability: thermostatModeCapability,
          command: 'setThermostatMode',
          arguments: [mode]
        }]);
        updateData.status = mode !== 'off';
        updateData['properties.hvacMode'] = mode;
        updateData['properties.smartThingsThermostatMode'] = mode;
        if (mode !== 'off') {
          updateData['properties.smartThingsLastActiveThermostatMode'] = mode;
        }
        break;
      }

      case 'lock':
        await smartThingsService.sendDeviceCommand(smartThingsId, [{
          component: 'main',
          capability: 'lock',
          command: 'lock'
        }]);
        break;

      case 'unlock':
        await smartThingsService.sendDeviceCommand(smartThingsId, [{
          component: 'main',
          capability: 'lock',
          command: 'unlock'
        }]);
        break;

      case 'open':
      case 'close': {
        const commandName = normalizedAction === 'open' ? 'open' : 'close';
        const commands = [];
        if (capabilities.has('doorControl')) {
          commands.push({
            component: 'main',
            capability: 'doorControl',
            command: commandName
          });
        }
        if (capabilities.has('garageDoorControl')) {
          commands.push({
            component: 'main',
            capability: 'garageDoorControl',
            command: commandName
          });
        }
        if (commands.length === 0) {
          commands.push({
            component: 'main',
            capability: 'doorControl',
            command: commandName
          });
        }
        await smartThingsService.sendDeviceCommand(smartThingsId, commands);
        break;
      }

      default:
        await smartThingsService.sendDeviceCommand(smartThingsId, [{
          component: 'main',
          capability: 'switch',
          command: commandValue ? 'on' : 'off'
        }]);
        break;
    }
  }

  async pollSmartThingsState(device, expectedStatus) {
    const smartThingsId = device?.properties?.smartThingsDeviceId;
    if (!smartThingsId) {
      return null;
    }

    let lastUpdates = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [details, status] = await Promise.all([
          smartThingsService.getDevice(smartThingsId),
          smartThingsService.getDeviceStatus(smartThingsId)
        ]);

        if (!status || !status.components) {
          throw new Error('SmartThings status payload missing components');
        }

        const combined = {
          ...(details || {}),
          deviceId: details?.deviceId || smartThingsId,
          status
        };

        let updates = await smartThingsService.buildSmartThingsDeviceUpdate(device, combined);
        if (!updates) {
          updates = {};
        }

        const healthState = details?.healthState?.state || '';
        const isOnline = healthState.toUpperCase() !== 'OFFLINE';
        const lastSeen = details?.healthState?.lastUpdatedDate
          ? new Date(details.healthState.lastUpdatedDate)
          : new Date();

        if (updates.isOnline === undefined && device.isOnline !== isOnline) {
          updates.isOnline = isOnline;
        }
        updates.lastSeen = lastSeen;
        updates['properties.smartThingsHealthState'] = details?.healthState || null;
        if (details?.locationId) {
          updates['properties.smartThingsLocationId'] = details.locationId;
        }

        if (Object.keys(updates).length > 0) {
          lastUpdates = updates;

          if (
            expectedStatus === undefined ||
            updates.status === undefined ||
            updates.status === expectedStatus
          ) {
            return updates;
          }
        }
      } catch (error) {
        console.warn(`DeviceService: Unable to fetch SmartThings state for ${smartThingsId} (attempt ${attempt + 1}): ${error.message}`);
      }

      const delayMs = Math.min(500 * (attempt + 1), 1500);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return lastUpdates;
  }

  async pollEcobeeState(device, expectedStatus) {
    const thermostatIdentifier = device?.properties?.ecobeeThermostatIdentifier;
    if (!thermostatIdentifier) {
      return null;
    }

    try {
      await ecobeeService.runDeviceStatusSync({
        force: true,
        reason: 'post-command-poll',
        thermostatIdentifiers: [thermostatIdentifier]
      });

      const refreshed = await Device.findById(device._id).lean();
      if (!refreshed) {
        return null;
      }

      const updates = {
        status: !!refreshed.status,
        isOnline: refreshed.isOnline !== false,
        temperature: refreshed.temperature,
        targetTemperature: refreshed.targetTemperature,
        properties: refreshed.properties || {}
      };

      if (expectedStatus !== undefined && updates.status !== expectedStatus) {
        // Preserve remote Ecobee state even when it differs from optimistic command state.
      }

      if (refreshed.lastSeen) {
        updates.lastSeen = new Date(refreshed.lastSeen);
      }

      return updates;
    } catch (error) {
      console.warn(`DeviceService: Unable to fetch Ecobee state for ${thermostatIdentifier}: ${error.message}`);
      return null;
    }
  }

  async controlRainMachineDevice(device, normalizedAction, commandValue) {
    const rainMachine = device?.properties?.rainmachine || {};

    if (this.isRainMachineControllerDevice(device)) {
      switch (normalizedAction) {
        case 'turnoff':
        case 'stopall':
          await rainMachineService.stopAll();
          break;
        default:
          throw new Error('RainMachine controller supports stop_all and turn_off actions');
      }

      const refreshedController = await Device.findById(device._id);
      if (!refreshedController) {
        throw new Error('Device not found');
      }

      return refreshedController;
    }

    if (!this.isRainMachineZoneDevice(device)) {
      throw new Error('Unsupported RainMachine entity type');
    }

    const zoneId = rainMachine.zoneId;
    if (zoneId === undefined || zoneId === null) {
      throw new Error('RainMachine zone ID is not configured for this device');
    }

    const defaultDuration = Number(rainMachine.nextRunDurationSeconds || rainMachine.userDurationSeconds || 0);
    const parsedDuration = Number(
      typeof commandValue === 'object' && commandValue
        ? (commandValue.durationSeconds ?? commandValue.seconds ?? commandValue.duration)
        : commandValue
    );
    const durationSeconds = Number.isFinite(parsedDuration) && parsedDuration > 0
      ? Math.max(60, Math.min(6 * 60 * 60, Math.round(parsedDuration)))
      : (Number.isFinite(defaultDuration) && defaultDuration > 0 ? defaultDuration : undefined);

    switch (normalizedAction) {
      case 'toggle':
        if (device.status) {
          await rainMachineService.stopZone(zoneId);
        } else {
          await rainMachineService.startZone(zoneId, durationSeconds);
        }
        break;
      case 'turnon':
      case 'rainmachinestartzone':
        await rainMachineService.startZone(zoneId, durationSeconds);
        break;
      case 'turnoff':
        await rainMachineService.stopZone(zoneId);
        break;
      default:
        throw new Error('RainMachine zones support turn_on, turn_off, toggle, and rainmachine_start_zone actions');
    }

    const refreshedZone = await Device.findById(device._id);
    if (!refreshedZone) {
      throw new Error('Device not found');
    }

    return refreshedZone;
  }

  /**
   * Get devices grouped by room
   * @returns {Promise<Array>} Array of rooms with their devices
   */
  async getDevicesByRoom() {
    try {
      console.log('DeviceService: Fetching devices grouped by room');

      this.scheduleIntegrationRefresh({ reason: 'getDevicesByRoom' });

      const devices = await Device.find(buildVisibleDeviceQuery()).sort({ room: 1, name: 1 });
      
      // Group devices by room
      const roomMap = {};
      devices.forEach(device => {
        if (!roomMap[device.room]) {
          roomMap[device.room] = [];
        }
        roomMap[device.room].push(device);
      });
      
      // Convert to array format
      const rooms = Object.keys(roomMap).map(roomName => ({
        name: roomName,
        devices: roomMap[roomName]
      }));
      
      console.log(`DeviceService: Found ${rooms.length} rooms with devices`);
      return rooms;
    } catch (error) {
      console.error('DeviceService: Error fetching devices by room:', error.message);
      console.error(error.stack);
      throw new Error('Failed to fetch devices by room');
    }
  }

  /**
   * Get device statistics
   * @returns {Promise<Object>} Device statistics
   */
  async getDeviceStats() {
    try {
      console.log('DeviceService: Fetching device statistics');

      this.scheduleIntegrationRefresh({ reason: 'getDeviceStats' });

      const visibleDeviceQuery = buildVisibleDeviceQuery();
      const totalDevices = await Device.countDocuments(visibleDeviceQuery);
      const onlineDevices = await Device.countDocuments(buildVisibleDeviceQuery({ isOnline: true }));
      const activeDevices = await Device.countDocuments(buildVisibleDeviceQuery({ status: true }));
      
      const devicesByType = await Device.aggregate([
        { $match: visibleDeviceQuery },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);
      
      const devicesByRoom = await Device.aggregate([
        { $match: visibleDeviceQuery },
        { $group: { _id: '$room', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);
      
      const stats = {
        total: totalDevices,
        online: onlineDevices,
        offline: totalDevices - onlineDevices,
        active: activeDevices,
        inactive: totalDevices - activeDevices,
        byType: devicesByType,
        byRoom: devicesByRoom
      };
      
      console.log('DeviceService: Successfully generated device statistics');
      return stats;
    } catch (error) {
      console.error('DeviceService: Error fetching device statistics:', error.message);
      console.error(error.stack);
      throw new Error('Failed to fetch device statistics');
    }
  }

  async ensureIntegrationState({ immediate = false } = {}) {
    await Promise.all([
      this.ensureSmartThingsState({ immediate }),
      this.ensureHarmonyState({ immediate }),
      this.ensureEcobeeState({ immediate }),
      this.ensureRainMachineState({ immediate })
    ]);
  }

  scheduleIntegrationRefresh({ immediate = false, reason = 'background' } = {}) {
    if (this.integrationRefreshPromise) {
      return this.integrationRefreshPromise;
    }

    const now = Date.now();
    if (!immediate && now - this.lastIntegrationRefreshScheduledAt < this.integrationRefreshDebounceMs) {
      return Promise.resolve(null);
    }

    this.lastIntegrationRefreshScheduledAt = now;
    this.integrationRefreshPromise = Promise.resolve()
      .then(() => this.ensureIntegrationState({ immediate }))
      .catch((error) => {
        console.warn(`DeviceService: Background integration refresh failed (${reason}): ${error.message}`);
      })
      .finally(() => {
        this.integrationRefreshPromise = null;
      });

    return this.integrationRefreshPromise;
  }

  async ensureHarmonyState({ immediate = false } = {}) {
    const hasHarmony = await this.detectHarmonyPresence();
    if (!hasHarmony) {
      return;
    }

    const now = Date.now();

    if (this.harmonySyncPromise) {
      try {
        await this.harmonySyncPromise;
      } catch (error) {
        console.warn('DeviceService: Harmony state refresh in progress failed:', error.message);
      }
      if (!immediate && now - this.lastHarmonySyncAt < this.harmonySyncCooldownMs) {
        return;
      }
    } else if (!immediate && now - this.lastHarmonySyncAt < this.harmonySyncCooldownMs) {
      return;
    }

    this.harmonySyncPromise = (async () => {
      let succeeded = false;
      try {
        await harmonyService.syncActivityStates({ force: immediate });
        succeeded = true;
      } catch (error) {
        console.warn('DeviceService: Harmony state refresh failed:', error.message);
        throw error;
      } finally {
        if (succeeded) {
          this.lastHarmonySyncAt = Date.now();
        }
        this.harmonySyncPromise = null;
      }
    })();

    try {
      await this.harmonySyncPromise;
    } catch (error) {
      // already logged above
    }
  }

  async ensureSmartThingsState({ immediate = false } = {}) {
    const hasSmartThings = await this.detectSmartThingsPresence();
    if (!hasSmartThings) {
      return;
    }

    let integrationSnapshot = null;
    try {
      integrationSnapshot = await SmartThingsIntegration.getIntegration();
    } catch (error) {
      console.warn('DeviceService: Unable to load SmartThings integration while preparing device refresh:', error.message);
    }

    if (!immediate && smartThingsService.shouldSkipDevicePolling({ integration: integrationSnapshot, reason: 'api-fetch' })) {
      return;
    }

    const now = Date.now();

    if (this.smartThingsSyncPromise) {
      try {
        await this.smartThingsSyncPromise;
      } catch (error) {
        console.warn('DeviceService: SmartThings state refresh in progress failed:', error.message);
      }
      if (!immediate && now - this.lastSmartThingsSyncAt < this.smartThingsSyncCooldownMs) {
        return;
      }
    } else if (!immediate && now - this.lastSmartThingsSyncAt < this.smartThingsSyncCooldownMs) {
      return;
    }

    this.smartThingsSyncPromise = (async () => {
      let succeeded = false;
      try {
        await smartThingsService.runDeviceStatusSync({
          integration: integrationSnapshot,
          reason: immediate ? 'api-fetch-force' : 'api-fetch',
          force: immediate
        });
        succeeded = true;
      } catch (error) {
        console.warn('DeviceService: SmartThings state refresh failed:', error.message);
        throw error;
      } finally {
        if (succeeded) {
          this.lastSmartThingsSyncAt = Date.now();
        }
        this.smartThingsSyncPromise = null;
      }
    })();

    try {
      await this.smartThingsSyncPromise;
    } catch (error) {
      // already logged above
    }
  }

  async ensureEcobeeState({ immediate = false } = {}) {
    const hasEcobee = await this.detectEcobeePresence();
    if (!hasEcobee) {
      return;
    }

    const now = Date.now();

    if (this.ecobeeSyncPromise) {
      try {
        await this.ecobeeSyncPromise;
      } catch (error) {
        console.warn('DeviceService: Ecobee state refresh in progress failed:', error.message);
      }
      if (!immediate && now - this.lastEcobeeSyncAt < this.ecobeeSyncCooldownMs) {
        return;
      }
    } else if (!immediate && now - this.lastEcobeeSyncAt < this.ecobeeSyncCooldownMs) {
      return;
    }

    this.ecobeeSyncPromise = (async () => {
      let succeeded = false;
      try {
        await ecobeeService.runDeviceStatusSync({
          force: immediate,
          reason: immediate ? 'api-fetch-force' : 'api-fetch'
        });
        succeeded = true;
      } catch (error) {
        console.warn('DeviceService: Ecobee state refresh failed:', error.message);
        throw error;
      } finally {
        if (succeeded) {
          this.lastEcobeeSyncAt = Date.now();
        }
        this.ecobeeSyncPromise = null;
      }
    })();

    try {
      await this.ecobeeSyncPromise;
    } catch (error) {
      // already logged above
    }
  }

  async ensureRainMachineState({ immediate = false } = {}) {
    const hasRainMachine = await this.detectRainMachinePresence();
    if (!hasRainMachine) {
      return;
    }

    const now = Date.now();

    if (this.rainMachineSyncPromise) {
      try {
        await this.rainMachineSyncPromise;
      } catch (error) {
        console.warn('DeviceService: RainMachine state refresh in progress failed:', error.message);
      }
      if (!immediate && now - this.lastRainMachineSyncAt < this.rainMachineSyncCooldownMs) {
        return;
      }
    } else if (!immediate && now - this.lastRainMachineSyncAt < this.rainMachineSyncCooldownMs) {
      return;
    }

    this.rainMachineSyncPromise = (async () => {
      let succeeded = false;
      try {
        await rainMachineService.refreshRuntime({
          reason: immediate ? 'api-fetch-force' : 'api-fetch'
        });
        succeeded = true;
      } catch (error) {
        console.warn('DeviceService: RainMachine state refresh failed:', error.message);
        throw error;
      } finally {
        if (succeeded) {
          this.lastRainMachineSyncAt = Date.now();
        }
        this.rainMachineSyncPromise = null;
      }
    })();

    try {
      await this.rainMachineSyncPromise;
    } catch (error) {
      // already logged above
    }
  }

  async detectSmartThingsPresence() {
    const now = Date.now();
    if (this.smartThingsPresence !== null && (now - this.smartThingsPresenceCheckedAt) < 60000) {
      return this.smartThingsPresence;
    }

    if (!isDatabaseReadyForPresenceChecks()) {
      this.smartThingsPresence = null;
      this.smartThingsPresenceCheckedAt = 0;
      return false;
    }

    try {
      this.smartThingsPresence = await Device.exists({
        'properties.source': 'smartthings',
        'properties.smartThingsDeviceId': { $exists: true }
      });
    } catch (error) {
      console.warn('DeviceService: Failed to detect SmartThings devices:', error.message);
      this.smartThingsPresence = false;
    } finally {
      this.smartThingsPresenceCheckedAt = now;
    }

    return this.smartThingsPresence;
  }

  async detectHarmonyPresence() {
    const now = Date.now();
    if (this.harmonyPresence !== null && (now - this.harmonyPresenceCheckedAt) < 60000) {
      return this.harmonyPresence;
    }

    if (!isDatabaseReadyForPresenceChecks()) {
      this.harmonyPresence = null;
      this.harmonyPresenceCheckedAt = 0;
      return false;
    }

    try {
      this.harmonyPresence = await Device.exists({
        'properties.source': 'harmony',
        'properties.harmonyHubIp': { $exists: true }
      });
    } catch (error) {
      console.warn('DeviceService: Failed to detect Harmony devices:', error.message);
      this.harmonyPresence = false;
    } finally {
      this.harmonyPresenceCheckedAt = now;
    }

    return this.harmonyPresence;
  }

  async detectEcobeePresence() {
    const now = Date.now();
    if (this.ecobeePresence !== null && (now - this.ecobeePresenceCheckedAt) < 60000) {
      return this.ecobeePresence;
    }

    if (!isDatabaseReadyForPresenceChecks()) {
      this.ecobeePresence = null;
      this.ecobeePresenceCheckedAt = 0;
      return false;
    }

    try {
      this.ecobeePresence = await Device.exists({
        'properties.source': 'ecobee',
        'properties.ecobeeThermostatIdentifier': { $exists: true }
      });
    } catch (error) {
      console.warn('DeviceService: Failed to detect Ecobee devices:', error.message);
      this.ecobeePresence = false;
    } finally {
      this.ecobeePresenceCheckedAt = now;
    }

    return this.ecobeePresence;
  }

  async detectRainMachinePresence() {
    const now = Date.now();
    if (this.rainMachinePresence !== null && (now - this.rainMachinePresenceCheckedAt) < 60000) {
      return this.rainMachinePresence;
    }

    if (!isDatabaseReadyForPresenceChecks()) {
      this.rainMachinePresence = null;
      this.rainMachinePresenceCheckedAt = 0;
      return false;
    }

    try {
      const [devicePresence, integration] = await Promise.all([
        Device.exists({
          'properties.source': 'rainmachine',
          'properties.rainmachine.controllerId': { $exists: true }
        }),
        RainMachineIntegration.getIntegration()
      ]);

      this.rainMachinePresence = Boolean(devicePresence)
        || (integration?.enabled === true && typeof integration?.host === 'string' && integration.host.trim().length > 0);
    } catch (error) {
      console.warn('DeviceService: Failed to detect RainMachine devices:', error.message);
      this.rainMachinePresence = false;
    } finally {
      this.rainMachinePresenceCheckedAt = now;
    }

    return this.rainMachinePresence;
  }
}

module.exports = new DeviceService();

const SecurityAlarm = require('../models/SecurityAlarm');
const Device = require('../models/Device');
const smartThingsService = require('./smartThingsService');
const deviceService = require('./deviceService');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const Settings = require('../models/Settings');

const STATUS_STALE_THRESHOLD_MS = Number(process.env.SECURITY_ALARM_STATUS_STALE_MS || 60000);
const ONLINE_GRACE_PERIOD_MS = Number(process.env.SECURITY_ALARM_ONLINE_GRACE_MS || 120000);
const LOW_BATTERY_THRESHOLD = Number(process.env.SECURITY_SENSOR_LOW_BATTERY_PERCENT || 20);
const CRITICAL_BATTERY_THRESHOLD = Number(process.env.SECURITY_SENSOR_CRITICAL_BATTERY_PERCENT || 5);

const SECURITY_CAPABILITIES = new Set([
  'contactSensor',
  'motionSensor',
  'waterSensor',
  'smokeDetector',
  'carbonMonoxideDetector',
  'tamperAlert',
  'accelerationSensor',
  'shockSensor',
  'alarm'
]);

const SENSOR_TYPE_LABELS = {
  doorWindow: 'Door / Window',
  motion: 'Motion',
  glass: 'Glass',
  smoke: 'Smoke',
  co: 'CO',
  flood: 'Flood',
  panic: 'Panic',
  security: 'Security'
};

const SECURITY_KEYWORD_PATTERNS = [
  { pattern: /\b(door|window|contact)\b/i, sensorType: 'doorWindow' },
  { pattern: /\bmotion\b/i, sensorType: 'motion' },
  { pattern: /\b(glass|tamper|shock)\b/i, sensorType: 'glass' },
  { pattern: /\b(smoke|fire)\b/i, sensorType: 'smoke' },
  { pattern: /\b(co|carbon monoxide|monoxide)\b/i, sensorType: 'co' },
  { pattern: /\b(flood|leak|water)\b/i, sensorType: 'flood' },
  { pattern: /\b(panic|alarm|security)\b/i, sensorType: 'panic' }
];

const BATTERY_PROPERTY_KEYS = [
  'smartThingsBatteryLevel',
  'batteryLevel',
  'battery',
  'batteryPercent',
  'batteryPercentage'
];

const normalizeString = (value) => {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
};

const toNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const uniqueStrings = (values) => Array.from(new Set(values.filter(Boolean)));

const getDeviceLookupKeys = (device) => uniqueStrings([
  normalizeString(device?._id?.toString?.() || device?._id),
  normalizeString(device?.id),
  normalizeString(device?.properties?.smartThingsDeviceId),
  normalizeString(device?.properties?.insteonAddress),
  normalizeString(device?.properties?.ecobeeSensorId),
  normalizeString(device?.properties?.ecobeeSensorKey)
]);

const getDeviceCapabilities = (device) => uniqueStrings([
  ...(Array.isArray(device?.properties?.smartThingsCapabilities) ? device.properties.smartThingsCapabilities : []),
  ...(Array.isArray(device?.properties?.smartthingsCapabilities) ? device.properties.smartthingsCapabilities : [])
].map((value) => normalizeString(value)));

const extractBatteryLevel = (device) => {
  if (!device || typeof device !== 'object') {
    return null;
  }

  const directBattery = toNumber(device?.batteryLevel);
  if (directBattery !== null) {
    return Math.max(0, Math.min(100, Math.round(directBattery)));
  }

  for (const key of BATTERY_PROPERTY_KEYS) {
    const candidate = toNumber(device?.properties?.[key]);
    if (candidate !== null) {
      return Math.max(0, Math.min(100, Math.round(candidate)));
    }
  }

  return null;
};

const getBatteryState = (batteryLevel) => {
  if (batteryLevel === null || batteryLevel === undefined) {
    return 'unknown';
  }
  if (batteryLevel <= CRITICAL_BATTERY_THRESHOLD) {
    return 'critical';
  }
  if (batteryLevel <= LOW_BATTERY_THRESHOLD) {
    return 'low';
  }
  return 'ok';
};

const inferSensorTypeFromKeywords = (device, zone) => {
  const haystack = [
    zone?.name,
    device?.name,
    device?.model,
    device?.brand,
    device?.properties?.smartThingsDeviceTypeName,
    device?.properties?.smartThingsPresentationId
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join(' ');

  for (const candidate of SECURITY_KEYWORD_PATTERNS) {
    if (candidate.pattern.test(haystack)) {
      return candidate.sensorType;
    }
  }

  return 'security';
};

const inferSensorType = (device, zone) => {
  const zoneType = normalizeString(zone?.deviceType);
  if (zoneType && SENSOR_TYPE_LABELS[zoneType]) {
    return zoneType;
  }

  const capabilities = getDeviceCapabilities(device);
  if (capabilities.includes('contactSensor')) {
    return 'doorWindow';
  }
  if (capabilities.includes('motionSensor')) {
    return 'motion';
  }
  if (capabilities.includes('waterSensor')) {
    return 'flood';
  }
  if (capabilities.includes('smokeDetector')) {
    return 'smoke';
  }
  if (capabilities.includes('carbonMonoxideDetector')) {
    return 'co';
  }
  if (capabilities.includes('tamperAlert') || capabilities.includes('accelerationSensor') || capabilities.includes('shockSensor')) {
    return inferSensorTypeFromKeywords(device, zone) === 'panic' ? 'panic' : 'glass';
  }
  if (capabilities.includes('alarm')) {
    return 'panic';
  }

  return inferSensorTypeFromKeywords(device, zone);
};

const inferStateLabel = (sensorType, isActive, isAvailable) => {
  if (!isAvailable) {
    return 'Unavailable';
  }

  switch (sensorType) {
    case 'doorWindow':
      return isActive ? 'Open' : 'Closed';
    case 'motion':
      return isActive ? 'Motion' : 'Clear';
    case 'flood':
      return isActive ? 'Wet' : 'Dry';
    case 'glass':
      return isActive ? 'Alert' : 'Clear';
    case 'smoke':
    case 'co':
    case 'panic':
    case 'security':
    default:
      return isActive ? 'Alert' : 'Normal';
  }
};

const looksLikeSecuritySensor = (device) => {
  if (!device || typeof device !== 'object') {
    return false;
  }

  const capabilities = getDeviceCapabilities(device);
  if (capabilities.some((capability) => SECURITY_CAPABILITIES.has(capability))) {
    return true;
  }

  if (normalizeString(device?.type).toLowerCase() !== 'sensor') {
    return false;
  }

  return inferSensorTypeFromKeywords(device, null) !== 'security'
    || /security/i.test(normalizeString(device?.properties?.smartThingsDeviceTypeName));
};

class SecurityAlarmService {
  constructor() {
    this.smartthingsBaseUrl = 'https://api.smartthings.com/v1';
  }

  buildSecuritySensorSummary({ device, zone }) {
    const localDeviceId = normalizeString(device?._id?.toString?.() || device?._id || device?.id);
    const resolvedDeviceId = localDeviceId || normalizeString(zone?.deviceId);
    const sensorType = inferSensorType(device, zone);
    const batteryLevel = extractBatteryLevel(device);
    const batteryState = getBatteryState(batteryLevel);
    const isAvailable = Boolean(device);
    const isOnline = isAvailable ? device.isOnline !== false : false;
    const isMonitored = Boolean(zone?.enabled);
    const isBypassed = Boolean(zone?.bypassed);
    const isActive = isAvailable ? Boolean(device?.status) : false;
    const requiresAttention = !isAvailable || !isOnline || batteryState === 'low' || batteryState === 'critical';

    let monitorState = 'Available';
    if (!isAvailable && zone) {
      monitorState = 'Missing';
    } else if (zone?.enabled && zone?.bypassed) {
      monitorState = 'Bypassed';
    } else if (zone?.enabled) {
      monitorState = 'Monitored';
    } else if (zone) {
      monitorState = 'Disabled';
    }

    const attentionFlags = [];
    if (!isAvailable) {
      attentionFlags.push('missing');
    }
    if (isAvailable && !isOnline) {
      attentionFlags.push('offline');
    }
    if (batteryState === 'critical') {
      attentionFlags.push('battery_critical');
    } else if (batteryState === 'low') {
      attentionFlags.push('battery_low');
    }

    return {
      deviceId: resolvedDeviceId,
      localDeviceId: localDeviceId || null,
      zoneDeviceId: normalizeString(zone?.deviceId) || null,
      name: normalizeString(zone?.name) || normalizeString(device?.name) || 'Unnamed security sensor',
      room: normalizeString(device?.room) || null,
      sensorType,
      sensorTypeLabel: SENSOR_TYPE_LABELS[sensorType] || SENSOR_TYPE_LABELS.security,
      stateLabel: inferStateLabel(sensorType, isActive, isAvailable),
      isActive,
      isAvailable,
      isOnline,
      isMonitored,
      isBypassed,
      monitorState,
      batteryLevel,
      batteryState,
      lastSeen: device?.lastSeen || null,
      attentionFlags,
      requiresAttention
    };
  }

  buildDoorLockSummary(device) {
    const localDeviceId = normalizeString(device?._id?.toString?.() || device?._id || device?.id);
    const isLocked = Boolean(device?.status);
    const isOnline = device?.isOnline !== false;

    return {
      deviceId: localDeviceId,
      localDeviceId: localDeviceId || null,
      name: normalizeString(device?.name) || 'Unnamed door lock',
      room: normalizeString(device?.room) || null,
      isLocked,
      isOnline,
      stateLabel: isLocked ? 'Locked' : 'Unlocked',
      lastSeen: device?.lastSeen || null
    };
  }

  getSecuritySensors(alarm, devices = []) {
    const deviceMap = new Map();

    devices.forEach((device) => {
      getDeviceLookupKeys(device).forEach((key) => {
        if (key) {
          deviceMap.set(key, device);
        }
      });
    });

    const securitySensors = [];
    const seenDeviceIds = new Set();
    const zones = Array.isArray(alarm?.zones) ? alarm.zones : [];

    zones.forEach((zone) => {
      const zoneDeviceId = normalizeString(zone?.deviceId);
      const matchedDevice = zoneDeviceId ? (deviceMap.get(zoneDeviceId) || null) : null;
      const summary = this.buildSecuritySensorSummary({ device: matchedDevice, zone });
      securitySensors.push(summary);
      if (summary.localDeviceId) {
        seenDeviceIds.add(summary.localDeviceId);
      }
    });

    devices.forEach((device) => {
      const localDeviceId = normalizeString(device?._id?.toString?.() || device?._id || device?.id);
      if (!localDeviceId || seenDeviceIds.has(localDeviceId) || !looksLikeSecuritySensor(device)) {
        return;
      }

      securitySensors.push(this.buildSecuritySensorSummary({ device, zone: null }));
      seenDeviceIds.add(localDeviceId);
    });

    securitySensors.sort((left, right) => {
      if (left.requiresAttention !== right.requiresAttention) {
        return left.requiresAttention ? -1 : 1;
      }
      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }
      if (left.isMonitored !== right.isMonitored) {
        return left.isMonitored ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });

    return securitySensors;
  }

  getDoorLocks(devices = []) {
    const doorLocks = devices
      .filter((device) => normalizeString(device?.type).toLowerCase() === 'lock')
      .map((device) => this.buildDoorLockSummary(device));

    doorLocks.sort((left, right) => {
      if (left.isLocked !== right.isLocked) {
        return left.isLocked ? 1 : -1;
      }
      if (left.isOnline !== right.isOnline) {
        return left.isOnline ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });

    return doorLocks;
  }

  /**
   * Check if SmartThings STHM is properly configured for security operations
   * @returns {Promise<boolean>} True if STHM is configured and connected
   */
  async isSmartThingsConfiguredForSthm() {
    try {
      const integration = await SmartThingsIntegration.getIntegration();
      const settings = await Settings.getSettings();
      const hasSthmMapping = Boolean(
        integration?.sthm?.disarmDeviceId &&
        integration?.sthm?.armStayDeviceId &&
        integration?.sthm?.armAwayDeviceId
      );

      if (!hasSthmMapping) {
        return false;
      }

      const useOAuth = settings?.smartthingsUseOAuth !== false;
      if (!useOAuth) {
        const hasPatToken = Boolean(settings?.smartthingsToken && settings.smartthingsToken.trim());
        return hasPatToken;
      }

      const hasOAuthAccess = Boolean(
        integration?.isConfigured &&
        (
          integration?.isConnected ||
          integration?.accessToken ||
          integration?.refreshToken
        )
      );

      return hasOAuthAccess;
    } catch (error) {
      console.error('SecurityAlarmService: Error checking SmartThings configuration:', error.message);
      return false;
    }
  }

  /**
   * Get the main alarm system
   * @returns {Promise<Object>} Alarm system data
   */
  async getAlarmSystem() {
    try {
      console.log('SecurityAlarmService: Getting alarm system');
      const alarm = await SecurityAlarm.getMainAlarm();
      console.log('SecurityAlarmService: Successfully retrieved alarm system');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error getting alarm system:', error.message);
      throw new Error('Failed to get alarm system');
    }
  }

  /**
   * Arm the security system
   * @param {string} mode - 'stay' or 'away'
   * @param {string} userId - User ID who is arming the system
   * @returns {Promise<Object>} Updated alarm system
   */
  async armAlarm(mode, userId) {
    try {
      console.log(`SecurityAlarmService: Arming alarm in ${mode} mode`);

      const alarm = await SecurityAlarm.getMainAlarm();

      // Check if already armed
      if (alarm.alarmState === 'armedStay' || alarm.alarmState === 'armedAway') {
        throw new Error('Alarm is already armed');
      }

      // Send command to SmartThings if properly configured
      const isSthmConfigured = await this.isSmartThingsConfiguredForSthm();
      if (isSthmConfigured) {
        try {
          const targetState = mode === 'stay' ? 'ArmedStay' : 'ArmedAway';
          await smartThingsService.setSecurityArmState(targetState);
          console.log('SecurityAlarmService: SmartThings command sent successfully');
        } catch (smartThingsError) {
          console.warn('SecurityAlarmService: SmartThings command failed, continuing with local arming:', smartThingsError.message);
          // Continue with local arming even if SmartThings fails
        }
      }

      // Update local alarm state
      await alarm.arm(mode, userId);

      console.log(`SecurityAlarmService: Successfully armed alarm in ${mode} mode`);
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error arming alarm:', error.message);
      throw error;
    }
  }

  /**
   * Disarm the security system
   * @param {string} userId - User ID who is disarming the system
   * @returns {Promise<Object>} Updated alarm system
   */
  async disarmAlarm(userId) {
    try {
      console.log('SecurityAlarmService: Disarming alarm');

      const alarm = await SecurityAlarm.getMainAlarm();

      // Check if already disarmed
      if (alarm.alarmState === 'disarmed') {
        throw new Error('Alarm is already disarmed');
      }

      // Send command to SmartThings if properly configured
      const isSthmConfigured = await this.isSmartThingsConfiguredForSthm();
      if (isSthmConfigured) {
        try {
          await smartThingsService.setSecurityArmState('Disarmed');
          console.log('SecurityAlarmService: SmartThings disarm command sent successfully');
        } catch (smartThingsError) {
          console.warn('SecurityAlarmService: SmartThings command failed, continuing with local disarming:', smartThingsError.message);
          // Continue with local disarming even if SmartThings fails
        }
      }

      // Update local alarm state
      await alarm.disarm(userId);

      console.log('SecurityAlarmService: Successfully disarmed alarm');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error disarming alarm:', error.message);
      throw error;
    }
  }

  /**
   * Dismiss an active triggered alarm
   * @param {string} userId - User ID dismissing the triggered alarm
   * @returns {Promise<Object>} Updated alarm system
   */
  async dismissAlarm(userId) {
    try {
      console.log('SecurityAlarmService: Dismissing triggered alarm');

      const alarm = await SecurityAlarm.getMainAlarm();
      if (alarm.alarmState !== 'triggered') {
        throw new Error('Alarm is not currently triggered');
      }

      // Best-effort SmartThings clear by forcing Disarmed state.
      const isSthmConfigured = await this.isSmartThingsConfiguredForSthm();
      if (isSthmConfigured) {
        try {
          await smartThingsService.setSecurityArmState('Disarmed');
          console.log('SecurityAlarmService: SmartThings dismiss/disarm command sent successfully');
        } catch (smartThingsError) {
          console.warn(
            'SecurityAlarmService: SmartThings dismiss command failed, continuing with local dismiss:',
            smartThingsError.message
          );
        }
      }

      await alarm.disarm(userId || 'system:dismiss');

      console.log('SecurityAlarmService: Successfully dismissed triggered alarm');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error dismissing triggered alarm:', error.message);
      throw error;
    }
  }

  /**
   * Get alarm status
   * @returns {Promise<Object>} Alarm status information
   */
  async getAlarmStatus() {
    try {
      console.log('SecurityAlarmService: Getting alarm status');

      let alarm = await SecurityAlarm.getMainAlarm();
      const now = Date.now();
      const lastSyncTimestamp = alarm.lastSyncWithSmartThings ? new Date(alarm.lastSyncWithSmartThings).getTime() : 0;
      const timeSinceLastSync = lastSyncTimestamp ? now - lastSyncTimestamp : Number.POSITIVE_INFINITY;

      const isSmartThingsConfigured = await this.isSmartThingsConfiguredForSthm();
      const shouldAttemptSync = isSmartThingsConfigured && (timeSinceLastSync > STATUS_STALE_THRESHOLD_MS || !alarm.isOnline);

      if (shouldAttemptSync) {
        try {
          alarm = await this.syncWithSmartThings();
        } catch (syncError) {
          console.warn('SecurityAlarmService: SmartThings sync during status lookup failed:', syncError.message);
          alarm = await SecurityAlarm.getMainAlarm();
        }
      }

      const updatedLastSyncTimestamp = alarm.lastSyncWithSmartThings ? new Date(alarm.lastSyncWithSmartThings).getTime() : 0;
      const updatedTimeSinceSync = updatedLastSyncTimestamp ? now - updatedLastSyncTimestamp : Number.POSITIVE_INFINITY;
      const computedIsOnline = Boolean(alarm.isOnline) || updatedTimeSinceSync <= ONLINE_GRACE_PERIOD_MS;

      if (computedIsOnline !== alarm.isOnline) {
        alarm.isOnline = computedIsOnline;
        await alarm.save();
      }

      try {
        await deviceService.ensureSmartThingsState({ immediate: false });
      } catch (deviceRefreshError) {
        console.warn('SecurityAlarmService: Security sensor refresh failed:', deviceRefreshError.message);
      }

      const devices = await Device.find({}, 'name type room status isOnline lastSeen properties brand model').lean();
      const securitySensors = this.getSecuritySensors(alarm, devices);
      const doorLocks = this.getDoorLocks(devices);
      const sensorCount = securitySensors.length;
      const activeSensorCount = securitySensors.filter((sensor) => sensor.isActive).length;
      const monitoredSensorCount = securitySensors.filter((sensor) => sensor.isMonitored && !sensor.isBypassed).length;
      const offlineSensorCount = securitySensors.filter((sensor) => !sensor.isOnline).length;
      const lowBatterySensorCount = securitySensors.filter((sensor) => (
        sensor.batteryState === 'low' || sensor.batteryState === 'critical'
      )).length;
      const attentionSensorCount = securitySensors.filter((sensor) => sensor.requiresAttention).length;
      const doorLockCount = doorLocks.length;
      const lockedDoorCount = doorLocks.filter((lock) => lock.isLocked).length;
      const unlockedDoorCount = doorLockCount - lockedDoorCount;

      const status = {
        alarmState: alarm.alarmState,
        isArmed: ['armedStay', 'armedAway'].includes(alarm.alarmState),
        isTriggered: alarm.alarmState === 'triggered',
        lastArmed: alarm.lastArmed,
        lastDisarmed: alarm.lastDisarmed,
        lastTriggered: alarm.lastTriggered,
        armedBy: alarm.armedBy,
        disarmedBy: alarm.disarmedBy,
        zoneCount: alarm.zones.length,
        activeZones: alarm.zones.filter(zone => zone.enabled && !zone.bypassed).length,
        bypassedZones: alarm.zones.filter(zone => zone.bypassed).length,
        sensorCount,
        activeSensorCount,
        monitoredSensorCount,
        offlineSensorCount,
        lowBatterySensorCount,
        attentionSensorCount,
        sensors: securitySensors,
        doorLockCount,
        lockedDoorCount,
        unlockedDoorCount,
        doorLocks,
        isOnline: computedIsOnline,
        lastSyncWithSmartThings: alarm.lastSyncWithSmartThings,
        batteryLevel: alarm.batteryLevel,
        signalStrength: alarm.signalStrength
      };
      
      console.log('SecurityAlarmService: Successfully retrieved alarm status');
      return status;
    } catch (error) {
      console.error('SecurityAlarmService: Error getting alarm status:', error.message);
      throw new Error('Failed to get alarm status');
    }
  }

  /**
   * Add a security zone
   * @param {Object} zoneData - Zone configuration data
   * @returns {Promise<Object>} Updated alarm system
   */
  async addZone(zoneData) {
    try {
      console.log(`SecurityAlarmService: Adding zone: ${zoneData.name}`);
      
      const alarm = await SecurityAlarm.getMainAlarm();
      await alarm.addZone(zoneData);
      
      console.log('SecurityAlarmService: Successfully added zone');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error adding zone:', error.message);
      throw new Error('Failed to add security zone');
    }
  }

  /**
   * Remove a security zone
   * @param {string} deviceId - Device ID of the zone to remove
   * @returns {Promise<Object>} Updated alarm system
   */
  async removeZone(deviceId) {
    try {
      console.log(`SecurityAlarmService: Removing zone: ${deviceId}`);
      
      const alarm = await SecurityAlarm.getMainAlarm();
      await alarm.removeZone(deviceId);
      
      console.log('SecurityAlarmService: Successfully removed zone');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error removing zone:', error.message);
      throw new Error('Failed to remove security zone');
    }
  }

  /**
   * Bypass or unbypass a security zone
   * @param {string} deviceId - Device ID of the zone
   * @param {boolean} bypass - Whether to bypass the zone
   * @returns {Promise<Object>} Updated alarm system
   */
  async bypassZone(deviceId, bypass = true) {
    try {
      console.log(`SecurityAlarmService: ${bypass ? 'Bypassing' : 'Unbypassing'} zone: ${deviceId}`);
      
      const alarm = await SecurityAlarm.getMainAlarm();
      await alarm.bypassZone(deviceId, bypass);
      
      console.log('SecurityAlarmService: Successfully updated zone bypass status');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error updating zone bypass:', error.message);
      throw error;
    }
  }

  /**
   * Sync alarm status with SmartThings
   * @returns {Promise<Object>} Updated alarm system
   */
  async syncWithSmartThings() {
    try {
      console.log('SecurityAlarmService: Syncing with SmartThings');

      const alarm = await SecurityAlarm.getMainAlarm();

      let synced = false;

      if (await this.isSmartThingsConfiguredForSthm()) {
        try {
          const securityState = await smartThingsService.getSecurityArmState();
          if (securityState?.armState) {
            const mappedState = this.mapSmartThingsArmState(securityState.armState);
            if (mappedState && mappedState !== alarm.alarmState) {
              alarm.alarmState = mappedState;
            }
            if (securityState.deviceId && alarm.smartthingsDeviceId !== securityState.deviceId) {
              console.log(`SecurityAlarmService: Tracking SmartThings security device ${securityState.deviceId}`);
              alarm.smartthingsDeviceId = securityState.deviceId;
            }
            alarm.lastSyncWithSmartThings = new Date();
            alarm.isOnline = true;
            await alarm.save();
            synced = true;
          }
        } catch (securityError) {
          console.warn('SecurityAlarmService: Unable to sync via SmartThings security endpoint:', securityError.message);
        }
      }

      if (!synced) {
        if (!alarm.smartthingsDeviceId) {
          console.warn('SecurityAlarmService: No SmartThings device ID configured; unable to sync via device status');
        } else {
        const deviceStatus = await smartThingsService.getDeviceStatus(alarm.smartthingsDeviceId);

        if (deviceStatus?.components?.main?.securitySystem) {
          const smartthingsState = deviceStatus.components.main.securitySystem.securitySystemStatus.value;
          const mappedState = this.mapSmartThingsArmState(smartthingsState);

          if (mappedState && mappedState !== alarm.alarmState) {
            alarm.alarmState = mappedState;
          }

          alarm.lastSyncWithSmartThings = new Date();
          alarm.isOnline = true;
          await alarm.save();
          synced = true;
        }
      }
      }

      if (!synced) {
        console.warn('SecurityAlarmService: SmartThings did not provide security state; keeping local state');
        alarm.isOnline = false;
        alarm.lastSyncWithSmartThings = new Date();
        await alarm.save();
      } else {
        alarm.isOnline = true;
        await alarm.save();
      }

      console.log('SecurityAlarmService: SmartThings sync complete');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error syncing with SmartThings:', error.message);

      // Mark as offline if sync fails
      const alarm = await SecurityAlarm.getMainAlarm();
      alarm.isOnline = false;
      await alarm.save();

      throw new Error('Failed to sync with SmartThings');
    }
  }

  mapSmartThingsArmState(armState) {
    if (!armState) {
      return null;
    }

    switch (armState.toLowerCase()) {
      case 'disarmed':
      case 'disarm':
        return 'disarmed';
      case 'armedstay':
      case 'stay':
      case 'armed_stay':
        return 'armedStay';
      case 'armedaway':
      case 'away':
      case 'armed_away':
        return 'armedAway';
      case 'triggered':
        return 'triggered';
      default:
        console.warn(`SecurityAlarmService: Unknown SmartThings arm state received: ${armState}`);
        return null;
    }
  }


  /**
   * Configure SmartThings integration
   * @param {string} deviceId - SmartThings device ID
   * @returns {Promise<Object>} Updated alarm system
   */
  async configureSmartThingsIntegration(deviceId) {
    try {
      console.log(`SecurityAlarmService: Configuring SmartThings integration with device: ${deviceId}`);
      
      const alarm = await SecurityAlarm.getMainAlarm();
      alarm.smartthingsDeviceId = deviceId;
      await alarm.save();
      
      console.log('SecurityAlarmService: Successfully configured SmartThings integration');
      return alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error configuring SmartThings integration:', error.message);
      throw new Error('Failed to configure SmartThings integration');
    }
  }
}

module.exports = new SecurityAlarmService();

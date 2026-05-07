const SecurityAlarm = require('../models/SecurityAlarm');
const Device = require('../models/Device');
const bcrypt = require('bcrypt');
const smartThingsService = require('./smartThingsService');
const deviceService = require('./deviceService');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const Settings = require('../models/Settings');
const {
  canonicalizeDeviceSource,
  getDeviceSource
} = require('./deviceSourceCatalog');

const STATUS_STALE_THRESHOLD_MS = Number(process.env.SECURITY_ALARM_STATUS_STALE_MS || 60000);
const ONLINE_GRACE_PERIOD_MS = Number(process.env.SECURITY_ALARM_ONLINE_GRACE_MS || 120000);
const LOW_BATTERY_THRESHOLD = Number(process.env.SECURITY_SENSOR_LOW_BATTERY_PERCENT || 20);
const CRITICAL_BATTERY_THRESHOLD = Number(process.env.SECURITY_SENSOR_CRITICAL_BATTERY_PERCENT || 5);

const SECURITY_CAPABILITIES = new Set([
  'contact',
  'contactSensor',
  'motion',
  'motionSensor',
  'water',
  'waterSensor',
  'smoke',
  'smokeDetector',
  'carbonMonoxide',
  'carbonMonoxideDetector',
  'tamper',
  'tamperAlert',
  'acceleration',
  'accelerationSensor',
  'shock',
  'shockSensor',
  'alarm',
  'doorState',
  'doorControl',
  'booleanState',
  'occupancy',
  'occupancySensing',
  'lock',
  'smokeCoAlarm',
  'smokeCOAlarm'
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
  'homeBrainBatteryLevel',
  'directBatteryLevel',
  'matterBatteryLevel',
  'smartThingsBatteryLevel',
  'batteryLevel',
  'battery',
  'batteryPercent',
  'batteryPercentage'
];

const SECURITY_STATUS_DEVICE_PROJECTION = 'name type room status isOnline lastSeen properties brand model';
const DEFAULT_ARM_AWAY_EXIT_DELAY_SECONDS = 30;
const SECURITY_PIN_MIN_LENGTH = 4;
const SECURITY_PIN_MAX_LENGTH = 8;
const SECURITY_PIN_NAME_MAX_LENGTH = 80;
const SECURITY_PIN_HASH_ROUNDS = Math.max(
  10,
  Math.min(14, Number(process.env.SECURITY_ALARM_PIN_HASH_ROUNDS || 12) || 12)
);

const SECURITY_AUDIO_PROMPTS = Object.freeze({
  armingAway30: '/audio/security/arming-away-30.mp3',
  armingCountdownBeep: '/audio/security/arming-countdown-beep.mp3',
  armingFinalBeeps: '/audio/security/arming-final-beeps.mp3',
  armedStay: '/audio/security/armed-stay.mp3',
  disarmed: '/audio/security/disarmed.mp3',
  alarmTriggered: '/audio/security/alarm-triggered.mp3',
  alarmDismissedFalseAlarm: '/audio/security/alarm-dismissed-false-alarm.mp3',
  securityConfirmationChime: '/audio/security/security-confirmation-chime.mp3',
  securityAlertPulse: '/audio/security/security-alert-pulse.mp3'
});

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

const buildSecurityAlarmError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const findNestedBatteryLevel = (value, depth = 0) => {
  if (!value || typeof value !== 'object' || depth > 5) {
    return null;
  }

  const direct = toNumber(value.battery ?? value.batteryLevel ?? value.batteryPercent ?? value.batteryPercentage ?? value.value);
  if (direct !== null) {
    return direct;
  }

  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') {
      continue;
    }
    const nested = findNestedBatteryLevel(child, depth + 1);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
};

const getDeviceLookupKeys = (device) => uniqueStrings([
  normalizeString(device?._id?.toString?.() || device?._id),
  normalizeString(device?.id),
  normalizeString(device?.properties?.smartThingsDeviceId),
  normalizeString(device?.properties?.insteonAddress),
  normalizeString(device?.properties?.ecobeeSensorId),
  normalizeString(device?.properties?.ecobeeSensorKey),
  normalizeString(device?.properties?.matter?.nodeId && device?.properties?.matter?.endpointId
    ? `${device.properties.matter.nodeId}/${device.properties.matter.endpointId}`
    : '')
]);

const getDeviceCapabilities = (device) => uniqueStrings([
  ...(Array.isArray(device?.properties?.smartThingsCapabilities) ? device.properties.smartThingsCapabilities : []),
  ...(Array.isArray(device?.properties?.smartthingsCapabilities) ? device.properties.smartthingsCapabilities : []),
  ...(Array.isArray(device?.properties?.directRadioFeatures) ? device.properties.directRadioFeatures : []),
  ...(Array.isArray(device?.properties?.matterFeatures) ? device.properties.matterFeatures : []),
  ...(Array.isArray(device?.properties?.capabilities) ? device.properties.capabilities : []),
  ...(Array.isArray(device?.capabilities) ? device.capabilities : [])
].map((value) => normalizeString(value)));

const getDeviceCategories = (device) => uniqueStrings([
  ...(Array.isArray(device?.properties?.smartThingsCategories) ? device.properties.smartThingsCategories : []),
  ...(Array.isArray(device?.properties?.smartthingsCategories) ? device.properties.smartthingsCategories : []),
  ...(Array.isArray(device?.properties?.matter?.deviceTypeNames) ? device.properties.matter.deviceTypeNames : []),
  ...(Array.isArray(device?.properties?.matterCategories) ? device.properties.matterCategories : [])
].map((value) => normalizeString(value).toLowerCase()));

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

  const nestedBattery = findNestedBatteryLevel(device?.properties?.smartThingsAttributeValues)
    ?? findNestedBatteryLevel(device?.properties?.directRadioState)
    ?? findNestedBatteryLevel(device?.properties?.homebrainDirect)
    ?? findNestedBatteryLevel(device?.properties?.matterState)
    ?? findNestedBatteryLevel(device?.properties?.matter);
  if (nestedBattery !== null) {
    return Math.max(0, Math.min(100, Math.round(nestedBattery)));
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
    device?.properties?.smartThingsPresentationId,
    device?.properties?.source,
    device?.properties?.matter?.productName,
    device?.properties?.matter?.endpointName,
    ...(Array.isArray(device?.properties?.matter?.deviceTypeNames) ? device.properties.matter.deviceTypeNames : []),
    ...(Array.isArray(device?.properties?.matterFeatures) ? device.properties.matterFeatures : [])
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
  if (capabilities.includes('contactSensor') || capabilities.includes('contact')) {
    return 'doorWindow';
  }
  if (capabilities.includes('motionSensor') || capabilities.includes('motion') || capabilities.includes('occupancy')) {
    return 'motion';
  }
  if (capabilities.includes('waterSensor') || capabilities.includes('water')) {
    return 'flood';
  }
  if (capabilities.includes('smokeDetector') || capabilities.includes('smoke')) {
    return 'smoke';
  }
  if (capabilities.includes('carbonMonoxideDetector') || capabilities.includes('carbonMonoxide')) {
    return 'co';
  }
  if (
    capabilities.includes('tamperAlert')
    || capabilities.includes('tamper')
    || capabilities.includes('accelerationSensor')
    || capabilities.includes('acceleration')
    || capabilities.includes('shockSensor')
    || capabilities.includes('shock')
  ) {
    return inferSensorTypeFromKeywords(device, zone) === 'panic' ? 'panic' : 'glass';
  }
  if (capabilities.includes('alarm')) {
    return 'panic';
  }
  if (capabilities.includes('doorState') || capabilities.includes('doorControl')) {
    return 'doorWindow';
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

const requestSecurityAlarmAutomationEvaluation = (reason) => {
  try {
    const automationSchedulerService = require('./automationSchedulerService');
    console.log(`SecurityAlarmService: Requesting automation scheduler evaluation after ${reason}`);
    void automationSchedulerService.tick({
      source: 'security_alarm',
      reason
    });
  } catch (error) {
    console.warn(`SecurityAlarmService: Failed to request automation evaluation after ${reason}: ${error.message}`);
  }
};

const looksLikeSecuritySensor = (device) => {
  if (!device || typeof device !== 'object') {
    return false;
  }

  if (device?.properties?.securitySensor === true || device?.properties?.includeInSecurityCenter === true) {
    return true;
  }

  const deviceType = normalizeString(device?.type).toLowerCase();
  if (deviceType === 'lock') {
    return false;
  }

  const capabilities = getDeviceCapabilities(device);
  if (capabilities.some((capability) => SECURITY_CAPABILITIES.has(capability))) {
    return true;
  }

  if (deviceType !== 'sensor' && deviceType !== 'garage' && deviceType !== 'camera') {
    return false;
  }

  if (deviceType === 'garage') {
    return true;
  }

  return inferSensorTypeFromKeywords(device, null) !== 'security'
    || /security/i.test(normalizeString(device?.properties?.smartThingsDeviceTypeName));
};

const looksLikeSmartThingsAlarmOutput = (device) => {
  if (!device || typeof device !== 'object') {
    return false;
  }

  const smartThingsDeviceId = normalizeString(device?.properties?.smartThingsDeviceId);
  if (!smartThingsDeviceId) {
    return false;
  }

  const capabilities = getDeviceCapabilities(device);
  if (capabilities.includes('alarm')) {
    return true;
  }

  const categories = getDeviceCategories(device);
  return categories.includes('siren');
};

const looksLikeHomeBrainAlarmOutput = (device) => {
  if (!device || typeof device !== 'object') {
    return false;
  }

  const source = normalizeString(device?.properties?.source).toLowerCase();
  const protocol = normalizeString(device?.properties?.homebrainDirect?.protocol).toLowerCase();
  if (!source.startsWith('homebrain-') && source !== 'matter' && protocol !== 'zigbee' && protocol !== 'zwave') {
    return false;
  }

  const capabilities = getDeviceCapabilities(device);
  if (capabilities.includes('alarm') || capabilities.includes('chime')) {
    return true;
  }

  const haystack = [
    device?.name,
    device?.type,
    device?.brand,
    device?.model,
    ...(Array.isArray(device?.properties?.directRadioFeatures) ? device.properties.directRadioFeatures : []),
    ...(Array.isArray(device?.properties?.matterFeatures) ? device.properties.matterFeatures : [])
  ]
    .map((entry) => normalizeString(entry).toLowerCase())
    .filter(Boolean)
    .join(' ');

  return /\b(siren|alarm|sounder|strobe|chime)\b/.test(haystack);
};

class SecurityAlarmService {
  constructor() {
    this.smartthingsBaseUrl = 'https://api.smartthings.com/v1';
    this.pendingArmTimers = new Map();
  }

  getEnabledPlatforms(alarm) {
    const enabledPlatforms = alarm?.enabledPlatforms && typeof alarm.enabledPlatforms === 'object'
      ? alarm.enabledPlatforms
      : {};

    return {
      homebrain: enabledPlatforms.homebrain !== false,
      smartthings: enabledPlatforms.smartthings !== false
    };
  }

  isPlatformEnabled(alarm, platform) {
    return this.getEnabledPlatforms(alarm)[platform] !== false;
  }

  normalizeExitDelaySeconds(value, fallback = DEFAULT_ARM_AWAY_EXIT_DELAY_SECONDS) {
    const candidate = toNumber(value);
    const resolved = candidate === null ? fallback : candidate;
    return Math.max(0, Math.min(300, Math.round(resolved)));
  }

  getPinSettings(alarm) {
    const pinSettings = alarm?.pinSettings && typeof alarm.pinSettings === 'object'
      ? alarm.pinSettings
      : {};

    return {
      requireForArm: pinSettings.requireForArm === true,
      requireForDisarm: pinSettings.requireForDisarm === true
    };
  }

  getSanitizedPins(alarm) {
    const userCodes = Array.isArray(alarm?.userCodes) ? alarm.userCodes : [];

    return userCodes.map((entry) => {
      const id = normalizeString(entry?._id?.toString?.() || entry?.id);
      return {
        id,
        name: normalizeString(entry?.name) || 'Security PIN',
        enabled: entry?.enabled !== false
      };
    }).filter((entry) => entry.id || entry.name);
  }

  getSecuritySettingsFromAlarm(alarm) {
    const enabledPlatforms = this.getEnabledPlatforms(alarm);

    return {
      enabledPlatforms,
      exitDelaySeconds: this.normalizeExitDelaySeconds(alarm?.exitDelay, DEFAULT_ARM_AWAY_EXIT_DELAY_SECONDS),
      entryDelaySeconds: this.normalizeExitDelaySeconds(alarm?.entryDelay, 30),
      pinSettings: this.getPinSettings(alarm),
      pins: this.getSanitizedPins(alarm)
    };
  }

  normalizePinName(value) {
    return normalizeString(value).replace(/\s+/g, ' ').slice(0, SECURITY_PIN_NAME_MAX_LENGTH);
  }

  validatePinValue(pin) {
    if (!/^\d+$/.test(pin)) {
      throw buildSecurityAlarmError('Security PIN must contain digits only', 400);
    }

    if (pin.length < SECURITY_PIN_MIN_LENGTH || pin.length > SECURITY_PIN_MAX_LENGTH) {
      throw buildSecurityAlarmError(
        `Security PIN must be ${SECURITY_PIN_MIN_LENGTH}-${SECURITY_PIN_MAX_LENGTH} digits`,
        400
      );
    }
  }

  hasExplicitPinValue(pinRecord) {
    return Object.prototype.hasOwnProperty.call(pinRecord, 'pin')
      || Object.prototype.hasOwnProperty.call(pinRecord, 'code')
      || Object.prototype.hasOwnProperty.call(pinRecord, 'securityPin');
  }

  normalizePinSettings(settings, currentSettings) {
    const pinSource = settings.pinSettings && typeof settings.pinSettings === 'object'
      ? settings.pinSettings
      : settings;

    return {
      requireForArm: typeof pinSource.requireForArm === 'boolean'
        ? pinSource.requireForArm
        : typeof pinSource.requirePinForArm === 'boolean'
          ? pinSource.requirePinForArm
          : currentSettings.requireForArm,
      requireForDisarm: typeof pinSource.requireForDisarm === 'boolean'
        ? pinSource.requireForDisarm
        : typeof pinSource.requirePinForDisarm === 'boolean'
          ? pinSource.requirePinForDisarm
          : currentSettings.requireForDisarm
    };
  }

  async normalizePinRecords(alarm, pinRecords) {
    if (!Array.isArray(pinRecords)) {
      return Array.isArray(alarm?.userCodes) ? alarm.userCodes : [];
    }

    const existingById = new Map();
    const existingCodes = Array.isArray(alarm?.userCodes) ? alarm.userCodes : [];
    existingCodes.forEach((entry) => {
      const id = normalizeString(entry?._id?.toString?.() || entry?.id);
      if (id) {
        existingById.set(id, entry);
      }
    });

    const usedNames = new Set();
    const normalizedRecords = [];

    for (const pinRecord of pinRecords) {
      if (!pinRecord || typeof pinRecord !== 'object') {
        continue;
      }
      if (pinRecord.remove === true || pinRecord.deleted === true) {
        continue;
      }

      const id = normalizeString(pinRecord.id || pinRecord._id);
      const existing = id ? existingById.get(id) : null;
      const name = this.normalizePinName(pinRecord.name);
      if (!name) {
        throw buildSecurityAlarmError('Each security PIN needs a name', 400);
      }

      const normalizedNameKey = name.toLowerCase();
      if (usedNames.has(normalizedNameKey)) {
        throw buildSecurityAlarmError('Security PIN names must be unique', 400);
      }
      usedNames.add(normalizedNameKey);

      const enabled = pinRecord.enabled !== false;
      const rawPin = normalizeString(pinRecord.pin ?? pinRecord.securityPin ?? pinRecord.code ?? '');
      let code = existing?.code || '';

      if (this.hasExplicitPinValue(pinRecord) && rawPin) {
        this.validatePinValue(rawPin);
        code = await bcrypt.hash(rawPin, SECURITY_PIN_HASH_ROUNDS);
      }

      if (!code) {
        throw buildSecurityAlarmError(`Enter a PIN for ${name}`, 400);
      }

      normalizedRecords.push({
        ...(existing?._id ? { _id: existing._id } : {}),
        ...(existing?.userId ? { userId: existing.userId } : {}),
        code,
        name,
        enabled
      });
    }

    return normalizedRecords;
  }

  hasEnabledPin(alarm) {
    return Array.isArray(alarm?.userCodes)
      && alarm.userCodes.some((entry) => entry?.enabled !== false && normalizeString(entry?.code));
  }

  async verifySecurityPin(alarm, action, options = {}) {
    const pinSettings = this.getPinSettings(alarm);
    const requirePin = action === 'arm'
      ? pinSettings.requireForArm
      : pinSettings.requireForDisarm;
    const pin = normalizeString(options.pin ?? options.securityPin ?? options.code ?? '');

    if (!pin) {
      if (requirePin) {
        throw buildSecurityAlarmError('Security PIN is required', 401);
      }
      return null;
    }

    const enabledPins = Array.isArray(alarm?.userCodes)
      ? alarm.userCodes.filter((entry) => entry?.enabled !== false && normalizeString(entry?.code))
      : [];

    for (const entry of enabledPins) {
      const storedCode = normalizeString(entry?.code);
      let matches = false;

      try {
        matches = storedCode.startsWith('$2')
          ? await bcrypt.compare(pin, storedCode)
          : pin === storedCode;
      } catch (error) {
        matches = false;
      }

      if (matches) {
        if (!storedCode.startsWith('$2')) {
          entry.code = await bcrypt.hash(pin, SECURITY_PIN_HASH_ROUNDS);
        }
        return {
          id: normalizeString(entry?._id?.toString?.() || entry?.id),
          name: this.normalizePinName(entry?.name) || 'Security PIN'
        };
      }
    }

    throw buildSecurityAlarmError('Invalid security PIN', 401);
  }

  resolveSecurityActor(userId, pinRecord, fallback = 'system') {
    if (pinRecord?.name) {
      return pinRecord.name;
    }

    return normalizeString(userId?.toString?.() || userId) || fallback;
  }

  getAudioPrompts(alarm) {
    return {
      ...SECURITY_AUDIO_PROMPTS,
      ...(alarm?.audioPrompts && typeof alarm.audioPrompts === 'object' ? alarm.audioPrompts : {})
    };
  }

  getAlarmTimerKey(alarm) {
    return normalizeString(alarm?._id?.toString?.() || alarm?._id) || 'main';
  }

  clearPendingArmTimer(alarm) {
    const key = this.getAlarmTimerKey(alarm);
    const timer = this.pendingArmTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pendingArmTimers.delete(key);
    }
  }

  schedulePendingArm(alarm) {
    if (!alarm || alarm.alarmState !== 'arming' || !alarm.pendingArmReadyAt) {
      return;
    }

    const readyAt = new Date(alarm.pendingArmReadyAt).getTime();
    const delayMs = readyAt - Date.now();
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
      return;
    }

    this.clearPendingArmTimer(alarm);
    const key = this.getAlarmTimerKey(alarm);
    const alarmId = normalizeString(alarm?._id?.toString?.() || alarm?._id);
    const timer = setTimeout(() => {
      this.pendingArmTimers.delete(key);
      this.finalizeExpiredPendingArmById(alarmId).catch((error) => {
        console.warn(`SecurityAlarmService: Failed to finalize pending arm: ${error.message}`);
      });
    }, Math.min(delayMs, 2147483647));

    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.pendingArmTimers.set(key, timer);
  }

  async finalizeExpiredPendingArmById(alarmId) {
    const alarm = alarmId
      ? await SecurityAlarm.findById(alarmId)
      : await SecurityAlarm.getMainAlarm();
    if (!alarm) {
      return null;
    }
    return this.finalizeExpiredPendingArm(alarm);
  }

  async finalizeExpiredPendingArm(alarm) {
    if (!alarm || alarm.alarmState !== 'arming' || !alarm.pendingArmMode || !alarm.pendingArmReadyAt) {
      return alarm;
    }

    const readyAt = new Date(alarm.pendingArmReadyAt).getTime();
    if (!Number.isFinite(readyAt) || readyAt > Date.now()) {
      this.schedulePendingArm(alarm);
      return alarm;
    }

    const previousState = alarm.alarmState;
    const mode = alarm.pendingArmMode;
    await this.sendSmartThingsArmCommand(alarm, mode);
    await alarm.arm(mode, alarm.armedBy || 'system:exit-delay');
    if (alarm.alarmState !== previousState) {
      requestSecurityAlarmAutomationEvaluation(`exit delay elapsed to ${alarm.alarmState}`);
    }
    return alarm;
  }

  getSecurityDeviceSourceLabel(source) {
    switch (canonicalizeDeviceSource(source)) {
      case 'homebrain-matter':
        return 'HomeBrain Matter';
      case 'homebrain-zigbee':
        return 'HomeBrain Zigbee';
      case 'homebrain-zwave':
        return 'HomeBrain Z-Wave';
      case 'homebrain-thread':
        return 'HomeBrain Thread';
      case 'smartthings':
        return 'SmartThings';
      case 'insteon':
        return 'INSTEON';
      case 'ecobee':
        return 'Ecobee';
      case 'rainmachine':
        return 'RainMachine';
      case 'tempest':
        return 'Tempest';
      case 'homebrain':
      case 'local':
        return 'HomeBrain';
      case '':
        return 'Unknown';
      default:
        return normalizeString(source)
          .replace(/[_-]+/g, ' ')
          .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }
  }

  buildSecuritySensorSummary({ device, zone }) {
    const localDeviceId = normalizeString(device?._id?.toString?.() || device?._id || device?.id);
    const resolvedDeviceId = localDeviceId || normalizeString(zone?.deviceId);
    const smartThingsDeviceId = normalizeString(device?.properties?.smartThingsDeviceId);
    const source = device ? getDeviceSource(device) : null;
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
      smartThingsDeviceId: smartThingsDeviceId || null,
      source,
      sourceLabel: this.getSecurityDeviceSourceLabel(source),
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
    const smartThingsDeviceId = normalizeString(device?.properties?.smartThingsDeviceId);
    const source = device ? getDeviceSource(device) : null;
    const isLocked = Boolean(device?.status);
    const isOnline = device?.isOnline !== false;

    return {
      deviceId: localDeviceId,
      localDeviceId: localDeviceId || null,
      smartThingsDeviceId: smartThingsDeviceId || null,
      source,
      sourceLabel: this.getSecurityDeviceSourceLabel(source),
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

  async refreshSmartThingsDoorLocks(devices = []) {
    const smartThingsDoorLocks = devices.filter((device) => (
      normalizeString(device?.type).toLowerCase() === 'lock' &&
      normalizeString(device?.properties?.smartThingsDeviceId)
    ));

    if (smartThingsDoorLocks.length === 0) {
      return devices;
    }

    const updatesByLocalId = new Map();

    for (const device of smartThingsDoorLocks) {
      const localDeviceId = normalizeString(device?._id?.toString?.() || device?._id || device?.id);
      const smartThingsDeviceId = normalizeString(device?.properties?.smartThingsDeviceId);
      if (!localDeviceId || !smartThingsDeviceId) {
        continue;
      }

      try {
        const [details, status] = await Promise.all([
          smartThingsService.getDevice(smartThingsDeviceId),
          smartThingsService.getDeviceStatus(smartThingsDeviceId)
        ]);

        if (!status || !status.components) {
          continue;
        }

        const combined = {
          ...(details || {}),
          deviceId: details?.deviceId || smartThingsDeviceId,
          status
        };

        const updates = await smartThingsService.buildSmartThingsDeviceUpdate(device, combined);
        if (updates && Object.keys(updates).length > 0) {
          updatesByLocalId.set(localDeviceId, updates);
        }
      } catch (error) {
        console.warn(`SecurityAlarmService: Failed to refresh SmartThings door lock ${smartThingsDeviceId}: ${error.message}`);
      }
    }

    if (updatesByLocalId.size === 0) {
      return devices;
    }

    const bulkOps = Array.from(updatesByLocalId.entries()).map(([deviceId, updates]) => ({
      updateOne: {
        filter: { _id: deviceId },
        update: { $set: updates }
      }
    }));

    await Device.bulkWrite(bulkOps, { ordered: false });

    const refreshedDevices = await Device.find(
      { _id: { $in: Array.from(updatesByLocalId.keys()) } },
      SECURITY_STATUS_DEVICE_PROJECTION
    ).lean();

    const refreshedById = new Map(
      refreshedDevices.map((device) => [
        normalizeString(device?._id?.toString?.() || device?._id || device?.id),
        device
      ])
    );

    const payload = deviceUpdateEmitter.normalizeDevices(refreshedDevices);
    if (payload.length > 0) {
      deviceUpdateEmitter.emit('devices:update', payload);
    }

    return devices.map((device) => {
      const localDeviceId = normalizeString(device?._id?.toString?.() || device?._id || device?.id);
      return refreshedById.get(localDeviceId) || device;
    });
  }

  /**
   * Check if SmartThings STHM is properly configured for security operations
   * @returns {Promise<boolean>} True if STHM is configured and connected
   */
  async isSmartThingsConfiguredForSthm(options = {}) {
    try {
      const requireAllMappings = options.requireAllMappings !== false;
      const mappingKeys = {
        disarm: 'disarmDeviceId',
        armStay: 'armStayDeviceId',
        armAway: 'armAwayDeviceId',
        silence: 'silenceDeviceId'
      };
      const requestedMappings = Array.isArray(options.requiredMappings)
        ? options.requiredMappings
          .map((mapping) => (typeof mapping === 'string' ? mapping.trim() : ''))
          .filter((mapping) => mappingKeys[mapping])
        : null;
      const integration = await SmartThingsIntegration.getIntegration();
      const settings = await Settings.getSettings();
      const requiredMappings = requestedMappings || (requireAllMappings ? ['disarm', 'armStay', 'armAway'] : ['disarm']);
      const hasSthmMapping = requiredMappings.every((mapping) => Boolean(integration?.sthm?.[mappingKeys[mapping]]));

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

  async sendSmartThingsArmCommand(alarm, mode) {
    if (!this.isPlatformEnabled(alarm, 'smartthings')) {
      return false;
    }

    const isSthmConfigured = await this.isSmartThingsConfiguredForSthm();
    if (!isSthmConfigured) {
      return false;
    }

    try {
      const targetState = mode === 'stay' ? 'ArmedStay' : 'ArmedAway';
      await smartThingsService.setSecurityArmState(targetState);
      console.log('SecurityAlarmService: SmartThings command sent successfully');
      return true;
    } catch (smartThingsError) {
      console.warn('SecurityAlarmService: SmartThings command failed, continuing with local arming:', smartThingsError.message);
      return false;
    }
  }

  async silenceSmartThingsAlarmOutputs() {
    try {
      const smartThingsDevices = await Device.find(
        {
          'properties.smartThingsDeviceId': { $exists: true, $ne: '' }
        },
        'name properties'
      ).lean();
      const alarmOutputs = smartThingsDevices.filter((device) => looksLikeSmartThingsAlarmOutput(device));

      if (alarmOutputs.length === 0) {
        return { silenced: [], failed: [] };
      }

      const results = await Promise.allSettled(alarmOutputs.map(async (device) => {
        const smartThingsDeviceId = normalizeString(device?.properties?.smartThingsDeviceId);
        const result = await smartThingsService.silenceAlarmDevice(smartThingsDeviceId, {
          capabilities: getDeviceCapabilities(device),
          categories: getDeviceCategories(device)
        });

        return {
          deviceId: smartThingsDeviceId,
          name: normalizeString(device?.name) || smartThingsDeviceId,
          via: result.via
        };
      }));

      const silenced = [];
      const failed = [];

      results.forEach((result, index) => {
        const device = alarmOutputs[index];
        const smartThingsDeviceId = normalizeString(device?.properties?.smartThingsDeviceId);
        const deviceName = normalizeString(device?.name) || smartThingsDeviceId || 'Unnamed SmartThings alarm output';

        if (result.status === 'fulfilled') {
          silenced.push(result.value);
          return;
        }

        const message = result.reason?.message || 'Unknown SmartThings alarm output error';
        failed.push({
          deviceId: smartThingsDeviceId,
          name: deviceName,
          error: message
        });
        console.warn(`SecurityAlarmService: Failed to silence SmartThings alarm output ${deviceName} (${smartThingsDeviceId}): ${message}`);
      });

      if (silenced.length > 0) {
        console.log(`SecurityAlarmService: Silenced ${silenced.length} SmartThings alarm output${silenced.length === 1 ? '' : 's'}`);
      }

      return { silenced, failed };
    } catch (error) {
      console.warn('SecurityAlarmService: Failed to enumerate SmartThings alarm outputs:', error.message);
      return {
        silenced: [],
        failed: [{
          deviceId: '',
          name: 'SmartThings alarm outputs',
          error: error.message
        }]
      };
    }
  }

  async silenceHomeBrainAlarmOutputs() {
    try {
      const homeBrainDevices = await Device.find(
        {
          $or: [
            { 'properties.source': /^homebrain-/i },
            { 'properties.source': /^matter$/i },
            { 'properties.homebrainDirect.protocol': { $in: ['zigbee', 'zwave'] } },
            { 'properties.supportsAlarm': true }
          ]
        },
        'name type status isOnline properties'
      ).lean();
      const alarmOutputs = homeBrainDevices.filter((device) => looksLikeHomeBrainAlarmOutput(device));

      if (alarmOutputs.length === 0) {
        return { silenced: [], failed: [] };
      }

      const results = await Promise.allSettled(alarmOutputs.map(async (device) => {
        const localDeviceId = normalizeString(device?._id?.toString?.() || device?._id || device?.id);
        const deviceName = normalizeString(device?.name) || localDeviceId || 'Unnamed HomeBrain alarm output';

        try {
          await deviceService.controlDevice(localDeviceId, 'alarm_off', null, {
            skipIntegrationRefresh: true,
            skipPostActionVerification: true,
            command: {
              source: 'security_alarm',
              reason: 'dismiss_triggered_alarm',
              priority: 'critical'
            }
          });
          return { deviceId: localDeviceId, name: deviceName, via: 'homebrain.alarm_off' };
        } catch (alarmOffError) {
          await deviceService.controlDevice(localDeviceId, 'turn_off', false, {
            skipIntegrationRefresh: true,
            skipPostActionVerification: true,
            command: {
              source: 'security_alarm',
              reason: 'dismiss_triggered_alarm',
              priority: 'critical',
              fallbackFrom: 'alarm_off',
              fallbackError: alarmOffError.message
            }
          });
          return { deviceId: localDeviceId, name: deviceName, via: 'homebrain.turn_off' };
        }
      }));

      const silenced = [];
      const failed = [];

      results.forEach((result, index) => {
        const device = alarmOutputs[index];
        const localDeviceId = normalizeString(device?._id?.toString?.() || device?._id || device?.id);
        const deviceName = normalizeString(device?.name) || localDeviceId || 'Unnamed HomeBrain alarm output';

        if (result.status === 'fulfilled') {
          silenced.push(result.value);
          return;
        }

        const message = result.reason?.message || 'Unknown HomeBrain alarm output error';
        failed.push({
          deviceId: localDeviceId,
          name: deviceName,
          error: message
        });
        console.warn(`SecurityAlarmService: Failed to silence HomeBrain alarm output ${deviceName} (${localDeviceId}): ${message}`);
      });

      if (silenced.length > 0) {
        console.log(`SecurityAlarmService: Silenced ${silenced.length} HomeBrain alarm output${silenced.length === 1 ? '' : 's'}`);
      }

      return { silenced, failed };
    } catch (error) {
      console.warn('SecurityAlarmService: Failed to enumerate HomeBrain alarm outputs:', error.message);
      return {
        silenced: [],
        failed: [{
          deviceId: '',
          name: 'HomeBrain alarm outputs',
          error: error.message
        }]
      };
    }
  }

  async clearTriggeredSmartThingsAlarm() {
    const result = {
      disarmedInSmartThings: false,
      silenceSwitchTriggered: false,
      silencedOutputs: [],
      failedOutputs: []
    };

    const canDisarmInSmartThings = await this.isSmartThingsConfiguredForSthm({ requireAllMappings: false });
    if (canDisarmInSmartThings) {
      try {
        await smartThingsService.setSecurityArmState('Disarmed');
        result.disarmedInSmartThings = true;
        console.log('SecurityAlarmService: SmartThings disarm command sent successfully');
      } catch (smartThingsError) {
        console.warn(
          'SecurityAlarmService: SmartThings disarm command failed, continuing with local dismiss:',
          smartThingsError.message
        );
      }
    }

    const canSilenceInSmartThings = await this.isSmartThingsConfiguredForSthm({ requiredMappings: ['silence'] });
    if (canSilenceInSmartThings) {
      try {
        await smartThingsService.triggerSthmSilenceSwitch();
        result.silenceSwitchTriggered = true;
        console.log('SecurityAlarmService: SmartThings silence routine trigger sent successfully');
      } catch (smartThingsError) {
        console.warn(
          'SecurityAlarmService: SmartThings silence routine trigger failed, continuing with local dismiss:',
          smartThingsError.message
        );
      }
    }

    const alarmOutputResult = await this.silenceSmartThingsAlarmOutputs();
    result.silencedOutputs = alarmOutputResult.silenced;
    result.failedOutputs = alarmOutputResult.failed;

    return result;
  }

  async clearTriggeredAlarm(alarm = null) {
    const currentAlarm = alarm || await SecurityAlarm.getMainAlarm();
    const result = {
      smartthings: {
        attempted: false,
        disarmedInSmartThings: false,
        silenceSwitchTriggered: false,
        silencedOutputs: [],
        failedOutputs: []
      },
      homebrain: {
        attempted: false,
        silencedOutputs: [],
        failedOutputs: []
      },
      disarmedInSmartThings: false,
      silenceSwitchTriggered: false,
      silencedOutputs: [],
      failedOutputs: []
    };

    if (this.isPlatformEnabled(currentAlarm, 'smartthings')) {
      result.smartthings.attempted = true;
      const smartThingsResult = await this.clearTriggeredSmartThingsAlarm();
      Object.assign(result.smartthings, smartThingsResult);
      result.disarmedInSmartThings = smartThingsResult.disarmedInSmartThings;
      result.silenceSwitchTriggered = smartThingsResult.silenceSwitchTriggered;
      result.silencedOutputs.push(...smartThingsResult.silencedOutputs);
      result.failedOutputs.push(...smartThingsResult.failedOutputs);
    }

    if (this.isPlatformEnabled(currentAlarm, 'homebrain')) {
      result.homebrain.attempted = true;
      const homeBrainResult = await this.silenceHomeBrainAlarmOutputs();
      result.homebrain.silencedOutputs = homeBrainResult.silenced;
      result.homebrain.failedOutputs = homeBrainResult.failed;
      result.silencedOutputs.push(...homeBrainResult.silenced);
      result.failedOutputs.push(...homeBrainResult.failed);
    }

    return result;
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

  async getSecuritySettings() {
    try {
      console.log('SecurityAlarmService: Getting security settings');
      const alarm = await SecurityAlarm.getMainAlarm();
      return this.getSecuritySettingsFromAlarm(alarm);
    } catch (error) {
      console.error('SecurityAlarmService: Error getting security settings:', error.message);
      throw new Error('Failed to get security settings');
    }
  }

  /**
   * Arm the security system
   * @param {string} mode - 'stay' or 'away'
   * @param {string} userId - User ID who is arming the system
   * @returns {Promise<Object>} Updated alarm system
   */
  async armAlarm(mode, userId, options = {}) {
    try {
      console.log(`SecurityAlarmService: Arming alarm in ${mode} mode`);

      let alarm = await SecurityAlarm.getMainAlarm();
      alarm = await this.finalizeExpiredPendingArm(alarm);
      const previousState = alarm.alarmState;

      // Check if already armed
      if (alarm.alarmState === 'armedStay' || alarm.alarmState === 'armedAway' || alarm.alarmState === 'arming') {
        throw new Error('Alarm is already armed');
      }

      const pinRecord = await this.verifySecurityPin(alarm, 'arm', options);
      const actor = this.resolveSecurityActor(userId, pinRecord);

      if (mode === 'away') {
        const exitDelaySeconds = this.normalizeExitDelaySeconds(
          options.exitDelaySeconds ?? options.exitDelay,
          alarm.exitDelay ?? DEFAULT_ARM_AWAY_EXIT_DELAY_SECONDS
        );
        alarm.exitDelay = exitDelaySeconds;

        if (exitDelaySeconds > 0) {
          alarm.alarmState = 'arming';
          alarm.pendingArmMode = 'away';
          alarm.pendingArmStartedAt = new Date();
          alarm.pendingArmReadyAt = new Date(Date.now() + exitDelaySeconds * 1000);
          alarm.armedBy = actor;
          alarm.audioPrompts = this.getAudioPrompts(alarm);
          await alarm.save();
          this.schedulePendingArm(alarm);
          requestSecurityAlarmAutomationEvaluation(`arm away countdown ${exitDelaySeconds}s`);
          console.log(`SecurityAlarmService: Started away arming countdown for ${exitDelaySeconds} seconds`);
          return alarm;
        }
      }

      await this.sendSmartThingsArmCommand(alarm, mode);

      // Update local alarm state
      await alarm.arm(mode, actor);
      alarm.audioPrompts = this.getAudioPrompts(alarm);
      if (typeof alarm.save === 'function') {
        await alarm.save();
      }
      if (alarm.alarmState !== previousState) {
        requestSecurityAlarmAutomationEvaluation(`arm to ${alarm.alarmState}`);
      }

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
  async disarmAlarm(userId, options = {}) {
    try {
      console.log('SecurityAlarmService: Disarming alarm');

      let alarm = await SecurityAlarm.getMainAlarm();
      alarm = await this.finalizeExpiredPendingArm(alarm);
      const previousState = alarm.alarmState;
      const alarmWasTriggered = alarm.alarmState === 'triggered';

      // Check if already disarmed
      if (alarm.alarmState === 'disarmed') {
        throw new Error('Alarm is already disarmed');
      }

      const pinRecord = await this.verifySecurityPin(alarm, 'disarm', options);
      const actor = this.resolveSecurityActor(userId, pinRecord);

      let sirenSilenceResult = null;
      if (alarmWasTriggered) {
        sirenSilenceResult = await this.clearTriggeredAlarm(alarm);
      } else if (this.isPlatformEnabled(alarm, 'smartthings')) {
        // Send command to SmartThings if the disarm switch is configured.
        const canDisarmInSmartThings = await this.isSmartThingsConfiguredForSthm({ requireAllMappings: false });
        if (canDisarmInSmartThings) {
          try {
            await smartThingsService.setSecurityArmState('Disarmed');
            console.log('SecurityAlarmService: SmartThings disarm command sent successfully');
          } catch (smartThingsError) {
            console.warn('SecurityAlarmService: SmartThings command failed, continuing with local disarming:', smartThingsError.message);
            // Continue with local disarming even if SmartThings fails
          }
        }
      }

      // Update local alarm state
      this.clearPendingArmTimer(alarm);
      await alarm.disarm(actor);
      alarm.audioPrompts = this.getAudioPrompts(alarm);
      if (sirenSilenceResult) {
        alarm.lastSirenSilenceResult = sirenSilenceResult;
      }
      if (typeof alarm.save === 'function') {
        await alarm.save();
      }
      if (alarm.alarmState !== previousState) {
        requestSecurityAlarmAutomationEvaluation(`disarm to ${alarm.alarmState}`);
      }

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
  async dismissAlarm(userId, options = {}) {
    try {
      console.log('SecurityAlarmService: Dismissing triggered alarm');

      const alarm = await SecurityAlarm.getMainAlarm();
      if (alarm.alarmState !== 'triggered') {
        throw new Error('Alarm is not currently triggered');
      }

      const allowedReasons = new Set(['false_alarm', 'test', 'manual', 'custom']);
      const requestedReason = normalizeString(options.reason).toLowerCase();
      const dismissalReason = allowedReasons.has(requestedReason) ? requestedReason : 'false_alarm';
      const dismissalReasonText = dismissalReason === 'custom'
        ? normalizeString(options.customReason || options.reasonText || '').slice(0, 500)
        : normalizeString(options.customReason || options.reasonText || '').slice(0, 500);
      const pinRecord = await this.verifySecurityPin(alarm, 'disarm', options);
      const actor = this.resolveSecurityActor(userId, pinRecord, 'system:dismiss');
      const sirenSilenceResult = await this.clearTriggeredAlarm(alarm);

      await alarm.disarm(actor);
      alarm.lastDismissed = new Date();
      alarm.dismissedBy = actor;
      alarm.dismissalReason = dismissalReason;
      alarm.dismissalReasonText = dismissalReasonText;
      alarm.lastSirenSilenceResult = sirenSilenceResult;
      alarm.audioPrompts = this.getAudioPrompts(alarm);
      if (typeof alarm.save === 'function') {
        await alarm.save();
      }

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
  async getAlarmStatus(options = {}) {
    try {
      console.log('SecurityAlarmService: Getting alarm status');

      let alarm = await SecurityAlarm.getMainAlarm();
      alarm = await this.finalizeExpiredPendingArm(alarm);
      const now = Date.now();
      const lastSyncTimestamp = alarm.lastSyncWithSmartThings ? new Date(alarm.lastSyncWithSmartThings).getTime() : 0;
      const timeSinceLastSync = lastSyncTimestamp ? now - lastSyncTimestamp : Number.POSITIVE_INFINITY;
      const enabledPlatforms = this.getEnabledPlatforms(alarm);

      const isSmartThingsConfigured = enabledPlatforms.smartthings
        ? await this.isSmartThingsConfiguredForSthm()
        : false;
      const shouldAttemptSync = enabledPlatforms.smartthings
        && alarm.alarmState !== 'arming'
        && isSmartThingsConfigured
        && (timeSinceLastSync > STATUS_STALE_THRESHOLD_MS || !alarm.isOnline);

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
      const computedIsOnline = Boolean(alarm.isOnline)
        || enabledPlatforms.homebrain
        || updatedTimeSinceSync <= ONLINE_GRACE_PERIOD_MS;

      if (computedIsOnline !== alarm.isOnline) {
        alarm.isOnline = computedIsOnline;
        await alarm.save();
      }

      if (enabledPlatforms.smartthings) {
        try {
          await deviceService.ensureSmartThingsState({ immediate: false });
        } catch (deviceRefreshError) {
          console.warn('SecurityAlarmService: Security sensor refresh failed:', deviceRefreshError.message);
        }
      }

      let devices = await Device.find({}, SECURITY_STATUS_DEVICE_PROJECTION).lean();
      if (options.refreshDoorLocks && enabledPlatforms.smartthings) {
        devices = await this.refreshSmartThingsDoorLocks(devices);
      }
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
      const pendingArmReadyAt = alarm.pendingArmReadyAt || null;
      const pendingArmTimestamp = pendingArmReadyAt ? new Date(pendingArmReadyAt).getTime() : 0;
      const secondsUntilArmed = alarm.alarmState === 'arming' && pendingArmTimestamp > now
        ? Math.ceil((pendingArmTimestamp - now) / 1000)
        : 0;

      const status = {
        alarmState: alarm.alarmState,
        isArmed: ['armedStay', 'armedAway'].includes(alarm.alarmState),
        isArming: alarm.alarmState === 'arming',
        isTriggered: alarm.alarmState === 'triggered',
        enabledPlatforms,
        pinSettings: this.getPinSettings(alarm),
        exitDelaySeconds: this.normalizeExitDelaySeconds(alarm.exitDelay, DEFAULT_ARM_AWAY_EXIT_DELAY_SECONDS),
        entryDelaySeconds: this.normalizeExitDelaySeconds(alarm.entryDelay, 30),
        pendingArmMode: alarm.pendingArmMode || null,
        pendingArmStartedAt: alarm.pendingArmStartedAt || null,
        pendingArmReadyAt,
        secondsUntilArmed,
        lastArmed: alarm.lastArmed,
        lastDisarmed: alarm.lastDisarmed,
        lastTriggered: alarm.lastTriggered,
        lastDismissed: alarm.lastDismissed || null,
        armedBy: alarm.armedBy,
        disarmedBy: alarm.disarmedBy,
        dismissedBy: alarm.dismissedBy || null,
        dismissalReason: alarm.dismissalReason || null,
        dismissalReasonText: alarm.dismissalReasonText || '',
        lastSirenSilenceResult: alarm.lastSirenSilenceResult || null,
        audioPrompts: this.getAudioPrompts(alarm),
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
      if (!this.isPlatformEnabled(alarm, 'smartthings')) {
        console.log('SecurityAlarmService: SmartThings security platform disabled; keeping local state');
        return alarm;
      }
      if (alarm.alarmState === 'arming') {
        this.schedulePendingArm(alarm);
        console.log('SecurityAlarmService: Skipping SmartThings sync while away arming countdown is active');
        return alarm;
      }

      let synced = false;
      let alarmStateChanged = false;

      if (await this.isSmartThingsConfiguredForSthm()) {
        try {
          const securityState = await smartThingsService.getSecurityArmState();
          if (securityState?.armState) {
            const mappedState = this.mapSmartThingsArmState(securityState.armState);
            if (mappedState && mappedState !== alarm.alarmState) {
              alarm.alarmState = mappedState;
              alarmStateChanged = true;
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
            alarmStateChanged = true;
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
      if (alarmStateChanged) {
        requestSecurityAlarmAutomationEvaluation(`SmartThings sync to ${alarm.alarmState}`);
      }
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

  async updateSecurityPlatforms(platforms = {}) {
    try {
      console.log('SecurityAlarmService: Updating enabled security platforms');
      const result = await this.updateSecuritySettings({ enabledPlatforms: platforms });
      return result.alarm;
    } catch (error) {
      console.error('SecurityAlarmService: Error updating security platforms:', error.message);
      throw error;
    }
  }

  async updateSecuritySettings(settings = {}) {
    try {
      console.log('SecurityAlarmService: Updating security settings');

      const alarm = await SecurityAlarm.getMainAlarm();
      const currentPlatforms = this.getEnabledPlatforms(alarm);
      const platformSource = settings.enabledPlatforms && typeof settings.enabledPlatforms === 'object'
        ? settings.enabledPlatforms
        : settings;
      const nextPlatforms = {
        homebrain: typeof platformSource.homebrain === 'boolean' ? platformSource.homebrain : currentPlatforms.homebrain,
        smartthings: typeof platformSource.smartthings === 'boolean' ? platformSource.smartthings : currentPlatforms.smartthings
      };

      if (!nextPlatforms.homebrain && !nextPlatforms.smartthings) {
        throw new Error('At least one security platform must remain enabled');
      }

      const previousSettings = this.getSecuritySettingsFromAlarm(alarm);
      const previousPinSettings = this.getPinSettings(alarm);
      alarm.enabledPlatforms = nextPlatforms;

      if (
        Object.prototype.hasOwnProperty.call(settings, 'exitDelaySeconds') ||
        Object.prototype.hasOwnProperty.call(settings, 'exitDelay')
      ) {
        alarm.exitDelay = this.normalizeExitDelaySeconds(
          settings.exitDelaySeconds ?? settings.exitDelay,
          previousSettings.exitDelaySeconds
        );
      }

      if (
        Object.prototype.hasOwnProperty.call(settings, 'entryDelaySeconds') ||
        Object.prototype.hasOwnProperty.call(settings, 'entryDelay')
      ) {
        alarm.entryDelay = this.normalizeExitDelaySeconds(
          settings.entryDelaySeconds ?? settings.entryDelay,
          previousSettings.entryDelaySeconds
        );
      }

      if (
        Object.prototype.hasOwnProperty.call(settings, 'pins') ||
        Object.prototype.hasOwnProperty.call(settings, 'userCodes')
      ) {
        alarm.userCodes = await this.normalizePinRecords(
          alarm,
          settings.pins ?? settings.userCodes
        );
      }

      if (
        Object.prototype.hasOwnProperty.call(settings, 'pinSettings') ||
        Object.prototype.hasOwnProperty.call(settings, 'requireForArm') ||
        Object.prototype.hasOwnProperty.call(settings, 'requireForDisarm') ||
        Object.prototype.hasOwnProperty.call(settings, 'requirePinForArm') ||
        Object.prototype.hasOwnProperty.call(settings, 'requirePinForDisarm')
      ) {
        alarm.pinSettings = this.normalizePinSettings(settings, previousPinSettings);
      }

      const nextPinSettings = this.getPinSettings(alarm);
      if ((nextPinSettings.requireForArm || nextPinSettings.requireForDisarm) && !this.hasEnabledPin(alarm)) {
        throw buildSecurityAlarmError('At least one enabled security PIN is required before PIN enforcement can be enabled', 400);
      }

      await alarm.save();
      const updatedSettings = this.getSecuritySettingsFromAlarm(alarm);
      if (
        previousSettings.enabledPlatforms.homebrain !== updatedSettings.enabledPlatforms.homebrain ||
        previousSettings.enabledPlatforms.smartthings !== updatedSettings.enabledPlatforms.smartthings ||
        previousSettings.exitDelaySeconds !== updatedSettings.exitDelaySeconds ||
        previousSettings.entryDelaySeconds !== updatedSettings.entryDelaySeconds ||
        previousSettings.pinSettings.requireForArm !== updatedSettings.pinSettings.requireForArm ||
        previousSettings.pinSettings.requireForDisarm !== updatedSettings.pinSettings.requireForDisarm ||
        JSON.stringify(previousSettings.pins) !== JSON.stringify(updatedSettings.pins)
      ) {
        requestSecurityAlarmAutomationEvaluation('security settings updated');
      }

      return {
        alarm,
        settings: updatedSettings
      };
    } catch (error) {
      console.error('SecurityAlarmService: Error updating security settings:', error.message);
      throw error;
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

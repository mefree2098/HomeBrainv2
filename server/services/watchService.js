const User = require('../models/User');
const deviceService = require('./deviceService');
const securityAlarmService = require('./securityAlarmService');
const senseService = require('./senseService');
const weatherService = require('./weatherService');
const { normalizeWatchPreferences } = require('../utils/watchPreferences');

function toPlainDocument(value) {
  if (!value) {
    return null;
  }

  if (typeof value.toObject === 'function') {
    return value.toObject();
  }

  return { ...value };
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getDocumentId(value) {
  return normalizeString(value?._id?.toString?.() || value?._id || value?.id);
}

function normalizeCapability(value) {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value && typeof value === 'object') {
    return normalizeString(value.id || value.capabilityId || value.name);
  }

  return '';
}

function getCapabilitySet(device) {
  const properties = device?.properties || {};
  const capabilities = [
    ...(Array.isArray(properties.smartThingsCapabilities) ? properties.smartThingsCapabilities : []),
    ...(Array.isArray(properties.smartthingsCapabilities) ? properties.smartthingsCapabilities : [])
  ];

  return new Set(capabilities.map(normalizeCapability).filter(Boolean));
}

function getCategorySet(device) {
  const properties = device?.properties || {};
  const categories = [
    ...(Array.isArray(properties.smartThingsCategories) ? properties.smartThingsCategories : []),
    ...(Array.isArray(properties.smartthingsCategories) ? properties.smartthingsCategories : [])
  ];

  return new Set(categories.map(normalizeCapability).filter(Boolean).map((entry) => entry.toLowerCase()));
}

function looksLikeLightSwitch(device) {
  const descriptor = [
    device?.name,
    device?.model,
    device?.brand,
    device?.properties?.smartThingsDeviceTypeName,
    device?.properties?.smartThingsPresentationId
  ]
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .join(' ')
    .toLowerCase();

  return /\b(light|lamp|dimmer|sconce|chandelier|fixture)\b/.test(descriptor);
}

function isWatchLightDevice(device) {
  if (!device || typeof device !== 'object') {
    return false;
  }

  if (normalizeString(device.type).toLowerCase() === 'light') {
    return true;
  }

  if (normalizeString(device.type).toLowerCase() !== 'switch') {
    return false;
  }

  const capabilities = getCapabilitySet(device);
  const categories = getCategorySet(device);

  return categories.has('light')
    || capabilities.has('switchLevel')
    || capabilities.has('colorControl')
    || device?.properties?.supportsBrightness === true
    || looksLikeLightSwitch(device);
}

function isDimmableLight(device) {
  if (!device) {
    return false;
  }

  if (normalizeString(device.type).toLowerCase() === 'light') {
    return true;
  }

  const capabilities = getCapabilitySet(device);
  const properties = device.properties || {};
  return capabilities.has('switchLevel')
    || capabilities.has('colorControl')
    || properties.supportsBrightness === true
    || Number.isFinite(Number(device.brightness));
}

function buildAvailableRooms(lightDevices = []) {
  const rooms = new Map();

  for (const device of lightDevices) {
    const room = normalizeString(device?.room) || 'Unassigned';
    const existing = rooms.get(room) || {
      name: room,
      lightCount: 0,
      onlineCount: 0,
      onCount: 0,
      dimmableCount: 0
    };

    existing.lightCount += 1;
    if (device?.isOnline !== false) {
      existing.onlineCount += 1;
    }
    if (device?.status === true) {
      existing.onCount += 1;
    }
    if (isDimmableLight(device)) {
      existing.dimmableCount += 1;
    }

    rooms.set(room, existing);
  }

  return Array.from(rooms.values()).sort((left, right) => left.name.localeCompare(right.name, undefined, {
    sensitivity: 'base'
  }));
}

function resolvePrimaryRoom(config, availableRooms = []) {
  const requestedRoom = normalizeString(config?.primaryRoom);
  if (requestedRoom && availableRooms.some((room) => room.name === requestedRoom)) {
    return requestedRoom;
  }

  return availableRooms[0]?.name || requestedRoom || '';
}

function summarizeLightDevice(device) {
  return {
    id: getDocumentId(device),
    name: normalizeString(device?.name) || 'Unnamed light',
    room: normalizeString(device?.room) || 'Unassigned',
    type: normalizeString(device?.type) || 'light',
    isOn: device?.status === true,
    isOnline: device?.isOnline !== false,
    brightness: Number.isFinite(Number(device?.brightness)) ? Math.max(0, Math.min(100, Math.round(Number(device.brightness)))) : null,
    dimmable: isDimmableLight(device)
  };
}

function buildLightSection(config, lightDevices = []) {
  const room = normalizeString(config?.primaryRoom);
  const allowedIds = new Set(Array.isArray(config?.lightDeviceIds) ? config.lightDeviceIds : []);
  const roomDevices = lightDevices.filter((device) => {
    if (room && normalizeString(device?.room) !== room) {
      return false;
    }

    return allowedIds.size === 0 || allowedIds.has(getDocumentId(device));
  });
  const devices = roomDevices.map(summarizeLightDevice).filter((device) => device.id);
  const onDevices = devices.filter((device) => device.isOn);
  const dimmableDevices = devices.filter((device) => device.dimmable);
  const brightnessValues = devices
    .filter((device) => device.isOn)
    .map((device) => Number.isFinite(Number(device.brightness)) ? Number(device.brightness) : 100);
  const averageBrightness = brightnessValues.length > 0
    ? Math.round(brightnessValues.reduce((sum, value) => sum + value, 0) / brightnessValues.length)
    : 0;

  return {
    available: devices.length > 0,
    room,
    totalCount: devices.length,
    onCount: onDevices.length,
    onlineCount: devices.filter((device) => device.isOnline).length,
    dimmableCount: dimmableDevices.length,
    averageBrightness,
    defaultLightBrightness: config.defaultLightBrightness,
    devices
  };
}

function mapSecurityStateLabel(alarmState) {
  switch (alarmState) {
    case 'armedAway':
      return 'Armed Away';
    case 'armedStay':
      return 'Armed Stay';
    case 'triggered':
      return 'Triggered';
    case 'disarmed':
      return 'Disarmed';
    default:
      return 'Unknown';
  }
}

function buildSecuritySectionFromStatus(status) {
  return {
    available: true,
    alarmState: status.alarmState || 'unknown',
    stateLabel: mapSecurityStateLabel(status.alarmState),
    isArmed: status.isArmed === true,
    isTriggered: status.isTriggered === true,
    isOnline: status.isOnline !== false,
    sensorCount: Number(status.sensorCount) || 0,
    activeSensorCount: Number(status.activeSensorCount) || 0,
    attentionSensorCount: Number(status.attentionSensorCount) || 0,
    offlineSensorCount: Number(status.offlineSensorCount) || 0,
    lowBatterySensorCount: Number(status.lowBatterySensorCount) || 0,
    doorLockCount: Number(status.doorLockCount) || 0,
    unlockedDoorCount: Number(status.unlockedDoorCount) || 0,
    updatedAt: new Date().toISOString()
  };
}

function buildPowerSectionFromDashboard(dashboard) {
  const live = dashboard?.live || null;
  const trends = dashboard?.trends || {};
  const costs = dashboard?.costs || {};

  return {
    available: Boolean(live),
    monitorName: dashboard?.monitor?.name || 'Sense Monitor',
    observedAt: live?.observedAt || dashboard?.generatedAt || null,
    powerW: Number.isFinite(Number(live?.powerW)) ? Number(live.powerW) : null,
    solarW: Number.isFinite(Number(live?.solarW)) ? Number(live.solarW) : null,
    netW: Number.isFinite(Number(live?.netW)) ? Number(live.netW) : null,
    alwaysOnW: Number.isFinite(Number(live?.alwaysOnW)) ? Number(live.alwaysOnW) : null,
    activeDeviceCount: Number.isFinite(Number(live?.activeDeviceCount)) ? Number(live.activeDeviceCount) : null,
    currentCostUsdPerHour: Number.isFinite(Number(costs.currentUsdPerHour)) ? Number(costs.currentUsdPerHour) : null,
    dayKwh: Number.isFinite(Number(trends.day?.consumptionTotalKwh)) ? Number(trends.day.consumptionTotalKwh) : null,
    projectedMonthUsd: Number.isFinite(Number(costs.projectedMonthUsd)) ? Number(costs.projectedMonthUsd) : null,
    activeDevices: (Array.isArray(dashboard?.activeDevices) ? dashboard.activeDevices : [])
      .slice(0, 4)
      .map((device) => ({
        name: normalizeString(device?.name) || 'Device',
        powerW: Number.isFinite(Number(device?.powerW)) ? Number(device.powerW) : 0,
        sharePct: Number.isFinite(Number(device?.sharePct)) ? Number(device.sharePct) : null
      }))
  };
}

function buildWeatherSectionFromPayload(weather) {
  return {
    available: true,
    fetchedAt: weather?.fetchedAt || null,
    locationName: weather?.location?.name || 'Saved location',
    temperatureF: Number.isFinite(Number(weather?.current?.temperatureF)) ? Number(weather.current.temperatureF) : null,
    apparentTemperatureF: Number.isFinite(Number(weather?.current?.apparentTemperatureF)) ? Number(weather.current.apparentTemperatureF) : null,
    condition: weather?.current?.condition || 'Unknown',
    icon: weather?.current?.icon || 'cloudy',
    humidity: Number.isFinite(Number(weather?.current?.humidity)) ? Number(weather.current.humidity) : null,
    windSpeedMph: Number.isFinite(Number(weather?.current?.windSpeedMph)) ? Number(weather.current.windSpeedMph) : null,
    highF: Number.isFinite(Number(weather?.today?.highF)) ? Number(weather.today.highF) : null,
    lowF: Number.isFinite(Number(weather?.today?.lowF)) ? Number(weather.today.lowF) : null,
    precipitationChance: Number.isFinite(Number(weather?.today?.precipitationChance)) ? Number(weather.today.precipitationChance) : null
  };
}

class WatchService {
  async getUser(userId) {
    const user = await User.findById(userId);
    if (!user) {
      const error = new Error('User not found');
      error.status = 404;
      throw error;
    }

    return user;
  }

  async getLightDevices() {
    const devices = await deviceService.getAllDevices();
    return devices
      .map(toPlainDocument)
      .filter(isWatchLightDevice);
  }

  async getConfig(userId) {
    const [user, lightDevices] = await Promise.all([
      this.getUser(userId),
      this.getLightDevices()
    ]);
    const availableRooms = buildAvailableRooms(lightDevices);
    const normalized = normalizeWatchPreferences(user.watchPreferences);
    const config = {
      ...normalized,
      primaryRoom: resolvePrimaryRoom(normalized, availableRooms)
    };
    const selectedRoomDevices = lightDevices
      .filter((device) => !config.primaryRoom || normalizeString(device?.room) === config.primaryRoom)
      .map(summarizeLightDevice)
      .filter((device) => device.id);

    return {
      config,
      availableRooms,
      selectedRoomDevices
    };
  }

  async updateConfig(userId, payload = {}) {
    const user = await this.getUser(userId);
    const current = normalizeWatchPreferences(user.watchPreferences);
    const nextConfig = normalizeWatchPreferences({
      ...current,
      ...(payload && typeof payload === 'object' ? payload : {})
    });

    user.watchPreferences = nextConfig;
    await user.save();

    return this.getConfig(userId);
  }

  async buildSecuritySection() {
    try {
      const status = await securityAlarmService.getAlarmStatus();
      return buildSecuritySectionFromStatus(status);
    } catch (error) {
      return {
        available: false,
        error: error.message || 'Security status unavailable'
      };
    }
  }

  async buildPowerSection() {
    try {
      const dashboard = await senseService.getDashboard({ hours: 3 });
      return buildPowerSectionFromDashboard(dashboard);
    } catch (error) {
      return {
        available: false,
        error: error.message || 'Power summary unavailable'
      };
    }
  }

  async buildWeatherSection() {
    try {
      const weather = await weatherService.fetchDashboardWeather();
      return buildWeatherSectionFromPayload(weather);
    } catch (error) {
      return {
        available: false,
        error: error.message || 'Weather unavailable'
      };
    }
  }

  async getDashboard(userId) {
    const user = await this.getUser(userId);
    const lightDevices = await this.getLightDevices();
    const availableRooms = buildAvailableRooms(lightDevices);
    const normalized = normalizeWatchPreferences(user.watchPreferences);
    const config = {
      ...normalized,
      primaryRoom: resolvePrimaryRoom(normalized, availableRooms)
    };
    const enabledSections = new Set(config.sections);
    const sections = {
      security: enabledSections.has('security') ? await this.buildSecuritySection() : null,
      lights: enabledSections.has('lights') ? buildLightSection(config, lightDevices) : null,
      power: enabledSections.has('power') ? await this.buildPowerSection() : null,
      weather: enabledSections.has('weather') ? await this.buildWeatherSection() : null
    };

    return {
      generatedAt: new Date().toISOString(),
      user: {
        id: getDocumentId(user),
        name: user.name || '',
        email: user.email || ''
      },
      config,
      availableRooms,
      sections
    };
  }

  async controlSecurity(userId, action) {
    const user = await this.getUser(userId);
    const normalizedAction = normalizeString(action).toLowerCase().replace(/[^a-z]/g, '');

    if (normalizedAction === 'armaway') {
      await securityAlarmService.armAlarm('away', getDocumentId(user));
    } else if (normalizedAction === 'armstay') {
      await securityAlarmService.armAlarm('stay', getDocumentId(user));
    } else if (normalizedAction === 'disarm') {
      await securityAlarmService.disarmAlarm(getDocumentId(user));
    } else {
      const error = new Error('Unsupported watch security action');
      error.status = 400;
      throw error;
    }

    const status = await securityAlarmService.getAlarmStatus();
    return buildSecuritySectionFromStatus(status);
  }

  async controlLights(userId, payload = {}) {
    const { config } = await this.getConfig(userId);
    const lightDevices = await this.getLightDevices();
    const requestedRoom = normalizeString(payload.room) || config.primaryRoom;
    const action = normalizeString(payload.action).toLowerCase();
    const normalizedAction = action.replace(/[^a-z]/g, '');
    const supportedActions = new Set(['turnon', 'turnoff', 'setbrightness']);
    if (!supportedActions.has(normalizedAction)) {
      const error = new Error('Unsupported watch light action');
      error.status = 400;
      throw error;
    }

    const commandAction = normalizedAction === 'turnon'
      ? 'turn_on'
      : normalizedAction === 'turnoff'
        ? 'turn_off'
        : 'set_brightness';
    const brightness = Number.isFinite(Number(payload.brightness))
      ? Math.max(0, Math.min(100, Math.round(Number(payload.brightness))))
      : config.defaultLightBrightness;
    const commandValue = commandAction === 'turn_off' ? undefined : brightness;
    const allowedIds = new Set(config.lightDeviceIds);
    const targetDevices = lightDevices.filter((device) => {
      if (requestedRoom && normalizeString(device?.room) !== requestedRoom) {
        return false;
      }
      return allowedIds.size === 0 || allowedIds.has(getDocumentId(device));
    });

    if (targetDevices.length === 0) {
      const error = new Error('No watch light devices are available for this room');
      error.status = 404;
      throw error;
    }

    const results = [];
    for (const device of targetDevices) {
      try {
        const updatedDevice = await deviceService.controlDevice(
          getDocumentId(device),
          commandAction,
          commandValue,
          {
            command: {
              source: 'watchos',
              reason: `Apple Watch ${commandAction} command for ${requestedRoom || 'watch lights'}`,
              actor: String(userId)
            }
          }
        );
        results.push({
          deviceId: getDocumentId(device),
          success: true,
          device: summarizeLightDevice(toPlainDocument(updatedDevice))
        });
      } catch (error) {
        results.push({
          deviceId: getDocumentId(device),
          success: false,
          error: error.message || 'Light command failed'
        });
      }
    }

    const refreshedLightDevices = await this.getLightDevices();
    const nextConfig = {
      ...config,
      primaryRoom: requestedRoom
    };

    return {
      partialFailure: results.some((result) => !result.success),
      results,
      lights: buildLightSection(nextConfig, refreshedLightDevices)
    };
  }
}

const watchService = new WatchService();

module.exports = watchService;
module.exports.WatchService = WatchService;
module.exports.__private__ = {
  buildAvailableRooms,
  buildLightSection,
  buildPowerSectionFromDashboard,
  buildWeatherSectionFromPayload,
  isWatchLightDevice,
  normalizeCapability,
  summarizeLightDevice
};

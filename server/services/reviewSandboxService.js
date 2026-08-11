const EventEmitter = require('events');
const ReviewSandboxState = require('../models/ReviewSandboxState');

const SCHEMA_VERSION = 1;
const stateLocks = new Map();
const stateEmitters = new Map();
const blockedUserIds = new Set();

const IDS = Object.freeze({
  devices: Object.freeze({
    entryLamp: 'review-device-entry-lamp',
    livingLamp: 'review-device-living-lamp',
    patioLights: 'review-device-patio-lights',
    thermostat: 'review-device-thermostat',
    frontLock: 'review-device-front-lock',
    entrySensor: 'review-device-entry-sensor',
    hallMotion: 'review-device-hall-motion',
    garageDoor: 'review-device-garage-door',
    energy: 'review-device-energy-monitor',
  }),
  groups: Object.freeze({
    eveningLights: 'review-group-evening-lights',
    arrival: 'review-group-arrival',
  }),
  scenes: Object.freeze({
    welcome: 'review-scene-evening-welcome',
    goodNight: 'review-scene-good-night',
    energySaver: 'review-scene-energy-saver',
  }),
  workflows: Object.freeze({
    sunset: 'review-workflow-sunset-welcome',
    morning: 'review-workflow-morning-comfort',
    secure: 'review-workflow-secure-home',
  }),
  profile: 'review-profile-apple',
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function userId(userOrId) {
  return String(userOrId?._id || userOrId?.id || userOrId || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function buildDevice(id, name, type, room, overrides = {}) {
  const timestamp = nowIso();
  return {
    _id: id,
    id,
    name,
    type,
    room,
    groups: [],
    status: false,
    brightness: 0,
    color: '#ffffff',
    isOnline: true,
    brand: 'HomeBrain Virtual',
    model: 'App Review Fixture',
    lastSeen: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    properties: {
      source: 'review-sandbox',
      isVirtual: true,
      reviewFixture: true,
    },
    ...overrides,
    properties: {
      source: 'review-sandbox',
      isVirtual: true,
      reviewFixture: true,
      ...(overrides.properties || {}),
    },
  };
}

function buildWeather() {
  const fetchedAt = nowIso();
  const hourlyForecast = [
    { time: fetchedAt, temperatureF: 67, precipitationChance: 8, condition: 'Partly Cloudy', icon: 'partly-cloudy' },
    { time: new Date(Date.now() + 3600000).toISOString(), temperatureF: 69, precipitationChance: 10, condition: 'Partly Cloudy', icon: 'partly-cloudy' },
    { time: new Date(Date.now() + 7200000).toISOString(), temperatureF: 71, precipitationChance: 12, condition: 'Mostly Sunny', icon: 'clear-day' },
    { time: new Date(Date.now() + 10800000).toISOString(), temperatureF: 72, precipitationChance: 9, condition: 'Mostly Sunny', icon: 'clear-day' },
  ];

  return {
    fetchedAt,
    location: {
      name: 'HomeBrain Demo Home',
      source: 'saved',
      timezone: 'America/Denver',
    },
    current: {
      temperatureF: 67,
      apparentTemperatureF: 66,
      humidity: 41,
      windSpeedMph: 7,
      precipitationIn: 0,
      airQualityIndex: 32,
      isDay: true,
      condition: 'Partly Cloudy',
      icon: 'partly-cloudy',
    },
    today: {
      highF: 74,
      lowF: 49,
      precipitationChance: 12,
      sunrise: new Date(Date.now() - 4 * 3600000).toISOString(),
      sunset: new Date(Date.now() + 5 * 3600000).toISOString(),
      condition: 'Partly Cloudy',
    },
    hourlyForecast,
    tempest: { available: false },
    indoorAir: { available: false },
    sources: {
      outdoorClimate: {
        moduleName: 'Review Sandbox',
        provider: 'virtual',
        label: 'Synthetic forecast',
        deviceType: 'weather_station',
        available: true,
        live: true,
      },
    },
  };
}

function buildDefaultState(user = {}) {
  const timestamp = nowIso();
  const devices = [
    buildDevice(IDS.devices.entryLamp, 'Entry Lamp', 'light', 'Entryway', {
      status: true,
      brightness: 78,
      color: '#ffd8a8',
      groups: [IDS.groups.arrival],
      properties: { supportsBrightness: true, supportsColor: true },
    }),
    buildDevice(IDS.devices.livingLamp, 'Living Room Floor Lamp', 'light', 'Living Room', {
      status: true,
      brightness: 62,
      color: '#ffc98b',
      groups: [IDS.groups.eveningLights],
      properties: { supportsBrightness: true, supportsColor: true },
    }),
    buildDevice(IDS.devices.patioLights, 'Patio String Lights', 'light', 'Back Patio', {
      status: false,
      brightness: 45,
      color: '#fff0c2',
      groups: [IDS.groups.eveningLights],
      properties: { supportsBrightness: true, supportsColor: true },
    }),
    buildDevice(IDS.devices.thermostat, 'Demo Thermostat', 'thermostat', 'Living Room', {
      status: true,
      temperature: 70,
      targetTemperature: 72,
      properties: {
        hvacMode: 'heat',
        smartThingsThermostatMode: 'heat',
        smartThingsLastActiveThermostatMode: 'heat',
      },
    }),
    buildDevice(IDS.devices.frontLock, 'Front Door Lock', 'lock', 'Entryway', {
      status: true,
      properties: { lockState: 'locked' },
    }),
    buildDevice(IDS.devices.entrySensor, 'Front Door Contact', 'sensor', 'Entryway', {
      status: false,
      properties: {
        directRadioFeatures: ['contact'],
        directRadioState: { contactOpen: false, contact: 'closed' },
        securitySensorType: 'contact',
      },
    }),
    buildDevice(IDS.devices.hallMotion, 'Hall Motion Sensor', 'sensor', 'Hallway', {
      status: false,
      properties: {
        directRadioFeatures: ['motion'],
        directRadioState: { motionActive: false, motion: 'inactive' },
        securitySensorType: 'motion',
      },
    }),
    buildDevice(IDS.devices.garageDoor, 'Garage Door', 'garage', 'Garage', {
      status: false,
      properties: { garageState: 'closed' },
    }),
    buildDevice(IDS.devices.energy, 'Whole Home Energy', 'energy_monitor', 'Utility', {
      status: true,
      properties: {
        currentPowerWatts: 742,
        todayEnergyKwh: 5.8,
        projectedMonthUsd: 86.4,
      },
    }),
  ];

  const rooms = ['Unassigned', 'Entryway', 'Living Room', 'Back Patio', 'Hallway', 'Garage', 'Utility']
    .map((name, index) => {
      const deviceCount = devices.filter((device) => device.room === name).length;
      return {
        id: name === 'Unassigned' ? null : `review-room-${index}`,
        name,
        normalizedName: name.toLowerCase(),
        registered: name !== 'Unassigned',
        isDefault: name === 'Unassigned',
        deviceCount,
        wallPanelCount: 0,
        voiceDeviceCount: name === 'Living Room' ? 1 : 0,
        totalReferences: deviceCount + (name === 'Living Room' ? 1 : 0),
      };
    });

  const scenes = [
    {
      _id: IDS.scenes.welcome,
      id: IDS.scenes.welcome,
      name: 'Evening Welcome',
      description: 'Warm entry and living-room lighting for arriving home.',
      active: true,
      category: 'lighting',
      activationCount: 12,
      lastActivated: isoHoursAgo(2),
      deviceActions: [
        { deviceId: IDS.devices.entryLamp, action: 'turn_on' },
        { deviceId: IDS.devices.entryLamp, action: 'set_brightness', value: 78 },
        { deviceId: IDS.devices.livingLamp, action: 'turn_on' },
      ],
    },
    {
      _id: IDS.scenes.goodNight,
      id: IDS.scenes.goodNight,
      name: 'Good Night',
      description: 'Turns off shared lights, closes the garage, and locks the entry.',
      active: false,
      category: 'security',
      activationCount: 8,
      lastActivated: isoHoursAgo(11),
      deviceActions: [
        { deviceId: IDS.devices.entryLamp, action: 'turn_off' },
        { deviceId: IDS.devices.livingLamp, action: 'turn_off' },
        { deviceId: IDS.devices.patioLights, action: 'turn_off' },
        { deviceId: IDS.devices.frontLock, action: 'lock' },
        { deviceId: IDS.devices.garageDoor, action: 'close' },
      ],
    },
    {
      _id: IDS.scenes.energySaver,
      id: IDS.scenes.energySaver,
      name: 'Energy Saver',
      description: 'Reduces lighting and adjusts the thermostat for efficiency.',
      active: false,
      category: 'energy',
      activationCount: 5,
      lastActivated: isoHoursAgo(24),
      deviceActions: [
        { deviceId: IDS.devices.livingLamp, action: 'set_brightness', value: 35 },
        { deviceId: IDS.devices.thermostat, action: 'set_temperature', value: 68 },
      ],
    },
  ];

  const workflows = [
    {
      _id: IDS.workflows.sunset,
      id: IDS.workflows.sunset,
      name: 'Sunset Welcome',
      description: 'Activates Evening Welcome near sunset when the home is occupied.',
      enabled: true,
      category: 'lighting',
      priority: 5,
      executionCount: 9,
      lastRun: isoHoursAgo(22),
      source: 'review-sandbox',
      cooldown: 900,
      trigger: { type: 'schedule', conditions: { event: 'sunset', offsetMinutes: -15 } },
      actions: [{ type: 'scene', sceneId: IDS.scenes.welcome }],
      graph: {},
      voiceAliases: ['run sunset welcome'],
    },
    {
      _id: IDS.workflows.morning,
      id: IDS.workflows.morning,
      name: 'Morning Comfort',
      description: 'Sets a comfortable temperature and gently raises the entry light.',
      enabled: true,
      category: 'climate',
      priority: 4,
      executionCount: 14,
      lastRun: isoHoursAgo(6),
      source: 'review-sandbox',
      cooldown: 600,
      trigger: { type: 'schedule', conditions: { time: '07:00' } },
      actions: [
        { type: 'device', deviceId: IDS.devices.thermostat, action: 'set_temperature', value: 71 },
        { type: 'device', deviceId: IDS.devices.entryLamp, action: 'set_brightness', value: 45 },
      ],
      graph: {},
      voiceAliases: ['run morning comfort'],
    },
    {
      _id: IDS.workflows.secure,
      id: IDS.workflows.secure,
      name: 'Secure Home',
      description: 'Locks the front door and closes the garage when requested.',
      enabled: true,
      category: 'security',
      priority: 8,
      executionCount: 4,
      lastRun: isoHoursAgo(4),
      source: 'review-sandbox',
      cooldown: 30,
      trigger: { type: 'manual', conditions: {} },
      actions: [
        { type: 'device', deviceId: IDS.devices.frontLock, action: 'lock' },
        { type: 'device', deviceId: IDS.devices.garageDoor, action: 'close' },
      ],
      graph: {},
      voiceAliases: ['secure the demo home'],
    },
  ];

  return {
    fixtureVersion: SCHEMA_VERSION,
    label: 'Apple App Review Sandbox',
    createdFor: userId(user),
    createdAt: timestamp,
    updatedAt: timestamp,
    devices,
    rooms,
    groups: [
      {
        _id: IDS.groups.eveningLights,
        id: IDS.groups.eveningLights,
        name: 'Evening Lights',
        description: 'Living room and patio lighting.',
        deviceIds: [IDS.devices.livingLamp, IDS.devices.patioLights],
        childGroupIds: [],
      },
      {
        _id: IDS.groups.arrival,
        id: IDS.groups.arrival,
        name: 'Arrival',
        description: 'Entry lighting plus the evening-light group.',
        deviceIds: [IDS.devices.entryLamp],
        childGroupIds: [IDS.groups.eveningLights],
      },
    ],
    scenes,
    workflows,
    workflowHistory: [],
    profile: {
      _id: IDS.profile,
      id: IDS.profile,
      name: 'Apple Review',
      wakeWords: ['Hey HomeBrain'],
      voiceId: 'review-voice',
      voiceName: 'HomeBrain Demo Voice',
      active: true,
      lastUsed: isoHoursAgo(1),
      favorites: {
        devices: [IDS.devices.entryLamp, IDS.devices.livingLamp, IDS.devices.thermostat, IDS.devices.frontLock],
        scenes: [IDS.scenes.welcome, IDS.scenes.goodNight],
      },
      securityVisibleSensors: [IDS.devices.entrySensor, IDS.devices.hallMotion],
      dashboardViews: [
        {
          id: 'review-dashboard-main',
          name: 'Demo Home',
          widgets: [
            { id: 'review-widget-hero', type: 'hero', title: 'Welcome Home', size: 'full', minimized: false, settings: {} },
            { id: 'review-widget-summary', type: 'summary', title: 'System Summary', size: 'full', minimized: false, settings: {} },
            { id: 'review-widget-security', type: 'security', title: 'Security Center', size: 'medium', minimized: false, settings: {} },
            { id: 'review-widget-scenes', type: 'favorite-scenes', title: 'Quick Scenes', size: 'large', minimized: false, settings: {} },
            { id: 'review-widget-weather', type: 'weather', title: 'Demo Weather', size: 'medium', minimized: false, settings: { weatherLocationMode: 'saved' } },
            { id: 'review-widget-devices', type: 'favorite-devices', title: 'Favorite Devices', size: 'large', minimized: false, settings: {} },
          ],
        },
      ],
    },
    voiceDevices: [
      {
        _id: 'review-voice-device-living-room',
        id: 'review-voice-device-living-room',
        name: 'Living Room Voice Orb',
        room: 'Living Room',
        deviceType: 'speaker',
        status: 'online',
        batteryLevel: null,
        volume: 55,
        microphoneSensitivity: 60,
        firmwareVersion: 'Review 1.0',
        lastSeen: timestamp,
      },
    ],
    security: {
      alarmState: 'disarmed',
      exitDelaySeconds: 30,
      secondsUntilArmed: 0,
      enabledPlatforms: { homebrain: true, smartthings: false },
      pinSettings: { requireForArm: false, requireForDisarm: false },
    },
    notifications: [
      {
        _id: 'review-notification-energy',
        id: 'review-notification-energy',
        channel: 'normal',
        severity: 'info',
        category: 'automation',
        source: 'review-sandbox',
        title: 'Energy Saver completed',
        message: 'The virtual thermostat and living-room light were adjusted.',
        occurredAt: isoHoursAgo(1),
        clearedAt: null,
        resolvedAt: null,
        resolvedReason: '',
      },
      {
        _id: 'review-notification-door',
        id: 'review-notification-door',
        channel: 'normal',
        severity: 'info',
        category: 'security',
        source: 'review-sandbox',
        title: 'Front door secured',
        message: 'The virtual front-door lock is locked.',
        occurredAt: isoHoursAgo(3),
        clearedAt: null,
        resolvedAt: null,
        resolvedReason: '',
      },
    ],
    watchConfig: {
      sections: ['security', 'lights', 'weather', 'power'],
      primaryRoom: 'Living Room',
      lightDeviceIds: [IDS.devices.entryLamp, IDS.devices.livingLamp, IDS.devices.patioLights],
      defaultLightBrightness: 70,
    },
    events: [
      {
        id: 'review-event-3',
        sequence: 3,
        type: 'automation.completed',
        source: 'review-sandbox',
        category: 'automation',
        severity: 'info',
        correlationId: 'review-seed',
        createdAt: isoHoursAgo(1),
        payload: { message: 'Energy Saver completed successfully.' },
      },
      {
        id: 'review-event-2',
        sequence: 2,
        type: 'security.locked',
        source: 'review-sandbox',
        category: 'security',
        severity: 'info',
        correlationId: 'review-seed',
        createdAt: isoHoursAgo(3),
        payload: { message: 'Virtual front door secured.' },
      },
      {
        id: 'review-event-1',
        sequence: 1,
        type: 'sandbox.ready',
        source: 'review-sandbox',
        category: 'system',
        severity: 'info',
        correlationId: 'review-seed',
        createdAt: isoHoursAgo(24),
        payload: { message: 'Apple review sandbox ready.' },
      },
    ],
  };
}

function summarizeState(state) {
  return {
    label: state.label,
    fixtureVersion: state.fixtureVersion,
    counts: {
      devices: state.devices.length,
      rooms: state.rooms.filter((room) => !room.isDefault).length,
      groups: state.groups.length,
      scenes: state.scenes.length,
      workflows: state.workflows.length,
      notifications: state.notifications.length,
    },
    names: {
      rooms: state.rooms.filter((room) => !room.isDefault).map((room) => room.name),
      groups: state.groups.map((group) => group.name),
      scenes: state.scenes.map((scene) => scene.name),
      workflows: state.workflows.map((workflow) => workflow.name),
    },
  };
}

async function getOrCreateState(user, options = {}) {
  const id = userId(user);
  if (!id) {
    const error = new Error('Review sandbox user is required');
    error.status = 400;
    throw error;
  }
  if (blockedUserIds.has(id)) {
    const error = new Error('Review sandbox account is no longer available');
    error.status = 410;
    throw error;
  }

  const reset = options.reset === true;
  if (reset) {
    return ReviewSandboxState.findOneAndUpdate(
      { userId: id },
      {
        $set: {
          schemaVersion: SCHEMA_VERSION,
          state: buildDefaultState(user),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).exec();
  }

  let document = await ReviewSandboxState.findOne({ userId: id }).exec();
  if (document && document.schemaVersion === SCHEMA_VERSION) {
    return document;
  }

  if (document) {
    document.schemaVersion = SCHEMA_VERSION;
    document.state = buildDefaultState(user);
    document.markModified('state');
    await document.save();
    return document;
  }

  try {
    return await ReviewSandboxState.create({
      userId: id,
      schemaVersion: SCHEMA_VERSION,
      state: buildDefaultState(user),
    });
  } catch (error) {
    if (error?.code === 11000) {
      return ReviewSandboxState.findOne({ userId: id }).exec();
    }
    throw error;
  }
}

function stateEmitter(id) {
  const key = userId(id);
  if (!stateEmitters.has(key)) {
    stateEmitters.set(key, new EventEmitter());
  }
  return stateEmitters.get(key);
}

async function withState(user, mutator) {
  const id = userId(user);
  return withUserLock(id, async () => {
    const document = await getOrCreateState(user);
    const state = clone(document.state);
    const result = await mutator(state);
    state.updatedAt = nowIso();
    document.state = state;
    document.markModified('state');
    await document.save();
    return { state, result };
  });
}

async function withUserLock(userOrId, operation) {
  const id = userId(userOrId);
  const previous = stateLocks.get(id) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(operation);

  stateLocks.set(id, current);
  current.finally(() => {
    if (stateLocks.get(id) === current) {
      stateLocks.delete(id);
    }
  }).catch(() => undefined);
  return current;
}

async function provisionForUser(user, options = {}) {
  if (options.reset === true) {
    return withUserLock(user, async () => {
      blockedUserIds.delete(userId(user));
      const document = await getOrCreateState(user, { reset: true });
      return summarizeState(document.state);
    });
  }
  const document = await getOrCreateState(user);
  return summarizeState(document.state);
}

async function deleteForUser(userOrId) {
  const id = userId(userOrId);
  if (!id) return { deletedCount: 0 };
  return withUserLock(id, async () => {
    blockedUserIds.add(id);
    stateEmitters.delete(id);
    return ReviewSandboxState.deleteOne({ userId: id }).exec();
  });
}

function findById(items, id) {
  return items.find((item) => String(item._id || item.id) === String(id));
}

function numericValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function controlDeviceInState(state, deviceId, action, value) {
  const device = findById(state.devices, deviceId);
  if (!device) {
    const error = new Error('Virtual device not found');
    error.status = 404;
    throw error;
  }

  switch (String(action || '').trim().toLowerCase()) {
    case 'turn_on':
    case 'on':
      device.status = true;
      if (device.type === 'light' && device.brightness <= 0) device.brightness = 70;
      break;
    case 'turn_off':
    case 'off':
      device.status = false;
      break;
    case 'toggle':
      device.status = !device.status;
      break;
    case 'set_brightness':
      device.brightness = Math.max(0, Math.min(100, numericValue(value)));
      device.status = device.brightness > 0;
      break;
    case 'set_color':
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.trim())) {
        const error = new Error('Color must be a six-digit hex value');
        error.status = 400;
        throw error;
      }
      device.color = value.trim().toLowerCase();
      device.status = true;
      break;
    case 'set_temperature':
      device.targetTemperature = Math.max(50, Math.min(90, numericValue(value, 70)));
      device.status = true;
      break;
    case 'set_mode': {
      const mode = String(value || 'off').trim().toLowerCase();
      device.properties.hvacMode = mode;
      device.properties.smartThingsThermostatMode = mode;
      device.status = mode !== 'off';
      break;
    }
    case 'lock':
      device.status = true;
      device.properties.lockState = 'locked';
      break;
    case 'unlock':
      device.status = false;
      device.properties.lockState = 'unlocked';
      break;
    case 'open':
      device.status = true;
      device.properties.garageState = 'open';
      break;
    case 'close':
      device.status = false;
      device.properties.garageState = 'closed';
      break;
    default: {
      const error = new Error('Unsupported virtual device action');
      error.status = 400;
      throw error;
    }
  }

  device.lastSeen = nowIso();
  device.updatedAt = device.lastSeen;
  return device;
}

function addEvent(state, input) {
  const sequence = Math.max(0, ...state.events.map((event) => Number(event.sequence) || 0)) + 1;
  const event = {
    id: `review-event-${sequence}`,
    sequence,
    type: input.type || 'sandbox.updated',
    source: 'review-sandbox',
    category: input.category || 'system',
    severity: input.severity || 'info',
    correlationId: input.correlationId || `review-${sequence}`,
    createdAt: nowIso(),
    payload: input.payload || {},
  };
  state.events.unshift(event);
  state.events = state.events.slice(0, 100);
  return event;
}

function notificationCounts(state) {
  return state.notifications.reduce((counts, notification) => {
    if (notification.clearedAt || notification.resolvedAt) return counts;
    const channel = notification.channel === 'securityCritical' ? 'securityCritical' : 'normal';
    counts[channel] += 1;
    return counts;
  }, { normal: 0, securityCritical: 0 });
}

function securityStatus(state) {
  const sensorDevices = state.devices.filter((device) => device.type === 'sensor');
  const lockDevices = state.devices.filter((device) => device.type === 'lock');
  const sensors = sensorDevices.map((device) => {
    const sensorType = device.properties.securitySensorType || 'security';
    const isActive = device.status === true;
    return {
      id: device._id,
      deviceId: device._id,
      localDeviceId: device._id,
      source: 'review-sandbox',
      sourceLabel: 'Virtual review device',
      name: device.name,
      room: device.room,
      sensorType,
      sensorTypeLabel: sensorType === 'contact' ? 'Contact' : sensorType === 'motion' ? 'Motion' : 'Sensor',
      isAvailable: true,
      isOnline: device.isOnline,
      isActive,
      isBypassed: false,
      bypassable: true,
      armedStayEnabled: true,
      armedAwayEnabled: true,
      monitoredModes: ['armedStay', 'armedAway'],
      stateLabel: sensorType === 'contact'
        ? (isActive ? 'Open' : 'Closed')
        : (isActive ? 'Motion detected' : 'Clear'),
      lastSeen: device.lastSeen,
      requiresAttention: false,
    };
  });
  const doorLocks = lockDevices.map((device) => ({
    id: device._id,
    deviceId: device._id,
    localDeviceId: device._id,
    source: 'review-sandbox',
    name: device.name,
    room: device.room,
    isLocked: device.status === true,
    isOnline: device.isOnline,
    stateLabel: device.status ? 'Locked' : 'Unlocked',
    lastSeen: device.lastSeen,
  }));
  const activeSensorCount = sensors.filter((sensor) => sensor.isActive).length;
  const alarmState = state.security.alarmState;

  return {
    alarmState,
    isArmed: alarmState === 'armedStay' || alarmState === 'armedAway',
    isTriggered: alarmState === 'triggered',
    isOnline: true,
    zoneCount: sensors.length,
    sensorCount: sensors.length,
    activeSensorCount,
    attentionSensorCount: 0,
    offlineSensorCount: 0,
    lowBatterySensorCount: 0,
    doorLockCount: doorLocks.length,
    unlockedDoorCount: doorLocks.filter((lock) => !lock.isLocked).length,
    zones: sensors.map((sensor) => ({ ...sensor, active: sensor.isActive })),
    sensors,
    doorLocks,
    sirenOutputs: [],
    exitDelaySeconds: state.security.exitDelaySeconds,
    secondsUntilArmed: state.security.secondsUntilArmed,
    enabledPlatforms: clone(state.security.enabledPlatforms),
    pinSettings: clone(state.security.pinSettings),
    audioPrompts: {},
    updatedAt: nowIso(),
  };
}

function lightSummary(device) {
  return {
    id: device._id,
    name: device.name,
    room: device.room,
    type: device.type,
    isOn: device.status === true,
    isOnline: device.isOnline !== false,
    brightness: numericValue(device.brightness),
    dimmable: true,
  };
}

function watchConfigPayload(state) {
  const lights = state.devices.filter((device) => device.type === 'light');
  const roomNames = Array.from(new Set(lights.map((device) => device.room)));
  const availableRooms = roomNames.map((name) => {
    const roomLights = lights.filter((device) => device.room === name);
    return {
      name,
      lightCount: roomLights.length,
      onlineCount: roomLights.filter((device) => device.isOnline).length,
      onCount: roomLights.filter((device) => device.status).length,
      dimmableCount: roomLights.length,
    };
  });
  const availableLightDevices = lights.map(lightSummary);
  const selected = new Set(state.watchConfig.lightDeviceIds);
  return {
    config: clone(state.watchConfig),
    availableRooms,
    availableLightDevices,
    selectedRoomDevices: availableLightDevices.filter((device) => selected.has(device.id)),
  };
}

function watchDashboard(state, user = {}) {
  const weather = buildWeather();
  const security = securityStatus(state);
  const config = watchConfigPayload(state);
  const selectedLights = config.selectedRoomDevices;
  const room = state.watchConfig.primaryRoom;
  const roomDevices = selectedLights.filter((device) => device.room === room);
  return {
    generatedAt: nowIso(),
    user: {
      id: userId(user),
      name: user.name || 'Apple App Review',
      email: user.email || '',
    },
    config: clone(state.watchConfig),
    availableRooms: config.availableRooms,
    sections: {
      security: {
        available: true,
        alarmState: security.alarmState,
        stateLabel: security.alarmState === 'disarmed' ? 'Disarmed' : security.alarmState === 'armedAway' ? 'Armed Away' : 'Armed Stay',
        isArmed: security.isArmed,
        isTriggered: security.isTriggered,
        isOnline: true,
        sensorCount: security.sensorCount,
        activeSensorCount: security.activeSensorCount,
        attentionSensorCount: 0,
        offlineSensorCount: 0,
        lowBatterySensorCount: 0,
        doorLockCount: security.doorLockCount,
        unlockedDoorCount: security.unlockedDoorCount,
        updatedAt: nowIso(),
      },
      lights: {
        available: roomDevices.length > 0,
        name: room,
        room,
        totalCount: roomDevices.length,
        onCount: roomDevices.filter((device) => device.isOn).length,
        onlineCount: roomDevices.filter((device) => device.isOnline).length,
        dimmableCount: roomDevices.length,
        averageBrightness: roomDevices.length
          ? Math.round(roomDevices.reduce((sum, device) => sum + device.brightness, 0) / roomDevices.length)
          : 0,
        defaultLightBrightness: state.watchConfig.defaultLightBrightness,
        devices: roomDevices,
        rooms: config.availableRooms.map((roomSummary) => ({
          ...roomSummary,
          available: roomSummary.lightCount > 0,
          room: roomSummary.name,
          totalCount: roomSummary.lightCount,
          averageBrightness: 0,
          defaultLightBrightness: state.watchConfig.defaultLightBrightness,
          devices: selectedLights.filter((device) => device.room === roomSummary.name),
        })),
      },
      weather: {
        available: true,
        fetchedAt: weather.fetchedAt,
        locationName: weather.location.name,
        temperatureF: weather.current.temperatureF,
        apparentTemperatureF: weather.current.apparentTemperatureF,
        condition: weather.current.condition,
        icon: weather.current.icon,
        humidity: weather.current.humidity,
        windSpeedMph: weather.current.windSpeedMph,
        highF: weather.today.highF,
        lowF: weather.today.lowF,
        precipitationChance: weather.today.precipitationChance,
      },
      power: {
        available: true,
        monitorName: 'Whole Home Energy',
        observedAt: nowIso(),
        powerW: 742,
        solarW: 0,
        netW: 742,
        alwaysOnW: 118,
        activeDeviceCount: 4,
        currentCostUsdPerHour: 0.11,
        dayKwh: 5.8,
        projectedMonthUsd: 86.4,
        activeDevices: [
          { name: 'Demo Thermostat', powerW: 418, sharePct: 56 },
          { name: 'Living Room Floor Lamp', powerW: 42, sharePct: 6 },
        ],
      },
    },
  };
}

function sendError(res, error) {
  return res.status(error?.status || 500).json({
    success: false,
    error: error?.message || 'Review sandbox request failed',
    message: error?.message || 'Review sandbox request failed',
  });
}

function workflowStats(state) {
  return {
    total: state.workflows.length,
    enabled: state.workflows.filter((workflow) => workflow.enabled).length,
    disabled: state.workflows.filter((workflow) => !workflow.enabled).length,
    totalExecutions: state.workflows.reduce((sum, workflow) => sum + numericValue(workflow.executionCount), 0),
    successfulExecutions: state.workflows.reduce((sum, workflow) => sum + numericValue(workflow.executionCount), 0),
    failedExecutions: 0,
    successRate: 100,
  };
}

async function activateScene(user, sceneId, active) {
  const mutation = await withState(user, (state) => {
    const scene = findById(state.scenes, sceneId);
    if (!scene) {
      const error = new Error('Virtual scene not found');
      error.status = 404;
      throw error;
    }

    const actionResults = [];
    if (active) {
      for (const action of scene.deviceActions || []) {
        const device = controlDeviceInState(state, action.deviceId, action.action, action.value);
        actionResults.push({ success: true, deviceId: device._id, action: action.action });
      }
      scene.activationCount = numericValue(scene.activationCount) + 1;
      scene.lastActivated = nowIso();
    }
    scene.active = active;
    addEvent(state, {
      type: active ? 'scene.activated' : 'scene.deactivated',
      category: 'automation',
      payload: { message: `${scene.name} ${active ? 'activated' : 'deactivated'}.`, sceneId: scene._id },
    });
    return { scene: clone(scene), actionResults };
  });
  stateEmitter(user).emit('devices:update', clone(mutation.state.devices));
  return mutation.result;
}

async function executeWorkflow(user, workflowId) {
  const mutation = await withState(user, (state) => {
    const workflow = findById(state.workflows, workflowId);
    if (!workflow) {
      const error = new Error('Virtual workflow not found');
      error.status = 404;
      throw error;
    }
    if (!workflow.enabled) {
      const error = new Error('Virtual workflow is disabled');
      error.status = 400;
      throw error;
    }

    for (const action of workflow.actions || []) {
      if (action.type === 'device') {
        controlDeviceInState(state, action.deviceId, action.action, action.value);
      }
      if (action.type === 'scene') {
        const scene = findById(state.scenes, action.sceneId);
        if (scene) {
          for (const deviceAction of scene.deviceActions || []) {
            controlDeviceInState(state, deviceAction.deviceId, deviceAction.action, deviceAction.value);
          }
          scene.active = true;
          scene.activationCount = numericValue(scene.activationCount) + 1;
          scene.lastActivated = nowIso();
        }
      }
    }

    workflow.executionCount = numericValue(workflow.executionCount) + 1;
    workflow.lastRun = nowIso();
    const historyId = `review-execution-${Date.now()}`;
    const runtimeEvent = {
      type: 'automation.completed',
      level: 'info',
      message: `${workflow.name} completed successfully.`,
      details: { workflowId: workflow._id, correlationId: historyId },
      createdAt: workflow.lastRun,
    };
    const actionResults = (workflow.actions || []).map((action, actionIndex) => ({
      actionIndex,
      actionType: action.type === 'scene' ? 'scene_activate' : 'device_control',
      target: action.sceneId || action.deviceId || null,
      success: true,
      message: 'Virtual action completed successfully.',
      executedAt: workflow.lastRun,
      durationMs: 60,
    }));
    const history = {
      _id: historyId,
      id: historyId,
      automationId: workflow._id,
      automationName: workflow.name,
      workflowId: workflow._id,
      workflowName: workflow.name,
      status: 'success',
      triggerType: 'manual',
      triggerSource: 'manual',
      triggerContext: {},
      correlationId: historyId,
      startedAt: workflow.lastRun,
      completedAt: workflow.lastRun,
      durationMs: 180,
      totalActions: (workflow.actions || []).length,
      successfulActions: (workflow.actions || []).length,
      failedActions: 0,
      currentAction: null,
      lastEvent: runtimeEvent,
      actionResults,
      runtimeEvents: [runtimeEvent],
      error: {},
    };
    state.workflowHistory.unshift(history);
    state.workflowHistory = state.workflowHistory.slice(0, 50);
    addEvent(state, {
      type: 'automation.completed',
      category: 'automation',
      correlationId: historyId,
      payload: { message: `${workflow.name} completed successfully.`, workflowId: workflow._id },
    });
    return { workflow: clone(workflow), history: clone(history) };
  });
  stateEmitter(user).emit('devices:update', clone(mutation.state.devices));
  return mutation.result;
}

function isPassThroughPath(path, method) {
  return method === 'POST' && path === '/watch/session';
}

function canonicalApiPath(req) {
  const raw = String(req?.originalUrl || req?.url || req?.path || '/').split('?', 1)[0] || '/';
  const withoutApiPrefix = raw === '/api' ? '/' : raw.startsWith('/api/') ? raw.slice('/api'.length) : raw;
  return withoutApiPrefix.startsWith('/') ? withoutApiPrefix : `/${withoutApiPrefix}`;
}

async function handleRequest(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  const path = canonicalApiPath(req);
  const user = req.user;

  try {
    if (isPassThroughPath(path, method)) {
      return false;
    }

    const document = await getOrCreateState(user);
    const state = clone(document.state);

    if (method === 'GET' && path === '/devices') {
      let devices = state.devices;
      for (const key of ['room', 'type']) {
        const value = typeof req.query?.[key] === 'string' ? req.query[key].trim().toLowerCase() : '';
        if (value) devices = devices.filter((device) => String(device[key] || '').toLowerCase() === value);
      }
      if (req.query?.status !== undefined) devices = devices.filter((device) => device.status === (req.query.status === 'true'));
      if (req.query?.isOnline !== undefined) devices = devices.filter((device) => device.isOnline === (req.query.isOnline === 'true'));
      return res.status(200).json({ success: true, message: 'Virtual devices fetched successfully', data: { devices } });
    }

    if (method === 'GET' && path === '/devices/stats') {
      const byType = state.devices.reduce((result, device) => {
        result[device.type] = (result[device.type] || 0) + 1;
        return result;
      }, {});
      return res.status(200).json({
        success: true,
        message: 'Virtual device statistics fetched successfully',
        data: { stats: { total: state.devices.length, online: state.devices.length, offline: 0, on: state.devices.filter((device) => device.status).length, byType } },
      });
    }

    if (method === 'GET' && path === '/devices/by-room') {
      const rooms = state.rooms.filter((room) => !room.isDefault).map((room) => ({
        room: room.name,
        name: room.name,
        devices: state.devices.filter((device) => device.room === room.name),
      }));
      return res.status(200).json({ success: true, message: 'Virtual devices by room fetched successfully', data: { rooms } });
    }

    let match = path.match(/^\/devices\/([^/]+)\/energy-history$/);
    if (method === 'GET' && match) {
      const device = findById(state.devices, match[1]);
      if (!device) return res.status(404).json({ success: false, error: 'Virtual device not found' });
      const hours = Math.max(1, Math.min(24 * 30, Math.round(numericValue(req.query?.hours, 24))));
      const limit = Math.max(1, Math.min(5000, Math.round(numericValue(req.query?.limit, 720))));
      const sampleCount = Math.min(6, limit, Math.max(1, Math.ceil(hours)));
      const samples = Array.from({ length: sampleCount }, (_, index) => index)
        .map((hoursAgo, index) => ({
          recordedAt: isoHoursAgo(hoursAgo),
          source: 'review-sandbox',
          power: {
            value: Math.max(18, 742 - index * 58),
            unit: 'W',
            timestamp: isoHoursAgo(hoursAgo),
          },
          energy: {
            value: Math.max(0.2, 5.8 - index * 0.8),
            unit: 'kWh',
            timestamp: isoHoursAgo(hoursAgo),
          },
        }))
        .reverse();
      return res.status(200).json({ success: true, data: { deviceId: device._id, hours, count: samples.length, samples } });
    }

    match = path.match(/^\/devices\/([^/]+)$/);
    if (method === 'GET' && match) {
      const device = findById(state.devices, match[1]);
      return device
        ? res.status(200).json({ success: true, message: 'Virtual device fetched successfully', data: { device } })
        : res.status(404).json({ success: false, error: 'Virtual device not found' });
    }

    if (method === 'POST' && (path === '/devices/control' || /^\/devices\/[^/]+\/control$/.test(path))) {
      const deviceId = path === '/devices/control' ? req.body?.deviceId : path.split('/')[2];
      const mutation = await withState(user, (nextState) => clone(controlDeviceInState(nextState, deviceId, req.body?.action, req.body?.value)));
      stateEmitter(user).emit('devices:update', [clone(mutation.result)]);
      return res.status(200).json({ success: true, message: 'Virtual device controlled successfully', data: { device: mutation.result } });
    }

    if (method === 'GET' && path === '/rooms') {
      return res.status(200).json({ success: true, message: 'Virtual rooms fetched successfully', data: { rooms: state.rooms } });
    }

    if (method === 'GET' && path === '/device-groups') {
      return res.status(200).json({ success: true, message: 'Virtual device groups fetched successfully', data: { groups: state.groups } });
    }
    match = path.match(/^\/device-groups\/([^/]+)$/);
    if (method === 'GET' && match) {
      const group = findById(state.groups, match[1]);
      return group
        ? res.status(200).json({ success: true, data: { group } })
        : res.status(404).json({ success: false, error: 'Virtual device group not found' });
    }

    if (method === 'GET' && path === '/scenes') {
      return res.status(200).json({ success: true, scenes: state.scenes, count: state.scenes.length });
    }
    if (method === 'GET' && path === '/scenes/stats') {
      return res.status(200).json({ success: true, stats: { total: state.scenes.length, active: state.scenes.filter((scene) => scene.active).length, totalActivations: state.scenes.reduce((sum, scene) => sum + numericValue(scene.activationCount), 0) } });
    }
    if (method === 'POST' && (path === '/scenes/activate' || path === '/scenes/deactivate')) {
      const active = path.endsWith('/activate');
      const result = await activateScene(user, req.body?.sceneId, active);
      return res.status(200).json({ success: true, message: `${result.scene.name} ${active ? 'activated' : 'deactivated'}`, scene: result.scene, deviceActions: [], groupActions: [], actionResults: result.actionResults, status: 'completed' });
    }
    match = path.match(/^\/scenes\/([^/]+)$/);
    if (method === 'GET' && match) {
      const scene = findById(state.scenes, match[1]);
      return scene ? res.status(200).json({ success: true, scene }) : res.status(404).json({ success: false, error: 'Virtual scene not found' });
    }

    if (method === 'GET' && path === '/workflows') {
      return res.status(200).json({ success: true, workflows: state.workflows, count: state.workflows.length });
    }
    if (method === 'GET' && path === '/workflows/stats') {
      return res.status(200).json({ success: true, stats: workflowStats(state) });
    }
    if (method === 'GET' && path === '/workflows/running') {
      return res.status(200).json({ success: true, executions: [], count: 0 });
    }
    if (method === 'GET' && path === '/workflows/runtime-history') {
      const limit = Math.max(1, Math.min(100, Math.round(numericValue(req.query?.limit, 50))));
      const page = Math.max(1, Math.round(numericValue(req.query?.page, 1)));
      const hours = Math.max(1, Math.min(24 * 365, Math.round(numericValue(req.query?.hours, 24))));
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      const matchingHistory = state.workflowHistory.filter((item) => {
        const startedAt = Date.parse(item.startedAt);
        return !Number.isFinite(startedAt) || startedAt >= cutoff;
      });
      const total = matchingHistory.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const resolvedPage = Math.min(page, totalPages);
      const history = matchingHistory.slice((resolvedPage - 1) * limit, resolvedPage * limit);
      return res.status(200).json({
        success: true,
        history,
        count: history.length,
        pagination: {
          page: resolvedPage,
          limit,
          total,
          totalPages,
          hasNextPage: resolvedPage < totalPages,
          hasPreviousPage: resolvedPage > 1,
        },
        timeRange: { hours },
      });
    }
    if (method === 'GET' && path === '/workflows/runtime-telemetry') {
      const total = state.workflowHistory.length;
      return res.status(200).json({ success: true, telemetry: { runningNow: 0, executionCount: total, successCount: total, partialSuccessCount: 0, failedCount: 0, cancelledCount: 0, runningCountInRange: 0, totalActions: state.workflowHistory.reduce((sum, item) => sum + numericValue(item.totalActions), 0), successfulActions: state.workflowHistory.reduce((sum, item) => sum + numericValue(item.successfulActions), 0), failedActions: state.workflowHistory.reduce((sum, item) => sum + numericValue(item.failedActions), 0), averageDurationMs: total ? 180 : null, failureRatePct: 0, lastStartedAt: state.workflowHistory[0]?.startedAt || null, lastCompletedAt: state.workflowHistory[0]?.completedAt || null, timeRange: { hours: numericValue(req.query?.hours, 24) } } });
    }
    match = path.match(/^\/workflows\/([^/]+)\/execute$/);
    if (method === 'POST' && match) {
      const result = await executeWorkflow(user, match[1]);
      return res.status(200).json({ success: true, message: `${result.workflow.name} completed successfully`, status: 'success', workflow: result.workflow, history: result.history, executionId: result.history.id });
    }
    match = path.match(/^\/workflows\/([^/]+)$/);
    if (method === 'GET' && match) {
      const workflow = findById(state.workflows, match[1]);
      return workflow ? res.status(200).json({ success: true, workflow }) : res.status(404).json({ success: false, message: 'Virtual workflow not found' });
    }

    if (method === 'GET' && path === '/profiles') {
      return res.status(200).json({ success: true, profiles: [state.profile] });
    }
    match = path.match(/^\/profiles\/([^/]+)\/dashboard-views$/);
    if (match && method === 'GET') {
      return res.status(200).json({ success: true, views: state.profile.dashboardViews });
    }
    if (match && method === 'PUT') {
      if (!Array.isArray(req.body?.views)) return res.status(400).json({ success: false, message: 'Views payload must be an array' });
      const mutation = await withState(user, (nextState) => {
        nextState.profile.dashboardViews = clone(req.body.views).slice(0, 10);
        return clone(nextState.profile.dashboardViews);
      });
      return res.status(200).json({ success: true, message: 'Virtual dashboard views updated successfully', views: mutation.result });
    }
    match = path.match(/^\/profiles\/([^/]+)\/security-visible-sensors$/);
    if (match && method === 'GET') {
      return res.status(200).json({ success: true, sensorIds: state.profile.securityVisibleSensors });
    }
    if (match && method === 'PUT') {
      const sensorIds = req.body?.sensorIds;
      if (sensorIds !== null && !Array.isArray(sensorIds)) return res.status(400).json({ success: false, message: 'sensorIds must be an array or null' });
      const allowed = new Set(state.devices.filter((device) => device.type === 'sensor').map((device) => device._id));
      const mutation = await withState(user, (nextState) => {
        nextState.profile.securityVisibleSensors = sensorIds === null ? [] : sensorIds.filter((id) => allowed.has(id));
        return clone(nextState.profile.securityVisibleSensors);
      });
      return res.status(200).json({ success: true, sensorIds: mutation.result });
    }
    match = path.match(/^\/profiles\/([^/]+)\/favorites\/devices$/);
    if (match && method === 'POST') {
      const device = findById(state.devices, req.body?.deviceId);
      if (!device) return res.status(404).json({ success: false, message: 'Virtual device not found' });
      const mutation = await withState(user, (nextState) => {
        if (!nextState.profile.favorites.devices.includes(device._id)) nextState.profile.favorites.devices.push(device._id);
        return clone(nextState.profile);
      });
      return res.status(200).json({ success: true, profile: mutation.result });
    }
    match = path.match(/^\/profiles\/([^/]+)\/favorites\/devices\/([^/]+)$/);
    if (match && method === 'DELETE') {
      const mutation = await withState(user, (nextState) => {
        nextState.profile.favorites.devices = nextState.profile.favorites.devices.filter((id) => id !== match[2]);
        return clone(nextState.profile);
      });
      return res.status(200).json({ success: true, profile: mutation.result });
    }
    match = path.match(/^\/profiles\/([^/]+)\/favorites\/scenes$/);
    if (match && method === 'POST') {
      const scene = findById(state.scenes, req.body?.sceneId);
      if (!scene) return res.status(404).json({ success: false, message: 'Virtual scene not found' });
      const mutation = await withState(user, (nextState) => {
        if (!nextState.profile.favorites.scenes.includes(scene._id)) nextState.profile.favorites.scenes.push(scene._id);
        return clone(nextState.profile);
      });
      return res.status(200).json({ success: true, profile: mutation.result });
    }
    match = path.match(/^\/profiles\/([^/]+)\/favorites\/scenes\/([^/]+)$/);
    if (match && method === 'DELETE') {
      const mutation = await withState(user, (nextState) => {
        nextState.profile.favorites.scenes = nextState.profile.favorites.scenes.filter((id) => id !== match[2]);
        return clone(nextState.profile);
      });
      return res.status(200).json({ success: true, profile: mutation.result });
    }
    match = path.match(/^\/profiles\/([^/]+)$/);
    if (method === 'GET' && match) {
      return match[1] === state.profile._id
        ? res.status(200).json({ success: true, profile: state.profile })
        : res.status(404).json({ success: false, message: 'Virtual profile not found' });
    }

    if (['GET', 'POST'].includes(method) && path === '/weather/current') {
      return res.status(200).json({ success: true, weather: buildWeather() });
    }
    if (['GET', 'POST'].includes(method) && path === '/weather/dashboard') {
      const forecast = buildWeather();
      return res.status(200).json({ success: true, dashboard: { fetchedAt: forecast.fetchedAt, forecast, hourlyForecast: forecast.hourlyForecast, tempest: { available: false, observations: [], events: [] }, indoorAir: { available: false, samples: [] } } });
    }

    if (method === 'GET' && (path === '/security-alarm' || path === '/security-alarm/status')) {
      const status = securityStatus(state);
      return path.endsWith('/status')
        ? res.status(200).json({ success: true, status })
        : res.status(200).json({ success: true, alarm: status });
    }
    if (method === 'GET' && path === '/security-alarm/settings') {
      return res.status(200).json({ success: true, settings: { enabledPlatforms: state.security.enabledPlatforms, exitDelaySeconds: state.security.exitDelaySeconds, pinSettings: state.security.pinSettings, pins: [] } });
    }
    if (method === 'POST' && ['/security-alarm/arm', '/security-alarm/disarm', '/security-alarm/dismiss', '/security-alarm/sync'].includes(path)) {
      const mutation = await withState(user, (nextState) => {
        if (path.endsWith('/arm')) nextState.security.alarmState = req.body?.mode === 'away' ? 'armedAway' : 'armedStay';
        if (path.endsWith('/disarm') || path.endsWith('/dismiss')) nextState.security.alarmState = 'disarmed';
        addEvent(nextState, { type: 'security.updated', category: 'security', payload: { message: `Virtual security is ${nextState.security.alarmState}.` } });
        return securityStatus(nextState);
      });
      return res.status(200).json({ success: true, message: 'Virtual security updated', alarm: mutation.result, status: mutation.result });
    }

    if (method === 'GET' && path === '/notifications') {
      const includeCleared = booleanValue(req.query?.includeCleared, false);
      const includeResolved = booleanValue(req.query?.includeResolved, includeCleared);
      const requestedChannel = typeof req.query?.channel === 'string' ? req.query.channel.trim() : '';
      const channel = requestedChannel === 'all' ? '' : requestedChannel;
      const limit = Math.max(1, Math.min(200, Math.round(numericValue(req.query?.limit, 100))));
      const notifications = state.notifications.filter((notification) => (
        (includeCleared || !notification.clearedAt)
        && (includeResolved || !notification.resolvedAt)
        && (!channel || notification.channel === channel)
      )).slice(0, limit);
      return res.status(200).json({ success: true, notifications, counts: notificationCounts(state) });
    }
    if ((method === 'DELETE' && path === '/notifications') || (method === 'POST' && path === '/notifications/clear')) {
      const mutation = await withState(user, (nextState) => {
        const clearedAt = nowIso();
        const requestedChannel = typeof (req.body?.channel ?? req.query?.channel) === 'string'
          ? String(req.body?.channel ?? req.query?.channel).trim()
          : '';
        const channel = requestedChannel === 'all' ? '' : requestedChannel;
        const includeResolved = booleanValue(
          req.body?.includeResolved ?? req.body?.includeHistory ?? req.query?.includeResolved ?? req.query?.includeHistory,
          false
        );
        let clearedCount = 0;
        nextState.notifications.forEach((notification) => {
          if (
            !notification.clearedAt
            && (includeResolved || !notification.resolvedAt)
            && (!channel || notification.channel === channel)
          ) {
            notification.clearedAt = clearedAt;
            clearedCount += 1;
          }
        });
        return {
          clearedCount,
          channel: channel || 'all',
          includeResolved,
          clearedAt,
          counts: notificationCounts(nextState),
        };
      });
      return res.status(200).json({ success: true, ...mutation.result });
    }
    match = path.match(/^\/notifications\/([^/]+)(?:\/clear)?$/);
    if ((method === 'DELETE' || method === 'POST') && match) {
      const mutation = await withState(user, (nextState) => {
        const notification = findById(nextState.notifications, match[1]);
        if (!notification) return null;
        notification.clearedAt = nowIso();
        return clone(notification);
      });
      return mutation.result
        ? res.status(200).json({ success: true, notification: mutation.result, counts: notificationCounts(mutation.state) })
        : res.status(404).json({ success: false, message: 'Virtual notification not found' });
    }
    if (method === 'GET' && path === '/notifications/push/status') {
      return res.status(200).json({ success: true, apns: { configured: false, enabled: false, environment: 'review-sandbox' } });
    }
    if (method === 'POST' && path === '/notifications/push/devices') {
      return res.status(200).json({ success: true, subscription: { installationId: 'review-sandbox', virtual: true }, apns: { configured: false, enabled: false, environment: 'review-sandbox' } });
    }
    if (method === 'DELETE' && /^\/notifications\/push\/devices\//.test(path)) {
      return res.status(200).json({ success: true, deleted: true, virtual: true });
    }

    if (method === 'GET' && path === '/watch/config') {
      return res.status(200).json({ success: true, ...watchConfigPayload(state) });
    }
    if (method === 'PUT' && path === '/watch/config') {
      const mutation = await withState(user, (nextState) => {
        const body = req.body || {};
        if (Array.isArray(body.sections)) nextState.watchConfig.sections = body.sections.filter((item) => typeof item === 'string');
        if (typeof body.primaryRoom === 'string') nextState.watchConfig.primaryRoom = body.primaryRoom;
        if (Array.isArray(body.lightDeviceIds)) {
          const lightIds = new Set(nextState.devices.filter((device) => device.type === 'light').map((device) => device._id));
          nextState.watchConfig.lightDeviceIds = body.lightDeviceIds.filter((id) => lightIds.has(id));
        }
        if (body.defaultLightBrightness !== undefined) nextState.watchConfig.defaultLightBrightness = Math.max(1, Math.min(100, numericValue(body.defaultLightBrightness, 70)));
        return watchConfigPayload(nextState);
      });
      return res.status(200).json({ success: true, message: 'Virtual Watch configuration updated', ...mutation.result });
    }
    if (method === 'GET' && path === '/watch/dashboard') {
      return res.status(200).json({ success: true, dashboard: watchDashboard(state, user) });
    }
    if (method === 'POST' && path === '/watch/security') {
      const action = String(req.body?.action || '').toLowerCase();
      const mutation = await withState(user, (nextState) => {
        nextState.security.alarmState = action.includes('away') ? 'armedAway' : action.includes('stay') ? 'armedStay' : 'disarmed';
        return watchDashboard(nextState, user).sections.security;
      });
      return res.status(200).json({ success: true, security: mutation.result });
    }
    if (method === 'POST' && path === '/watch/lights') {
      const mutation = await withState(user, (nextState) => {
        const selected = new Set(nextState.watchConfig.lightDeviceIds);
        const action = req.body?.action || (req.body?.isOn === false ? 'turn_off' : 'turn_on');
        const updated = nextState.devices.filter((device) => device.type === 'light' && (selected.size === 0 || selected.has(device._id)) && (!req.body?.room || device.room === req.body.room));
        updated.forEach((device) => controlDeviceInState(nextState, device._id, action, req.body?.brightness));
        return updated.map(lightSummary);
      });
      stateEmitter(user).emit('devices:update', clone(mutation.state.devices));
      return res.status(200).json({
        success: true,
        partialFailure: false,
        message: 'Virtual lights updated',
        results: mutation.result.map((device) => ({ deviceId: device.id, success: true, device })),
        lights: watchDashboard(mutation.state, user).sections.lights,
      });
    }

    if (method === 'GET' && path === '/voice/devices') {
      return res.status(200).json({ success: true, devices: state.voiceDevices, count: state.voiceDevices.length });
    }
    if (method === 'GET' && path === '/voice/status') {
      return res.status(200).json({ success: true, status: 'online', deviceCount: state.voiceDevices.length, reviewSandbox: true });
    }
    if (method === 'POST' && path === '/voice/commands/interpret') {
      const command = String(req.body?.commandText || '').trim();
      if (!command) return res.status(400).json({ success: false, message: 'commandText is required' });
      let responseText = 'The command was processed in the virtual review home.';
      let changedDevice = null;
      const normalized = command.toLowerCase();
      if (normalized.includes('living') && normalized.includes('light')) {
        const action = normalized.includes('off') ? 'turn_off' : 'turn_on';
        const mutation = await withState(user, (nextState) => clone(controlDeviceInState(nextState, IDS.devices.livingLamp, action)));
        changedDevice = mutation.result;
        stateEmitter(user).emit('devices:update', [clone(changedDevice)]);
        responseText = `The virtual living-room light is now ${changedDevice.status ? 'on' : 'off'}.`;
      } else if (normalized.includes('secure') || normalized.includes('lock')) {
        const mutation = await withState(user, (nextState) => clone(controlDeviceInState(nextState, IDS.devices.frontLock, 'lock')));
        changedDevice = mutation.result;
        stateEmitter(user).emit('devices:update', [clone(changedDevice)]);
        responseText = 'The virtual front door is locked.';
      }
      return res.status(200).json({ success: true, responseText, message: responseText, usedFallback: false, device: changedDevice, reviewSandbox: true });
    }
    if (method === 'POST' && (path === '/voice/browser/acknowledgment' || path === '/voice/browser/acknowledgment/')) {
      return res.status(204).end();
    }

    if (method === 'GET' && path === '/resources/utilization') {
      return res.status(200).json({
        cpu: { usagePercent: 18, cores: 8, model: 'Virtual Review CPU' },
        gpu: { available: true, detected: true, usagePercent: 9, type: 'Virtual Review GPU' },
        memory: { usagePercent: 41, totalGB: 16, usedGB: 6.6, freeGB: 9.4 },
        disk: { usagePercent: 27, totalGB: 256, usedGB: 69, availableGB: 187 },
        temperature: { available: true, average: 42, maximum: 44, unit: 'C' },
        uptime: { seconds: 86400 },
        systemInfo: { hostname: 'homebrain-review-sandbox', platform: 'virtual' },
      });
    }

    if (method === 'GET' && path === '/events/latest') {
      const category = typeof req.query?.category === 'string' ? req.query.category : '';
      const correlationId = typeof req.query?.correlationId === 'string' ? req.query.correlationId.trim() : '';
      const events = state.events
        .filter((event) => (!category || event.category === category))
        .filter((event) => (!correlationId || event.correlationId === correlationId))
        .slice(0, Math.max(1, Math.min(100, numericValue(req.query?.limit, 100))));
      return res.status(200).json({ success: true, events, count: events.length, lastSequence: events[0]?.sequence || 0 });
    }
    if (method === 'GET' && path === '/events/summary') {
      return res.status(200).json({ success: true, total: state.events.length, bySeverity: { info: state.events.length }, byCategory: state.events.reduce((result, event) => { result[event.category] = (result[event.category] || 0) + 1; return result; }, {}) });
    }
    if (method === 'GET' && path === '/matter/status') {
      return res.status(200).json({ success: true, status: { available: false, enabled: false, message: 'Physical commissioning is disabled in the review sandbox.' } });
    }
    if (method === 'GET' && path === '/matter/commissioning-sessions') {
      return res.status(200).json({ success: true, sessions: [] });
    }

    return res.status(403).json({
      success: false,
      error: 'This endpoint is not available in the isolated App Review sandbox.',
      reviewSandbox: true,
    });
  } catch (error) {
    return sendError(res, error);
  }
}

async function handleDeviceStream(user, req, res) {
  try {
    const document = await getOrCreateState(user);
    const emitter = stateEmitter(user);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendUpdate = (devices) => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'devices:update', devices })}\n\n`);
      } catch (_error) {
        // The close handlers below perform cleanup.
      }
    };
    const heartbeat = setInterval(() => {
      try {
        res.write(':\n\n');
      } catch (_error) {
        clearInterval(heartbeat);
      }
    }, 30000);

    emitter.on('devices:update', sendUpdate);
    res.write('event: ready\n');
    res.write('data: {}\n\n');
    sendUpdate(clone(document.state.devices));

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      emitter.removeListener('devices:update', sendUpdate);
      try { res.end(); } catch (_error) { /* already closed */ }
    };
    req.on('close', cleanup);
    req.on('end', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    return true;
  } catch (error) {
    sendError(res, error);
    return true;
  }
}

module.exports = {
  SCHEMA_VERSION,
  IDS,
  buildDefaultState,
  summarizeState,
  getOrCreateState,
  provisionForUser,
  deleteForUser,
  handleRequest,
  handleDeviceStream,
  isPassThroughPath,
  canonicalApiPath,
};

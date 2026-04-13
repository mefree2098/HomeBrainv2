const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const Device = require('../models/Device');
const Scene = require('../models/Scene');
const WallPanel = require('../models/WallPanel');
const deviceService = require('./deviceService');
const sceneService = require('./sceneService');
const securityAlarmService = require('./securityAlarmService');
const harmonyService = require('./harmonyService');
const eventStreamService = require('./eventStreamService');
const weatherService = require('./weatherService');
const { getConfiguredPublicOrigin } = require('../utils/publicOrigin');

const PANEL_CLAIM_TOKEN_TTL_MS = Math.max(
  60_000,
  Number(process.env.WALL_PANEL_CLAIM_TOKEN_TTL_MS || 60 * 60 * 1000)
);

const DEFAULT_POLL_INTERVAL_MS = Math.max(
  1_000,
  Number(process.env.WALL_PANEL_POLL_INTERVAL_MS || 4_000)
);

const PANEL_MODE_ORDER = Object.freeze(['thermostat', 'room', 'home', 'media', 'quiet']);
const THERMOSTAT_MODES = Object.freeze(['auto', 'cool', 'heat', 'off']);
const ROOM_DEVICE_TYPES = new Set(['light', 'switch', 'speaker', 'lock', 'garage']);
const ACTIVE_OTA_STATUSES = new Set(['queued', 'building', 'ready', 'downloading', 'installing', 'rebooting']);
const DOWNLOADABLE_OTA_STATUSES = new Set(['ready', 'downloading', 'installing', 'rebooting']);
const PANEL_BUILD_TARGETS = Object.freeze({
  'elecrow-crowpanel-2.1-rotary': Object.freeze({
    env: 'elecrow-crowpanel-2_1',
    artifactRelativePath: path.join('.pio', 'build', 'elecrow-crowpanel-2_1', 'firmware.bin')
  })
});

function normalizeTimestamp(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clampProgress(value, fallback = 0) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(100, parsed));
}

function normalizeOtaState(input = {}) {
  const status = trimString(input.status) || 'idle';
  const completed = status === 'completed';

  return {
    jobId: trimString(input.jobId),
    status,
    phase: trimString(input.phase) || status,
    progress: clampProgress(input.progress, completed ? 100 : 0),
    targetVersion: trimString(input.targetVersion),
    currentVersion: trimString(input.currentVersion),
    message: trimString(input.message),
    lastError: trimString(input.lastError),
    hardwareProfile: trimString(input.hardwareProfile),
    previousPanelStatus: trimString(input.previousPanelStatus) || 'offline',
    artifactPath: trimString(input.artifactPath),
    artifactSizeBytes: Math.max(0, normalizeNumber(input.artifactSizeBytes, 0)),
    bytesTransferred: Math.max(0, normalizeNumber(input.bytesTransferred, 0)),
    bytesTotal: Math.max(0, normalizeNumber(input.bytesTotal, 0)),
    requestedAt: normalizeTimestamp(input.requestedAt),
    startedAt: normalizeTimestamp(input.startedAt),
    completedAt: normalizeTimestamp(input.completedAt),
    updatedAt: normalizeTimestamp(input.updatedAt)
  };
}

function mergeOtaState(existing = {}, updates = {}) {
  const current = normalizeOtaState(existing);
  return normalizeOtaState({
    ...current,
    ...updates,
    updatedAt: updates.updatedAt || new Date()
  });
}

function serializeOtaState(ota = {}) {
  const normalized = normalizeOtaState(ota);
  return {
    jobId: normalized.jobId,
    status: normalized.status,
    phase: normalized.phase,
    progress: normalized.progress,
    targetVersion: normalized.targetVersion,
    currentVersion: normalized.currentVersion,
    message: normalized.message,
    lastError: normalized.lastError,
    hardwareProfile: normalized.hardwareProfile,
    artifactSizeBytes: normalized.artifactSizeBytes,
    bytesTransferred: normalized.bytesTransferred,
    bytesTotal: normalized.bytesTotal,
    requestedAt: normalized.requestedAt || null,
    startedAt: normalized.startedAt || null,
    completedAt: normalized.completedAt || null,
    updatedAt: normalized.updatedAt || null
  };
}

function otaStatusIsActive(status) {
  return ACTIVE_OTA_STATUSES.has(trimString(status));
}

function buildPanelFirmwareVersion() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `panel-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function createError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toId(value) {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'object' && typeof value.toString === 'function') {
    return value.toString().trim();
  }
  return '';
}

function uniqueIds(values = []) {
  const seen = new Set();
  const results = [];

  values.forEach((value) => {
    const normalized = toId(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    results.push(normalized);
  });

  return results;
}

function toPlainObject(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }
  if (typeof value.toObject === 'function') {
    return value.toObject();
  }
  return { ...value };
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildRegistrationCode() {
  const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `HBWP-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function issueClaimToken() {
  return {
    claimToken: crypto.randomBytes(16).toString('hex'),
    claimTokenExpires: new Date(Date.now() + PANEL_CLAIM_TOKEN_TTL_MS)
  };
}

function getThermostatMode(device = {}) {
  const raw = (
    device?.properties?.smartThingsThermostatMode
    || device?.properties?.ecobeeHvacMode
    || device?.properties?.hvacMode
    || (device?.status ? 'heat' : 'off')
  );
  const normalized = trimString(String(raw)).toLowerCase();
  return THERMOSTAT_MODES.includes(normalized) ? normalized : 'off';
}

function statusLabelForDevice(device = {}) {
  switch (trimString(device?.type).toLowerCase()) {
    case 'lock':
      return device.status ? 'Locked' : 'Unlocked';
    case 'garage':
      return device.status ? 'Open' : 'Closed';
    case 'light':
    case 'switch':
    case 'speaker':
      return device.status ? 'On' : 'Off';
    default:
      return device.status ? 'Active' : 'Idle';
  }
}

function actionForDevice(device = {}) {
  switch (trimString(device?.type).toLowerCase()) {
    case 'lock':
      return device.status ? 'unlock' : 'lock';
    case 'garage':
      return device.status ? 'close' : 'open';
    default:
      return device.status ? 'turn_off' : 'turn_on';
  }
}

function accentForDevice(device = {}) {
  switch (trimString(device?.type).toLowerCase()) {
    case 'light':
      return 'blue';
    case 'switch':
      return 'cyan';
    case 'speaker':
      return 'purple';
    case 'lock':
      return 'yellow';
    case 'garage':
      return 'orange';
    default:
      return 'slate';
  }
}

function makeQuickAction(input = {}) {
  return {
    id: trimString(input.id) || crypto.randomUUID(),
    label: trimString(input.label) || 'Action',
    subtitle: trimString(input.subtitle),
    type: trimString(input.type),
    targetId: toId(input.targetId),
    action: trimString(input.action),
    value: input.value ?? null,
    accent: trimString(input.accent) || 'blue',
    destructive: normalizeBoolean(input.destructive, false)
  };
}

function makeModeSnapshot(input = {}) {
  return {
    id: trimString(input.id),
    title: trimString(input.title),
    centerValue: trimString(input.centerValue),
    secondaryValue: trimString(input.secondaryValue),
    hint: trimString(input.hint),
    accent: trimString(input.accent) || 'blue',
    knob: input.knob && typeof input.knob === 'object'
      ? {
          kind: trimString(input.knob.kind) || 'none',
          min: normalizeNumber(input.knob.min, 0),
          max: normalizeNumber(input.knob.max, 100),
          step: normalizeNumber(input.knob.step, 1),
          value: normalizeNumber(input.knob.value, 0),
          clockwiseAction: input.knob.clockwiseAction || null,
          counterclockwiseAction: input.knob.counterclockwiseAction || null,
          pressAction: input.knob.pressAction || null,
          longPressAction: input.knob.longPressAction || null
        }
      : {
          kind: 'none',
          min: 0,
          max: 100,
          step: 1,
          value: 0,
          clockwiseAction: null,
          counterclockwiseAction: null,
          pressAction: null,
          longPressAction: null
        },
    quickActions: Array.isArray(input.quickActions) ? input.quickActions.slice(0, 4) : [],
    meta: input.meta && typeof input.meta === 'object' ? input.meta : {}
  };
}

function buildThemeSnapshot() {
  return {
    name: 'homebrain-ios-future',
    palette: {
      pageTop: '#061120',
      pageMid: '#0B1831',
      pageBottom: '#040A17',
      chrome: '#081324',
      panel: '#0A1730',
      panelSoft: '#132442',
      panelStroke: '#50A7FF',
      textPrimary: '#F4F8FF',
      textSecondary: '#B6C4DE',
      textMuted: '#8CA0C2',
      accentBlue: '#4AE3FF',
      accentPurple: '#8F9BFF',
      accentGreen: '#33E3AA',
      accentYellow: '#FFE46B',
      accentOrange: '#FFC764',
      accentRed: '#FF8B7F'
    }
  };
}

function buildDefaultSettings(overrides = {}) {
  const input = overrides && typeof overrides === 'object' ? overrides : {};
  return {
    integrationKind: 'elecrow-wall-panel',
    theme: 'homebrain-ios-future',
    pollingIntervalMs: normalizeNumber(input.pollingIntervalMs, DEFAULT_POLL_INTERVAL_MS),
    modeOrder: Array.isArray(input.modeOrder) && input.modeOrder.length > 0
      ? input.modeOrder.map((value) => trimString(value)).filter(Boolean)
      : [...PANEL_MODE_ORDER],
    registered: normalizeBoolean(input.registered, false),
    registrationExpires: input.registrationExpires
      ? new Date(input.registrationExpires)
      : new Date(Date.now() + 24 * 60 * 60 * 1000),
    registrationCode: trimString(input.registrationCode),
    claimToken: trimString(input.claimToken),
    claimTokenExpires: input.claimTokenExpires ? new Date(input.claimTokenExpires) : null,
    thermostat: {
      deviceId: toId(input?.thermostat?.deviceId),
      sensorDeviceId: toId(input?.thermostat?.sensorDeviceId),
      bedtimeSceneId: toId(input?.thermostat?.bedtimeSceneId)
    },
    roomControl: {
      favoriteDeviceIds: uniqueIds(input?.roomControl?.favoriteDeviceIds),
      sceneIds: uniqueIds(input?.roomControl?.sceneIds)
    },
    homeStatus: {
      sceneIds: uniqueIds(input?.homeStatus?.sceneIds),
      weatherEnabled: normalizeBoolean(input?.homeStatus?.weatherEnabled, false)
    },
    harmony: {
      hubIp: trimString(input?.harmony?.hubIp),
      activityIds: uniqueIds(input?.harmony?.activityIds),
      commandDeviceId: toId(input?.harmony?.commandDeviceId)
    },
    quietHouse: {
      bedtimeSceneId: toId(input?.quietHouse?.bedtimeSceneId),
      morningSceneId: toId(input?.quietHouse?.morningSceneId),
      whiteNoiseSceneId: toId(input?.quietHouse?.whiteNoiseSceneId),
      lockUpSceneId: toId(input?.quietHouse?.lockUpSceneId),
      nightLightDeviceId: toId(input?.quietHouse?.nightLightDeviceId)
    }
  };
}

function mergeSettings(existing = {}, updates = {}) {
  const current = buildDefaultSettings(existing);
  const next = updates && typeof updates === 'object' ? updates : {};

  return buildDefaultSettings({
    ...current,
    ...next,
    thermostat: {
      ...current.thermostat,
      ...(next.thermostat || {})
    },
    roomControl: {
      ...current.roomControl,
      ...(next.roomControl || {})
    },
    homeStatus: {
      ...current.homeStatus,
      ...(next.homeStatus || {})
    },
    harmony: {
      ...current.harmony,
      ...(next.harmony || {})
    },
    quietHouse: {
      ...current.quietHouse,
      ...(next.quietHouse || {})
    }
  });
}

async function loadScenesInOrder(sceneIds = []) {
  const ids = uniqueIds(sceneIds);
  if (ids.length === 0) {
    return [];
  }

  const scenes = await Scene.find({ _id: { $in: ids } });
  const byId = new Map(scenes.map((scene) => [toId(scene._id), scene]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function normalizePanelDocument(panel) {
  const source = toPlainObject(panel);
  return {
    ...source,
    ota: normalizeOtaState(source.ota || {}),
    settings: mergeSettings(source.settings || {}),
    _id: toId(source._id),
    id: toId(source._id)
  };
}

function serializePanel(panel, { includeSecrets = false } = {}) {
  const normalized = normalizePanelDocument(panel);
  const payload = {
    id: normalized.id,
    name: normalized.name,
    room: normalized.room,
    hardwareProfile: normalized.hardwareProfile,
    status: normalized.status,
    powerSource: normalized.powerSource,
    connectionType: normalized.connectionType,
    ipAddress: normalized.ipAddress || '',
    firmwareVersion: normalized.firmwareVersion || '',
    lastSeen: normalized.lastSeen || null,
    createdAt: normalized.createdAt || null,
    updatedAt: normalized.updatedAt || null,
    ota: serializeOtaState(normalized.ota || {}),
    settings: {
      ...normalized.settings,
      claimToken: includeSecrets ? normalized.settings.claimToken : undefined,
      registrationCode: includeSecrets ? normalized.settings.registrationCode : undefined
    }
  };

  if (!includeSecrets) {
    delete payload.settings.claimToken;
    delete payload.settings.registrationCode;
  }

  return payload;
}

function buildProvisioningSnapshot(panel, origin = '') {
  const normalized = normalizePanelDocument(panel);
  return {
    hubUrl: trimString(origin),
    panelId: normalized.id,
    registrationCode: normalized.settings.registrationCode,
    hardwareProfile: normalized.hardwareProfile,
    firmwareHeader: {
      HOMEBRAIN_PANEL_HUB_URL: trimString(origin),
      HOMEBRAIN_PANEL_ID: normalized.id,
      HOMEBRAIN_PANEL_REGISTRATION_CODE: normalized.settings.registrationCode
    }
  };
}

function credentialsMatchPanel(panel, credentials = {}) {
  const normalized = normalizePanelDocument(panel);
  const registrationCode = trimString(credentials.registrationCode);
  const claimToken = trimString(credentials.claimToken);

  if (registrationCode && registrationCode === normalized.settings.registrationCode) {
    return true;
  }

  if (claimToken && claimToken === normalized.settings.claimToken) {
    const expiresAt = normalized.settings.claimTokenExpires
      ? new Date(normalized.settings.claimTokenExpires).getTime()
      : 0;
    return expiresAt > Date.now();
  }

  return false;
}

async function getPanelDocument(panelId) {
  const panel = await WallPanel.findById(panelId);
  if (!panel) {
    throw createError(404, 'Wall panel not found');
  }
  return panel;
}

async function ensurePanelAccess(panelId, credentials = {}) {
  const panel = await getPanelDocument(panelId);
  if (!credentialsMatchPanel(panel, credentials)) {
    throw createError(403, 'Wall panel credentials are invalid or expired');
  }
  return panel;
}

async function resolveThermostatDevice(settings, roomDevices = []) {
  const explicitDeviceId = toId(settings?.thermostat?.deviceId);
  if (explicitDeviceId) {
    return deviceService.getDeviceById(explicitDeviceId);
  }

  const roomThermostat = roomDevices.find((device) => trimString(device?.type).toLowerCase() === 'thermostat');
  if (roomThermostat) {
    return roomThermostat;
  }

  return Device.findOne({ type: 'thermostat' });
}

async function resolveSensorDevice(settings, roomDevices = []) {
  const explicitSensorId = toId(settings?.thermostat?.sensorDeviceId);
  if (explicitSensorId) {
    return deviceService.getDeviceById(explicitSensorId);
  }

  return roomDevices.find((device) => trimString(device?.type).toLowerCase() === 'sensor') || null;
}

function buildThermostatWeatherMeta(weather = null) {
  const icon = trimString(weather?.current?.icon);
  const condition = trimString(weather?.current?.condition);
  const outdoorTemperature = normalizeNumber(weather?.current?.temperatureF, NaN);

  if (!icon && !condition && !Number.isFinite(outdoorTemperature)) {
    return {};
  }

  return {
    weatherIcon: icon || 'cloudy',
    weatherCondition: condition || 'Outdoor weather',
    weatherIsDay: normalizeBoolean(weather?.current?.isDay, true),
    outdoorTemperature: Number.isFinite(outdoorTemperature) ? Math.round(outdoorTemperature) : null
  };
}

function buildThermostatMode(panel, thermostatDevice, sensorDevice, weather = null) {
  const weatherMeta = buildThermostatWeatherMeta(weather);

  if (!thermostatDevice) {
    return makeModeSnapshot({
      id: 'thermostat',
      title: 'Thermostat',
      centerValue: 'Not Bound',
      secondaryValue: 'Assign a thermostat in the panel settings.',
      hint: 'Swipe to change surfaces.',
      accent: 'blue',
      meta: {
        ready: false,
        ...weatherMeta
      }
    });
  }

  const targetTemperature = Number(thermostatDevice?.targetTemperature ?? thermostatDevice?.temperature ?? 70);
  const currentTemperature = Number(
    sensorDevice?.temperature
    ?? thermostatDevice?.temperature
    ?? thermostatDevice?.targetTemperature
    ?? 70
  );
  const mode = getThermostatMode(thermostatDevice);
  const bedtimeSceneId = toId(panel?.settings?.thermostat?.bedtimeSceneId || panel?.settings?.quietHouse?.bedtimeSceneId);

  return makeModeSnapshot({
    id: 'thermostat',
    title: 'Thermostat',
    centerValue: `${Math.round(currentTemperature)}°`,
    secondaryValue: `Set point ${Math.round(targetTemperature)}°`,
    hint: '',
    accent: 'blue',
    knob: {
      kind: 'range',
      min: 55,
      max: 90,
      step: 1,
      value: Math.round(targetTemperature),
      pressAction: makeQuickAction({
        id: 'thermostat-commit',
        label: 'Commit',
        type: 'panel.noop'
      }),
      longPressAction: bedtimeSceneId
        ? makeQuickAction({
            id: 'thermostat-bedtime',
            label: 'Bedtime',
            type: 'scene.activate',
            targetId: bedtimeSceneId,
            accent: 'purple'
          })
        : null
    },
    quickActions: THERMOSTAT_MODES.map((entry) => makeQuickAction({
      id: `thermostat-mode-${entry}`,
      label: entry.toUpperCase(),
      subtitle: mode === entry ? 'Active' : '',
      type: 'thermostat.set_mode',
      targetId: toId(thermostatDevice._id),
      value: entry,
      accent: mode === entry ? 'green' : 'slate'
    })),
    meta: {
      ready: true,
      deviceId: toId(thermostatDevice._id),
      sensorDeviceId: toId(sensorDevice?._id),
      currentTemperature: Math.round(currentTemperature),
      targetTemperature: Math.round(targetTemperature),
      mode,
      ...weatherMeta
    }
  });
}

function pickRoomDevices(panel, roomDevices = [], allDevices = []) {
  const explicitIds = uniqueIds(panel?.settings?.roomControl?.favoriteDeviceIds);
  if (explicitIds.length > 0) {
    const byId = new Map(
      [...allDevices, ...roomDevices].map((device) => [toId(device._id), device])
    );
    return explicitIds.map((id) => byId.get(id)).filter(Boolean).slice(0, 4);
  }

  return roomDevices
    .filter((device) => ROOM_DEVICE_TYPES.has(trimString(device?.type).toLowerCase()))
    .slice(0, 4);
}

async function buildRoomMode(panel, roomDevices = [], allDevices = []) {
  const quickActions = [];
  const configuredScenes = await loadScenesInOrder(panel?.settings?.roomControl?.sceneIds);
  const explicitDeviceIds = uniqueIds(panel?.settings?.roomControl?.favoriteDeviceIds);
  const pinnedDevices = pickRoomDevices(panel, roomDevices, allDevices);

  configuredScenes.slice(0, 2).forEach((scene) => {
    quickActions.push(makeQuickAction({
      id: `room-scene-${toId(scene._id)}`,
      label: scene.name,
      subtitle: trimString(scene.category) || 'Scene',
      type: 'scene.activate',
      targetId: toId(scene._id),
      accent: 'purple'
    }));
  });

  pinnedDevices.forEach((device) => {
    quickActions.push(makeQuickAction({
      id: `room-device-${toId(device._id)}`,
      label: device.name,
      subtitle: statusLabelForDevice(device),
      type: 'device.control',
      targetId: toId(device._id),
      action: actionForDevice(device),
      accent: accentForDevice(device)
    }));
  });

  const summaryDevices = explicitDeviceIds.length > 0
    ? pinnedDevices
    : roomDevices.filter((device) => ROOM_DEVICE_TYPES.has(trimString(device?.type).toLowerCase()));
  const controllableCount = summaryDevices.length;
  const activeCount = summaryDevices.filter((device) => device.status).length;

  return makeModeSnapshot({
    id: 'room',
    title: panel.room,
    centerValue: `${activeCount}/${controllableCount || 0}`,
    secondaryValue: explicitDeviceIds.length > 0 ? 'Pinned controls' : 'Room controls',
    hint: 'Tap tiles for scenes and device toggles.',
    accent: 'cyan',
    quickActions,
    meta: {
      ready: quickActions.length > 0,
      controllableCount,
      activeCount,
      isPinnedSelection: explicitDeviceIds.length > 0
    }
  });
}

function alarmStateLabel(status = {}) {
  switch (status.alarmState) {
    case 'armedStay':
      return 'ARMED STAY';
    case 'armedAway':
      return 'ARMED AWAY';
    case 'triggered':
      return 'TRIGGERED';
    case 'disarmed':
    default:
      return 'DISARMED';
  }
}

function summarizeSecurityStatus(securityStatus = null) {
  if (!securityStatus || typeof securityStatus !== 'object') {
    return null;
  }

  return {
    alarmState: trimString(securityStatus.alarmState) || 'unknown',
    isArmed: Boolean(securityStatus.isArmed),
    isTriggered: Boolean(securityStatus.isTriggered),
    sensorCount: normalizeNumber(securityStatus.sensorCount, 0),
    activeSensorCount: normalizeNumber(securityStatus.activeSensorCount, 0),
    offlineSensorCount: normalizeNumber(securityStatus.offlineSensorCount, 0),
    lowBatterySensorCount: normalizeNumber(securityStatus.lowBatterySensorCount, 0),
    attentionSensorCount: normalizeNumber(securityStatus.attentionSensorCount, 0),
    doorLockCount: normalizeNumber(securityStatus.doorLockCount, 0),
    lockedDoorCount: normalizeNumber(securityStatus.lockedDoorCount, 0),
    unlockedDoorCount: normalizeNumber(securityStatus.unlockedDoorCount, 0),
    isOnline: normalizeBoolean(securityStatus.isOnline, true),
    batteryLevel: normalizeNumber(securityStatus.batteryLevel, 0),
    signalStrength: normalizeNumber(securityStatus.signalStrength, 0),
    error: trimString(securityStatus.error)
  };
}

function buildHomeMode(panel, securityStatus = null, allDevices = []) {
  const garages = allDevices.filter((device) => trimString(device?.type).toLowerCase() === 'garage');
  const locks = allDevices.filter((device) => trimString(device?.type).toLowerCase() === 'lock');
  const garageOpenCount = garages.filter((device) => device.status).length;
  const unlockedCount = locks.filter((device) => !device.status).length;
  const quickActions = [];

  if (securityStatus?.isTriggered) {
    quickActions.push(makeQuickAction({
      id: 'security-dismiss',
      label: 'Dismiss',
      subtitle: 'Clear active alarm',
      type: 'security.dismiss',
      accent: 'red',
      destructive: true
    }));
    quickActions.push(makeQuickAction({
      id: 'security-disarm',
      label: 'Disarm',
      subtitle: 'Return to normal',
      type: 'security.disarm',
      accent: 'yellow'
    }));
  } else if (securityStatus?.isArmed) {
    quickActions.push(makeQuickAction({
      id: 'security-disarm',
      label: 'Disarm',
      subtitle: 'Home access',
      type: 'security.disarm',
      accent: 'yellow'
    }));
  } else {
    quickActions.push(makeQuickAction({
      id: 'security-arm-stay',
      label: 'Arm Stay',
      subtitle: 'Stay home',
      type: 'security.arm',
      value: 'stay',
      accent: 'green'
    }));
    quickActions.push(makeQuickAction({
      id: 'security-arm-away',
      label: 'Arm Away',
      subtitle: 'Leave home',
      type: 'security.arm',
      value: 'away',
      accent: 'orange'
    }));
  }

  const lockUpSceneId = toId(panel?.settings?.quietHouse?.lockUpSceneId);
  if (lockUpSceneId) {
    quickActions.push(makeQuickAction({
      id: 'home-lock-up',
      label: 'Lock Up',
      subtitle: 'Night secure',
      type: 'scene.activate',
      targetId: lockUpSceneId,
      accent: 'purple'
    }));
  }

  if (garages[0]) {
    quickActions.push(makeQuickAction({
      id: `home-garage-${toId(garages[0]._id)}`,
      label: garages[0].name,
      subtitle: statusLabelForDevice(garages[0]),
      type: 'device.control',
      targetId: toId(garages[0]._id),
      action: actionForDevice(garages[0]),
      accent: 'orange'
    }));
  }

  return makeModeSnapshot({
    id: 'home',
    title: 'Whole Home',
    centerValue: alarmStateLabel(securityStatus || {}),
    secondaryValue: `${garageOpenCount} garage open · ${unlockedCount} unlocked`,
    hint: 'Security, garage, and lock shortcuts live here.',
    accent: securityStatus?.isTriggered ? 'red' : (securityStatus?.isArmed ? 'green' : 'blue'),
    quickActions,
    meta: {
      ready: true,
      garageOpenCount,
      unlockedCount,
      security: summarizeSecurityStatus(securityStatus)
    }
  });
}

async function buildMediaMode(panel) {
  const hubIp = trimString(panel?.settings?.harmony?.hubIp);
  if (!hubIp) {
    return makeModeSnapshot({
      id: 'media',
      title: 'Media',
      centerValue: 'Not Bound',
      secondaryValue: 'Assign a Harmony hub in panel settings.',
      hint: 'Swipe for Quiet House or bind Harmony in HomeBrain.',
      accent: 'purple',
      meta: {
        ready: false
      }
    });
  }

  let hub = null;
  try {
    hub = await harmonyService.getHubSnapshot(hubIp, { includeCommands: true });
  } catch (error) {
    return makeModeSnapshot({
      id: 'media',
      title: 'Media',
      centerValue: 'Hub Offline',
      secondaryValue: error.message || 'Harmony hub unavailable',
      hint: 'Check the configured Harmony IP and power state.',
      accent: 'red',
      meta: {
        ready: false,
        hubIp
      }
    });
  }

  const configuredActivityIds = uniqueIds(panel?.settings?.harmony?.activityIds);
  const activities = Array.isArray(hub?.activities) ? hub.activities : [];
  const chosenActivities = configuredActivityIds.length > 0
    ? configuredActivityIds
        .map((id) => activities.find((entry) => trimString(entry?.id) === id))
        .filter(Boolean)
    : activities.slice(0, 2);
  const commandDeviceId = toId(panel?.settings?.harmony?.commandDeviceId);
  const currentActivity = activities.find((entry) => trimString(entry?.id) === trimString(hub?.currentActivityId));
  const quickActions = chosenActivities.map((activity) => makeQuickAction({
    id: `media-activity-${trimString(activity.id)}`,
    label: trimString(activity.label) || 'Activity',
    subtitle: trimString(activity.activityTypeDisplayName) || 'Harmony',
    type: 'harmony.activity.start',
    targetId: trimString(activity.id),
    accent: trimString(activity.id) === trimString(hub?.currentActivityId) ? 'green' : 'purple'
  }));

  quickActions.push(makeQuickAction({
    id: 'media-off',
    label: 'Power Off',
    subtitle: 'Shut down hub',
    type: 'harmony.power_off',
    accent: 'red'
  }));

  if (commandDeviceId) {
    quickActions.push(makeQuickAction({
      id: 'media-play-pause',
      label: 'Play / Pause',
      subtitle: 'Knob press mirror',
      type: 'harmony.command',
      targetId: commandDeviceId,
      action: 'PlayPause',
      accent: 'blue'
    }));
  }

  return makeModeSnapshot({
    id: 'media',
    title: trimString(hub?.friendlyName) || 'Media',
    centerValue: trimString(currentActivity?.label) || 'All Off',
    secondaryValue: commandDeviceId ? 'Turn knob for volume' : 'Tap to launch activities',
    hint: commandDeviceId
      ? 'Turn the knob for volume. Press for Play/Pause.'
      : 'Tap an activity to launch media control.',
    accent: 'purple',
    knob: commandDeviceId
      ? {
          kind: 'relative',
          value: 50,
          min: 0,
          max: 100,
          step: 1,
          clockwiseAction: makeQuickAction({
            id: 'media-volume-up',
            label: 'Volume Up',
            type: 'harmony.command',
            targetId: commandDeviceId,
            action: 'VolumeUp',
            accent: 'blue'
          }),
          counterclockwiseAction: makeQuickAction({
            id: 'media-volume-down',
            label: 'Volume Down',
            type: 'harmony.command',
            targetId: commandDeviceId,
            action: 'VolumeDown',
            accent: 'blue'
          }),
          pressAction: makeQuickAction({
            id: 'media-play-pause',
            label: 'Play / Pause',
            type: 'harmony.command',
            targetId: commandDeviceId,
            action: 'PlayPause',
            accent: 'purple'
          }),
          longPressAction: makeQuickAction({
            id: 'media-power-off',
            label: 'Power Off',
            type: 'harmony.power_off',
            accent: 'red'
          })
        }
      : undefined,
    quickActions,
    meta: {
      ready: true,
      hubIp,
      commandDeviceId,
      currentActivityId: trimString(hub?.currentActivityId)
    }
  });
}

async function buildQuietMode(panel) {
  const sceneIds = uniqueIds([
    panel?.settings?.quietHouse?.bedtimeSceneId,
    panel?.settings?.quietHouse?.morningSceneId,
    panel?.settings?.quietHouse?.whiteNoiseSceneId,
    panel?.settings?.quietHouse?.lockUpSceneId
  ]);
  const scenes = await loadScenesInOrder(sceneIds);
  const quickActions = scenes.map((scene) => makeQuickAction({
    id: `quiet-scene-${toId(scene._id)}`,
    label: scene.name,
    subtitle: trimString(scene.category) || 'Scene',
    type: 'scene.activate',
    targetId: toId(scene._id),
    accent: 'purple'
  }));

  const nightLightDeviceId = toId(panel?.settings?.quietHouse?.nightLightDeviceId);
  if (nightLightDeviceId) {
    const nightLight = await Device.findById(nightLightDeviceId).catch(() => null);
    if (nightLight) {
      quickActions.push(makeQuickAction({
        id: `quiet-night-light-${toId(nightLight._id)}`,
        label: nightLight.name,
        subtitle: statusLabelForDevice(nightLight),
        type: 'device.control',
        targetId: toId(nightLight._id),
        action: actionForDevice(nightLight),
        accent: 'yellow'
      }));
    }
  }

  return makeModeSnapshot({
    id: 'quiet',
    title: 'Quiet House',
    centerValue: quickActions.length > 0 ? 'Wind Down' : 'Not Bound',
    secondaryValue: quickActions.length > 0 ? 'Sleep scenes and night controls' : 'Assign bedtime scenes in panel settings.',
    hint: 'Use this page for bedtime, white noise, and night light routines.',
    accent: 'purple',
    quickActions,
    meta: {
      ready: quickActions.length > 0
    }
  });
}

function resolvePanelBuildTarget(hardwareProfile) {
  const key = trimString(hardwareProfile);
  return PANEL_BUILD_TARGETS[key] || null;
}

function buildPanelOtaDownloadUrl(panelId, origin = '') {
  const resolvedOrigin = trimString(origin) || getConfiguredPublicOrigin();
  if (!resolvedOrigin) {
    return '';
  }

  return `${resolvedOrigin}/api/panels/${encodeURIComponent(panelId)}/ota/download`;
}

function buildPanelOtaPayload(panel, origin = '') {
  const ota = normalizeOtaState(panel?.ota || {});
  const downloadReady = DOWNLOADABLE_OTA_STATUSES.has(ota.status) && ota.artifactPath;

  return {
    active: otaStatusIsActive(ota.status),
    available: Boolean(downloadReady),
    status: ota.status,
    phase: ota.phase,
    progress: ota.progress,
    jobId: ota.jobId,
    targetVersion: ota.targetVersion,
    message: ota.message,
    bytesTotal: ota.bytesTotal || ota.artifactSizeBytes || 0,
    downloadUrl: downloadReady ? buildPanelOtaDownloadUrl(toId(panel?._id || panel?.id), origin) : ''
  };
}

class WallPanelService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    this.panelFirmwareProjectDir = options.panelFirmwareProjectDir
      || path.join(this.projectRoot, 'embedded', 'elecrow-wall-panel');
    this.panelOtaArtifactsDir = options.panelOtaArtifactsDir
      || path.join(this.projectRoot, 'server', 'data', 'wall-panel-ota');
    this.platformioBin = options.platformioBin || process.env.HOMEBRAIN_PANEL_PLATFORMIO_BIN || 'pio';
    this.spawnProcess = options.spawnProcess || spawn;
  }

  async ensureOtaArtifactsDir() {
    await fsp.mkdir(this.panelOtaArtifactsDir, { recursive: true });
  }

  async updatePanelOtaState(panelId, jobId, updates = {}, options = {}) {
    const { allowMissingJob = false } = options;
    const panel = await getPanelDocument(panelId);
    const currentOta = normalizeOtaState(panel.ota || {});

    if (jobId && currentOta.jobId && currentOta.jobId !== jobId) {
      if (allowMissingJob) {
        return panel;
      }
      throw createError(409, 'A newer OTA job has already replaced this request');
    }

    panel.ota = mergeOtaState(currentOta, updates);

    if (updates.status === 'completed') {
      panel.status = 'online';
    } else if (updates.status === 'failed') {
      panel.status = trimString(panel.ota.previousPanelStatus) || 'online';
    } else if (otaStatusIsActive(panel.ota.status)) {
      panel.status = 'updating';
    }

    await panel.save();
    return panel;
  }

  async failPanelOtaJob(panelId, jobId, error) {
    const message = trimString(error?.message) || 'OTA update failed';
    try {
      const panel = await this.updatePanelOtaState(panelId, jobId, {
        status: 'failed',
        phase: 'failed',
        progress: 0,
        message,
        lastError: message,
        completedAt: new Date()
      }, {
        allowMissingJob: true
      });

      void eventStreamService.publishSafe({
        type: 'wall_panel.ota_failed',
        source: 'wall_panel',
        category: 'panel',
        severity: 'error',
        payload: {
          panelId: toId(panel._id),
          jobId,
          message
        },
        tags: ['wall-panel', 'ota']
      });
    } catch (reportError) {
      console.error('Failed to persist wall panel OTA failure:', reportError.message);
    }
  }

  async buildPanelOtaArtifact(panel, { jobId, targetVersion }) {
    const buildTarget = resolvePanelBuildTarget(panel.hardwareProfile);
    if (!buildTarget) {
      throw createError(400, `Hardware profile ${panel.hardwareProfile} does not have an OTA build target yet`);
    }

    await this.ensureOtaArtifactsDir();
    await this.updatePanelOtaState(panel.id, jobId, {
      status: 'building',
      phase: 'building',
      progress: 12,
      message: `Building ${panel.hardwareProfile} firmware...`,
      startedAt: new Date(),
      hardwareProfile: panel.hardwareProfile
    });

    await new Promise((resolve, reject) => {
      const child = this.spawnProcess(
        this.platformioBin,
        ['run', '-e', buildTarget.env],
        {
          cwd: this.panelFirmwareProjectDir,
          env: {
            ...process.env,
            HOMEBRAIN_PANEL_BUILD_VERSION: targetVersion
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      );

      let stderr = '';
      let sawCompiling = false;
      let sawLinking = false;

      const handleOutput = async (chunk) => {
        const text = chunk.toString();
        stderr = `${stderr}${text}`.slice(-4000);

        if (!sawCompiling && /Compiling|Building/i.test(text)) {
          sawCompiling = true;
          await this.updatePanelOtaState(panel.id, jobId, {
            progress: 24,
            message: 'Compiling wall panel firmware...'
          }, { allowMissingJob: true }).catch(() => null);
        }

        if (!sawLinking && /Linking|Creating esp32s3 image|Retrieving maximum program size/i.test(text)) {
          sawLinking = true;
          await this.updatePanelOtaState(panel.id, jobId, {
            progress: 42,
            message: 'Linking and packaging OTA image...'
          }, { allowMissingJob: true }).catch(() => null);
        }
      };

      child.stdout.on('data', handleOutput);
      child.stderr.on('data', handleOutput);
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(trimString(stderr) || `PlatformIO exited with code ${code}`));
      });
    });

    const builtArtifactPath = path.join(this.panelFirmwareProjectDir, buildTarget.artifactRelativePath);
    const panelDir = path.join(this.panelOtaArtifactsDir, panel.id);
    await fsp.mkdir(panelDir, { recursive: true });

    const artifactPath = path.join(panelDir, `${jobId}.bin`);
    await fsp.copyFile(builtArtifactPath, artifactPath);
    const stat = await fsp.stat(artifactPath);

    await this.updatePanelOtaState(panel.id, jobId, {
      status: 'ready',
      phase: 'ready',
      progress: 60,
      message: 'Firmware package is ready. Waiting for the orb to download it over Wi-Fi.',
      artifactPath,
      artifactSizeBytes: stat.size,
      bytesTransferred: 0,
      bytesTotal: stat.size
    });

    void eventStreamService.publishSafe({
      type: 'wall_panel.ota_ready',
      source: 'wall_panel',
      category: 'panel',
      payload: {
        panelId: panel.id,
        jobId,
        targetVersion,
        artifactSizeBytes: stat.size
      },
      tags: ['wall-panel', 'ota']
    });
  }

  async pushFirmwareUpdate(panelId) {
    const panel = normalizePanelDocument(await getPanelDocument(panelId));

    if (!panel.settings.registered) {
      throw createError(400, 'This hardware orb has not completed its first activation yet');
    }

    if (otaStatusIsActive(panel.ota.status)) {
      throw createError(409, 'A firmware update is already in progress for this hardware orb');
    }

    const buildTarget = resolvePanelBuildTarget(panel.hardwareProfile);
    if (!buildTarget) {
      throw createError(400, `Hardware profile ${panel.hardwareProfile} is not OTA-capable yet`);
    }

    const jobId = crypto.randomUUID();
    const targetVersion = buildPanelFirmwareVersion();
    const panelDoc = await getPanelDocument(panelId);
    panelDoc.status = 'updating';
    panelDoc.ota = mergeOtaState(panelDoc.ota || {}, {
      jobId,
      status: 'queued',
      phase: 'queued',
      progress: 4,
      targetVersion,
      currentVersion: trimString(panelDoc.firmwareVersion),
      message: 'Queued HomeBrain firmware build for this orb.',
      hardwareProfile: buildTarget ? panel.hardwareProfile : '',
      previousPanelStatus: trimString(panel.status) || 'offline',
      requestedAt: new Date(),
      startedAt: null,
      completedAt: null,
      lastError: '',
      artifactPath: '',
      artifactSizeBytes: 0,
      bytesTransferred: 0,
      bytesTotal: 0
    });
    await panelDoc.save();

    void eventStreamService.publishSafe({
      type: 'wall_panel.ota_requested',
      source: 'wall_panel',
      category: 'panel',
      payload: {
        panelId: panel.id,
        jobId,
        targetVersion,
        hardwareProfile: panel.hardwareProfile
      },
      tags: ['wall-panel', 'ota']
    });

    void this.buildPanelOtaArtifact(normalizePanelDocument(panelDoc), { jobId, targetVersion }).catch((error) => {
      console.error('Wall panel OTA build failed:', error.message);
      return this.failPanelOtaJob(panel.id, jobId, error);
    });

    return serializePanel(panelDoc);
  }

  async getPanelOtaArtifact(panelId, credentials = {}) {
    const panel = normalizePanelDocument(await ensurePanelAccess(panelId, credentials));
    const ota = normalizeOtaState(panel.ota || {});

    if (!DOWNLOADABLE_OTA_STATUSES.has(ota.status) || !ota.artifactPath) {
      throw createError(404, 'No OTA package is available for this hardware orb');
    }

    const stat = await fsp.stat(ota.artifactPath).catch(() => null);
    if (!stat) {
      throw createError(404, 'The OTA package is no longer available on this HomeBrain host');
    }

    return {
      panel,
      ota,
      artifactPath: ota.artifactPath,
      artifactSizeBytes: stat.size
    };
  }

  async reportPanelOtaStatus(panelId, credentials = {}, report = {}) {
    const panel = normalizePanelDocument(await ensurePanelAccess(panelId, credentials));
    const ota = normalizeOtaState(panel.ota || {});
    const jobId = trimString(report.jobId);

    if (!ota.jobId || (jobId && ota.jobId !== jobId)) {
      throw createError(409, 'This OTA status report does not match the current HomeBrain update job');
    }

    const phase = trimString(report.phase) || ota.phase || ota.status;
    const rawProgress = clampProgress(report.progress, ota.progress);
    let status = ota.status;
    let progress = rawProgress;

    if (['downloading', 'download'].includes(phase)) {
      status = 'downloading';
      progress = Math.max(62, Math.min(82, 62 + Math.round(rawProgress * 0.2)));
    } else if (['installing', 'write', 'verifying'].includes(phase)) {
      status = 'installing';
      progress = Math.max(82, Math.min(95, 82 + Math.round(rawProgress * 0.13)));
    } else if (phase === 'rebooting') {
      status = 'rebooting';
      progress = 97;
    } else if (phase === 'ready') {
      status = 'ready';
      progress = Math.max(60, ota.progress);
    } else if (phase === 'failed') {
      status = 'failed';
      progress = 0;
    } else if (phase === 'completed') {
      status = 'completed';
      progress = 100;
    }

    const updatedPanel = await this.updatePanelOtaState(panel.id, ota.jobId, {
      status,
      phase,
      progress,
      currentVersion: trimString(report.currentVersion) || ota.currentVersion || panel.firmwareVersion || '',
      bytesTransferred: Math.max(0, normalizeNumber(report.bytesTransferred, ota.bytesTransferred)),
      bytesTotal: Math.max(0, normalizeNumber(report.bytesTotal, ota.bytesTotal || ota.artifactSizeBytes)),
      message: trimString(report.message) || ota.message,
      lastError: phase === 'failed' ? (trimString(report.error) || trimString(report.message) || ota.lastError) : '',
      completedAt: phase === 'failed' || phase === 'completed' ? new Date() : ota.completedAt
    }, {
      allowMissingJob: true
    });

    if (phase === 'failed') {
      updatedPanel.status = trimString(updatedPanel.ota.previousPanelStatus) || 'online';
      await updatedPanel.save();
    }

    return serializePanel(updatedPanel);
  }

  async listPanels() {
    const panels = await WallPanel.find({}).sort({ room: 1, name: 1 });
    return panels.map((panel) => serializePanel(panel));
  }

  async getPanelById(panelId) {
    const panel = await getPanelDocument(panelId);
    return serializePanel(panel);
  }

  async getPanelProvisioning(panelId, origin = '') {
    const panel = await getPanelDocument(panelId);
    return {
      panel: serializePanel(panel, { includeSecrets: true }),
      provisioning: buildProvisioningSnapshot(panel, origin)
    };
  }

  async registerPanel(input = {}) {
    const name = trimString(input.name);
    const room = trimString(input.room);

    if (!name || !room) {
      throw createError(400, 'Name and room are required');
    }

    const hardwareProfile = trimString(input.hardwareProfile) || 'elecrow-crowpanel-2.1-rotary';
    const registrationCode = buildRegistrationCode();
    const { claimToken, claimTokenExpires } = issueClaimToken();

    const panel = new WallPanel({
      name,
      room,
      hardwareProfile,
      status: 'offline',
      powerSource: trimString(input.powerSource) || 'wired',
      connectionType: 'wifi',
      ota: normalizeOtaState(),
      settings: buildDefaultSettings({
        ...(input.settings || {}),
        registered: false,
        registrationCode,
        claimToken,
        claimTokenExpires
      })
    });

    await panel.save();

    void eventStreamService.publishSafe({
      type: 'wall_panel.registered',
      source: 'wall_panel',
      category: 'panel',
      payload: {
        panelId: toId(panel._id),
        name: panel.name,
        room: panel.room,
        hardwareProfile: panel.hardwareProfile
      },
      tags: ['wall-panel', 'registration']
    });

    return serializePanel(panel, { includeSecrets: true });
  }

  async updatePanel(panelId, updates = {}) {
    const panel = await getPanelDocument(panelId);

    if (updates.name !== undefined) {
      const name = trimString(updates.name);
      if (!name) {
        throw createError(400, 'Panel name cannot be empty');
      }
      panel.name = name;
    }

    if (updates.room !== undefined) {
      const room = trimString(updates.room);
      if (!room) {
        throw createError(400, 'Panel room cannot be empty');
      }
      panel.room = room;
    }

    if (updates.hardwareProfile !== undefined) {
      panel.hardwareProfile = trimString(updates.hardwareProfile) || panel.hardwareProfile;
    }

    if (updates.powerSource !== undefined) {
      panel.powerSource = trimString(updates.powerSource) || panel.powerSource;
    }

    if (updates.status !== undefined) {
      panel.status = trimString(updates.status) || panel.status;
    }

    if (updates.firmwareVersion !== undefined) {
      panel.firmwareVersion = trimString(updates.firmwareVersion);
    }

    if (updates.ipAddress !== undefined) {
      panel.ipAddress = trimString(updates.ipAddress);
    }

    if (updates.settings !== undefined) {
      panel.settings = mergeSettings(panel.settings || {}, updates.settings);
    }

    await panel.save();

    void eventStreamService.publishSafe({
      type: 'wall_panel.updated',
      source: 'wall_panel',
      category: 'panel',
      payload: {
        panelId: toId(panel._id),
        name: panel.name,
        room: panel.room
      },
      tags: ['wall-panel', 'update']
    });

    return serializePanel(panel);
  }

  async rotateClaimToken(panelId) {
    const panel = await getPanelDocument(panelId);
    const { claimToken, claimTokenExpires } = issueClaimToken();
    panel.settings = mergeSettings(panel.settings || {}, {
      claimToken,
      claimTokenExpires
    });
    await panel.save();
    return serializePanel(panel, { includeSecrets: true });
  }

  async rotateRegistrationCode(panelId, origin = '') {
    const panel = await getPanelDocument(panelId);
    const registrationCode = buildRegistrationCode();
    panel.status = 'offline';
    panel.ota = mergeOtaState(panel.ota || {}, {
      status: 'idle',
      phase: 'idle',
      progress: 0,
      message: '',
      lastError: '',
      artifactPath: '',
      artifactSizeBytes: 0,
      bytesTransferred: 0,
      bytesTotal: 0,
      targetVersion: '',
      jobId: '',
      completedAt: null
    });
    panel.settings = mergeSettings(panel.settings || {}, {
      registered: false,
      registrationCode
    });
    await panel.save();

    void eventStreamService.publishSafe({
      type: 'wall_panel.registration_rotated',
      source: 'wall_panel',
      category: 'panel',
      payload: {
        panelId: toId(panel._id),
        name: panel.name,
        room: panel.room
      },
      tags: ['wall-panel', 'registration']
    });

    return {
      panel: serializePanel(panel, { includeSecrets: true }),
      provisioning: buildProvisioningSnapshot(panel, origin)
    };
  }

  async bootstrapPanel(panelId, credentials = {}, origin = '') {
    const panel = await ensurePanelAccess(panelId, credentials);
    const state = await this.getPanelState(panelId, credentials, origin);
    return {
      panel: serializePanel(panel),
      provisioning: buildProvisioningSnapshot(panel, origin),
      state
    };
  }

  async activatePanel(panelId, credentials = {}, activation = {}) {
    const panel = await ensurePanelAccess(panelId, credentials);
    panel.ipAddress = trimString(activation.ipAddress || activation.ip || panel.ipAddress);
    panel.firmwareVersion = trimString(activation.firmwareVersion || panel.firmwareVersion);
    panel.settings = mergeSettings(panel.settings || {}, {
      registered: true,
      claimToken: '',
      claimTokenExpires: null
    });

    const currentOta = normalizeOtaState(panel.ota || {});
    if (currentOta.targetVersion && panel.firmwareVersion === currentOta.targetVersion) {
      panel.status = 'online';
      panel.ota = mergeOtaState(currentOta, {
        status: 'completed',
        phase: 'completed',
        progress: 100,
        currentVersion: panel.firmwareVersion,
        message: 'Orb is now running the latest HomeBrain firmware.',
        lastError: '',
        completedAt: new Date()
      });
    } else if (otaStatusIsActive(currentOta.status)) {
      panel.status = 'updating';
      panel.ota = mergeOtaState(currentOta, {
        currentVersion: panel.firmwareVersion
      });
    } else {
      panel.status = 'online';
      panel.ota = mergeOtaState(currentOta, {
        currentVersion: panel.firmwareVersion
      });
    }

    await panel.save();

    void eventStreamService.publishSafe({
      type: 'wall_panel.activated',
      source: 'wall_panel',
      category: 'panel',
      payload: {
        panelId: toId(panel._id),
        ipAddress: panel.ipAddress || '',
        firmwareVersion: panel.firmwareVersion || ''
      },
      tags: ['wall-panel', 'activation']
    });

    return serializePanel(panel);
  }

  async getPanelState(panelId, credentials = {}, origin = '') {
    const panel = normalizePanelDocument(await ensurePanelAccess(panelId, credentials));
    const roomDevices = await Device.find({ room: panel.room }).sort({ name: 1 });
    const allDevices = await Device.find({}).sort({ room: 1, name: 1 });

    let securityStatus = null;
    try {
      securityStatus = await securityAlarmService.getAlarmStatus({ refreshDoorLocks: false });
    } catch (error) {
      securityStatus = {
        alarmState: 'unknown',
        isArmed: false,
        isTriggered: false,
        error: error.message
      };
    }

    const weatherSnapshot = await weatherService.fetchDashboardWeather().catch(() => null);

    const thermostatDevice = await resolveThermostatDevice(panel.settings, roomDevices).catch(() => null);
    const sensorDevice = await resolveSensorDevice(panel.settings, roomDevices).catch(() => null);

    const thermostat = buildThermostatMode(panel, thermostatDevice, sensorDevice, weatherSnapshot);
    const room = await buildRoomMode(panel, roomDevices, allDevices);
    const home = buildHomeMode(panel, securityStatus, allDevices);
    const media = await buildMediaMode(panel);
    const quiet = await buildQuietMode(panel);
    const modeMap = { thermostat, room, home, media, quiet };
    const modeOrder = panel.settings.modeOrder.filter((mode) => modeMap[mode]);

    return {
      panel: {
        id: panel.id,
        name: panel.name,
        room: panel.room,
        hardwareProfile: panel.hardwareProfile,
        status: panel.status,
        firmwareVersion: panel.firmwareVersion || '',
        lastSeen: panel.lastSeen || null
      },
      transport: {
        pollIntervalMs: panel.settings.pollingIntervalMs || DEFAULT_POLL_INTERVAL_MS,
        supportsEncoder: true,
        supportsSwipeModes: true
      },
      ota: buildPanelOtaPayload(panel, origin),
      theme: buildThemeSnapshot(),
      modeOrder,
      modes: modeMap,
      generatedAt: new Date().toISOString()
    };
  }

  async executeAction(panelId, credentials = {}, request = {}) {
    const panel = normalizePanelDocument(await ensurePanelAccess(panelId, credentials));
    const type = trimString(request.type).toLowerCase();
    const targetId = toId(request.targetId || request.deviceId || request.sceneId || request.activityId);
    const actor = `wall-panel:${panel.id}`;

    if (!type) {
      throw createError(400, 'Action type is required');
    }

    let result = null;

    switch (type) {
      case 'thermostat.set_temperature': {
        const deviceId = targetId || toId(panel.settings.thermostat.deviceId);
        const value = Number(request.value);
        if (!deviceId || !Number.isFinite(value)) {
          throw createError(400, 'Thermostat setpoint requires a device and numeric value');
        }
        result = await deviceService.controlDevice(deviceId, 'set_temperature', value);
        break;
      }

      case 'thermostat.set_mode': {
        const deviceId = targetId || toId(panel.settings.thermostat.deviceId);
        const value = trimString(request.value).toLowerCase();
        if (!deviceId || !THERMOSTAT_MODES.includes(value)) {
          throw createError(400, 'Thermostat mode must be auto, cool, heat, or off');
        }
        result = await deviceService.controlDevice(deviceId, 'set_mode', value);
        break;
      }

      case 'scene.activate': {
        const sceneId = targetId;
        if (!sceneId) {
          throw createError(400, 'Scene activation requires a scene ID');
        }
        result = await sceneService.activateScene(sceneId);
        break;
      }

      case 'device.control': {
        const deviceId = targetId;
        const action = trimString(request.action);
        if (!deviceId || !action) {
          throw createError(400, 'Device control requires device ID and action');
        }
        result = await deviceService.controlDevice(deviceId, action, request.value);
        break;
      }

      case 'security.arm': {
        const mode = trimString(request.value || request.mode).toLowerCase();
        if (!['stay', 'away'].includes(mode)) {
          throw createError(400, 'Security arm requires mode "stay" or "away"');
        }
        result = await securityAlarmService.armAlarm(mode, actor);
        break;
      }

      case 'security.disarm':
        result = await securityAlarmService.disarmAlarm(actor);
        break;

      case 'security.dismiss':
        result = await securityAlarmService.dismissAlarm(actor);
        break;

      case 'harmony.activity.start': {
        const hubIp = trimString(request.hubIp || panel.settings.harmony.hubIp);
        const activityId = targetId;
        if (!hubIp || !activityId) {
          throw createError(400, 'Harmony activity start requires a hub and activity ID');
        }
        result = await harmonyService.startActivity(hubIp, activityId);
        break;
      }

      case 'harmony.power_off': {
        const hubIp = trimString(request.hubIp || panel.settings.harmony.hubIp);
        if (!hubIp) {
          throw createError(400, 'Harmony power off requires a hub IP');
        }
        result = await harmonyService.turnOffHub(hubIp);
        break;
      }

      case 'harmony.command': {
        const hubIp = trimString(request.hubIp || panel.settings.harmony.hubIp);
        const deviceId = targetId || toId(panel.settings.harmony.commandDeviceId);
        const command = trimString(request.action || request.command);
        if (!hubIp || !deviceId || !command) {
          throw createError(400, 'Harmony command requires hub, device ID, and command');
        }
        result = await harmonyService.sendDeviceCommand(hubIp, deviceId, command, request.holdMs);
        break;
      }

      case 'panel.noop':
        result = { success: true };
        break;

      default:
        throw createError(400, `Unsupported wall panel action: ${type}`);
    }

    void eventStreamService.publishSafe({
      type: 'wall_panel.action',
      source: 'wall_panel',
      category: 'panel',
      payload: {
        panelId: panel.id,
        actionType: type,
        targetId,
        actor
      },
      tags: ['wall-panel', 'action']
    });

    return {
      success: true,
      actionType: type,
      result
    };
  }
}

module.exports = new WallPanelService();

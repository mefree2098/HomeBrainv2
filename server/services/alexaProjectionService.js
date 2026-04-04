const AlexaBrokerRegistration = require('../models/AlexaBrokerRegistration');
const AlexaExposure = require('../models/AlexaExposure');
const Device = require('../models/Device');
const Scene = require('../models/Scene');
const Workflow = require('../models/Workflow');
const deviceGroupService = require('./deviceGroupService');
const deviceService = require('./deviceService');
const {
  ALEXA_DISPLAY_CATEGORIES,
  ALEXA_INTERFACES,
  ALEXA_PROJECTION_TYPES,
  ALEXA_RESTRICTED_SCENE_DEVICE_TYPES,
  buildEndpointId,
  normalizeAlexaName,
  parseEndpointId,
  uniqueCaseInsensitive
} = require('../../shared/alexa/contracts');

const RESTRICTED_DEVICE_TYPES = new Set(ALEXA_RESTRICTED_SCENE_DEVICE_TYPES);
const DEVICE_GROUP_FALLBACK_TYPES = new Set(['light', 'switch']);
const ALLOWED_WORKFLOW_ACTION_TYPES = new Set(['device_control', 'scene_activate', 'delay']);
const THERMOSTAT_MODE_MAP = Object.freeze({
  auto: 'AUTO',
  cool: 'COOL',
  heat: 'HEAT',
  off: 'OFF'
});

function propertyDescriptor(name) {
  return { name };
}

function buildReportableCapability(interfaceName, supportedNames = [], extra = {}) {
  return {
    type: 'AlexaInterface',
    interface: interfaceName,
    version: '3',
    properties: {
      supported: supportedNames.map((name) => propertyDescriptor(name)),
      proactivelyReported: true,
      retrievable: true
    },
    ...extra
  };
}

function buildSceneCapability() {
  return {
    type: 'AlexaInterface',
    interface: ALEXA_INTERFACES.SCENE_CONTROLLER,
    version: '3',
    supportsDeactivation: false,
    proactivelyReported: false
  };
}

function buildAlexaBaseCapability() {
  return {
    type: 'AlexaInterface',
    interface: ALEXA_INTERFACES.BASE,
    version: '3'
  };
}

function toObjectIdString(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (typeof value?.toString === 'function') {
    return value.toString();
  }

  return String(value).trim();
}

function normalizeDisplayDescription(value, fallback) {
  const normalized = normalizeAlexaName(value);
  return normalized || fallback;
}

function buildAlexaProperty(namespace, name, value) {
  return {
    namespace,
    name,
    value,
    timeOfSample: new Date().toISOString(),
    uncertaintyInMilliseconds: 500
  };
}

function normalizeSmartThingsValue(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim().toLowerCase();
  }

  if (typeof value === 'object') {
    const candidate = value.id || value.capabilityId || value.name;
    if (typeof candidate === 'string') {
      return candidate.trim().toLowerCase();
    }
  }

  return '';
}

function getSmartThingsCapabilitySet(device) {
  const values = [
    ...(Array.isArray(device?.properties?.smartThingsCapabilities) ? device.properties.smartThingsCapabilities : []),
    ...(Array.isArray(device?.properties?.smartthingsCapabilities) ? device.properties.smartthingsCapabilities : [])
  ];
  return new Set(values.map((entry) => normalizeSmartThingsValue(entry)).filter(Boolean));
}

function getDeviceAlexaName(device, exposure = {}) {
  return normalizeAlexaName(exposure.friendlyName, device?.name || 'Unnamed device');
}

function getExposureAliases(entity = {}, exposure = {}) {
  const values = [];

  if (Array.isArray(exposure?.aliases)) {
    values.push(...exposure.aliases);
  }

  if (Array.isArray(entity?.voiceAliases)) {
    values.push(...entity.voiceAliases);
  }

  return uniqueCaseInsensitive(values);
}

function supportsColorTemperatureControl(device) {
  if (!device) {
    return false;
  }

  if (typeof device?.colorTemperature === 'number') {
    return true;
  }

  if (device?.properties?.supportsColorTemperature === true) {
    return true;
  }

  return getSmartThingsCapabilitySet(device).has('colortemperature');
}

function isTemperatureSensorDevice(device) {
  if (!device) {
    return false;
  }

  if (device.type === 'thermostat') {
    return true;
  }

  return typeof device.temperature === 'number';
}

function normalizeThermostatMode(device) {
  const mode = deviceService.normalizeThermostatMode?.(
    device?.properties?.hvacMode
    || device?.properties?.smartThingsThermostatMode
    || device?.properties?.smartThingsLastActiveThermostatMode
    || (device?.status ? 'heat' : 'off')
  );

  return THERMOSTAT_MODE_MAP[mode] || 'OFF';
}

function hexToAlexaColor(hex) {
  const normalized = deviceService.normalizeHexColor?.(hex);
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
      hue = ((b - r) / delta) + 2;
    } else {
      hue = ((r - g) / delta) + 4;
    }

    hue *= 60;
    if (hue < 0) {
      hue += 360;
    }
  }

  const saturation = max === 0 ? 0 : delta / max;
  return {
    hue,
    saturation: Number(saturation.toFixed(4)),
    brightness: Number(max.toFixed(4))
  };
}

function buildEndpointStatePropertiesForDevice(device, inferred = inferDeviceTraits(device)) {
  const properties = [];

  if (inferred.interfaces.has(ALEXA_INTERFACES.POWER_CONTROLLER)) {
    properties.push(buildAlexaProperty(
      ALEXA_INTERFACES.POWER_CONTROLLER,
      'powerState',
      device?.status ? 'ON' : 'OFF'
    ));
  }

  if (inferred.interfaces.has(ALEXA_INTERFACES.BRIGHTNESS_CONTROLLER)) {
    properties.push(buildAlexaProperty(
      ALEXA_INTERFACES.BRIGHTNESS_CONTROLLER,
      'brightness',
      Math.max(0, Math.min(100, Number(device?.brightness || 0)))
    ));
  }

  if (inferred.interfaces.has(ALEXA_INTERFACES.COLOR_CONTROLLER)) {
    const color = hexToAlexaColor(device?.color || '#ffffff');
    if (color) {
      properties.push(buildAlexaProperty(
        ALEXA_INTERFACES.COLOR_CONTROLLER,
        'color',
        color
      ));
    }
  }

  if (inferred.interfaces.has(ALEXA_INTERFACES.COLOR_TEMPERATURE_CONTROLLER)) {
    const colorTemperature = Number(device?.colorTemperature ?? device?.properties?.colorTemperature);
    if (Number.isFinite(colorTemperature)) {
      properties.push(buildAlexaProperty(
        ALEXA_INTERFACES.COLOR_TEMPERATURE_CONTROLLER,
        'colorTemperatureInKelvin',
        Math.max(1000, Math.min(10000, Math.round(colorTemperature)))
      ));
    }
  }

  if (inferred.interfaces.has(ALEXA_INTERFACES.THERMOSTAT_CONTROLLER)) {
    if (Number.isFinite(Number(device?.targetTemperature))) {
      properties.push(buildAlexaProperty(
        ALEXA_INTERFACES.THERMOSTAT_CONTROLLER,
        'targetSetpoint',
        {
          value: Number(device.targetTemperature),
          scale: 'FAHRENHEIT'
        }
      ));
    }

    properties.push(buildAlexaProperty(
      ALEXA_INTERFACES.THERMOSTAT_CONTROLLER,
      'thermostatMode',
      normalizeThermostatMode(device)
    ));
  }

  if (inferred.interfaces.has(ALEXA_INTERFACES.TEMPERATURE_SENSOR) && Number.isFinite(Number(device?.temperature))) {
    properties.push(buildAlexaProperty(
      ALEXA_INTERFACES.TEMPERATURE_SENSOR,
      'temperature',
      {
        value: Number(device.temperature),
        scale: 'FAHRENHEIT'
      }
    ));
  }

  if (inferred.interfaces.has(ALEXA_INTERFACES.LOCK_CONTROLLER)) {
    properties.push(buildAlexaProperty(
      ALEXA_INTERFACES.LOCK_CONTROLLER,
      'lockState',
      device?.status ? 'LOCKED' : 'UNLOCKED'
    ));
  }

  properties.push(buildAlexaProperty(
    ALEXA_INTERFACES.ENDPOINT_HEALTH,
    'connectivity',
    {
      value: device?.isOnline === false ? 'UNREACHABLE' : 'OK'
    }
  ));

  return properties;
}

function getRestrictedDeviceReason(device) {
  if (!device) {
    return 'Scene references a missing device';
  }

  if (RESTRICTED_DEVICE_TYPES.has(device.type)) {
    switch (device.type) {
      case 'camera':
        return `Device "${device.name}" is a camera and cannot be projected as an Alexa scene or workflow`;
      case 'lock':
        return `Device "${device.name}" is a lock and cannot be projected as an Alexa scene or workflow`;
      case 'garage':
        return `Device "${device.name}" is a garage door and cannot be projected as an Alexa scene or workflow`;
      case 'sensor':
        return `Device "${device.name}" is a sensor and cannot be projected as an Alexa scene or workflow`;
      default:
        return `Device "${device.name}" is restricted for Alexa scene projection`;
    }
  }

  return '';
}

function inferDeviceTraits(device) {
  const interfaces = new Set();
  const capabilities = [buildAlexaBaseCapability()];
  const displayCategories = [];
  const validationErrors = [];
  const validationWarnings = [];

  if (!device) {
    validationErrors.push('Device could not be found');
    return {
      projectionType: ALEXA_PROJECTION_TYPES.DEVICE,
      interfaces,
      capabilities,
      displayCategories,
      validationErrors,
      validationWarnings
    };
  }

  switch (device.type) {
    case 'light':
    case 'switch':
      interfaces.add(ALEXA_INTERFACES.POWER_CONTROLLER);
      capabilities.push(buildReportableCapability(ALEXA_INTERFACES.POWER_CONTROLLER, ['powerState']));
      displayCategories.push(deviceService.supportsBrightnessControl(device)
        ? ALEXA_DISPLAY_CATEGORIES.LIGHT
        : ALEXA_DISPLAY_CATEGORIES.SWITCH);
      break;
    case 'thermostat':
      interfaces.add(ALEXA_INTERFACES.THERMOSTAT_CONTROLLER);
      capabilities.push(buildReportableCapability(ALEXA_INTERFACES.THERMOSTAT_CONTROLLER, ['targetSetpoint', 'thermostatMode']));
      displayCategories.push(ALEXA_DISPLAY_CATEGORIES.THERMOSTAT);
      break;
    case 'lock':
      interfaces.add(ALEXA_INTERFACES.LOCK_CONTROLLER);
      capabilities.push(buildReportableCapability(ALEXA_INTERFACES.LOCK_CONTROLLER, ['lockState']));
      displayCategories.push(ALEXA_DISPLAY_CATEGORIES.SMARTLOCK);
      break;
    case 'sensor':
      if (isTemperatureSensorDevice(device)) {
        displayCategories.push(ALEXA_DISPLAY_CATEGORIES.TEMPERATURE_SENSOR);
      } else {
        validationErrors.push(`Device type "${device.type}" is not supported for Alexa v1 exposure`);
      }
      break;
    default:
      validationErrors.push(`Device type "${device.type}" is not supported for Alexa v1 exposure`);
      break;
  }

  if (deviceService.supportsBrightnessControl(device)) {
    interfaces.add(ALEXA_INTERFACES.BRIGHTNESS_CONTROLLER);
    capabilities.push(buildReportableCapability(ALEXA_INTERFACES.BRIGHTNESS_CONTROLLER, ['brightness']));
  }

  if (deviceService.supportsColorControl(device)) {
    interfaces.add(ALEXA_INTERFACES.COLOR_CONTROLLER);
    capabilities.push(buildReportableCapability(ALEXA_INTERFACES.COLOR_CONTROLLER, ['color']));
  }

  if (supportsColorTemperatureControl(device)) {
    interfaces.add(ALEXA_INTERFACES.COLOR_TEMPERATURE_CONTROLLER);
    capabilities.push(buildReportableCapability(ALEXA_INTERFACES.COLOR_TEMPERATURE_CONTROLLER, ['colorTemperatureInKelvin']));
  }

  if (isTemperatureSensorDevice(device)) {
    interfaces.add(ALEXA_INTERFACES.TEMPERATURE_SENSOR);
    capabilities.push(buildReportableCapability(ALEXA_INTERFACES.TEMPERATURE_SENSOR, ['temperature']));
  }

  interfaces.add(ALEXA_INTERFACES.ENDPOINT_HEALTH);
  capabilities.push(buildReportableCapability(ALEXA_INTERFACES.ENDPOINT_HEALTH, ['connectivity']));

  if (displayCategories.length === 0 && interfaces.has(ALEXA_INTERFACES.POWER_CONTROLLER)) {
    displayCategories.push(ALEXA_DISPLAY_CATEGORIES.SWITCH);
  }

  return {
    projectionType: ALEXA_PROJECTION_TYPES.DEVICE,
    interfaces,
    capabilities,
    displayCategories,
    validationErrors: uniqueCaseInsensitive(validationErrors),
    validationWarnings: uniqueCaseInsensitive(validationWarnings)
  };
}

function inferGroupTraits(group = {}, memberDevices = []) {
  const validationErrors = [];
  const validationWarnings = [];
  const interfaces = new Set();
  const capabilities = [buildAlexaBaseCapability()];
  const displayCategories = [];
  const activeMembers = Array.isArray(memberDevices) ? memberDevices.filter(Boolean) : [];

  if (activeMembers.length === 0) {
    validationErrors.push(`Device group "${group.name || 'Unnamed group'}" has no members`);
    return {
      projectionType: ALEXA_PROJECTION_TYPES.GROUP,
      interfaces,
      capabilities,
      displayCategories,
      validationErrors,
      validationWarnings
    };
  }

  const types = new Set(activeMembers.map((device) => device.type));
  const allSupportPower = activeMembers.every((device) => inferDeviceTraits(device).interfaces.has(ALEXA_INTERFACES.POWER_CONTROLLER));
  const allSupportBrightness = activeMembers.every((device) => inferDeviceTraits(device).interfaces.has(ALEXA_INTERFACES.BRIGHTNESS_CONTROLLER));
  const allSupportColor = activeMembers.every((device) => inferDeviceTraits(device).interfaces.has(ALEXA_INTERFACES.COLOR_CONTROLLER));
  const allSupportColorTemperature = activeMembers.every((device) => inferDeviceTraits(device).interfaces.has(ALEXA_INTERFACES.COLOR_TEMPERATURE_CONTROLLER));

  if (!allSupportPower) {
    validationErrors.push(`Device group "${group.name || 'Unnamed group'}" does not share a safe power-control intersection`);
    return {
      projectionType: ALEXA_PROJECTION_TYPES.GROUP,
      interfaces,
      capabilities,
      displayCategories,
      validationErrors,
      validationWarnings
    };
  }

  if (types.size === 1 && types.has('light')) {
    displayCategories.push(ALEXA_DISPLAY_CATEGORIES.LIGHT);
  } else if (types.size === 1 && types.has('switch')) {
    displayCategories.push(ALEXA_DISPLAY_CATEGORIES.SWITCH);
  } else if ([...types].every((entry) => DEVICE_GROUP_FALLBACK_TYPES.has(entry))) {
    displayCategories.push(ALEXA_DISPLAY_CATEGORIES.SWITCH);
    validationWarnings.push(`Device group "${group.name || 'Unnamed group'}" mixes light and switch members, so Alexa exposure falls back to power control`);
  } else {
    validationErrors.push(`Device group "${group.name || 'Unnamed group'}" contains unsupported member types for Alexa grouping`);
    return {
      projectionType: ALEXA_PROJECTION_TYPES.GROUP,
      interfaces,
      capabilities,
      displayCategories,
      validationErrors,
      validationWarnings
    };
  }

  interfaces.add(ALEXA_INTERFACES.POWER_CONTROLLER);
  capabilities.push(buildReportableCapability(ALEXA_INTERFACES.POWER_CONTROLLER, ['powerState']));

  if (displayCategories[0] === ALEXA_DISPLAY_CATEGORIES.LIGHT && allSupportBrightness) {
    interfaces.add(ALEXA_INTERFACES.BRIGHTNESS_CONTROLLER);
    capabilities.push(buildReportableCapability(ALEXA_INTERFACES.BRIGHTNESS_CONTROLLER, ['brightness']));
  }

  if (displayCategories[0] === ALEXA_DISPLAY_CATEGORIES.LIGHT && allSupportColor) {
    interfaces.add(ALEXA_INTERFACES.COLOR_CONTROLLER);
    capabilities.push(buildReportableCapability(ALEXA_INTERFACES.COLOR_CONTROLLER, ['color']));
  }

  if (displayCategories[0] === ALEXA_DISPLAY_CATEGORIES.LIGHT && allSupportColorTemperature) {
    interfaces.add(ALEXA_INTERFACES.COLOR_TEMPERATURE_CONTROLLER);
    capabilities.push(buildReportableCapability(ALEXA_INTERFACES.COLOR_TEMPERATURE_CONTROLLER, ['colorTemperatureInKelvin']));
  }

  interfaces.add(ALEXA_INTERFACES.ENDPOINT_HEALTH);
  capabilities.push(buildReportableCapability(ALEXA_INTERFACES.ENDPOINT_HEALTH, ['connectivity']));

  return {
    projectionType: ALEXA_PROJECTION_TYPES.GROUP,
    interfaces,
    capabilities,
    displayCategories,
    validationErrors: uniqueCaseInsensitive(validationErrors),
    validationWarnings: uniqueCaseInsensitive(validationWarnings)
  };
}

function buildGroupStateProperties(memberDevices = [], traits = inferGroupTraits({}, memberDevices)) {
  const devices = Array.isArray(memberDevices) ? memberDevices.filter(Boolean) : [];
  if (devices.length === 0) {
    return [
      buildAlexaProperty(ALEXA_INTERFACES.ENDPOINT_HEALTH, 'connectivity', { value: 'UNREACHABLE' })
    ];
  }

  const properties = [];
  if (traits.interfaces.has(ALEXA_INTERFACES.POWER_CONTROLLER)) {
    const onCount = devices.filter((device) => device.status).length;
    properties.push(buildAlexaProperty(
      ALEXA_INTERFACES.POWER_CONTROLLER,
      'powerState',
      onCount > 0 ? 'ON' : 'OFF'
    ));
  }

  if (traits.interfaces.has(ALEXA_INTERFACES.BRIGHTNESS_CONTROLLER)) {
    const averageBrightness = Math.round(
      devices.reduce((sum, device) => sum + Number(device.brightness || 0), 0) / devices.length
    );
    properties.push(buildAlexaProperty(
      ALEXA_INTERFACES.BRIGHTNESS_CONTROLLER,
      'brightness',
      averageBrightness
    ));
  }

  if (traits.interfaces.has(ALEXA_INTERFACES.COLOR_CONTROLLER)) {
    const firstColorCapable = devices.find((device) => device?.color);
    const color = firstColorCapable ? hexToAlexaColor(firstColorCapable.color) : null;
    if (color) {
      properties.push(buildAlexaProperty(
        ALEXA_INTERFACES.COLOR_CONTROLLER,
        'color',
        color
      ));
    }
  }

  if (traits.interfaces.has(ALEXA_INTERFACES.COLOR_TEMPERATURE_CONTROLLER)) {
    const candidates = devices
      .map((device) => Number(device?.colorTemperature ?? device?.properties?.colorTemperature))
      .filter((value) => Number.isFinite(value));
    if (candidates.length > 0) {
      const average = Math.round(candidates.reduce((sum, value) => sum + value, 0) / candidates.length);
      properties.push(buildAlexaProperty(
        ALEXA_INTERFACES.COLOR_TEMPERATURE_CONTROLLER,
        'colorTemperatureInKelvin',
        average
      ));
    }
  }

  properties.push(buildAlexaProperty(
    ALEXA_INTERFACES.ENDPOINT_HEALTH,
    'connectivity',
    {
      value: devices.every((device) => device?.isOnline === false) ? 'UNREACHABLE' : 'OK'
    }
  ));

  return properties;
}

function validateSceneExposure(scene, sceneContext = new Map()) {
  const devicesById = sceneContext instanceof Map
    ? sceneContext
    : (sceneContext?.devicesById || new Map());
  const groupsById = sceneContext instanceof Map
    ? new Map()
    : (sceneContext?.groupsById || new Map());
  const validationErrors = [];
  const validationWarnings = [];
  const resolvedDevices = [];
  const seenDeviceIds = new Set();

  if (!scene) {
    validationErrors.push('Scene could not be found');
    return { validationErrors, validationWarnings, devices: resolvedDevices };
  }

  const hasDeviceActions = Array.isArray(scene.deviceActions) && scene.deviceActions.length > 0;
  const hasGroupActions = Array.isArray(scene.groupActions) && scene.groupActions.length > 0;

  if (!hasDeviceActions && !hasGroupActions) {
    validationErrors.push(`Scene "${scene.name}" has no actions to expose to Alexa`);
    return { validationErrors, validationWarnings, devices: resolvedDevices };
  }

  (scene.deviceActions || []).forEach((action) => {
    const deviceId = toObjectIdString(action?.deviceId?._id || action?.deviceId);
    const device = devicesById.get(deviceId);
    if (device && !seenDeviceIds.has(deviceId)) {
      seenDeviceIds.add(deviceId);
      resolvedDevices.push(device);
    }
    const restrictedReason = getRestrictedDeviceReason(device);
    if (restrictedReason) {
      validationErrors.push(restrictedReason);
    }
  });

  (scene.groupActions || []).forEach((action) => {
    const groupId = toObjectIdString(action?.groupId?._id || action?.groupId);
    const group = groupsById.get(groupId);
    if (!group) {
      validationErrors.push(`Scene "${scene.name}" references a device group that could not be found`);
      return;
    }

    (Array.isArray(group.deviceIds) ? group.deviceIds : []).forEach((deviceId) => {
      const normalizedDeviceId = toObjectIdString(deviceId);
      const device = devicesById.get(normalizedDeviceId);
      if (device && !seenDeviceIds.has(normalizedDeviceId)) {
        seenDeviceIds.add(normalizedDeviceId);
        resolvedDevices.push(device);
      }

      const restrictedReason = getRestrictedDeviceReason(device);
      if (restrictedReason) {
        validationErrors.push(restrictedReason);
      }
    });
  });

  return {
    validationErrors: uniqueCaseInsensitive(validationErrors),
    validationWarnings: uniqueCaseInsensitive(validationWarnings),
    devices: resolvedDevices
  };
}

function resolveWorkflowTargetDevices(action, context = {}) {
  const devicesById = context.devicesById || new Map();
  const groupsById = context.groupsById || new Map();
  const groupsByNormalizedName = context.groupsByNormalizedName || new Map();
  const scenesById = context.scenesById || new Map();

  if (!action || typeof action !== 'object') {
    return [];
  }

  if (action.type === 'scene_activate') {
    const sceneId = toObjectIdString(action?.target?.sceneId || action?.target);
    const scene = scenesById.get(sceneId);
    if (!scene) {
      return [null];
    }

    const devices = [];

    (scene.deviceActions || []).forEach((sceneAction) => {
      const deviceId = toObjectIdString(sceneAction?.deviceId?._id || sceneAction?.deviceId);
      devices.push(devicesById.get(deviceId) || null);
    });

    (scene.groupActions || []).forEach((sceneAction) => {
      const groupId = toObjectIdString(sceneAction?.groupId?._id || sceneAction?.groupId);
      const group = groupsById.get(groupId);
      if (!group) {
        devices.push(null);
        return;
      }

      (Array.isArray(group.deviceIds) ? group.deviceIds : []).forEach((deviceId) => {
        devices.push(devicesById.get(toObjectIdString(deviceId)) || null);
      });
    });

    return devices;
  }

  if (action.type !== 'device_control') {
    return [];
  }

  const target = action.target;
  if (typeof target === 'string') {
    return [devicesById.get(toObjectIdString(target)) || null];
  }

  if (target && typeof target === 'object') {
    const groupName = normalizeAlexaName(target.group || target.name || target.label || target.value);
    const kind = String(target.kind || target.type || '').trim().toLowerCase();
    if (groupName && (kind === 'device_group' || kind === 'group')) {
      const group = groupsByNormalizedName.get(groupName.toLowerCase());
      if (!group) {
        return [null];
      }

      return (Array.isArray(group.deviceIds) ? group.deviceIds : [])
        .map((deviceId) => devicesById.get(toObjectIdString(deviceId)) || null);
    }

    const deviceId = toObjectIdString(target.deviceId || target.id || target.value);
    if (deviceId) {
      return [devicesById.get(deviceId) || null];
    }
  }

  return [];
}

function validateWorkflowExposure(workflow, context = {}) {
  const validationErrors = [];
  const validationWarnings = [];

  if (!workflow) {
    validationErrors.push('Workflow could not be found');
    return { validationErrors, validationWarnings, displayCategory: ALEXA_DISPLAY_CATEGORIES.SCENE_TRIGGER };
  }

  if (workflow.enabled === false) {
    validationErrors.push(`Workflow "${workflow.name}" is disabled`);
  }

  if (workflow?.trigger?.type !== 'manual') {
    validationErrors.push(`Workflow "${workflow?.name || 'Unnamed workflow'}" must use a manual trigger for Alexa scene exposure`);
  }

  const actions = Array.isArray(workflow.actions) ? workflow.actions : [];
  if (actions.length === 0) {
    validationErrors.push(`Workflow "${workflow.name}" has no actions to expose`);
  }

  let hasDelay = false;
  actions.forEach((action) => {
    if (!ALLOWED_WORKFLOW_ACTION_TYPES.has(action?.type)) {
      validationErrors.push(`Workflow "${workflow.name}" uses unsupported action type "${action?.type || 'unknown'}" for Alexa exposure`);
      return;
    }

    if (action.type === 'delay') {
      hasDelay = true;
    }

    const targetDevices = resolveWorkflowTargetDevices(action, context);
    targetDevices.forEach((device) => {
      const restrictedReason = getRestrictedDeviceReason(device);
      if (restrictedReason) {
        validationErrors.push(restrictedReason);
      }
      if (!device) {
        validationErrors.push(`Workflow "${workflow.name}" references a missing device or scene`);
      }
    });
  });

  return {
    validationErrors: uniqueCaseInsensitive(validationErrors),
    validationWarnings: uniqueCaseInsensitive(validationWarnings),
    displayCategory: hasDelay
      ? ALEXA_DISPLAY_CATEGORIES.ACTIVITY_TRIGGER
      : ALEXA_DISPLAY_CATEGORIES.SCENE_TRIGGER
  };
}

function inferProjectionType(entityType) {
  switch (entityType) {
    case 'device':
      return ALEXA_PROJECTION_TYPES.DEVICE;
    case 'device_group':
      return ALEXA_PROJECTION_TYPES.GROUP;
    case 'scene':
      return ALEXA_PROJECTION_TYPES.SCENE;
    case 'workflow':
      return ALEXA_PROJECTION_TYPES.WORKFLOW_SCENE;
    default:
      return ALEXA_PROJECTION_TYPES.DEVICE;
  }
}

function buildSceneEndpoint(scene, exposure, hubId, validation) {
  return {
    endpointId: buildEndpointId(hubId, exposure.entityType, exposure.entityId),
    manufacturerName: 'HomeBrain',
    friendlyName: normalizeAlexaName(exposure.friendlyName, scene?.name || 'HomeBrain Scene'),
    description: normalizeDisplayDescription(scene?.description, `HomeBrain scene ${scene?.name || ''}`.trim()),
    displayCategories: [ALEXA_DISPLAY_CATEGORIES.SCENE_TRIGGER],
    cookie: {
      entityType: exposure.entityType,
      entityId: exposure.entityId,
      projectionType: ALEXA_PROJECTION_TYPES.SCENE,
      aliases: JSON.stringify(getExposureAliases(scene, exposure))
    },
    capabilities: [
      buildAlexaBaseCapability(),
      buildSceneCapability()
    ],
    state: {
      properties: [],
      connectivity: validation.validationErrors.length === 0 ? 'OK' : 'UNREACHABLE'
    }
  };
}

function buildWorkflowEndpoint(workflow, exposure, hubId, validation) {
  return {
    endpointId: buildEndpointId(hubId, exposure.entityType, exposure.entityId),
    manufacturerName: 'HomeBrain',
    friendlyName: normalizeAlexaName(exposure.friendlyName, workflow?.name || 'HomeBrain Workflow'),
    description: normalizeDisplayDescription(workflow?.description, `HomeBrain workflow ${workflow?.name || ''}`.trim()),
    displayCategories: [validation.displayCategory],
    cookie: {
      entityType: exposure.entityType,
      entityId: exposure.entityId,
      projectionType: ALEXA_PROJECTION_TYPES.WORKFLOW_SCENE,
      aliases: JSON.stringify(getExposureAliases(workflow, exposure))
    },
    capabilities: [
      buildAlexaBaseCapability(),
      buildSceneCapability()
    ],
    state: {
      properties: [],
      connectivity: validation.validationErrors.length === 0 ? 'OK' : 'UNREACHABLE'
    }
  };
}

function mergeValidation(exposure, validation = {}) {
  return {
    validationWarnings: uniqueCaseInsensitive([
      ...(Array.isArray(validation.validationWarnings) ? validation.validationWarnings : []),
      ...(Array.isArray(exposure.validationWarnings) ? exposure.validationWarnings : [])
    ]),
    validationErrors: uniqueCaseInsensitive([
      ...(Array.isArray(validation.validationErrors) ? validation.validationErrors : []),
      ...(Array.isArray(exposure.validationErrors) ? exposure.validationErrors : [])
    ])
  };
}

function applyNamingCollisionWarnings(records = []) {
  const labelOwners = new Map();
  records.forEach((record) => {
    if (!record?.enabled || !record?.endpoint) {
      return;
    }

    const labels = uniqueCaseInsensitive([
      record.endpoint.friendlyName,
      ...getExposureAliases(record.entity, record.exposure)
    ]);

    labels.forEach((label) => {
      const key = label.toLowerCase();
      if (!labelOwners.has(key)) {
        labelOwners.set(key, []);
      }
      labelOwners.get(key).push(record);
    });
  });

  records.forEach((record) => {
    if (!record?.enabled || !record?.endpoint) {
      return;
    }

    const labels = uniqueCaseInsensitive([
      record.endpoint.friendlyName,
      ...getExposureAliases(record.entity, record.exposure)
    ]);
    const extraWarnings = [];

    labels.forEach((label) => {
      const owners = labelOwners.get(label.toLowerCase()) || [];
      if (owners.length <= 1) {
        return;
      }

      const peers = owners
        .filter((entry) => entry.endpoint.endpointId !== record.endpoint.endpointId)
        .map((entry) => entry.endpoint.friendlyName);
      if (peers.length > 0) {
        extraWarnings.push(`Alexa name collision on "${label}" with ${uniqueCaseInsensitive(peers).join(', ')}`);
      }
    });

    record.validationWarnings = uniqueCaseInsensitive([
      ...(record.validationWarnings || []),
      ...extraWarnings
    ]);
  });

  return records;
}

class AlexaProjectionService {
  async ensureBrokerRegistration() {
    let registration = await AlexaBrokerRegistration.findOne();
    if (!registration) {
      registration = new AlexaBrokerRegistration();
      await registration.save();
    }
    return registration;
  }

  async loadContext() {
    const registration = await this.ensureBrokerRegistration();
    const [devices, groups, scenes, workflows, exposures] = await Promise.all([
      Device.find().lean(),
      deviceGroupService.listGroups(),
      Scene.find().lean(),
      Workflow.find().lean(),
      AlexaExposure.find().lean()
    ]);

    const devicesById = new Map(devices.map((device) => [toObjectIdString(device._id), device]));
    const groupsById = new Map(groups.map((group) => [toObjectIdString(group._id), group]));
    const groupsByNormalizedName = new Map(groups.map((group) => [String(group.normalizedName || '').toLowerCase(), group]));
    const scenesById = new Map(scenes.map((scene) => [toObjectIdString(scene._id), scene]));
    const workflowsById = new Map(workflows.map((workflow) => [toObjectIdString(workflow._id), workflow]));

    return {
      registration,
      hubId: registration.hubId,
      devices,
      devicesById,
      groups,
      groupsById,
      groupsByNormalizedName,
      scenes,
      scenesById,
      workflows,
      workflowsById,
      exposures
    };
  }

  async loadEntity(entityType, entityId, context = null) {
    const resolvedContext = context || await this.loadContext();
    const key = toObjectIdString(entityId);

    switch (entityType) {
      case 'device':
        return resolvedContext.devicesById.get(key) || null;
      case 'device_group':
        return resolvedContext.groupsById.get(key) || null;
      case 'scene':
        return resolvedContext.scenesById.get(key) || null;
      case 'workflow':
        return resolvedContext.workflowsById.get(key) || null;
      default:
        return null;
    }
  }

  buildRecordForExposure(exposure, context) {
    const entity = this.loadEntitySync(exposure.entityType, exposure.entityId, context);
    const enabled = exposure.enabled !== false;
    const projectionType = exposure.projectionType || inferProjectionType(exposure.entityType);
    let endpoint = null;
    let validation = { validationWarnings: [], validationErrors: [] };

    if (exposure.entityType === 'device') {
      const traits = inferDeviceTraits(entity);
      validation = mergeValidation(exposure, traits);
      if (validation.validationErrors.length === 0) {
        endpoint = {
          endpointId: buildEndpointId(context.hubId, exposure.entityType, exposure.entityId),
          manufacturerName: 'HomeBrain',
          friendlyName: getDeviceAlexaName(entity, exposure),
          description: normalizeDisplayDescription(entity?.room, `HomeBrain ${entity?.type || 'device'}`),
          displayCategories: traits.displayCategories,
          cookie: {
            entityType: exposure.entityType,
            entityId: exposure.entityId,
            projectionType,
            roomHint: normalizeAlexaName(exposure.roomHint, entity?.room || ''),
            aliases: JSON.stringify(getExposureAliases(entity, exposure))
          },
          capabilities: traits.capabilities,
          state: {
            properties: buildEndpointStatePropertiesForDevice(entity, traits),
            connectivity: entity?.isOnline === false ? 'UNREACHABLE' : 'OK'
          }
        };
      }
    } else if (exposure.entityType === 'device_group') {
      const memberDevices = Array.isArray(entity?.deviceIds)
        ? entity.deviceIds.map((deviceId) => context.devicesById.get(toObjectIdString(deviceId))).filter(Boolean)
        : [];
      const traits = inferGroupTraits(entity, memberDevices);
      validation = mergeValidation(exposure, traits);
      if (validation.validationErrors.length === 0) {
        endpoint = {
          endpointId: buildEndpointId(context.hubId, exposure.entityType, exposure.entityId),
          manufacturerName: 'HomeBrain',
          friendlyName: normalizeAlexaName(exposure.friendlyName, entity?.name || 'HomeBrain Group'),
          description: normalizeDisplayDescription(entity?.description, `HomeBrain group ${entity?.name || ''}`.trim()),
          displayCategories: traits.displayCategories,
          cookie: {
            entityType: exposure.entityType,
            entityId: exposure.entityId,
            projectionType,
            roomHint: normalizeAlexaName(exposure.roomHint, entity?.rooms?.[0] || ''),
            aliases: JSON.stringify(getExposureAliases(entity, exposure)),
            groupDeviceIds: Array.isArray(entity?.deviceIds) ? entity.deviceIds.map((deviceId) => toObjectIdString(deviceId)) : []
          },
          capabilities: traits.capabilities,
          state: {
            properties: buildGroupStateProperties(memberDevices, traits),
            connectivity: memberDevices.every((device) => device?.isOnline === false) ? 'UNREACHABLE' : 'OK'
          }
        };
      }
    } else if (exposure.entityType === 'scene') {
      const sceneValidation = validateSceneExposure(entity, context);
      validation = mergeValidation(exposure, sceneValidation);
      if (validation.validationErrors.length === 0) {
        endpoint = buildSceneEndpoint(entity, exposure, context.hubId, validation);
      }
    } else if (exposure.entityType === 'workflow') {
      const workflowValidation = validateWorkflowExposure(entity, context);
      validation = mergeValidation(exposure, workflowValidation);
      if (validation.validationErrors.length === 0) {
        endpoint = buildWorkflowEndpoint(entity, exposure, context.hubId, workflowValidation);
      }
    }

    return {
      exposure,
      entity,
      enabled,
      projectionType,
      validationWarnings: validation.validationWarnings,
      validationErrors: validation.validationErrors,
      endpoint
    };
  }

  loadEntitySync(entityType, entityId, context) {
    const key = toObjectIdString(entityId);
    switch (entityType) {
      case 'device':
        return context.devicesById.get(key) || null;
      case 'device_group':
        return context.groupsById.get(key) || null;
      case 'scene':
        return context.scenesById.get(key) || null;
      case 'workflow':
        return context.workflowsById.get(key) || null;
      default:
        return null;
    }
  }

  async listExposureSummaries() {
    const context = await this.loadContext();
    const records = context.exposures.map((exposure) => this.buildRecordForExposure(exposure, context));
    const recordsWithCollisions = applyNamingCollisionWarnings(records);

    return recordsWithCollisions.map((record) => ({
      _id: record.exposure._id?.toString?.() || String(record.exposure._id),
      entityType: record.exposure.entityType,
      entityId: record.exposure.entityId,
      enabled: record.enabled,
      projectionType: record.projectionType,
      friendlyName: record.endpoint?.friendlyName || normalizeAlexaName(record.exposure.friendlyName, record.entity?.name || ''),
      aliases: getExposureAliases(record.entity, record.exposure),
      roomHint: normalizeAlexaName(record.exposure.roomHint, record.entity?.room || record.entity?.rooms?.[0] || ''),
      validationWarnings: record.validationWarnings,
      validationErrors: record.validationErrors,
      endpointId: record.endpoint?.endpointId || buildEndpointId(context.hubId, record.exposure.entityType, record.exposure.entityId),
      entity: record.entity
    }));
  }

  async buildCatalog(options = {}) {
    const includeDisabled = options.includeDisabled === true;
    const context = await this.loadContext();
    const records = context.exposures.map((exposure) => this.buildRecordForExposure(exposure, context));
    const recordsWithCollisions = applyNamingCollisionWarnings(records);
    const filtered = recordsWithCollisions.filter((record) => includeDisabled || record.enabled);
    const endpoints = filtered
      .filter((record) => record.enabled && record.endpoint && record.validationErrors.length === 0)
      .map((record) => record.endpoint);

    return {
      hubId: context.hubId,
      endpoints,
      records: filtered
    };
  }

  async getCatalogEntryByEndpointId(endpointId) {
    const parsed = parseEndpointId(endpointId);
    if (!parsed) {
      throw new Error('Invalid Alexa endpoint ID');
    }

    const context = await this.loadContext();
    if (parsed.hubId !== context.hubId) {
      throw new Error('Endpoint hub ID does not match this HomeBrain hub');
    }

    const exposure = context.exposures.find((entry) => (
      entry.entityType === parsed.entityType && entry.entityId === parsed.entityId
    ));
    if (!exposure) {
      throw new Error('Alexa exposure not found for endpoint');
    }

    return this.buildRecordForExposure(exposure, context);
  }

  async getStateForEndpoint(endpointId) {
    const record = await this.getCatalogEntryByEndpointId(endpointId);
    if (!record.endpoint) {
      throw new Error('Alexa endpoint is not currently valid');
    }

    return {
      endpointId: record.endpoint.endpointId,
      entityType: record.exposure.entityType,
      entityId: record.exposure.entityId,
      properties: Array.isArray(record.endpoint.state?.properties) ? record.endpoint.state.properties : [],
      connectivity: record.endpoint.state?.connectivity || 'OK'
    };
  }

  async upsertExposure(entityType, entityId, updates = {}) {
    const context = await this.loadContext();
    const entity = await this.loadEntity(entityType, entityId, context);
    if (!entity) {
      throw new Error(`Unable to find ${entityType} ${entityId}`);
    }

    const existing = await AlexaExposure.findOne({
      entityType,
      entityId: toObjectIdString(entityId)
    });

    const exposure = existing || new AlexaExposure({
      entityType,
      entityId: toObjectIdString(entityId),
      projectionType: inferProjectionType(entityType)
    });

    if (Object.prototype.hasOwnProperty.call(updates, 'enabled')) {
      exposure.enabled = updates.enabled === true;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'friendlyName')) {
      exposure.friendlyName = normalizeAlexaName(updates.friendlyName);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'aliases')) {
      exposure.aliases = uniqueCaseInsensitive(Array.isArray(updates.aliases) ? updates.aliases : []);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'roomHint')) {
      exposure.roomHint = normalizeAlexaName(updates.roomHint);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'projectionType')) {
      exposure.projectionType = updates.projectionType || inferProjectionType(entityType);
    }

    exposure.endpointIdSeed = buildEndpointId(context.hubId, entityType, entityId);

    const record = this.buildRecordForExposure(exposure.toObject(), context);
    exposure.validationWarnings = record.validationWarnings;
    exposure.validationErrors = record.validationErrors;
    await exposure.save();

    return this.listExposureSummaries().then((records) => records.find((entry) => (
      entry.entityType === entityType && entry.entityId === toObjectIdString(entityId)
    )));
  }

  async ensureExposure(entityType, entityId, defaults = {}) {
    const existing = await AlexaExposure.findOne({
      entityType,
      entityId: toObjectIdString(entityId)
    });

    if (existing) {
      return existing;
    }

    const exposure = new AlexaExposure({
      entityType,
      entityId: toObjectIdString(entityId),
      enabled: defaults.enabled === true,
      friendlyName: normalizeAlexaName(defaults.friendlyName),
      aliases: uniqueCaseInsensitive(defaults.aliases),
      roomHint: normalizeAlexaName(defaults.roomHint),
      projectionType: inferProjectionType(entityType)
    });
    await exposure.save();
    return exposure;
  }
}

const alexaProjectionService = new AlexaProjectionService();

module.exports = alexaProjectionService;
module.exports.AlexaProjectionService = AlexaProjectionService;
module.exports.buildAlexaProperty = buildAlexaProperty;
module.exports.buildEndpointStatePropertiesForDevice = buildEndpointStatePropertiesForDevice;
module.exports.buildGroupStateProperties = buildGroupStateProperties;
module.exports.getRestrictedDeviceReason = getRestrictedDeviceReason;
module.exports.inferDeviceTraits = inferDeviceTraits;
module.exports.inferGroupTraits = inferGroupTraits;
module.exports.validateSceneExposure = validateSceneExposure;
module.exports.validateWorkflowExposure = validateWorkflowExposure;
module.exports.supportsColorTemperatureControl = supportsColorTemperatureControl;

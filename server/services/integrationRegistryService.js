const mongoose = require('mongoose');
const Settings = require('../models/Settings');
const TempestIntegration = require('../models/TempestIntegration');
const GoveeIntegration = require('../models/GoveeIntegration');
const RainMachineIntegration = require('../models/RainMachineIntegration');
const SenseIntegration = require('../models/SenseIntegration');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const EcobeeIntegration = require('../models/EcobeeIntegration');
const {
  getCapabilityDefinitions,
  getModuleDefinition,
  getModuleDefinitions,
  getModulesForCapability
} = require('./integrationModuleCatalog');

const SELECTED_MODE = 'selected';
const AUTO_MODE = 'auto';

function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

function trimString(value, fallback = '') {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}

function asPlainObject(value) {
  if (!value) {
    return {};
  }

  if (typeof value.toObject === 'function') {
    return value.toObject();
  }

  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function toIsoString(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizePreferenceEntry(entry = {}) {
  const mode = entry?.mode === SELECTED_MODE ? SELECTED_MODE : AUTO_MODE;
  return {
    mode,
    moduleId: mode === SELECTED_MODE ? trimString(entry.moduleId) : '',
    resourceId: mode === SELECTED_MODE ? trimString(entry.resourceId) : '',
    updatedAt: toIsoString(entry.updatedAt)
  };
}

function normalizeIntegrationPreferences(raw = {}) {
  const source = asPlainObject(raw);
  const capabilities = asPlainObject(source.capabilities);
  return {
    capabilities: Object.entries(capabilities).reduce((acc, [capabilityKey, entry]) => {
      const normalizedKey = trimString(capabilityKey);
      if (normalizedKey) {
        acc[normalizedKey] = normalizePreferenceEntry(entry);
      }
      return acc;
    }, {})
  };
}

function buildHealth({ enabled, configured, connected, lastError }) {
  if (enabled === false) {
    return 'disabled';
  }

  if (configured === false) {
    return 'not_configured';
  }

  if (connected === true) {
    return 'online';
  }

  if (lastError) {
    return 'attention';
  }

  return 'ready';
}

function buildModuleStatus(definition, overlay = {}) {
  const configured = overlay.configured === true;
  const enabled = overlay.enabled !== false && (overlay.enabled === true || configured || overlay.alwaysEnabled === true);
  const connected = overlay.connected === true;
  const lastError = trimString(overlay.lastError);
  const health = overlay.health || buildHealth({ enabled, configured, connected, lastError });

  return {
    ...definition,
    settingsUrl: `/settings?tab=${definition.settingsTab}`,
    configured,
    enabled,
    connected,
    health,
    statusLabel: overlay.statusLabel || health.replace(/_/g, ' '),
    supportsEnabledToggle: overlay.supportsEnabledToggle === true,
    lastSyncAt: toIsoString(overlay.lastSyncAt),
    lastSeenAt: toIsoString(overlay.lastSeenAt),
    lastError,
    resourceCount: Array.isArray(overlay.resources) ? overlay.resources.length : 0,
    resources: Array.isArray(overlay.resources) ? overlay.resources : [],
    detail: overlay.detail || {}
  };
}

function getResourcePreferenceState(resource, capabilityKey, preferences) {
  const preference = preferences.capabilities?.[capabilityKey] || { mode: AUTO_MODE };
  if (preference.mode !== SELECTED_MODE) {
    return false;
  }

  return preference.resourceId
    ? preference.resourceId === resource.id
    : preference.moduleId === resource.moduleId;
}

function decorateResource(resource, definition, capabilityKey, preferences) {
  return {
    ...resource,
    moduleId: definition.id,
    moduleName: definition.label,
    provider: definition.provider,
    capability: capabilityKey,
    selected: getResourcePreferenceState(resource, capabilityKey, preferences)
  };
}

async function loadTempestModule(definition, preferences) {
  const tempestService = require('./tempestService');
  const status = await tempestService.getStatus();
  const integration = asPlainObject(status.integration);
  const health = asPlainObject(status.health);
  const selectedStationId = Number(integration.selectedStationId ?? status.selectedStation?.stationId);
  const stations = Array.isArray(status.stations) ? status.stations : [];
  const resources = stations.map((station) => {
    const id = String(station.stationId ?? station.id ?? station.deviceId ?? '');
    return decorateResource({
      id,
      label: station.name || station.stationName || `Station ${id}`,
      deviceType: 'weather_station',
      room: integration.room || 'Outside',
      sourceKey: id ? `tempest_station:${id}` : '',
      nativeId: id,
      online: health.isConnected === true,
      primary: Number(id) === selectedStationId
    }, definition, 'outdoor_climate', preferences);
  }).filter((resource) => resource.id);

  return buildModuleStatus(definition, {
    configured: integration.tokenConfigured === true || Boolean(trimString(integration.token)),
    enabled: integration.enabled === true,
    connected: health.isConnected === true || health.websocketConnected === true,
    supportsEnabledToggle: true,
    lastSyncAt: integration.lastSyncAt || health.lastObservationAt,
    lastSeenAt: health.websocketLastMessageAt || health.lastObservationAt,
    lastError: health.lastError || integration.lastError,
    resources,
    detail: {
      realtime: {
        websocketConnected: health.websocketConnected === true,
        udpListening: health.udpListening === true
      },
      selectedStationId: integration.selectedStationId || null
    }
  });
}

async function loadGoveeModule(definition, preferences) {
  const goveeAirQualityService = require('./goveeAirQualityService');
  const status = await goveeAirQualityService.getStatus();
  const integration = asPlainObject(status.integration);
  const health = asPlainObject(status.health);
  const devices = Array.isArray(status.devices) ? status.devices : [];
  const selectedDeviceKey = [
    status.selectedDevice?.sku || integration.selectedSku,
    status.selectedDevice?.device || integration.selectedDevice
  ].filter(Boolean).join(':');
  const resources = devices.map((device) => {
    const id = [device.sku, device.device].filter(Boolean).join(':') || trimString(device.device);
    return decorateResource({
      id,
      label: device.deviceName || device.name || device.device || 'Govee Indoor Air',
      deviceType: 'air_quality_monitor',
      room: integration.room || 'Inside',
      sourceKey: trimString(device.device) ? `govee_air_quality:${device.device}` : '',
      nativeId: trimString(device.device),
      online: device.online !== false,
      primary: id === selectedDeviceKey
    }, definition, 'indoor_climate', preferences);
  }).filter((resource) => resource.id);

  if (status.selectedDevice && resources.every((resource) => resource.id !== selectedDeviceKey)) {
    resources.unshift(decorateResource({
      id: selectedDeviceKey || trimString(status.selectedDevice.device),
      label: status.selectedDevice.deviceName || 'Govee Indoor Air',
      deviceType: 'air_quality_monitor',
      room: integration.room || 'Inside',
      sourceKey: trimString(status.selectedDevice.device) ? `govee_air_quality:${status.selectedDevice.device}` : '',
      nativeId: trimString(status.selectedDevice.device),
      online: status.latestSample?.isOnline !== false,
      primary: true
    }, definition, 'indoor_climate', preferences));
  }

  return buildModuleStatus(definition, {
    configured: health.configured === true || integration.apiKeyConfigured === true || Boolean(trimString(integration.localDeviceIp)),
    enabled: integration.enabled === true || health.enabled === true,
    connected: health.isConnected === true,
    supportsEnabledToggle: true,
    lastSyncAt: health.lastSyncAt,
    lastSeenAt: health.lastSampleAt,
    lastError: health.lastError || health.lastLocalError || integration.lastError,
    resources,
    detail: {
      connectionMode: integration.connectionMode || 'auto',
      apiKeyConfigured: integration.apiKeyConfigured === true,
      apiKeySource: integration.apiKeySource || 'none',
      localDeviceCount: Array.isArray(status.localDevices) ? status.localDevices.length : 0,
      lastSampleSource: health.lastSampleSource || ''
    }
  });
}

async function loadRainMachineModule(definition) {
  const rainMachineService = require('./rainMachineService');
  const status = await rainMachineService.getStatus();
  const integration = asPlainObject(status.integration);
  const health = asPlainObject(status.health);
  const controller = asPlainObject(status.controller);
  const resources = controller.id ? [{
    id: trimString(controller.id),
    label: controller.name || integration.controllerName || 'RainMachine Controller',
    moduleId: definition.id,
    moduleName: definition.label,
    provider: definition.provider,
    capability: 'irrigation_controller',
    deviceType: 'irrigation_controller',
    room: integration.room || 'Irrigation',
    sourceKey: `rainmachine_report:${controller.id}`,
    nativeId: trimString(controller.id),
    online: health.isConnected === true,
    primary: true,
    selected: false
  }] : [];

  return buildModuleStatus(definition, {
    configured: Boolean(trimString(integration.host) && trimString(integration.password)),
    enabled: integration.enabled === true,
    connected: health.isConnected === true,
    supportsEnabledToggle: true,
    lastSyncAt: health.lastSyncAt || health.lastReportSyncAt,
    lastSeenAt: health.lastConnectedAt,
    lastError: health.lastError || integration.lastError,
    resources,
    detail: {
      host: integration.host || '',
      controllerName: controller.name || integration.controllerName || ''
    }
  });
}

async function loadSenseModule(definition) {
  const senseService = require('./senseService');
  const status = await senseService.getStatus();
  const integration = asPlainObject(status.integration);
  const health = asPlainObject(status.health);
  const monitorId = trimString(integration.monitorId || status.latestSnapshot?.monitorId);
  const resources = monitorId ? [{
    id: monitorId,
    label: integration.monitorName || 'Sense Monitor',
    moduleId: definition.id,
    moduleName: definition.label,
    provider: definition.provider,
    capability: 'energy_monitor',
    deviceType: 'energy_monitor',
    room: integration.room || 'Electrical Panel',
    sourceKey: `sense_monitor:${monitorId}`,
    nativeId: monitorId,
    online: health.isConnected === true || health.websocketConnected === true,
    primary: true,
    selected: false
  }] : [];

  return buildModuleStatus(definition, {
    configured: Boolean(trimString(integration.email) && (trimString(integration.password) || trimString(integration.refreshToken))),
    enabled: integration.enabled === true,
    connected: health.isConnected === true || health.websocketConnected === true,
    supportsEnabledToggle: true,
    lastSyncAt: health.lastTrendSyncAt || health.lastRealtimeAt,
    lastSeenAt: health.websocketLastMessageAt || health.lastRealtimeAt,
    lastError: health.lastError || integration.lastError,
    resources,
    detail: {
      realtimeEnabled: integration.realtimeEnabled !== false,
      monitorId
    }
  });
}

async function loadSmartThingsModule(definition) {
  const integration = await SmartThingsIntegration.getIntegration();
  const sanitized = integration.toSanitized ? integration.toSanitized() : asPlainObject(integration);
  const connectedDevices = Array.isArray(sanitized.connectedDevices) ? sanitized.connectedDevices : [];

  return buildModuleStatus(definition, {
    configured: sanitized.isConfigured === true || Boolean(trimString(sanitized.clientId)),
    enabled: sanitized.isConfigured === true,
    connected: sanitized.isConnected === true,
    supportsEnabledToggle: false,
    lastSyncAt: sanitized.lastSync,
    lastSeenAt: sanitized.updatedAt,
    lastError: sanitized.lastError,
    resources: connectedDevices.slice(0, 25).map((device) => ({
      id: trimString(device.deviceId),
      label: device.label || device.name || device.deviceId,
      moduleId: definition.id,
      moduleName: definition.label,
      provider: definition.provider,
      capability: 'device_control',
      deviceType: Array.isArray(device.categories) ? device.categories[0] || 'device' : 'device',
      room: device.room || '',
      sourceKey: trimString(device.deviceId) ? `device:${device.deviceId}` : '',
      nativeId: trimString(device.deviceId),
      online: null,
      primary: false,
      selected: false
    })).filter((resource) => resource.id),
    detail: {
      deviceCount: connectedDevices.length,
      sthmConfigured: Boolean(sanitized.sthm?.locationId)
    }
  });
}

async function loadEcobeeModule(definition, preferences) {
  const integration = await EcobeeIntegration.getIntegration();
  const sanitized = integration.toSanitized ? integration.toSanitized() : asPlainObject(integration);
  const devices = Array.isArray(sanitized.connectedDevices) ? sanitized.connectedDevices : [];
  const resources = devices.map((device) => decorateResource({
    id: trimString(device.thermostatIdentifier || device.deviceId || device.name),
    label: device.name || device.thermostatIdentifier || 'Ecobee Thermostat',
    deviceType: 'thermostat',
    room: 'Thermostat',
    sourceKey: trimString(device.thermostatIdentifier) ? `device:${device.thermostatIdentifier}` : '',
    nativeId: trimString(device.thermostatIdentifier),
    online: sanitized.isConnected === true,
    primary: false
  }, definition, 'thermostat', preferences)).filter((resource) => resource.id);

  return buildModuleStatus(definition, {
    configured: sanitized.isConfigured === true || Boolean(trimString(sanitized.clientId)),
    enabled: sanitized.isConfigured === true,
    connected: sanitized.isConnected === true,
    supportsEnabledToggle: false,
    lastSyncAt: sanitized.lastSync,
    lastSeenAt: sanitized.updatedAt,
    lastError: sanitized.lastError,
    resources,
    detail: {
      thermostatCount: devices.length
    }
  });
}

async function loadSettingsBackedModule(definition) {
  const settings = isDatabaseConnected() ? await Settings.getSettings() : null;
  const sanitized = settings?.toSanitized ? settings.toSanitized() : asPlainObject(settings);

  if (definition.id === 'insteon') {
    const endpoint = trimString(sanitized.insteonPort || sanitized.isyHost);
    return buildModuleStatus(definition, {
      configured: Boolean(endpoint),
      enabled: Boolean(endpoint),
      connected: false,
      supportsEnabledToggle: false,
      detail: {
        endpoint: sanitized.insteonPort || '',
        isyConfigured: Boolean(trimString(sanitized.isyHost))
      }
    });
  }

  if (definition.id === 'harmony') {
    const configured = Boolean(trimString(sanitized.harmonyHubAddresses));
    return buildModuleStatus(definition, {
      configured,
      enabled: configured,
      connected: false,
      supportsEnabledToggle: false,
      detail: {
        hubAddressesConfigured: configured
      }
    });
  }

  if (definition.id === 'llm-providers') {
    const configured = Boolean(
      trimString(sanitized.openaiApiKey)
      || trimString(sanitized.anthropicApiKey)
      || trimString(sanitized.localLlmEndpoint)
      || trimString(sanitized.codexModel)
    );
    return buildModuleStatus(definition, {
      configured,
      enabled: configured,
      connected: configured,
      supportsEnabledToggle: false,
      detail: {
        provider: sanitized.llmProvider || 'openai',
        priorityList: Array.isArray(sanitized.llmPriorityList) ? sanitized.llmPriorityList : []
      }
    });
  }

  return buildModuleStatus(definition, {
    configured: false,
    enabled: false,
    connected: false,
    supportsEnabledToggle: false
  });
}

async function loadNativeRadioModule(definition) {
  if (definition.id === 'matter-thread') {
    const matterService = require('./matterService');
    const status = await matterService.getStatus().catch((error) => ({
      available: false,
      error: error.message
    }));

    return buildModuleStatus(definition, {
      configured: status.available !== false,
      enabled: status.available !== false,
      connected: status.available !== false && status.ready !== false,
      supportsEnabledToggle: false,
      lastError: status.error,
      detail: status
    });
  }

  const directRadioService = require('./directRadioService');
  const status = await directRadioService.getStatus().catch((error) => ({
    available: false,
    error: error.message
  }));

  return buildModuleStatus(definition, {
    configured: status.available !== false,
    enabled: status.available !== false,
    connected: status.available !== false,
    supportsEnabledToggle: false,
    lastError: status.error,
    detail: status
  });
}

async function loadStaticModule(definition) {
  if (definition.id === 'alexa') {
    return buildModuleStatus(definition, {
      configured: true,
      enabled: true,
      connected: true,
      supportsEnabledToggle: false
    });
  }

  return buildModuleStatus(definition, {
    configured: true,
    enabled: true,
    connected: true,
    supportsEnabledToggle: false
  });
}

async function loadModuleStatus(definition, preferences) {
  try {
    switch (definition.id) {
      case 'tempest':
        return await loadTempestModule(definition, preferences);
      case 'govee-indoor-air':
        return await loadGoveeModule(definition, preferences);
      case 'rainmachine':
        return await loadRainMachineModule(definition);
      case 'sense':
        return await loadSenseModule(definition);
      case 'smartthings':
        return await loadSmartThingsModule(definition);
      case 'ecobee':
        return await loadEcobeeModule(definition, preferences);
      case 'homebrain-native-radios':
      case 'matter-thread':
        return await loadNativeRadioModule(definition);
      case 'insteon':
      case 'harmony':
      case 'llm-providers':
        return await loadSettingsBackedModule(definition);
      case 'alexa':
      case 'codex-skill':
      case 'openclaw':
        return await loadStaticModule(definition);
      default:
        return buildModuleStatus(definition, {});
    }
  } catch (error) {
    return buildModuleStatus(definition, {
      configured: false,
      enabled: false,
      connected: false,
      lastError: error.message || 'Failed to load integration module status',
      statusLabel: 'attention'
    });
  }
}

async function getPreferences() {
  if (!isDatabaseConnected()) {
    return { capabilities: {} };
  }

  const settings = await Settings.getSettings();
  return normalizeIntegrationPreferences(settings.integrationPreferences);
}

async function savePreferences(nextPreferences) {
  if (!isDatabaseConnected()) {
    return normalizeIntegrationPreferences(nextPreferences);
  }

  const settings = await Settings.updateSettings({
    integrationPreferences: normalizeIntegrationPreferences(nextPreferences)
  });
  return normalizeIntegrationPreferences(settings.integrationPreferences);
}

function groupModulesByCategory(modules = []) {
  return modules.reduce((acc, module) => {
    const category = module.category || 'Other';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(module.id);
    return acc;
  }, {});
}

async function getCatalog(options = {}) {
  const preferences = await getPreferences();
  const definitions = getModuleDefinitions();
  const includeStatus = options.includeStatus !== false;
  const modules = includeStatus
    ? await Promise.all(definitions.map((definition) => loadModuleStatus(definition, preferences)))
    : definitions.map((definition) => buildModuleStatus(definition, {
        configured: false,
        enabled: false,
        connected: false
      }));

  return {
    generatedAt: new Date().toISOString(),
    capabilities: getCapabilityDefinitions(),
    preferences,
    categories: groupModulesByCategory(modules),
    modules
  };
}

async function getCapabilityProviders(capabilityKey) {
  const key = trimString(capabilityKey);
  const preferences = await getPreferences();
  const definitions = getModulesForCapability(key);
  const modules = await Promise.all(definitions.map((definition) => loadModuleStatus(definition, preferences)));

  return {
    capability: key,
    preference: preferences.capabilities[key] || { mode: AUTO_MODE, moduleId: '', resourceId: '', updatedAt: null },
    modules,
    resources: modules.flatMap((module) => (
      Array.isArray(module.resources)
        ? module.resources.filter((resource) => resource.capability === key || module.capabilities.includes(key))
        : []
    ))
  };
}

async function updateCapabilityPreference(capabilityKey, input = {}) {
  const key = trimString(capabilityKey);
  const capabilityModules = getModulesForCapability(key);
  if (capabilityModules.length === 0) {
    throw new Error(`Unknown integration capability: ${key}`);
  }

  const mode = input.mode === SELECTED_MODE ? SELECTED_MODE : AUTO_MODE;
  const moduleId = trimString(input.moduleId);
  const resourceId = trimString(input.resourceId);

  if (mode === SELECTED_MODE && moduleId && !capabilityModules.some((definition) => definition.id === moduleId)) {
    throw new Error(`Module ${moduleId} does not provide ${key}`);
  }

  const preferences = await getPreferences();
  preferences.capabilities[key] = {
    mode,
    moduleId: mode === SELECTED_MODE ? moduleId : '',
    resourceId: mode === SELECTED_MODE ? resourceId : '',
    updatedAt: new Date().toISOString()
  };

  return savePreferences(preferences);
}

async function updateModuleEnabled(moduleId, enabled) {
  const definition = getModuleDefinition(moduleId);
  if (!definition) {
    throw new Error(`Unknown integration module: ${moduleId}`);
  }

  const nextEnabled = enabled === true;

  if (definition.id === 'tempest') {
    const tempestService = require('./tempestService');
    const integration = await TempestIntegration.getIntegration();
    integration.enabled = nextEnabled;
    if (!nextEnabled) {
      integration.isConnected = false;
      integration.websocket = {
        ...(integration.websocket?.toObject ? integration.websocket.toObject() : integration.websocket || {}),
        connected: false
      };
    }
    await integration.save();
    if (!nextEnabled && typeof tempestService.stopRealtime === 'function') {
      tempestService.stopRealtime();
    }
    if (nextEnabled) {
      tempestService.refreshRuntime({ reason: 'module-enabled' }).catch((error) => {
        console.warn(`IntegrationRegistryService: Tempest enable refresh failed: ${error.message}`);
      });
    }
  } else if (definition.id === 'govee-indoor-air') {
    const goveeAirQualityService = require('./goveeAirQualityService');
    const integration = await GoveeIntegration.getIntegration();
    integration.enabled = nextEnabled;
    if (!nextEnabled) {
      integration.isConnected = false;
      integration.lastError = '';
    }
    await integration.save();
    if (typeof goveeAirQualityService.restartPollTimer === 'function') {
      await goveeAirQualityService.restartPollTimer();
    }
    if (nextEnabled) {
      goveeAirQualityService.syncNow({ reason: 'module-enabled', allowDisabled: false }).catch((error) => {
        console.warn(`IntegrationRegistryService: Govee enable sync failed: ${error.message}`);
      });
    }
  } else if (definition.id === 'rainmachine') {
    const rainMachineService = require('./rainMachineService');
    const integration = await RainMachineIntegration.getIntegration();
    integration.enabled = nextEnabled;
    if (!nextEnabled) {
      integration.isConnected = false;
      integration.lastError = '';
    }
    await integration.save();
    if (typeof rainMachineService.ensurePollTimer === 'function') {
      await rainMachineService.ensurePollTimer();
    }
  } else if (definition.id === 'sense') {
    const senseService = require('./senseService');
    const integration = await SenseIntegration.getIntegration();
    integration.enabled = nextEnabled;
    if (!nextEnabled) {
      integration.isConnected = false;
      integration.lastError = '';
    }
    await integration.save();
    if (!nextEnabled && typeof senseService.stopWebSocket === 'function') {
      senseService.stopWebSocket({ resetMonitor: true });
    }
    if (nextEnabled) {
      senseService.refreshRuntime({ reason: 'module-enabled', forceRealtime: true }).catch((error) => {
        console.warn(`IntegrationRegistryService: Sense enable refresh failed: ${error.message}`);
      });
    }
  } else {
    const error = new Error(`${definition.label} does not expose a safe platform-level enable toggle yet.`);
    error.status = 409;
    throw error;
  }

  const preferences = await getPreferences();
  return loadModuleStatus(definition, preferences);
}

async function getCapabilityPreference(capabilityKey) {
  const preferences = await getPreferences();
  return preferences.capabilities[capabilityKey] || {
    mode: AUTO_MODE,
    moduleId: '',
    resourceId: '',
    updatedAt: null
  };
}

module.exports = {
  AUTO_MODE,
  SELECTED_MODE,
  getCapabilityPreference,
  getCapabilityProviders,
  getCatalog,
  getPreferences,
  normalizeIntegrationPreferences,
  updateCapabilityPreference,
  updateModuleEnabled
};

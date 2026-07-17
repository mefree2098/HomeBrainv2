const CAPABILITY_DEFINITIONS = [
  { key: 'outdoor_climate', label: 'Outdoor Climate', section: 'Climate', selectable: true },
  { key: 'indoor_climate', label: 'Indoor Climate', section: 'Climate', selectable: true },
  { key: 'air_quality', label: 'Air Quality', section: 'Climate', selectable: true },
  { key: 'device_control', label: 'Device Control', section: 'Devices', selectable: false },
  { key: 'native_radio', label: 'Native Zigbee/Z-Wave/Thread', section: 'Devices', selectable: false },
  { key: 'security_platform', label: 'Security Platform', section: 'Security', selectable: true },
  { key: 'energy_monitor', label: 'Energy Monitor', section: 'Energy', selectable: true },
  { key: 'irrigation_controller', label: 'Irrigation Controller', section: 'Irrigation', selectable: true },
  { key: 'thermostat', label: 'Thermostat', section: 'Climate', selectable: true },
  { key: 'voice_assistant', label: 'Voice Assistant', section: 'Voice', selectable: true },
  { key: 'robot', label: 'Robot', section: 'Robotics', selectable: true },
  { key: 'ai_provider', label: 'AI Provider', section: 'AI', selectable: true },
  { key: 'remote_control', label: 'Remote Control', section: 'Media', selectable: false },
  { key: 'telemetry_source', label: 'Telemetry Source', section: 'Data', selectable: false },
  { key: 'workflow_actions', label: 'Workflow Actions', section: 'Workflows', selectable: false },
  { key: 'workflow_conditions', label: 'Workflow Conditions', section: 'Workflows', selectable: false },
  { key: 'alerts_source', label: 'Alerts Source', section: 'Alerts', selectable: false }
];

const SHARED_DEVICE_TYPES = Object.freeze([
  'light',
  'switch',
  'lock',
  'sensor',
  'siren',
  'thermostat',
  'garage',
  'camera',
  'speaker'
]);

const INTEGRATION_MODULE_DEFINITIONS = [
  {
    id: 'tempest',
    label: 'Tempest Weather Station',
    provider: 'WeatherFlow Tempest',
    category: 'Climate',
    description: 'Outdoor weather station readings, events, history, and dashboard forecast fusion.',
    settingsTab: 'tempest',
    apiBasePath: '/api/tempest',
    deviceSource: 'tempest',
    capabilities: ['outdoor_climate', 'air_quality', 'telemetry_source', 'workflow_conditions', 'alerts_source'],
    deviceTypes: ['weather_station', 'outdoor_climate_sensor'],
    telemetrySourceTypes: ['tempest_station'],
    selectableResources: ['outdoor_climate']
  },
  {
    id: 'govee-indoor-air',
    label: 'Govee Indoor Air',
    provider: 'Govee',
    category: 'Climate',
    description: 'Indoor temperature, humidity, PM2.5, AQI, CO2/TVOC where exposed, and local/cloud ingest.',
    settingsTab: 'govee',
    apiBasePath: '/api/govee-air-quality',
    deviceSource: 'govee',
    capabilities: ['indoor_climate', 'air_quality', 'telemetry_source', 'workflow_conditions', 'alerts_source'],
    deviceTypes: ['indoor_climate_sensor', 'air_quality_monitor'],
    telemetrySourceTypes: ['govee_air_quality'],
    selectableResources: ['indoor_climate', 'air_quality']
  },
  {
    id: 'ecobee',
    label: 'Ecobee',
    provider: 'Ecobee',
    category: 'Climate',
    description: 'Thermostats, thermostat sensors, indoor climate data, and HVAC device control.',
    settingsTab: 'ecobee',
    apiBasePath: '/api/ecobee',
    deviceSource: 'ecobee',
    capabilities: ['thermostat', 'indoor_climate', 'device_control', 'workflow_actions', 'workflow_conditions'],
    deviceTypes: ['thermostat', 'indoor_climate_sensor'],
    telemetrySourceTypes: []
  },
  {
    id: 'sense',
    label: 'Sense Energy',
    provider: 'Sense',
    category: 'Energy',
    description: 'Whole-home energy, device-level power telemetry, and energy workflow conditions.',
    settingsTab: 'sense',
    apiBasePath: '/api/sense',
    deviceSource: 'sense',
    capabilities: ['energy_monitor', 'telemetry_source', 'workflow_conditions', 'alerts_source'],
    deviceTypes: ['energy_monitor', 'power_meter'],
    telemetrySourceTypes: ['sense_monitor', 'sense_device']
  },
  {
    id: 'rainmachine',
    label: 'RainMachine',
    provider: 'RainMachine',
    category: 'Irrigation',
    description: 'Irrigation schedules, zone state, watering history, reports, and workflow actions.',
    settingsTab: 'rainmachine',
    apiBasePath: '/api/rainmachine',
    deviceSource: 'rainmachine',
    capabilities: ['irrigation_controller', 'telemetry_source', 'workflow_actions', 'workflow_conditions', 'alerts_source'],
    deviceTypes: ['irrigation_controller', 'irrigation_zone'],
    telemetrySourceTypes: ['rainmachine_report']
  },
  {
    id: 'smartthings',
    label: 'SmartThings',
    provider: 'SmartThings',
    category: 'Devices',
    description: 'Cloud-backed device ingest/control, STHM security bridge, and migration source devices.',
    settingsTab: 'devices',
    apiBasePath: '/api/smartthings',
    deviceSource: 'smartthings',
    capabilities: ['device_control', 'security_platform', 'workflow_actions', 'workflow_conditions', 'alerts_source'],
    deviceTypes: SHARED_DEVICE_TYPES,
    telemetrySourceTypes: ['device']
  },
  {
    id: 'homebrain-native-radios',
    label: 'HomeBrain Native Radios',
    provider: 'HomeBrain',
    category: 'Devices',
    description: 'Native Zigbee, Z-Wave, Thread, and Matter onboarding/control for migrated devices.',
    settingsTab: 'devices',
    apiBasePath: '/api/direct-radios',
    deviceSource: 'homebrain-native',
    capabilities: ['native_radio', 'device_control', 'workflow_actions', 'workflow_conditions', 'alerts_source'],
    deviceTypes: SHARED_DEVICE_TYPES,
    telemetrySourceTypes: ['device']
  },
  {
    id: 'matter-thread',
    label: 'Matter / Thread',
    provider: 'HomeBrain',
    category: 'Devices',
    description: 'Matter fabric, Thread credentials, commissioning, and Matter device control.',
    settingsTab: 'devices',
    apiBasePath: '/api/matter',
    deviceSource: 'homebrain-matter',
    capabilities: ['native_radio', 'device_control', 'workflow_actions', 'workflow_conditions', 'alerts_source'],
    deviceTypes: ['light', 'switch', 'lock', 'sensor', 'thermostat', 'garage'],
    telemetrySourceTypes: ['device']
  },
  {
    id: 'insteon',
    label: 'INSTEON',
    provider: 'INSTEON / ISY',
    category: 'Devices',
    description: 'PLM/ISY-backed lighting, switches, sensors, links, scenes, and workflows.',
    settingsTab: 'devices',
    apiBasePath: '/api/insteon',
    deviceSource: 'insteon',
    capabilities: ['device_control', 'workflow_actions', 'workflow_conditions', 'alerts_source'],
    deviceTypes: ['light', 'switch', 'sensor'],
    telemetrySourceTypes: ['device']
  },
  {
    id: 'harmony',
    label: 'Harmony',
    provider: 'Logitech Harmony',
    category: 'Media',
    description: 'Hub discovery, activities, IR device control, and media workflow actions.',
    settingsTab: 'devices',
    apiBasePath: '/api/harmony',
    deviceSource: 'harmony',
    capabilities: ['remote_control', 'device_control', 'workflow_actions'],
    deviceTypes: ['remote', 'media_activity'],
    telemetrySourceTypes: []
  },
  {
    id: 'alexa',
    label: 'Alexa',
    provider: 'Amazon Alexa',
    category: 'Voice',
    description: 'Alexa bridge, account linking, entity exposure, custom skill, and proactive events.',
    settingsTab: 'alexa',
    apiBasePath: '/api/alexa',
    deviceSource: 'alexa',
    capabilities: ['voice_assistant', 'workflow_actions'],
    deviceTypes: ['voice_assistant'],
    telemetrySourceTypes: []
  },
  {
    id: 'reachy-mini',
    label: 'Reachy Mini',
    provider: 'Pollen Robotics',
    category: 'Robotics',
    description: 'Reachy Mini Wireless voice, perception, semantic motion, workflows, and managed companion updates.',
    settingsTab: 'reachy-mini',
    apiBasePath: '/api/reachy-mini',
    deviceSource: 'reachy',
    capabilities: ['robot', 'voice_assistant', 'device_control', 'workflow_actions', 'workflow_conditions', 'alerts_source'],
    deviceTypes: ['robot'],
    telemetrySourceTypes: []
  },
  {
    id: 'codex-skill',
    label: 'Codex Skill',
    provider: 'HomeBrain',
    category: 'Developer',
    description: 'Live HomeBrain admin skill bundle and token management for Codex-assisted operations.',
    settingsTab: 'codex-skill',
    apiBasePath: '/api/codex-skill',
    deviceSource: 'codex-skill',
    capabilities: ['ai_provider', 'workflow_actions'],
    deviceTypes: ['developer_tool'],
    telemetrySourceTypes: []
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    provider: 'OpenClaw',
    category: 'Developer',
    description: 'External OpenClaw admin integration, deployment bundle generation, and status checks.',
    settingsTab: 'openclaw',
    apiBasePath: '/api/openclaw',
    deviceSource: 'openclaw',
    capabilities: ['ai_provider', 'workflow_actions'],
    deviceTypes: ['developer_tool'],
    telemetrySourceTypes: []
  },
  {
    id: 'llm-providers',
    label: 'AI / LLM Providers',
    provider: 'OpenAI, Anthropic, Local, Codex',
    category: 'AI',
    description: 'Platform LLM routing for automations, chart builder, assistant features, and fallback ordering.',
    settingsTab: 'ai',
    apiBasePath: '/api/settings',
    deviceSource: 'llm',
    capabilities: ['ai_provider', 'workflow_actions'],
    deviceTypes: ['ai_provider'],
    telemetrySourceTypes: []
  }
];

const MODULES_BY_ID = new Map(INTEGRATION_MODULE_DEFINITIONS.map((definition) => [definition.id, definition]));
const CAPABILITIES_BY_KEY = new Map(CAPABILITY_DEFINITIONS.map((definition) => [definition.key, definition]));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getCapabilityDefinitions() {
  return clone(CAPABILITY_DEFINITIONS);
}

function getModuleDefinitions() {
  return clone(INTEGRATION_MODULE_DEFINITIONS);
}

function getModuleDefinition(moduleId) {
  const definition = MODULES_BY_ID.get(String(moduleId || '').trim());
  return definition ? clone(definition) : null;
}

function getCapabilityDefinition(capabilityKey) {
  const definition = CAPABILITIES_BY_KEY.get(String(capabilityKey || '').trim());
  return definition ? clone(definition) : null;
}

function getModulesForCapability(capabilityKey) {
  const key = String(capabilityKey || '').trim();
  return INTEGRATION_MODULE_DEFINITIONS
    .filter((definition) => definition.capabilities.includes(key))
    .map((definition) => clone(definition));
}

function getTelemetrySourceModule(sourceType) {
  const normalized = String(sourceType || '').trim();
  if (!normalized) {
    return null;
  }

  return INTEGRATION_MODULE_DEFINITIONS.find((definition) => (
    Array.isArray(definition.telemetrySourceTypes) && definition.telemetrySourceTypes.includes(normalized)
  )) || null;
}

function decorateTelemetrySourceSummary(summary = {}) {
  const moduleDefinition = getTelemetrySourceModule(summary.sourceType);
  if (!moduleDefinition) {
    return {
      ...summary,
      integrationModuleId: '',
      integrationModuleName: '',
      integrationCategory: '',
      capabilities: [],
      deviceTypes: []
    };
  }

  return {
    ...summary,
    integrationModuleId: moduleDefinition.id,
    integrationModuleName: moduleDefinition.label,
    integrationCategory: moduleDefinition.category,
    capabilities: [...moduleDefinition.capabilities],
    deviceTypes: [...moduleDefinition.deviceTypes]
  };
}

module.exports = {
  decorateTelemetrySourceSummary,
  getCapabilityDefinition,
  getCapabilityDefinitions,
  getModuleDefinition,
  getModuleDefinitions,
  getModulesForCapability,
  getTelemetrySourceModule
};

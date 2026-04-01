const ALEXA_ENTITY_TYPES = Object.freeze([
  'device',
  'device_group',
  'scene',
  'workflow'
]);

const ALEXA_PROJECTION_TYPES = Object.freeze({
  DEVICE: 'alexa_device',
  GROUP: 'alexa_group',
  SCENE: 'alexa_scene',
  WORKFLOW_SCENE: 'alexa_workflow_scene'
});

const ALEXA_DISPLAY_CATEGORIES = Object.freeze({
  LIGHT: 'LIGHT',
  SWITCH: 'SWITCH',
  THERMOSTAT: 'THERMOSTAT',
  SMARTLOCK: 'SMARTLOCK',
  TEMPERATURE_SENSOR: 'TEMPERATURE_SENSOR',
  SCENE_TRIGGER: 'SCENE_TRIGGER',
  ACTIVITY_TRIGGER: 'ACTIVITY_TRIGGER'
});

const ALEXA_INTERFACES = Object.freeze({
  BASE: 'Alexa',
  ENDPOINT_HEALTH: 'Alexa.EndpointHealth',
  POWER_CONTROLLER: 'Alexa.PowerController',
  BRIGHTNESS_CONTROLLER: 'Alexa.BrightnessController',
  COLOR_CONTROLLER: 'Alexa.ColorController',
  COLOR_TEMPERATURE_CONTROLLER: 'Alexa.ColorTemperatureController',
  THERMOSTAT_CONTROLLER: 'Alexa.ThermostatController',
  TEMPERATURE_SENSOR: 'Alexa.TemperatureSensor',
  LOCK_CONTROLLER: 'Alexa.LockController',
  SCENE_CONTROLLER: 'Alexa.SceneController'
});

const ALEXA_RESTRICTED_SCENE_DEVICE_TYPES = Object.freeze([
  'camera',
  'cooking_appliance',
  'lock',
  'garage',
  'security_sensor',
  'security_system',
  'sensor'
]);

function sanitizeIdentifierPart(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-z0-9:_-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildEndpointId(hubId, entityType, entityId) {
  const normalizedHubId = sanitizeIdentifierPart(hubId || 'hub');
  const normalizedEntityType = sanitizeIdentifierPart(entityType || 'entity');
  const normalizedEntityId = sanitizeIdentifierPart(entityId || 'unknown');
  return `hb:${normalizedHubId}:${normalizedEntityType}:${normalizedEntityId}`;
}

function parseEndpointId(endpointId) {
  const value = String(endpointId || '').trim();
  const match = value.match(/^hb:([^:]+):([^:]+):(.+)$/);
  if (!match) {
    return null;
  }

  return {
    hubId: match[1],
    entityType: match[2],
    entityId: match[3]
  };
}

function normalizeAlexaName(value, fallback = '') {
  if (typeof value !== 'string') {
    return String(fallback || '').trim();
  }

  const normalized = value
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || String(fallback || '').trim();
}

function uniqueCaseInsensitive(values = []) {
  const seen = new Set();
  const normalized = [];

  values.forEach((entry) => {
    const value = normalizeAlexaName(entry);
    if (!value) {
      return;
    }

    const key = value.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    normalized.push(value);
  });

  return normalized;
}

module.exports = {
  ALEXA_ENTITY_TYPES,
  ALEXA_PROJECTION_TYPES,
  ALEXA_DISPLAY_CATEGORIES,
  ALEXA_INTERFACES,
  ALEXA_RESTRICTED_SCENE_DEVICE_TYPES,
  buildEndpointId,
  parseEndpointId,
  normalizeAlexaName,
  sanitizeIdentifierPart,
  uniqueCaseInsensitive
};

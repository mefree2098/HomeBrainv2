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

const ALEXA_ERROR_TYPES = Object.freeze({
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_DIRECTIVE: 'INVALID_DIRECTIVE',
  INVALID_AUTHORIZATION_CREDENTIAL: 'INVALID_AUTHORIZATION_CREDENTIAL',
  EXPIRED_AUTHORIZATION_CREDENTIAL: 'EXPIRED_AUTHORIZATION_CREDENTIAL',
  NO_SUCH_ENDPOINT: 'NO_SUCH_ENDPOINT',
  BRIDGE_UNREACHABLE: 'BRIDGE_UNREACHABLE',
  ENDPOINT_UNREACHABLE: 'ENDPOINT_UNREACHABLE',
  ENDPOINT_BUSY: 'ENDPOINT_BUSY',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  VALUE_OUT_OF_RANGE: 'VALUE_OUT_OF_RANGE',
  TEMPERATURE_VALUE_OUT_OF_RANGE: 'TEMPERATURE_VALUE_OUT_OF_RANGE',
  NOT_SUPPORTED_IN_CURRENT_MODE: 'NOT_SUPPORTED_IN_CURRENT_MODE',
  POWER_LEVEL_NOT_SUPPORTED: 'POWER_LEVEL_NOT_SUPPORTED',
  INTERNAL_DEVICE_ERROR: 'INTERNAL_DEVICE_ERROR',
  ALREADY_IN_OPERATION: 'ALREADY_IN_OPERATION',
  DOOR_OPEN: 'DOOR_OPEN',
  DOOR_CLOSED: 'DOOR_CLOSED',
  UNSUPPORTED_THERMOSTAT_MODE: 'UNSUPPORTED_THERMOSTAT_MODE'
});

const VALID_ALEXA_ERROR_TYPES = new Set(Object.values(ALEXA_ERROR_TYPES));

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

function normalizeAlexaErrorType(value, fallback = ALEXA_ERROR_TYPES.INTERNAL_ERROR) {
  const candidate = String(value || '').trim().toUpperCase();
  if (VALID_ALEXA_ERROR_TYPES.has(candidate)) {
    return candidate;
  }

  return VALID_ALEXA_ERROR_TYPES.has(fallback) ? fallback : ALEXA_ERROR_TYPES.INTERNAL_ERROR;
}

module.exports = {
  ALEXA_ENTITY_TYPES,
  ALEXA_PROJECTION_TYPES,
  ALEXA_DISPLAY_CATEGORIES,
  ALEXA_INTERFACES,
  ALEXA_ERROR_TYPES,
  ALEXA_RESTRICTED_SCENE_DEVICE_TYPES,
  buildEndpointId,
  parseEndpointId,
  normalizeAlexaName,
  normalizeAlexaErrorType,
  sanitizeIdentifierPart,
  uniqueCaseInsensitive
};

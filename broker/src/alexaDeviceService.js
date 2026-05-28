const axios = require('axios');

const DEFAULT_DISCOVERY_PATH = '/v1/devices';
const DEFAULT_SPEAK_PATH = '/v1/devices/{deviceId}/speak';
const DEFAULT_TIMEOUT_MS = 10000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseBoundedMs(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function sanitizeBaseUrl(value) {
  const normalized = trimString(value).replace(/\/+$/, '');
  if (!normalized) {
    return '';
  }
  return new URL(normalized).origin;
}

function buildAbsoluteUrl(baseUrl, pathValue, fallbackPath = '') {
  const normalizedBaseUrl = sanitizeBaseUrl(baseUrl);
  const candidate = trimString(pathValue || fallbackPath);
  if (!normalizedBaseUrl) {
    return '';
  }
  if (!candidate) {
    return normalizedBaseUrl;
  }
  return new URL(candidate, normalizedBaseUrl).toString();
}

function extractDevices(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.devices)) {
    return payload.devices;
  }
  if (Array.isArray(payload?.deviceList)) {
    return payload.deviceList;
  }
  if (Array.isArray(payload?.endpoints)) {
    return payload.endpoints;
  }
  if (Array.isArray(payload?.data?.devices)) {
    return payload.data.devices;
  }
  return [];
}

function normalizeDevice(entry = {}, fallbackBrokerAccountId = '') {
  const id = trimString(
    entry.id
    || entry.deviceId
    || entry.alexaDeviceId
    || entry.endpointId
    || entry.serialNumber
    || entry.accountDeviceId
  );
  if (!id) {
    return null;
  }

  const name = trimString(
    entry.name
    || entry.displayName
    || entry.accountName
    || entry.friendlyName
    || entry.label
  ) || id;
  const rawOnline = entry.online ?? entry.isOnline ?? entry.connected ?? entry.reachable;
  const status = trimString(entry.status || entry.connectionState || entry.availability).toLowerCase();
  const online = typeof rawOnline === 'boolean'
    ? rawOnline
    : status
      ? ['online', 'connected', 'reachable', 'available', 'ok'].includes(status)
      : null;

  return {
    id,
    deviceId: id,
    name,
    room: trimString(entry.room || entry.roomName || entry.location || entry.groupName),
    type: trimString(entry.type || entry.deviceType || entry.category || entry.productName) || 'alexa_device',
    brokerAccountId: trimString(entry.brokerAccountId) || fallbackBrokerAccountId || '',
    locale: trimString(entry.locale),
    online,
    capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : [],
    provider: trimString(entry.provider || entry.source || 'alexa')
  };
}

function buildBearerHeaders(token) {
  const value = trimString(token);
  return value ? { Authorization: `Bearer ${value}` } : {};
}

class AlexaDeviceService {
  constructor({ store, eventGatewayService, httpClient = axios } = {}) {
    this.store = store;
    this.eventGatewayService = eventGatewayService;
    this.httpClient = httpClient;
  }

  getConfig() {
    const baseUrl = trimString(
      process.env.HOMEBRAIN_ALEXA_DEVICE_SERVICE_BASE_URL
      || process.env.HOMEBRAIN_ALEXA_DEVICE_API_BASE_URL
    );

    return {
      baseUrl,
      discoveryPath: trimString(process.env.HOMEBRAIN_ALEXA_DEVICE_DISCOVERY_PATH) || DEFAULT_DISCOVERY_PATH,
      speakPath: trimString(process.env.HOMEBRAIN_ALEXA_DEVICE_SPEAK_PATH) || DEFAULT_SPEAK_PATH,
      staticToken: trimString(process.env.HOMEBRAIN_ALEXA_DEVICE_SERVICE_TOKEN || process.env.HOMEBRAIN_ALEXA_DEVICE_API_TOKEN),
      timeoutMs: parseBoundedMs(
        process.env.HOMEBRAIN_ALEXA_DEVICE_SERVICE_TIMEOUT_MS || process.env.HOMEBRAIN_ALEXA_DEVICE_API_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS,
        1000,
        60000
      )
    };
  }

  isConfigured() {
    return Boolean(this.getConfig().baseUrl);
  }

  async resolveAccessToken({ hubId = '', brokerAccountId = '' } = {}) {
    const { staticToken } = this.getConfig();
    if (staticToken) {
      return staticToken;
    }
    if (!this.store || !this.eventGatewayService) {
      return '';
    }

    const grants = await this.store.listActivePermissionGrants({
      hubId: trimString(hubId),
      brokerAccountId: trimString(brokerAccountId)
    });
    const grant = grants[0];
    if (!grant) {
      return '';
    }

    const activeGrant = await this.eventGatewayService.ensureValidGrantAccessToken(grant);
    return trimString(activeGrant?.accessToken);
  }

  async listDevices({ hubId = '', brokerAccountId = '' } = {}) {
    const config = this.getConfig();
    if (!config.baseUrl) {
      return {
        available: false,
        reason: 'Alexa device service is not configured',
        devices: [],
        count: 0
      };
    }

    const token = await this.resolveAccessToken({ hubId, brokerAccountId });
    const response = await this.httpClient.get(
      buildAbsoluteUrl(config.baseUrl, config.discoveryPath, DEFAULT_DISCOVERY_PATH),
      {
        timeout: config.timeoutMs,
        params: {
          hubId: trimString(hubId) || undefined,
          brokerAccountId: trimString(brokerAccountId) || undefined
        },
        headers: {
          Accept: 'application/json',
          ...buildBearerHeaders(token)
        }
      }
    );

    const devices = extractDevices(response.data)
      .map((entry) => normalizeDevice(entry, trimString(brokerAccountId)))
      .filter(Boolean);

    return {
      available: true,
      devices,
      count: devices.length,
      updatedAt: new Date().toISOString()
    };
  }

  async speak({
    hubId = '',
    brokerAccountId = '',
    deviceId = '',
    deviceName = '',
    message = '',
    locale = ''
  } = {}) {
    const config = this.getConfig();
    const resolvedDeviceId = trimString(deviceId);
    const resolvedMessage = trimString(message);
    if (!resolvedDeviceId) {
      const error = new Error('Alexa device id is required');
      error.status = 400;
      throw error;
    }
    if (!resolvedMessage) {
      const error = new Error('Alexa speech message is required');
      error.status = 400;
      throw error;
    }
    if (!config.baseUrl) {
      const error = new Error('Alexa device service is not configured');
      error.status = 503;
      throw error;
    }

    const path = config.speakPath.replace('{deviceId}', encodeURIComponent(resolvedDeviceId));
    const token = await this.resolveAccessToken({ hubId, brokerAccountId });
    const response = await this.httpClient.post(
      buildAbsoluteUrl(config.baseUrl, path, DEFAULT_SPEAK_PATH.replace('{deviceId}', encodeURIComponent(resolvedDeviceId))),
      {
        hubId: trimString(hubId) || undefined,
        brokerAccountId: trimString(brokerAccountId) || undefined,
        deviceId: resolvedDeviceId,
        deviceName: trimString(deviceName) || undefined,
        message: resolvedMessage,
        locale: trimString(locale) || undefined
      },
      {
        timeout: config.timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...buildBearerHeaders(token)
        }
      }
    );

    return {
      success: true,
      deviceId: resolvedDeviceId,
      deviceName: trimString(deviceName),
      brokerAccountId: trimString(brokerAccountId),
      message: resolvedMessage,
      status: response.status,
      providerResponse: response.data || null
    };
  }
}

module.exports = {
  AlexaDeviceService,
  normalizeDevice,
  extractDevices
};

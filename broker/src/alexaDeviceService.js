const axios = require('axios');

const DEFAULT_PROVIDER = 'disabled';
const DEFAULT_COMMAND_TYPE = 'announce';
const DEFAULT_LOCALE = 'en-US';
const DEFAULT_AMAZON_PAGE = 'amazon.com';
const DEFAULT_SERVICE_HOST = 'pitangui.amazon.com';
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

function normalizeProvider(value) {
  const normalized = trimString(value);
  return ['disabled', 'homebrain', 'asp'].includes(normalized) ? normalized : DEFAULT_PROVIDER;
}

function normalizeCommandType(value) {
  const normalized = trimString(value);
  return ['announce', 'speak', 'ssml'].includes(normalized) ? normalized : DEFAULT_COMMAND_TYPE;
}

function parseJsonObject(value) {
  const normalized = trimString(value);
  if (!normalized) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function pickString(...values) {
  for (const value of values) {
    const normalized = trimString(value);
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function parseTargetMappings(value) {
  const parsed = Array.isArray(value) ? value : parseJsonObject(value);
  const mappings = Array.isArray(parsed) ? parsed : [];

  return mappings.map((entry = {}) => ({
    key: trimString(entry.key),
    alexaDeviceId: trimString(entry.alexaDeviceId || entry.deviceId || entry.target),
    displayName: trimString(entry.displayName || entry.name),
    room: trimString(entry.room),
    enabled: entry.enabled !== false
  })).filter((entry) => entry.key && entry.alexaDeviceId);
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
  const serialNumber = trimString(entry.serialNumber || entry.deviceSerialNumber);
  const id = trimString(
    entry.id
    || entry.deviceId
    || entry.alexaDeviceId
    || entry.endpointId
    || serialNumber
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
    serialNumber,
    deviceType: trimString(entry.deviceType || entry.deviceTypeId),
    deviceOwnerCustomerId: trimString(entry.deviceOwnerCustomerId || entry.customerId || entry.ownerCustomerId),
    name,
    room: trimString(entry.room || entry.roomName || entry.location || entry.groupName),
    type: trimString(entry.type || entry.deviceType || entry.category || entry.productName) || 'alexa_device',
    brokerAccountId: trimString(entry.brokerAccountId) || fallbackBrokerAccountId || '',
    locale: trimString(entry.locale),
    online,
    capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : [],
    provider: trimString(entry.provider || entry.source || 'homebrain')
  };
}

function overlayMappings(devices, mappings) {
  const byId = new Map(devices.map((device) => [device.id, device]));
  const bySerial = new Map(devices.filter((device) => device.serialNumber).map((device) => [device.serialNumber, device]));
  const byName = new Map(devices.map((device) => [device.name.toLowerCase(), device]));
  const result = [...devices];

  mappings.filter((entry) => entry.enabled).forEach((entry) => {
    const match = byId.get(entry.alexaDeviceId)
      || bySerial.get(entry.alexaDeviceId)
      || byName.get(entry.alexaDeviceId.toLowerCase());
    if (!match) {
      result.push({
        id: entry.key,
        deviceId: entry.key,
        name: entry.displayName || entry.key,
        room: entry.room,
        type: 'alexa_device',
        brokerAccountId: '',
        locale: '',
        online: null,
        capabilities: [],
        provider: 'homebrain',
        mappedTarget: entry.alexaDeviceId
      });
      return;
    }

    match.alias = entry.key;
    match.id = entry.key;
    match.deviceId = entry.key;
    if (entry.displayName) {
      match.name = entry.displayName;
    }
    if (entry.room) {
      match.room = entry.room;
    }
    match.mappedTarget = entry.alexaDeviceId;
  });

  return result;
}

function extractCsrf(cookie) {
  const match = trimString(cookie).match(/(?:^|;\s*)csrf=([^;]+)/i);
  if (!match) {
    return '';
  }

  try {
    return decodeURIComponent(match[1]);
  } catch (_error) {
    return match[1];
  }
}

function getNestedObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = parseJsonObject(value);
    return parsed && !Array.isArray(parsed) ? parsed : {};
  }
  return {};
}

function getSessionDetails(config) {
  const sessionData = getNestedObject(parseJsonObject(config.sessionData));
  const cookieData = getNestedObject(sessionData.cookieData);
  const registrationData = getNestedObject(sessionData.formerRegistrationData);
  const registrationCookieData = getNestedObject(registrationData.cookieData);

  const cookie = pickString(
    config.sessionCookie,
    sessionData.cookie,
    sessionData.localCookie,
    sessionData.sessionCookie,
    sessionData.alexaCookie,
    cookieData.cookie,
    registrationData.cookie,
    registrationData.localCookie,
    registrationCookieData.cookie
  );
  const csrf = pickString(
    sessionData.csrf,
    cookieData.csrf,
    registrationData.csrf,
    registrationCookieData.csrf,
    extractCsrf(cookie)
  );

  return { cookie, csrf };
}

function buildBaseUrl(serviceHost) {
  const rawHost = trimString(serviceHost) || DEFAULT_SERVICE_HOST;
  const withScheme = /^https?:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`;

  try {
    return new URL(withScheme).origin;
  } catch (_error) {
    return `https://${DEFAULT_SERVICE_HOST}`;
  }
}

function buildRequestContext(config) {
  const { cookie, csrf } = getSessionDetails(config);
  if (!cookie) {
    const error = new Error('HomeBrain Alexa command bridge needs an Alexa session cookie stored in broker settings');
    error.status = 503;
    throw error;
  }
  if (!csrf) {
    const error = new Error('HomeBrain Alexa command bridge needs a csrf token in the stored Alexa session');
    error.status = 503;
    throw error;
  }

  const baseUrl = buildBaseUrl(config.serviceHost);
  return {
    baseUrl,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      Cookie: cookie,
      csrf,
      Referer: `${baseUrl}/spa/index.html`,
      'User-Agent': 'HomeBrain Alexa Broker'
    },
    timeout: config.timeoutMs
  };
}

function makeAlexaRequestError(error, action) {
  const providerStatus = error?.response?.status;
  const status = providerStatus === 401 || providerStatus === 403 ? 503 : 502;
  const message = providerStatus === 401 || providerStatus === 403
    ? 'Alexa rejected the stored session. Refresh the Alexa session in broker settings.'
    : `HomeBrain Alexa command bridge could not ${action}`;
  const nextError = new Error(message);
  nextError.status = status;
  nextError.providerStatus = providerStatus || null;
  nextError.cause = error;
  return nextError;
}

function isWhitespaceCharacter(value) {
  return value === ' ' || value === '\n' || value === '\r' || value === '\t' || value === '\f' || value === '\v';
}

function plainTextFromSsml(value) {
  let inTag = false;
  let previousWhitespace = true;
  let result = '';

  for (const character of trimString(value)) {
    if (character === '<') {
      inTag = true;
      if (!previousWhitespace) {
        result += ' ';
        previousWhitespace = true;
      }
      continue;
    }
    if (character === '>') {
      inTag = false;
      continue;
    }
    if (inTag) {
      continue;
    }
    if (isWhitespaceCharacter(character)) {
      if (!previousWhitespace) {
        result += ' ';
        previousWhitespace = true;
      }
      continue;
    }

    result += character;
    previousWhitespace = false;
  }

  return result.trim();
}

function targetDevicePayload(targetDevice) {
  return {
    deviceSerialNumber: targetDevice.serialNumber,
    deviceTypeId: targetDevice.deviceType
  };
}

function validateTargetDevice(targetDevice, commandType) {
  if (!targetDevice?.serialNumber || !targetDevice?.deviceType) {
    const error = new Error('Alexa target is missing device serial or type metadata from the Alexa device list');
    error.status = 502;
    throw error;
  }

  if (commandType !== 'speak' && !targetDevice.deviceOwnerCustomerId) {
    const error = new Error('Alexa announcement target is missing owner metadata from the Alexa device list');
    error.status = 502;
    throw error;
  }
}

function buildAnnouncementSequence({ targetDevice, message, locale, commandType }) {
  return {
    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
    startNode: {
      '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
      type: 'AlexaAnnouncement',
      skillId: 'amzn1.ask.1p.routines.messaging',
      operationPayload: {
        expireAfter: 'PT5S',
        content: [{
          locale,
          display: {
            title: 'HomeBrain',
            body: plainTextFromSsml(message)
          },
          speak: {
            type: commandType === 'ssml' ? 'ssml' : 'text',
            value: message
          }
        }],
        target: {
          customerId: targetDevice.deviceOwnerCustomerId,
          devices: [targetDevicePayload(targetDevice)]
        }
      }
    }
  };
}

function buildSpeakSequence({ targetDevice, message, locale }) {
  return {
    '@type': 'com.amazon.alexa.behaviors.model.Sequence',
    startNode: {
      '@type': 'com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode',
      type: 'Alexa.Speak',
      skillId: 'amzn1.ask.1p.saysomething',
      operationPayload: {
        deviceType: targetDevice.deviceType,
        deviceSerialNumber: targetDevice.serialNumber,
        locale,
        textToSpeak: message
      }
    }
  };
}

function normalizeMatchValue(value) {
  return trimString(value).toLowerCase();
}

function collectTargetCandidates(config, deviceId, deviceName) {
  const requested = trimString(deviceId);
  const requestedName = trimString(deviceName);
  const candidates = [requested, requestedName].filter(Boolean);
  const mapping = config.targetMappings.find((entry) => entry.enabled && (
    entry.key === requested
    || entry.alexaDeviceId === requested
    || entry.displayName === requested
    || (requestedName && entry.displayName === requestedName)
  ));

  if (mapping) {
    candidates.push(mapping.key, mapping.alexaDeviceId, mapping.displayName);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function resolveTargetDevice(config, devices, deviceId, deviceName = '') {
  const candidates = collectTargetCandidates(config, deviceId, deviceName);
  const normalizedCandidates = new Set(candidates.map(normalizeMatchValue));
  const targetDevice = devices.find((device) => [
    device.id,
    device.deviceId,
    device.serialNumber,
    device.name,
    device.alias,
    device.mappedTarget
  ].some((value) => normalizedCandidates.has(normalizeMatchValue(value))));

  if (targetDevice) {
    return targetDevice;
  }

  const error = new Error(`Alexa target "${trimString(deviceName) || trimString(deviceId)}" was not found in the Alexa device list`);
  error.status = 404;
  throw error;
}

class AlexaDeviceService {
  constructor({ httpClient = axios } = {}) {
    this.httpClient = httpClient;
  }

  getConfig() {
    return {
      provider: normalizeProvider(process.env.HOMEBRAIN_ALEXA_COMMAND_PROVIDER),
      defaultType: normalizeCommandType(process.env.HOMEBRAIN_ALEXA_COMMAND_DEFAULT_TYPE),
      locale: trimString(process.env.HOMEBRAIN_ALEXA_COMMAND_LOCALE) || DEFAULT_LOCALE,
      amazonPage: trimString(process.env.HOMEBRAIN_ALEXA_COMMAND_AMAZON_PAGE) || DEFAULT_AMAZON_PAGE,
      serviceHost: trimString(process.env.HOMEBRAIN_ALEXA_COMMAND_SERVICE_HOST) || DEFAULT_SERVICE_HOST,
      sessionCookie: trimString(process.env.HOMEBRAIN_ALEXA_COMMAND_SESSION_COOKIE),
      sessionData: trimString(process.env.HOMEBRAIN_ALEXA_COMMAND_SESSION_DATA),
      targetMappings: parseTargetMappings(process.env.HOMEBRAIN_ALEXA_COMMAND_TARGETS_JSON),
      timeoutMs: parseBoundedMs(process.env.HOMEBRAIN_ALEXA_COMMAND_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 60000)
    };
  }

  isConfigured() {
    const config = this.getConfig();
    if (config.provider !== 'homebrain') {
      return false;
    }
    const { cookie } = getSessionDetails(config);
    return Boolean(cookie);
  }

  ensureHomeBrainProvider(config) {
    if (config.provider === 'disabled') {
      return {
        available: false,
        reason: 'HomeBrain Alexa command bridge is disabled'
      };
    }

    if (config.provider === 'asp') {
      return {
        available: false,
        reason: 'Alexa Smart Properties command provider is reserved for a future enterprise bridge'
      };
    }

    if (!config.sessionCookie && !config.sessionData) {
      return {
        available: false,
        reason: 'HomeBrain Alexa command bridge needs an Alexa session stored in broker settings'
      };
    }

    return {
      available: true,
      reason: ''
    };
  }

  async fetchAlexaDevices(config, brokerAccountId = '') {
    const requestContext = buildRequestContext(config);
    try {
      const response = await this.httpClient.get(`${requestContext.baseUrl}/api/devices-v2/device`, {
        headers: requestContext.headers,
        timeout: requestContext.timeout,
        params: {
          cached: 'true',
          _: Date.now()
        },
        validateStatus: (status) => status >= 200 && status < 300
      });
      return extractDevices(response?.data)
        .map((entry) => normalizeDevice(entry, trimString(brokerAccountId)))
        .filter(Boolean);
    } catch (error) {
      throw makeAlexaRequestError(error, 'load Alexa devices');
    }
  }

  async sendBehaviorPreview(config, sequence) {
    const requestContext = buildRequestContext(config);
    try {
      return await this.httpClient.post(`${requestContext.baseUrl}/api/behaviors/preview`, {
        behaviorId: 'PREVIEW',
        sequenceJson: JSON.stringify(sequence),
        status: 'ENABLED'
      }, {
        headers: requestContext.headers,
        timeout: requestContext.timeout,
        validateStatus: (status) => status >= 200 && status < 300
      });
    } catch (error) {
      throw makeAlexaRequestError(error, 'send Alexa speech');
    }
  }

  async listDevices({ brokerAccountId = '' } = {}) {
    const config = this.getConfig();
    const readiness = this.ensureHomeBrainProvider(config);
    if (!readiness.available) {
      return {
        available: false,
        reason: readiness.reason,
        devices: [],
        count: 0
      };
    }

    const devices = overlayMappings(
      await this.fetchAlexaDevices(config, brokerAccountId),
      config.targetMappings
    );

    return {
      available: true,
      devices,
      count: devices.length,
      updatedAt: new Date().toISOString()
    };
  }

  async speak({
    brokerAccountId = '',
    deviceId = '',
    deviceName = '',
    message = '',
    locale = '',
    type = ''
  } = {}) {
    const config = this.getConfig();
    const readiness = this.ensureHomeBrainProvider(config);
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
    if (!readiness.available) {
      const error = new Error(readiness.reason);
      error.status = 503;
      throw error;
    }

    const commandType = normalizeCommandType(type || config.defaultType);
    const devices = await this.fetchAlexaDevices(config, brokerAccountId);
    const targetDevice = resolveTargetDevice(config, devices, resolvedDeviceId, deviceName);
    const resolvedLocale = trimString(locale) || targetDevice.locale || config.locale;
    validateTargetDevice(targetDevice, commandType);
    const sequence = commandType === 'speak'
      ? buildSpeakSequence({
        targetDevice,
        message: resolvedMessage,
        locale: resolvedLocale
      })
      : buildAnnouncementSequence({
        targetDevice,
        message: resolvedMessage,
        locale: resolvedLocale,
        commandType
      });
    const providerResponse = await this.sendBehaviorPreview(config, sequence);

    return {
      success: true,
      deviceId: resolvedDeviceId,
      deviceName: trimString(deviceName),
      brokerAccountId: trimString(brokerAccountId),
      message: resolvedMessage,
      locale: resolvedLocale,
      type: commandType,
      provider: 'homebrain',
      target: targetDevice.serialNumber || targetDevice.id,
      status: providerResponse?.status || 200,
      providerResponse: providerResponse?.data || null
    };
  }
}

module.exports = {
  AlexaDeviceService,
  normalizeDevice,
  extractDevices,
  parseTargetMappings,
  overlayMappings,
  extractCsrf,
  buildAnnouncementSequence,
  buildSpeakSequence
};

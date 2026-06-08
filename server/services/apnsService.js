const fs = require('fs');
const http2 = require('http2');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const DEFAULT_BUNDLE_ID = 'NTechR.HomeBrainApp';
const TOKEN_REFRESH_MS = 45 * 60 * 1000;

let cachedJwt = null;
let cachedJwtCreatedAt = 0;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function envFlag(value, fallback = false) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function getEnvironment() {
  const raw = normalizeString(process.env.HOMEBRAIN_APNS_ENVIRONMENT || process.env.APNS_ENVIRONMENT).toLowerCase();
  if (raw === 'production' || raw === 'prod') return 'production';
  return 'development';
}

function getApnsHost(environment = getEnvironment()) {
  return environment === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
}

function getPrivateKey() {
  const inlineKey = normalizeString(process.env.HOMEBRAIN_APNS_PRIVATE_KEY || process.env.APNS_PRIVATE_KEY);
  if (inlineKey) {
    return inlineKey.replace(/\\n/g, '\n');
  }

  const keyPath = normalizeString(process.env.HOMEBRAIN_APNS_PRIVATE_KEY_PATH || process.env.APNS_PRIVATE_KEY_PATH);
  if (!keyPath) return '';
  return fs.readFileSync(keyPath, 'utf8');
}

function getConfig() {
  const teamId = normalizeString(process.env.HOMEBRAIN_APNS_TEAM_ID || process.env.APNS_TEAM_ID);
  const keyId = normalizeString(process.env.HOMEBRAIN_APNS_KEY_ID || process.env.APNS_KEY_ID);
  const bundleId = normalizeString(
    process.env.HOMEBRAIN_APNS_BUNDLE_ID
      || process.env.APNS_TOPIC
      || process.env.IOS_BUNDLE_ID
  ) || DEFAULT_BUNDLE_ID;
  const environment = getEnvironment();
  const privateKey = getPrivateKey();
  const criticalAlertsEnabled = envFlag(
    process.env.HOMEBRAIN_APNS_CRITICAL_ALERTS_ENABLED
      || process.env.APNS_CRITICAL_ALERTS_ENABLED,
    false
  );

  return {
    teamId,
    keyId,
    bundleId,
    environment,
    privateKey,
    host: getApnsHost(environment),
    criticalAlertsEnabled,
    configured: Boolean(teamId && keyId && privateKey && bundleId)
  };
}

function getProviderToken(config) {
  const now = Date.now();
  if (cachedJwt && cachedJwtCreatedAt && now - cachedJwtCreatedAt < TOKEN_REFRESH_MS) {
    return cachedJwt;
  }

  cachedJwt = jwt.sign(
    {
      iss: config.teamId,
      iat: Math.floor(now / 1000)
    },
    config.privateKey,
    {
      algorithm: 'ES256',
      header: {
        alg: 'ES256',
        kid: config.keyId
      }
    }
  );
  cachedJwtCreatedAt = now;
  return cachedJwt;
}

function sanitizeCollapseId(value) {
  const normalized = normalizeString(value);
  if (!normalized) return '';
  return normalized.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64);
}

function buildApsPayload(input, config) {
  const title = normalizeString(input.title) || 'HomeBrain';
  const body = normalizeString(input.body || input.message) || 'Security event detected.';
  const payload = {
    aps: {
      alert: { title, body },
      badge: Number.isFinite(Number(input.badge)) ? Math.max(0, Number(input.badge)) : 1,
      sound: 'default',
      'thread-id': input.threadId || 'homebrain-security',
      'interruption-level': config.criticalAlertsEnabled ? 'critical' : 'time-sensitive'
    },
    homebrain: {
      notificationId: normalizeString(input.notificationId),
      channel: normalizeString(input.channel) || 'securityCritical',
      eventType: normalizeString(input.eventType),
      eventKey: normalizeString(input.eventKey),
      deviceId: normalizeString(input.deviceId)
    }
  };

  if (config.criticalAlertsEnabled) {
    payload.aps.sound = {
      critical: 1,
      name: 'default',
      volume: 1.0
    };
  }

  return payload;
}

function sendAlertToToken(deviceToken, input = {}) {
  let config;
  try {
    config = getConfig();
  } catch (error) {
    return Promise.resolve({
      success: false,
      skipped: true,
      reason: error.message || 'apns_config_error'
    });
  }

  if (!config.configured) {
    return Promise.resolve({
      success: false,
      skipped: true,
      reason: 'apns_not_configured'
    });
  }

  const token = normalizeString(deviceToken);
  if (!token) {
    return Promise.resolve({
      success: false,
      skipped: true,
      reason: 'missing_device_token'
    });
  }

  let providerToken;
  try {
    providerToken = getProviderToken(config);
  } catch (error) {
    return Promise.resolve({
      success: false,
      skipped: true,
      reason: error.message || 'apns_token_error'
    });
  }
  const ttlSeconds = Number.isFinite(Number(input.ttlSeconds))
    ? Math.max(0, Number(input.ttlSeconds))
    : 10 * 60;
  const expiration = ttlSeconds === 0
    ? 0
    : Math.floor(Date.now() / 1000) + ttlSeconds;
  const apnsId = normalizeString(input.apnsId) || randomUUID();
  const collapseId = sanitizeCollapseId(input.collapseId || input.eventKey);
  const payload = JSON.stringify(buildApsPayload(input, config));

  return new Promise((resolve) => {
    const client = http2.connect(config.host);
    let responseBody = '';
    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      try {
        client.close();
      } catch (_error) {
        // Ignore close failures after APNs responds.
      }
      resolve(result);
    };

    client.on('error', (error) => {
      finish({
        success: false,
        statusCode: 0,
        reason: error.message || 'apns_connection_error'
      });
    });

    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${providerToken}`,
      'content-type': 'application/json',
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(expiration),
      'apns-id': apnsId
    };

    if (collapseId) {
      headers['apns-collapse-id'] = collapseId;
    }

    const request = client.request(headers);
    request.setEncoding('utf8');
    request.on('response', (headers) => {
      request.statusCode = Number(headers[':status']) || 0;
      request.apnsId = headers['apns-id'] || apnsId;
    });
    request.on('data', (chunk) => {
      responseBody += chunk;
    });
    request.on('error', (error) => {
      finish({
        success: false,
        statusCode: 0,
        apnsId,
        reason: error.message || 'apns_request_error'
      });
    });
    request.on('end', () => {
      const statusCode = Number(request.statusCode) || 0;
      let parsedBody = {};
      if (responseBody) {
        try {
          parsedBody = JSON.parse(responseBody);
        } catch (_error) {
          parsedBody = { reason: responseBody };
        }
      }

      finish({
        success: statusCode >= 200 && statusCode < 300,
        statusCode,
        apnsId: request.apnsId || apnsId,
        reason: parsedBody.reason || '',
        response: parsedBody
      });
    });
    request.end(payload);
  });
}

function getStatus() {
  let config;
  try {
    config = getConfig();
  } catch (error) {
    return {
      configured: false,
      environment: getEnvironment(),
      bundleId: normalizeString(
        process.env.HOMEBRAIN_APNS_BUNDLE_ID
          || process.env.APNS_TOPIC
          || process.env.IOS_BUNDLE_ID
      ) || DEFAULT_BUNDLE_ID,
      criticalAlertsEnabled: false,
      host: getApnsHost(getEnvironment()),
      missing: ['HOMEBRAIN_APNS_PRIVATE_KEY or HOMEBRAIN_APNS_PRIVATE_KEY_PATH'],
      error: error.message || 'APNs configuration could not be loaded'
    };
  }

  return {
    configured: config.configured,
    environment: config.environment,
    bundleId: config.bundleId,
    criticalAlertsEnabled: config.criticalAlertsEnabled,
    host: config.host,
    missing: [
      config.teamId ? null : 'HOMEBRAIN_APNS_TEAM_ID',
      config.keyId ? null : 'HOMEBRAIN_APNS_KEY_ID',
      config.privateKey ? null : 'HOMEBRAIN_APNS_PRIVATE_KEY or HOMEBRAIN_APNS_PRIVATE_KEY_PATH'
    ].filter(Boolean)
  };
}

module.exports = {
  getStatus,
  sendAlertToToken,
  _resetProviderTokenForTests() {
    cachedJwt = null;
    cachedJwtCreatedAt = 0;
  }
};

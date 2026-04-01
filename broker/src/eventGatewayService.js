const axios = require('axios');

const DEFAULT_LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const DEFAULT_BATCH_SIZE = Math.max(1, Number(process.env.HOMEBRAIN_ALEXA_EVENT_BATCH_SIZE || 25));
const DEFAULT_RETRY_LIMIT = Math.max(1, Number(process.env.HOMEBRAIN_ALEXA_EVENT_RETRY_LIMIT || 3));
const DEFAULT_RETRY_DELAY_MS = Math.max(1000, Number(process.env.HOMEBRAIN_ALEXA_EVENT_RETRY_DELAY_MS || 1000));
const DEFAULT_DISPATCH_INTERVAL_MS = Math.max(5000, Number(process.env.HOMEBRAIN_ALEXA_EVENT_DISPATCH_INTERVAL_MS || 15000));
const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getSkillClientId() {
  return trimString(process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_ID || process.env.HOMEBRAIN_ALEXA_SKILL_CLIENT_ID);
}

function getSkillClientSecret() {
  return trimString(process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET || process.env.HOMEBRAIN_ALEXA_SKILL_CLIENT_SECRET);
}

function getLwaTokenUrl() {
  return trimString(process.env.HOMEBRAIN_ALEXA_LWA_TOKEN_URL) || DEFAULT_LWA_TOKEN_URL;
}

function resolveEventRegion(value) {
  const normalized = trimString(value).toLowerCase();
  if (!normalized) {
    return 'NA';
  }
  if (normalized === 'eu' || normalized.startsWith('eu-')) {
    return 'EU';
  }
  if (normalized === 'fe' || normalized.startsWith('fe-') || normalized.startsWith('ap-')) {
    return 'FE';
  }
  if (normalized === 'na' || normalized.startsWith('us-') || normalized.startsWith('ca-')) {
    return 'NA';
  }
  if (normalized.includes('europe')) {
    return 'EU';
  }
  if (normalized.includes('far') || normalized.includes('asia') || normalized.includes('pacific')) {
    return 'FE';
  }
  return normalized.toUpperCase();
}

function getEventGatewayUrl(eventRegion) {
  const region = resolveEventRegion(eventRegion);
  const specificOverride = trimString(process.env[`HOMEBRAIN_ALEXA_EVENT_GATEWAY_URL_${region}`]);
  if (specificOverride) {
    return specificOverride;
  }
  const sharedOverride = trimString(process.env.HOMEBRAIN_ALEXA_EVENT_GATEWAY_URL);
  if (sharedOverride) {
    return sharedOverride;
  }
  if (region === 'EU') {
    return 'https://api.eu.amazonalexa.com/v3/events';
  }
  if (region === 'FE') {
    return 'https://api.fe.amazonalexa.com/v3/events';
  }
  return 'https://api.amazonalexa.com/v3/events';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildBearerScope(token) {
  return {
    type: 'BearerToken',
    token
  };
}

function attachScopeToEventPayload(payload, accessToken) {
  const body = clone(payload);
  const eventNamespace = body?.event?.header?.namespace;

  if (eventNamespace === 'Alexa.Discovery') {
    body.event.payload = {
      ...(body.event.payload || {}),
      scope: buildBearerScope(accessToken)
    };
    return body;
  }

  body.event = body.event || {};
  body.event.endpoint = {
    ...(body.event.endpoint || {}),
    scope: buildBearerScope(accessToken)
  };
  return body;
}

function calculateBackoffMs(attemptNumber) {
  return DEFAULT_RETRY_DELAY_MS * Math.max(1, 2 ** Math.max(0, attemptNumber - 1));
}

class AlexaEventGatewayService {
  constructor({ store, httpClient = axios, autoStart = false } = {}) {
    this.store = store;
    this.httpClient = httpClient;
    this.autoStart = autoStart;
    this.intervalId = null;
    this.processing = false;

    if (autoStart) {
      this.start();
    }
  }

  isConfigured() {
    return Boolean(getSkillClientId() && getSkillClientSecret());
  }

  async requestLwaToken(params) {
    if (!this.isConfigured()) {
      throw new Error('Alexa event gateway client credentials are not configured');
    }

    const form = new URLSearchParams({
      ...params,
      client_id: getSkillClientId(),
      client_secret: getSkillClientSecret()
    });

    const response = await this.httpClient.post(getLwaTokenUrl(), form.toString(), {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      }
    });

    return response.data;
  }

  async acceptGrantForLinkedAccount({
    brokerAccountId,
    hubId,
    granteeToken,
    grantCode,
    permissionScopes = ['alexa::async_event:write'],
    eventRegion,
    metadata = {}
  } = {}) {
    const resolvedRegion = resolveEventRegion(eventRegion || process.env.AWS_REGION || 'NA');
    const tokenData = await this.requestLwaToken({
      grant_type: 'authorization_code',
      code: trimString(grantCode)
    });

    const timestamp = Date.now();
    const record = await this.store.recordPermissionGrant({
      brokerAccountId,
      hubId,
      granteeToken,
      grantCode,
      permissionScopes,
      eventRegion: resolvedRegion,
      eventGatewayUrl: getEventGatewayUrl(resolvedRegion),
      lwaTokenUrl: getLwaTokenUrl(),
      accessToken: trimString(tokenData.access_token),
      refreshToken: trimString(tokenData.refresh_token),
      tokenType: trimString(tokenData.token_type || 'bearer') || 'bearer',
      tokenExpiresAt: new Date(timestamp + Math.max(60, Number(tokenData.expires_in || 3600)) * 1000).toISOString(),
      lastRefreshedAt: new Date(timestamp).toISOString(),
      status: 'active',
      lastError: '',
      metadata
    });

    await this.store.appendAudit({
      type: 'permission_grant_accepted',
      hubId: hubId || record.hubId,
      brokerAccountId,
      message: 'Stored Alexa proactive-events grant',
      details: {
        eventRegion: record.eventRegion,
        permissionGrantId: record.permissionGrantId
      }
    });

    return record;
  }

  async refreshPermissionGrant(grant) {
    if (!trimString(grant?.refreshToken)) {
      throw new Error('Permission grant does not have a refresh token');
    }

    const tokenData = await this.requestLwaToken({
      grant_type: 'refresh_token',
      refresh_token: trimString(grant.refreshToken)
    });

    const timestamp = Date.now();
    return this.store.updatePermissionGrant(grant.permissionGrantId, {
      accessToken: trimString(tokenData.access_token),
      refreshToken: trimString(tokenData.refresh_token || grant.refreshToken),
      tokenType: trimString(tokenData.token_type || grant.tokenType || 'bearer') || 'bearer',
      tokenExpiresAt: new Date(timestamp + Math.max(60, Number(tokenData.expires_in || 3600)) * 1000).toISOString(),
      lastRefreshedAt: new Date(timestamp).toISOString(),
      status: 'active',
      lastError: ''
    });
  }

  async ensureValidGrantAccessToken(grant) {
    const expiresAtMs = new Date(grant?.tokenExpiresAt || 0).getTime();
    if (Number.isFinite(expiresAtMs) && expiresAtMs > (Date.now() + 60 * 1000)) {
      return grant;
    }

    return this.refreshPermissionGrant(grant);
  }

  async sendEventToGateway(grant, queuedEvent) {
    const activeGrant = await this.ensureValidGrantAccessToken(grant);
    const payload = attachScopeToEventPayload(queuedEvent.payload, activeGrant.accessToken);
    const response = await this.httpClient.post(
      trimString(activeGrant.eventGatewayUrl) || getEventGatewayUrl(activeGrant.eventRegion),
      payload,
      {
        timeout: 10000,
        headers: {
          Authorization: `Bearer ${activeGrant.accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    await this.store.updatePermissionGrant(activeGrant.permissionGrantId, {
      lastUsedAt: new Date().toISOString(),
      lastError: ''
    });

    return response;
  }

  async dispatchQueuedEvent(queuedEvent) {
    const grant = queuedEvent.permissionGrantId
      ? await this.store.getPermissionGrant(queuedEvent.permissionGrantId)
      : null;

    if (!grant || grant.status !== 'active' || grant.revokedAt) {
      await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
        status: 'skipped',
        lastError: 'No active Alexa permission grant is available for this queued event'
      });
      return {
        status: 'skipped'
      };
    }

    try {
      const response = await this.sendEventToGateway(grant, queuedEvent);
      await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
        status: 'delivered',
        deliveredAt: new Date().toISOString(),
        lastError: '',
        metadata: {
          lastResponseStatus: response.status
        }
      });

      return {
        status: 'delivered',
        httpStatus: response.status
      };
    } catch (error) {
      const responseStatus = Number(error.response?.status || 0);
      const message = trimString(error.response?.data?.message || error.response?.data?.error || error.message) || 'Alexa event delivery failed';

      if (responseStatus === 401 && trimString(grant.refreshToken)) {
        try {
          const refreshedGrant = await this.refreshPermissionGrant(grant);
          const response = await this.sendEventToGateway(refreshedGrant, queuedEvent);
          await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
            status: 'delivered',
            deliveredAt: new Date().toISOString(),
            lastError: '',
            metadata: {
              lastResponseStatus: response.status,
              retriedAfterRefresh: true
            }
          });
          return {
            status: 'delivered',
            httpStatus: response.status,
            refreshed: true
          };
        } catch (refreshError) {
          const refreshMessage = trimString(refreshError.response?.data?.message || refreshError.response?.data?.error || refreshError.message) || message;
          await this.store.updatePermissionGrant(grant.permissionGrantId, {
            status: 'error',
            lastError: refreshMessage
          });
          await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
            status: queuedEvent.attempts >= queuedEvent.maxAttempts ? 'failed' : 'queued',
            nextAttemptAt: queuedEvent.attempts >= queuedEvent.maxAttempts
              ? queuedEvent.nextAttemptAt
              : new Date(Date.now() + calculateBackoffMs(queuedEvent.attempts)).toISOString(),
            lastError: refreshMessage
          });
          return {
            status: queuedEvent.attempts >= queuedEvent.maxAttempts ? 'failed' : 'queued',
            httpStatus: Number(refreshError.response?.status || responseStatus || 0)
          };
        }
      }

      if (responseStatus === 403) {
        await this.store.updatePermissionGrant(grant.permissionGrantId, {
          status: 'revoked',
          revokedAt: new Date().toISOString(),
          lastError: message
        });
      }

      if (RETRYABLE_STATUS_CODES.has(responseStatus) && queuedEvent.attempts < queuedEvent.maxAttempts) {
        await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
          status: 'queued',
          nextAttemptAt: new Date(Date.now() + calculateBackoffMs(queuedEvent.attempts)).toISOString(),
          lastError: message,
          metadata: {
            lastResponseStatus: responseStatus
          }
        });
        return {
          status: 'queued',
          httpStatus: responseStatus
        };
      }

      await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
        status: 'failed',
        lastError: message,
        metadata: {
          lastResponseStatus: responseStatus
        }
      });
      return {
        status: 'failed',
        httpStatus: responseStatus
      };
    }
  }

  async flush(options = {}) {
    if (this.processing) {
      return {
        success: true,
        skipped: true,
        reason: 'Alexa event dispatch is already running'
      };
    }

    this.processing = true;
    try {
      const queuedEvents = await this.store.reserveQueuedEvents({
        limit: Math.max(1, Number(options.limit || DEFAULT_BATCH_SIZE)),
        hubId: options.hubId
      });

      const results = [];
      for (const queuedEvent of queuedEvents) {
        results.push({
          eventId: queuedEvent.eventId,
          ...(await this.dispatchQueuedEvent(queuedEvent))
        });
      }

      return {
        success: true,
        processed: results.length,
        results
      };
    } finally {
      this.processing = false;
    }
  }

  kick(options = {}) {
    setTimeout(() => {
      void this.flush(options).catch(() => {});
    }, 0);
  }

  start() {
    if (this.intervalId) {
      return;
    }

    this.intervalId = setInterval(() => {
      void this.flush().catch(() => {});
    }, DEFAULT_DISPATCH_INTERVAL_MS);

    if (typeof this.intervalId.unref === 'function') {
      this.intervalId.unref();
    }
  }

  stop() {
    if (!this.intervalId) {
      return;
    }
    clearInterval(this.intervalId);
    this.intervalId = null;
  }
}

module.exports = {
  AlexaEventGatewayService,
  attachScopeToEventPayload,
  getEventGatewayUrl,
  resolveEventRegion
};

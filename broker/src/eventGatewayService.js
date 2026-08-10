const axios = require('axios');

const DEFAULT_LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const DEFAULT_BATCH_SIZE = Math.max(1, Number(process.env.HOMEBRAIN_ALEXA_EVENT_BATCH_SIZE || 25));
const DEFAULT_RETRY_LIMIT = Math.max(1, Number(process.env.HOMEBRAIN_ALEXA_EVENT_RETRY_LIMIT || 8));
const DEFAULT_RETRY_DELAY_MS = Math.max(1000, Number(process.env.HOMEBRAIN_ALEXA_EVENT_RETRY_DELAY_MS || 5000));
const DEFAULT_DISPATCH_INTERVAL_MS = Math.max(5000, Number(process.env.HOMEBRAIN_ALEXA_EVENT_DISPATCH_INTERVAL_MS || 15000));
const DEFAULT_GRANT_ACTIVATION_GRACE_MS = Math.max(
  60 * 1000,
  Number(process.env.HOMEBRAIN_ALEXA_GRANT_ACTIVATION_GRACE_MS || 10 * 60 * 1000)
);
const DEFAULT_GRANT_ACTIVATION_RETRY_LIMIT = Math.max(
  2,
  Number(process.env.HOMEBRAIN_ALEXA_GRANT_ACTIVATION_RETRY_LIMIT || 8)
);
const DEFAULT_GRANT_ACTIVATION_RETRY_DELAY_MS = Math.max(
  5000,
  Number(process.env.HOMEBRAIN_ALEXA_GRANT_ACTIVATION_RETRY_DELAY_MS || 30 * 1000)
);
const DEFAULT_GRANT_ACTIVATION_RETRY_MAX_DELAY_MS = Math.max(
  DEFAULT_GRANT_ACTIVATION_RETRY_DELAY_MS,
  Number(process.env.HOMEBRAIN_ALEXA_GRANT_ACTIVATION_RETRY_MAX_DELAY_MS || 2 * 60 * 1000)
);
const DEFAULT_GRANT_INITIAL_DELAY_MS = Math.max(
  0,
  Number(process.env.HOMEBRAIN_ALEXA_GRANT_INITIAL_DELAY_MS || 30 * 1000)
);
const RETRYABLE_STATUS_CODES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);
const REVOKED_EVENT_GATEWAY_CODES = new Set([
  'SKILL_DISABLED_EXCEPTION',
  'SKILL_REVOKED_EXCEPTION'
]);

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

function calculateActivationBackoffMs(attemptNumber) {
  return Math.min(
    DEFAULT_GRANT_ACTIVATION_RETRY_MAX_DELAY_MS,
    DEFAULT_GRANT_ACTIVATION_RETRY_DELAY_MS * Math.max(1, 2 ** Math.max(0, attemptNumber - 1))
  );
}

function parseTokenExpiresIn(value) {
  const expiresIn = Number(value ?? 3600);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('LWA token response has an invalid expires_in value');
  }
  return Math.max(60, expiresIn);
}

function validateLwaTokenData(tokenData, { requireRefreshToken = false } = {}) {
  const accessToken = trimString(tokenData?.access_token);
  const refreshToken = trimString(tokenData?.refresh_token);
  if (!accessToken) {
    throw new Error('LWA token response is missing access_token');
  }
  if (requireRefreshToken && !refreshToken) {
    throw new Error('LWA token response is missing refresh_token');
  }
  return {
    accessToken,
    refreshToken,
    tokenType: trimString(tokenData?.token_type || 'bearer') || 'bearer',
    expiresIn: parseTokenExpiresIn(tokenData?.expires_in)
  };
}

function getAlexaErrorDetails(error) {
  const data = error?.response?.data;
  const nestedPayload = data?.payload && typeof data.payload === 'object' ? data.payload : {};
  const status = Number(error?.response?.status || error?.status || 0);
  const code = trimString(
    data?.code
    || data?.error
    || nestedPayload.code
    || nestedPayload.type
    || error?.code
  ).toUpperCase();
  const message = trimString(
    data?.message
    || data?.error_description
    || nestedPayload.description
    || nestedPayload.message
    || error?.message
    || code
  ) || 'Alexa event delivery failed';
  return {
    status,
    code,
    message,
    stage: trimString(error?.alexaStage)
  };
}

function markAlexaStage(error, stage) {
  const target = error instanceof Error ? error : new Error(String(error || 'Alexa request failed'));
  target.alexaStage = stage;
  return target;
}

function isRetryableFailure(details) {
  return RETRYABLE_STATUS_CODES.has(details.status) || details.status >= 500;
}

function isTerminalLwaGrantFailure(details) {
  return details.code === 'INVALID_GRANT'
    || details.code === 'INVALID_TOKEN'
    || details.code === 'UNAUTHORIZED_CLIENT';
}

class AlexaEventGatewayService {
  constructor({ store, httpClient = axios, autoStart = false } = {}) {
    this.store = store;
    this.httpClient = httpClient;
    this.autoStart = autoStart;
    this.intervalId = null;
    this.processing = false;
    this.acceptGrantPromises = new Map();

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

    try {
      const response = await this.httpClient.post(getLwaTokenUrl(), form.toString(), {
        timeout: 7000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        }
      });
      return response.data;
    } catch (error) {
      throw markAlexaStage(error, params?.grant_type === 'refresh_token' ? 'lwa_refresh' : 'lwa_authorization_code');
    }
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
    const normalizedGrantCode = trimString(grantCode);
    if (!normalizedGrantCode || !trimString(granteeToken) || !trimString(brokerAccountId)) {
      throw new Error('AcceptGrant requires a linked account, grant code, and grantee token');
    }

    const operationKey = `${trimString(brokerAccountId)}::${normalizedGrantCode}`;
    const activeOperation = this.acceptGrantPromises.get(operationKey);
    if (activeOperation) {
      return activeOperation;
    }

    const operation = (async () => {
      const existing = typeof this.store.findPermissionGrantByGrantCode === 'function'
        ? await this.store.findPermissionGrantByGrantCode(normalizedGrantCode, { brokerAccountId, hubId })
        : null;
      if (existing?.accessToken && existing?.refreshToken) {
        return {
          ...existing,
          idempotentReplay: true
        };
      }

      const resolvedRegion = resolveEventRegion(eventRegion || process.env.AWS_REGION || 'NA');
      const tokenData = await this.requestLwaToken({
        grant_type: 'authorization_code',
        code: normalizedGrantCode
      });
      let validatedTokens;
      try {
        validatedTokens = validateLwaTokenData(tokenData, { requireRefreshToken: true });
      } catch (error) {
        throw markAlexaStage(error, 'lwa_authorization_code');
      }

      const timestamp = Date.now();
      const record = await this.store.recordPermissionGrant({
        brokerAccountId,
        hubId,
        granteeToken,
        grantCode: normalizedGrantCode,
        permissionScopes,
        eventRegion: resolvedRegion,
        eventGatewayUrl: getEventGatewayUrl(resolvedRegion),
        lwaTokenUrl: getLwaTokenUrl(),
        accessToken: validatedTokens.accessToken,
        refreshToken: validatedTokens.refreshToken,
        tokenType: validatedTokens.tokenType,
        tokenExpiresAt: new Date(timestamp + validatedTokens.expiresIn * 1000).toISOString(),
        lastRefreshedAt: new Date(timestamp).toISOString(),
        status: 'active',
        lastError: '',
        metadata
      });

      Promise.resolve(this.store.appendAudit?.({
        type: 'permission_grant_accepted',
        hubId: hubId || record.hubId,
        brokerAccountId,
        message: 'Stored Alexa proactive-events grant',
        details: {
          eventRegion: record.eventRegion,
          permissionGrantId: record.permissionGrantId
        }
      })).catch(() => {});

      return record;
    })();

    this.acceptGrantPromises.set(operationKey, operation);
    try {
      return await operation;
    } finally {
      this.acceptGrantPromises.delete(operationKey);
    }
  }

  async refreshPermissionGrant(grant) {
    if (!trimString(grant?.refreshToken)) {
      throw markAlexaStage(new Error('Permission grant does not have a refresh token'), 'lwa_refresh');
    }

    const tokenData = await this.requestLwaToken({
      grant_type: 'refresh_token',
      refresh_token: trimString(grant.refreshToken)
    });
    let validatedTokens;
    try {
      validatedTokens = validateLwaTokenData(tokenData);
    } catch (error) {
      throw markAlexaStage(error, 'lwa_refresh');
    }

    const timestamp = Date.now();
    return this.store.updatePermissionGrant(grant.permissionGrantId, {
      accessToken: validatedTokens.accessToken,
      refreshToken: validatedTokens.refreshToken || trimString(grant.refreshToken),
      tokenType: validatedTokens.tokenType || trimString(grant.tokenType || 'bearer') || 'bearer',
      tokenExpiresAt: new Date(timestamp + validatedTokens.expiresIn * 1000).toISOString(),
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
      lastError: '',
      metadata: {
        lastErrorCode: '',
        lastErrorStatus: 0,
        lastDeliveryAt: new Date().toISOString()
      }
    });

    return response;
  }

  async updateGrantFailure(grant, details, status = 'active', extraMetadata = {}) {
    return this.store.updatePermissionGrant(grant.permissionGrantId, {
      status,
      lastError: details.message,
      ...(status === 'revoked' ? { revokedAt: new Date().toISOString() } : {}),
      metadata: {
        lastErrorCode: details.code,
        lastErrorStatus: details.status,
        lastErrorStage: details.stage,
        lastErrorAt: new Date().toISOString(),
        ...extraMetadata
      }
    });
  }

  async finalizeRetryableEvent(queuedEvent, details, options = {}) {
    const maxAttempts = Math.max(
      Number(queuedEvent.maxAttempts || 0),
      Number(options.maxAttempts || DEFAULT_RETRY_LIMIT)
    );
    const shouldRetry = Number(queuedEvent.attempts || 0) < maxAttempts;
    const delayMs = typeof options.delayMs === 'number'
      ? options.delayMs
      : calculateBackoffMs(queuedEvent.attempts);
    await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
      status: shouldRetry ? 'queued' : 'failed',
      maxAttempts,
      nextAttemptAt: shouldRetry
        ? new Date(Date.now() + delayMs).toISOString()
        : queuedEvent.nextAttemptAt,
      lastError: details.message,
      metadata: {
        lastResponseStatus: details.status,
        lastResponseCode: details.code,
        lastFailureStage: details.stage
      }
    });
    return {
      status: shouldRetry ? 'queued' : 'failed',
      httpStatus: details.status,
      errorCode: details.code
    };
  }

  appendFailureAudit(grant, type, details, extraDetails = {}) {
    Promise.resolve(this.store.appendAudit?.({
      type,
      severity: type.includes('retry') ? 'warning' : 'error',
      hubId: grant.hubId,
      brokerAccountId: grant.brokerAccountId,
      message: details.message,
      details: {
        permissionGrantId: grant.permissionGrantId,
        httpStatus: details.status,
        errorCode: details.code,
        stage: details.stage,
        ...extraDetails
      }
    })).catch(() => {});
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

    const acceptedAt = new Date(grant.acceptedAt || grant.createdAt || 0).getTime();
    const activationReadyAt = acceptedAt + DEFAULT_GRANT_INITIAL_DELAY_MS;
    if (
      DEFAULT_GRANT_INITIAL_DELAY_MS > 0
      && Number.isFinite(acceptedAt)
      && acceptedAt > 0
      && activationReadyAt > Date.now()
    ) {
      await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
        status: 'queued',
        maxAttempts: Math.max(Number(queuedEvent.maxAttempts || 0), DEFAULT_GRANT_ACTIVATION_RETRY_LIMIT),
        nextAttemptAt: new Date(activationReadyAt).toISOString(),
        lastError: '',
        metadata: {
          activationDelayApplied: true
        }
      });
      return {
        status: 'queued',
        deferred: 'grant_activation'
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
      let details = getAlexaErrorDetails(error);
      let refreshedAfterUnauthorized = false;

      if (details.status === 401 && details.stage !== 'lwa_refresh' && trimString(grant.refreshToken)) {
        try {
          const refreshedGrant = await this.refreshPermissionGrant(grant);
          refreshedAfterUnauthorized = true;
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
          details = getAlexaErrorDetails(refreshError);
        }
      }

      if (details.stage === 'lwa_refresh') {
        if (isTerminalLwaGrantFailure(details)) {
          await this.updateGrantFailure(grant, details, 'revoked');
          await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
            status: 'skipped',
            lastError: details.message,
            metadata: {
              lastResponseStatus: details.status,
              lastResponseCode: details.code,
              lastFailureStage: details.stage
            }
          });
          this.appendFailureAudit(grant, 'permission_grant_revoked', details);
          return {
            status: 'skipped',
            httpStatus: details.status,
            errorCode: details.code
          };
        }

        await this.updateGrantFailure(grant, details, 'active');
        this.appendFailureAudit(grant, 'permission_grant_refresh_retry', details);
        return this.finalizeRetryableEvent(queuedEvent, details);
      }

      if (details.status === 401 && refreshedAfterUnauthorized) {
        await this.updateGrantFailure(grant, details, 'revoked', {
          revokedAfterRefreshRetry: true
        });
        await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
          status: 'skipped',
          lastError: details.message,
          metadata: {
            lastResponseStatus: details.status,
            lastResponseCode: details.code,
            retriedAfterRefresh: true
          }
        });
        this.appendFailureAudit(grant, 'permission_grant_revoked', details, {
          retriedAfterRefresh: true
        });
        return {
          status: 'skipped',
          httpStatus: details.status,
          errorCode: details.code
        };
      }

      if (details.status === 403) {
        if (REVOKED_EVENT_GATEWAY_CODES.has(details.code)) {
          await this.updateGrantFailure(grant, details, 'revoked');
          await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
            status: 'skipped',
            lastError: details.message,
            metadata: {
              lastResponseStatus: details.status,
              lastResponseCode: details.code
            }
          });
          this.appendFailureAudit(grant, 'permission_grant_revoked', details);
          return {
            status: 'skipped',
            httpStatus: details.status,
            errorCode: details.code
          };
        }

        const acceptedAt = new Date(grant.acceptedAt || grant.createdAt || 0).getTime();
        const withinActivationGrace = Number.isFinite(acceptedAt)
          && acceptedAt > 0
          && Date.now() - acceptedAt < DEFAULT_GRANT_ACTIVATION_GRACE_MS;
        if (withinActivationGrace) {
          await this.updateGrantFailure(grant, details, 'active', {
            activationGraceRetry: true
          });
          this.appendFailureAudit(grant, 'permission_grant_activation_retry', details);
          return this.finalizeRetryableEvent(queuedEvent, details, {
            maxAttempts: DEFAULT_GRANT_ACTIVATION_RETRY_LIMIT,
            delayMs: calculateActivationBackoffMs(queuedEvent.attempts)
          });
        }

        await this.updateGrantFailure(grant, details, 'error', {
          configurationReviewRequired: true
        });
        await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
          status: 'failed',
          lastError: details.message,
          metadata: {
            lastResponseStatus: details.status,
            lastResponseCode: details.code
          }
        });
        this.appendFailureAudit(grant, 'permission_grant_configuration_error', details);
        return {
          status: 'failed',
          httpStatus: details.status,
          errorCode: details.code
        };
      }

      if (isRetryableFailure(details)) {
        await this.updateGrantFailure(grant, details, 'active');
        return this.finalizeRetryableEvent(queuedEvent, details);
      }

      await this.updateGrantFailure(grant, details, details.status === 404 ? 'error' : 'active');
      await this.store.finalizeQueuedEvent(queuedEvent.eventId, {
        status: 'failed',
        lastError: details.message,
        metadata: {
          lastResponseStatus: details.status,
          lastResponseCode: details.code,
          lastFailureStage: details.stage
        }
      });
      return {
        status: 'failed',
        httpStatus: details.status,
        errorCode: details.code
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

const express = require('express');
const axios = require('axios');
const brokerStore = require('./store');
const {
  buildAddOrUpdateReport,
  buildChangeReport,
  buildDeleteReport
} = require('../../shared/alexa/messages');
const { extractCustomSkillIdentity } = require('../../shared/alexa/customSkill');
const { AlexaEventGatewayService, resolveEventRegion } = require('./eventGatewayService');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getBrokerClientId() {
  return trimString(process.env.HOMEBRAIN_ALEXA_OAUTH_CLIENT_ID) || 'homebrain-alexa-skill';
}

function getConfiguredBrokerClientSecret() {
  return trimString(process.env.HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET);
}

function getBrokerDisplayName() {
  return trimString(process.env.HOMEBRAIN_ALEXA_BROKER_DISPLAY_NAME) || 'HomeBrain Alexa Broker';
}

function parseJsonEnv(value, fallback = null) {
  const normalized = trimString(value);
  if (!normalized) {
    return fallback;
  }

  try {
    return JSON.parse(normalized);
  } catch (_error) {
    return fallback;
  }
}

function getClientRegistry() {
  const configured = parseJsonEnv(process.env.HOMEBRAIN_ALEXA_OAUTH_CLIENTS, null);
  if (Array.isArray(configured)) {
    return configured
      .map((entry) => {
        const clientId = trimString(entry?.clientId || entry?.id);
        if (!clientId) {
          return null;
        }

        return {
          clientId,
          clientSecret: trimString(entry?.clientSecret),
          redirectUris: Array.from(new Set((Array.isArray(entry?.redirectUris) ? entry.redirectUris : [])
            .map((value) => trimString(value))
            .filter(Boolean))),
          allowedHubIds: Array.from(new Set((Array.isArray(entry?.allowedHubIds) ? entry.allowedHubIds : [])
            .map((value) => trimString(value))
            .filter(Boolean))),
          allowAnyRedirectUri: entry?.allowAnyRedirectUri === true
        };
      })
      .filter(Boolean);
  }

  const clientId = getBrokerClientId();
  const allowedClientIds = trimString(process.env.HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS)
    .split(',')
    .map((entry) => trimString(entry))
    .filter(Boolean);
  const redirectUris = trimString(process.env.HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS)
    .split(',')
    .map((entry) => trimString(entry))
    .filter(Boolean);
  const fallbackClientIds = allowedClientIds.length > 0 ? allowedClientIds : [clientId];

  return fallbackClientIds.map((value) => ({
    clientId: value,
    clientSecret: getConfiguredBrokerClientSecret(),
    redirectUris,
    allowedHubIds: [],
    allowAnyRedirectUri: redirectUris.length === 0
  }));
}

function getClientConfig(clientId) {
  const value = trimString(clientId);
  if (!value) {
    return null;
  }

  return getClientRegistry().find((entry) => entry.clientId === value) || null;
}

function resolveClientCredentials(req) {
  const basicHeader = trimString(req.headers.authorization);
  if (basicHeader.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(basicHeader.slice(6), 'base64').toString('utf8');
      const separatorIndex = decoded.indexOf(':');
      if (separatorIndex >= 0) {
        return {
          clientId: decoded.slice(0, separatorIndex),
          clientSecret: decoded.slice(separatorIndex + 1)
        };
      }
    } catch (_error) {
      return {
        clientId: '',
        clientSecret: ''
      };
    }
  }

  return {
    clientId: trimString(req.body?.client_id || req.query?.client_id),
    clientSecret: trimString(req.body?.client_secret || req.query?.client_secret)
  };
}

function validateClientId(clientId) {
  const value = trimString(clientId);
  if (!value) {
    throw new Error('client_id is required');
  }

  const client = getClientConfig(value);
  if (!client) {
    throw new Error('client_id is not allowed');
  }

  return client;
}

function validateClientSecret(client, clientSecret) {
  const expectedSecret = trimString(client?.clientSecret || getConfiguredBrokerClientSecret());
  if (expectedSecret && clientSecret !== expectedSecret) {
    throw new Error('client_secret is invalid');
  }
}

function validateRedirectUri(client, redirectUri) {
  const normalizedRedirectUri = trimString(redirectUri);
  if (!normalizedRedirectUri) {
    throw new Error('redirect_uri is required');
  }

  let parsed;
  try {
    parsed = new URL(normalizedRedirectUri);
  } catch (_error) {
    throw new Error('redirect_uri is invalid');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('redirect_uri must use http or https');
  }

  if (parsed.protocol === 'http:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('redirect_uri must use https unless it targets localhost');
  }

  const allowedRedirectUris = Array.isArray(client?.redirectUris) ? client.redirectUris : [];
  if (allowedRedirectUris.length > 0 && !allowedRedirectUris.includes(normalizedRedirectUri)) {
    throw new Error('redirect_uri is not allowed');
  }

  return normalizedRedirectUri;
}

function sanitizeBaseUrl(value) {
  const normalized = trimString(value).replace(/\/+$/, '');
  if (!normalized) {
    return '';
  }

  return new URL(normalized).origin;
}

function buildAbsoluteUrl(baseUrl, value, fallbackPath = '') {
  const normalizedBaseUrl = sanitizeBaseUrl(baseUrl);
  const candidate = trimString(value || fallbackPath);
  if (!normalizedBaseUrl) {
    return '';
  }
  if (!candidate) {
    return normalizedBaseUrl;
  }
  return new URL(candidate, normalizedBaseUrl).toString();
}

function extractBearerToken(value) {
  const match = trimString(value).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildAuthorizeErrorRedirect(redirectUri, error, description, state) {
  const target = new URL(redirectUri);
  target.searchParams.set('error', error);
  if (description) {
    target.searchParams.set('error_description', description);
  }
  if (state) {
    target.searchParams.set('state', state);
  }
  return target.toString();
}

function safeOrigin(value) {
  try {
    return sanitizeBaseUrl(value);
  } catch (_error) {
    return '';
  }
}

function buildBrokerBaseUrl(req) {
  const configured = sanitizeBaseUrl(process.env.HOMEBRAIN_BROKER_PUBLIC_BASE_URL);
  if (configured) {
    return configured;
  }

  const forwardedProto = trimString(req.headers['x-forwarded-proto']) || req.protocol;
  const forwardedHost = trimString(req.headers['x-forwarded-host']) || trimString(req.headers.host);
  if (!forwardedHost) {
    return '';
  }

  return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, '');
}

function isLoopbackHostname(hostname) {
  const value = trimString(hostname).toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function validateHubBaseUrl(value, { mode = 'private' } = {}) {
  const normalized = trimString(value);
  if (!normalized) {
    throw new Error('hubBaseUrl is required');
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_error) {
    throw new Error('hubBaseUrl is invalid');
  }

  const requiresHttps = mode === 'public' || !isLoopbackHostname(parsed.hostname);
  if (requiresHttps && parsed.protocol !== 'https:') {
    throw new Error('hubBaseUrl must use https unless it points to localhost for private mode');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('hubBaseUrl must use http or https');
  }

  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/+$/, '');
}

function resolveHubReference(hubs = [], reference = '', allowedHubIds = []) {
  const normalizedReference = trimString(reference);
  const allowed = new Set((Array.isArray(allowedHubIds) ? allowedHubIds : []).map((entry) => trimString(entry)).filter(Boolean));
  const candidates = (Array.isArray(hubs) ? hubs : [])
    .filter((hub) => hub?.registration)
    .filter((hub) => allowed.size === 0 || allowed.has(hub.hubId));

  if (candidates.length === 0) {
    throw new Error('No HomeBrain hubs have been paired with the broker yet');
  }

  if (!normalizedReference && candidates.length === 1) {
    return candidates[0];
  }
  if (!normalizedReference) {
    throw new Error('hubRef is required when more than one HomeBrain hub is paired');
  }

  const normalizedOrigin = safeOrigin(normalizedReference);
  const match = candidates.find((hub) => hub.hubId === normalizedReference)
    || candidates.find((hub) => safeOrigin(hub.registration?.publicOrigin) === normalizedOrigin);
  if (!match) {
    throw new Error('Selected hub could not be found');
  }

  return match;
}

function buildRequestId() {
  return `hbr_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

function getRateLimitConfig() {
  return {
    windowMs: Math.max(1000, Number(process.env.HOMEBRAIN_ALEXA_RATE_LIMIT_WINDOW_MS || 60 * 1000)),
    maxRequests: Math.max(1, Number(process.env.HOMEBRAIN_ALEXA_RATE_LIMIT_MAX || 120))
  };
}

function createRateLimitMiddleware() {
  const buckets = new Map();
  const { windowMs, maxRequests } = getRateLimitConfig();

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const key = trimString(req.headers['x-forwarded-for'])
      .split(',')[0]
      .trim()
      || trimString(req.socket?.remoteAddress)
      || 'unknown';
    const bucket = buckets.get(key);

    if (!bucket || now - bucket.startedAt >= windowMs) {
      buckets.set(key, { startedAt: now, count: 1 });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      res.status(429).json({
        success: false,
        error: 'Rate limit exceeded'
      });
      return;
    }

    next();
  };
}

async function proxyToHub(store, hubId, kind, method = 'get', body = null) {
  const hub = await store.getHub(hubId);
  if (!hub?.registration) {
    const error = new Error(`Hub ${hubId} is not registered with the broker`);
    error.status = 404;
    throw error;
  }

  const url = hub.registration[`${kind}Url`];
  if (!url) {
    const error = new Error(`Hub ${hubId} does not have a ${kind} URL configured`);
    error.status = 501;
    throw error;
  }

  const response = await axios({
    url,
    method,
    data: body,
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${hub.registration.relayToken}`,
      'X-HomeBrain-Hub-Id': hubId
    }
  });

  return response.data;
}

async function requireHubAuth(store, req) {
  const hubId = trimString(req.headers['x-homebrain-hub-id'] || req.body?.hubId || req.params?.hubId);
  const token = extractBearerToken(req.headers.authorization);

  if (!hubId) {
    const error = new Error('Hub authentication requires X-HomeBrain-Hub-Id');
    error.status = 401;
    throw error;
  }

  const hub = await store.getHub(hubId);
  if (!hub?.registration) {
    const error = new Error('Hub is not registered');
    error.status = 404;
    throw error;
  }

  if (!token || token !== hub.registration.relayToken) {
    const error = new Error('Hub authentication failed');
    error.status = 401;
    throw error;
  }

  return hub;
}

async function requireAlexaAuth(store, req, options = {}) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    const error = new Error('Alexa authorization token is required');
    error.status = 401;
    throw error;
  }

  let resolved;
  try {
    resolved = await store.resolveAccessToken(token);
  } catch (_error) {
    const error = new Error('Alexa authorization token is invalid or expired');
    error.status = 401;
    throw error;
  }

  const expectedHubId = trimString(options.expectedHubId);
  if (expectedHubId && resolved.hubId !== expectedHubId) {
    const error = new Error('Alexa authorization token does not match the requested HomeBrain hub');
    error.status = 403;
    throw error;
  }

  return resolved;
}

function renderAuthorizePage({ oauth = {}, error = '', brokerDisplayName = getBrokerDisplayName(), resolvedHub = null }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlEscape(brokerDisplayName)} Account Linking</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f6f4ef; color: #1f2937; }
      main { max-width: 36rem; margin: 3rem auto; padding: 2rem; background: white; border-radius: 1rem; box-shadow: 0 10px 30px rgba(15,23,42,0.08); }
      h1 { margin-top: 0; font-size: 1.75rem; }
      p { line-height: 1.5; }
      label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.35rem; }
      input, select, button { width: 100%; box-sizing: border-box; padding: 0.8rem 0.9rem; border-radius: 0.75rem; border: 1px solid #d1d5db; font-size: 1rem; }
      button { margin-top: 1.25rem; background: #14532d; color: white; border: none; font-weight: 700; cursor: pointer; }
      .hint { color: #4b5563; font-size: 0.95rem; }
      .error { padding: 0.8rem 0.9rem; border-radius: 0.75rem; background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; margin-bottom: 1rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Link Alexa to HomeBrain</h1>
      <p class="hint">Enter the HomeBrain hub ID or public origin from Settings &gt; Integrations &gt; Alexa, then provide the one-time Alexa pairing code.</p>
      ${error ? `<div class="error">${htmlEscape(error)}</div>` : ''}
      <form method="post" action="/api/oauth/alexa/authorize">
        <input type="hidden" name="response_type" value="${htmlEscape(oauth.responseType)}" />
        <input type="hidden" name="client_id" value="${htmlEscape(oauth.clientId)}" />
        <input type="hidden" name="redirect_uri" value="${htmlEscape(oauth.redirectUri)}" />
        <input type="hidden" name="scope" value="${htmlEscape(oauth.scope)}" />
        <input type="hidden" name="state" value="${htmlEscape(oauth.state)}" />
        <label for="hubRef">HomeBrain Hub ID or Public Origin</label>
        <input id="hubRef" name="hubRef" value="${htmlEscape(oauth.hubRef || resolvedHub?.hubId || resolvedHub?.registration?.publicOrigin || '')}" placeholder="hub-123 or https://home.example.com" required />
        <label for="linkCode">Alexa Pairing Code</label>
        <input id="linkCode" name="linkCode" autocomplete="one-time-code" placeholder="HBAX-XXXX-XXXX-XXXX" required />
        <label for="locale">Locale</label>
        <input id="locale" name="locale" value="${htmlEscape(oauth.locale || 'en-US')}" placeholder="en-US" />
        ${resolvedHub ? `<p class="hint">Resolved hub: ${htmlEscape(resolvedHub.hubId)}${resolvedHub.registration?.publicOrigin ? ` (${htmlEscape(resolvedHub.registration.publicOrigin)})` : ''}</p>` : ''}
        <button type="submit">Link Account</button>
      </form>
    </main>
  </body>
</html>`;
}

async function syncLinkedAccountsToHub(store, hubId) {
  const hub = await store.getHub(hubId);
  if (!hub?.registration?.accountsUrl) {
    return {
      skipped: true,
      reason: 'Hub does not expose an accounts endpoint'
    };
  }

  const accounts = await store.listAccountLinks({ hubId });
  const response = await proxyToHub(store, hubId, 'accounts', 'post', { accounts });
  return {
    success: true,
    count: accounts.length,
    response
  };
}

async function queueEventsForActivePermissionGrants(store, hubId, buildPayloadsForGrant) {
  const grants = await store.listActivePermissionGrants({ hubId });
  if (!Array.isArray(grants) || grants.length === 0) {
    return [];
  }

  const records = [];
  for (const grant of grants) {
    const payloads = await Promise.resolve(buildPayloadsForGrant(grant));
    const list = Array.isArray(payloads) ? payloads : [payloads];
    for (const payload of list) {
      if (!payload) {
        continue;
      }
      records.push(await store.enqueueEvent({
        ...payload,
        hubId,
        brokerAccountId: grant.brokerAccountId,
        permissionGrantId: grant.permissionGrantId
      }));
    }
  }

  return records;
}

function queueCatalogEvents(store, hubId, endpoints = []) {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    return Promise.resolve([]);
  }

  return queueEventsForActivePermissionGrants(store, hubId, () => ({
    kind: 'add_or_update_report',
    payload: buildAddOrUpdateReport({ endpoints }),
    metadata: { count: endpoints.length }
  }));
}

function queueDeleteEvents(store, hubId, endpointIds = []) {
  const ids = Array.isArray(endpointIds) ? endpointIds.filter(Boolean) : [];
  if (ids.length === 0) {
    return Promise.resolve([]);
  }

  return queueEventsForActivePermissionGrants(store, hubId, () => ({
    kind: 'delete_report',
    payload: buildDeleteReport({
      endpoints: ids.map((endpointId) => ({ endpointId }))
    }),
    metadata: { count: ids.length }
  }));
}

function queueStateEvents(store, hubId, states = []) {
  const list = Array.isArray(states) ? states : [];
  if (list.length === 0) {
    return Promise.resolve([]);
  }

  return queueEventsForActivePermissionGrants(store, hubId, () => list.map((entry) => ({
    kind: 'change_report',
    payload: buildChangeReport({
      endpoint: {
        endpointId: entry.endpointId
      },
      properties: Array.isArray(entry.properties) ? entry.properties : []
    }),
    metadata: {
      endpointId: entry.endpointId
    }
  })));
}

function queueCatalogEventsForBrokerAccount(store, hubId, brokerAccountId, endpoints = []) {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    return Promise.resolve([]);
  }

  return queueEventsForActivePermissionGrants(store, hubId, (grant) => {
    if (grant.brokerAccountId !== brokerAccountId) {
      return [];
    }

    return {
      kind: 'add_or_update_report',
      payload: buildAddOrUpdateReport({ endpoints }),
      metadata: { count: endpoints.length, brokerAccountId }
    };
  });
}

async function buildReadinessSnapshot(store, options = {}) {
  const hubId = trimString(options.hubId);
  const metrics = await store.getMetricsSnapshot({ hubId });
  const hubs = await store.listHubs();
  const scopedHubs = hubs.filter((entry) => (!hubId || entry.hubId === hubId));
  const publicHubs = scopedHubs.filter((entry) => entry.registration?.mode === 'public');
  const brokerBaseUrl = safeOrigin(process.env.HOMEBRAIN_BROKER_PUBLIC_BASE_URL);
  const clientRegistry = getClientRegistry();
  const checks = [];

  checks.push({
    id: 'hub_registration',
    label: 'Paired HomeBrain hub',
    status: scopedHubs.some((entry) => entry.registration) ? 'ok' : 'blocked',
    message: scopedHubs.some((entry) => entry.registration)
      ? 'At least one HomeBrain hub is paired with the broker.'
      : 'Pair a HomeBrain hub before attempting Alexa account linking.'
  });

  checks.push({
    id: 'oauth_clients',
    label: 'OAuth client registry',
    status: clientRegistry.length > 0 ? 'ok' : 'blocked',
    message: clientRegistry.length > 0
      ? `${clientRegistry.length} Alexa OAuth client configuration(s) loaded.`
      : 'Configure at least one Alexa OAuth client.'
  });

  checks.push({
    id: 'redirect_uri_allowlist',
    label: 'Redirect URI allowlist',
    status: clientRegistry.every((entry) => entry.allowAnyRedirectUri !== true || entry.redirectUris.length > 0)
      ? 'ok'
      : 'warning',
    message: clientRegistry.every((entry) => entry.allowAnyRedirectUri !== true || entry.redirectUris.length > 0)
      ? 'OAuth clients are using explicit redirect URI allowlists.'
      : 'One or more OAuth clients allow arbitrary redirect URIs. Configure HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS or HOMEBRAIN_ALEXA_OAUTH_CLIENTS before public release.'
  });

  checks.push({
    id: 'event_gateway_credentials',
    label: 'Alexa event-gateway credentials',
    status: trimString(process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_ID) && trimString(process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET)
      ? 'ok'
      : 'warning',
    message: trimString(process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_ID) && trimString(process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET)
      ? 'Event-gateway client credentials are configured.'
      : 'Configure HOMEBRAIN_ALEXA_EVENT_CLIENT_ID and HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET for proactive events.'
  });

  checks.push({
    id: 'broker_https',
    label: 'Broker HTTPS public base URL',
    status: publicHubs.length === 0 || brokerBaseUrl.startsWith('https://')
      ? 'ok'
      : 'warning',
    message: publicHubs.length === 0 || brokerBaseUrl.startsWith('https://')
      ? 'Broker public base URL is compatible with Alexa account linking.'
      : 'Set HOMEBRAIN_BROKER_PUBLIC_BASE_URL to an HTTPS origin before public rollout.'
  });

  checks.push({
    id: 'hub_https',
    label: 'Hub HTTPS origin',
    status: publicHubs.every((entry) => safeOrigin(entry.registration?.publicOrigin).startsWith('https://'))
      ? 'ok'
      : publicHubs.length > 0
        ? 'blocked'
        : 'ok',
    message: publicHubs.length === 0 || publicHubs.every((entry) => safeOrigin(entry.registration?.publicOrigin).startsWith('https://'))
      ? 'Public-mode hubs advertise HTTPS public origins.'
      : 'Every public-mode hub must advertise an HTTPS public origin.'
  });

  checks.push({
    id: 'event_queue_health',
    label: 'Broker event queue health',
    status: metrics.queue.failed === 0 && metrics.queue.oldestQueuedAgeMs < 15 * 60 * 1000
      ? 'ok'
      : metrics.queue.failed > 0
        ? 'warning'
        : 'warning',
    message: metrics.queue.failed === 0 && metrics.queue.oldestQueuedAgeMs < 15 * 60 * 1000
      ? 'Alexa event queue is healthy.'
      : `Broker queue has ${metrics.queue.failed} failed event(s) and an oldest queued age of ${metrics.queue.oldestQueuedAgeMs}ms.`
  });

  checks.push({
    id: 'manual_certificate_review',
    label: 'Manual Alexa certification review',
    status: 'manual',
    message: 'Run the Alexa Smart Home test tool and verify the deployed certificate chain before public submission.'
  });

  const blocked = checks.filter((entry) => entry.status === 'blocked').length;
  const warning = checks.filter((entry) => entry.status === 'warning' || entry.status === 'manual').length;

  return {
    hubId: hubId || null,
    status: blocked > 0 ? 'blocked' : warning > 0 ? 'warning' : 'ready',
    generatedAt: new Date().toISOString(),
    checks
  };
}

function createApp(options = {}) {
  const app = express();
  const store = options.store || brokerStore;
  const autoKickDispatcher = options.autoKickDispatcher !== false;
  const eventGatewayService = options.eventGatewayService || new AlexaEventGatewayService({
    store,
    autoStart: false
  });

  if (options.startDispatcher !== false) {
    eventGatewayService.start();
  }

  app.set('trust proxy', true);
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.requestId = trimString(req.headers['x-request-id']) || buildRequestId();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });
  app.use(createRateLimitMiddleware());

  app.get('/health', async (_req, res) => {
    const metrics = await store.getMetricsSnapshot();

    return res.status(200).json({
      success: true,
      hubs: metrics.hubs.total,
      queuedEvents: metrics.queue.queued,
      activePermissionGrants: metrics.permissionGrants.active,
      failedEvents: metrics.queue.failed,
      oldestQueuedAgeMs: metrics.queue.oldestQueuedAgeMs,
      generatedAt: metrics.generatedAt
    });
  });

  app.get('/api/oauth/alexa/authorize', async (req, res) => {
    const clientId = trimString(req.query.client_id);
    const redirectUri = trimString(req.query.redirect_uri);
    const state = trimString(req.query.state);
    let safeRedirectUri = '';

    try {
      const client = validateClientId(clientId);
      if (trimString(req.query.response_type) !== 'code') {
        throw new Error('response_type must be code');
      }
      const validatedRedirectUri = validateRedirectUri(client, redirectUri);
      safeRedirectUri = validatedRedirectUri;

      const hubs = (await store.listHubs()).filter((hub) => hub.registration);
      const requestedHubRef = trimString(req.query.hubRef || req.query.hubId);
      const allowedHubs = hubs.filter((hub) => (
        !Array.isArray(client.allowedHubIds)
        || client.allowedHubIds.length === 0
        || client.allowedHubIds.includes(hub.hubId)
      ));
      if (allowedHubs.length === 0) {
        throw new Error('No HomeBrain hubs are available for this Alexa client');
      }
      const resolvedHub = requestedHubRef
        ? resolveHubReference(allowedHubs, requestedHubRef, client.allowedHubIds)
        : allowedHubs.length === 1
          ? allowedHubs[0]
          : null;

      return res.status(200).type('html').send(renderAuthorizePage({
        resolvedHub,
        oauth: {
          responseType: trimString(req.query.response_type),
          clientId: client.clientId,
          redirectUri: validatedRedirectUri,
          scope: trimString(req.query.scope) || 'smart_home',
          state,
          locale: trimString(req.query.locale) || 'en-US',
          hubRef: requestedHubRef || resolvedHub?.hubId || ''
        }
      }));
    } catch (error) {
      if (safeRedirectUri) {
        return res.redirect(buildAuthorizeErrorRedirect(safeRedirectUri, 'invalid_request', error.message, state));
      }

      return res.status(400).type('html').send(renderAuthorizePage({
        oauth: {
          responseType: trimString(req.query.response_type),
          clientId,
          redirectUri,
          scope: trimString(req.query.scope),
          state,
          hubRef: trimString(req.query.hubRef || req.query.hubId)
        },
        error: error.message
      }));
    }
  });

  app.post('/api/oauth/alexa/authorize', async (req, res) => {
    const clientId = trimString(req.body.client_id);
    const redirectUri = trimString(req.body.redirect_uri);
    const state = trimString(req.body.state);
    let safeRedirectUri = '';

    try {
      const client = validateClientId(clientId);
      if (trimString(req.body.response_type) !== 'code') {
        throw new Error('response_type must be code');
      }
      const validatedRedirectUri = validateRedirectUri(client, redirectUri);
      safeRedirectUri = validatedRedirectUri;

      const hubRef = trimString(req.body.hubRef || req.body.hubId);
      const linkCode = trimString(req.body.linkCode);
      if (!linkCode) {
        throw new Error('linkCode is required');
      }

      const hub = resolveHubReference(await store.listHubs(), hubRef, client.allowedHubIds);
      const hubId = hub.hubId;

      if (!hub.registration.linkAccountUrl) {
        throw new Error('Selected hub does not support Alexa account linking yet');
      }

      const linkResponse = await proxyToHub(store, hubId, 'linkAccount', 'post', {
        linkCode,
        brokerClientId: clientId,
        actor: 'alexa_oauth'
      });

      const accountLink = await store.createAccountLink({
        hubId,
        locale: trimString(req.body.locale) || 'en-US',
        status: 'linked',
        metadata: {
          linkCodePreview: linkResponse.codePreview || '',
          linkedVia: 'link_code',
          clientId
        }
      });

      const authorizationCode = await store.createAuthorizationCode({
        brokerAccountId: accountLink.brokerAccountId,
        clientId: client.clientId,
        redirectUri: validatedRedirectUri,
        scopes: trimString(req.body.scope || 'smart_home').split(/\s+/).filter(Boolean),
        locale: accountLink.locale,
        metadata: {
          linkCodePreview: linkResponse.codePreview || ''
        }
      });

      await store.appendAudit({
        type: 'oauth_authorize_success',
        hubId,
        brokerAccountId: accountLink.brokerAccountId,
        message: 'Alexa account linking authorization issued',
        details: {
          clientId: client.clientId,
          redirectUri: validatedRedirectUri
        }
      });

      await syncLinkedAccountsToHub(store, hubId).catch(() => {});

      const target = new URL(validatedRedirectUri);
      target.searchParams.set('code', authorizationCode.code);
      if (state) {
        target.searchParams.set('state', state);
      }
      return res.redirect(target.toString());
    } catch (error) {
      if (safeRedirectUri) {
        return res.redirect(buildAuthorizeErrorRedirect(safeRedirectUri, 'access_denied', error.message, state));
      }

      return res.status(400).type('html').send(renderAuthorizePage({
        oauth: {
          responseType: trimString(req.body.response_type),
          clientId,
          redirectUri,
          scope: trimString(req.body.scope),
          state,
          locale: trimString(req.body.locale),
          hubRef: trimString(req.body.hubRef || req.body.hubId)
        },
        error: error.message
      }));
    }
  });

  app.post('/api/oauth/alexa/token', async (req, res) => {
    try {
      const { clientId, clientSecret } = resolveClientCredentials(req);
      const client = validateClientId(clientId);
      validateClientSecret(client, clientSecret);

      const grantType = trimString(req.body.grant_type);
      if (grantType === 'authorization_code') {
        const codeRecord = await store.consumeAuthorizationCode(req.body.code, {
          clientId: client.clientId,
          redirectUri: validateRedirectUri(client, req.body.redirect_uri)
        });

        const tokens = await store.issueTokens({
          brokerAccountId: codeRecord.brokerAccountId,
          hubId: codeRecord.hubId,
          clientId: client.clientId,
          scopes: codeRecord.scopes,
          locale: codeRecord.locale
        });

        return res.status(200).json({
          token_type: tokens.tokenType,
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_in: tokens.expiresIn,
          scope: tokens.scope
        });
      }

      if (grantType === 'refresh_token') {
        const tokens = await store.rotateRefreshToken(req.body.refresh_token, { clientId: client.clientId });
        return res.status(200).json({
          token_type: tokens.tokenType,
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_in: tokens.expiresIn,
          scope: tokens.scope
        });
      }

      return res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: `Unsupported grant_type ${grantType || '(empty)'}`
      });
    } catch (error) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: error.message
      });
    }
  });

  app.post('/api/oauth/alexa/resolve', async (req, res) => {
    try {
      const token = extractBearerToken(req.headers.authorization) || trimString(req.body?.token);
      if (!token) {
        throw new Error('Access token is required');
      }

      const resolved = await store.resolveAccessToken(token);
      return res.status(200).json({
        success: true,
        brokerAccountId: resolved.brokerAccountId,
        hubId: resolved.hubId,
        clientId: resolved.clientId,
        scopes: resolved.scopes,
        locale: resolved.locale,
        expiresAt: resolved.expiresAt,
        account: resolved.accountLink
      });
    } catch (error) {
      return res.status(401).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/grants/accept', async (req, res) => {
    try {
      const granteeToken = trimString(req.body?.granteeToken) || extractBearerToken(req.headers.authorization);
      const grantCode = trimString(req.body?.grantCode);
      const permissionScopes = Array.isArray(req.body?.permissionScopes)
        ? req.body.permissionScopes
        : ['alexa::async_event:write'];

      if (!granteeToken) {
        throw new Error('granteeToken is required');
      }
      if (!grantCode) {
        throw new Error('grantCode is required');
      }

      const resolved = await store.resolveAccessToken(granteeToken);
      const grant = await eventGatewayService.acceptGrantForLinkedAccount({
        brokerAccountId: resolved.brokerAccountId,
        hubId: resolved.hubId,
        grantCode,
        granteeToken,
        permissionScopes,
        eventRegion: resolveEventRegion(req.body?.eventRegion || req.body?.region || process.env.AWS_REGION || 'NA'),
        metadata: req.body?.metadata || {}
      });

      await syncLinkedAccountsToHub(store, resolved.hubId).catch(() => {});
      if (autoKickDispatcher) {
        eventGatewayService.kick({ hubId: resolved.hubId });
      }

      return res.status(200).json({
        success: true,
        permissionGrantId: grant.permissionGrantId,
        brokerAccountId: resolved.brokerAccountId,
        hubId: resolved.hubId
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get('/api/alexa/metrics', async (req, res) => {
    try {
      const hub = await requireHubAuth(store, req);
      const metrics = await store.getMetricsSnapshot({ hubId: hub.hubId });
      return res.status(200).json({
        success: true,
        hubId: hub.hubId,
        metrics
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get('/api/alexa/audit', async (req, res) => {
    try {
      const hub = await requireHubAuth(store, req);
      const auditLogs = await store.listAuditLog({
        hubId: hub.hubId,
        type: trimString(req.query.type),
        limit: req.query.limit
      });
      return res.status(200).json({
        success: true,
        hubId: hub.hubId,
        count: auditLogs.length,
        auditLogs
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get('/api/alexa/readiness', async (req, res) => {
    try {
      const hub = await requireHubAuth(store, req);
      const readiness = await buildReadinessSnapshot(store, { hubId: hub.hubId });
      return res.status(200).json({
        success: true,
        hubId: hub.hubId,
        readiness
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get('/api/alexa/events', async (req, res) => {
    try {
      const hub = await requireHubAuth(store, req);
      const [events, grants] = await Promise.all([
        store.listQueuedEvents({
          hubId: hub.hubId,
          status: trimString(req.query.status)
        }),
        store.listPermissionGrants({
          hubId: hub.hubId
        })
      ]);

      return res.status(200).json({
        success: true,
        hubId: hub.hubId,
        events,
        permissionGrants: grants,
        count: events.length
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/events/flush', async (req, res) => {
    try {
      const hub = await requireHubAuth(store, req);
      const result = await eventGatewayService.flush({
        limit: req.body?.limit,
        hubId: hub.hubId
      });
      return res.status(200).json(result);
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/households/:brokerAccountId/discovery-sync', async (req, res) => {
    try {
      const hub = await requireHubAuth(store, req);
      const brokerAccountId = trimString(req.params.brokerAccountId);
      const account = await store.getAccountLink(brokerAccountId);
      if (!account || account.hubId !== hub.hubId) {
        return res.status(404).json({
          success: false,
          error: 'Linked household not found'
        });
      }

      const currentHub = await store.getHub(hub.hubId);
      const endpoints = currentHub?.catalog?.endpoints || [];
      const queued = await queueCatalogEventsForBrokerAccount(store, hub.hubId, brokerAccountId, endpoints);
      await store.touchAccountDiscovery(brokerAccountId, {
        lastDiscoverySyncSource: 'homebrain_admin'
      });
      await syncLinkedAccountsToHub(store, hub.hubId).catch(() => {});
      if (autoKickDispatcher) {
        eventGatewayService.kick({ hubId: hub.hubId });
      }

      return res.status(200).json({
        success: true,
        brokerAccountId,
        queued: queued.length
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/households/:brokerAccountId/revoke', async (req, res) => {
    try {
      const hub = await requireHubAuth(store, req);
      const brokerAccountId = trimString(req.params.brokerAccountId);
      const account = await store.getAccountLink(brokerAccountId);
      if (!account || account.hubId !== hub.hubId) {
        return res.status(404).json({
          success: false,
          error: 'Linked household not found'
        });
      }

      const revoked = await store.revokeAccountLink(brokerAccountId, {
        reason: trimString(req.body?.reason || 'Revoked by HomeBrain admin')
      });
      await syncLinkedAccountsToHub(store, hub.hubId).catch(() => {});

      return res.status(200).json({
        success: true,
        account: revoked
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/hubs/register', async (req, res) => {
    try {
      const requestPayload = req.body || {};
      let hubPayload = null;
      const requestedMode = trimString(requestPayload.mode) === 'public' ? 'public' : 'private';

      if (trimString(requestPayload.hubBaseUrl) && trimString(requestPayload.linkCode)) {
        const hubBaseUrl = validateHubBaseUrl(requestPayload.hubBaseUrl, { mode: requestedMode });
        const brokerBaseUrl = buildBrokerBaseUrl(req);
        if (!brokerBaseUrl) {
          throw new Error('Unable to determine broker public base URL');
        }

        const response = await axios.post(`${hubBaseUrl}/api/alexa/broker/register`, {
          linkCode: trimString(requestPayload.linkCode),
          mode: requestedMode,
          brokerBaseUrl,
          brokerClientId: trimString(requestPayload.brokerClientId) || getBrokerClientId(),
          brokerDisplayName: trimString(requestPayload.brokerDisplayName) || getBrokerDisplayName()
        }, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json'
          }
        });

        const registration = response.data || {};
        hubPayload = {
          hubId: registration.hubId,
          hubBaseUrl,
          publicOrigin: trimString(registration.publicOrigin),
          relayToken: trimString(registration.relayToken),
          brokerClientId: trimString(requestPayload.brokerClientId) || getBrokerClientId(),
          mode: trimString(registration.mode) === 'public' ? 'public' : 'private',
          catalogUrl: buildAbsoluteUrl(hubBaseUrl, registration.endpoints?.catalog, '/api/alexa/broker/catalog'),
          stateUrl: buildAbsoluteUrl(hubBaseUrl, registration.endpoints?.state, '/api/alexa/broker/state'),
          executeUrl: buildAbsoluteUrl(hubBaseUrl, registration.endpoints?.execute, '/api/alexa/broker/execute'),
          customSkillUrl: buildAbsoluteUrl(hubBaseUrl, registration.endpoints?.customSkill, '/api/alexa/broker/custom-skill'),
          healthUrl: buildAbsoluteUrl(hubBaseUrl, registration.endpoints?.health, '/api/alexa/broker/health'),
          accountsUrl: buildAbsoluteUrl(hubBaseUrl, registration.endpoints?.accounts, '/api/alexa/broker/accounts'),
          linkAccountUrl: buildAbsoluteUrl(hubBaseUrl, registration.endpoints?.linkAccount, '/api/alexa/broker/link-account')
        };
      } else {
        if (trimString(process.env.HOMEBRAIN_ALEXA_ALLOW_MANUAL_REGISTRATION) !== 'true') {
          throw new Error('Manual hub registration is disabled');
        }
        hubPayload = {
          hubId: trimString(requestPayload.hubId),
          hubBaseUrl: validateHubBaseUrl(requestPayload.hubBaseUrl, { mode: requestedMode }),
          publicOrigin: trimString(requestPayload.publicOrigin),
          relayToken: trimString(requestPayload.relayToken),
          brokerClientId: trimString(requestPayload.brokerClientId) || getBrokerClientId(),
          mode: requestedMode,
          catalogUrl: trimString(requestPayload.catalogUrl),
          stateUrl: trimString(requestPayload.stateUrl),
          executeUrl: trimString(requestPayload.executeUrl),
          customSkillUrl: trimString(requestPayload.customSkillUrl),
          healthUrl: trimString(requestPayload.healthUrl),
          accountsUrl: trimString(requestPayload.accountsUrl),
          linkAccountUrl: trimString(requestPayload.linkAccountUrl)
        };
      }

      const hub = await store.registerHub(hubPayload);
      await store.appendAudit({
        type: 'hub_registered',
        hubId: hub.hubId,
        message: 'Broker registered HomeBrain hub',
        details: {
          mode: hub.registration?.mode,
          publicOrigin: hub.registration?.publicOrigin
        }
      });

      return res.status(200).json({
        success: true,
        hub
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.response?.data?.error || error.message
      });
    }
  });

  app.post('/api/alexa/hubs/catalog', async (req, res) => {
    try {
      const hub = await requireHubAuth(store, req);
      const previousHub = await store.getHub(hub.hubId);
      const previousEndpointIds = new Set((previousHub?.catalog?.endpoints || [])
        .map((entry) => trimString(entry?.endpointId))
        .filter(Boolean));

      const catalog = await store.upsertCatalog({
        hubId: hub.hubId,
        endpoints: req.body?.endpoints,
        reason: trimString(req.body?.reason) || 'hub_push'
      });

      const nextEndpointIds = new Set((catalog.endpoints || [])
        .map((entry) => trimString(entry?.endpointId))
        .filter(Boolean));
      const removedEndpointIds = Array.from(previousEndpointIds)
        .filter((endpointId) => !nextEndpointIds.has(endpointId));

      await queueCatalogEvents(store, hub.hubId, catalog.endpoints);
      await queueDeleteEvents(store, hub.hubId, removedEndpointIds);
      if (autoKickDispatcher) {
        eventGatewayService.kick({ hubId: hub.hubId });
      }

      return res.status(200).json({
        success: true,
        catalog
      });
    } catch (error) {
      return res.status(error.status || 400).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/hubs/state', async (req, res) => {
    try {
      const hub = await requireHubAuth(store, req);
      const state = await store.upsertState({
        hubId: hub.hubId,
        states: req.body?.states,
        reason: trimString(req.body?.reason) || 'hub_push'
      });

      await queueStateEvents(store, hub.hubId, state.states);
      if (autoKickDispatcher) {
        eventGatewayService.kick({ hubId: hub.hubId });
      }

      return res.status(200).json({
        success: true,
        state
      });
    } catch (error) {
      return res.status(error.status || 400).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/hubs/accounts', async (req, res) => {
    try {
      const hub = await requireHubAuth(store, req);
      const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
      const persisted = [];

      for (const account of accounts) {
        persisted.push(await store.createAccountLink({
          brokerAccountId: account?.brokerAccountId,
          hubId: hub.hubId,
          alexaUserId: account?.alexaUserId,
          alexaAccountId: account?.alexaAccountId,
          alexaHouseholdId: account?.alexaHouseholdId,
          locale: account?.locale,
          status: account?.status,
          permissions: account?.permissions,
          acceptedGrantAt: account?.acceptedGrantAt,
          lastDiscoveryAt: account?.lastDiscoveryAt,
          lastSeenAt: account?.lastSeenAt,
          metadata: account?.metadata
        }));
      }

      return res.status(200).json({
        success: true,
        accounts: persisted
      });
    } catch (error) {
      return res.status(error.status || 400).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get('/api/alexa/hubs/:hubId/catalog', async (req, res) => {
    try {
      await requireAlexaAuth(store, req, { expectedHubId: req.params.hubId });
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      if (refresh) {
        const response = await proxyToHub(store, req.params.hubId, 'catalog', 'get');
        await store.upsertCatalog({
          hubId: req.params.hubId,
          endpoints: response.endpoints,
          reason: 'hub_refresh'
        });
      }

      const hub = await store.getHub(req.params.hubId);
      return res.status(200).json({
        success: true,
        hubId: req.params.hubId,
        endpoints: hub?.catalog?.endpoints || [],
        updatedAt: hub?.catalog?.updatedAt || null
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get('/api/alexa/hubs/:hubId/events', async (req, res) => {
    try {
      await requireHubAuth(store, req);
      const events = await store.listQueuedEvents({ hubId: req.params.hubId });
      return res.status(200).json({
        success: true,
        events,
        count: events.length
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/directives/state', async (req, res) => {
    try {
      const hubId = trimString(req.body?.hubId);
      const endpointIds = Array.isArray(req.body?.endpointIds) ? req.body.endpointIds : [];
      if (!hubId) {
        throw new Error('hubId is required');
      }
      await requireAlexaAuth(store, req, { expectedHubId: hubId });

      const response = await proxyToHub(store, hubId, 'state', 'post', { endpointIds });
      await store.upsertState({
        hubId,
        states: response.states,
        reason: 'hub_refresh'
      });

      return res.status(200).json(response);
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.post('/api/alexa/directives/execute', async (req, res) => {
    try {
      const hubId = trimString(req.body?.hubId);
      if (!hubId) {
        throw new Error('hubId is required');
      }
      await requireAlexaAuth(store, req, { expectedHubId: hubId });

      const response = await proxyToHub(store, hubId, 'execute', 'post', req.body?.directive || req.body);
      return res.status(200).json(response);
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  const handleCustomSkillDispatch = async (req, res) => {
    let resolved = null;
    try {
      const token = extractBearerToken(req.headers.authorization);
      resolved = await requireAlexaAuth(store, req, {
        expectedHubId: trimString(req.body?.hubId)
      });

      const envelope = req.body?.envelope && typeof req.body.envelope === 'object'
        ? req.body.envelope
        : req.body;
      const identity = extractCustomSkillIdentity(envelope);
      const response = await proxyToHub(store, resolved.hubId, 'customSkill', 'post', {
        ...(req.body || {}),
        brokerAccountId: resolved.brokerAccountId,
        linkedAccount: resolved.accountLink,
        envelope,
        metadata: {
          ...(req.body?.metadata || {}),
          source: 'broker_custom_skill_dispatch'
        }
      });

      await store.appendAudit({
        type: 'custom_skill_dispatch',
        severity: 'info',
        hubId: resolved.hubId,
        brokerAccountId: resolved.brokerAccountId,
        message: 'Broker dispatched Alexa custom skill request to HomeBrain',
        details: {
          authorization: token ? 'bearer' : 'missing',
          requestType: identity.requestType,
          intentName: identity.intentName,
          requestId: identity.requestId
        }
      });

      return res.status(200).json(response);
    } catch (error) {
      if (resolved?.hubId) {
        await store.appendAudit({
          type: 'custom_skill_dispatch_failed',
          severity: 'error',
          hubId: resolved.hubId,
          brokerAccountId: resolved.brokerAccountId,
          message: error.message,
          details: {
            status: error.status || error.response?.status || 500
          }
        }).catch(() => {});
      }

      return res.status(error.status || error.response?.status || 500).json({
        success: false,
        error: error.response?.data?.error || error.message
      });
    }
  };

  app.post('/api/alexa/custom/dispatch', handleCustomSkillDispatch);
  app.post('/api/alexa/custom-skill/dispatch', handleCustomSkillDispatch);

  app.get('/api/alexa/hubs/:hubId', async (req, res) => {
    await requireHubAuth(store, req);
    const hub = await store.getHub(req.params.hubId);
    if (!hub) {
      return res.status(404).json({
        success: false,
        error: 'Hub not found'
      });
    }

    return res.status(200).json({
      success: true,
      hub
    });
  });

  return app;
}

module.exports = {
  createApp,
  buildAbsoluteUrl,
  buildBrokerBaseUrl,
  extractBearerToken,
  renderAuthorizePage
};

if (require.main === module) {
  const app = createApp({ startDispatcher: true });
  const port = Number(process.env.PORT || 4301);
  const bindHost = trimString(process.env.HOMEBRAIN_BROKER_BIND_HOST) || '0.0.0.0';
  app.listen(port, bindHost, () => {
    console.log(`HomeBrain Alexa broker listening on ${bindHost}:${port}`);
  });
}

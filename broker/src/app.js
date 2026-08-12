const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const brokerStore = require('./store');
const { sha256 } = brokerStore;
const {
  buildAddOrUpdateReport,
  buildChangeReport,
  buildDeleteReport
} = require('../../shared/alexa/messages');
const { extractCustomSkillIdentity } = require('../../shared/alexa/customSkill');
const { AlexaEventGatewayService, resolveEventRegion } = require('./eventGatewayService');
const { AlexaDeviceService } = require('./alexaDeviceService');
const { createOutboundAgents } = require('./outboundNetworkSafety');
const AUTHORIZE_SUBMISSION_HMAC_KEY = crypto.randomBytes(32);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createOAuthTokenError(oauthError, message, status = 400) {
  const error = new Error(message);
  error.name = 'OAuthTokenError';
  error.oauthError = oauthError;
  error.oauthStatus = status;
  return error;
}

function classifyOAuthTokenError(error) {
  if (trimString(error?.oauthError)) {
    return {
      oauthError: trimString(error.oauthError),
      description: trimString(error.message) || 'Token exchange failed',
      status: Math.max(400, Number(error.oauthStatus || 400))
    };
  }

  return {
    oauthError: 'server_error',
    description: 'Token exchange is temporarily unavailable',
    status: 500
  };
}

function setOAuthTokenResponseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function getTokenFingerprint(value) {
  const token = trimString(value);
  return token ? sha256(token).slice(0, 12) : '';
}

function getAuthorizationSubmissionKey(values) {
  // codeql[js/insufficient-password-hash] This process-random HMAC is an authorization-submission deduplication key, not a password hash or stored credential.
  return crypto.createHmac('sha256', AUTHORIZE_SUBMISSION_HMAC_KEY)
    .update((Array.isArray(values) ? values : [values]).map((value) => trimString(value)).join('\0'), 'utf8')
    .digest('hex');
}

function appendOAuthRefreshFailureAudit(store, payload = {}) {
  Promise.resolve().then(async () => {
    if (typeof store.appendAudit !== 'function') {
      return;
    }

    let hubId = trimString(payload.hubId);
    if (!hubId && typeof store.listHubs === 'function') {
      const registeredHubs = (await store.listHubs()).filter((hub) => hub?.registration);
      if (registeredHubs.length === 1) {
        hubId = registeredHubs[0].hubId;
      }
    }

    await store.appendAudit({
      type: 'oauth_token_refresh_failed',
      hubId,
      brokerAccountId: trimString(payload.brokerAccountId),
      severity: payload.oauthError === 'server_error' ? 'error' : 'warning',
      message: `Alexa access-token refresh failed with ${payload.oauthError}`,
      details: {
        clientId: trimString(payload.clientId),
        requestId: trimString(payload.requestId),
        refreshTokenFingerprint: trimString(payload.refreshTokenFingerprint),
        oauthError: trimString(payload.oauthError),
        reason: trimString(payload.reason),
        transient: payload.oauthError === 'server_error',
        latencyMs: Math.max(0, Number(payload.latencyMs || 0))
      }
    });
  }).catch((auditError) => {
    console.warn(`[broker] Unable to persist Alexa refresh failure audit: ${auditError.message}`);
  });
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
  const actualSecret = trimString(clientSecret);
  if (!expectedSecret) {
    throw new Error('client_secret is not configured');
  }
  const expectedBuffer = Buffer.from(expectedSecret, 'utf8');
  const actualBuffer = Buffer.from(actualSecret, 'utf8');
  if (expectedSecret && (
    expectedBuffer.length !== actualBuffer.length
    || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  )) {
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
  if (allowedRedirectUris.length === 0 && client?.allowAnyRedirectUri !== true) {
    throw new Error('OAuth client does not have any allowed redirect URIs configured');
  }

  return normalizedRedirectUri;
}

function validatePkceParameters(codeChallenge, codeChallengeMethod) {
  const challenge = trimString(codeChallenge);
  const method = trimString(codeChallengeMethod);
  if (!challenge && !method) {
    return {
      codeChallenge: '',
      codeChallengeMethod: ''
    };
  }
  if (!challenge) {
    throw new Error('code_challenge is required when code_challenge_method is provided');
  }
  if (method !== 'S256') {
    throw new Error('code_challenge_method must be S256');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    throw new Error('code_challenge must be a valid S256 PKCE challenge');
  }
  return {
    codeChallenge: challenge,
    codeChallengeMethod: method
  };
}

function sanitizeBaseUrl(value) {
  const normalized = trimString(value);
  if (!normalized) {
    return '';
  }
  if (normalized.length > 2048) {
    throw new Error('Base URL is too long');
  }
  const parsed = new URL(normalized);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Base URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Base URL must not include credentials');
  }
  return parsed.origin;
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
  const resolved = new URL(candidate, `${normalizedBaseUrl}/`);
  if (resolved.origin !== normalizedBaseUrl || resolved.username || resolved.password) {
    throw new Error('Resolved URL must remain on the configured origin');
  }
  resolved.hash = '';
  return resolved.toString();
}

function extractBearerToken(value) {
  const header = trimString(value);
  if (header.length < 8 || header.slice(0, 7).toLowerCase() !== 'bearer ') {
    return '';
  }
  return header.slice(7).trim();
}

function findUnsafeRequestKey(value, depth = 0, budget = { remaining: 20_000 }) {
  if (!value || typeof value !== 'object' || depth > 20) return '';
  if (budget.remaining <= 0) return '[request too complex]';
  budget.remaining -= 1;
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || key.startsWith('$')) {
      return key;
    }
    const nested = findUnsafeRequestKey(value[key], depth + 1, budget);
    if (nested) return nested;
  }
  return '';
}

function rejectUnsafeRequestKeys(req, res, next) {
  const unsafeKey = findUnsafeRequestKey(req.body) || findUnsafeRequestKey(req.query);
  if (unsafeKey) {
    return res.status(400).json({ success: false, error: 'Request contains an unsupported field name' });
  }
  return next();
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

function getDefaultHubReference(resolvedHub = null, explicitRef = '') {
  const requestedRef = trimString(explicitRef);
  if (requestedRef) {
    return requestedRef;
  }

  const publicOrigin = trimString(resolvedHub?.registration?.publicOrigin);
  if (publicOrigin) {
    return publicOrigin;
  }

  return trimString(resolvedHub?.hubId);
}

function safeOrigin(value) {
  try {
    return sanitizeBaseUrl(value);
  } catch (_error) {
    return '';
  }
}

function closeServerAndExit(server, exitCode = 0, options = {}) {
  const requestedTimeoutMs = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.max(250, Math.min(60_000, Math.round(requestedTimeoutMs)))
    : 5000;
  const exitProcess = typeof options.exitProcess === 'function'
    ? options.exitProcess
    : process.exit.bind(process);
  let exited = false;

  const finish = () => {
    if (exited) {
      return;
    }
    exited = true;
    exitProcess(exitCode);
  };

  process.exitCode = exitCode;

  try {
    server.close(finish);
  } catch (_error) {
    finish();
    return;
  }

  const timer = setTimeout(finish, timeoutMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

function buildBrokerBaseUrl(req) {
  const configured = sanitizeBaseUrl(process.env.HOMEBRAIN_BROKER_PUBLIC_BASE_URL);
  if (configured) {
    return configured;
  }

  const protocol = trimString(req.protocol).toLowerCase();
  const host = trimString(req.get?.('host') || req.headers.host);
  if (!host || !['http', 'https'].includes(protocol)) {
    return '';
  }

  try {
    return sanitizeBaseUrl(`${protocol}://${host}`);
  } catch (_error) {
    return '';
  }
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

  if (parsed.username || parsed.password) {
    throw new Error('hubBaseUrl must not include credentials');
  }

  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('hubBaseUrl must be an origin without a path, query, or fragment');
  }

  return parsed.origin;
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
  return `hbr_${crypto.randomBytes(12).toString('hex')}`;
}

function clampNumber(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

function getRateLimitConfig() {
  return {
    windowMs: clampNumber(process.env.HOMEBRAIN_ALEXA_RATE_LIMIT_WINDOW_MS, 60 * 1000, 1000, 60 * 60 * 1000),
    maxRequests: clampNumber(process.env.HOMEBRAIN_ALEXA_RATE_LIMIT_MAX, 120, 1, 100_000)
  };
}

function createOAuthTokenRateLimitMiddleware() {
  return rateLimit({
    windowMs: clampNumber(process.env.HOMEBRAIN_ALEXA_TOKEN_RATE_LIMIT_WINDOW_MS, 60 * 1000, 1000, 60 * 60 * 1000),
    limit: clampNumber(process.env.HOMEBRAIN_ALEXA_TOKEN_RATE_LIMIT_MAX, 60, 1, 10_000),
    standardHeaders: true,
    legacyHeaders: false,
    handler(_req, res) {
      setOAuthTokenResponseHeaders(res);
      return res.status(429).json({
        error: 'temporarily_unavailable',
        error_description: 'Too many token requests; retry shortly'
      });
    }
  });
}

function createRateLimitMiddleware() {
  const { windowMs, maxRequests } = getRateLimitConfig();
  const { ipKeyGenerator } = rateLimit;

  return rateLimit({
    windowMs,
    limit: maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    skip(req) {
      // Alexa's token endpoint has its own authenticated protocol contract. A
      // generic HTML/JSON 429 here can be interpreted as a broken account link.
      return req.path === '/api/oauth/alexa/token';
    },
    keyGenerator(req) {
      return typeof ipKeyGenerator === 'function'
        ? ipKeyGenerator(req.ip)
        : (trimString(req.socket?.remoteAddress) || 'unknown');
    },
    message: {
      success: false,
      error: 'Rate limit exceeded'
    }
  });
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
  const defaultHubReference = getDefaultHubReference(resolvedHub, oauth.hubRef);
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
        <input type="hidden" name="code_challenge" value="${htmlEscape(oauth.codeChallenge)}" />
        <input type="hidden" name="code_challenge_method" value="${htmlEscape(oauth.codeChallengeMethod)}" />
        <label for="hubRef">HomeBrain Hub ID or Public Origin</label>
        <input id="hubRef" name="hubRef" value="${htmlEscape(defaultHubReference)}" placeholder="hub-123 or https://home.example.com" />
        <label for="linkCode">Alexa Pairing Code</label>
        <input id="linkCode" name="linkCode" autocomplete="one-time-code" placeholder="HBAX-XXXX-XXXX-XXXX" required />
        <label for="locale">Locale</label>
        <input id="locale" name="locale" value="${htmlEscape(oauth.locale || 'en-US')}" placeholder="en-US" />
        ${resolvedHub ? `<p class="hint">Resolved hub: ${htmlEscape(resolvedHub.hubId)}${resolvedHub.registration?.publicOrigin ? ` (${htmlEscape(resolvedHub.registration.publicOrigin)})` : ''}</p>` : ''}
        <button id="linkAccountButton" type="submit">Link Account</button>
      </form>
    </main>
    <script>
      const form = document.querySelector('form');
      const button = document.getElementById('linkAccountButton');
      form.addEventListener('submit', (event) => {
        if (form.dataset.submitted === 'true') {
          event.preventDefault();
          return;
        }
        form.dataset.submitted = 'true';
        button.disabled = true;
        button.textContent = 'Linking…';
      });
    </script>
  </body>
</html>`;
}

function getAuthorizeRedirectOrigin(redirectUri = '') {
  try {
    const parsed = new URL(trimString(redirectUri));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null') {
      return '';
    }
    return parsed.origin;
  } catch (_error) {
    return '';
  }
}

function setAuthorizePageHeaders(res, options = {}) {
  const redirectOrigin = getAuthorizeRedirectOrigin(options.redirectUri);
  const formActionSources = ["'self'", ...(redirectOrigin ? [redirectOrigin] : [])];
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action ${formActionSources.join(' ')}; base-uri 'none'`
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sanitizePermissionGrant(record = {}) {
  const {
    accessToken,
    refreshToken,
    granteeTokenHash,
    grantCodeHash,
    ...safeRecord
  } = record || {};
  return {
    ...safeRecord,
    hasAccessToken: Boolean(trimString(accessToken)),
    hasRefreshToken: Boolean(trimString(refreshToken)),
    grantCodeFingerprint: trimString(grantCodeHash).slice(0, 12),
    granteeTokenFingerprint: trimString(granteeTokenHash).slice(0, 12)
  };
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

async function reconcileLinkedAccountsToHubs(store, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 4));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs || 5000));
  let pendingHubIds = null;
  let lastErrors = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const hubs = (await store.listHubs())
        .filter((hub) => hub?.registration?.accountsUrl)
        .filter((hub) => !pendingHubIds || pendingHubIds.has(hub.hubId));

      if (hubs.length === 0) {
        return {
          success: true,
          attempts: attempt,
          syncedHubs: 0,
          failedHubs: []
        };
      }

      const results = await Promise.all(hubs.map(async (hub) => {
        try {
          const result = await syncLinkedAccountsToHub(store, hub.hubId);
          return { hubId: hub.hubId, success: true, count: Number(result?.count || 0) };
        } catch (error) {
          return { hubId: hub.hubId, success: false, error: error.message };
        }
      }));
      const failures = results.filter((entry) => !entry.success);
      if (failures.length === 0) {
        return {
          success: true,
          attempts: attempt,
          syncedHubs: results.length,
          syncedAccounts: results.reduce((total, entry) => total + entry.count, 0),
          failedHubs: []
        };
      }

      lastErrors = failures;
      pendingHubIds = new Set(failures.map((entry) => entry.hubId));
    } catch (error) {
      lastErrors = [{ hubId: '', success: false, error: error.message }];
    }

    if (attempt < maxAttempts && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  return {
    success: false,
    attempts: maxAttempts,
    syncedHubs: 0,
    failedHubs: lastErrors
  };
}

async function queueEventsForActivePermissionGrants(store, hubId, buildPayloadsForGrant) {
  const grants = await store.listActivePermissionGrants({ hubId });
  if (!Array.isArray(grants) || grants.length === 0) {
    return [];
  }

  const events = [];
  for (const grant of grants) {
    const payloads = await Promise.resolve(buildPayloadsForGrant(grant));
    const list = Array.isArray(payloads) ? payloads : [payloads];
    for (const payload of list) {
      if (!payload) {
        continue;
      }
      events.push({
        ...payload,
        hubId,
        brokerAccountId: grant.brokerAccountId,
        permissionGrantId: grant.permissionGrantId
      });
    }
  }

  if (events.length === 0) {
    return [];
  }

  if (typeof store.enqueueEvents === 'function') {
    return store.enqueueEvents(events);
  }

  return Promise.all(events.map((event) => store.enqueueEvent(event)));
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
  const storageHealth = typeof store.getStorageHealth === 'function'
    ? await store.getStorageHealth().catch((error) => ({
      primary: { valid: false, error: error.message },
      backup: { valid: false, error: error.message }
    }))
    : null;
  const redirectConfigurationUsable = clientRegistry.every((entry) => entry.redirectUris.length > 0 || entry.allowAnyRedirectUri === true);
  const redirectsExplicitlyRestricted = clientRegistry.every((entry) => entry.redirectUris.length > 0 && entry.allowAnyRedirectUri !== true);
  const oauthClientSecretsConfigured = clientRegistry.length > 0 && clientRegistry.every((entry) => Boolean(trimString(entry.clientSecret)));
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
    status: oauthClientSecretsConfigured ? 'ok' : 'blocked',
    message: oauthClientSecretsConfigured
      ? `${clientRegistry.length} Alexa OAuth client configuration(s) loaded with confidential client credentials.`
      : 'Configure at least one Alexa OAuth client with a non-empty client secret.'
  });

  checks.push({
    id: 'redirect_uri_allowlist',
    label: 'Redirect URI allowlist',
    status: !redirectConfigurationUsable ? 'blocked' : redirectsExplicitlyRestricted ? 'ok' : 'warning',
    message: !redirectConfigurationUsable
      ? 'One or more OAuth clients have no usable redirect URI configuration.'
      : redirectsExplicitlyRestricted
      ? 'OAuth clients are using explicit redirect URI allowlists.'
      : 'One or more OAuth clients allow arbitrary redirect URIs. Configure an explicit redirect URI allowlist before public release.'
  });

  checks.push({
    id: 'pkce_s256',
    label: 'OAuth PKCE S256',
    status: 'ok',
    message: 'The authorization and token endpoints support Alexa PKCE S256 verification.'
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
    id: 'oauth_account_tokens',
    label: 'Linked-account token integrity',
    status: metrics.linkedAccounts.missingRefreshToken === 0 ? 'ok' : 'warning',
    message: metrics.linkedAccounts.missingRefreshToken === 0
      ? `${metrics.linkedAccounts.tokenBacked} linked account(s) have durable refresh tokens.`
      : `${metrics.linkedAccounts.missingRefreshToken} legacy account record(s) have no durable refresh token and are quarantined as stale.`
  });

  checks.push({
    id: 'proactive_event_grants',
    label: 'Proactive-event grants',
    status: metrics.linkedAccounts.tokenBacked === 0 || metrics.permissionGrants.active > 0
      ? 'ok'
      : 'blocked',
    message: metrics.linkedAccounts.tokenBacked === 0 || metrics.permissionGrants.active > 0
      ? `${metrics.permissionGrants.active} active Alexa event-gateway grant(s) are available.`
      : 'A token-backed Alexa account exists, but no active event-gateway grant is available.'
  });

  checks.push({
    id: 'event_queue_health',
    label: 'Broker event queue health',
    status: metrics.queue.unresolvedFailed === 0 && metrics.queue.staleProcessing === 0 && metrics.queue.oldestQueuedAgeMs < 15 * 60 * 1000
      ? 'ok'
      : metrics.queue.unresolvedFailed > 0
        ? 'warning'
        : 'warning',
    message: metrics.queue.unresolvedFailed === 0 && metrics.queue.staleProcessing === 0 && metrics.queue.oldestQueuedAgeMs < 15 * 60 * 1000
      ? `Alexa event queue is healthy${metrics.queue.failed > 0 ? `; ${metrics.queue.failed} older failed event(s) remain retained for diagnostics` : ''}.`
      : `Broker queue has ${metrics.queue.unresolvedFailed} unresolved failed event(s), ${metrics.queue.staleProcessing} stale processing event(s), and an oldest queued age of ${metrics.queue.oldestQueuedAgeMs}ms.`
  });

  if (storageHealth) {
    checks.push({
      id: 'durable_store',
      label: 'Durable broker credential store',
      status: storageHealth.primary?.valid && storageHealth.backup?.valid
        ? 'ok'
        : storageHealth.primary?.valid
          ? 'warning'
          : 'blocked',
      message: storageHealth.primary?.valid && storageHealth.backup?.valid
        ? 'The primary and backup Alexa credential stores are readable.'
        : storageHealth.primary?.valid
          ? `The primary credential store is readable, but the backup is not healthy (${storageHealth.backup?.error || 'unknown error'}).`
          : `The primary Alexa credential store is not healthy (${storageHealth.primary?.error || 'unknown error'}).`
    });
  }

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
  // nosemgrep: javascript.express.security.audit.express-check-csurf-middleware-usage.express-check-csurf-middleware-usage -- the broker has no cookie-authenticated mutations; routes use bearer/relay credentials or one-time pairing codes.
  const app = express();
  const store = options.store || brokerStore;
  const autoKickDispatcher = options.autoKickDispatcher !== false;
  const eventGatewayService = options.eventGatewayService || new AlexaEventGatewayService({
    store,
    autoStart: false
  });
  const alexaDeviceService = options.alexaDeviceService || new AlexaDeviceService({
    store,
    eventGatewayService
  });
  const authorizeSubmissions = new Map();
  const allowPrivateHubUrls = options.allowPrivateHubUrls === undefined
    ? trimString(process.env.HOMEBRAIN_ALEXA_ALLOW_PRIVATE_HUB_URLS).toLowerCase() === 'true'
    : options.allowPrivateHubUrls === true;

  if (options.startDispatcher !== false) {
    eventGatewayService.start();
  }

  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(rejectUnsafeRequestKeys);
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
      failedEvents: metrics.queue.unresolvedFailed,
      retainedFailedEvents: metrics.queue.failed,
      oldestQueuedAgeMs: metrics.queue.oldestQueuedAgeMs,
      generatedAt: metrics.generatedAt
    });
  });

  app.get('/api/oauth/alexa/authorize', async (req, res) => {
    const clientId = trimString(req.query.client_id);
    const redirectUri = trimString(req.query.redirect_uri);
    const state = trimString(req.query.state);
    let safeRedirectUri = '';
    setAuthorizePageHeaders(res);

    try {
      const client = validateClientId(clientId);
      if (trimString(req.query.response_type) !== 'code') {
        throw new Error('response_type must be code');
      }
      const validatedRedirectUri = validateRedirectUri(client, redirectUri);
      const pkce = validatePkceParameters(req.query.code_challenge, req.query.code_challenge_method);
      safeRedirectUri = validatedRedirectUri;
      // Chromium and WebKit can apply form-action to redirects after a form
      // submission. Allow only the origin that already passed the OAuth
      // client's exact redirect-URI allowlist so Alexa can receive the code.
      setAuthorizePageHeaders(res, { redirectUri: validatedRedirectUri });

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
          ...pkce,
          locale: trimString(req.query.locale) || 'en-US',
          hubRef: getDefaultHubReference(resolvedHub, requestedHubRef)
        }
      }));
    } catch (error) {
      console.warn(`[broker] Alexa authorize request rejected: ${error.message}`);
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
          codeChallenge: trimString(req.query.code_challenge),
          codeChallengeMethod: trimString(req.query.code_challenge_method),
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
    setAuthorizePageHeaders(res);

    try {
      const client = validateClientId(clientId);
      if (trimString(req.body.response_type) !== 'code') {
        throw new Error('response_type must be code');
      }
      const validatedRedirectUri = validateRedirectUri(client, redirectUri);
      const pkce = validatePkceParameters(req.body.code_challenge, req.body.code_challenge_method);
      safeRedirectUri = validatedRedirectUri;
      setAuthorizePageHeaders(res, { redirectUri: validatedRedirectUri });

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

      const submissionKey = getAuthorizationSubmissionKey([
        client.clientId,
        validatedRedirectUri,
        state,
        hubId,
        linkCode,
        pkce.codeChallenge
      ]);
      let submission = authorizeSubmissions.get(submissionKey);
      if (!submission) {
        const promise = (async () => {
          const linkResponse = await proxyToHub(store, hubId, 'linkAccount', 'post', {
            linkCode,
            brokerClientId: clientId,
            actor: 'alexa_oauth'
          });
          const grant = await store.createAuthorizationGrant({
            brokerAccountId: linkResponse.brokerAccountId,
            hubId,
            locale: trimString(req.body.locale) || 'en-US',
            clientId: client.clientId,
            redirectUri: validatedRedirectUri,
            scopes: trimString(req.body.scope || 'smart_home').split(/\s+/).filter(Boolean),
            codeChallenge: pkce.codeChallenge,
            codeChallengeMethod: pkce.codeChallengeMethod,
            accountMetadata: {
              linkCodePreview: linkResponse.codePreview || '',
              linkedVia: 'link_code',
              clientId
            },
            codeMetadata: {
              linkCodePreview: linkResponse.codePreview || ''
            }
          });
          const target = new URL(validatedRedirectUri);
          target.searchParams.set('code', grant.authorizationCode.code);
          if (state) {
            target.searchParams.set('state', state);
          }
          return target.toString();
        })();
        submission = { promise };
        authorizeSubmissions.set(submissionKey, submission);
        promise.catch(() => {
          authorizeSubmissions.delete(submissionKey);
        });
        const timer = setTimeout(() => {
          authorizeSubmissions.delete(submissionKey);
        }, 5 * 60 * 1000);
        timer.unref?.();
      }

      return res.redirect(await submission.promise);
    } catch (error) {
      console.warn(`[broker] Alexa authorize form submit failed: ${error.message}`);
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
          codeChallenge: trimString(req.body.code_challenge),
          codeChallengeMethod: trimString(req.body.code_challenge_method),
          locale: trimString(req.body.locale),
          hubRef: trimString(req.body.hubRef || req.body.hubId)
        },
        error: error.message
      }));
    }
  });

  app.post('/api/oauth/alexa/token', createOAuthTokenRateLimitMiddleware(), async (req, res) => {
    const startedAt = Date.now();
    const grantType = trimString(req.body.grant_type);
    const refreshTokenFingerprint = grantType === 'refresh_token'
      ? getTokenFingerprint(req.body.refresh_token)
      : '';
    let resolvedClientId = '';
    let clientAuthenticated = false;
    setOAuthTokenResponseHeaders(res);

    try {
      const { clientId, clientSecret } = resolveClientCredentials(req);
      resolvedClientId = trimString(clientId);
      let client;
      try {
        client = validateClientId(clientId);
        validateClientSecret(client, clientSecret);
        clientAuthenticated = true;
      } catch (error) {
        throw createOAuthTokenError('invalid_client', error.message, 401);
      }

      if (grantType === 'authorization_code') {
        let redirectUri;
        try {
          redirectUri = validateRedirectUri(client, req.body.redirect_uri);
        } catch (error) {
          throw createOAuthTokenError('invalid_grant', error.message);
        }

        const tokens = await store.exchangeAuthorizationCode(req.body.code, {
          clientId: client.clientId,
          redirectUri,
          codeVerifier: req.body.code_verifier,
          requestId: req.requestId
        });
        void syncLinkedAccountsToHub(store, tokens.hubId).catch((syncError) => {
          console.warn(`[broker] Unable to sync linked Alexa account after token exchange: ${syncError.message}`);
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
        const tokens = await store.refreshAccessToken(req.body.refresh_token, {
          clientId: client.clientId,
          requestId: req.requestId
        });
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
      const failure = classifyOAuthTokenError(error);
      console.warn('[broker] Alexa token exchange failed; classified details were recorded in the broker audit trail.');

      if (grantType === 'refresh_token' && clientAuthenticated) {
        appendOAuthRefreshFailureAudit(store, {
          hubId: error.hubId,
          brokerAccountId: error.brokerAccountId,
          clientId: resolvedClientId,
          requestId: req.requestId,
          refreshTokenFingerprint,
          oauthError: failure.oauthError,
          reason: failure.description,
          latencyMs: Date.now() - startedAt
        });
      }

      if (failure.oauthError === 'invalid_client') {
        res.setHeader('WWW-Authenticate', 'Basic realm="HomeBrain Alexa Broker"');
      }

      return res.status(failure.status).json({
        error: failure.oauthError,
        error_description: failure.description
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
        permissionGrants: grants.map((entry) => sanitizePermissionGrant(entry)),
        count: events.length
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get('/api/alexa/devices', async (req, res) => {
    try {
      const hub = await requireHubAuth(store, req);
      const result = await alexaDeviceService.listDevices({
        hubId: hub.hubId,
        brokerAccountId: trimString(req.query.brokerAccountId)
      });

      return res.status(200).json({
        success: true,
        hubId: hub.hubId,
        ...result
      });
    } catch (error) {
      return res.status(error.status || error.response?.status || 500).json({
        success: false,
        error: error.response?.data?.error || error.response?.data?.message || error.message
      });
    }
  });

  app.post('/api/alexa/devices/:alexaDeviceId/speak', async (req, res) => {
    let hub = null;
    try {
      hub = await requireHubAuth(store, req);
      const result = await alexaDeviceService.speak({
        hubId: hub.hubId,
        brokerAccountId: req.body?.brokerAccountId,
        deviceId: req.params.alexaDeviceId,
        deviceName: req.body?.deviceName,
        message: req.body?.message,
        locale: req.body?.locale,
        type: req.body?.type
      });

      await store.appendAudit({
        type: 'alexa_device_speak',
        severity: 'info',
        hubId: hub.hubId,
        brokerAccountId: result.brokerAccountId,
        message: `Sent Alexa announcement to ${result.deviceName || result.deviceId}`,
        details: {
          deviceId: result.deviceId,
          status: result.status
        }
      });

      return res.status(200).json(result);
    } catch (error) {
      if (hub?.hubId) {
        await store.appendAudit({
          type: 'alexa_device_speak_failed',
          severity: 'error',
          hubId: hub.hubId,
          brokerAccountId: trimString(req.body?.brokerAccountId),
          message: error.response?.data?.error || error.response?.data?.message || error.message,
          details: {
            deviceId: req.params.alexaDeviceId,
            status: error.response?.status || error.status || 500
          }
        }).catch(() => {});
      }

      return res.status(error.status || error.response?.status || 500).json({
        success: false,
        error: error.response?.data?.error || error.response?.data?.message || error.message
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
        const hubAgents = createOutboundAgents(hubBaseUrl, {
          allowPrivate: allowPrivateHubUrls,
          lookup: options.hubDnsLookup
        });
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
          maxRedirects: 0,
          maxContentLength: 2 * 1024 * 1024,
          maxBodyLength: 2 * 1024 * 1024,
          httpAgent: hubAgents.httpAgent,
          httpsAgent: hubAgents.httpsAgent,
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
          linkedAt: account?.linkedAt,
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
      const hub = await requireHubAuth(store, req);
      if (hub.hubId !== req.params.hubId) {
        return res.status(403).json({
          success: false,
          error: 'Broker hub ID does not match the requested event queue'
        });
      }
      const events = await store.listQueuedEvents({ hubId: req.params.hubId });
      return res.status(200).json({
        success: true,
        events,
        count: events.length
      });
    } catch (error) {
      return res.status(error.status || 500).json({
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

      const response = await proxyToHub(store, hubId, 'execute', 'post', req.body || {});
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
    const authenticatedHub = await requireHubAuth(store, req);
    if (authenticatedHub.hubId !== req.params.hubId) {
      return res.status(403).json({
        success: false,
        error: 'Broker hub ID does not match the requested hub'
      });
    }
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
  closeServerAndExit,
  extractBearerToken,
  findUnsafeRequestKey,
  reconcileLinkedAccountsToHubs,
  renderAuthorizePage,
  sanitizeBaseUrl,
  validateHubBaseUrl
};

if (require.main === module) {
  const app = createApp({ startDispatcher: true });
  const port = Number(process.env.PORT || 4301);
  const bindHost = trimString(process.env.HOMEBRAIN_BROKER_BIND_HOST) || '0.0.0.0';
  const server = app.listen(port, bindHost, () => {
    console.log(`HomeBrain Alexa broker listening on ${bindHost}:${port}`);
    void reconcileLinkedAccountsToHubs(brokerStore).then((result) => {
      if (result.success && result.syncedHubs > 0) {
        console.log(`[broker] Reconciled ${result.syncedAccounts} linked-account record(s) with ${result.syncedHubs} HomeBrain hub(s)`);
      } else if (!result.success) {
        console.warn(`[broker] Unable to reconcile linked accounts with HomeBrain after ${result.attempts} attempt(s): ${result.failedHubs.map((entry) => `${entry.hubId || 'unknown'}: ${entry.error}`).join('; ')}`);
      }
    }).catch((error) => {
      console.warn(`[broker] Unable to reconcile linked accounts with HomeBrain: ${error.message}`);
    });
  });

  server.on('error', (error) => {
    console.error(`[broker] HTTP server error: ${error.message}`);
    process.exit(1);
  });

  server.on('close', () => {
    console.log('[broker] HTTP server closed');
  });

  const shutdown = (signal) => {
    console.log(`[broker] Received ${signal}; shutting down`);
    closeServerAndExit(server, 0);
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (error) => {
    console.error(`[broker] Uncaught exception: ${error.stack || error.message}`);
    closeServerAndExit(server, 1);
  });
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[broker] Unhandled rejection: ${message}`);
    closeServerAndExit(server, 1);
  });
}

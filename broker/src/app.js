const express = require('express');
const axios = require('axios');
const brokerStore = require('./store');
const {
  buildAddOrUpdateReport,
  buildChangeReport,
  buildDeleteReport
} = require('../../shared/alexa/messages');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getBrokerClientId() {
  return trimString(process.env.HOMEBRAIN_ALEXA_OAUTH_CLIENT_ID) || 'homebrain-alexa-skill';
}

function getBrokerDisplayName() {
  return trimString(process.env.HOMEBRAIN_ALEXA_BROKER_DISPLAY_NAME) || 'HomeBrain Alexa Broker';
}

function getAllowedClientIds() {
  const configured = trimString(process.env.HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS);
  if (!configured) {
    return [];
  }

  return Array.from(new Set(configured.split(',').map((entry) => trimString(entry)).filter(Boolean)));
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

  const allowed = getAllowedClientIds();
  if (allowed.length > 0 && !allowed.includes(value)) {
    throw new Error('client_id is not allowed');
  }

  return value;
}

function validateClientSecret(clientSecret) {
  const expectedSecret = trimString(process.env.HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET);
  if (expectedSecret && clientSecret !== expectedSecret) {
    throw new Error('client_secret is invalid');
  }
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

function renderAuthorizePage({ oauth = {}, hubs = [], error = '', brokerDisplayName = getBrokerDisplayName() }) {
  const hubOptions = hubs.map((hub) => {
    const label = `${hub.hubId}${hub.registration?.publicOrigin ? ` (${hub.registration.publicOrigin})` : ''}`;
    const selected = oauth.hubId === hub.hubId ? ' selected' : '';
    return `<option value="${htmlEscape(hub.hubId)}"${selected}>${htmlEscape(label)}</option>`;
  }).join('\n');

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
      <p class="hint">Choose the paired HomeBrain hub and enter the one-time Alexa pairing code from Settings &gt; Integrations &gt; Alexa.</p>
      ${error ? `<div class="error">${htmlEscape(error)}</div>` : ''}
      <form method="post" action="/api/oauth/alexa/authorize">
        <input type="hidden" name="response_type" value="${htmlEscape(oauth.responseType)}" />
        <input type="hidden" name="client_id" value="${htmlEscape(oauth.clientId)}" />
        <input type="hidden" name="redirect_uri" value="${htmlEscape(oauth.redirectUri)}" />
        <input type="hidden" name="scope" value="${htmlEscape(oauth.scope)}" />
        <input type="hidden" name="state" value="${htmlEscape(oauth.state)}" />
        <label for="hubId">HomeBrain Hub</label>
        <select id="hubId" name="hubId" required>${hubOptions}</select>
        <label for="linkCode">Alexa Pairing Code</label>
        <input id="linkCode" name="linkCode" autocomplete="one-time-code" placeholder="HBAX-XXXX-XXXX-XXXX" required />
        <label for="locale">Locale</label>
        <input id="locale" name="locale" value="${htmlEscape(oauth.locale || 'en-US')}" placeholder="en-US" />
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

function queueCatalogEvents(store, hubId, endpoints = []) {
  if (!Array.isArray(endpoints) || endpoints.length === 0) {
    return Promise.resolve([]);
  }

  return Promise.all([
    store.enqueueEvent({
      kind: 'add_or_update_report',
      hubId,
      payload: buildAddOrUpdateReport({ endpoints }),
      metadata: { count: endpoints.length }
    })
  ]);
}

function queueDeleteEvents(store, hubId, endpointIds = []) {
  const ids = Array.isArray(endpointIds) ? endpointIds.filter(Boolean) : [];
  if (ids.length === 0) {
    return Promise.resolve([]);
  }

  return Promise.all([
    store.enqueueEvent({
      kind: 'delete_report',
      hubId,
      payload: buildDeleteReport({
        endpoints: ids.map((endpointId) => ({ endpointId }))
      }),
      metadata: { count: ids.length }
    })
  ]);
}

function queueStateEvents(store, hubId, states = []) {
  const list = Array.isArray(states) ? states : [];
  if (list.length === 0) {
    return Promise.resolve([]);
  }

  return Promise.all(list.map((entry) => store.enqueueEvent({
    kind: 'change_report',
    hubId,
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

function createApp(options = {}) {
  const app = express();
  const store = options.store || brokerStore;

  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', async (_req, res) => {
    const hubs = await store.listHubs();
    res.status(200).json({
      success: true,
      hubs: hubs.length,
      generatedAt: new Date().toISOString()
    });
  });

  app.get('/api/oauth/alexa/authorize', async (req, res) => {
    const clientId = trimString(req.query.client_id);
    const redirectUri = trimString(req.query.redirect_uri);
    const state = trimString(req.query.state);

    try {
      validateClientId(clientId);
      if (trimString(req.query.response_type) !== 'code') {
        throw new Error('response_type must be code');
      }
      if (!redirectUri) {
        throw new Error('redirect_uri is required');
      }

      const hubs = (await store.listHubs()).filter((hub) => hub.registration);
      if (hubs.length === 0) {
        throw new Error('No HomeBrain hubs have been paired with the broker yet');
      }

      return res.status(200).type('html').send(renderAuthorizePage({
        hubs,
        oauth: {
          responseType: trimString(req.query.response_type),
          clientId,
          redirectUri,
          scope: trimString(req.query.scope) || 'smart_home',
          state,
          locale: trimString(req.query.locale) || 'en-US',
          hubId: trimString(req.query.hubId)
        }
      }));
    } catch (error) {
      if (redirectUri) {
        return res.redirect(buildAuthorizeErrorRedirect(redirectUri, 'invalid_request', error.message, state));
      }

      return res.status(400).type('html').send(renderAuthorizePage({
        hubs: [],
        oauth: {
          responseType: trimString(req.query.response_type),
          clientId,
          redirectUri,
          scope: trimString(req.query.scope),
          state
        },
        error: error.message
      }));
    }
  });

  app.post('/api/oauth/alexa/authorize', async (req, res) => {
    const clientId = trimString(req.body.client_id);
    const redirectUri = trimString(req.body.redirect_uri);
    const state = trimString(req.body.state);

    try {
      validateClientId(clientId);
      if (trimString(req.body.response_type) !== 'code') {
        throw new Error('response_type must be code');
      }
      if (!redirectUri) {
        throw new Error('redirect_uri is required');
      }

      const hubId = trimString(req.body.hubId);
      const linkCode = trimString(req.body.linkCode);
      if (!hubId) {
        throw new Error('hubId is required');
      }
      if (!linkCode) {
        throw new Error('linkCode is required');
      }

      const hub = await store.getHub(hubId);
      if (!hub?.registration) {
        throw new Error('Selected hub is not paired with the broker');
      }

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
        clientId,
        redirectUri,
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
          clientId,
          redirectUri
        }
      });

      await syncLinkedAccountsToHub(store, hubId).catch(() => {});

      const target = new URL(redirectUri);
      target.searchParams.set('code', authorizationCode.code);
      if (state) {
        target.searchParams.set('state', state);
      }
      return res.redirect(target.toString());
    } catch (error) {
      if (redirectUri) {
        return res.redirect(buildAuthorizeErrorRedirect(redirectUri, 'access_denied', error.message, state));
      }

      const hubs = (await store.listHubs()).filter((hub) => hub.registration);
      return res.status(400).type('html').send(renderAuthorizePage({
        hubs,
        oauth: {
          responseType: trimString(req.body.response_type),
          clientId,
          redirectUri,
          scope: trimString(req.body.scope),
          state,
          locale: trimString(req.body.locale),
          hubId: trimString(req.body.hubId)
        },
        error: error.message
      }));
    }
  });

  app.post('/api/oauth/alexa/token', async (req, res) => {
    try {
      const { clientId, clientSecret } = resolveClientCredentials(req);
      validateClientId(clientId);
      validateClientSecret(clientSecret);

      const grantType = trimString(req.body.grant_type);
      if (grantType === 'authorization_code') {
        const codeRecord = await store.consumeAuthorizationCode(req.body.code, {
          clientId,
          redirectUri: trimString(req.body.redirect_uri)
        });

        const tokens = await store.issueTokens({
          brokerAccountId: codeRecord.brokerAccountId,
          hubId: codeRecord.hubId,
          clientId,
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
        const tokens = await store.rotateRefreshToken(req.body.refresh_token, { clientId });
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
      const grant = await store.recordPermissionGrant({
        brokerAccountId: resolved.brokerAccountId,
        grantCode,
        granteeToken,
        permissionScopes,
        metadata: req.body?.metadata || {}
      });

      await syncLinkedAccountsToHub(store, resolved.hubId).catch(() => {});

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

  app.post('/api/alexa/hubs/register', async (req, res) => {
    try {
      const requestPayload = req.body || {};
      let hubPayload = null;

      if (trimString(requestPayload.hubBaseUrl) && trimString(requestPayload.linkCode)) {
        const hubBaseUrl = sanitizeBaseUrl(requestPayload.hubBaseUrl);
        const brokerBaseUrl = buildBrokerBaseUrl(req);
        if (!brokerBaseUrl) {
          throw new Error('Unable to determine broker public base URL');
        }

        const response = await axios.post(`${hubBaseUrl}/api/alexa/broker/register`, {
          linkCode: trimString(requestPayload.linkCode),
          mode: trimString(requestPayload.mode) === 'public' ? 'public' : 'private',
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
          healthUrl: buildAbsoluteUrl(hubBaseUrl, registration.endpoints?.health, '/api/alexa/broker/health'),
          accountsUrl: buildAbsoluteUrl(hubBaseUrl, registration.endpoints?.accounts, '/api/alexa/broker/accounts'),
          linkAccountUrl: buildAbsoluteUrl(hubBaseUrl, registration.endpoints?.linkAccount, '/api/alexa/broker/link-account')
        };
      } else {
        hubPayload = {
          hubId: trimString(requestPayload.hubId),
          hubBaseUrl: sanitizeBaseUrl(requestPayload.hubBaseUrl),
          publicOrigin: trimString(requestPayload.publicOrigin),
          relayToken: trimString(requestPayload.relayToken),
          brokerClientId: trimString(requestPayload.brokerClientId) || getBrokerClientId(),
          mode: trimString(requestPayload.mode) === 'public' ? 'public' : 'private',
          catalogUrl: trimString(requestPayload.catalogUrl),
          stateUrl: trimString(requestPayload.stateUrl),
          executeUrl: trimString(requestPayload.executeUrl),
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

      res.status(200).json({
        success: true,
        hub
      });
    } catch (error) {
      res.status(400).json({
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
      res.status(200).json({
        success: true,
        hubId: req.params.hubId,
        endpoints: hub?.catalog?.endpoints || [],
        updatedAt: hub?.catalog?.updatedAt || null
      });
    } catch (error) {
      res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get('/api/alexa/hubs/:hubId/events', async (req, res) => {
    try {
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

      const response = await proxyToHub(store, hubId, 'state', 'post', { endpointIds });
      await store.upsertState({
        hubId,
        states: response.states,
        reason: 'hub_refresh'
      });
      res.status(200).json(response);
    } catch (error) {
      res.status(error.status || 500).json({
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

      const response = await proxyToHub(store, hubId, 'execute', 'post', req.body?.directive || req.body);
      res.status(200).json(response);
    } catch (error) {
      res.status(error.status || 500).json({
        success: false,
        error: error.message
      });
    }
  });

  app.get('/api/alexa/hubs/:hubId', async (req, res) => {
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
  const app = createApp();
  const port = Number(process.env.PORT || 4301);
  app.listen(port, () => {
    console.log(`HomeBrain Alexa broker listening on port ${port}`);
  });
}

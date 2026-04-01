const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');

const { createApp } = require('../src/app');
const { BrokerStore } = require('../src/store');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test('broker pairing and Alexa OAuth flow persist linked accounts and tokens', async (t) => {
  const relayToken = 'relay-secret';
  const linkedAccountsPayloads = [];
  const eventGatewayPayloads = [];

  const hubServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = chunks.length > 0
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : {};

    if (req.url === '/api/alexa/broker/register' && req.method === 'POST') {
      assert.equal(body.linkCode, 'HBAX-REGISTER');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        hubId: 'hub-test',
        relayToken,
        mode: 'private',
        publicOrigin: 'https://hub.example.com',
        endpoints: {
          health: '/api/alexa/broker/health',
          catalog: '/api/alexa/broker/catalog',
          execute: '/api/alexa/broker/execute',
          state: '/api/alexa/broker/state',
          accounts: '/api/alexa/broker/accounts',
          linkAccount: '/api/alexa/broker/link-account'
        }
      }));
      return;
    }

    assert.equal(req.headers.authorization, `Bearer ${relayToken}`);
    assert.equal(req.headers['x-homebrain-hub-id'], 'hub-test');

    if (req.url === '/api/alexa/broker/link-account' && req.method === 'POST') {
      assert.equal(body.linkCode, 'HBAX-LINK');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        hubId: 'hub-test',
        codePreview: 'LINK',
        mode: 'private'
      }));
      return;
    }

    if (req.url === '/api/alexa/broker/accounts' && req.method === 'POST') {
      linkedAccountsPayloads.push(body.accounts || []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        accounts: body.accounts || []
      }));
      return;
    }

    if (req.url === '/api/alexa/broker/custom-skill' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        spokenText: 'Custom skill completed.',
        resultText: 'Custom skill completed.'
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: `Unhandled hub route ${req.method} ${req.url}`
    }));
  });

  const amazonServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const rawBody = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/auth/o2/token' && req.method === 'POST') {
      const params = new URLSearchParams(rawBody);
      assert.equal(params.get('client_id'), 'event-client-id');
      assert.equal(params.get('client_secret'), 'event-client-secret');
      assert.equal(params.get('grant_type'), 'authorization_code');
      assert.equal(params.get('code'), 'grant-code-1');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'amzn-access-1',
        refresh_token: 'amzn-refresh-1',
        token_type: 'bearer',
        expires_in: 3600
      }));
      return;
    }

    if (req.url === '/v3/events' && req.method === 'POST') {
      eventGatewayPayloads.push({
        authorization: req.headers.authorization,
        body: JSON.parse(rawBody || '{}')
      });

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: `Unhandled Amazon route ${req.method} ${req.url}`
    }));
  });

  const brokerStoreFile = path.join(os.tmpdir(), `homebrain-broker-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const brokerStore = new BrokerStore({ filePath: brokerStoreFile });
  const amazon = await listen(amazonServer);
  const previousEventClientId = process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_ID;
  const previousEventClientSecret = process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET;
  const previousLwaTokenUrl = process.env.HOMEBRAIN_ALEXA_LWA_TOKEN_URL;
  const previousEventGatewayUrl = process.env.HOMEBRAIN_ALEXA_EVENT_GATEWAY_URL;
  const previousAllowedRedirectUris = process.env.HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS;
  const previousAllowedClientIds = process.env.HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS;
  process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_ID = 'event-client-id';
  process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET = 'event-client-secret';
  process.env.HOMEBRAIN_ALEXA_LWA_TOKEN_URL = `${amazon.baseUrl}/auth/o2/token`;
  process.env.HOMEBRAIN_ALEXA_EVENT_GATEWAY_URL = `${amazon.baseUrl}/v3/events`;
  process.env.HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS = 'http://127.0.0.1/callback';
  process.env.HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS = 'client-test';

  const brokerServer = http.createServer(createApp({
    store: brokerStore,
    startDispatcher: false,
    autoKickDispatcher: false
  }));

  const hub = await listen(hubServer);
  const broker = await listen(brokerServer);

  t.after(async () => {
    process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_ID = previousEventClientId;
    process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET = previousEventClientSecret;
    process.env.HOMEBRAIN_ALEXA_LWA_TOKEN_URL = previousLwaTokenUrl;
    process.env.HOMEBRAIN_ALEXA_EVENT_GATEWAY_URL = previousEventGatewayUrl;
    process.env.HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS = previousAllowedRedirectUris;
    process.env.HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS = previousAllowedClientIds;
    await Promise.all([
      close(broker.server),
      close(hub.server),
      close(amazon.server)
    ]);
    await fs.rm(brokerStoreFile, { force: true });
  });

  const registerResponse = await fetch(`${broker.baseUrl}/api/alexa/hubs/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      hubBaseUrl: hub.baseUrl,
      linkCode: 'HBAX-REGISTER',
      brokerClientId: 'client-test'
    })
  });

  assert.equal(registerResponse.status, 200);
  const registerPayload = await registerResponse.json();
  assert.equal(registerPayload.success, true);
  assert.equal(registerPayload.hub.hubId, 'hub-test');

  const authorizeResponse = await fetch(`${broker.baseUrl}/api/oauth/alexa/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: 'client-test',
      redirect_uri: 'http://127.0.0.1/callback',
      scope: 'smart_home',
      state: 'state-123',
      hubRef: 'hub-test',
      linkCode: 'HBAX-LINK',
      locale: 'en-US'
    })
  });

  assert.equal(authorizeResponse.status, 302);
  const redirectLocation = authorizeResponse.headers.get('location');
  assert.ok(redirectLocation);

  const redirectUrl = new URL(redirectLocation);
  assert.equal(redirectUrl.searchParams.get('state'), 'state-123');
  const authorizationCode = redirectUrl.searchParams.get('code');
  assert.ok(authorizationCode);

  const tokenResponse = await fetch(`${broker.baseUrl}/api/oauth/alexa/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'client-test',
      redirect_uri: 'http://127.0.0.1/callback',
      code: authorizationCode
    })
  });

  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  const resolveResponse = await fetch(`${broker.baseUrl}/api/oauth/alexa/resolve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.access_token}`
    },
    body: JSON.stringify({})
  });

  assert.equal(resolveResponse.status, 200);
  const resolved = await resolveResponse.json();
  assert.equal(resolved.hubId, 'hub-test');
  assert.equal(resolved.account.status, 'linked');

  const grantResponse = await fetch(`${broker.baseUrl}/api/alexa/grants/accept`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.access_token}`
    },
    body: JSON.stringify({
      grantCode: 'grant-code-1',
      granteeToken: tokens.access_token
    })
  });

  assert.equal(grantResponse.status, 200);
  const grantPayload = await grantResponse.json();
  assert.equal(grantPayload.success, true);

  assert.ok(linkedAccountsPayloads.length >= 2);
  const finalSyncPayload = linkedAccountsPayloads.at(-1);
  assert.equal(finalSyncPayload.length, 1);
  assert.equal(finalSyncPayload[0].permissions.includes('alexa::async_event:write'), true);
  const brokerAccountId = finalSyncPayload[0].brokerAccountId;

  const catalogSyncResponse = await fetch(`${broker.baseUrl}/api/alexa/hubs/catalog`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${relayToken}`,
      'X-HomeBrain-Hub-Id': 'hub-test'
    },
    body: JSON.stringify({
      hubId: 'hub-test',
      endpoints: [{
        endpointId: 'hb:hub-test:device:lamp-1',
        friendlyName: 'Lamp',
        description: 'Living room lamp',
        manufacturerName: 'HomeBrain',
        displayCategories: ['LIGHT'],
        capabilities: []
      }]
    })
  });

  assert.equal(catalogSyncResponse.status, 200);

  const householdDiscoveryResponse = await fetch(`${broker.baseUrl}/api/alexa/households/${encodeURIComponent(brokerAccountId)}/discovery-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${relayToken}`,
      'X-HomeBrain-Hub-Id': 'hub-test'
    },
    body: JSON.stringify({})
  });

  assert.equal(householdDiscoveryResponse.status, 200);
  const householdDiscoveryPayload = await householdDiscoveryResponse.json();
  assert.equal(householdDiscoveryPayload.success, true);
  assert.equal(householdDiscoveryPayload.queued, 1);

  const stateSyncResponse = await fetch(`${broker.baseUrl}/api/alexa/hubs/state`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${relayToken}`,
      'X-HomeBrain-Hub-Id': 'hub-test'
    },
    body: JSON.stringify({
      hubId: 'hub-test',
      states: [{
        endpointId: 'hb:hub-test:device:lamp-1',
        properties: [{
          namespace: 'Alexa.PowerController',
          name: 'powerState',
          value: 'ON'
        }]
      }]
    })
  });

  assert.equal(stateSyncResponse.status, 200);

  const flushResponse = await fetch(`${broker.baseUrl}/api/alexa/events/flush`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${relayToken}`,
      'X-HomeBrain-Hub-Id': 'hub-test'
    },
    body: JSON.stringify({
      hubId: 'hub-test'
    })
  });

  assert.equal(flushResponse.status, 200);
  const flushPayload = await flushResponse.json();
  assert.equal(flushPayload.success, true);
  assert.equal(flushPayload.processed, 3);

  assert.equal(eventGatewayPayloads.length, 3);
  assert.equal(eventGatewayPayloads[0].authorization, 'Bearer amzn-access-1');
  assert.equal(
    eventGatewayPayloads.some((entry) => entry.body?.event?.payload?.scope?.token === 'amzn-access-1'),
    true
  );
  assert.equal(
    eventGatewayPayloads.some((entry) => entry.body?.event?.endpoint?.scope?.token === 'amzn-access-1'),
    true
  );

  const customSkillResponse = await fetch(`${broker.baseUrl}/api/alexa/custom-skill/dispatch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.access_token}`
    },
    body: JSON.stringify({
      intentName: 'RunWorkflowIntent',
      requestType: 'IntentRequest'
    })
  });
  assert.equal(customSkillResponse.status, 200);
  const customSkillPayload = await customSkillResponse.json();
  assert.equal(customSkillPayload.success, true);
  assert.equal(customSkillPayload.spokenText, 'Custom skill completed.');

  const revokeResponse = await fetch(`${broker.baseUrl}/api/alexa/households/${encodeURIComponent(brokerAccountId)}/revoke`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${relayToken}`,
      'X-HomeBrain-Hub-Id': 'hub-test'
    },
    body: JSON.stringify({
      reason: 'Revoked in test'
    })
  });

  assert.equal(revokeResponse.status, 200);
  const revokePayload = await revokeResponse.json();
  assert.equal(revokePayload.success, true);
  assert.equal(revokePayload.account.status, 'revoked');

  const metricsResponse = await fetch(`${broker.baseUrl}/api/alexa/metrics`, {
    headers: {
      Authorization: `Bearer ${relayToken}`,
      'X-HomeBrain-Hub-Id': 'hub-test'
    }
  });
  assert.equal(metricsResponse.status, 200);
  const metricsPayload = await metricsResponse.json();
  assert.equal(metricsPayload.success, true);
  assert.equal(metricsPayload.metrics.queue.delivered >= 3, true);

  const auditResponse = await fetch(`${broker.baseUrl}/api/alexa/audit?limit=10`, {
    headers: {
      Authorization: `Bearer ${relayToken}`,
      'X-HomeBrain-Hub-Id': 'hub-test'
    }
  });
  assert.equal(auditResponse.status, 200);
  const auditPayload = await auditResponse.json();
  assert.equal(auditPayload.success, true);
  assert.equal(Array.isArray(auditPayload.auditLogs), true);
  assert.equal(auditPayload.auditLogs.some((entry) => entry.type === 'hub_registered'), true);

  const readinessResponse = await fetch(`${broker.baseUrl}/api/alexa/readiness`, {
    headers: {
      Authorization: `Bearer ${relayToken}`,
      'X-HomeBrain-Hub-Id': 'hub-test'
    }
  });
  assert.equal(readinessResponse.status, 200);
  const readinessPayload = await readinessResponse.json();
  assert.equal(readinessPayload.success, true);
  assert.equal(Array.isArray(readinessPayload.readiness.checks), true);

  const persistedHub = await brokerStore.getHub('hub-test');
  assert.equal(persistedHub.registration.linkAccountUrl, `${hub.baseUrl}/api/alexa/broker/link-account`);
});

test('broker custom dispatch resolves the linked hub and relays Alexa custom skill requests', async (t) => {
  const relayToken = 'relay-custom-secret';
  const hubCalls = [];

  const hubServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = chunks.length > 0
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : {};

    hubCalls.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      hubId: req.headers['x-homebrain-hub-id'],
      body
    });

    if (req.url === '/api/alexa/broker/custom-skill' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '1.0',
        response: {
          outputSpeech: {
            type: 'PlainText',
            text: 'Workflow bedtime started.'
          },
          shouldEndSession: true
        }
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: `Unhandled hub route ${req.method} ${req.url}`
    }));
  });

  const brokerStoreFile = path.join(os.tmpdir(), `homebrain-broker-custom-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const brokerStore = new BrokerStore({ filePath: brokerStoreFile });
  const brokerServer = http.createServer(createApp({
    store: brokerStore,
    startDispatcher: false,
    autoKickDispatcher: false
  }));

  const hub = await listen(hubServer);
  const broker = await listen(brokerServer);

  t.after(async () => {
    await Promise.all([
      close(broker.server),
      close(hub.server)
    ]);
    await fs.rm(brokerStoreFile, { force: true });
  });

  await brokerStore.registerHub({
    hubId: 'hub-custom',
    hubBaseUrl: hub.baseUrl,
    publicOrigin: 'https://hub.example.com',
    relayToken,
    brokerClientId: 'client-custom',
    mode: 'public',
    catalogUrl: `${hub.baseUrl}/api/alexa/broker/catalog`,
    stateUrl: `${hub.baseUrl}/api/alexa/broker/state`,
    executeUrl: `${hub.baseUrl}/api/alexa/broker/execute`,
    customSkillUrl: `${hub.baseUrl}/api/alexa/broker/custom-skill`,
    healthUrl: `${hub.baseUrl}/api/alexa/broker/health`,
    accountsUrl: `${hub.baseUrl}/api/alexa/broker/accounts`,
    linkAccountUrl: `${hub.baseUrl}/api/alexa/broker/link-account`
  });

  const account = await brokerStore.createAccountLink({
    hubId: 'hub-custom',
    brokerAccountId: 'acct-custom',
    status: 'linked',
    locale: 'en-US'
  });

  const tokens = await brokerStore.issueTokens({
    brokerAccountId: account.brokerAccountId,
    hubId: 'hub-custom',
    clientId: 'client-custom',
    scopes: ['smart_home']
  });

  const response = await fetch(`${broker.baseUrl}/api/alexa/custom/dispatch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.accessToken}`
    },
    body: JSON.stringify({
      envelope: {
        session: {
          user: {
            userId: 'user-custom',
            accessToken: tokens.accessToken
          }
        },
        request: {
          type: 'IntentRequest',
          requestId: 'req-custom',
          locale: 'en-US',
          intent: {
            name: 'HomeBrainWorkflowIntent',
            slots: {
              workflowName: {
                name: 'workflowName',
                value: 'Bedtime'
              }
            }
          }
        }
      }
    })
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.response.outputSpeech.text, 'Workflow bedtime started.');
  assert.equal(hubCalls.length, 1);
  assert.equal(hubCalls[0].authorization, `Bearer ${relayToken}`);
  assert.equal(hubCalls[0].hubId, 'hub-custom');
  assert.equal(hubCalls[0].body.brokerAccountId, 'acct-custom');
  assert.equal(hubCalls[0].body.envelope.request.intent.name, 'HomeBrainWorkflowIntent');
});

test('broker rejects unauthenticated event access and invalid redirect URIs', async (t) => {
  const brokerStoreFile = path.join(os.tmpdir(), `homebrain-broker-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const brokerStore = new BrokerStore({ filePath: brokerStoreFile });
  const previousAllowedRedirectUris = process.env.HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS;
  process.env.HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS = 'https://allowed.example/callback';

  const brokerServer = http.createServer(createApp({
    store: brokerStore,
    startDispatcher: false,
    autoKickDispatcher: false
  }));
  const broker = await listen(brokerServer);

  t.after(async () => {
    process.env.HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS = previousAllowedRedirectUris;
    await close(broker.server);
    await fs.rm(brokerStoreFile, { force: true });
  });

  const unauthorizedEventsResponse = await fetch(`${broker.baseUrl}/api/alexa/events`);
  assert.equal(unauthorizedEventsResponse.status, 401);

  const invalidAuthorizeResponse = await fetch(`${broker.baseUrl}/api/oauth/alexa/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: 'homebrain-alexa-skill',
      redirect_uri: 'https://evil.example/callback',
      scope: 'smart_home',
      state: 'state-123',
      hubRef: 'hub-test',
      linkCode: 'HBAX-LINK'
    })
  });

  assert.equal(invalidAuthorizeResponse.status, 400);
});

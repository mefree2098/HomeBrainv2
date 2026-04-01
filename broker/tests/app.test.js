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

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: `Unhandled hub route ${req.method} ${req.url}`
    }));
  });

  const brokerStoreFile = path.join(os.tmpdir(), `homebrain-broker-test-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const brokerStore = new BrokerStore({ filePath: brokerStoreFile });
  const brokerServer = http.createServer(createApp({ store: brokerStore }));

  const hub = await listen(hubServer);
  const broker = await listen(brokerServer);

  t.after(async () => {
    await Promise.all([
      close(broker.server),
      close(hub.server)
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
      hubId: 'hub-test',
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

  const persistedHub = await brokerStore.getHub('hub-test');
  assert.equal(persistedHub.registration.linkAccountUrl, `${hub.baseUrl}/api/alexa/broker/link-account`);
});

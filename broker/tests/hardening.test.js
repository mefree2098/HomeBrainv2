const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const {
  buildAbsoluteUrl,
  createApp,
  findUnsafeRequestKey,
  reconcileLinkedAccountsToHubs,
  renderAuthorizePage,
  sanitizeBaseUrl,
  validateHubBaseUrl
} = require('../src/app');
const { AlexaEventGatewayService } = require('../src/eventGatewayService');
const { BrokerStore, pkceS256, safeRecordKey } = require('../src/store');

function createMemoryStore() {
  const store = new BrokerStore({
    state: {
      version: 2,
      hubs: {},
      accountLinks: {},
      authCodes: {},
      accessTokens: {},
      refreshTokens: {},
      permissionGrants: {},
      eventQueue: [],
      auditLog: []
    }
  });
  store.persist = async () => {};
  return store;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`
      });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test('broker URL validation rejects credentials, unsafe schemes, and cross-origin endpoints', () => {
  assert.equal(sanitizeBaseUrl('https://broker.example.test/path'), 'https://broker.example.test');
  assert.throws(() => sanitizeBaseUrl('https://user:secret@broker.example.test'), /credentials/);
  assert.throws(() => sanitizeBaseUrl('file:///tmp/test'), /http or https/);
  assert.equal(
    buildAbsoluteUrl('https://hub.example.test', '/api/alexa/catalog'),
    'https://hub.example.test/api/alexa/catalog'
  );
  assert.throws(
    () => buildAbsoluteUrl('https://hub.example.test', 'https://attacker.example/catalog'),
    /configured origin/
  );
  assert.equal(validateHubBaseUrl('https://hub.example.test', { mode: 'public' }), 'https://hub.example.test');
  assert.throws(() => validateHubBaseUrl('https://hub.example.test/path', { mode: 'public' }), /without a path/);
});

test('broker pairing blocks private callback addresses unless explicitly allowed', async (t) => {
  const broker = await listen(http.createServer(createApp({
    store: createMemoryStore(),
    startDispatcher: false,
    autoKickDispatcher: false,
    allowPrivateHubUrls: false
  })));
  t.after(() => close(broker.server));

  const response = await fetch(`${broker.baseUrl}/api/alexa/hubs/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hubBaseUrl: 'http://127.0.0.1:1',
      linkCode: 'HBAX-SSRF-TEST',
      mode: 'private'
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /outside the permitted network/);
});

test('broker request safety finds prototype and query-operator keys', () => {
  assert.equal(findUnsafeRequestKey(JSON.parse('{"nested":{"__proto__":{"polluted":true}}}')), '__proto__');
  assert.equal(findUnsafeRequestKey({ nested: { $where: 'sleep(1)' } }), '$where');
  assert.equal(findUnsafeRequestKey({ nested: { safe: true } }), '');
});

test('broker store rejects identifiers that could address object prototypes', async () => {
  const store = createMemoryStore();
  assert.throws(() => safeRecordKey('__proto__', 'hubId'), /invalid/);
  await assert.rejects(() => store.registerHub({ hubId: '__proto__' }), /hubId is invalid/);
  assert.equal({}.polluted, undefined);
});

async function createLinkedGrant(store, options = {}) {
  await store.registerHub({
    hubId: options.hubId || 'hub-hardening',
    relayToken: 'relay-hardening',
    mode: 'public'
  });
  const account = await store.createAccountLink({
    hubId: options.hubId || 'hub-hardening',
    locale: 'en-US',
    status: 'linked'
  });
  await store.issueTokens({
    brokerAccountId: account.brokerAccountId,
    clientId: 'client-hardening',
    scopes: ['smart_home']
  });
  const grant = await store.recordPermissionGrant({
    brokerAccountId: account.brokerAccountId,
    hubId: account.hubId,
    grantCode: options.grantCode || 'grant-hardening',
    granteeToken: 'grantee-hardening',
    eventRegion: 'NA',
    eventGatewayUrl: 'https://events.example.test/v3/events',
    accessToken: 'lwa-access-hardening',
    refreshToken: 'lwa-refresh-hardening',
    tokenExpiresAt: options.tokenExpiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: 'active'
  });
  const acceptedGrant = await store.updatePermissionGrant(grant.permissionGrantId, {
    acceptedAt: options.acceptedAt || new Date(Date.now() - 60 * 1000).toISOString()
  });
  return { account, grant: acceptedGrant };
}

test('startup reconciliation pushes broker-authoritative account status back to every hub', async (t) => {
  let received = null;
  const hub = await listen(http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = {
        authorization: req.headers.authorization,
        hubId: req.headers['x-homebrain-hub-id'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  }));
  t.after(() => close(hub.server));

  const store = createMemoryStore();
  await store.registerHub({
    hubId: 'hub-reconcile',
    relayToken: 'relay-reconcile',
    accountsUrl: `${hub.baseUrl}/api/alexa/broker/accounts`,
    mode: 'public'
  });
  const account = await store.createAccountLink({
    brokerAccountId: 'acct-stale',
    hubId: 'hub-reconcile',
    status: 'linked'
  });
  assert.equal(account.status, 'error');

  const result = await reconcileLinkedAccountsToHubs(store, {
    maxAttempts: 1,
    retryDelayMs: 0
  });

  assert.equal(result.success, true);
  assert.equal(result.syncedHubs, 1);
  assert.equal(result.syncedAccounts, 1);
  assert.equal(received.authorization, 'Bearer relay-reconcile');
  assert.equal(received.hubId, 'hub-reconcile');
  assert.equal(received.body.accounts[0].brokerAccountId, 'acct-stale');
  assert.equal(received.body.accounts[0].status, 'error');
  assert.equal(received.body.accounts[0].metadata.credentialError, 'missing_refresh_token');
});

test('authorization-code exchange is atomic, retryable after persistence failure, and verifies PKCE', async () => {
  const store = createMemoryStore();
  await store.registerHub({ hubId: 'hub-oauth-atomic', mode: 'public' });
  const verifier = 'v'.repeat(43);
  const authorization = await store.createAuthorizationGrant({
    hubId: 'hub-oauth-atomic',
    locale: 'en-US',
    clientId: 'client-atomic',
    redirectUri: 'https://example.test/callback',
    scopes: ['smart_home'],
    codeChallenge: pkceS256(verifier),
    codeChallengeMethod: 'S256'
  });

  assert.equal(authorization.accountLink.status, 'pending');
  await assert.rejects(
    () => store.exchangeAuthorizationCode(authorization.authorizationCode.code, {
      clientId: 'client-atomic',
      redirectUri: 'https://example.test/callback',
      codeVerifier: 'x'.repeat(43)
    }),
    /code_verifier is invalid/
  );

  store.persist = async () => {
    throw new Error('simulated disk outage');
  };
  await assert.rejects(
    () => store.exchangeAuthorizationCode(authorization.authorizationCode.code, {
      clientId: 'client-atomic',
      redirectUri: 'https://example.test/callback',
      codeVerifier: verifier
    }),
    /simulated disk outage/
  );

  const afterFailure = await store.read((state) => ({
    authCodes: Object.values(state.authCodes),
    accessTokens: Object.values(state.accessTokens),
    refreshTokens: Object.values(state.refreshTokens),
    account: state.accountLinks[authorization.accountLink.brokerAccountId]
  }));
  assert.equal(afterFailure.authCodes.length, 1);
  assert.equal(afterFailure.accessTokens.length, 0);
  assert.equal(afterFailure.refreshTokens.length, 0);
  assert.equal(afterFailure.account.status, 'pending');

  store.persist = async () => {};
  const tokens = await store.exchangeAuthorizationCode(authorization.authorizationCode.code, {
    clientId: 'client-atomic',
    redirectUri: 'https://example.test/callback',
    codeVerifier: verifier,
    requestId: 'atomic-retry'
  });
  assert.ok(tokens.accessToken);
  assert.ok(tokens.refreshToken);
  const replayedTokens = await store.exchangeAuthorizationCode(authorization.authorizationCode.code, {
    clientId: 'client-atomic',
    redirectUri: 'https://example.test/callback',
    codeVerifier: verifier,
    requestId: 'atomic-response-retry'
  });
  assert.equal(replayedTokens.accessToken, tokens.accessToken);
  assert.equal(replayedTokens.refreshToken, tokens.refreshToken);
  const tokenRecords = await store.read((state) => ({
    accessTokens: Object.keys(state.accessTokens).length,
    refreshTokens: Object.keys(state.refreshTokens).length
  }));
  assert.deepEqual(tokenRecords, { accessTokens: 1, refreshTokens: 1 });
  assert.equal((await store.getAccountLink(authorization.accountLink.brokerAccountId)).status, 'linked');
  assert.equal((await store.getMetricsSnapshot()).linkedAccounts.tokenBacked, 1);
});

test('token endpoint accepts valid PKCE and does not consume the code on a bad verifier', async (t) => {
  const previousAllowedClientIds = process.env.HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS;
  const previousAllowedRedirectUris = process.env.HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS;
  const previousOauthClients = process.env.HOMEBRAIN_ALEXA_OAUTH_CLIENTS;
  const previousOauthClientSecret = process.env.HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET;
  process.env.HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS = 'client-pkce';
  process.env.HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS = 'https://example.test/callback';
  process.env.HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET = 'pkce-client-secret';
  delete process.env.HOMEBRAIN_ALEXA_OAUTH_CLIENTS;

  const store = createMemoryStore();
  await store.registerHub({ hubId: 'hub-pkce-route', mode: 'public' });
  const verifier = 'p'.repeat(43);
  const authorization = await store.createAuthorizationGrant({
    hubId: 'hub-pkce-route',
    clientId: 'client-pkce',
    redirectUri: 'https://example.test/callback',
    scopes: ['smart_home'],
    codeChallenge: pkceS256(verifier),
    codeChallengeMethod: 'S256'
  });
  const broker = await listen(http.createServer(createApp({
    store,
    startDispatcher: false,
    autoKickDispatcher: false
  })));

  t.after(async () => {
    restoreEnv('HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS', previousAllowedClientIds);
    restoreEnv('HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS', previousAllowedRedirectUris);
    restoreEnv('HOMEBRAIN_ALEXA_OAUTH_CLIENTS', previousOauthClients);
    restoreEnv('HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET', previousOauthClientSecret);
    await close(broker.server);
  });

  const exchange = (codeVerifier) => fetch(`${broker.baseUrl}/api/oauth/alexa/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'client-pkce',
      client_secret: 'pkce-client-secret',
      redirect_uri: 'https://example.test/callback',
      code: authorization.authorizationCode.code,
      code_verifier: codeVerifier
    })
  });

  const badResponse = await exchange('b'.repeat(43));
  assert.equal(badResponse.status, 400);
  assert.equal((await badResponse.json()).error, 'invalid_grant');

  const goodResponse = await exchange(verifier);
  assert.equal(goodResponse.status, 200);
  assert.equal(goodResponse.headers.get('cache-control'), 'no-store');
  assert.ok((await goodResponse.json()).refresh_token);
});

test('authorization page preserves PKCE and blocks browser double submission', () => {
  const challenge = pkceS256('q'.repeat(43));
  const html = renderAuthorizePage({
    oauth: {
      responseType: 'code',
      clientId: 'client-page',
      redirectUri: 'https://example.test/callback',
      scope: 'smart_home',
      state: 'state-page',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      locale: 'en-US'
    }
  });
  assert.match(html, new RegExp(`name="code_challenge" value="${challenge}"`));
  assert.match(html, /name="code_challenge_method" value="S256"/);
  assert.match(html, /form\.dataset\.submitted === 'true'/);
  assert.match(html, /button\.disabled = true/);
});

test('stale processing events are recovered after an interrupted dispatcher', async () => {
  const store = createMemoryStore();
  await store.enqueueEvent({
    hubId: 'hub-lease',
    status: 'processing',
    attempts: 1,
    lastAttemptAt: '2020-01-01T00:00:00.000Z',
    processingStartedAt: '2020-01-01T00:00:00.000Z',
    leaseExpiresAt: '2020-01-01T00:02:00.000Z',
    payload: { event: { header: { namespace: 'Alexa', name: 'ChangeReport' } } }
  });

  const reserved = await store.reserveQueuedEvents({ hubId: 'hub-lease' });
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].status, 'processing');
  assert.equal(reserved[0].attempts, 2);
  assert.ok(new Date(reserved[0].leaseExpiresAt).getTime() > Date.now());
});

test('events wait for a newly accepted grant to propagate before first delivery', async () => {
  const store = createMemoryStore();
  let gatewayCalls = 0;
  const { grant } = await createLinkedGrant(store, {
    hubId: 'hub-grant-activation-delay',
    acceptedAt: new Date().toISOString()
  });
  await store.enqueueEvent({
    hubId: grant.hubId,
    brokerAccountId: grant.brokerAccountId,
    permissionGrantId: grant.permissionGrantId,
    payload: { event: { header: { namespace: 'Alexa', name: 'AddOrUpdateReport' }, payload: {} } }
  });
  const service = new AlexaEventGatewayService({
    store,
    httpClient: {
      async post() {
        gatewayCalls += 1;
        return { status: 202, data: {} };
      }
    }
  });
  const result = await service.flush({ hubId: grant.hubId });
  assert.equal(result.results[0].status, 'queued');
  assert.equal(result.results[0].deferred, 'grant_activation');
  assert.equal(gatewayCalls, 0);
  const event = (await store.listQueuedEvents({ hubId: grant.hubId }))[0];
  assert.equal(event.status, 'queued');
  assert.equal(event.metadata.activationDelayApplied, true);
  assert.ok(new Date(event.nextAttemptAt).getTime() > Date.now());
});

test('AcceptGrant is idempotent and rejects incomplete LWA token responses', async (t) => {
  const previousClientId = process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_ID;
  const previousClientSecret = process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET;
  process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_ID = 'event-client';
  process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET = 'event-secret';
  t.after(() => {
    restoreEnv('HOMEBRAIN_ALEXA_EVENT_CLIENT_ID', previousClientId);
    restoreEnv('HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET', previousClientSecret);
  });

  const store = createMemoryStore();
  await store.registerHub({ hubId: 'hub-grant-idempotent', mode: 'public' });
  const account = await store.createAccountLink({
    hubId: 'hub-grant-idempotent',
    status: 'linked'
  });
  await store.issueTokens({
    brokerAccountId: account.brokerAccountId,
    clientId: 'client-grant-idempotent',
    scopes: ['smart_home']
  });
  let lwaCalls = 0;
  const httpClient = {
    async post(_url, body) {
      lwaCalls += 1;
      const params = new URLSearchParams(body);
      if (params.get('code') === 'malformed-grant') {
        return { status: 200, data: { access_token: 'access-without-refresh', expires_in: 3600 } };
      }
      return {
        status: 200,
        data: {
          access_token: 'lwa-access',
          refresh_token: 'lwa-refresh',
          expires_in: 3600
        }
      };
    }
  };
  const service = new AlexaEventGatewayService({ store, httpClient });
  const payload = {
    brokerAccountId: account.brokerAccountId,
    hubId: account.hubId,
    granteeToken: 'grantee-token',
    grantCode: 'one-time-grant',
    eventRegion: 'NA'
  };

  const first = await service.acceptGrantForLinkedAccount(payload);
  const replay = await service.acceptGrantForLinkedAccount(payload);
  assert.equal(lwaCalls, 1);
  assert.equal(replay.permissionGrantId, first.permissionGrantId);
  assert.equal(replay.idempotentReplay, true);

  await assert.rejects(
    () => service.acceptGrantForLinkedAccount({ ...payload, grantCode: 'malformed-grant' }),
    /missing refresh_token/
  );
});

test('transient LWA refresh failures keep the grant active and requeue the event', async (t) => {
  const previousClientId = process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_ID;
  const previousClientSecret = process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET;
  process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_ID = 'event-client';
  process.env.HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET = 'event-secret';
  t.after(() => {
    restoreEnv('HOMEBRAIN_ALEXA_EVENT_CLIENT_ID', previousClientId);
    restoreEnv('HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET', previousClientSecret);
  });

  const store = createMemoryStore();
  const { grant } = await createLinkedGrant(store, {
    tokenExpiresAt: '2020-01-01T00:00:00.000Z'
  });
  await store.enqueueEvent({
    hubId: grant.hubId,
    brokerAccountId: grant.brokerAccountId,
    permissionGrantId: grant.permissionGrantId,
    payload: { event: { header: { namespace: 'Alexa', name: 'ChangeReport' }, endpoint: {} } }
  });
  const httpClient = {
    async post() {
      const error = new Error('LWA temporarily unavailable');
      error.response = { status: 503, data: { error: 'server_error' } };
      throw error;
    }
  };
  const service = new AlexaEventGatewayService({ store, httpClient });
  const result = await service.flush({ hubId: grant.hubId });
  assert.equal(result.results[0].status, 'queued');
  assert.equal((await store.getPermissionGrant(grant.permissionGrantId)).status, 'active');
  assert.equal((await store.listQueuedEvents({ hubId: grant.hubId }))[0].status, 'queued');
});

test('a fresh event-gateway 403 is retried without deleting the grant or its diagnostics', async () => {
  const store = createMemoryStore();
  const { grant } = await createLinkedGrant(store);
  await store.enqueueEvent({
    hubId: grant.hubId,
    brokerAccountId: grant.brokerAccountId,
    permissionGrantId: grant.permissionGrantId,
    payload: { event: { header: { namespace: 'Alexa', name: 'AddOrUpdateReport' }, payload: {} } }
  });
  const httpClient = {
    async post() {
      const error = new Error('Skill not active yet');
      error.response = {
        status: 403,
        data: {
          payload: {
            code: 'SKILL_NEVER_ENABLED_EXCEPTION',
            description: 'Skill enablement has not propagated'
          }
        }
      };
      throw error;
    }
  };
  const service = new AlexaEventGatewayService({ store, httpClient });
  const result = await service.flush({ hubId: grant.hubId });
  assert.equal(result.results[0].status, 'queued');

  const persistedGrant = await store.getPermissionGrant(grant.permissionGrantId);
  assert.equal(persistedGrant.status, 'active');
  assert.equal(persistedGrant.revokedAt, null);
  assert.equal(persistedGrant.metadata.lastErrorCode, 'SKILL_NEVER_ENABLED_EXCEPTION');
  const event = (await store.listQueuedEvents({ hubId: grant.hubId }))[0];
  assert.equal(event.status, 'queued');
  assert.equal(event.maxAttempts, 8);
  assert.equal(event.metadata.lastResponseCode, 'SKILL_NEVER_ENABLED_EXCEPTION');
});

test('an explicit skill-disabled response revokes but preserves the grant record', async () => {
  const store = createMemoryStore();
  const { grant } = await createLinkedGrant(store, { hubId: 'hub-disabled-grant' });
  await store.enqueueEvent({
    hubId: grant.hubId,
    brokerAccountId: grant.brokerAccountId,
    permissionGrantId: grant.permissionGrantId,
    payload: { event: { header: { namespace: 'Alexa', name: 'ChangeReport' }, endpoint: {} } }
  });
  const httpClient = {
    async post() {
      const error = new Error('The customer disabled the skill');
      error.response = {
        status: 403,
        data: { code: 'SKILL_DISABLED_EXCEPTION', message: 'The customer disabled the skill' }
      };
      throw error;
    }
  };
  const service = new AlexaEventGatewayService({ store, httpClient });
  const result = await service.flush({ hubId: grant.hubId });
  assert.equal(result.results[0].status, 'skipped');
  const persistedGrant = await store.getPermissionGrant(grant.permissionGrantId);
  assert.equal(persistedGrant.status, 'revoked');
  assert.ok(persistedGrant.revokedAt);
  assert.equal((await store.listPermissionGrants({ hubId: grant.hubId })).length, 1);
});

test('legacy linked records without refresh tokens are surfaced as credential errors', async () => {
  const store = createMemoryStore();
  await store.registerHub({ hubId: 'hub-stale-account', mode: 'public' });
  const account = await store.createAccountLink({
    hubId: 'hub-stale-account',
    status: 'linked'
  });
  const persisted = await store.getAccountLink(account.brokerAccountId);
  const metrics = await store.getMetricsSnapshot({ hubId: 'hub-stale-account' });
  assert.equal(persisted.status, 'error');
  assert.equal(persisted.metadata.credentialError, 'missing_refresh_token');
  assert.equal(metrics.linkedAccounts.linked, 0);
  assert.equal(metrics.linkedAccounts.error, 1);
  assert.equal(metrics.linkedAccounts.missingRefreshToken, 1);
});

test('delivery API redacts LWA and grantee credentials from grant diagnostics', async (t) => {
  const store = createMemoryStore();
  const { grant } = await createLinkedGrant(store, { hubId: 'hub-redaction' });
  const broker = await listen(http.createServer(createApp({
    store,
    startDispatcher: false,
    autoKickDispatcher: false
  })));
  t.after(() => close(broker.server));

  const response = await fetch(`${broker.baseUrl}/api/alexa/events`, {
    headers: {
      Authorization: 'Bearer relay-hardening',
      'X-HomeBrain-Hub-Id': grant.hubId
    }
  });
  assert.equal(response.status, 200);
  const record = (await response.json()).permissionGrants[0];
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'accessToken'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'refreshToken'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'granteeTokenHash'), false);
  assert.equal(record.hasAccessToken, true);
  assert.equal(record.hasRefreshToken, true);
});

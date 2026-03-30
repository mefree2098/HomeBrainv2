const test = require('node:test');
const assert = require('node:assert/strict');

const OIDCClient = require('../models/OIDCClient');
const ReverseProxyRoute = require('../models/ReverseProxyRoute');
const axiomIngressSyncService = require('../services/axiomIngressSyncService');
const oidcService = require('../services/oidcService');
const reverseProxyService = require('../services/reverseProxyService');

function createRouteDocument(overrides = {}) {
  return {
    _id: overrides._id || 'route-id',
    hostname: overrides.hostname || 'mail.freestonefamily.com',
    platformKey: overrides.platformKey || 'axiom',
    displayName: overrides.displayName || 'Axiom',
    upstreamProtocol: overrides.upstreamProtocol || 'http',
    upstreamHost: overrides.upstreamHost || '127.0.0.1',
    upstreamPort: overrides.upstreamPort || 3001,
    enabled: overrides.enabled ?? true,
    tlsMode: overrides.tlsMode || 'automatic',
    allowOnDemandTls: overrides.allowOnDemandTls ?? false,
    allowPublicUpstream: overrides.allowPublicUpstream ?? false,
    healthCheckPath: overrides.healthCheckPath || '/',
    websocketSupport: overrides.websocketSupport ?? true,
    stripPrefix: overrides.stripPrefix || '',
    notes: overrides.notes || '',
    toObject() {
      return {
        _id: this._id,
        hostname: this.hostname,
        platformKey: this.platformKey,
        displayName: this.displayName,
        upstreamProtocol: this.upstreamProtocol,
        upstreamHost: this.upstreamHost,
        upstreamPort: this.upstreamPort,
        enabled: this.enabled,
        tlsMode: this.tlsMode,
        allowOnDemandTls: this.allowOnDemandTls,
        allowPublicUpstream: this.allowPublicUpstream,
        healthCheckPath: this.healthCheckPath,
        websocketSupport: this.websocketSupport,
        stripPrefix: this.stripPrefix,
        notes: this.notes
      };
    }
  };
}

test('sync reconciles managed Axiom routes, redirect URIs, and applies the reverse-proxy config', async (t) => {
  const originalFetch = global.fetch;
  const originalFindRoutes = ReverseProxyRoute.find;
  const originalOidcFindOne = OIDCClient.findOne;
  const originalGetRoutePresets = reverseProxyService.getRoutePresets;
  const originalCreateRoute = reverseProxyService.createRoute;
  const originalUpdateRoute = reverseProxyService.updateRoute;
  const originalDeleteRoute = reverseProxyService.deleteRoute;
  const originalApplyConfig = reverseProxyService.applyConfig;
  const originalEnsureBootstrapState = oidcService.ensureBootstrapState;

  t.after(() => {
    global.fetch = originalFetch;
    ReverseProxyRoute.find = originalFindRoutes;
    OIDCClient.findOne = originalOidcFindOne;
    reverseProxyService.getRoutePresets = originalGetRoutePresets;
    reverseProxyService.createRoute = originalCreateRoute;
    reverseProxyService.updateRoute = originalUpdateRoute;
    reverseProxyService.deleteRoute = originalDeleteRoute;
    reverseProxyService.applyConfig = originalApplyConfig;
    oidcService.ensureBootstrapState = originalEnsureBootstrapState;
  });

  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        generatedAt: '2026-03-30T18:15:00.000Z',
        mailHosts: ['mail.freestonefamily.com', 'mail.ntechr.com'],
        homeBrainRedirectUris: [
          'https://mail.freestonefamily.com/api/identity/homebrain/callback',
          'https://mail.ntechr.com/api/identity/homebrain/callback'
        ]
      };
    }
  });

  const existingManagedRoute = createRouteDocument({
    _id: 'route-managed',
    hostname: 'mail.freestonefamily.com',
    enabled: false,
    displayName: 'Axiom Legacy',
    notes: 'stale'
  });
  const staleManagedRoute = createRouteDocument({
    _id: 'route-stale',
    hostname: 'mail.oldexample.com',
    notes: 'remove me'
  });

  ReverseProxyRoute.find = (query) => {
    assert.deepEqual(query, { platformKey: 'axiom' });
    return {
      sort: async () => [existingManagedRoute, staleManagedRoute]
    };
  };

  reverseProxyService.getRoutePresets = async () => ([
    {
      platformKey: 'axiom',
      displayName: 'Axiom',
      upstreamProtocol: 'http',
      upstreamHost: '127.0.0.1',
      upstreamPort: 3001,
      healthCheckPath: '/',
      websocketSupport: true,
      tlsMode: 'automatic'
    }
  ]);

  const createdRoutes = [];
  const updatedRoutes = [];
  const deletedRoutes = [];

  reverseProxyService.createRoute = async (payload, actor) => {
    createdRoutes.push({ payload, actor });
    return { hostname: payload.hostname };
  };
  reverseProxyService.updateRoute = async (routeId, payload, actor) => {
    updatedRoutes.push({ routeId, payload, actor });
    return { _id: routeId, hostname: payload.hostname };
  };
  reverseProxyService.deleteRoute = async (routeId, actor) => {
    deletedRoutes.push({ routeId, actor });
    return { success: true };
  };

  let applyActor = '';
  reverseProxyService.applyConfig = async (actor) => {
    applyActor = actor;
    return {
      appliedAt: new Date('2026-03-30T18:16:00.000Z'),
      appliedRoutes: ['mail.freestonefamily.com', 'mail.ntechr.com']
    };
  };

  oidcService.ensureBootstrapState = async () => ({
    settingsUpdated: [],
    createdClients: [],
    updatedClients: []
  });

  const oidcClient = {
    clientId: 'homebrain-axiom',
    name: 'Axiom',
    platform: 'axiom',
    enabled: true,
    redirectUris: [
      'https://mail.freestonefamily.com/api/identity/homebrain/callback',
      'https://mail.oldexample.com/api/identity/homebrain/callback'
    ],
    scopes: ['openid', 'profile', 'email'],
    requirePkce: true,
    tokenEndpointAuthMethod: 'none',
    saved: false,
    async save() {
      this.saved = true;
      return this;
    }
  };
  OIDCClient.findOne = async () => oidcClient;

  const result = await axiomIngressSyncService.sync({
    actor: 'system:test-sync',
    reason: 'domain-created'
  });

  assert.equal(createdRoutes.length, 1);
  assert.equal(createdRoutes[0].payload.hostname, 'mail.ntechr.com');
  assert.equal(createdRoutes[0].payload.enabled, true);
  assert.equal(createdRoutes[0].payload.notes, 'Managed automatically from Axiom mail domains.');
  assert.equal(createdRoutes[0].actor, 'system:test-sync');

  assert.equal(updatedRoutes.length, 1);
  assert.equal(updatedRoutes[0].routeId, 'route-managed');
  assert.equal(updatedRoutes[0].payload.hostname, 'mail.freestonefamily.com');
  assert.equal(updatedRoutes[0].payload.enabled, true);
  assert.equal(updatedRoutes[0].payload.displayName, 'Axiom');

  assert.deepEqual(deletedRoutes, [
    {
      routeId: 'route-stale',
      actor: 'system:test-sync'
    }
  ]);

  assert.equal(oidcClient.saved, true);
  assert.deepEqual(oidcClient.redirectUris, [
    'https://mail.freestonefamily.com/api/identity/homebrain/callback',
    'https://mail.ntechr.com/api/identity/homebrain/callback'
  ]);

  assert.equal(applyActor, 'system:test-sync');
  assert.deepEqual(result.routes.created, ['mail.ntechr.com']);
  assert.deepEqual(result.routes.updated, ['mail.freestonefamily.com']);
  assert.deepEqual(result.routes.deleted, ['mail.oldexample.com']);
  assert.deepEqual(result.oidc.redirectUris, [
    'https://mail.freestonefamily.com/api/identity/homebrain/callback',
    'https://mail.ntechr.com/api/identity/homebrain/callback'
  ]);
  assert.deepEqual(result.reverseProxy.appliedRoutes, [
    'mail.freestonefamily.com',
    'mail.ntechr.com'
  ]);
});

test('sync creates the default Axiom OIDC client when bootstrap has not seeded it yet', async (t) => {
  const originalFetch = global.fetch;
  const originalFindRoutes = ReverseProxyRoute.find;
  const originalOidcFindOne = OIDCClient.findOne;
  const originalOidcCreate = OIDCClient.create;
  const originalGetRoutePresets = reverseProxyService.getRoutePresets;
  const originalCreateRoute = reverseProxyService.createRoute;
  const originalApplyConfig = reverseProxyService.applyConfig;
  const originalEnsureBootstrapState = oidcService.ensureBootstrapState;

  t.after(() => {
    global.fetch = originalFetch;
    ReverseProxyRoute.find = originalFindRoutes;
    OIDCClient.findOne = originalOidcFindOne;
    OIDCClient.create = originalOidcCreate;
    reverseProxyService.getRoutePresets = originalGetRoutePresets;
    reverseProxyService.createRoute = originalCreateRoute;
    reverseProxyService.applyConfig = originalApplyConfig;
    oidcService.ensureBootstrapState = originalEnsureBootstrapState;
  });

  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        generatedAt: '2026-03-30T18:20:00.000Z',
        mailHosts: ['mail.freestonefamily.com'],
        homeBrainRedirectUris: ['https://mail.freestonefamily.com/api/identity/homebrain/callback']
      };
    }
  });

  ReverseProxyRoute.find = () => ({
    sort: async () => []
  });

  reverseProxyService.getRoutePresets = async () => ([
    {
      platformKey: 'axiom',
      displayName: 'Axiom',
      upstreamProtocol: 'http',
      upstreamHost: '127.0.0.1',
      upstreamPort: 3001,
      healthCheckPath: '/',
      websocketSupport: true,
      tlsMode: 'automatic'
    }
  ]);

  reverseProxyService.createRoute = async (payload) => ({ hostname: payload.hostname });
  reverseProxyService.applyConfig = async () => ({
    appliedAt: new Date('2026-03-30T18:21:00.000Z'),
    appliedRoutes: ['mail.freestonefamily.com']
  });
  oidcService.ensureBootstrapState = async () => ({
    settingsUpdated: ['signingKeys'],
    createdClients: [],
    updatedClients: []
  });

  OIDCClient.findOne = async () => null;

  let createdClient = null;
  OIDCClient.create = async (payload) => {
    createdClient = payload;
    return payload;
  };

  const result = await axiomIngressSyncService.sync({
    actor: 'system:test-create-client',
    reason: 'startup'
  });

  assert.equal(createdClient.clientId, 'homebrain-axiom');
  assert.deepEqual(createdClient.redirectUris, [
    'https://mail.freestonefamily.com/api/identity/homebrain/callback'
  ]);
  assert.equal(createdClient.platform, 'axiom');
  assert.equal(createdClient.requirePkce, true);
  assert.equal(result.oidc.created, true);
});

test('sync rejects an empty Axiom manifest instead of removing managed routes', async (t) => {
  const originalFetch = global.fetch;
  const originalFindRoutes = ReverseProxyRoute.find;

  t.after(() => {
    global.fetch = originalFetch;
    ReverseProxyRoute.find = originalFindRoutes;
  });

  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        generatedAt: '2026-03-30T18:30:00.000Z',
        mailHosts: [],
        homeBrainRedirectUris: []
      };
    }
  });

  let routeLookupAttempted = false;
  ReverseProxyRoute.find = () => {
    routeLookupAttempted = true;
    return {
      sort: async () => []
    };
  };

  await assert.rejects(
    axiomIngressSyncService.sync({
      actor: 'system:test-empty-manifest',
      reason: 'manual'
    }),
    /did not include any mail hosts/
  );

  assert.equal(routeLookupAttempted, false);
});

test('sync fallback keeps the manifest on the API port while creating Axiom routes for the web gateway', async (t) => {
  const servicePath = require.resolve('../services/axiomIngressSyncService');
  const originalFetch = global.fetch;
  const originalFindRoutes = ReverseProxyRoute.find;
  const originalOidcFindOne = OIDCClient.findOne;
  const originalOidcCreate = OIDCClient.create;
  const originalGetRoutePresets = reverseProxyService.getRoutePresets;
  const originalCreateRoute = reverseProxyService.createRoute;
  const originalApplyConfig = reverseProxyService.applyConfig;
  const originalEnsureBootstrapState = oidcService.ensureBootstrapState;
  const originalAxiomUpstreamPort = process.env.AXIOM_UPSTREAM_PORT;
  const originalAxiomApiPort = process.env.AXIOM_API_PORT;
  const originalManifestPort = process.env.AXIOM_HOMEBRAIN_MANIFEST_PORT;

  delete process.env.AXIOM_UPSTREAM_PORT;
  delete process.env.AXIOM_API_PORT;
  delete process.env.AXIOM_HOMEBRAIN_MANIFEST_PORT;
  delete require.cache[servicePath];

  t.after(() => {
    global.fetch = originalFetch;
    ReverseProxyRoute.find = originalFindRoutes;
    OIDCClient.findOne = originalOidcFindOne;
    OIDCClient.create = originalOidcCreate;
    reverseProxyService.getRoutePresets = originalGetRoutePresets;
    reverseProxyService.createRoute = originalCreateRoute;
    reverseProxyService.applyConfig = originalApplyConfig;
    oidcService.ensureBootstrapState = originalEnsureBootstrapState;

    if (typeof originalAxiomUpstreamPort === 'string') {
      process.env.AXIOM_UPSTREAM_PORT = originalAxiomUpstreamPort;
    } else {
      delete process.env.AXIOM_UPSTREAM_PORT;
    }

    if (typeof originalAxiomApiPort === 'string') {
      process.env.AXIOM_API_PORT = originalAxiomApiPort;
    } else {
      delete process.env.AXIOM_API_PORT;
    }

    if (typeof originalManifestPort === 'string') {
      process.env.AXIOM_HOMEBRAIN_MANIFEST_PORT = originalManifestPort;
    } else {
      delete process.env.AXIOM_HOMEBRAIN_MANIFEST_PORT;
    }

    delete require.cache[servicePath];
  });

  const freshAxiomIngressSyncService = require('../services/axiomIngressSyncService');

  let fetchedUrl = '';
  global.fetch = async (url) => {
    fetchedUrl = String(url);
    return {
      ok: true,
      async json() {
        return {
          generatedAt: '2026-03-30T19:00:00.000Z',
          mailHosts: ['mail.freestonefamily.com'],
          homeBrainRedirectUris: ['https://mail.freestonefamily.com/api/identity/homebrain/callback']
        };
      }
    };
  };

  ReverseProxyRoute.find = () => ({
    sort: async () => []
  });

  reverseProxyService.getRoutePresets = async () => [];

  let createdRoute = null;
  reverseProxyService.createRoute = async (payload) => {
    createdRoute = payload;
    return { hostname: payload.hostname };
  };
  reverseProxyService.applyConfig = async () => ({
    appliedAt: new Date('2026-03-30T19:01:00.000Z'),
    appliedRoutes: ['mail.freestonefamily.com']
  });
  oidcService.ensureBootstrapState = async () => ({
    settingsUpdated: [],
    createdClients: [],
    updatedClients: []
  });

  OIDCClient.findOne = async () => null;
  OIDCClient.create = async (payload) => payload;

  await freshAxiomIngressSyncService.sync({
    actor: 'system:test-fallback-ports',
    reason: 'manual'
  });

  assert.equal(fetchedUrl, 'http://127.0.0.1:3001/internal/deployment/homebrain-manifest');
  assert.equal(createdRoute.upstreamHost, '127.0.0.1');
  assert.equal(createdRoute.upstreamPort, 4174);
  assert.equal(createdRoute.healthCheckPath, '/healthz');
});

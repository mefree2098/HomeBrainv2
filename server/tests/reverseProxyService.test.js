const test = require('node:test');
const assert = require('node:assert/strict');

const reverseProxyService = require('../services/reverseProxyService');
const ReverseProxyRoute = require('../models/ReverseProxyRoute');
const ReverseProxySettings = require('../models/ReverseProxySettings');
const ReverseProxyAuditLog = require('../models/ReverseProxyAuditLog');

function createSettings(overrides = {}) {
  return {
    caddyAdminUrl: 'http://127.0.0.1:2019',
    caddyStorageRoot: '/var/lib/caddy',
    acmeEnv: 'staging',
    acmeEmail: 'admin@example.com',
    expectedPublicIp: '',
    expectedPublicIpv6: '',
    onDemandTlsEnabled: false,
    accessLogsEnabled: true,
    adminApiEnabled: true,
    lastAppliedConfigText: '',
    lastAppliedConfigHash: '',
    lastApplyStatus: 'never',
    lastApplyError: '',
    lastAppliedAt: null,
    updatedBy: 'system',
    toObject() {
      return { ...this };
    },
    async save() {
      return this;
    },
    ...overrides
  };
}

test('buildDesiredConfig renders Caddy global options and enabled routes', async (t) => {
  const originalGetSettings = ReverseProxySettings.getSettings;
  const originalFind = ReverseProxyRoute.find;

  t.after(() => {
    ReverseProxySettings.getSettings = originalGetSettings;
    ReverseProxyRoute.find = originalFind;
  });

  ReverseProxySettings.getSettings = async () => createSettings({
    acmeEnv: 'staging',
    onDemandTlsEnabled: true
  });

  ReverseProxyRoute.find = () => ({
    sort: () => ({
      lean: async () => ([
        {
          hostname: 'freestonefamily.com',
          upstreamProtocol: 'http',
          upstreamHost: '127.0.0.1',
          upstreamPort: 3000,
          healthCheckPath: '/ping',
          stripPrefix: '',
          tlsMode: 'automatic',
          websocketSupport: true
        },
        {
          hostname: 'mail.freestonefamily.com',
          upstreamProtocol: 'http',
          upstreamHost: '127.0.0.1',
          upstreamPort: 3001,
          healthCheckPath: '/',
          stripPrefix: '',
          tlsMode: 'on_demand',
          websocketSupport: true
        }
      ])
    })
  });

  const result = await reverseProxyService.buildDesiredConfig();

  assert.match(result.caddyfile, /admin "127\.0\.0\.1:2019"/);
  assert.match(result.caddyfile, /acme_ca "https:\/\/acme-staging-v02\.api\.letsencrypt\.org\/directory"/);
  assert.match(result.caddyfile, /on_demand_tls/);
  assert.match(result.caddyfile, /freestonefamily\.com \{/);
  assert.match(result.caddyfile, /reverse_proxy "http:\/\/127\.0\.0\.1:3000"/);
  assert.match(result.caddyfile, /mail\.freestonefamily\.com \{/);
  assert.match(result.caddyfile, /tls \{\n    on_demand\n  \}/);
});

test('buildDesiredConfig pins production ACME to Let\'s Encrypt', async (t) => {
  const originalGetSettings = ReverseProxySettings.getSettings;
  const originalFind = ReverseProxyRoute.find;

  t.after(() => {
    ReverseProxySettings.getSettings = originalGetSettings;
    ReverseProxyRoute.find = originalFind;
  });

  ReverseProxySettings.getSettings = async () => createSettings({
    acmeEnv: 'production'
  });

  ReverseProxyRoute.find = () => ({
    sort: () => ({
      lean: async () => ([
        {
          hostname: 'freestonefamily.com',
          upstreamProtocol: 'http',
          upstreamHost: '127.0.0.1',
          upstreamPort: 3000,
          healthCheckPath: '/ping',
          stripPrefix: '',
          tlsMode: 'automatic',
          websocketSupport: true
        }
      ])
    })
  });

  const result = await reverseProxyService.buildDesiredConfig();

  assert.match(result.caddyfile, /acme_ca "https:\/\/acme-v02\.api\.letsencrypt\.org\/directory"/);
  assert.doesNotMatch(result.caddyfile, /acme-staging-v02/);
});

test('updateSettings requires confirmation before switching ACME from staging to production', async (t) => {
  const originalGetSettings = ReverseProxySettings.getSettings;
  const originalAuditCreate = ReverseProxyAuditLog.create;

  t.after(() => {
    ReverseProxySettings.getSettings = originalGetSettings;
    ReverseProxyAuditLog.create = originalAuditCreate;
  });

  ReverseProxyAuditLog.create = async () => ({ ok: true });
  ReverseProxySettings.getSettings = async () => createSettings({
    acmeEnv: 'staging'
  });

  await assert.rejects(
    reverseProxyService.updateSettings({ acmeEnv: 'production' }, 'tester@example.com'),
    /requires confirmation/
  );
});

test('canIssueCertificate only allows approved on-demand routes when policy is enabled', async (t) => {
  const originalGetSettings = ReverseProxySettings.getSettings;
  const originalFindOne = ReverseProxyRoute.findOne;

  t.after(() => {
    ReverseProxySettings.getSettings = originalGetSettings;
    ReverseProxyRoute.findOne = originalFindOne;
  });

  ReverseProxySettings.getSettings = async () => createSettings({
    onDemandTlsEnabled: true
  });

  ReverseProxyRoute.findOne = () => ({
    lean: async () => ({
      hostname: 'mail.freestonefamily.com',
      enabled: true,
      tlsMode: 'on_demand',
      allowOnDemandTls: true,
      certificateStatus: {
        ownershipVerified: true,
        adminApproved: false
      }
    })
  });

  const allowed = await reverseProxyService.canIssueCertificate('mail.freestonefamily.com');
  assert.equal(allowed, true);

  ReverseProxyRoute.findOne = () => ({
    lean: async () => ({
      hostname: 'mail.freestonefamily.com',
      enabled: true,
      tlsMode: 'on_demand',
      allowOnDemandTls: false,
      certificateStatus: {
        ownershipVerified: true,
        adminApproved: true
      }
    })
  });

  const denied = await reverseProxyService.canIssueCertificate('mail.freestonefamily.com');
  assert.equal(denied, false);
});

test('ensureBootstrapState backfills settings and creates only missing seeded routes', async (t) => {
  const originalGetSettings = ReverseProxySettings.getSettings;
  const originalFind = ReverseProxyRoute.find;
  const originalAuditCreate = ReverseProxyAuditLog.create;
  const originalCreateRoute = reverseProxyService.createRoute;
  const originalValidateRoute = reverseProxyService.validateRoute;
  const originalAcmeEmail = process.env.CADDY_ACME_EMAIL;
  const originalExpectedPublicIp = process.env.HOMEBRAIN_EXPECTED_PUBLIC_IP;
  const originalPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  const originalPublicHost = process.env.HOMEBRAIN_PUBLIC_HOST;
  const originalAxiomPublicHost = process.env.AXIOM_PUBLIC_HOST;

  t.after(() => {
    ReverseProxySettings.getSettings = originalGetSettings;
    ReverseProxyRoute.find = originalFind;
    ReverseProxyAuditLog.create = originalAuditCreate;
    reverseProxyService.createRoute = originalCreateRoute;
    reverseProxyService.validateRoute = originalValidateRoute;
    process.env.CADDY_ACME_EMAIL = originalAcmeEmail;
    process.env.HOMEBRAIN_EXPECTED_PUBLIC_IP = originalExpectedPublicIp;
    process.env.HOMEBRAIN_PUBLIC_BASE_URL = originalPublicBaseUrl;
    process.env.HOMEBRAIN_PUBLIC_HOST = originalPublicHost;
    process.env.AXIOM_PUBLIC_HOST = originalAxiomPublicHost;
  });

  process.env.CADDY_ACME_EMAIL = 'ops@example.com';
  process.env.HOMEBRAIN_EXPECTED_PUBLIC_IP = '203.0.113.10';
  delete process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  delete process.env.HOMEBRAIN_PUBLIC_HOST;
  delete process.env.AXIOM_PUBLIC_HOST;

  let saved = false;
  ReverseProxySettings.getSettings = async () => createSettings({
    caddyAdminUrl: '',
    caddyStorageRoot: '',
    acmeEmail: '',
    expectedPublicIp: '',
    async save() {
      saved = true;
      return this;
    }
  });

  ReverseProxyRoute.find = async () => ([
    {
      hostname: 'www.freestonefamily.com',
      validationStatus: 'unknown'
    }
  ]);

  ReverseProxyAuditLog.create = async () => ({ ok: true });

  const createdRoutes = [];
  reverseProxyService.createRoute = async (payload) => {
    createdRoutes.push(payload.hostname);
    return { hostname: payload.hostname };
  };

  const revalidatedRoutes = [];
  reverseProxyService.validateRoute = async (route) => {
    revalidatedRoutes.push(route.hostname);
    return { validationStatus: 'valid' };
  };

  const result = await reverseProxyService.ensureBootstrapState({
    actor: 'system:test-bootstrap'
  });

  assert.equal(saved, true);
  assert.deepEqual(
    result.settingsUpdated.sort(),
    ['acmeEmail', 'caddyAdminUrl', 'caddyStorageRoot', 'expectedPublicIp'].sort()
  );
  assert.deepEqual(
    createdRoutes.sort(),
    ['freestonefamily.com', 'mail.freestonefamily.com'].sort()
  );
  assert.deepEqual(revalidatedRoutes, ['www.freestonefamily.com']);
  assert.deepEqual(
    result.createdRoutes.sort(),
    ['freestonefamily.com', 'mail.freestonefamily.com'].sort()
  );
});

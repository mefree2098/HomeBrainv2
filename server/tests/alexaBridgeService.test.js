const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const ReverseProxyRoute = require('../models/ReverseProxyRoute');
const ReverseProxySettings = require('../models/ReverseProxySettings');
const alexaProjectionService = require('../services/alexaProjectionService');
const {
  AlexaBridgeService,
  alexaColorToHex,
  normalizeDirectivePayload
} = require('../services/alexaBridgeService');

test('generateLinkCode issues one-time pairing code and registerBroker consumes it', async (t) => {
  const bridge = new AlexaBridgeService();
  const registration = {
    hubId: 'hub-test-1234',
    status: 'unpaired',
    mode: 'private',
    brokerBaseUrl: '',
    brokerClientId: '',
    brokerDisplayName: '',
    relayTokenHash: '',
    publicOrigin: '',
    pendingLinkCodes: [],
    recentActivity: [],
    async save() {
      return this;
    }
  };

  const originalEnsureBrokerRegistration = alexaProjectionService.ensureBrokerRegistration;
  alexaProjectionService.ensureBrokerRegistration = async () => registration;

  const previousOrigin = process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://hub.example.com';

  t.after(() => {
    alexaProjectionService.ensureBrokerRegistration = originalEnsureBrokerRegistration;
    process.env.HOMEBRAIN_PUBLIC_BASE_URL = previousOrigin;
  });

  const issued = await bridge.generateLinkCode({
    actor: 'admin@example.com',
    mode: 'public',
    ttlMinutes: 10
  });

  assert.match(issued.code, /^HBAX-/);
  assert.equal(registration.pendingLinkCodes.length, 1);
  assert.equal(registration.pendingLinkCodes[0].mode, 'public');

  const registered = await bridge.registerBroker({
    linkCode: issued.code,
    brokerBaseUrl: 'https://broker.example.com/alexa',
    brokerClientId: 'broker-client-1',
    brokerDisplayName: 'HomeBrain Alexa Broker',
    mode: 'public'
  });

  assert.equal(registered.success, true);
  assert.equal(registered.mode, 'public');
  assert.equal(registered.hubId, 'hub-test-1234');
  assert.equal(registration.status, 'paired');
  assert.equal(registration.pendingLinkCodes.length, 0);
  assert.equal(registration.brokerBaseUrl, 'https://broker.example.com');
  assert.equal(registration.publicOrigin, 'https://hub.example.com');
  assert.ok(registration.relayTokenHash);

  await assert.rejects(
    () => bridge.registerBroker({
      linkCode: issued.code,
      brokerBaseUrl: 'https://broker.example.com'
    }),
    /invalid or expired/i
  );
});

test('normalizeDirectivePayload extracts Alexa Smart Home directive details', () => {
  const normalized = normalizeDirectivePayload({
    directive: {
      header: {
        namespace: 'Alexa.PowerController',
        name: 'TurnOn',
        correlationToken: 'abc-123'
      },
      endpoint: {
        endpointId: 'hb:hub-1:device:device-1'
      },
      payload: {}
    }
  });

  assert.equal(normalized.namespace, 'Alexa.PowerController');
  assert.equal(normalized.name, 'TurnOn');
  assert.equal(normalized.endpointId, 'hb:hub-1:device:device-1');
  assert.equal(normalized.correlationToken, 'abc-123');
});

test('alexaColorToHex converts Alexa HSB colors into HomeBrain hex strings', () => {
  assert.equal(alexaColorToHex({
    hue: 0,
    saturation: 1,
    brightness: 1
  }), '#ff0000');

  assert.equal(alexaColorToHex({
    hue: 120,
    saturation: 1,
    brightness: 1
  }), '#00ff00');
});

test('getBrokerDeliveryStatus and flushBrokerEvents proxy broker delivery state through relay auth', async (t) => {
  const bridge = new AlexaBridgeService();
  const brokerCalls = [];
  const brokerServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = chunks.length > 0
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : null;

    brokerCalls.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      hubId: req.headers['x-homebrain-hub-id'],
      body
    });

    if (req.url === '/api/alexa/events?hubId=hub-test-1234' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        events: [
          { eventId: 'evt-1', kind: 'change_report', status: 'queued', createdAt: '2026-04-01T12:00:00.000Z' },
          { eventId: 'evt-2', kind: 'add_or_update_report', status: 'delivered', createdAt: '2026-04-01T11:00:00.000Z', deliveredAt: '2026-04-01T11:00:10.000Z' }
        ],
        permissionGrants: [
          { permissionGrantId: 'grant-1', brokerAccountId: 'acct-1', status: 'active', eventRegion: 'NA', lastRefreshedAt: '2026-04-01T10:00:00.000Z' }
        ]
      }));
      return;
    }

    if (req.url === '/api/alexa/events/flush' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        processed: 3
      }));
      return;
    }

    if (req.url === '/api/alexa/households/acct-1/discovery-sync' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        brokerAccountId: 'acct-1',
        queued: 2
      }));
      return;
    }

    if (req.url === '/api/alexa/households/acct-1/revoke' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        account: {
          brokerAccountId: 'acct-1',
          status: 'revoked'
        }
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: 'Not found'
    }));
  });

  await new Promise((resolve) => brokerServer.listen(0, '127.0.0.1', resolve));
  const brokerAddress = brokerServer.address();
  const registration = {
    hubId: 'hub-test-1234',
    status: 'paired',
    mode: 'private',
    brokerBaseUrl: `http://127.0.0.1:${brokerAddress.port}`,
    brokerClientId: 'broker-client-1',
    brokerDisplayName: 'HomeBrain Alexa Broker',
    relayToken: 'relay-token-1',
    relayTokenHash: 'ignored-in-test',
    publicOrigin: 'https://hub.example.com',
    pendingLinkCodes: [],
    recentActivity: [],
    async save() {
      return this;
    }
  };

  const originalEnsureBrokerRegistration = alexaProjectionService.ensureBrokerRegistration;

  alexaProjectionService.ensureBrokerRegistration = async () => registration;

  t.after(() => {
    alexaProjectionService.ensureBrokerRegistration = originalEnsureBrokerRegistration;
    brokerServer.close();
  });

  const delivery = await bridge.getBrokerDeliveryStatus();
  assert.equal(delivery.available, true);
  assert.equal(delivery.queuedCount, 1);
  assert.equal(delivery.deliveredCount, 1);
  assert.equal(delivery.activeGrantCount, 1);

  const flush = await bridge.flushBrokerEvents(10);
  assert.equal(flush.success, true);
  assert.equal(flush.processed, 3);

  const discoverySync = await bridge.syncBrokerDiscoveryForAccount('acct-1');
  assert.equal(discoverySync.success, true);
  assert.equal(discoverySync.queued, 2);

  const revoke = await bridge.revokeBrokerAccount('acct-1', 'test revoke');
  assert.equal(revoke.success, true);
  assert.equal(revoke.account.status, 'revoked');

  assert.equal(brokerCalls.length, 4);
  assert.equal(brokerCalls[0].authorization, 'Bearer relay-token-1');
  assert.equal(brokerCalls[1].hubId, 'hub-test-1234');
  assert.equal(brokerCalls[2].url, '/api/alexa/households/acct-1/discovery-sync');
  assert.equal(brokerCalls[3].url, '/api/alexa/households/acct-1/revoke');
});

test('getCertificationReadiness summarizes public-release blockers and passes', async (t) => {
  const bridge = new AlexaBridgeService();
  const registration = {
    hubId: 'hub-prod-1',
    status: 'paired',
    mode: 'public',
    brokerBaseUrl: 'https://broker.example.com',
    proactiveEventsEnabled: true,
    publicOrigin: 'https://hub.example.com',
    async save() {
      return this;
    }
  };

  const originalEnsureBrokerRegistration = alexaProjectionService.ensureBrokerRegistration;
  const originalGetSettings = ReverseProxySettings.getSettings;
  const originalFindOne = ReverseProxyRoute.findOne;

  alexaProjectionService.ensureBrokerRegistration = async () => registration;
  ReverseProxySettings.getSettings = async () => ({ acmeEnv: 'production' });
  ReverseProxyRoute.findOne = () => ({
    lean: async () => ({
      hostname: 'hub.example.com',
      enabled: true,
      validationStatus: 'valid',
      validation: {
        blockingErrors: [],
        warnings: []
      },
      certificateStatus: {
        status: 'issued',
        automaticTlsEligible: true,
        dnsReady: true,
        renewalState: 'healthy',
        servedIssuer: 'Let\'s Encrypt',
        servedSubject: 'hub.example.com',
        servedNotAfter: '2026-12-31T00:00:00.000Z',
        lastError: ''
      }
    })
  });

  t.after(() => {
    alexaProjectionService.ensureBrokerRegistration = originalEnsureBrokerRegistration;
    ReverseProxySettings.getSettings = originalGetSettings;
    ReverseProxyRoute.findOne = originalFindOne;
  });

  const readiness = await bridge.getCertificationReadiness({
    registration,
    linkedAccounts: [{ brokerAccountId: 'acct-1' }],
    brokerDelivery: { activeGrantCount: 1 }
  });

  assert.equal(readiness.status, 'pass');
  assert.equal(readiness.reverseProxy.hostname, 'hub.example.com');
  assert.equal(readiness.certificate.status, 'issued');
  assert.ok(readiness.checks.some((entry) => entry.key === 'tls_certificate' && entry.status === 'pass'));
});

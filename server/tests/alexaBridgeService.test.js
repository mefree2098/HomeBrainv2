const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const axios = require('axios');

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

test('link codes are consumed case-insensitively for mobile account-link flows', async (t) => {
  const bridge = new AlexaBridgeService();
  const registration = {
    hubId: 'hub-mobile-1',
    status: 'paired',
    mode: 'public',
    brokerBaseUrl: 'https://broker.example.com',
    brokerClientId: 'broker-client-1',
    brokerDisplayName: 'HomeBrain Alexa Broker',
    relayToken: 'relay-token-1',
    relayTokenHash: 'ignored-in-test',
    publicOrigin: 'https://hub.example.com',
    pendingLinkCodes: [],
    recentActivity: [],
    lastSeenAt: null,
    async save() {
      return this;
    }
  };

  const originalEnsureBrokerRegistration = alexaProjectionService.ensureBrokerRegistration;
  alexaProjectionService.ensureBrokerRegistration = async () => registration;

  t.after(() => {
    alexaProjectionService.ensureBrokerRegistration = originalEnsureBrokerRegistration;
  });

  const issued = await bridge.generateLinkCode({
    actor: 'mobile-user',
    mode: 'public',
    ttlMinutes: 10
  });

  const consumed = await bridge.consumeLinkCodeForAccountLinking(issued.code.toLowerCase(), {
    brokerClientId: 'homebrain-alexa-skill',
    actor: 'alexa_oauth'
  });

  assert.equal(consumed.success, true);
  assert.equal(consumed.mode, 'public');
  assert.equal(registration.pendingLinkCodes.length, 0);
});

test('link codes are consumed when separators are omitted', async (t) => {
  const bridge = new AlexaBridgeService();
  const registration = {
    hubId: 'hub-mobile-2',
    status: 'paired',
    mode: 'public',
    brokerBaseUrl: 'https://broker.example.com',
    brokerClientId: 'broker-client-1',
    brokerDisplayName: 'HomeBrain Alexa Broker',
    relayToken: 'relay-token-2',
    relayTokenHash: 'ignored-in-test',
    publicOrigin: 'https://hub.example.com',
    pendingLinkCodes: [],
    recentActivity: [],
    lastSeenAt: null,
    async save() {
      return this;
    }
  };

  const originalEnsureBrokerRegistration = alexaProjectionService.ensureBrokerRegistration;
  alexaProjectionService.ensureBrokerRegistration = async () => registration;

  t.after(() => {
    alexaProjectionService.ensureBrokerRegistration = originalEnsureBrokerRegistration;
  });

  const issued = await bridge.generateLinkCode({
    actor: 'mobile-user',
    mode: 'public',
    ttlMinutes: 10
  });

  const condensedCode = issued.code.replace(/-/g, '').toLowerCase();
  const consumed = await bridge.consumeLinkCodeForAccountLinking(condensedCode, {
    brokerClientId: 'homebrain-alexa-skill',
    actor: 'alexa_oauth'
  });

  assert.equal(consumed.success, true);
  assert.equal(consumed.mode, 'public');
  assert.equal(registration.pendingLinkCodes.length, 0);
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

test('normalizeDirectivePayload accepts a raw Alexa directive object', () => {
  const normalized = normalizeDirectivePayload({
    header: {
      namespace: 'Alexa.PowerController',
      name: 'TurnOn',
      correlationToken: 'raw-123'
    },
    endpoint: {
      endpointId: 'hb:hub-1:device:device-9'
    },
    payload: {}
  });

  assert.equal(normalized.namespace, 'Alexa.PowerController');
  assert.equal(normalized.name, 'TurnOn');
  assert.equal(normalized.endpointId, 'hb:hub-1:device:device-9');
  assert.equal(normalized.correlationToken, 'raw-123');
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

test('executeDirective uses fast Harmony power control for Alexa responses', async (t) => {
  const bridge = new AlexaBridgeService();
  const deviceService = require('../services/deviceService');

  const originalGetCatalogEntryByEndpointId = alexaProjectionService.getCatalogEntryByEndpointId;
  const originalGetStateForEndpoint = alexaProjectionService.getStateForEndpoint;
  const originalControlDevice = deviceService.controlDevice;

  t.after(() => {
    alexaProjectionService.getCatalogEntryByEndpointId = originalGetCatalogEntryByEndpointId;
    alexaProjectionService.getStateForEndpoint = originalGetStateForEndpoint;
    deviceService.controlDevice = originalControlDevice;
  });

  alexaProjectionService.getCatalogEntryByEndpointId = async () => ({
    exposure: {
      entityType: 'device',
      entityId: 'device-harmony-1'
    },
    entity: {
      _id: 'device-harmony-1',
      type: 'switch',
      properties: {
        source: 'harmony',
        harmonyHubIp: '192.168.1.50',
        harmonyActivityId: '123456'
      }
    },
    validationErrors: [],
    endpoint: {
      state: {
        properties: []
      }
    }
  });
  alexaProjectionService.getStateForEndpoint = async () => ({
    properties: [],
    connectivity: 'OK'
  });

  let receivedCall = null;
  deviceService.controlDevice = async (...args) => {
    receivedCall = args;
    return {
      _id: 'device-harmony-1',
      status: true,
      isOnline: true
    };
  };

  const result = await bridge.executeDirective({
    directive: {
      header: {
        namespace: 'Alexa.PowerController',
        name: 'TurnOn',
        correlationToken: 'corr-1'
      },
      endpoint: {
        endpointId: 'hb:hub-1:device:device-harmony-1'
      },
      payload: {}
    }
  });

  assert.equal(result.success, true);
  assert.deepEqual(receivedCall, [
    'device-harmony-1',
    'turn_on',
    undefined,
    {
      command: {
        source: 'alexa',
        triggerSource: 'alexa',
        reason: 'Alexa directive Alexa.PowerController.TurnOn',
        actor: 'alexa',
        correlationId: null
      },
      skipIntegrationRefresh: true,
      skipPostActionVerification: true
    }
  ]);
});

test('executeDirective acknowledges Alexa workflow scenes without waiting for the workflow timer to finish', async (t) => {
  const bridge = new AlexaBridgeService();
  const workflowService = require('../services/workflowService');

  const originalGetCatalogEntryByEndpointId = alexaProjectionService.getCatalogEntryByEndpointId;
  const originalGetStateForEndpoint = alexaProjectionService.getStateForEndpoint;
  const originalExecuteWorkflow = workflowService.executeWorkflow;

  t.after(() => {
    alexaProjectionService.getCatalogEntryByEndpointId = originalGetCatalogEntryByEndpointId;
    alexaProjectionService.getStateForEndpoint = originalGetStateForEndpoint;
    workflowService.executeWorkflow = originalExecuteWorkflow;
  });

  alexaProjectionService.getCatalogEntryByEndpointId = async () => ({
    exposure: {
      entityType: 'workflow',
      entityId: 'workflow-night-tv-1'
    },
    entity: {
      _id: 'workflow-night-tv-1',
      name: 'Night TV',
      trigger: {
        type: 'manual'
      },
      actions: [
        { type: 'device_control', target: 'device-harmony-1', parameters: { action: 'turn_on' } },
        { type: 'delay', parameters: { seconds: 5400 } }
      ]
    },
    validationErrors: [],
    endpoint: {
      displayCategories: ['ACTIVITY_TRIGGER'],
      state: {
        properties: []
      }
    }
  });
  alexaProjectionService.getStateForEndpoint = async () => {
    throw new Error('Alexa workflow scenes should not fetch endpoint state for ActivationStarted responses');
  };

  let receivedCall = null;
  workflowService.executeWorkflow = (...args) => {
    receivedCall = args;
    return new Promise(() => {});
  };

  const result = await bridge.executeDirective({
    directive: {
      header: {
        namespace: 'Alexa.SceneController',
        name: 'Activate',
        correlationToken: 'scene-corr-1'
      },
      endpoint: {
        endpointId: 'hb:hub-1:workflow:workflow-night-tv-1'
      },
      payload: {}
    }
  });

  assert.equal(result.success, true);
  assert.equal(result.namespace, 'Alexa.SceneController');
  assert.equal(result.name, 'Activate');
  assert.deepEqual(result.properties, []);
  assert.deepEqual(receivedCall, [
    'workflow-night-tv-1',
    {
      triggerType: 'manual',
      triggerSource: 'alexa',
      context: {
        source: 'alexa',
        endpointId: 'hb:hub-1:workflow:workflow-night-tv-1'
      }
    }
  ]);
});

test('executeDirective acknowledges Alexa scene endpoints without waiting for scene actions', async (t) => {
  const bridge = new AlexaBridgeService();
  const sceneService = require('../services/sceneService');

  const originalGetCatalogEntryByEndpointId = alexaProjectionService.getCatalogEntryByEndpointId;
  const originalGetStateForEndpoint = alexaProjectionService.getStateForEndpoint;
  const originalActivateScene = sceneService.activateScene;

  t.after(() => {
    alexaProjectionService.getCatalogEntryByEndpointId = originalGetCatalogEntryByEndpointId;
    alexaProjectionService.getStateForEndpoint = originalGetStateForEndpoint;
    sceneService.activateScene = originalActivateScene;
  });

  alexaProjectionService.getCatalogEntryByEndpointId = async () => ({
    exposure: {
      entityType: 'scene',
      entityId: 'scene-stars-only-1'
    },
    entity: {
      _id: 'scene-stars-only-1',
      name: 'Stars Only'
    },
    validationErrors: [],
    endpoint: {
      state: {
        properties: []
      }
    }
  });
  alexaProjectionService.getStateForEndpoint = async () => {
    throw new Error('Alexa scene activation responses should not fetch endpoint state');
  };

  let receivedCall = null;
  sceneService.activateScene = (...args) => {
    receivedCall = args;
    return new Promise(() => {});
  };

  const result = await bridge.executeDirective({
    directive: {
      header: {
        namespace: 'Alexa.SceneController',
        name: 'Activate',
        correlationToken: 'scene-corr-activate'
      },
      endpoint: {
        endpointId: 'hb:hub-1:scene:scene-stars-only-1'
      },
      payload: {}
    }
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.success, true);
  assert.equal(result.namespace, 'Alexa.SceneController');
  assert.equal(result.name, 'Activate');
  assert.deepEqual(result.properties, []);
  assert.deepEqual(receivedCall, [
    'scene-stars-only-1',
    {
      command: {
        source: 'alexa',
        triggerSource: 'alexa',
        reason: 'Alexa scene activation',
        actor: 'alexa',
        correlationId: 'scene-corr-activate'
      },
      waitForCompletion: false
    }
  ]);
});

test('executeDirective deactivates Alexa scene endpoints', async (t) => {
  const bridge = new AlexaBridgeService();
  const sceneService = require('../services/sceneService');

  const originalGetCatalogEntryByEndpointId = alexaProjectionService.getCatalogEntryByEndpointId;
  const originalGetStateForEndpoint = alexaProjectionService.getStateForEndpoint;
  const originalDeactivateScene = sceneService.deactivateScene;

  t.after(() => {
    alexaProjectionService.getCatalogEntryByEndpointId = originalGetCatalogEntryByEndpointId;
    alexaProjectionService.getStateForEndpoint = originalGetStateForEndpoint;
    sceneService.deactivateScene = originalDeactivateScene;
  });

  alexaProjectionService.getCatalogEntryByEndpointId = async () => ({
    exposure: {
      entityType: 'scene',
      entityId: 'scene-movie-night-1'
    },
    entity: {
      _id: 'scene-movie-night-1',
      name: 'Movie Night'
    },
    validationErrors: [],
    endpoint: {
      state: {
        properties: []
      }
    }
  });
  alexaProjectionService.getStateForEndpoint = async () => {
    throw new Error('Alexa scene deactivation responses should not fetch endpoint state');
  };

  let receivedCall = null;
  sceneService.deactivateScene = async (...args) => {
    receivedCall = args;
    return {
      scene: {
        _id: 'scene-movie-night-1',
        name: 'Movie Night'
      },
      message: 'Scene deactivated'
    };
  };

  const result = await bridge.executeDirective({
    directive: {
      header: {
        namespace: 'Alexa.SceneController',
        name: 'Deactivate',
        correlationToken: 'scene-corr-2'
      },
      endpoint: {
        endpointId: 'hb:hub-1:scene:scene-movie-night-1'
      },
      payload: {}
    }
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.success, true);
  assert.equal(result.namespace, 'Alexa.SceneController');
  assert.equal(result.name, 'Deactivate');
  assert.deepEqual(result.properties, []);
  assert.deepEqual(receivedCall, [
    'scene-movie-night-1',
    {
      command: {
        source: 'alexa',
        triggerSource: 'alexa',
        reason: 'Alexa scene deactivation',
        actor: 'alexa',
        correlationId: 'scene-corr-2'
      }
    }
  ]);
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

test('notifyBroker re-pairs broker registration and retries when broker lost the hub', async (t) => {
  const bridge = new AlexaBridgeService();
  let statePushCount = 0;
  let recoveryCount = 0;
  const brokerServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    if (req.url === '/api/alexa/hubs/state' && req.method === 'POST') {
      statePushCount += 1;
      assert.equal(req.headers.authorization, 'Bearer relay-token-1');
      assert.equal(req.headers['x-homebrain-hub-id'], 'hub-test-1234');

      if (statePushCount === 1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: 'Hub is not registered'
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        state: {
          states: [],
          updatedAt: '2026-04-01T12:00:00.000Z'
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
    mode: 'public',
    brokerBaseUrl: `http://127.0.0.1:${brokerAddress.port}`,
    brokerClientId: 'homebrain-alexa-skill',
    brokerDisplayName: 'HomeBrain Alexa Broker',
    relayToken: 'relay-token-1',
    relayTokenHash: 'ignored-in-test',
    publicOrigin: 'https://hub.example.com',
    pendingLinkCodes: [],
    recentActivity: [],
    lastStateSyncStatus: 'never',
    async save() {
      return this;
    }
  };

  const originalEnsureBrokerRegistration = alexaProjectionService.ensureBrokerRegistration;
  const originalRecoverBrokerRegistration = bridge.recoverBrokerRegistration.bind(bridge);

  alexaProjectionService.ensureBrokerRegistration = async () => registration;
  bridge.recoverBrokerRegistration = async (options) => {
    recoveryCount += 1;
    assert.equal(options.source, 'state_sync');
    assert.match(options.reason, /not registered/i);
    return {
      success: true,
      repaired: true
    };
  };

  t.after(() => {
    alexaProjectionService.ensureBrokerRegistration = originalEnsureBrokerRegistration;
    bridge.recoverBrokerRegistration = originalRecoverBrokerRegistration;
    brokerServer.close();
  });

  const result = await bridge.notifyBroker('/api/alexa/hubs/state', {
    hubId: registration.hubId,
    states: []
  }, {
    kind: 'state',
    type: 'state_sync'
  });

  assert.equal(result.success, true);
  assert.equal(result.recovered, true);
  assert.equal(recoveryCount, 1);
  assert.equal(statePushCount, 2);
  assert.equal(registration.lastStateSyncStatus, 'success');
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

test('pairWithBroker preserves the requested broker control URL after registration', async (t) => {
  const bridge = new AlexaBridgeService();
  const originalGetSummary = bridge.getSummary.bind(bridge);
  const registration = {
    hubId: 'hub-local-pair',
    status: 'paired',
    mode: 'public',
    brokerBaseUrl: 'https://alexa-broker.example.com',
    brokerClientId: 'homebrain-alexa-skill',
    brokerDisplayName: 'HomeBrain Alexa Broker',
    relayToken: 'relay-token',
    relayTokenHash: 'relay-token-hash',
    publicOrigin: 'https://hub.example.com',
    pendingLinkCodes: [],
    recentActivity: [],
    lastSeenAt: null,
    async save() {
      return this;
    }
  };

  const originalEnsureBrokerRegistration = alexaProjectionService.ensureBrokerRegistration;
  const previousOrigin = process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  const previousAxiosPost = axios.post;

  alexaProjectionService.ensureBrokerRegistration = async () => registration;
  bridge.getSummary = async () => ({
    hubId: registration.hubId,
    brokerBaseUrl: registration.brokerBaseUrl,
    status: registration.status,
    mode: registration.mode
  });
  process.env.HOMEBRAIN_PUBLIC_BASE_URL = 'https://hub.example.com';
  axios.post = async (url, body) => {
    assert.equal(url, 'http://127.0.0.1:4301/api/alexa/hubs/register');
    assert.equal(body.hubBaseUrl, 'https://hub.example.com');
    assert.equal(body.linkCode, 'HBAX-LOCAL-PAIR');

    // Simulate the broker callback path having already overwritten the stored
    // broker URL with its public origin before pairWithBroker resumes locally.
    registration.brokerBaseUrl = 'https://alexa-broker.example.com';

    return {
      data: {
        success: true,
        hub: {
          hubId: registration.hubId
        }
      }
    };
  };

  t.after(() => {
    alexaProjectionService.ensureBrokerRegistration = originalEnsureBrokerRegistration;
    bridge.getSummary = originalGetSummary;
    process.env.HOMEBRAIN_PUBLIC_BASE_URL = previousOrigin;
    axios.post = previousAxiosPost;
  });

  const result = await bridge.pairWithBroker({
    brokerBaseUrl: 'http://127.0.0.1:4301',
    linkCode: 'HBAX-LOCAL-PAIR',
    mode: 'public',
    brokerClientId: 'homebrain-alexa-skill'
  });

  assert.equal(result.success, true);
  assert.equal(registration.brokerBaseUrl, 'http://127.0.0.1:4301');
});

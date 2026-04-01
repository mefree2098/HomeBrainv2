const test = require('node:test');
const assert = require('node:assert/strict');

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

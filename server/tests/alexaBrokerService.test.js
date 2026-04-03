const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AlexaBrokerService,
  buildLocalBaseUrl,
  parseListInput
} = require('../services/alexaBrokerService');

test('buildLocalBaseUrl uses loopback when broker binds all interfaces', () => {
  assert.equal(buildLocalBaseUrl('0.0.0.0', 4301), 'http://127.0.0.1:4301');
  assert.equal(buildLocalBaseUrl('::', 4301), 'http://127.0.0.1:4301');
  assert.equal(buildLocalBaseUrl('127.0.0.1', 4301), 'http://127.0.0.1:4301');
});

test('parseListInput accepts newline and comma separated values and deduplicates them', () => {
  assert.deepEqual(
    parseListInput('alpha\nbeta, gamma\nalpha'),
    ['alpha', 'beta', 'gamma']
  );
});

test('buildRuntimeEnv serializes managed Alexa broker configuration', () => {
  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });

  const env = service.buildRuntimeEnv({
    servicePort: 4301,
    bindHost: '127.0.0.1',
    publicBaseUrl: 'https://alexa-broker.example.com',
    displayName: 'Managed Alexa Broker',
    oauthClientId: 'homebrain-alexa-skill',
    oauthClientSecret: 'super-secret',
    allowedClientIds: ['homebrain-alexa-skill', 'alt-client'],
    allowedRedirectUris: ['https://pitangui.amazon.com/api/skill/link/1'],
    eventClientId: 'event-client-id',
    eventClientSecret: 'event-client-secret',
    storeFile: '/var/lib/homebrain-alexa/store.json',
    authCodeTtlMs: 300000,
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 15552000,
    lwaTokenUrl: 'https://api.amazon.com/auth/o2/token',
    eventGatewayUrl: 'https://api.amazonalexa.com/v3/events',
    rateLimitWindowMs: 60000,
    rateLimitMax: 120,
    allowManualRegistration: true
  });

  assert.equal(env.PORT, '4301');
  assert.equal(env.HOMEBRAIN_BROKER_BIND_HOST, '127.0.0.1');
  assert.equal(env.HOMEBRAIN_BROKER_PUBLIC_BASE_URL, 'https://alexa-broker.example.com');
  assert.equal(env.HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET, 'super-secret');
  assert.equal(env.HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS, 'homebrain-alexa-skill,alt-client');
  assert.equal(
    env.HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS,
    'https://pitangui.amazon.com/api/skill/link/1'
  );
  assert.equal(env.HOMEBRAIN_ALEXA_ALLOW_MANUAL_REGISTRATION, 'true');
});

test('buildManagedReverseProxyRoutePayload derives the managed broker ingress route', () => {
  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });

  const payload = service.buildManagedReverseProxyRoutePayload({
    publicBaseUrl: 'https://alexa-broker.example.com/oauth/callback',
    bindHost: '0.0.0.0',
    servicePort: 4301,
    displayName: 'Managed Alexa Broker'
  });

  assert.deepEqual(payload, {
    hostname: 'alexa-broker.example.com',
    platformKey: 'alexa-broker',
    displayName: 'Managed Alexa Broker',
    upstreamProtocol: 'http',
    upstreamHost: '127.0.0.1',
    upstreamPort: 4301,
    enabled: true,
    tlsMode: 'automatic',
    allowOnDemandTls: false,
    healthCheckPath: '/health',
    websocketSupport: false,
    notes: 'Managed automatically by the HomeBrain Alexa Broker deployment flow.'
  });
});

test('prepareForHostRestart preserves managed broker runtime state across host restarts', async () => {
  const config = {
    resumeAfterHostRestart: false,
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
    }
  };
  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test',
    configModel: {
      getConfig: async () => config
    }
  });

  service.child = {
    exitCode: null,
    killed: false
  };

  const result = await service.prepareForHostRestart();

  assert.equal(result.shouldResume, true);
  assert.equal(config.resumeAfterHostRestart, true);
  assert.ok(config.saveCalls >= 1);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AlexaBrokerService,
  buildLocalBaseUrl,
  parseListInput
} = require('../services/alexaBrokerService');
const AlexaBrokerConfig = require('../models/AlexaBrokerConfig');

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
    alexaCommandProvider: 'homebrain',
    alexaCommandDefaultType: 'announce',
    alexaCommandLocale: 'en-US',
    alexaCommandAmazonPage: 'amazon.com',
    alexaCommandServiceHost: 'pitangui.amazon.com',
    alexaCommandSessionCookie: 'session-cookie',
    alexaCommandSessionData: '',
    alexaCommandTargets: [{
      key: 'kitchen',
      alexaDeviceId: 'kitchen-echo-serial',
      displayName: 'Kitchen Alexa',
      room: 'Kitchen'
    }],
    alexaCommandTimeoutMs: 10000,
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
  assert.equal(env.HOMEBRAIN_ALEXA_COMMAND_PROVIDER, 'homebrain');
  assert.equal(env.HOMEBRAIN_ALEXA_COMMAND_DEFAULT_TYPE, 'announce');
  assert.equal(env.HOMEBRAIN_ALEXA_COMMAND_SESSION_COOKIE, 'session-cookie');
  assert.equal(env.HOMEBRAIN_ALEXA_COMMAND_SERVICE_HOST, 'pitangui.amazon.com');
  assert.equal(env.HOMEBRAIN_ALEXA_COMMAND_TIMEOUT_MS, '10000');
  assert.deepEqual(JSON.parse(env.HOMEBRAIN_ALEXA_COMMAND_TARGETS_JSON), [{
    key: 'kitchen',
    alexaDeviceId: 'kitchen-echo-serial',
    displayName: 'Kitchen Alexa',
    room: 'Kitchen',
    enabled: true
  }]);
  assert.equal(
    env.HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS,
    'https://pitangui.amazon.com/api/skill/link/1'
  );
  assert.equal(env.HOMEBRAIN_ALEXA_ALLOW_MANUAL_REGISTRATION, 'true');
});

test('updateConfig stores managed HomeBrain Alexa command bridge settings', async () => {
  const config = {
    alexaCommandProvider: 'disabled',
    alexaCommandDefaultType: 'announce',
    alexaCommandLocale: 'en-US',
    alexaCommandAmazonPage: 'amazon.com',
    alexaCommandServiceHost: 'pitangui.amazon.com',
    alexaCommandSessionCookie: 'old-cookie',
    alexaCommandSessionData: '',
    alexaCommandTargets: [],
    alexaCommandTimeoutMs: 10000,
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
    }
  };

  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });

  service.getConfig = async () => config;
  service.getStatus = async () => ({
    alexaCommandProvider: config.alexaCommandProvider,
    alexaCommandSessionConfigured: Boolean(config.alexaCommandSessionCookie || config.alexaCommandSessionData)
  });

  const response = await service.updateConfig({
    alexaCommandProvider: 'homebrain',
    alexaCommandDefaultType: 'speak',
    alexaCommandLocale: 'en-US',
    alexaCommandAmazonPage: 'amazon.com',
    alexaCommandServiceHost: 'pitangui.amazon.com',
    alexaCommandSessionCookie: 'new-cookie',
    alexaCommandTargets: 'kitchen = kitchen-echo-serial | Kitchen Alexa | Kitchen',
    alexaCommandTimeoutMs: '2500'
  });

  assert.equal(response.success, true);
  assert.equal(config.alexaCommandProvider, 'homebrain');
  assert.equal(config.alexaCommandDefaultType, 'speak');
  assert.equal(config.alexaCommandSessionCookie, 'new-cookie');
  assert.deepEqual(config.alexaCommandTargets, [{
    key: 'kitchen',
    alexaDeviceId: 'kitchen-echo-serial',
    displayName: 'Kitchen Alexa',
    room: 'Kitchen',
    enabled: true
  }]);
  assert.equal(config.alexaCommandTimeoutMs, 2500);
  assert.equal(config.saveCalls, 1);

  await service.updateConfig({
    alexaCommandSessionCookie: '********okie'
  });

  assert.equal(config.alexaCommandSessionCookie, 'new-cookie');
});

test('AlexaBrokerConfig sanitized output omits legacy generic device provider settings', () => {
  const config = new AlexaBrokerConfig({
    alexaCommandProvider: 'homebrain'
  });
  config.set('deviceServiceBaseUrl', 'https://legacy-provider.example.com', { strict: false });
  config.set('deviceServiceToken', 'legacy-secret', { strict: false });
  config.set('deviceDiscoveryPath', '/v1/devices', { strict: false });
  config.set('deviceSpeakPath', '/v1/devices/{deviceId}/speak', { strict: false });
  config.set('deviceServiceTimeoutMs', 10000, { strict: false });

  const sanitized = config.toSanitized();

  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'deviceServiceBaseUrl'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'deviceServiceToken'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'deviceDiscoveryPath'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'deviceSpeakPath'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'deviceServiceTimeoutMs'), false);
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

test('deployService starts the broker before applying the managed reverse proxy route', async () => {
  const calls = [];
  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });

  service.getConfig = async () => ({
    isInstalled: true,
    publicBaseUrl: 'https://alexa-broker.example.com',
    bindHost: '127.0.0.1',
    servicePort: 4301
  });
  service.install = async () => {
    calls.push('install');
    return { success: true };
  };
  service.isChildAlive = () => false;
  service.startService = async () => {
    calls.push('start');
    return { status: { serviceStatus: 'running' } };
  };
  service.restartService = async () => {
    calls.push('restart');
    return { status: { serviceStatus: 'running' } };
  };
  service.ensureManagedReverseProxyRoute = async () => {
    calls.push('route');
    return { success: true };
  };

  await service.deployService({ actor: 'test', installDependencies: false });

  assert.deepEqual(calls, ['start', 'route']);
});

test('getStatus clears stale lastError once the broker is healthy again', async () => {
  const config = {
    isInstalled: true,
    serviceStatus: 'error',
    servicePid: 1234,
    serviceOwner: 'matt',
    servicePort: 4301,
    bindHost: '127.0.0.1',
    lastError: {
      message: 'Old failure',
      timestamp: new Date('2026-04-04T18:00:00.000Z')
    },
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
    },
    toSanitized() {
      return {
        isInstalled: this.isInstalled,
        serviceStatus: this.serviceStatus,
        servicePid: this.servicePid,
        serviceOwner: this.serviceOwner,
        servicePort: this.servicePort,
        bindHost: this.bindHost,
        lastError: this.lastError
      };
    }
  };

  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test',
    configModel: {
      getConfig: async () => config
    }
  });

  service.getConfig = async () => config;
  service.probeHealth = async () => ({
    available: true,
    localBaseUrl: 'http://127.0.0.1:4301',
    health: { ok: true },
    message: ''
  });
  service.findManagedReverseProxyRoute = async () => null;
  service.child = {
    pid: 4321,
    exitCode: null,
    killed: false
  };

  const status = await service.getStatus();

  assert.equal(status.serviceStatus, 'running');
  assert.equal(status.lastError, null);
  assert.equal(config.lastError, null);
  assert.ok(config.saveCalls >= 1);
});

test('runMonitorPass starts the broker automatically when it is offline and auto recovery is enabled', async () => {
  const config = {
    isInstalled: true,
    autoStart: true,
    resumeAfterHostRestart: false,
    manualStopRequested: false,
    serviceStatus: 'stopped'
  };

  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });

  let startOptions = null;
  service.getConfig = async () => config;
  service.probeHealth = async () => ({
    available: false,
    localBaseUrl: 'http://127.0.0.1:4301',
    health: null,
    message: 'connect ECONNREFUSED 127.0.0.1:4301'
  });
  service.isChildAlive = () => false;
  service.startService = async (options = {}) => {
    startOptions = options;
    return { success: true };
  };

  await service.runMonitorPass({ trigger: 'test' });

  assert.equal(startOptions?.automatic, true);
  assert.equal(startOptions?.actor, 'system:auto-recovery');
  assert.match(startOptions?.reason || '', /ECONNREFUSED/);
});

test('runMonitorPass schedules a short retry when automatic recovery fails', async () => {
  const config = {
    isInstalled: true,
    autoStart: true,
    resumeAfterHostRestart: false,
    manualStopRequested: false,
    serviceStatus: 'stopped'
  };

  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });

  let retryOptions = null;
  service.getConfig = async () => config;
  service.probeHealth = async () => ({
    available: false,
    localBaseUrl: 'http://127.0.0.1:4301',
    health: null,
    message: 'connect ECONNREFUSED 127.0.0.1:4301'
  });
  service.isChildAlive = () => false;
  service.startService = async () => {
    throw new Error('Alexa broker stopped before it became healthy');
  };
  service.scheduleRecoveryAttempt = (options = {}) => {
    retryOptions = options;
  };

  await service.runMonitorPass({ trigger: 'test' });

  assert.match(retryOptions?.reason || '', /stopped before it became healthy/);
});

test('runMonitorPass leaves the broker stopped after a manual stop request', async () => {
  const config = {
    isInstalled: true,
    autoStart: true,
    resumeAfterHostRestart: false,
    manualStopRequested: true,
    serviceStatus: 'stopped'
  };

  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });

  let startCalled = false;
  service.getConfig = async () => config;
  service.probeHealth = async () => ({
    available: false,
    localBaseUrl: 'http://127.0.0.1:4301',
    health: null,
    message: 'connect ECONNREFUSED 127.0.0.1:4301'
  });
  service.isChildAlive = () => false;
  service.startService = async () => {
    startCalled = true;
    return { success: true };
  };

  await service.runMonitorPass({ trigger: 'test' });

  assert.equal(startCalled, false);
});

test('getStatus reports the manual-stop reason and recovery mode', async () => {
  const stoppedAt = new Date('2026-04-17T16:30:00.000Z');
  const config = {
    isInstalled: true,
    autoStart: true,
    manualStopRequested: true,
    resumeAfterHostRestart: false,
    serviceStatus: 'stopped',
    servicePid: null,
    serviceOwner: null,
    servicePort: 4301,
    bindHost: '127.0.0.1',
    lastStoppedAt: stoppedAt,
    lastError: null,
    lifecycleEvents: [{
      type: 'manual_stop',
      status: 'info',
      message: 'Alexa broker was stopped manually. Automatic recovery is paused until it is started again.',
      occurredAt: stoppedAt
    }],
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
    },
    toSanitized() {
      return {
        isInstalled: this.isInstalled,
        autoStart: this.autoStart,
        manualStopRequested: this.manualStopRequested,
        resumeAfterHostRestart: this.resumeAfterHostRestart,
        serviceStatus: this.serviceStatus,
        servicePid: this.servicePid,
        serviceOwner: this.serviceOwner,
        servicePort: this.servicePort,
        bindHost: this.bindHost,
        lastStoppedAt: this.lastStoppedAt,
        lastError: this.lastError,
        lifecycleEvents: this.lifecycleEvents
      };
    }
  };

  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test',
    configModel: {
      getConfig: async () => config
    }
  });

  service.getConfig = async () => config;
  service.probeHealth = async () => ({
    available: false,
    localBaseUrl: 'http://127.0.0.1:4301',
    health: null,
    message: 'connect ECONNREFUSED 127.0.0.1:4301'
  });
  service.findManagedReverseProxyRoute = async () => null;
  service.isChildAlive = () => false;

  const status = await service.getStatus();

  assert.equal(status.autoRecoveryMode, 'paused_manual_stop');
  assert.match(status.statusReason?.message || '', /stopped manually/i);
  assert.equal(status.lifecycleEvents?.[0]?.type, 'manual_stop');
});

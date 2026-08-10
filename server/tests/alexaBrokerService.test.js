const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

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
    refreshTokenTtlSeconds: 0,
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
  assert.equal(env.HOMEBRAIN_ALEXA_REFRESH_TOKEN_TTL_SECONDS, '0');
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
    refreshTokenTtlSeconds: 15552000,
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
    }
  };

  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });

  service.getConfig = async () => config;
  service.isManagedRuntimeAlive = () => true;
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
    alexaCommandTimeoutMs: '2500',
    refreshTokenTtlSeconds: '0'
  });

  assert.equal(response.success, true);
  assert.equal(response.restartRequired, true);
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
  assert.equal(config.refreshTokenTtlSeconds, 0);
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

test('managedReverseProxyRouteMatchesConfig detects restart-sensitive route drift', () => {
  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });
  const config = {
    publicBaseUrl: 'https://alexa-broker.example.com',
    bindHost: '127.0.0.1',
    servicePort: 4301,
    displayName: 'Managed Alexa Broker'
  };
  const route = service.buildManagedReverseProxyRoutePayload(config);

  assert.equal(service.managedReverseProxyRouteMatchesConfig(config, route), true);
  assert.equal(service.managedReverseProxyRouteMatchesConfig(config, {
    ...route,
    allowOnDemandTls: true
  }), false);
  assert.equal(service.managedReverseProxyRouteMatchesConfig(config, {
    ...route,
    upstreamPort: 4302
  }), false);
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

test('manual start restarts a managed broker process that is alive but unhealthy', async () => {
  const config = {
    isInstalled: true,
    serviceStatus: 'running'
  };
  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });
  let restartOptions = null;

  service.getConfig = async () => config;
  service.isManagedRuntimeAlive = () => true;
  service.probeHealth = async () => ({
    available: false,
    portOccupied: true,
    localBaseUrl: 'http://127.0.0.1:4301',
    message: 'timeout of 2000ms exceeded TCP port is already in use.'
  });
  service.restartService = async (options = {}) => {
    restartOptions = options;
    return { success: true, message: 'restarted unhealthy broker' };
  };

  const result = await service.startService({
    actor: 'admin@example.com',
    source: 'admin_start'
  });

  assert.equal(result.success, true);
  assert.equal(restartOptions.actor, 'admin@example.com');
  assert.equal(restartOptions.source, 'admin_start_unhealthy_recovery');
  assert.match(restartOptions.reason, /timeout of 2000ms/);
});

test('startService reconciles the managed reverse-proxy route after broker health is established', async () => {
  const config = {
    isInstalled: true,
    serviceStatus: 'running',
    lastError: null,
    manualStopRequested: false,
    async save() {}
  };
  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });
  let reconciliationOptions = null;

  service.getConfig = async () => config;
  service.isManagedRuntimeAlive = () => true;
  service.isChildAlive = () => false;
  service.probeHealth = async () => ({
    available: true,
    portOccupied: true,
    health: { success: true },
    message: ''
  });
  service.reconcileManagedReverseProxyRouteAfterStartup = async (options = {}) => {
    reconciliationOptions = options;
    return { success: true };
  };
  service.getStatus = async () => ({ serviceStatus: 'running' });

  const result = await service.startService({
    actor: 'system:auto-recovery',
    automatic: true,
    source: 'watchdog_interval'
  });

  assert.equal(result.success, true);
  assert.deepEqual(reconciliationOptions, {
    actor: 'system:auto-recovery',
    applyConfig: true
  });
});

test('startup route reconciliation validates a matching route without reloading Caddy', async () => {
  const config = {
    publicBaseUrl: 'https://alexa-broker.example.com',
    bindHost: '127.0.0.1',
    servicePort: 4301,
    displayName: 'Managed Alexa Broker'
  };
  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });
  const route = service.buildManagedReverseProxyRoutePayload(config);
  route.validationStatus = 'invalid';
  let validationCalls = 0;
  let ensureCalls = 0;

  service.getConfig = async () => config;
  service.findManagedReverseProxyRoute = async () => route;
  service.reverseProxyService = {
    async validateRoute(receivedRoute, _settings, options) {
      validationCalls += 1;
      assert.equal(receivedRoute, route);
      assert.equal(options.persist, true);
      return { validationStatus: 'valid' };
    }
  };
  service.ensureManagedReverseProxyRoute = async () => {
    ensureCalls += 1;
    return { success: true };
  };

  const result = await service.reconcileManagedReverseProxyRouteAfterStartup({
    actor: 'system:auto-recovery',
    applyConfig: true
  });

  assert.equal(result.success, true);
  assert.equal(result.action, 'validated');
  assert.equal(result.appliedConfig, false);
  assert.equal(validationCalls, 1);
  assert.equal(ensureCalls, 0);
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

test('getStatus treats a healthy tracked broker pid as managed after a backend restart', async () => {
  const config = {
    isInstalled: true,
    serviceStatus: 'running_external',
    servicePid: 1234,
    serviceOwner: 'matt',
    servicePort: 4301,
    bindHost: '127.0.0.1',
    lastError: null,
    lifecycleEvents: [],
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
    available: true,
    portOccupied: true,
    localBaseUrl: 'http://127.0.0.1:4301',
    health: { ok: true },
    message: ''
  });
  service.findManagedReverseProxyRoute = async () => null;
  service.isChildAlive = () => false;
  service.isTrackedBrokerProcessAlive = () => true;

  const status = await service.getStatus();

  assert.equal(status.serviceStatus, 'running');
  assert.equal(status.serviceRunning, true);
  assert.equal(status.servicePid, 1234);
  assert.equal(status.serviceOwner, 'matt');
  assert.equal(status.statusReason, null);
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

test('runMonitorPass does not spawn a second broker when the configured port is occupied', async () => {
  const config = {
    isInstalled: true,
    autoStart: true,
    resumeAfterHostRestart: false,
    manualStopRequested: false,
    serviceStatus: 'stopped',
    servicePid: null,
    serviceOwner: null,
    lastError: null,
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
    }
  };

  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test'
  });

  let startCalled = false;
  service.getConfig = async () => config;
  service.probeHealth = async () => ({
    available: false,
    portOccupied: true,
    localBaseUrl: 'http://127.0.0.1:4301',
    health: null,
    message: 'timeout of 2000ms exceeded TCP port is already in use.'
  });
  service.isChildAlive = () => false;
  service.isTrackedBrokerProcessAlive = () => false;
  service.startService = async () => {
    startCalled = true;
    return { success: true };
  };

  await service.runMonitorPass({ trigger: 'test' });

  assert.equal(startCalled, false);
  assert.equal(config.serviceStatus, 'running_external');
  assert.match(config.lastError?.message || '', /TCP port is already in use/);
  assert.ok(config.saveCalls >= 1);
});

test('waitForHealthyBroker rejects when health belongs to another process and the spawned child exits', async () => {
  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test',
    startupStabilityMs: 10
  });

  const child = {
    exitCode: null,
    killed: false
  };

  service.probeHealth = async () => {
    setTimeout(() => {
      child.exitCode = 1;
    }, 0);
    return {
      available: true,
      portOccupied: true,
      localBaseUrl: 'http://127.0.0.1:4301',
      health: { ok: true },
      message: ''
    };
  };

  await assert.rejects(
    () => service.waitForHealthyBroker({ bindHost: '127.0.0.1', servicePort: 4301 }, 100, child),
    /startup health could be confirmed/
  );
});

test('runMonitorPass does not restart a live broker on transient health timeouts while the port is occupied', async () => {
  const config = {
    isInstalled: true,
    autoStart: true,
    resumeAfterHostRestart: false,
    manualStopRequested: false,
    serviceStatus: 'running'
  };

  const service = new AlexaBrokerService({
    projectRoot: '/tmp/homebrain-test',
    healthFailureThreshold: 2,
    portOccupiedHealthFailureThreshold: 4
  });

  const restartCalls = [];
  service.getConfig = async () => config;
  service.probeHealth = async () => ({
    available: false,
    portOccupied: true,
    localBaseUrl: 'http://127.0.0.1:4301',
    health: null,
    message: 'timeout of 2000ms exceeded TCP port is already in use.'
  });
  service.isManagedRuntimeAlive = () => true;
  service.restartService = async (options = {}) => {
    restartCalls.push(options);
    return { success: true };
  };

  await service.runMonitorPass({ trigger: 'test' });
  await service.runMonitorPass({ trigger: 'test' });

  assert.equal(restartCalls.length, 0);
  assert.equal(service.consecutiveHealthFailures, 2);

  await service.runMonitorPass({ trigger: 'test' });
  await service.runMonitorPass({ trigger: 'test' });

  assert.equal(restartCalls.length, 1);
  assert.equal(restartCalls[0]?.automatic, true);
  assert.match(restartCalls[0]?.reason || '', /TCP port is already in use/);
});

test('stopService waits for a signaled child exit and records it as an intentional stop', async () => {
  const config = {
    isInstalled: true,
    autoStart: true,
    resumeAfterHostRestart: false,
    manualStopRequested: false,
    serviceStatus: 'running',
    servicePid: 4321,
    serviceOwner: 'tester',
    lifecycleEvents: [],
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

  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4321;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    setTimeout(() => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    }, 10);
    return true;
  };

  service.getConfig = async () => config;
  service.getStatus = async () => ({ serviceStatus: config.serviceStatus });
  service.child = child;
  service.attachProcessListeners(child);

  await service.stopService({
    actor: 'test',
    manual: false,
    source: 'test_stop',
    reason: 'test restart'
  });

  assert.equal(service.child, null);
  assert.equal(service.stoppingChild, false);
  assert.equal(config.serviceStatus, 'stopped');
  assert.equal(config.lifecycleEvents.some((event) => event.type === 'unexpected_exit'), false);
  assert.equal(config.lifecycleEvents.some((event) => event.type === 'stopped'), true);
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

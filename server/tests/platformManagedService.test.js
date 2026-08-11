const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('events');

const { PlatformManagedServiceManager } = require('../services/platformManagedService');
const PlatformManagedService = require('../models/PlatformManagedService');
const reachyMiniService = require('../services/reachyMiniService');

const projectRoot = path.resolve(__dirname, '..', '..');

test('managed services declare the unique serviceId index exactly once', () => {
  const serviceIdIndexes = PlatformManagedService.schema.indexes()
    .filter(([fields]) => fields.serviceId === 1);

  assert.equal(serviceIdIndexes.length, 1);
  assert.equal(serviceIdIndexes[0][1].unique, true);
});

function createSpawnStub(calls, handlers = {}) {
  return (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      const key = [command, ...args].join(' ');
      const handler = handlers[key] || handlers.default || (() => ({ code: 0, stdout: '', stderr: '' }));
      const result = handler(command, args);
      if (result.stdout) {
        child.stdout.emit('data', Buffer.from(result.stdout));
      }
      if (result.stderr) {
        child.stderr.emit('data', Buffer.from(result.stderr));
      }
      child.emit('close', result.code ?? 0);
    });
    return child;
  };
}

test('runSetupCommand uses the managed setup-services helper with sudo', async () => {
  const calls = [];
  const manager = new PlatformManagedServiceManager({
    projectRoot,
    spawnProcess: createSpawnStub(calls)
  });

  await manager.runSetupCommand('update-platform-service', 'mqtt');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'sudo');
  assert.deepEqual(calls[0].args.slice(-2), ['update-platform-service', 'mqtt']);
  assert.equal(calls[0].args[0], '-n');
});

test('managed service definitions expose Codex CLI as a non-daemon runtime', () => {
  const manager = new PlatformManagedServiceManager();
  const codex = manager.getDefinitions().find((entry) => entry.serviceId === 'codex');

  assert.deepEqual(codex, {
    serviceId: 'codex',
    displayName: 'Codex CLI',
    packageName: '@openai/codex',
    systemdUnit: '',
    runtimeKind: 'cli',
    setupCommand: 'setup-codex',
    updateTarget: 'codex',
    managementNotes: 'OpenAI coding agent CLI used by HomeBrain for current model access.'
  });
});

test('getRuntimeStatus treats an installed Codex CLI as ready without probing systemd', async () => {
  const calls = [];
  const manager = new PlatformManagedServiceManager({
    projectRoot,
    spawnProcess: createSpawnStub(calls, {
      'bash -lc command -v codex': () => ({ code: 0, stdout: '/usr/local/bin/codex' }),
      "bash -lc codex --version 2>/dev/null | awk 'NR==1 {print $NF}' || true": () => ({ code: 0, stdout: '0.144.5' })
    })
  });
  const definition = manager.getDefinitions().find((entry) => entry.serviceId === 'codex');

  assert.deepEqual(await manager.getRuntimeStatus(definition), {
    installed: true,
    active: true,
    currentVersion: '0.144.5'
  });
  assert.equal(calls.some((call) => call.command === 'systemctl'), false);
});

test('isDueForCheck honors weekly policy intervals', () => {
  const manager = new PlatformManagedServiceManager();
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  assert.equal(manager.isDueForCheck({
    lastCheckedAt: eightDaysAgo,
    policy: { autoCheckEnabled: true, checkIntervalDays: 7 }
  }), true);
  assert.equal(manager.isDueForCheck({
    lastCheckedAt: yesterday,
    policy: { autoCheckEnabled: true, checkIntervalDays: 7 }
  }), false);
  assert.equal(manager.isDueForCheck({
    lastCheckedAt: eightDaysAgo,
    policy: { autoCheckEnabled: false, checkIntervalDays: 7 }
  }), false);
});

test('normalizeRecord marks auto updates eligible only after the stability delay', () => {
  const manager = new PlatformManagedServiceManager();
  const definition = manager.getDefinitions().find((entry) => entry.serviceId === 'mqtt');
  const eligibleRecord = {
    serviceId: 'mqtt',
    updateAvailable: true,
    eligibleForAutoUpdateAt: new Date(Date.now() - 1000),
    policy: { autoUpdateEnabled: true, autoCheckEnabled: true, checkIntervalDays: 7, stabilityDelayDays: 30 }
  };
  const waitingRecord = {
    serviceId: 'mqtt',
    updateAvailable: true,
    eligibleForAutoUpdateAt: new Date(Date.now() + 1000),
    policy: { autoUpdateEnabled: true, autoCheckEnabled: true, checkIntervalDays: 7, stabilityDelayDays: 30 }
  };

  assert.equal(manager.normalizeRecord(eligibleRecord, definition).autoUpdateEligible, true);
  assert.equal(manager.normalizeRecord(waitingRecord, definition).autoUpdateEligible, false);
});

test('sanitizeMqttConfig tolerates invalid environment broker URLs', (t) => {
  const originalUrl = process.env.HOMEBRAIN_MQTT_URL;
  process.env.HOMEBRAIN_MQTT_URL = 'not a valid mqtt url';
  t.after(() => {
    if (originalUrl === undefined) {
      delete process.env.HOMEBRAIN_MQTT_URL;
    } else {
      process.env.HOMEBRAIN_MQTT_URL = originalUrl;
    }
  });

  const manager = new PlatformManagedServiceManager();
  const config = manager.sanitizeMqttConfig({
    host: 'mqtt.homebrain.test',
    port: '1884',
    topicPrefix: 'homebrain / bad/#/name'
  });

  assert.equal(config.brokerUrl, 'mqtt://mqtt.homebrain.test:1884');
  assert.equal(config.topicPrefix, 'homebrain/bad/name');
});

test('getPiholeConfig exposes hostname suggestions separately from configured routes', (t) => {
  const originalPublicHost = process.env.HOMEBRAIN_PUBLIC_HOST;
  const originalRouteHost = process.env.HOMEBRAIN_PIHOLE_ADMIN_ROUTE_HOST;
  process.env.HOMEBRAIN_PUBLIC_HOST = 'home.example.test';
  delete process.env.HOMEBRAIN_PIHOLE_ADMIN_ROUTE_HOST;
  t.after(() => {
    if (originalPublicHost === undefined) {
      delete process.env.HOMEBRAIN_PUBLIC_HOST;
    } else {
      process.env.HOMEBRAIN_PUBLIC_HOST = originalPublicHost;
    }
    if (originalRouteHost === undefined) {
      delete process.env.HOMEBRAIN_PIHOLE_ADMIN_ROUTE_HOST;
    } else {
      process.env.HOMEBRAIN_PIHOLE_ADMIN_ROUTE_HOST = originalRouteHost;
    }
  });

  const manager = new PlatformManagedServiceManager();
  const config = manager.getPiholeConfig({ config: { pihole: {} } });

  assert.equal(config.adminHostname, 'pihole.home.example.test');
  assert.equal(config.suggestedAdminHostname, 'pihole.home.example.test');
  assert.equal(config.adminHostnameConfigured, false);
});

test('ensureManagedRoutes does not create Pi-hole ingress from a suggestion alone', async (t) => {
  const originalPublicHost = process.env.HOMEBRAIN_PUBLIC_HOST;
  const originalRouteHost = process.env.HOMEBRAIN_PIHOLE_ADMIN_ROUTE_HOST;
  process.env.HOMEBRAIN_PUBLIC_HOST = 'home.example.test';
  delete process.env.HOMEBRAIN_PIHOLE_ADMIN_ROUTE_HOST;
  t.after(() => {
    if (originalPublicHost === undefined) {
      delete process.env.HOMEBRAIN_PUBLIC_HOST;
    } else {
      process.env.HOMEBRAIN_PUBLIC_HOST = originalPublicHost;
    }
    if (originalRouteHost === undefined) {
      delete process.env.HOMEBRAIN_PIHOLE_ADMIN_ROUTE_HOST;
    } else {
      process.env.HOMEBRAIN_PIHOLE_ADMIN_ROUTE_HOST = originalRouteHost;
    }
  });

  const manager = new PlatformManagedServiceManager();
  manager.getOrCreateRecord = async () => ({ config: { pihole: {} } });
  manager.ensurePiholeRoute = async () => {
    throw new Error('route should not be created');
  };

  assert.deepEqual(await manager.ensureManagedRoutes(), {
    created: [],
    updated: [],
    skipped: [{ serviceId: 'pihole', reason: 'admin-hostname-not-configured' }]
  });
});

test('buildPiholeRoutePayload targets the local Pi-hole web console', () => {
  const manager = new PlatformManagedServiceManager();
  const payload = manager.buildPiholeRoutePayload({
    adminHostname: 'pihole.home.example.test',
    webPort: 8081,
    adminRouteEnabled: true,
    dynamicDnsEnabled: true
  });

  assert.equal(payload.platformKey, 'pihole');
  assert.equal(payload.hostname, 'pihole.home.example.test');
  assert.equal(payload.upstreamProtocol, 'http');
  assert.equal(payload.upstreamHost, '127.0.0.1');
  assert.equal(payload.upstreamPort, 8081);
  assert.equal(payload.websocketSupport, false);
});

test('Reachy fleet updates persist batch intent and every accepted request across partial dispatch failure', async (t) => {
  const originalFleetStatus = reachyMiniService.getCompanionFleetStatus;
  const originalRequestUpdate = reachyMiniService.requestCompanionUpdate;
  t.after(() => {
    reachyMiniService.getCompanionFleetStatus = originalFleetStatus;
    reachyMiniService.requestCompanionUpdate = originalRequestUpdate;
  });

  const events = [];
  const saves = [];
  const record = {
    config: {},
    policy: {},
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    lastUpdateStatus: 'never',
    lastError: '',
    markModified() {},
    async save() {
      events.push(`save:${this.config?.reachyUpdate?.requests?.length || 0}`);
      saves.push(JSON.parse(JSON.stringify({
        config: this.config,
        lastUpdateStatus: this.lastUpdateStatus,
        lastError: this.lastError
      })));
      return this;
    }
  };
  const fleet = {
    installed: true,
    paired: true,
    setupRequired: false,
    active: true,
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    devices: [
      { deviceId: 'robot-a', updateAvailable: true },
      { deviceId: 'robot-b', updateAvailable: true }
    ]
  };
  reachyMiniService.getCompanionFleetStatus = async () => fleet;
  reachyMiniService.requestCompanionUpdate = async (deviceId) => {
    events.push(`dispatch:${deviceId}`);
    if (deviceId === 'robot-b') throw new Error('robot-b disconnected');
    return { accepted: true, requestId: 'request-a' };
  };

  const manager = new PlatformManagedServiceManager();
  manager.getOrCreateRecord = async () => record;
  const result = await manager.updateService('reachy-homebrain-app', { actor: 'admin' });

  assert.equal(events[0], 'save:0');
  assert.equal(events[1], 'dispatch:robot-a');
  assert.equal(events[2], 'save:1');
  assert.equal(events[3], 'dispatch:robot-b');
  assert.deepEqual(record.config.reachyUpdate.plannedDeviceIds, ['robot-a', 'robot-b']);
  assert.deepEqual(record.config.reachyUpdate.deviceIds, ['robot-a']);
  assert.deepEqual(record.config.reachyUpdate.requests, [{ deviceId: 'robot-a', requestId: 'request-a' }]);
  assert.equal(record.config.reachyUpdate.dispatchFailures[0].deviceId, 'robot-b');
  assert.equal(record.lastUpdateStatus, 'in_progress');
  assert.match(record.lastError, /1 accepted, 1 failed/);
  assert.equal(result.lastUpdateStatus, 'in_progress');
  assert.ok(saves.some((snapshot) => snapshot.config.reachyUpdate?.requests?.[0]?.requestId === 'request-a'));

  await manager.reconcileReachyRecord(record, {
    ...fleet,
    devices: [{
      deviceId: 'robot-a',
      state: 'completed',
      current: true,
      updateAvailable: false
    }]
  });
  assert.equal(record.lastUpdateStatus, 'failed');
  assert.match(record.lastError, /1 succeeded, 1 failed/);
  assert.equal(record.config.reachyUpdate, undefined);
});

test('Reachy reconciliation recovers a planned-only request after a crash before accepted correlation save', async () => {
  const startedAt = new Date(Date.now() - 2_000).toISOString();
  const record = {
    config: {
      reachyUpdate: {
        plannedDeviceIds: ['robot-a'],
        deviceIds: [],
        requests: [],
        dispatchFailures: [],
        startedAt
      }
    },
    lastUpdateStatus: 'in_progress',
    lastError: '',
    markModified() {},
    async save() { return this; }
  };
  const manager = new PlatformManagedServiceManager();

  await manager.reconcileReachyRecord(record, {
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    devices: [{
      deviceId: 'robot-a',
      state: 'staging',
      requestId: 'robot-request-a',
      requestedAt: new Date(Date.now() - 1_000).toISOString(),
      current: false,
      updateAvailable: true
    }]
  });

  assert.equal(record.lastUpdateStatus, 'in_progress');
  assert.deepEqual(record.config.reachyUpdate.deviceIds, ['robot-a']);
  assert.deepEqual(record.config.reachyUpdate.requests, [{
    deviceId: 'robot-a',
    requestId: 'robot-request-a',
    recovered: true
  }]);

  await manager.reconcileReachyRecord(record, {
    currentVersion: '0.2.0',
    latestVersion: '0.2.0',
    updateAvailable: false,
    devices: [{
      deviceId: 'robot-a',
      state: 'completed',
      requestId: 'robot-request-a',
      requestedAt: new Date(Date.now() - 1_000).toISOString(),
      current: true,
      updateAvailable: false
    }]
  });

  assert.equal(record.lastUpdateStatus, 'success');
  assert.equal(record.lastError, '');
  assert.equal(record.config.reachyUpdate, undefined);
});

test('Reachy fleet update admission atomically rejects a concurrent second batch before duplicate dispatch', async (t) => {
  const originalFindOneAndUpdate = PlatformManagedService.findOneAndUpdate;
  const originalFleetStatus = reachyMiniService.getCompanionFleetStatus;
  const originalRequestUpdate = reachyMiniService.requestCompanionUpdate;
  t.after(() => {
    PlatformManagedService.findOneAndUpdate = originalFindOneAndUpdate;
    reachyMiniService.getCompanionFleetStatus = originalFleetStatus;
    reachyMiniService.requestCompanionUpdate = originalRequestUpdate;
  });

  const fleet = {
    installed: true,
    paired: true,
    setupRequired: false,
    active: true,
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    devices: [{ deviceId: 'robot-a', updateAvailable: true }]
  };
  reachyMiniService.getCompanionFleetStatus = async () => fleet;

  let releaseDispatch;
  let dispatchStartedResolve;
  const dispatchStarted = new Promise((resolve) => { dispatchStartedResolve = resolve; });
  let dispatchCalls = 0;
  reachyMiniService.requestCompanionUpdate = async () => {
    dispatchCalls += 1;
    dispatchStartedResolve();
    await new Promise((resolve) => { releaseDispatch = resolve; });
    return { accepted: true, requestId: 'request-a' };
  };

  const claimedRecord = {
    _id: 'managed-reachy-record',
    serviceId: 'reachy-homebrain-app',
    config: { retainedSetting: true },
    policy: {},
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    lastUpdateStatus: 'never',
    lastError: '',
    markModified() {},
    async save() { return this; }
  };
  let admitted = false;
  let admissionCalls = 0;
  PlatformManagedService.findOneAndUpdate = async (_query, update) => {
    admissionCalls += 1;
    if (admitted) return null;
    admitted = true;
    claimedRecord.config = {
      ...claimedRecord.config,
      reachyUpdate: JSON.parse(JSON.stringify(update.$set['config.reachyUpdate']))
    };
    claimedRecord.lastUpdatedAt = update.$set.lastUpdatedAt;
    claimedRecord.lastUpdateStatus = update.$set.lastUpdateStatus;
    claimedRecord.lastError = update.$set.lastError;
    return claimedRecord;
  };

  const manager = new PlatformManagedServiceManager();
  manager.getOrCreateRecord = async () => ({
    _id: 'managed-reachy-record',
    serviceId: 'reachy-homebrain-app',
    config: { retainedSetting: true },
    policy: {},
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    updateAvailable: true,
    lastUpdateStatus: 'never',
    lastError: '',
    markModified() {},
    async save() { return this; }
  });

  const first = manager.updateService('reachy-homebrain-app', { actor: 'first-admin' });
  await dispatchStarted;
  await assert.rejects(
    manager.updateService('reachy-homebrain-app', { actor: 'second-admin' }),
    (error) => error?.status === 409 && error?.code === 'REACHY_UPDATE_IN_PROGRESS'
  );

  assert.equal(admissionCalls, 2);
  assert.equal(dispatchCalls, 1);
  assert.equal(claimedRecord.config.reachyUpdate.actor, 'first-admin');
  releaseDispatch();
  await first;
});

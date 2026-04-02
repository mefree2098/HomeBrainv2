const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const harmonyServiceModule = require('../services/harmonyService');

const { HarmonyService } = harmonyServiceModule;

class FakeExplorer extends EventEmitter {
  static instances = [];

  constructor() {
    super();
    this.responseCollector = { server: new EventEmitter() };
    this.ping = { socket: new EventEmitter() };
    this.started = false;
    this.stopped = false;
    FakeExplorer.instances.push(this);
  }

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
  }
}

test('discoverHubs coalesces concurrent discovery runs onto one explorer instance', async () => {
  FakeExplorer.instances.length = 0;

  let releaseSleep;
  const sleepPromise = new Promise((resolve) => {
    releaseSleep = resolve;
  });

  const service = new HarmonyService({
    ExplorerClass: FakeExplorer,
    sleep: () => sleepPromise
  });

  service.getConfiguredHubAddresses = async () => [];
  service.getKnownHubRegistry = async () => [];
  service.mergeKnownHubs = async () => [];

  const first = service.discoverHubs({ timeoutMs: 1 });
  const second = service.discoverHubs({ timeoutMs: 1 });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeExplorer.instances.length, 1);
  assert.equal(FakeExplorer.instances[0].started, true);

  releaseSleep();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, []);
  assert.deepEqual(secondResult, []);
  assert.equal(FakeExplorer.instances[0].stopped, true);
});

test('discoverHubs downgrades low-level socket failures into a safe empty result', async () => {
  class ErrorExplorer extends EventEmitter {
    constructor() {
      super();
      this.responseCollector = { server: new EventEmitter() };
      this.ping = { socket: new EventEmitter() };
      this.stopped = false;
    }

    start() {
      process.nextTick(() => {
        this.responseCollector.server.emit('error', new Error('EADDRINUSE: address already in use'));
      });
    }

    stop() {
      this.stopped = true;
    }
  }

  const service = new HarmonyService({
    ExplorerClass: ErrorExplorer,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 250))
  });

  service.getConfiguredHubAddresses = async () => [];
  service.getKnownHubRegistry = async () => [];
  service.mergeKnownHubs = async () => [];

  const result = await service.discoverHubs({ timeoutMs: 1 });
  assert.deepEqual(result, []);
});

test('startBackgroundMonitoring polls Harmony activity state for known hubs', async (t) => {
  const service = new HarmonyService();
  const originalIntervalMs = service.backgroundMonitorIntervalMs;

  t.after(() => {
    service.stopBackgroundMonitoring();
    service.backgroundMonitorIntervalMs = originalIntervalMs;
  });

  const observedHubLists = [];

  service.getMonitoringHubIps = async () => ['192.168.1.50'];
  service.syncActivityStates = async ({ hubIps, force }) => {
    observedHubLists.push({ hubIps, force });
    return { success: true };
  };
  service.backgroundMonitorIntervalMs = 5;

  service.startBackgroundMonitoring({ immediate: true });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(observedHubLists.length >= 1);
  assert.deepEqual(observedHubLists[0], {
    hubIps: ['192.168.1.50'],
    force: true
  });
});

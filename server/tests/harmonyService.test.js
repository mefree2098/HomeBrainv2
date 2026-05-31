const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const Device = require('../models/Device');
const Settings = require('../models/Settings');
const harmonyServiceModule = require('../services/harmonyService');

const { HarmonyService, pruneStaleRememberedHubAliases } = harmonyServiceModule;

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

test('pruneStaleRememberedHubAliases hides stale remembered IP aliases for the active hub', () => {
  const hubs = pruneStaleRememberedHubAliases([
    {
      ip: '192.168.2.14',
      friendlyName: 'Bedroom Hub',
      source: 'remembered',
      discovered: false,
      success: false,
      trackedActivityDevices: 0
    },
    {
      ip: '192.168.2.43',
      friendlyName: 'Bedroom Hub',
      source: 'remembered+discovered',
      discovered: true,
      success: true,
      remoteId: '9173577',
      trackedActivityDevices: 6
    }
  ]);

  assert.deepEqual(hubs.map((hub) => hub.ip), ['192.168.2.43']);
});

test('pruneStaleRememberedHubAliases keeps configured or tracked remembered hubs', () => {
  const hubs = pruneStaleRememberedHubAliases([
    {
      ip: '192.168.2.14',
      friendlyName: 'Bedroom Hub',
      source: 'remembered+configured',
      discovered: false,
      success: false,
      trackedActivityDevices: 0
    },
    {
      ip: '192.168.2.15',
      friendlyName: 'Bedroom Hub',
      source: 'remembered',
      discovered: false,
      success: false,
      trackedActivityDevices: 1
    },
    {
      ip: '192.168.2.43',
      friendlyName: 'Bedroom Hub',
      source: 'remembered+discovered',
      discovered: true,
      success: true,
      remoteId: '9173577'
    }
  ]);

  assert.deepEqual(hubs.map((hub) => hub.ip), ['192.168.2.14', '192.168.2.15', '192.168.2.43']);
});

test('getStatus uses hydrated hubs so stale remembered aliases stay hidden', async (t) => {
  const originalCountDocuments = Device.countDocuments;

  t.after(() => {
    Device.countDocuments = originalCountDocuments;
  });

  const service = new HarmonyService();
  service.getConfiguredHubAddresses = async () => [];
  service.getHubs = async (options) => {
    assert.equal(options.includeCommands, false);
    assert.equal(options.timeoutMs, 1);
    return [
      {
        ip: '192.168.2.43',
        friendlyName: 'Bedroom Hub',
        source: 'remembered',
        success: true,
        discovered: false,
        remoteId: '9173577',
        trackedActivityDevices: 6
      }
    ];
  };
  Device.countDocuments = async (query) => (
    query?.isOnline === true ? 12 : 12
  );

  const status = await service.getStatus({ timeoutMs: 1 });

  assert.deepEqual(status.discoveredHubs.map((hub) => hub.ip), ['192.168.2.43']);
  assert.equal(status.knownHubCount, 1);
  assert.equal(status.discoveredCount, 1);
  assert.equal(status.trackedDevices, 12);
  assert.equal(status.onlineDevices, 12);
});

test('mergeKnownHubs serializes cached settings saves from concurrent readers', async (t) => {
  const originalGetSettings = Settings.getSettings;
  let saveInProgress = false;
  let saveCount = 0;
  const settingsDoc = {
    harmonyKnownHubs: [],
    async save() {
      if (saveInProgress) {
        throw new Error('parallel save');
      }
      saveInProgress = true;
      saveCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      saveInProgress = false;
      return this;
    }
  };

  t.after(() => {
    Settings.getSettings = originalGetSettings;
  });

  Settings.getSettings = async () => settingsDoc;

  const service = new HarmonyService();
  await Promise.all([
    service.mergeKnownHubs([{
      ip: '192.168.2.43',
      friendlyName: 'Bedroom Hub',
      discovered: true,
      lastSeenAt: new Date('2026-05-31T00:00:00Z')
    }]),
    service.mergeKnownHubs([{
      ip: '192.168.2.14',
      friendlyName: 'Bedroom Hub'
    }])
  ]);

  assert.equal(saveCount, 2);
  assert.deepEqual(
    settingsDoc.harmonyKnownHubs.map((hub) => hub.ip).sort(),
    ['192.168.2.14', '192.168.2.43']
  );
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

test('syncDevices dedupes duplicate HomeBrain rows for a Harmony activity', async (t) => {
  const originalFind = Device.find;
  const originalCreate = Device.create;
  const originalDeleteMany = Device.deleteMany;

  t.after(() => {
    Device.find = originalFind;
    Device.create = originalCreate;
    Device.deleteMany = originalDeleteMany;
  });

  const service = new HarmonyService();
  service.discoverHubs = async () => [{ ip: '192.168.1.50' }];
  service.getHubSnapshot = async () => ({
    ip: '192.168.1.50',
    friendlyName: 'Family Room',
    currentActivityId: '123',
    activities: [
      {
        id: '123',
        label: 'Watch TV',
        isAVActivity: true,
        activityTypeDisplayName: 'TV'
      }
    ]
  });
  service.mergeKnownHubs = async () => [];
  service.syncActivityStates = async () => ({ success: true });

  const canonicalDevice = {
    _id: 'harmony-canonical',
    name: 'Family Room - Watch TV',
    groups: ['Media'],
    properties: {
      harmonyHubIp: '192.168.1.50',
      harmonyActivityId: '123'
    },
    createdAt: new Date('2026-04-01T00:00:00Z'),
    async save() {
      this.saved = true;
    }
  };

  const duplicateDevice = {
    _id: 'harmony-duplicate',
    name: 'Family Room Duplicate',
    groups: ['Favorites'],
    properties: {
      harmonyHubIp: '192.168.1.50',
      harmonyActivityId: '123'
    },
    createdAt: new Date('2026-04-02T00:00:00Z')
  };

  const deleteManyCalls = [];

  Device.find = async (query) => {
    if (query['properties.harmonyActivityId']) {
      assert.equal(query['properties.harmonyHubIp'], '192.168.1.50');
      assert.equal(query['properties.harmonyActivityId'], '123');
      return [duplicateDevice, canonicalDevice];
    }

    if (query.name instanceof RegExp) {
      assert.equal(query.room, 'Family Room');
      assert.equal(query.name.test('Family Room - Watch TV'), true);
      return [duplicateDevice, canonicalDevice];
    }

    throw new Error(`Unexpected Device.find query: ${JSON.stringify(query)}`);
  };
  Device.create = async () => {
    throw new Error('Device.create should not be called when a canonical Harmony row already exists');
  };
  Device.deleteMany = async (query) => {
    deleteManyCalls.push(query);
    if (query._id) {
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  };

  const result = await service.syncDevices({ timeoutMs: 1 });

  assert.equal(result.success, true);
  assert.equal(result.updated, 1);
  assert.equal(result.deduped, 1);
  assert.deepEqual(canonicalDevice.groups, ['Media', 'Favorites']);
  assert.equal(canonicalDevice.saved, true);
  assert.equal(deleteManyCalls.length, 3);
  assert.deepEqual(deleteManyCalls[0], {
    _id: { $in: ['harmony-duplicate'] }
  });
});

test('sendPowerCommand resolves Harmony power commands and repeats explicit power commands when requested', async () => {
  const sentCommands = [];
  const fakeClient = {
    remoteId: 'remote-1',
    async getAvailableCommands() {
      return {
        device: [
          {
            id: '55',
            label: 'Projector',
            controlGroup: [
              {
                function: [
                  { name: 'PowerOn', label: 'PowerOn', action: 'IR_POWER_ON' },
                  { name: 'PowerOff', label: 'PowerOff', action: 'IR_POWER_OFF' }
                ]
              }
            ]
          }
        ]
      };
    },
    async send(action, body, holdMs) {
      sentCommands.push({ action, body, holdMs });
    },
    end() {}
  };

  const service = new HarmonyService({
    getHarmonyClient: async () => fakeClient
  });

  const result = await service.sendPowerCommand('192.168.1.50', '55', 'off', { repeatCount: 2 });

  assert.equal(result.success, true);
  assert.equal(result.deviceId, '55');
  assert.equal(result.command, 'PowerOff');
  assert.equal(result.commandKind, 'off');
  assert.equal(result.repeatCount, 2);
  assert.deepEqual(sentCommands, [
    { action: 'holdAction', body: 'IR_POWER_OFF', holdMs: 0 },
    { action: 'holdAction', body: 'IR_POWER_OFF', holdMs: 0 }
  ]);
});

test('withClient times out stalled Harmony operations and closes the client', async () => {
  const fakeClient = {
    ended: false,
    end() {
      this.ended = true;
    }
  };
  const service = new HarmonyService({
    clientOperationTimeoutMs: 20,
    getHarmonyClient: async () => fakeClient
  });

  await assert.rejects(
    () => service.withClient(
      '192.168.1.50',
      () => new Promise(() => {}),
      { operationName: 'test Harmony command' }
    ),
    (error) => {
      assert.equal(error.code, 'HARMONY_OPERATION_TIMEOUT');
      assert.equal(error.status, 504);
      assert.match(error.message, /test Harmony command timed out waiting/);
      return true;
    }
  );
  assert.equal(fakeClient.ended, true);
});

test('withClient times out stalled Harmony connections before an operation starts', async () => {
  const service = new HarmonyService({
    clientOperationTimeoutMs: 20,
    getHarmonyClient: async () => new Promise(() => {})
  });

  await assert.rejects(
    () => service.withClient(
      '192.168.1.50',
      () => {
        throw new Error('operation should not start');
      },
      { operationName: 'test Harmony connection' }
    ),
    (error) => {
      assert.equal(error.code, 'HARMONY_OPERATION_TIMEOUT');
      assert.match(error.message, /test Harmony connection timed out connecting/);
      return true;
    }
  );
});

test('syncDevices updates Harmony raw device metadata while preserving custom device options', async (t) => {
  const originalFind = Device.find;
  const originalCreate = Device.create;
  const originalDeleteMany = Device.deleteMany;

  t.after(() => {
    Device.find = originalFind;
    Device.create = originalCreate;
    Device.deleteMany = originalDeleteMany;
  });

  const service = new HarmonyService();
  service.discoverHubs = async () => [{ ip: '192.168.1.50' }];
  service.getHubSnapshot = async () => ({
    ip: '192.168.1.50',
    friendlyName: 'Family Room',
    currentActivityId: '-1',
    currentActivityLabel: 'Off',
    activities: [],
    devices: [
      {
        id: '55',
        label: 'Projector',
        manufacturer: 'Epson',
        model: 'Cinema 1080',
        commands: [
          { name: 'PowerOn', label: 'PowerOn', action: 'IR_POWER_ON' },
          { name: 'PowerOff', label: 'PowerOff', action: 'IR_POWER_OFF' },
          { name: 'VolumeUp', label: 'VolumeUp', action: 'IR_VOLUME_UP' },
          { name: 'VolumeDown', label: 'VolumeDown', action: 'IR_VOLUME_DOWN' },
          { name: 'Mute', label: 'Mute', action: 'IR_MUTE' },
          { name: 'DirectionUp', label: 'DirectionUp', action: 'IR_UP' },
          { name: 'Select', label: 'Select', action: 'IR_SELECT' }
        ]
      }
    ]
  });
  service.mergeKnownHubs = async () => [];
  service.syncActivityStates = async () => ({ success: true });

  const canonicalDevice = {
    _id: 'harmony-projector-1',
    name: 'Projector',
    type: 'switch',
    room: 'Family Room',
    status: true,
    groups: ['Media'],
    properties: {
      source: 'harmony',
      harmonyHubIp: '192.168.1.50',
      harmonyEntityType: 'device',
      harmonyDeviceId: '55',
      harmonyRepeatPowerCommands: true
    },
    createdAt: new Date('2026-04-01T00:00:00Z'),
    async save() {
      this.saved = true;
    }
  };

  const deleteManyCalls = [];

  Device.find = async (query) => {
    if (query['properties.harmonyDeviceId']) {
      assert.equal(query['properties.harmonyHubIp'], '192.168.1.50');
      assert.equal(query['properties.harmonyDeviceId'], '55');
      return [canonicalDevice];
    }

    if (query.name instanceof RegExp) {
      assert.equal(query.room, 'Family Room');
      assert.equal(query.name.test('Projector'), true);
      return [canonicalDevice];
    }

    throw new Error(`Unexpected Device.find query: ${JSON.stringify(query)}`);
  };
  Device.create = async () => {
    throw new Error('Device.create should not be called when a canonical Harmony raw device already exists');
  };
  Device.deleteMany = async (query) => {
    deleteManyCalls.push(query);
    return { deletedCount: 0 };
  };

  const result = await service.syncDevices({ timeoutMs: 1 });

  assert.equal(result.success, true);
  assert.equal(result.updated, 1);
  assert.equal(canonicalDevice.saved, true);
  assert.equal(canonicalDevice.status, true);
  assert.equal(canonicalDevice.properties.harmonyRepeatPowerCommands, true);
  assert.equal(canonicalDevice.properties.harmonyEntityType, 'device');
  assert.equal(Array.isArray(canonicalDevice.properties.harmonyCommands), true);
  assert.deepEqual(canonicalDevice.properties.harmonyCommands.slice(0, 5), [
    { name: 'PowerOff', label: 'PowerOff', category: 'power', capability: null },
    { name: 'PowerOn', label: 'PowerOn', category: 'power', capability: null },
    { name: 'Mute', label: 'Mute', category: 'volume', capability: 'mute' },
    { name: 'VolumeDown', label: 'VolumeDown', category: 'volume', capability: 'volume_down' },
    { name: 'VolumeUp', label: 'VolumeUp', category: 'volume', capability: 'volume_up' }
  ]);
  assert.deepEqual(canonicalDevice.properties.harmonyControlCommands, {
    volume_up: 'VolumeUp',
    volume_down: 'VolumeDown',
    mute: 'Mute',
    direction_up: 'DirectionUp',
    select: 'Select'
  });
  assert.deepEqual(canonicalDevice.properties.harmonyPowerCommands, {
    on: 'PowerOn',
    off: 'PowerOff',
    toggle: null
  });
  assert.equal(deleteManyCalls.length, 2);
});

test('syncDevices migrates a legacy Harmony raw device row onto stable remoteId identity', async (t) => {
  const originalFind = Device.find;
  const originalCreate = Device.create;
  const originalDeleteMany = Device.deleteMany;

  t.after(() => {
    Device.find = originalFind;
    Device.create = originalCreate;
    Device.deleteMany = originalDeleteMany;
  });

  const service = new HarmonyService();
  service.discoverHubs = async () => [{ ip: '192.168.1.50' }];
  service.getHubSnapshot = async () => ({
    ip: '192.168.1.50',
    friendlyName: 'Bedroom Hub',
    remoteId: 'remote-bedroom',
    currentActivityId: '-1',
    currentActivityLabel: 'Off',
    activities: [],
    devices: [
      {
        id: '77',
        label: 'Amazon Fire TV',
        manufacturer: 'Amazon',
        model: 'Fire TV',
        commands: [
          { name: 'PowerToggle', label: 'PowerToggle', action: 'IR_POWER_TOGGLE' },
          { name: 'Play', label: 'Play', action: 'IR_PLAY' },
          { name: 'Pause', label: 'Pause', action: 'IR_PAUSE' }
        ]
      }
    ]
  });
  service.mergeKnownHubs = async () => [];
  service.syncActivityStates = async () => ({ success: true });

  const legacyDevice = {
    _id: 'legacy-fire-tv',
    name: 'Amazon Fire TV',
    type: 'switch',
    room: 'Bedroom Hub',
    status: false,
    groups: ['Media'],
    brand: 'Amazon',
    model: 'Fire TV',
    properties: {
      source: 'harmony',
      harmonyHubIp: 'bedroom-hub.local',
      harmonyHubName: 'Bedroom Hub',
      harmonyDeviceLabel: 'Amazon Fire TV',
      harmonyRepeatPowerCommands: true
    },
    createdAt: new Date('2026-04-03T00:00:00Z'),
    async save() {
      this.saved = true;
    }
  };

  const deleteManyCalls = [];

  Device.find = async (query) => {
    if (query['properties.harmonyDeviceId']) {
      assert.equal(query['properties.harmonyDeviceId'], '77');
      assert.deepEqual(query.$or, [
        { 'properties.harmonyRemoteId': 'remote-bedroom' },
        { 'properties.harmonyHubIp': '192.168.1.50' }
      ]);
      return [];
    }

    if (query.name instanceof RegExp) {
      assert.equal(query.room, 'Bedroom Hub');
      assert.equal(query.name.test('Amazon Fire TV'), true);
      assert.equal(query.name.test('Amazon Fire TV (2)'), true);
      return [legacyDevice];
    }

    throw new Error(`Unexpected Device.find query: ${JSON.stringify(query)}`);
  };
  Device.create = async () => {
    throw new Error('Device.create should not be called when a legacy Harmony row can be migrated');
  };
  Device.deleteMany = async (query) => {
    deleteManyCalls.push(query);
    return { deletedCount: 0 };
  };

  const result = await service.syncDevices({ timeoutMs: 1 });

  assert.equal(result.success, true);
  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  assert.equal(legacyDevice.saved, true);
  assert.equal(legacyDevice.properties.harmonyDeviceId, '77');
  assert.equal(legacyDevice.properties.harmonyRemoteId, 'remote-bedroom');
  assert.equal(legacyDevice.properties.harmonyHubIp, '192.168.1.50');
  assert.equal(legacyDevice.properties.harmonyRepeatPowerCommands, true);
  assert.equal(deleteManyCalls.length, 2);
});

test('syncDevices removes Harmony raw device rows with auto-numbered duplicate names', async (t) => {
  const originalFind = Device.find;
  const originalCreate = Device.create;
  const originalDeleteMany = Device.deleteMany;

  t.after(() => {
    Device.find = originalFind;
    Device.create = originalCreate;
    Device.deleteMany = originalDeleteMany;
  });

  const service = new HarmonyService();
  service.discoverHubs = async () => [{ ip: '192.168.1.50' }];
  service.getHubSnapshot = async () => ({
    ip: '192.168.1.50',
    friendlyName: 'Bedroom Hub',
    remoteId: 'remote-bedroom',
    currentActivityId: '-1',
    currentActivityLabel: 'Off',
    activities: [],
    devices: [
      {
        id: '77',
        label: 'Amazon Fire TV',
        manufacturer: 'Amazon',
        model: 'Fire TV',
        commands: [
          { name: 'Play', label: 'Play', action: 'IR_PLAY' },
          { name: 'Pause', label: 'Pause', action: 'IR_PAUSE' }
        ]
      }
    ]
  });
  service.mergeKnownHubs = async () => [];
  service.syncActivityStates = async () => ({ success: true });

  const canonicalDevice = {
    _id: 'fire-tv-canonical',
    name: 'Amazon Fire TV',
    type: 'switch',
    room: 'Bedroom Hub',
    status: false,
    groups: ['Media'],
    brand: 'Amazon',
    model: 'Fire TV',
    properties: {
      source: 'harmony',
      harmonyEntityType: 'device',
      harmonyHubIp: '192.168.1.50',
      harmonyRemoteId: 'remote-bedroom',
      harmonyDeviceId: '77',
      harmonyDeviceLabel: 'Amazon Fire TV'
    },
    createdAt: new Date('2026-04-01T00:00:00Z'),
    async save() {
      this.saved = true;
    }
  };

  const duplicateDevice = {
    _id: 'fire-tv-duplicate',
    name: 'Amazon Fire TV (2)',
    type: 'switch',
    room: 'Bedroom Hub',
    status: false,
    groups: ['Favorites'],
    brand: 'Amazon',
    model: 'Fire TV',
    properties: {
      source: 'harmony',
      harmonyHubIp: 'bedroom-hub.local',
      harmonyDeviceLabel: 'Amazon Fire TV'
    },
    createdAt: new Date('2026-04-02T00:00:00Z')
  };

  const deleteManyCalls = [];

  Device.find = async (query) => {
    if (query['properties.harmonyDeviceId']) {
      assert.equal(query['properties.harmonyDeviceId'], '77');
      assert.deepEqual(query.$or, [
        { 'properties.harmonyRemoteId': 'remote-bedroom' },
        { 'properties.harmonyHubIp': '192.168.1.50' }
      ]);
      return [canonicalDevice];
    }

    if (query.name instanceof RegExp) {
      assert.equal(query.room, 'Bedroom Hub');
      assert.equal(query.name.test('Amazon Fire TV'), true);
      assert.equal(query.name.test('Amazon Fire TV (2)'), true);
      return [canonicalDevice, duplicateDevice];
    }

    throw new Error(`Unexpected Device.find query: ${JSON.stringify(query)}`);
  };
  Device.create = async () => {
    throw new Error('Device.create should not be called when a duplicate-numbered Harmony row already exists');
  };
  Device.deleteMany = async (query) => {
    deleteManyCalls.push(query);
    if (query._id) {
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  };

  const result = await service.syncDevices({ timeoutMs: 1 });

  assert.equal(result.success, true);
  assert.equal(result.updated, 1);
  assert.equal(result.deduped, 1);
  assert.equal(canonicalDevice.saved, true);
  assert.equal(canonicalDevice.name, 'Amazon Fire TV');
  assert.deepEqual(canonicalDevice.groups, ['Media', 'Favorites']);
  assert.deepEqual(deleteManyCalls[0], {
    _id: { $in: ['fire-tv-duplicate'] }
  });
});

test('syncDevices removes Harmony raw duplicates even when hub remoteId is unavailable', async (t) => {
  const originalFind = Device.find;
  const originalCreate = Device.create;
  const originalDeleteMany = Device.deleteMany;

  t.after(() => {
    Device.find = originalFind;
    Device.create = originalCreate;
    Device.deleteMany = originalDeleteMany;
  });

  const service = new HarmonyService();
  service.discoverHubs = async () => [{ ip: '192.168.1.50' }];
  service.getHubSnapshot = async () => ({
    ip: '192.168.1.50',
    friendlyName: 'Bedroom Hub',
    remoteId: null,
    currentActivityId: '-1',
    currentActivityLabel: 'Off',
    activities: [],
    devices: [
      {
        id: '77',
        label: 'Amazon Fire TV',
        manufacturer: 'Amazon',
        model: 'Fire TV',
        commands: [
          { name: 'Play', label: 'Play', action: 'IR_PLAY' },
          { name: 'Pause', label: 'Pause', action: 'IR_PAUSE' }
        ]
      }
    ]
  });
  service.mergeKnownHubs = async () => [];
  service.syncActivityStates = async () => ({ success: true });

  const canonicalDevice = {
    _id: 'fire-tv-canonical',
    name: 'Amazon Fire TV',
    type: 'switch',
    room: 'Bedroom Hub',
    status: false,
    groups: ['Media'],
    brand: 'Amazon',
    model: 'Fire TV',
    properties: {
      source: 'harmony',
      harmonyEntityType: 'device',
      harmonyHubIp: '192.168.1.50',
      harmonyDeviceId: '77',
      harmonyDeviceLabel: 'Amazon Fire TV'
    },
    createdAt: new Date('2026-04-01T00:00:00Z'),
    async save() {
      this.saved = true;
    }
  };

  const duplicateDevice = {
    _id: 'fire-tv-duplicate',
    name: 'Amazon Fire TV (2)',
    type: 'switch',
    room: 'Bedroom Hub',
    status: false,
    groups: ['Favorites'],
    brand: 'Amazon',
    model: 'Fire TV',
    properties: {
      source: 'harmony',
      harmonyHubIp: 'bedroom-hub.local',
      harmonyDeviceId: '77',
      harmonyDeviceLabel: 'Amazon Fire TV'
    },
    createdAt: new Date('2026-04-02T00:00:00Z')
  };

  const deleteManyCalls = [];

  Device.find = async (query) => {
    if (query['properties.harmonyDeviceId']) {
      assert.equal(query['properties.harmonyDeviceId'], '77');
      assert.equal(query['properties.harmonyHubIp'], '192.168.1.50');
      return [canonicalDevice];
    }

    if (query.name instanceof RegExp) {
      assert.equal(query.room, 'Bedroom Hub');
      assert.equal(query.name.test('Amazon Fire TV'), true);
      assert.equal(query.name.test('Amazon Fire TV (2)'), true);
      return [canonicalDevice, duplicateDevice];
    }

    throw new Error(`Unexpected Device.find query: ${JSON.stringify(query)}`);
  };
  Device.create = async () => {
    throw new Error('Device.create should not be called when a hostname-drift Harmony duplicate exists');
  };
  Device.deleteMany = async (query) => {
    deleteManyCalls.push(query);
    if (query._id) {
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  };

  const result = await service.syncDevices({ timeoutMs: 1 });

  assert.equal(result.success, true);
  assert.equal(result.updated, 1);
  assert.equal(result.deduped, 1);
  assert.equal(canonicalDevice.saved, true);
  assert.deepEqual(canonicalDevice.groups, ['Media', 'Favorites']);
  assert.deepEqual(deleteManyCalls[0], {
    _id: { $in: ['fire-tv-duplicate'] }
  });
});

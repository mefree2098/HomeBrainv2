const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Device = require('../models/Device');
const Settings = require('../models/Settings');
const Workflow = require('../models/Workflow');

const insteonService = require('../services/insteonService');
const workflowService = require('../services/workflowService');

test('resolveConnectionTarget supports serial:// scheme for USB PLM endpoints', () => {
  const resolved = insteonService.resolveConnectionTarget('serial:///dev/ttyUSB0');

  assert.equal(resolved.transport, 'serial');
  assert.equal(resolved.serialPath, '/dev/ttyUSB0');
  assert.equal(resolved.label, '/dev/ttyUSB0');
});

test('resolveConnectionTarget keeps /dev/serial/by-id endpoints as serial', () => {
  const resolved = insteonService.resolveConnectionTarget('/dev/serial/by-id/usb-Insteon_PLM-if00-port0');

  assert.equal(resolved.transport, 'serial');
  assert.equal(resolved.serialPath, '/dev/serial/by-id/usb-Insteon_PLM-if00-port0');
});

test('resolveConnectionTarget parses host:port shorthand as tcp', () => {
  const resolved = insteonService.resolveConnectionTarget('192.168.1.50:9761');

  assert.equal(resolved.transport, 'tcp');
  assert.equal(resolved.host, '192.168.1.50');
  assert.equal(resolved.port, 9761);
});

test('listLocalSerialPorts merges serialport list entries with /dev/serial/by-id aliases', async (t) => {
  const originalLoadSerialPortModule = insteonService._loadSerialPortModule;
  const originalGetSerialByIdEntries = insteonService._getSerialByIdEntries;
  const originalGetFallbackSerialDevicePaths = insteonService._getFallbackSerialDevicePaths;

  t.after(() => {
    insteonService._loadSerialPortModule = originalLoadSerialPortModule;
    insteonService._getSerialByIdEntries = originalGetSerialByIdEntries;
    insteonService._getFallbackSerialDevicePaths = originalGetFallbackSerialDevicePaths;
  });

  insteonService._loadSerialPortModule = () => ({
    list: async () => ([
      {
        path: '/dev/ttyUSB0',
        manufacturer: 'FTDI',
        vendorId: '0403',
        productId: '6001'
      }
    ])
  });

  insteonService._getSerialByIdEntries = async () => ([
    {
      symlinkPath: '/dev/serial/by-id/usb-Insteon_PLM-if00-port0',
      resolvedPath: '/dev/ttyUSB0'
    }
  ]);
  insteonService._getFallbackSerialDevicePaths = async () => [];

  const ports = await insteonService.listLocalSerialPorts();
  assert.equal(ports.length, 1);
  assert.equal(ports[0].path, '/dev/ttyUSB0');
  assert.equal(ports[0].stablePath, '/dev/serial/by-id/usb-Insteon_PLM-if00-port0');
  assert.equal(ports[0].likelyInsteon, true);
});

test('listLocalSerialPorts includes fallback /dev serial devices when serialport metadata is unavailable', async (t) => {
  const originalLoadSerialPortModule = insteonService._loadSerialPortModule;
  const originalGetSerialByIdEntries = insteonService._getSerialByIdEntries;
  const originalGetFallbackSerialDevicePaths = insteonService._getFallbackSerialDevicePaths;

  t.after(() => {
    insteonService._loadSerialPortModule = originalLoadSerialPortModule;
    insteonService._getSerialByIdEntries = originalGetSerialByIdEntries;
    insteonService._getFallbackSerialDevicePaths = originalGetFallbackSerialDevicePaths;
  });

  insteonService._loadSerialPortModule = () => null;
  insteonService._getSerialByIdEntries = async () => ([
    {
      symlinkPath: '/dev/serial/by-id/usb-Insteon_PLM-if00-port0',
      resolvedPath: '/dev/ttyUSB1'
    }
  ]);
  insteonService._getFallbackSerialDevicePaths = async () => ['/dev/ttyUSB1'];

  const ports = await insteonService.listLocalSerialPorts();
  assert.equal(ports.length, 1);
  assert.equal(ports[0].path, '/dev/ttyUSB1');
  assert.equal(ports[0].stablePath, '/dev/serial/by-id/usb-Insteon_PLM-if00-port0');
  assert.equal(ports[0].likelyInsteon, true);
});

test('getSerialTransportDiagnostics reports serialport load errors clearly', (t) => {
  const originalSerialPortModule = insteonService._serialPortModule;
  const originalSerialPortLoadError = insteonService._serialPortLoadError;

  t.after(() => {
    insteonService._serialPortModule = originalSerialPortModule;
    insteonService._serialPortLoadError = originalSerialPortLoadError;
  });

  insteonService._serialPortModule = null;
  insteonService._serialPortLoadError = new Error('native bindings mismatch');

  const diagnostics = insteonService.getSerialTransportDiagnostics();
  assert.equal(diagnostics.supported, false);
  assert.match(diagnostics.error, /native bindings mismatch/i);
});

test('_buildSerialTransportUnavailableMessage includes endpoint and load details', (t) => {
  const originalSerialPortLoadError = insteonService._serialPortLoadError;

  t.after(() => {
    insteonService._serialPortLoadError = originalSerialPortLoadError;
  });

  insteonService._serialPortLoadError = new Error('NODE_MODULE_VERSION mismatch');
  const message = insteonService._buildSerialTransportUnavailableMessage('/dev/serial/by-id/usb-test-port0');
  assert.match(message, /usb-test-port0/);
  assert.match(message, /NODE_MODULE_VERSION mismatch/);
});

test('_buildSerialTransportUnavailableMessage includes bridge fallback errors', (t) => {
  const originalSerialPortLoadError = insteonService._serialPortLoadError;

  t.after(() => {
    insteonService._serialPortLoadError = originalSerialPortLoadError;
  });

  insteonService._serialPortLoadError = new Error('native module failed');
  const message = insteonService._buildSerialTransportUnavailableMessage(
    '/dev/serial/by-id/usb-test-port0',
    new Error('bridge startup failed')
  );
  assert.match(message, /bridge startup failed/i);
});

test('_isMaskedSecretValue detects masked placeholders', () => {
  assert.equal(insteonService._isMaskedSecretValue('********abcd'), true);
  assert.equal(insteonService._isMaskedSecretValue('••••••••••••'), true);
  assert.equal(insteonService._isMaskedSecretValue('real-password-123'), false);
});

test('_normalizeInsteonInfoPayload maps home-controller info shape into stable fields', () => {
  const normalized = insteonService._normalizeInsteonInfoPayload({
    id: '2F.AA.10',
    firmware: '9E',
    deviceCategory: { id: 2, name: 'Switched Lighting Control' },
    deviceSubCategory: { id: 31 }
  });

  assert.equal(normalized.deviceId, '2FAA10');
  assert.equal(normalized.firmwareVersion, '9E');
  assert.equal(normalized.deviceCategory, 2);
  assert.equal(normalized.subcategory, 31);
});

test('_parseRuntimeCommand treats direct light control as targeting the addressed responder in monitor mode', () => {
  const directCommand = insteonService._parseRuntimeCommand({
    standard: {
      id: '38.9A.D0',
      gatewayId: '38.8A.57',
      messageType: 0,
      command1: '11',
      command2: 'FF'
    }
  });

  assert.ok(directCommand);
  assert.equal(directCommand.address, '389AD0');
  assert.equal(directCommand.sourceAddress, '389AD0');
  assert.equal(directCommand.targetAddress, '388A57');
  assert.equal(directCommand.messageClass, 'direct');
  assert.equal(directCommand.semanticCommand1, '11');
  assert.equal(directCommand.inferredState, null);
  assert.equal(directCommand.stateRefreshRecommended, true);
  assert.equal(directCommand.expectedStatus, true);
});

test('_parseRuntimeCommand only treats light status ACKs as authoritative state observations', () => {
  const statusAck = insteonService._parseRuntimeCommand({
    standard: {
      id: '38.8A.57',
      gatewayId: '38.9A.D0',
      messageType: 1,
      command1: '19',
      command2: 'D1'
    }
  });
  const reservedAck = insteonService._parseRuntimeCommand({
    standard: {
      id: '38.9A.D0',
      gatewayId: '38.8A.57',
      messageType: 1,
      command1: '0D',
      command2: 'FF'
    }
  });

  assert.ok(statusAck);
  assert.equal(statusAck.inferredState.status, true);
  assert.equal(statusAck.inferredState.brightness, 82);
  assert.equal(statusAck.observedState.address, '388A57');
  assert.equal(statusAck.stateRefreshRecommended, false);

  assert.ok(reservedAck);
  assert.equal(reservedAck.inferredState, null);
  assert.equal(reservedAck.observedState, null);
  assert.equal(reservedAck.stateRefreshRecommended, false);
});

test('_parseRuntimeCommand treats all-link scene broadcasts as controller events instead of literal brightness bytes', () => {
  const broadcastCommand = insteonService._parseRuntimeCommand({
    standard: {
      id: '38.89.78',
      messageType: 6,
      gatewayId: '000002',
      command1: '11',
      command2: '01'
    }
  });

  assert.ok(broadcastCommand);
  assert.equal(broadcastCommand.address, '388978');
  assert.equal(broadcastCommand.messageType, 6);
  assert.equal(broadcastCommand.broadcastGroup, 2);
  assert.equal(broadcastCommand.sceneCommand1, '11');
  assert.equal(broadcastCommand.sceneCommand2, '01');
  assert.equal(broadcastCommand.inferredState, null);
  assert.equal(broadcastCommand.stateRefreshRecommended, true);
  assert.equal(broadcastCommand.expectedStatus, true);
});

test('_handleRuntimeCommand queues linked responder refreshes for controller scene broadcasts', async (t) => {
  const originalPersistByAddress = insteonService._persistDeviceRuntimeStateByAddress;
  const originalScheduleRuntimeStateRefresh = insteonService._scheduleRuntimeStateRefresh;
  const originalGetRuntimeSceneResponderAddresses = insteonService._getRuntimeSceneResponderAddresses;

  t.after(() => {
    insteonService._persistDeviceRuntimeStateByAddress = originalPersistByAddress;
    insteonService._scheduleRuntimeStateRefresh = originalScheduleRuntimeStateRefresh;
    insteonService._getRuntimeSceneResponderAddresses = originalGetRuntimeSceneResponderAddresses;
  });

  const persisted = [];
  const scheduledRefreshes = [];

  insteonService._persistDeviceRuntimeStateByAddress = async (address, patch) => {
    persisted.push({ address, patch });
    return patch;
  };
  insteonService._scheduleRuntimeStateRefresh = (address, reason, options) => {
    scheduledRefreshes.push({ address, reason, options });
  };
  insteonService._getRuntimeSceneResponderAddresses = async (address, group) => {
    assert.equal(address, '388978');
    assert.equal(group, 2);
    return ['388A57'];
  };

  await insteonService._handleRuntimeCommand({
    standard: {
      id: '38.89.78',
      messageType: 6,
      gatewayId: '000002',
      command1: '11',
      command2: '01'
    }
  });

  assert.equal(persisted.length, 0);

  assert.equal(scheduledRefreshes.length, 1);
  assert.equal(scheduledRefreshes[0].address, '388A57');

  assert.equal(scheduledRefreshes[0].options.expectedStatus, true);
});

test('_handleRuntimeCommand refreshes the addressed responder for monitor-mode direct light commands', async (t) => {
  const originalPersistByAddress = insteonService._persistDeviceRuntimeStateByAddress;
  const originalScheduleRuntimeStateRefresh = insteonService._scheduleRuntimeStateRefresh;

  t.after(() => {
    insteonService._persistDeviceRuntimeStateByAddress = originalPersistByAddress;
    insteonService._scheduleRuntimeStateRefresh = originalScheduleRuntimeStateRefresh;
  });

  const persisted = [];
  const scheduledRefreshes = [];

  insteonService._persistDeviceRuntimeStateByAddress = async (address, patch) => {
    persisted.push({ address, patch });
    return patch;
  };
  insteonService._scheduleRuntimeStateRefresh = (address, reason, options) => {
    scheduledRefreshes.push({ address, reason, options });
  };

  await insteonService._handleRuntimeCommand({
    standard: {
      id: '38.9A.D0',
      gatewayId: '38.8A.57',
      messageType: 0,
      command1: '11',
      command2: 'FF'
    }
  });

  assert.equal(persisted.length, 0);
  assert.equal(scheduledRefreshes.length, 1);
  assert.equal(scheduledRefreshes[0].address, '388A57');
  assert.equal(scheduledRefreshes[0].reason, 'direct:38.9A.D0:11');
  assert.equal(scheduledRefreshes[0].options.expectedStatus, true);
});

test('_handleRuntimeCommand refreshes the addressed responder for all-link cleanup messages', async (t) => {
  const originalPersistByAddress = insteonService._persistDeviceRuntimeStateByAddress;
  const originalScheduleRuntimeStateRefresh = insteonService._scheduleRuntimeStateRefresh;

  t.after(() => {
    insteonService._persistDeviceRuntimeStateByAddress = originalPersistByAddress;
    insteonService._scheduleRuntimeStateRefresh = originalScheduleRuntimeStateRefresh;
  });

  const persisted = [];
  const scheduledRefreshes = [];

  insteonService._persistDeviceRuntimeStateByAddress = async (address, patch) => {
    persisted.push({ address, patch });
    return patch;
  };
  insteonService._scheduleRuntimeStateRefresh = (address, reason, options) => {
    scheduledRefreshes.push({ address, reason, options });
  };

  await insteonService._handleRuntimeCommand({
    standard: {
      id: '38.89.78',
      gatewayId: '38.8A.57',
      messageType: 2,
      command1: '11',
      command2: '02'
    }
  });

  assert.equal(persisted.length, 0);
  assert.equal(scheduledRefreshes.length, 1);
  assert.equal(scheduledRefreshes[0].address, '388A57');
  assert.equal(scheduledRefreshes[0].reason, 'cleanup:38.89.78:2');
  assert.equal(scheduledRefreshes[0].options.expectedStatus, true);
});

test('_handleRuntimeCommand persists direct status ACKs without an extra refresh query', async (t) => {
  const originalPersistByAddress = insteonService._persistDeviceRuntimeStateByAddress;
  const originalScheduleRuntimeStateRefresh = insteonService._scheduleRuntimeStateRefresh;

  t.after(() => {
    insteonService._persistDeviceRuntimeStateByAddress = originalPersistByAddress;
    insteonService._scheduleRuntimeStateRefresh = originalScheduleRuntimeStateRefresh;
  });

  const persisted = [];
  const scheduledRefreshes = [];

  insteonService._persistDeviceRuntimeStateByAddress = async (address, patch) => {
    persisted.push({ address, patch });
    return patch;
  };
  insteonService._scheduleRuntimeStateRefresh = (address, reason, options) => {
    scheduledRefreshes.push({ address, reason, options });
  };

  await insteonService._handleRuntimeCommand({
    standard: {
      id: '38.8A.57',
      gatewayId: '38.9A.D0',
      messageType: 1,
      command1: '19',
      command2: 'D1'
    }
  });

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].address, '388A57');
  assert.equal(persisted[0].patch.status, true);
  assert.equal(persisted[0].patch.brightness, 82);
  assert.equal(scheduledRefreshes.length, 0);
});

test('_confirmDeviceStateByAddress retries level query and persists confirmed state', async (t) => {
  const originalQueryLevel = insteonService._queryDeviceLevelByAddress;
  const originalPersistByAddress = insteonService._persistDeviceRuntimeStateByAddress;
  const originalSleep = insteonService._sleep;

  t.after(() => {
    insteonService._queryDeviceLevelByAddress = originalQueryLevel;
    insteonService._persistDeviceRuntimeStateByAddress = originalPersistByAddress;
    insteonService._sleep = originalSleep;
  });

  let queryCalls = 0;
  let persistedPatch = null;

  insteonService._queryDeviceLevelByAddress = async () => {
    queryCalls += 1;
    if (queryCalls === 1) {
      throw new Error('temporary timeout');
    }
    return 255;
  };
  insteonService._persistDeviceRuntimeStateByAddress = async (_address, patch) => {
    persistedPatch = patch;
    return patch;
  };
  insteonService._sleep = async () => {};

  const state = await insteonService._confirmDeviceStateByAddress('11.22.33', {
    attempts: 2,
    timeoutMs: 1000,
    pauseBetweenMs: 0
  });

  assert.equal(queryCalls, 2);
  assert.equal(state.status, true);
  assert.equal(state.brightness, 100);
  assert.ok(persistedPatch);
  assert.equal(persistedPatch.status, true);
  assert.equal(persistedPatch.brightness, 100);
});

test('_confirmExpectedDeviceStateByAddress requires stable matching reads', async (t) => {
  const originalQueryLevel = insteonService._queryDeviceLevelByAddress;
  const originalPersistByAddress = insteonService._persistDeviceRuntimeStateByAddress;
  const originalSleep = insteonService._sleep;

  t.after(() => {
    insteonService._queryDeviceLevelByAddress = originalQueryLevel;
    insteonService._persistDeviceRuntimeStateByAddress = originalPersistByAddress;
    insteonService._sleep = originalSleep;
  });

  const queriedLevels = [0, 0];
  const persisted = [];

  insteonService._queryDeviceLevelByAddress = async () => queriedLevels.shift();
  insteonService._persistDeviceRuntimeStateByAddress = async (_address, patch) => {
    persisted.push(patch);
    return patch;
  };
  insteonService._sleep = async () => {};

  const state = await insteonService._confirmExpectedDeviceStateByAddress('11.22.33', false, {
    attempts: 2,
    timeoutMs: 1000,
    pauseBetweenMs: 0,
    settleBetweenMatchesMs: 0,
    requiredMatches: 2
  });

  assert.equal(state.status, false);
  assert.equal(state.confirmedReads, 2);
  assert.equal(persisted.length, 2);
});

test('_confirmExpectedDeviceStateByAddress fails when only a transient matching read is observed', async (t) => {
  const originalQueryLevel = insteonService._queryDeviceLevelByAddress;
  const originalPersistByAddress = insteonService._persistDeviceRuntimeStateByAddress;
  const originalSleep = insteonService._sleep;

  t.after(() => {
    insteonService._queryDeviceLevelByAddress = originalQueryLevel;
    insteonService._persistDeviceRuntimeStateByAddress = originalPersistByAddress;
    insteonService._sleep = originalSleep;
  });

  const queriedLevels = [0, 100];

  insteonService._queryDeviceLevelByAddress = async () => queriedLevels.shift();
  insteonService._persistDeviceRuntimeStateByAddress = async (_address, patch) => patch;
  insteonService._sleep = async () => {};

  await assert.rejects(
    insteonService._confirmExpectedDeviceStateByAddress('11.22.33', false, {
      attempts: 2,
      timeoutMs: 1000,
      pauseBetweenMs: 0,
      settleBetweenMatchesMs: 0,
      requiredMatches: 2
    }),
    /stable OFF state/i
  );
});

test('getStatusSnapshot reports persisted inventory separately from the runtime cache', async (t) => {
  const originalCountDocuments = Device.countDocuments;
  const originalDevices = insteonService.devices;
  const originalConnected = insteonService.isConnected;
  const originalTransport = insteonService.connectionTransport;
  const originalPort = insteonService.connectionTarget;

  t.after(() => {
    Device.countDocuments = originalCountDocuments;
    insteonService.devices = originalDevices;
    insteonService.isConnected = originalConnected;
    insteonService.connectionTransport = originalTransport;
    insteonService.connectionTarget = originalPort;
  });

  Device.countDocuments = async (query = {}) => {
    if (query?.['properties.linkedToCurrentPlm'] === true) {
      return 2;
    }
    return 5;
  };

  insteonService.devices = new Map([['112233', { _id: 'runtime-device-1' }]]);
  insteonService.isConnected = true;
  insteonService.connectionTransport = 'serial';
  insteonService.connectionTarget = '/dev/serial/by-id/test-plm';

  const snapshot = await insteonService.getStatusSnapshot();

  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.deviceCount, 5);
  assert.equal(snapshot.inventory.cachedDeviceCount, 1);
  assert.equal(snapshot.inventory.persistedDeviceCount, 5);
  assert.equal(snapshot.inventory.linkedDatabaseDeviceCount, 2);
  assert.deepEqual(snapshot.diagnostics, []);
});

test('startRuntimeMonitoring attempts a background connect when tracked Insteon devices exist', async (t) => {
  const originalGetSettings = Settings.getSettings;
  const originalCountDocuments = Device.countDocuments;
  const originalFind = Device.find;
  const originalConnect = insteonService.connect;
  const originalIntervalMs = insteonService._runtimeMonitoringIntervalMs;
  const originalIsConnected = insteonService.isConnected;
  const originalHub = insteonService.hub;

  t.after(() => {
    Settings.getSettings = originalGetSettings;
    Device.countDocuments = originalCountDocuments;
    Device.find = originalFind;
    insteonService.connect = originalConnect;
    insteonService._runtimeMonitoringIntervalMs = originalIntervalMs;
    insteonService.isConnected = originalIsConnected;
    insteonService.hub = originalHub;
    insteonService.stopRuntimeMonitoring();
  });

  let connectCalls = 0;

  Settings.getSettings = async () => ({
    insteonPort: '/dev/ttyUSB0'
  });
  Device.countDocuments = async () => 1;
  Device.find = async () => [];
  insteonService.connect = async () => {
    connectCalls += 1;
    insteonService.isConnected = true;
    insteonService.hub = {};
    return { success: true };
  };

  insteonService.isConnected = false;
  insteonService.hub = null;
  insteonService._runtimeMonitoringIntervalMs = 5;

  insteonService.startRuntimeMonitoring({ immediate: true });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(connectCalls, 1);
});

test('_runRuntimeMonitoringPass polls tracked Insteon light state changes', async (t) => {
  const originalFind = Device.find;
  const originalQueryLevelByAddress = insteonService._queryDeviceLevelByAddress;
  const originalPersistDeviceRuntimeState = insteonService._persistDeviceRuntimeState;
  const originalIsConnected = insteonService.isConnected;
  const originalHub = insteonService.hub;
  const originalMonitoringStarted = insteonService._runtimeMonitoringStarted;
  const originalMonitoringInProgress = insteonService._runtimeMonitoringInProgress;
  const originalPollPauseMs = insteonService._runtimeStatePollPauseMs;
  const originalPollMetadata = insteonService._runtimePollMetadata;
  const originalStaleAfterMs = insteonService._runtimeMonitoringStaleAfterMs;
  const originalOfflineStaleAfterMs = insteonService._runtimeMonitoringOfflineStaleAfterMs;
  const originalBatchSize = insteonService._runtimeMonitoringBatchSize;
  const originalScheduleRuntimeMonitoringPass = insteonService._scheduleRuntimeMonitoringPass;

  t.after(() => {
    Device.find = originalFind;
    insteonService._queryDeviceLevelByAddress = originalQueryLevelByAddress;
    insteonService._persistDeviceRuntimeState = originalPersistDeviceRuntimeState;
    insteonService.isConnected = originalIsConnected;
    insteonService.hub = originalHub;
    insteonService._runtimeMonitoringStarted = originalMonitoringStarted;
    insteonService._runtimeMonitoringInProgress = originalMonitoringInProgress;
    insteonService._runtimeStatePollPauseMs = originalPollPauseMs;
    insteonService._runtimePollMetadata = originalPollMetadata;
    insteonService._runtimeMonitoringStaleAfterMs = originalStaleAfterMs;
    insteonService._runtimeMonitoringOfflineStaleAfterMs = originalOfflineStaleAfterMs;
    insteonService._runtimeMonitoringBatchSize = originalBatchSize;
    insteonService._scheduleRuntimeMonitoringPass = originalScheduleRuntimeMonitoringPass;
  });

  const trackedDevice = {
    _id: 'device-9',
    type: 'light',
    status: false,
    brightness: 0,
    isOnline: true,
    properties: {
      source: 'insteon',
      insteonAddress: '11.22.33'
    }
  };

  const persistedPatches = [];

  Device.find = async () => [trackedDevice];
  insteonService._queryDeviceLevelByAddress = async () => 100;
  insteonService._persistDeviceRuntimeState = async (_device, patch) => {
    persistedPatches.push(patch);
    Object.assign(trackedDevice, patch);
    return trackedDevice;
  };
  insteonService._scheduleRuntimeMonitoringPass = () => {};
  insteonService.isConnected = true;
  insteonService.hub = {};
  insteonService._runtimeMonitoringStarted = true;
  insteonService._runtimeMonitoringInProgress = false;
  insteonService._runtimeStatePollPauseMs = 0;
  insteonService._runtimePollMetadata = new Map();
  insteonService._runtimeMonitoringStaleAfterMs = 0;
  insteonService._runtimeMonitoringOfflineStaleAfterMs = 0;
  insteonService._runtimeMonitoringBatchSize = 10;

  await insteonService._runRuntimeMonitoringPass('test');

  assert.equal(persistedPatches.length, 1);
  assert.equal(persistedPatches[0].status, true);
  assert.equal(persistedPatches[0].brightness, 100);
});

test('_shouldPollRuntimeState treats address-bearing Insteon fan loads as pollable', () => {
  const trackedFan = {
    type: 'fan',
    properties: {
      insteonAddress: '38.8A.57'
    }
  };

  assert.equal(insteonService._shouldPollRuntimeState(trackedFan), true);
});

test('_getRuntimeMonitoringEffectiveBatchSize scales above the static default for large Insteon inventories', (t) => {
  const originalBatchSize = insteonService._runtimeMonitoringBatchSize;
  const originalIntervalMs = insteonService._runtimeMonitoringIntervalMs;
  const originalStaleAfterMs = insteonService._runtimeMonitoringStaleAfterMs;

  t.after(() => {
    insteonService._runtimeMonitoringBatchSize = originalBatchSize;
    insteonService._runtimeMonitoringIntervalMs = originalIntervalMs;
    insteonService._runtimeMonitoringStaleAfterMs = originalStaleAfterMs;
  });

  insteonService._runtimeMonitoringBatchSize = 4;
  insteonService._runtimeMonitoringIntervalMs = 30000;
  insteonService._runtimeMonitoringStaleAfterMs = 60000;

  assert.equal(insteonService._getRuntimeMonitoringEffectiveBatchSize(4), 4);
  assert.equal(insteonService._getRuntimeMonitoringEffectiveBatchSize(77), 39);
});

test('_selectRuntimePollBatch rotates across the tracked Insteon inventory instead of reusing the same slice', (t) => {
  const originalBatchSize = insteonService._runtimeMonitoringBatchSize;
  const originalIntervalMs = insteonService._runtimeMonitoringIntervalMs;
  const originalStaleAfterMs = insteonService._runtimeMonitoringStaleAfterMs;
  const originalCursor = insteonService._runtimeMonitoringCursor;

  t.after(() => {
    insteonService._runtimeMonitoringBatchSize = originalBatchSize;
    insteonService._runtimeMonitoringIntervalMs = originalIntervalMs;
    insteonService._runtimeMonitoringStaleAfterMs = originalStaleAfterMs;
    insteonService._runtimeMonitoringCursor = originalCursor;
  });

  insteonService._runtimeMonitoringBatchSize = 2;
  insteonService._runtimeMonitoringIntervalMs = 30000;
  insteonService._runtimeMonitoringStaleAfterMs = 60000;
  insteonService._runtimeMonitoringCursor = 0;

  const pollCandidates = ['11.22.33', '22.33.44', '33.44.55', '44.55.66', '55.66.77', '66.77.88']
    .map((address, index) => ({
      normalizedAddress: address.replaceAll('.', ''),
      lastPolledAt: 0,
      isOffline: false,
      device: {
        _id: `device-${index + 1}`,
        type: 'light',
        properties: {
          source: 'insteon',
          insteonAddress: address
        }
      }
    }));

  const firstSelection = insteonService._selectRuntimePollBatch(pollCandidates);
  const secondSelection = insteonService._selectRuntimePollBatch(pollCandidates);

  assert.deepEqual(
    firstSelection.pollBatch.map((entry) => entry.normalizedAddress),
    ['112233', '223344', '334455']
  );
  assert.deepEqual(
    secondSelection.pollBatch.map((entry) => entry.normalizedAddress),
    ['445566', '556677', '667788']
  );
});

test('_runRuntimeMonitoringPass also tracks address-only Insteon devices without source metadata', async (t) => {
  const originalFind = Device.find;
  const originalQueryLevelByAddress = insteonService._queryDeviceLevelByAddress;
  const originalPersistDeviceRuntimeState = insteonService._persistDeviceRuntimeState;
  const originalIsConnected = insteonService.isConnected;
  const originalHub = insteonService.hub;
  const originalMonitoringStarted = insteonService._runtimeMonitoringStarted;
  const originalMonitoringInProgress = insteonService._runtimeMonitoringInProgress;
  const originalPollPauseMs = insteonService._runtimeStatePollPauseMs;
  const originalPollMetadata = insteonService._runtimePollMetadata;
  const originalStaleAfterMs = insteonService._runtimeMonitoringStaleAfterMs;
  const originalOfflineStaleAfterMs = insteonService._runtimeMonitoringOfflineStaleAfterMs;
  const originalBatchSize = insteonService._runtimeMonitoringBatchSize;
  const originalScheduleRuntimeMonitoringPass = insteonService._scheduleRuntimeMonitoringPass;

  t.after(() => {
    Device.find = originalFind;
    insteonService._queryDeviceLevelByAddress = originalQueryLevelByAddress;
    insteonService._persistDeviceRuntimeState = originalPersistDeviceRuntimeState;
    insteonService.isConnected = originalIsConnected;
    insteonService.hub = originalHub;
    insteonService._runtimeMonitoringStarted = originalMonitoringStarted;
    insteonService._runtimeMonitoringInProgress = originalMonitoringInProgress;
    insteonService._runtimeStatePollPauseMs = originalPollPauseMs;
    insteonService._runtimePollMetadata = originalPollMetadata;
    insteonService._runtimeMonitoringStaleAfterMs = originalStaleAfterMs;
    insteonService._runtimeMonitoringOfflineStaleAfterMs = originalOfflineStaleAfterMs;
    insteonService._runtimeMonitoringBatchSize = originalBatchSize;
    insteonService._scheduleRuntimeMonitoringPass = originalScheduleRuntimeMonitoringPass;
  });

  const trackedDevice = {
    _id: 'device-address-only',
    type: 'light',
    status: false,
    brightness: 0,
    isOnline: true,
    properties: {
      insteonAddress: '38.8A.57'
    }
  };

  const queriedAddresses = [];

  Device.find = async () => [trackedDevice];
  insteonService._queryDeviceLevelByAddress = async (address) => {
    queriedAddresses.push(address);
    return 100;
  };
  insteonService._persistDeviceRuntimeState = async (_device, patch) => {
    Object.assign(trackedDevice, patch);
    return trackedDevice;
  };
  insteonService._scheduleRuntimeMonitoringPass = () => {};
  insteonService.isConnected = true;
  insteonService.hub = {};
  insteonService._runtimeMonitoringStarted = true;
  insteonService._runtimeMonitoringInProgress = false;
  insteonService._runtimeStatePollPauseMs = 0;
  insteonService._runtimePollMetadata = new Map();
  insteonService._runtimeMonitoringStaleAfterMs = 0;
  insteonService._runtimeMonitoringOfflineStaleAfterMs = 0;
  insteonService._runtimeMonitoringBatchSize = 10;

  await insteonService._runRuntimeMonitoringPass('test');

  assert.deepEqual(queriedAddresses, ['388A57']);
});

test('_persistDeviceRuntimeStateByAddress updates every HomeBrain device row that shares an INSTEON address', async (t) => {
  const originalFind = Device.find;
  const originalPersistDeviceRuntimeState = insteonService._persistDeviceRuntimeState;
  const originalLogEngineWarn = insteonService._logEngineWarn;

  t.after(() => {
    Device.find = originalFind;
    insteonService._persistDeviceRuntimeState = originalPersistDeviceRuntimeState;
    insteonService._logEngineWarn = originalLogEngineWarn;
  });

  const duplicateA = {
    _id: 'device-duplicate-a',
    name: 'Master Toilet Fan',
    properties: { insteonAddress: '38.8A.57' }
  };
  const duplicateB = {
    _id: 'device-duplicate-b',
    name: 'Master Toilet Fan Mirror',
    properties: { insteonAddress: '388A57' }
  };

  const persistedDeviceIds = [];
  const warnings = [];

  Device.find = async () => [duplicateA, duplicateB];
  insteonService._persistDeviceRuntimeState = async (device, patch) => {
    persistedDeviceIds.push(String(device._id));
    Object.assign(device, patch);
    return device;
  };
  insteonService._logEngineWarn = (_message, payload) => {
    warnings.push(payload);
  };

  const persisted = await insteonService._persistDeviceRuntimeStateByAddress('38.8A.57', {
    status: true,
    brightness: 100
  });

  assert.equal(persisted, duplicateA);
  assert.deepEqual(persistedDeviceIds, ['device-duplicate-a', 'device-duplicate-b']);
  assert.equal(duplicateA.status, true);
  assert.equal(duplicateB.status, true);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].details.deviceIds, ['device-duplicate-a', 'device-duplicate-b']);
});

test('syncDevicesFromPLM removes duplicate HomeBrain rows for a PLM-linked address even when skipExisting is enabled', async (t) => {
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalGetAllLinkedDevices = insteonService.getAllLinkedDevices;
  const originalFindExistingDevices = insteonService._findExistingInsteonDevicesByAddress;
  const originalReconcileDuplicates = insteonService._reconcileInsteonDuplicateDeviceRows;
  const originalIsConnected = insteonService.isConnected;
  const originalHub = insteonService.hub;

  t.after(() => {
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService.getAllLinkedDevices = originalGetAllLinkedDevices;
    insteonService._findExistingInsteonDevicesByAddress = originalFindExistingDevices;
    insteonService._reconcileInsteonDuplicateDeviceRows = originalReconcileDuplicates;
    insteonService.isConnected = originalIsConnected;
    insteonService.hub = originalHub;
  });

  const canonicalDevice = {
    _id: 'device-keep',
    name: 'Master Toilet Fan',
    properties: {
      source: 'insteon',
      insteonAddress: '388A57'
    }
  };
  const duplicateDevice = {
    _id: 'device-drop',
    name: '38.8A.57',
    properties: {
      source: 'insteon',
      insteonAddress: '38.8A.57'
    }
  };

  insteonService.isConnected = true;
  insteonService.hub = {};
  insteonService.getPLMInfo = async () => ({
    deviceId: 'AA.BB.CC',
    firmwareVersion: '9E',
    deviceCategory: 3,
    subcategory: 0
  });
  insteonService.getAllLinkedDevices = async () => ([
    {
      address: '38.8A.57',
      group: 1,
      type: 'light'
    }
  ]);
  insteonService._findExistingInsteonDevicesByAddress = async () => [canonicalDevice, duplicateDevice];
  insteonService._reconcileInsteonDuplicateDeviceRows = async () => ({
    keptDevice: canonicalDevice,
    removedCount: 1,
    removedDevices: [duplicateDevice]
  });

  const result = await insteonService.syncDevicesFromPLM({ skipExisting: true });

  assert.equal(result.success, true);
  assert.equal(result.created, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.deduped, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Removed 1 duplicate HomeBrain row/i);
});

test('_runRuntimeMonitoringPass defers polling when higher-priority PLM work is queued', async (t) => {
  const originalFind = Device.find;
  const originalQueryLevelByAddress = insteonService._queryDeviceLevelByAddress;
  const originalIsConnected = insteonService.isConnected;
  const originalHub = insteonService.hub;
  const originalMonitoringStarted = insteonService._runtimeMonitoringStarted;
  const originalMonitoringInProgress = insteonService._runtimeMonitoringInProgress;
  const originalPollPauseMs = insteonService._runtimeStatePollPauseMs;
  const originalPollMetadata = insteonService._runtimePollMetadata;
  const originalStaleAfterMs = insteonService._runtimeMonitoringStaleAfterMs;
  const originalOfflineStaleAfterMs = insteonService._runtimeMonitoringOfflineStaleAfterMs;
  const originalBatchSize = insteonService._runtimeMonitoringBatchSize;
  const originalScheduleRuntimeMonitoringPass = insteonService._scheduleRuntimeMonitoringPass;
  const originalQueue = insteonService._plmOperationQueue;
  const originalActiveOperation = insteonService._activePlmOperation;

  t.after(() => {
    Device.find = originalFind;
    insteonService._queryDeviceLevelByAddress = originalQueryLevelByAddress;
    insteonService.isConnected = originalIsConnected;
    insteonService.hub = originalHub;
    insteonService._runtimeMonitoringStarted = originalMonitoringStarted;
    insteonService._runtimeMonitoringInProgress = originalMonitoringInProgress;
    insteonService._runtimeStatePollPauseMs = originalPollPauseMs;
    insteonService._runtimePollMetadata = originalPollMetadata;
    insteonService._runtimeMonitoringStaleAfterMs = originalStaleAfterMs;
    insteonService._runtimeMonitoringOfflineStaleAfterMs = originalOfflineStaleAfterMs;
    insteonService._runtimeMonitoringBatchSize = originalBatchSize;
    insteonService._scheduleRuntimeMonitoringPass = originalScheduleRuntimeMonitoringPass;
    insteonService._plmOperationQueue = originalQueue;
    insteonService._activePlmOperation = originalActiveOperation;
  });

  let queryCalls = 0;
  Device.find = async () => ([{
    _id: 'device-10',
    type: 'light',
    status: false,
    brightness: 0,
    isOnline: true,
    properties: {
      source: 'insteon',
      insteonAddress: '11.22.33'
    }
  }]);
  insteonService._queryDeviceLevelByAddress = async () => {
    queryCalls += 1;
    return 0;
  };
  insteonService._scheduleRuntimeMonitoringPass = () => {};
  insteonService.isConnected = true;
  insteonService.hub = {};
  insteonService._runtimeMonitoringStarted = true;
  insteonService._runtimeMonitoringInProgress = false;
  insteonService._runtimeStatePollPauseMs = 0;
  insteonService._runtimePollMetadata = new Map();
  insteonService._runtimeMonitoringStaleAfterMs = 0;
  insteonService._runtimeMonitoringOfflineStaleAfterMs = 0;
  insteonService._runtimeMonitoringBatchSize = 10;
  insteonService._plmOperationQueue = [{
    priority: 0,
    sequence: 1,
    kind: 'control_command',
    label: 'turning off 11.22.33',
    executor: async () => {},
    resolve: () => {},
    reject: () => {}
  }];
  insteonService._activePlmOperation = null;

  await insteonService._runRuntimeMonitoringPass('test');

  assert.equal(queryCalls, 0);
});

test('turnOn can still do stable synchronous verification when explicitly requested', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalFindById = Device.findById;
  const originalConfirmState = insteonService._confirmExpectedDeviceStateByAddress;
  const originalPersistState = insteonService._persistDeviceRuntimeState;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    Device.findById = originalFindById;
    insteonService._confirmExpectedDeviceStateByAddress = originalConfirmState;
    insteonService._persistDeviceRuntimeState = originalPersistState;
  });

  let hubAddress = null;
  let hubLevel = null;
  insteonService.isConnected = true;
  insteonService.hub = {
    turnOn(address, level, callback) {
      hubAddress = address;
      hubLevel = level;
      callback(null, { ack: true, success: true });
    }
  };
  Device.findById = async () => ({
    _id: 'mock-device',
    model: 'Dimmer Test',
    properties: { insteonAddress: '11.22.33', deviceCategory: 1, subcategory: 0 }
  });
  insteonService._persistDeviceRuntimeState = async (_device, patch) => patch;
  insteonService._confirmExpectedDeviceStateByAddress = async () => ({
    status: true,
    brightness: 68,
    level: 173,
    confirmedReads: 2
  });

  const result = await insteonService.turnOn('mock-device', 68, {
    verificationMode: 'stable'
  });
  assert.equal(hubAddress, '112233');
  assert.equal(hubLevel, 68);
  assert.equal(result.success, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.status, true);
  assert.equal(result.brightness, 68);
  assert.match(result.message, /Insteon PLM 11\.22\.33/i);
  assert.equal(result.details.controlMethod, 'insteon_plm_direct');
  assert.equal(result.details.confirmedReads, 2);
  assert.equal(result.details.commandAcknowledged, true);
});

test('turnOn returns success with warning when verification is inconclusive after the command is acknowledged', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalFindById = Device.findById;
  const originalConfirmState = insteonService._confirmExpectedDeviceStateByAddress;
  const originalPersistState = insteonService._persistDeviceRuntimeState;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    Device.findById = originalFindById;
    insteonService._confirmExpectedDeviceStateByAddress = originalConfirmState;
    insteonService._persistDeviceRuntimeState = originalPersistState;
  });

  let hubAddress = null;
  let persistedPatch = null;
  insteonService.isConnected = true;
  insteonService.hub = {
    turnOn(address, _level, callback) {
      hubAddress = address;
      callback(null, { ack: true, success: true });
    }
  };
  Device.findById = async () => ({
    _id: 'mock-device',
    model: 'Dimmer Test',
    properties: { insteonAddress: '11.22.33', deviceCategory: 2, subcategory: 31 }
  });
  insteonService._persistDeviceRuntimeState = async (_device, patch) => {
    persistedPatch = patch;
    return patch;
  };
  insteonService._confirmExpectedDeviceStateByAddress = async () => {
    const error = new Error('Unable to confirm a stable ON state for 11.22.33. Timeout getting device status for 11.22.33');
    error.code = 'INSTEON_STATE_CONFIRMATION_TIMEOUT';
    error.details = {
      expectedStatus: true,
      lastObservedState: null
    };
    throw error;
  };

  const result = await insteonService.turnOn('mock-device', 68, {
    verificationMode: 'stable'
  });

  assert.equal(hubAddress, '112233');
  assert.equal(result.success, true);
  assert.equal(result.confirmed, false);
  assert.equal(result.status, true);
  assert.equal(result.brightness, 68);
  assert.match(result.message, /verification pending/i);
  assert.match(result.warning, /Timeout getting device status/i);
  assert.equal(result.details.confirmationCode, 'INSTEON_STATE_CONFIRMATION_TIMEOUT');
  assert.equal(result.details.commandAcknowledged, true);
  assert.equal(persistedPatch.status, true);
});

test('turnOn can return after acknowledgement without synchronous verification', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalFindById = Device.findById;
  const originalConfirmState = insteonService._confirmExpectedDeviceStateByAddress;
  const originalPersistState = insteonService._persistDeviceRuntimeState;
  const originalScheduleRuntimeStateRefresh = insteonService._scheduleRuntimeStateRefresh;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    Device.findById = originalFindById;
    insteonService._confirmExpectedDeviceStateByAddress = originalConfirmState;
    insteonService._persistDeviceRuntimeState = originalPersistState;
    insteonService._scheduleRuntimeStateRefresh = originalScheduleRuntimeStateRefresh;
  });

  let confirmCalls = 0;
  let refreshAddress = null;
  insteonService.isConnected = true;
  insteonService.hub = {
    turnOn(_address, _level, callback) {
      callback(null, { ack: true, success: true });
    }
  };
  Device.findById = async () => ({
    _id: 'mock-device',
    model: 'Dimmer Test',
    properties: { insteonAddress: '11.22.33', deviceCategory: 2, subcategory: 31 }
  });
  insteonService._persistDeviceRuntimeState = async (_device, patch) => patch;
  insteonService._confirmExpectedDeviceStateByAddress = async () => {
    confirmCalls += 1;
    throw new Error('should not be called');
  };
  insteonService._scheduleRuntimeStateRefresh = (address) => {
    refreshAddress = address;
  };

  const result = await insteonService.turnOn('mock-device', 68, {
    verificationMode: 'ack'
  });

  assert.equal(confirmCalls, 0);
  assert.equal(refreshAddress, '112233');
  assert.equal(result.success, true);
  assert.equal(result.confirmed, false);
  assert.match(result.message, /async status refresh queued/i);
  assert.equal(result.details.verificationMode, 'ack');
});

test('turnOn uses fast on opcode for full brightness and waits for a post-command settle window', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalFindById = Device.findById;
  const originalConfirmState = insteonService._confirmExpectedDeviceStateByAddress;
  const originalPersistState = insteonService._persistDeviceRuntimeState;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    Device.findById = originalFindById;
    insteonService._confirmExpectedDeviceStateByAddress = originalConfirmState;
    insteonService._persistDeviceRuntimeState = originalPersistState;
  });

  let standardTurnOnCalls = 0;
  let fastTurnOnCalls = 0;
  let receivedConfirmOptions = null;
  insteonService.isConnected = true;
  insteonService.hub = {
    light(_address) {
      return {
        turnOn(_level, _callback) {
          standardTurnOnCalls += 1;
        },
        turnOnFast(callback) {
          fastTurnOnCalls += 1;
          callback(null, { ack: true, success: true });
        }
      };
    }
  };
  Device.findById = async () => ({
    _id: 'mock-device',
    model: 'Dimmer Test',
    properties: { insteonAddress: '11.22.33', deviceCategory: 1, subcategory: 0 }
  });
  insteonService._persistDeviceRuntimeState = async (_device, patch) => patch;
  insteonService._confirmExpectedDeviceStateByAddress = async (_address, _expectedStatus, options = {}) => {
    receivedConfirmOptions = options;
    return {
      status: true,
      brightness: 100,
      level: 100,
      confirmedReads: 1
    };
  };

  const result = await insteonService.turnOn('mock-device', 100);

  assert.equal(standardTurnOnCalls, 0);
  assert.equal(fastTurnOnCalls, 1);
  assert.equal(receivedConfirmOptions.initialDelayMs, 700);
  assert.equal(receivedConfirmOptions.requiredMatches, 1);
  assert.equal(result.success, true);
  assert.equal(result.confirmed, true);
});

test('turnOn can recover after command acknowledgement times out if the device state confirms ON', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalFindById = Device.findById;
  const originalExecuteHubCommandWithTimeout = insteonService._executeHubCommandWithTimeout;
  const originalRecoverCommandStateAfterTimeout = insteonService._recoverCommandStateAfterTimeout;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    Device.findById = originalFindById;
    insteonService._executeHubCommandWithTimeout = originalExecuteHubCommandWithTimeout;
    insteonService._recoverCommandStateAfterTimeout = originalRecoverCommandStateAfterTimeout;
  });

  insteonService.isConnected = true;
  insteonService.hub = {};
  Device.findById = async () => ({
    _id: 'mock-device',
    model: 'Dimmer Test',
    properties: { insteonAddress: '11.22.33', deviceCategory: 1, subcategory: 0 }
  });
  insteonService._executeHubCommandWithTimeout = async () => {
    const error = new Error('Timeout turning on device');
    error.code = 'INSTEON_COMMAND_TIMEOUT';
    throw error;
  };
  insteonService._recoverCommandStateAfterTimeout = async () => ({
    status: true,
    brightness: 100,
    level: 100,
    confirmedReads: 1
  });

  const result = await insteonService.turnOn('mock-device', 100);

  assert.equal(result.success, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.status, true);
  assert.match(result.message, /timed out after 3 attempts, but status confirmed ON/i);
  assert.equal(result.details.commandAcknowledged, false);
  assert.equal(result.details.commandAttempts, 3);
  assert.equal(result.details.verificationRecovered, true);
});

test('turnOff can still do stable synchronous verification when explicitly requested', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalFindById = Device.findById;
  const originalConfirmState = insteonService._confirmExpectedDeviceStateByAddress;
  const originalPersistState = insteonService._persistDeviceRuntimeState;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    Device.findById = originalFindById;
    insteonService._confirmExpectedDeviceStateByAddress = originalConfirmState;
    insteonService._persistDeviceRuntimeState = originalPersistState;
  });

  let hubAddress = null;
  insteonService.isConnected = true;
  insteonService.hub = {
    turnOff(address, callback) {
      hubAddress = address;
      callback(null, { ack: true, success: true });
    }
  };
  Device.findById = async () => ({
    _id: 'mock-device',
    model: 'SwitchLinc Test',
    properties: { insteonAddress: '11.22.33', deviceCategory: 2, subcategory: 31 }
  });
  insteonService._persistDeviceRuntimeState = async (_device, patch) => patch;
  insteonService._confirmExpectedDeviceStateByAddress = async () => ({
    status: false,
    brightness: 0,
    level: 0,
    confirmedReads: 2
  });

  const result = await insteonService.turnOff('mock-device', {
    verificationMode: 'stable'
  });

  assert.equal(hubAddress, '112233');
  assert.equal(result.success, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.status, false);
  assert.match(result.message, /Insteon PLM 11\.22\.33/i);
  assert.equal(result.details.controlMethod, 'insteon_plm_direct');
  assert.equal(result.details.confirmedLevel, 0);
  assert.equal(result.details.commandAcknowledged, true);
});

test('turnOff defaults to fast synchronous verification', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalFindById = Device.findById;
  const originalConfirmState = insteonService._confirmExpectedDeviceStateByAddress;
  const originalPersistState = insteonService._persistDeviceRuntimeState;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    Device.findById = originalFindById;
    insteonService._confirmExpectedDeviceStateByAddress = originalConfirmState;
    insteonService._persistDeviceRuntimeState = originalPersistState;
  });

  let confirmCalls = 0;
  insteonService.isConnected = true;
  insteonService.hub = {
    turnOff(_address, callback) {
      callback(null, { ack: true, success: true });
    }
  };
  Device.findById = async () => ({
    _id: 'mock-device',
    model: 'SwitchLinc Test',
    properties: { insteonAddress: '11.22.33', deviceCategory: 2, subcategory: 31 }
  });
  insteonService._persistDeviceRuntimeState = async (_device, patch) => patch;
  insteonService._confirmExpectedDeviceStateByAddress = async () => {
    confirmCalls += 1;
    return {
      status: false,
      brightness: 0,
      level: 0,
      confirmedReads: 1
    };
  };

  const result = await insteonService.turnOff('mock-device');

  assert.equal(confirmCalls, 1);
  assert.equal(result.success, true);
  assert.equal(result.confirmed, true);
  assert.match(result.message, /confirmed OFF/i);
  assert.equal(result.details.verificationMode, 'fast');
});

test('turnOff uses fast off opcode when available', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalFindById = Device.findById;
  const originalConfirmState = insteonService._confirmExpectedDeviceStateByAddress;
  const originalPersistState = insteonService._persistDeviceRuntimeState;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    Device.findById = originalFindById;
    insteonService._confirmExpectedDeviceStateByAddress = originalConfirmState;
    insteonService._persistDeviceRuntimeState = originalPersistState;
  });

  let standardTurnOffCalls = 0;
  let fastTurnOffCalls = 0;
  insteonService.isConnected = true;
  insteonService.hub = {
    light(_address) {
      return {
        turnOff(_callback) {
          standardTurnOffCalls += 1;
        },
        turnOffFast(callback) {
          fastTurnOffCalls += 1;
          callback(null, { ack: true, success: true });
        }
      };
    }
  };
  Device.findById = async () => ({
    _id: 'mock-device',
    model: 'SwitchLinc Test',
    properties: { insteonAddress: '11.22.33', deviceCategory: 2, subcategory: 31 }
  });
  insteonService._persistDeviceRuntimeState = async (_device, patch) => patch;
  insteonService._confirmExpectedDeviceStateByAddress = async () => ({
    status: false,
    brightness: 0,
    level: 0,
    confirmedReads: 1
  });

  const result = await insteonService.turnOff('mock-device');

  assert.equal(standardTurnOffCalls, 0);
  assert.equal(fastTurnOffCalls, 1);
  assert.equal(result.success, true);
  assert.equal(result.confirmed, true);
});

test('turnOff retries command timeouts before succeeding', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalFindById = Device.findById;
  const originalExecuteHubCommandWithTimeout = insteonService._executeHubCommandWithTimeout;
  const originalConfirmState = insteonService._confirmExpectedDeviceStateByAddress;
  const originalPersistState = insteonService._persistDeviceRuntimeState;
  const originalSleep = insteonService._sleep;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    Device.findById = originalFindById;
    insteonService._executeHubCommandWithTimeout = originalExecuteHubCommandWithTimeout;
    insteonService._confirmExpectedDeviceStateByAddress = originalConfirmState;
    insteonService._persistDeviceRuntimeState = originalPersistState;
    insteonService._sleep = originalSleep;
  });

  let commandCalls = 0;

  insteonService.isConnected = true;
  insteonService.hub = {
    turnOff(_address, callback) {
      callback(null);
    }
  };
  Device.findById = async () => ({
    _id: 'mock-device',
    model: 'SwitchLinc Test',
    properties: { insteonAddress: '11.22.33', deviceCategory: 2, subcategory: 31 }
  });
  insteonService._executeHubCommandWithTimeout = async () => {
    commandCalls += 1;
    if (commandCalls === 1) {
      const error = new Error('Timeout turning off device');
      error.code = 'INSTEON_COMMAND_TIMEOUT';
      throw error;
    }
  };
  insteonService._persistDeviceRuntimeState = async (_device, patch) => patch;
  insteonService._confirmExpectedDeviceStateByAddress = async () => ({
    status: false,
    brightness: 0,
    level: 0,
    confirmedReads: 2
  });
  insteonService._sleep = async () => {};

  const result = await insteonService.turnOff('mock-device', {
    commandAttempts: 2,
    commandPauseBetweenMs: 0,
    verificationMode: 'stable'
  });

  assert.equal(commandCalls, 2);
  assert.equal(result.success, true);
  assert.match(result.message, /after 2 command attempts/i);
  assert.equal(result.details.commandAttempts, 2);
  assert.equal(result.details.commandRetryCount, 1);
});

test('setBrightness routes string zero values to turnOff', async (t) => {
  const originalTurnOn = insteonService.turnOn;
  const originalTurnOff = insteonService.turnOff;

  t.after(() => {
    insteonService.turnOn = originalTurnOn;
    insteonService.turnOff = originalTurnOff;
  });

  let turnOnCalls = 0;
  let turnOffCalls = 0;
  let receivedOptions = null;
  insteonService.turnOn = async () => {
    turnOnCalls += 1;
    return { success: true, action: 'turn_on' };
  };
  insteonService.turnOff = async (_deviceId, options = {}) => {
    turnOffCalls += 1;
    receivedOptions = options;
    return { success: true, action: 'turn_off' };
  };

  const result = await insteonService.setBrightness('mock-device', '0', {
    verificationMode: 'fast'
  });

  assert.equal(turnOnCalls, 0);
  assert.equal(turnOffCalls, 1);
  assert.equal(result.action, 'turn_off');
  assert.equal(receivedOptions.verificationMode, 'fast');
});

test('linkDevice accepts id-based link confirmations', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
  });

  insteonService.isConnected = true;
  insteonService.hub = {
    link(callback) {
      callback(null, {
        id: '11.22.33',
        group: 1,
        type: 'dimmer'
      });
    }
  };

  const result = await insteonService.linkDevice(1);

  assert.equal(result.success, true);
  assert.equal(result.address, '11.22.33');
  assert.equal(result.normalizedAddress, '112233');
  assert.equal(result.group, 1);
});

test('_linkDeviceRemote writes responder and controller links when controller links are enabled', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalCancelLinkingSafe = insteonService._cancelLinkingSafe;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    insteonService._cancelLinkingSafe = originalCancelLinkingSafe;
  });

  const linkCalls = [];
  insteonService.isConnected = true;
  insteonService._cancelLinkingSafe = async () => {};
  insteonService.hub = {
    link(address, options, callback) {
      linkCalls.push({ address, options: { ...options } });
      callback(null, { id: address, controller: options.controller === true });
    }
  };

  const result = await insteonService._linkDeviceRemote('11.22.33', {
    group: 1,
    timeoutMs: 5000,
    ensureControllerLinks: true
  });

  assert.equal(linkCalls.length, 2);
  assert.equal(linkCalls[0].address, '112233');
  assert.equal(linkCalls[0].options.controller, false);
  assert.equal(linkCalls[1].options.controller, true);
  assert.equal(result.controllerLinkError, null);
});

test('_linkDeviceRemote tolerates controller-link failure and returns warning detail', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalCancelLinkingSafe = insteonService._cancelLinkingSafe;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    insteonService._cancelLinkingSafe = originalCancelLinkingSafe;
  });

  insteonService.isConnected = true;
  insteonService._cancelLinkingSafe = async () => {};
  insteonService.hub = {
    link(address, options, callback) {
      if (options.controller === true) {
        callback(new Error('link refused'));
        return;
      }
      callback(null, { id: address, controller: false });
    }
  };

  const result = await insteonService._linkDeviceRemote('11.22.33', {
    group: 1,
    timeoutMs: 5000,
    ensureControllerLinks: true
  });

  assert.ok(result.responderLink);
  assert.equal(result.controllerLink, null);
  assert.ok(result.controllerLinkError instanceof Error);
  assert.match(result.controllerLinkError.message, /link refused/i);
});

test('importDevicesFromISY skips pre-link lookup when PLM id is unavailable', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalParse = insteonService._parseISYImportPayload;
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalDeviceHasLinkToPLM = insteonService._deviceHasLinkToPLM;
  const originalLinkDeviceRemote = insteonService._linkDeviceRemote;
  const originalGetDeviceInfo = insteonService.getDeviceInfo;
  const originalUpsertInsteonDevice = insteonService._upsertInsteonDevice;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    insteonService._parseISYImportPayload = originalParse;
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService._deviceHasLinkToPLM = originalDeviceHasLinkToPLM;
    insteonService._linkDeviceRemote = originalLinkDeviceRemote;
    insteonService.getDeviceInfo = originalGetDeviceInfo;
    insteonService._upsertInsteonDevice = originalUpsertInsteonDevice;
  });

  let linkLookupCalls = 0;
  insteonService.hub = {};
  insteonService.isConnected = true;
  insteonService._parseISYImportPayload = () => ({
    devices: [{ address: '112233', displayAddress: '11.22.33', name: 'Test Device' }],
    invalidEntries: [],
    duplicateCount: 0,
    options: {
      group: 10,
      linkMode: 'remote',
      timeoutMs: 5000,
      pauseBetweenMs: 0,
      retries: 0,
      skipLinking: false,
      checkExistingLinks: true
    }
  });
  insteonService.getPLMInfo = async () => ({ firmwareVersion: '9E', deviceId: null });
  insteonService._deviceHasLinkToPLM = async () => {
    linkLookupCalls += 1;
    return false;
  };
  insteonService._linkDeviceRemote = async () => ({});
  insteonService.getDeviceInfo = async () => ({ deviceCategory: 1, subcategory: 0, firmwareVersion: '9E' });
  insteonService._upsertInsteonDevice = async () => ({
    action: 'created',
    device: { _id: 'mock-device-id' }
  });

  const result = await insteonService.importDevicesFromISY({});

  assert.equal(result.success, true);
  assert.equal(result.failed, 0);
  assert.equal(result.linked, 1);
  assert.equal(linkLookupCalls, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /PLM device ID unavailable/i);
});

test('importDevicesFromISY sanitizes malformed parsed entries instead of aborting import', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalParse = insteonService._parseISYImportPayload;
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalLinkDeviceRemote = insteonService._linkDeviceRemote;
  const originalGetDeviceInfo = insteonService.getDeviceInfo;
  const originalUpsertInsteonDevice = insteonService._upsertInsteonDevice;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    insteonService._parseISYImportPayload = originalParse;
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService._linkDeviceRemote = originalLinkDeviceRemote;
    insteonService.getDeviceInfo = originalGetDeviceInfo;
    insteonService._upsertInsteonDevice = originalUpsertInsteonDevice;
  });

  insteonService.hub = {};
  insteonService.isConnected = true;
  insteonService._parseISYImportPayload = () => ({
    devices: [
      { address: '11.22.33', displayAddress: '11.22.33', name: 'Good Device' },
      { address: undefined, displayAddress: null, name: 'Broken Device' }
    ],
    invalidEntries: [],
    duplicateCount: 0,
    options: {
      group: 10,
      linkMode: 'remote',
      timeoutMs: 5000,
      pauseBetweenMs: 0,
      retries: 0,
      skipLinking: false,
      checkExistingLinks: false
    }
  });
  insteonService.getPLMInfo = async () => ({ firmwareVersion: '9E', deviceId: null });
  insteonService._linkDeviceRemote = async () => ({});
  insteonService.getDeviceInfo = async () => ({ deviceCategory: 1, subcategory: 0, firmwareVersion: '9E' });
  insteonService._upsertInsteonDevice = async () => ({
    action: 'created',
    device: { _id: 'mock-device-id' }
  });

  const result = await insteonService.importDevicesFromISY({});

  assert.equal(result.success, true);
  assert.equal(result.accepted, 1);
  assert.equal(result.invalid, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.imported, 1);
  assert.equal(result.devices.length, 1);
  assert.match(result.invalidEntries[0].reason, /Invalid INSTEON address/i);
});

test('importDevicesFromISY uses fallback metadata when device info lookup times out', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalParse = insteonService._parseISYImportPayload;
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalLinkDeviceRemote = insteonService._linkDeviceRemote;
  const originalGetDeviceInfo = insteonService.getDeviceInfo;
  const originalUpsertInsteonDevice = insteonService._upsertInsteonDevice;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    insteonService._parseISYImportPayload = originalParse;
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService._linkDeviceRemote = originalLinkDeviceRemote;
    insteonService.getDeviceInfo = originalGetDeviceInfo;
    insteonService._upsertInsteonDevice = originalUpsertInsteonDevice;
  });

  let capturedInfo;
  insteonService.hub = {};
  insteonService.isConnected = true;
  insteonService._parseISYImportPayload = () => ({
    devices: [{ address: '11.22.33', displayAddress: '11.22.33', name: 'Slow Device' }],
    invalidEntries: [],
    duplicateCount: 0,
    options: {
      group: 10,
      linkMode: 'remote',
      timeoutMs: 5000,
      pauseBetweenMs: 0,
      retries: 0,
      skipLinking: false,
      checkExistingLinks: false
    }
  });
  insteonService.getPLMInfo = async () => ({ firmwareVersion: '9E', deviceId: null });
  insteonService._linkDeviceRemote = async () => ({});
  insteonService.getDeviceInfo = async () => {
    throw new Error('Timeout getting device info');
  };
  insteonService._upsertInsteonDevice = async (payload) => {
    capturedInfo = payload.deviceInfo;
    return {
      action: 'created',
      device: { _id: 'mock-device-id' }
    };
  };

  const result = await insteonService.importDevicesFromISY({});

  assert.equal(result.success, true);
  assert.equal(result.failed, 0);
  assert.equal(result.imported, 1);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].infoStatus, 'fallback');
  assert.ok(capturedInfo);
  assert.equal(capturedInfo.deviceCategory, 0);
  assert.equal(capturedInfo.subcategory, 0);
  assert.equal(capturedInfo.firmwareVersion, 'Unknown');
});

test('queryLinkedDevicesStatus reports level status and info fallback reachability', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalGetAllLinkedDevices = insteonService.getAllLinkedDevices;
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalQueryDeviceLevelByAddress = insteonService._queryDeviceLevelByAddress;
  const originalQueryDevicePingByAddress = insteonService._queryDevicePingByAddress;
  const originalQueryDeviceInfoByAddress = insteonService._queryDeviceInfoByAddress;
  const originalSleep = insteonService._sleep;
  const originalDeviceFind = Device.find;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    insteonService.getAllLinkedDevices = originalGetAllLinkedDevices;
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService._queryDeviceLevelByAddress = originalQueryDeviceLevelByAddress;
    insteonService._queryDevicePingByAddress = originalQueryDevicePingByAddress;
    insteonService._queryDeviceInfoByAddress = originalQueryDeviceInfoByAddress;
    insteonService._sleep = originalSleep;
    Device.find = originalDeviceFind;
  });

  insteonService.hub = {};
  insteonService.isConnected = true;
  insteonService.getAllLinkedDevices = async () => ([
    { address: 'AABBCC', displayAddress: 'AA.BB.CC', group: 1, controller: false },
    { address: '112233', displayAddress: '11.22.33', group: 1, controller: false }
  ]);
  insteonService.getPLMInfo = async () => ({ deviceId: '010203', firmwareVersion: '9E' });
  insteonService._queryDeviceLevelByAddress = async (address) => {
    if (address === 'AABBCC') {
      return 128;
    }
    throw new Error('NACK');
  };
  insteonService._queryDevicePingByAddress = async () => {
    throw new Error('ping timeout');
  };
  insteonService._queryDeviceInfoByAddress = async () => ({
    firmwareVersion: '1.0',
    deviceCategory: 2,
    subcategory: 1
  });
  insteonService._sleep = async () => {};
  Device.find = async () => ([
    { _id: { toString: () => 'db-device-1' }, name: 'Kitchen Light', properties: { source: 'insteon', insteonAddress: 'AA.BB.CC' } }
  ]);

  const result = await insteonService.queryLinkedDevicesStatus({ pauseBetweenMs: 0 });
  assert.equal(result.success, true);
  assert.equal(result.summary.linkedDevices, 2);
  assert.equal(result.summary.reachable, 2);
  assert.equal(result.summary.unreachable, 0);
  assert.equal(result.summary.statusKnown, 1);
  assert.equal(result.summary.statusUnknown, 1);
  const kitchen = result.devices.find((device) => device.address === 'AABBCC');
  const fallback = result.devices.find((device) => device.address === '112233');
  assert.ok(kitchen);
  assert.ok(fallback);
  assert.equal(kitchen.name, 'Kitchen Light');
  assert.equal(kitchen.status, true);
  assert.equal(kitchen.respondedVia, 'level');
  assert.equal(fallback.status, null);
  assert.equal(fallback.respondedVia, 'info');
  assert.match(fallback.error, /status read unavailable/i);
});

test('queryLinkedDevicesStatus marks device reachable via ping when level query fails', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalGetAllLinkedDevices = insteonService.getAllLinkedDevices;
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalQueryDeviceLevelByAddress = insteonService._queryDeviceLevelByAddress;
  const originalQueryDevicePingByAddress = insteonService._queryDevicePingByAddress;
  const originalQueryDeviceInfoByAddress = insteonService._queryDeviceInfoByAddress;
  const originalSleep = insteonService._sleep;
  const originalDeviceFind = Device.find;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    insteonService.getAllLinkedDevices = originalGetAllLinkedDevices;
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService._queryDeviceLevelByAddress = originalQueryDeviceLevelByAddress;
    insteonService._queryDevicePingByAddress = originalQueryDevicePingByAddress;
    insteonService._queryDeviceInfoByAddress = originalQueryDeviceInfoByAddress;
    insteonService._sleep = originalSleep;
    Device.find = originalDeviceFind;
  });

  let infoLookupCalls = 0;
  insteonService.hub = {};
  insteonService.isConnected = true;
  insteonService.getAllLinkedDevices = async () => ([
    { address: '445566', displayAddress: '44.55.66', group: 1, controller: false }
  ]);
  insteonService.getPLMInfo = async () => ({ deviceId: '010203', firmwareVersion: '9E' });
  insteonService._queryDeviceLevelByAddress = async () => {
    throw new Error('NACK');
  };
  insteonService._queryDevicePingByAddress = async () => ({
    id: '445566',
    command1: '0F',
    command2: '00'
  });
  insteonService._queryDeviceInfoByAddress = async () => {
    infoLookupCalls += 1;
    throw new Error('should not be called when ping succeeds');
  };
  insteonService._sleep = async () => {};
  Device.find = async () => [];

  const result = await insteonService.queryLinkedDevicesStatus({ pauseBetweenMs: 0 });
  assert.equal(result.success, true);
  assert.equal(result.summary.linkedDevices, 1);
  assert.equal(result.summary.reachable, 1);
  assert.equal(result.summary.unreachable, 0);
  assert.equal(result.summary.statusKnown, 0);
  assert.equal(result.summary.statusUnknown, 1);
  assert.equal(result.devices[0].respondedVia, 'ping');
  assert.equal(result.devices[0].reachable, true);
  assert.equal(result.devices[0].status, null);
  assert.equal(infoLookupCalls, 0);
});

test('queryLinkedDevicesStatus marks device unreachable when level and info both fail', async (t) => {
  const originalHub = insteonService.hub;
  const originalConnected = insteonService.isConnected;
  const originalGetAllLinkedDevices = insteonService.getAllLinkedDevices;
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalQueryDeviceLevelByAddress = insteonService._queryDeviceLevelByAddress;
  const originalQueryDevicePingByAddress = insteonService._queryDevicePingByAddress;
  const originalQueryDeviceInfoByAddress = insteonService._queryDeviceInfoByAddress;
  const originalSleep = insteonService._sleep;
  const originalDeviceFind = Device.find;

  t.after(() => {
    insteonService.hub = originalHub;
    insteonService.isConnected = originalConnected;
    insteonService.getAllLinkedDevices = originalGetAllLinkedDevices;
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService._queryDeviceLevelByAddress = originalQueryDeviceLevelByAddress;
    insteonService._queryDevicePingByAddress = originalQueryDevicePingByAddress;
    insteonService._queryDeviceInfoByAddress = originalQueryDeviceInfoByAddress;
    insteonService._sleep = originalSleep;
    Device.find = originalDeviceFind;
  });

  insteonService.hub = {};
  insteonService.isConnected = true;
  insteonService.getAllLinkedDevices = async () => ([
    { address: '445566', displayAddress: '44.55.66', group: 1, controller: false }
  ]);
  insteonService.getPLMInfo = async () => ({ deviceId: '010203', firmwareVersion: '9E' });
  insteonService._queryDeviceLevelByAddress = async () => {
    throw new Error('timeout');
  };
  insteonService._queryDevicePingByAddress = async () => {
    throw new Error('ping timeout');
  };
  insteonService._queryDeviceInfoByAddress = async () => {
    throw new Error('no response');
  };
  insteonService._sleep = async () => {};
  Device.find = async () => [];

  const result = await insteonService.queryLinkedDevicesStatus({ pauseBetweenMs: 0 });
  assert.equal(result.success, true);
  assert.equal(result.summary.linkedDevices, 1);
  assert.equal(result.summary.reachable, 0);
  assert.equal(result.summary.unreachable, 1);
  assert.equal(result.devices[0].respondedVia, 'none');
  assert.equal(result.devices[0].reachable, false);
  assert.match(result.devices[0].error, /level query failed/i);
  assert.match(result.devices[0].error, /ping failed/i);
});

test('startLinkedStatusRun records progress logs and stores completed result', async (t) => {
  const originalQueryLinkedDevicesStatus = insteonService.queryLinkedDevicesStatus;

  t.after(() => {
    insteonService.queryLinkedDevicesStatus = originalQueryLinkedDevicesStatus;
  });

  insteonService.queryLinkedDevicesStatus = async (_payload, runtime = {}) => {
    runtime.onProgress?.({
      stage: 'devices',
      message: 'Processing device 1/1: AA.BB.CC',
      progress: 50
    });
    return {
      success: true,
      message: 'Queried 1 linked device: 1 reachable, 0 unreachable.',
      scannedAt: new Date().toISOString(),
      summary: {
        linkedDevices: 1,
        reachable: 1,
        unreachable: 0,
        statusKnown: 1,
        statusUnknown: 0
      },
      warnings: [],
      devices: []
    };
  };

  const started = insteonService.startLinkedStatusRun({ pauseBetweenMs: 0 });
  assert.ok(started.id);
  assert.equal(started.status, 'running');

  let snapshot = insteonService.getLinkedStatusRun(started.id);
  for (let attempt = 0; attempt < 100 && snapshot?.status === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    snapshot = insteonService.getLinkedStatusRun(started.id);
  }

  assert.ok(snapshot);
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.result?.success, true);
  assert.equal(snapshot.result?.summary?.linkedDevices, 1);
  assert.ok(Array.isArray(snapshot.logs));
  assert.ok(snapshot.logs.some((entry) => /Processing device 1\/1/i.test(entry.message)));
  assert.ok(snapshot.logs.some((entry) => /Queried 1 linked device/i.test(entry.message)));
});

test('cancelLinkedStatusRun transitions active run to cancelled', async (t) => {
  const originalQueryLinkedDevicesStatus = insteonService.queryLinkedDevicesStatus;

  t.after(() => {
    insteonService.queryLinkedDevicesStatus = originalQueryLinkedDevicesStatus;
  });

  insteonService.queryLinkedDevicesStatus = async (_payload, runtime = {}) => {
    runtime.onProgress?.({
      stage: 'devices',
      message: 'Processing device 1/99: 11.22.33',
      progress: 10
    });

    for (let index = 0; index < 200; index += 1) {
      if (runtime.shouldCancel?.()) {
        const cancelled = new Error('Query cancelled by user.');
        cancelled.code = 'QUERY_CANCELLED';
        cancelled.isCancelled = true;
        throw cancelled;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    return {
      success: true,
      message: 'Unexpected completion',
      scannedAt: new Date().toISOString(),
      summary: { linkedDevices: 0, reachable: 0, unreachable: 0, statusKnown: 0, statusUnknown: 0 },
      warnings: [],
      devices: []
    };
  };

  const started = insteonService.startLinkedStatusRun({ pauseBetweenMs: 0 });
  assert.ok(started.id);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancellationResponse = insteonService.cancelLinkedStatusRun(started.id);
  assert.ok(cancellationResponse);
  assert.equal(cancellationResponse.cancelRequested, true);

  let snapshot = insteonService.getLinkedStatusRun(started.id);
  for (let attempt = 0; attempt < 200 && snapshot?.status === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    snapshot = insteonService.getLinkedStatusRun(started.id);
  }

  assert.ok(snapshot);
  assert.equal(snapshot.status, 'cancelled');
  assert.match(snapshot.error || '', /cancelled/i);
  assert.ok(Array.isArray(snapshot.logs));
  assert.ok(snapshot.logs.some((entry) => /cancellation requested/i.test(entry.message)));
  assert.ok(snapshot.logs.some((entry) => /query cancelled/i.test(entry.message)));
});

test('cancelISYSyncRun transitions active migration run to cancelled', async (t) => {
  const originalSyncFromISY = insteonService.syncFromISY;

  t.after(() => {
    insteonService.syncFromISY = originalSyncFromISY;
  });

  insteonService.syncFromISY = async (_payload, runtime = {}) => {
    runtime.onProgress?.({
      stage: 'devices',
      message: 'Processing device 1/72: 11.22.33',
      progress: 10
    });

    for (let index = 0; index < 200; index += 1) {
      if (runtime.shouldCancel?.()) {
        const cancelled = new Error('ISY migration cancelled by user.');
        cancelled.code = 'ISY_SYNC_CANCELLED';
        cancelled.isCancelled = true;
        throw cancelled;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    return {
      success: true,
      message: 'Unexpected completion'
    };
  };

  const started = insteonService.startISYSyncRun({ dryRun: false });
  assert.ok(started.id);
  assert.equal(started.status, 'running');

  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancellationResponse = insteonService.cancelISYSyncRun(started.id);
  assert.ok(cancellationResponse);
  assert.equal(cancellationResponse.cancelRequested, true);

  let snapshot = insteonService.getISYSyncRun(started.id);
  for (let attempt = 0; attempt < 200 && snapshot?.status === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    snapshot = insteonService.getISYSyncRun(started.id);
  }

  assert.ok(snapshot);
  assert.equal(snapshot.status, 'cancelled');
  assert.match(snapshot.error || '', /cancelled/i);
  assert.ok(Array.isArray(snapshot.logs));
  assert.ok(snapshot.logs.some((entry) => /cancellation requested/i.test(entry.message)));
  assert.ok(snapshot.logs.some((entry) => /migration cancelled/i.test(entry.message)));
});

test('_resolveISYConnection ignores masked input password and falls back to stored password', async (t) => {
  const originalGetSettings = Settings.getSettings;

  t.after(() => {
    Settings.getSettings = originalGetSettings;
  });

  Settings.getSettings = async () => ({
    isyHost: '192.168.1.11',
    isyPort: 80,
    isyUsername: 'admin',
    isyPassword: 'actual-secret',
    isyUseHttps: false,
    isyIgnoreTlsErrors: true
  });

  const resolved = await insteonService._resolveISYConnection({
    isyHost: '192.168.1.11',
    isyPort: 80,
    isyUsername: 'admin',
    isyPassword: '********cret',
    isyUseHttps: false
  });

  assert.equal(resolved.password, 'actual-secret');
  assert.equal(resolved.host, '192.168.1.11');
  assert.equal(resolved.port, 80);
  assert.equal(resolved.useHttps, false);
});

test('_resolveISYConnection surfaces masked stored-password corruption clearly', async (t) => {
  const originalGetSettings = Settings.getSettings;

  t.after(() => {
    Settings.getSettings = originalGetSettings;
  });

  Settings.getSettings = async () => ({
    isyHost: '192.168.1.11',
    isyPort: 80,
    isyUsername: 'admin',
    isyPassword: '********abcd',
    isyUseHttps: false,
    isyIgnoreTlsErrors: true
  });

  await assert.rejects(
    insteonService._resolveISYConnection({
      isyHost: '192.168.1.11',
      isyPort: 80,
      isyUsername: 'admin',
      isyUseHttps: false
    }),
    /stored isy password appears masked/i
  );
});

test('_resolveISYConnection persists resolved connection fields when requested', async (t) => {
  const originalGetSettings = Settings.getSettings;
  const originalUpdateSettings = Settings.updateSettings;

  t.after(() => {
    Settings.getSettings = originalGetSettings;
    Settings.updateSettings = originalUpdateSettings;
  });

  const persistedPayloads = [];
  Settings.getSettings = async () => ({
    isyHost: '192.168.1.11',
    isyPort: 80,
    isyUsername: 'admin',
    isyPassword: 'stored-secret',
    isyUseHttps: false,
    isyIgnoreTlsErrors: true
  });
  Settings.updateSettings = async (payload) => {
    persistedPayloads.push(payload);
    return {};
  };

  const resolved = await insteonService._resolveISYConnection({
    isyHost: '192.168.1.22',
    isyPort: 443,
    isyUsername: 'isy-admin',
    isyPassword: 'fresh-secret',
    isyUseHttps: true,
    isyIgnoreTlsErrors: false,
    persistConnection: true
  });

  assert.equal(resolved.host, '192.168.1.22');
  assert.equal(resolved.port, 443);
  assert.equal(resolved.username, 'isy-admin');
  assert.equal(resolved.password, 'fresh-secret');
  assert.equal(persistedPayloads.length, 1);
  assert.deepEqual(persistedPayloads[0], {
    isyHost: '192.168.1.22',
    isyPort: 443,
    isyUsername: 'isy-admin',
    isyUseHttps: true,
    isyIgnoreTlsErrors: false,
    isyPassword: 'fresh-secret'
  });
});

test('_resolveISYConnection persist does not overwrite stored password when no explicit password is provided', async (t) => {
  const originalGetSettings = Settings.getSettings;
  const originalUpdateSettings = Settings.updateSettings;

  t.after(() => {
    Settings.getSettings = originalGetSettings;
    Settings.updateSettings = originalUpdateSettings;
  });

  const persistedPayloads = [];
  Settings.getSettings = async () => ({
    isyHost: '192.168.1.11',
    isyPort: 80,
    isyUsername: 'admin',
    isyPassword: 'stored-secret',
    isyUseHttps: false,
    isyIgnoreTlsErrors: true
  });
  Settings.updateSettings = async (payload) => {
    persistedPayloads.push(payload);
    return {};
  };

  const resolved = await insteonService._resolveISYConnection({
    isyHost: '192.168.1.33',
    isyPort: 8080,
    isyUsername: 'isy-admin',
    isyUseHttps: false,
    isyIgnoreTlsErrors: true,
    persistConnection: true
  });

  assert.equal(resolved.password, 'stored-secret');
  assert.equal(persistedPayloads.length, 1);
  assert.deepEqual(persistedPayloads[0], {
    isyHost: '192.168.1.33',
    isyPort: 8080,
    isyUsername: 'isy-admin',
    isyUseHttps: false,
    isyIgnoreTlsErrors: true
  });
});

test('_probeISYConnection falls back when /rest/ping returns HTTP 404', async (t) => {
  const originalRequestISYResource = insteonService._requestISYResource;

  t.after(() => {
    insteonService._requestISYResource = originalRequestISYResource;
  });

  const requestedPaths = [];
  insteonService._requestISYResource = async (_connection, path) => {
    requestedPaths.push(path);
    if (path === '/rest/ping') {
      throw new Error('ISY request failed for /rest/ping: HTTP 404');
    }
    return '<ok />';
  };

  const probe = await insteonService._probeISYConnection({});
  assert.equal(probe.path, '/rest/config');
  assert.equal(probe.usedFallback, true);
  assert.deepEqual(requestedPaths, ['/rest/ping', '/rest/config']);
});

test('_probeISYConnection does not swallow non-404 errors', async (t) => {
  const originalRequestISYResource = insteonService._requestISYResource;

  t.after(() => {
    insteonService._requestISYResource = originalRequestISYResource;
  });

  insteonService._requestISYResource = async () => {
    throw new Error('ISY request failed for /rest/ping: HTTP 401');
  };

  await assert.rejects(
    insteonService._probeISYConnection({}),
    /HTTP 401/i
  );
});

test('_isLocalSerialBridgeActive returns true only for live bridge process', (t) => {
  const originalBridge = insteonService._localSerialBridge;

  t.after(() => {
    insteonService._localSerialBridge = originalBridge;
  });

  insteonService._localSerialBridge = { process: { exitCode: null, killed: false } };
  assert.equal(insteonService._isLocalSerialBridgeActive(), true);

  insteonService._localSerialBridge = { process: { exitCode: 0, killed: false } };
  assert.equal(insteonService._isLocalSerialBridgeActive(), false);
});

test('_validateSerialEndpoint surfaces missing device with detected endpoint hints', async (t) => {
  const originalListLocalSerialPorts = insteonService.listLocalSerialPorts;
  const originalAccess = fs.promises.access;

  t.after(() => {
    insteonService.listLocalSerialPorts = originalListLocalSerialPorts;
    fs.promises.access = originalAccess;
  });

  insteonService.listLocalSerialPorts = async () => ([
    { path: '/dev/ttyUSB0', stablePath: '/dev/serial/by-id/usb-Insteon_PLM-if00-port0', aliases: [] }
  ]);

  fs.promises.access = async () => {
    const error = new Error('not found');
    error.code = 'ENOENT';
    throw error;
  };

  await assert.rejects(
    insteonService._validateSerialEndpoint('/dev/ttyUSB9'),
    /does not exist.*\/dev\/serial\/by-id\/usb-Insteon_PLM-if00-port0/i
  );
});

test('_validateSerialEndpoint includes stable path when ttyUSB path is used', async (t) => {
  const originalListLocalSerialPorts = insteonService.listLocalSerialPorts;
  const originalAccess = fs.promises.access;

  t.after(() => {
    insteonService.listLocalSerialPorts = originalListLocalSerialPorts;
    fs.promises.access = originalAccess;
  });

  insteonService.listLocalSerialPorts = async () => ([
    { path: '/dev/ttyUSB0', stablePath: '/dev/serial/by-id/usb-Insteon_PLM-if00-port0', aliases: [] }
  ]);
  fs.promises.access = async () => {};

  const result = await insteonService._validateSerialEndpoint('/dev/ttyUSB0');
  assert.equal(result.serialPath, '/dev/ttyUSB0');
  assert.equal(result.stablePath, '/dev/serial/by-id/usb-Insteon_PLM-if00-port0');
});

test('_validateSerialEndpoint auto-resolves missing ttyUSB targets to the single likely INSTEON port', async (t) => {
  const originalListLocalSerialPorts = insteonService.listLocalSerialPorts;
  const originalAccess = fs.promises.access;

  t.after(() => {
    insteonService.listLocalSerialPorts = originalListLocalSerialPorts;
    fs.promises.access = originalAccess;
  });

  insteonService.listLocalSerialPorts = async () => ([
    {
      path: '/dev/ttyUSB1',
      stablePath: '/dev/serial/by-id/usb-Insteon_PLM-if00-port0',
      aliases: ['/dev/serial/by-id/usb-Insteon_PLM-if00-port0'],
      likelyInsteon: true
    }
  ]);

  fs.promises.access = async (targetPath) => {
    if (targetPath === '/dev/ttyUSB0') {
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    }
  };

  const result = await insteonService._validateSerialEndpoint('/dev/ttyUSB0');
  assert.equal(result.serialPath, '/dev/serial/by-id/usb-Insteon_PLM-if00-port0');
  assert.equal(result.stablePath, '/dev/serial/by-id/usb-Insteon_PLM-if00-port0');
  assert.equal(result.requestedPath, '/dev/ttyUSB0');
  assert.equal(result.autoResolved, true);
  assert.equal(result.autoResolvedReason, 'single-likely-insteon-port');
});

test('_normalizeInsteonAddress normalizes separator formats', () => {
  assert.equal(insteonService._normalizeInsteonAddress('aa.bb.cc'), 'AABBCC');
  assert.equal(insteonService._normalizeInsteonAddress('aa bb cc'), 'AABBCC');
  assert.equal(insteonService._normalizeInsteonAddress('aa-bb-cc'), 'AABBCC');
});

test('_parseISYImportPayload parses and deduplicates mixed payload formats', () => {
  const parsed = insteonService._parseISYImportPayload({
    deviceIds: ['aa.bb.cc', '11.22.33', 'AABBCC'],
    rawDeviceList: 'Kitchen 44.55.66\nInvalid XYZ\n11-22-33',
    group: 2,
    retries: 0
  });

  assert.equal(parsed.devices.length, 3);
  assert.equal(parsed.devices[0].address, 'AABBCC');
  assert.equal(parsed.devices[1].address, '112233');
  assert.equal(parsed.devices[2].address, '445566');
  assert.equal(parsed.duplicateCount, 2);
  assert.equal(parsed.options.group, 2);
  assert.equal(parsed.options.retries, 0);
});

test('_parseISYImportPayload accepts ISY node object variants with resolved/normalized addresses', () => {
  const parsed = insteonService._parseISYImportPayload({
    devices: [
      { resolvedAddress: 'AA.BB.CC', name: 'Kitchen' },
      { normalizedAddress: '112233', displayName: 'Hallway' },
      { properties: { insteonAddress: '44-55-66' } }
    ]
  });

  assert.equal(parsed.devices.length, 3);
  assert.equal(parsed.devices[0].address, 'AABBCC');
  assert.equal(parsed.devices[1].address, '112233');
  assert.equal(parsed.devices[2].address, '445566');
  assert.equal(parsed.invalidEntries.length, 0);
});

test('_parseISYImportPayload keeps friendly names when duplicate IDs arrive across payload fields', () => {
  const parsed = insteonService._parseISYImportPayload({
    deviceIds: ['AA.BB.CC'],
    devices: [{ address: 'AA.BB.CC', name: 'Kitchen Dimmer' }]
  });

  assert.equal(parsed.devices.length, 1);
  assert.equal(parsed.devices[0].address, 'AABBCC');
  assert.equal(parsed.devices[0].name, 'Kitchen Dimmer');
  assert.equal(parsed.duplicateCount, 1);
});

test('_parseISYImportPayload rejects out-of-range group values', () => {
  assert.throws(
    () => insteonService._parseISYImportPayload({ deviceIds: ['AA.BB.CC'], group: 300 }),
    /group must be an integer between 0 and 255/i
  );
});

test('_parseISYTopologyPayload parses scene topology with mixed address formats', () => {
  const parsed = insteonService._parseISYTopologyPayload({
    dryRun: true,
    scenes: [
      {
        name: 'Movie Lights',
        group: 3,
        controller: 'gw',
        responders: [
          { id: 'aa.bb.cc', level: 20, ramp: 2000 },
          '11-22-33'
        ]
      }
    ]
  });

  assert.equal(parsed.scenes.length, 1);
  assert.equal(parsed.scenes[0].controller, 'gw');
  assert.equal(parsed.scenes[0].group, 3);
  assert.equal(parsed.scenes[0].responders[0].id, 'AABBCC');
  assert.equal(parsed.scenes[0].responders[1].id, '112233');
  assert.equal(parsed.options.dryRun, true);
});

test('_parseISYTopologyPayload converts linkRecords into scene operations', () => {
  const parsed = insteonService._parseISYTopologyPayload({
    dryRun: true,
    linkRecords: [
      {
        controller: 'gw',
        group: 5,
        responder: 'AA.BB.CC'
      },
      {
        controller: 'gw',
        group: 5,
        responder: { id: '11.22.33', level: 40 }
      }
    ]
  });

  assert.equal(parsed.scenes.length, 1);
  assert.equal(parsed.scenes[0].group, 5);
  assert.equal(parsed.scenes[0].responders.length, 2);
});

test('_parseISYTopologyPayload rejects missing responders', () => {
  assert.throws(
    () => insteonService._parseISYTopologyPayload({
      scenes: [{ name: 'Broken', group: 1, controller: 'gw', responders: [] }]
    }),
    /no valid isy scene topology entries/i
  );
});

test('_parseISYTopologyPayload enables existing-scene checks by default', () => {
  const parsed = insteonService._parseISYTopologyPayload({
    scenes: [{ name: 'Scene', group: 1, controller: '11.22.33', responders: ['AA.BB.CC'] }]
  });

  assert.equal(parsed.options.checkExistingSceneLinks, true);
});

test('_parseISYTopologyPayload enables responder fallback by default', () => {
  const parsed = insteonService._parseISYTopologyPayload({
    scenes: [{ name: 'Scene', group: 1, controller: '11.22.33', responders: ['AA.BB.CC'] }]
  });
  assert.equal(parsed.options.responderFallback, true);

  const disabled = insteonService._parseISYTopologyPayload({
    responderFallback: false,
    scenes: [{ name: 'Scene', group: 1, controller: '11.22.33', responders: ['AA.BB.CC'] }]
  });
  assert.equal(disabled.options.responderFallback, false);
});

test('_isISYInsteonNode accepts family 1 and excludes explicit non-insteon families', () => {
  assert.equal(insteonService._isISYInsteonNode({
    family: '1',
    resolvedAddress: 'AA.BB.CC'
  }), true);

  assert.equal(insteonService._isISYInsteonNode({
    family: '',
    resolvedAddress: '11.22.33'
  }), true);

  assert.equal(insteonService._isISYInsteonNode({
    family: '4',
    resolvedAddress: '44.55.66'
  }), false);
});

test('_buildISYDeviceReplayList deduplicates addresses and keeps friendly names', () => {
  const replayList = insteonService._buildISYDeviceReplayList([
    {
      address: '31.41.0F.1',
      resolvedAddress: '31.41.0F',
      name: '31.41.0F.1'
    },
    {
      address: '31.41.0F',
      resolvedAddress: '31.41.0F',
      name: 'Kitchen Main'
    },
    {
      address: 'AA.BB.CC',
      resolvedAddress: 'AA.BB.CC',
      name: 'Hall Light'
    }
  ]);

  assert.equal(replayList.length, 2);
  const keypad = replayList.find((entry) => entry.address === '31410F');
  const hall = replayList.find((entry) => entry.address === 'AABBCC');
  assert.ok(keypad);
  assert.ok(hall);
  assert.equal(keypad.name, 'Kitchen Main');
  assert.equal(hall.name, 'Hall Light');
});

test('syncFromISY passes extracted device names into device replay payload', async (t) => {
  const originalExtractISYData = insteonService.extractISYData;
  const originalImportDevicesFromISY = insteonService.importDevicesFromISY;
  const originalApplyISYSceneTopology = insteonService.applyISYSceneTopology;
  const originalImportPrograms = insteonService.importISYProgramsAsWorkflows;

  t.after(() => {
    insteonService.extractISYData = originalExtractISYData;
    insteonService.importDevicesFromISY = originalImportDevicesFromISY;
    insteonService.applyISYSceneTopology = originalApplyISYSceneTopology;
    insteonService.importISYProgramsAsWorkflows = originalImportPrograms;
  });

  let capturedPayload = null;
  insteonService.extractISYData = async () => ({
    connection: {
      host: '192.168.1.11',
      port: 80,
      useHttps: false,
      ignoreTlsErrors: true,
      username: 'admin',
      passwordMasked: '******'
    },
    devices: [
      { address: '31.41.0F.1', resolvedAddress: '31.41.0F', name: '31.41.0F.1', family: '1' },
      { address: '31.41.0F', resolvedAddress: '31.41.0F', name: 'Kitchen Main', family: '1' },
      { address: 'AA.BB.CC', resolvedAddress: 'AA.BB.CC', name: 'Hall Light', family: '1' }
    ],
    excludedNodes: 0,
    groups: [],
    programs: [],
    networkResources: [],
    deviceIds: ['31410F', 'AABBCC'],
    topologyScenes: [],
    counts: {
      nodes: 3,
      insteonNodes: 3,
      excludedNonInsteonNodes: 0,
      groups: 0,
      programs: 0,
      networkResources: 0,
      programsWithLogicBlocks: 0,
      uniqueDeviceIds: 2,
      topologyScenes: 0
    }
  });
  insteonService.importDevicesFromISY = async (payload) => {
    capturedPayload = payload;
    return {
      success: true,
      accepted: 2,
      linked: 2,
      linkWriteAttempts: 2,
      linkWriteSucceeded: 2,
      linkWriteFailed: 0,
      failed: 0,
      imported: 2,
      updated: 0
    };
  };
  insteonService.applyISYSceneTopology = async () => {
    throw new Error('applyISYSceneTopology should not be called in this test');
  };
  insteonService.importISYProgramsAsWorkflows = async () => {
    throw new Error('importISYProgramsAsWorkflows should not be called in this test');
  };

  const result = await insteonService.syncFromISY({
    dryRun: false,
    importDevices: true,
    importTopology: false,
    importPrograms: false
  });

  assert.equal(result.success, true);
  assert.ok(capturedPayload);
  assert.equal(Array.isArray(capturedPayload.devices), true);
  assert.equal(capturedPayload.devices.length, 2);
  const keypad = capturedPayload.devices.find((entry) => entry.address === '31410F');
  const hall = capturedPayload.devices.find((entry) => entry.address === 'AABBCC');
  assert.ok(keypad);
  assert.ok(hall);
  assert.equal(keypad.name, 'Kitchen Main');
  assert.equal(hall.name, 'Hall Light');
  assert.equal(capturedPayload.checkExistingLinks, false);
});

test('_upsertInsteonDevice upgrades switch metadata to light and applies resolved name', async (t) => {
  const originalFindExisting = insteonService._findExistingInsteonDeviceByAddress;
  const originalFindExistingDevices = insteonService._findExistingInsteonDevicesByAddress;
  const originalGetDeviceInfo = insteonService.getDeviceInfo;

  t.after(() => {
    insteonService._findExistingInsteonDeviceByAddress = originalFindExisting;
    insteonService._findExistingInsteonDevicesByAddress = originalFindExistingDevices;
    insteonService.getDeviceInfo = originalGetDeviceInfo;
  });

  const existingDevice = {
    _id: 'device-1',
    name: '31.41.F1',
    type: 'switch',
    room: 'Unassigned',
    brand: 'Insteon',
    model: 'Unknown',
    properties: {
      source: 'insteon',
      insteonAddress: '3141F1',
      deviceCategory: 0,
      subcategory: 0
    },
    isOnline: false,
    lastSeen: null,
    save: async function save() {
      return this;
    }
  };

  insteonService._findExistingInsteonDeviceByAddress = async () => existingDevice;
  insteonService._findExistingInsteonDevicesByAddress = async () => [existingDevice];
  insteonService.getDeviceInfo = async () => ({
    deviceId: '3141F1',
    deviceCategory: 1,
    subcategory: 46,
    productKey: '2477D'
  });

  const result = await insteonService._upsertInsteonDevice({
    address: '31.41.F1',
    group: 1,
    name: 'Kitchen Main',
    markLinkedToCurrentPlm: true
  });

  assert.equal(result.action, 'updated');
  assert.equal(existingDevice.name, 'Kitchen Main');
  assert.equal(existingDevice.type, 'light');
  assert.equal(existingDevice.model, '2477D');
  assert.equal(existingDevice.properties.deviceCategory, 1);
  assert.equal(existingDevice.properties.subcategory, 46);
  assert.equal(existingDevice.properties.supportsBrightness, true);
  assert.equal(existingDevice.properties.linkedToCurrentPlm, true);
});

test('_upsertInsteonDevice treats fan-labeled Insteon loads like fader switches when metadata is incomplete', async (t) => {
  const originalFindExisting = insteonService._findExistingInsteonDeviceByAddress;
  const originalFindExistingDevices = insteonService._findExistingInsteonDevicesByAddress;
  const originalGetDeviceInfo = insteonService.getDeviceInfo;
  const originalCreate = Device.create;

  t.after(() => {
    insteonService._findExistingInsteonDeviceByAddress = originalFindExisting;
    insteonService._findExistingInsteonDevicesByAddress = originalFindExistingDevices;
    insteonService.getDeviceInfo = originalGetDeviceInfo;
    Device.create = originalCreate;
  });

  let createdPayload = null;
  Device.create = async (payload) => {
    createdPayload = payload;
    return {
      ...payload,
      _id: 'device-fan',
      save: async function save() {
        return this;
      }
    };
  };

  insteonService._findExistingInsteonDeviceByAddress = async () => null;
  insteonService._findExistingInsteonDevicesByAddress = async () => [];
  insteonService.getDeviceInfo = async () => ({
    deviceId: '388A57',
    deviceCategory: 0,
    subcategory: 0,
    productKey: 'Unknown'
  });

  const result = await insteonService._upsertInsteonDevice({
    address: '38.8A.57',
    name: 'Master Toilet Fan'
  });

  assert.equal(result.action, 'created');
  assert.equal(createdPayload.name, 'Master Toilet Fan');
  assert.equal(createdPayload.type, 'light');
  assert.equal(createdPayload.properties.supportsBrightness, true);
});

test('_upsertInsteonDevice preserves known category metadata when refreshed info is unavailable', async (t) => {
  const originalFindExisting = insteonService._findExistingInsteonDeviceByAddress;
  const originalFindExistingDevices = insteonService._findExistingInsteonDevicesByAddress;
  const originalGetDeviceInfo = insteonService.getDeviceInfo;

  t.after(() => {
    insteonService._findExistingInsteonDeviceByAddress = originalFindExisting;
    insteonService._findExistingInsteonDevicesByAddress = originalFindExistingDevices;
    insteonService.getDeviceInfo = originalGetDeviceInfo;
  });

  const existingDevice = {
    _id: 'device-2',
    name: 'Hall Dimmer',
    type: 'light',
    room: 'Unassigned',
    brand: 'Insteon',
    model: '2477D',
    properties: {
      source: 'insteon',
      insteonAddress: 'AABBCC',
      deviceCategory: 1,
      subcategory: 46,
      supportsBrightness: true
    },
    isOnline: true,
    lastSeen: null,
    save: async function save() {
      return this;
    }
  };

  insteonService._findExistingInsteonDeviceByAddress = async () => existingDevice;
  insteonService._findExistingInsteonDevicesByAddress = async () => [existingDevice];
  insteonService.getDeviceInfo = async () => ({
    deviceId: 'AABBCC',
    deviceCategory: 0,
    subcategory: 0,
    firmwareVersion: 'Unknown'
  });

  const result = await insteonService._upsertInsteonDevice({
    address: 'AA.BB.CC',
    group: 1,
    name: 'Hall Dimmer'
  });

  assert.equal(result.action, 'updated');
  assert.equal(existingDevice.type, 'light');
  assert.equal(existingDevice.properties.deviceCategory, 1);
  assert.equal(existingDevice.properties.subcategory, 46);
  assert.equal(existingDevice.properties.supportsBrightness, true);
});

test('_upsertInsteonDevice removes duplicate HomeBrain rows that point at the same INSTEON address', async (t) => {
  const originalFindExistingDevices = insteonService._findExistingInsteonDevicesByAddress;
  const originalGetDeviceInfo = insteonService.getDeviceInfo;
  const originalDeleteMany = Device.deleteMany;

  t.after(() => {
    insteonService._findExistingInsteonDevicesByAddress = originalFindExistingDevices;
    insteonService.getDeviceInfo = originalGetDeviceInfo;
    Device.deleteMany = originalDeleteMany;
  });

  const canonicalDevice = {
    _id: 'device-keep',
    name: 'Master Toilet Fan',
    type: 'light',
    room: 'Primary Bath',
    groups: ['Fans'],
    brand: 'Insteon',
    model: '2477D',
    properties: {
      source: 'insteon',
      insteonAddress: '388A57',
      linkedToCurrentPlm: true,
      supportsBrightness: true,
      deviceCategory: 1,
      subcategory: 46
    },
    isOnline: false,
    lastSeen: null,
    save: async function save() {
      return this;
    }
  };
  const duplicateDevice = {
    _id: 'device-drop',
    name: '38.8A.57',
    type: 'switch',
    room: 'Unassigned',
    groups: [],
    brand: 'Insteon',
    model: 'Unknown',
    properties: {
      source: 'insteon',
      insteonAddress: '38.8A.57'
    }
  };

  let deletedQuery = null;

  insteonService._findExistingInsteonDevicesByAddress = async () => [canonicalDevice, duplicateDevice];
  insteonService.getDeviceInfo = async () => ({
    deviceId: '388A57',
    deviceCategory: 1,
    subcategory: 46,
    productKey: '2477D'
  });
  Device.deleteMany = async (query) => {
    deletedQuery = query;
    return { deletedCount: 1 };
  };

  const result = await insteonService._upsertInsteonDevice({
    address: '38.8A.57',
    group: 1,
    markLinkedToCurrentPlm: true
  });

  assert.equal(result.action, 'updated');
  assert.equal(result.device, canonicalDevice);
  assert.equal(result.removedDuplicates, 1);
  assert.deepEqual(deletedQuery, {
    _id: { $in: ['device-drop'] }
  });
});

test('_isTopologySceneAlreadyLinked resolves gw controller using PLM id', async (t) => {
  const originalHasResponderLink = insteonService._deviceHasResponderLinkToController;

  t.after(() => {
    insteonService._deviceHasResponderLinkToController = originalHasResponderLink;
  });

  const calls = [];
  insteonService._deviceHasResponderLinkToController = async (responder, group, controller) => {
    calls.push({ responder, group, controller });
    return true;
  };

  const alreadyLinked = await insteonService._isTopologySceneAlreadyLinked({
    name: 'Scene 1',
    group: 9,
    controller: 'gw',
    responders: [{ id: 'AA.BB.CC' }]
  }, { normalizedPlmId: '112233' });

  assert.equal(alreadyLinked, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { responder: 'AABBCC', group: 9, controller: '112233' });
});

test('applyISYSceneTopology skips scenes already in desired state', async (t) => {
  const originalConnected = insteonService.isConnected;
  const originalHub = insteonService.hub;
  const originalParseTopologyPayload = insteonService._parseISYTopologyPayload;
  const originalGetPLMInfo = insteonService.getPLMInfo;
  const originalIsSceneAlreadyLinked = insteonService._isTopologySceneAlreadyLinked;
  const originalApplyTopologyScene = insteonService._applyTopologyScene;
  const originalSleep = insteonService._sleep;

  t.after(() => {
    insteonService.isConnected = originalConnected;
    insteonService.hub = originalHub;
    insteonService._parseISYTopologyPayload = originalParseTopologyPayload;
    insteonService.getPLMInfo = originalGetPLMInfo;
    insteonService._isTopologySceneAlreadyLinked = originalIsSceneAlreadyLinked;
    insteonService._applyTopologyScene = originalApplyTopologyScene;
    insteonService._sleep = originalSleep;
  });

  let applyCalls = 0;
  insteonService.isConnected = true;
  insteonService.hub = {};
  insteonService._parseISYTopologyPayload = () => ({
    scenes: [{ name: 'Scene 1', group: 1, controller: '11.22.33', remove: false, responders: [{ id: 'AA.BB.CC' }] }],
    invalidEntries: [],
    options: {
      dryRun: false,
      upsertDevices: false,
      continueOnError: true,
      checkExistingSceneLinks: true,
      pauseBetweenScenesMs: 0,
      sceneTimeoutMs: 5000
    }
  });
  insteonService.getPLMInfo = async () => ({ deviceId: '010203' });
  insteonService._isTopologySceneAlreadyLinked = async () => true;
  insteonService._applyTopologyScene = async () => {
    applyCalls += 1;
  };
  insteonService._sleep = async () => {};

  const result = await insteonService.applyISYSceneTopology({});
  assert.equal(result.success, true);
  assert.equal(result.sceneCount, 1);
  assert.equal(result.appliedScenes, 0);
  assert.equal(result.skippedExistingScenes, 1);
  assert.equal(result.failedScenes, 0);
  assert.equal(applyCalls, 0);
  assert.equal(result.scenes[0].status, 'already-linked');
});

test('_applyTopologyScene falls back to per-responder writes when bulk scene write fails', async (t) => {
  const originalConnected = insteonService.isConnected;
  const originalHub = insteonService.hub;

  t.after(() => {
    insteonService.isConnected = originalConnected;
    insteonService.hub = originalHub;
  });

  const sceneCalls = [];
  const fallbackMessages = [];
  insteonService.isConnected = true;
  insteonService.hub = {
    cancelLinking: async () => {},
    scene: (_controller, responders, _options, callback) => {
      sceneCalls.push(responders.map((entry) => entry.id).join(','));
      if (responders.length > 1) {
        callback(new Error('bulk write timeout'));
        return;
      }
      callback(null);
    }
  };

  const result = await insteonService._applyTopologyScene({
    name: 'Movie Scene',
    group: 9,
    controller: 'AABBCC',
    remove: false,
    responders: [
      { id: '112233' },
      { id: '445566' }
    ]
  }, {
    timeoutMs: 5000,
    responderFallback: true,
    onFallbackProgress: (message) => fallbackMessages.push(message)
  });

  assert.equal(result.fallbackUsed, true);
  assert.equal(result.failedResponders.length, 0);
  assert.deepEqual(result.appliedResponders, ['112233', '445566']);
  assert.deepEqual(sceneCalls, ['112233,445566', '112233', '445566']);
  assert.equal(fallbackMessages.length > 0, true);
});

test('applyISYSceneTopology marks partial scenes when responder fallback has failures', async (t) => {
  const originalConnected = insteonService.isConnected;
  const originalHub = insteonService.hub;
  const originalParseTopologyPayload = insteonService._parseISYTopologyPayload;
  const originalApplyTopologyScene = insteonService._applyTopologyScene;
  const originalSleep = insteonService._sleep;

  t.after(() => {
    insteonService.isConnected = originalConnected;
    insteonService.hub = originalHub;
    insteonService._parseISYTopologyPayload = originalParseTopologyPayload;
    insteonService._applyTopologyScene = originalApplyTopologyScene;
    insteonService._sleep = originalSleep;
  });

  insteonService.isConnected = true;
  insteonService.hub = {};
  insteonService._parseISYTopologyPayload = () => ({
    scenes: [{ name: 'Scene 1', group: 1, controller: '11.22.33', remove: false, responders: [{ id: 'AA.BB.CC' }, { id: '44.55.66' }] }],
    invalidEntries: [],
    options: {
      dryRun: false,
      upsertDevices: false,
      continueOnError: true,
      checkExistingSceneLinks: false,
      responderFallback: true,
      pauseBetweenScenesMs: 0,
      sceneTimeoutMs: 5000
    }
  });
  insteonService._applyTopologyScene = async () => ({
    fallbackUsed: true,
    fullSceneError: 'bulk write timeout',
    appliedResponders: ['AABBCC'],
    failedResponders: [{ id: '445566', error: 'responder timeout' }]
  });
  insteonService._sleep = async () => {};

  const result = await insteonService.applyISYSceneTopology({});
  assert.equal(result.success, true);
  assert.equal(result.appliedScenes, 1);
  assert.equal(result.partialScenes, 1);
  assert.equal(result.fallbackScenes, 1);
  assert.equal(result.failedScenes, 0);
  assert.equal(result.scenes[0].status, 'applied-partial');
  assert.equal(result.scenes[0].fallbackUsed, true);
  assert.equal(Array.isArray(result.scenes[0].failedResponders), true);
  assert.equal(result.warnings.length, 1);
});

test('_parseISYNodesXml parses device and group membership from ISY xml', () => {
  const xml = `
    <nodes>
      <node flag="0">
        <address>AA BB CC</address>
        <name>Kitchen Dimmer</name>
        <family>1</family>
        <type>1.2.3</type>
        <parent>0</parent>
        <enabled>true</enabled>
      </node>
      <group flag="0">
        <address>0010</address>
        <name>Movie Scene</name>
        <parent>0</parent>
        <link type="1">AA.BB.CC</link>
        <link type="0">11.22.33</link>
      </group>
    </nodes>
  `;

  const parsed = insteonService._parseISYNodesXml(xml);
  assert.equal(parsed.devices.length, 1);
  assert.equal(parsed.devices[0].normalizedAddress, 'AABBCC');
  assert.equal(parsed.devices[0].resolvedAddress, 'AABBCC');
  assert.equal(parsed.groups.length, 1);
  assert.deepEqual(parsed.groups[0].controllers, ['AABBCC']);
  assert.deepEqual(parsed.groups[0].members.sort(), ['112233', 'AABBCC']);
});

test('_parseISYNodesXml resolves ISY subnode addresses to base Insteon IDs', () => {
  const xml = `
    <nodes>
      <node flag="0">
        <address>31.41.0F.1</address>
        <name>Keypad Button A</name>
        <parent>31.41.0F</parent>
      </node>
      <node flag="0">
        <address>31.49.05.1D</address>
        <name>Keypad LED</name>
        <parent>31.49.05</parent>
      </node>
      <group flag="0">
        <address>0010</address>
        <name>Movie Scene</name>
        <parent>0</parent>
        <link type="1">31.41.0F.1</link>
        <link type="0">31.49.05.1D</link>
      </group>
    </nodes>
  `;

  const parsed = insteonService._parseISYNodesXml(xml);
  assert.equal(parsed.devices.length, 2);
  assert.equal(parsed.devices[0].normalizedAddress, '31410F');
  assert.equal(parsed.devices[0].resolvedAddress, '31410F');
  assert.equal(parsed.devices[1].normalizedAddress, '314905');
  assert.equal(parsed.devices[1].resolvedAddress, '314905');
  assert.deepEqual(parsed.groups[0].controllers, ['31410F']);
  assert.deepEqual(parsed.groups[0].members.sort(), ['31410F', '314905']);
});

test('_parseISYProgramsXml parses non-folder programs', () => {
  const xml = `
    <programs>
      <program id="0001" parentId="0000" folder="false" enabled="true" runAtStartup="true" status="true">
        <name>Evening Lights</name>
        <lastRunTime>2026/03/01 20:30:00</lastRunTime>
      </program>
      <program id="0002" parentId="0000" folder="true" status="true">
        <name>Folder</name>
      </program>
    </programs>
  `;

  const programs = insteonService._parseISYProgramsXml(xml);
  assert.equal(programs.length, 1);
  assert.equal(programs[0].id, '0001');
  assert.equal(programs[0].name, 'Evening Lights');
  assert.equal(programs[0].enabled, true);
});

test('_parseISYProgramsXml extracts IF/THEN/ELSE program sections', () => {
  const xml = `
    <programs>
      <program id="0003" parentId="0000" folder="false" enabled="true" runAtStartup="false" status="true">
        <name>Porch Routine</name>
        <if>Time is  6:30:00PM</if>
        <then>
          Set 'Kitchen Dimmer' On
          Wait 5 seconds
        </then>
        <else>- No Actions - (To add one, press 'Action')</else>
      </program>
    </programs>
  `;

  const programs = insteonService._parseISYProgramsXml(xml);
  assert.equal(programs.length, 1);
  assert.equal(programs[0].ifLines[0], 'Time is 6:30:00PM');
  assert.equal(programs[0].thenLines[0], "Set 'Kitchen Dimmer' On");
  assert.equal(programs[0].thenLines[1], 'Wait 5 seconds');
  assert.equal(programs[0].elseLines.length, 0);
});

test('_parseISYNetworkResourcesXml parses resource ids, names, and control info', () => {
  const xml = `
    <NetConfig>
      <NetRule id="5">
        <sName>Doorbell Notify</sName>
        <ControlInfo>
          <protocol>https</protocol>
          <host>api.example.com</host>
          <port>443</port>
          <method>POST</method>
          <path>/v1/devices/notify</path>
          <timeout>5000</timeout>
        </ControlInfo>
      </NetRule>
      <resource id="07" name="Webhook Ping" />
    </NetConfig>
  `;

  const resources = insteonService._parseISYNetworkResourcesXml(xml);
  assert.equal(resources.length, 2);
  assert.equal(resources[0].id, '5');
  assert.equal(resources[0].name, 'Doorbell Notify');
  assert.equal(resources[0].controlInfo.protocol, 'https');
  assert.equal(resources[0].controlInfo.host, 'api.example.com');
  assert.equal(resources[0].controlInfo.method, 'POST');
  assert.equal(resources[0].controlInfo.path, '/v1/devices/notify');
  assert.equal(resources[1].id, '07');
  assert.equal(resources[1].name, 'Webhook Ping');
});

test('_buildISYProgramWorkflowPayloads translates simple time/device/scene program', () => {
  const lookup = {
    devicesByAddress: new Map(),
    devicesByName: new Map([
      ['kitchen dimmer', { _id: 'dev1', name: 'Kitchen Dimmer', type: 'light' }]
    ]),
    devicesById: new Map([
      ['dev1', { _id: 'dev1', name: 'Kitchen Dimmer', type: 'light' }]
    ]),
    scenesByName: new Map([
      ['movie night', { _id: 'scene1', name: 'Movie Night', deviceActions: [] }]
    ]),
    programsByName: new Map(),
    programsById: new Map()
  };

  const payloads = insteonService._buildISYProgramWorkflowPayloads({
    id: '0003',
    name: 'Porch Routine',
    enabled: true,
    runAtStartup: false,
    status: true,
    ifLines: ['Time is 6:30:00PM'],
    thenLines: ["Set 'Kitchen Dimmer' On", 'Wait 5 seconds', "Set Scene 'Movie Night' On"],
    elseLines: []
  }, lookup, { enableWorkflows: true });

  assert.equal(payloads.mainPayload.trigger.type, 'schedule');
  assert.equal(payloads.mainPayload.trigger.conditions.cron, '* * * * *');
  assert.equal(payloads.mainPayload.actions.length, 4);
  assert.equal(payloads.mainPayload.actions[0].type, 'condition');
  assert.equal(payloads.mainPayload.actions[0].parameters.evaluator, 'isy_program_if');
  assert.equal(payloads.mainPayload.actions[0].parameters.onFalseActions.length, 0);
  assert.equal(payloads.mainPayload.actions[1].type, 'device_control');
  assert.equal(payloads.mainPayload.actions[1].target, 'dev1');
  assert.equal(payloads.mainPayload.actions[2].type, 'delay');
  assert.equal(payloads.mainPayload.actions[3].type, 'scene_activate');
  assert.equal(payloads.mainPayload.actions[3].target, 'scene1');
  assert.equal(payloads.elsePayload, null);
});

test('_buildISYProgramWorkflowPayloads embeds ELSE path in primary workflow for device-state IF', () => {
  const lookup = {
    devicesByAddress: new Map(),
    devicesByName: new Map([
      ['kitchen dimmer', { _id: 'dev1', name: 'Kitchen Dimmer', type: 'light' }]
    ]),
    devicesById: new Map([
      ['dev1', { _id: 'dev1', name: 'Kitchen Dimmer', type: 'light' }]
    ]),
    scenesByName: new Map(),
    programsByName: new Map(),
    programsById: new Map()
  };

  const payloads = insteonService._buildISYProgramWorkflowPayloads({
    id: '0004',
    name: 'Kitchen Status',
    enabled: true,
    runAtStartup: false,
    status: true,
    ifLines: ["Status 'Kitchen Dimmer' is On"],
    thenLines: ["Set 'Kitchen Dimmer' Off"],
    elseLines: ["Set 'Kitchen Dimmer' On"]
  }, lookup, { enableWorkflows: true });

  assert.equal(payloads.mainPayload.trigger.type, 'schedule');
  assert.equal(payloads.elsePayload, null);
  assert.equal(payloads.elseHandledInPrimary, true);
  assert.equal(payloads.mainPayload.actions[0].type, 'condition');
  assert.equal(payloads.mainPayload.actions[0].parameters.onFalseActions[0].type, 'device_control');
  assert.equal(payloads.mainPayload.actions[0].parameters.onFalseActions[0].target, 'dev1');
});

test('_buildISYProgramWorkflowPayloads embeds ELSE path in primary workflow when trigger inversion is not possible', () => {
  const lookup = {
    devicesByAddress: new Map(),
    devicesByName: new Map([
      ['kitchen dimmer', { _id: 'dev1', name: 'Kitchen Dimmer', type: 'light' }]
    ]),
    devicesById: new Map([
      ['dev1', { _id: 'dev1', name: 'Kitchen Dimmer', type: 'light' }]
    ]),
    scenesByName: new Map(),
    programsByName: new Map(),
    programsById: new Map()
  };

  const payloads = insteonService._buildISYProgramWorkflowPayloads({
    id: '0005',
    name: 'Time Branch',
    enabled: true,
    runAtStartup: false,
    status: true,
    ifLines: ['Time is 6:30:00PM'],
    thenLines: ["Set 'Kitchen Dimmer' On"],
    elseLines: ["Set 'Kitchen Dimmer' Off"]
  }, lookup, { enableWorkflows: true });

  assert.equal(payloads.elsePayload, null);
  assert.equal(payloads.elseHandledInPrimary, true);
  assert.equal(payloads.mainPayload.trigger.type, 'schedule');
  assert.equal(payloads.mainPayload.trigger.conditions.cron, '* * * * *');
  assert.equal(payloads.mainPayload.actions[0].type, 'condition');
  assert.equal(payloads.mainPayload.actions[0].parameters.evaluator, 'isy_program_if');
  assert.equal(payloads.mainPayload.actions[0].parameters.edge, 'change');
  assert.ok(Array.isArray(payloads.mainPayload.actions[0].parameters.onFalseActions));
  assert.equal(payloads.mainPayload.actions[0].parameters.onFalseActions.length, 1);
});

test('importISYProgramsAsWorkflows persists translated ISY programs as workflows', async (t) => {
  const originalBuildLookup = insteonService._buildISYProgramLookup;
  const originalFindOne = Workflow.findOne;
  const originalCreateWorkflow = workflowService.createWorkflow;
  const originalUpdateWorkflow = workflowService.updateWorkflow;

  t.after(() => {
    insteonService._buildISYProgramLookup = originalBuildLookup;
    Workflow.findOne = originalFindOne;
    workflowService.createWorkflow = originalCreateWorkflow;
    workflowService.updateWorkflow = originalUpdateWorkflow;
  });

  insteonService._buildISYProgramLookup = async () => ({
    devicesByAddress: new Map(),
    devicesByName: new Map([
      ['porch light', { _id: 'dev1', name: 'Porch Light', type: 'light' }]
    ]),
    devicesById: new Map([
      ['dev1', { _id: 'dev1', name: 'Porch Light', type: 'light' }]
    ]),
    scenesByName: new Map(),
    programsByName: new Map(),
    programsById: new Map(),
    resourcesByName: new Map(),
    resourcesById: new Map()
  });

  Workflow.findOne = () => ({
    lean: async () => null
  });

  const createdPayloads = [];
  workflowService.createWorkflow = async (payload, options) => {
    createdPayloads.push({ payload, options });
    return {
      _id: 'workflow-isy-1',
      name: payload.name
    };
  };
  workflowService.updateWorkflow = async () => {
    throw new Error('workflowService.updateWorkflow should not be called when no matching workflow exists');
  };

  const result = await insteonService.importISYProgramsAsWorkflows([
    {
      id: '2001',
      name: 'Porch Routine',
      enabled: true,
      runAtStartup: false,
      status: true,
      ifLines: ["Status 'Porch Light' is Off"],
      thenLines: ["Set 'Porch Light' On"],
      elseLines: []
    }
  ], {
    dryRun: false,
    enableWorkflows: true
  });

  assert.equal(result.success, true);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.failed, 0);
  assert.equal(createdPayloads.length, 1);
  assert.equal(createdPayloads[0].options.source, 'import');
  assert.equal(createdPayloads[0].payload.source, 'import');
  assert.equal(createdPayloads[0].payload.enabled, true);
  assert.equal(createdPayloads[0].payload.name, 'ISY Program 2001: Porch Routine');
  assert.equal(createdPayloads[0].payload.actions[0].type, 'condition');
  assert.equal(createdPayloads[0].payload.actions[1].type, 'device_control');
  assert.equal(createdPayloads[0].payload.actions[1].target, 'dev1');
  assert.deepEqual(result.workflows, [
    {
      programId: '2001',
      path: 'then',
      workflowId: 'workflow-isy-1',
      name: 'ISY Program 2001: Porch Routine',
      status: 'created'
    }
  ]);
  assert.equal(result.elseSkipped, 1);
});

test('_buildISYConditionExpression parses variable/program conditions and precedence', () => {
  const lookup = {
    devicesByAddress: new Map(),
    devicesByName: new Map(),
    devicesById: new Map(),
    scenesByName: new Map(),
    programsByName: new Map([
      ['holiday lights', { id: '1001', name: 'Holiday Lights' }]
    ]),
    programsById: new Map([
      ['1001', { id: '1001', name: 'Holiday Lights' }]
    ])
  };

  const expression = insteonService._buildISYConditionExpression({
    ifLines: [
      '$counter > 0',
      "And Program 'Holiday Lights' is True",
      "Or $mode is 2"
    ]
  }, lookup);

  assert.ok(expression);
  assert.equal(expression.op, 'or');
  assert.equal(expression.conditions.length, 2);
  assert.equal(expression.conditions[0].op, 'and');
});

test('_translateISYProgramActionLines translates variables, program control, and repeat', () => {
  const lookup = {
    devicesByAddress: new Map(),
    devicesByName: new Map(),
    devicesById: new Map(),
    scenesByName: new Map(),
    programsByName: new Map([
      ['timer program', { id: '2001', name: 'Timer Program' }]
    ]),
    programsById: new Map([
      ['2001', { id: '2001', name: 'Timer Program' }]
    ])
  };

  const translated = insteonService._translateISYProgramActionLines([
    '$counter += 1',
    "Run Program 'Timer Program' (Then Path)",
    'Repeat 2 times',
    'Wait 1 seconds',
    '$counter -= 1'
  ], lookup, {
    branch: 'then',
    ifExpression: {
      kind: 'isy_variable',
      name: 'counter',
      operator: '>',
      value: { kind: 'literal', value: 0 }
    }
  });

  assert.equal(translated.actions[0].type, 'variable_control');
  assert.equal(translated.actions[0].parameters.operation, 'add');
  assert.equal(translated.actions[1].type, 'workflow_control');
  assert.equal(translated.actions[1].parameters.operation, 'run_then');
  assert.equal(translated.actions[2].type, 'repeat');
  assert.equal(translated.actions[2].parameters.mode, 'for');
  assert.equal(translated.actions[2].parameters.actions.length, 2);
});

test('_translateISYProgramActionLines translates network resource statements into executable actions', () => {
  const lookup = {
    devicesByAddress: new Map(),
    devicesByName: new Map(),
    devicesById: new Map(),
    scenesByName: new Map(),
    programsByName: new Map(),
    programsById: new Map(),
    resourcesByName: new Map([
      ['doorbell notify', {
        id: '5',
        name: 'Doorbell Notify',
        controlInfo: {
          protocol: 'https',
          host: 'api.example.com',
          port: 443,
          method: 'POST',
          path: '/v1/devices/notify',
          payload: '{"device":"front-door"}',
          timeout: 5000
        }
      }]
    ]),
    resourcesById: new Map([
      ['5', {
        id: '5',
        name: 'Doorbell Notify',
        controlInfo: {
          protocol: 'https',
          host: 'api.example.com',
          port: 443,
          method: 'POST',
          path: '/v1/devices/notify',
          payload: '{"device":"front-door"}',
          timeout: 5000
        }
      }],
      ['7', { id: '07', name: 'Webhook Ping' }],
      ['07', { id: '07', name: 'Webhook Ping' }]
    ])
  };

  const translated = insteonService._translateISYProgramActionLines([
    "Network Resource 'Doorbell Notify'",
    'Resource 7'
  ], lookup, { branch: 'then' });

  assert.equal(translated.actions.length, 2);
  assert.equal(translated.actions[0].type, 'http_request');
  assert.equal(translated.actions[0].target, 'https://api.example.com/v1/devices/notify');
  assert.equal(translated.actions[0].parameters.method, 'POST');
  assert.deepEqual(translated.actions[0].parameters.body, { device: 'front-door' });
  assert.equal(translated.actions[1].type, 'isy_network_resource');
  assert.equal(translated.actions[1].parameters.resourceId, '07');
  assert.equal(translated.untranslatedLines.length, 0);
});

test('_buildTopologyScenesFromISYGroups creates scene entries per controller', () => {
  const scenes = insteonService._buildTopologyScenesFromISYGroups([
    {
      address: '0010',
      name: 'Movie Scene',
      members: ['AABBCC', '112233'],
      controllers: ['AABBCC']
    }
  ]);

  assert.equal(scenes.length, 1);
  assert.equal(scenes[0].controller, 'AABBCC');
  assert.equal(scenes[0].responders.length, 1);
  assert.equal(scenes[0].responders[0].id, '112233');
  assert.ok(Number.isInteger(scenes[0].group));
});

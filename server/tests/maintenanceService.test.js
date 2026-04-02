const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const maintenanceService = require('../services/maintenanceService');
const insteonService = require('../services/insteonService');
const smartThingsService = require('../services/smartThingsService');

test('forceInsteonSync delegates to the PLM sync service and starts runtime monitoring', async (t) => {
  const originalSyncDevicesFromPLM = insteonService.syncDevicesFromPLM;
  const originalStartRuntimeMonitoring = insteonService.startRuntimeMonitoring;
  const originalGetStatusSnapshot = insteonService.getStatusSnapshot;

  t.after(() => {
    insteonService.syncDevicesFromPLM = originalSyncDevicesFromPLM;
    insteonService.startRuntimeMonitoring = originalStartRuntimeMonitoring;
    insteonService.getStatusSnapshot = originalGetStatusSnapshot;
  });

  let startArgs = null;
  insteonService.syncDevicesFromPLM = async (options = {}) => {
    assert.equal(options.skipExisting, false);
    return {
      success: true,
      message: 'INSTEON sync complete - 2 PLM-linked devices, 1 created, 1 updated, 0 duplicate rows removed, 0 failed',
      deviceCount: 2,
      linkedDeviceCount: 2,
      created: 1,
      updated: 1,
      deduped: 0,
      failed: 0,
      warnings: [],
      errors: [],
      plmInfo: {
        deviceId: '112233'
      }
    };
  };
  insteonService.startRuntimeMonitoring = (options = {}) => {
    startArgs = options;
  };
  insteonService.getStatusSnapshot = async () => ({
    connected: true,
    port: '/dev/serial/by-id/test-plm',
    diagnostics: []
  });

  const result = await maintenanceService.forceInsteonSync();

  assert.equal(result.success, true);
  assert.equal(result.deviceCount, 2);
  assert.equal(result.linkedDeviceCount, 2);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.deduped, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.plmInfo.deviceId, '112233');
  assert.deepEqual(startArgs, { immediate: false });
  assert.equal(result.runtimeStatus.connected, true);
  assert.deepEqual(result.diagnostics, []);
});

test('forceInsteonSync propagates PLM sync failures', async (t) => {
  const originalSyncDevicesFromPLM = insteonService.syncDevicesFromPLM;
  const originalGetStatusSnapshot = insteonService.getStatusSnapshot;

  t.after(() => {
    insteonService.syncDevicesFromPLM = originalSyncDevicesFromPLM;
    insteonService.getStatusSnapshot = originalGetStatusSnapshot;
  });

  insteonService.syncDevicesFromPLM = async () => {
    throw new Error('PLM link table read failed');
  };
  insteonService.getStatusSnapshot = async () => ({
    connected: true,
    port: '/dev/serial/by-id/test-plm'
  });

  await assert.rejects(
    maintenanceService.forceInsteonSync(),
    /failed to sync insteon devices: PLM link table read failed\. PLM transport is connected at \/dev\/serial\/by-id\/test-plm/i
  );
});

test('startInsteonSyncRun stores live progress logs and completes with the sync result', async (t) => {
  const originalSyncDevicesFromPLM = insteonService.syncDevicesFromPLM;
  const originalStartRuntimeMonitoring = insteonService.startRuntimeMonitoring;
  const originalGetStatusSnapshot = insteonService.getStatusSnapshot;

  t.after(() => {
    insteonService.syncDevicesFromPLM = originalSyncDevicesFromPLM;
    insteonService.startRuntimeMonitoring = originalStartRuntimeMonitoring;
    insteonService.getStatusSnapshot = originalGetStatusSnapshot;
  });

  insteonService.syncDevicesFromPLM = async (_options = {}, runtime = {}) => {
    runtime.onProgress?.({
      message: 'Reading PLM link database',
      stage: 'query',
      progress: 10
    });
    runtime.onProgress?.({
      message: 'Syncing device 1/1: 11.22.33',
      stage: 'devices',
      progress: 50
    });

    return {
      success: true,
      message: 'INSTEON sync complete - 1 PLM-linked device, 1 created, 0 updated, 0 duplicate rows removed, 0 failed',
      deviceCount: 1,
      linkedDeviceCount: 1,
      created: 1,
      updated: 0,
      deduped: 0,
      failed: 0,
      warnings: [],
      errors: [],
      plmInfo: {
        deviceId: '112233'
      }
    };
  };
  insteonService.startRuntimeMonitoring = () => {};
  insteonService.getStatusSnapshot = async () => ({
    connected: true,
    port: '/dev/serial/by-id/test-plm',
    diagnostics: []
  });

  const run = maintenanceService.startInsteonSyncRun();
  assert.ok(run.id);
  assert.equal(run.status, 'running');

  let snapshot = maintenanceService.getInsteonSyncRun(run.id);
  const deadline = Date.now() + 2000;
  while (snapshot && snapshot.status === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    snapshot = maintenanceService.getInsteonSyncRun(run.id);
  }

  assert.ok(snapshot);
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.result.linkedDeviceCount, 1);
  assert.ok(Array.isArray(snapshot.logs));
  assert.ok(snapshot.logs.some((entry) => /reading plm link database/i.test(entry.message)));
  assert.ok(snapshot.logs.some((entry) => /syncing device 1\/1/i.test(entry.message)));
});

test('forceSmartThingsSync dedupes duplicate HomeBrain rows for one SmartThings device ID', async (t) => {
  const originalGetIntegration = SmartThingsIntegration.getIntegration;
  const originalGetDevices = smartThingsService.getDevices;
  const originalMapSmartThingsDevice = maintenanceService.mapSmartThingsDevice;
  const originalFind = Device.find;
  const originalCreate = Device.create;
  const originalDeleteMany = Device.deleteMany;

  t.after(() => {
    SmartThingsIntegration.getIntegration = originalGetIntegration;
    smartThingsService.getDevices = originalGetDevices;
    maintenanceService.mapSmartThingsDevice = originalMapSmartThingsDevice;
    Device.find = originalFind;
    Device.create = originalCreate;
    Device.deleteMany = originalDeleteMany;
  });

  const canonicalDevice = {
    _id: 'smartthings-canonical',
    name: 'Front Porch Light',
    groups: ['Exterior'],
    properties: {
      smartThingsDeviceId: 'smartthings-device-1'
    },
    createdAt: new Date('2026-04-01T00:00:00Z'),
    async save() {
      this.saved = true;
    }
  };

  const duplicateDevice = {
    _id: 'smartthings-duplicate',
    name: 'Front Porch Light Duplicate',
    groups: ['Favorites'],
    properties: {
      smartThingsDeviceId: 'smartthings-device-1'
    },
    createdAt: new Date('2026-04-02T00:00:00Z')
  };

  const deleteManyCalls = [];

  SmartThingsIntegration.getIntegration = async () => ({
    async updateSecurityArmState() {}
  });
  smartThingsService.getDevices = async () => [{
    deviceId: 'smartthings-device-1',
    locationId: 'location-1'
  }];
  maintenanceService.mapSmartThingsDevice = async () => ({
    name: 'Front Porch Light',
    type: 'light',
    room: 'Porch',
    status: true,
    brightness: 100,
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-device-1'
    },
    brand: 'Samsung',
    model: 'Bulb',
    isOnline: true,
    lastSeen: new Date('2026-04-02T12:00:00Z')
  });
  Device.find = async (query) => {
    assert.equal(query['properties.smartThingsDeviceId'], 'smartthings-device-1');
    return [duplicateDevice, canonicalDevice];
  };
  Device.create = async () => {
    throw new Error('Device.create should not be called when a canonical SmartThings row already exists');
  };
  Device.deleteMany = async (query) => {
    deleteManyCalls.push(query);
    if (query._id) {
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  };

  const result = await maintenanceService.forceSmartThingsSync();

  assert.equal(result.success, true);
  assert.equal(result.updated, 1);
  assert.equal(result.deduped, 1);
  assert.deepEqual(canonicalDevice.groups, ['Exterior', 'Favorites']);
  assert.equal(canonicalDevice.saved, true);
  assert.equal(deleteManyCalls.length, 2);
  assert.deepEqual(deleteManyCalls[0], {
    _id: { $in: ['smartthings-duplicate'] }
  });
});

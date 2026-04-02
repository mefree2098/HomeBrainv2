const test = require('node:test');
const assert = require('node:assert/strict');

const maintenanceService = require('../services/maintenanceService');
const insteonService = require('../services/insteonService');

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
      message: 'INSTEON sync complete - 2 PLM-linked devices, 1 created, 1 updated, 0 failed',
      deviceCount: 2,
      linkedDeviceCount: 2,
      created: 1,
      updated: 1,
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
      message: 'INSTEON sync complete - 1 PLM-linked device, 1 created, 0 updated, 0 failed',
      deviceCount: 1,
      linkedDeviceCount: 1,
      created: 1,
      updated: 0,
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

const test = require('node:test');
const assert = require('node:assert/strict');

const directRadioService = require('../services/directRadioService');

const DirectRadioService = directRadioService.DirectRadioService;
const DEVICE_ID = '507f1f77bcf86cd799439011';

function createService() {
  const service = new DirectRadioService();
  service.zwave.removeNodeStatusEnum = {
    2: 'NodeFound',
    6: 'Done',
    7: 'Failed'
  };
  service.zwave.addNodeStatusEnum = {
    6: 'Done',
    7: 'Failed'
  };
  return service;
}

test('Z-Wave migration exclusion does not advance until controller reports Done', async () => {
  const service = createService();
  const migration = {
    id: 'migration-exclusion',
    sourceDeviceId: DEVICE_ID,
    protocol: 'zwave',
    status: 'excluding',
    exclusionExpiresAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);

  let result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'pending');
  assert.equal(result.verification.canAdvance, false);

  service.recordZWaveExclusionStatus(2, { nodeId: 12 });
  result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'pending');
  assert.equal(result.verification.canAdvance, false);

  service.recordZWaveExclusionStatus(6, { nodeId: 12 });
  result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.canAdvance, true);
  assert.equal(migration.status, 'excluded');
  assert.equal(migration.exclusionNodeId, 12);
});

test('Z-Wave migration observes controller status reports that are awaited internally by zwave-js', async () => {
  const service = createService();
  const migration = {
    id: 'migration-observed-exclusion',
    sourceDeviceId: DEVICE_ID,
    protocol: 'zwave',
    status: 'excluding',
    exclusionExpiresAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);

  service.observeZWaveMigrationMessage({
    functionType: 75,
    status: 6,
    statusContext: { nodeId: 42 },
    constructor: { name: 'RemoveNodeFromNetworkRequestStatusReport' }
  });

  const result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'verified');
  assert.equal(migration.exclusionNodeId, 42);
});

test('SmartThings-backed Z-Wave migration exclusion verifies only after SmartThings removes the device', async () => {
  const service = createService();
  const migration = {
    id: 'migration-smartthings-exclusion',
    sourceDeviceId: DEVICE_ID,
    smartThingsDeviceId: 'smartthings-device-1',
    protocol: 'zwave',
    status: 'awaiting_smartthings_exclusion',
    exclusionStatus: 'waiting_smartthings',
    exclusionExpiresAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);

  service.smartThingsService = {
    getDevice: async () => ({ deviceId: migration.smartThingsDeviceId })
  };
  let result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'pending');
  assert.equal(result.verification.canAdvance, false);

  service.smartThingsService = {
    getDevice: async () => {
      const error = new Error('SmartThings device not found');
      error.status = 404;
      throw error;
    }
  };
  result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.canAdvance, true);
  assert.equal(migration.status, 'excluded');
  assert.ok(migration.exclusionVerifiedAt);
  assert.ok(migration.smartThingsRemovalVerifiedAt);
});

test('direct-radio migration inclusion does not advance until HomeBrain completes the native device record', async () => {
  const service = createService();
  const migration = {
    id: 'migration-inclusion',
    sourceDeviceId: DEVICE_ID,
    protocol: 'zwave',
    status: 'pairing',
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);

  let result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_inclusion'
  });
  assert.equal(result.verification.status, 'pending');
  assert.equal(result.verification.canAdvance, false);

  migration.status = 'completed';
  migration.completedAt = new Date().toISOString();
  migration.inclusionVerifiedAt = migration.completedAt;
  migration.directIdentity = { protocol: 'zwave', id: '12' };

  result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_inclusion'
  });
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.canAdvance, true);
});

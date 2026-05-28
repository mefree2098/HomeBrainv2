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

test('SmartThings-backed Z-Wave migration exclusion verifies after SmartThings removes the device', async () => {
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

test('SmartThings-backed Z-Wave migration accepts offline SmartThings health as stale-tile exclusion evidence', async () => {
  const service = createService();
  const migration = {
    id: 'migration-smartthings-offline-exclusion',
    sourceDeviceId: DEVICE_ID,
    smartThingsDeviceId: 'smartthings-device-2',
    protocol: 'zwave',
    status: 'awaiting_smartthings_exclusion',
    exclusionStatus: 'waiting_smartthings',
    exclusionExpiresAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000,
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);

  service.smartThingsService = {
    getDevice: async () => ({
      deviceId: migration.smartThingsDeviceId,
      type: 'ZWAVE',
      parentDeviceId: 'hub-1',
      zwave: {
        hubId: 'hub-1',
        provisioningState: 'PROVISIONED'
      }
    }),
    getDeviceHealth: async () => ({
      deviceId: migration.smartThingsDeviceId,
      state: 'OFFLINE',
      lastUpdatedDate: new Date().toISOString()
    }),
    getHubHealth: async () => ({
      hubId: 'hub-1',
      connectivity: 'CONNECTED'
    }),
    getDeviceStatus: async () => ({
      components: {
        main: {
          switch: {
            switch: {
              value: 'off',
              timestamp: '2026-05-23T18:18:44.775Z'
            }
          }
        }
      }
    })
  };

  const result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.canAdvance, true);
  assert.equal(migration.status, 'excluded');
  assert.equal(migration.smartThingsExclusionVerificationSource, 'device_health_offline');
  assert.ok(migration.smartThingsExclusionEvidence);
  assert.equal(migration.smartThingsExclusionEvidence.healthState, 'OFFLINE');
});

test('SmartThings-backed Z-Wave migration verifies when hub exclusion counter increases', async () => {
  const service = createService();
  const migration = {
    id: 'migration-smartthings-counter-exclusion',
    sourceDeviceId: DEVICE_ID,
    smartThingsDeviceId: 'smartthings-device-3',
    protocol: 'zwave',
    status: 'awaiting_smartthings_exclusion',
    exclusionStatus: 'waiting_smartthings',
    exclusionExpiresAt: Date.now() + 60_000,
    expiresAt: Date.now() + 60_000,
    smartThingsHubHealthBeforeExclusion: {
      hubRadioState: {
        zwave: {
          excludedDevices: 0
        }
      }
    },
    startedAt: new Date().toISOString()
  };
  service.activeMigrations.set(migration.id, migration);

  service.smartThingsService = {
    getDevice: async () => ({
      deviceId: migration.smartThingsDeviceId,
      type: 'ZWAVE',
      parentDeviceId: 'hub-1',
      zwave: {
        hubId: 'hub-1',
        provisioningState: 'PROVISIONED'
      }
    }),
    getDeviceHealth: async () => ({
      deviceId: migration.smartThingsDeviceId,
      state: 'ONLINE',
      lastUpdatedDate: new Date().toISOString()
    }),
    getHubHealth: async () => ({
      hubId: 'hub-1',
      connectivity: 'CONNECTED',
      hubRadioState: {
        zwave: {
          excludedDevices: 1
        }
      }
    }),
    getDeviceStatus: async () => ({ components: {} })
  };

  const result = await service.verifyMigrationStep({
    migrationId: migration.id,
    phase: 'physical_exclusion'
  });
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.canAdvance, true);
  assert.equal(migration.status, 'excluded');
  assert.equal(migration.smartThingsExclusionVerificationSource, 'hub_exclusion_counter');
  assert.deepEqual(migration.smartThingsExclusionCounter, {
    path: 'zwave.excludedDevices',
    value: 1
  });
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

test('Z-Wave generic pairing waits for a submitted S2 DSK PIN instead of aborting', async () => {
  const service = createService();
  service.activePairings.set('zwave', {
    id: 'pairing-zwave-test',
    protocol: 'zwave',
    mode: 'inclusion',
    status: 'active',
    startedAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    baselineIdentities: [],
    events: []
  });

  const callbacks = service.buildZWaveInclusionCallbacks({
    SecurityClass: {
      S2_AccessControl: 1,
      S2_Authenticated: 2,
      S2_Unauthenticated: 3,
      S0_Legacy: 4
    }
  });
  const pinPromise = callbacks.validateDSKAndEnterPIN('12345-11111-22222-33333-44444-55555-66666-77777');
  await new Promise((resolve) => setImmediate(resolve));

  const waitingPairing = service.serializePairingSession(service.activePairings.get('zwave'));
  assert.equal(waitingPairing.status, 'awaiting_dsk');
  assert.equal(waitingPairing.pendingDsk, '12345-11111-22222-33333-44444-55555-66666-77777');

  const submitResult = service.submitZWaveDskPin('12345');
  assert.equal(submitResult.accepted, true);
  assert.equal(await pinPromise, '12345');
  assert.equal(service.zwave.pendingDsk, null);
});

test('Z-Wave generic pairing defaults to standard inclusion without a DSK PIN prompt', async () => {
  const service = createService();
  const zwave = require('zwave-js');
  let inclusionOptions = null;
  service.start = async () => {};
  service.zwave.started = true;
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [1, { id: 1, isControllerNode: true }]
      ]),
      beginInclusion: async (options) => {
        inclusionOptions = options;
        return true;
      }
    }
  };

  const result = await service.startPairing('zwave', { durationSeconds: 60 });
  assert.equal(inclusionOptions.strategy, zwave.InclusionStrategy.Insecure);
  assert.equal(result.pairing.zwaveSecurityMode, 'insecure');
  assert.match(result.pairing.message, /No DSK PIN is required/);
});

test('Z-Wave pairing can explicitly request secure S2 inclusion', async () => {
  const service = createService();
  const zwave = require('zwave-js');
  let inclusionOptions = null;
  service.start = async () => {};
  service.zwave.started = true;
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [1, { id: 1, isControllerNode: true }]
      ]),
      beginInclusion: async (options) => {
        inclusionOptions = options;
        return true;
      }
    }
  };

  const result = await service.startPairing('zwave', {
    durationSeconds: 60,
    zwaveSecurityMode: 's2'
  });
  assert.equal(inclusionOptions.strategy, zwave.InclusionStrategy.Security_S2);
  assert.equal(result.pairing.zwaveSecurityMode, 's2');
});

test('generic pairing session completes immediately when an included direct device is upserted', () => {
  const service = createService();
  service.activePairings.set('zwave', {
    id: 'pairing-zwave-complete',
    protocol: 'zwave',
    mode: 'inclusion',
    status: 'active',
    startedAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    baselineIdentities: ['3'],
    events: []
  });

  const session = service.completePairingSession(
    'zwave',
    { protocol: 'zwave', id: '3', source: 'homebrain-zwave' },
    { _id: { toString: () => 'device-node-3' }, name: 'Cold Storage Switch' },
    'node added'
  );

  assert.equal(session.status, 'completed');
  assert.equal(session.directDeviceId, 'device-node-3');
  assert.equal(session.directDeviceName, 'Cold Storage Switch');
  assert.equal(session.detectedIdentity.id, '3');
});

test('generic pairing baseline ignores already-known Z-Wave nodes', () => {
  const service = createService();
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [1, { id: 1, isControllerNode: true }],
        [3, { id: 3, isControllerNode: false }]
      ])
    }
  };

  const session = service.createPairingSession('zwave', 60);
  session.status = 'active';
  assert.deepEqual(session.baselineIdentities, ['3']);

  const unchanged = service.completePairingSession(
    'zwave',
    { protocol: 'zwave', id: '3', source: 'homebrain-zwave' },
    { _id: { toString: () => 'device-node-3' }, name: 'Existing Z-Wave Node' },
    'node value updated'
  );
  assert.equal(unchanged.status, 'active');

  const completed = service.completePairingSession(
    'zwave',
    { protocol: 'zwave', id: '4', source: 'homebrain-zwave' },
    { _id: { toString: () => 'device-node-4' }, name: 'New Z-Wave Node' },
    'node value updated'
  );
  assert.equal(completed.status, 'completed');
  assert.equal(completed.detectedIdentity.id, '4');
});

test('Z-Wave node refresh requests a fresh interview for an already-included node', async () => {
  const service = createService();
  service.started = true;
  let refreshOptions = null;
  let pingTryReallyHard = null;
  const node = {
    id: 4,
    isControllerNode: false,
    ready: false,
    status: 0,
    valueDB: { hasValue: () => false },
    ping: async (tryReallyHard) => {
      pingTryReallyHard = tryReallyHard;
      return false;
    },
    refreshInfo: async (options) => {
      refreshOptions = options;
    }
  };
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [1, { id: 1, isControllerNode: true }],
        [4, node]
      ])
    }
  };

  const result = await service.refreshZWaveNodeInfo(4, {
    waitForWakeup: false,
    pingFirst: true
  });

  assert.equal(pingTryReallyHard, true);
  assert.deepEqual(refreshOptions, {
    resetSecurityClasses: false,
    waitForWakeup: false
  });
  assert.equal(result.node.id, 4);
  assert.equal(result.node.incomplete, true);
  assert.equal(result.ping, false);
});

test('Z-Wave failed-node removal refuses a responding node unless forced', async () => {
  const service = createService();
  service.started = true;
  let removeCalled = false;
  const node = {
    id: 4,
    isControllerNode: false,
    ready: false,
    status: 0,
    valueDB: { hasValue: () => false }
  };
  service.zwave.driver = {
    controller: {
      nodes: new Map([
        [4, node]
      ]),
      isFailedNode: async () => false,
      removeFailedNode: async () => {
        removeCalled = true;
      }
    }
  };

  await assert.rejects(
    () => service.removeFailedZWaveNode(4, { confirm: true }),
    /still responding/
  );
  assert.equal(removeCalled, false);
});

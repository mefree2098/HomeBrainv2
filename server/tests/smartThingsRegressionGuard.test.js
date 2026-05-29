'use strict';

// Phase 1 coverage: a migrated device must shed its top-level SmartThings
// identity so the SmartThings full-sync and webhook can no longer re-source or
// delete it, and getDeviceSource must classify a migrated device as native.

const test = require('node:test');
const assert = require('node:assert');

const directRadioService = require('../services/directRadioService');
const { getDeviceSource } = require('../services/deviceSourceCatalog');

test('severMigratedSmartThingsIdentity removes the top-level ST identity and relocates it', () => {
  const result = directRadioService.severMigratedSmartThingsIdentity({
    source: 'homebrain-zigbee',
    smartThingsDeviceId: 'st-123',
    smartThingsId: 'stid-9',
    homebrainDirect: { protocol: 'zigbee', ieeeAddr: '0x00158d0001' },
    smartThingsMigration: {
      migratedAt: '2026-05-29T00:00:00.000Z',
      previousSource: 'smartthings',
      migrationId: 'mig-1'
    }
  });

  assert.strictEqual(result.smartThingsDeviceId, undefined, 'top-level smartThingsDeviceId removed');
  assert.strictEqual(result.smartThingsId, undefined, 'top-level smartThingsId removed');
  assert.strictEqual(result.smartThingsMigration.smartThingsDeviceId, 'st-123', 'relocated into migration');
  assert.strictEqual(result.smartThingsMigration.smartThingsId, 'stid-9');
  assert.notStrictEqual(result.smartThingsMigration.retiredSource, true, 'native device is NOT flagged retiredSource (that would hide it from the device list)');
  assert.strictEqual(result.smartThingsMigration.migrationId, 'mig-1', 'preserved migration metadata');
  assert.strictEqual(result.smartThingsMigration.previousSource, 'smartthings');
  assert.strictEqual(result.source, 'homebrain-zigbee', 'native source untouched');
});

test('severMigratedSmartThingsIdentity prefers an existing migration id and is idempotent', () => {
  const once = directRadioService.severMigratedSmartThingsIdentity({
    source: 'homebrain-zwave',
    smartThingsDeviceId: 'top-level-id',
    smartThingsMigration: { smartThingsDeviceId: 'migration-id' }
  });
  assert.strictEqual(once.smartThingsMigration.smartThingsDeviceId, 'migration-id', 'migration id preferred');
  assert.strictEqual(once.smartThingsDeviceId, undefined);

  const twice = directRadioService.severMigratedSmartThingsIdentity(once);
  assert.deepStrictEqual(twice.smartThingsMigration, once.smartThingsMigration, 'idempotent');
  assert.strictEqual(twice.smartThingsDeviceId, undefined);
});

test('severMigratedSmartThingsIdentity tolerates empty/invalid input', () => {
  const result = directRadioService.severMigratedSmartThingsIdentity();
  assert.strictEqual(result.smartThingsDeviceId, undefined);
  assert.notStrictEqual(result.smartThingsMigration.retiredSource, true);
});

test('severMigratedSmartThingsIdentity clears a wrongly-set retiredSource so the native device is un-hidden', () => {
  const result = directRadioService.severMigratedSmartThingsIdentity({
    source: 'homebrain-zwave',
    smartThingsMigration: { smartThingsDeviceId: 'st-9', retiredSource: true, status: 'finalized_source' }
  });
  assert.notStrictEqual(result.smartThingsMigration.retiredSource, true, 'retiredSource cleared');
  assert.notStrictEqual(result.smartThingsMigration.status, 'finalized_source', 'finalized_source status cleared');
  assert.strictEqual(result.smartThingsMigration.smartThingsDeviceId, 'st-9', 'ST id preserved');
});

test('getDeviceSource classifies a severed migrated device as native, not smartthings', () => {
  const migrated = directRadioService.severMigratedSmartThingsIdentity({
    source: 'homebrain-zigbee',
    smartThingsDeviceId: 'st-123',
    homebrainDirect: { protocol: 'zigbee' },
    smartThingsMigration: { migrationId: 'm1' }
  });
  assert.strictEqual(getDeviceSource({ properties: migrated }), 'homebrain-zigbee');
});

test('getDeviceSource still classifies a real SmartThings device as smartthings', () => {
  assert.strictEqual(
    getDeviceSource({ properties: { source: 'smartthings', smartThingsDeviceId: 'st-9' } }),
    'smartthings'
  );
  // The dangerous fallback that severing defends against: blank source + ST id
  // would otherwise resolve to 'smartthings' even on a migrated device.
  assert.strictEqual(
    getDeviceSource({ properties: { smartThingsDeviceId: 'st-9' } }),
    'smartthings'
  );
});

test('isMigratedNativeSource (maintenance guard) recognizes homebrain-* sources only', () => {
  const { isMigratedNativeSource } = require('../services/maintenanceService');
  assert.strictEqual(isMigratedNativeSource('homebrain-zigbee'), true);
  assert.strictEqual(isMigratedNativeSource('homebrain-zwave'), true);
  assert.strictEqual(isMigratedNativeSource('smartthings'), false);
  assert.strictEqual(isMigratedNativeSource('insteon'), false);
  assert.strictEqual(isMigratedNativeSource(''), false);
  assert.strictEqual(isMigratedNativeSource(null), false);
});

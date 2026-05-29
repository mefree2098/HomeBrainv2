'use strict';

// Phase 2 coverage: the Z-Wave migration gate can be satisfied by a manual /
// native exclusion confirmation (markSmartThingsExclusionVerified), so the
// flow no longer deadlocks on the unreliable SmartThings-API exclusion.

const test = require('node:test');
const assert = require('node:assert');

const directRadioService = require('../services/directRadioService');

test('markSmartThingsExclusionVerified sets the fields the Z-Wave inclusion gate checks', () => {
  const migration = {
    id: 'm-test-1',
    protocol: 'zwave',
    sourceDeviceId: 'device-1',
    expiresAt: 0
  };

  directRadioService.markSmartThingsExclusionVerified(migration, {
    source: 'manual_confirmation',
    removalVerified: false,
    message: 'confirmed by operator'
  });

  assert.ok(migration.exclusionVerifiedAt, 'exclusionVerifiedAt is set (the gate field)');
  assert.strictEqual(migration.status, 'excluded');
  assert.strictEqual(migration.exclusionStatus, 'verified');
  assert.strictEqual(migration.smartThingsExclusionVerificationSource, 'manual_confirmation');
  assert.ok(migration.expiresAt > Date.now(), 'extends the migration window so inclusion can proceed');
});

test('markSmartThingsExclusionVerified records removal verification only when asked', () => {
  const migration = { id: 'm-test-2', protocol: 'zwave', sourceDeviceId: 'device-2' };
  directRadioService.markSmartThingsExclusionVerified(migration, { source: 'missing_device_at_start', removalVerified: true });
  assert.ok(migration.smartThingsRemovalVerifiedAt, 'removal verification timestamp recorded');

  const migration2 = { id: 'm-test-3', protocol: 'zwave', sourceDeviceId: 'device-3' };
  directRadioService.markSmartThingsExclusionVerified(migration2, { source: 'manual_confirmation', removalVerified: false });
  assert.strictEqual(migration2.smartThingsRemovalVerifiedAt, undefined, 'no removal verification on manual confirm');
});

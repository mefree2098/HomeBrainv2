const test = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../services/voiceDeviceLifecycleService');

function createDevice(settings = {}, overrides = {}) {
  return {
    _id: { toString: () => '507f1f77bcf86cd799439011' },
    status: 'offline',
    firmwareVersion: '1.0.0',
    settings,
    markModified(field) {
      this.modified = this.modified || [];
      this.modified.push(field);
    },
    ...overrides
  };
}

test('registration and claim credentials expire and cannot authenticate registered devices', () => {
  const nowMs = Date.parse('2026-06-11T12:00:00.000Z');
  const device = createDevice({
    registrationCode: 'ABCD1234',
    registrationExpires: new Date(nowMs + 60_000),
    claimToken: 'claim-token',
    claimTokenExpires: new Date(nowMs + 60_000),
    registered: false
  });

  assert.equal(lifecycle.isRegistrationCredentialActive(device, 'ABCD1234', nowMs), true);
  assert.equal(lifecycle.isClaimTokenActive(device, 'claim-token', nowMs), true);
  assert.equal(lifecycle.isRegistrationCredentialActive(device, 'ABCD1234', nowMs + 120_000), false);
  assert.equal(lifecycle.isClaimTokenActive(device, 'claim-token', nowMs + 120_000), false);

  device.settings.registered = true;
  assert.equal(lifecycle.isRegistrationCredentialActive(device, 'ABCD1234', nowMs), false);
  assert.equal(lifecycle.isClaimTokenActive(device, 'claim-token', nowMs), false);
});

test('device token validation requires an activated device', () => {
  const issued = lifecycle.issueDeviceToken();
  const device = createDevice({
    registered: false,
    deviceTokenHash: issued.deviceTokenHash
  });

  assert.equal(lifecycle.isDeviceTokenValid(device, issued.deviceToken), false);
  device.settings.registered = true;
  assert.equal(lifecycle.isDeviceTokenValid(device, issued.deviceToken), true);
  assert.equal(lifecycle.isDeviceTokenValid(device, `${issued.deviceToken}-wrong`), false);
});

test('activation clears onboarding secrets and stores only the device token hash', () => {
  const issued = lifecycle.issueDeviceToken();
  const device = createDevice({
    registrationCode: 'ABCD1234',
    registrationExpires: new Date(Date.now() + 60_000),
    claimToken: 'claim-token',
    claimTokenExpires: new Date(Date.now() + 60_000),
    registered: false,
    lifecycle: { state: 'registered' }
  });

  lifecycle.applyDeviceActivation(device, issued, {
    ipAddress: '192.168.2.27',
    firmwareVersion: '1.1.0'
  });

  assert.equal(device.status, 'online');
  assert.equal(device.ipAddress, '192.168.2.27');
  assert.equal(device.firmwareVersion, '1.1.0');
  assert.equal(device.settings.registered, true);
  assert.equal(device.settings.deviceTokenHash, issued.deviceTokenHash);
  assert.equal(device.settings.registrationCode, undefined);
  assert.equal(device.settings.registrationExpires, undefined);
  assert.equal(device.settings.claimToken, undefined);
  assert.equal(device.settings.claimTokenExpires, undefined);
  assert.equal(device.settings.lifecycle.state, 'activated');
  assert.deepEqual(device.modified, ['settings']);
});

test('onboarding reissue clears device token and marks device offline', () => {
  const device = createDevice({
    registered: true,
    deviceTokenHash: 'old-token-hash',
    deviceTokenCreatedAt: new Date(),
    lifecycle: { state: 'activated', credentialVersion: 2 }
  }, {
    status: 'online'
  });

  const onboarding = lifecycle.applyOnboardingReissue(device);

  assert.equal(device.status, 'offline');
  assert.equal(device.settings.registered, false);
  assert.equal(device.settings.deviceTokenHash, undefined);
  assert.equal(device.settings.deviceTokenCreatedAt, undefined);
  assert.equal(device.settings.registrationCode, onboarding.registrationCode);
  assert.equal(device.settings.claimToken, onboarding.claimToken);
  assert.equal(device.settings.lifecycle.state, 'onboarding_reissued');
  assert.equal(device.settings.lifecycle.credentialVersion, 3);
  assert.deepEqual(device.modified, ['settings']);
});

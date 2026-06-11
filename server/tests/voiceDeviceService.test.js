const test = require('node:test');
const assert = require('node:assert/strict');

const VoiceDevice = require('../models/VoiceDevice');
const voiceDeviceService = require('../services/voiceDeviceService');

test('diagnoseDevice passes when websocket is authenticated and heartbeat is fresh', async (t) => {
  const originalFindById = VoiceDevice.findById;
  const now = new Date('2026-06-11T12:00:00.000Z');

  t.after(() => {
    VoiceDevice.findById = originalFindById;
  });

  VoiceDevice.findById = async () => ({
    _id: { toString: () => '507f1f77bcf86cd799439011' },
    name: 'Pi5',
    room: 'Living Room',
    deviceType: 'speaker',
    status: 'online',
    lastSeen: new Date(now.getTime() - 30_000),
    wakeWordSupport: true,
    supportedWakeWords: ['Anna'],
    settings: {
      registered: true,
      deviceTokenHash: 'hashed-token',
      lifecycle: { state: 'activated' }
    },
    updateStatus: { status: 'idle' }
  });

  const result = await voiceDeviceService.diagnoseDevice('507f1f77bcf86cd799439011', {
    now,
    websocketStats: [
      {
        connectedDevices: 1,
        connections: [
          {
            deviceId: '507f1f77bcf86cd799439011',
            authenticated: true,
            lastPing: now.toISOString()
          }
        ]
      }
    ]
  });

  assert.equal(result.success, true);
  assert.equal(result.testResults.connectivity, true);
  assert.equal(result.diagnostics.checks.activated.ok, true);
  assert.equal(result.diagnostics.checks.websocketAuthenticated.ok, true);
  assert.equal(result.diagnostics.checks.heartbeatFresh.ok, true);
  assert.equal(result.diagnostics.capabilities.audioInputAvailable, true);
  assert.equal(result.diagnostics.capabilities.audioOutputAvailable, true);
});

test('diagnoseDevice reports expired onboarding and missing websocket', async (t) => {
  const originalFindById = VoiceDevice.findById;
  const now = new Date('2026-06-11T12:00:00.000Z');

  t.after(() => {
    VoiceDevice.findById = originalFindById;
  });

  VoiceDevice.findById = async () => ({
    _id: { toString: () => '507f1f77bcf86cd799439011' },
    name: 'Pi5',
    room: 'Living Room',
    deviceType: 'speaker',
    status: 'offline',
    lastSeen: new Date(now.getTime() - 10 * 60_000),
    wakeWordSupport: true,
    supportedWakeWords: ['Anna'],
    settings: {
      registered: false,
      registrationCode: 'ABCD1234',
      registrationExpires: new Date(now.getTime() - 60_000),
      claimToken: 'claim-token',
      claimTokenExpires: new Date(now.getTime() - 60_000),
      lifecycle: { state: 'registered' }
    },
    updateStatus: { status: 'idle' }
  });

  const result = await voiceDeviceService.diagnoseDevice('507f1f77bcf86cd799439011', {
    now,
    websocketStats: []
  });

  assert.equal(result.success, false);
  assert.equal(result.testResults.connectivity, false);
  assert.equal(result.diagnostics.onboarding.registered, false);
  assert.equal(result.diagnostics.onboarding.registrationExpired, true);
  assert.equal(result.diagnostics.onboarding.claimTokenExpired, true);
  assert.equal(result.diagnostics.checks.websocketConnected.ok, false);
  assert.equal(result.diagnostics.checks.websocketAuthenticated.ok, false);
  assert.equal(result.diagnostics.checks.heartbeatFresh.ok, false);
  assert.match(result.message, /No live websocket connection is open/);
});

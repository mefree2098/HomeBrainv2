const test = require('node:test');
const assert = require('node:assert/strict');

const VoiceDevice = require('../models/VoiceDevice');
const remoteUpdateService = require('../services/remoteUpdateService');
const eventStreamService = require('../services/eventStreamService');

test('initiateUpdate preserves previous offline status when websocket delivery fails', async (t) => {
  const originalFindById = VoiceDevice.findById;
  const originalFindByIdAndUpdate = VoiceDevice.findByIdAndUpdate;
  const originalGetUpdatePackageInfo = remoteUpdateService.getUpdatePackageInfo;
  const originalGenerateUpdatePackage = remoteUpdateService.generateUpdatePackage;
  const originalPublishSafe = eventStreamService.publishSafe;
  const updates = [];

  t.after(() => {
    VoiceDevice.findById = originalFindById;
    VoiceDevice.findByIdAndUpdate = originalFindByIdAndUpdate;
    remoteUpdateService.getUpdatePackageInfo = originalGetUpdatePackageInfo;
    remoteUpdateService.generateUpdatePackage = originalGenerateUpdatePackage;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  VoiceDevice.findById = async () => ({
    _id: { toString: () => '507f1f77bcf86cd799439011' },
    name: 'Pi5',
    room: 'Living Room',
    status: 'offline',
    firmwareVersion: '1.0.0'
  });
  VoiceDevice.findByIdAndUpdate = async (_deviceId, update) => {
    updates.push(update);
    return null;
  };
  remoteUpdateService.getUpdatePackageInfo = async () => ({
    version: '1.1.0',
    downloadUrl: '/downloads/updates/homebrain-remote-v1.1.0.zip',
    checksum: 'abc123',
    size: 1234
  });
  remoteUpdateService.generateUpdatePackage = async () => {};
  eventStreamService.publishSafe = async () => {};

  await assert.rejects(
    remoteUpdateService.initiateUpdate(
      '507f1f77bcf86cd799439011',
      { sendMessage: () => false, getStats: () => ({ connectedDevices: 0 }) },
      { force: true, baseUrl: 'http://homebrain.local' }
    ),
    /WebSocket send failed/
  );

  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, 'offline');
  assert.equal(updates[0].updateStatus.status, 'failed');
  assert.equal(updates[0].updateStatus.version, '1.1.0');
  assert.equal(updates[0]['settings.updateStatus'].status, 'failed');
});

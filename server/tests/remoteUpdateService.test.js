const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VoiceDevice = require('../models/VoiceDevice');
const remoteUpdateService = require('../services/remoteUpdateService');
const eventStreamService = require('../services/eventStreamService');

test('remote update archive includes the package lock required by npm ci', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-remote-update-'));
  const archivePath = path.join(tempDir, 'remote.zip');
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  await remoteUpdateService.createZipArchive(archivePath);
  const listed = spawnSync('unzip', ['-Z1', archivePath], {
    encoding: 'utf8',
    timeout: 10_000
  });

  assert.equal(listed.status, 0, listed.stderr);
  const entries = listed.stdout.split('\n').filter(Boolean);
  assert.equal(entries.includes('package.json'), true);
  assert.equal(entries.includes('package-lock.json'), true);
  assert.equal(entries.includes('index.js'), true);
  assert.equal(entries.includes('updater.js'), true);

  const sizes = spawnSync('unzip', ['-l', archivePath], {
    encoding: 'utf8',
    timeout: 10_000
  });
  assert.equal(sizes.status, 0, sizes.stderr);
  const summary = sizes.stdout.split('\n').find((line) => /\bfiles?$/.test(line.trim()));
  const uncompressedBytes = Number(summary?.trim().split(/\s+/)[0]);
  const archiveBytes = fs.statSync(archivePath).size;
  assert.equal(Number.isFinite(uncompressedBytes), true);
  assert.ok(uncompressedBytes <= archiveBytes * 4);
});

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

test('updateDeviceStatus uses non-conflicting update paths when completion is reported', async (t) => {
  const originalFindByIdAndUpdate = VoiceDevice.findByIdAndUpdate;
  const originalPublishSafe = eventStreamService.publishSafe;
  const originalVersion = remoteUpdateService.currentVersion;
  const updates = [];

  t.after(() => {
    VoiceDevice.findByIdAndUpdate = originalFindByIdAndUpdate;
    eventStreamService.publishSafe = originalPublishSafe;
    remoteUpdateService.currentVersion = originalVersion;
  });

  VoiceDevice.findByIdAndUpdate = async (_deviceId, update) => {
    updates.push(update);
    return null;
  };
  eventStreamService.publishSafe = async () => {};
  remoteUpdateService.currentVersion = '1.1.14';

  await remoteUpdateService.updateDeviceStatus('507f1f77bcf86cd799439011', 'completed');

  assert.equal(updates.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0], 'updateStatus'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updates[0], 'settings.updateStatus'), false);
  assert.equal(updates[0].$set.status, 'online');
  assert.equal(updates[0].$set.firmwareVersion, '1.1.14');
  assert.equal(updates[0].$set['updateStatus.status'], 'completed');
  assert.equal(updates[0].$set['settings.updateStatus.status'], 'completed');
  assert.ok(updates[0].$set['updateStatus.completedAt'] instanceof Date);
  assert.equal(updates[0].$unset['updateStatus.error'], '');
  assert.equal(updates[0].$unset['settings.updateStatus.failedAt'], '');
});

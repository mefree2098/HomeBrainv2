const assert = require('node:assert/strict');
const test = require('node:test');

const RemoteDeviceUpdater = require('./updater');
const {
  isLocalOrPrivateHostname,
  normalizeArchiveEntry,
  normalizeSha256
} = RemoteDeviceUpdater.__private__;

test('update URLs stay on the configured HomeBrain origin', () => {
  const updater = new RemoteDeviceUpdater({ allowedOrigin: 'https://hub.example.test' });
  assert.equal(
    updater.parseDownloadUrl('https://hub.example.test/api/update.zip').toString(),
    'https://hub.example.test/api/update.zip'
  );
  assert.throws(
    () => updater.parseDownloadUrl('https://attacker.example/update.zip'),
    /configured HomeBrain origin/
  );
  assert.throws(
    () => updater.parseDownloadUrl('https://user:secret@hub.example.test/update.zip'),
    /credentials/
  );
});

test('standalone updater requires HTTPS for public hosts but permits LAN HTTP', () => {
  const updater = new RemoteDeviceUpdater();
  assert.equal(updater.parseDownloadUrl('http://192.168.1.10/update.zip').protocol, 'http:');
  assert.throws(() => updater.parseDownloadUrl('http://downloads.example/update.zip'), /must use HTTPS/);
  assert.equal(updater.parseDownloadUrl('https://downloads.example/update.zip').protocol, 'https:');
});

test('archive paths and checksums use strict validation', () => {
  assert.equal(normalizeArchiveEntry('nested/package.json'), 'nested/package.json');
  assert.equal(normalizeArchiveEntry('../outside'), '');
  assert.equal(normalizeArchiveEntry('/absolute/path'), '');
  assert.equal(normalizeArchiveEntry('folder\\outside'), '');
  assert.equal(normalizeSha256('A'.repeat(64)), 'a'.repeat(64));
  assert.equal(normalizeSha256('g'.repeat(64)), '');
  assert.equal(isLocalOrPrivateHostname('192.168.1.20'), true);
  assert.equal(isLocalOrPrivateHostname('8.8.8.8'), false);
});

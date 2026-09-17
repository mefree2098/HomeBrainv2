const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

test('installation refreshes dependencies for override and lockfile security updates', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-updater-test-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(root, 'npm-calls');
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOMEBRAIN_UPDATER_TEST_LOG"\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  const originalLog = process.env.HOMEBRAIN_UPDATER_TEST_LOG;
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  process.env.HOMEBRAIN_UPDATER_TEST_LOG = calls;
  t.after(() => {
    process.env.PATH = originalPath;
    if (originalLog === undefined) delete process.env.HOMEBRAIN_UPDATER_TEST_LOG;
    else process.env.HOMEBRAIN_UPDATER_TEST_LOG = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const scenario of ['override', 'lockfile', 'new-lockfile', 'version-only']) {
    await t.test(scenario, async () => {
      const installDir = path.join(root, scenario, 'installed');
      const extractDir = path.join(root, scenario, 'extracted');
      fs.mkdirSync(installDir, { recursive: true });
      fs.mkdirSync(extractDir, { recursive: true });
      fs.rmSync(calls, { force: true });
      const oldPkg = { version: '1.0.0', dependencies: { runtime: '1.0.0' }, overrides: { archive: '1.0.0' } };
      const newPkg = { ...oldPkg, version: '1.0.1', ...(scenario === 'override' ? { overrides: { archive: '1.0.1' } } : {}) };
      fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify(oldPkg));
      fs.writeFileSync(path.join(extractDir, 'package.json'), JSON.stringify(newPkg));
      const oldLock = JSON.stringify({ packages: { 'node_modules/archive': { version: '1.0.0' } } });
      const newLock = scenario === 'lockfile' ? oldLock.replace('1.0.0', '1.0.1') : oldLock;
      if (scenario !== 'new-lockfile') fs.writeFileSync(path.join(installDir, 'package-lock.json'), oldLock);
      fs.writeFileSync(path.join(extractDir, 'package-lock.json'), newLock);

      await new RemoteDeviceUpdater({ installDir }).installUpdate(extractDir);

      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'))), newPkg);
      assert.equal(fs.readFileSync(path.join(installDir, 'package-lock.json'), 'utf8'), newLock);
      if (scenario === 'version-only') assert.equal(fs.existsSync(calls), false);
      else assert.equal(fs.readFileSync(calls, 'utf8'), 'ci\n--no-audit\n--no-fund\n');
    });
  }
});

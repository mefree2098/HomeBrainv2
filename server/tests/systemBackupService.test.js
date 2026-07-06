const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const systemBackupServiceModule = require('../services/systemBackupService');

const { SystemBackupService } = systemBackupServiceModule;

function getArchiveArg(args = []) {
  const match = args.find((arg) => typeof arg === 'string' && arg.startsWith('--archive='));
  return match ? match.slice('--archive='.length) : null;
}

async function createTempProject(t) {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'homebrain-system-backup-'));
  const serverRoot = path.join(projectRoot, 'server');
  const tempRoot = path.join(projectRoot, '.tmp');

  await fsp.mkdir(path.join(serverRoot, 'data'), { recursive: true });
  await fsp.mkdir(path.join(serverRoot, 'public', 'downloads'), { recursive: true });
  await fsp.mkdir(path.join(serverRoot, 'certificates'), { recursive: true });
  await fsp.mkdir(tempRoot, { recursive: true });

  t.after(async () => {
    await fsp.rm(projectRoot, { recursive: true, force: true });
  });

  return {
    projectRoot,
    serverRoot,
    tempRoot
  };
}

test('createDisasterRecoveryBackup captures Mongo metadata and persisted filesystem state', { concurrency: false }, async (t) => {
  const { projectRoot, serverRoot, tempRoot } = await createTempProject(t);

  await fsp.writeFile(path.join(projectRoot, '.env'), 'DATABASE_URL=mongodb://localhost/HomeBrain\nTEST_VALUE=restored\n', 'utf8');
  await fsp.writeFile(path.join(serverRoot, 'data', 'device-cache.json'), '{"ok":true}\n', 'utf8');
  await fsp.mkdir(path.join(serverRoot, 'data', 'system-backup'), { recursive: true });
  await fsp.writeFile(path.join(serverRoot, 'data', 'system-backup', 'skip-me.txt'), 'skip\n', 'utf8');
  await fsp.writeFile(path.join(serverRoot, 'public', 'downloads', 'latest.bin'), 'payload\n', 'utf8');
  await fsp.writeFile(path.join(serverRoot, 'certificates', 'hub.pem'), 'certificate\n', 'utf8');

  const service = new SystemBackupService({
    projectRoot,
    tempRoot,
    databaseUrl: 'mongodb://localhost/HomeBrain',
    now: () => new Date('2026-04-15T12:00:00.000Z')
  });
  const originalRunCommand = service.runCommand.bind(service);

  service.runCommand = async (command, args, options) => {
    if (command === 'mongodump') {
      const archivePath = getArchiveArg(args);
      assert.equal(args.includes('--gzip'), true);
      assert.ok(archivePath);
      await fsp.mkdir(path.dirname(archivePath), { recursive: true });
      await fsp.writeFile(archivePath, 'mongodump-archive', 'utf8');
      return { code: 0, stdout: '', stderr: '' };
    }

    return originalRunCommand(command, args, options);
  };

  const backup = await service.createDisasterRecoveryBackup();
  const extractRoot = await fsp.mkdtemp(path.join(tempRoot, 'extract-'));

  t.after(async () => {
    await backup.cleanup();
    await fsp.rm(extractRoot, { recursive: true, force: true });
  });

  await originalRunCommand('tar', ['-xzf', backup.archivePath, '-C', extractRoot]);

  const manifest = JSON.parse(await fsp.readFile(path.join(extractRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'homebrain-disaster-recovery');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.database.databaseName, 'HomeBrain');
  assert.equal(manifest.database.archivePath, 'database/homebrain.mongodb.archive.gz');
  assert.equal(
    await fsp.readFile(path.join(extractRoot, 'filesystem', '.env'), 'utf8'),
    'DATABASE_URL=mongodb://localhost/HomeBrain\nTEST_VALUE=restored\n'
  );
  assert.equal(
    await fsp.readFile(path.join(extractRoot, 'filesystem', 'server', 'data', 'device-cache.json'), 'utf8'),
    '{"ok":true}\n'
  );
  assert.equal(
    fs.existsSync(path.join(extractRoot, 'filesystem', 'server', 'data', 'system-backup')),
    false
  );
  assert.equal(
    await fsp.readFile(path.join(extractRoot, 'filesystem', 'server', 'public', 'downloads', 'latest.bin'), 'utf8'),
    'payload\n'
  );
  assert.equal(
    await fsp.readFile(path.join(extractRoot, 'filesystem', 'server', 'certificates', 'hub.pem'), 'utf8'),
    'certificate\n'
  );
});

test('runRestoreJob restores filesystem state, uses the backup DATABASE_URL, and preserves system-backup workspace', { concurrency: false }, async (t) => {
  const { projectRoot, serverRoot, tempRoot } = await createTempProject(t);
  const backupRoot = path.join(serverRoot, 'data', 'system-backup');
  const service = new SystemBackupService({
    projectRoot,
    tempRoot,
    databaseUrl: 'mongodb://current-host/HomeBrain',
    now: () => new Date('2026-04-15T13:00:00.000Z')
  });
  const originalRunCommand = service.runCommand.bind(service);

  await service.initialize();
  await fsp.writeFile(path.join(projectRoot, '.env'), 'DATABASE_URL=mongodb://current-host/HomeBrain\nCURRENT_ONLY=1\n', 'utf8');
  await fsp.writeFile(path.join(serverRoot, 'data', 'stale.json'), 'stale\n', 'utf8');
  await fsp.writeFile(path.join(serverRoot, 'public', 'downloads', 'old.bin'), 'old\n', 'utf8');
  await fsp.writeFile(path.join(serverRoot, 'certificates', 'old.pem'), 'old-cert\n', 'utf8');
  await fsp.writeFile(path.join(backupRoot, 'keep.txt'), 'keep\n', 'utf8');

  const bundleRoot = await fsp.mkdtemp(path.join(tempRoot, 'bundle-'));
  const archivePath = path.join(tempRoot, 'restore-backup.tar.gz');

  t.after(async () => {
    await fsp.rm(bundleRoot, { recursive: true, force: true });
    await fsp.rm(archivePath, { force: true });
  });

  await fsp.mkdir(path.join(bundleRoot, 'filesystem', 'server', 'data'), { recursive: true });
  await fsp.mkdir(path.join(bundleRoot, 'filesystem', 'server', 'public', 'downloads'), { recursive: true });
  await fsp.mkdir(path.join(bundleRoot, 'filesystem', 'server', 'certificates'), { recursive: true });
  await fsp.mkdir(path.join(bundleRoot, 'database'), { recursive: true });

  await fsp.writeFile(path.join(bundleRoot, 'filesystem', '.env'), 'DATABASE_URL=mongodb://restored-host/HomeBrain\nRESTORED=1\n', 'utf8');
  await fsp.writeFile(path.join(bundleRoot, 'filesystem', 'server', 'data', 'restored.json'), 'restored\n', 'utf8');
  await fsp.writeFile(path.join(bundleRoot, 'filesystem', 'server', 'public', 'downloads', 'latest.bin'), 'new\n', 'utf8');
  await fsp.writeFile(path.join(bundleRoot, 'filesystem', 'server', 'certificates', 'hub.pem'), 'new-cert\n', 'utf8');
  await fsp.writeFile(path.join(bundleRoot, 'database', 'homebrain.mongodb.archive.gz'), 'mongorestore-archive', 'utf8');
  await fsp.writeFile(path.join(bundleRoot, 'manifest.json'), `${JSON.stringify({
    format: 'homebrain-disaster-recovery',
    version: 1,
    createdAt: '2026-04-15T12:00:00.000Z',
    appVersion: '1.0.0',
    database: {
      archivePath: 'database/homebrain.mongodb.archive.gz'
    }
  }, null, 2)}\n`, 'utf8');

  await originalRunCommand('tar', ['-czf', archivePath, '-C', bundleRoot, '.']);

  const queuedJob = await service.startRestoreJobFromArchive(archivePath, {
    actor: 'tester@example.com',
    archiveName: 'restore-backup.tar.gz'
  });

  let mongorestoreCalls = 0;
  service.runCommand = async (command, args, options) => {
    if (command === 'mongorestore') {
      mongorestoreCalls += 1;
      assert.equal(args.includes('--drop'), true);
      assert.equal(args.includes('--uri=mongodb://restored-host/HomeBrain'), true);
      assert.equal(fs.existsSync(getArchiveArg(args)), true);
      return { code: 0, stdout: '', stderr: '' };
    }

    if (command === 'sudo') {
      throw new Error('sudo should not be called during an offline restore run');
    }

    return originalRunCommand(command, args, options);
  };

  const result = await service.runRestoreJob(queuedJob.id, { restartOnComplete: false });

  assert.equal(mongorestoreCalls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.phase, 'completed');
  assert.match(String(result.message || ''), /start homebrain/i);
  assert.equal(
    await fsp.readFile(path.join(projectRoot, '.env'), 'utf8'),
    'DATABASE_URL=mongodb://restored-host/HomeBrain\nRESTORED=1\n'
  );
  assert.equal(
    await fsp.readFile(path.join(serverRoot, 'data', 'restored.json'), 'utf8'),
    'restored\n'
  );
  assert.equal(fs.existsSync(path.join(serverRoot, 'data', 'stale.json')), false);
  assert.equal(
    await fsp.readFile(path.join(serverRoot, 'data', 'system-backup', 'keep.txt'), 'utf8'),
    'keep\n'
  );
  assert.equal(
    await fsp.readFile(path.join(serverRoot, 'public', 'downloads', 'latest.bin'), 'utf8'),
    'new\n'
  );
  assert.equal(fs.existsSync(path.join(serverRoot, 'public', 'downloads', 'old.bin')), false);
  assert.equal(
    await fsp.readFile(path.join(serverRoot, 'certificates', 'hub.pem'), 'utf8'),
    'new-cert\n'
  );
  assert.equal(fs.existsSync(path.join(serverRoot, 'certificates', 'old.pem')), false);
});

test('launchRestoreHelper falls back to the repo restore script when the systemd helper is unavailable', { concurrency: false }, async (t) => {
  const { projectRoot, tempRoot } = await createTempProject(t);
  const restoreScriptPath = path.join(projectRoot, 'scripts', 'restore-homebrain-backup.sh');
  await fsp.mkdir(path.dirname(restoreScriptPath), { recursive: true });
  await fsp.writeFile(restoreScriptPath, '#!/usr/bin/env bash\n', 'utf8');

  const spawnCalls = [];
  const service = new SystemBackupService({
    projectRoot,
    tempRoot,
    spawnProcess: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = new (require('events').EventEmitter)();
      child.unref = () => {
        child.wasUnrefed = true;
      };
      process.nextTick(() => child.emit('spawn'));
      return child;
    }
  });

  service.runCommand = async () => {
    throw new Error('Command failed (sudo -n systemctl start homebrain-restore-helper): Unit not found');
  };

  const launched = await service.launchRestoreHelper();

  assert.equal(launched.launchStrategy, 'detached-script');
  assert.equal(launched.scriptPath, restoreScriptPath);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, restoreScriptPath);
  assert.deepEqual(spawnCalls[0].args, []);
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(spawnCalls[0].options.stdio, 'ignore');
  assert.equal(spawnCalls[0].options.cwd, projectRoot);
  assert.equal(spawnCalls[0].options.env.HOMEBRAIN_DIR, projectRoot);
  assert.equal(spawnCalls[0].options.env.HOMEBRAIN_SERVICE_NAME, 'homebrain');
});

test('uploadArchiveToSmb copies backups with smbclient without exposing credentials in args', { concurrency: false }, async (t) => {
  const { projectRoot, tempRoot } = await createTempProject(t);
  const archivePath = path.join(tempRoot, 'homebrain-backup.tar.gz');
  await fsp.writeFile(archivePath, 'backup', 'utf8');

  const service = new SystemBackupService({
    projectRoot,
    tempRoot
  });

  let smbclientCall = null;
  service.runCommand = async (command, args) => {
    smbclientCall = { command, args };
    assert.equal(command, 'smbclient');
    assert.equal(args.includes('super-secret'), false);
    const credentialsIndex = args.indexOf('-A');
    assert.notEqual(credentialsIndex, -1);
    const credentialsPath = args[credentialsIndex + 1];
    const credentials = await fsp.readFile(credentialsPath, 'utf8');
    assert.match(credentials, /username = matt/);
    assert.match(credentials, /password = super-secret/);
    assert.match(credentials, /domain = WORKGROUP/);
    return { code: 0, stdout: '', stderr: '' };
  };

  const result = await service.uploadArchiveToSmb(archivePath, {
    shareUrl: 'smb://nas.local/backups/homebrain',
    remoteDirectory: 'daily',
    username: 'matt',
    password: 'super-secret',
    domain: 'WORKGROUP'
  });

  assert.equal(result.sharePath, '//nas.local/backups');
  assert.equal(result.remoteDirectory, 'homebrain/daily');
  assert.equal(result.remoteTarget, '//nas.local/backups/homebrain/daily/homebrain-backup.tar.gz');
  assert.equal(smbclientCall.command, 'smbclient');
  assert.equal(smbclientCall.args[0], '//nas.local/backups');
  const commandText = smbclientCall.args[smbclientCall.args.indexOf('-c') + 1];
  assert.match(commandText, /mkdir "homebrain"/);
  assert.match(commandText, /cd "daily"/);
  assert.match(commandText, /put .*homebrain-backup\.tar\.gz/);
});

test('SMB backup jobs persist only sanitized share metadata', { concurrency: false }, async (t) => {
  const { projectRoot, tempRoot } = await createTempProject(t);
  const service = new SystemBackupService({
    projectRoot,
    tempRoot,
    now: () => new Date('2026-04-15T14:00:00.000Z')
  });

  service.executeSmbBackupJob = async () => {};

  const job = await service.startSmbBackupJob({
    shareUrl: 'smb://matt:super-secret@nas.local/backups/homebrain',
    remoteDirectory: 'daily',
    username: 'matt',
    password: 'super-secret',
    confirmBackup: 'BACKUP HOMEBRAIN TO SMB'
  });
  const stored = await service.readBackupJob(job.id);
  const raw = JSON.stringify(stored);

  assert.equal(stored.smb.sharePath, '//nas.local/backups');
  assert.equal(stored.smb.remoteDirectory, 'homebrain/daily');
  assert.equal(stored.smb.usernameConfigured, true);
  assert.doesNotMatch(raw, /super-secret/);
  assert.doesNotMatch(raw, /matt:super-secret/);
});

test('getLatestBackupJob marks interrupted active SMB backup as failed', { concurrency: false }, async (t) => {
  const { projectRoot, tempRoot } = await createTempProject(t);
  const service = new SystemBackupService({
    projectRoot,
    tempRoot,
    now: () => new Date('2026-05-11T08:30:00.000Z')
  });

  await service.writeBackupJob({
    id: 'stale-job',
    actor: 'system:scheduler',
    archiveName: null,
    status: 'creating',
    phase: 'creating-archive',
    createdAt: '2026-05-10T08:30:00.000Z',
    updatedAt: '2026-05-10T08:30:00.000Z',
    completedAt: null,
    error: null,
    message: 'Creating HomeBrain disaster recovery archive.',
    remoteTarget: null,
    source: 'scheduled',
    retention: null,
    manifest: null
  });

  const latest = await service.getLatestBackupJob();
  const stored = await service.readBackupJob('stale-job');

  assert.equal(latest.status, 'failed');
  assert.equal(latest.phase, 'failed');
  assert.equal(latest.completedAt, '2026-05-11T08:30:00.000Z');
  assert.match(latest.error, /interrupted before completion/);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.completedAt, '2026-05-11T08:30:00.000Z');
});

test('startSmbBackupJob recovers interrupted latest backup before queuing a new one', { concurrency: false }, async (t) => {
  const { projectRoot, tempRoot } = await createTempProject(t);
  const service = new SystemBackupService({
    projectRoot,
    tempRoot,
    now: () => new Date('2026-05-11T08:30:00.000Z')
  });

  service.executeSmbBackupJob = async () => new Promise(() => {});

  await service.writeBackupJob({
    id: 'interrupted-job',
    actor: 'system:scheduler',
    archiveName: null,
    status: 'uploading',
    phase: 'uploading-smb',
    createdAt: '2026-05-10T08:30:00.000Z',
    updatedAt: '2026-05-10T08:45:00.000Z',
    completedAt: null,
    error: null,
    message: 'Uploading backup archive to SMB share.',
    remoteTarget: null,
    source: 'scheduled',
    retention: null,
    manifest: null
  });

  const nextJob = await service.startSmbBackupJob({
    shareUrl: 'smb://nas.local/backups',
    remoteDirectory: 'HomeBrain',
    confirmBackup: 'BACKUP HOMEBRAIN TO SMB'
  });
  const interruptedJob = await service.readBackupJob('interrupted-job');
  const latestJob = await service.readLatestBackupJobRecord();

  assert.equal(interruptedJob.status, 'failed');
  assert.match(interruptedJob.error, /interrupted before completion/);
  assert.equal(nextJob.status, 'queued');
  assert.notEqual(nextJob.id, 'interrupted-job');
  assert.equal(latestJob.id, nextJob.id);
});

test('SMB share parser accepts UNC paths and rejects incomplete shares', () => {
  const parsed = systemBackupServiceModule._test.parseSmbShareTarget('//nas/backups/homebrain', 'daily');
  assert.equal(parsed.sharePath, '//nas/backups');
  assert.equal(parsed.remoteDirectory, 'homebrain/daily');
  assert.equal(parsed.displayPath, '//nas/backups/homebrain/daily');

  assert.throws(
    () => systemBackupServiceModule._test.parseSmbShareTarget('nas/backups'),
    /SMB share must look like/
  );
  assert.throws(
    () => systemBackupServiceModule._test.parseSmbShareTarget('//nas'),
    /host and share/
  );
});

test('testSmbConnection writes, lists, and deletes a probe file on the configured share', { concurrency: false }, async (t) => {
  const { projectRoot, tempRoot } = await createTempProject(t);
  const service = new SystemBackupService({
    projectRoot,
    tempRoot,
    now: () => new Date('2026-05-10T08:30:00.000Z')
  });

  let smbclientCommand = '';
  service.runCommand = async (command, args) => {
    assert.equal(command, 'smbclient');
    smbclientCommand = args[args.indexOf('-c') + 1];
    assert.match(smbclientCommand, /put .*homebrain-smb-test-.*\.txt/);
    assert.match(smbclientCommand, /ls "homebrain-smb-test-.*\.txt"/);
    assert.match(smbclientCommand, /del "homebrain-smb-test-.*\.txt"/);
    return { code: 0, stdout: 'homebrain-smb-test-ok.txt', stderr: '' };
  };

  const result = await service.testSmbConnection({
    shareUrl: '//nas/backups',
    remoteDirectory: 'HomeBrain/nightly'
  });

  assert.equal(result.success, true);
  assert.equal(result.sharePath, '//nas/backups');
  assert.equal(result.remoteDirectory, 'HomeBrain/nightly');
  assert.match(result.remoteTarget, /\/\/nas\/backups\/HomeBrain\/nightly\/homebrain-smb-test-/);
  assert.match(smbclientCommand, /cd "nightly"/);
});

test('pruneSmbBackups keeps the newest matching backup files and deletes older ones', { concurrency: false }, async (t) => {
  const { projectRoot, tempRoot } = await createTempProject(t);
  const service = new SystemBackupService({
    projectRoot,
    tempRoot
  });

  const deletedCommands = [];
  service.runCommand = async (command, args) => {
    assert.equal(command, 'smbclient');
    const commandText = args[args.indexOf('-c') + 1];
    if (commandText.includes('ls "homebrain-backup-*.tar.gz"')) {
      return {
        code: 0,
        stdout: [
          'homebrain-backup-2026-05-06T02-30-00Z.tar.gz',
          'homebrain-backup-2026-05-07T02-30-00Z.tar.gz',
          'homebrain-backup-2026-05-08T02-30-00Z.tar.gz',
          'homebrain-backup-2026-05-09T02-30-00Z.tar.gz',
          'homebrain-backup-2026-05-10T02-30-00Z.tar.gz'
        ].join('\n'),
        stderr: ''
      };
    }

    deletedCommands.push(commandText);
    return { code: 0, stdout: '', stderr: '' };
  };

  const result = await service.pruneSmbBackups({
    shareUrl: 'smb://nas.local/backups',
    remoteDirectory: 'HomeBrain'
  }, 3);

  assert.deepEqual(result.kept, [
    'homebrain-backup-2026-05-10T02-30-00Z.tar.gz',
    'homebrain-backup-2026-05-09T02-30-00Z.tar.gz',
    'homebrain-backup-2026-05-08T02-30-00Z.tar.gz'
  ]);
  assert.deepEqual(result.deleted, [
    'homebrain-backup-2026-05-07T02-30-00Z.tar.gz',
    'homebrain-backup-2026-05-06T02-30-00Z.tar.gz'
  ]);
  assert.equal(deletedCommands.length, 1);
  assert.match(deletedCommands[0], /del "homebrain-backup-2026-05-07T02-30-00Z\.tar\.gz"/);
  assert.match(deletedCommands[0], /del "homebrain-backup-2026-05-06T02-30-00Z\.tar\.gz"/);
});

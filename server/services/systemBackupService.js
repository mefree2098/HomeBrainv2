const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const dotenv = require('dotenv');

const packageJson = require('../../package.json');
const { getDataRetentionDays } = require('../config/dataRetention');
const Settings = require('../models/Settings');

const BACKUP_FORMAT_VERSION = 1;
const DEFAULT_SERVICE_NAME = 'homebrain';
const SMB_BACKUP_CONFIRMATION = 'BACKUP HOMEBRAIN TO SMB';
const SMB_BACKUP_FILENAME_PATTERN = /homebrain-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.tar\.gz/g;

function isRestoreActiveStatus(status) {
  return ['queued', 'validating', 'restoring'].includes(String(status || '').trim());
}

function isBackupActiveStatus(status) {
  return ['queued', 'creating', 'uploading'].includes(String(status || '').trim());
}

function sanitizeFilename(value, fallback = 'homebrain-backup.tar.gz') {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return fallback;
  }

  let sanitized = '';
  let previousWasDash = false;
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    const isSafe =
      (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || char === '.'
      || char === '_'
      || char === '-';
    const nextChar = isSafe ? char : '-';
    if (nextChar === '-' && previousWasDash) {
      continue;
    }
    sanitized += nextChar;
    previousWasDash = nextChar === '-';
  }

  sanitized = sanitized.split('-').filter(Boolean).join('-');
  return sanitized || fallback;
}

function timestampForFilename(date = new Date()) {
  return date
    .toISOString()
    .replace(/[:]/g, '-')
    .replace(/\.\d{3}Z$/, 'Z');
}

function buildRestoreJobSummary(job) {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    status: job.status,
    actor: job.actor || 'unknown',
    archiveName: job.archiveName || null,
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
    completedAt: job.completedAt || null,
    error: job.error || null,
    phase: job.phase || null,
    manifest: job.manifest || null,
    message: job.message || null
  };
}

function buildBackupJobSummary(job) {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    status: job.status,
    actor: job.actor || 'unknown',
    archiveName: job.archiveName || null,
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
    completedAt: job.completedAt || null,
    error: job.error || null,
    phase: job.phase || null,
    message: job.message || null,
    remoteTarget: job.remoteTarget || null,
    source: job.source || 'manual',
    retention: job.retention || null,
    manifest: job.manifest || null
  };
}

function buildArchivePathArgs(targetPath) {
  return [`--archive=${targetPath}`, '--gzip'];
}

function normalizeSmbPathPart(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseSmbShareTarget(value, extraDirectory = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('SMB share URL is required.');
  }

  let host = '';
  let parts = [];
  if (raw.startsWith('smb://')) {
    const parsed = new URL(raw);
    host = parsed.hostname;
    parts = normalizeSmbPathPart(decodeURIComponent(parsed.pathname || ''));
  } else {
    const withoutSlashes = raw.replace(/^\\\\/, '//');
    if (!withoutSlashes.startsWith('//')) {
      throw new Error('SMB share must look like smb://server/share/path or //server/share/path.');
    }
    parts = normalizeSmbPathPart(withoutSlashes.slice(2));
    host = parts.shift() || '';
  }

  const share = parts.shift() || '';
  if (!host || !share) {
    throw new Error('SMB share must include both a host and share name.');
  }

  const remoteParts = [
    ...parts,
    ...normalizeSmbPathPart(extraDirectory)
  ];
  const remoteDirectory = remoteParts.join('/');
  const sharePath = `//${host}/${share}`;
  return {
    sharePath,
    remoteDirectory,
    displayPath: remoteDirectory ? `${sharePath}/${remoteDirectory}` : sharePath
  };
}

function smbQuote(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildSmbClientUploadCommand(localArchivePath, remoteDirectory, remoteFilename) {
  const commands = ['prompt off'];
  normalizeSmbPathPart(remoteDirectory).forEach((part) => {
    commands.push(`mkdir ${smbQuote(part)}`);
    commands.push(`cd ${smbQuote(part)}`);
  });
  commands.push(`put ${smbQuote(localArchivePath)} ${smbQuote(remoteFilename)}`);
  return commands.join('; ');
}

function buildSmbClientTestCommand(localTestPath, remoteDirectory, remoteFilename) {
  const commands = ['prompt off'];
  normalizeSmbPathPart(remoteDirectory).forEach((part) => {
    commands.push(`mkdir ${smbQuote(part)}`);
    commands.push(`cd ${smbQuote(part)}`);
  });
  commands.push(`put ${smbQuote(localTestPath)} ${smbQuote(remoteFilename)}`);
  commands.push(`ls ${smbQuote(remoteFilename)}`);
  commands.push(`del ${smbQuote(remoteFilename)}`);
  return commands.join('; ');
}

function buildSmbClientListBackupsCommand(remoteDirectory) {
  const commands = ['prompt off'];
  normalizeSmbPathPart(remoteDirectory).forEach((part) => {
    commands.push(`cd ${smbQuote(part)}`);
  });
  commands.push('ls "homebrain-backup-*.tar.gz"');
  return commands.join('; ');
}

function buildSmbClientDeleteBackupsCommand(remoteDirectory, filenames = []) {
  const commands = ['prompt off'];
  normalizeSmbPathPart(remoteDirectory).forEach((part) => {
    commands.push(`cd ${smbQuote(part)}`);
  });
  filenames.forEach((filename) => {
    commands.push(`del ${smbQuote(filename)}`);
  });
  return commands.join('; ');
}

function parseSmbBackupFilenames(output = '') {
  return Array.from(new Set(String(output || '').match(SMB_BACKUP_FILENAME_PATTERN) || []))
    .sort();
}

function isMaskedSecretValue(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^[*•]+$/.test(trimmed)) {
    return true;
  }
  return /^[*•]{4,}[^*•\s]+$/.test(trimmed);
}

function hasOwnValue(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function pickConfiguredString(candidate, fallback = '', explicit = false) {
  if (explicit) {
    if (typeof candidate === 'string' && isMaskedSecretValue(candidate)) {
      return typeof fallback === 'string' ? fallback.trim() : '';
    }
    return typeof candidate === 'string' ? candidate.trim() : '';
  }

  if (typeof candidate === 'string' && candidate.trim() && !isMaskedSecretValue(candidate)) {
    return candidate.trim();
  }
  return typeof fallback === 'string' ? fallback.trim() : '';
}

function pickConfiguredPassword(candidate, fallback = '') {
  if (typeof candidate === 'string' && candidate && !isMaskedSecretValue(candidate)) {
    return candidate;
  }
  return typeof fallback === 'string' ? fallback : '';
}

function normalizeRetentionCount(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(30, Math.max(1, Math.trunc(numeric)));
}

class SystemBackupService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    this.serverRoot = path.join(this.projectRoot, 'server');
    this.backupRoot = options.backupRoot || path.join(this.serverRoot, 'data', 'system-backup');
    this.backupJobsDir = path.join(this.backupRoot, 'backup-jobs');
    this.restoreJobsDir = path.join(this.backupRoot, 'restore-jobs');
    this.restoreArchivesDir = path.join(this.backupRoot, 'restore-archives');
    this.latestBackupJobRefPath = path.join(this.backupRoot, 'latest-backup-job.txt');
    this.latestRestoreJobRefPath = path.join(this.backupRoot, 'latest-restore-job.txt');
    this.spawnProcess = options.spawnProcess || spawn;
    this.settingsModel = options.settingsModel || Settings;
    this.tempRoot = options.tempRoot || os.tmpdir();
    this.databaseUrl = options.databaseUrl || process.env.DATABASE_URL || '';
    this.serviceName = options.serviceName || process.env.HOMEBRAIN_SERVICE_NAME || DEFAULT_SERVICE_NAME;
    this.restoreHelperServiceName = options.restoreHelperServiceName
      || process.env.HOMEBRAIN_RESTORE_HELPER_SERVICE_NAME
      || `${this.serviceName}-restore-helper`;
    this.now = options.now || (() => new Date());
    this._runningRestorePromise = null;
    this._runningBackupPromise = null;
  }

  async spawnDetached(command, args, options = {}) {
    const cwd = options.cwd || this.projectRoot;
    const env = { ...process.env, ...(options.env || {}) };

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(command, args, {
        cwd,
        env,
        detached: true,
        stdio: 'ignore'
      });

      const cleanup = () => {
        child.removeListener('error', handleError);
        child.removeListener('spawn', handleSpawn);
      };

      const handleError = (error) => {
        cleanup();
        reject(error);
      };

      const handleSpawn = () => {
        cleanup();
        child.unref?.();
        resolve(child);
      };

      child.once('error', handleError);
      child.once('spawn', handleSpawn);
    });
  }

  async initialize() {
    await fsp.mkdir(this.backupJobsDir, { recursive: true });
    await fsp.mkdir(this.restoreJobsDir, { recursive: true });
    await fsp.mkdir(this.restoreArchivesDir, { recursive: true });
  }

  getBackupTargets() {
    return [
      {
        relativePath: '.env',
        kind: 'file',
        optional: true
      },
      {
        relativePath: path.join('server', 'data'),
        kind: 'directory',
        optional: true,
        excludeNames: ['system-backup']
      },
      {
        relativePath: path.join('server', 'public', 'downloads'),
        kind: 'directory',
        optional: true
      },
      {
        relativePath: path.join('server', 'certificates'),
        kind: 'directory',
        optional: true
      }
    ];
  }

  getRestoreJobPath(jobId) {
    return path.join(this.restoreJobsDir, `${jobId}.json`);
  }

  getBackupJobPath(jobId) {
    return path.join(this.backupJobsDir, `${jobId}.json`);
  }

  async pathExists(targetPath) {
    try {
      await fsp.access(targetPath, fs.constants.F_OK);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async runCommand(command, args, options = {}) {
    const cwd = options.cwd || this.projectRoot;
    const env = { ...process.env, ...(options.env || {}) };
    const captureStdout = options.captureStdout !== false;

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(command, args, {
        cwd,
        env,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk) => {
        if (captureStdout) {
          stdout += chunk.toString();
        }
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => reject(error));
      child.on('close', (code) => {
        if (code === 0) {
          resolve({
            code,
            stdout: String(stdout || '').trim(),
            stderr: String(stderr || '').trim()
          });
          return;
        }

        const error = new Error(
          `Command failed (${command} ${args.join(' ')}): ${String(stderr || '').trim() || `exit ${code}`}`
        );
        error.exitCode = code;
        reject(error);
      });
    });
  }

  async copyPath(sourcePath, targetPath, options = {}) {
    const stat = await fsp.stat(sourcePath);
    if (stat.isDirectory()) {
      await fsp.mkdir(targetPath, { recursive: true });
      await fsp.cp(sourcePath, targetPath, {
        recursive: true,
        force: true,
        filter: (src) => {
          const baseName = path.basename(src);
          return !Array.isArray(options.excludeNames) || !options.excludeNames.includes(baseName);
        }
      });
      return;
    }

    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(sourcePath, targetPath);
  }

  parseDatabaseMetadata(databaseUrl = this.databaseUrl) {
    const metadata = {
      configured: Boolean(String(databaseUrl || '').trim()),
      databaseName: null,
      hostname: null
    };

    if (!metadata.configured) {
      return metadata;
    }

    try {
      const normalized = databaseUrl.startsWith('mongodb://') || databaseUrl.startsWith('mongodb+srv://')
        ? databaseUrl
        : `mongodb://${databaseUrl}`;
      const parsed = new URL(normalized);
      metadata.databaseName = parsed.pathname.replace(/^\/+/, '') || null;
      metadata.hostname = parsed.hostname || null;
    } catch (_error) {
      metadata.databaseName = null;
      metadata.hostname = null;
    }

    return metadata;
  }

  buildManifest() {
    return {
      format: 'homebrain-disaster-recovery',
      version: BACKUP_FORMAT_VERSION,
      createdAt: this.now().toISOString(),
      appVersion: packageJson.version || '0.0.0',
      database: this.parseDatabaseMetadata(),
      filesystem: {
        targets: this.getBackupTargets().map((target) => ({
          relativePath: target.relativePath,
          kind: target.kind,
          optional: Boolean(target.optional),
          excludeNames: Array.isArray(target.excludeNames) ? target.excludeNames : []
        }))
      },
      retentionDays: getDataRetentionDays()
    };
  }

  async createDisasterRecoveryBackup() {
    await this.initialize();

    if (!String(this.databaseUrl || '').trim()) {
      throw new Error('DATABASE_URL must be configured before creating a disaster recovery backup');
    }

    const tempRoot = await fsp.mkdtemp(path.join(this.tempRoot, 'homebrain-backup-'));
    const bundleRoot = path.join(tempRoot, 'bundle');
    const filesystemRoot = path.join(bundleRoot, 'filesystem');
    const databaseRoot = path.join(bundleRoot, 'database');
    const archiveFilename = `homebrain-backup-${timestampForFilename(this.now())}.tar.gz`;
    const archivePath = path.join(tempRoot, archiveFilename);
    const databaseArchivePath = path.join(databaseRoot, 'homebrain.mongodb.archive.gz');
    const manifest = this.buildManifest();

    await fsp.mkdir(filesystemRoot, { recursive: true });
    await fsp.mkdir(databaseRoot, { recursive: true });

    for (const target of this.getBackupTargets()) {
      const sourcePath = path.join(this.projectRoot, target.relativePath);
      const exists = await this.pathExists(sourcePath);

      if (!exists) {
        continue;
      }

      const targetPath = path.join(filesystemRoot, target.relativePath);
      await this.copyPath(sourcePath, targetPath, target);
    }

    await this.runCommand('mongodump', [
      `--uri=${this.databaseUrl}`,
      ...buildArchivePathArgs(databaseArchivePath)
    ]);

    manifest.database.archivePath = path.relative(bundleRoot, databaseArchivePath);

    await fsp.writeFile(
      path.join(bundleRoot, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );

    await this.runCommand('tar', ['-czf', archivePath, '-C', bundleRoot, '.']);

    return {
      archivePath,
      archiveFilename,
      manifest,
      cleanup: async () => {
        await fsp.rm(tempRoot, { recursive: true, force: true });
      }
    };
  }

  async writeBackupJob(job) {
    await this.initialize();
    await fsp.writeFile(
      this.getBackupJobPath(job.id),
      `${JSON.stringify(job, null, 2)}\n`,
      'utf8'
    );
    await fsp.writeFile(this.latestBackupJobRefPath, `${job.id}\n`, 'utf8');
    return job;
  }

  async readBackupJob(jobId) {
    const raw = await fsp.readFile(this.getBackupJobPath(jobId), 'utf8');
    return JSON.parse(raw);
  }

  async updateBackupJob(jobId, updater) {
    const current = await this.readBackupJob(jobId);
    const patch = typeof updater === 'function' ? await updater(current) : updater;
    const next = {
      ...current,
      ...patch,
      updatedAt: this.now().toISOString()
    };
    await this.writeBackupJob(next);
    return next;
  }

  async readLatestBackupJobRecord() {
    await this.initialize();

    try {
      const jobId = String(await fsp.readFile(this.latestBackupJobRefPath, 'utf8')).trim();
      if (!jobId) {
        return null;
      }

      return await this.readBackupJob(jobId);
    } catch (_error) {
      return null;
    }
  }

  async recoverInterruptedBackupJob(job) {
    if (!job || !isBackupActiveStatus(job.status) || this._runningBackupPromise) {
      return job || null;
    }

    return this.updateBackupJob(job.id, {
      status: 'failed',
      phase: 'failed',
      completedAt: this.now().toISOString(),
      error: 'Backup was interrupted before completion. The HomeBrain process is no longer running this backup job.',
      message: 'Backup failed because the HomeBrain process stopped before the job completed.'
    });
  }

  async getLatestBackupJob() {
    const latestJob = await this.readLatestBackupJobRecord();
    return buildBackupJobSummary(await this.recoverInterruptedBackupJob(latestJob));
  }

  async writeSmbCredentialsFile(options = {}, tempRoot) {
    const username = String(options.username || '').trim();
    const password = String(options.password || '');
    const domain = String(options.domain || '').trim();
    if (!username && !password) {
      return null;
    }

    const credentialsPath = path.join(tempRoot, 'smb-credentials');
    const lines = [];
    if (username) {
      lines.push(`username = ${username}`);
    }
    lines.push(`password = ${password}`);
    if (domain) {
      lines.push(`domain = ${domain}`);
    }
    await fsp.writeFile(credentialsPath, `${lines.join('\n')}\n`, { mode: 0o600 });
    await fsp.chmod(credentialsPath, 0o600);
    return credentialsPath;
  }

  buildSmbOptionsFromSettings(settings = {}, overrides = {}) {
    const shareOverrideKey = hasOwnValue(overrides, 'shareUrl') ? 'shareUrl' : 'sharePath';
    const shareOverrideExplicit = hasOwnValue(overrides, 'shareUrl') || hasOwnValue(overrides, 'sharePath');
    return {
      shareUrl: pickConfiguredString(overrides[shareOverrideKey], settings.smbBackupShareUrl, shareOverrideExplicit),
      remoteDirectory: pickConfiguredString(
        overrides.remoteDirectory,
        settings.smbBackupRemoteDirectory,
        hasOwnValue(overrides, 'remoteDirectory')
      ),
      username: pickConfiguredString(overrides.username, settings.smbBackupUsername, hasOwnValue(overrides, 'username')),
      password: pickConfiguredPassword(overrides.password, settings.smbBackupPassword),
      domain: pickConfiguredString(overrides.domain, settings.smbBackupDomain, hasOwnValue(overrides, 'domain')),
      retentionCount: normalizeRetentionCount(
        Object.prototype.hasOwnProperty.call(overrides, 'retentionCount')
          ? overrides.retentionCount
          : settings.smbBackupRetentionCount,
        null
      )
    };
  }

  async resolveSmbOptions(options = {}) {
    if (!options.useSavedSettings) {
      return options;
    }

    const settings = await this.settingsModel.getSettings();
    return {
      ...options,
      ...this.buildSmbOptionsFromSettings(settings, options)
    };
  }

  async runSmbClientCommand(options = {}, commandText, commandOptions = {}) {
    const target = parseSmbShareTarget(options.shareUrl || options.sharePath, options.remoteDirectory);
    const tempRoot = await fsp.mkdtemp(path.join(this.tempRoot, 'homebrain-smb-backup-'));

    try {
      const credentialsPath = await this.writeSmbCredentialsFile(options, tempRoot);
      const args = [
        target.sharePath,
        '-m',
        'SMB3'
      ];
      if (credentialsPath) {
        args.push('-A', credentialsPath);
      } else {
        args.push('-N');
      }
      args.push('-c', commandText);

      try {
        const result = await this.runCommand('smbclient', args, {
          captureStdout: commandOptions.captureStdout !== false
        });
        return { target, result };
      } catch (error) {
        if (/ENOENT|not found|spawn smbclient/i.test(error.message || '')) {
          throw new Error('smbclient is required to save backups to SMB. Install the samba-client/smbclient package on the HomeBrain host.');
        }
        throw error;
      }
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async uploadArchiveToSmb(archivePath, options = {}) {
    const target = parseSmbShareTarget(options.shareUrl || options.sharePath, options.remoteDirectory);
    const remoteFilename = sanitizeFilename(options.remoteFilename || path.basename(archivePath), path.basename(archivePath));
    const { target: uploadedTarget } = await this.runSmbClientCommand(
      options,
      buildSmbClientUploadCommand(archivePath, target.remoteDirectory, remoteFilename),
      { captureStdout: false }
    );

    return {
      sharePath: uploadedTarget.sharePath,
      remoteDirectory: uploadedTarget.remoteDirectory,
      remoteFilename,
      remoteTarget: `${uploadedTarget.displayPath}/${remoteFilename}`,
      displayPath: uploadedTarget.displayPath
    };
  }

  async testSmbConnection(options = {}) {
    const resolvedOptions = await this.resolveSmbOptions(options);
    const target = parseSmbShareTarget(resolvedOptions.shareUrl || resolvedOptions.sharePath, resolvedOptions.remoteDirectory);
    const tempRoot = await fsp.mkdtemp(path.join(this.tempRoot, 'homebrain-smb-test-'));
    const remoteFilename = `homebrain-smb-test-${randomUUID()}.txt`;
    const localTestPath = path.join(tempRoot, remoteFilename);

    try {
      await fsp.writeFile(localTestPath, `HomeBrain SMB connection test ${this.now().toISOString()}\n`, 'utf8');
      const { result } = await this.runSmbClientCommand(
        resolvedOptions,
        buildSmbClientTestCommand(localTestPath, target.remoteDirectory, remoteFilename),
        { captureStdout: true }
      );

      return {
        success: true,
        message: 'SMB connection test completed successfully.',
        sharePath: target.sharePath,
        remoteDirectory: target.remoteDirectory,
        remoteTarget: `${target.displayPath}/${remoteFilename}`,
        stdout: result.stdout || ''
      };
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async listSmbBackupFiles(options = {}) {
    const target = parseSmbShareTarget(options.shareUrl || options.sharePath, options.remoteDirectory);
    const { result } = await this.runSmbClientCommand(
      options,
      buildSmbClientListBackupsCommand(target.remoteDirectory),
      { captureStdout: true }
    );

    return {
      sharePath: target.sharePath,
      remoteDirectory: target.remoteDirectory,
      displayPath: target.displayPath,
      files: parseSmbBackupFilenames(result.stdout)
    };
  }

  async pruneSmbBackups(options = {}, keepCount = 3) {
    const normalizedKeepCount = normalizeRetentionCount(keepCount, 3);
    const listing = await this.listSmbBackupFiles(options);
    const sorted = [...listing.files].sort().reverse();
    const kept = sorted.slice(0, normalizedKeepCount);
    const deleted = sorted.slice(normalizedKeepCount);

    if (deleted.length > 0) {
      await this.runSmbClientCommand(
        options,
        buildSmbClientDeleteBackupsCommand(listing.remoteDirectory, deleted),
        { captureStdout: false }
      );
    }

    return {
      keepCount: normalizedKeepCount,
      matched: sorted.length,
      kept,
      deleted,
      displayPath: listing.displayPath
    };
  }

  async startSmbBackupJob(options = {}) {
    return this.startSmbBackupJobInternal(options, { requireConfirmation: true });
  }

  async startScheduledSmbBackupJobFromSettings(settings = {}, options = {}) {
    const resolved = {
      ...this.buildSmbOptionsFromSettings(settings, options),
      actor: options.actor || 'system:scheduler',
      source: 'scheduled',
      targetRunAt: options.targetRunAt || null,
      onComplete: options.onComplete
    };
    return this.startSmbBackupJobInternal(resolved, { requireConfirmation: false });
  }

  async startSmbBackupJobInternal(options = {}, control = {}) {
    await this.initialize();
    const requireConfirmation = control.requireConfirmation !== false;
    const resolvedOptions = await this.resolveSmbOptions(options);

    if (requireConfirmation && String(resolvedOptions.confirmBackup || resolvedOptions.confirm || '').trim().toUpperCase() !== SMB_BACKUP_CONFIRMATION) {
      const error = new Error(`Type ${SMB_BACKUP_CONFIRMATION} to save a disaster recovery backup to SMB.`);
      error.status = 400;
      throw error;
    }

    const target = parseSmbShareTarget(resolvedOptions.shareUrl || resolvedOptions.sharePath, resolvedOptions.remoteDirectory);

    const latestJob = await this.recoverInterruptedBackupJob(await this.readLatestBackupJobRecord());
    if ((latestJob && isBackupActiveStatus(latestJob.status)) || this._runningBackupPromise) {
      const error = new Error('A disaster recovery backup job is already running');
      error.code = 'BACKUP_RUNNING';
      throw error;
    }

    const job = await this.writeBackupJob({
      id: randomUUID(),
      actor: resolvedOptions.actor || 'unknown',
      source: resolvedOptions.source || 'manual',
      archiveName: null,
      status: 'queued',
      phase: 'queued',
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      completedAt: null,
      error: null,
      message: 'SMB backup queued.',
      remoteTarget: null,
      smb: {
        sharePath: target.sharePath,
        remoteDirectory: target.remoteDirectory,
        usernameConfigured: Boolean(String(resolvedOptions.username || '').trim()),
        domain: String(resolvedOptions.domain || '').trim() || null
      },
      retention: null,
      manifest: null
    });

    this._runningBackupPromise = this.executeSmbBackupJob(job.id, resolvedOptions)
      .catch(() => null)
      .finally(() => {
        this._runningBackupPromise = null;
      });

    return buildBackupJobSummary(job);
  }

  async executeSmbBackupJob(jobId, options = {}) {
    let backup = null;
    try {
      await this.updateBackupJob(jobId, {
        status: 'creating',
        phase: 'creating-archive',
        message: 'Creating HomeBrain disaster recovery archive.'
      });

      backup = await this.createDisasterRecoveryBackup();

      await this.updateBackupJob(jobId, {
        status: 'uploading',
        phase: 'uploading-smb',
        archiveName: backup.archiveFilename,
        manifest: {
          version: backup.manifest?.version || null,
          createdAt: backup.manifest?.createdAt || null,
          appVersion: backup.manifest?.appVersion || null,
          database: backup.manifest?.database || null
        },
        message: 'Uploading backup archive to SMB share.'
      });

      const uploaded = await this.uploadArchiveToSmb(backup.archivePath, {
        ...options,
        remoteFilename: options.remoteFilename || backup.archiveFilename
      });

      let retention = null;
      const retentionCount = normalizeRetentionCount(options.retentionCount, null);
      if (retentionCount) {
        retention = await this.pruneSmbBackups(options, retentionCount);
      }

      const completedJob = await this.updateBackupJob(jobId, {
        status: 'completed',
        phase: 'completed',
        completedAt: this.now().toISOString(),
        remoteTarget: uploaded.remoteTarget,
        retention,
        message: retention
          ? `Backup saved to ${uploaded.remoteTarget}. Retention kept ${retention.kept.length} backup${retention.kept.length === 1 ? '' : 's'} and deleted ${retention.deleted.length}.`
          : `Backup saved to ${uploaded.remoteTarget}.`
      });
      await options.onComplete?.(buildBackupJobSummary(completedJob));
    } catch (error) {
      const failedJob = await this.updateBackupJob(jobId, {
        status: 'failed',
        phase: 'failed',
        completedAt: this.now().toISOString(),
        error: error.message,
        message: 'Backup failed before HomeBrain could save the archive to SMB.'
      }).catch(() => {});
      if (failedJob) {
        await options.onComplete?.(buildBackupJobSummary(failedJob));
      }
    } finally {
      await backup?.cleanup?.().catch(() => {});
    }
  }

  async writeRestoreJob(job) {
    await this.initialize();
    await fsp.writeFile(
      this.getRestoreJobPath(job.id),
      `${JSON.stringify(job, null, 2)}\n`,
      'utf8'
    );
    await fsp.writeFile(this.latestRestoreJobRefPath, `${job.id}\n`, 'utf8');
    return job;
  }

  async readRestoreJob(jobId) {
    const raw = await fsp.readFile(this.getRestoreJobPath(jobId), 'utf8');
    return JSON.parse(raw);
  }

  async updateRestoreJob(jobId, updater) {
    const current = await this.readRestoreJob(jobId);
    const patch = typeof updater === 'function' ? await updater(current) : updater;
    const next = {
      ...current,
      ...patch,
      updatedAt: this.now().toISOString()
    };
    await this.writeRestoreJob(next);
    return next;
  }

  async readLatestRestoreJobRecord() {
    await this.initialize();

    try {
      const jobId = String(await fsp.readFile(this.latestRestoreJobRefPath, 'utf8')).trim();
      if (!jobId) {
        return null;
      }

      return await this.readRestoreJob(jobId);
    } catch (_error) {
      return null;
    }
  }

  async getLatestRestoreJob() {
    return buildRestoreJobSummary(await this.readLatestRestoreJobRecord());
  }

  async stageRestoreUpload(readable, options = {}) {
    await this.initialize();

    const filename = sanitizeFilename(options.archiveName, 'homebrain-backup.tar.gz');
    const uploadId = randomUUID();
    const archivePath = path.join(this.restoreArchivesDir, `${uploadId}-${filename}`);

    await pipeline(readable, fs.createWriteStream(archivePath));

    return {
      archivePath,
      archiveName: filename
    };
  }

  async startRestoreJobFromArchive(archivePath, options = {}) {
    await this.initialize();

    const latestJob = await this.readLatestRestoreJobRecord();
    if ((latestJob && isRestoreActiveStatus(latestJob.status)) || this._runningRestorePromise) {
      const error = new Error('A restore job is already running');
      error.code = 'RESTORE_RUNNING';
      throw error;
    }

    const job = await this.writeRestoreJob({
      id: randomUUID(),
      actor: options.actor || 'unknown',
      archiveName: sanitizeFilename(options.archiveName, path.basename(archivePath)),
      archivePath,
      status: 'queued',
      phase: 'queued',
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      completedAt: null,
      error: null,
      message: 'Restore queued. HomeBrain will restart when the restore finishes.',
      manifest: null
    });

    return buildRestoreJobSummary(job);
  }

  async markRestoreJobFailed(jobId, errorMessage, message = 'Restore could not be launched.') {
    return buildRestoreJobSummary(await this.updateRestoreJob(jobId, {
      status: 'failed',
      phase: 'failed',
      completedAt: this.now().toISOString(),
      error: errorMessage,
      message
    }));
  }

  async launchRestoreHelper() {
    try {
      await this.runCommand('sudo', ['-n', 'systemctl', 'start', this.restoreHelperServiceName], {
        captureStdout: false
      });

      return {
        serviceName: this.restoreHelperServiceName,
        launchStrategy: 'systemd-service'
      };
    } catch (error) {
      const restoreHelperScriptPath = path.join(this.projectRoot, 'scripts', 'restore-homebrain-backup.sh');

      if (!(await this.pathExists(restoreHelperScriptPath))) {
        throw error;
      }

      await this.spawnDetached(restoreHelperScriptPath, [], {
        env: {
          HOMEBRAIN_SERVICE_NAME: this.serviceName,
          HOMEBRAIN_DIR: this.projectRoot,
          HOMEBRAIN_PORT: String(process.env.HOMEBRAIN_PORT || '3000')
        }
      });

      return {
        serviceName: this.restoreHelperServiceName,
        launchStrategy: 'detached-script',
        scriptPath: restoreHelperScriptPath,
        fallbackReason: error.message
      };
    }
  }

  async runRestoreJob(jobId, options = {}) {
    const job = await this.readRestoreJob(jobId);

    if (!job?.archivePath) {
      throw new Error(`Restore job "${jobId}" is missing its archive path.`);
    }

    if (this._runningRestorePromise) {
      const error = new Error('A restore job is already running');
      error.code = 'RESTORE_RUNNING';
      throw error;
    }

    this._runningRestorePromise = this.executeRestoreJob(job.id, job.archivePath, options)
      .catch(() => null)
      .finally(() => {
        this._runningRestorePromise = null;
      });

    await this._runningRestorePromise;
    return buildRestoreJobSummary(await this.readRestoreJob(job.id));
  }

  async runLatestQueuedRestoreJob(options = {}) {
    const latestJob = await this.readLatestRestoreJobRecord();

    if (!latestJob) {
      throw new Error('No restore job is available.');
    }

    if (String(latestJob.status || '') !== 'queued') {
      throw new Error(`Latest restore job is "${latestJob.status}", not queued.`);
    }

    return this.runRestoreJob(latestJob.id, options);
  }

  async extractArchiveToTemp(archivePath) {
    const tempRoot = await fsp.mkdtemp(path.join(this.tempRoot, 'homebrain-restore-'));
    const extractRoot = path.join(tempRoot, 'bundle');
    await fsp.mkdir(extractRoot, { recursive: true });
    await this.runCommand('tar', ['-xzf', archivePath, '-C', extractRoot]);
    return {
      tempRoot,
      extractRoot
    };
  }

  loadEnvOverrides(extractedRoot) {
    const envPath = path.join(extractedRoot, 'filesystem', '.env');
    if (!fs.existsSync(envPath)) {
      return {};
    }

    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      return dotenv.parse(raw);
    } catch (_error) {
      return {};
    }
  }

  async restoreFileTarget(extractedRoot, target) {
    const sourcePath = path.join(extractedRoot, 'filesystem', target.relativePath);
    const targetPath = path.join(this.projectRoot, target.relativePath);
    const exists = await this.pathExists(sourcePath);

    if (!exists) {
      return;
    }

    if (target.kind === 'directory') {
      await fsp.mkdir(targetPath, { recursive: true });
      const sourceEntries = await fsp.readdir(sourcePath, { withFileTypes: true });
      const existingEntries = await fsp.readdir(targetPath, { withFileTypes: true }).catch(() => []);
      const sourceNames = new Set(sourceEntries.map((entry) => entry.name));
      const excludedNames = new Set(Array.isArray(target.excludeNames) ? target.excludeNames : []);

      for (const entry of existingEntries) {
        if (excludedNames.has(entry.name)) {
          continue;
        }
        if (!sourceNames.has(entry.name)) {
          await fsp.rm(path.join(targetPath, entry.name), { recursive: true, force: true });
        }
      }

      for (const entry of sourceEntries) {
        const sourceEntryPath = path.join(sourcePath, entry.name);
        const targetEntryPath = path.join(targetPath, entry.name);
        await fsp.rm(targetEntryPath, { recursive: true, force: true });
        await this.copyPath(sourceEntryPath, targetEntryPath, {});
      }
      return;
    }

    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(sourcePath, targetPath);
  }

  async queueServiceRestart() {
    try {
      await this.runCommand('sudo', ['-n', 'systemctl', 'restart', this.serviceName], {
        captureStdout: false
      });
    } catch (error) {
      console.warn(`SystemBackupService: failed to restart ${this.serviceName}: ${error.message}`);
    }
  }

  async executeRestoreJob(jobId, archivePath, options = {}) {
    const restartOnComplete = options.restartOnComplete !== false;
    let tempRoot = null;

    try {
      await this.updateRestoreJob(jobId, {
        status: 'validating',
        phase: 'validating',
        message: 'Validating backup archive.'
      });

      const extracted = await this.extractArchiveToTemp(archivePath);
      tempRoot = extracted.tempRoot;

      const manifestPath = path.join(extracted.extractRoot, 'manifest.json');
      const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      if (manifest.version !== BACKUP_FORMAT_VERSION || manifest.format !== 'homebrain-disaster-recovery') {
        throw new Error('Unsupported HomeBrain backup format');
      }

      await this.updateRestoreJob(jobId, {
        status: 'restoring',
        phase: 'filesystem',
        manifest: {
          version: manifest.version,
          createdAt: manifest.createdAt || null,
          appVersion: manifest.appVersion || null
        },
        message: 'Restoring HomeBrain filesystem state.'
      });

      for (const target of this.getBackupTargets()) {
        await this.restoreFileTarget(extracted.extractRoot, target);
      }

      const envOverrides = this.loadEnvOverrides(extracted.extractRoot);
      const databaseUrl = String(envOverrides.DATABASE_URL || this.databaseUrl || '').trim();
      if (!databaseUrl) {
        throw new Error('DATABASE_URL is missing. HomeBrain cannot restore the database without it.');
      }

      await this.updateRestoreJob(jobId, {
        phase: 'database',
        message: 'Restoring MongoDB data.'
      });

      const databaseArchivePath = path.join(
        extracted.extractRoot,
        manifest.database?.archivePath || path.join('database', 'homebrain.mongodb.archive.gz')
      );

      await this.runCommand('mongorestore', [
        `--uri=${databaseUrl}`,
        '--drop',
        ...buildArchivePathArgs(databaseArchivePath)
      ]);

      if (restartOnComplete) {
        await this.updateRestoreJob(jobId, {
          status: 'completed',
          phase: 'restart_pending',
          completedAt: this.now().toISOString(),
          message: 'Restore completed. Restarting HomeBrain to load the restored environment.'
        });

        await this.queueServiceRestart();
      } else {
        await this.updateRestoreJob(jobId, {
          status: 'completed',
          phase: 'completed',
          completedAt: this.now().toISOString(),
          message: 'Restore completed. Start HomeBrain to load the restored environment.'
        });
      }
    } catch (error) {
      await this.updateRestoreJob(jobId, {
        status: 'failed',
        phase: 'failed',
        completedAt: this.now().toISOString(),
        error: error.message,
        message: 'Restore failed before HomeBrain could finish applying the backup.'
      }).catch(() => {});
    } finally {
      if (tempRoot) {
        await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

module.exports = new SystemBackupService();
module.exports.SystemBackupService = SystemBackupService;
module.exports._test = {
  buildSmbClientUploadCommand,
  buildSmbClientTestCommand,
  buildSmbClientListBackupsCommand,
  buildSmbClientDeleteBackupsCommand,
  parseSmbShareTarget,
  parseSmbBackupFilenames
};

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

const BACKUP_FORMAT_VERSION = 1;
const DEFAULT_SERVICE_NAME = 'homebrain';

function isRestoreActiveStatus(status) {
  return ['queued', 'validating', 'restoring'].includes(String(status || '').trim());
}

function sanitizeFilename(value, fallback = 'homebrain-backup.tar.gz') {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return fallback;
  }

  const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
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

function buildArchivePathArgs(targetPath) {
  return [`--archive=${targetPath}`, '--gzip'];
}

class SystemBackupService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');
    this.serverRoot = path.join(this.projectRoot, 'server');
    this.backupRoot = options.backupRoot || path.join(this.serverRoot, 'data', 'system-backup');
    this.restoreJobsDir = path.join(this.backupRoot, 'restore-jobs');
    this.restoreArchivesDir = path.join(this.backupRoot, 'restore-archives');
    this.latestRestoreJobRefPath = path.join(this.backupRoot, 'latest-restore-job.txt');
    this.spawnProcess = options.spawnProcess || spawn;
    this.tempRoot = options.tempRoot || os.tmpdir();
    this.databaseUrl = options.databaseUrl || process.env.DATABASE_URL || '';
    this.serviceName = options.serviceName || process.env.HOMEBRAIN_SERVICE_NAME || DEFAULT_SERVICE_NAME;
    this.restoreHelperServiceName = options.restoreHelperServiceName
      || process.env.HOMEBRAIN_RESTORE_HELPER_SERVICE_NAME
      || `${this.serviceName}-restore-helper`;
    this.now = options.now || (() => new Date());
    this._runningRestorePromise = null;
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

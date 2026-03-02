const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const wakeWordTrainingService = require('./wakeWordTrainingService');
const eventStreamService = require('./eventStreamService');

const MAX_LOG_TAIL_BYTES = 64 * 1024;

const DEPLOY_PRESETS = Object.freeze({
  safe: Object.freeze({
    id: 'safe',
    label: 'Safe',
    description: 'Install dependencies, build, run server tests, then restart services.',
    defaults: Object.freeze({
      allowDirty: false,
      installDependencies: true,
      runServerTests: true,
      runClientLint: false,
      restartServices: true
    })
  }),
  minimal: Object.freeze({
    id: 'minimal',
    label: 'Minimal',
    description: 'Fastest path: pull/build/restart only. Skips dependency installs and tests.',
    defaults: Object.freeze({
      allowDirty: false,
      installDependencies: false,
      runServerTests: false,
      runClientLint: false,
      restartServices: true
    })
  }),
  full: Object.freeze({
    id: 'full',
    label: 'Full',
    description: 'Most thorough: install deps, lint client, run tests, then restart services.',
    defaults: Object.freeze({
      allowDirty: false,
      installDependencies: true,
      runServerTests: true,
      runClientLint: true,
      restartServices: true
    })
  })
});

const DB_READY_STATE = Object.freeze({
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting'
});

function trimStdout(value) {
  return (value || '').toString().trim();
}

class PlatformDeployService {
  constructor() {
    this.projectRoot = path.resolve(__dirname, '..', '..');
    this.dataDir = path.join(__dirname, '..', 'data', 'platform-deploy');
    this.jobsDir = path.join(this.dataDir, 'jobs');
    this.latestJobRefPath = path.join(this.dataDir, 'latest-job.txt');
    this.initialized = false;
    this.startDeployInProgress = false;
    // Cleaning client/dist can roll back freshly built frontend bundles on systems
    // that serve dist directly. Keep this opt-in only.
    this.autoCleanClientDist = process.env.HOMEBRAIN_DEPLOY_AUTOCLEAN_CLIENT_DIST === 'true';
    this.restartOllamaOnDeploy = process.env.HOMEBRAIN_DEPLOY_RESTART_OLLAMA !== 'false';
    this.defaultOllamaRestartCommand = process.env.HOMEBRAIN_DEPLOY_OLLAMA_RESTART_CMD
      || 'sudo systemctl restart ollama';
    this.customRestartCommand = process.env.HOMEBRAIN_DEPLOY_RESTART_CMD || '';
    this.coreRestartCommand = process.env.HOMEBRAIN_DEPLOY_CORE_RESTART_CMD
      || 'sudo systemctl daemon-reload || true; sudo systemctl restart homebrain-discovery || true; sudo systemctl restart homebrain';
  }

  async initialize() {
    if (this.initialized) {
      return;
    }

    await fsp.mkdir(this.jobsDir, { recursive: true });
    this.initialized = true;
  }

  getDeployPresets() {
    return Object.values(DEPLOY_PRESETS);
  }

  resolveDeployOptions(options = {}) {
    const presetId = typeof options.preset === 'string' && DEPLOY_PRESETS[options.preset]
      ? options.preset
      : 'safe';
    const preset = DEPLOY_PRESETS[presetId];
    const defaults = preset.defaults;
    const pickBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

    return {
      preset: presetId,
      allowDirty: pickBoolean(options.allowDirty, defaults.allowDirty),
      installDependencies: pickBoolean(options.installDependencies, defaults.installDependencies),
      runServerTests: pickBoolean(options.runServerTests, defaults.runServerTests),
      runClientLint: pickBoolean(options.runClientLint, defaults.runClientLint),
      restartServices: pickBoolean(options.restartServices, defaults.restartServices)
    };
  }

  async getDeployHealth(app) {
    const checkedAt = new Date().toISOString();
    const api = {
      status: 'healthy',
      message: 'API process is responding.'
    };

    const voiceWs = app?.get?.('voiceWebSocket') || null;
    const wsServerInitialized = Boolean(voiceWs?.wss);
    const wsConnections = typeof voiceWs?.deviceConnections?.size === 'number'
      ? voiceWs.deviceConnections.size
      : 0;
    const websocket = {
      status: wsServerInitialized ? 'healthy' : 'degraded',
      message: wsServerInitialized
        ? 'Voice WebSocket server is initialized.'
        : 'Voice WebSocket server is not initialized.',
      serverInitialized: wsServerInitialized,
      connectedDevices: wsConnections
    };

    const dbReadyState = mongoose.connection.readyState;
    const database = {
      status: dbReadyState === 1 ? 'healthy' : 'degraded',
      message: `MongoDB is ${DB_READY_STATE[dbReadyState] || 'unknown'}.`,
      readyState: dbReadyState,
      state: DB_READY_STATE[dbReadyState] || 'unknown'
    };

    let wakeQueue = { active: [], pending: [] };
    try {
      wakeQueue = await wakeWordTrainingService.getQueueStatus();
    } catch (error) {
      wakeQueue = { active: [], pending: [] };
    }

    const pythonExecutable = wakeWordTrainingService.pythonExecutable || null;
    const workerBinaryAvailable = Boolean(pythonExecutable && fs.existsSync(pythonExecutable));
    const wakeWordWorker = {
      status: workerBinaryAvailable ? 'healthy' : 'degraded',
      message: workerBinaryAvailable
        ? 'Wake-word worker executable is available.'
        : 'Wake-word worker executable is missing.',
      pythonExecutable,
      activeJobs: wakeQueue.active.length,
      pendingJobs: wakeQueue.pending.length
    };

    const checks = { api, websocket, database, wakeWordWorker };
    const hasDegraded = Object.values(checks).some((item) => item.status !== 'healthy');

    return {
      checkedAt,
      overallStatus: hasDegraded ? 'degraded' : 'healthy',
      checks
    };
  }

  getJobPath(jobId) {
    return path.join(this.jobsDir, `${jobId}.json`);
  }

  getLogPath(jobId) {
    return path.join(this.jobsDir, `${jobId}.log`);
  }

  async runCommand(command, args, options = {}) {
    const cwd = options.cwd || this.projectRoot;
    const env = { ...process.env, ...(options.env || {}) };
    const captureStdout = options.captureStdout !== false;

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        const value = chunk.toString();
        if (captureStdout) {
          stdout += value;
        }
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({
            code,
            stdout: trimStdout(stdout),
            stderr: trimStdout(stderr)
          });
          return;
        }

        const err = new Error(
          `Command failed (${command} ${args.join(' ')}): ${trimStdout(stderr) || `exit ${code}`}`
        );
        err.code = code;
        err.stderr = trimStdout(stderr);
        err.stdout = trimStdout(stdout);
        reject(err);
      });
    });
  }

  async runLoggedCommand(jobId, stepName, command, args, options = {}) {
    const cwd = options.cwd || this.projectRoot;
    const env = { ...process.env, ...(options.env || {}) };
    const appendChunk = async (prefix, chunk) => {
      const text = chunk.toString();
      if (!text) return;
      const timestamp = new Date().toISOString();
      await this.appendJobLog(jobId, `[${timestamp}] [${stepName}] ${prefix}${text}`);
    };

    await this.appendJobLog(
      jobId,
      `\n[${new Date().toISOString()}] [${stepName}] Running: ${command} ${args.join(' ')}\n`
    );

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      child.stdout.on('data', (chunk) => {
        void appendChunk('', chunk).catch(() => {});
      });
      child.stderr.on('data', (chunk) => {
        void appendChunk('ERR: ', chunk).catch(() => {});
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ code });
          return;
        }
        reject(new Error(`Step "${stepName}" failed with exit code ${code}`));
      });
    });
  }

  getSafeGitArgs(args = []) {
    return ['-c', `safe.directory=${this.projectRoot}`, ...args];
  }

  async getClientDistStatusLines() {
    const result = await this.runCommand(
      'git',
      this.getSafeGitArgs(['status', '--porcelain', '--', 'client/dist'])
    );

    return (result.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async cleanupClientDistArtifacts({ jobId = null } = {}) {
    const log = async (message) => {
      if (!jobId) return;
      await this.appendJobLog(
        jobId,
        `[${new Date().toISOString()}] [Clean client dist artifacts] ${message}\n`
      );
    };

    const changes = await this.getClientDistStatusLines();
    if (changes.length === 0) {
      return { cleaned: false };
    }

    await log(`Detected ${changes.length} generated change(s) in client/dist; resetting.`);

    const runGitNoOutput = (args) => this.runCommand(
      'git',
      this.getSafeGitArgs(args),
      { captureStdout: false }
    );

    try {
      await runGitNoOutput(['restore', '--source=HEAD', '--worktree', '--staged', '--', 'client/dist']);
    } catch (error) {
      await log(`"git restore" failed (${error.message}); trying fallback.`);
      await runGitNoOutput(['reset', '--', 'client/dist']).catch(() => {});
      await runGitNoOutput(['checkout', '--', 'client/dist']);
    }

    await runGitNoOutput(['clean', '-fd', '--', 'client/dist']).catch(async (error) => {
      await log(`WARN: git clean failed: ${error.message}`);
    });

    const remaining = await this.getClientDistStatusLines();
    if (remaining.length > 0) {
      throw new Error(`Unable to clean generated client/dist artifacts (${remaining.length} changes remain).`);
    }

    await log('client/dist artifacts normalized.');
    return { cleaned: true };
  }

  async getRepoStatus() {
    await this.initialize();

    const runGit = async (args, fallback = '') => {
      try {
        const result = await this.runCommand('git', this.getSafeGitArgs(args));
        return result.stdout || fallback;
      } catch (error) {
        return fallback;
      }
    };

    const [branch, commit, shortCommit, remote, upstream, statusOutput] = await Promise.all([
      runGit(['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown'),
      runGit(['rev-parse', 'HEAD'], ''),
      runGit(['rev-parse', '--short', 'HEAD'], ''),
      runGit(['config', '--get', 'remote.origin.url'], ''),
      runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], ''),
      runGit(['status', '--porcelain'], '')
    ]);

    const rawDirtyEntries = statusOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const ignoredDirtyEntries = rawDirtyEntries.filter((entry) => this.isIgnorableDirtyEntry(entry));
    const dirtyEntries = rawDirtyEntries.filter((entry) => !this.isIgnorableDirtyEntry(entry));

    let ahead = 0;
    let behind = 0;
    if (upstream) {
      const aheadBehind = await runGit(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], '');
      const [behindCount, aheadCount] = aheadBehind.split('\t').map((value) => Number(value || 0));
      behind = Number.isFinite(behindCount) ? behindCount : 0;
      ahead = Number.isFinite(aheadCount) ? aheadCount : 0;
    }

    return {
      branch,
      commit,
      shortCommit,
      remote,
      upstream,
      dirty: dirtyEntries.length > 0,
      dirtyEntries,
      ignoredDirtyEntries,
      rawDirtyEntries,
      ahead,
      behind,
      projectRoot: this.projectRoot
    };
  }

  normalizeStatusEntryPath(entry = '') {
    const raw = String(entry || '').trim();
    if (!raw) {
      return '';
    }

    const withoutPrefix = raw.replace(/^[A-Z? !]{1,2}\s+/, '').trim();
    if (withoutPrefix.includes(' -> ')) {
      const parts = withoutPrefix.split(' -> ');
      return (parts[parts.length - 1] || '').trim();
    }
    return withoutPrefix;
  }

  isIgnorableDirtyEntry(entry = '') {
    const filePath = this.normalizeStatusEntryPath(entry);
    if (!filePath) {
      return false;
    }
    return filePath.startsWith('client/dist/');
  }

  async writeLatestJobRef(jobId) {
    await this.initialize();
    await fsp.writeFile(this.latestJobRefPath, `${jobId}\n`, 'utf8');
  }

  async readLatestJobRef() {
    await this.initialize();
    try {
      const value = await fsp.readFile(this.latestJobRefPath, 'utf8');
      return value.trim() || null;
    } catch (error) {
      return null;
    }
  }

  async writeJob(job) {
    await this.initialize();
    const filePath = this.getJobPath(job.id);
    await fsp.writeFile(filePath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  }

  async readJob(jobId) {
    await this.initialize();
    const filePath = this.getJobPath(jobId);
    const raw = await fsp.readFile(filePath, 'utf8');
    const job = JSON.parse(raw);
    const logTail = await this.readJobLogTail(jobId);
    return { ...job, logTail };
  }

  async readJobFile(jobId) {
    await this.initialize();
    const filePath = this.getJobPath(jobId);
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  }

  async updateJob(jobId, updater) {
    const current = await this.readJobFile(jobId).catch(() => null);
    if (!current) {
      return null;
    }
    const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater };
    const merged = {
      ...current,
      ...next,
      updatedAt: new Date().toISOString()
    };
    await this.writeJob(merged);
    return merged;
  }

  async appendJobLog(jobId, text) {
    await this.initialize();
    const filePath = this.getLogPath(jobId);
    await fsp.appendFile(filePath, text, 'utf8');
  }

  async readJobLogTail(jobId, maxBytes = MAX_LOG_TAIL_BYTES) {
    const filePath = this.getLogPath(jobId);

    try {
      const stat = await fsp.stat(filePath);
      const size = stat.size || 0;
      const start = size > maxBytes ? size - maxBytes : 0;
      const handle = await fsp.open(filePath, 'r');
      try {
        const length = size - start;
        if (length <= 0) {
          return '';
        }
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        return buffer.toString('utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      return '';
    }
  }

  async getLatestJob() {
    const latestJobId = await this.readLatestJobRef();
    if (!latestJobId) {
      return null;
    }
    try {
      return await this.readJob(latestJobId);
    } catch (error) {
      return null;
    }
  }

  async getRunningJob() {
    const latest = await this.getLatestJob();
    if (!latest) {
      return null;
    }

    if (latest.status !== 'running') {
      return null;
    }

    const updatedAt = Date.parse(latest.updatedAt || '');
    if (Number.isFinite(updatedAt)) {
      const staleForMs = Date.now() - updatedAt;
      if (staleForMs > 2 * 60 * 60 * 1000) {
        await this.updateJob(latest.id, {
          status: 'failed',
          currentStep: 'failed',
          error: 'Deployment marked stale after timeout',
          completedAt: new Date().toISOString()
        });
        return null;
      }
    }

    return latest;
  }

  sanitizeShellCommand(command) {
    if (typeof command !== 'string') {
      return '';
    }
    return command
      .replace(/\r?\n/g, '; ')
      .trim();
  }

  commandRestartsHomebrain(command) {
    if (!command) {
      return false;
    }
    return /\bsystemctl\s+(?:restart|try-restart|start)\s+[^;]*\bhomebrain\b/i.test(command);
  }

  buildServiceRestartCommand() {
    const commandParts = [];
    const notes = [];

    if (this.restartOllamaOnDeploy) {
      commandParts.push(`${this.defaultOllamaRestartCommand} || true`);
    }

    const customRestart = this.sanitizeShellCommand(this.customRestartCommand);
    if (customRestart) {
      if (this.commandRestartsHomebrain(customRestart)) {
        notes.push(
          'Ignored HOMEBRAIN_DEPLOY_RESTART_CMD because it restarts homebrain. ' +
          'Use HOMEBRAIN_DEPLOY_CORE_RESTART_CMD for full restart override.'
        );
      } else {
        commandParts.push(customRestart);
      }
    }

    const coreRestart = this.sanitizeShellCommand(this.coreRestartCommand)
      || 'sudo systemctl daemon-reload || true; sudo systemctl restart homebrain-discovery || true; sudo systemctl restart homebrain';
    commandParts.push(coreRestart);

    return {
      fullCommand: commandParts.join('; '),
      notes
    };
  }

  async triggerServiceRestart(jobId = null) {
    const { fullCommand, notes } = this.buildServiceRestartCommand();
    if (jobId) {
      await this.appendJobLog(
        jobId,
        `[${new Date().toISOString()}] [restart] Triggering service restart command: ${fullCommand}\n`
      );
      for (const note of notes) {
        await this.appendJobLog(jobId, `[${new Date().toISOString()}] [restart] ${note}\n`);
      }
    }

    const child = spawn('bash', ['-lc', fullCommand], {
      cwd: this.projectRoot,
      env: process.env,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    void eventStreamService.publishSafe({
      type: 'deploy.services_restart_triggered',
      source: 'platform_deploy',
      category: 'deploy',
      payload: {
        jobId: jobId || null,
        command: fullCommand
      },
      tags: ['deploy', 'restart']
    });
  }

  async startDeploy(options = {}, actor = 'unknown') {
    if (this.startDeployInProgress) {
      const running = await this.getRunningJob().catch(() => null);
      const error = new Error('A deployment job is already being started');
      error.code = 'DEPLOY_RUNNING';
      error.job = running;
      throw error;
    }

    this.startDeployInProgress = true;
    try {
      await this.initialize();
      const running = await this.getRunningJob();
      if (running) {
        const error = new Error('A deployment job is already running');
        error.code = 'DEPLOY_RUNNING';
        error.job = running;
        throw error;
      }

      if (this.autoCleanClientDist) {
        await this.cleanupClientDistArtifacts().catch(() => {});
      }

      const resolvedOptions = this.resolveDeployOptions(options);
      let repoStatus = await this.getRepoStatus();
      if ((repoStatus.ignoredDirtyEntries || []).length > 0) {
        // Normalize generated frontend artifacts up front so deploy start/pull
        // is not blocked by hashed client/dist churn.
        await this.cleanupClientDistArtifacts().catch(() => {});
        repoStatus = await this.getRepoStatus();
      }
      const allowDirty = resolvedOptions.allowDirty === true;
      if (repoStatus.dirty && !allowDirty) {
        const blockingDirtyEntries = (repoStatus.dirtyEntries || []).filter(
          (entry) => !this.isIgnorableDirtyEntry(entry)
        );

        if (blockingDirtyEntries.length === 0 && (repoStatus.ignoredDirtyEntries || []).length > 0) {
          // Dist-only dirtiness is common after client builds; normalize and re-check.
          await this.cleanupClientDistArtifacts().catch(() => {});
          repoStatus = await this.getRepoStatus();
        }

        const blockingAfterCleanup = (repoStatus.dirtyEntries || []).filter(
          (entry) => !this.isIgnorableDirtyEntry(entry)
        );

        if (blockingAfterCleanup.length > 0) {
          const error = new Error('Repository has uncommitted non-dist changes. Commit/stash first or enable allowDirty.');
          error.code = 'REPO_DIRTY';
          error.repoStatus = {
            ...repoStatus,
            blockingDirtyEntries: blockingAfterCleanup
          };
          throw error;
        }
      }

      const job = {
        id: crypto.randomUUID(),
        actor,
        status: 'running',
        currentStep: 'queued',
        steps: [],
        options: {
          preset: resolvedOptions.preset,
          allowDirty,
          installDependencies: resolvedOptions.installDependencies,
          runServerTests: resolvedOptions.runServerTests,
          runClientLint: resolvedOptions.runClientLint,
          restartServices: resolvedOptions.restartServices
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
        repoBefore: repoStatus,
        repoAfter: null
      };

      await this.writeJob(job);
      await this.writeLatestJobRef(job.id);
      await this.appendJobLog(job.id, `[${new Date().toISOString()}] Deployment job created by ${actor}\n`);

      void eventStreamService.publishSafe({
        type: 'deploy.started',
        source: 'platform_deploy',
        category: 'deploy',
        payload: {
          jobId: job.id,
          actor,
          preset: job.options?.preset || 'safe',
          allowDirty: Boolean(job.options?.allowDirty),
          restartServices: Boolean(job.options?.restartServices)
        },
        tags: ['deploy', 'job']
      });

      void this.executeJob(job.id);
      return this.readJob(job.id);
    } finally {
      this.startDeployInProgress = false;
    }
  }

  async markStep(jobId, stepName, status, error = null) {
    await this.updateJob(jobId, (current) => {
      const steps = Array.isArray(current.steps) ? [...current.steps] : [];
      const existingIndex = steps.findIndex((step) => step.name === stepName);
      const nextStep = {
        name: stepName,
        status,
        updatedAt: new Date().toISOString(),
        ...(error ? { error } : {})
      };
      if (existingIndex >= 0) {
        steps[existingIndex] = { ...steps[existingIndex], ...nextStep };
      } else {
        steps.push(nextStep);
      }
      return {
        steps,
        currentStep: stepName
      };
    });
  }

  async executeJob(jobId) {
    const job = await this.readJob(jobId).catch(() => null);
    if (!job) {
      return;
    }

    const runStep = async (stepName, command, args, options = {}) => {
      await this.markStep(jobId, stepName, 'running');
      try {
        await this.runLoggedCommand(jobId, stepName, command, args, options);
        await this.markStep(jobId, stepName, 'completed');
      } catch (error) {
        await this.appendJobLog(jobId, `[${new Date().toISOString()}] [${stepName}] FAILED: ${error.message}\n`);
        await this.markStep(jobId, stepName, 'failed', error.message);
        throw error;
      }
    };

    const runCustomStep = async (stepName, operation) => {
      await this.markStep(jobId, stepName, 'running');
      try {
        await operation();
        await this.markStep(jobId, stepName, 'completed');
      } catch (error) {
        await this.appendJobLog(jobId, `[${new Date().toISOString()}] [${stepName}] FAILED: ${error.message}\n`);
        await this.markStep(jobId, stepName, 'failed', error.message);
        throw error;
      }
    };

    const runNpmStep = async (stepName, npmArgs, options = {}) => {
      await runStep(stepName, 'node', ['scripts/run-with-modern-node.js', 'npm', ...npmArgs], options);
    };

    try {
      await runCustomStep('Normalize client dist artifacts', async () => {
        await this.cleanupClientDistArtifacts({ jobId });
      });

      const prePullRepoStatus = await this.getRepoStatus();
      const skipPullForDirtyRepo = Boolean(job.options?.allowDirty) && Boolean(prePullRepoStatus?.dirty);

      await runStep('Fetch latest refs', 'git', this.getSafeGitArgs(['fetch', '--all', '--prune']));

      if (skipPullForDirtyRepo) {
        await runCustomStep('Pull latest changes', async () => {
          const behindCount = Number(prePullRepoStatus?.behind || 0);
          const dirtyCount = Array.isArray(prePullRepoStatus?.dirtyEntries)
            ? prePullRepoStatus.dirtyEntries.length
            : 0;
          const note = [
            'Skipping git pull because allowDirty=true and repository has local changes.',
            `Dirty entries: ${dirtyCount}.`,
            behindCount > 0
              ? `Remote is ahead by ${behindCount}; deploying current local checkout without pulling.`
              : 'Remote is not ahead; deploying current local checkout.'
          ].join(' ');
          await this.appendJobLog(jobId, `[${new Date().toISOString()}] [Pull latest changes] ${note}\n`);
        });
      } else {
        await runStep('Pull latest changes', 'git', this.getSafeGitArgs(['pull', '--ff-only']));
      }

      if (job.options.installDependencies) {
        await runNpmStep('Install root dependencies', ['install', '--include=dev', '--no-audit', '--no-fund']);
        await runNpmStep('Install server dependencies', ['install', '--include=dev', '--no-audit', '--no-fund', '--prefix', 'server']);
        await runNpmStep('Install client dependencies', ['install', '--include=dev', '--no-audit', '--no-fund', '--prefix', 'client']);
      }

      if (job.options.runClientLint) {
        await runNpmStep('Run client lint', ['run', 'lint', '--prefix', 'client', '--', '--max-warnings=0']);
      }

      await runNpmStep('Build client', ['run', 'build', '--prefix', 'client']);

      if (job.options.runServerTests) {
        await runNpmStep('Run server tests', ['test', '--prefix', 'server']);
      }

      // Do not clean client/dist after build.
      // This server serves client/dist directly at runtime, so post-build cleanup would
      // revert freshly built assets and can leave the UI running stale code.

      const repoAfter = await this.getRepoStatus();
      await this.updateJob(jobId, {
        status: 'completed',
        currentStep: 'completed',
        completedAt: new Date().toISOString(),
        repoAfter,
        error: null
      });
      await this.appendJobLog(jobId, `[${new Date().toISOString()}] Deployment completed successfully\n`);

      void eventStreamService.publishSafe({
        type: 'deploy.completed',
        source: 'platform_deploy',
        category: 'deploy',
        payload: {
          jobId,
          preset: job.options?.preset || 'safe',
          restartServices: Boolean(job.options?.restartServices),
          repoCommit: repoAfter?.shortCommit || null
        },
        tags: ['deploy', 'job']
      });

      if (job.options.restartServices) {
        await this.markStep(jobId, 'Restart services', 'running');
        await this.triggerServiceRestart(jobId);
        await this.markStep(jobId, 'Restart services', 'completed');
      }
    } catch (error) {
      await this.updateJob(jobId, {
        status: 'failed',
        currentStep: 'failed',
        completedAt: new Date().toISOString(),
        error: error.message || 'Deployment failed'
      });

      void eventStreamService.publishSafe({
        type: 'deploy.failed',
        source: 'platform_deploy',
        category: 'deploy',
        severity: 'error',
        payload: {
          jobId,
          preset: job.options?.preset || 'safe',
          error: error.message || 'Deployment failed'
        },
        tags: ['deploy', 'job']
      });
    }
  }
}

module.exports = new PlatformDeployService();

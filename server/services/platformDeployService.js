const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const wakeWordTrainingService = require('./wakeWordTrainingService');
const eventStreamService = require('./eventStreamService');
const caddyAdminService = require('./caddyAdminService');
const reverseProxyService = require('./reverseProxyService');
const oidcService = require('./oidcService');

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
    this.autoRecoverDirtyRepo = process.env.HOMEBRAIN_DEPLOY_AUTO_STASH_DIRTY !== 'false';
    this.restartOllamaOnDeploy = process.env.HOMEBRAIN_DEPLOY_RESTART_OLLAMA !== 'false';
    this.defaultOllamaRestartCommand = process.env.HOMEBRAIN_DEPLOY_OLLAMA_RESTART_CMD
      || 'sudo systemctl restart ollama';
    this.customRestartCommand = process.env.HOMEBRAIN_DEPLOY_RESTART_CMD || '';
    this.coreRestartCommand = process.env.HOMEBRAIN_DEPLOY_CORE_RESTART_CMD
      || 'sudo systemctl daemon-reload || true; sudo systemctl restart homebrain';
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
      autoRecoverDirtyRepo: pickBoolean(options.autoRecoverDirtyRepo, this.autoRecoverDirtyRepo),
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

    const caddyStatus = await caddyAdminService.ping().catch((error) => ({
      reachable: false,
      error: error.message
    }));
    const reverseProxy = {
      status: caddyStatus.reachable ? 'healthy' : 'degraded',
      message: caddyStatus.reachable
        ? 'Caddy admin API is reachable.'
        : `Caddy admin API is unavailable${caddyStatus.error ? `: ${caddyStatus.error}` : '.'}`
    };

    const checks = { api, websocket, database, wakeWordWorker, reverseProxy };
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

  getClientDistPath() {
    return path.join(this.projectRoot, 'client', 'dist');
  }

  async isPathWritable(targetPath, { probeCreate = false } = {}) {
    try {
      await fsp.access(targetPath, fs.constants.W_OK);
    } catch (error) {
      return false;
    }

    if (!probeCreate) {
      return true;
    }

    let stat;
    try {
      stat = await fsp.stat(targetPath);
    } catch (error) {
      return false;
    }

    if (!stat.isDirectory()) {
      return true;
    }

    const probeFile = path.join(
      targetPath,
      `.homebrain-write-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );

    try {
      await fsp.writeFile(probeFile, '');
      await fsp.unlink(probeFile);
      return true;
    } catch (error) {
      return false;
    }
  }

  async ensureWritableClientDist({ jobId = null } = {}) {
    const log = async (message) => {
      if (!jobId) return;
      await this.appendJobLog(
        jobId,
        `[${new Date().toISOString()}] [Ensure client dist permissions] ${message}\n`
      );
    };

    const distPath = this.getClientDistPath();
    if (!fs.existsSync(distPath)) {
      await log('client/dist does not exist yet; skipping permission check.');
      return { checked: false, repaired: false, missing: true };
    }

    const getCheckTargets = () => [distPath, path.join(distPath, 'assets')].filter((value) => fs.existsSync(value));
    const findNonWritable = async () => {
      const paths = [];
      for (const target of getCheckTargets()) {
        if (!(await this.isPathWritable(target, { probeCreate: true }))) {
          paths.push(target);
        }
      }
      return paths;
    };
    const recreateDistDirectory = async () => {
      const quarantineDir = path.join(os.tmpdir(), 'homebrain-dist-quarantine');
      await fsp.mkdir(quarantineDir, { recursive: true });
      const quarantinePath = path.join(
        quarantineDir,
        `dist.quarantine.${new Date().toISOString().replace(/[:.]/g, '-')}`
      );

      await fsp.rename(distPath, quarantinePath);
      await fsp.mkdir(distPath, { recursive: true });
      await log(
        `Replaced non-writable client/dist with a clean directory and quarantined prior contents at ${quarantinePath}.`
      );

      return quarantinePath;
    };

    let nonWritablePaths = await findNonWritable();
    if (nonWritablePaths.length === 0) {
      return { checked: true, repaired: false, missing: false };
    }

    const relativePaths = nonWritablePaths.map((target) => path.relative(this.projectRoot, target) || target);
    await log(`Detected non-writable path(s): ${relativePaths.join(', ')}. Attempting repair.`);

    const repairCommand = 'sudo -n chown -R "$(id -un):$(id -gn)" client/dist && sudo -n chmod -R u+rwX client/dist';
    try {
      await this.runCommand('bash', ['-lc', repairCommand], {
        cwd: this.projectRoot,
        captureStdout: false
      });
    } catch (error) {
      await log(`sudo repair failed (${error.message}). Falling back to dist directory replacement.`);
      try {
        await recreateDistDirectory();
        nonWritablePaths = await findNonWritable();
        if (nonWritablePaths.length === 0) {
          await log('client/dist permissions repaired via directory replacement.');
          return { checked: true, repaired: true, missing: false, replaced: true };
        }
      } catch (replacementError) {
        throw new Error(
          `client/dist is not writable and fallback replacement failed: ${replacementError.message}`
        );
      }

      throw new Error('client/dist remains non-writable after fallback replacement.');
    }

    nonWritablePaths = await findNonWritable();
    if (nonWritablePaths.length > 0) {
      await log('client/dist is still not writable after sudo repair; replacing directory.');
      try {
        await recreateDistDirectory();
      } catch (replacementError) {
        throw new Error(
          `client/dist remains non-writable after repair and replacement failed: ${replacementError.message}`
        );
      }

      nonWritablePaths = await findNonWritable();
      if (nonWritablePaths.length > 0) {
        throw new Error('client/dist remains non-writable after automatic repair and replacement.');
      }

      await log('client/dist permissions repaired via directory replacement.');
      return { checked: true, repaired: true, missing: false, replaced: true };
    }

    await log('client/dist permissions repaired.');
    return { checked: true, repaired: true, missing: false };
  }

  async cleanupClientDistArtifacts({ jobId = null } = {}) {
    const log = async (message) => {
      if (!jobId) return;
      await this.appendJobLog(
        jobId,
        `[${new Date().toISOString()}] [Clean client dist artifacts] ${message}\n`
      );
    };

    await this.ensureWritableClientDist({ jobId });

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
    return filePath.startsWith('client/dist/')
      || filePath.startsWith('client/dist.quarantine.');
  }

  getBlockingDirtyEntries(repoStatus = null) {
    const entries = Array.isArray(repoStatus?.dirtyEntries) ? repoStatus.dirtyEntries : [];
    return entries.filter((entry) => !this.isIgnorableDirtyEntry(entry));
  }

  async autoStashDirtyChanges({ jobId = null, repoStatus = null } = {}) {
    const log = async (message) => {
      if (!jobId) return;
      await this.appendJobLog(
        jobId,
        `[${new Date().toISOString()}] [Auto-stash local changes] ${message}\n`
      );
    };

    let currentStatus = repoStatus || await this.getRepoStatus();
    let blockingEntries = this.getBlockingDirtyEntries(currentStatus);
    const initialDirtyCount = blockingEntries.length;
    if (blockingEntries.length === 0) {
      await log('No blocking dirty entries found; skipping auto-stash.');
      return {
        applied: false,
        dirtyCount: 0,
        stashRef: null
      };
    }

    await log(`Detected ${blockingEntries.length} non-dist local change(s); creating automatic stash backup.`);
    await log(`Dirty entries: ${blockingEntries.slice(0, 40).join(', ')}${blockingEntries.length > 40 ? ' ...' : ''}`);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const stashMessage = `homebrain-auto-stash-${stamp}`;
    const stashResult = await this.runCommand(
      'git',
      this.getSafeGitArgs(['stash', 'push', '-u', '-m', stashMessage])
    );
    const stashOutput = trimStdout(stashResult.stdout || stashResult.stderr || '');
    await log(`git stash output: ${stashOutput || '(no output)'}`);

    let stashRef = null;
    try {
      const latestStash = await this.runCommand(
        'git',
        this.getSafeGitArgs(['stash', 'list', '--max-count=1'])
      );
      const firstLine = (latestStash.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean)[0] || '';
      const match = firstLine.match(/^(stash@\{\d+\})\s*:/);
      stashRef = match ? match[1] : null;
      if (stashRef) {
        await log(`Latest stash reference: ${stashRef}`);
      }
    } catch (error) {
      await log(`WARN: Unable to read stash list after auto-stash: ${error.message}`);
    }

    currentStatus = await this.getRepoStatus();
    blockingEntries = this.getBlockingDirtyEntries(currentStatus);
    if (blockingEntries.length > 0) {
      throw new Error('Repository still has non-dist local changes after automatic stash.');
    }

    return {
      applied: true,
      dirtyCount: initialDirtyCount,
      stashRef
    };
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
      || 'sudo systemctl daemon-reload || true; sudo systemctl restart homebrain';
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
          if (!resolvedOptions.autoRecoverDirtyRepo) {
            const error = new Error(
              'Repository has uncommitted non-dist changes and auto-recovery is disabled. ' +
              'Commit/stash first, enable allowDirty, or enable autoRecoverDirtyRepo.'
            );
            error.code = 'REPO_DIRTY';
            error.repoStatus = {
              ...repoStatus,
              blockingDirtyEntries: blockingAfterCleanup
            };
            throw error;
          }
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
          autoRecoverDirtyRepo: resolvedOptions.autoRecoverDirtyRepo,
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
      await runCustomStep('Ensure client dist permissions', async () => {
        await this.ensureWritableClientDist({ jobId });
      });

      await runCustomStep('Normalize client dist artifacts', async () => {
        await this.cleanupClientDistArtifacts({ jobId });
      });

      let prePullRepoStatus = await this.getRepoStatus();
      const shouldAutoRecoverDirtyRepo = Boolean(job.options?.autoRecoverDirtyRepo) && !Boolean(job.options?.allowDirty);
      if (shouldAutoRecoverDirtyRepo) {
        const blockingPrePullEntries = this.getBlockingDirtyEntries(prePullRepoStatus);
        if (blockingPrePullEntries.length > 0) {
          await runCustomStep('Auto-stash local changes', async () => {
            await this.autoStashDirtyChanges({
              jobId,
              repoStatus: prePullRepoStatus
            });
          });
          prePullRepoStatus = await this.getRepoStatus();
        }
      }

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

      await runNpmStep('Ensure server native modules', ['run', 'ensure:native', '--prefix', 'server']);

      if (job.options.runClientLint) {
        await runNpmStep('Run client lint', ['run', 'lint', '--prefix', 'client', '--', '--max-warnings=0']);
      }

      await runNpmStep('Build client', ['run', 'build', '--prefix', 'client']);

      if (job.options.runServerTests) {
        await runNpmStep('Run server tests', ['test', '--prefix', 'server']);
      }

      await runCustomStep('Bootstrap reverse proxy state', async () => {
        const bootstrapSummary = await reverseProxyService.ensureBootstrapState({
          actor: `platform-deploy:${job.actor || 'unknown'}`,
          seedDefaultRoutes: true,
          validateExistingRoutes: true
        });

        await this.appendJobLog(
          jobId,
          `[${new Date().toISOString()}] [Bootstrap reverse proxy state] `
          + `settingsUpdated=${bootstrapSummary.settingsUpdated.join(',') || 'none'} `
          + `createdRoutes=${bootstrapSummary.createdRoutes.join(',') || 'none'} `
          + `revalidatedRoutes=${bootstrapSummary.revalidatedRoutes.join(',') || 'none'}\n`
        );
      });

      await runCustomStep('Bootstrap identity state', async () => {
        const bootstrapSummary = await oidcService.ensureBootstrapState({
          actor: `platform-deploy:${job.actor || 'unknown'}`
        });

        await this.appendJobLog(
          jobId,
          `[${new Date().toISOString()}] [Bootstrap identity state] `
          + `settingsUpdated=${bootstrapSummary.settingsUpdated.join(',') || 'none'} `
          + `createdClients=${bootstrapSummary.createdClients.join(',') || 'none'} `
          + `updatedClients=${bootstrapSummary.updatedClients.join(',') || 'none'}\n`
        );
      });

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

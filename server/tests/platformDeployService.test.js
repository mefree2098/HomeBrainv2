const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const platformDeployServiceModule = require('../services/platformDeployService');
const eventStreamService = require('../services/eventStreamService');

const { PlatformDeployService } = platformDeployServiceModule;

function createRepoStatus(commit, shortCommit = commit.slice(0, 7)) {
  return {
    branch: 'main',
    commit,
    shortCommit,
    remote: 'origin',
    upstream: 'origin/main',
    dirty: false,
    dirtyEntries: [],
    ignoredDirtyEntries: [],
    rawDirtyEntries: [],
    ahead: 0,
    behind: 0,
    projectRoot: '/tmp/homebrain-test'
  };
}

function createRunningJob(jobId, repoStatus) {
  return {
    id: jobId,
    actor: 'admin@homebrain.test',
    status: 'running',
    currentStep: 'Restart services',
    steps: [
      {
        name: 'Restart services',
        status: 'running',
        updatedAt: '2026-03-23T12:00:00.000Z'
      }
    ],
    options: {
      preset: 'safe',
      allowDirty: false,
      autoRecoverDirtyRepo: true,
      installDependencies: true,
      runServerTests: true,
      runClientLint: false,
      restartServices: true
    },
    createdAt: '2026-03-23T12:00:00.000Z',
    updatedAt: '2026-03-23T12:00:00.000Z',
    startedAt: '2026-03-23T12:00:00.000Z',
    completedAt: null,
    error: null,
    repoBefore: repoStatus,
    repoAfter: repoStatus
  };
}

function createRunningInstallJob(jobId, repoStatus) {
  return {
    ...createRunningJob(jobId, repoStatus),
    currentStep: 'Install root dependencies',
    steps: [
      {
        name: 'Install root dependencies',
        status: 'running',
        updatedAt: '2026-03-23T12:00:00.000Z'
      }
    ],
    createdAt: '2026-03-23T11:58:00.000Z',
    updatedAt: '2026-03-23T12:00:00.000Z',
    startedAt: '2026-03-23T11:58:00.000Z',
    repoAfter: null
  };
}

async function createTempService(t, options = {}) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'homebrain-platform-deploy-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  const alexaBrokerService = options.alexaBrokerService || {
    prepareForHostRestart: async () => ({ success: true, shouldResume: false })
  };

  return new PlatformDeployService({
    projectRoot: tempRoot,
    dataDir: path.join(tempRoot, 'deploy-data'),
    runtimeStartedAt: '2026-03-23T12:00:00.000Z',
    runtimePid: 4242,
    alexaBrokerService,
    ...options
  });
}

test('triggerServiceRestart persists expected backend commit before restart handoff', { concurrency: false }, async (t) => {
  const publishedEvents = [];
  const originalPublishSafe = eventStreamService.publishSafe;
  eventStreamService.publishSafe = async (payload) => {
    publishedEvents.push(payload);
  };

  t.after(() => {
    eventStreamService.publishSafe = originalPublishSafe;
  });

  const spawnCalls = [];
  let prepareCalls = 0;
  const service = await createTempService(t, {
    alexaBrokerService: {
      prepareForHostRestart: async () => {
        prepareCalls += 1;
        return { success: true, shouldResume: true };
      }
    },
    spawnProcess: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter();
      child.pid = 9876;
      child.unref = () => {};
      process.nextTick(() => child.emit('spawn'));
      return child;
    }
  });

  const repoStatus = createRepoStatus('abcdef0123456789', 'abcdef0');
  service.getRepoStatus = async () => repoStatus;

  const pendingRestart = await service.triggerServiceRestart('job-1', {
    actor: 'admin@homebrain.test',
    source: 'deploy',
    repoStatus
  });

  const persistedRestart = await service.readPendingRestart();
  const { fullCommand } = service.buildServiceRestartCommand();

  assert.equal(pendingRestart.expectedCommit, repoStatus.commit);
  assert.equal(persistedRestart.expectedShortCommit, repoStatus.shortCommit);
  assert.equal(persistedRestart.jobId, 'job-1');
  assert.equal(persistedRestart.actor, 'admin@homebrain.test');
  assert.equal(persistedRestart.command, fullCommand);
  assert.equal(prepareCalls, 1);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'bash');
  assert.deepEqual(spawnCalls[0].args, ['-lc', fullCommand]);
  assert.equal(
    publishedEvents.some((event) => event.type === 'deploy.services_restart_triggered'),
    true
  );
});

test('finalizePendingRestart completes the deploy after the new backend boots the expected commit', { concurrency: false }, async (t) => {
  const publishedEvents = [];
  const originalPublishSafe = eventStreamService.publishSafe;
  eventStreamService.publishSafe = async (payload) => {
    publishedEvents.push(payload);
  };

  t.after(() => {
    eventStreamService.publishSafe = originalPublishSafe;
  });

  const service = await createTempService(t);
  const repoStatus = createRepoStatus('fedcba9876543210', 'fedcba9');
  const jobId = 'job-2';

  await service.writeJob(createRunningJob(jobId, repoStatus));
  await service.writePendingRestart({
    jobId,
    actor: 'admin@homebrain.test',
    source: 'deploy',
    requestedAt: '2026-03-23T12:01:00.000Z',
    expectedCommit: repoStatus.commit,
    expectedShortCommit: repoStatus.shortCommit,
    command: 'sudo systemctl restart homebrain'
  });

  service.getRepoStatus = async () => repoStatus;
  service.getRuntimeInfo = async () => ({
    pid: 5252,
    bootedAt: '2026-03-23T12:02:00.000Z',
    uptimeSeconds: 6,
    loadedBranch: 'main',
    loadedCommit: repoStatus.commit,
    loadedShortCommit: repoStatus.shortCommit,
    repoMatchesRuntime: true
  });

  const result = await service.finalizePendingRestart();
  const updatedJob = await service.readJob(jobId);

  assert.equal(result.finalized, true);
  assert.equal(result.success, true);
  assert.equal(updatedJob.status, 'completed');
  assert.equal(updatedJob.currentStep, 'completed');
  assert.notEqual(updatedJob.completedAt, null);
  assert.equal(updatedJob.steps.find((step) => step.name === 'Restart services')?.status, 'completed');
  assert.equal(await service.readPendingRestart(), null);
  assert.equal(
    publishedEvents.some((event) => event.type === 'deploy.completed'),
    true
  );
});

test('finalizePendingRestart waits until a newer runtime boots before resolving the pending restart', { concurrency: false }, async (t) => {
  const service = await createTempService(t);
  const repoStatus = createRepoStatus('fedcba9876543210', 'fedcba9');
  const oldRepoStatus = createRepoStatus('1234567890abcdef', '1234567');
  const jobId = 'job-3';

  await service.writeJob(createRunningJob(jobId, repoStatus));
  await service.writePendingRestart({
    jobId,
    actor: 'admin@homebrain.test',
    source: 'deploy',
    requestedAt: '2026-03-23T12:01:00.000Z',
    expectedCommit: repoStatus.commit,
    expectedShortCommit: repoStatus.shortCommit,
    command: 'sudo -n systemctl restart homebrain'
  });

  service.getRepoStatus = async () => repoStatus;
  service.getRuntimeInfo = async () => ({
    pid: 4242,
    bootedAt: '2026-03-23T12:00:00.000Z',
    uptimeSeconds: 120,
    loadedBranch: 'main',
    loadedCommit: oldRepoStatus.commit,
    loadedShortCommit: oldRepoStatus.shortCommit,
    repoMatchesRuntime: false
  });

  const result = await service.finalizePendingRestart();
  const updatedJob = await service.readJob(jobId);
  const persistedRestart = await service.readPendingRestart();

  assert.equal(result.finalized, false);
  assert.equal(result.waitingForRuntime, true);
  assert.equal(updatedJob.status, 'running');
  assert.equal(updatedJob.currentStep, 'Restart services');
  assert.equal(updatedJob.steps.find((step) => step.name === 'Restart services')?.status, 'running');
  assert.equal(persistedRestart?.expectedCommit, repoStatus.commit);
});

test('getLatestJob reconciles a stale running restart step as completed when runtime already matches the deployed commit', { concurrency: false }, async (t) => {
  const publishedEvents = [];
  const originalPublishSafe = eventStreamService.publishSafe;
  eventStreamService.publishSafe = async (payload) => {
    publishedEvents.push(payload);
  };

  t.after(() => {
    eventStreamService.publishSafe = originalPublishSafe;
  });

  const service = await createTempService(t);
  const repoStatus = createRepoStatus('fedcba9876543210', 'fedcba9');
  const jobId = 'job-4';

  await service.writeJob(createRunningJob(jobId, repoStatus));
  await service.writeLatestJobRef(jobId);

  service.getRepoStatus = async () => repoStatus;
  service.getRuntimeInfo = async () => ({
    pid: 5252,
    bootedAt: '2026-03-23T12:02:00.000Z',
    uptimeSeconds: 6,
    loadedBranch: 'main',
    loadedCommit: repoStatus.commit,
    loadedShortCommit: repoStatus.shortCommit,
    repoMatchesRuntime: true
  });

  const latest = await service.getLatestJob();

  assert.equal(latest.status, 'completed');
  assert.equal(latest.currentStep, 'completed');
  assert.equal(latest.steps.find((step) => step.name === 'Restart services')?.status, 'completed');
  assert.equal(await service.readPendingRestart(), null);
  assert.equal(
    publishedEvents.some((event) => event.type === 'deploy.completed'),
    true
  );
});

test('getLatestJob reconciles a stale running restart step as failed when runtime was superseded externally', { concurrency: false }, async (t) => {
  const publishedEvents = [];
  const originalPublishSafe = eventStreamService.publishSafe;
  eventStreamService.publishSafe = async (payload) => {
    publishedEvents.push(payload);
  };

  t.after(() => {
    eventStreamService.publishSafe = originalPublishSafe;
  });

  const service = await createTempService(t);
  const deployedRepoStatus = createRepoStatus('fedcba9876543210', 'fedcba9');
  const currentRepoStatus = createRepoStatus('0123456789abcdef', '0123456');
  const jobId = 'job-5';

  await service.writeJob(createRunningJob(jobId, deployedRepoStatus));
  await service.writeLatestJobRef(jobId);

  service.getRepoStatus = async () => currentRepoStatus;
  service.getRuntimeInfo = async () => ({
    pid: 6262,
    bootedAt: '2026-03-23T12:05:00.000Z',
    uptimeSeconds: 6,
    loadedBranch: 'main',
    loadedCommit: currentRepoStatus.commit,
    loadedShortCommit: currentRepoStatus.shortCommit,
    repoMatchesRuntime: true
  });

  const latest = await service.getLatestJob();

  assert.equal(latest.status, 'failed');
  assert.equal(latest.currentStep, 'failed');
  assert.match(latest.error, /running backend is 0123456 instead of expected fedcba9/i);
  assert.equal(
    publishedEvents.some((event) => event.type === 'deploy.failed'),
    true
  );
});

test('getLatestJob fails an abandoned non-restart step after the backend restarted without completing it', { concurrency: false }, async (t) => {
  const publishedEvents = [];
  const originalPublishSafe = eventStreamService.publishSafe;
  eventStreamService.publishSafe = async (payload) => {
    publishedEvents.push(payload);
  };

  t.after(() => {
    eventStreamService.publishSafe = originalPublishSafe;
  });

  const service = await createTempService(t);
  const repoStatus = createRepoStatus('fedcba9876543210', 'fedcba9');
  const jobId = 'job-install-abandoned';

  await service.writeJob(createRunningInstallJob(jobId, repoStatus));
  await service.writeLatestJobRef(jobId);

  service.getRepoStatus = async () => repoStatus;
  service.getRuntimeInfo = async () => ({
    pid: 6262,
    bootedAt: '2026-03-23T12:20:00.000Z',
    uptimeSeconds: 6,
    loadedBranch: 'main',
    loadedCommit: repoStatus.commit,
    loadedShortCommit: repoStatus.shortCommit,
    repoMatchesRuntime: true
  });

  const latest = await service.getLatestJob();

  assert.equal(latest.status, 'failed');
  assert.equal(latest.currentStep, 'failed');
  assert.match(latest.error, /interrupted while "Install root dependencies" was running/i);
  assert.equal(latest.steps.find((step) => step.name === 'Install root dependencies')?.status, 'failed');
  assert.equal(
    publishedEvents.some((event) => event.type === 'deploy.failed'),
    true
  );
});

test('ensureWritableDependencyArtifacts repairs existing node_modules trees before npm install', { concurrency: false }, async (t) => {
  const service = await createTempService(t);
  await fsp.mkdir(path.join(service.projectRoot, 'node_modules', '.bin'), { recursive: true });
  await fsp.mkdir(path.join(service.projectRoot, 'client', 'node_modules'), { recursive: true });

  const commands = [];
  let writable = false;
  service.isPathWritable = async () => writable;
  service.runCommand = async (command, args) => {
    commands.push({ command, args });
    if (command === 'id' && args[0] === '-un') {
      return { stdout: 'matt', stderr: '' };
    }
    if (command === 'id' && args[0] === '-gn') {
      return { stdout: 'staff', stderr: '' };
    }
    if (command === 'sudo' && args[1] === 'chmod') {
      writable = true;
    }
    return { stdout: '', stderr: '' };
  };

  const result = await service.ensureWritableDependencyArtifacts();
  const chownCall = commands.find((call) => call.command === 'sudo' && call.args[1] === 'chown');
  const chmodCall = commands.find((call) => call.command === 'sudo' && call.args[1] === 'chmod');

  assert.equal(result.repaired, true);
  assert.deepEqual(chownCall?.args.slice(0, 4), ['-n', 'chown', '-R', 'matt:staff']);
  assert.equal(chownCall?.args.includes('node_modules'), true);
  assert.equal(chownCall?.args.includes(path.join('client', 'node_modules')), true);
  assert.equal(chmodCall?.args.includes('u+rwX'), true);
});

test('buildServiceRestartCommand removes invalid sudo fragments and forces non-interactive sudo', { concurrency: false }, async (t) => {
  const service = await createTempService(t);
  service.restartOllamaOnDeploy = true;
  service.defaultOllamaRestartCommand = 'sudo systemctl restart ollama';
  service.customRestartCommand = 'sudo; sudo systemctl daemon-reload';
  service.coreRestartCommand = 'sudo; sudo systemctl start homebrain-restart-helper';

  const result = service.buildServiceRestartCommand();

  assert.equal(result.fullCommand.includes('sudo;'), false);
  assert.equal(result.fullCommand.includes('sudo -n systemctl restart --no-block ollama || true'), true);
  assert.equal(result.fullCommand.includes('sudo -n systemctl daemon-reload'), true);
  assert.equal(result.fullCommand.includes('sudo -n systemctl start --no-block homebrain-restart-helper'), true);
  assert.equal(
    result.notes.some((note) => /does not include a command/i.test(note)),
    true
  );
});

test('buildServiceRestartCommand does not revive the host Ollama service by default', { concurrency: false }, async (t) => {
  const originalRestartOllama = process.env.HOMEBRAIN_DEPLOY_RESTART_OLLAMA;
  const originalOllamaRestartCommand = process.env.HOMEBRAIN_DEPLOY_OLLAMA_RESTART_CMD;

  delete process.env.HOMEBRAIN_DEPLOY_RESTART_OLLAMA;
  delete process.env.HOMEBRAIN_DEPLOY_OLLAMA_RESTART_CMD;

  t.after(() => {
    if (originalRestartOllama === undefined) {
      delete process.env.HOMEBRAIN_DEPLOY_RESTART_OLLAMA;
    } else {
      process.env.HOMEBRAIN_DEPLOY_RESTART_OLLAMA = originalRestartOllama;
    }

    if (originalOllamaRestartCommand === undefined) {
      delete process.env.HOMEBRAIN_DEPLOY_OLLAMA_RESTART_CMD;
    } else {
      process.env.HOMEBRAIN_DEPLOY_OLLAMA_RESTART_CMD = originalOllamaRestartCommand;
    }
  });

  const service = await createTempService(t);

  const result = service.buildServiceRestartCommand();

  assert.equal(service.restartOllamaOnDeploy, false);
  assert.equal(result.fullCommand.includes('ollama'), false);
});

test('buildServiceRestartCommand routes direct HomeBrain restarts through the restart helper', { concurrency: false }, async (t) => {
  const service = await createTempService(t);
  service.coreRestartCommand = [
    'sudo -n systemctl daemon-reload || true',
    'sudo -n systemctl restart --no-block homebrain-discovery || true',
    'sudo -n systemctl restart --no-block homebrain'
  ].join('; ');

  const result = service.buildServiceRestartCommand();

  assert.equal(result.fullCommand.includes('sudo -n systemctl restart --no-block homebrain;'), false);
  assert.equal(result.fullCommand.endsWith('sudo -n systemctl restart --no-block homebrain'), false);
  assert.equal(result.fullCommand.includes('homebrain-discovery'), false);
  assert.equal(result.fullCommand.includes('sudo -n systemctl start --no-block homebrain-restart-helper'), true);
  assert.equal(
    result.notes.some((note) => /orphaned HomeBrain Node processes/i.test(note)),
    true
  );
  assert.equal(
    result.notes.some((note) => /legacy homebrain-discovery/i.test(note)),
    true
  );
});

test('buildServiceRestartCommand drops stale custom legacy discovery restarts', { concurrency: false }, async (t) => {
  const service = await createTempService(t);
  service.customRestartCommand = 'sudo systemctl try-restart homebrain-discovery';

  const result = service.buildServiceRestartCommand();

  assert.equal(result.fullCommand.includes('homebrain-discovery'), false);
  assert.equal(result.fullCommand.includes('homebrain-restart-helper'), true);
  assert.equal(
    result.notes.some((note) => /discovery now runs inside the main HomeBrain service/i.test(note)),
    true
  );
});

test('buildServiceRestartCommand falls back when core restart only targets legacy discovery', { concurrency: false }, async (t) => {
  const service = await createTempService(t);
  service.coreRestartCommand = 'sudo systemctl restart homebrain-discovery';

  const result = service.buildServiceRestartCommand();

  assert.equal(result.fullCommand.includes('homebrain-discovery'), false);
  assert.equal(result.fullCommand.includes('sudo -n systemctl daemon-reload'), true);
  assert.equal(result.fullCommand.includes('sudo -n systemctl start --no-block homebrain-restart-helper'), true);
  assert.equal(
    result.notes.some((note) => /configured core restart only targeted legacy services/i.test(note)),
    true
  );
});

test('normalizeRestartCommandSegments adds --no-block to systemctl start and restart commands', { concurrency: false }, async (t) => {
  const service = await createTempService(t);

  const result = service.normalizeRestartCommandSegments(
    'sudo systemctl restart homebrain; sudo systemctl start ollama; sudo systemctl try-restart homebrain-discovery',
    'test restart command'
  );

  assert.deepEqual(result.segments, [
    'sudo -n systemctl restart --no-block homebrain',
    'sudo -n systemctl start --no-block ollama',
    'sudo -n systemctl try-restart --no-block homebrain-discovery'
  ]);
});

test('installServiceHelpers runs setup-services install-service with non-interactive sudo when the helper script exists', { concurrency: false }, async (t) => {
  const service = await createTempService(t);
  const scriptsDir = path.join(service.projectRoot, 'scripts');
  const setupServicesPath = path.join(scriptsDir, 'setup-services.sh');

  await fsp.mkdir(scriptsDir, { recursive: true });
  await fsp.writeFile(setupServicesPath, '#!/usr/bin/env bash\n', 'utf8');

  let call = null;
  service.runCommand = async (command, args) => {
    call = { command, args };
    return { code: 0, stdout: '', stderr: '' };
  };
  service.appendJobLog = async () => {};

  const result = await service.installServiceHelpers('job-helpers');

  assert.deepEqual(result, { skipped: false });
  assert.deepEqual(call, {
    command: 'sudo',
    args: ['-n', '/bin/bash', setupServicesPath, 'install-service']
  });
});

test('setup-services keeps HomeBrain-managed child services alive across restarts', async () => {
  const setupServicesPath = path.resolve(__dirname, '..', '..', 'scripts', 'setup-services.sh');
  const script = await fsp.readFile(setupServicesPath, 'utf8');
  const serviceUnitStart = script.indexOf('Description=HomeBrain Smart Home Hub');
  const serviceUnitEnd = script.indexOf('[Install]', serviceUnitStart);
  const serviceUnit = script.slice(serviceUnitStart, serviceUnitEnd);

  assert.match(serviceUnit, /Environment=HOMEBRAIN_BOOTSTRAP_NODE_BIN=\$\{node_bin\}/);
  assert.match(serviceUnit, /ExecStart=\$\{HOMEBRAIN_DIR\}\/scripts\/run-homebrain-server-with-modern-node\.sh/);
  assert.doesNotMatch(serviceUnit, /ExecStart=.*run-with-modern-node\.js node server\/server\.js/);
  assert.match(serviceUnit, /KillMode=process/);
  assert.doesNotMatch(serviceUnit, /KillMode=mixed/);
});

test('setup-services installs a MongoDB WiredTiger cache guard for Jetson hosts', async () => {
  const setupServicesPath = path.resolve(__dirname, '..', '..', 'scripts', 'setup-services.sh');
  const script = await fsp.readFile(setupServicesPath, 'utf8');

  assert.match(script, /MONGODB_RESOURCE_GUARD_PATH/);
  assert.match(script, /--wiredTigerCacheSizeGB/);
  assert.match(script, /HOMEBRAIN_MONGODB_WIREDTIGER_CACHE_GB/);
  assert.match(script, /configure_mongodb_resource_guard/);
});

test('installServiceHelpers skips when helper installation lacks passwordless sudo', { concurrency: false }, async (t) => {
  const service = await createTempService(t);
  const scriptsDir = path.join(service.projectRoot, 'scripts');
  const setupServicesPath = path.join(scriptsDir, 'setup-services.sh');
  const logs = [];

  await fsp.mkdir(scriptsDir, { recursive: true });
  await fsp.writeFile(setupServicesPath, '#!/usr/bin/env bash\n', 'utf8');

  service.appendJobLog = async (_jobId, text) => {
    logs.push(text);
  };
  service.runCommand = async () => {
    const error = new Error('Command failed (sudo -n /bin/bash scripts/setup-services.sh install-service): sudo: a password is required');
    error.stderr = 'sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\nsudo: a password is required';
    throw error;
  };

  const result = await service.installServiceHelpers('job-helpers');

  assert.deepEqual(result, { skipped: true, reason: 'sudo-not-configured' });
  assert.equal(
    logs.some((entry) => entry.includes('Skipped because passwordless sudo for helper installation is not configured on this host yet')),
    true
  );
});

test('isIgnorableDirtyEntry treats OTA artifacts as generated output', { concurrency: false }, async (t) => {
  const service = await createTempService(t);

  assert.equal(service.isIgnorableDirtyEntry('?? server/data/wall-panel-ota/'), true);
  assert.equal(service.isIgnorableDirtyEntry('?? client/dist/asset.js'), true);
  assert.equal(service.isIgnorableDirtyEntry('?? server/src/index.js'), false);
});

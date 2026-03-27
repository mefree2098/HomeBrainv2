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

async function createTempService(t, options = {}) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'homebrain-platform-deploy-'));
  t.after(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  return new PlatformDeployService({
    projectRoot: tempRoot,
    dataDir: path.join(tempRoot, 'deploy-data'),
    runtimeStartedAt: '2026-03-23T12:00:00.000Z',
    runtimePid: 4242,
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
  const service = await createTempService(t, {
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

test('buildServiceRestartCommand removes invalid sudo fragments and forces non-interactive sudo', { concurrency: false }, async (t) => {
  const service = await createTempService(t);
  service.restartOllamaOnDeploy = true;
  service.defaultOllamaRestartCommand = 'sudo systemctl restart ollama';
  service.customRestartCommand = 'sudo; sudo systemctl daemon-reload';
  service.coreRestartCommand = 'sudo; sudo systemctl restart homebrain';

  const result = service.buildServiceRestartCommand();

  assert.equal(result.fullCommand.includes('sudo;'), false);
  assert.equal(result.fullCommand.includes('sudo -n systemctl restart ollama || true'), true);
  assert.equal(result.fullCommand.includes('sudo -n systemctl daemon-reload'), true);
  assert.equal(result.fullCommand.includes('sudo -n systemctl restart homebrain'), true);
  assert.equal(
    result.notes.some((note) => /does not include a command/i.test(note)),
    true
  );
});

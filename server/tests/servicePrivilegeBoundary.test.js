const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { PlatformDeployService } = require('../services/platformDeployService');
const { SystemBackupService } = require('../services/systemBackupService');
const { DeviceRestartService } = require('../services/deviceRestartService');
const ollamaService = require('../services/ollamaService');
const matterService = require('../services/matterService');

async function hardened(t, handler = () => ({ ok: true, code: 0, stdout: '', stderr: '' })) {
  const old = { hardened: process.env.HOMEBRAIN_HARDENED_SERVICE, socket: process.env.HOMEBRAIN_HOST_CONTROL_SOCKET };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-priv-'));
  const socketPath = path.join(dir, 'host.sock');
  const actions = [];
  const server = net.createServer((client) => client.once('data', (data) => {
    const { action } = JSON.parse(data);
    actions.push(action);
    client.end(`${JSON.stringify(handler(action))}\n`);
  }));
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
  process.env.HOMEBRAIN_HARDENED_SERVICE = '1';
  process.env.HOMEBRAIN_HOST_CONTROL_SOCKET = socketPath;
  t.after(async () => {
    if (old.hardened === undefined) delete process.env.HOMEBRAIN_HARDENED_SERVICE;
    else process.env.HOMEBRAIN_HARDENED_SERVICE = old.hardened;
    if (old.socket === undefined) delete process.env.HOMEBRAIN_HOST_CONTROL_SOCKET;
    else process.env.HOMEBRAIN_HOST_CONTROL_SOCKET = old.socket;
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return actions;
}

test('hardened deploy retains administrator-owned helpers and uses a fixed restart action', { concurrency: false }, async (t) => {
  const actions = await hardened(t);
  const service = new PlatformDeployService();
  service.appendJobLog = async () => {};
  service.runCommand = async () => assert.fail('Deployment elevated or provisioned host software');
  service.customRestartCommand = 'sudo bash /tmp/untrusted.sh';
  service.coreRestartCommand = 'sudo systemctl restart ssh';
  assert.deepEqual(await service.installServiceHelpers('fixture'), { skipped: true, reason: 'administrator-managed' });
  assert.deepEqual(await service.provisionPlatformServices('fixture'), { skipped: true, reason: 'administrator-managed' });
  assert.deepEqual(actions, ['probe']);
  const restart = service.buildServiceRestartCommand().fullCommand;
  assert.match(restart, /homebrain-host-control\.js' 'restart'/);
  assert.doesNotMatch(restart, /sudo|systemctl|untrusted|ssh/);
});

test('restore and restart request only fixed socket operations', { concurrency: false }, async (t) => {
  const actions = await hardened(t);
  const service = new SystemBackupService();
  service.runCommand = service.spawnDetached = async () => assert.fail('Restore used legacy privilege or detached fallback');
  assert.equal((await service.launchRestoreHelper()).launchStrategy, 'systemd-service');
  await service.queueServiceRestart();
  assert.deepEqual(actions, ['restore', 'restart']);
});

test('denied restore cannot fall back to a legacy helper', { concurrency: false }, async (t) => {
  await hardened(t, () => ({ ok: false, code: 64, stderr: 'Host operation denied' }));
  const service = new SystemBackupService();
  service.spawnDetached = async () => assert.fail('Detached fallback bypassed denied operation');
  await assert.rejects(service.launchRestoreHelper(), /denied/);
});

test('hardened reboot denial happens before recording or dispatching a request', { concurrency: false }, async (t) => {
  const actions = await hardened(t);
  const service = new DeviceRestartService({
    settingsModel: { getSettings: async () => assert.fail('Recorded forbidden reboot') },
    spawnProcess: () => assert.fail('Spawned forbidden reboot')
  });
  for (const run of [() => service.requestManualReboot(), () => service.handleScheduledReboot(new Date()), () => service.dispatchRebootCommand()]) {
    await assert.rejects(run(), { code: 'HOST_ADMINISTRATOR_REQUIRED' });
  }
  assert.deepEqual(actions, []);
});

test('software installation and kernel/provisioning operations require SSH administration', { concurrency: false }, async (t) => {
  const actions = await hardened(t);
  for (const run of [() => ollamaService.install(), () => ollamaService.update(), () => matterService.startThreadKernelRebuild(), () => matterService.startThreadBorderRouter()]) {
    await assert.rejects(run(), { code: 'HOST_ADMINISTRATOR_REQUIRED' });
  }
  assert.deepEqual(actions, []);
});

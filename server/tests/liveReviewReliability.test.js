const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SystemBackupService } = require('../services/systemBackupService');
const { computeNextSmbBackupRunAt } = require('../services/smbBackupSchedulerService');
const { summarizeOperationalHealth } = require('../services/operationalHealthService');
const Device = require('../models/Device');
const deviceService = require('../services/deviceService');
const { executeActionSequence } = require('../services/workflowExecutionService');

test('uncertain relative device actions execute once even with explicit retry settings', async (t) => {
  const id = '507f191e810c19729de860ea';
  t.mock.method(Device, 'findById', () => ({ lean: async () => ({ _id: id, name: 'Speaker', type: 'speaker', properties: { source: 'smartthings' } }) }));
  let attempts = 0;
  t.mock.method(deviceService, 'controlDevice', async () => { attempts += 1; throw new Error('Uncertain network timeout'); });
  for (const action of ['toggle', 'volume_up', 'harmony_command']) {
    attempts = 0;
    const result = await executeActionSequence([{ type: 'device_control', target: id, parameters: { action, value: 'VolumeUp', workflowRetryCount: 3, workflowRetryDelayMs: 1 } }]);
    assert.equal(result.status, 'failed');
    assert.equal(attempts, 1, action);
    assert.equal(result.actionResults[0].details.requiresReconciliation, true);
  }
});

test('a completed empty checkpoint finishes without replaying physical actions after restart', async (t) => {
  const Automation = require('../models/Automation');
  const History = require('../models/AutomationHistory');
  const runtime = require('../services/automationRuntimeService');
  const service = require('../services/automationService');
  const history = {
    _id: '507f191e810c19729de860ea', status: 'running', totalActions: 1,
    actionResults: [{ success: true }], resumeState: { pendingActions: [] },
    async markCompleted(status) { this.status = status; }, toObject() { return { status: this.status }; }
  };
  const automation = { _id: '507f191e810c19729de860eb', name: 'Already finished', enabled: true, actions: [{ type: 'device_control', target: '507f191e810c19729de860ec', parameters: { action: 'toggle' } }], async save() {}, toObject() { return {}; } };
  t.mock.method(Automation, 'findById', async () => automation);
  t.mock.method(History, 'findById', async () => history);
  for (const name of ['recordExecutionCompleted', 'recordActionStarted', 'recordActionCompleted']) t.mock.method(runtime, name, async () => {});
  let commands = 0;
  t.mock.method(deviceService, 'controlDevice', async () => { commands += 1; });
  const result = await service.executeAutomation(automation._id, { resumeHistory: history });
  assert.equal(result.success, true);
  assert.equal(history.status, 'success');
  assert.equal(commands, 0);
  history.status = 'running'; history.resumeState = null;
  await assert.rejects(service.executeAutomation(automation._id, { resumeHistory: history }), /Cannot safely resume/);
  assert.equal(history.status, 'failed');
  assert.equal(commands, 0);
});

test('local scheduled backups run without an SMB share and retain only verified archive names', async (t) => {
  assert.ok(computeNextSmbBackupRunAt({ backupDestination: 'local', smbBackupScheduleEnabled: true, smbBackupScheduleTime: '02:30', timezone: 'America/Denver' }, new Date('2026-11-09T10:00:00Z')));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-local-backups-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const service = new SystemBackupService({ backupRoot: path.join(dir, 'backups') });
  const source = path.join(dir, 'input');
  await fs.writeFile(source, 'verified backup bytes');
  for (const day of ['07', '08', '09']) await service.saveLocalArchive(source, `homebrain-backup-2026-11-${day}T00-00-00Z.tar.gz`);
  const localDir = path.join(dir, 'backups/local');
  await fs.writeFile(path.join(localDir, 'keep-this.txt'), 'unrelated');
  const result = await service.pruneLocalBackups(2);
  assert.deepEqual(result.deleted, ['homebrain-backup-2026-11-07T00-00-00Z.tar.gz']);
  assert.equal(await fs.readFile(path.join(localDir, result.kept[0]), 'utf8'), 'verified backup bytes');
  assert.equal((await fs.stat(path.join(localDir, result.kept[0]))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(localDir, 'keep-this.txt'), 'utf8'), 'unrelated');
  await assert.rejects(service.saveLocalArchive(source, '../outside.tar.gz'), /Invalid backup/);
});

test('health distinguishes a running platform from device, enrollment, automation and backup readiness', () => {
  const now = Date.parse('2026-11-09T20:00:00Z');
  const health = summarizeOperationalHealth([
    { _id: 'light', name: 'Offline light', isOnline: false },
    { _id: 'motion', name: 'Motion', isOnline: true, properties: { homebrainDirect: { iasZone: { enrolled: false, cieMatchesCoordinator: true } } } }
  ], 3, [{ provider: 'midea', enabled: true, configured: true, connected: false }], {}, now);
  for (const check of Object.values(health)) assert.equal(check.status, 'degraded');
  assert.equal(health.devices.offlineCount, 1);
  assert.equal(health.enrollment.affectedDevices[0].name, 'Motion');
  assert.equal(health.automations.failedExecutions, 3);
});

test('appliance recovery resolves legacy alerts and recurring failures use one stable active key', async (t) => {
  const service = require('../services/applianceService');
  const notifications = require('../services/notificationService');
  const Notification = require('../models/HomeBrainNotification');
  const resolved = [];
  const created = [];
  t.mock.method(Device, 'findOne', () => ({ lean: async () => ({ isOnline: false, properties: {} }) }));
  t.mock.method(Device, 'findOneAndUpdate', async () => ({ _id: 'heater', name: 'Water Heater' }));
  t.mock.method(Notification, 'updateMany', async (query) => { resolved.push(query); });
  t.mock.method(notifications, 'createSystemNotification', async (input) => { created.push(input); });
  await service.persistStates('econet', [{ id: '123', online: true }], {});
  assert.equal(resolved[0].eventKey.$ne, '');
  assert.equal(created.length, 0);
  await service.persistStates('econet', [{ id: '123', online: false }], {});
  await service.persistStates('econet', [{ id: '123', online: false }], {});
  assert.deepEqual(created.map((input) => input.eventKey), ['appliance:econet:123:offline', 'appliance:econet:123:offline']);
});

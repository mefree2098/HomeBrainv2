const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  DeviceRestartService,
  computeNextRestartRunAt
} = require('../services/deviceRestartService');

test('computeNextRestartRunAt schedules weekly restarts in the configured timezone', () => {
  const nextRunAt = computeNextRestartRunAt({
    deviceRestartScheduleEnabled: true,
    deviceRestartScheduleFrequency: 'weekly',
    deviceRestartScheduleDayOfWeek: 0,
    deviceRestartScheduleTime: '03:00',
    timezone: 'America/Denver'
  }, new Date('2026-04-27T15:00:00.000Z'));

  assert.equal(nextRunAt.toISOString(), '2026-05-03T09:00:00.000Z');
});

test('computeNextRestartRunAt keeps daily restarts on the next local occurrence', () => {
  const beforeTodayRun = computeNextRestartRunAt({
    deviceRestartScheduleEnabled: true,
    deviceRestartScheduleFrequency: 'daily',
    deviceRestartScheduleTime: '03:00',
    timezone: 'America/Denver'
  }, new Date('2026-04-27T08:30:00.000Z'));

  const afterTodayRun = computeNextRestartRunAt({
    deviceRestartScheduleEnabled: true,
    deviceRestartScheduleFrequency: 'daily',
    deviceRestartScheduleTime: '03:00',
    timezone: 'America/Denver'
  }, new Date('2026-04-27T09:30:00.000Z'));

  assert.equal(beforeTodayRun.toISOString(), '2026-04-27T09:00:00.000Z');
  assert.equal(afterTodayRun.toISOString(), '2026-04-28T09:00:00.000Z');
});

test('computeNextRestartRunAt spaces biweekly restarts from the last scheduled run', () => {
  const nextRunAt = computeNextRestartRunAt({
    deviceRestartScheduleEnabled: true,
    deviceRestartScheduleFrequency: 'biweekly',
    deviceRestartScheduleDayOfWeek: 0,
    deviceRestartScheduleTime: '03:00',
    deviceRestartScheduleLastTriggeredAt: new Date('2026-04-26T09:00:00.000Z'),
    timezone: 'America/Denver'
  }, new Date('2026-04-27T15:00:00.000Z'));

  assert.equal(nextRunAt.toISOString(), '2026-05-10T09:00:00.000Z');
});

test('requestManualReboot records the request and dispatches sudo reboot', async () => {
  const spawnCalls = [];
  const settingsDoc = {
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
    }
  };
  const service = new DeviceRestartService({
    settingsModel: {
      getSettings: async () => settingsDoc
    },
    rebootBinary: '/usr/sbin/reboot',
    spawnProcess: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    }
  });

  const result = await service.requestManualReboot({ actor: 'admin@homebrain.test' });

  assert.equal(result.success, true);
  assert.equal(result.command, 'sudo -n /usr/sbin/reboot');
  assert.equal(settingsDoc.saveCalls, 1);
  assert.equal(settingsDoc.deviceRestartLastRequestedBy, 'admin@homebrain.test');
  assert.equal(settingsDoc.deviceRestartLastRequestSource, 'manual');
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'sudo');
  assert.deepEqual(spawnCalls[0].args, ['-n', '/usr/sbin/reboot']);
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(spawnCalls[0].options.stdio, 'ignore');
});

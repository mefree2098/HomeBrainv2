const test = require('node:test');
const assert = require('node:assert/strict');

const insteonService = require('../services/insteonService');
const insteonEngineLogService = require('../services/insteonEngineLogService');

test('insteonEngineLogService replays the most recent log entries in chronological order', (t) => {
  insteonEngineLogService.reset();
  t.after(() => {
    insteonEngineLogService.reset();
  });

  insteonEngineLogService.publish({
    message: 'First log entry',
    level: 'info',
    timestamp: '2026-04-02T18:00:00.000Z'
  });
  insteonEngineLogService.publish({
    message: 'Second log entry',
    level: 'warn',
    timestamp: '2026-04-02T18:00:01.000Z'
  });
  insteonEngineLogService.publish({
    message: 'Third log entry',
    level: 'error',
    timestamp: '2026-04-02T18:00:02.000Z'
  });

  const replay = insteonEngineLogService.latest({ limit: 2 });

  assert.equal(replay.length, 2);
  assert.equal(replay[0].message, 'Second log entry');
  assert.equal(replay[1].message, 'Third log entry');
});

test('insteonService runtime command handling writes live engine logs', async (t) => {
  const originalPersistByAddress = insteonService._persistDeviceRuntimeStateByAddress;
  const originalScheduleRefresh = insteonService._scheduleRuntimeStateRefresh;

  insteonEngineLogService.reset();

  t.after(() => {
    insteonService._persistDeviceRuntimeStateByAddress = originalPersistByAddress;
    insteonService._scheduleRuntimeStateRefresh = originalScheduleRefresh;
    insteonEngineLogService.reset();
  });

  let persisted = null;
  let scheduled = null;

  insteonService._persistDeviceRuntimeStateByAddress = async (address, state) => {
    persisted = { address, state };
  };
  insteonService._scheduleRuntimeStateRefresh = (address, reason) => {
    scheduled = { address, reason };
  };

  await insteonService._handleRuntimeCommand({
    standard: {
      id: '11.22.33',
      command1: '11',
      command2: 'FF'
    }
  });

  assert.deepEqual(persisted?.address, '112233');
  assert.deepEqual(scheduled?.address, '112233');
  assert.match(scheduled?.reason || '', /cmd:11/i);

  const logs = insteonEngineLogService.latest({ limit: 10 });
  assert.ok(logs.some((entry) => (
    entry.operation === 'runtime_command'
    && entry.direction === 'inbound'
    && /inbound runtime command/i.test(entry.message)
    && entry.address === '11.22.33'
  )));
});

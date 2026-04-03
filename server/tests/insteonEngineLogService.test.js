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
  const originalFindExistingDevices = insteonService._findExistingInsteonDevicesByAddress;

  insteonEngineLogService.reset();

  t.after(() => {
    insteonService._persistDeviceRuntimeStateByAddress = originalPersistByAddress;
    insteonService._scheduleRuntimeStateRefresh = originalScheduleRefresh;
    insteonService._findExistingInsteonDevicesByAddress = originalFindExistingDevices;
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
  insteonService._findExistingInsteonDevicesByAddress = async (address) => (
    address === '445566'
      ? [{ _id: 'target-device', properties: { insteonAddress: '44.55.66' } }]
      : []
  );

  await insteonService._handleRuntimeCommand({
    standard: {
      id: '11.22.33',
      gatewayId: '44.55.66',
      messageType: 0,
      command1: '11',
      command2: 'FF'
    }
  });

  assert.deepEqual(persisted, {
    address: '445566',
    state: {
      status: true,
      brightness: 100,
      level: 100,
      isOnline: true,
      lastSeen: persisted?.state?.lastSeen
    }
  });
  assert.ok(persisted?.state?.lastSeen instanceof Date);
  assert.deepEqual(scheduled?.address, '445566');
  assert.match(scheduled?.reason || '', /direct:11\.22\.33:11/i);

  const logs = insteonEngineLogService.latest({ limit: 10 });
  assert.ok(logs.some((entry) => (
    entry.operation === 'runtime_command'
    && entry.direction === 'inbound'
    && /inbound runtime command/i.test(entry.message)
    && entry.address === '11.22.33'
    && entry.details?.sourceAddress === '11.22.33'
    && entry.details?.targetAddress === '44.55.66'
    && entry.details?.messageClass === 'direct'
  )));
});

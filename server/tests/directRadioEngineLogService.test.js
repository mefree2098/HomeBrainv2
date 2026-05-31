const test = require('node:test');
const assert = require('node:assert/strict');

const directRadioEngineLogService = require('../services/directRadioEngineLogService');

test('directRadioEngineLogService replays recent log entries in chronological order', (t) => {
  directRadioEngineLogService.reset();
  t.after(() => {
    directRadioEngineLogService.reset();
  });

  directRadioEngineLogService.publish({
    protocol: 'zigbee',
    level: 'info',
    message: 'First direct-radio entry',
    timestamp: '2026-05-07T10:00:00.000Z'
  });
  directRadioEngineLogService.publish({
    protocol: 'zwave',
    level: 'warn',
    message: 'Second direct-radio entry',
    timestamp: '2026-05-07T10:00:01.000Z'
  });
  directRadioEngineLogService.publish({
    protocol: 'system',
    level: 'error',
    message: 'Third direct-radio entry',
    timestamp: '2026-05-07T10:00:02.000Z'
  });

  const replay = directRadioEngineLogService.latest({ limit: 2 });

  assert.equal(replay.length, 2);
  assert.equal(replay[0].message, 'Second direct-radio entry');
  assert.equal(replay[1].message, 'Third direct-radio entry');
});

test('directRadioEngineLogService normalizes unsupported protocol and level values', (t) => {
  directRadioEngineLogService.reset();
  t.after(() => {
    directRadioEngineLogService.reset();
  });

  const entry = directRadioEngineLogService.publish({
    protocol: 'matter',
    level: 'debug',
    message: 'Unknown direct-radio entry',
    details: {
      keep: true,
      drop: undefined
    }
  });

  assert.equal(entry.protocol, 'system');
  assert.equal(entry.level, 'info');
  assert.deepEqual(entry.details, { keep: true });
});

test('directRadioEngineLogService keeps a full diagnostic replay window', (t) => {
  directRadioEngineLogService.reset();
  t.after(() => {
    directRadioEngineLogService.reset();
  });

  for (let index = 0; index < 10025; index += 1) {
    directRadioEngineLogService.publish({
      protocol: 'zigbee',
      level: 'info',
      message: `Direct radio entry ${index}`
    });
  }

  const replay = directRadioEngineLogService.latest({ limit: 20000 });

  assert.equal(replay.length, 10000);
  assert.equal(replay[0].message, 'Direct radio entry 25');
  assert.equal(replay.at(-1).message, 'Direct radio entry 10024');
});

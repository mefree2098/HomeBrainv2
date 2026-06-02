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

  for (let index = 0; index < 50025; index += 1) {
    directRadioEngineLogService.publish({
      protocol: 'zigbee',
      level: 'info',
      message: `Direct radio entry ${index}`
    });
  }

  const replay = directRadioEngineLogService.latest({ limit: 60000 });

  assert.equal(replay.length, 50000);
  assert.equal(replay[0].message, 'Direct radio entry 25');
  assert.equal(replay.at(-1).message, 'Direct radio entry 50024');
});

test('directRadioEngineLogService replays and clears entries by protocol', (t) => {
  directRadioEngineLogService.reset();
  t.after(() => {
    directRadioEngineLogService.reset();
  });

  directRadioEngineLogService.publish({ protocol: 'zigbee', message: 'zigbee joined' });
  directRadioEngineLogService.publish({ protocol: 'zwave', message: 'zwave included' });
  directRadioEngineLogService.publish({ protocol: 'system', message: 'scan complete' });

  assert.deepEqual(
    directRadioEngineLogService.latest({ limit: 10, protocol: 'zigbee' }).map((entry) => entry.message),
    ['zigbee joined']
  );
  assert.deepEqual(
    directRadioEngineLogService.latest({ limit: 10, protocol: 'zwave' }).map((entry) => entry.message),
    ['zwave included']
  );

  assert.equal(directRadioEngineLogService.reset({ protocol: 'zigbee' }), 1);
  assert.deepEqual(
    directRadioEngineLogService.latest({ limit: 10 }).map((entry) => entry.message),
    ['zwave included', 'scan complete']
  );
});

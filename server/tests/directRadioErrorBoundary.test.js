'use strict';

// Phase 0a regression coverage: every Zigbee/Z-Wave event listener routes its
// fire-and-forget async handler through directRadioService.dispatchHandler so a
// thrown error is logged instead of silently dropping the device update (or
// surfacing as an unhandled promise rejection that can crash the process).

const test = require('node:test');
const assert = require('node:assert');

const directRadioService = require('../services/directRadioService');
const directRadioEngineLogService = require('../services/directRadioEngineLogService');

function lastErrorLog() {
  const entries = directRadioEngineLogService.latest({ limit: 50 });
  return [...entries].reverse().find((entry) => entry.level === 'error') || null;
}

test('dispatchHandler catches a synchronous throw and logs it instead of propagating', () => {
  directRadioEngineLogService.reset();
  let ran = false;

  const result = directRadioService.dispatchHandler(
    'test:sync',
    'zwave',
    () => {
      ran = true;
      throw new Error('boom-sync');
    },
    { nodeId: 7 }
  );

  assert.strictEqual(ran, true, 'handler body executed');
  assert.strictEqual(result, undefined, 'returns undefined rather than propagating the throw');

  const entry = lastErrorLog();
  assert.ok(entry, 'an error log entry was published');
  assert.strictEqual(entry.protocol, 'zwave');
  assert.match(entry.message, /test:sync/);
  assert.strictEqual(entry.details.error, 'boom-sync');
  assert.strictEqual(entry.details.nodeId, 7);
});

test('dispatchHandler catches an async rejection without an unhandled rejection', async () => {
  directRadioEngineLogService.reset();

  directRadioService.dispatchHandler(
    'test:async',
    'zigbee',
    () => Promise.reject(new Error('boom-async')),
    { ieeeAddr: '0xabc' }
  );

  // Allow the rejection-handling microtask to run.
  await new Promise((resolve) => setImmediate(resolve));

  const entry = lastErrorLog();
  assert.ok(entry, 'an error log entry was published for the async rejection');
  assert.strictEqual(entry.protocol, 'zigbee');
  assert.match(entry.message, /test:async/);
  assert.strictEqual(entry.details.error, 'boom-async');
  assert.strictEqual(entry.details.ieeeAddr, '0xabc');
});

test('dispatchHandler returns the handler result on success and logs no error', async () => {
  directRadioEngineLogService.reset();

  const value = directRadioService.dispatchHandler('test:ok', 'zwave', () => 'value');
  assert.strictEqual(value, 'value');

  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(lastErrorLog(), null, 'no error log entry on success');
});

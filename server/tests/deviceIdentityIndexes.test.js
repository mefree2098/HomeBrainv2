'use strict';

// Phase 1 (item C) coverage: the partial-unique identity indexes are scoped to
// the two globally-unique fields, and the builder is safe-by-construction — a
// failed build (e.g. pre-existing duplicate rows) is swallowed and never crashes
// startup. Uses fake models so it never touches a real Mongo collection.

const test = require('node:test');
const assert = require('node:assert');

const { ensureDeviceIdentityIndexes } = require('../models/init');

test('creates partial-unique indexes on smartThingsDeviceId and homebrainDirect.ieeeAddr only', async () => {
  const calls = [];
  const fakeModel = {
    collection: {
      createIndex: async (key, opts) => { calls.push({ key, opts }); }
    }
  };

  await ensureDeviceIdentityIndexes(fakeModel);

  assert.strictEqual(calls.length, 2, 'exactly two unique indexes');
  const names = calls.map((call) => call.opts.name).sort();
  assert.deepStrictEqual(names, ['uniq_homebrainDirect_ieeeAddr', 'uniq_smartThingsDeviceId']);

  for (const call of calls) {
    const field = Object.keys(call.key)[0];
    assert.strictEqual(call.opts.unique, true, `${field} index is unique`);
    // Partial filter ($type: 'string') so devices missing the field aren't indexed
    // and can't collide on null.
    assert.deepStrictEqual(call.opts.partialFilterExpression[field], { $type: 'string' });
  }

  // The intentionally-shared migration field and the per-controller nodeId are
  // never made unique.
  const fields = calls.map((call) => Object.keys(call.key)[0]);
  assert.ok(!fields.includes('properties.smartThingsMigration.smartThingsDeviceId'));
  assert.ok(!fields.includes('properties.homebrainDirect.nodeId'));
});

test('never throws when an index build fails (e.g. pre-existing duplicates)', async () => {
  const fakeModel = {
    collection: {
      createIndex: async () => { throw new Error('E11000 duplicate key error'); }
    }
  };
  await assert.doesNotReject(() => ensureDeviceIdentityIndexes(fakeModel));
});

test('is a no-op when no usable collection is available', async () => {
  await assert.doesNotReject(() => ensureDeviceIdentityIndexes({}));
});

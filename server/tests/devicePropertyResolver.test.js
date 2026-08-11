const assert = require('node:assert/strict');
const test = require('node:test');

const {
  applyFlattenedUpdates,
  getNestedValue,
  setNestedValue
} = require('../utils/devicePropertyResolver');

test('device property helpers read and write safe nested paths', () => {
  const document = {};
  setNestedValue(document, 'properties.energy.watts', 42);

  assert.equal(getNestedValue(document, 'properties.energy.watts'), 42);
  assert.deepEqual(document, { properties: { energy: { watts: 42 } } });
});

test('device property helpers reject prototype-polluting paths', () => {
  const document = {};
  setNestedValue(document, '__proto__.polluted', true);
  setNestedValue(document, 'constructor.prototype.polluted', true);

  const updated = applyFlattenedUpdates({}, JSON.parse(
    '{"__proto__":{"polluted":true},"safe.value":1}'
  ));

  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(getNestedValue(document, '__proto__.polluted'), undefined);
  assert.deepEqual(updated, { safe: { value: 1 } });
});

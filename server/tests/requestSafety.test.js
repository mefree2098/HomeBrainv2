const assert = require('node:assert/strict');
const test = require('node:test');

const { findUnsafeRequestKey, rejectUnsafeRequestKeys } = require('../middleware/requestSafety');

test('request key validation rejects Mongo operators and prototype keys recursively', () => {
  assert.equal(findUnsafeRequestKey({ filters: { $where: 'dangerous' } }), '$where');
  assert.equal(findUnsafeRequestKey(JSON.parse('{"metadata":{"__proto__":{"admin":true}}}')), '__proto__');
  assert.equal(findUnsafeRequestKey({ safe: [{ value: 1 }] }), null);
});

test('request safety middleware returns a generic 400 response', () => {
  const req = { body: { nested: { $gt: 0 } }, query: {}, params: {} };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let nextCalled = false;

  rejectUnsafeRequestKeys(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, {
    success: false,
    message: 'Request contains an unsafe object key.'
  });
});

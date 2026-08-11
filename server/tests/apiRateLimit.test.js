const assert = require('node:assert/strict');
const test = require('node:test');

const { createApiRateLimit, getApiRateLimitConfig } = require('../middleware/apiRateLimit');

function invoke(limiter, ip = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = {
      ip,
      headers: {},
      socket: { remoteAddress: ip },
      app: { get: () => false }
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      send(body) { resolve({ limited: true, statusCode: this.statusCode, body }); },
      json(body) { resolve({ limited: true, statusCode: this.statusCode, body }); }
    };

    Promise.resolve(limiter(req, res, () => resolve({ limited: false, statusCode: res.statusCode })))
      .catch(reject);
  });
}

test('global API rate-limit configuration is bounded', () => {
  assert.deepEqual(getApiRateLimitConfig({
    HOMEBRAIN_API_RATE_LIMIT_WINDOW_MS: '-1',
    HOMEBRAIN_API_RATE_LIMIT_MAX: '999999999'
  }), {
    windowMs: 1_000,
    limit: 100_000
  });
});

test('global API rate limiter rejects requests after the configured budget', async () => {
  const limiter = createApiRateLimit({ windowMs: 60_000, limit: 2 });
  assert.equal((await invoke(limiter)).limited, false);
  assert.equal((await invoke(limiter)).limited, false);
  const rejected = await invoke(limiter);
  assert.equal(rejected.limited, true);
  assert.equal(rejected.statusCode, 429);
  assert.equal(rejected.body.message, 'Too many API requests. Please retry shortly.');
});

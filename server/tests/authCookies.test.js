const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACCESS_TOKEN_COOKIE_NAME,
  SESSION_TOKEN_COOKIE_NAME,
  buildCookieOptions,
  clearAuthCookies,
  resolveCookieSecure,
  setAuthCookies
} = require('../utils/authCookies');

function createResponseRecorder() {
  const cookies = [];
  const clearedCookies = [];
  return {
    cookies,
    clearedCookies,
    cookie(name, value, options) {
      cookies.push({ name, value, options });
    },
    clearCookie(name, options) {
      clearedCookies.push({ name, options });
    }
  };
}

test('production mode does not force Secure cookies for direct LAN HTTP', () => {
  const req = { protocol: 'http', secure: false };
  const env = { NODE_ENV: 'production' };

  assert.equal(resolveCookieSecure(req, env), false);
  assert.equal(buildCookieOptions(1_000, { req, env }).secure, false);
});

test('HTTPS requests automatically receive Secure cookies', () => {
  const req = { protocol: 'https', secure: true };

  assert.equal(resolveCookieSecure(req, {}), true);
  assert.equal(buildCookieOptions(1_000, { req, env: {} }).secure, true);
});

test('COOKIE_SECURE can explicitly force or disable Secure cookies', () => {
  const httpRequest = { protocol: 'http', secure: false };
  const httpsRequest = { protocol: 'https', secure: true };

  assert.equal(resolveCookieSecure(httpRequest, { COOKIE_SECURE: 'true' }), true);
  assert.equal(resolveCookieSecure(httpsRequest, { COOKIE_SECURE: 'false' }), false);
});

test('setAuthCookies applies request-aware security to both auth cookies', () => {
  const res = createResponseRecorder();
  const req = { protocol: 'http', secure: false };

  setAuthCookies(res, 'access-token', 'session-token', { req, env: {} });

  assert.deepEqual(res.cookies.map(({ name }) => name), [
    ACCESS_TOKEN_COOKIE_NAME,
    SESSION_TOKEN_COOKIE_NAME
  ]);
  assert.deepEqual(res.cookies.map(({ options }) => options.secure), [false, false]);
});

test('clearAuthCookies uses the same request-aware security attributes', () => {
  const res = createResponseRecorder();
  const req = { protocol: 'https', secure: true };

  clearAuthCookies(res, { req, env: {} });

  assert.deepEqual(res.clearedCookies.map(({ name }) => name), [
    ACCESS_TOKEN_COOKIE_NAME,
    SESSION_TOKEN_COOKIE_NAME
  ]);
  assert.deepEqual(res.clearedCookies.map(({ options }) => options.secure), [true, true]);
  assert.deepEqual(res.clearedCookies.map(({ options }) => 'maxAge' in options), [false, false]);
});

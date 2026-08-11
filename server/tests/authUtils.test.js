const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const authModulePath = require.resolve('../utils/auth');

function loadAuthModule() {
  delete require.cache[authModulePath];
  return require(authModulePath);
}

function refreshLifetimeInSeconds(token) {
  const decoded = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
  return Number(decoded?.exp || 0) - Number(decoded?.iat || 0);
}

test('generateRefreshToken defaults to a 30 day lifetime', (t) => {
  const originalRefreshTokenTtl = process.env.AUTH_REFRESH_TOKEN_TTL;
  const originalRefreshSecret = process.env.REFRESH_TOKEN_SECRET;

  t.after(() => {
    process.env.AUTH_REFRESH_TOKEN_TTL = originalRefreshTokenTtl;
    process.env.REFRESH_TOKEN_SECRET = originalRefreshSecret;
    delete require.cache[authModulePath];
  });

  delete process.env.AUTH_REFRESH_TOKEN_TTL;
  process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';

  const { generateRefreshToken } = loadAuthModule();
  const token = generateRefreshToken({ _id: '507f1f77bcf86cd799439011' });

  assert.equal(refreshLifetimeInSeconds(token), 30 * 24 * 60 * 60);
});

test('generateRefreshToken respects AUTH_REFRESH_TOKEN_TTL overrides', (t) => {
  const originalRefreshTokenTtl = process.env.AUTH_REFRESH_TOKEN_TTL;
  const originalRefreshSecret = process.env.REFRESH_TOKEN_SECRET;

  t.after(() => {
    process.env.AUTH_REFRESH_TOKEN_TTL = originalRefreshTokenTtl;
    process.env.REFRESH_TOKEN_SECRET = originalRefreshSecret;
    delete require.cache[authModulePath];
  });

  process.env.AUTH_REFRESH_TOKEN_TTL = '90d';
  process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';

  const { generateRefreshToken } = loadAuthModule();
  const token = generateRefreshToken({ _id: '507f1f77bcf86cd799439011' });

  assert.equal(refreshLifetimeInSeconds(token), 90 * 24 * 60 * 60);
});

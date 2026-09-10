const test = require('node:test');
const assert = require('node:assert/strict');
const { getCookieValue } = require('../utils/authCookies');

test('malformed unrelated cookies do not shadow valid authentication', () => {
  assert.equal(getCookieValue({ headers: { cookie: 'bad%=no; hbAccessToken=valid%20token' } }, 'hbAccessToken'), 'valid token');
});
test('invalid cookie values fail closed even when followed by a valid duplicate', () => {
  for (const value of ['%', '%E0%A4%A', '%FF']) {
    assert.equal(getCookieValue({ headers: { cookie: `hbAccessToken=${value}; hbAccessToken=valid` } }, 'hbAccessToken'), null);
  }
});
test('cookie parser safely handles missing or non-string headers', () => {
  for (const req of [undefined, {}, { headers: {} }, { headers: { cookie: ['hbAccessToken=x'] } }]) {
    assert.equal(getCookieValue(req, 'hbAccessToken'), null);
  }
});

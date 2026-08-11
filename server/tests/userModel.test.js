const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');

test('user serialization removes password and stored refresh token', () => {
  const user = new User({
    name: 'HomeBrain Admin',
    email: 'admin@example.com',
    password: 'stored-password-hash',
    refreshToken: 'stored-refresh-token',
    role: 'admin',
    platforms: {
      homebrain: true,
      axiom: true
    }
  });

  const serialized = user.toJSON();

  assert.equal(serialized.password, undefined);
  assert.equal(serialized.refreshToken, undefined);
  assert.deepEqual(serialized.platforms, {
    homebrain: true,
    axiom: true
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');

const User = require('../models/User');
const UserService = require('../services/userService');
const { generatePasswordHash } = require('../utils/password');

test('authenticateWithPassword rejects active users that have no enabled platforms', async (t) => {
  const originalFindOne = User.findOne;

  t.after(() => {
    User.findOne = originalFindOne;
  });

  User.findOne = () => ({
    exec: async () => ({
      _id: '507f1f77bcf86cd799439011',
      email: 'matt@freestonefamily.com',
      password: await generatePasswordHash('ValidPass123!'),
      isActive: true,
      platforms: {
        homebrain: false,
        axiom: false
      },
      async save() {
        return this;
      }
    })
  });

  await assert.rejects(
    () => UserService.authenticateWithPassword('matt@freestonefamily.com', 'ValidPass123!'),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.message, 'User account has no platform access');
      return true;
    }
  );
});

test('updateUserDetails blocks removing HomeBrain access from the last active HomeBrain admin', async (t) => {
  const originalGet = UserService.get;
  const originalCountActiveAdmins = UserService.countActiveAdmins;

  t.after(() => {
    UserService.get = originalGet;
    UserService.countActiveAdmins = originalCountActiveAdmins;
  });

  let saveCalled = false;
  UserService.get = async () => ({
    _id: '507f1f77bcf86cd799439011',
    email: 'matt@freestonefamily.com',
    role: 'admin',
    isActive: true,
    platforms: {
      homebrain: true,
      axiom: true
    },
    async save() {
      saveCalled = true;
      return this;
    }
  });
  UserService.countActiveAdmins = async () => 1;

  await assert.rejects(
    () => UserService.updateUserDetails('507f1f77bcf86cd799439011', {
      platforms: {
        homebrain: false,
        axiom: true
      }
    }),
    /At least one active HomeBrain admin account is required/
  );

  assert.equal(saveCalled, false);
});

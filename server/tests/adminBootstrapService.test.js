const test = require('node:test');
const assert = require('node:assert/strict');

const adminBootstrapService = require('../services/adminBootstrapService');
const User = require('../models/User');
const UserService = require('../services/userService');
const { generatePasswordHash, validatePassword } = require('../utils/password');
const { ROLES } = require('../../shared/config/roles');

test('ensureBootstrapState promotes and reactivates the configured admin account', async (t) => {
  const originalFindOne = User.findOne;

  t.after(() => {
    User.findOne = originalFindOne;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_EMAIL;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_NAME;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_PASSWORD;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_ENABLED;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_SYNC_PASSWORD;
  });

  process.env.HOMEBRAIN_DEFAULT_ADMIN_EMAIL = 'matt@freestonefamily.com';
  process.env.HOMEBRAIN_DEFAULT_ADMIN_NAME = 'Matt Freestone';

  const user = {
    email: 'matt@freestonefamily.com',
    role: ROLES.USER,
    isActive: false,
    platforms: {
      homebrain: false,
      axiom: false
    },
    name: '',
    password: await generatePasswordHash('CurrentPass123!'),
    saved: false,
    async save() {
      this.saved = true;
      return this;
    }
  };

  User.findOne = () => ({
    exec: async () => user
  });

  const result = await adminBootstrapService.ensureBootstrapState();

  assert.equal(result.created, false);
  assert.equal(result.updated, true);
  assert.deepEqual(result.changes, ['role', 'isActive', 'platforms.homebrain', 'name']);
  assert.equal(user.role, ROLES.ADMIN);
  assert.equal(user.isActive, true);
  assert.equal(user.platforms.homebrain, true);
  assert.equal(user.name, 'Matt Freestone');
  assert.equal(user.saved, true);
});

test('ensureBootstrapState skips creating a missing default admin when no password is configured', async (t) => {
  const originalFindOne = User.findOne;
  const originalCreate = UserService.create;

  t.after(() => {
    User.findOne = originalFindOne;
    UserService.create = originalCreate;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_EMAIL;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_NAME;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_PASSWORD;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_ENABLED;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_SYNC_PASSWORD;
  });

  process.env.HOMEBRAIN_DEFAULT_ADMIN_EMAIL = 'matt@freestonefamily.com';
  process.env.HOMEBRAIN_DEFAULT_ADMIN_NAME = 'Matt Freestone';

  User.findOne = () => ({
    exec: async () => null
  });

  let createCalled = false;
  UserService.create = async () => {
    createCalled = true;
  };

  const result = await adminBootstrapService.ensureBootstrapState();

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'password_not_configured');
  assert.equal(createCalled, false);
});

test('ensureBootstrapState creates the configured admin when password bootstrap is available', async (t) => {
  const originalFindOne = User.findOne;
  const originalCreate = UserService.create;

  t.after(() => {
    User.findOne = originalFindOne;
    UserService.create = originalCreate;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_EMAIL;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_NAME;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_PASSWORD;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_ENABLED;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_SYNC_PASSWORD;
  });

  process.env.HOMEBRAIN_DEFAULT_ADMIN_EMAIL = 'matt@freestonefamily.com';
  process.env.HOMEBRAIN_DEFAULT_ADMIN_NAME = 'Matt Freestone';
  process.env.HOMEBRAIN_DEFAULT_ADMIN_PASSWORD = 'AdminPass123!';

  User.findOne = () => ({
    exec: async () => null
  });

  let createdPayload = null;
  UserService.create = async (payload) => {
    createdPayload = payload;
    return payload;
  };

  const result = await adminBootstrapService.ensureBootstrapState();

  assert.equal(result.created, true);
  assert.deepEqual(result.changes, ['created']);
  assert.equal(createdPayload.email, 'matt@freestonefamily.com');
  assert.equal(createdPayload.name, 'Matt Freestone');
  assert.equal(createdPayload.role, ROLES.ADMIN);
  assert.equal(createdPayload.isActive, true);
  assert.deepEqual(createdPayload.platforms, {
    homebrain: true,
    axiom: false
  });
});

test('ensureBootstrapState updates the configured admin password when the bootstrap password changes', async (t) => {
  const originalFindOne = User.findOne;

  t.after(() => {
    User.findOne = originalFindOne;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_EMAIL;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_NAME;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_PASSWORD;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_ENABLED;
    delete process.env.HOMEBRAIN_DEFAULT_ADMIN_SYNC_PASSWORD;
  });

  process.env.HOMEBRAIN_DEFAULT_ADMIN_EMAIL = 'matt@freestonefamily.com';
  process.env.HOMEBRAIN_DEFAULT_ADMIN_NAME = 'Matt Freestone';
  process.env.HOMEBRAIN_DEFAULT_ADMIN_PASSWORD = 'NewAdminPass123!';
  process.env.HOMEBRAIN_DEFAULT_ADMIN_SYNC_PASSWORD = 'true';

  const user = {
    email: 'matt@freestonefamily.com',
    role: ROLES.ADMIN,
    isActive: true,
    name: 'Matt Freestone',
    password: await generatePasswordHash('OldAdminPass123!'),
    async save() {
      return this;
    }
  };

  User.findOne = () => ({
    exec: async () => user
  });

  const result = await adminBootstrapService.ensureBootstrapState();

  assert.equal(result.updated, true);
  assert.deepEqual(result.changes, ['password']);
  assert.equal(await validatePassword('NewAdminPass123!', user.password), true);
});

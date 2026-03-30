const User = require('../models/User');
const UserService = require('./userService');
const { generatePasswordHash, validatePassword } = require('../utils/password');
const { ROLES } = require('../../shared/config/roles');
const { USER_PLATFORMS, hasPlatformAccess } = require('../utils/userPlatforms');

const DEFAULT_ADMIN_EMAIL = 'matt@freestonefamily.com';
const DEFAULT_ADMIN_NAME = 'Matt Freestone';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(value) {
  return trimString(value).toLowerCase();
}

function parseEnabledFlag(value) {
  if (typeof value !== 'string') {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

function getConfiguredAdminEmail() {
  return normalizeEmail(process.env.HOMEBRAIN_DEFAULT_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL);
}

function getConfiguredAdminName() {
  return trimString(process.env.HOMEBRAIN_DEFAULT_ADMIN_NAME || DEFAULT_ADMIN_NAME);
}

function getConfiguredAdminPassword() {
  return trimString(process.env.HOMEBRAIN_DEFAULT_ADMIN_PASSWORD || process.env.DEFAULT_ADMIN_PASSWORD);
}

function shouldSyncExistingPassword() {
  return parseEnabledFlag(process.env.HOMEBRAIN_DEFAULT_ADMIN_SYNC_PASSWORD || 'false');
}

function createSummary(overrides = {}) {
  return {
    enabled: true,
    email: '',
    created: false,
    updated: false,
    skipped: false,
    reason: '',
    changes: [],
    ...overrides,
  };
}

class AdminBootstrapService {
  async ensureBootstrapState(_options = {}) {
    const enabled = parseEnabledFlag(process.env.HOMEBRAIN_DEFAULT_ADMIN_ENABLED);
    const email = getConfiguredAdminEmail();
    const name = getConfiguredAdminName();
    const password = getConfiguredAdminPassword();
    const syncExistingPassword = shouldSyncExistingPassword();

    if (!enabled) {
      return createSummary({
        enabled: false,
        skipped: true,
        reason: 'disabled'
      });
    }

    if (!email) {
      return createSummary({
        skipped: true,
        reason: 'missing_email'
      });
    }

    const existingUser = await User.findOne({ email }).exec();
    if (existingUser) {
      const changes = [];

      if (existingUser.role !== ROLES.ADMIN) {
        existingUser.role = ROLES.ADMIN;
        changes.push('role');
      }

      if (!existingUser.isActive) {
        existingUser.isActive = true;
        changes.push('isActive');
      }

      if (!hasPlatformAccess(existingUser, USER_PLATFORMS.HOMEBRAIN)) {
        existingUser.platforms = {
          ...(existingUser.platforms || {}),
          [USER_PLATFORMS.HOMEBRAIN]: true
        };
        changes.push('platforms.homebrain');
      }

      if (name && existingUser.name !== name) {
        existingUser.name = name;
        changes.push('name');
      }

      if (password && syncExistingPassword) {
        const passwordMatches = await validatePassword(password, existingUser.password);
        if (!passwordMatches) {
          existingUser.password = await generatePasswordHash(password); // eslint-disable-line no-param-reassign
          changes.push('password');
        }
      }

      if (changes.length > 0) {
        await existingUser.save();
      }

      return createSummary({
        email,
        updated: changes.length > 0,
        changes,
        reason: changes.length > 0 ? '' : 'already_current'
      });
    }

    if (!password) {
      return createSummary({
        email,
        skipped: true,
        reason: 'password_not_configured'
      });
    }

    await UserService.create({
      email,
      password,
      name,
      role: ROLES.ADMIN,
      isActive: true,
      platforms: {
        homebrain: true,
        axiom: false
      }
    });

    return createSummary({
      email,
      created: true,
      changes: ['created']
    });
  }
}

module.exports = new AdminBootstrapService();

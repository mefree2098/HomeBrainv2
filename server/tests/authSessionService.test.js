const test = require('node:test');
const assert = require('node:assert/strict');

const UserSession = require('../models/UserSession');
const Settings = require('../models/Settings');
const UserService = require('../services/userService');
const authSessionService = require('../services/authSessionService');
const jwt = require('jsonwebtoken');

function buildQueryExecutor(records, query = {}, mode = 'one') {
  const matchValue = (actual, expected) => {
    if (expected && typeof expected === 'object' && '$gt' in expected) {
      return new Date(actual).getTime() > new Date(expected.$gt).getTime();
    }

    if (expected === null) {
      return actual === null || actual === undefined;
    }

    return String(actual ?? '') === String(expected ?? '');
  };

  const matches = (record) => Object.entries(query).every(([key, expected]) => {
    return matchValue(record[key], expected);
  });

  return {
    _sort: null,
    sort(sortObject = {}) {
      this._sort = sortObject;
      return this;
    },
    async exec() {
      const filtered = records.filter(matches);
      const entries = Object.entries(this._sort || {});
      if (entries.length > 0) {
        filtered.sort((left, right) => {
          for (const [key, direction] of entries) {
            const leftValue = left[key] instanceof Date ? left[key].getTime() : left[key];
            const rightValue = right[key] instanceof Date ? right[key].getTime() : right[key];
            if (leftValue === rightValue) {
              continue;
            }

            if ((direction || 1) < 0) {
              return leftValue > rightValue ? -1 : 1;
            }

            return leftValue > rightValue ? 1 : -1;
          }

          return 0;
        });
      }

      return mode === 'many' ? filtered : (filtered[0] || null);
    }
  };
}

function buildRequest(deviceId, clientName = 'Hallway iPad') {
  return {
    headers: {
      'x-homebrain-client-type': 'ios',
      'x-homebrain-client-name': clientName,
      'x-homebrain-device-id': deviceId,
      'user-agent': 'HomeBrainApp/1.0 (iPad; iPadOS)'
    },
    ip: '192.168.1.20'
  };
}

function refreshLifetimeInDays(token) {
  const decoded = jwt.decode(token);
  const issuedAt = Number(decoded?.iat || 0);
  const expiresAt = Number(decoded?.exp || 0);
  return Math.round((expiresAt - issuedAt) / (24 * 60 * 60));
}

function restoreEnvValue(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test('session lifetime keeps iOS at 365 days while browser sessions default to 30 days', async (t) => {
  const originalAuthSessionMaxAge = process.env.AUTH_SESSION_MAX_AGE_DAYS;
  const originalIosSessionMaxAge = process.env.AUTH_IOS_SESSION_MAX_AGE_DAYS;
  const originalGetSettings = Settings.getSettings;

  t.after(() => {
    restoreEnvValue('AUTH_SESSION_MAX_AGE_DAYS', originalAuthSessionMaxAge);
    restoreEnvValue('AUTH_IOS_SESSION_MAX_AGE_DAYS', originalIosSessionMaxAge);
    Settings.getSettings = originalGetSettings;
  });

  process.env.AUTH_SESSION_MAX_AGE_DAYS = '30';
  process.env.AUTH_IOS_SESSION_MAX_AGE_DAYS = '365';
  Settings.getSettings = async () => ({ authSessionMaxAgeDays: 365 });

  assert.equal(await authSessionService.getSessionLifetimeDays('web'), 30);
  assert.equal(await authSessionService.getSessionLifetimeDays('ios'), 365);
  assert.equal(await authSessionService.getSessionLifetimeDays('watchos'), 365);
});

test('UserSession accepts watchOS client sessions', async () => {
  const session = new UserSession({
    userId: '507f1f77bcf86cd799439011',
    sessionId: 'watch-session-1',
    tokenHash: 'token-hash',
    clientType: 'watchos',
    clientName: 'Apple Watch',
    expiresAt: new Date(Date.now() + 86_400_000)
  });

  await session.validate();
});

test('browser-like requests cannot spoof iOS session metadata', () => {
  const metadata = authSessionService.extractSessionMetadata({
    headers: {
      origin: 'https://homebrain.example.com',
      'sec-fetch-site': 'same-origin',
      'x-homebrain-client-type': 'ios',
      'x-homebrain-client-name': 'Spoofed iPad',
      'x-homebrain-device-id': 'browser-device',
      'user-agent': 'Mozilla/5.0 Safari/605.1.15'
    },
    ip: '192.168.1.40'
  });

  assert.equal(metadata.clientType, 'web');
});

test('issueSession reuses the same session record for the same device', async (t) => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalRefreshSecret = process.env.REFRESH_TOKEN_SECRET;
  const originalGetSettings = Settings.getSettings;
  const originalUserGet = UserService.get;
  const originalFindOne = UserSession.findOne;
  const originalFind = UserSession.find;
  const originalSave = UserSession.prototype.save;

  const sessions = [];
  const user = {
    _id: '507f1f77bcf86cd799439011',
    role: 'admin',
    isActive: true,
    toJSON() {
      return { _id: this._id, role: this.role };
    }
  };

  t.after(() => {
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.REFRESH_TOKEN_SECRET = originalRefreshSecret;
    Settings.getSettings = originalGetSettings;
    UserService.get = originalUserGet;
    UserSession.findOne = originalFindOne;
    UserSession.find = originalFind;
    UserSession.prototype.save = originalSave;
  });

  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';

  Settings.getSettings = async () => ({ authSessionMaxAgeDays: 365 });
  UserService.get = async () => user;
  UserSession.findOne = (query) => buildQueryExecutor(sessions, query, 'one');
  UserSession.find = (query) => buildQueryExecutor(sessions, query, 'many');
  UserSession.prototype.save = async function save() {
    const index = sessions.findIndex((entry) => entry.sessionId === this.sessionId);
    if (index >= 0) {
      sessions[index] = this;
    } else {
      sessions.push(this);
    }
    return this;
  };

  const first = await authSessionService.issueSession(user, buildRequest('device-1'));
  const second = await authSessionService.issueSession(user, buildRequest('device-1'));

  assert.equal(sessions.length, 1);
  assert.equal(first.session.sessionId, second.session.sessionId);
  assert.notEqual(first.tokens.refreshToken, second.tokens.refreshToken);
  assert.equal(refreshLifetimeInDays(first.tokens.refreshToken), 365);
});

test('issueSession supports at least 20 simultaneous device sessions for one user', async (t) => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalRefreshSecret = process.env.REFRESH_TOKEN_SECRET;
  const originalGetSettings = Settings.getSettings;
  const originalUserGet = UserService.get;
  const originalFindOne = UserSession.findOne;
  const originalFind = UserSession.find;
  const originalSave = UserSession.prototype.save;

  const sessions = [];
  const user = {
    _id: '507f1f77bcf86cd799439011',
    role: 'admin',
    isActive: true,
    toJSON() {
      return { _id: this._id, role: this.role };
    }
  };

  t.after(() => {
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.REFRESH_TOKEN_SECRET = originalRefreshSecret;
    Settings.getSettings = originalGetSettings;
    UserService.get = originalUserGet;
    UserSession.findOne = originalFindOne;
    UserSession.find = originalFind;
    UserSession.prototype.save = originalSave;
  });

  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';

  Settings.getSettings = async () => ({ authSessionMaxAgeDays: 365 });
  UserService.get = async () => user;
  UserSession.findOne = (query) => buildQueryExecutor(sessions, query, 'one');
  UserSession.find = (query) => buildQueryExecutor(sessions, query, 'many');
  UserSession.prototype.save = async function save() {
    const index = sessions.findIndex((entry) => entry.sessionId === this.sessionId);
    if (index >= 0) {
      sessions[index] = this;
    } else {
      sessions.push(this);
    }
    return this;
  };

  for (let index = 1; index <= 20; index += 1) {
    await authSessionService.issueSession(user, buildRequest(`device-${index}`, `Device ${index}`));
  }

  assert.equal(sessions.length, 20);
  assert.equal(new Set(sessions.map((entry) => entry.sessionId)).size, 20);
});

test('refreshSession rotates tokens without creating a new device session', async (t) => {
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalRefreshSecret = process.env.REFRESH_TOKEN_SECRET;
  const originalGetSettings = Settings.getSettings;
  const originalUserGet = UserService.get;
  const originalFindOne = UserSession.findOne;
  const originalFind = UserSession.find;
  const originalSave = UserSession.prototype.save;

  const sessions = [];
  const user = {
    _id: '507f1f77bcf86cd799439011',
    role: 'admin',
    isActive: true,
    toJSON() {
      return { _id: this._id, role: this.role };
    }
  };

  t.after(() => {
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.REFRESH_TOKEN_SECRET = originalRefreshSecret;
    Settings.getSettings = originalGetSettings;
    UserService.get = originalUserGet;
    UserSession.findOne = originalFindOne;
    UserSession.find = originalFind;
    UserSession.prototype.save = originalSave;
  });

  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.REFRESH_TOKEN_SECRET = 'test-refresh-secret';

  Settings.getSettings = async () => ({ authSessionMaxAgeDays: 365 });
  UserService.get = async () => user;
  UserSession.findOne = (query) => buildQueryExecutor(sessions, query, 'one');
  UserSession.find = (query) => buildQueryExecutor(sessions, query, 'many');
  UserSession.prototype.save = async function save() {
    const index = sessions.findIndex((entry) => entry.sessionId === this.sessionId);
    if (index >= 0) {
      sessions[index] = this;
    } else {
      sessions.push(this);
    }
    return this;
  };

  const initial = await authSessionService.issueSession(user, buildRequest('device-1'));
  const refreshed = await authSessionService.refreshSession(initial.tokens.refreshToken, buildRequest('device-1'));

  assert.equal(sessions.length, 1);
  assert.equal(initial.session.sessionId, refreshed.session.sessionId);
  assert.notEqual(initial.tokens.refreshToken, refreshed.tokens.refreshToken);
});

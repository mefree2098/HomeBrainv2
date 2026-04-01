const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_AUTH_CODE_TTL_MS = Math.max(60 * 1000, Number(process.env.HOMEBRAIN_ALEXA_AUTH_CODE_TTL_MS || 5 * 60 * 1000));
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = Math.max(300, Number(process.env.HOMEBRAIN_ALEXA_ACCESS_TOKEN_TTL_SECONDS || 60 * 60));
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = Math.max(3600, Number(process.env.HOMEBRAIN_ALEXA_REFRESH_TOKEN_TTL_SECONDS || 30 * 24 * 60 * 60));
const MAX_EVENT_QUEUE = 500;
const MAX_AUDIT_LOG = 500;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values = []) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => trimString(value))
    .filter(Boolean)));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString('base64url');
}

function randomIdentifier(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return {
    version: 1,
    hubs: {},
    accountLinks: {},
    authCodes: {},
    accessTokens: {},
    refreshTokens: {},
    permissionGrants: {},
    eventQueue: [],
    auditLog: []
  };
}

function ensureHubRecord(state, hubId) {
  const key = trimString(hubId);
  if (!key) {
    throw new Error('hubId is required');
  }

  if (!state.hubs[key]) {
    const timestamp = new Date().toISOString();
    state.hubs[key] = {
      hubId: key,
      registration: null,
      catalog: {
        endpoints: [],
        updatedAt: null,
        reason: 'never'
      },
      state: {
        states: [],
        updatedAt: null,
        reason: 'never'
      },
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  return state.hubs[key];
}

function pruneExpiredEntries(state) {
  const now = Date.now();

  Object.keys(state.authCodes || {}).forEach((key) => {
    const entry = state.authCodes[key];
    if (!entry || new Date(entry.expiresAt || 0).getTime() <= now || entry.consumedAt) {
      delete state.authCodes[key];
    }
  });

  Object.keys(state.accessTokens || {}).forEach((key) => {
    const entry = state.accessTokens[key];
    if (!entry || entry.revokedAt || new Date(entry.expiresAt || 0).getTime() <= now) {
      delete state.accessTokens[key];
    }
  });

  Object.keys(state.refreshTokens || {}).forEach((key) => {
    const entry = state.refreshTokens[key];
    if (!entry || entry.revokedAt || new Date(entry.expiresAt || 0).getTime() <= now) {
      delete state.refreshTokens[key];
    }
  });

  Object.keys(state.permissionGrants || {}).forEach((key) => {
    const entry = state.permissionGrants[key];
    if (entry && entry.revokedAt) {
      delete state.permissionGrants[key];
    }
  });

  state.eventQueue = (Array.isArray(state.eventQueue) ? state.eventQueue : []).slice(-MAX_EVENT_QUEUE);
  state.auditLog = (Array.isArray(state.auditLog) ? state.auditLog : []).slice(-MAX_AUDIT_LOG);
}

class BrokerStore {
  constructor(options = {}) {
    this.filePath = options.filePath
      || trimString(process.env.HOMEBRAIN_BROKER_STORE_FILE)
      || path.join(__dirname, '..', 'data', 'store.json');
    this.state = options.state ? clone(options.state) : null;
    this.initialized = Boolean(options.state);
    this.pending = Promise.resolve();
  }

  async init() {
    if (this.initialized) {
      return;
    }

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      this.state = {
        ...defaultState(),
        ...JSON.parse(raw || '{}')
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      this.state = defaultState();
      await this.persist();
    }

    pruneExpiredEntries(this.state);
    this.initialized = true;
  }

  async persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  async runExclusive(task) {
    const next = this.pending.then(task, task);
    this.pending = next.catch(() => {});
    return next;
  }

  async read(task) {
    return this.runExclusive(async () => {
      await this.init();
      pruneExpiredEntries(this.state);
      return clone(await task(this.state));
    });
  }

  async write(task) {
    return this.runExclusive(async () => {
      await this.init();
      pruneExpiredEntries(this.state);
      const result = await task(this.state);
      pruneExpiredEntries(this.state);
      await this.persist();
      return clone(result);
    });
  }

  buildHubView(state, hubId) {
    const hub = state.hubs[trimString(hubId)];
    if (!hub) {
      return null;
    }

    const accounts = Object.values(state.accountLinks || {})
      .filter((entry) => entry.hubId === hub.hubId)
      .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime());

    return {
      ...hub,
      accounts
    };
  }

  async getHub(hubId) {
    return this.read((state) => this.buildHubView(state, hubId));
  }

  async listHubs() {
    return this.read((state) => Object.keys(state.hubs || {})
      .map((hubId) => this.buildHubView(state, hubId))
      .filter(Boolean));
  }

  async registerHub(payload = {}) {
    return this.write((state) => {
      const timestamp = new Date().toISOString();
      const hub = ensureHubRecord(state, payload.hubId);
      hub.registration = {
        hubId: hub.hubId,
        hubBaseUrl: trimString(payload.hubBaseUrl),
        catalogUrl: trimString(payload.catalogUrl),
        stateUrl: trimString(payload.stateUrl),
        executeUrl: trimString(payload.executeUrl),
        healthUrl: trimString(payload.healthUrl),
        accountsUrl: trimString(payload.accountsUrl),
        linkAccountUrl: trimString(payload.linkAccountUrl),
        relayToken: trimString(payload.relayToken),
        brokerClientId: trimString(payload.brokerClientId),
        mode: trimString(payload.mode) === 'public' ? 'public' : 'private',
        publicOrigin: trimString(payload.publicOrigin),
        updatedAt: timestamp
      };
      hub.updatedAt = timestamp;
      return this.buildHubView(state, hub.hubId);
    });
  }

  async upsertCatalog(payload = {}) {
    return this.write((state) => {
      const hub = ensureHubRecord(state, payload.hubId);
      const timestamp = new Date().toISOString();
      hub.catalog = {
        endpoints: Array.isArray(payload.endpoints) ? payload.endpoints : [],
        updatedAt: timestamp,
        reason: trimString(payload.reason) || 'hub_push'
      };
      hub.updatedAt = timestamp;
      return hub.catalog;
    });
  }

  async upsertState(payload = {}) {
    return this.write((state) => {
      const hub = ensureHubRecord(state, payload.hubId);
      const timestamp = new Date().toISOString();
      hub.state = {
        states: Array.isArray(payload.states) ? payload.states : [],
        updatedAt: timestamp,
        reason: trimString(payload.reason) || 'hub_push'
      };
      hub.updatedAt = timestamp;
      return hub.state;
    });
  }

  async listAccountLinks(filters = {}) {
    return this.read((state) => Object.values(state.accountLinks || {})
      .filter((entry) => (!filters.hubId || entry.hubId === filters.hubId))
      .filter((entry) => (!filters.status || entry.status === filters.status))
      .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime()));
  }

  async createAccountLink(payload = {}) {
    return this.write((state) => {
      const timestamp = new Date().toISOString();
      const hub = ensureHubRecord(state, payload.hubId);
      const brokerAccountId = trimString(payload.brokerAccountId) || randomIdentifier('hbacct');
      const existing = state.accountLinks[brokerAccountId] || {};

      const next = {
        brokerAccountId,
        hubId: hub.hubId,
        alexaUserId: trimString(payload.alexaUserId),
        alexaAccountId: trimString(payload.alexaAccountId),
        alexaHouseholdId: trimString(payload.alexaHouseholdId),
        locale: trimString(payload.locale) || 'en-US',
        status: trimString(payload.status) === 'revoked'
          ? 'revoked'
          : trimString(payload.status) === 'pending'
            ? 'pending'
            : 'linked',
        permissions: uniqueStrings(payload.permissions || existing.permissions || []),
        acceptedGrantAt: payload.acceptedGrantAt || existing.acceptedGrantAt || null,
        linkedAt: existing.linkedAt || timestamp,
        lastDiscoveryAt: payload.lastDiscoveryAt || existing.lastDiscoveryAt || null,
        lastSeenAt: payload.lastSeenAt || existing.lastSeenAt || timestamp,
        metadata: payload.metadata && typeof payload.metadata === 'object'
          ? { ...(existing.metadata || {}), ...payload.metadata }
          : (existing.metadata || {}),
        createdAt: existing.createdAt || timestamp,
        updatedAt: timestamp
      };

      state.accountLinks[brokerAccountId] = next;
      hub.updatedAt = timestamp;
      return next;
    });
  }

  async updateAccountLink(brokerAccountId, updates = {}) {
    return this.write((state) => {
      const account = state.accountLinks[trimString(brokerAccountId)];
      if (!account) {
        throw new Error('Linked account not found');
      }

      const timestamp = new Date().toISOString();
      Object.assign(account, {
        alexaUserId: Object.prototype.hasOwnProperty.call(updates, 'alexaUserId') ? trimString(updates.alexaUserId) : account.alexaUserId,
        alexaAccountId: Object.prototype.hasOwnProperty.call(updates, 'alexaAccountId') ? trimString(updates.alexaAccountId) : account.alexaAccountId,
        alexaHouseholdId: Object.prototype.hasOwnProperty.call(updates, 'alexaHouseholdId') ? trimString(updates.alexaHouseholdId) : account.alexaHouseholdId,
        locale: Object.prototype.hasOwnProperty.call(updates, 'locale') ? (trimString(updates.locale) || 'en-US') : account.locale,
        status: Object.prototype.hasOwnProperty.call(updates, 'status') ? trimString(updates.status) || account.status : account.status,
        permissions: Object.prototype.hasOwnProperty.call(updates, 'permissions')
          ? uniqueStrings(updates.permissions)
          : uniqueStrings(account.permissions),
        acceptedGrantAt: Object.prototype.hasOwnProperty.call(updates, 'acceptedGrantAt') ? updates.acceptedGrantAt : account.acceptedGrantAt,
        lastDiscoveryAt: Object.prototype.hasOwnProperty.call(updates, 'lastDiscoveryAt') ? updates.lastDiscoveryAt : account.lastDiscoveryAt,
        lastSeenAt: Object.prototype.hasOwnProperty.call(updates, 'lastSeenAt') ? updates.lastSeenAt : (updates.touch ? timestamp : account.lastSeenAt),
        metadata: updates.metadata && typeof updates.metadata === 'object'
          ? { ...(account.metadata || {}), ...updates.metadata }
          : account.metadata,
        updatedAt: timestamp
      });

      return account;
    });
  }

  async createAuthorizationCode(payload = {}) {
    return this.write((state) => {
      const brokerAccountId = trimString(payload.brokerAccountId);
      const accountLink = state.accountLinks[brokerAccountId];
      if (!accountLink) {
        throw new Error('Linked account not found');
      }

      const code = randomToken(24);
      const codeHash = sha256(code);
      const timestamp = new Date();
      state.authCodes[codeHash] = {
        codeHash,
        brokerAccountId,
        hubId: accountLink.hubId,
        clientId: trimString(payload.clientId),
        redirectUri: trimString(payload.redirectUri),
        scopes: uniqueStrings(payload.scopes || ['smart_home']),
        locale: trimString(payload.locale) || accountLink.locale || 'en-US',
        createdAt: timestamp.toISOString(),
        expiresAt: new Date(timestamp.getTime() + DEFAULT_AUTH_CODE_TTL_MS).toISOString(),
        consumedAt: null,
        metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}
      };

      return {
        code,
        expiresAt: state.authCodes[codeHash].expiresAt
      };
    });
  }

  async consumeAuthorizationCode(code, meta = {}) {
    return this.write((state) => {
      const codeHash = sha256(trimString(code));
      const record = state.authCodes[codeHash];
      if (!record) {
        throw new Error('Authorization code is invalid or expired');
      }

      if (record.consumedAt) {
        throw new Error('Authorization code has already been used');
      }

      if (meta.clientId && trimString(meta.clientId) !== record.clientId) {
        throw new Error('Authorization code client mismatch');
      }

      if (meta.redirectUri && trimString(meta.redirectUri) !== record.redirectUri) {
        throw new Error('Authorization code redirect URI mismatch');
      }

      record.consumedAt = new Date().toISOString();
      return record;
    });
  }

  async issueTokens(payload = {}) {
    return this.write((state) => {
      const brokerAccountId = trimString(payload.brokerAccountId);
      const accountLink = state.accountLinks[brokerAccountId];
      if (!accountLink) {
        throw new Error('Linked account not found');
      }

      const accessToken = randomToken(32);
      const refreshToken = randomToken(32);
      const accessTokenHash = sha256(accessToken);
      const refreshTokenHash = sha256(refreshToken);
      const now = Date.now();
      const scopes = uniqueStrings(payload.scopes || ['smart_home']);
      const timestamp = new Date().toISOString();

      state.accessTokens[accessTokenHash] = {
        tokenHash: accessTokenHash,
        brokerAccountId,
        hubId: accountLink.hubId,
        clientId: trimString(payload.clientId),
        scopes,
        locale: trimString(payload.locale) || accountLink.locale || 'en-US',
        createdAt: timestamp,
        lastUsedAt: timestamp,
        expiresAt: new Date(now + DEFAULT_ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
        revokedAt: null
      };

      state.refreshTokens[refreshTokenHash] = {
        tokenHash: refreshTokenHash,
        brokerAccountId,
        hubId: accountLink.hubId,
        clientId: trimString(payload.clientId),
        scopes,
        locale: trimString(payload.locale) || accountLink.locale || 'en-US',
        createdAt: timestamp,
        lastUsedAt: timestamp,
        expiresAt: new Date(now + DEFAULT_REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
        revokedAt: null
      };

      accountLink.lastSeenAt = timestamp;
      accountLink.updatedAt = timestamp;

      return {
        accessToken,
        refreshToken,
        tokenType: 'bearer',
        expiresIn: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
        scope: scopes.join(' '),
        brokerAccountId,
        hubId: accountLink.hubId
      };
    });
  }

  async rotateRefreshToken(refreshToken, meta = {}) {
    return this.write((state) => {
      const tokenHash = sha256(trimString(refreshToken));
      const refreshRecord = state.refreshTokens[tokenHash];
      if (!refreshRecord) {
        throw new Error('Refresh token is invalid or expired');
      }

      if (refreshRecord.revokedAt) {
        throw new Error('Refresh token has been revoked');
      }

      if (meta.clientId && trimString(meta.clientId) !== refreshRecord.clientId) {
        throw new Error('Refresh token client mismatch');
      }

      refreshRecord.revokedAt = new Date().toISOString();
      const accountLink = state.accountLinks[refreshRecord.brokerAccountId];
      if (!accountLink) {
        throw new Error('Linked account not found');
      }

      const accessToken = randomToken(32);
      const nextRefreshToken = randomToken(32);
      const accessTokenHash = sha256(accessToken);
      const nextRefreshTokenHash = sha256(nextRefreshToken);
      const now = Date.now();
      const scopes = uniqueStrings(refreshRecord.scopes || ['smart_home']);
      const timestamp = new Date().toISOString();

      state.accessTokens[accessTokenHash] = {
        tokenHash: accessTokenHash,
        brokerAccountId: refreshRecord.brokerAccountId,
        hubId: refreshRecord.hubId,
        clientId: refreshRecord.clientId,
        scopes,
        locale: refreshRecord.locale,
        createdAt: timestamp,
        lastUsedAt: timestamp,
        expiresAt: new Date(now + DEFAULT_ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
        revokedAt: null
      };

      state.refreshTokens[nextRefreshTokenHash] = {
        tokenHash: nextRefreshTokenHash,
        brokerAccountId: refreshRecord.brokerAccountId,
        hubId: refreshRecord.hubId,
        clientId: refreshRecord.clientId,
        scopes,
        locale: refreshRecord.locale,
        createdAt: timestamp,
        lastUsedAt: timestamp,
        expiresAt: new Date(now + DEFAULT_REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
        revokedAt: null
      };

      accountLink.lastSeenAt = timestamp;
      accountLink.updatedAt = timestamp;

      return {
        accessToken,
        refreshToken: nextRefreshToken,
        tokenType: 'bearer',
        expiresIn: DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
        scope: scopes.join(' '),
        brokerAccountId: refreshRecord.brokerAccountId,
        hubId: refreshRecord.hubId
      };
    });
  }

  async resolveAccessToken(token) {
    return this.write((state) => {
      const tokenHash = sha256(trimString(token));
      const accessToken = state.accessTokens[tokenHash];
      if (!accessToken) {
        throw new Error('Access token is invalid or expired');
      }

      if (accessToken.revokedAt) {
        throw new Error('Access token has been revoked');
      }

      const accountLink = state.accountLinks[accessToken.brokerAccountId];
      if (!accountLink || accountLink.status === 'revoked') {
        throw new Error('Linked account is no longer active');
      }

      const timestamp = new Date().toISOString();
      accessToken.lastUsedAt = timestamp;
      accountLink.lastSeenAt = timestamp;
      accountLink.updatedAt = timestamp;

      return {
        brokerAccountId: accessToken.brokerAccountId,
        hubId: accessToken.hubId,
        clientId: accessToken.clientId,
        scopes: accessToken.scopes,
        locale: accessToken.locale,
        expiresAt: accessToken.expiresAt,
        accountLink
      };
    });
  }

  async revokeAccessToken(token) {
    return this.write((state) => {
      const tokenHash = sha256(trimString(token));
      const accessToken = state.accessTokens[tokenHash];
      if (accessToken) {
        accessToken.revokedAt = new Date().toISOString();
      }
      return Boolean(accessToken);
    });
  }

  async recordPermissionGrant(payload = {}) {
    return this.write((state) => {
      const brokerAccountId = trimString(payload.brokerAccountId);
      const accountLink = state.accountLinks[brokerAccountId];
      if (!accountLink) {
        throw new Error('Linked account not found');
      }

      const permissionGrantId = randomIdentifier('hbgrant');
      const timestamp = new Date().toISOString();
      const record = {
        permissionGrantId,
        brokerAccountId,
        hubId: accountLink.hubId,
        grantCodeHash: sha256(trimString(payload.grantCode)),
        granteeTokenHash: sha256(trimString(payload.granteeToken)),
        permissionScopes: uniqueStrings(payload.permissionScopes || ['alexa::async_event:write']),
        createdAt: timestamp,
        updatedAt: timestamp,
        revokedAt: null,
        metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}
      };

      state.permissionGrants[permissionGrantId] = record;
      accountLink.permissions = uniqueStrings([...(accountLink.permissions || []), ...record.permissionScopes]);
      accountLink.acceptedGrantAt = timestamp;
      accountLink.updatedAt = timestamp;
      return record;
    });
  }

  async enqueueEvent(payload = {}) {
    return this.write((state) => {
      const record = {
        eventId: randomIdentifier('hbevent'),
        kind: trimString(payload.kind) || 'change_report',
        hubId: trimString(payload.hubId),
        brokerAccountId: trimString(payload.brokerAccountId),
        createdAt: new Date().toISOString(),
        status: trimString(payload.status) || 'queued',
        payload: payload.payload && typeof payload.payload === 'object' ? payload.payload : {},
        metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}
      };
      state.eventQueue.push(record);
      state.eventQueue = state.eventQueue.slice(-MAX_EVENT_QUEUE);
      return record;
    });
  }

  async listQueuedEvents(filters = {}) {
    return this.read((state) => (Array.isArray(state.eventQueue) ? state.eventQueue : [])
      .filter((entry) => (!filters.hubId || entry.hubId === filters.hubId))
      .filter((entry) => (!filters.status || entry.status === filters.status))
      .slice()
      .reverse());
  }

  async appendAudit(payload = {}) {
    return this.write((state) => {
      const record = {
        auditId: randomIdentifier('hbaudit'),
        type: trimString(payload.type) || 'info',
        hubId: trimString(payload.hubId),
        brokerAccountId: trimString(payload.brokerAccountId),
        createdAt: new Date().toISOString(),
        details: payload.details && typeof payload.details === 'object' ? payload.details : {},
        message: trimString(payload.message)
      };
      state.auditLog.push(record);
      state.auditLog = state.auditLog.slice(-MAX_AUDIT_LOG);
      return record;
    });
  }
}

module.exports = new BrokerStore();
module.exports.BrokerStore = BrokerStore;
module.exports.sha256 = sha256;
module.exports.randomIdentifier = randomIdentifier;

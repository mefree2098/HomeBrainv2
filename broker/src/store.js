const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_AUTH_CODE_TTL_MS = Math.max(60 * 1000, Number(process.env.HOMEBRAIN_ALEXA_AUTH_CODE_TTL_MS || 5 * 60 * 1000));
const DEFAULT_AUTH_CODE_REPLAY_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.HOMEBRAIN_ALEXA_AUTH_CODE_REPLAY_TTL_MS || 5 * 60 * 1000)
);
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = Math.max(300, Number(process.env.HOMEBRAIN_ALEXA_ACCESS_TOKEN_TTL_SECONDS || 60 * 60));
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 0;
const MAX_EVENT_QUEUE = 500;
const MAX_AUDIT_LOG = 500;
const STORE_BACKUP_SUFFIX = '.bak';
const DEFAULT_EVENT_PROCESSING_LEASE_MS = Math.max(
  30 * 1000,
  Number(process.env.HOMEBRAIN_ALEXA_EVENT_PROCESSING_LEASE_MS || 2 * 60 * 1000)
);
const DEFAULT_PERSIST_ATTEMPTS = Math.max(
  1,
  Number(process.env.HOMEBRAIN_ALEXA_STORE_PERSIST_ATTEMPTS || 3)
);
const TERMINAL_EVENT_STATUSES = new Set(['delivered', 'failed', 'skipped']);

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

function pkceS256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('base64url');
}

function secureEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString('base64url');
}

function randomIdentifier(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function permissionGrantKey(brokerAccountId, eventRegion = 'NA') {
  return `${trimString(brokerAccountId)}::${trimString(eventRegion || 'NA').toUpperCase()}`;
}

class BrokerOAuthGrantError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'BrokerOAuthGrantError';
    this.oauthError = 'invalid_grant';
    this.oauthStatus = 400;
    this.hubId = trimString(context.hubId);
    this.brokerAccountId = trimString(context.brokerAccountId);
  }
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function safeDateMs(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getRefreshTokenTtlSeconds() {
  const rawValue = trimString(process.env.HOMEBRAIN_ALEXA_REFRESH_TOKEN_TTL_SECONDS);
  if (!rawValue) {
    return DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_REFRESH_TOKEN_TTL_SECONDS;
  }

  return Math.max(0, parsed);
}

function getRefreshTokenExpiresAt(now = Date.now()) {
  const ttlSeconds = getRefreshTokenTtlSeconds();
  if (ttlSeconds <= 0) {
    return null;
  }

  return new Date(now + ttlSeconds * 1000).toISOString();
}

function defaultState() {
  return {
    version: 3,
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

function normalizeStoreState(value) {
  const parsed = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const state = {
    ...defaultState(),
    ...parsed
  };

  state.hubs = state.hubs && typeof state.hubs === 'object' && !Array.isArray(state.hubs) ? state.hubs : {};
  state.accountLinks = state.accountLinks && typeof state.accountLinks === 'object' && !Array.isArray(state.accountLinks) ? state.accountLinks : {};
  state.authCodes = state.authCodes && typeof state.authCodes === 'object' && !Array.isArray(state.authCodes) ? state.authCodes : {};
  state.accessTokens = state.accessTokens && typeof state.accessTokens === 'object' && !Array.isArray(state.accessTokens) ? state.accessTokens : {};
  state.refreshTokens = state.refreshTokens && typeof state.refreshTokens === 'object' && !Array.isArray(state.refreshTokens) ? state.refreshTokens : {};
  state.permissionGrants = state.permissionGrants && typeof state.permissionGrants === 'object' && !Array.isArray(state.permissionGrants) ? state.permissionGrants : {};
  state.eventQueue = Array.isArray(state.eventQueue) ? state.eventQueue : [];
  state.auditLog = Array.isArray(state.auditLog) ? state.auditLog : [];
  state.version = Math.max(3, Number(state.version || 0));

  return state;
}

function persistentRecordCounts(state = {}) {
  return {
    hubs: Object.keys(state.hubs || {}).length,
    accountLinks: Object.keys(state.accountLinks || {}).length,
    refreshTokens: Object.keys(state.refreshTokens || {}).length,
    permissionGrants: Object.keys(state.permissionGrants || {}).length
  };
}

function persistentRecordTotal(state = {}) {
  const counts = persistentRecordCounts(state);
  return counts.hubs + counts.accountLinks + counts.refreshTokens + counts.permissionGrants;
}

function shouldRefuseEmptyOverwrite(existingState, nextState) {
  if (!existingState) {
    return false;
  }

  const existingCounts = persistentRecordCounts(existingState);
  const nextCounts = persistentRecordCounts(nextState);
  return (existingCounts.hubs > 0 && nextCounts.hubs === 0)
    || (persistentRecordTotal(existingState) > 0 && persistentRecordTotal(nextState) === 0);
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

function appendAuditRecord(state, payload = {}) {
  const record = {
    auditId: randomIdentifier('hbaudit'),
    type: trimString(payload.type) || 'info',
    hubId: trimString(payload.hubId),
    brokerAccountId: trimString(payload.brokerAccountId),
    createdAt: new Date().toISOString(),
    severity: trimString(payload.severity) || 'info',
    details: payload.details && typeof payload.details === 'object' ? payload.details : {},
    message: trimString(payload.message)
  };
  state.auditLog.push(record);
  state.auditLog = state.auditLog.slice(-MAX_AUDIT_LOG);
  return record;
}

function compactEventQueue(state, { enforceLimit = false } = {}) {
  const queue = Array.isArray(state.eventQueue) ? state.eventQueue : [];
  while (queue.length > MAX_EVENT_QUEUE) {
    const terminalIndex = queue.findIndex((entry) => TERMINAL_EVENT_STATUSES.has(trimString(entry?.status)));
    if (terminalIndex < 0) {
      if (enforceLimit) {
        throw new Error(`Alexa event queue capacity of ${MAX_EVENT_QUEUE} active events has been reached`);
      }
      break;
    }
    queue.splice(terminalIndex, 1);
  }
  state.eventQueue = queue;
}

function pruneExpiredEntries(state) {
  const now = Date.now();

  Object.keys(state.authCodes || {}).forEach((key) => {
    const entry = state.authCodes[key];
    const expiresAt = safeDateMs(entry?.expiresAt);
    const replayExpiresAt = safeDateMs(entry?.replayExpiresAt)
      || (safeDateMs(entry?.consumedAt) + DEFAULT_AUTH_CODE_REPLAY_TTL_MS);
    if (
      !entry
      || (!entry.consumedAt && expiresAt <= now)
      || (entry.consumedAt && replayExpiresAt <= now)
    ) {
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
    if (!entry || entry.revokedAt) {
      delete state.refreshTokens[key];
    }
  });

  const refreshBackedAccountIds = new Set(Object.values(state.refreshTokens || {})
    .filter((entry) => entry && !entry.revokedAt)
    .map((entry) => entry.brokerAccountId));
  Object.values(state.accountLinks || {}).forEach((account) => {
    if (!account) {
      return;
    }
    if (account.status === 'linked' && !refreshBackedAccountIds.has(account.brokerAccountId)) {
      account.status = 'error';
      account.metadata = {
        ...(account.metadata || {}),
        credentialError: 'missing_refresh_token',
        credentialErrorAt: account.metadata?.credentialErrorAt || new Date(now).toISOString()
      };
      account.updatedAt = new Date(now).toISOString();
    } else if (
      account.status === 'error'
      && account.metadata?.credentialError === 'missing_refresh_token'
      && refreshBackedAccountIds.has(account.brokerAccountId)
    ) {
      account.status = 'linked';
      account.metadata = {
        ...(account.metadata || {}),
        credentialError: '',
        credentialRecoveredAt: new Date(now).toISOString()
      };
      account.updatedAt = new Date(now).toISOString();
    }
  });

  // Keep revoked and errored permission grants as durable diagnostics. Removing
  // them made a failed relink look as though AcceptGrant had never arrived.
  compactEventQueue(state);
  state.auditLog = (Array.isArray(state.auditLog) ? state.auditLog : []).slice(-MAX_AUDIT_LOG);
}

function normalizeAccountStatus(value, fallback = 'linked') {
  const normalized = trimString(value);
  return ['pending', 'linked', 'revoked', 'error'].includes(normalized) ? normalized : fallback;
}

function upsertAccountLinkRecord(state, payload = {}) {
  const timestamp = new Date().toISOString();
  const hub = ensureHubRecord(state, payload.hubId);
  const brokerAccountId = trimString(payload.brokerAccountId) || randomIdentifier('hbacct');
  const existing = state.accountLinks[brokerAccountId] || {};
  const status = normalizeAccountStatus(payload.status, normalizeAccountStatus(existing.status, 'linked'));
  const has = (key) => Object.prototype.hasOwnProperty.call(payload, key);

  const next = {
    brokerAccountId,
    hubId: hub.hubId,
    alexaUserId: has('alexaUserId') ? trimString(payload.alexaUserId) : trimString(existing.alexaUserId),
    alexaAccountId: has('alexaAccountId') ? trimString(payload.alexaAccountId) : trimString(existing.alexaAccountId),
    alexaHouseholdId: has('alexaHouseholdId') ? trimString(payload.alexaHouseholdId) : trimString(existing.alexaHouseholdId),
    locale: has('locale') ? (trimString(payload.locale) || 'en-US') : (trimString(existing.locale) || 'en-US'),
    status,
    permissions: uniqueStrings(has('permissions') ? payload.permissions : existing.permissions || []),
    acceptedGrantAt: has('acceptedGrantAt') ? payload.acceptedGrantAt : (existing.acceptedGrantAt || null),
    linkedAt: status === 'linked'
      ? (has('linkedAt') ? (payload.linkedAt || existing.linkedAt || timestamp) : (existing.linkedAt || timestamp))
      : (has('linkedAt') ? payload.linkedAt : (existing.linkedAt || null)),
    lastDiscoveryAt: has('lastDiscoveryAt') ? payload.lastDiscoveryAt : (existing.lastDiscoveryAt || null),
    lastSeenAt: has('lastSeenAt') ? payload.lastSeenAt : (existing.lastSeenAt || timestamp),
    metadata: payload.metadata && typeof payload.metadata === 'object'
      ? { ...(existing.metadata || {}), ...payload.metadata }
      : (existing.metadata || {}),
    createdAt: existing.createdAt || timestamp,
    updatedAt: timestamp
  };

  state.accountLinks[brokerAccountId] = next;
  hub.updatedAt = timestamp;
  return next;
}

function createAuthorizationCodeRecord(state, payload = {}) {
  const brokerAccountId = trimString(payload.brokerAccountId);
  const accountLink = state.accountLinks[brokerAccountId];
  if (!accountLink) {
    throw new Error('Alexa account authorization was not found');
  }

  const code = randomToken(24);
  const codeHash = sha256(code);
  const timestamp = new Date();
  const codeChallenge = trimString(payload.codeChallenge);
  const codeChallengeMethod = trimString(payload.codeChallengeMethod);
  state.authCodes[codeHash] = {
    codeHash,
    brokerAccountId,
    hubId: accountLink.hubId,
    clientId: trimString(payload.clientId),
    redirectUri: trimString(payload.redirectUri),
    scopes: uniqueStrings(payload.scopes || ['smart_home']),
    locale: trimString(payload.locale) || accountLink.locale || 'en-US',
    codeChallenge,
    codeChallengeMethod: codeChallenge ? codeChallengeMethod : '',
    createdAt: timestamp.toISOString(),
    expiresAt: new Date(timestamp.getTime() + DEFAULT_AUTH_CODE_TTL_MS).toISOString(),
    consumedAt: null,
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}
  };

  return {
    code,
    expiresAt: state.authCodes[codeHash].expiresAt,
    record: state.authCodes[codeHash]
  };
}

function validateAuthorizationCodeRecord(state, code, meta = {}, options = {}) {
  const codeHash = sha256(trimString(code));
  const record = state.authCodes[codeHash];
  if (!record) {
    throw new BrokerOAuthGrantError('Authorization code is invalid or expired', record || {});
  }
  const replayExpiresAt = safeDateMs(record.replayExpiresAt)
    || (safeDateMs(record.consumedAt) + DEFAULT_AUTH_CODE_REPLAY_TTL_MS);
  if ((!record.consumedAt && safeDateMs(record.expiresAt) <= Date.now())
    || (record.consumedAt && replayExpiresAt <= Date.now())) {
    throw new BrokerOAuthGrantError('Authorization code is invalid or expired', record);
  }
  if (meta.clientId && trimString(meta.clientId) !== record.clientId) {
    throw new BrokerOAuthGrantError('Authorization code client mismatch', record);
  }
  if (meta.redirectUri && trimString(meta.redirectUri) !== record.redirectUri) {
    throw new BrokerOAuthGrantError('Authorization code redirect URI mismatch', record);
  }

  const codeChallenge = trimString(record.codeChallenge);
  if (codeChallenge) {
    const verifier = trimString(meta.codeVerifier);
    if (!verifier) {
      throw new BrokerOAuthGrantError('PKCE code_verifier is required', record);
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      throw new BrokerOAuthGrantError('PKCE code_verifier is invalid', record);
    }
    if (record.codeChallengeMethod !== 'S256' || !secureEqual(pkceS256(verifier), codeChallenge)) {
      throw new BrokerOAuthGrantError('PKCE code_verifier is invalid', record);
    }
  }

  if (record.consumedAt && options.allowConsumed !== true) {
    throw new BrokerOAuthGrantError('Authorization code has already been used', record);
  }

  return record;
}

function issueTokensInState(state, payload = {}) {
  const brokerAccountId = trimString(payload.brokerAccountId);
  const accountLink = state.accountLinks[brokerAccountId];
  if (!accountLink || accountLink.status === 'revoked') {
    throw new BrokerOAuthGrantError('Linked account is no longer active', {
      brokerAccountId,
      hubId: accountLink?.hubId
    });
  }

  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const accessTokenHash = sha256(accessToken);
  const refreshTokenHash = sha256(refreshToken);
  const now = Date.now();
  const scopes = uniqueStrings(payload.scopes || ['smart_home']);
  const timestamp = new Date(now).toISOString();

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
    expiresAt: getRefreshTokenExpiresAt(now),
    revokedAt: null
  };

  accountLink.status = 'linked';
  accountLink.linkedAt = accountLink.linkedAt || timestamp;
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
}

class BrokerStore {
  constructor(options = {}) {
    this.filePath = options.filePath
      || trimString(process.env.HOMEBRAIN_BROKER_STORE_FILE)
      || path.join(__dirname, '..', 'data', 'store.json');
    this.state = options.state ? normalizeStoreState(clone(options.state)) : null;
    this.initialized = Boolean(options.state);
    this.initializing = null;
    this.pending = Promise.resolve();
    this.lastPersistence = {
      lastSuccessAt: null,
      lastErrorAt: null,
      lastError: '',
      backupError: ''
    };
  }

  getBackupFilePath() {
    return `${this.filePath}${STORE_BACKUP_SUFFIX}`;
  }

  async readStateFile(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    return normalizeStoreState(JSON.parse(raw || '{}'));
  }

  async init() {
    if (this.initialized) {
      return;
    }

    if (this.initializing) {
      return this.initializing;
    }

    this.initializing = this.initializeState();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async initializeState() {
    if (this.initialized) {
      return;
    }

    try {
      this.state = await this.readStateFile(this.filePath);
    } catch (error) {
      const primaryMissing = error.code === 'ENOENT';
      try {
        this.state = await this.readStateFile(this.getBackupFilePath());
        await this.persist({
          state: this.state,
          skipBackupRefresh: true
        });
      } catch (backupError) {
        if (!primaryMissing) {
          throw error;
        }
        if (backupError.code !== 'ENOENT') {
          throw backupError;
        }

        this.state = defaultState();
        await this.persist({
          state: this.state,
          allowEmptyOverwrite: true,
          skipBackupRefresh: true
        });
      }
    }

    pruneExpiredEntries(this.state);
    this.initialized = true;
  }

  async persist(options = {}) {
    const stateToPersist = normalizeStoreState(clone(options.state || this.state));
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });

    let existingState = null;
    try {
      existingState = await this.readStateFile(this.filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        try {
          existingState = await this.readStateFile(this.getBackupFilePath());
        } catch (_backupError) {
          existingState = null;
        }
      }
    }

    if (options.allowEmptyOverwrite !== true && shouldRefuseEmptyOverwrite(existingState, stateToPersist)) {
      throw new Error('Refusing to overwrite non-empty Alexa broker store with an empty hub state');
    }

    const serialized = JSON.stringify(stateToPersist, null, 2);
    let persisted = false;
    let lastError = null;
    for (let attempt = 1; attempt <= DEFAULT_PERSIST_ATTEMPTS; attempt += 1) {
      const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
      try {
        const handle = await fs.open(temporaryPath, 'w', 0o600);
        try {
          await handle.writeFile(serialized, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporaryPath, this.filePath);
        await fs.chmod(this.filePath, 0o600).catch(() => {});
        persisted = true;
        break;
      } catch (error) {
        lastError = error;
        await fs.unlink(temporaryPath).catch(() => {});
        if (attempt < DEFAULT_PERSIST_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 25));
        }
      }
    }

    if (!persisted) {
      this.lastPersistence.lastErrorAt = new Date().toISOString();
      this.lastPersistence.lastError = lastError?.message || 'Unknown broker store persistence failure';
      throw lastError || new Error(this.lastPersistence.lastError);
    }

    this.lastPersistence.lastSuccessAt = new Date().toISOString();
    this.lastPersistence.lastError = '';

    if (options.skipBackupRefresh !== true) {
      try {
        await fs.copyFile(this.filePath, this.getBackupFilePath());
        await fs.chmod(this.getBackupFilePath(), 0o600).catch(() => {});
        this.lastPersistence.backupError = '';
      } catch (error) {
        this.lastPersistence.backupError = error.message;
      }
    }
  }

  async runExclusive(task) {
    const next = this.pending.then(task, task);
    this.pending = next.catch(() => {});
    return next;
  }

  async read(task) {
    await this.init();
    const snapshot = normalizeStoreState(clone(this.state));
    pruneExpiredEntries(snapshot);
    return clone(await task(snapshot));
  }

  async write(task) {
    return this.runExclusive(async () => {
      await this.init();
      const workingState = normalizeStoreState(clone(this.state));
      pruneExpiredEntries(workingState);
      const result = await task(workingState);
      pruneExpiredEntries(workingState);
      await this.persist({ state: workingState });
      this.state = workingState;
      return clone(result);
    });
  }

  async getStorageHealth() {
    await this.init();
    const inspect = async (filePath) => {
      try {
        const [state, stat] = await Promise.all([
          this.readStateFile(filePath),
          fs.stat(filePath)
        ]);
        return {
          available: true,
          valid: true,
          bytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          records: persistentRecordCounts(state),
          error: ''
        };
      } catch (error) {
        return {
          available: error.code !== 'ENOENT',
          valid: false,
          bytes: 0,
          modifiedAt: null,
          records: persistentRecordCounts(),
          error: error.code === 'ENOENT' ? 'missing' : error.message
        };
      }
    };

    const [primary, backup] = await Promise.all([
      inspect(this.filePath),
      inspect(this.getBackupFilePath())
    ]);
    return {
      primary,
      backup,
      ...clone(this.lastPersistence)
    };
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
        customSkillUrl: trimString(payload.customSkillUrl),
        healthUrl: trimString(payload.healthUrl),
        accountsUrl: trimString(payload.accountsUrl),
        linkAccountUrl: trimString(payload.linkAccountUrl),
        customSkillDispatchUrl: trimString(payload.customSkillDispatchUrl),
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
    return this.write((state) => upsertAccountLinkRecord(state, payload));
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

      if (account.status === 'linked' && !account.linkedAt) {
        account.linkedAt = timestamp;
      }

      return account;
    });
  }

  async getAccountLink(brokerAccountId) {
    return this.read((state) => state.accountLinks[trimString(brokerAccountId)] || null);
  }

  async touchAccountDiscovery(brokerAccountId, metadata = {}) {
    return this.updateAccountLink(brokerAccountId, {
      lastDiscoveryAt: new Date().toISOString(),
      metadata
    });
  }

  async createAuthorizationCode(payload = {}) {
    return this.write((state) => {
      const authorizationCode = createAuthorizationCodeRecord(state, payload);
      return {
        code: authorizationCode.code,
        expiresAt: authorizationCode.expiresAt
      };
    });
  }

  async createAuthorizationGrant(payload = {}) {
    return this.write((state) => {
      const accountLink = upsertAccountLinkRecord(state, {
        brokerAccountId: payload.brokerAccountId,
        hubId: payload.hubId,
        locale: payload.locale,
        status: 'pending',
        metadata: payload.accountMetadata
      });
      const authorizationCode = createAuthorizationCodeRecord(state, {
        brokerAccountId: accountLink.brokerAccountId,
        clientId: payload.clientId,
        redirectUri: payload.redirectUri,
        scopes: payload.scopes,
        locale: accountLink.locale,
        codeChallenge: payload.codeChallenge,
        codeChallengeMethod: payload.codeChallengeMethod,
        metadata: payload.codeMetadata
      });

      appendAuditRecord(state, {
        type: 'oauth_authorize_success',
        hubId: accountLink.hubId,
        brokerAccountId: accountLink.brokerAccountId,
        message: 'Alexa account-link authorization code issued',
        details: {
          clientId: trimString(payload.clientId),
          redirectUri: trimString(payload.redirectUri),
          pkce: Boolean(trimString(payload.codeChallenge))
        }
      });

      return {
        accountLink,
        authorizationCode: {
          code: authorizationCode.code,
          expiresAt: authorizationCode.expiresAt
        }
      };
    });
  }

  async consumeAuthorizationCode(code, meta = {}) {
    return this.write((state) => {
      const record = validateAuthorizationCodeRecord(state, code, meta);
      record.consumedAt = new Date().toISOString();
      record.replayExpiresAt = new Date(Date.now() + DEFAULT_AUTH_CODE_REPLAY_TTL_MS).toISOString();
      return record;
    });
  }

  async issueTokens(payload = {}) {
    return this.write((state) => issueTokensInState(state, payload));
  }

  async exchangeAuthorizationCode(code, meta = {}) {
    return this.write((state) => {
      const record = validateAuthorizationCodeRecord(state, code, meta, { allowConsumed: true });
      if (record.consumedAt) {
        if (!record.exchangeResult?.accessToken || !record.exchangeResult?.refreshToken) {
          throw new BrokerOAuthGrantError('Authorization code has already been used', record);
        }
        appendAuditRecord(state, {
          type: 'oauth_token_exchange_replayed',
          hubId: record.hubId,
          brokerAccountId: record.brokerAccountId,
          message: 'Alexa retried a completed authorization-code exchange; the original durable token response was replayed',
          details: {
            clientId: record.clientId,
            requestId: trimString(meta.requestId),
            pkce: Boolean(trimString(record.codeChallenge))
          }
        });
        return record.exchangeResult;
      }

      const tokens = issueTokensInState(state, {
        brokerAccountId: record.brokerAccountId,
        clientId: record.clientId,
        scopes: record.scopes,
        locale: record.locale
      });
      record.consumedAt = new Date().toISOString();
      record.replayExpiresAt = new Date(Date.now() + DEFAULT_AUTH_CODE_REPLAY_TTL_MS).toISOString();
      record.exchangeResult = tokens;
      appendAuditRecord(state, {
        type: 'oauth_token_exchange_succeeded',
        hubId: record.hubId,
        brokerAccountId: record.brokerAccountId,
        message: 'Alexa exchanged its authorization code for durable account tokens',
        details: {
          clientId: record.clientId,
          requestId: trimString(meta.requestId),
          pkce: Boolean(trimString(record.codeChallenge))
        }
      });
      return tokens;
    });
  }

  async refreshAccessToken(refreshToken, meta = {}) {
    return this.write((state) => {
      const normalizedRefreshToken = trimString(refreshToken);
      const tokenHash = sha256(normalizedRefreshToken);
      const refreshRecord = state.refreshTokens[tokenHash];
      if (!refreshRecord) {
        throw new BrokerOAuthGrantError('Refresh token is invalid or expired');
      }

      if (refreshRecord.revokedAt) {
        throw new BrokerOAuthGrantError('Refresh token has been revoked', refreshRecord);
      }

      if (meta.clientId && trimString(meta.clientId) !== refreshRecord.clientId) {
        throw new BrokerOAuthGrantError('Refresh token client mismatch', refreshRecord);
      }

      const accountLink = state.accountLinks[refreshRecord.brokerAccountId];
      if (!accountLink || accountLink.status !== 'linked') {
        throw new BrokerOAuthGrantError('Linked account is no longer active', refreshRecord);
      }

      const accessToken = randomToken(32);
      const accessTokenHash = sha256(accessToken);
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

      // Alexa can retry a refresh from another edge after the first response has
      // already been issued. Keep the durable refresh token valid so that retry
      // does not receive invalid_grant and unlink the household.
      refreshRecord.lastUsedAt = timestamp;
      refreshRecord.expiresAt = getRefreshTokenExpiresAt(now);

      accountLink.lastSeenAt = timestamp;
      accountLink.updatedAt = timestamp;

      appendAuditRecord(state, {
        type: 'oauth_token_refresh_succeeded',
        hubId: refreshRecord.hubId,
        brokerAccountId: refreshRecord.brokerAccountId,
        message: 'Alexa renewed its access token with the durable refresh token',
        details: {
          clientId: refreshRecord.clientId,
          requestId: trimString(meta.requestId),
          refreshTokenFingerprint: tokenHash.slice(0, 12),
          durableRefreshTokenReused: true
        }
      });

      return {
        accessToken,
        refreshToken: normalizedRefreshToken,
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
      if (!accountLink || accountLink.status !== 'linked') {
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
      if (!accountLink || accountLink.status !== 'linked') {
        throw new Error('Linked account is not active');
      }

      const eventRegion = trimString(payload.eventRegion || 'NA').toUpperCase() || 'NA';
      const permissionGrantId = permissionGrantKey(brokerAccountId, eventRegion);
      const timestamp = new Date().toISOString();
      const existing = state.permissionGrants[permissionGrantId] || {};
      const record = {
        permissionGrantId,
        brokerAccountId,
        hubId: accountLink.hubId,
        eventRegion,
        eventGatewayUrl: trimString(payload.eventGatewayUrl || existing.eventGatewayUrl),
        lwaTokenUrl: trimString(payload.lwaTokenUrl || existing.lwaTokenUrl),
        grantCodeHash: sha256(trimString(payload.grantCode)),
        granteeTokenHash: sha256(trimString(payload.granteeToken)),
        permissionScopes: uniqueStrings(payload.permissionScopes || existing.permissionScopes || ['alexa::async_event:write']),
        accessToken: Object.prototype.hasOwnProperty.call(payload, 'accessToken') ? trimString(payload.accessToken) : trimString(existing.accessToken),
        refreshToken: Object.prototype.hasOwnProperty.call(payload, 'refreshToken') ? trimString(payload.refreshToken) : trimString(existing.refreshToken),
        tokenType: trimString(payload.tokenType || existing.tokenType || 'bearer') || 'bearer',
        tokenExpiresAt: payload.tokenExpiresAt || existing.tokenExpiresAt || null,
        lastRefreshedAt: payload.lastRefreshedAt || existing.lastRefreshedAt || timestamp,
        lastUsedAt: payload.lastUsedAt || existing.lastUsedAt || null,
        lastError: trimString(payload.lastError || ''),
        status: trimString(payload.status || existing.status || 'active') || 'active',
        createdAt: existing.createdAt || timestamp,
        acceptedAt: timestamp,
        updatedAt: timestamp,
        revokedAt: payload.status === 'revoked' ? (payload.revokedAt || timestamp) : null,
        metadata: payload.metadata && typeof payload.metadata === 'object'
          ? { ...(existing.metadata || {}), ...payload.metadata }
          : (existing.metadata || {})
      };

      state.permissionGrants[permissionGrantId] = record;
      accountLink.permissions = uniqueStrings([...(accountLink.permissions || []), ...record.permissionScopes]);
      accountLink.acceptedGrantAt = timestamp;
      accountLink.updatedAt = timestamp;
      return record;
    });
  }

  async updatePermissionGrant(permissionGrantId, updates = {}) {
    return this.write((state) => {
      const record = state.permissionGrants[trimString(permissionGrantId)];
      if (!record) {
        throw new Error('Permission grant not found');
      }

      const timestamp = new Date().toISOString();
      Object.assign(record, {
        eventGatewayUrl: Object.prototype.hasOwnProperty.call(updates, 'eventGatewayUrl') ? trimString(updates.eventGatewayUrl) : record.eventGatewayUrl,
        lwaTokenUrl: Object.prototype.hasOwnProperty.call(updates, 'lwaTokenUrl') ? trimString(updates.lwaTokenUrl) : record.lwaTokenUrl,
        permissionScopes: Object.prototype.hasOwnProperty.call(updates, 'permissionScopes')
          ? uniqueStrings(updates.permissionScopes)
          : uniqueStrings(record.permissionScopes),
        accessToken: Object.prototype.hasOwnProperty.call(updates, 'accessToken') ? trimString(updates.accessToken) : record.accessToken,
        refreshToken: Object.prototype.hasOwnProperty.call(updates, 'refreshToken') ? trimString(updates.refreshToken) : record.refreshToken,
        tokenType: Object.prototype.hasOwnProperty.call(updates, 'tokenType') ? (trimString(updates.tokenType) || record.tokenType) : record.tokenType,
        tokenExpiresAt: Object.prototype.hasOwnProperty.call(updates, 'tokenExpiresAt') ? updates.tokenExpiresAt : record.tokenExpiresAt,
        lastRefreshedAt: Object.prototype.hasOwnProperty.call(updates, 'lastRefreshedAt') ? updates.lastRefreshedAt : record.lastRefreshedAt,
        acceptedAt: Object.prototype.hasOwnProperty.call(updates, 'acceptedAt') ? updates.acceptedAt : record.acceptedAt,
        lastUsedAt: Object.prototype.hasOwnProperty.call(updates, 'lastUsedAt') ? updates.lastUsedAt : record.lastUsedAt,
        lastError: Object.prototype.hasOwnProperty.call(updates, 'lastError') ? trimString(updates.lastError) : record.lastError,
        status: Object.prototype.hasOwnProperty.call(updates, 'status') ? (trimString(updates.status) || record.status) : record.status,
        revokedAt: Object.prototype.hasOwnProperty.call(updates, 'revokedAt') ? updates.revokedAt : record.revokedAt,
        metadata: updates.metadata && typeof updates.metadata === 'object'
          ? { ...(record.metadata || {}), ...updates.metadata }
          : record.metadata,
        updatedAt: timestamp
      });

      if (record.status === 'active' && !Object.prototype.hasOwnProperty.call(updates, 'revokedAt')) {
        record.revokedAt = null;
      }

      return record;
    });
  }

  async listPermissionGrants(filters = {}) {
    return this.read((state) => Object.values(state.permissionGrants || {})
      .filter((entry) => (!filters.hubId || entry.hubId === filters.hubId))
      .filter((entry) => (!filters.brokerAccountId || entry.brokerAccountId === filters.brokerAccountId))
      .filter((entry) => (!filters.status || entry.status === filters.status))
      .sort((left, right) => new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime()));
  }

  async listActivePermissionGrants(filters = {}) {
    return this.listPermissionGrants(filters)
      .then((list) => list.filter((entry) => entry.status === 'active' && !entry.revokedAt && entry.accessToken));
  }

  async getPermissionGrant(permissionGrantId) {
    return this.read((state) => state.permissionGrants[trimString(permissionGrantId)] || null);
  }

  async findPermissionGrantByGrantCode(grantCode, filters = {}) {
    const grantCodeHash = sha256(trimString(grantCode));
    return this.read((state) => Object.values(state.permissionGrants || {})
      .find((entry) => entry.grantCodeHash === grantCodeHash
        && (!filters.brokerAccountId || entry.brokerAccountId === filters.brokerAccountId)
        && (!filters.hubId || entry.hubId === filters.hubId)) || null);
  }

  async revokePermissionGrant(permissionGrantId, options = {}) {
    return this.write((state) => {
      const record = state.permissionGrants[trimString(permissionGrantId)];
      if (!record) {
        throw new Error('Permission grant not found');
      }

      const timestamp = new Date().toISOString();
      record.status = 'revoked';
      record.revokedAt = timestamp;
      record.lastError = trimString(options.reason || record.lastError || 'Permission grant revoked');
      record.updatedAt = timestamp;

      (Array.isArray(state.eventQueue) ? state.eventQueue : [])
        .filter((entry) => entry.permissionGrantId === record.permissionGrantId && (entry.status === 'queued' || entry.status === 'processing'))
        .forEach((entry) => {
          entry.status = 'skipped';
          entry.lastError = record.lastError;
          entry.updatedAt = timestamp;
        });

      return record;
    });
  }

  async revokeAccountLink(brokerAccountId, options = {}) {
    return this.write((state) => {
      const account = state.accountLinks[trimString(brokerAccountId)];
      if (!account) {
        throw new Error('Linked account not found');
      }

      const timestamp = new Date().toISOString();
      account.status = 'revoked';
      account.permissions = [];
      account.updatedAt = timestamp;
      account.metadata = {
        ...(account.metadata || {}),
        revokedAt: timestamp,
        revokeReason: trimString(options.reason || 'Linked account revoked')
      };

      Object.values(state.accessTokens || {})
        .filter((entry) => entry.brokerAccountId === account.brokerAccountId && !entry.revokedAt)
        .forEach((entry) => {
          entry.revokedAt = timestamp;
        });

      Object.values(state.refreshTokens || {})
        .filter((entry) => entry.brokerAccountId === account.brokerAccountId && !entry.revokedAt)
        .forEach((entry) => {
          entry.revokedAt = timestamp;
        });

      Object.values(state.permissionGrants || {})
        .filter((entry) => entry.brokerAccountId === account.brokerAccountId && !entry.revokedAt)
        .forEach((entry) => {
          entry.status = 'revoked';
          entry.revokedAt = timestamp;
          entry.lastError = trimString(options.reason || 'Linked account revoked');
          entry.updatedAt = timestamp;
        });

      (Array.isArray(state.eventQueue) ? state.eventQueue : [])
        .filter((entry) => entry.brokerAccountId === account.brokerAccountId && (entry.status === 'queued' || entry.status === 'processing'))
        .forEach((entry) => {
          entry.status = 'skipped';
          entry.lastError = trimString(options.reason || 'Linked account revoked');
          entry.updatedAt = timestamp;
        });

      return account;
    });
  }

  async enqueueEvent(payload = {}) {
    const records = await this.enqueueEvents([payload]);
    return records[0];
  }

  async enqueueEvents(payloads = []) {
    return this.write((state) => {
      const timestamp = new Date().toISOString();
      const records = (Array.isArray(payloads) ? payloads : [payloads])
        .filter((payload) => payload && typeof payload === 'object')
        .map((payload) => ({
          eventId: randomIdentifier('hbevent'),
          kind: trimString(payload.kind) || 'change_report',
          hubId: trimString(payload.hubId),
          brokerAccountId: trimString(payload.brokerAccountId),
          permissionGrantId: trimString(payload.permissionGrantId),
          createdAt: timestamp,
          status: trimString(payload.status) || 'queued',
          attempts: Math.max(0, Number(payload.attempts || 0)),
          maxAttempts: Math.max(1, Number(payload.maxAttempts || 3)),
          lastAttemptAt: payload.lastAttemptAt || null,
          processingStartedAt: payload.processingStartedAt || null,
          leaseExpiresAt: payload.leaseExpiresAt || null,
          nextAttemptAt: payload.nextAttemptAt || timestamp,
          deliveredAt: payload.deliveredAt || null,
          lastError: trimString(payload.lastError || ''),
          payload: payload.payload && typeof payload.payload === 'object' ? payload.payload : {},
          metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}
        }));
      state.eventQueue.push(...records);
      compactEventQueue(state, { enforceLimit: true });
      return records;
    });
  }

  async listQueuedEvents(filters = {}) {
    return this.read((state) => (Array.isArray(state.eventQueue) ? state.eventQueue : [])
      .filter((entry) => (!filters.hubId || entry.hubId === filters.hubId))
      .filter((entry) => (!filters.brokerAccountId || entry.brokerAccountId === filters.brokerAccountId))
      .filter((entry) => (!filters.status || entry.status === filters.status))
      .slice()
      .reverse());
  }

  async reserveQueuedEvents(options = {}) {
    return this.write((state) => {
      const limit = Math.max(1, Number(options.limit || 25));
      const now = Date.now();
      const selected = [];

      for (const entry of Array.isArray(state.eventQueue) ? state.eventQueue : []) {
        if (entry.status !== 'processing') {
          continue;
        }
        const leaseExpiresAt = safeDateMs(entry.leaseExpiresAt)
          || (safeDateMs(entry.processingStartedAt || entry.lastAttemptAt) + DEFAULT_EVENT_PROCESSING_LEASE_MS);
        if (!leaseExpiresAt || leaseExpiresAt <= now) {
          entry.status = 'queued';
          entry.processingStartedAt = null;
          entry.leaseExpiresAt = null;
          entry.nextAttemptAt = new Date(now).toISOString();
          entry.lastError = trimString(entry.lastError) || 'Recovered after an interrupted Alexa event dispatch';
          entry.updatedAt = new Date(now).toISOString();
        }
      }

      for (const entry of Array.isArray(state.eventQueue) ? state.eventQueue : []) {
        if (selected.length >= limit) {
          break;
        }
        if (entry.status !== 'queued') {
          continue;
        }
        if (options.hubId && entry.hubId !== options.hubId) {
          continue;
        }
        if (entry.nextAttemptAt && new Date(entry.nextAttemptAt).getTime() > now) {
          continue;
        }

        entry.status = 'processing';
        entry.attempts = Math.max(0, Number(entry.attempts || 0)) + 1;
        entry.lastAttemptAt = new Date(now).toISOString();
        entry.processingStartedAt = new Date(now).toISOString();
        entry.leaseExpiresAt = new Date(now + DEFAULT_EVENT_PROCESSING_LEASE_MS).toISOString();
        selected.push(entry);
      }

      return selected;
    });
  }

  async finalizeQueuedEvent(eventId, updates = {}) {
    return this.write((state) => {
      const entry = (Array.isArray(state.eventQueue) ? state.eventQueue : [])
        .find((candidate) => candidate.eventId === trimString(eventId));
      if (!entry) {
        throw new Error('Queued event not found');
      }

      const timestamp = new Date().toISOString();
      Object.assign(entry, {
        status: Object.prototype.hasOwnProperty.call(updates, 'status') ? trimString(updates.status) : entry.status,
        deliveredAt: Object.prototype.hasOwnProperty.call(updates, 'deliveredAt') ? updates.deliveredAt : entry.deliveredAt,
        nextAttemptAt: Object.prototype.hasOwnProperty.call(updates, 'nextAttemptAt') ? updates.nextAttemptAt : entry.nextAttemptAt,
        maxAttempts: Object.prototype.hasOwnProperty.call(updates, 'maxAttempts')
          ? Math.max(1, Number(updates.maxAttempts || entry.maxAttempts || 3))
          : entry.maxAttempts,
        lastError: Object.prototype.hasOwnProperty.call(updates, 'lastError') ? trimString(updates.lastError) : entry.lastError,
        processingStartedAt: null,
        leaseExpiresAt: null,
        metadata: updates.metadata && typeof updates.metadata === 'object'
          ? { ...(entry.metadata || {}), ...updates.metadata }
          : entry.metadata,
        updatedAt: timestamp
      });

      return entry;
    });
  }

  async appendAudit(payload = {}) {
    return this.write((state) => appendAuditRecord(state, payload));
  }

  async listAuditLog(filters = {}) {
    return this.read((state) => (Array.isArray(state.auditLog) ? state.auditLog : [])
      .filter((entry) => (!filters.hubId || entry.hubId === filters.hubId))
      .filter((entry) => (!filters.brokerAccountId || entry.brokerAccountId === filters.brokerAccountId))
      .filter((entry) => (!filters.type || entry.type === filters.type))
      .slice()
      .reverse()
      .slice(0, Math.max(1, Number(filters.limit || 50))));
  }

  async getMetricsSnapshot(filters = {}) {
    return this.read((state) => {
      const hubId = trimString(filters.hubId);
      const hubs = Object.values(state.hubs || {})
        .filter((entry) => (!hubId || entry.hubId === hubId));
      const accounts = Object.values(state.accountLinks || {})
        .filter((entry) => (!hubId || entry.hubId === hubId));
      const accessTokens = Object.values(state.accessTokens || {})
        .filter((entry) => (!hubId || entry.hubId === hubId));
      const refreshTokens = Object.values(state.refreshTokens || {})
        .filter((entry) => (!hubId || entry.hubId === hubId));
      const authCodes = Object.values(state.authCodes || {})
        .filter((entry) => (!hubId || entry.hubId === hubId))
        .filter((entry) => !entry.consumedAt);
      const permissionGrants = Object.values(state.permissionGrants || {})
        .filter((entry) => (!hubId || entry.hubId === hubId));
      const events = (Array.isArray(state.eventQueue) ? state.eventQueue : [])
        .filter((entry) => (!hubId || entry.hubId === hubId));
      const auditLog = (Array.isArray(state.auditLog) ? state.auditLog : [])
        .filter((entry) => (!hubId || entry.hubId === hubId));

      const queuedEvents = events.filter((entry) => entry.status === 'queued');
      const processingEvents = events.filter((entry) => entry.status === 'processing');
      const failedEvents = events.filter((entry) => entry.status === 'failed');
      const deliveredEvents = events.filter((entry) => entry.status === 'delivered');
      const skippedEvents = events.filter((entry) => entry.status === 'skipped');
      const retryBacklog = queuedEvents.filter((entry) => Number(entry.attempts || 0) > 0);
      const oldestQueued = queuedEvents.reduce((oldest, entry) => {
        const currentValue = safeDateMs(entry.createdAt);
        if (!oldest || currentValue < safeDateMs(oldest.createdAt)) {
          return entry;
        }
        return oldest;
      }, null);
      const grantRefreshErrors = permissionGrants.filter((entry) => trimString(entry.lastError));
      const activeRefreshTokens = refreshTokens.filter((entry) => !entry.revokedAt);
      const refreshBackedAccountIds = new Set(activeRefreshTokens.map((entry) => entry.brokerAccountId));
      const linkedAccounts = accounts.filter((entry) => entry.status === 'linked');
      const staleProcessingEvents = processingEvents.filter((entry) => {
        const leaseExpiresAt = safeDateMs(entry.leaseExpiresAt)
          || (safeDateMs(entry.processingStartedAt || entry.lastAttemptAt) + DEFAULT_EVENT_PROCESSING_LEASE_MS);
        return !leaseExpiresAt || leaseExpiresAt <= Date.now();
      });
      const latestDeliveredAtMs = deliveredEvents.reduce(
        (latest, entry) => Math.max(latest, safeDateMs(entry.deliveredAt || entry.updatedAt)),
        0
      );
      const unresolvedFailedEvents = failedEvents.filter((entry) => (
        latestDeliveredAtMs === 0
        || safeDateMs(entry.lastAttemptAt || entry.updatedAt || entry.createdAt) > latestDeliveredAtMs
      ));
      const oauthRefreshSuccesses = auditLog.filter((entry) => entry.type === 'oauth_token_refresh_succeeded');
      const oauthRefreshFailures = auditLog.filter((entry) => entry.type === 'oauth_token_refresh_failed');
      const lastOauthRefreshSuccess = oauthRefreshSuccesses
        .slice()
        .sort((left, right) => safeDateMs(right.createdAt) - safeDateMs(left.createdAt))[0] || null;
      const lastOauthRefreshFailure = oauthRefreshFailures
        .slice()
        .sort((left, right) => safeDateMs(right.createdAt) - safeDateMs(left.createdAt))[0] || null;
      const byAuditType = {};
      auditLog.forEach((entry) => {
        const key = trimString(entry.type) || 'info';
        byAuditType[key] = (byAuditType[key] || 0) + 1;
      });

      return {
        hubId: hubId || null,
        generatedAt: new Date().toISOString(),
        hubs: {
          total: hubs.length,
          paired: hubs.filter((entry) => entry.registration).length,
          publicMode: hubs.filter((entry) => entry.registration?.mode === 'public').length,
          privateMode: hubs.filter((entry) => entry.registration?.mode !== 'public').length
        },
        linkedAccounts: {
          total: accounts.length,
          linked: linkedAccounts.length,
          pending: accounts.filter((entry) => entry.status === 'pending').length,
          error: accounts.filter((entry) => entry.status === 'error').length,
          revoked: accounts.filter((entry) => entry.status === 'revoked').length,
          tokenBacked: linkedAccounts.filter((entry) => refreshBackedAccountIds.has(entry.brokerAccountId)).length,
          missingRefreshToken: accounts.filter((entry) => entry.metadata?.credentialError === 'missing_refresh_token').length,
          activeLocales: Array.from(new Set(accounts.map((entry) => trimString(entry.locale)).filter(Boolean))).sort()
        },
        oauth: {
          authCodesActive: authCodes.length,
          accessTokensActive: accessTokens.filter((entry) => !entry.revokedAt).length,
          refreshTokensActive: activeRefreshTokens.length,
          clientIds: Array.from(new Set(accessTokens.map((entry) => trimString(entry.clientId)).filter(Boolean))).sort(),
          refreshSuccesses: oauthRefreshSuccesses.length,
          refreshFailures: oauthRefreshFailures.length,
          lastRefreshAt: lastOauthRefreshSuccess?.createdAt || null,
          lastRefreshFailureAt: lastOauthRefreshFailure?.createdAt || null,
          lastRefreshFailureCode: trimString(lastOauthRefreshFailure?.details?.oauthError),
          lastRefreshFailureReason: trimString(lastOauthRefreshFailure?.details?.reason)
        },
        permissionGrants: {
          total: permissionGrants.length,
          active: permissionGrants.filter((entry) => entry.status === 'active' && !entry.revokedAt).length,
          revoked: permissionGrants.filter((entry) => entry.status === 'revoked' || entry.revokedAt).length,
          withErrors: grantRefreshErrors.length,
          regions: Array.from(new Set(permissionGrants.map((entry) => trimString(entry.eventRegion)).filter(Boolean))).sort()
        },
        queue: {
          total: events.length,
          queued: queuedEvents.length,
          processing: processingEvents.length,
          staleProcessing: staleProcessingEvents.length,
          failed: failedEvents.length,
          unresolvedFailed: unresolvedFailedEvents.length,
          delivered: deliveredEvents.length,
          skipped: skippedEvents.length,
          retryBacklog: retryBacklog.length,
          oldestQueuedAt: oldestQueued?.createdAt || null,
          oldestQueuedAgeMs: oldestQueued ? Math.max(0, Date.now() - safeDateMs(oldestQueued.createdAt)) : 0
        },
        dispatch: {
          attempts: events.reduce((sum, entry) => sum + Math.max(0, Number(entry.attempts || 0)), 0),
          maxAttemptFailures: failedEvents.filter((entry) => Number(entry.attempts || 0) >= Number(entry.maxAttempts || 3)).length,
          lastDeliveredAt: deliveredEvents
            .map((entry) => entry.deliveredAt)
            .filter(Boolean)
            .sort((left, right) => safeDateMs(right) - safeDateMs(left))[0] || null,
          lastFailureAt: failedEvents
            .map((entry) => entry.updatedAt || entry.lastAttemptAt)
            .filter(Boolean)
            .sort((left, right) => safeDateMs(right) - safeDateMs(left))[0] || null
        },
        audit: {
          total: auditLog.length,
          lastAt: auditLog
            .map((entry) => entry.createdAt)
            .filter(Boolean)
            .sort((left, right) => safeDateMs(right) - safeDateMs(left))[0] || null,
          byType: byAuditType
        }
      };
    });
  }
}

module.exports = new BrokerStore();
module.exports.BrokerStore = BrokerStore;
module.exports.sha256 = sha256;
module.exports.pkceS256 = pkceS256;
module.exports.randomIdentifier = randomIdentifier;
module.exports.permissionGrantKey = permissionGrantKey;
module.exports.getRefreshTokenTtlSeconds = getRefreshTokenTtlSeconds;
module.exports.BrokerOAuthGrantError = BrokerOAuthGrantError;

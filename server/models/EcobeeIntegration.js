const mongoose = require('mongoose');

const DEFAULT_ECOBEE_SCOPES = ['smartWrite'];
const ECOBEE_AUTH_MODES = ['appKey', 'web'];

const trimString = (value) => (typeof value === 'string' ? value.trim() : value ?? '');

const normalizeScopeTokens = (input) => {
  if (Array.isArray(input)) {
    return input;
  }

  if (typeof input === 'string') {
    return input.split(/[\s,]+/g);
  }

  return [];
};

const sanitizeScopes = (scopes) => {
  const normalized = normalizeScopeTokens(scopes)
    .filter((scope) => typeof scope === 'string')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  if (normalized.length === 0) {
    return [...DEFAULT_ECOBEE_SCOPES];
  }

  return Array.from(new Set(normalized));
};

const sanitizeAuthMode = (value, fallback = 'appKey') => {
  const normalized = trimString(value);
  if (ECOBEE_AUTH_MODES.includes(normalized)) {
    return normalized;
  }
  return fallback;
};

const maskSecret = (value) => {
  const secret = trimString(value);
  if (!secret) {
    return '';
  }
  if (secret.length <= 4) {
    return '*'.repeat(secret.length);
  }
  return secret.replace(/.(?=.{4})/g, '*');
};

const buildMockIntegration = () => ({
  authMode: trimString(process.env.ECOBEE_CLIENT_ID || '') ? 'appKey' : 'web',
  clientId: trimString(process.env.ECOBEE_CLIENT_ID || ''),
  redirectUri: trimString(process.env.ECOBEE_REDIRECT_URI || 'http://localhost:3000/api/ecobee/callback'),
  username: '',
  password: '',
  accessToken: '',
  refreshToken: '',
  tokenType: 'Bearer',
  expiresAt: null,
  scope: [...DEFAULT_ECOBEE_SCOPES],
  isConfigured: false,
  isConnected: false,
  lastSync: null,
  lastError: '',
  pendingMfa: null,
  connectedDevices: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  isTokenValid: () => false,
  clearTokens: async function clearTokens() {
    return Promise.resolve();
  },
  updateDevices: async function updateDevices() {
    return Promise.resolve();
  },
  toSanitized: function toSanitized() {
    const sanitized = { ...this };
    sanitized.accessToken = maskSecret(sanitized.accessToken);
    sanitized.refreshToken = maskSecret(sanitized.refreshToken);
    sanitized.password = maskSecret(sanitized.password);
    sanitized.pendingMfa = null;
    sanitized.pendingMfaRequired = false;
    return sanitized;
  }
});

const EcobeeIntegrationSchema = new mongoose.Schema({
  authMode: {
    type: String,
    enum: ECOBEE_AUTH_MODES,
    default: 'appKey',
    set: (value) => sanitizeAuthMode(value)
  },
  clientId: {
    type: String,
    default: '',
    set: (value) => (typeof value === 'string' ? value.trim() : value)
  },
  redirectUri: {
    type: String,
    default: '',
    set: (value) => (typeof value === 'string' ? value.trim() : value)
  },
  username: {
    type: String,
    default: '',
    set: (value) => (typeof value === 'string' ? value.trim() : value)
  },
  password: {
    type: String,
    default: ''
  },

  accessToken: {
    type: String,
    default: ''
  },
  refreshToken: {
    type: String,
    default: ''
  },
  tokenType: {
    type: String,
    default: 'Bearer'
  },
  expiresAt: {
    type: Date,
    default: null
  },
  scope: {
    type: [String],
    default: () => [...DEFAULT_ECOBEE_SCOPES]
  },

  isConfigured: {
    type: Boolean,
    default: false
  },
  isConnected: {
    type: Boolean,
    default: false
  },
  lastSync: {
    type: Date,
    default: null
  },
  lastError: {
    type: String,
    default: ''
  },
  pendingMfa: {
    challengeUrl: String,
    state: String,
    mfaType: String,
    cookies: mongoose.Schema.Types.Mixed,
    codeVerifier: String,
    username: String,
    password: String,
    createdAt: Date
  },

  connectedDevices: [{
    thermostatIdentifier: String,
    name: String,
    sensorCount: Number,
    hvacMode: String,
    equipmentStatus: String,
    lastUpdated: { type: Date, default: Date.now }
  }],

  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

EcobeeIntegrationSchema.pre('save', function preSave() {
  this.updatedAt = new Date();
});

EcobeeIntegrationSchema.statics.getIntegration = async function getIntegration() {
  let integration = await this.findOne();

  if (!integration) {
    return buildMockIntegration();
  }

  let changed = false;

  const trimmedClientId = trimString(integration.clientId);
  const trimmedRedirectUri = trimString(integration.redirectUri);
  const inferredFallback = trimmedClientId ? 'appKey' : 'web';
  const normalizedAuthMode = sanitizeAuthMode(integration.authMode, inferredFallback);

  if (integration.authMode !== normalizedAuthMode) {
    integration.authMode = normalizedAuthMode;
    changed = true;
  }

  if (integration.clientId !== trimmedClientId) {
    integration.clientId = trimmedClientId;
    changed = true;
  }

  if (integration.redirectUri !== trimmedRedirectUri) {
    integration.redirectUri = trimmedRedirectUri;
    changed = true;
  }

  const sanitizedScopes = sanitizeScopes(integration.scope);
  if (!Array.isArray(integration.scope) ||
      integration.scope.length !== sanitizedScopes.length ||
      sanitizedScopes.some((scope, index) => scope !== integration.scope[index])) {
    integration.scope = sanitizedScopes;
    changed = true;
  }

  if (changed && typeof integration.save === 'function') {
    await integration.save();
  }

  return integration;
};

EcobeeIntegrationSchema.statics.configureIntegration = async function configureIntegration(config) {
  const clientId = trimString(config.clientId);
  const redirectUri = config.redirectUri
    ? trimString(config.redirectUri)
    : trimString(process.env.ECOBEE_REDIRECT_URI || 'http://localhost:3000/api/ecobee/callback');
  const scope = sanitizeScopes(config.scope || DEFAULT_ECOBEE_SCOPES);

  let integration = await this.findOne();

  if (!integration) {
    integration = new this({
      authMode: 'appKey',
      clientId,
      redirectUri,
      scope,
      isConfigured: true
    });
  } else {
    const switchedAuthMode = integration.authMode !== 'appKey';
    const changedClientId = trimString(integration.clientId) !== clientId;
    integration.authMode = 'appKey';
    integration.clientId = clientId;
    integration.redirectUri = redirectUri;
    integration.username = '';
    integration.password = '';
    integration.scope = scope;
    integration.isConfigured = true;
    integration.pendingMfa = undefined;
    if (switchedAuthMode || changedClientId) {
      integration.accessToken = '';
      integration.refreshToken = '';
      integration.expiresAt = null;
      integration.isConnected = false;
    }
  }

  await integration.save();
  return integration;
};

EcobeeIntegrationSchema.statics.configureWebIntegration = async function configureWebIntegration(config) {
  const username = trimString(config.username);
  const password = typeof config.password === 'string' ? config.password : '';

  let integration = await this.findOne();

  if (!integration) {
    integration = new this({
      authMode: 'web',
      clientId: '',
      redirectUri: '',
      username,
      password,
      scope: [...DEFAULT_ECOBEE_SCOPES],
      isConfigured: true,
      isConnected: false
    });
  } else {
    integration.authMode = 'web';
    integration.clientId = '';
    integration.redirectUri = '';
    integration.username = username;
    integration.password = password;
    integration.scope = sanitizeScopes(integration.scope || DEFAULT_ECOBEE_SCOPES);
    integration.isConfigured = true;
    integration.accessToken = '';
    integration.refreshToken = '';
    integration.expiresAt = null;
    integration.isConnected = false;
  }

  integration.pendingMfa = undefined;
  integration.lastError = '';
  await integration.save();
  return integration;
};

EcobeeIntegrationSchema.methods.isTokenValid = function isTokenValid() {
  if (!this.accessToken || !this.expiresAt) {
    return false;
  }

  const expiryBuffer = new Date(Date.now() + 60 * 1000);
  return this.expiresAt > expiryBuffer;
};

EcobeeIntegrationSchema.methods.updateTokens = async function updateTokens(tokenData, options = {}) {
  if (options.authMode) {
    this.authMode = sanitizeAuthMode(options.authMode, this.authMode || 'appKey');
  }

  this.accessToken = tokenData.access_token || '';
  this.tokenType = tokenData.token_type || 'Bearer';

  if (tokenData.refresh_token) {
    this.refreshToken = tokenData.refresh_token;
  }

  if (tokenData.expires_in) {
    const expiresInSeconds = Number(tokenData.expires_in);
    const clampedExpiresIn = Number.isFinite(expiresInSeconds) ? Math.max(30, expiresInSeconds - 60) : 3000;
    this.expiresAt = new Date(Date.now() + (clampedExpiresIn * 1000));
  }

  if (tokenData.scope) {
    this.scope = sanitizeScopes(tokenData.scope);
  }

  this.isConnected = true;
  this.lastError = '';
  this.pendingMfa = undefined;

  await this.save();
};

EcobeeIntegrationSchema.methods.clearTokens = async function clearTokens(errorMessage = '') {
  this.accessToken = '';
  this.refreshToken = '';
  this.expiresAt = null;
  this.isConnected = false;
  this.lastError = errorMessage;
  this.pendingMfa = undefined;

  await this.save();
};

EcobeeIntegrationSchema.methods.setPendingMfa = async function setPendingMfa(challenge) {
  this.pendingMfa = {
    challengeUrl: trimString(challenge.challengeUrl),
    state: trimString(challenge.state),
    mfaType: trimString(challenge.mfaType || 'otp'),
    cookies: challenge.cookies || {},
    codeVerifier: trimString(challenge.codeVerifier),
    username: trimString(challenge.username || this.username),
    password: typeof challenge.password === 'string' ? challenge.password : this.password,
    createdAt: new Date()
  };
  this.isConnected = false;
  this.lastError = 'Ecobee MFA code required';

  await this.save();
};

EcobeeIntegrationSchema.methods.clearPendingMfa = async function clearPendingMfa() {
  this.pendingMfa = undefined;
  await this.save();
};

EcobeeIntegrationSchema.methods.updateDevices = async function updateDevices(thermostats = []) {
  const list = Array.isArray(thermostats) ? thermostats : [];

  this.connectedDevices = list.map((thermostat) => ({
    thermostatIdentifier: thermostat?.identifier || '',
    name: thermostat?.name || thermostat?.identifier || 'Ecobee Thermostat',
    sensorCount: Array.isArray(thermostat?.remoteSensors) ? thermostat.remoteSensors.length : 0,
    hvacMode: thermostat?.settings?.hvacMode || '',
    equipmentStatus: thermostat?.equipmentStatus || '',
    lastUpdated: new Date()
  }));

  this.lastSync = new Date();
  await this.save();
};

EcobeeIntegrationSchema.methods.toSanitized = function toSanitized() {
  const sanitized = this.toObject();

  sanitized.accessToken = maskSecret(sanitized.accessToken);
  sanitized.refreshToken = maskSecret(sanitized.refreshToken);
  sanitized.password = maskSecret(sanitized.password);

  const pendingMfa = sanitized.pendingMfa;
  sanitized.pendingMfaRequired = !!pendingMfa;
  sanitized.pendingMfa = pendingMfa
    ? {
        mfaType: pendingMfa.mfaType || 'otp',
        username: pendingMfa.username || sanitized.username || '',
        createdAt: pendingMfa.createdAt || null
      }
    : null;

  return sanitized;
};

module.exports = mongoose.model('EcobeeIntegration', EcobeeIntegrationSchema);

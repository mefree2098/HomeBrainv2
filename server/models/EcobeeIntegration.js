const mongoose = require('mongoose');

const DEFAULT_ECOBEE_SCOPES = ['smartWrite'];

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

const buildMockIntegration = () => ({
  clientId: trimString(process.env.ECOBEE_CLIENT_ID || ''),
  redirectUri: trimString(process.env.ECOBEE_REDIRECT_URI || 'http://localhost:3000/api/ecobee/callback'),
  accessToken: '',
  refreshToken: '',
  tokenType: 'Bearer',
  expiresAt: null,
  scope: [...DEFAULT_ECOBEE_SCOPES],
  isConfigured: false,
  isConnected: false,
  lastSync: null,
  lastError: '',
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
    if (sanitized.accessToken) {
      sanitized.accessToken = sanitized.accessToken.replace(/.(?=.{4})/g, '*');
    }
    if (sanitized.refreshToken) {
      sanitized.refreshToken = sanitized.refreshToken.replace(/.(?=.{4})/g, '*');
    }
    return sanitized;
  }
});

const EcobeeIntegrationSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    set: (value) => (typeof value === 'string' ? value.trim() : value)
  },
  redirectUri: {
    type: String,
    required: true,
    set: (value) => (typeof value === 'string' ? value.trim() : value)
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
      clientId,
      redirectUri,
      scope,
      isConfigured: true
    });
  } else {
    integration.clientId = clientId;
    integration.redirectUri = redirectUri;
    integration.scope = scope;
    integration.isConfigured = true;
  }

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

EcobeeIntegrationSchema.methods.updateTokens = async function updateTokens(tokenData) {
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

  await this.save();
};

EcobeeIntegrationSchema.methods.clearTokens = async function clearTokens(errorMessage = '') {
  this.accessToken = '';
  this.refreshToken = '';
  this.expiresAt = null;
  this.isConnected = false;
  this.lastError = errorMessage;

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

  if (sanitized.accessToken) {
    sanitized.accessToken = sanitized.accessToken.replace(/.(?=.{4})/g, '*');
  }

  if (sanitized.refreshToken) {
    sanitized.refreshToken = sanitized.refreshToken.replace(/.(?=.{4})/g, '*');
  }

  return sanitized;
};

module.exports = mongoose.model('EcobeeIntegration', EcobeeIntegrationSchema);

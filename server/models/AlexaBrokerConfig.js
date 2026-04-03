const mongoose = require('mongoose');

function maskSecret(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return '';
  }

  return normalized.replace(/.(?=.{4})/g, '*');
}

const lastErrorSchema = new mongoose.Schema({
  message: {
    type: String,
    default: ''
  },
  timestamp: {
    type: Date,
    default: null
  }
}, { _id: false });

const alexaBrokerConfigSchema = new mongoose.Schema({
  isInstalled: {
    type: Boolean,
    default: false
  },
  serviceStatus: {
    type: String,
    enum: ['not_installed', 'installing', 'stopped', 'starting', 'running', 'running_external', 'error'],
    default: 'not_installed'
  },
  servicePid: {
    type: Number,
    default: null
  },
  servicePort: {
    type: Number,
    min: 1,
    max: 65535,
    default: 4301
  },
  bindHost: {
    type: String,
    default: '127.0.0.1'
  },
  reverseProxyRouteId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ReverseProxyRoute',
    default: null
  },
  resumeAfterHostRestart: {
    type: Boolean,
    default: false
  },
  serviceOwner: {
    type: String,
    default: null
  },
  publicBaseUrl: {
    type: String,
    default: ''
  },
  displayName: {
    type: String,
    default: 'HomeBrain Alexa Broker'
  },
  oauthClientId: {
    type: String,
    default: 'homebrain-alexa-skill'
  },
  oauthClientSecret: {
    type: String,
    default: ''
  },
  allowedClientIds: {
    type: [String],
    default: ['homebrain-alexa-skill']
  },
  allowedRedirectUris: {
    type: [String],
    default: []
  },
  eventClientId: {
    type: String,
    default: ''
  },
  eventClientSecret: {
    type: String,
    default: ''
  },
  storeFile: {
    type: String,
    default: ''
  },
  authCodeTtlMs: {
    type: Number,
    default: 300000
  },
  accessTokenTtlSeconds: {
    type: Number,
    default: 3600
  },
  refreshTokenTtlSeconds: {
    type: Number,
    default: 15552000
  },
  lwaTokenUrl: {
    type: String,
    default: 'https://api.amazon.com/auth/o2/token'
  },
  eventGatewayUrl: {
    type: String,
    default: 'https://api.amazonalexa.com/v3/events'
  },
  rateLimitWindowMs: {
    type: Number,
    default: 60000
  },
  rateLimitMax: {
    type: Number,
    default: 120
  },
  allowManualRegistration: {
    type: Boolean,
    default: false
  },
  autoStart: {
    type: Boolean,
    default: true
  },
  lastStartedAt: {
    type: Date,
    default: null
  },
  lastStoppedAt: {
    type: Date,
    default: null
  },
  lastError: {
    type: lastErrorSchema,
    default: null
  }
}, {
  timestamps: true
});

alexaBrokerConfigSchema.pre('save', function preSave() {
  this.bindHost = String(this.bindHost || '').trim() || '127.0.0.1';
  this.publicBaseUrl = String(this.publicBaseUrl || '').trim().replace(/\/+$/, '');
  this.displayName = String(this.displayName || '').trim() || 'HomeBrain Alexa Broker';
  this.oauthClientId = String(this.oauthClientId || '').trim() || 'homebrain-alexa-skill';
  this.oauthClientSecret = String(this.oauthClientSecret || '').trim();
  this.allowedClientIds = Array.from(new Set((Array.isArray(this.allowedClientIds) ? this.allowedClientIds : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)));
  this.allowedRedirectUris = Array.from(new Set((Array.isArray(this.allowedRedirectUris) ? this.allowedRedirectUris : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)));
  this.eventClientId = String(this.eventClientId || '').trim();
  this.eventClientSecret = String(this.eventClientSecret || '').trim();
  this.storeFile = String(this.storeFile || '').trim();
  this.lwaTokenUrl = String(this.lwaTokenUrl || '').trim() || 'https://api.amazon.com/auth/o2/token';
  this.eventGatewayUrl = String(this.eventGatewayUrl || '').trim() || 'https://api.amazonalexa.com/v3/events';
});

alexaBrokerConfigSchema.statics.getConfig = async function getConfig() {
  let config = await this.findOne();
  if (!config) {
    config = await this.create({});
  }
  return config;
};

alexaBrokerConfigSchema.methods.setError = async function setError(message) {
  this.lastError = {
    message: String(message || 'Unknown Alexa broker error'),
    timestamp: new Date()
  };
  await this.save();
};

alexaBrokerConfigSchema.methods.toSanitized = function toSanitized() {
  const sanitized = this.toObject();
  sanitized.oauthClientSecret = maskSecret(sanitized.oauthClientSecret);
  sanitized.eventClientSecret = maskSecret(sanitized.eventClientSecret);
  return sanitized;
};

module.exports = mongoose.model('AlexaBrokerConfig', alexaBrokerConfigSchema);

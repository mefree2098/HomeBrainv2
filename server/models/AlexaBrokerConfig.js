const mongoose = require('mongoose');

const LEGACY_DEVICE_PROVIDER_FIELDS = [
  'deviceDiscoveryPath',
  'deviceServiceBaseUrl',
  'deviceServiceTimeoutMs',
  'deviceServiceToken',
  'deviceSpeakPath'
];

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

const lifecycleEventSchema = new mongoose.Schema({
  type: {
    type: String,
    default: 'info'
  },
  status: {
    type: String,
    enum: ['info', 'success', 'warning', 'error'],
    default: 'info'
  },
  message: {
    type: String,
    default: ''
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  occurredAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const alexaCommandTargetSchema = new mongoose.Schema({
  key: {
    type: String,
    default: ''
  },
  alexaDeviceId: {
    type: String,
    default: ''
  },
  displayName: {
    type: String,
    default: ''
  },
  room: {
    type: String,
    default: ''
  },
  enabled: {
    type: Boolean,
    default: true
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
  alexaCommandProvider: {
    type: String,
    enum: ['disabled', 'homebrain', 'asp'],
    default: 'disabled'
  },
  alexaCommandDefaultType: {
    type: String,
    enum: ['announce', 'speak', 'ssml'],
    default: 'announce'
  },
  alexaCommandLocale: {
    type: String,
    default: 'en-US'
  },
  alexaCommandAmazonPage: {
    type: String,
    default: 'amazon.com'
  },
  alexaCommandServiceHost: {
    type: String,
    default: 'pitangui.amazon.com'
  },
  alexaCommandSessionCookie: {
    type: String,
    default: ''
  },
  alexaCommandSessionData: {
    type: String,
    default: ''
  },
  alexaCommandTargets: {
    type: [alexaCommandTargetSchema],
    default: []
  },
  alexaCommandTimeoutMs: {
    type: Number,
    default: 10000
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
    default: 0
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
  manualStopRequested: {
    type: Boolean,
    default: false
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
  },
  lifecycleEvents: {
    type: [lifecycleEventSchema],
    default: []
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
  this.alexaCommandProvider = ['disabled', 'homebrain', 'asp'].includes(String(this.alexaCommandProvider || '').trim())
    ? String(this.alexaCommandProvider).trim()
    : 'disabled';
  this.alexaCommandDefaultType = ['announce', 'speak', 'ssml'].includes(String(this.alexaCommandDefaultType || '').trim())
    ? String(this.alexaCommandDefaultType).trim()
    : 'announce';
  this.alexaCommandLocale = String(this.alexaCommandLocale || '').trim() || 'en-US';
  this.alexaCommandAmazonPage = String(this.alexaCommandAmazonPage || '').trim() || 'amazon.com';
  this.alexaCommandServiceHost = String(this.alexaCommandServiceHost || '').trim() || 'pitangui.amazon.com';
  this.alexaCommandSessionCookie = String(this.alexaCommandSessionCookie || '').trim();
  this.alexaCommandSessionData = String(this.alexaCommandSessionData || '').trim();
  this.alexaCommandTargets = Array.isArray(this.alexaCommandTargets)
    ? this.alexaCommandTargets.map((entry) => ({
      key: String(entry?.key || '').trim(),
      alexaDeviceId: String(entry?.alexaDeviceId || '').trim(),
      displayName: String(entry?.displayName || '').trim(),
      room: String(entry?.room || '').trim(),
      enabled: entry?.enabled !== false
    })).filter((entry) => entry.key && entry.alexaDeviceId)
    : [];
  this.storeFile = String(this.storeFile || '').trim();
  this.refreshTokenTtlSeconds = Math.max(0, Number.parseInt(String(this.refreshTokenTtlSeconds ?? 0), 10) || 0);
  this.lwaTokenUrl = String(this.lwaTokenUrl || '').trim() || 'https://api.amazon.com/auth/o2/token';
  this.eventGatewayUrl = String(this.eventGatewayUrl || '').trim() || 'https://api.amazonalexa.com/v3/events';
  this.lifecycleEvents = Array.isArray(this.lifecycleEvents)
    ? this.lifecycleEvents.slice(-50).map((entry) => ({
      type: String(entry?.type || 'info').trim() || 'info',
      status: ['info', 'success', 'warning', 'error'].includes(String(entry?.status || '').trim())
        ? String(entry.status).trim()
        : 'info',
      message: String(entry?.message || '').trim(),
      details: entry?.details && typeof entry.details === 'object' ? entry.details : {},
      occurredAt: entry?.occurredAt ? new Date(entry.occurredAt) : new Date()
    }))
    : [];
});

alexaBrokerConfigSchema.statics.getConfig = async function getConfig() {
  let config = await this.findOne();
  if (!config) {
    config = await this.create({});
  }
  const persistedConfig = config.toObject();
  const legacyUnset = LEGACY_DEVICE_PROVIDER_FIELDS.reduce((updates, field) => {
    if (Object.prototype.hasOwnProperty.call(persistedConfig, field)) {
      updates[field] = '';
    }
    return updates;
  }, {});
  if (Object.keys(legacyUnset).length > 0) {
    await this.updateOne({ _id: config._id }, { $unset: legacyUnset });
    config = await this.findById(config._id);
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
  LEGACY_DEVICE_PROVIDER_FIELDS.forEach((field) => {
    delete sanitized[field];
  });
  sanitized.oauthClientSecret = maskSecret(sanitized.oauthClientSecret);
  sanitized.eventClientSecret = maskSecret(sanitized.eventClientSecret);
  sanitized.alexaCommandSessionCookie = maskSecret(sanitized.alexaCommandSessionCookie);
  sanitized.alexaCommandSessionData = maskSecret(sanitized.alexaCommandSessionData);
  return sanitized;
};

module.exports = mongoose.model('AlexaBrokerConfig', alexaBrokerConfigSchema);

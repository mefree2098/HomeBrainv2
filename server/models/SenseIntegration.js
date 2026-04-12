const { randomUUID } = require('crypto');
const mongoose = require('mongoose');

const trimString = (value, fallback = '') => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

const clampInteger = (value, fallback, minimum, maximum) => {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(minimum, Math.min(maximum, numeric));
};

const clampDecimal = (value, fallback, minimum, maximum, digits = 4) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const bounded = Math.max(minimum, Math.min(maximum, numeric));
  const multiplier = 10 ** digits;
  return Math.round(bounded * multiplier) / multiplier;
};

const buildDeviceId = () => randomUUID().replace(/-/g, '');

const WebsocketStateSchema = new mongoose.Schema({
  connected: {
    type: Boolean,
    default: false
  },
  lastConnectedAt: {
    type: Date,
    default: null
  },
  lastMessageAt: {
    type: Date,
    default: null
  },
  reconnectCount: {
    type: Number,
    default: 0
  }
}, { _id: false });

const SenseIntegrationSchema = new mongoose.Schema({
  email: {
    type: String,
    default: ''
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
  userId: {
    type: String,
    default: ''
  },
  deviceId: {
    type: String,
    default: buildDeviceId
  },
  monitorId: {
    type: String,
    default: ''
  },
  monitorName: {
    type: String,
    default: ''
  },
  enabled: {
    type: Boolean,
    default: false
  },
  realtimeEnabled: {
    type: Boolean,
    default: true
  },
  room: {
    type: String,
    default: 'Electrical Panel'
  },
  pollIntervalSeconds: {
    type: Number,
    default: 10,
    min: 5,
    max: 300
  },
  trendSyncIntervalMinutes: {
    type: Number,
    default: 15,
    min: 5,
    max: 1440
  },
  electricityRateCentsPerKwh: {
    type: Number,
    default: 11,
    min: 0,
    max: 500
  },
  availableMonitors: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  solarConfigured: {
    type: Boolean,
    default: false
  },
  isConnected: {
    type: Boolean,
    default: false
  },
  lastAuthenticatedAt: {
    type: Date,
    default: null
  },
  lastRealtimeAt: {
    type: Date,
    default: null
  },
  lastTrendSyncAt: {
    type: Date,
    default: null
  },
  lastSyncAt: {
    type: Date,
    default: null
  },
  lastError: {
    type: String,
    default: ''
  },
  websocket: {
    type: WebsocketStateSchema,
    default: () => ({})
  },
  snapshot: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({})
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  versionKey: false
});

SenseIntegrationSchema.pre('save', function() {
  this.updatedAt = new Date();
  if (!trimString(this.deviceId)) {
    this.deviceId = buildDeviceId();
  }
});

SenseIntegrationSchema.statics.getDefaultIntegration = function() {
  return {
    email: trimString(process.env.SENSE_EMAIL, ''),
    password: trimString(process.env.SENSE_PASSWORD, ''),
    accessToken: '',
    refreshToken: '',
    userId: '',
    deviceId: trimString(process.env.SENSE_DEVICE_ID, '') || buildDeviceId(),
    monitorId: trimString(process.env.SENSE_MONITOR_ID, ''),
    monitorName: '',
    enabled: process.env.SENSE_ENABLED === 'true',
    realtimeEnabled: process.env.SENSE_REALTIME_ENABLED !== 'false',
    room: trimString(process.env.SENSE_ROOM, 'Electrical Panel'),
    pollIntervalSeconds: clampInteger(process.env.SENSE_POLL_INTERVAL_SECONDS, 10, 5, 300),
    trendSyncIntervalMinutes: clampInteger(process.env.SENSE_TREND_SYNC_INTERVAL_MINUTES, 15, 5, 1440),
    electricityRateCentsPerKwh: clampDecimal(process.env.SENSE_ELECTRICITY_RATE_CENTS_PER_KWH, 11, 0, 500),
    availableMonitors: [],
    solarConfigured: false,
    isConnected: false,
    lastAuthenticatedAt: null,
    lastRealtimeAt: null,
    lastTrendSyncAt: null,
    lastSyncAt: null,
    lastError: '',
    websocket: {
      connected: false,
      lastConnectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0
    },
    snapshot: {}
  };
};

SenseIntegrationSchema.statics.getIntegration = async function() {
  const integration = await this.findOne();
  if (integration) {
    return integration;
  }

  return new this(this.getDefaultIntegration());
};

SenseIntegrationSchema.methods.toSanitized = function() {
  const sanitized = this.toObject ? this.toObject() : { ...this };
  const password = trimString(sanitized.password, '');
  const accessToken = trimString(sanitized.accessToken, '');
  const refreshToken = trimString(sanitized.refreshToken, '');

  sanitized.passwordConfigured = password.length > 0;
  sanitized.accessTokenConfigured = accessToken.length > 0;
  sanitized.refreshTokenConfigured = refreshToken.length > 0;
  sanitized.password = password
    ? password.replace(/.(?=.{4})/g, '*')
    : '';
  sanitized.accessToken = accessToken
    ? `${'*'.repeat(Math.max(8, accessToken.length - 4))}${accessToken.slice(-4)}`
    : '';
  sanitized.refreshToken = refreshToken
    ? `${'*'.repeat(Math.max(8, refreshToken.length - 4))}${refreshToken.slice(-4)}`
    : '';

  return sanitized;
};

module.exports = mongoose.model('SenseIntegration', SenseIntegrationSchema);

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

const RainMachineIntegrationSchema = new mongoose.Schema({
  host: {
    type: String,
    default: ''
  },
  protocol: {
    type: String,
    enum: ['https', 'http'],
    default: 'https'
  },
  port: {
    type: Number,
    default: 8080,
    min: 1,
    max: 65535
  },
  password: {
    type: String,
    default: ''
  },
  enabled: {
    type: Boolean,
    default: false
  },
  room: {
    type: String,
    default: 'Irrigation'
  },
  pollIntervalMinutes: {
    type: Number,
    default: 5,
    min: 1,
    max: 1440
  },
  defaultZoneDurationSeconds: {
    type: Number,
    default: 600,
    min: 60,
    max: 6 * 60 * 60
  },
  controllerId: {
    type: String,
    default: ''
  },
  controllerName: {
    type: String,
    default: ''
  },
  apiVersion: {
    type: String,
    default: ''
  },
  hardwareVersion: {
    type: Number,
    default: null
  },
  softwareVersion: {
    type: String,
    default: ''
  },
  isConnected: {
    type: Boolean,
    default: false
  },
  lastDiscoveredAt: {
    type: Date,
    default: null
  },
  lastAuthenticatedAt: {
    type: Date,
    default: null
  },
  lastConnectedAt: {
    type: Date,
    default: null
  },
  lastSyncAt: {
    type: Date,
    default: null
  },
  lastReportSyncAt: {
    type: Date,
    default: null
  },
  lastError: {
    type: String,
    default: ''
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

RainMachineIntegrationSchema.pre('save', function() {
  this.updatedAt = new Date();
});

RainMachineIntegrationSchema.statics.getDefaultIntegration = function() {
  const envProtocol = trimString(process.env.RAINMACHINE_PROTOCOL, 'https').toLowerCase() === 'http'
    ? 'http'
    : 'https';
  const defaultPort = envProtocol === 'http' ? 8081 : 8080;

  return {
    host: trimString(process.env.RAINMACHINE_HOST, ''),
    protocol: envProtocol,
    port: clampInteger(process.env.RAINMACHINE_PORT, defaultPort, 1, 65535),
    password: trimString(process.env.RAINMACHINE_PASSWORD, ''),
    enabled: process.env.RAINMACHINE_ENABLED === 'true',
    room: trimString(process.env.RAINMACHINE_ROOM, 'Irrigation'),
    pollIntervalMinutes: clampInteger(process.env.RAINMACHINE_POLL_INTERVAL_MINUTES, 5, 1, 1440),
    defaultZoneDurationSeconds: clampInteger(process.env.RAINMACHINE_DEFAULT_ZONE_DURATION_SECONDS, 600, 60, 6 * 60 * 60),
    controllerId: '',
    controllerName: '',
    apiVersion: '',
    hardwareVersion: null,
    softwareVersion: '',
    isConnected: false,
    lastDiscoveredAt: null,
    lastAuthenticatedAt: null,
    lastConnectedAt: null,
    lastSyncAt: null,
    lastReportSyncAt: null,
    lastError: '',
    snapshot: {}
  };
};

RainMachineIntegrationSchema.statics.getIntegration = async function() {
  const integration = await this.findOne();
  if (integration) {
    return integration;
  }

  return new this(this.getDefaultIntegration());
};

RainMachineIntegrationSchema.methods.toSanitized = function() {
  const sanitized = this.toObject ? this.toObject() : { ...this };
  const password = trimString(sanitized.password, '');

  sanitized.passwordConfigured = password.length > 0;
  sanitized.password = password
    ? password.replace(/.(?=.{4})/g, '*')
    : '';

  return sanitized;
};

module.exports = mongoose.model('RainMachineIntegration', RainMachineIntegrationSchema);

const mongoose = require('mongoose');

const trimString = (value, fallback = '') => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

const clampPollIntervalMs = (value) => {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric)) {
    return 60 * 1000;
  }
  return Math.max(60 * 1000, Math.min(60 * 60 * 1000, numeric));
};

const GoveeIntegrationSchema = new mongoose.Schema({
  apiKey: {
    type: String,
    default: ''
  },
  enabled: {
    type: Boolean,
    default: false
  },
  room: {
    type: String,
    default: 'Inside'
  },
  selectedDevice: {
    type: String,
    default: ''
  },
  selectedSku: {
    type: String,
    default: ''
  },
  selectedDeviceName: {
    type: String,
    default: ''
  },
  selectedDeviceType: {
    type: String,
    default: ''
  },
  pollIntervalMs: {
    type: Number,
    default: 60 * 1000,
    min: 60 * 1000,
    max: 60 * 60 * 1000
  },
  tempOffsetF: {
    type: Number,
    default: 0
  },
  humidityOffsetPct: {
    type: Number,
    default: 0
  },
  pm25OffsetUgM3: {
    type: Number,
    default: 0
  },
  discoveredDevices: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  lastSample: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  isConnected: {
    type: Boolean,
    default: false
  },
  lastDiscoveryAt: {
    type: Date,
    default: null
  },
  lastSyncAt: {
    type: Date,
    default: null
  },
  lastSampleAt: {
    type: Date,
    default: null
  },
  lastError: {
    type: String,
    default: ''
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

GoveeIntegrationSchema.pre('save', function() {
  this.pollIntervalMs = clampPollIntervalMs(this.pollIntervalMs);
  this.updatedAt = new Date();
});

GoveeIntegrationSchema.statics.getDefaultIntegration = function() {
  return {
    apiKey: trimString(process.env.GOVEE_API_KEY, ''),
    enabled: process.env.GOVEE_ENABLED === 'true',
    room: trimString(process.env.GOVEE_ROOM, 'Inside'),
    selectedDevice: trimString(process.env.GOVEE_SELECTED_DEVICE, ''),
    selectedSku: trimString(process.env.GOVEE_SELECTED_SKU, ''),
    selectedDeviceName: '',
    selectedDeviceType: '',
    pollIntervalMs: clampPollIntervalMs(process.env.GOVEE_POLL_INTERVAL_MS),
    tempOffsetF: Number(process.env.GOVEE_TEMP_OFFSET_F || 0),
    humidityOffsetPct: Number(process.env.GOVEE_HUMIDITY_OFFSET_PCT || 0),
    pm25OffsetUgM3: Number(process.env.GOVEE_PM25_OFFSET_UGM3 || 0),
    discoveredDevices: [],
    lastSample: null,
    isConnected: false,
    lastDiscoveryAt: null,
    lastSyncAt: null,
    lastSampleAt: null,
    lastError: ''
  };
};

GoveeIntegrationSchema.statics.getIntegration = async function() {
  const integration = await this.findOne();
  if (integration) {
    return integration;
  }

  return new this(this.getDefaultIntegration());
};

GoveeIntegrationSchema.methods.toSanitized = function() {
  const sanitized = this.toObject ? this.toObject() : { ...this };

  if (sanitized.apiKey) {
    sanitized.apiKey = sanitized.apiKey.replace(/.(?=.{4})/g, '*');
  }

  const hasStoredKey = Boolean(this.apiKey);
  const hasEnvironmentKey = Boolean(process.env.GOVEE_API_KEY);
  sanitized.apiKeyConfigured = hasStoredKey || hasEnvironmentKey;
  sanitized.apiKeySource = hasStoredKey
    ? 'stored'
    : (hasEnvironmentKey ? 'environment' : 'none');

  return sanitized;
};

module.exports = mongoose.model('GoveeIntegration', GoveeIntegrationSchema);

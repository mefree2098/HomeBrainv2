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

const normalizeConnectionMode = (value) => {
  const normalized = trimString(value, 'auto').toLowerCase();
  return ['auto', 'cloud', 'local'].includes(normalized) ? normalized : 'auto';
};

const GoveeIntegrationSchema = new mongoose.Schema({
  apiKey: {
    type: String,
    default: ''
  },
  connectionMode: {
    type: String,
    enum: ['auto', 'cloud', 'local'],
    default: 'auto'
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
  localDeviceIp: {
    type: String,
    default: ''
  },
  localDevicePort: {
    type: Number,
    default: 4003,
    min: 1,
    max: 65535
  },
  localDiscoveredDevices: {
    type: [mongoose.Schema.Types.Mixed],
    default: []
  },
  lastLocalDiscoveryAt: {
    type: Date,
    default: null
  },
  lastLocalSyncAt: {
    type: Date,
    default: null
  },
  lastLocalError: {
    type: String,
    default: ''
  },
  lastSample: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  lastSampleSource: {
    type: String,
    enum: ['cloud_api', 'local_lan', ''],
    default: ''
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
  this.connectionMode = normalizeConnectionMode(this.connectionMode);
  this.pollIntervalMs = clampPollIntervalMs(this.pollIntervalMs);
  const port = Math.trunc(Number(this.localDevicePort));
  this.localDevicePort = Number.isFinite(port) && port > 0 && port <= 65535 ? port : 4003;
  this.updatedAt = new Date();
});

GoveeIntegrationSchema.statics.getDefaultIntegration = function() {
  return {
    apiKey: trimString(process.env.GOVEE_API_KEY, ''),
    connectionMode: normalizeConnectionMode(process.env.GOVEE_CONNECTION_MODE),
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
    localDeviceIp: trimString(process.env.GOVEE_LOCAL_DEVICE_IP, ''),
    localDevicePort: Number(process.env.GOVEE_LOCAL_DEVICE_PORT || 4003),
    localDiscoveredDevices: [],
    lastLocalDiscoveryAt: null,
    lastLocalSyncAt: null,
    lastLocalError: '',
    lastSample: null,
    lastSampleSource: '',
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

const mongoose = require('mongoose');

const sensorNodeSettingsSchema = new mongoose.Schema({
  reportingIntervalSeconds: {
    type: Number,
    min: 10,
    max: 86400,
    default: 300
  },
  deepSleepEnabled: {
    type: Boolean,
    default: true
  },
  temperatureOffsetC: {
    type: Number,
    min: -20,
    max: 20,
    default: 0
  },
  humidityOffsetPct: {
    type: Number,
    min: -50,
    max: 50,
    default: 0
  },
  altitudeMeters: {
    type: Number,
    min: -500,
    max: 9000,
    default: 0
  },
  presenceHoldSeconds: {
    type: Number,
    min: 0,
    max: 3600,
    default: 30
  }
}, {
  _id: false,
  versionKey: false
});

const sensorNodeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  room: {
    type: String,
    required: true,
    trim: true
  },
  profile: {
    type: String,
    enum: ['auto', 'air-station', 'climate', 'presence'],
    default: 'auto'
  },
  hardwareProfile: {
    type: String,
    enum: ['seeed-xiao-esp32-c6'],
    default: 'seeed-xiao-esp32-c6'
  },
  powerSource: {
    type: String,
    enum: ['wired', 'battery'],
    default: 'battery'
  },
  status: {
    type: String,
    enum: ['provisioning', 'online', 'offline', 'error'],
    default: 'provisioning'
  },
  deviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device'
  },
  hardwareId: {
    type: String,
    trim: true
  },
  firmwareVersion: {
    type: String,
    trim: true
  },
  otaProtocol: { type: Number, default: 0, min: 0, max: 1 },
  firmwareUpdate: { type: mongoose.Schema.Types.Mixed, default: null },
  capabilities: {
    type: [String],
    default: []
  },
  ipAddress: {
    type: String,
    trim: true
  },
  settings: {
    type: sensorNodeSettingsSchema,
    default: () => ({})
  },
  latestReading: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  readingSequence: {
    type: Number,
    min: 0,
    default: 0
  },
  lastReadingAt: {
    type: Date,
    default: null
  },
  lastSeen: {
    type: Date,
    default: null
  },
  lastError: {
    type: String,
    trim: true
  },
  setupCodeHash: {
    type: String,
    select: false
  },
  setupCodeExpiresAt: {
    type: Date,
    default: null
  },
  setupCodeUsedAt: {
    type: Date,
    default: null
  },
  deviceTokenHash: {
    type: String,
    select: false
  },
  deviceTokenCreatedAt: {
    type: Date,
    default: null
  },
  deviceTokenVersion: {
    type: Number,
    min: 0,
    default: 0
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
  versionKey: false,
  collection: 'sensor_nodes'
});

sensorNodeSchema.pre('save', function updateTimestamp() {
  this.updatedAt = new Date();
});

sensorNodeSchema.index({ deviceId: 1 }, { unique: true, sparse: true });
sensorNodeSchema.index({ hardwareId: 1 }, { unique: true, sparse: true });
sensorNodeSchema.index({ status: 1, lastSeen: 1 });
sensorNodeSchema.index({ room: 1, name: 1 });

module.exports = mongoose.model('SensorNode', sensorNodeSchema);

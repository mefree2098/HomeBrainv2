const mongoose = require('mongoose');

const retentionDays = Math.max(
  1,
  Number(process.env.DEVICE_ENERGY_SAMPLE_RETENTION_DAYS || process.env.HOMEBRAIN_TELEMETRY_RETENTION_DAYS || 365)
);

const deviceEnergySampleSchema = new mongoose.Schema({
  deviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    required: true,
    index: true
  },
  source: {
    type: String,
    default: 'smartthings'
  },
  powerValue: {
    type: Number,
    default: null
  },
  powerUnit: {
    type: String,
    default: ''
  },
  powerTimestamp: {
    type: Date,
    default: null
  },
  energyValue: {
    type: Number,
    default: null
  },
  energyUnit: {
    type: String,
    default: ''
  },
  energyTimestamp: {
    type: Date,
    default: null
  },
  recordedAt: {
    type: Date,
    required: true,
    index: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  }
}, {
  versionKey: false,
  collection: 'device_energy_samples'
});

deviceEnergySampleSchema.index({ deviceId: 1, recordedAt: -1 });
deviceEnergySampleSchema.index(
  { recordedAt: 1 },
  {
    expireAfterSeconds: retentionDays * 24 * 60 * 60,
    name: 'device_energy_samples_ttl'
  }
);

module.exports = mongoose.model('DeviceEnergySample', deviceEnergySampleSchema);

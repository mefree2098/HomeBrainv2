const mongoose = require('mongoose');

const retentionDays = Math.max(
  1,
  Number(process.env.SENSE_MONITOR_SNAPSHOT_RETENTION_DAYS || process.env.HOMEBRAIN_TELEMETRY_RETENTION_DAYS || 365)
);

const SenseActiveDeviceSchema = new mongoose.Schema({
  senseDeviceId: {
    type: String,
    default: ''
  },
  name: {
    type: String,
    default: ''
  },
  icon: {
    type: String,
    default: ''
  },
  powerW: {
    type: Number,
    default: 0
  },
  sharePct: {
    type: Number,
    default: null
  },
  alwaysOn: {
    type: Boolean,
    default: false
  },
  synthetic: {
    type: Boolean,
    default: false
  }
}, { _id: false });

const SenseMonitorSnapshotSchema = new mongoose.Schema({
  monitorId: {
    type: String,
    required: true,
    index: true
  },
  monitorName: {
    type: String,
    default: ''
  },
  observedAt: {
    type: Date,
    required: true,
    index: true
  },
  powerW: {
    type: Number,
    default: 0
  },
  solarW: {
    type: Number,
    default: 0
  },
  netW: {
    type: Number,
    default: 0
  },
  alwaysOnW: {
    type: Number,
    default: null
  },
  otherW: {
    type: Number,
    default: 0
  },
  untrackedW: {
    type: Number,
    default: 0
  },
  activeDeviceCount: {
    type: Number,
    default: 0
  },
  voltage: {
    type: [Number],
    default: []
  },
  frequencyHz: {
    type: Number,
    default: null
  },
  activeDevices: {
    type: [SenseActiveDeviceSchema],
    default: []
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({})
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  }
}, {
  versionKey: false,
  collection: 'sense_monitor_snapshots'
});

SenseMonitorSnapshotSchema.index({ monitorId: 1, observedAt: -1 });
SenseMonitorSnapshotSchema.index(
  { observedAt: 1 },
  {
    expireAfterSeconds: retentionDays * 24 * 60 * 60,
    name: 'sense_monitor_snapshots_ttl'
  }
);

module.exports = mongoose.model('SenseMonitorSnapshot', SenseMonitorSnapshotSchema);

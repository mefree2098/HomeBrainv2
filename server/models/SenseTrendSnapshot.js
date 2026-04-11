const mongoose = require('mongoose');

const retentionDays = Math.max(
  1,
  Number(process.env.SENSE_TREND_SNAPSHOT_RETENTION_DAYS || process.env.HOMEBRAIN_TELEMETRY_RETENTION_DAYS || 365)
);

const SenseTrendDeviceSchema = new mongoose.Schema({
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
  totalKwh: {
    type: Number,
    default: 0
  },
  sharePct: {
    type: Number,
    default: null
  }
}, { _id: false });

const SenseTrendSnapshotSchema = new mongoose.Schema({
  monitorId: {
    type: String,
    required: true,
    index: true
  },
  monitorName: {
    type: String,
    default: ''
  },
  scale: {
    type: String,
    enum: ['day', 'week', 'month', 'year', 'cycle'],
    required: true,
    index: true
  },
  startAt: {
    type: Date,
    required: true,
    index: true
  },
  syncedAt: {
    type: Date,
    required: true,
    index: true
  },
  consumptionTotalKwh: {
    type: Number,
    default: 0
  },
  productionTotalKwh: {
    type: Number,
    default: 0
  },
  productionPct: {
    type: Number,
    default: null
  },
  netProductionKwh: {
    type: Number,
    default: null
  },
  fromGridKwh: {
    type: Number,
    default: null
  },
  toGridKwh: {
    type: Number,
    default: null
  },
  solarPoweredPct: {
    type: Number,
    default: null
  },
  deviceBreakdown: {
    type: [SenseTrendDeviceSchema],
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
  collection: 'sense_trend_snapshots'
});

SenseTrendSnapshotSchema.index({ monitorId: 1, scale: 1, startAt: -1 }, { unique: true });
SenseTrendSnapshotSchema.index(
  { startAt: 1 },
  {
    expireAfterSeconds: retentionDays * 24 * 60 * 60,
    name: 'sense_trend_snapshots_ttl'
  }
);

module.exports = mongoose.model('SenseTrendSnapshot', SenseTrendSnapshotSchema);

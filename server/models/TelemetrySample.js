const mongoose = require('mongoose');

const retentionDays = Math.max(
  1,
  Number(process.env.HOMEBRAIN_TELEMETRY_RETENTION_DAYS || 365)
);

const telemetrySampleSchema = new mongoose.Schema({
  sourceType: {
    type: String,
    enum: ['device', 'tempest_station'],
    required: true,
    index: true
  },
  sourceId: {
    type: String,
    required: true,
    index: true
  },
  sourceKey: {
    type: String,
    required: true,
    index: true
  },
  sourceName: {
    type: String,
    default: ''
  },
  sourceCategory: {
    type: String,
    default: ''
  },
  sourceRoom: {
    type: String,
    default: ''
  },
  sourceOrigin: {
    type: String,
    default: ''
  },
  streamType: {
    type: String,
    enum: ['device_state', 'tempest_observation'],
    required: true,
    index: true
  },
  metricKeys: {
    type: [String],
    default: []
  },
  metrics: {
    type: Map,
    of: Number,
    default: {}
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
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
  collection: 'telemetry_samples'
});

telemetrySampleSchema.index({ sourceKey: 1, recordedAt: -1 });
telemetrySampleSchema.index({ sourceType: 1, sourceId: 1, recordedAt: -1 });
telemetrySampleSchema.index({ sourceKey: 1, streamType: 1, recordedAt: -1 });
telemetrySampleSchema.index({ streamType: 1, recordedAt: -1 });
telemetrySampleSchema.index(
  { recordedAt: 1 },
  {
    expireAfterSeconds: retentionDays * 24 * 60 * 60,
    name: 'telemetry_samples_ttl'
  }
);

module.exports = mongoose.model('TelemetrySample', telemetrySampleSchema);

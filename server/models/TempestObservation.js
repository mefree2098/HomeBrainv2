const mongoose = require('mongoose');

const retentionDays = Math.max(
  1,
  Number(process.env.TEMPEST_HISTORY_RETENTION_DAYS || process.env.HOMEBRAIN_TELEMETRY_RETENTION_DAYS || 365)
);

const TempestObservationSchema = new mongoose.Schema({
  stationId: {
    type: Number,
    required: true,
    index: true
  },
  deviceId: {
    type: Number,
    required: true,
    index: true
  },
  stationName: {
    type: String,
    default: ''
  },
  observationType: {
    type: String,
    required: true
  },
  source: {
    type: String,
    enum: ['rest', 'udp', 'ws'],
    required: true
  },
  observedAt: {
    type: Date,
    required: true,
    index: true
  },
  metrics: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  derived: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  raw: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  }
}, {
  versionKey: false
});

TempestObservationSchema.index(
  { stationId: 1, deviceId: 1, observedAt: 1, observationType: 1 },
  { unique: true, name: 'tempest_observation_unique' }
);
TempestObservationSchema.index(
  { observedAt: 1 },
  {
    expireAfterSeconds: retentionDays * 24 * 60 * 60,
    name: 'tempest_observations_ttl'
  }
);

module.exports = mongoose.model('TempestObservation', TempestObservationSchema);

const mongoose = require('mongoose');

const telemetrySourceSummarySchema = new mongoose.Schema({
  sourceKey: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  sourceType: {
    type: String,
    enum: ['device', 'tempest_station', 'govee_air_quality', 'workflow', 'rainmachine_report', 'sense_monitor', 'sense_device'],
    required: true,
    index: true
  },
  sourceId: {
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
    enum: ['device_state', 'tempest_observation', 'tempest_device_state', 'govee_air_quality_sample', 'workflow_execution', 'rainmachine_daily_stat', 'rainmachine_watering_log', 'sense_monitor_state', 'sense_device_state'],
    default: 'device_state',
    index: true
  },
  streamCounts: {
    type: Map,
    of: Number,
    default: {}
  },
  metricKeys: {
    type: [String],
    default: []
  },
  sampleCount: {
    type: Number,
    default: 0,
    min: 0
  },
  lastValues: {
    type: Map,
    of: Number,
    default: {}
  },
  lastSampleAt: {
    type: Date,
    default: null,
    index: true
  },
  latestSampleId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  rebuiltAt: {
    type: Date,
    default: null
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
  collection: 'telemetry_source_summaries'
});

telemetrySourceSummarySchema.index({ sourceType: 1, sourceId: 1 });
telemetrySourceSummarySchema.index({ streamType: 1, lastSampleAt: -1 });
telemetrySourceSummarySchema.index({ updatedAt: -1 });

module.exports = mongoose.model('TelemetrySourceSummary', telemetrySourceSummarySchema);

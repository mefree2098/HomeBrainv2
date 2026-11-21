const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  recordedAt: { type: Date, required: true, expires: 35 * 86400 },
  bootedAt: Date,
  commit: String,
  coveredMs: Number,
  latency: [Number],
  serverErrors: Number,
  aborted: Number,
  cpuCoresUsed: Number,
  rssBytes: Number,
  heapUsedBytes: Number,
  availableMemoryPercent: Number,
  processWriteBytes: Number,
  volumeWriteBytes: Number,
  health: mongoose.Schema.Types.Mixed
}, { versionKey: false });

module.exports = mongoose.model('PlatformMeasurement', schema);

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true, enum: ['default'] },
  host: { type: String, default: '192.168.1.1' },
  enabled: { type: Boolean, default: false },
  configured: { type: Boolean, default: false },
  secrets: { type: String, select: false, default: '' },
  connected: { type: Boolean, default: false },
  lastSyncAt: { type: Date, default: null },
  lastError: { type: String, default: '' },
  lastFailure: { type: mongoose.Schema.Types.Mixed, default: null },
  retryBlocked: { type: Boolean, default: false },
  clients: { type: [mongoose.Schema.Types.Mixed], default: [] },
  nodes: { type: [mongoose.Schema.Types.Mixed], default: [] },
  metadataError: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('DecoIntegration', schema);

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  provider: { type: String, enum: ['midea', 'econet'], required: true, unique: true },
  enabled: { type: Boolean, default: false },
  email: { type: String, default: '' },
  room: { type: String, default: '' },
  connections: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // AES-GCM encrypted; the runtime key is kept separately from the database.
  secrets: { type: String, select: false, default: '' },
  configured: { type: Boolean, default: false },
  connected: { type: Boolean, default: false },
  lastSyncAt: { type: Date, default: null },
  lastError: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('ApplianceIntegration', schema);

const mongoose = require('mongoose');

// Retain invocation IDs across reconnects/restarts. Expiration is cleanup, not a replay policy.
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  requestId: { type: String, required: true },
  fingerprint: { type: String, required: true },
  state: { type: String, enum: ['running', 'completed', 'failed'], required: true },
  message: { type: String, required: true },
  results: [{ _id: false, deviceId: String, success: Boolean }],
  heartbeatAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true, versionKey: false });
schema.index({ userId: 1, requestId: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('SiriCommand', schema);

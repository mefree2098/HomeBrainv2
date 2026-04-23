const mongoose = require('mongoose');

const deviceCommandClaimSchema = new mongoose.Schema({
  deviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    required: true,
    unique: true,
    index: true
  },
  commandId: {
    type: String,
    required: true,
    index: true
  },
  source: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  priority: {
    type: Number,
    required: true,
    min: 0,
    max: 100
  },
  ttlSeconds: {
    type: Number,
    required: true,
    min: 0
  },
  reason: {
    type: String,
    default: ''
  },
  actor: {
    type: String,
    default: ''
  },
  action: {
    type: String,
    default: ''
  },
  value: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  issuedAt: {
    type: Date,
    required: true,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  }
}, {
  timestamps: true,
  versionKey: false
});

deviceCommandClaimSchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    name: 'device_command_claim_expiry'
  }
);

module.exports = mongoose.model('DeviceCommandClaim', deviceCommandClaimSchema);

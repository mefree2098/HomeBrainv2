const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  sessionId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true
  },
  tokenHash: {
    type: String,
    required: true,
    trim: true
  },
  clientType: {
    type: String,
    enum: ['ios', 'watchos', 'web', 'android', 'desktop', 'api', 'unknown'],
    default: 'unknown'
  },
  clientName: {
    type: String,
    default: '',
    trim: true,
    maxlength: 200
  },
  deviceId: {
    type: String,
    default: '',
    trim: true,
    maxlength: 200
  },
  appVersion: {
    type: String,
    default: '',
    trim: true,
    maxlength: 80
  },
  userAgent: {
    type: String,
    default: '',
    trim: true,
    maxlength: 1000
  },
  ipAddress: {
    type: String,
    default: '',
    trim: true,
    maxlength: 120
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  },
  lastUsedAt: {
    type: Date,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  revokedAt: {
    type: Date,
    default: null
  },
  revokeReason: {
    type: String,
    default: '',
    trim: true,
    maxlength: 240
  },
  legacyMigrated: {
    type: Boolean,
    default: false
  }
}, {
  versionKey: false,
  timestamps: true
});

schema.index(
  { userId: 1, deviceId: 1, clientType: 1, revokedAt: 1 },
  {
    partialFilterExpression: {
      deviceId: { $exists: true, $type: 'string', $ne: '' }
    }
  }
);

schema.methods.toSanitized = function toSanitized() {
  const object = typeof this.toObject === 'function'
    ? this.toObject()
    : { ...this };

  delete object.tokenHash;
  return object;
};

const UserSession = mongoose.model('UserSession', schema);

module.exports = UserSession;

const mongoose = require('mongoose');

const PushSubscriptionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  installationId: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  platform: {
    type: String,
    enum: ['apns'],
    default: 'apns',
    index: true
  },
  deviceToken: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  deviceFamily: {
    type: String,
    enum: ['iPhone', 'iPad', 'iPod', 'Watch', 'mac', 'unknown'],
    default: 'unknown',
    index: true
  },
  deviceName: {
    type: String,
    default: '',
    trim: true,
    maxlength: 160
  },
  systemVersion: {
    type: String,
    default: '',
    trim: true
  },
  appVersion: {
    type: String,
    default: '',
    trim: true
  },
  buildNumber: {
    type: String,
    default: '',
    trim: true
  },
  environment: {
    type: String,
    enum: ['development', 'sandbox', 'production'],
    default: 'development',
    index: true
  },
  bundleId: {
    type: String,
    default: 'NTechR.HomeBrainApp',
    trim: true
  },
  pushEnabled: {
    type: Boolean,
    default: true,
    index: true
  },
  securityCriticalPushEnabled: {
    type: Boolean,
    default: false,
    index: true
  },
  authorizationStatus: {
    type: String,
    default: 'unknown',
    trim: true
  },
  lastRegisteredAt: {
    type: Date,
    default: Date.now
  },
  lastSeenAt: {
    type: Date,
    default: Date.now
  },
  disabledAt: {
    type: Date,
    default: null,
    index: true
  },
  failureCount: {
    type: Number,
    default: 0
  },
  lastFailureAt: {
    type: Date,
    default: null
  },
  lastFailureReason: {
    type: String,
    default: '',
    trim: true
  }
}, {
  timestamps: true,
  versionKey: false
});

PushSubscriptionSchema.index(
  { userId: 1, installationId: 1, platform: 1 },
  { unique: true }
);

PushSubscriptionSchema.index({ deviceToken: 1, platform: 1 });
PushSubscriptionSchema.index({
  userId: 1,
  pushEnabled: 1,
  securityCriticalPushEnabled: 1,
  disabledAt: 1
});

module.exports = mongoose.model('PushSubscription', PushSubscriptionSchema);

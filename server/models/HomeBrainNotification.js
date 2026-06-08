const mongoose = require('mongoose');

const HomeBrainNotificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  channel: {
    type: String,
    enum: ['normal', 'securityCritical'],
    required: true,
    index: true
  },
  severity: {
    type: String,
    enum: ['info', 'warning', 'critical'],
    default: 'info',
    index: true
  },
  category: {
    type: String,
    enum: ['security', 'device', 'system', 'automation'],
    default: 'system',
    index: true
  },
  eventType: {
    type: String,
    default: '',
    trim: true,
    index: true
  },
  eventKey: {
    type: String,
    default: '',
    trim: true,
    index: true
  },
  source: {
    type: String,
    default: 'homebrain',
    trim: true
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 160
  },
  message: {
    type: String,
    required: true,
    trim: true,
    maxlength: 2000
  },
  deviceId: {
    type: String,
    default: '',
    trim: true,
    index: true
  },
  zoneDeviceId: {
    type: String,
    default: '',
    trim: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  occurredAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  clearedAt: {
    type: Date,
    default: null,
    index: true
  },
  clearedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  pushDelivery: {
    attemptedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['not_applicable', 'skipped', 'sent', 'partial_failure', 'failed'],
      default: 'not_applicable'
    },
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    skippedReason: { type: String, default: '' },
    errors: { type: [String], default: [] }
  }
}, {
  timestamps: true,
  versionKey: false
});

HomeBrainNotificationSchema.index({
  userId: 1,
  channel: 1,
  clearedAt: 1,
  occurredAt: -1
});

HomeBrainNotificationSchema.index({
  userId: 1,
  eventKey: 1,
  clearedAt: 1
});

module.exports = mongoose.model('HomeBrainNotification', HomeBrainNotificationSchema);

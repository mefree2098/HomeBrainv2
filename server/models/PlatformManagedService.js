const mongoose = require('mongoose');

const platformManagedServiceSchema = new mongoose.Schema({
  serviceId: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  displayName: {
    type: String,
    required: true,
    trim: true
  },
  packageName: {
    type: String,
    trim: true,
    default: ''
  },
  currentVersion: {
    type: String,
    trim: true,
    default: ''
  },
  latestVersion: {
    type: String,
    trim: true,
    default: ''
  },
  updateAvailable: {
    type: Boolean,
    default: false
  },
  candidateFirstSeenAt: {
    type: Date,
    default: null
  },
  eligibleForAutoUpdateAt: {
    type: Date,
    default: null
  },
  lastCheckedAt: {
    type: Date,
    default: null
  },
  lastUpdatedAt: {
    type: Date,
    default: null
  },
  lastUpdateStatus: {
    type: String,
    enum: ['never', 'success', 'failed', 'skipped'],
    default: 'never'
  },
  lastError: {
    type: String,
    default: ''
  },
  policy: {
    autoCheckEnabled: {
      type: Boolean,
      default: true
    },
    autoUpdateEnabled: {
      type: Boolean,
      default: false
    },
    checkIntervalDays: {
      type: Number,
      default: 7,
      min: 1,
      max: 90
    },
    stabilityDelayDays: {
      type: Number,
      default: 30,
      min: 0,
      max: 365
    }
  }
}, {
  timestamps: true
});

platformManagedServiceSchema.index({ serviceId: 1 }, { unique: true });
platformManagedServiceSchema.index({ lastCheckedAt: 1 });
platformManagedServiceSchema.index({ eligibleForAutoUpdateAt: 1 });

module.exports = mongoose.model('PlatformManagedService', platformManagedServiceSchema);

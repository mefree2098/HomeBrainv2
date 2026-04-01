const crypto = require('crypto');
const mongoose = require('mongoose');

function randomHubId() {
  return `hub-${crypto.randomBytes(8).toString('hex')}`;
}

const pendingLinkCodeSchema = new mongoose.Schema({
  codeHash: {
    type: String,
    required: true
  },
  codePreview: {
    type: String,
    default: ''
  },
  mode: {
    type: String,
    enum: ['private', 'public'],
    default: 'private'
  },
  createdBy: {
    type: String,
    default: 'system'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    required: true
  },
  consumedAt: {
    type: Date,
    default: null
  }
}, { _id: false });

const recentActivitySchema = new mongoose.Schema({
  direction: {
    type: String,
    enum: ['inbound', 'outbound', 'system'],
    default: 'system'
  },
  type: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['info', 'success', 'warning', 'error'],
    default: 'info'
  },
  message: {
    type: String,
    default: ''
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  occurredAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const alexaBrokerRegistrationSchema = new mongoose.Schema({
  hubId: {
    type: String,
    required: true,
    unique: true,
    default: randomHubId
  },
  status: {
    type: String,
    enum: ['unpaired', 'paired'],
    default: 'unpaired'
  },
  mode: {
    type: String,
    enum: ['private', 'public'],
    default: 'private'
  },
  brokerBaseUrl: {
    type: String,
    default: ''
  },
  brokerClientId: {
    type: String,
    default: ''
  },
  brokerDisplayName: {
    type: String,
    default: ''
  },
  relayTokenHash: {
    type: String,
    default: ''
  },
  publicOrigin: {
    type: String,
    default: ''
  },
  pendingLinkCodes: {
    type: [pendingLinkCodeSchema],
    default: []
  },
  recentActivity: {
    type: [recentActivitySchema],
    default: []
  },
  proactiveEventsEnabled: {
    type: Boolean,
    default: true
  },
  lastRegisteredAt: {
    type: Date,
    default: null
  },
  lastSeenAt: {
    type: Date,
    default: null
  },
  lastCatalogSyncAt: {
    type: Date,
    default: null
  },
  lastCatalogSyncStatus: {
    type: String,
    enum: ['never', 'success', 'failed'],
    default: 'never'
  },
  lastCatalogSyncError: {
    type: String,
    default: ''
  },
  lastStateSyncAt: {
    type: Date,
    default: null
  },
  lastStateSyncStatus: {
    type: String,
    enum: ['never', 'success', 'failed'],
    default: 'never'
  },
  lastStateSyncError: {
    type: String,
    default: ''
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
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
  collection: 'alexa_broker_registrations'
});

alexaBrokerRegistrationSchema.pre('validate', function preValidate() {
  this.hubId = String(this.hubId || randomHubId()).trim();
  this.brokerBaseUrl = String(this.brokerBaseUrl || '').trim().replace(/\/+$/, '');
  this.brokerClientId = String(this.brokerClientId || '').trim();
  this.brokerDisplayName = String(this.brokerDisplayName || '').trim();
  this.publicOrigin = String(this.publicOrigin || '').trim().replace(/\/+$/, '');
  this.pendingLinkCodes = Array.isArray(this.pendingLinkCodes) ? this.pendingLinkCodes : [];
  this.recentActivity = Array.isArray(this.recentActivity)
    ? this.recentActivity.slice(-50)
    : [];
});

alexaBrokerRegistrationSchema.pre('save', function preSave() {
  this.updatedAt = new Date();
});

alexaBrokerRegistrationSchema.index({ status: 1 });

module.exports = mongoose.model('AlexaBrokerRegistration', alexaBrokerRegistrationSchema);

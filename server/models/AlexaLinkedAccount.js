const mongoose = require('mongoose');

const alexaLinkedAccountSchema = new mongoose.Schema({
  hubId: {
    type: String,
    required: true,
    trim: true
  },
  brokerAccountId: {
    type: String,
    required: true,
    trim: true
  },
  alexaUserId: {
    type: String,
    default: '',
    trim: true
  },
  alexaAccountId: {
    type: String,
    default: '',
    trim: true
  },
  alexaHouseholdId: {
    type: String,
    default: '',
    trim: true
  },
  locale: {
    type: String,
    default: 'en-US',
    trim: true
  },
  status: {
    type: String,
    enum: ['linked', 'revoked', 'pending'],
    default: 'linked'
  },
  permissions: {
    type: [String],
    default: []
  },
  acceptedGrantAt: {
    type: Date,
    default: null
  },
  linkedAt: {
    type: Date,
    default: Date.now
  },
  lastDiscoveryAt: {
    type: Date,
    default: null
  },
  lastSeenAt: {
    type: Date,
    default: null
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
  collection: 'alexa_linked_accounts'
});

alexaLinkedAccountSchema.pre('validate', function preValidate() {
  this.hubId = String(this.hubId || '').trim();
  this.brokerAccountId = String(this.brokerAccountId || '').trim();
  this.alexaUserId = String(this.alexaUserId || '').trim();
  this.alexaAccountId = String(this.alexaAccountId || '').trim();
  this.alexaHouseholdId = String(this.alexaHouseholdId || '').trim();
  this.locale = String(this.locale || 'en-US').trim() || 'en-US';
});

alexaLinkedAccountSchema.pre('save', function preSave() {
  this.updatedAt = new Date();
});

alexaLinkedAccountSchema.index({ hubId: 1, brokerAccountId: 1 }, { unique: true });
alexaLinkedAccountSchema.index({ status: 1, hubId: 1 });

module.exports = mongoose.model('AlexaLinkedAccount', alexaLinkedAccountSchema);

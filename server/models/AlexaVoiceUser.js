const mongoose = require('mongoose');

const alexaVoiceUserSchema = new mongoose.Schema({
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
  alexaPersonId: {
    type: String,
    default: '',
    trim: true
  },
  alexaDeviceId: {
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
  label: {
    type: String,
    default: '',
    trim: true
  },
  status: {
    type: String,
    enum: ['unmapped', 'mapped', 'disabled'],
    default: 'unmapped'
  },
  responseMode: {
    type: String,
    enum: ['inherit', 'text', 'ssml', 'audio'],
    default: 'inherit'
  },
  userProfileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserProfile',
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  lastSeenAt: {
    type: Date,
    default: null
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
  collection: 'alexa_voice_users'
});

alexaVoiceUserSchema.pre('validate', function preValidate() {
  this.hubId = String(this.hubId || '').trim();
  this.brokerAccountId = String(this.brokerAccountId || '').trim();
  this.alexaUserId = String(this.alexaUserId || '').trim();
  this.alexaPersonId = String(this.alexaPersonId || '').trim();
  this.alexaDeviceId = String(this.alexaDeviceId || '').trim();
  this.alexaHouseholdId = String(this.alexaHouseholdId || '').trim();
  this.locale = String(this.locale || 'en-US').trim() || 'en-US';
  this.label = String(this.label || '').trim();
});

alexaVoiceUserSchema.pre('save', function preSave() {
  this.updatedAt = new Date();
});

alexaVoiceUserSchema.index({ hubId: 1, brokerAccountId: 1, status: 1 });
alexaVoiceUserSchema.index({ hubId: 1, brokerAccountId: 1, alexaUserId: 1 });
alexaVoiceUserSchema.index({ hubId: 1, brokerAccountId: 1, alexaPersonId: 1 });
alexaVoiceUserSchema.index({ userProfileId: 1, status: 1 });

module.exports = mongoose.model('AlexaVoiceUser', alexaVoiceUserSchema);

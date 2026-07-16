const mongoose = require('mongoose');

const SUPPORT_REQUEST_RETENTION_DAYS = 90;
const SUPPORT_REQUEST_STATUSES = ['open', 'in_progress', 'resolved'];

const PublicSupportRequestSchema = new mongoose.Schema({
  requestId: {
    type: String,
    required: true,
    unique: true,
    index: true,
    lowercase: true,
    trim: true
  },
  name: {
    type: String,
    default: '',
    maxlength: 80,
    trim: true
  },
  email: {
    type: String,
    required: true,
    maxlength: 254,
    lowercase: true,
    trim: true
  },
  subject: {
    type: String,
    required: true,
    minlength: 3,
    maxlength: 120,
    trim: true
  },
  message: {
    type: String,
    required: true,
    minlength: 20,
    maxlength: 1400,
    trim: true
  },
  appVersion: {
    type: String,
    default: '',
    maxlength: 40,
    trim: true
  },
  device: {
    type: String,
    default: '',
    maxlength: 100,
    trim: true
  },
  status: {
    type: String,
    enum: SUPPORT_REQUEST_STATUSES,
    default: 'open',
    required: true,
    index: true
  },
  internalNote: {
    type: String,
    default: '',
    maxlength: 1000,
    trim: true
  },
  handledAt: {
    type: Date,
    default: null
  },
  lastHandledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  resolvedAt: {
    type: Date,
    default: null
  },
  submittedAt: {
    type: Date,
    required: true,
    default: Date.now,
    index: true
  },
  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + SUPPORT_REQUEST_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  }
}, {
  timestamps: true,
  versionKey: false
});

PublicSupportRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PublicSupportRequest', PublicSupportRequestSchema);

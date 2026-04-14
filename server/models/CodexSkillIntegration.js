const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  singletonKey: {
    type: String,
    default: 'primary',
    immutable: true,
    unique: true,
    index: true
  },
  enabled: {
    type: Boolean,
    default: true
  },
  displayName: {
    type: String,
    default: 'HomeBrain Codex Live Admin',
    trim: true,
    maxlength: 120
  },
  publishedBaseUrl: {
    type: String,
    default: '',
    trim: true,
    maxlength: 500
  },
  notes: {
    type: String,
    default: '',
    trim: true,
    maxlength: 2000
  },
  issuedToUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  issuedToEmail: {
    type: String,
    default: '',
    trim: true,
    maxlength: 320
  },
  tokenHash: {
    type: String,
    default: ''
  },
  tokenPrefix: {
    type: String,
    default: ''
  },
  tokenCreatedAt: {
    type: Date,
    default: null
  },
  tokenRotatedAt: {
    type: Date,
    default: null
  },
  createdBy: {
    type: String,
    default: 'system'
  },
  lastUsedAt: {
    type: Date,
    default: null
  },
  lastUsedIp: {
    type: String,
    default: ''
  },
  lastUserAgent: {
    type: String,
    default: ''
  }
}, {
  timestamps: true,
  versionKey: false
});

schema.statics.getIntegration = async function getIntegration() {
  let integration = await this.findOne({ singletonKey: 'primary' });

  if (!integration) {
    integration = new this({ singletonKey: 'primary' });
    await integration.save();
  }

  return integration;
};

schema.methods.toSanitized = function toSanitized() {
  const value = this.toObject();
  delete value.tokenHash;

  return {
    ...value,
    tokenConfigured: Boolean(value.tokenPrefix && value.tokenCreatedAt)
  };
};

module.exports = mongoose.model('CodexSkillIntegration', schema);

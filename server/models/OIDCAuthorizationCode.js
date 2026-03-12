const mongoose = require('mongoose');

const oidcAuthorizationCodeSchema = new mongoose.Schema({
  codeHash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  clientId: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  redirectUri: {
    type: String,
    required: true
  },
  scopes: {
    type: [String],
    default: ['openid']
  },
  nonce: {
    type: String,
    default: ''
  },
  codeChallenge: {
    type: String,
    default: ''
  },
  codeChallengeMethod: {
    type: String,
    enum: ['plain', 'S256', ''],
    default: ''
  },
  authTime: {
    type: Date,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true,
    expires: 0
  },
  consumedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  versionKey: false
});

module.exports = mongoose.model('OIDCAuthorizationCode', oidcAuthorizationCodeSchema);

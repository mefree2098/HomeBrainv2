const mongoose = require('mongoose');

const oidcClientSchema = new mongoose.Schema({
  clientId: {
    type: String,
    trim: true,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    trim: true,
    required: true
  },
  platform: {
    type: String,
    trim: true,
    default: 'custom'
  },
  enabled: {
    type: Boolean,
    default: true
  },
  redirectUris: {
    type: [String],
    default: []
  },
  scopes: {
    type: [String],
    default: ['openid', 'profile', 'email']
  },
  requirePkce: {
    type: Boolean,
    default: true
  },
  tokenEndpointAuthMethod: {
    type: String,
    enum: ['none', 'client_secret_post', 'client_secret_basic'],
    default: 'none'
  },
  clientSecretHash: {
    type: String,
    default: ''
  },
  updatedBy: {
    type: String,
    default: 'system'
  }
}, {
  timestamps: true,
  versionKey: false
});

module.exports = mongoose.model('OIDCClient', oidcClientSchema);

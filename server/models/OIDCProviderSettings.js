const crypto = require('crypto');
const mongoose = require('mongoose');

function generateSigningKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  const keyId = crypto
    .createHash('sha256')
    .update(publicKey)
    .digest('base64url')
    .slice(0, 24);

  return {
    signingKeyId: keyId,
    signingPublicKeyPem: publicKey,
    signingPrivateKeyPem: privateKey
  };
}

const defaultKeyPair = generateSigningKeyPair();

const oidcProviderSettingsSchema = new mongoose.Schema({
  singletonKey: {
    type: String,
    default: 'default',
    unique: true
  },
  signingKeyId: {
    type: String,
    trim: true,
    default: defaultKeyPair.signingKeyId
  },
  signingPrivateKeyPem: {
    type: String,
    default: defaultKeyPair.signingPrivateKeyPem
  },
  signingPublicKeyPem: {
    type: String,
    default: defaultKeyPair.signingPublicKeyPem
  },
  updatedBy: {
    type: String,
    default: 'system'
  }
}, {
  timestamps: true
});

oidcProviderSettingsSchema.statics.getSettings = async function getSettings() {
  let settings = await this.findOne({ singletonKey: 'default' });
  if (!settings) {
    settings = await this.create({ singletonKey: 'default' });
  }
  return settings;
};

module.exports = mongoose.model('OIDCProviderSettings', oidcProviderSettingsSchema);

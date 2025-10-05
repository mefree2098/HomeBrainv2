const mongoose = require('mongoose');
const crypto = require('crypto');

const sslCertificateSchema = new mongoose.Schema({
  domain: {
    type: String,
    required: true,
    trim: true,
    index: true
  },

  // Certificate content (PEM format)
  certificate: {
    type: String,
    required: true
  },

  // Private key (encrypted)
  privateKey: {
    type: String,
    required: true
  },

  // Certificate chain (intermediate certificates)
  certificateChain: {
    type: String,
    default: ''
  },

  // Certificate provider
  provider: {
    type: String,
    enum: ['manual', 'letsencrypt'],
    default: 'manual'
  },

  // Certificate status
  status: {
    type: String,
    enum: ['active', 'inactive', 'expired', 'pending'],
    default: 'inactive'
  },

  // Certificate expiry date
  expiryDate: {
    type: Date,
    required: true
  },

  // Certificate issued date
  issuedDate: {
    type: Date,
    required: true
  },

  // Subject Alternative Names (SANs)
  subjectAltNames: [{
    type: String
  }],

  // Issuer information
  issuer: {
    commonName: String,
    organization: String,
    country: String
  },

  // Subject information
  subject: {
    commonName: String,
    organization: String,
    organizationalUnit: String,
    locality: String,
    state: String,
    country: String,
    emailAddress: String
  },

  // Let's Encrypt specific fields
  letsEncrypt: {
    accountEmail: String,
    challengeType: {
      type: String,
      enum: ['http-01', 'dns-01'],
      default: 'http-01'
    },
    autoRenew: {
      type: Boolean,
      default: true
    },
    lastRenewalAttempt: Date,
    renewalErrors: [String]
  },

  // CSR (Certificate Signing Request) if generated
  csr: String,

  // Auto-renewal settings
  autoRenew: {
    type: Boolean,
    default: false
  },

  renewalDaysBeforeExpiry: {
    type: Number,
    default: 30
  },

  // Metadata
  notes: String,

  lastChecked: Date,

  createdAt: {
    type: Date,
    default: Date.now
  },

  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes
sslCertificateSchema.index({ status: 1, expiryDate: 1 });
sslCertificateSchema.index({ domain: 1, status: 1 });

// Update timestamp on save
sslCertificateSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Instance method to encrypt private key
sslCertificateSchema.methods.encryptPrivateKey = function(privateKey) {
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync(process.env.JWT_SECRET || 'homebrain-ssl-secret', 'salt', 32);
  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return iv.toString('hex') + ':' + encrypted;
};

// Instance method to decrypt private key
sslCertificateSchema.methods.decryptPrivateKey = function() {
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync(process.env.JWT_SECRET || 'homebrain-ssl-secret', 'salt', 32);

  const parts = this.privateKey.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encrypted = parts.join(':');

  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
};

// Instance method to check if certificate is expiring soon
sslCertificateSchema.methods.isExpiringSoon = function() {
  const daysUntilExpiry = Math.floor((this.expiryDate - Date.now()) / (1000 * 60 * 60 * 24));
  return daysUntilExpiry <= this.renewalDaysBeforeExpiry;
};

// Instance method to check if certificate is expired
sslCertificateSchema.methods.isExpired = function() {
  return this.expiryDate < Date.now();
};

// Static method to get active certificate for domain
sslCertificateSchema.statics.getActiveCertificate = async function(domain) {
  return await this.findOne({
    domain: domain,
    status: 'active',
    expiryDate: { $gt: new Date() }
  }).sort({ expiryDate: -1 });
};

// Static method to get certificates expiring soon
sslCertificateSchema.statics.getExpiringSoon = async function(days = 30) {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + days);

  return await this.find({
    status: 'active',
    expiryDate: { $lte: futureDate, $gt: new Date() }
  });
};

// Static method to deactivate old certificates for domain
sslCertificateSchema.statics.deactivateOldCertificates = async function(domain, excludeId) {
  return await this.updateMany(
    {
      domain: domain,
      _id: { $ne: excludeId }
    },
    {
      $set: { status: 'inactive' }
    }
  );
};

const SSLCertificate = mongoose.model('SSLCertificate', sslCertificateSchema);

module.exports = SSLCertificate;

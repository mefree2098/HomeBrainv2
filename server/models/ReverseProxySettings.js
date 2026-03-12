const mongoose = require('mongoose');

const getDefaultAcmeEnv = () => (
  process.env.ACME_ENV === 'production' ? 'production' : 'staging'
);

const reverseProxySettingsSchema = new mongoose.Schema({
  singletonKey: {
    type: String,
    default: 'default',
    unique: true
  },
  caddyAdminUrl: {
    type: String,
    trim: true,
    default: process.env.CADDY_ADMIN_URL || 'http://127.0.0.1:2019'
  },
  caddyStorageRoot: {
    type: String,
    trim: true,
    default: process.env.CADDY_STORAGE_ROOT || '/var/lib/caddy'
  },
  acmeEnv: {
    type: String,
    enum: ['staging', 'production'],
    default: getDefaultAcmeEnv
  },
  acmeEmail: {
    type: String,
    trim: true,
    default: process.env.CADDY_ACME_EMAIL || ''
  },
  expectedPublicIp: {
    type: String,
    trim: true,
    default: process.env.HOMEBRAIN_EXPECTED_PUBLIC_IP || ''
  },
  expectedPublicIpv6: {
    type: String,
    trim: true,
    default: process.env.HOMEBRAIN_EXPECTED_PUBLIC_IPV6 || ''
  },
  onDemandTlsEnabled: {
    type: Boolean,
    default: false
  },
  accessLogsEnabled: {
    type: Boolean,
    default: true
  },
  adminApiEnabled: {
    type: Boolean,
    default: true
  },
  lastAppliedConfigText: {
    type: String,
    default: ''
  },
  lastAppliedConfigHash: {
    type: String,
    default: ''
  },
  lastApplyStatus: {
    type: String,
    enum: ['never', 'success', 'failed'],
    default: 'never'
  },
  lastApplyError: {
    type: String,
    default: ''
  },
  lastAppliedAt: {
    type: Date,
    default: null
  },
  updatedBy: {
    type: String,
    default: 'system'
  }
}, {
  timestamps: true
});

reverseProxySettingsSchema.statics.getSettings = async function getSettings() {
  let settings = await this.findOne({ singletonKey: 'default' });
  if (!settings) {
    settings = await this.create({ singletonKey: 'default' });
  }
  return settings;
};

module.exports = mongoose.model('ReverseProxySettings', reverseProxySettingsSchema);

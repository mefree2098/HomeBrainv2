const mongoose = require('mongoose');

function hasPublicBaseUrl() {
  const baseUrl = String(process.env.HOMEBRAIN_PUBLIC_BASE_URL || '').trim();
  if (!baseUrl) {
    return false;
  }

  try {
    const parsed = new URL(baseUrl);
    const host = (parsed.hostname || '').trim().toLowerCase();
    return Boolean(
      host
      && host !== 'localhost'
      && host !== '127.0.0.1'
      && host !== '::1'
    );
  } catch (_error) {
    return false;
  }
}

const getDefaultAcmeEnv = () => {
  if (process.env.ACME_ENV === 'production') {
    return 'production';
  }

  if (process.env.ACME_ENV === 'staging') {
    return 'staging';
  }

  return hasPublicBaseUrl() ? 'production' : 'staging';
};

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

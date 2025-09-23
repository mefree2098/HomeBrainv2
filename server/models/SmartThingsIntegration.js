const mongoose = require('mongoose');

const SmartThingsIntegrationSchema = new mongoose.Schema({
  // OAuth Configuration
  clientId: {
    type: String,
    required: true
  },
  clientSecret: {
    type: String,
    required: true
  },
  redirectUri: {
    type: String,
    required: true
  },

  // OAuth Tokens
  accessToken: {
    type: String,
    default: ''
  },
  refreshToken: {
    type: String,
    default: ''
  },
  tokenType: {
    type: String,
    default: 'Bearer'
  },
  expiresAt: {
    type: Date,
    default: null
  },
  scope: {
    type: [String],
    default: ['r:devices:*', 'x:devices:*', 'r:scenes:*', 'x:scenes:*', 'r:locations:*']
  },

  // Integration Status
  isConfigured: {
    type: Boolean,
    default: false
  },
  isConnected: {
    type: Boolean,
    default: false
  },
  lastSync: {
    type: Date,
    default: null
  },
  lastError: {
    type: String,
    default: ''
  },

  // Device Management
  connectedDevices: [{
    deviceId: String,
    name: String,
    label: String,
    room: String,
    capabilities: [String],
    components: [String],
    lastUpdated: { type: Date, default: Date.now }
  }],

  // STHM Virtual Switches for Security Integration
  sthm: {
    armAwayDeviceId: {
      type: String,
      default: ''
    },
    armStayDeviceId: {
      type: String,
      default: ''
    },
    disarmDeviceId: {
      type: String,
      default: ''
    }
  },

  // Metadata
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Update updatedAt on save
SmartThingsIntegrationSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Static method to get or create integration
SmartThingsIntegrationSchema.statics.getIntegration = async function() {
  console.log('SmartThingsIntegration: Getting integration configuration');

  let integration = await this.findOne();

  if (!integration) {
    console.log('SmartThingsIntegration: No integration found, returning unconfigured status');
    // Return a plain object with default unconfigured state instead of trying to save invalid document
    return {
      clientId: process.env.SMARTTHINGS_CLIENT_ID || '',
      clientSecret: process.env.SMARTTHINGS_CLIENT_SECRET || '',
      redirectUri: process.env.SMARTTHINGS_REDIRECT_URI || 'http://localhost:3000/api/smartthings/callback',
      accessToken: '',
      refreshToken: '',
      tokenType: 'Bearer',
      expiresAt: null,
      scope: ['r:devices:*', 'x:devices:*', 'r:scenes:*', 'x:scenes:*', 'r:locations:*'],
      isConfigured: false,
      isConnected: false,
      lastSync: null,
      lastError: '',
      connectedDevices: [],
      sthm: {
        armAwayDeviceId: '',
        armStayDeviceId: '',
        disarmDeviceId: ''
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      // Add methods that would be expected
      isTokenValid: () => false,
      clearTokens: async function(errorMessage = '') {
        // For the mock object, we don't actually need to do anything
        // since there's no database record to update
        console.log('SmartThingsIntegration: Mock clearTokens called - no database record to clear');
        return Promise.resolve();
      },
      toSanitized: function() {
        const sanitized = { ...this };
        if (sanitized.clientSecret) {
          sanitized.clientSecret = sanitized.clientSecret.replace(/.(?=.{4})/g, '*');
        }
        if (sanitized.accessToken) {
          sanitized.accessToken = sanitized.accessToken.replace(/.(?=.{4})/g, '*');
        }
        if (sanitized.refreshToken) {
          sanitized.refreshToken = sanitized.refreshToken.replace(/.(?=.{4})/g, '*');
        }
        return sanitized;
      }
    };
  }

  return integration;
};

// Static method to create or update integration with OAuth configuration
SmartThingsIntegrationSchema.statics.configureIntegration = async function(config) {
  console.log('SmartThingsIntegration: Configuring integration with OAuth settings');

  let integration = await this.findOne();

  if (!integration) {
    console.log('SmartThingsIntegration: Creating new integration configuration');
    integration = new this({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri || process.env.SMARTTHINGS_REDIRECT_URI || 'http://localhost:3000/api/smartthings/callback',
      isConfigured: true
    });
  } else {
    console.log('SmartThingsIntegration: Updating existing integration configuration');
    integration.clientId = config.clientId;
    integration.clientSecret = config.clientSecret;
    if (config.redirectUri) {
      integration.redirectUri = config.redirectUri;
    }
    integration.isConfigured = true;
  }

  await integration.save();
  console.log('SmartThingsIntegration: OAuth configuration saved successfully');
  return integration;
};

// Method to check if tokens are valid
SmartThingsIntegrationSchema.methods.isTokenValid = function() {
  if (!this.accessToken || !this.expiresAt) {
    return false;
  }

  // Check if token expires within the next 5 minutes
  const expiryBuffer = new Date(Date.now() + 5 * 60 * 1000);
  return this.expiresAt > expiryBuffer;
};

// Method to update OAuth tokens
SmartThingsIntegrationSchema.methods.updateTokens = async function(tokenData) {
  console.log('SmartThingsIntegration: Updating OAuth tokens');

  this.accessToken = tokenData.access_token;
  this.tokenType = tokenData.token_type || 'Bearer';

  if (tokenData.refresh_token) {
    this.refreshToken = tokenData.refresh_token;
  }

  // Set expiration time (subtract 5 minutes for safety buffer)
  if (tokenData.expires_in) {
    this.expiresAt = new Date(Date.now() + (tokenData.expires_in - 300) * 1000);
  }

  this.isConnected = true;
  this.lastError = '';

  await this.save();
  console.log('SmartThingsIntegration: OAuth tokens updated successfully');
};

// Method to clear tokens (on error or disconnection)
SmartThingsIntegrationSchema.methods.clearTokens = async function(errorMessage = '') {
  console.log('SmartThingsIntegration: Clearing OAuth tokens');

  this.accessToken = '';
  this.refreshToken = '';
  this.expiresAt = null;
  this.isConnected = false;
  this.lastError = errorMessage;

  await this.save();
  console.log('SmartThingsIntegration: OAuth tokens cleared');
};

// Method to update device list
SmartThingsIntegrationSchema.methods.updateDevices = async function(devices) {
  console.log(`SmartThingsIntegration: Updating device list with ${devices.length} devices`);

  this.connectedDevices = devices.map(device => ({
    deviceId: device.deviceId,
    name: device.name,
    label: device.label,
    room: device.roomId || '',
    capabilities: device.components?.[0]?.capabilities?.map(cap => cap.id) || [],
    components: device.components?.map(comp => comp.id) || [],
    lastUpdated: new Date()
  }));

  this.lastSync = new Date();
  await this.save();

  console.log('SmartThingsIntegration: Device list updated successfully');
};

// Method to get sanitized data (without sensitive information)
SmartThingsIntegrationSchema.methods.toSanitized = function() {
  const sanitized = this.toObject();

  // Mask sensitive data
  if (sanitized.clientSecret) {
    sanitized.clientSecret = sanitized.clientSecret.replace(/.(?=.{4})/g, '*');
  }
  if (sanitized.accessToken) {
    sanitized.accessToken = sanitized.accessToken.replace(/.(?=.{4})/g, '*');
  }
  if (sanitized.refreshToken) {
    sanitized.refreshToken = sanitized.refreshToken.replace(/.(?=.{4})/g, '*');
  }

  return sanitized;
};

module.exports = mongoose.model('SmartThingsIntegration', SmartThingsIntegrationSchema);
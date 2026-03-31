const mongoose = require('mongoose');

const trimString = (value) => (typeof value === 'string' ? value.trim() : value ?? '');

const REQUIRED_SMARTTHINGS_SCOPES = [
  'r:devices:*',
  'x:devices:*',
  'r:scenes:*',
  'x:scenes:*',
  'r:locations:*',
  'x:locations:*',
  'r:rules:*',
  'w:rules:*',
  'r:security:locations:*:armstate'
];

const DEPRECATED_SMARTTHINGS_SCOPES = [
  'x:rules:*'
];

const sanitizeScopes = (scopes) => {
  const rawScopes = Array.isArray(scopes) ? scopes : [];
  const filteredScopes = rawScopes
    .filter(scope => typeof scope === 'string')
    .map(scope => scope.trim())
    .filter(scope => scope.length > 0 && !DEPRECATED_SMARTTHINGS_SCOPES.includes(scope));

  return Array.from(new Set([...filteredScopes, ...REQUIRED_SMARTTHINGS_SCOPES]));
};

const SmartThingsIntegrationSchema = new mongoose.Schema({
  // OAuth Configuration
  clientId: {
    type: String,
    required: true,
    set: value => typeof value === 'string' ? value.trim() : value
  },
  clientSecret: {
    type: String,
    required: true,
    set: value => typeof value === 'string' ? value.trim() : value
  },
  redirectUri: {
    type: String,
    required: true,
    set: value => typeof value === 'string' ? value.trim() : value
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
    default: () => [...REQUIRED_SMARTTHINGS_SCOPES]
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
    },
    dismissDeviceId: {
      type: String,
      default: ''
    },
    locationId: {
      type: String,
      default: ''
    },
    lastArmState: {
      type: String,
      default: ''
    },
    lastArmStateUpdatedAt: {
      type: Date,
      default: null
    },
    lastCommandRequestedState: {
      type: String,
      default: ''
    },
    lastCommandRequestedAt: {
      type: Date,
      default: null
    },
    lastCommandResult: {
      type: String,
      default: ''
    },
    lastCommandError: {
      type: String,
      default: ''
    },
    lastCommandDeviceId: {
      type: String,
      default: ''
    }
  },

  // Webhook / SmartApp metadata
  webhook: {
    installedAppId: {
      type: String,
      default: ''
    },
    locationId: {
      type: String,
      default: ''
    },
    subscriptions: [{
      subscriptionId: {
        type: String,
        default: ''
      },
      sourceType: {
        type: String,
        default: ''
      },
      deviceId: {
        type: String,
        default: ''
      },
      capability: {
        type: String,
        default: ''
      },
      attribute: {
        type: String,
        default: ''
      },
      componentId: {
        type: String,
        default: ''
      },
      subscriptionName: {
        type: String,
        default: ''
      },
      stateChangeOnly: {
        type: Boolean,
        default: true
      },
      value: {
        type: String,
        default: ''
      },
      createdDate: {
        type: Date,
        default: null
      },
      expirationTime: {
        type: Date,
        default: null
      }
    }],
    lastSubscriptionSync: {
      type: Date,
      default: null
    },
    lastLifecycleHandledAt: {
      type: Date,
      default: null
    },
    lastEventReceivedAt: {
      type: Date,
      default: null
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
SmartThingsIntegrationSchema.pre('save', function() {
  this.updatedAt = new Date();
});

// Static method to get or create integration
SmartThingsIntegrationSchema.statics.getIntegration = async function() {
  console.log('SmartThingsIntegration: Getting integration configuration');

  let integration = await this.findOne();

  if (!integration) {
    console.log('SmartThingsIntegration: No integration found, returning unconfigured status');
    // Return a plain object with default unconfigured state instead of trying to save invalid document
    return {
      clientId: trimString(process.env.SMARTTHINGS_CLIENT_ID || ''),
      clientSecret: trimString(process.env.SMARTTHINGS_CLIENT_SECRET || ''),
      redirectUri: trimString(process.env.SMARTTHINGS_REDIRECT_URI || 'http://localhost:3000/api/smartthings/callback'),
      accessToken: '',
      refreshToken: '',
      tokenType: 'Bearer',
      expiresAt: null,
      scope: [...REQUIRED_SMARTTHINGS_SCOPES],
      isConfigured: false,
      isConnected: false,
      lastSync: null,
      lastError: '',
      connectedDevices: [],
        sthm: {
          armAwayDeviceId: '',
          armStayDeviceId: '',
          disarmDeviceId: '',
          dismissDeviceId: '',
          locationId: '',
          lastArmState: '',
          lastArmStateUpdatedAt: null,
          lastCommandRequestedState: '',
          lastCommandRequestedAt: null,
          lastCommandResult: '',
          lastCommandError: '',
          lastCommandDeviceId: ''
        },
        webhook: {
          installedAppId: '',
          locationId: '',
          subscriptions: [],
          lastSubscriptionSync: null,
          lastLifecycleHandledAt: null,
          lastEventReceivedAt: null
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
        updateWebhookState: async function() {
          console.log('SmartThingsIntegration: Mock updateWebhookState called - no database record to update');
          return Promise.resolve();
        },
        clearWebhookState: async function() {
          console.log('SmartThingsIntegration: Mock clearWebhookState called - no database record to update');
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

  if (integration) {
    let changed = false;
    const trimmedClientId = trimString(integration.clientId);
    const trimmedClientSecret = trimString(integration.clientSecret);
    const trimmedRedirectUri = trimString(integration.redirectUri);

    if (integration.clientId !== trimmedClientId) {
      integration.clientId = trimmedClientId;
      changed = true;
    }
    if (integration.clientSecret !== trimmedClientSecret) {
      integration.clientSecret = trimmedClientSecret;
      changed = true;
    }
    if (integration.redirectUri !== trimmedRedirectUri) {
      integration.redirectUri = trimmedRedirectUri;
      changed = true;
    }

    const sanitizedScopes = sanitizeScopes(integration.scope);
    if (!Array.isArray(integration.scope) ||
        integration.scope.length !== sanitizedScopes.length ||
        sanitizedScopes.some((scope, index) => scope !== integration.scope[index])) {
      integration.scope = sanitizedScopes;
      changed = true;
    }

    if (!integration.webhook) {
      integration.webhook = {
        installedAppId: '',
        locationId: '',
        subscriptions: [],
        lastSubscriptionSync: null,
        lastLifecycleHandledAt: null,
        lastEventReceivedAt: null
      };
      changed = true;
    }

    if (changed && typeof integration.save === 'function') {
      await integration.save();
    }
  }

  return integration;
};

// Static method to create or update integration with OAuth configuration
SmartThingsIntegrationSchema.statics.configureIntegration = async function(config) {
  console.log('SmartThingsIntegration: Configuring integration with OAuth settings');

  const clientId = trimString(config.clientId);
  const clientSecret = trimString(config.clientSecret);
  const redirectUri = config.redirectUri ? trimString(config.redirectUri) : trimString(process.env.SMARTTHINGS_REDIRECT_URI || 'http://localhost:3000/api/smartthings/callback');

  let integration = await this.findOne();

  if (!integration) {
    console.log('SmartThingsIntegration: Creating new integration configuration');
    integration = new this({
      clientId,
      clientSecret,
      redirectUri,
      isConfigured: true,
      scope: [...REQUIRED_SMARTTHINGS_SCOPES]
    });
  } else {
    console.log('SmartThingsIntegration: Updating existing integration configuration');
    integration.clientId = clientId;
    integration.clientSecret = clientSecret;
    integration.redirectUri = redirectUri;
    integration.isConfigured = true;
    integration.scope = sanitizeScopes(integration.scope);
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
    locationId: device.locationId || '',
    capabilities: device.components?.[0]?.capabilities?.map(cap => cap.id) || [],
    components: device.components?.map(comp => comp.id) || [],
    lastUpdated: new Date()
  }));

  this.lastSync = new Date();
  await this.save();

  console.log('SmartThingsIntegration: Device list updated successfully');
};

SmartThingsIntegrationSchema.methods.updateSecurityArmState = async function({ armState, locationId }) {
  if (!this.sthm) {
    this.sthm = {};
  }

  let changed = false;

  if (locationId) {
    const trimmedLocation = trimString(locationId);
    if (this.sthm.locationId !== trimmedLocation) {
      this.sthm.locationId = trimmedLocation;
      changed = true;
    }
  }

  if (armState) {
    if (this.sthm.lastArmState !== armState) {
      this.sthm.lastArmState = armState;
      changed = true;
    }
    this.sthm.lastArmStateUpdatedAt = new Date();
  }

  if (!changed) {
    return;
  }

  await this.save();
};

SmartThingsIntegrationSchema.methods.updateWebhookState = async function({
  installedAppId,
  locationId,
  subscriptions,
  lastSubscriptionSync,
  lastLifecycleHandledAt,
  lastEventReceivedAt
} = {}) {
  if (!this.webhook) {
    this.webhook = {
      installedAppId: '',
      locationId: '',
      subscriptions: [],
      lastSubscriptionSync: null,
      lastLifecycleHandledAt: null,
      lastEventReceivedAt: null
    };
  }

  let changed = false;

  if (installedAppId !== undefined) {
    const trimmedInstalledAppId = trimString(installedAppId);
    if (this.webhook.installedAppId !== trimmedInstalledAppId) {
      this.webhook.installedAppId = trimmedInstalledAppId;
      changed = true;
    }
  }

  if (locationId !== undefined) {
    const trimmedLocationId = trimString(locationId);
    if (this.webhook.locationId !== trimmedLocationId) {
      this.webhook.locationId = trimmedLocationId;
      changed = true;
    }
  }

  if (Array.isArray(subscriptions)) {
    this.webhook.subscriptions = subscriptions;
    changed = true;
  }

  if (lastSubscriptionSync !== undefined) {
    this.webhook.lastSubscriptionSync = lastSubscriptionSync ? new Date(lastSubscriptionSync) : null;
    changed = true;
  }

  if (lastLifecycleHandledAt !== undefined) {
    this.webhook.lastLifecycleHandledAt = lastLifecycleHandledAt ? new Date(lastLifecycleHandledAt) : new Date();
    changed = true;
  }

  if (lastEventReceivedAt !== undefined) {
    this.webhook.lastEventReceivedAt = lastEventReceivedAt ? new Date(lastEventReceivedAt) : null;
    changed = true;
  }

  if (!changed) {
    return;
  }

  await this.save();
};

SmartThingsIntegrationSchema.methods.clearWebhookState = async function() {
  this.webhook = {
    installedAppId: '',
    locationId: '',
    subscriptions: [],
    lastSubscriptionSync: null,
    lastLifecycleHandledAt: new Date(),
    lastEventReceivedAt: null
  };

  await this.save();
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

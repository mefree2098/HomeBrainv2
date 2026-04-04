const mongoose = require('mongoose');

const HarmonyKnownHubSchema = new mongoose.Schema({
  ip: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  friendlyName: {
    type: String,
    default: ''
  },
  firstDiscoveredAt: {
    type: Date,
    default: null
  },
  lastDiscoveredAt: {
    type: Date,
    default: null
  },
  lastSeenAt: {
    type: Date,
    default: null
  },
  lastSnapshotAt: {
    type: Date,
    default: null
  },
  lastKnownActivityId: {
    type: String,
    default: null
  },
  lastKnownActivityLabel: {
    type: String,
    default: null
  },
  lastDeviceSyncAt: {
    type: Date,
    default: null
  },
  lastDeviceSyncStatus: {
    type: String,
    enum: ['unknown', 'success', 'failed'],
    default: 'unknown'
  },
  lastDeviceSyncError: {
    type: String,
    default: ''
  },
  lastActivitySyncAt: {
    type: Date,
    default: null
  },
  lastActivitySyncStatus: {
    type: String,
    enum: ['unknown', 'success', 'failed'],
    default: 'unknown'
  },
  lastActivitySyncError: {
    type: String,
    default: ''
  },
  lastUpdatedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const SettingsSchema = new mongoose.Schema({
  // General Settings
  location: {
    type: String,
    default: 'New York, NY'
  },
  timezone: {
    type: String,
    default: 'America/New_York'
  },
  
  // Voice Settings
  wakeWordSensitivity: {
    type: Number,
    min: 0.1,
    max: 1.0,
    default: 0.7
  },
  voiceVolume: {
    type: Number,
    min: 0.1,
    max: 1.0,
    default: 0.8
  },
  microphoneSensitivity: {
    type: Number,
    min: 0.1,
    max: 1.0,
    default: 0.6
  },
  enableVoiceConfirmation: {
    type: Boolean,
    default: true
  },
  voiceRegion: {
    type: String,
    default: 'all'
  },
  elevenlabsDefaultVoiceId: {
    type: String,
    default: ''
  },
  sttProvider: {
    type: String,
    enum: ['openai', 'local'],
    default: 'openai'
  },
  sttModel: {
    type: String,
    default: 'gpt-4o-mini-transcribe'
  },
  sttLanguage: {
    type: String,
    default: 'en'
  },
  
  // Notification Settings
  enableNotifications: {
    type: Boolean,
    default: true
  },
  
  // Integration Settings
  insteonPort: {
    type: String,
    default: '/dev/ttyUSB0'
  },
  isyHost: {
    type: String,
    default: ''
  },
  isyPort: {
    type: Number,
    min: 1,
    max: 65535,
    default: 443
  },
  isyUsername: {
    type: String,
    default: ''
  },
  isyPassword: {
    type: String,
    default: ''
  },
  isyUseHttps: {
    type: Boolean,
    default: true
  },
  isyIgnoreTlsErrors: {
    type: Boolean,
    default: true
  },
  smartthingsToken: {
    type: String,
    default: ''
  },
  // SmartThings OAuth Configuration
  smartthingsClientId: {
    type: String,
    default: ''
  },
  smartthingsClientSecret: {
    type: String,
    default: ''
  },
  smartthingsRedirectUri: {
    type: String,
    default: ''
  },
  smartthingsUseOAuth: {
    type: Boolean,
    default: true
  },
  harmonyHubAddresses: {
    type: String,
    default: ''
  },
  harmonyKnownHubs: {
    type: [HarmonyKnownHubSchema],
    default: []
  },
  elevenlabsApiKey: {
    type: String,
    default: ''
  },
  
  // AI/LLM Provider Settings
  llmProvider: {
    type: String,
    enum: ['openai', 'anthropic', 'local', 'codex'],
    default: 'openai'
  },
  openaiApiKey: {
    type: String,
    default: ''
  },
  openaiModel: {
    type: String,
    default: 'gpt-5.2-codex'
  },
  anthropicApiKey: {
    type: String,
    default: ''
  },
  anthropicModel: {
    type: String,
    default: 'claude-3-sonnet-20240229'
  },
  codexPath: {
    type: String,
    default: ''
  },
  codexHome: {
    type: String,
    default: ''
  },
  codexHomeProfile: {
    type: String,
    enum: ['auto', 'azure', 'aws', 'local', 'custom'],
    default: 'local'
  },
  codexAwsVolumeRoot: {
    type: String,
    default: '/mnt/efs'
  },
  codexModel: {
    type: String,
    default: 'gpt-5.4'
  },
  localLlmEndpoint: {
    type: String,
    default: 'http://localhost:11434'
  },
  localLlmModel: {
    type: String,
    default: 'llama2-7b'
  },
  homebrainLocalLlmModel: {
    type: String,
    default: 'llama2-7b'
  },
  spamFilterLocalLlmModel: {
    type: String,
    default: 'llama2-7b'
  },
  llmPriorityList: {
    type: [String],
    default: ['local', 'codex', 'openai', 'anthropic'],
    validate: {
      validator: function(arr) {
        // Ensure array only contains valid provider names
        const validProviders = ['openai', 'anthropic', 'local', 'codex'];
        return arr.every(provider => validProviders.includes(provider));
      },
      message: 'Invalid LLM provider in priority list'
    }
  },

  // Security Settings
  enableSecurityMode: {
    type: Boolean,
    default: false
  },
  autoDiscoveryEnabled: {
    type: Boolean,
    default: false
  },
  
  // Metadata
  lastModified: {
    type: Date,
    default: Date.now
  },
  modifiedBy: {
    type: String,
    default: 'system'
  }
}, {
  timestamps: true
});

// Update lastModified on save
SettingsSchema.pre('save', function() {
  this.lastModified = new Date();
});

// Static method to get or create settings
SettingsSchema.statics.getSettings = async function() {
  console.log('Settings: Getting application settings');
  
  let settings = await this.findOne();
  
  if (!settings) {
    console.log('Settings: No settings found, creating default settings');
    settings = new this();
    await settings.save();
    console.log('Settings: Default settings created successfully');
  } else if (settings.localLlmEndpoint && settings.localLlmEndpoint.trim().toLowerCase() === 'http://localhost:8080') {
    console.log('Settings: Updating legacy local LLM endpoint to default Ollama port (11434)');
    settings.localLlmEndpoint = 'http://localhost:11434';
    await settings.save();
    console.log('Settings: localLlmEndpoint updated to http://localhost:11434');
  }

  let updated = false;
  const legacyLocalModel = typeof settings.localLlmModel === 'string' ? settings.localLlmModel.trim() : '';
  const homebrainLocalModel = typeof settings.homebrainLocalLlmModel === 'string'
    ? settings.homebrainLocalLlmModel.trim()
    : '';
  const spamFilterLocalModel = typeof settings.spamFilterLocalLlmModel === 'string'
    ? settings.spamFilterLocalLlmModel.trim()
    : '';
  const sharedLocalModel = homebrainLocalModel || legacyLocalModel || spamFilterLocalModel;

  if (sharedLocalModel) {
    if (legacyLocalModel !== sharedLocalModel) {
      settings.localLlmModel = sharedLocalModel;
      updated = true;
    }

    if (homebrainLocalModel !== sharedLocalModel) {
      settings.homebrainLocalLlmModel = sharedLocalModel;
      updated = true;
    }

    if (spamFilterLocalModel !== sharedLocalModel) {
      settings.spamFilterLocalLlmModel = sharedLocalModel;
      updated = true;
    }
  }

  const codexHomeProfile = typeof settings.codexHomeProfile === 'string'
    ? settings.codexHomeProfile.trim().toLowerCase()
    : '';
  if (!codexHomeProfile) {
    settings.codexHomeProfile = 'local';
    updated = true;
  }

  const currentPriorityList = Array.isArray(settings.llmPriorityList)
    ? settings.llmPriorityList.filter((provider) => typeof provider === 'string' && provider.trim())
    : [];
  const hasCodexProvider = currentPriorityList.includes('codex');
  const isLegacyPriorityOrder = currentPriorityList.length === 3 &&
    currentPriorityList[0] === 'local' &&
    currentPriorityList[1] === 'openai' &&
    currentPriorityList[2] === 'anthropic';

  if (!hasCodexProvider) {
    settings.llmPriorityList = isLegacyPriorityOrder
      ? ['local', 'codex', 'openai', 'anthropic']
      : [...currentPriorityList, 'codex'];
    updated = true;
  }

  if (updated) {
    console.log('Settings: Migrated local model role settings');
    await settings.save();
  }
  
  return settings;
};

// Static method to update settings
SettingsSchema.statics.updateSettings = async function(updates) {
  console.log('Settings: Updating application settings:', Object.keys(updates));
  
  let settings = await this.getSettings();
  
  // Apply updates
  Object.keys(updates).forEach(key => {
    if (key !== '_id' && key !== '__v' && key !== 'createdAt' && key !== 'updatedAt') {
      settings[key] = updates[key];
    }
  });
  
  await settings.save();
  console.log('Settings: Successfully updated settings');
  
  return settings;
};

// Method to get sanitized settings (without sensitive data for frontend)
SettingsSchema.methods.toSanitized = function() {
  const sanitized = this.toObject();
  
  // Mask sensitive data
  if (sanitized.elevenlabsApiKey) {
    sanitized.elevenlabsApiKey = sanitized.elevenlabsApiKey.replace(/.(?=.{4})/g, '*');
  }
  if (sanitized.smartthingsToken) {
    sanitized.smartthingsToken = sanitized.smartthingsToken.replace(/.(?=.{4})/g, '*');
  }
  if (sanitized.smartthingsClientSecret) {
    sanitized.smartthingsClientSecret = sanitized.smartthingsClientSecret.replace(/.(?=.{4})/g, '*');
  }
  if (sanitized.openaiApiKey) {
    sanitized.openaiApiKey = sanitized.openaiApiKey.replace(/.(?=.{4})/g, '*');
  }
  if (sanitized.anthropicApiKey) {
    sanitized.anthropicApiKey = sanitized.anthropicApiKey.replace(/.(?=.{4})/g, '*');
  }
  if (sanitized.isyPassword) {
    sanitized.isyPassword = sanitized.isyPassword.replace(/.(?=.{4})/g, '*');
  }
  delete sanitized.harmonyKnownHubs;
  delete sanitized.voiceRegion;
  delete sanitized.autoDiscoveryEnabled;
  
  return sanitized;
};

module.exports = mongoose.model('Settings', SettingsSchema);

const mongoose = require('mongoose');

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
  elevenlabsApiKey: {
    type: String,
    default: ''
  },
  
  // AI/LLM Provider Settings
  llmProvider: {
    type: String,
    enum: ['openai', 'anthropic', 'local'],
    default: 'openai'
  },
  openaiApiKey: {
    type: String,
    default: ''
  },
  openaiModel: {
    type: String,
    default: 'gpt-4'
  },
  anthropicApiKey: {
    type: String,
    default: ''
  },
  anthropicModel: {
    type: String,
    default: 'claude-3-sonnet-20240229'
  },
  localLlmEndpoint: {
    type: String,
    default: 'http://localhost:8080'
  },
  localLlmModel: {
    type: String,
    default: 'llama2-7b'
  },
  
  // Security Settings
  enableSecurityMode: {
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
SettingsSchema.pre('save', function(next) {
  this.lastModified = new Date();
  next();
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
  
  return sanitized;
};

module.exports = mongoose.model('Settings', SettingsSchema);
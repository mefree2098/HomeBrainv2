const mongoose = require('mongoose');

const ollamaModelSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  tag: {
    type: String,
    default: 'latest',
  },
  size: {
    type: Number, // Size in bytes
    default: 0,
  },
  digest: {
    type: String,
  },
  modifiedAt: {
    type: Date,
  },
  family: {
    type: String,
  },
  parameterSize: {
    type: String, // e.g., "7B", "13B"
  },
  quantizationLevel: {
    type: String, // e.g., "Q4_0", "Q5_K_M"
  },
  format: {
    type: String,
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
  },
}, { _id: false });

const chatMessageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['user', 'assistant', 'system'],
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  model: {
    type: String,
    required: true,
  },
}, { _id: true });

const ollamaConfigSchema = new mongoose.Schema({
  isInstalled: {
    type: Boolean,
    default: false,
  },
  version: {
    type: String,
    default: null,
  },
  servicePid: {
    type: Number,
    default: null,
  },
  serviceOwner: {
    type: String,
    default: null,
  },
  installPath: {
    type: String,
    default: '/usr/local/bin/ollama',
  },
  serviceStatus: {
    type: String,
    enum: ['running', 'running_external', 'stopped', 'installing', 'error', 'not_installed'],
    default: 'not_installed',
  },
  installedModels: [ollamaModelSchema],
  activeModel: {
    type: String,
    default: null,
  },
  configuration: {
    apiUrl: {
      type: String,
      default: 'http://localhost:11434',
    },
    maxConcurrentRequests: {
      type: Number,
      default: 1,
    },
    contextLength: {
      type: Number,
      default: 2048,
    },
    gpuLayers: {
      type: Number,
      default: -1, // -1 means auto
    },
  },
  updateAvailable: {
    type: Boolean,
    default: false,
  },
  latestVersion: {
    type: String,
    default: null,
  },
  lastUpdateCheck: {
    type: Date,
    default: null,
  },
  chatHistory: [chatMessageSchema],
  statistics: {
    totalChats: {
      type: Number,
      default: 0,
    },
    totalTokensProcessed: {
      type: Number,
      default: 0,
    },
    averageResponseTime: {
      type: Number,
      default: 0,
    },
  },
  lastError: {
    message: String,
    timestamp: Date,
  },
}, {
  timestamps: true,
});

// Indexes
ollamaConfigSchema.index({ serviceStatus: 1 });
ollamaConfigSchema.index({ activeModel: 1 });
ollamaConfigSchema.index({ 'chatHistory.timestamp': -1 });

// Static method to get or create config
ollamaConfigSchema.statics.getConfig = async function() {
  let config = await this.findOne();
  if (!config) {
    config = await this.create({});
  }
  return config;
};

// Method to add chat message
ollamaConfigSchema.methods.addChatMessage = async function(role, content, model) {
  this.chatHistory.push({ role, content, model });

  // Keep only last 1000 messages
  if (this.chatHistory.length > 1000) {
    this.chatHistory = this.chatHistory.slice(-1000);
  }

  if (role === 'assistant') {
    this.statistics.totalChats += 1;
  }

  await this.save();
  return this.chatHistory[this.chatHistory.length - 1];
};

// Method to update model list
ollamaConfigSchema.methods.updateModels = async function(models) {
  this.installedModels = models;
  await this.save();
};

// Method to set active model
ollamaConfigSchema.methods.setActiveModel = async function(modelName) {
  const modelExists = this.installedModels.some(m => m.name === modelName);
  if (!modelExists) {
    throw new Error('Model not found in installed models');
  }
  this.activeModel = modelName;
  await this.save();
};

// Method to update installation status
ollamaConfigSchema.methods.updateInstallation = async function(version, isInstalled) {
  this.version = version;
  this.isInstalled = isInstalled;
  if (!isInstalled) {
    this.servicePid = null;
    this.serviceOwner = null;
    this.serviceStatus = 'not_installed';
  }
  await this.save();
};

// Method to set error
ollamaConfigSchema.methods.setError = async function(errorMessage) {
  this.lastError = {
    message: errorMessage,
    timestamp: new Date(),
  };
  await this.save();
};

module.exports = mongoose.model('OllamaConfig', ollamaConfigSchema);

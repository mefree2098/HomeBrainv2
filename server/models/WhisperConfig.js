const mongoose = require('mongoose');

const whisperModelSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true
    },
    variant: {
      type: String,
      default: 'multilingual'
    },
    sizeBytes: {
      type: Number,
      default: 0
    },
    computeType: {
      type: String,
      default: 'float16'
    },
    languages: {
      type: [String],
      default: ['en']
    },
    path: {
      type: String,
      required: true
    },
    downloadedAt: {
      type: Date,
      default: Date.now
    },
    checksum: {
      type: String,
      default: null
    }
  },
  { _id: false }
);

const whisperConfigSchema = new mongoose.Schema(
  {
    isInstalled: {
      type: Boolean,
      default: false
    },
    serviceStatus: {
      type: String,
      enum: ['not_installed', 'installing', 'stopped', 'starting', 'running', 'error'],
      default: 'not_installed'
    },
    servicePid: {
      type: Number,
      default: null
    },
    servicePort: {
      type: Number,
      default: null
    },
    serviceOwner: {
      type: String,
      default: null
    },
    activeDevice: {
      type: String,
      default: null
    },
    activeComputeType: {
      type: String,
      default: null
    },
    buildWithCudnn: {
      type: Boolean,
      default: null
    },
    activeModel: {
      type: String,
      default: 'small'
    },
    installedModels: {
      type: [whisperModelSchema],
      default: []
    },
    modelDirectory: {
      type: String,
      default: null
    },
    autoStart: {
      type: Boolean,
      default: true
    },
    lastError: {
      message: String,
      timestamp: Date
    },
    lastHealthCheck: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

whisperConfigSchema.statics.getConfig = async function () {
  let config = await this.findOne();
  if (!config) {
    config = await this.create({});
  }
  return config;
};

whisperConfigSchema.methods.setError = async function (message) {
  this.lastError = {
    message,
    timestamp: new Date()
  };
  await this.save();
};

whisperConfigSchema.methods.upsertModel = async function (modelInfo) {
  const index = this.installedModels.findIndex((model) => model.name === modelInfo.name);
  if (index >= 0) {
    this.installedModels[index] = { ...this.installedModels[index], ...modelInfo };
  } else {
    this.installedModels.push(modelInfo);
  }
  await this.save();
};

module.exports = mongoose.model('WhisperConfig', whisperConfigSchema);

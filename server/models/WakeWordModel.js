const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  phrase: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'queued', 'generating', 'training', 'exporting', 'ready', 'error'],
    default: 'pending',
    index: true
  },
  engine: {
    type: String,
    default: 'openwakeword'
  },
  format: {
    type: String,
    default: 'tflite'
  },
  modelPath: {
    type: String
  },
  checksum: {
    type: String
  },
  artifacts: [{
    format: {
      type: String,
      enum: ['tflite', 'onnx', 'torchscript', 'raw'],
      required: true
    },
    path: {
      type: String,
      required: true
    },
    size: {
      type: Number
    },
    checksum: {
      type: String
    },
    threshold: {
      type: Number,
      min: 0,
      max: 1
    },
    sensitivity: {
      type: Number,
      min: 0,
      max: 1
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  progress: {
    type: Number,
    min: 0,
    max: 1,
    default: 0
  },
  statusMessage: {
    type: String
  },
  error: {
    type: String
  },
  profiles: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserProfile'
  }],
  trainingMetadata: {
    samplesGenerated: Number,
    generator: String,
    durationMs: Number
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  lastTrainedAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  versionKey: false
});

schema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const WakeWordModel = mongoose.model('WakeWordModel', schema);
module.exports = WakeWordModel;

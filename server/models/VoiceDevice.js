const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  room: {
    type: String,
    required: true,
    trim: true,
  },
  deviceType: {
    type: String,
    required: true,
    enum: ['hub', 'speaker', 'display', 'mobile', 'microphone'],
    default: 'speaker',
  },
  status: {
    type: String,
    enum: ['online', 'offline', 'error', 'updating'],
    default: 'offline',
  },
  // Device specifications
  brand: {
    type: String,
    trim: true,
  },
  model: {
    type: String,
    trim: true,
  },
  serialNumber: {
    type: String,
    trim: true,
    unique: true,
    sparse: true,
  },
  // Voice capabilities
  wakeWordSupport: {
    type: Boolean,
    default: true,
  },
  supportedWakeWords: [{
    type: String,
    trim: true,
  }],
  voiceRecognitionEnabled: {
    type: Boolean,
    default: true,
  },
  // Audio settings
  volume: {
    type: Number,
    min: 0,
    max: 100,
    default: 50,
  },
  microphoneSensitivity: {
    type: Number,
    min: 0,
    max: 100,
    default: 50,
  },
  // Power and connectivity
  batteryLevel: {
    type: Number,
    min: 0,
    max: 100,
  },
  powerSource: {
    type: String,
    enum: ['battery', 'wired', 'both'],
    default: 'wired',
  },
  connectionType: {
    type: String,
    enum: ['wifi', 'bluetooth', 'zigbee', 'ethernet'],
    default: 'wifi',
  },
  ipAddress: {
    type: String,
    trim: true,
  },
  // Status tracking
  lastSeen: {
    type: Date,
    default: Date.now,
  },
  lastInteraction: {
    type: Date,
  },
  uptime: {
    type: Number, // Uptime in seconds
    default: 0,
  },
  audioStreamActive: {
    type: Boolean,
    default: false,
  },
  audioStreamStartedAt: {
    type: Date,
  },
  lastTranscriptText: {
    type: String,
    trim: true,
  },
  lastTranscriptAt: {
    type: Date,
  },
  lastTranscriptConfidence: {
    type: Number,
    min: 0,
    max: 1,
  },
  lastTranscriptProvider: {
    type: String,
    trim: true,
  },
  lastTranscriptModel: {
    type: String,
    trim: true,
  },
  lastTranscriptLanguage: {
    type: String,
    trim: true,
  },
  lastTranscriptError: {
    type: String,
    trim: true,
  },
  lastWakeWord: {
    type: String,
    trim: true,
  },
  lastWakeWordAt: {
    type: Date,
  },
  lastWakeWordConfidence: {
    type: Number,
    min: 0,
    max: 1,
  },
  // Configuration
  settings: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  // Firmware information
  firmwareVersion: {
    type: String,
    trim: true,
  },
  lastUpdate: {
    type: Date,
  },
  // Update tracking
  updateStatus: {
    status: {
      type: String,
      enum: ['idle', 'checking', 'downloading', 'installing', 'completed', 'failed'],
      default: 'idle'
    },
    version: String,
    startedAt: Date,
    completedAt: Date,
    failedAt: Date,
    error: String,
    lastChecked: Date
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
}, {
  versionKey: false,
});

// Update the updatedAt field and lastSeen before saving
schema.pre('save', function(next) {
  this.updatedAt = Date.now();
  if (this.status === 'online') {
    this.lastSeen = Date.now();
  }
  next();
});

// Indexes for better query performance
schema.index({ status: 1 });
schema.index({ room: 1 });
schema.index({ deviceType: 1 });
schema.index({ lastSeen: -1 });

const VoiceDevice = mongoose.model('VoiceDevice', schema);

module.exports = VoiceDevice;

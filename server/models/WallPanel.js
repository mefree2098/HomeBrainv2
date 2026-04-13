const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  room: {
    type: String,
    required: true,
    trim: true
  },
  hardwareProfile: {
    type: String,
    enum: ['elecrow-crowpanel-2.1-rotary', 'elecrow-crowpanel-1.28-rotary'],
    default: 'elecrow-crowpanel-2.1-rotary'
  },
  status: {
    type: String,
    enum: ['online', 'offline', 'error', 'updating'],
    default: 'offline'
  },
  powerSource: {
    type: String,
    enum: ['wired', 'battery', 'both'],
    default: 'wired'
  },
  connectionType: {
    type: String,
    enum: ['wifi', 'bluetooth', 'ethernet'],
    default: 'wifi'
  },
  ipAddress: {
    type: String,
    trim: true
  },
  firmwareVersion: {
    type: String,
    trim: true
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  ota: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  settings: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
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

schema.pre('save', function updateTimestamps() {
  this.updatedAt = Date.now();
  if (this.status === 'online') {
    this.lastSeen = Date.now();
  }
});

schema.index({ status: 1 });
schema.index({ room: 1 });
schema.index({ hardwareProfile: 1 });
schema.index({ lastSeen: -1 });

const WallPanel = mongoose.model('WallPanel', schema);

module.exports = WallPanel;

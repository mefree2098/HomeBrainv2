const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  type: {
    type: String,
    required: true,
    enum: ['light', 'lock', 'thermostat', 'garage', 'sensor', 'switch', 'camera'],
  },
  room: {
    type: String,
    required: true,
    trim: true,
  },
  status: {
    type: Boolean,
    default: false,
  },
  // Light-specific properties
  brightness: {
    type: Number,
    min: 0,
    max: 100,
    default: 0,
  },
  color: {
    type: String,
    default: '#ffffff',
  },
  // Thermostat-specific properties
  temperature: {
    type: Number,
    min: -50,
    max: 150,
  },
  targetTemperature: {
    type: Number,
    min: -50,
    max: 150,
  },
  // Generic properties for extensibility
  properties: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  // Device metadata
  brand: {
    type: String,
    trim: true,
  },
  model: {
    type: String,
    trim: true,
  },
  // Connection status
  isOnline: {
    type: Boolean,
    default: true,
  },
  lastSeen: {
    type: Date,
    default: Date.now,
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

// Update the updatedAt field before saving
schema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Indexes for better query performance
schema.index({ type: 1, room: 1 });
schema.index({ status: 1 });
schema.index({ isOnline: 1 });

const Device = mongoose.model('Device', schema);

module.exports = Device;
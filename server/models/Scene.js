const mongoose = require('mongoose');

const deviceActionSchema = new mongoose.Schema({
  deviceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    required: true,
  },
  action: {
    type: String,
    required: true,
    enum: ['turn_on', 'turn_off', 'set_brightness', 'set_temperature', 'lock', 'unlock', 'open', 'close'],
  },
  value: {
    type: mongoose.Schema.Types.Mixed, // Can be number, string, or object
  },
}, { _id: false });

const schema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500,
  },
  deviceActions: [deviceActionSchema],
  active: {
    type: Boolean,
    default: false,
  },
  icon: {
    type: String,
    default: 'home',
  },
  color: {
    type: String,
    default: '#3b82f6',
  },
  // Scene metadata
  category: {
    type: String,
    enum: ['comfort', 'security', 'entertainment', 'energy', 'custom'],
    default: 'custom',
  },
  isDefault: {
    type: Boolean,
    default: false,
  },
  // Usage tracking
  activationCount: {
    type: Number,
    default: 0,
  },
  lastActivated: {
    type: Date,
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
schema.index({ category: 1 });
schema.index({ active: 1 });
schema.index({ isDefault: 1 });

const Scene = mongoose.model('Scene', schema);

module.exports = Scene;
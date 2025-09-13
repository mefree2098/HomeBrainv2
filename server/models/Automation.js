const mongoose = require('mongoose');

const triggerSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['time', 'device_state', 'weather', 'location', 'sensor', 'schedule', 'manual'],
  },
  conditions: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
}, { _id: false });

const actionSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['device_control', 'scene_activate', 'notification', 'delay', 'condition'],
  },
  target: {
    type: mongoose.Schema.Types.Mixed, // Can be device ID, scene ID, or other targets
  },
  parameters: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
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
  trigger: triggerSchema,
  actions: [actionSchema],
  enabled: {
    type: Boolean,
    default: true,
  },
  // Execution tracking
  lastRun: {
    type: Date,
  },
  executionCount: {
    type: Number,
    default: 0,
  },
  lastError: {
    message: String,
    timestamp: Date,
  },
  // Automation metadata
  priority: {
    type: Number,
    default: 5,
    min: 1,
    max: 10,
  },
  category: {
    type: String,
    enum: ['security', 'comfort', 'energy', 'convenience', 'custom'],
    default: 'custom',
  },
  // Advanced features
  conditions: [{
    type: {
      type: String,
      enum: ['time_range', 'day_of_week', 'device_state', 'weather', 'custom'],
    },
    parameters: mongoose.Schema.Types.Mixed,
  }],
  cooldown: {
    type: Number, // Cooldown period in minutes
    default: 0,
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
schema.index({ enabled: 1 });
schema.index({ 'trigger.type': 1 });
schema.index({ category: 1 });
schema.index({ priority: -1 });

const Automation = mongoose.model('Automation', schema);

module.exports = Automation;
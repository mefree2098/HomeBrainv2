const mongoose = require('mongoose');
const { DASHBOARD_WIDGET_SIZES, DASHBOARD_WIDGET_TYPES } = require('../utils/dashboardViews');

const dashboardWidgetSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    trim: true,
  },
  type: {
    type: String,
    required: true,
    enum: DASHBOARD_WIDGET_TYPES,
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80,
  },
  size: {
    type: String,
    required: true,
    enum: DASHBOARD_WIDGET_SIZES,
    default: 'medium',
  },
  minimized: {
    type: Boolean,
    default: false,
  },
  settings: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
}, {
  _id: false,
  versionKey: false,
});

const dashboardViewSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    trim: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80,
  },
  widgets: {
    type: [dashboardWidgetSchema],
    default: [],
  },
}, {
  _id: false,
  versionKey: false,
});

const normalizeVisibleSensorIds = (value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const seen = new Set();
  const normalized = [];

  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
};

const securityPreferencesSchema = new mongoose.Schema({
  visibleSensorIds: {
    type: [String],
    default: undefined,
    set: normalizeVisibleSensorIds,
  },
}, {
  _id: false,
  versionKey: false,
});

const schema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  // Voice recognition settings
  wakeWords: [{
    type: String,
    required: true,
    trim: true,
  }],
  wakeWordModels: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WakeWordModel'
  }],
  voiceId: {
    type: String,
    required: true,
    trim: true,
  },
  voiceName: {
    type: String,
    trim: true,
  },
  // AI Assistant settings
  systemPrompt: {
    type: String,
    required: true,
    maxlength: 2000,
  },
  personality: {
    type: String,
    enum: ['friendly', 'professional', 'casual', 'formal', 'humorous', 'neutral'],
    default: 'friendly',
  },
  responseStyle: {
    type: String,
    enum: ['concise', 'detailed', 'conversational', 'technical'],
    default: 'conversational',
  },
  // User preferences
  preferredLanguage: {
    type: String,
    default: 'en-US',
  },
  timezone: {
    type: String,
    default: 'UTC',
  },
  // Voice settings
  speechRate: {
    type: Number,
    min: 0.5,
    max: 2.0,
    default: 1.0,
  },
  speechPitch: {
    type: Number,
    min: 0.5,
    max: 2.0,
    default: 1.0,
  },
  // Permissions and access
  active: {
    type: Boolean,
    default: true,
  },
  permissions: [{
    type: String,
    enum: ['device_control', 'scene_control', 'automation_control', 'user_management', 'system_settings'],
  }],
  // Usage tracking
  lastUsed: {
    type: Date,
  },
  usageCount: {
    type: Number,
    default: 0,
  },
  // Personal information (optional)
  avatar: {
    type: String, // URL or base64 encoded image
    trim: true,
  },
  birthDate: {
    type: Date,
  },
  // Customization
  favorites: {
    devices: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Device',
    }],
    scenes: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Scene',
    }],
    automations: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Automation',
    }],
  },
  dashboardViews: {
    type: [dashboardViewSchema],
    default: [],
  },
  securityPreferences: {
    type: securityPreferencesSchema,
    default: () => ({}),
  },
  // Advanced settings
  contextMemory: {
    type: Boolean,
    default: true,
  },
  learningMode: {
    type: Boolean,
    default: true,
  },
  privacyMode: {
    type: Boolean,
    default: false,
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
schema.pre('save', function() {
  this.updatedAt = Date.now();
});

// Indexes for better query performance
schema.index({ active: 1 });
schema.index({ wakeWords: 1 });
schema.index({ voiceId: 1 });
schema.index({ lastUsed: -1 });

const UserProfile = mongoose.model('UserProfile', schema);

module.exports = UserProfile;

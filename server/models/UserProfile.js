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

const alexaPreferencesSchema = new mongoose.Schema({
  responseMode: {
    type: String,
    enum: ['auto', 'text', 'ssml', 'audio'],
    default: 'auto',
  },
  preferredLocale: {
    type: String,
    default: 'en-US',
  },
  allowPersonalization: {
    type: Boolean,
    default: true,
  },
  includeAudioFallbackText: {
    type: Boolean,
    default: false,
  },
}, {
  _id: false,
  versionKey: false,
});

const trimOptionalString = (value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  const normalized = String(value).trim();
  return normalized || undefined;
};

const normalizeAlexaMappings = (value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = [];
  const seen = new Set();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const personId = trimOptionalString(entry.personId);
    const householdId = trimOptionalString(entry.householdId);
    const locale = trimOptionalString(entry.locale);
    const speakerLabel = trimOptionalString(entry.speakerLabel);
    const alexaUserId = trimOptionalString(entry.alexaUserId);
    const alexaAccountId = trimOptionalString(entry.alexaAccountId);
    const defaultForHousehold = entry.defaultForHousehold === true;
    const fallback = entry.fallback === true;
    const enabled = entry.enabled !== false;

    if (!personId && !defaultForHousehold && !fallback) {
      continue;
    }

    const dedupeKey = [
      personId || '*',
      householdId || '*',
      locale || '*',
      defaultForHousehold ? 'default' : 'nodefault',
      fallback ? 'fallback' : 'nofallback'
    ].join('::').toLowerCase();

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalized.push({
      personId,
      speakerLabel,
      householdId,
      locale,
      alexaUserId,
      alexaAccountId,
      defaultForHousehold,
      fallback,
      enabled
    });
  }

  return normalized;
};

const alexaMappingSchema = new mongoose.Schema({
  personId: {
    type: String,
    trim: true,
  },
  speakerLabel: {
    type: String,
    trim: true,
    maxlength: 120,
  },
  householdId: {
    type: String,
    trim: true,
    maxlength: 160,
  },
  locale: {
    type: String,
    trim: true,
    maxlength: 40,
  },
  alexaUserId: {
    type: String,
    trim: true,
    maxlength: 160,
  },
  alexaAccountId: {
    type: String,
    trim: true,
    maxlength: 160,
  },
  defaultForHousehold: {
    type: Boolean,
    default: false,
  },
  fallback: {
    type: Boolean,
    default: false,
  },
  enabled: {
    type: Boolean,
    default: true,
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
  alexaMappings: {
    type: [alexaMappingSchema],
    default: [],
    set: normalizeAlexaMappings,
  },
  securityPreferences: {
    type: securityPreferencesSchema,
    default: () => ({}),
  },
  alexaPreferences: {
    type: alexaPreferencesSchema,
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
schema.index({ 'alexaMappings.personId': 1 });
schema.index({ 'alexaMappings.householdId': 1 });

const UserProfile = mongoose.model('UserProfile', schema);

module.exports = UserProfile;

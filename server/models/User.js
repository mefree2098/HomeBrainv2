const mongoose = require('mongoose');

const { validatePassword, isPasswordHash } = require('../utils/password.js');
const {randomUUID} = require("crypto");
const { ROLES } = require('../../shared/config/roles.js');
const { DEFAULT_USER_PLATFORMS, normalizeUserPlatforms } = require('../utils/userPlatforms');
const {
  DEFAULT_WATCH_PREFERENCES,
  WATCH_SECTIONS,
  normalizeWatchPreferences
} = require('../utils/watchPreferences');

const platformsSchema = new mongoose.Schema({
  homebrain: {
    type: Boolean,
    default: DEFAULT_USER_PLATFORMS.homebrain,
  },
  axiom: {
    type: Boolean,
    default: DEFAULT_USER_PLATFORMS.axiom,
  },
}, {
  _id: false,
});

const watchPreferencesSchema = new mongoose.Schema({
  sections: {
    type: [String],
    enum: WATCH_SECTIONS,
    default: () => [...DEFAULT_WATCH_PREFERENCES.sections],
  },
  primaryRoom: {
    type: String,
    default: '',
    trim: true,
    maxlength: 120,
  },
  lightDeviceIds: {
    type: [String],
    default: [],
  },
  defaultLightBrightness: {
    type: Number,
    min: 1,
    max: 100,
    default: DEFAULT_WATCH_PREFERENCES.defaultLightBrightness,
  },
}, {
  _id: false,
});

const schema = new mongoose.Schema({
  name: {
    type: String,
    default: '',
    trim: true,
    maxlength: 120,
  },
  email: {
    type: String,
    required: true,
    index: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
    validate: { validator: isPasswordHash, message: 'Invalid password hash' },
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true,
  },
  lastLoginAt: {
    type: Date,
    default: Date.now,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  isReadOnly: {
    type: Boolean,
    default: false,
  },
  platforms: {
    type: platformsSchema,
    default: () => ({ ...DEFAULT_USER_PLATFORMS }),
  },
  watchPreferences: {
    type: watchPreferencesSchema,
    default: () => normalizeWatchPreferences(),
  },
  role: {
    type: String,
    enum: [ROLES.ADMIN, ROLES.USER],
    default: ROLES.USER,
  },
  refreshToken: {
    type: String,
    unique: true,
    index: true,
    default: () => randomUUID(),
  },
}, {
  versionKey: false,
});

schema.pre('validate', function normalizePlatforms() {
  this.platforms = normalizeUserPlatforms(this.platforms);
  this.watchPreferences = normalizeWatchPreferences(this.watchPreferences);
});

function sanitizeUserDocument(_doc, ret) {
  delete ret.password;
  delete ret.refreshToken;
  ret.platforms = normalizeUserPlatforms(ret.platforms);
  return ret;
}

schema.set('toJSON', {
  transform: sanitizeUserDocument,
});

schema.set('toObject', {
  transform: sanitizeUserDocument,
});

const User = mongoose.model('User', schema);

module.exports = User;

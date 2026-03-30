const mongoose = require('mongoose');

const { validatePassword, isPasswordHash } = require('../utils/password.js');
const {randomUUID} = require("crypto");
const { ROLES } = require('../../shared/config/roles.js');
const { DEFAULT_USER_PLATFORMS, normalizeUserPlatforms } = require('../utils/userPlatforms');

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
  platforms: {
    type: platformsSchema,
    default: () => ({ ...DEFAULT_USER_PLATFORMS }),
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

schema.pre('validate', function normalizePlatforms(next) {
  this.platforms = normalizeUserPlatforms(this.platforms);
  next();
});

function sanitizeUserDocument(_doc, ret) {
  delete ret.password;
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

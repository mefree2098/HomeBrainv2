const mongoose = require('mongoose');
const {
  ALEXA_ENTITY_TYPES,
  ALEXA_PROJECTION_TYPES,
  normalizeAlexaName,
  uniqueCaseInsensitive
} = require('../../shared/alexa/contracts');

const projectionTypes = Object.values(ALEXA_PROJECTION_TYPES);

const alexaExposureSchema = new mongoose.Schema({
  entityType: {
    type: String,
    required: true,
    enum: ALEXA_ENTITY_TYPES
  },
  entityId: {
    type: String,
    required: true,
    trim: true
  },
  enabled: {
    type: Boolean,
    default: false
  },
  projectionType: {
    type: String,
    enum: projectionTypes,
    default: ALEXA_PROJECTION_TYPES.DEVICE
  },
  friendlyName: {
    type: String,
    trim: true,
    default: ''
  },
  aliases: {
    type: [String],
    default: []
  },
  roomHint: {
    type: String,
    trim: true,
    default: ''
  },
  endpointIdSeed: {
    type: String,
    trim: true,
    default: ''
  },
  validationWarnings: {
    type: [String],
    default: []
  },
  validationErrors: {
    type: [String],
    default: []
  },
  metadata: {
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
  versionKey: false,
  collection: 'alexa_exposures'
});

alexaExposureSchema.pre('validate', function preValidate() {
  this.entityId = String(this.entityId || '').trim();
  this.friendlyName = normalizeAlexaName(this.friendlyName);
  this.roomHint = normalizeAlexaName(this.roomHint);
  this.endpointIdSeed = String(this.endpointIdSeed || '').trim();
  this.aliases = uniqueCaseInsensitive(Array.isArray(this.aliases) ? this.aliases : []);
  this.validationWarnings = uniqueCaseInsensitive(Array.isArray(this.validationWarnings) ? this.validationWarnings : []);
  this.validationErrors = uniqueCaseInsensitive(Array.isArray(this.validationErrors) ? this.validationErrors : []);
});

alexaExposureSchema.pre('save', function preSave() {
  this.updatedAt = new Date();
});

alexaExposureSchema.index({ entityType: 1, entityId: 1 }, { unique: true });
alexaExposureSchema.index({ enabled: 1, entityType: 1 });

module.exports = mongoose.model('AlexaExposure', alexaExposureSchema);

const mongoose = require('mongoose');

function sanitizeRoomName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeRoomName(value) {
  return sanitizeRoomName(value).toLowerCase();
}

const roomSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  normalizedName: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
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
  collection: 'rooms'
});

roomSchema.pre('validate', function preValidate() {
  this.name = sanitizeRoomName(this.name);
  this.normalizedName = normalizeRoomName(this.name);
});

roomSchema.pre('save', function preSave() {
  this.updatedAt = new Date();
});

roomSchema.index({ normalizedName: 1 }, { unique: true });
roomSchema.index({ name: 1 });

module.exports = mongoose.model('Room', roomSchema);
module.exports.sanitizeRoomName = sanitizeRoomName;
module.exports.normalizeRoomName = normalizeRoomName;

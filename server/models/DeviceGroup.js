const mongoose = require('mongoose');

const deviceGroupSchema = new mongoose.Schema({
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
  description: {
    type: String,
    trim: true,
    default: ''
  },
  insteonPlmGroup: {
    type: Number,
    default: null
  },
  insteonMemberSignature: {
    type: String,
    trim: true,
    default: ''
  },
  insteonLastSyncedAt: {
    type: Date,
    default: null
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
  collection: 'device_groups'
});

deviceGroupSchema.pre('validate', function preValidate() {
  const trimmedName = typeof this.name === 'string' ? this.name.trim() : '';
  this.name = trimmedName;
  this.normalizedName = trimmedName.toLowerCase();
});

deviceGroupSchema.pre('save', function preSave() {
  this.updatedAt = new Date();
});

deviceGroupSchema.index({ normalizedName: 1 }, { unique: true });
deviceGroupSchema.index({ name: 1 });

module.exports = mongoose.model('DeviceGroup', deviceGroupSchema);

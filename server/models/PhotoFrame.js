const mongoose = require('mongoose');
const { normalizeConfig } = require('../services/photoFrameConfig');

const photoSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  contentType: { type: String, required: true },
  bytes: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  room: { type: String, default: '', trim: true, maxlength: 80 },
  hardwareProfile: { type: String, default: 'humblestead-10.1-1280x800' },
  config: { type: mongoose.Schema.Types.Mixed, default: () => normalizeConfig() },
  photos: { type: [photoSchema], default: [] },
  deviceTokenHash: { type: String, select: false },
  lastSeen: { type: Date, default: null },
  playerVersion: { type: String, default: '' },
  software: { type: mongoose.Schema.Types.Mixed, default: null },
  ota: { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: true, versionKey: '__v', optimisticConcurrency: true });

module.exports = mongoose.model('PhotoFrame', schema);

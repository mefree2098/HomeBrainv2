const mongoose = require('mongoose');

const TempestEventSchema = new mongoose.Schema({
  stationId: {
    type: Number,
    required: true,
    index: true
  },
  deviceId: {
    type: Number,
    required: true,
    index: true
  },
  stationName: {
    type: String,
    default: ''
  },
  eventType: {
    type: String,
    enum: ['lightning_strike', 'precip_start'],
    required: true
  },
  source: {
    type: String,
    enum: ['rest', 'udp', 'ws'],
    required: true
  },
  eventAt: {
    type: Date,
    required: true,
    index: true
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  raw: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  }
}, {
  versionKey: false
});

TempestEventSchema.index({ stationId: 1, eventAt: -1 });
TempestEventSchema.index({ deviceId: 1, eventAt: -1 });

module.exports = mongoose.model('TempestEvent', TempestEventSchema);

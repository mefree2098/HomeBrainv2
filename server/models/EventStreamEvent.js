const mongoose = require('mongoose');

const eventStreamEventSchema = new mongoose.Schema({
  sequence: {
    type: Number,
    required: true,
    unique: true,
    index: true
  },
  type: {
    type: String,
    required: true,
    trim: true
  },
  source: {
    type: String,
    default: 'system',
    trim: true
  },
  category: {
    type: String,
    default: 'general',
    trim: true
  },
  severity: {
    type: String,
    enum: ['info', 'warn', 'error'],
    default: 'info'
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  tags: {
    type: [String],
    default: []
  },
  correlationId: {
    type: String,
    trim: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  }
}, {
  versionKey: false,
  collection: 'event_stream'
});

eventStreamEventSchema.index({ createdAt: -1 });
eventStreamEventSchema.index({ type: 1, createdAt: -1 });
eventStreamEventSchema.index({ source: 1, createdAt: -1 });

module.exports = mongoose.model('EventStreamEvent', eventStreamEventSchema);

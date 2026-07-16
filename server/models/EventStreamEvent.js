const mongoose = require('mongoose');
const { getDataRetentionDays } = require('../config/dataRetention');

const retentionDays = getDataRetentionDays().eventStream;

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
  actorUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    select: false
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
eventStreamEventSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: retentionDays * 24 * 60 * 60,
    name: 'event_stream_ttl'
  }
);
eventStreamEventSchema.index({ type: 1, createdAt: -1 });
eventStreamEventSchema.index({ source: 1, createdAt: -1 });
eventStreamEventSchema.index({ category: 1, createdAt: -1 });
eventStreamEventSchema.index(
  { actorUserId: 1, type: 1, createdAt: -1 },
  {
    name: 'event_stream_actor_type_created_at',
    partialFilterExpression: { actorUserId: { $exists: true } }
  }
);

module.exports = mongoose.model('EventStreamEvent', eventStreamEventSchema);

const { EventEmitter } = require('events');
const mongoose = require('mongoose');
const EventStreamEvent = require('../models/EventStreamEvent');

const COUNTER_COLLECTION = 'event_stream_counters';
const COUNTER_ID = 'global';
const DEFAULT_REPLAY_LIMIT = 100;
const MAX_REPLAY_LIMIT = 500;

class EventStreamService extends EventEmitter {
  async nextSequence() {
    const collection = mongoose.connection.collection(COUNTER_COLLECTION);
    const result = await collection.findOneAndUpdate(
      { _id: COUNTER_ID },
      { $inc: { sequence: 1 } },
      { upsert: true, returnDocument: 'after' }
    );

    // Node Mongo driver can return either a document or a result envelope depending on version/config.
    const directSequence = Number(result?.sequence);
    if (Number.isFinite(directSequence) && directSequence > 0) {
      return directSequence;
    }

    const nestedSequence = Number(result?.value?.sequence);
    if (Number.isFinite(nestedSequence) && nestedSequence > 0) {
      return nestedSequence;
    }

    const fallback = await collection.findOne({ _id: COUNTER_ID });
    const fallbackSequence = Number(fallback?.sequence);
    return Number.isFinite(fallbackSequence) && fallbackSequence > 0 ? fallbackSequence : 1;
  }

  toPublicEvent(doc) {
    const event = typeof doc?.toObject === 'function' ? doc.toObject() : doc;
    return {
      id: event?._id?.toString?.() || String(event?._id || ''),
      sequence: event.sequence,
      type: event.type,
      source: event.source,
      category: event.category,
      severity: event.severity,
      payload: event.payload || {},
      tags: Array.isArray(event.tags) ? event.tags : [],
      correlationId: event.correlationId || null,
      createdAt: event.createdAt
    };
  }

  async publish(input = {}) {
    const type = (input.type || '').toString().trim();
    if (!type) {
      throw new Error('Event type is required');
    }

    const sequence = await this.nextSequence();
    const doc = await EventStreamEvent.create({
      sequence,
      type,
      source: (input.source || 'system').toString(),
      category: (input.category || 'general').toString(),
      severity: ['info', 'warn', 'error'].includes(input.severity) ? input.severity : 'info',
      payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
      tags: Array.isArray(input.tags)
        ? input.tags.map((tag) => String(tag).trim()).filter(Boolean)
        : [],
      correlationId: input.correlationId || null
    });

    const event = this.toPublicEvent(doc);
    this.emit('event', event);
    return event;
  }

  async publishSafe(input = {}) {
    try {
      return await this.publish(input);
    } catch (error) {
      console.warn(`EventStreamService: failed to publish "${input?.type || 'unknown'}": ${error.message}`);
      return null;
    }
  }

  async replay(options = {}) {
    const sinceSequence = Math.max(0, Number(options.sinceSequence) || 0);
    const limit = Math.min(
      MAX_REPLAY_LIMIT,
      Math.max(1, Number(options.limit) || DEFAULT_REPLAY_LIMIT)
    );
    const types = Array.isArray(options.types)
      ? options.types.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const source = typeof options.source === 'string' && options.source.trim()
      ? options.source.trim()
      : null;
    const category = typeof options.category === 'string' && options.category.trim()
      ? options.category.trim()
      : null;
    const correlationId = typeof options.correlationId === 'string' && options.correlationId.trim()
      ? options.correlationId.trim()
      : null;

    const query = {
      ...(sinceSequence > 0 ? { sequence: { $gt: sinceSequence } } : {})
    };
    if (types.length > 0) {
      query.type = { $in: types };
    }
    if (source) {
      query.source = source;
    }
    if (category) {
      query.category = category;
    }
    if (correlationId) {
      query.correlationId = correlationId;
    }

    const docs = await EventStreamEvent.find(query)
      .sort({ sequence: 1 })
      .limit(limit);
    const events = docs.map((doc) => this.toPublicEvent(doc));
    const lastSequence = events.length > 0 ? events[events.length - 1].sequence : sinceSequence;

    return {
      events,
      lastSequence,
      count: events.length
    };
  }

  async latest(options = DEFAULT_REPLAY_LIMIT) {
    const limit = typeof options === 'number'
      ? options
      : Math.min(MAX_REPLAY_LIMIT, Math.max(1, Number(options?.limit) || DEFAULT_REPLAY_LIMIT));
    const source = typeof options === 'object' && typeof options?.source === 'string' && options.source.trim()
      ? options.source.trim()
      : null;
    const category = typeof options === 'object' && typeof options?.category === 'string' && options.category.trim()
      ? options.category.trim()
      : null;
    const correlationId = typeof options === 'object' && typeof options?.correlationId === 'string' && options.correlationId.trim()
      ? options.correlationId.trim()
      : null;
    const types = typeof options === 'object' && Array.isArray(options?.types)
      ? options.types.map((value) => String(value).trim()).filter(Boolean)
      : [];

    const query = {};
    if (source) {
      query.source = source;
    }
    if (category) {
      query.category = category;
    }
    if (correlationId) {
      query.correlationId = correlationId;
    }
    if (types.length > 0) {
      query.type = { $in: types };
    }

    const docs = await EventStreamEvent.find(query)
      .sort({ sequence: -1 })
      .limit(limit);
    return docs.map((doc) => this.toPublicEvent(doc)).reverse();
  }

  async summary(windowMinutes = 60) {
    const duration = Math.max(1, Number(windowMinutes) || 60);
    const startTime = new Date(Date.now() - duration * 60 * 1000);

    const [total, byType, bySeverity] = await Promise.all([
      EventStreamEvent.countDocuments({ createdAt: { $gte: startTime } }),
      EventStreamEvent.aggregate([
        { $match: { createdAt: { $gte: startTime } } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ]),
      EventStreamEvent.aggregate([
        { $match: { createdAt: { $gte: startTime } } },
        { $group: { _id: '$severity', count: { $sum: 1 } } }
      ])
    ]);

    return {
      windowMinutes: duration,
      total,
      byType: byType.reduce((acc, entry) => {
        acc[entry._id] = entry.count;
        return acc;
      }, {}),
      bySeverity: bySeverity.reduce((acc, entry) => {
        acc[entry._id || 'info'] = entry.count;
        return acc;
      }, {})
    };
  }
}

module.exports = new EventStreamService();

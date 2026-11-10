const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const eventStreamService = require('../services/eventStreamService');

const HEARTBEAT_MS = 25_000;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTypes(raw) {
  if (!raw) {
    return [];
  }

  if (Array.isArray(raw)) {
    raw = raw.join(',');
  }

  return String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function matchesFilters(event, { types, source, category, correlationId }) {
  if (!event) {
    return false;
  }

  if (Array.isArray(types) && types.length > 0 && !types.includes(event.type)) {
    return false;
  }

  if (source && event.source !== source) {
    return false;
  }

  if (category && event.category !== category) {
    return false;
  }

  if (correlationId && event.correlationId !== correlationId) {
    return false;
  }

  return true;
}

router.use(requireUser());

router.get('/summary', async (req, res) => {
  try {
    const windowMinutes = parsePositiveInt(req.query.windowMinutes, 60);
    const summary = await eventStreamService.summary(windowMinutes);
    return res.status(200).json({
      success: true,
      ...summary
    });
  } catch (error) {
    console.error('GET /api/events/summary - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch event summary'
    });
  }
});

router.get('/latest', async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 100);
    const types = parseTypes(req.query.types);
    const source = typeof req.query.source === 'string' && req.query.source.trim()
      ? req.query.source.trim()
      : null;
    const category = typeof req.query.category === 'string' && req.query.category.trim()
      ? req.query.category.trim()
      : null;
    const correlationId = typeof req.query.correlationId === 'string' && req.query.correlationId.trim()
      ? req.query.correlationId.trim()
      : null;
    const events = await eventStreamService.latest({
      limit,
      types,
      source,
      category,
      correlationId
    });
    return res.status(200).json({
      success: true,
      events,
      count: events.length,
      lastSequence: events.length > 0 ? events[events.length - 1].sequence : 0
    });
  } catch (error) {
    console.error('GET /api/events/latest - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch latest events'
    });
  }
});

router.get('/replay', async (req, res) => {
  try {
    const sinceSequence = parsePositiveInt(req.query.sinceSequence, 0);
    const limit = parsePositiveInt(req.query.limit, 100);
    const types = parseTypes(req.query.types);
    const source = typeof req.query.source === 'string' && req.query.source.trim()
      ? req.query.source.trim()
      : null;
    const category = typeof req.query.category === 'string' && req.query.category.trim()
      ? req.query.category.trim()
      : null;
    const correlationId = typeof req.query.correlationId === 'string' && req.query.correlationId.trim()
      ? req.query.correlationId.trim()
      : null;

    const replay = await eventStreamService.replay({
      sinceSequence,
      limit,
      types,
      source,
      category,
      correlationId
    });

    return res.status(200).json({
      success: true,
      ...replay
    });
  } catch (error) {
    console.error('GET /api/events/replay - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to replay events'
    });
  }
});

router.get('/stream', async (req, res) => {
  const filters = {
    types: parseTypes(req.query.types),
    source: typeof req.query.source === 'string' ? req.query.source.trim() : null,
    category: typeof req.query.category === 'string' ? req.query.category.trim() : null,
    correlationId: typeof req.query.correlationId === 'string' ? req.query.correlationId.trim() : null
  };
  // EventSource sends this header automatically after a transport reconnect.
  let cursor = parsePositiveInt(req.get('Last-Event-ID'), parsePositiveInt(req.query.sinceSequence, 0));
  const limit = Math.min(500, parsePositiveInt(req.query.limit, 100));
  let closed = false;
  let replaying = true;
  let buffer = [];
  let heartbeat;
  let stopWatching;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    stopWatching?.();
    eventStreamService.removeListener('event', listener);
    res.end();
  };
  const writeEvent = (event) => {
    const sequence = Number(event?.sequence);
    if (closed || !Number.isSafeInteger(sequence) || sequence <= cursor) return;
    // Disconnect slow consumers; their durable cursor allows a later replay.
    if (res.writableLength > 1024 * 1024) { cleanup(); return; }
    res.write(`id: ${sequence}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`);
    cursor = sequence;
  };
  const listener = (event) => {
    if (closed || !matchesFilters(event, filters)) return;
    if (replaying) {
      buffer.push(event);
      if (buffer.length > 1000) cleanup();
    } else writeEvent(event);
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // Subscribe before querying Mongo so inserts during replay cannot be lost.
  eventStreamService.on('event', listener);
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
  stopWatching = require('../utils/watchAuthorization').watchAuthorization(req, cleanup);
  try {
    while (!closed) {
      const replay = await eventStreamService.replay({ ...filters, sinceSequence: cursor, limit });
      replay.events.forEach(writeEvent);
      if (replay.events.length < limit) break;
    }
    if (closed) return;
    buffer.sort((a, b) => a.sequence - b.sequence).forEach(writeEvent);
    buffer = [];
    replaying = false;
    res.write(`event: ready\ndata: ${JSON.stringify({ sinceSequence: cursor })}\n\n`);
    heartbeat = setInterval(() => { if (!closed) res.write(':\n\n'); }, HEARTBEAT_MS);
    heartbeat.unref?.();
  } catch (error) {
    console.error('GET /api/events/stream - Replay failed:', error.message);
    cleanup();
  }
});

module.exports = router;

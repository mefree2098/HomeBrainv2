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
  let sinceSequence = parsePositiveInt(req.query.sinceSequence, 0);
  const limit = parsePositiveInt(req.query.limit, 100);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const writeEvent = (event) => {
    try {
      res.write(`id: ${event.sequence}\n`);
      res.write('event: event\n');
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      sinceSequence = Math.max(sinceSequence, Number(event.sequence) || sinceSequence);
    } catch (error) {
      console.warn('GET /api/events/stream - Failed to write event:', error.message);
    }
  };

  try {
    const replay = await eventStreamService.replay({
      sinceSequence,
      limit,
      types,
      source,
      category,
      correlationId
    });
    replay.events.forEach(writeEvent);
  } catch (error) {
    console.error('GET /api/events/stream - Failed initial replay:', error.message);
  }

  res.write('event: ready\n');
  res.write(`data: ${JSON.stringify({ sinceSequence })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(':\n\n');
    } catch (error) {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_MS);

  const listener = (event) => {
    if ((Number(event?.sequence) || 0) <= sinceSequence) {
      return;
    }
    if (!matchesFilters(event, { types, source, category, correlationId })) {
      return;
    }
    writeEvent(event);
  };

  eventStreamService.on('event', listener);

  let closed = false;
  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    eventStreamService.removeListener('event', listener);
    try {
      res.end();
    } catch (error) {
      // No-op.
    }
  };

  req.on('close', cleanup);
  req.on('end', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

module.exports = router;

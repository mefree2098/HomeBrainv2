const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

const DEFAULT_LOG_LIMIT = 50000;
const MAX_LOG_LIMIT = 50000;

function parsePositiveInt(value, fallback, maximum = MAX_LOG_LIMIT) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.min(maximum, numeric);
}

function trimString(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function normalizeLevel(value) {
  const normalized = trimString(value, 'info')?.toLowerCase();
  return ['info', 'warn', 'error'].includes(normalized) ? normalized : 'info';
}

function normalizeProtocol(value) {
  const normalized = trimString(value, 'system')?.toLowerCase();
  return ['zigbee', 'zwave', 'system'].includes(normalized) ? normalized : 'system';
}

function normalizeDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((accumulator, [key, entryValue]) => {
    if (entryValue !== undefined) {
      accumulator[key] = entryValue;
    }
    return accumulator;
  }, {});
}

class DirectRadioEngineLogService extends EventEmitter {
  constructor() {
    super();
    this._entries = [];
    this._limit = parsePositiveInt(process.env.HOMEBRAIN_DIRECT_RADIO_LOG_LIMIT, DEFAULT_LOG_LIMIT);
  }

  publish(input = {}) {
    const timestamp = input.timestamp ? new Date(input.timestamp) : new Date();
    const entry = {
      id: trimString(input.id, null) || randomUUID(),
      timestamp: Number.isNaN(timestamp.getTime()) ? new Date().toISOString() : timestamp.toISOString(),
      level: normalizeLevel(input.level),
      protocol: normalizeProtocol(input.protocol),
      stage: trimString(input.stage, null),
      operation: trimString(input.operation, null),
      target: trimString(input.target, null),
      message: trimString(input.message, 'Direct radio activity'),
      details: normalizeDetails(input.details)
    };

    this._entries.push(entry);
    if (this._entries.length > this._limit) {
      this._entries.splice(0, this._entries.length - this._limit);
    }

    this.emit('log', entry);
    return entry;
  }

  latest(options = {}) {
    const limit = typeof options === 'number'
      ? parsePositiveInt(options, Math.min(200, this._limit), this._limit)
      : parsePositiveInt(options.limit, Math.min(200, this._limit), this._limit);
    return this._entries.slice(-limit);
  }

  reset() {
    this._entries = [];
  }
}

module.exports = new DirectRadioEngineLogService();

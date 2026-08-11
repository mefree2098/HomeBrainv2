const rateLimit = require('express-rate-limit');

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_REQUEST_LIMIT = 1_800;

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function getApiRateLimitConfig(env = process.env) {
  return {
    windowMs: clampInteger(
      env.HOMEBRAIN_API_RATE_LIMIT_WINDOW_MS,
      DEFAULT_WINDOW_MS,
      1_000,
      24 * 60 * 60 * 1_000
    ),
    limit: clampInteger(
      env.HOMEBRAIN_API_RATE_LIMIT_MAX,
      DEFAULT_REQUEST_LIMIT,
      100,
      100_000
    )
  };
}

function createApiRateLimit(options = {}) {
  const defaults = getApiRateLimitConfig(options.env || process.env);
  const { ipKeyGenerator } = rateLimit;

  return rateLimit({
    windowMs: clampInteger(options.windowMs, defaults.windowMs, 1_000, 24 * 60 * 60 * 1_000),
    limit: clampInteger(options.limit, defaults.limit, 1, 100_000),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator(req) {
      return typeof ipKeyGenerator === 'function'
        ? ipKeyGenerator(req.ip)
        : (req.ip || req.socket?.remoteAddress || 'unknown');
    },
    message: {
      success: false,
      message: 'Too many API requests. Please retry shortly.'
    }
  });
}

module.exports = {
  createApiRateLimit,
  getApiRateLimitConfig
};

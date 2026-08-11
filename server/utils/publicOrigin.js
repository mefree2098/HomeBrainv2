const {
  isAllowedLocalHostname,
  parseHttpUrl,
  trimTrailingSlashes
} = require('./networkSafety');

function normalizeOrigin(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = trimTrailingSlashes(value.trim());
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = parseHttpUrl(trimmed, 'Public origin');
    return parsed.origin;
  } catch (_error) {
    return '';
  }
}

function getConfiguredPublicOrigin() {
  return normalizeOrigin(process.env.HOMEBRAIN_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || '');
}

function getClientOrigin(req) {
  return normalizeOrigin(process.env.CLIENT_URL || '') || getRequestOrigin(req);
}

function getRequestOrigin(req) {
  const configured = getConfiguredPublicOrigin();
  if (configured) {
    return configured;
  }

  const host = req.get('host');
  if (!host) {
    return '';
  }

  const protocol = req.protocol || (req.secure ? 'https' : 'http');
  try {
    const parsed = parseHttpUrl(`${protocol}://${host}`, 'Request origin');
    const allowUnconfiguredPublicHost = process.env.NODE_ENV !== 'production'
      || String(process.env.HOMEBRAIN_ALLOW_HOST_HEADER_ORIGIN || '').toLowerCase() === 'true';
    if (!allowUnconfiguredPublicHost && !isAllowedLocalHostname(parsed.hostname)) {
      return '';
    }
    return parsed.origin;
  } catch (_error) {
    return '';
  }
}

function toWebSocketOrigin(origin) {
  try {
    const parsed = new URL(origin);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return parsed.origin;
  } catch (_error) {
    return '';
  }
}

function buildClientRedirectUrl(req, pathname, parameters = {}) {
  const origin = getClientOrigin(req);
  const target = new URL(pathname || '/', origin || 'http://homebrain.invalid');
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null) {
      target.searchParams.set(key, String(value));
    }
  }
  return origin ? target.toString() : `${target.pathname}${target.search}`;
}

module.exports = {
  buildClientRedirectUrl,
  getClientOrigin,
  getConfiguredPublicOrigin,
  getRequestOrigin,
  normalizeOrigin,
  toWebSocketOrigin
};

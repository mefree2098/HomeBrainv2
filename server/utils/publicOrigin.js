function normalizeOrigin(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.origin;
  } catch (_error) {
    return '';
  }
}

function getConfiguredPublicOrigin() {
  return normalizeOrigin(process.env.HOMEBRAIN_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || '');
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
  return `${protocol}://${host}`;
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

module.exports = {
  getConfiguredPublicOrigin,
  getRequestOrigin,
  toWebSocketOrigin
};

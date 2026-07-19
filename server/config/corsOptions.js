function splitList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeOrigin(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  try {
    return new URL(value.trim()).origin;
  } catch (_error) {
    return '';
  }
}

function buildAllowedOrigins(env = process.env) {
  const configured = [
    env.CLIENT_URL,
    env.HOMEBRAIN_PUBLIC_BASE_URL,
    env.PUBLIC_BASE_URL,
    env.AXIOM_PUBLIC_BASE_URL,
    env.AXIOM_PUBLIC_URL,
    ...splitList(env.CORS_ALLOWED_ORIGINS)
  ].map(normalizeOrigin).filter(Boolean);

  if (env.NODE_ENV !== 'production') {
    configured.push(
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000'
    );
  }

  return [...new Set(configured)];
}

function getRequestOrigin(req) {
  const host = req?.get?.('host') || req?.headers?.host;
  if (!host) {
    return '';
  }

  const protocol = String(req?.protocol || (req?.secure ? 'https' : 'http')).trim().toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') {
    return '';
  }

  return normalizeOrigin(`${protocol}://${host}`);
}

function buildCorsOptions(req = null, env = process.env) {
  const allowedOrigins = buildAllowedOrigins(env);
  const requestOrigin = getRequestOrigin(req);

  return {
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = normalizeOrigin(origin);
      if (normalizedOrigin && (normalizedOrigin === requestOrigin || allowedOrigins.includes(normalizedOrigin))) {
        return callback(null, true);
      }

      const error = new Error('CORS origin not allowed');
      error.status = 403;
      return callback(error);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-CSRF-Token',
      'X-HomeBrain-Client-Type',
      'X-HomeBrain-Client-Name',
      'X-HomeBrain-Device-Id',
      'X-HomeBrain-Registration-Code',
      'X-HomeBrain-Claim-Token',
      'X-HomeBrain-Device-Token'
    ]
  };
}

module.exports = {
  buildAllowedOrigins,
  buildCorsOptions,
  getRequestOrigin,
  normalizeOrigin,
  splitList
};

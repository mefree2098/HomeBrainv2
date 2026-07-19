const ACCESS_TOKEN_COOKIE_NAME = 'hbAccessToken';
const SESSION_TOKEN_COOKIE_NAME = 'hbSessionToken';

const ACCESS_TOKEN_COOKIE_MAX_AGE = Number(process.env.ACCESS_TOKEN_COOKIE_MAX_AGE || 60 * 60 * 1000);
const SESSION_TOKEN_COOKIE_MAX_AGE = Number(process.env.SESSION_TOKEN_COOKIE_MAX_AGE || 30 * 24 * 60 * 60 * 1000);
const COOKIE_SAMESITE = ['strict', 'lax', 'none'].includes(String(process.env.COOKIE_SAMESITE || '').toLowerCase())
  ? String(process.env.COOKIE_SAMESITE).toLowerCase()
  : 'lax';

function parseBooleanOverride(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return null;
}

function resolveCookieSecure(req, env = process.env) {
  const configuredValue = parseBooleanOverride(env.COOKIE_SECURE);
  if (configuredValue !== null) {
    return configuredValue;
  }

  return req?.secure === true || String(req?.protocol || '').toLowerCase() === 'https';
}

// Kept for callers that consumed the previous exported constant. Cookie writers use
// resolveCookieSecure() so HTTP and HTTPS requests can be handled correctly at runtime.
const SECURE_COOKIE = resolveCookieSecure(null);

function getCookieValue(req, name) {
  const rawCookies = req?.headers?.cookie;
  if (!rawCookies || typeof rawCookies !== 'string') {
    return null;
  }

  for (const part of rawCookies.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = decodeURIComponent(trimmed.slice(0, separatorIndex));
    if (key !== name) {
      continue;
    }

    return decodeURIComponent(trimmed.slice(separatorIndex + 1));
  }

  return null;
}

function buildCookieOptions(maxAge, options = {}) {
  const includeMaxAge = options.includeMaxAge !== false;

  return {
    httpOnly: true,
    sameSite: COOKIE_SAMESITE,
    secure: resolveCookieSecure(options.req, options.env),
    path: '/',
    ...(includeMaxAge ? { maxAge } : {})
  };
}

function setAccessTokenCookie(res, accessToken, maxAge = ACCESS_TOKEN_COOKIE_MAX_AGE, options = {}) {
  res.cookie(ACCESS_TOKEN_COOKIE_NAME, accessToken, buildCookieOptions(maxAge, options));
}

function setSessionTokenCookie(res, sessionToken, maxAge = SESSION_TOKEN_COOKIE_MAX_AGE, options = {}) {
  res.cookie(SESSION_TOKEN_COOKIE_NAME, sessionToken, buildCookieOptions(maxAge, options));
}

function setAuthCookies(res, accessToken, sessionToken, options = {}) {
  setAccessTokenCookie(
    res,
    accessToken,
    options.accessTokenMaxAge || ACCESS_TOKEN_COOKIE_MAX_AGE,
    options
  );
  setSessionTokenCookie(
    res,
    sessionToken,
    options.sessionTokenMaxAge || SESSION_TOKEN_COOKIE_MAX_AGE,
    options
  );
}

function clearAuthCookies(res, options = {}) {
  const clearOptions = { ...options, includeMaxAge: false };
  res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, buildCookieOptions(ACCESS_TOKEN_COOKIE_MAX_AGE, clearOptions));
  res.clearCookie(SESSION_TOKEN_COOKIE_NAME, buildCookieOptions(SESSION_TOKEN_COOKIE_MAX_AGE, clearOptions));
}

module.exports = {
  ACCESS_TOKEN_COOKIE_NAME,
  SESSION_TOKEN_COOKIE_NAME,
  ACCESS_TOKEN_COOKIE_MAX_AGE,
  SESSION_TOKEN_COOKIE_MAX_AGE,
  COOKIE_SAMESITE,
  SECURE_COOKIE,
  buildCookieOptions,
  getCookieValue,
  resolveCookieSecure,
  setAccessTokenCookie,
  setSessionTokenCookie,
  setAuthCookies,
  clearAuthCookies
};

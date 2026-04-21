const ACCESS_TOKEN_COOKIE_NAME = 'hbAccessToken';
const SESSION_TOKEN_COOKIE_NAME = 'hbSessionToken';

const SECURE_COOKIE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const ACCESS_TOKEN_COOKIE_MAX_AGE = Number(process.env.ACCESS_TOKEN_COOKIE_MAX_AGE || 60 * 60 * 1000);
const SESSION_TOKEN_COOKIE_MAX_AGE = Number(process.env.SESSION_TOKEN_COOKIE_MAX_AGE || 30 * 24 * 60 * 60 * 1000);
const COOKIE_SAMESITE = ['strict', 'lax', 'none'].includes(String(process.env.COOKIE_SAMESITE || '').toLowerCase())
  ? String(process.env.COOKIE_SAMESITE).toLowerCase()
  : 'lax';

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
    secure: SECURE_COOKIE,
    path: '/',
    ...(includeMaxAge ? { maxAge } : {})
  };
}

function setAccessTokenCookie(res, accessToken, maxAge = ACCESS_TOKEN_COOKIE_MAX_AGE) {
  res.cookie(ACCESS_TOKEN_COOKIE_NAME, accessToken, buildCookieOptions(maxAge));
}

function setSessionTokenCookie(res, sessionToken, maxAge = SESSION_TOKEN_COOKIE_MAX_AGE) {
  res.cookie(SESSION_TOKEN_COOKIE_NAME, sessionToken, buildCookieOptions(maxAge));
}

function setAuthCookies(res, accessToken, sessionToken, options = {}) {
  setAccessTokenCookie(res, accessToken, options.accessTokenMaxAge || ACCESS_TOKEN_COOKIE_MAX_AGE);
  setSessionTokenCookie(res, sessionToken, options.sessionTokenMaxAge || SESSION_TOKEN_COOKIE_MAX_AGE);
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, buildCookieOptions(ACCESS_TOKEN_COOKIE_MAX_AGE, { includeMaxAge: false }));
  res.clearCookie(SESSION_TOKEN_COOKIE_NAME, buildCookieOptions(SESSION_TOKEN_COOKIE_MAX_AGE, { includeMaxAge: false }));
}

module.exports = {
  ACCESS_TOKEN_COOKIE_NAME,
  SESSION_TOKEN_COOKIE_NAME,
  ACCESS_TOKEN_COOKIE_MAX_AGE,
  SESSION_TOKEN_COOKIE_MAX_AGE,
  COOKIE_SAMESITE,
  SECURE_COOKIE,
  getCookieValue,
  setAccessTokenCookie,
  setSessionTokenCookie,
  setAuthCookies,
  clearAuthCookies
};

const ACCESS_TOKEN_COOKIE_NAME = 'hbAccessToken';
const SESSION_TOKEN_COOKIE_NAME = 'hbSessionToken';

const SECURE_COOKIE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const ACCESS_TOKEN_COOKIE_MAX_AGE = Number(process.env.ACCESS_TOKEN_COOKIE_MAX_AGE || 60 * 60 * 1000);
const SESSION_TOKEN_COOKIE_MAX_AGE = Number(process.env.SESSION_TOKEN_COOKIE_MAX_AGE || 30 * 24 * 60 * 60 * 1000);

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

function buildCookieOptions(maxAge) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIE,
    path: '/',
    maxAge
  };
}

function setAccessTokenCookie(res, accessToken) {
  res.cookie(ACCESS_TOKEN_COOKIE_NAME, accessToken, buildCookieOptions(ACCESS_TOKEN_COOKIE_MAX_AGE));
}

function setSessionTokenCookie(res, sessionToken) {
  res.cookie(SESSION_TOKEN_COOKIE_NAME, sessionToken, buildCookieOptions(SESSION_TOKEN_COOKIE_MAX_AGE));
}

function setAuthCookies(res, accessToken, sessionToken) {
  setAccessTokenCookie(res, accessToken);
  setSessionTokenCookie(res, sessionToken);
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, buildCookieOptions(ACCESS_TOKEN_COOKIE_MAX_AGE));
  res.clearCookie(SESSION_TOKEN_COOKIE_NAME, buildCookieOptions(SESSION_TOKEN_COOKIE_MAX_AGE));
}

module.exports = {
  ACCESS_TOKEN_COOKIE_NAME,
  SESSION_TOKEN_COOKIE_NAME,
  ACCESS_TOKEN_COOKIE_MAX_AGE,
  SESSION_TOKEN_COOKIE_MAX_AGE,
  SECURE_COOKIE,
  getCookieValue,
  setAccessTokenCookie,
  setSessionTokenCookie,
  setAuthCookies,
  clearAuthCookies
};

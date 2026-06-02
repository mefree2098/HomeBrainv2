const crypto = require('crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;
const DEFAULT_AMAZON_PAGE = 'amazon.com';
const DEFAULT_SERVICE_HOST = 'pitangui.amazon.com';
const REQUIRED_COOKIE_NAMES = ['session-id', 'session-token', 'csrf'];
const IMPORTANT_COOKIE_NAMES = ['ubid-main', 'session-id-time', 'at-main', 'sess-at-main', 'x-main'];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowMs() {
  return Date.now();
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeHostname(value, fallback) {
  const raw = trimString(value) || fallback;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).hostname.toLowerCase();
  } catch (_error) {
    return fallback;
  }
}

function normalizeAmazonPage(value) {
  const host = normalizeHostname(value, DEFAULT_AMAZON_PAGE);
  return host.replace(/^www\./i, '') || DEFAULT_AMAZON_PAGE;
}

function normalizeServiceHost(value) {
  return normalizeHostname(value, DEFAULT_SERVICE_HOST) || DEFAULT_SERVICE_HOST;
}

function buildAlexaSpaUrl(amazonPage) {
  const host = normalizeAmazonPage(amazonPage);
  if (host === DEFAULT_AMAZON_PAGE) {
    return 'https://alexa.amazon.com/spa/index.html';
  }
  return `https://alexa.${host}/spa/index.html`;
}

function buildAmazonLoginUrl(amazonPage) {
  const host = normalizeAmazonPage(amazonPage);
  const returnTo = buildAlexaSpaUrl(host);
  const target = new URL(`https://www.${host}/ap/signin`);
  target.searchParams.set('openid.pape.max_auth_age', '0');
  target.searchParams.set('openid.return_to', returnTo);
  target.searchParams.set('openid.assoc_handle', 'amzn_alexa_us');
  target.searchParams.set('openid.mode', 'checkid_setup');
  target.searchParams.set('openid.ns', 'http://specs.openid.net/auth/2.0');
  target.searchParams.set('openid.identity', 'http://specs.openid.net/auth/2.0/identifier_select');
  target.searchParams.set('openid.claimed_id', 'http://specs.openid.net/auth/2.0/identifier_select');
  return target.toString();
}

function parseCookieNames(cookie) {
  return trimString(cookie)
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf('=');
      return separatorIndex > 0 ? entry.slice(0, separatorIndex).trim() : '';
    })
    .filter(Boolean);
}

function extractCookieValue(cookie, name) {
  const expected = String(name || '').toLowerCase();
  const entry = trimString(cookie)
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.slice(0, part.indexOf('=')).trim().toLowerCase() === expected);
  if (!entry) {
    return '';
  }
  const separatorIndex = entry.indexOf('=');
  return separatorIndex >= 0 ? entry.slice(separatorIndex + 1).trim() : '';
}

function extractCsrf(cookie) {
  const value = extractCookieValue(cookie, 'csrf');
  if (!value) {
    return '';
  }
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function appendCookie(cookie, name, value) {
  const normalizedCookie = trimString(cookie);
  const normalizedName = trimString(name);
  const normalizedValue = trimString(value);
  if (!normalizedCookie || !normalizedName || !normalizedValue) {
    return normalizedCookie;
  }
  const names = new Set(parseCookieNames(normalizedCookie).map((entry) => entry.toLowerCase()));
  if (names.has(normalizedName.toLowerCase())) {
    return normalizedCookie;
  }
  return `${normalizedCookie}; ${normalizedName}=${normalizedValue}`;
}

function validateCookie(cookie, explicitCsrf = '') {
  let normalizedCookie = trimString(cookie);
  if (!normalizedCookie) {
    throw Object.assign(new Error('Alexa session capture did not include a cookie'), { status: 400 });
  }

  if (explicitCsrf && !extractCsrf(normalizedCookie)) {
    normalizedCookie = appendCookie(normalizedCookie, 'csrf', explicitCsrf);
  }

  const names = new Set(parseCookieNames(normalizedCookie).map((entry) => entry.toLowerCase()));
  const missing = REQUIRED_COOKIE_NAMES.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw Object.assign(new Error(`Alexa session cookie is missing ${missing.join(', ')}`), {
      status: 400,
      missing
    });
  }

  const warnings = IMPORTANT_COOKIE_NAMES
    .filter((name) => !names.has(name))
    .map((name) => `${name} was not present in the captured cookie`);

  return {
    cookie: normalizedCookie,
    csrf: extractCsrf(normalizedCookie),
    cookieNames: Array.from(names).sort(),
    warnings
  };
}

function getPublicBaseUrl(req) {
  const proto = trimString(req?.headers?.['x-forwarded-proto']).split(',')[0] || req?.protocol || 'http';
  const host = trimString(req?.headers?.['x-forwarded-host']).split(',')[0] || trimString(req?.headers?.host);
  if (!host) {
    return '';
  }
  return `${proto}://${host}`;
}

class AlexaSessionCaptureService {
  constructor({ ttlMs = DEFAULT_TTL_MS, clock = nowMs } = {}) {
    this.ttlMs = Math.min(Math.max(Number(ttlMs) || DEFAULT_TTL_MS, 60 * 1000), MAX_TTL_MS);
    this.clock = clock;
    this.sessions = new Map();
  }

  cleanupExpired() {
    const current = this.clock();
    for (const [id, session] of this.sessions.entries()) {
      if (session.expiresAtMs <= current) {
        if (session.status === 'pending') {
          session.status = 'expired';
          session.message = 'Alexa session capture expired before the helper returned a session.';
        }
        if (session.expiresAtMs + this.ttlMs < current) {
          this.sessions.delete(id);
        }
      }
    }
  }

  startCapture({ actor = 'unknown', amazonPage = DEFAULT_AMAZON_PAGE, serviceHost = DEFAULT_SERVICE_HOST, req = null } = {}) {
    this.cleanupExpired();
    const captureId = randomToken(18);
    const token = randomToken(32);
    const normalizedAmazonPage = normalizeAmazonPage(amazonPage);
    const normalizedServiceHost = normalizeServiceHost(serviceHost);
    const startedAtMs = this.clock();
    const expiresAtMs = startedAtMs + this.ttlMs;
    const publicBaseUrl = getPublicBaseUrl(req);
    const loginUrl = buildAmazonLoginUrl(normalizedAmazonPage);
    const receiverUrl = publicBaseUrl
      ? `${publicBaseUrl}/api/alexa/session-capture/${encodeURIComponent(captureId)}/complete`
      : `/api/alexa/session-capture/${encodeURIComponent(captureId)}/complete`;
    const statusUrl = publicBaseUrl
      ? `${publicBaseUrl}/api/alexa/session-capture/${encodeURIComponent(captureId)}/status`
      : `/api/alexa/session-capture/${encodeURIComponent(captureId)}/status`;
    const capturePageUrl = publicBaseUrl
      ? `${publicBaseUrl}/alexa-session-capture.html?captureId=${encodeURIComponent(captureId)}&token=${encodeURIComponent(token)}&receiver=${encodeURIComponent(receiverUrl)}&status=${encodeURIComponent(statusUrl)}&login=${encodeURIComponent(loginUrl)}&serviceHost=${encodeURIComponent(normalizedServiceHost)}&amazonPage=${encodeURIComponent(normalizedAmazonPage)}`
      : `/alexa-session-capture.html?captureId=${encodeURIComponent(captureId)}&token=${encodeURIComponent(token)}&receiver=${encodeURIComponent(receiverUrl)}&status=${encodeURIComponent(statusUrl)}&login=${encodeURIComponent(loginUrl)}&serviceHost=${encodeURIComponent(normalizedServiceHost)}&amazonPage=${encodeURIComponent(normalizedAmazonPage)}`;

    const session = {
      captureId,
      tokenHash: hashToken(token),
      actor: trimString(actor) || 'unknown',
      amazonPage: normalizedAmazonPage,
      serviceHost: normalizedServiceHost,
      status: 'pending',
      message: 'Waiting for Alexa login helper to capture a fresh session.',
      startedAtMs,
      expiresAtMs,
      startedAt: new Date(startedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      completedAt: null,
      cookieNames: [],
      warnings: []
    };
    this.sessions.set(captureId, session);

    return {
      captureId,
      token,
      status: session.status,
      message: session.message,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      amazonPage: normalizedAmazonPage,
      serviceHost: normalizedServiceHost,
      loginUrl,
      receiverUrl,
      statusUrl,
      capturePageUrl,
      helperExtensionUrl: '/api/alexa/session-capture/helper-extension.zip'
    };
  }

  getStatus(captureId) {
    this.cleanupExpired();
    const session = this.sessions.get(trimString(captureId));
    if (!session) {
      throw Object.assign(new Error('Alexa session capture was not found or has expired'), { status: 404 });
    }
    return this.sanitizeSession(session);
  }

  completeCapture(captureId, { token = '', cookie = '', csrf = '', userAgent = '', helperVersion = '' } = {}) {
    this.cleanupExpired();
    const session = this.sessions.get(trimString(captureId));
    if (!session) {
      throw Object.assign(new Error('Alexa session capture was not found or has expired'), { status: 404 });
    }
    if (session.status !== 'pending') {
      throw Object.assign(new Error(`Alexa session capture is already ${session.status}`), { status: 409 });
    }
    if (session.expiresAtMs <= this.clock()) {
      session.status = 'expired';
      session.message = 'Alexa session capture expired before the helper returned a session.';
      throw Object.assign(new Error(session.message), { status: 410 });
    }
    if (hashToken(token) !== session.tokenHash) {
      throw Object.assign(new Error('Alexa session capture token is invalid'), { status: 401 });
    }

    const validation = validateCookie(cookie, csrf);
    session.status = 'captured';
    session.message = 'Alexa session was captured and is ready to activate.';
    session.completedAt = new Date(this.clock()).toISOString();
    session.cookieNames = validation.cookieNames;
    session.warnings = validation.warnings;
    session.userAgent = trimString(userAgent);
    session.helperVersion = trimString(helperVersion);

    return {
      ...this.sanitizeSession(session),
      cookie: validation.cookie,
      csrf: validation.csrf
    };
  }

  markActivated(captureId, { message = 'Alexa session was saved and broker runtime was refreshed.' } = {}) {
    const session = this.sessions.get(trimString(captureId));
    if (!session) {
      return null;
    }
    session.status = 'activated';
    session.message = trimString(message) || 'Alexa session was saved and broker runtime was refreshed.';
    session.activatedAt = new Date(this.clock()).toISOString();
    return this.sanitizeSession(session);
  }

  markFailed(captureId, error) {
    const session = this.sessions.get(trimString(captureId));
    if (!session) {
      return null;
    }
    session.status = 'failed';
    session.message = error?.message || 'Alexa session capture failed.';
    session.failedAt = new Date(this.clock()).toISOString();
    return this.sanitizeSession(session);
  }

  sanitizeSession(session) {
    return {
      captureId: session.captureId,
      status: session.status,
      message: session.message,
      startedAt: session.startedAt,
      expiresAt: session.expiresAt,
      completedAt: session.completedAt || null,
      activatedAt: session.activatedAt || null,
      failedAt: session.failedAt || null,
      amazonPage: session.amazonPage,
      serviceHost: session.serviceHost,
      cookieNames: Array.isArray(session.cookieNames) ? session.cookieNames : [],
      warnings: Array.isArray(session.warnings) ? session.warnings : []
    };
  }
}

module.exports = {
  AlexaSessionCaptureService,
  buildAmazonLoginUrl,
  normalizeAmazonPage,
  normalizeServiceHost,
  validateCookie
};

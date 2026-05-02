const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const UserSession = require('../models/UserSession');
const UserService = require('./userService');
const Settings = require('../models/Settings');
const { generateAccessToken, generateRefreshToken } = require('../utils/auth');

const DEFAULT_SESSION_MAX_AGE_DAYS = 30;
const DEFAULT_IOS_SESSION_MAX_AGE_DAYS = 365;
const MIN_SESSION_MAX_AGE_DAYS = 1;
const MAX_SESSION_MAX_AGE_DAYS = 3650;
const SESSION_CLIENT_TYPES = new Set(['ios', 'watchos', 'web', 'android', 'desktop', 'api', 'unknown']);
const SHARED_REFRESH_TOKEN_CLIENT_TYPES = new Set(['ios', 'watchos']);

function trimString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(Math.max(Math.round(numeric), min), max);
}

function normalizeClientType(rawValue) {
  const normalized = trimString(rawValue, 'unknown').toLowerCase();
  return SESSION_CLIENT_TYPES.has(normalized) ? normalized : 'unknown';
}

function isBrowserLikeRequest(req = {}) {
  return Boolean(req.headers?.origin || req.headers?.['sec-fetch-site']);
}

function extractIpAddress(req) {
  const forwarded = trimString(req?.headers?.['x-forwarded-for']);
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  return trimString(req?.ip || req?.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function detectBrowserLabel(userAgent = '') {
  const ua = userAgent.toLowerCase();
  if (!ua) {
    return '';
  }

  if (ua.includes('edg/')) return 'Edge';
  if (ua.includes('chrome/') && !ua.includes('edg/')) return 'Chrome';
  if (ua.includes('firefox/')) return 'Firefox';
  if (ua.includes('safari/') && !ua.includes('chrome/')) return 'Safari';
  return 'Browser';
}

function detectPlatformLabel(userAgent = '') {
  const ua = userAgent.toLowerCase();
  if (!ua) {
    return '';
  }

  if (ua.includes('ipad')) return 'iPad';
  if (ua.includes('iphone')) return 'iPhone';
  if (ua.includes('mac os x') || ua.includes('macintosh')) return 'Mac';
  if (ua.includes('windows')) return 'Windows';
  if (ua.includes('android')) return 'Android';
  if (ua.includes('linux')) return 'Linux';
  return '';
}

function inferClientName(clientType, userAgent) {
  if (clientType === 'ios') {
    return detectPlatformLabel(userAgent) || 'iOS device';
  }

  if (clientType === 'watchos') {
    return 'Apple Watch';
  }

  if (clientType === 'web') {
    const browser = detectBrowserLabel(userAgent);
    const platform = detectPlatformLabel(userAgent);
    return [browser, platform].filter(Boolean).join(' on ') || 'Web browser';
  }

  if (clientType === 'android') {
    return 'Android device';
  }

  if (clientType === 'desktop') {
    return 'Desktop app';
  }

  if (clientType === 'api') {
    return 'API client';
  }

  return 'Unknown device';
}

function extractSessionMetadata(req = {}) {
  const userAgent = trimString(req.headers?.['user-agent']);
  const requestedClientType = normalizeClientType(req.headers?.['x-homebrain-client-type']);
  const clientType = isBrowserLikeRequest(req) && requestedClientType !== 'web'
    ? 'web'
    : requestedClientType;
  const clientName = trimString(req.headers?.['x-homebrain-client-name']);
  const deviceId = trimString(req.headers?.['x-homebrain-device-id']);
  const appVersion = trimString(req.headers?.['x-homebrain-app-version']);

  return {
    clientType,
    clientName: clientName || inferClientName(clientType, userAgent),
    deviceId,
    appVersion,
    userAgent,
    ipAddress: extractIpAddress(req)
  };
}

async function getSettingsSessionLifetimeDays(fallback) {
  try {
    const settings = await Settings.getSettings();
    return clampNumber(
      settings?.authSessionMaxAgeDays,
      MIN_SESSION_MAX_AGE_DAYS,
      MAX_SESSION_MAX_AGE_DAYS,
      fallback
    );
  } catch (_error) {
    return fallback;
  }
}

async function getSessionLifetimeDays(clientType = 'unknown') {
  const normalizedClientType = normalizeClientType(clientType);

  if (normalizedClientType === 'ios' || normalizedClientType === 'watchos') {
    const iosEnvOverride = trimString(process.env.AUTH_IOS_SESSION_MAX_AGE_DAYS);
    if (iosEnvOverride) {
      return clampNumber(
        iosEnvOverride,
        MIN_SESSION_MAX_AGE_DAYS,
        MAX_SESSION_MAX_AGE_DAYS,
        DEFAULT_IOS_SESSION_MAX_AGE_DAYS
      );
    }

    return getSettingsSessionLifetimeDays(DEFAULT_IOS_SESSION_MAX_AGE_DAYS);
  }

  const envOverride = trimString(process.env.AUTH_SESSION_MAX_AGE_DAYS);
  if (envOverride) {
    return clampNumber(envOverride, MIN_SESSION_MAX_AGE_DAYS, MAX_SESSION_MAX_AGE_DAYS, DEFAULT_SESSION_MAX_AGE_DAYS);
  }

  return DEFAULT_SESSION_MAX_AGE_DAYS;
}

function buildExpiryForDays(days) {
  return new Date(Date.now() + (days * 24 * 60 * 60 * 1000));
}

function decodeTokenExpiration(token) {
  const decoded = jwt.decode(token);
  const exp = Number(decoded?.exp || 0);
  return Number.isFinite(exp) && exp > 0 ? new Date(exp * 1000) : null;
}

function isValidDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function toSanitizedSession(session, currentSessionId = '') {
  const safe = session.toSanitized();
  return {
    ...safe,
    id: safe.sessionId,
    isCurrent: Boolean(currentSessionId && currentSessionId === safe.sessionId)
  };
}

function buildSessionError(message, status = 401) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function findReusableSession(userId, metadata) {
  if (!trimString(metadata.deviceId)) {
    return null;
  }

  return UserSession
    .findOne({
      userId,
      deviceId: metadata.deviceId,
      clientType: metadata.clientType,
      revokedAt: null
    })
    .sort({ updatedAt: -1, createdAt: -1 })
    .exec();
}

async function persistSession(session, metadata, refreshToken, expiresAt, overrides = {}) {
  session.tokenHash = hashToken(refreshToken);
  session.clientType = metadata.clientType;
  session.clientName = metadata.clientName;
  session.deviceId = metadata.deviceId;
  session.appVersion = metadata.appVersion;
  session.userAgent = metadata.userAgent;
  session.ipAddress = metadata.ipAddress;
  session.lastUsedAt = new Date();
  session.expiresAt = expiresAt;
  session.revokedAt = null;
  session.revokeReason = '';

  if (Object.prototype.hasOwnProperty.call(overrides, 'legacyMigrated')) {
    session.legacyMigrated = overrides.legacyMigrated === true;
  }

  await session.save();
  return session;
}

async function buildTokensForSession(user, sessionId, clientType = 'unknown') {
  const lifetimeDays = await getSessionLifetimeDays(clientType);
  const refreshExpiresAt = buildExpiryForDays(lifetimeDays);
  const expiresIn = `${lifetimeDays}d`;

  const accessToken = generateAccessToken(user, { sessionId });
  const refreshToken = generateRefreshToken(user, { sessionId, expiresIn });

  return {
    accessToken,
    refreshToken,
    refreshExpiresAt: decodeTokenExpiration(refreshToken) || refreshExpiresAt,
    refreshMaxAgeMs: Math.max(refreshExpiresAt.getTime() - Date.now(), 0)
  };
}

function buildTokensWithExistingRefreshToken(user, session, refreshToken) {
  const refreshExpiresAt = decodeTokenExpiration(refreshToken)
    || (isValidDate(session.expiresAt) ? session.expiresAt : buildExpiryForDays(DEFAULT_SESSION_MAX_AGE_DAYS));

  return {
    accessToken: generateAccessToken(user, { sessionId: session.sessionId }),
    refreshToken,
    refreshExpiresAt,
    refreshMaxAgeMs: Math.max(refreshExpiresAt.getTime() - Date.now(), 0)
  };
}

function shouldReuseRefreshToken(clientType) {
  return SHARED_REFRESH_TOKEN_CLIENT_TYPES.has(normalizeClientType(clientType));
}

async function issueSession(user, req, options = {}) {
  const metadata = {
    ...extractSessionMetadata(req),
    ...(options.metadata || {})
  };

  let session = null;

  if (trimString(options.sessionId)) {
    session = await UserSession.findOne({
      userId: user._id,
      sessionId: options.sessionId
    }).exec();
  }

  if (!session && options.reuseExisting !== false) {
    session = await findReusableSession(user._id, metadata);
  }

  if (!session) {
    session = new UserSession({
      userId: user._id,
      sessionId: trimString(options.sessionId) || crypto.randomUUID(),
      tokenHash: hashToken('pending'),
      expiresAt: new Date(),
      ...metadata
    });
  }

  const tokens = await buildTokensForSession(user, session.sessionId, metadata.clientType);
  await persistSession(
    session,
    metadata,
    tokens.refreshToken,
    tokens.refreshExpiresAt,
    {
      legacyMigrated: options.legacyMigrated === true
    }
  );

  return {
    session,
    tokens
  };
}

async function migrateLegacyRefreshToken(user, refreshToken, decoded, req) {
  const existing = await UserSession.findOne({
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    legacyMigrated: true
  }).exec();

  if (existing) {
    return existing;
  }

  const metadata = extractSessionMetadata(req);
  const session = new UserSession({
    userId: user._id,
    sessionId: crypto.randomUUID(),
    tokenHash: hashToken(refreshToken),
    clientType: metadata.clientType,
    clientName: metadata.clientName,
    deviceId: metadata.deviceId,
    appVersion: metadata.appVersion,
    userAgent: metadata.userAgent,
    ipAddress: metadata.ipAddress,
    lastUsedAt: new Date(),
    expiresAt: Number.isFinite(Number(decoded?.exp))
      ? new Date(Number(decoded.exp) * 1000)
      : buildExpiryForDays(DEFAULT_SESSION_MAX_AGE_DAYS),
    legacyMigrated: true
  });

  await session.save();
  return session;
}

async function loadValidatedSession(refreshToken, req = null, options = {}) {
  const normalizedToken = trimString(refreshToken);
  if (!normalizedToken) {
    throw buildSessionError('Refresh token is required', 401);
  }

  if (!process.env.REFRESH_TOKEN_SECRET) {
    throw buildSessionError('Server configuration error', 500);
  }

  let decoded = null;
  try {
    decoded = jwt.verify(normalizedToken, process.env.REFRESH_TOKEN_SECRET, {
      ignoreExpiration: options.ignoreExpiration === true
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw buildSessionError('Refresh token has expired', 403);
    }

    if (error.name === 'JsonWebTokenError') {
      throw buildSessionError('Invalid refresh token signature', 403);
    }

    throw buildSessionError('Invalid refresh token', 403);
  }

  const user = await UserService.get(decoded.sub);
  if (!user) {
    throw buildSessionError('User not found', 403);
  }

  if (!user.isActive) {
    throw buildSessionError('User account is inactive', 403);
  }

  let session = null;
  const sessionId = trimString(decoded.sid);

  if (sessionId) {
    session = await UserSession.findOne({
      userId: user._id,
      sessionId
    }).exec();
  } else if (user.refreshToken === normalizedToken) {
    session = await migrateLegacyRefreshToken(user, normalizedToken, decoded, req);
  }

  if (!session) {
    throw buildSessionError('Invalid refresh token', 403);
  }

  if (session.revokedAt) {
    throw buildSessionError('Refresh token has been revoked', 403);
  }

  if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) {
    throw buildSessionError('Refresh token has expired', 403);
  }

  if (session.tokenHash !== hashToken(normalizedToken)) {
    throw buildSessionError('Invalid refresh token', 403);
  }

  return {
    user,
    session,
    decoded
  };
}

async function refreshSession(refreshToken, req = null) {
  const { user, session } = await loadValidatedSession(refreshToken, req);
  const requestMetadata = extractSessionMetadata(req);
  const metadata = {
    ...requestMetadata,
    clientType: session.clientType || requestMetadata.clientType,
    clientName: requestMetadata.clientName || session.clientName,
    deviceId: requestMetadata.deviceId || session.deviceId,
    appVersion: requestMetadata.appVersion || session.appVersion,
    userAgent: requestMetadata.userAgent || session.userAgent
  };
  const tokens = shouldReuseRefreshToken(metadata.clientType)
    ? buildTokensWithExistingRefreshToken(user, session, refreshToken)
    : await buildTokensForSession(user, session.sessionId, metadata.clientType);

  await persistSession(session, metadata, tokens.refreshToken, tokens.refreshExpiresAt);

  return {
    user,
    session,
    tokens
  };
}

async function resolveUserFromSessionToken(sessionToken) {
  try {
    const { user, session } = await loadValidatedSession(sessionToken, null);
    return { user, session };
  } catch (_error) {
    return { user: null, session: null };
  }
}

async function assertSessionActive(userId, sessionId) {
  const normalizedSessionId = trimString(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const session = await UserSession.findOne({
    userId,
    sessionId: normalizedSessionId
  }).exec();

  if (!session || session.revokedAt) {
    throw buildSessionError('Session has been revoked', 401);
  }

  if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) {
    throw buildSessionError('Session has expired', 401);
  }

  return session;
}

async function listSessionsForUser(userId, currentSessionId = '') {
  const sessions = await UserSession.find({
    userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() }
  })
    .sort({ lastUsedAt: -1, createdAt: -1 })
    .exec();

  return sessions.map((session) => toSanitizedSession(session, currentSessionId));
}

async function revokeSessionById(userId, sessionId, reason = 'revoked-by-user') {
  const session = await UserSession.findOne({
    userId,
    sessionId: trimString(sessionId)
  }).exec();

  if (!session) {
    return null;
  }

  if (!session.revokedAt) {
    session.revokedAt = new Date();
    session.revokeReason = trimString(reason, 'revoked');
    await session.save();
  }

  return session;
}

async function revokeSessionByRefreshToken(refreshToken, userId = null, reason = 'logout') {
  const normalizedToken = trimString(refreshToken);
  if (!normalizedToken || !process.env.REFRESH_TOKEN_SECRET) {
    return null;
  }

  let decoded = null;
  try {
    decoded = jwt.verify(normalizedToken, process.env.REFRESH_TOKEN_SECRET, {
      ignoreExpiration: true
    });
  } catch (_error) {
    return null;
  }

  const sessionId = trimString(decoded?.sid);
  if (sessionId) {
    const query = {
      sessionId
    };

    if (userId) {
      query.userId = userId;
    }

    const session = await UserSession.findOne(query).exec();
    if (!session) {
      return null;
    }

    if (!session.revokedAt) {
      session.revokedAt = new Date();
      session.revokeReason = trimString(reason, 'revoked');
      await session.save();
    }

    return session;
  }

  if (!userId) {
    return null;
  }

  const user = await UserService.get(userId);
  if (user && user.refreshToken === normalizedToken) {
    user.refreshToken = null;
    await user.save();
  }

  return null;
}

function getSessionIdFromAccessToken(token) {
  const decoded = jwt.decode(trimString(token));
  return trimString(decoded?.sid);
}

module.exports = {
  DEFAULT_SESSION_MAX_AGE_DAYS,
  DEFAULT_IOS_SESSION_MAX_AGE_DAYS,
  MIN_SESSION_MAX_AGE_DAYS,
  MAX_SESSION_MAX_AGE_DAYS,
  extractSessionMetadata,
  getSessionLifetimeDays,
  issueSession,
  refreshSession,
  loadValidatedSession,
  resolveUserFromSessionToken,
  assertSessionActive,
  listSessionsForUser,
  revokeSessionById,
  revokeSessionByRefreshToken,
  getSessionIdFromAccessToken
};

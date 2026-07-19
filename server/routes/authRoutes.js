const express = require('express');
const rateLimit = require('express-rate-limit');
const UserService = require('../services/userService.js');
const authSessionService = require('../services/authSessionService.js');
const accountDeletionService = require('../services/accountDeletionService.js');
const { requireUser, extractToken, verifyAccessToken } = require('./middlewares/auth.js');
const User = require('../models/User.js');
const { ALL_ROLES, ROLES } = require('../../shared/config/roles.js');
const oidcService = require('../services/oidcService');
const { getAxiomPublicOrigin } = require('../utils/platformUrls');
const { USER_PLATFORMS, hasPlatformAccess } = require('../utils/userPlatforms');
const {
  SESSION_TOKEN_COOKIE_NAME,
  clearAuthCookies,
  getCookieValue,
  setAuthCookies
} = require('../utils/authCookies');

const router = express.Router();
const { ipKeyGenerator } = rateLimit;
const TOKEN_JSON_CLIENT_TYPES = new Set(['ios', 'android', 'desktop', 'api', 'watchos']);

function rateLimitIpKey(req) {
  return typeof ipKeyGenerator === 'function'
    ? ipKeyGenerator(req.ip)
    : (req.ip || req.socket?.remoteAddress || 'unknown');
}

function buildEmailAwareRateLimitKey(req = {}) {
  const email = trimString(req.body?.email).toLowerCase();
  return `${rateLimitIpKey(req)}:${email || 'unknown-email'}`;
}

function buildClientRateLimitKey(req = {}) {
  return `${rateLimitIpKey(req)}:${getRequestClientType(req)}`;
}

const loginRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000)),
  limit: Math.max(5, Number(process.env.HOMEBRAIN_LOGIN_RATE_LIMIT_MAX || 25)),
  keyGenerator: buildEmailAwareRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please retry shortly.'
  }
});

const registrationRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_REGISTER_RATE_LIMIT_WINDOW_MS || 60 * 60 * 1000)),
  limit: Math.max(2, Number(process.env.HOMEBRAIN_REGISTER_RATE_LIMIT_MAX || 10)),
  keyGenerator: rateLimitIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many registration attempts. Please retry shortly.'
  }
});

const refreshRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_REFRESH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000)),
  limit: Math.max(30, Number(process.env.HOMEBRAIN_REFRESH_RATE_LIMIT_MAX || 240)),
  keyGenerator: buildClientRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many token refresh attempts. Please retry shortly.'
  }
});

const oidcExchangeRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_OIDC_EXCHANGE_RATE_LIMIT_WINDOW_MS || 5 * 60 * 1000)),
  limit: Math.max(10, Number(process.env.HOMEBRAIN_OIDC_EXCHANGE_RATE_LIMIT_MAX || 60)),
  keyGenerator: buildClientRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many OIDC exchange attempts. Please retry shortly.'
  }
});

const accountDeletionRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_ACCOUNT_DELETE_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000)),
  limit: Math.max(3, Number(process.env.HOMEBRAIN_ACCOUNT_DELETE_RATE_LIMIT_MAX || 5)),
  keyGenerator: rateLimitIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many account deletion attempts. Please retry shortly.'
  }
});

function trimString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function isBrowserLikeRequest(req = {}) {
  return Boolean(req.headers?.origin || req.headers?.['sec-fetch-site']);
}

function getRequestClientType(req = {}) {
  const requestedClientType = trimString(req.headers?.['x-homebrain-client-type'], 'unknown').toLowerCase();
  if (isBrowserLikeRequest(req) && requestedClientType !== 'web') {
    return 'web';
  }
  return requestedClientType;
}

function shouldReturnTokenJson(req = {}) {
  return TOKEN_JSON_CLIENT_TYPES.has(getRequestClientType(req)) && !isBrowserLikeRequest(req);
}

function buildAuthenticatedUserPayload(user, req, tokens = {}) {
  const serializedUser = typeof user?.toJSON === 'function'
    ? user.toJSON()
    : (typeof user?.toObject === 'function' ? user.toObject() : { ...user });

  const defaultRedirectUrl = !hasPlatformAccess(serializedUser, USER_PLATFORMS.HOMEBRAIN)
    && hasPlatformAccess(serializedUser, USER_PLATFORMS.AXIOM)
    ? getAxiomPublicOrigin(req)
    : null;

  return {
    ...serializedUser,
    defaultRedirectUrl,
    ...tokens
  };
}

function buildAuthResponse(user, req, tokens = {}) {
  return buildAuthenticatedUserPayload(
    user,
    req,
    shouldReturnTokenJson(req) ? tokens : {}
  );
}

function getRefreshTokenFromRequest(req) {
  return getCookieValue(req, SESSION_TOKEN_COOKIE_NAME)
    || (shouldReturnTokenJson(req) ? trimString(req.body?.refreshToken) : '');
}

router.post('/login', loginRateLimit, async (req, res) => {
  const sendError = msg => res.status(400).json({ message: msg });
  const { email, password } = req.body;

  if (!email || !password) {
    return sendError('Email and password are required');
  }

  let user = null;

  try {
    user = await UserService.authenticateWithPassword(email, password);
  } catch (error) {
    const statusCode = error.status || (error.message === 'User account is inactive' ? 403 : 500);
    return res.status(statusCode).json({ message: error.message || 'Login failed' });
  }

  if (user) {
    try {
      const sessionIssue = await authSessionService.issueSession(user, req);
      setAuthCookies(
        res,
        sessionIssue.tokens.accessToken,
        sessionIssue.tokens.refreshToken,
        {
          req,
          sessionTokenMaxAge: sessionIssue.tokens.refreshMaxAgeMs
        }
      );

      return res.json(buildAuthResponse(user, req, {
        accessToken: sessionIssue.tokens.accessToken,
        refreshToken: sessionIssue.tokens.refreshToken
      }));
    } catch (error) {
      console.error(`Error while issuing login session: ${error.message}`);
      return res.status(500).json({ message: 'Login failed' });
    }
  } else {
    return sendError('Email or password is incorrect');

  }
});

router.post('/oidc/exchange', oidcExchangeRateLimit, async (req, res) => {
  try {
    const decoded = await oidcService.verifyIssuedAccessToken(req);
    const user = await UserService.get(decoded.sub);

    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: 'User account is inactive' });
    }

    const sessionIssue = await authSessionService.issueSession(user, req);
    return res.status(200).json({
      accessToken: sessionIssue.tokens.accessToken
    });
  } catch (error) {
    return res.status(error.status || 401).json({
      message: error.description || error.message || 'OIDC token exchange failed'
    });
  }
});

router.post('/register', registrationRateLimit, async (req, res, next) => {
  try {
    const registrationOpen = await UserService.canPublicRegister();
    if (!registrationOpen) {
      return res.status(403).json({
        message: 'Public registration is closed. Ask an admin to create your account.'
      });
    }

    const user = await UserService.create({
      ...req.body,
      role: ROLES.ADMIN
    });

    const sessionIssue = await authSessionService.issueSession(user, req);
    setAuthCookies(
      res,
      sessionIssue.tokens.accessToken,
      sessionIssue.tokens.refreshToken,
      {
        req,
        sessionTokenMaxAge: sessionIssue.tokens.refreshMaxAgeMs
      }
    );

    return res.status(200).json(buildAuthResponse(user, req, {
      accessToken: sessionIssue.tokens.accessToken,
      refreshToken: sessionIssue.tokens.refreshToken
    }));
  } catch (error) {
    console.error(`Error while registering user: ${error}`);
    return res.status(400).json({ message: error.message || 'Registration failed' });
  }
});

router.post('/logout', async (req, res) => {
  const email = trimString(req.body?.email);
  const explicitRefreshToken = req.body?.refreshToken || getCookieValue(req, SESSION_TOKEN_COOKIE_NAME);

  let user = null;
  let currentSessionId = '';
  const accessToken = extractToken(req);
  if (accessToken) {
    try {
      user = await verifyAccessToken(accessToken, ALL_ROLES, req, { platform: null });
      currentSessionId = authSessionService.getSessionIdFromAccessToken(accessToken);
    } catch (_error) {
      user = null;
    }
  }

  if (!user && explicitRefreshToken) {
    const resolved = await authSessionService.resolveUserFromSessionToken(explicitRefreshToken);
    user = resolved.user;
  }

  if (!user && email) {
    user = await User.findOne({ email });
  }

  if (user && currentSessionId) {
    await authSessionService.revokeSessionById(user._id, currentSessionId, 'logout');
  } else if (explicitRefreshToken) {
    await authSessionService.revokeSessionByRefreshToken(
      explicitRefreshToken,
      user?._id || null,
      'logout'
    );
  } else if (user) {
    user.refreshToken = null;
    await user.save();
  }

  clearAuthCookies(res, { req });

  res.status(200).json({ message: 'User logged out successfully.' });
});

router.post('/refresh', refreshRateLimit, async (req, res) => {
  const refreshToken = getRefreshTokenFromRequest(req);

  console.log('Refresh token request received');

  if (!refreshToken) {
    console.log('No refresh token provided in request');
    clearAuthCookies(res, { req });
    return res.status(401).json({
      success: false,
      message: 'Refresh token is required'
    });
  }

  try {
    const sessionIssue = await authSessionService.refreshSession(refreshToken, req);
    setAuthCookies(
      res,
      sessionIssue.tokens.accessToken,
      sessionIssue.tokens.refreshToken,
      {
        req,
        sessionTokenMaxAge: sessionIssue.tokens.refreshMaxAgeMs
      }
    );

    console.log('Token refresh successful');
    return res.status(200).json({
      success: true,
      data: {
        ...buildAuthResponse(sessionIssue.user, req, {
          accessToken: sessionIssue.tokens.accessToken,
          refreshToken: sessionIssue.tokens.refreshToken
        })
      }
    });
  } catch (error) {
    console.error(`Token refresh error: ${error.message}`);
    console.error('Full error details:', error);

    if ((error.status || 500) < 500) {
      clearAuthCookies(res, { req });
    }

    return res.status(error.status || 403).json({
      success: false,
      message: error.message || 'Invalid refresh token'
    });
  }
});

router.get('/me', requireUser(ALL_ROLES, { platform: null }), async (req, res) => {
  return res.status(200).json(buildAuthenticatedUserPayload(req.user, req));
});

router.delete('/account', accountDeletionRateLimit, requireUser(ALL_ROLES, {
  platform: null,
  allowReadOnlyMutation: true
}), async (req, res) => {
  try {
    await accountDeletionService.deleteAccount(req.user._id, req.body?.password);
    clearAuthCookies(res, { req });

    return res.status(200).json({
      success: true,
      message: 'Your HomeBrain account and associated personal data were deleted.'
    });
  } catch (error) {
    console.error(`DELETE /api/auth/account - Error: ${error.message}`);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to delete account'
    });
  }
});

router.get('/sessions', requireUser(ALL_ROLES, { platform: null }), async (req, res) => {
  try {
    const currentSessionId = authSessionService.getSessionIdFromAccessToken(extractToken(req));
    const sessions = await authSessionService.listSessionsForUser(req.user._id, currentSessionId);
    const sessionMetadata = authSessionService.extractSessionMetadata(req);
    const lifetimeDays = await authSessionService.getSessionLifetimeDays(sessionMetadata.clientType);

    return res.status(200).json({
      success: true,
      currentSessionId,
      lifetimeDays,
      sessions
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to list sessions'
    });
  }
});

router.delete('/sessions/:sessionId', requireUser(ALL_ROLES, { platform: null }), async (req, res) => {
  try {
    const session = await authSessionService.revokeSessionById(
      req.user._id,
      req.params.sessionId,
      'revoked-by-user'
    );

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    const currentSessionId = authSessionService.getSessionIdFromAccessToken(extractToken(req));
    const signedOutCurrentSession = currentSessionId === session.sessionId;

    if (signedOutCurrentSession) {
      clearAuthCookies(res, { req });
    }

    return res.status(200).json({
      success: true,
      signedOutCurrentSession,
      message: signedOutCurrentSession
        ? 'Current session revoked and signed out.'
        : 'Session revoked successfully.'
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to revoke session'
    });
  }
});

router.get('/registration-status', async (_req, res) => {
  try {
    const userCount = await UserService.countUsers();
    const activeAdminCount = await UserService.countActiveAdmins();

    return res.status(200).json({
      registrationOpen: userCount === 0,
      userCount,
      hasActiveAdmin: activeAdminCount > 0
    });
  } catch (error) {
    console.error(`Error while getting registration status: ${error}`);
    return res.status(500).json({
      message: 'Failed to get registration status'
    });
  }
});

module.exports = router;

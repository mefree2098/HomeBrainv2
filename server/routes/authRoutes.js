const express = require('express');
const UserService = require('../services/userService.js');
const authSessionService = require('../services/authSessionService.js');
const { requireUser, extractToken, verifyAccessToken } = require('./middlewares/auth.js');
const User = require('../models/User.js');
const { generateAccessToken } = require('../utils/auth.js');
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

function buildAuthResponse(user, req, sessionIssue) {
  return buildAuthenticatedUserPayload(user, req, {
    accessToken: sessionIssue.tokens.accessToken,
    refreshToken: sessionIssue.tokens.refreshToken
  });
}

router.post('/login', async (req, res) => {
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
          sessionTokenMaxAge: sessionIssue.tokens.refreshMaxAgeMs
        }
      );

      return res.json(buildAuthResponse(user, req, sessionIssue));
    } catch (error) {
      console.error(`Error while issuing login session: ${error.message}`);
      return res.status(500).json({ message: 'Login failed' });
    }
  } else {
    return sendError('Email or password is incorrect');

  }
});

router.post('/oidc/exchange', async (req, res) => {
  try {
    const decoded = await oidcService.verifyIssuedAccessToken(req);
    const user = await UserService.get(decoded.sub);

    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (!user.isActive) {
      return res.status(403).json({ message: 'User account is inactive' });
    }

    return res.status(200).json({
      accessToken: generateAccessToken(user)
    });
  } catch (error) {
    return res.status(error.status || 401).json({
      message: error.description || error.message || 'OIDC token exchange failed'
    });
  }
});

router.post('/register', async (req, res, next) => {
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
        sessionTokenMaxAge: sessionIssue.tokens.refreshMaxAgeMs
      }
    );

    return res.status(200).json(buildAuthResponse(user, req, sessionIssue));
  } catch (error) {
    console.error(`Error while registering user: ${error}`);
    return res.status(400).json({ message: error.message || 'Registration failed' });
  }
});

router.post('/logout', async (req, res) => {
  const { email } = req.body || {};
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

  clearAuthCookies(res);

  res.status(200).json({ message: 'User logged out successfully.' });
});

router.post('/refresh', async (req, res) => {
  const refreshToken = req.body?.refreshToken || getCookieValue(req, SESSION_TOKEN_COOKIE_NAME);

  console.log('Refresh token request received');

  if (!refreshToken) {
    console.log('No refresh token provided in request');
    clearAuthCookies(res);
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
        sessionTokenMaxAge: sessionIssue.tokens.refreshMaxAgeMs
      }
    );

    console.log('Token refresh successful');
    return res.status(200).json({
      success: true,
      data: {
        ...buildAuthResponse(sessionIssue.user, req, sessionIssue)
      }
    });
  } catch (error) {
    console.error(`Token refresh error: ${error.message}`);
    console.error('Full error details:', error);

    if ((error.status || 500) < 500) {
      clearAuthCookies(res);
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

router.get('/sessions', requireUser(ALL_ROLES, { platform: null }), async (req, res) => {
  try {
    const currentSessionId = authSessionService.getSessionIdFromAccessToken(extractToken(req));
    const sessions = await authSessionService.listSessionsForUser(req.user._id, currentSessionId);
    const lifetimeDays = await authSessionService.getSessionLifetimeDays();

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
      clearAuthCookies(res);
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

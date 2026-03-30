const express = require('express');
const UserService = require('../services/userService.js');
const { requireUser, extractToken, verifyAccessToken } = require('./middlewares/auth.js');
const User = require('../models/User.js');
const { generateAccessToken, generateRefreshToken } = require('../utils/auth.js');
const jwt = require('jsonwebtoken');
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
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    user.refreshToken = refreshToken;
    await user.save();
    setAuthCookies(res, accessToken, refreshToken);
    return res.json(buildAuthenticatedUserPayload(user, req, {
      accessToken,
      refreshToken
    }));
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

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    user.refreshToken = refreshToken;
    await user.save();
    setAuthCookies(res, accessToken, refreshToken);

    return res.status(200).json(buildAuthenticatedUserPayload(user, req, {
      accessToken,
      refreshToken
    }));
  } catch (error) {
    console.error(`Error while registering user: ${error}`);
    return res.status(400).json({ message: error.message || 'Registration failed' });
  }
});

router.post('/logout', async (req, res) => {
  const { email } = req.body || {};

  let user = null;
  const accessToken = extractToken(req);
  if (accessToken) {
    try {
      user = await verifyAccessToken(accessToken, ALL_ROLES);
    } catch (_error) {
      user = null;
    }
  }

  if (!user) {
    const sessionToken = getCookieValue(req, SESSION_TOKEN_COOKIE_NAME);
    user = await oidcService.getUserFromSessionToken(sessionToken);
  }

  if (!user && email) {
    user = await User.findOne({ email });
  }

  if (user) {
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
    console.log('Attempting to verify refresh token');
    
    if (!process.env.REFRESH_TOKEN_SECRET) {
      console.error('REFRESH_TOKEN_SECRET environment variable is not set');
      clearAuthCookies(res);
      return res.status(500).json({
        success: false,
        message: 'Server configuration error'
      });
    }
    
    // Verify the refresh token
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);

    // Find the user
    console.log(`Looking up user with ID: ${decoded.sub}`);
    const user = await UserService.get(decoded.sub);

    if (!user) {
      console.log('User not found in database');
      clearAuthCookies(res);
      return res.status(403).json({
        success: false,
        message: 'User not found'
      });
    }

    console.log('User found, comparing refresh tokens');
    if (user.refreshToken !== refreshToken) {
      console.log('Refresh token mismatch - stored token does not match provided token');
      clearAuthCookies(res);
      return res.status(403).json({
        success: false,
        message: 'Invalid refresh token'
      });
    }

    // Generate new tokens
    console.log('Generating new tokens');
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    // Update user's refresh token in database
    console.log('Updating user refresh token in database');
    user.refreshToken = newRefreshToken;
    await user.save();
    setAuthCookies(res, newAccessToken, newRefreshToken);

    console.log('Token refresh successful');
    // Return new tokens
    return res.status(200).json({
      success: true,
      data: {
        ...buildAuthenticatedUserPayload(user, req),
        accessToken: newAccessToken,
        refreshToken: newRefreshToken
      }
    });

  } catch (error) {
    console.error(`Token refresh error: ${error.message}`);
    console.error('Full error details:', error);

    if (error.name === 'TokenExpiredError') {
      clearAuthCookies(res);
      return res.status(403).json({
        success: false,
        message: 'Refresh token has expired'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      console.error('JWT verification failed - possible signature mismatch');
      clearAuthCookies(res);
      return res.status(403).json({
        success: false,
        message: 'Invalid refresh token signature'
      });
    }

    clearAuthCookies(res);
    return res.status(403).json({
      success: false,
      message: 'Invalid refresh token'
    });
  }
});

router.get('/me', requireUser(ALL_ROLES, { platform: null }), async (req, res) => {
  return res.status(200).json(buildAuthenticatedUserPayload(req.user, req));
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

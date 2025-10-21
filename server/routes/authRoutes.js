const express = require('express');
const UserService = require('../services/userService.js');
const { requireUser } = require('./middlewares/auth.js');
const User = require('../models/User.js');
const { generateAccessToken, generateRefreshToken } = require('../utils/auth.js');
const jwt = require('jsonwebtoken');
const { ALL_ROLES } = require('../../shared/config/roles.js');

const router = express.Router();

const ACCESS_TOKEN_COOKIE_NAME = 'hbAccessToken';
const SECURE_COOKIE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const ACCESS_TOKEN_COOKIE_MAX_AGE = Number(process.env.ACCESS_TOKEN_COOKIE_MAX_AGE || 60 * 60 * 1000);

router.post('/login', async (req, res) => {
  const sendError = msg => res.status(400).json({ message: msg });
  const { email, password } = req.body;

  if (!email || !password) {
    return sendError('Email and password are required');
  }

  const user = await UserService.authenticateWithPassword(email, password);

  if (user) {
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    user.refreshToken = refreshToken;
    await user.save();
    res.cookie(ACCESS_TOKEN_COOKIE_NAME, accessToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: SECURE_COOKIE,
      maxAge: ACCESS_TOKEN_COOKIE_MAX_AGE
    });
    return res.json({...user.toObject(), accessToken, refreshToken});
  } else {
    return sendError('Email or password is incorrect');

  }
});

router.post('/register', async (req, res, next) => {
  if (req.user) {
    return res.json({ user: req.user });
  }
  try {
    const user = await UserService.create(req.body);
    return res.status(200).json(user);
  } catch (error) {
    console.error(`Error while registering user: ${error}`);
    return res.status(400).json({ error });
  }
});

router.post('/logout', async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ email });
  if (user) {
    user.refreshToken = null;
    await user.save();
  }

  res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure: SECURE_COOKIE
  });

  res.status(200).json({ message: 'User logged out successfully.' });
});

router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  console.log('Refresh token request received');

  if (!refreshToken) {
    console.log('No refresh token provided in request');
    return res.status(401).json({
      success: false,
      message: 'Refresh token is required'
    });
  }

  try {
    console.log('Attempting to verify refresh token');
    
    if (!process.env.REFRESH_TOKEN_SECRET) {
      console.error('REFRESH_TOKEN_SECRET environment variable is not set');
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
      return res.status(403).json({
        success: false,
        message: 'User not found'
      });
    }

    console.log('User found, comparing refresh tokens');
    if (user.refreshToken !== refreshToken) {
      console.log('Refresh token mismatch - stored token does not match provided token');
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

    console.log('Token refresh successful');
    // Return new tokens
    return res.status(200).json({
      success: true,
      data: {
        ...user.toObject(),
        accessToken: newAccessToken,
        refreshToken: newRefreshToken
      }
    });

  } catch (error) {
    console.error(`Token refresh error: ${error.message}`);
    console.error('Full error details:', error);

    if (error.name === 'TokenExpiredError') {
      return res.status(403).json({
        success: false,
        message: 'Refresh token has expired'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      console.error('JWT verification failed - possible signature mismatch');
      return res.status(403).json({
        success: false,
        message: 'Invalid refresh token signature'
      });
    }

    return res.status(403).json({
      success: false,
      message: 'Invalid refresh token'
    });
  }
});

router.get('/me', requireUser(ALL_ROLES), async (req, res) => {
  return res.status(200).json(req.user);
});

module.exports = router;

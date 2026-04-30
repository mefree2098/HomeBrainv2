const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const watchService = require('../services/watchService');
const authSessionService = require('../services/authSessionService');
const { requireUser } = require('./middlewares/auth');

const watchRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_WATCH_RATE_LIMIT_WINDOW_MS || 60_000)),
  limit: Math.max(20, Number(process.env.HOMEBRAIN_WATCH_RATE_LIMIT_MAX || 180)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many watch requests. Please retry shortly.'
  }
});

router.use(watchRateLimit, requireUser());

function trimString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function currentUserId(req) {
  return req.user?._id || req.user?.id;
}

router.get('/config', async (req, res) => {
  try {
    const data = await watchService.getConfig(currentUserId(req));
    return res.status(200).json({
      success: true,
      ...data
    });
  } catch (error) {
    console.error('GET /api/watch/config - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to load watch configuration'
    });
  }
});

router.put('/config', async (req, res) => {
  try {
    const data = await watchService.updateConfig(currentUserId(req), req.body || {});
    return res.status(200).json({
      success: true,
      message: 'Watch configuration updated successfully',
      ...data
    });
  } catch (error) {
    console.error('PUT /api/watch/config - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to update watch configuration'
    });
  }
});

router.post('/session', async (req, res) => {
  try {
    const watchDeviceId = trimString(req.body?.watchDeviceId)
      || `watch-${currentUserId(req)}`;
    const watchName = trimString(req.body?.watchName, 'Apple Watch');
    const sessionReq = {
      ...req,
      headers: {
        ...(req.headers || {}),
        'x-homebrain-client-type': 'watchos',
        'x-homebrain-client-name': watchName,
        'x-homebrain-device-id': watchDeviceId
      }
    };
    const sessionIssue = await authSessionService.issueSession(req.user, sessionReq);

    return res.status(200).json({
      success: true,
      tokens: {
        accessToken: sessionIssue.tokens.accessToken,
        refreshToken: sessionIssue.tokens.refreshToken
      },
      refreshExpiresAt: sessionIssue.tokens.refreshExpiresAt,
      session: sessionIssue.session.toSanitized()
    });
  } catch (error) {
    console.error('POST /api/watch/session - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to create watch session'
    });
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    const dashboard = await watchService.getDashboard(currentUserId(req));
    return res.status(200).json({
      success: true,
      dashboard
    });
  } catch (error) {
    console.error('GET /api/watch/dashboard - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to load watch dashboard'
    });
  }
});

router.post('/security', async (req, res) => {
  try {
    const security = await watchService.controlSecurity(currentUserId(req), req.body?.action);
    return res.status(200).json({
      success: true,
      security
    });
  } catch (error) {
    console.error('POST /api/watch/security - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to control security from watch'
    });
  }
});

router.post('/lights', async (req, res) => {
  try {
    const result = await watchService.controlLights(currentUserId(req), req.body || {});
    return res.status(200).json({
      success: !result.partialFailure,
      ...result
    });
  } catch (error) {
    console.error('POST /api/watch/lights - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to control watch lights'
    });
  }
});

module.exports = router;

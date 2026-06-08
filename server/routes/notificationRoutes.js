const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireUser } = require('./middlewares/auth');
const notificationService = require('../services/notificationService');

const router = express.Router();
const auth = requireUser();

const notificationRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_NOTIFICATION_RATE_LIMIT_WINDOW_MS || 60_000)),
  limit: Math.max(30, Number(process.env.HOMEBRAIN_NOTIFICATION_RATE_LIMIT_MAX || 600)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many notification requests. Please retry shortly.'
  }
});

const pushRegistrationRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_PUSH_REGISTRATION_RATE_LIMIT_WINDOW_MS || 60_000)),
  limit: Math.max(10, Number(process.env.HOMEBRAIN_PUSH_REGISTRATION_RATE_LIMIT_MAX || 120)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many push registration requests. Please retry shortly.'
  }
});

function getUserId(req) {
  return req.user?._id || req.user?.id;
}

function sendError(res, error, fallbackMessage) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  res.status(status).json({
    success: false,
    message: error?.message || fallbackMessage
  });
}

router.use(notificationRateLimit, auth);

router.get('/', async (req, res) => {
  try {
    const notifications = await notificationService.listNotifications(getUserId(req), {
      channel: req.query.channel,
      includeCleared: req.query.includeCleared,
      limit: req.query.limit
    });
    const counts = await notificationService.getUnreadCounts(getUserId(req));
    res.status(200).json({
      success: true,
      notifications,
      counts
    });
  } catch (error) {
    console.error('GET /api/notifications - Error:', error.message);
    sendError(res, error, 'Failed to fetch notifications');
  }
});

router.delete('/', async (req, res) => {
  try {
    const result = await notificationService.clearNotifications(getUserId(req), {
      channel: req.query.channel || req.body?.channel
    });
    const counts = await notificationService.getUnreadCounts(getUserId(req));
    res.status(200).json({
      success: true,
      ...result,
      counts
    });
  } catch (error) {
    console.error('DELETE /api/notifications - Error:', error.message);
    sendError(res, error, 'Failed to clear notifications');
  }
});

router.post('/clear', async (req, res) => {
  try {
    const result = await notificationService.clearNotifications(getUserId(req), {
      channel: req.body?.channel
    });
    const counts = await notificationService.getUnreadCounts(getUserId(req));
    res.status(200).json({
      success: true,
      ...result,
      counts
    });
  } catch (error) {
    console.error('POST /api/notifications/clear - Error:', error.message);
    sendError(res, error, 'Failed to clear notifications');
  }
});

router.delete('/:notificationId', async (req, res) => {
  try {
    const notification = await notificationService.clearNotification(getUserId(req), req.params.notificationId);
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }
    const counts = await notificationService.getUnreadCounts(getUserId(req));
    return res.status(200).json({
      success: true,
      notification,
      counts
    });
  } catch (error) {
    console.error('DELETE /api/notifications/:notificationId - Error:', error.message);
    return sendError(res, error, 'Failed to clear notification');
  }
});

router.post('/:notificationId/clear', async (req, res) => {
  try {
    const notification = await notificationService.clearNotification(getUserId(req), req.params.notificationId);
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }
    const counts = await notificationService.getUnreadCounts(getUserId(req));
    return res.status(200).json({
      success: true,
      notification,
      counts
    });
  } catch (error) {
    console.error('POST /api/notifications/:notificationId/clear - Error:', error.message);
    return sendError(res, error, 'Failed to clear notification');
  }
});

router.get('/push/status', async (_req, res) => {
  try {
    res.status(200).json({
      success: true,
      apns: notificationService.getPushStatus()
    });
  } catch (error) {
    console.error('GET /api/notifications/push/status - Error:', error.message);
    sendError(res, error, 'Failed to fetch push status');
  }
});

router.post('/push/devices', pushRegistrationRateLimit, async (req, res) => {
  try {
    const subscription = await notificationService.registerPushDevice(getUserId(req), req.body || {});
    res.status(200).json({
      success: true,
      subscription,
      apns: notificationService.getPushStatus()
    });
  } catch (error) {
    console.error('POST /api/notifications/push/devices - Error:', error.message);
    sendError(res, error, 'Failed to register push device');
  }
});

router.delete('/push/devices/:installationId', async (req, res) => {
  try {
    const result = await notificationService.unregisterPushDevice(getUserId(req), req.params.installationId);
    res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('DELETE /api/notifications/push/devices/:installationId - Error:', error.message);
    sendError(res, error, 'Failed to unregister push device');
  }
});

module.exports = router;

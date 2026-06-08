const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireUser, requireAdmin } = require('./middlewares/auth');
const notificationService = require('../services/notificationService');
const remoteHomeBrainNotificationService = require('../services/remoteHomeBrainNotificationService');

const router = express.Router();
const auth = requireUser();
const admin = requireAdmin();

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

const remoteHomeBrainRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_REMOTE_NOTIFICATION_RATE_LIMIT_WINDOW_MS || 60_000)),
  limit: Math.max(5, Number(process.env.HOMEBRAIN_REMOTE_NOTIFICATION_RATE_LIMIT_MAX || 120)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many remote HomeBrain notification requests. Please retry shortly.'
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

router.post('/remote-homebrains/handshake', remoteHomeBrainRateLimit, async (req, res) => {
  try {
    const remote = await remoteHomeBrainNotificationService.authenticateInboundRequest(req);
    const publicRemote = await remoteHomeBrainNotificationService.recordInboundHandshake(remote, req.body || {});
    res.status(200).json({
      success: true,
      message: `Connected to ${publicRemote.name}`,
      remote: publicRemote
    });
  } catch (error) {
    console.error('POST /api/notifications/remote-homebrains/handshake - Error:', error.message);
    sendError(res, error, 'Failed to verify remote HomeBrain connection');
  }
});

router.post('/remote-homebrains/alerts', remoteHomeBrainRateLimit, async (req, res) => {
  try {
    const remote = await remoteHomeBrainNotificationService.authenticateInboundRequest(req);
    const result = await remoteHomeBrainNotificationService.receiveSecurityAlert(remote, req.body || {});
    res.status(202).json({
      success: true,
      remote: result.remote,
      notificationCount: result.notifications?.length || 0
    });
  } catch (error) {
    console.error('POST /api/notifications/remote-homebrains/alerts - Error:', error.message);
    sendError(res, error, 'Failed to receive remote HomeBrain alert');
  }
});

router.use(notificationRateLimit, auth);

router.get('/', async (req, res) => {
  try {
    const notifications = await notificationService.listNotifications(getUserId(req), {
      channel: req.query.channel,
      includeCleared: req.query.includeCleared,
      includeResolved: req.query.includeResolved,
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

router.get('/remote-homebrains', admin, async (_req, res) => {
  try {
    const remotes = await remoteHomeBrainNotificationService.listRemoteHomeBrains();
    res.status(200).json({
      success: true,
      ...remotes
    });
  } catch (error) {
    console.error('GET /api/notifications/remote-homebrains - Error:', error.message);
    sendError(res, error, 'Failed to fetch remote HomeBrain settings');
  }
});

router.post('/remote-homebrains/inbound', admin, async (req, res) => {
  try {
    const result = await remoteHomeBrainNotificationService.createInboundRemote(req.body || {});
    res.status(201).json({
      success: true,
      remote: result.remote,
      token: result.token
    });
  } catch (error) {
    console.error('POST /api/notifications/remote-homebrains/inbound - Error:', error.message);
    sendError(res, error, 'Failed to add inbound remote HomeBrain');
  }
});

router.patch('/remote-homebrains/inbound/:remoteId', admin, async (req, res) => {
  try {
    const remote = await remoteHomeBrainNotificationService.updateInboundRemote(req.params.remoteId, req.body || {});
    res.status(200).json({
      success: true,
      remote
    });
  } catch (error) {
    console.error('PATCH /api/notifications/remote-homebrains/inbound/:remoteId - Error:', error.message);
    sendError(res, error, 'Failed to update inbound remote HomeBrain');
  }
});

router.post('/remote-homebrains/inbound/:remoteId/rotate-token', admin, async (req, res) => {
  try {
    const result = await remoteHomeBrainNotificationService.rotateInboundToken(req.params.remoteId);
    res.status(200).json({
      success: true,
      remote: result.remote,
      token: result.token
    });
  } catch (error) {
    console.error('POST /api/notifications/remote-homebrains/inbound/:remoteId/rotate-token - Error:', error.message);
    sendError(res, error, 'Failed to rotate remote HomeBrain token');
  }
});

router.delete('/remote-homebrains/inbound/:remoteId', admin, async (req, res) => {
  try {
    const result = await remoteHomeBrainNotificationService.deleteInboundRemote(req.params.remoteId);
    res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('DELETE /api/notifications/remote-homebrains/inbound/:remoteId - Error:', error.message);
    sendError(res, error, 'Failed to delete inbound remote HomeBrain');
  }
});

router.post('/remote-homebrains/outbound', admin, async (req, res) => {
  try {
    const target = await remoteHomeBrainNotificationService.createOutboundTarget(req.body || {});
    res.status(201).json({
      success: true,
      target
    });
  } catch (error) {
    console.error('POST /api/notifications/remote-homebrains/outbound - Error:', error.message);
    sendError(res, error, 'Failed to add outbound remote HomeBrain');
  }
});

router.patch('/remote-homebrains/outbound/:targetId', admin, async (req, res) => {
  try {
    const target = await remoteHomeBrainNotificationService.updateOutboundTarget(req.params.targetId, req.body || {});
    res.status(200).json({
      success: true,
      target
    });
  } catch (error) {
    console.error('PATCH /api/notifications/remote-homebrains/outbound/:targetId - Error:', error.message);
    sendError(res, error, 'Failed to update outbound remote HomeBrain');
  }
});

router.post('/remote-homebrains/outbound/:targetId/test', admin, async (req, res) => {
  try {
    const result = await remoteHomeBrainNotificationService.testOutboundTarget(req.params.targetId);
    res.status(200).json(result);
  } catch (error) {
    console.error('POST /api/notifications/remote-homebrains/outbound/:targetId/test - Error:', error.message);
    sendError(res, error, 'Failed to test remote HomeBrain connection');
  }
});

router.delete('/remote-homebrains/outbound/:targetId', admin, async (req, res) => {
  try {
    const result = await remoteHomeBrainNotificationService.deleteOutboundTarget(req.params.targetId);
    res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('DELETE /api/notifications/remote-homebrains/outbound/:targetId - Error:', error.message);
    sendError(res, error, 'Failed to delete outbound remote HomeBrain');
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
    sendError(res, error, 'Failed to clear notification');
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
    sendError(res, error, 'Failed to clear notification');
  }
});

router.get('/push/status', (_req, res) => {
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

const express = require('express');
const rateLimit = require('express-rate-limit');

const { requireAdmin } = require('./middlewares/auth');
const { getRequestOrigin } = require('../utils/publicOrigin');

function createSensorNodeRouter(sensorNodeService = require('../services/sensorNodeService')) {
  const router = express.Router();
  const admin = [requireAdmin(), (req, res, next) => req.user.isReviewSandbox
    ? res.status(403).json({ success: false, message: 'Sensor Fleet is not available in the review sandbox.' })
    : next()];

  router.use((_req, res, next) => { setNoStoreHeaders(res); next(); });
  router.param('nodeId', (req, res, next, nodeId) => {
    if (!/^[a-f0-9]{24}$/i.test(nodeId)) {
      return res.status(400).json({ success: false, message: 'Invalid sensor node ID.' });
    }
    return next();
  });

  const activationRateLimit = rateLimit({
    windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_SENSOR_ACTIVATION_RATE_LIMIT_WINDOW_MS || 15 * 60_000)),
    limit: Math.max(5, Number(process.env.HOMEBRAIN_SENSOR_ACTIVATION_RATE_LIMIT_MAX || 30)),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many sensor activation attempts. Please retry later.' }
  });

  const readingRateLimit = rateLimit({
    windowMs: Math.max(10_000, Number(process.env.HOMEBRAIN_SENSOR_READING_RATE_LIMIT_WINDOW_MS || 60_000)),
    limit: Math.max(60, Number(process.env.HOMEBRAIN_SENSOR_READING_RATE_LIMIT_MAX || 600)),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Sensor reading rate limit exceeded.' }
  });

  function setNoStoreHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  function extractSetupCode(req) {
    return req.get('X-HomeBrain-Sensor-Setup') || req.body?.setupCode || req.body?.setup_code || '';
  }

  function extractDeviceToken(req) {
    const authorization = req.get('Authorization') || '';
    const match = authorization.match(/^Sensor\s+(.+)$/i);
    return req.get('X-HomeBrain-Sensor-Token') || match?.[1] || '';
  }

  function requestIp(req) {
    return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/i, '').slice(0, 64);
  }

  function sendError(res, error, fallback) {
    const status = error.code === 11000 ? 409
      : Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    return res.status(status).json({
      success: false,
      message: error.code === 11000 ? 'This physical sensor is already assigned to a HomeBrain node.'
        : status < 500 ? error.message : fallback
    });
  }

  router.get('/', admin, async (_req, res) => {
    try {
      const nodes = await sensorNodeService.listNodes();
      return res.status(200).json({ success: true, nodes, count: nodes.length });
    } catch (error) {
      console.error('GET /api/sensor-nodes - Error:', error.message);
      return sendError(res, error, 'Failed to list sensor nodes.');
    }
  });

  router.post('/', admin, async (req, res) => {
    try {
      setNoStoreHeaders(res);
      const result = await sensorNodeService.registerNode(req.body || {}, getRequestOrigin(req));
      return res.status(201).json({ success: true, ...result });
    } catch (error) {
      console.error('POST /api/sensor-nodes - Error:', error.message);
      return sendError(res, error, 'Failed to register sensor node.');
    }
  });

  router.get('/:nodeId', admin, async (req, res) => {
    try {
      const node = await sensorNodeService.getNodeById(req.params.nodeId);
      return res.status(200).json({
        success: true,
        node: sensorNodeService.serializeNode(node)
      });
    } catch (error) {
      console.error('%s', `GET /api/sensor-nodes/${req.params.nodeId} - Error:`, error.message);
      return sendError(res, error, 'Failed to fetch sensor node.');
    }
  });

  router.put('/:nodeId', admin, async (req, res) => {
    try {
      const node = await sensorNodeService.updateNode(req.params.nodeId, req.body || {});
      return res.status(200).json({ success: true, node });
    } catch (error) {
      console.error('%s', `PUT /api/sensor-nodes/${req.params.nodeId} - Error:`, error.message);
      return sendError(res, error, 'Failed to update sensor node.');
    }
  });

  router.delete('/:nodeId', admin, async (req, res) => {
    try {
      const node = await sensorNodeService.deleteNode(req.params.nodeId);
      return res.status(200).json({ success: true, node });
    } catch (error) {
      console.error('%s', `DELETE /api/sensor-nodes/${req.params.nodeId} - Error:`, error.message);
      return sendError(res, error, 'Failed to delete sensor node.');
    }
  });

  router.get('/:nodeId/provisioning', admin, async (req, res) => {
    try {
      setNoStoreHeaders(res);
      const result = await sensorNodeService.getProvisioningStatus(req.params.nodeId, getRequestOrigin(req));
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      console.error('%s', `GET /api/sensor-nodes/${req.params.nodeId}/provisioning - Error:`, error.message);
      return sendError(res, error, 'Failed to fetch sensor provisioning status.');
    }
  });

  router.post('/:nodeId/setup-code/rotate', admin, async (req, res) => {
    try {
      setNoStoreHeaders(res);
      const result = await sensorNodeService.rotateSetupCode(req.params.nodeId, getRequestOrigin(req));
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      console.error('%s', `POST /api/sensor-nodes/${req.params.nodeId}/setup-code/rotate - Error:`, error.message);
      return sendError(res, error, 'Failed to rotate sensor setup code.');
    }
  });

  router.post('/:nodeId/activate', activationRateLimit, async (req, res) => {
    try {
      setNoStoreHeaders(res);
      const result = await sensorNodeService.activateNode(
        req.params.nodeId,
        extractSetupCode(req),
        req.body || {},
        { ipAddress: requestIp(req) }
      );
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      console.error('%s', `POST /api/sensor-nodes/${req.params.nodeId}/activate - Error:`, error.message);
      return sendError(res, error, 'Failed to activate sensor node.');
    }
  });

  router.get('/:nodeId/config', readingRateLimit, async (req, res) => {
    try {
      setNoStoreHeaders(res);
      const config = await sensorNodeService.getRuntimeConfig(req.params.nodeId, extractDeviceToken(req));
      return res.status(200).json({ success: true, config });
    } catch (error) {
      console.error('%s', `GET /api/sensor-nodes/${req.params.nodeId}/config - Error:`, error.message);
      return sendError(res, error, 'Failed to fetch sensor configuration.');
    }
  });

  router.post('/:nodeId/readings', readingRateLimit, async (req, res) => {
    try {
      setNoStoreHeaders(res);
      const result = await sensorNodeService.ingestReading(
        req.params.nodeId,
        extractDeviceToken(req),
        req.body || {},
        { ipAddress: requestIp(req) }
      );
      return res.status(202).json({ success: true, ...result });
    } catch (error) {
      console.error('%s', `POST /api/sensor-nodes/${req.params.nodeId}/readings - Error:`, error.message);
      return sendError(res, error, 'Failed to ingest sensor reading.');
    }
  });

  return router;
}

module.exports = createSensorNodeRouter();
module.exports.createSensorNodeRouter = createSensorNodeRouter;

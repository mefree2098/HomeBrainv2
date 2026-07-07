const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireAdmin } = require('./middlewares/auth');
const platformManagedService = require('../services/platformManagedService');

const platformServiceRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_PLATFORM_SERVICE_RATE_LIMIT_WINDOW_MS || 60_000)),
  limit: Math.max(5, Number(process.env.HOMEBRAIN_PLATFORM_SERVICE_RATE_LIMIT_MAX || 60)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many platform service requests. Please retry shortly.'
  }
});

router.use(platformServiceRateLimit, requireAdmin());

function getActor(req) {
  return req.user?.email || req.user?._id || 'unknown';
}

function logRouteError(routeLabel, error) {
  console.error(`${routeLabel} - Error:`, error.message);
}

router.get('/', async (req, res) => {
  try {
    const services = await platformManagedService.listServices();
    return res.status(200).json({
      success: true,
      services
    });
  } catch (error) {
    logRouteError('GET /api/platform-services', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to list platform services'
    });
  }
});

router.get('/mqtt/manage', async (req, res) => {
  try {
    const result = await platformManagedService.getMqttManagement({
      limit: req.query?.limit || 50
    });
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    logRouteError('GET /api/platform-services/mqtt/manage', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load MQTT management'
    });
  }
});

router.patch('/mqtt/config', async (req, res) => {
  try {
    const result = await platformManagedService.updateMqttConfig(req.body || {});
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    logRouteError('PATCH /api/platform-services/mqtt/config', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update MQTT configuration'
    });
  }
});

router.post('/mqtt/test-publish', async (req, res) => {
  try {
    const result = await platformManagedService.publishMqttTest(req.body || {});
    return res.status(200).json({
      success: true,
      result
    });
  } catch (error) {
    logRouteError('POST /api/platform-services/mqtt/test-publish', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to publish MQTT test message'
    });
  }
});

router.get('/pihole/manage', async (req, res) => {
  try {
    const result = await platformManagedService.getPiholeManagement({
      queryLimit: req.query?.limit || 80
    });
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    logRouteError('GET /api/platform-services/pihole/manage', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load Pi-hole management'
    });
  }
});

router.patch('/pihole/config', async (req, res) => {
  try {
    const result = await platformManagedService.updatePiholeConfig(req.body || {}, {
      actor: getActor(req)
    });
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    logRouteError('PATCH /api/platform-services/pihole/config', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update Pi-hole configuration'
    });
  }
});

router.post('/pihole/ensure-route', async (req, res) => {
  try {
    const result = await platformManagedService.ensurePiholeRoute({
      actor: getActor(req),
      apply: req.body?.apply === true
    });
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    logRouteError('POST /api/platform-services/pihole/ensure-route', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to ensure Pi-hole reverse proxy route'
    });
  }
});

router.post('/pihole/gravity', async (req, res) => {
  try {
    const result = await platformManagedService.runPiholeGravity({
      actor: getActor(req)
    });
    return res.status(202).json({
      success: true,
      ...result
    });
  } catch (error) {
    logRouteError('POST /api/platform-services/pihole/gravity', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update Pi-hole gravity'
    });
  }
});

router.post('/:serviceId/install', async (req, res) => {
  try {
    const service = await platformManagedService.installService(req.params.serviceId, {
      actor: getActor(req)
    });
    return res.status(202).json({
      success: true,
      service
    });
  } catch (error) {
    logRouteError('POST /api/platform-services/:serviceId/install', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to install platform service'
    });
  }
});

router.post('/:serviceId/check-updates', async (req, res) => {
  try {
    const service = await platformManagedService.checkForUpdates(req.params.serviceId, {
      actor: getActor(req)
    });
    return res.status(200).json({
      success: true,
      service
    });
  } catch (error) {
    logRouteError('POST /api/platform-services/:serviceId/check-updates', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to check service updates'
    });
  }
});

router.post('/:serviceId/update', async (req, res) => {
  try {
    const service = await platformManagedService.updateService(req.params.serviceId, {
      actor: getActor(req),
      automatic: false
    });
    return res.status(202).json({
      success: true,
      service
    });
  } catch (error) {
    logRouteError('POST /api/platform-services/:serviceId/update', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update platform service'
    });
  }
});

router.patch('/:serviceId/policy', async (req, res) => {
  try {
    const service = await platformManagedService.updatePolicy(req.params.serviceId, req.body || {});
    return res.status(200).json({
      success: true,
      service
    });
  } catch (error) {
    logRouteError('PATCH /api/platform-services/:serviceId/policy', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update platform service policy'
    });
  }
});

router.post('/policy/run', async (req, res) => {
  try {
    const result = await platformManagedService.runPolicyPass({
      actor: getActor(req)
    });
    return res.status(202).json({
      success: true,
      ...result
    });
  } catch (error) {
    logRouteError('POST /api/platform-services/policy/run', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to run platform service policy'
    });
  }
});

module.exports = router;

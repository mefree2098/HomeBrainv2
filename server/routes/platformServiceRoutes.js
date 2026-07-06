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

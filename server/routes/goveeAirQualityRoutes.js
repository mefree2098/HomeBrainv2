const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireAdmin } = require('./middlewares/auth');
const goveeAirQualityService = require('../services/goveeAirQualityService');

const goveeAirQualityRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_GOVEE_RATE_LIMIT_WINDOW_MS || 60_000)),
  limit: Math.max(10, Number(process.env.HOMEBRAIN_GOVEE_RATE_LIMIT_MAX || 120)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many Govee indoor air requests. Please retry shortly.'
  }
});

router.use(goveeAirQualityRateLimit, requireAdmin());

router.get('/status', async (req, res) => {
  try {
    const status = await goveeAirQualityService.getStatus();
    return res.status(200).json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error('GoveeAirQualityRoutes: Failed to load status:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load Govee indoor air status'
    });
  }
});

router.post('/test', async (req, res) => {
  try {
    const result = await goveeAirQualityService.testConnection({
      apiKey: req.body?.apiKey
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error('GoveeAirQualityRoutes: Test connection failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to test Govee indoor air connection'
    });
  }
});

router.post('/local/discover', async (req, res) => {
  try {
    const devices = await goveeAirQualityService.discoverLocalDevices({
      timeoutMs: req.body?.timeoutMs,
      targets: req.body?.targets,
      localDeviceIp: req.body?.localDeviceIp
    });
    return res.status(200).json({
      success: true,
      devices,
      message: devices.length > 0
        ? `Found ${devices.length} local Govee LAN device${devices.length === 1 ? '' : 's'}.`
        : 'No local Govee LAN Control response. If this H5106 is on Wi-Fi but still does not appear, the model or firmware may not expose Govee LAN Control; keep Auto or Cloud mode enabled for API readings.'
    });
  } catch (error) {
    console.error('GoveeAirQualityRoutes: Local discovery failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to discover local Govee LAN devices',
      devices: []
    });
  }
});

router.post('/local/test', async (req, res) => {
  try {
    const result = await goveeAirQualityService.testLocalConnection(req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    console.error('GoveeAirQualityRoutes: Local test failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to test local Govee LAN connectivity',
      devices: []
    });
  }
});

router.post('/configure', async (req, res) => {
  try {
    const result = await goveeAirQualityService.configureIntegration(req.body || {});
    return res.status(200).json({
      success: true,
      message: 'Govee indoor air integration updated successfully',
      ...result
    });
  } catch (error) {
    console.error('GoveeAirQualityRoutes: Configure failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to configure Govee indoor air integration'
    });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const result = await goveeAirQualityService.syncNow({ reason: 'manual-sync', allowDisabled: true });
    return res.status(200).json({
      success: result?.success !== false,
      message: result?.skipped ? 'Govee indoor air sync skipped' : 'Govee indoor air sync completed',
      ...result
    });
  } catch (error) {
    console.error('GoveeAirQualityRoutes: Sync failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to sync Govee indoor air integration'
    });
  }
});

module.exports = router;

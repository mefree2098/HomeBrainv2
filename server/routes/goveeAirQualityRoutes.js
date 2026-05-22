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

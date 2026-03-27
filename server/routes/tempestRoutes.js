const express = require('express');
const router = express.Router();
const { requireAdmin, requireUser } = require('./middlewares/auth');
const tempestService = require('../services/tempestService');

const admin = requireAdmin();
const user = requireUser();

router.get('/status', admin, async (req, res) => {
  try {
    const status = await tempestService.getStatus();
    return res.status(200).json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error('TempestRoutes: Failed to load status:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load Tempest status'
    });
  }
});

router.post('/test', admin, async (req, res) => {
  try {
    const result = await tempestService.testConnection({
      token: req.body?.token
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error('TempestRoutes: Test connection failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to test Tempest connection'
    });
  }
});

router.post('/configure', admin, async (req, res) => {
  try {
    const result = await tempestService.configureIntegration(req.body || {});
    return res.status(200).json({
      success: true,
      message: 'Tempest integration updated successfully',
      ...result
    });
  } catch (error) {
    console.error('TempestRoutes: Configure failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to configure Tempest integration'
    });
  }
});

router.post('/sync', admin, async (req, res) => {
  try {
    const result = await tempestService.refreshRuntime({ reason: 'manual-sync' });
    return res.status(200).json({
      success: true,
      message: result?.skipped ? 'Tempest sync skipped' : 'Tempest sync completed',
      ...result
    });
  } catch (error) {
    console.error('TempestRoutes: Sync failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to sync Tempest integration'
    });
  }
});

router.get('/observations', user, async (req, res) => {
  try {
    const observations = await tempestService.getObservations({
      stationId: req.query.stationId,
      hours: req.query.hours,
      limit: req.query.limit
    });

    return res.status(200).json({
      success: true,
      observations
    });
  } catch (error) {
    console.error('TempestRoutes: Observation query failed:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load Tempest observations'
    });
  }
});

router.get('/events', user, async (req, res) => {
  try {
    const events = await tempestService.getEvents({
      stationId: req.query.stationId,
      limit: req.query.limit
    });

    return res.status(200).json({
      success: true,
      events
    });
  } catch (error) {
    console.error('TempestRoutes: Event query failed:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load Tempest events'
    });
  }
});

module.exports = router;

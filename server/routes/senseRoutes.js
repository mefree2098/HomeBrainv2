const express = require('express');
const router = express.Router();
const { requireAdmin, requireUser } = require('./middlewares/auth');
const senseService = require('../services/senseService');

const admin = requireAdmin();
const user = requireUser();

router.get('/status', admin, async (_req, res) => {
  try {
    const status = await senseService.getStatus();
    return res.status(200).json(status);
  } catch (error) {
    console.error('SenseRoutes: Failed to load status:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load Sense status'
    });
  }
});

router.post('/test', admin, async (req, res) => {
  try {
    const result = await senseService.testConnection(req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    console.error('SenseRoutes: Test connection failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to test Sense connection'
    });
  }
});

router.post('/configure', admin, async (req, res) => {
  try {
    const result = await senseService.configureIntegration(req.body || {});
    return res.status(200).json({
      ...result,
      message: 'Sense integration updated successfully'
    });
  } catch (error) {
    console.error('SenseRoutes: Configure failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to configure Sense integration'
    });
  }
});

router.post('/sync', admin, async (_req, res) => {
  try {
    const result = await senseService.syncNow();
    return res.status(200).json(result);
  } catch (error) {
    console.error('SenseRoutes: Sync failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to sync Sense integration'
    });
  }
});

router.get('/dashboard', user, async (req, res) => {
  try {
    const dashboard = await senseService.getDashboard({
      hours: req.query.hours
    });
    return res.status(200).json(dashboard);
  } catch (error) {
    console.error('SenseRoutes: Dashboard failed:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load Sense dashboard'
    });
  }
});

module.exports = router;

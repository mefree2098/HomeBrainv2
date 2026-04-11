const express = require('express');
const router = express.Router();
const { requireAdmin, requireUser } = require('./middlewares/auth');
const rainMachineService = require('../services/rainMachineService');

const admin = requireAdmin();
const user = requireUser();

router.get('/status', admin, async (req, res) => {
  try {
    const status = await rainMachineService.getStatus();
    return res.status(200).json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error('RainMachineRoutes: Failed to load status:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load RainMachine status'
    });
  }
});

router.post('/discover', admin, async (req, res) => {
  try {
    const controllers = await rainMachineService.discoverControllers({
      timeoutMs: req.body?.timeoutMs || req.query?.timeoutMs
    });

    return res.status(200).json({
      success: true,
      controllers
    });
  } catch (error) {
    console.error('RainMachineRoutes: Discovery failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to discover RainMachine controllers'
    });
  }
});

router.post('/test', admin, async (req, res) => {
  try {
    const result = await rainMachineService.testConnection(req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    console.error('RainMachineRoutes: Test connection failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to test RainMachine connection'
    });
  }
});

router.post('/configure', admin, async (req, res) => {
  try {
    const result = await rainMachineService.configureIntegration(req.body || {});
    return res.status(200).json({
      success: true,
      message: 'RainMachine integration updated successfully',
      ...result
    });
  } catch (error) {
    console.error('RainMachineRoutes: Configure failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to configure RainMachine integration'
    });
  }
});

router.post('/sync', admin, async (req, res) => {
  try {
    const result = await rainMachineService.refreshRuntime({
      reason: 'manual-sync',
      forceReports: true
    });
    return res.status(200).json({
      success: true,
      message: result?.skipped ? 'RainMachine sync skipped' : 'RainMachine sync completed',
      ...result
    });
  } catch (error) {
    console.error('RainMachineRoutes: Sync failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to sync RainMachine integration'
    });
  }
});

router.get('/dashboard', user, async (req, res) => {
  try {
    const dashboard = await rainMachineService.getDashboard({
      dailyDays: req.query.dailyDays,
      wateringDays: req.query.wateringDays
    });

    return res.status(200).json({
      success: true,
      dashboard
    });
  } catch (error) {
    console.error('RainMachineRoutes: Dashboard failed:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load RainMachine dashboard'
    });
  }
});

router.get('/daily-stats', user, async (req, res) => {
  try {
    const dailyStats = await rainMachineService.getDailyStats({
      days: req.query.days
    });

    return res.status(200).json({
      success: true,
      dailyStats
    });
  } catch (error) {
    console.error('RainMachineRoutes: Daily stats failed:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load RainMachine daily stats'
    });
  }
});

router.get('/watering-history', user, async (req, res) => {
  try {
    const wateringHistory = await rainMachineService.getWateringHistory({
      days: req.query.days,
      simulated: req.query.simulated === '1' || req.query.simulated === 'true'
    });

    return res.status(200).json({
      success: true,
      wateringHistory
    });
  } catch (error) {
    console.error('RainMachineRoutes: Watering history failed:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load RainMachine watering history'
    });
  }
});

router.post('/zones/:id/start', user, async (req, res) => {
  try {
    const dashboard = await rainMachineService.startZone(req.params.id, req.body?.durationSeconds ?? req.body?.seconds);
    return res.status(200).json({
      success: true,
      message: 'RainMachine zone started',
      dashboard
    });
  } catch (error) {
    console.error('RainMachineRoutes: Start zone failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to start RainMachine zone'
    });
  }
});

router.post('/zones/:id/stop', user, async (req, res) => {
  try {
    const dashboard = await rainMachineService.stopZone(req.params.id);
    return res.status(200).json({
      success: true,
      message: 'RainMachine zone stopped',
      dashboard
    });
  } catch (error) {
    console.error('RainMachineRoutes: Stop zone failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to stop RainMachine zone'
    });
  }
});

router.post('/programs/:id/start', user, async (req, res) => {
  try {
    const dashboard = await rainMachineService.startProgram(req.params.id);
    return res.status(200).json({
      success: true,
      message: 'RainMachine program started',
      dashboard
    });
  } catch (error) {
    console.error('RainMachineRoutes: Start program failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to start RainMachine program'
    });
  }
});

router.post('/programs/:id/stop', user, async (req, res) => {
  try {
    const dashboard = await rainMachineService.stopProgram(req.params.id);
    return res.status(200).json({
      success: true,
      message: 'RainMachine program stopped',
      dashboard
    });
  } catch (error) {
    console.error('RainMachineRoutes: Stop program failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to stop RainMachine program'
    });
  }
});

router.post('/controller/stop-all', user, async (req, res) => {
  try {
    const dashboard = await rainMachineService.stopAll();
    return res.status(200).json({
      success: true,
      message: 'RainMachine watering stopped',
      dashboard
    });
  } catch (error) {
    console.error('RainMachineRoutes: Stop all failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to stop RainMachine watering'
    });
  }
});

router.post('/restrictions/rain-delay', user, async (req, res) => {
  try {
    const dashboard = await rainMachineService.setRainDelay(req.body?.days);
    return res.status(200).json({
      success: true,
      message: 'RainMachine rain delay updated',
      dashboard
    });
  } catch (error) {
    console.error('RainMachineRoutes: Rain delay failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to update RainMachine rain delay'
    });
  }
});

module.exports = router;

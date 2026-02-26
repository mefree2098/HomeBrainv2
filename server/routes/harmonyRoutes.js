const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const harmonyService = require('../services/harmonyService');

router.use(requireUser());

router.get('/status', async (req, res) => {
  try {
    const timeoutMs = Number(req.query.timeoutMs || 0) || undefined;
    const status = await harmonyService.getStatus({ timeoutMs });
    return res.status(200).json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error('HarmonyRoutes: Failed to load status:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load Harmony status'
    });
  }
});

router.post('/discover', async (req, res) => {
  try {
    const timeoutMs = Number(req.body?.timeoutMs || 0) || undefined;
    const hubs = await harmonyService.discoverHubs({ timeoutMs, force: true });
    const discoveredCount = hubs.filter((hub) => hub?.discovered).length;
    return res.status(200).json({
      success: true,
      hubs,
      count: discoveredCount,
      totalKnown: hubs.length
    });
  } catch (error) {
    console.error('HarmonyRoutes: Discovery failed:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to discover Harmony hubs'
    });
  }
});

router.get('/hubs', async (req, res) => {
  try {
    const includeCommands = req.query.includeCommands !== 'false';
    const timeoutMs = Number(req.query.timeoutMs || 0) || undefined;
    const hubs = await harmonyService.getHubs({ includeCommands, timeoutMs });
    return res.status(200).json({
      success: true,
      hubs,
      count: hubs.length
    });
  } catch (error) {
    console.error('HarmonyRoutes: Failed to fetch hub list:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch Harmony hubs'
    });
  }
});

router.get('/hubs/:hubIp', async (req, res) => {
  try {
    const hubIp = decodeURIComponent(req.params.hubIp || '');
    if (!hubIp) {
      return res.status(400).json({
        success: false,
        message: 'Hub IP/host is required'
      });
    }

    const includeCommands = req.query.includeCommands !== 'false';
    const hub = await harmonyService.getHubSnapshot(hubIp, { includeCommands });
    return res.status(200).json({
      success: true,
      hub
    });
  } catch (error) {
    console.error(`HarmonyRoutes: Failed to fetch hub ${req.params.hubIp}:`, error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to fetch Harmony hub'
    });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const timeoutMs = Number(req.body?.timeoutMs || 0) || undefined;
    const result = await harmonyService.syncDevices({ timeoutMs });
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('HarmonyRoutes: Sync failed:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to sync Harmony devices'
    });
  }
});

router.post('/sync-state', async (req, res) => {
  try {
    const hubIps = Array.isArray(req.body?.hubIps) ? req.body.hubIps : undefined;
    const result = await harmonyService.syncActivityStates({ hubIps, force: true });
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('HarmonyRoutes: State sync failed:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to sync Harmony activity state'
    });
  }
});

router.post('/hubs/:hubIp/activities/:activityId/start', async (req, res) => {
  try {
    const hubIp = decodeURIComponent(req.params.hubIp || '');
    const activityId = decodeURIComponent(req.params.activityId || '');
    const result = await harmonyService.startActivity(hubIp, activityId);
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('HarmonyRoutes: Failed to start activity:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to start Harmony activity'
    });
  }
});

router.post('/hubs/:hubIp/off', async (req, res) => {
  try {
    const hubIp = decodeURIComponent(req.params.hubIp || '');
    const result = await harmonyService.turnOffHub(hubIp);
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('HarmonyRoutes: Failed to power off hub:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to power off Harmony hub'
    });
  }
});

router.post('/hubs/:hubIp/devices/:deviceId/commands', async (req, res) => {
  try {
    const hubIp = decodeURIComponent(req.params.hubIp || '');
    const deviceId = decodeURIComponent(req.params.deviceId || '');
    const command = req.body?.command;
    const holdMs = req.body?.holdMs;

    if (!command || typeof command !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Command is required'
      });
    }

    const result = await harmonyService.sendDeviceCommand(hubIp, deviceId, command, holdMs);
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('HarmonyRoutes: Failed to send command:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to send Harmony command'
    });
  }
});

module.exports = router;

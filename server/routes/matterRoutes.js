const express = require('express');
const rateLimit = require('express-rate-limit');
const matterService = require('../services/matterService');
const { requireAdmin } = require('./middlewares/auth');

const router = express.Router();
const matterRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_MATTER_RATE_LIMIT_WINDOW_MS || 60_000)),
  limit: Math.max(20, Number(process.env.HOMEBRAIN_MATTER_RATE_LIMIT_MAX || 180)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many Matter requests. Please retry shortly.'
  }
});

router.use(matterRateLimit, requireAdmin());

function sendError(res, error, fallbackMessage) {
  const status = error.status || error.statusCode || 500;
  res.status(status).json({
    success: false,
    message: error.message || fallbackMessage,
    error: error.message || fallbackMessage
  });
}

router.get('/status', async (_req, res) => {
  try {
    const status = await matterService.start();
    res.status(200).json({
      success: true,
      status
    });
  } catch (error) {
    sendError(res, error, 'Failed to get Matter status');
  }
});

router.get('/thread/status', async (_req, res) => {
  try {
    const status = await matterService.getThreadStatus();
    res.status(200).json({
      success: true,
      status
    });
  } catch (error) {
    sendError(res, error, 'Failed to get Thread status');
  }
});

router.get('/thread/firmware-flash/status', async (_req, res) => {
  try {
    const threadStatus = await matterService.getThreadStatus();
    const status = await matterService.getThreadFirmwareFlashStatus({
      selectedPort: threadStatus.selectedPort
    });
    res.status(200).json({
      success: true,
      status
    });
  } catch (error) {
    sendError(res, error, 'Failed to get Thread firmware flash status');
  }
});

router.post('/thread/firmware-flash/start', async (req, res) => {
  try {
    const job = await matterService.startThreadFirmwareFlash(req.body || {});
    res.status(202).json({
      success: true,
      job,
      status: await matterService.getThreadFirmwareFlashStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to start Thread firmware flash');
  }
});

router.get('/devices', async (_req, res) => {
  try {
    const devices = await matterService.listMatterDevices();
    res.status(200).json({
      success: true,
      devices
    });
  } catch (error) {
    sendError(res, error, 'Failed to list Matter devices');
  }
});

router.get('/commissioning-sessions', async (_req, res) => {
  try {
    res.status(200).json({
      success: true,
      sessions: matterService.getCommissioningSessions()
    });
  } catch (error) {
    sendError(res, error, 'Failed to list Matter commissioning sessions');
  }
});

router.post('/commissioning/start', async (req, res) => {
  try {
    const session = await matterService.startCommissioning(req.body || {});
    res.status(202).json({
      success: true,
      session,
      status: await matterService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to start Matter commissioning');
  }
});

router.put('/config', async (req, res) => {
  try {
    const config = await matterService.updateConfig(req.body || {});
    res.status(200).json({
      success: true,
      config,
      status: await matterService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to update Matter configuration');
  }
});

router.post('/sync', async (_req, res) => {
  try {
    const syncedDevices = await matterService.syncCommissionedNodesToDevices();
    const devices = syncedDevices.length > 0 ? syncedDevices : await matterService.listMatterDevices();
    res.status(200).json({
      success: true,
      devices,
      status: await matterService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to sync Matter devices');
  }
});

router.post('/devices/:deviceId/refresh', async (req, res) => {
  try {
    const Device = require('../models/Device');
    const device = await Device.findById(req.params.deviceId);
    if (!device) {
      return res.status(404).json({
        success: false,
        message: 'Matter device not found'
      });
    }

    const update = await matterService.refreshMatterDeviceState(device);
    const refreshedDevice = update
      ? await Device.findByIdAndUpdate(device._id, update, { returnDocument: 'after', runValidators: true })
      : device;

    res.status(200).json({
      success: true,
      device: refreshedDevice
    });
  } catch (error) {
    sendError(res, error, 'Failed to refresh Matter device');
  }
});

router.delete('/devices/:deviceId', async (req, res) => {
  try {
    const device = await matterService.removeMatterDevice(req.params.deviceId, {
      force: req.query.force === '1' || req.query.force === 'true',
      decommission: req.query.decommission !== 'false'
    });
    res.status(200).json({
      success: true,
      device
    });
  } catch (error) {
    sendError(res, error, 'Failed to remove Matter device');
  }
});

router.get('/capabilities', async (_req, res) => {
  try {
    res.status(200).json({
      success: true,
      capabilities: matterService.getCapabilities()
    });
  } catch (error) {
    sendError(res, error, 'Failed to list Matter capabilities');
  }
});

module.exports = router;

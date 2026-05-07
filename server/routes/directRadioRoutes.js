const express = require('express');
const directRadioService = require('../services/directRadioService');
const { requireAdmin } = require('./middlewares/auth');

const router = express.Router();
router.use(requireAdmin());

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
    await directRadioService.start();
    const status = await directRadioService.getStatus();
    res.status(200).json({
      success: true,
      status
    });
  } catch (error) {
    sendError(res, error, 'Failed to get direct radio status');
  }
});

router.get('/serial-ports', async (_req, res) => {
  try {
    const serialPorts = await directRadioService.detectSerialPorts();
    res.status(200).json({
      success: true,
      serialPorts
    });
  } catch (error) {
    sendError(res, error, 'Failed to list serial ports');
  }
});

router.post('/pairing/start', async (req, res) => {
  try {
    const protocol = String(req.body?.protocol || '').trim().toLowerCase();
    const result = await directRadioService.startPairing(protocol, {
      durationSeconds: req.body?.durationSeconds
    });
    res.status(200).json({
      success: true,
      result,
      status: await directRadioService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to start direct radio pairing');
  }
});

router.post('/pairing/stop', async (req, res) => {
  try {
    const protocol = String(req.body?.protocol || 'all').trim().toLowerCase();
    const status = await directRadioService.stopPairing(protocol || 'all');
    res.status(200).json({
      success: true,
      status
    });
  } catch (error) {
    sendError(res, error, 'Failed to stop direct radio pairing');
  }
});

router.post('/exclusion/start', async (req, res) => {
  try {
    const protocol = String(req.body?.protocol || 'zwave').trim().toLowerCase();
    const result = await directRadioService.startExclusion(protocol, {
      durationSeconds: req.body?.durationSeconds
    });
    res.status(200).json({
      success: true,
      result,
      status: await directRadioService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to start direct radio exclusion');
  }
});

router.get('/migration-plan/:deviceId', async (req, res) => {
  try {
    const plan = await directRadioService.getMigrationPlan(req.params.deviceId, {
      protocol: req.query.protocol
    });
    res.status(200).json({
      success: true,
      plan
    });
  } catch (error) {
    sendError(res, error, 'Failed to build migration plan');
  }
});

router.post('/migrations', async (req, res) => {
  try {
    const result = await directRadioService.startMigration({
      deviceId: req.body?.deviceId,
      protocol: String(req.body?.protocol || '').trim().toLowerCase(),
      durationSeconds: req.body?.durationSeconds,
      dskPin: req.body?.dskPin
    });
    res.status(200).json({
      success: true,
      ...result,
      status: await directRadioService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to start device migration');
  }
});

module.exports = router;

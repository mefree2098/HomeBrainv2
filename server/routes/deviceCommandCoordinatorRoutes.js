const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const coordinatorService = require('../services/deviceCommandCoordinatorService');
const { requireUser, requireAdmin } = require('./middlewares/auth');

const auth = requireUser();
const admin = requireAdmin();
const coordinatorRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.DEVICE_COMMAND_COORDINATOR_RATE_LIMIT_WINDOW_MS || 5 * 60 * 1000)),
  limit: Math.max(10, Number(process.env.DEVICE_COMMAND_COORDINATOR_RATE_LIMIT_MAX || 240)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many device command coordinator requests. Please retry shortly.'
  }
});

function actorFromRequest(req) {
  return String(req.user?.email || req.user?._id || req.user?.id || 'unknown');
}

router.get('/policy', coordinatorRateLimit, auth, async (_req, res) => {
  try {
    const policy = await coordinatorService.getPolicy();
    res.status(200).json({
      success: true,
      policy,
      sourceDefinitions: coordinatorService.sourceDefinitions
    });
  } catch (error) {
    console.error('GET /api/device-command-coordinator/policy - Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch device command coordinator policy'
    });
  }
});

router.put('/policy', coordinatorRateLimit, admin, async (req, res) => {
  try {
    const policy = await coordinatorService.updatePolicy(req.body?.policy || req.body || {}, actorFromRequest(req));
    res.status(200).json({
      success: true,
      message: 'Device command coordinator policy updated',
      policy,
      sourceDefinitions: coordinatorService.sourceDefinitions
    });
  } catch (error) {
    console.error('PUT /api/device-command-coordinator/policy - Error:', error.message);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to update device command coordinator policy'
    });
  }
});

router.get('/claims', coordinatorRateLimit, auth, async (req, res) => {
  try {
    const claims = await coordinatorService.listActiveClaims();
    const decisions = coordinatorService.getRecentDecisions(req.query.limit);
    res.status(200).json({
      success: true,
      claims,
      decisions
    });
  } catch (error) {
    console.error('GET /api/device-command-coordinator/claims - Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch active device command holds'
    });
  }
});

router.delete('/claims', coordinatorRateLimit, admin, async (req, res) => {
  try {
    const cleared = await coordinatorService.clearAllClaims(actorFromRequest(req));
    res.status(200).json({
      success: true,
      message: `Cleared ${cleared.length} active device command hold${cleared.length === 1 ? '' : 's'}`,
      cleared
    });
  } catch (error) {
    console.error('DELETE /api/device-command-coordinator/claims - Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear device command holds'
    });
  }
});

router.delete('/claims/:deviceId', coordinatorRateLimit, admin, async (req, res) => {
  try {
    const cleared = await coordinatorService.clearDeviceClaim(req.params.deviceId, actorFromRequest(req));
    res.status(200).json({
      success: true,
      message: cleared ? 'Device command hold cleared' : 'No active hold found for device',
      cleared
    });
  } catch (error) {
    console.error('DELETE /api/device-command-coordinator/claims/:deviceId - Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear device command hold'
    });
  }
});

module.exports = router;

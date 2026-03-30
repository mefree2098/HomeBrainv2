const express = require('express');

const axiomIngressSyncService = require('../services/axiomIngressSyncService');

const router = express.Router();

function isLoopbackAddress(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  return value === '127.0.0.1' || value === '::1';
}

router.post('/sync', async (req, res) => {
  const remoteAddress = req.socket?.remoteAddress || req.ip;
  if (!isLoopbackAddress(remoteAddress)) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden'
    });
  }

  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : 'manual';
    const summary = await axiomIngressSyncService.sync({
      actor: 'system:internal-axiom-sync',
      reason: reason || 'manual'
    });

    return res.status(200).json({
      success: true,
      ...summary
    });
  } catch (error) {
    console.error('POST /internal/axiom/sync - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to sync Axiom ingress state'
    });
  }
});

module.exports = router;

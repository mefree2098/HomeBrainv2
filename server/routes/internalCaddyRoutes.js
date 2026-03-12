const express = require('express');

const reverseProxyService = require('../services/reverseProxyService');

const router = express.Router();

function isLoopbackAddress(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  return value === '127.0.0.1' || value === '::1';
}

router.get('/can-issue-cert', async (req, res) => {
  const remoteAddress = req.socket?.remoteAddress || req.ip;
  if (!isLoopbackAddress(remoteAddress)) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden'
    });
  }

  const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
  if (!domain) {
    return res.status(400).json({
      success: false,
      message: 'domain is required'
    });
  }

  try {
    const allowed = await reverseProxyService.canIssueCertificate(domain);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        domain,
        allowed: false
      });
    }

    return res.status(200).json({
      success: true,
      domain,
      allowed: true
    });
  } catch (error) {
    console.error('GET /internal/caddy/can-issue-cert - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Internal certificate policy check failed'
    });
  }
});

module.exports = router;

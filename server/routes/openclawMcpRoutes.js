const express = require('express');

const openclawIntegrationService = require('../services/openclawIntegrationService');
const openclawMcpService = require('../services/openclawMcpService');

const router = express.Router();

async function requireOpenClawIntegration(req, res, next) {
  try {
    const token = openclawIntegrationService.extractBearerToken(req);
    const integration = await openclawIntegrationService.verifyToken(token, req);
    req.openclawIntegration = integration;
    return next();
  } catch (error) {
    return res.status(error.status || 401).json({
      jsonrpc: '2.0',
      error: {
        code: error.status === 403 ? -32003 : -32001,
        message: error.message || 'Unauthorized'
      },
      id: null
    });
  }
}

function sendMethodNotAllowed(res) {
  return res
    .status(405)
    .set('Allow', 'POST')
    .json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.'
      },
      id: null
    });
}

router.post('/', requireOpenClawIntegration, async (req, res) => {
  return openclawMcpService.handleRequest(req, res, req.openclawIntegration);
});

router.get('/', (_req, res) => sendMethodNotAllowed(res));
router.delete('/', (_req, res) => sendMethodNotAllowed(res));

module.exports = router;

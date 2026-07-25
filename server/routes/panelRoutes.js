const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();
const wallPanelService = require('../services/wallPanelService');
const { requireAdmin } = require('./middlewares/auth');
const { getRequestOrigin } = require('../utils/publicOrigin');

const admin = requireAdmin();
const panelFirmwareMutationRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_PANEL_FIRMWARE_RATE_LIMIT_WINDOW_MS || 60_000)),
  limit: Math.max(5, Number(process.env.HOMEBRAIN_PANEL_FIRMWARE_RATE_LIMIT_MAX || 30)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many hardware orb firmware requests. Please retry shortly.'
  }
});

function extractPanelCredentials(req) {
  return {
    registrationCode: req.get('X-HomeBrain-Panel-Code')
      || req.query.code
      || req.body?.registrationCode
      || '',
    claimToken: req.get('X-HomeBrain-Panel-Claim')
      || req.query.claim
      || req.body?.claimToken
      || ''
  };
}

function getObservedRequestOrigin(req) {
  const host = req.get('host');
  if (!host) {
    return '';
  }
  const protocol = req.protocol || (req.secure ? 'https' : 'http');
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch (_error) {
    return '';
  }
}

function setNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

router.get('/', admin, async (_req, res) => {
  try {
    const panels = await wallPanelService.listPanels();
    return res.status(200).json({
      success: true,
      panels,
      count: panels.length
    });
  } catch (error) {
    console.error('GET /api/panels - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to fetch wall panels'
    });
  }
});

router.get('/provisioning/usb-ports', admin, async (_req, res) => {
  try {
    const result = await wallPanelService.listProvisioningUsbPorts();
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('GET /api/panels/provisioning/usb-ports - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to detect hardware orb USB ports',
      ports: []
    });
  }
});

router.post('/provisioning/usb', admin, async (req, res) => {
  try {
    const result = await wallPanelService.provisionPanelOverUsb(
      req.body || {},
      getRequestOrigin(req)
    );
    return res.status(202).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('POST /api/panels/provisioning/usb - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to start hardware orb USB provisioning'
    });
  }
});

router.post('/register', admin, async (req, res) => {
  try {
    const panel = await wallPanelService.registerPanel(req.body || {});
    return res.status(201).json({
      success: true,
      panel
    });
  } catch (error) {
    console.error('POST /api/panels/register - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to register wall panel'
    });
  }
});

router.get('/:panelId', admin, async (req, res) => {
  try {
    const panel = await wallPanelService.getPanelById(req.params.panelId);
    return res.status(200).json({
      success: true,
      panel
    });
  } catch (error) {
    console.error(`GET /api/panels/${req.params.panelId} - Error:`, error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to load wall panel'
    });
  }
});

router.put('/:panelId', admin, async (req, res) => {
  try {
    const panel = await wallPanelService.updatePanel(req.params.panelId, req.body || {});
    return res.status(200).json({
      success: true,
      panel
    });
  } catch (error) {
    console.error(`PUT /api/panels/${req.params.panelId} - Error:`, error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to update wall panel'
    });
  }
});

router.post('/:panelId/claim-token/rotate', admin, async (req, res) => {
  try {
    const panel = await wallPanelService.rotateClaimToken(req.params.panelId);
    return res.status(200).json({
      success: true,
      panel
    });
  } catch (error) {
    console.error(`POST /api/panels/${req.params.panelId}/claim-token/rotate - Error:`, error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to rotate wall panel claim token'
    });
  }
});

router.get('/:panelId/provisioning', admin, async (req, res) => {
  try {
    const result = await wallPanelService.getPanelProvisioning(
      req.params.panelId,
      getRequestOrigin(req)
    );
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error(`GET /api/panels/${req.params.panelId}/provisioning - Error:`, error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to fetch wall panel provisioning bundle'
    });
  }
});

router.post('/:panelId/registration-code/rotate', admin, async (req, res) => {
  try {
    const result = await wallPanelService.rotateRegistrationCode(
      req.params.panelId,
      getRequestOrigin(req)
    );
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error(`POST /api/panels/${req.params.panelId}/registration-code/rotate - Error:`, error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to rotate wall panel registration code'
    });
  }
});

router.get('/:panelId/bootstrap', async (req, res) => {
  try {
    const credentials = extractPanelCredentials(req);
    const result = await wallPanelService.bootstrapPanel(
      req.params.panelId,
      credentials,
      getRequestOrigin(req)
    );
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error(`GET /api/panels/${req.params.panelId}/bootstrap - Error:`, error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to bootstrap wall panel'
    });
  }
});

router.post('/:panelId/activate', async (req, res) => {
  try {
    const panel = await wallPanelService.activatePanel(
      req.params.panelId,
      extractPanelCredentials(req),
      req.body || {}
    );
    return res.status(200).json({
      success: true,
      panel
    });
  } catch (error) {
    console.error(`POST /api/panels/${req.params.panelId}/activate - Error:`, error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to activate wall panel'
    });
  }
});

router.get('/:panelId/state', async (req, res) => {
  try {
    setNoStoreHeaders(res);
    const state = await wallPanelService.getPanelState(
      req.params.panelId,
      extractPanelCredentials(req),
      getRequestOrigin(req),
      req.ip,
      getObservedRequestOrigin(req)
    );
    return res.status(200).json({
      success: true,
      state
    });
  } catch (error) {
    console.error(`GET /api/panels/${req.params.panelId}/state - Error:`, error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to fetch wall panel state'
    });
  }
});

router.post('/:panelId/ota/push', panelFirmwareMutationRateLimit, admin, async (req, res) => {
  try {
    const panel = await wallPanelService.pushFirmwareUpdate(
      req.params.panelId,
      getRequestOrigin(req),
      req.body || {}
    );
    return res.status(202).json({
      success: true,
      panel
    });
  } catch (error) {
    console.error(`POST /api/panels/${req.params.panelId}/ota/push - Error:`, error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to start the wall panel OTA update'
    });
  }
});

router.post('/:panelId/ota/recover-identity', panelFirmwareMutationRateLimit, admin, async (req, res) => {
  try {
    const recovery = await wallPanelService.pushPanelIdentityRecovery(
      req.params.panelId,
      req.body || {},
      getRequestOrigin(req)
    );
    return res.status(202).json({
      success: true,
      ...recovery
    });
  } catch (error) {
    console.error('POST /api/panels/:panelId/ota/recover-identity - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to start hardware orb identity recovery'
    });
  }
});

router.post('/:panelId/ota/cancel', panelFirmwareMutationRateLimit, admin, async (req, res) => {
  try {
    const panel = await wallPanelService.cancelPanelOtaJob(
      req.params.panelId,
      req.body || {}
    );
    return res.status(200).json({
      success: true,
      panel
    });
  } catch (error) {
    console.error('POST /api/panels/:panelId/ota/cancel - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to cancel the wall panel OTA update'
    });
  }
});

router.get('/:panelId/ota/download', async (req, res) => {
  try {
    const artifact = await wallPanelService.getPanelOtaArtifact(
      req.params.panelId,
      extractPanelCredentials(req),
      getRequestOrigin(req),
      req.ip,
      getObservedRequestOrigin(req)
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(artifact.artifactSizeBytes));
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(artifact.artifactPath);
  } catch (error) {
    console.error(`GET /api/panels/${req.params.panelId}/ota/download - Error:`, error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to stream the wall panel OTA package'
    });
  }
});

router.post('/:panelId/ota/status', async (req, res) => {
  try {
    const panel = await wallPanelService.reportPanelOtaStatus(
      req.params.panelId,
      extractPanelCredentials(req),
      req.body || {}
    );
    return res.status(200).json({
      success: true,
      panel
    });
  } catch (error) {
    console.error(`POST /api/panels/${req.params.panelId}/ota/status - Error:`, error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to record wall panel OTA status'
    });
  }
});

router.post('/:panelId/actions', async (req, res) => {
  try {
    const result = await wallPanelService.executeAction(
      req.params.panelId,
      extractPanelCredentials(req),
      req.body || {}
    );
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error(`POST /api/panels/${req.params.panelId}/actions - Error:`, error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to execute wall panel action'
    });
  }
});

module.exports = router;

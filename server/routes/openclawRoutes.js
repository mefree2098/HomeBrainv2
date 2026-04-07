const express = require('express');

const { requireAdmin } = require('./middlewares/auth');
const openclawIntegrationService = require('../services/openclawIntegrationService');

const router = express.Router();

router.use(requireAdmin());

router.get('/', async (req, res) => {
  try {
    const status = await openclawIntegrationService.getStatus(req);
    return res.status(200).json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error('GET /api/openclaw - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch OpenClaw integration status'
    });
  }
});

router.put('/', async (req, res) => {
  try {
    await openclawIntegrationService.updateIntegrationSettings(
      req.body || {},
      req.user?.email || req.user?._id || 'unknown-admin'
    );
    const status = await openclawIntegrationService.getStatus(req);
    return res.status(200).json({
      success: true,
      message: 'OpenClaw integration settings updated successfully',
      ...status
    });
  } catch (error) {
    console.error('PUT /api/openclaw - Error:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to update OpenClaw integration settings'
    });
  }
});

router.post('/token/rotate', async (req, res) => {
  try {
    const actor = req.user?.email || req.user?._id || 'unknown-admin';
    const { token } = await openclawIntegrationService.rotateToken({ actor });
    const status = await openclawIntegrationService.getStatus(req, { token });

    return res.status(201).json({
      success: true,
      message: 'OpenClaw integration token rotated successfully',
      token,
      ...status
    });
  } catch (error) {
    console.error('POST /api/openclaw/token/rotate - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to rotate OpenClaw integration token'
    });
  }
});

router.delete('/token', async (req, res) => {
  try {
    const integration = await openclawIntegrationService.revokeToken({
      actor: req.user?.email || req.user?._id || 'unknown-admin'
    });

    return res.status(200).json({
      success: true,
      message: 'OpenClaw integration token revoked successfully',
      integration
    });
  } catch (error) {
    console.error('DELETE /api/openclaw/token - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to revoke OpenClaw integration token'
    });
  }
});

router.get('/skill', async (_req, res) => {
  try {
    const markdown = await openclawIntegrationService.getSkillMarkdown();
    return res.status(200).json({
      success: true,
      path: openclawIntegrationService.skillPath,
      markdown
    });
  } catch (error) {
    console.error('GET /api/openclaw/skill - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load OpenClaw skill'
    });
  }
});

router.get('/jetson-guide', async (_req, res) => {
  try {
    const markdown = await openclawIntegrationService.getJetsonGuideMarkdown();
    return res.status(200).json({
      success: true,
      path: openclawIntegrationService.jetsonGuidePath,
      markdown
    });
  } catch (error) {
    console.error('GET /api/openclaw/jetson-guide - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load Jetson setup guide'
    });
  }
});

router.get('/bundle', async (req, res) => {
  try {
    await openclawIntegrationService.writeBundleToResponse(res, req);
  } catch (error) {
    console.error('GET /api/openclaw/bundle - Error:', error.message);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to build OpenClaw bundle'
      });
    }
  }
});

router.post('/bundle', async (req, res) => {
  try {
    const rawToken = String(req.body?.token || '').trim();
    if (rawToken) {
      const matches = await openclawIntegrationService.currentTokenMatches(rawToken);
      if (!matches) {
        return res.status(400).json({
          success: false,
          message: 'The provided OpenClaw token no longer matches the current integration token. Rotate again and retry.'
        });
      }
    }

    await openclawIntegrationService.writeBundleToResponse(res, req, {
      token: rawToken || undefined
    });
  } catch (error) {
    console.error('POST /api/openclaw/bundle - Error:', error.message);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to build OpenClaw bundle'
      });
    }
  }
});

module.exports = router;

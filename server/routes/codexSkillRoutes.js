const express = require('express');

const { requireAdmin } = require('./middlewares/auth');
const codexSkillIntegrationService = require('../services/codexSkillIntegrationService');

const router = express.Router();

router.use(requireAdmin());

router.get('/', async (req, res) => {
  try {
    const status = await codexSkillIntegrationService.getStatus(req);
    return res.status(200).json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error('GET /api/codex-skill - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch Codex skill integration status'
    });
  }
});

router.put('/', async (req, res) => {
  try {
    await codexSkillIntegrationService.updateIntegrationSettings(
      req.body || {},
      req.user?.email || req.user?._id || 'unknown-admin'
    );
    const status = await codexSkillIntegrationService.getStatus(req);
    return res.status(200).json({
      success: true,
      message: 'Codex skill integration settings updated successfully',
      ...status
    });
  } catch (error) {
    console.error('PUT /api/codex-skill - Error:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to update Codex skill integration settings'
    });
  }
});

router.post('/token/rotate', async (req, res) => {
  try {
    const actor = req.user?.email || req.user?._id || 'unknown-admin';
    const { token } = await codexSkillIntegrationService.rotateToken({
      actor,
      user: req.user || null
    });
    const status = await codexSkillIntegrationService.getStatus(req, { token });

    return res.status(201).json({
      success: true,
      message: 'Codex skill token rotated successfully',
      token,
      ...status
    });
  } catch (error) {
    console.error('POST /api/codex-skill/token/rotate - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to rotate Codex skill token'
    });
  }
});

router.delete('/token', async (req, res) => {
  try {
    const integration = await codexSkillIntegrationService.revokeToken({
      actor: req.user?.email || req.user?._id || 'unknown-admin'
    });

    return res.status(200).json({
      success: true,
      message: 'Codex skill token revoked successfully',
      integration
    });
  } catch (error) {
    console.error('DELETE /api/codex-skill/token - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to revoke Codex skill token'
    });
  }
});

router.get('/skill', async (_req, res) => {
  try {
    const markdown = await codexSkillIntegrationService.getSkillMarkdown();
    const openAiYaml = await codexSkillIntegrationService.getSkillOpenAiYaml();
    return res.status(200).json({
      success: true,
      path: codexSkillIntegrationService.skillPath,
      markdown,
      openAiYaml
    });
  } catch (error) {
    console.error('GET /api/codex-skill/skill - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load Codex skill bundle'
    });
  }
});

router.get('/bundle', async (req, res) => {
  try {
    await codexSkillIntegrationService.writeBundleToResponse(res, req);
  } catch (error) {
    console.error('GET /api/codex-skill/bundle - Error:', error.message);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to build Codex skill bundle'
      });
    }
  }
});

router.post('/bundle', async (req, res) => {
  try {
    const rawToken = String(req.body?.token || '').trim();
    if (rawToken) {
      const matches = await codexSkillIntegrationService.currentTokenMatches(rawToken);
      if (!matches) {
        return res.status(400).json({
          success: false,
          message: 'The provided Codex skill token no longer matches the current integration token. Rotate again and retry.'
        });
      }
    }

    await codexSkillIntegrationService.writeBundleToResponse(res, req, {
      token: rawToken || undefined
    });
  } catch (error) {
    console.error('POST /api/codex-skill/bundle - Error:', error.message);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: error.message || 'Failed to build Codex skill bundle'
      });
    }
  }
});

module.exports = router;

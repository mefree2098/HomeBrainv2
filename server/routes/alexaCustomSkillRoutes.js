const express = require('express');

const alexaBridgeService = require('../services/alexaBridgeService');
const alexaCustomSkillService = require('../services/alexaCustomSkillService');
const { requireAdmin } = require('./middlewares/auth');

const router = express.Router();
const admin = requireAdmin();

async function brokerAuth(req, res, next) {
  try {
    const registration = await alexaBridgeService.authenticateBrokerRequest(req);
    req.alexaBrokerRegistration = registration;
    return next();
  } catch (error) {
    return res.status(error.status || 401).json({
      success: false,
      error: error.message || 'Broker authentication failed'
    });
  }
}

router.post('/dispatch', brokerAuth, async (req, res) => {
  try {
    const result = await alexaCustomSkillService.handleSkillRequest(
      req.body?.envelope && typeof req.body.envelope === 'object' ? req.body.envelope : req.body,
      {
        brokerAccountId: req.body?.brokerAccountId,
        linkedAccount: req.body?.linkedAccount
      }
    );

    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Failed to dispatch Alexa custom-skill request'
    });
  }
});

router.get('/audio/:clipId', async (req, res) => {
  try {
    const clip = await alexaCustomSkillService.resolveAudioClip(req.params.clipId, req.query.token);
    res.setHeader('Content-Type', clip.contentType || 'audio/mpeg');
    return res.status(200).send(clip.buffer);
  } catch (error) {
    return res.status(error.status || 400).json({
      success: false,
      error: error.message || 'Failed to resolve Alexa custom audio clip'
    });
  }
});

router.get('/status', admin, async (_req, res) => {
  try {
    const status = await alexaCustomSkillService.getStatusSummary();
    return res.status(200).json({
      success: true,
      status
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa custom-skill status'
    });
  }
});

router.get('/voice-users', admin, async (_req, res) => {
  try {
    const voiceUsers = await alexaCustomSkillService.listVoiceUsers();
    return res.status(200).json({
      success: true,
      count: voiceUsers.length,
      voiceUsers
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa voice users'
    });
  }
});

router.put('/voice-users/:voiceUserId', admin, async (req, res) => {
  try {
    const voiceUser = await alexaCustomSkillService.updateVoiceUser(req.params.voiceUserId, req.body || {});
    return res.status(200).json({
      success: true,
      voiceUser
    });
  } catch (error) {
    return res.status(error.message?.includes('not found') ? 404 : 400).json({
      success: false,
      error: error.message || 'Failed to update Alexa voice user'
    });
  }
});

router.delete('/voice-users/:voiceUserId', admin, async (req, res) => {
  try {
    const result = await alexaCustomSkillService.deleteVoiceUser(req.params.voiceUserId);
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    return res.status(error.message?.includes('not found') ? 404 : 400).json({
      success: false,
      error: error.message || 'Failed to delete Alexa voice user'
    });
  }
});

router.post('/preview', admin, async (req, res) => {
  try {
    const result = await alexaCustomSkillService.dispatch({
      ...(req.body || {}),
      metadata: {
        ...(req.body?.metadata || {}),
        source: 'admin_preview'
      }
    });

    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message || 'Failed to preview Alexa custom-skill request'
    });
  }
});

module.exports = router;

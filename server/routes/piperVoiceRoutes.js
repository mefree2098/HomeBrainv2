const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const piperVoiceService = require('../services/piperVoiceService');

router.get('/', requireUser(), async (req, res) => {
  try {
    const voices = await piperVoiceService.listVoices();
    res.status(200).json({
      success: true,
      voices
    });
  } catch (error) {
    console.error('GET /api/wake-words/voices - Error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to list Piper voices'
    });
  }
});

router.post('/:voiceId', requireUser(), async (req, res) => {
  try {
    const voice = await piperVoiceService.downloadVoice(req.params.voiceId);
    res.status(202).json({
      success: true,
      voice,
      message: `${voice.name} voice downloaded`
    });
  } catch (error) {
    console.error(`POST /api/wake-words/voices/${req.params.voiceId} - Error:`, error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to download Piper voice'
    });
  }
});

router.delete('/:voiceId', requireUser(), async (req, res) => {
  try {
    await piperVoiceService.removeVoice(req.params.voiceId);
    res.status(200).json({
      success: true,
      message: 'Voice removed'
    });
  } catch (error) {
    console.error(`DELETE /api/wake-words/voices/${req.params.voiceId} - Error:`, error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to remove Piper voice'
    });
  }
});

// Test Piper device/provider (CPU vs GPU)
router.get('/probe/device', requireUser(), async (req, res) => {
  try {
    const info = await piperVoiceService.detectPiperDevice();
    res.status(200).json({ success: true, info });
  } catch (error) {
    console.error('GET /api/wake-words/voices/probe/device - Error:', error.message);
    res.status(500).json({ success: false, message: error.message || 'Failed to probe Piper device' });
  }
});

module.exports = router;

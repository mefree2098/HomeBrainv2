const express = require('express');
const router = express.Router();
const { requireAdmin } = require('./middlewares/auth');
const Settings = require('../models/Settings');
const ttsProviderService = require('../services/ttsProviderService');

const auth = requireAdmin();

function resolveApiKey(candidate, storedValue, isMaskedSecretValue) {
  const normalized = typeof candidate === 'string' ? candidate.trim() : '';
  if (normalized && !isMaskedSecretValue(normalized)) {
    return normalized;
  }
  return typeof storedValue === 'string' ? storedValue.trim() : '';
}

function isMaskedSecretValue(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return /^[*•]{4,}[^*•\s]*$/.test(trimmed);
}

async function buildOverrides(req) {
  const settings = await Settings.getSettings();
  return {
    settings,
    provider: req.body?.provider || req.query?.provider,
    endpoint: req.body?.endpoint || req.query?.endpoint || settings.s2ProEndpoint,
    apiKey: resolveApiKey(req.body?.apiKey || req.query?.apiKey, settings.s2ProApiKey, isMaskedSecretValue),
    voiceId: req.body?.voiceId || req.query?.voiceId || settings.s2ProDefaultVoiceId,
    model: req.body?.model || req.query?.model || settings.s2ProModel,
    format: req.body?.format || req.query?.format || settings.s2ProOutputFormat,
    timeoutMs: req.body?.timeoutMs || req.query?.timeoutMs || settings.s2ProTimeoutMs,
    text: req.body?.text || req.query?.text
  };
}

router.get('/status', auth, async (_req, res) => {
  try {
    const settings = await Settings.getSettings();
    return res.status(200).json({
      success: true,
      status: {
        provider: settings.ttsProvider || 'elevenlabs',
        priorityList: settings.ttsProviderPriorityList || ['s2_pro', 'elevenlabs'],
        s2ProConfigured: Boolean(settings.s2ProEndpoint),
        s2ProEndpoint: settings.s2ProEndpoint || '',
        s2ProDefaultVoiceId: settings.s2ProDefaultVoiceId || '',
        s2ProModel: settings.s2ProModel || 's2-pro',
        s2ProOutputFormat: settings.s2ProOutputFormat || 'mp3',
        elevenLabsConfigured: Boolean(settings.elevenlabsApiKey || process.env.ELEVENLABS_API_KEY),
        elevenlabsDefaultVoiceId: settings.elevenlabsDefaultVoiceId || ''
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch TTS status'
    });
  }
});

router.get('/voices', auth, async (req, res) => {
  try {
    const provider = String(req.query?.provider || 's2_pro').trim().toLowerCase();
    const overrides = await buildOverrides(req);
    const result = await ttsProviderService.listVoices(provider, overrides);
    return res.status(200).json({
      ...result,
      count: Array.isArray(result.voices) ? result.voices.length : 0
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to fetch TTS voices',
      error: error.message
    });
  }
});

router.post('/test', auth, async (req, res) => {
  try {
    const overrides = await buildOverrides(req);
    const result = await ttsProviderService.testProvider(overrides);
    return res.status(200).json(result);
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to test TTS provider',
      error: error.message
    });
  }
});

router.post('/preview', auth, async (req, res) => {
  try {
    const overrides = await buildOverrides(req);
    const speech = await ttsProviderService.textToSpeechDetailed(
      overrides.text || 'HomeBrain voice preview.',
      overrides.voiceId,
      overrides
    );
    const audioBuffer = speech.audioBuffer;
    res.setHeader('Content-Type', speech.contentType || 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-HomeBrain-TTS-Provider', speech.provider || overrides.provider || 'unknown');
    return res.status(200).send(audioBuffer);
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to generate TTS preview',
      error: error.message
    });
  }
});

module.exports = router;

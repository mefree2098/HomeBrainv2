const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireAdmin } = require('./middlewares/auth');
const Settings = require('../models/Settings');
const ttsProviderService = require('../services/ttsProviderService');

const auth = requireAdmin();
const ttsReadRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_TTS_READ_RATE_LIMIT_WINDOW_MS || 60 * 1000)),
  limit: Math.max(1, Number(process.env.HOMEBRAIN_TTS_READ_RATE_LIMIT_MAX || 120)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many TTS status requests. Try again later.'
  }
});
const ttsProbeRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_TTS_PROBE_RATE_LIMIT_WINDOW_MS || 5 * 60 * 1000)),
  limit: Math.max(1, Number(process.env.HOMEBRAIN_TTS_PROBE_RATE_LIMIT_MAX || 30)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many TTS provider probe requests. Try again later.'
  }
});

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
  const source = req.body || {};
  return {
    settings,
    provider: source.provider,
    endpoint: source.endpoint || settings.s2ProEndpoint,
    apiKey: resolveApiKey(source.apiKey, settings.s2ProApiKey, isMaskedSecretValue),
    voiceId: source.voiceId || settings.s2ProDefaultVoiceId,
    model: source.model || settings.s2ProModel,
    format: source.format || settings.s2ProOutputFormat,
    timeoutMs: source.timeoutMs || settings.s2ProTimeoutMs,
    text: source.text
  };
}

async function buildStoredVoiceOverrides(req) {
  const settings = await Settings.getSettings();
  return {
    settings,
    provider: req.query?.provider,
    endpoint: settings.s2ProEndpoint,
    apiKey: settings.s2ProApiKey,
    voiceId: settings.s2ProDefaultVoiceId,
    model: settings.s2ProModel,
    format: settings.s2ProOutputFormat,
    timeoutMs: settings.s2ProTimeoutMs
  };
}

router.get('/status', ttsReadRateLimit, auth, async (_req, res) => {
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

router.get('/voices', ttsReadRateLimit, auth, async (req, res) => {
  try {
    const provider = String(req.query?.provider || 's2_pro').trim().toLowerCase();
    const overrides = await buildStoredVoiceOverrides(req);
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

router.post('/voices/query', ttsProbeRateLimit, auth, async (req, res) => {
  try {
    const overrides = await buildOverrides(req);
    const provider = String(overrides.provider || 's2_pro').trim().toLowerCase();
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

router.post('/test', ttsProbeRateLimit, auth, async (req, res) => {
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

router.post('/preview', ttsProbeRateLimit, auth, async (req, res) => {
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

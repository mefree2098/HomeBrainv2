const express = require('express');
const fs = require('fs');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const voiceDeviceService = require('../services/voiceDeviceService');
const voiceCommandService = require('../services/voiceCommandService');
const speechService = require('../services/speechService');
const Settings = require('../models/Settings');
const elevenLabsService = require('../services/elevenLabsService');
const voiceAcknowledgmentService = require('../services/voiceAcknowledgmentService');
const { requireUser, requireAdmin } = require('./middlewares/auth');
const voiceWs = require('../websocket/voiceWebSocket');
const VoiceDevice = require('../models/VoiceDevice');
const VoiceCommand = require('../models/VoiceCommand');
const eventStreamService = require('../services/eventStreamService');

const admin = requireAdmin();
const DEFAULT_WAKE_WORD_MIN_RMS = 0.004;
const MAX_WAKE_WORD_MIN_RMS = 0.2;
const voiceDiagnosticsRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});
const browserVoiceAudioRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

function collectVoiceWebSocketStats(app) {
  return ['voiceWebSocket', 'voiceWebSocketHttp']
    .map((key) => app?.get?.(key))
    .filter(Boolean)
    .map((ws) => {
      try {
        return typeof ws.getStats === 'function' ? ws.getStats() : null;
      } catch (error) {
        console.warn('%s', `Failed to collect ${ws?.constructor?.name || 'voice websocket'} stats:`, error.message);
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * @route GET /api/voice/devices
 * @desc Get all voice devices
 * @access Private
 */
router.get('/devices', requireUser(), async (req, res) => {
  console.log('GET /api/voice/devices - Fetching all voice devices');
  try {
    const devices = await voiceDeviceService.getAllDevices();
    
    console.log(`GET /api/voice/devices - Successfully fetched ${devices.length} devices`);
    res.status(200).json({
      success: true,
      devices: devices,
      count: devices.length
    });
  } catch (error) {
    console.error('GET /api/voice/devices - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch voice devices'
    });
  }
});

/**
 * @route GET /api/voice/devices/:id
 * @desc Get voice device by ID
 * @access Private
 */
router.get('/devices/:id', requireUser(), async (req, res) => {
  const { id } = req.params;
  console.log(`GET /api/voice/devices/${id} - Fetching voice device by ID`);
  
  try {
    const device = await voiceDeviceService.getDeviceById(id);
    
    console.log(`GET /api/voice/devices/${id} - Successfully fetched device: ${device.name}`);
    res.status(200).json({
      success: true,
      device: device
    });
  } catch (error) {
    console.error('%s', `GET /api/voice/devices/${id} - Error:`, error.message);
    console.error(error.stack);
    
    const statusCode = error.message === 'Voice device not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to fetch voice device'
    });
  }
});

router.get('/devices/:id/interactions', admin, async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isObjectIdOrHexString(id)) {
    return res.status(400).json({ success: false, message: 'Invalid voice device id' });
  }

  try {
    const device = await VoiceDevice.findById(id).select('_id name room').lean();
    if (!device) {
      return res.status(404).json({ success: false, message: 'Voice device not found' });
    }
    const limit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit || '25'), 10) || 25));
    const interactions = await VoiceCommand.find({ deviceId: id })
      .select('-llmProcessing.prompt -llmProcessing.rawResponse')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      device,
      interactions,
      count: interactions.length
    });
  } catch (error) {
    console.error('GET /api/voice/devices/:id/interactions - Error:', {
      deviceId: String(id),
      error: error.message
    });
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch voice interactions'
    });
  }
});

/**
 * @route GET /api/voice/status
 * @desc Get voice system status
 * @access Private
 */
router.get('/status', requireUser(), async (req, res) => {
  console.log('GET /api/voice/status - Fetching voice system status');
  try {
    const status = await voiceDeviceService.getSystemStatus();
    
    console.log('GET /api/voice/status - Successfully fetched system status');
    res.status(200).json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error('GET /api/voice/status - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get voice system status'
    });
  }
});

/**
 * @route POST /api/voice/browser/transcribe
 * @desc Transcribe short browser-captured audio snippets for dashboard voice fallback
 * @access Private
 */
router.post(['/browser/transcribe', '/browser/transcribe/'], requireUser(), async (req, res) => {
  const {
    audioBase64,
    mimeType = 'audio/webm',
    language = 'en',
    profile = null
  } = req.body || {};

  if (typeof audioBase64 !== 'string' || audioBase64.trim().length === 0) {
    return res.status(400).json({
      success: false,
      message: 'audioBase64 is required'
    });
  }

  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    if (!audioBuffer.length) {
      return res.status(400).json({
        success: false,
        message: 'Decoded audio payload is empty'
      });
    }

    const stt = await speechService.transcribeMediaBuffer({
      audioBuffer,
      mimeType: typeof mimeType === 'string' ? mimeType : 'audio/webm',
      language: typeof language === 'string' ? language : 'en',
      profile: typeof profile === 'string' ? profile : null
    });

    console.log(
      'POST /api/voice/browser/transcribe - Success '
      + `provider=${stt?.provider || 'unknown'} `
      + `model=${stt?.model || 'unknown'} `
      + `device=${stt?.device || 'unknown'} `
      + `computeType=${stt?.computeType || 'unknown'} `
      + `beamSize=${typeof stt?.beamSize === 'number' ? stt.beamSize : 'unknown'} `
      + `tookMs=${typeof stt?.processingTimeMs === 'number' ? Math.round(stt.processingTimeMs) : 'unknown'} `
      + `chars=${typeof stt?.text === 'string' ? stt.text.length : 0}`
    );

    return res.status(200).json({
      success: true,
      stt
    });
  } catch (error) {
    console.error('POST /api/voice/browser/transcribe - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to transcribe browser audio'
    });
  }
});

/**
 * @route POST /api/voice/browser/acknowledgment
 * @desc Fetch a wake-word acknowledgment clip for browser voice UX (prefers pre-generated cache)
 * @access Private
 */
router.post(['/browser/acknowledgment', '/browser/acknowledgment/'], requireUser(), async (req, res) => {
  const wakeWord = typeof req.body?.wakeWord === 'string' && req.body.wakeWord.trim()
    ? req.body.wakeWord.trim()
    : 'anna';

  let fallbackVoiceId = 'default';
  try {
    const settings = await Settings.getSettings();
    const configuredVoiceId = settings?.elevenlabsDefaultVoiceId;
    if (typeof configuredVoiceId === 'string' && configuredVoiceId.trim().length > 0) {
      fallbackVoiceId = configuredVoiceId.trim();
    }
  } catch (_error) {
    // Keep default fallback voice when settings are unavailable.
  }

  try {
    const acknowledgment = await voiceAcknowledgmentService.getRandomAcknowledgment(wakeWord, fallbackVoiceId);
    if (!acknowledgment?.text || !acknowledgment?.voiceId || acknowledgment.voiceId === 'default') {
      return res.status(204).end();
    }

    const cachedAudioPath = await voiceAcknowledgmentService.findCachedAudio(
      acknowledgment.voiceId,
      acknowledgment.text
    );
    if (cachedAudioPath) {
      const stat = await fs.promises.stat(cachedAudioPath);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Acknowledgment-Source', 'cache');
      res.setHeader('X-Acknowledgment-Voice', acknowledgment.voiceId);
      const stream = fs.createReadStream(cachedAudioPath);
      stream.on('error', (streamError) => {
        console.error('POST /api/voice/browser/acknowledgment - Stream error:', streamError.message);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Failed to stream cached acknowledgment'
          });
          return;
        }
        res.end();
      });
      stream.pipe(res);
      return;
    }

    const speech = await elevenLabsService.textToSpeechDetailed(acknowledgment.text, acknowledgment.voiceId);
    const audioBuffer = speech.audioBuffer;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Acknowledgment-Source', speech.cacheHit ? 'elevenlabs-cache' : 'tts');
    res.setHeader('X-Acknowledgment-Voice', acknowledgment.voiceId);
    res.setHeader('X-ElevenLabs-Emotion-Tagging', speech.tagger?.status || 'unknown');
    return res.status(200).send(audioBuffer);
  } catch (error) {
    console.error('POST /api/voice/browser/acknowledgment - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to get browser acknowledgment audio'
    });
  }
});

async function handleBrowserResponseAudio(req, res) {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const wakeWord = typeof req.body?.wakeWord === 'string' ? req.body.wakeWord.trim() : '';
  const requestedVoiceId = typeof req.body?.voiceId === 'string' ? req.body.voiceId.trim() : '';

  if (!text) {
    return res.status(400).json({
      success: false,
      message: 'Text is required for browser response audio'
    });
  }

  if (text.length > 5000) {
    return res.status(400).json({
      success: false,
      message: 'Text is too long. Maximum 5000 characters allowed.'
    });
  }

  let fallbackVoiceId = requestedVoiceId;
  try {
    const settings = await Settings.getSettings();
    const configuredVoiceId = settings?.elevenlabsDefaultVoiceId;
    if (!fallbackVoiceId && typeof configuredVoiceId === 'string' && configuredVoiceId.trim().length > 0) {
      fallbackVoiceId = configuredVoiceId.trim();
    }
  } catch (_error) {
    // Keep the requested voice when settings are unavailable.
  }

  let profile = null;
  try {
    profile = await voiceAcknowledgmentService.resolveProfileForWakeWord(wakeWord);
  } catch (error) {
    console.warn('POST /api/voice/browser/response-audio - Wake-word profile lookup failed:', error.message);
  }

  const voiceId = profile?.voiceId || fallbackVoiceId;
  if (!voiceId || voiceId === 'default') {
    return res.status(204).end();
  }

  try {
    const cachedAudioPath = await voiceAcknowledgmentService.findCachedAudio(voiceId, text);
    if (cachedAudioPath) {
      const stat = await fs.promises.stat(cachedAudioPath);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Browser-Voice-Source', profile ? 'wake-word-profile-cache' : 'fallback-cache');
      res.setHeader('X-Browser-Voice-Id', voiceId);
      const stream = fs.createReadStream(cachedAudioPath);
      stream.on('error', (streamError) => {
        console.error('POST /api/voice/browser/response-audio - Stream error:', streamError.message);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Failed to stream cached response audio'
          });
          return;
        }
        res.end();
      });
      stream.pipe(res);
      return;
    }

    const speech = await elevenLabsService.textToSpeechDetailed(text, voiceId);
    const audioBuffer = speech.audioBuffer;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Browser-Voice-Source', profile ? 'wake-word-profile-tts' : 'fallback-tts');
    res.setHeader('X-Browser-Voice-Id', voiceId);
    res.setHeader('X-ElevenLabs-Cache', speech.cacheHit ? 'hit' : 'miss');
    res.setHeader('X-ElevenLabs-Model', speech.modelId || 'unknown');
    res.setHeader('X-ElevenLabs-Emotion-Tagging', speech.tagger?.status || 'unknown');
    return res.status(200).send(audioBuffer);
  } catch (error) {
    console.error('POST /api/voice/browser/response-audio - Error:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate browser response audio'
    });
  }
}

/**
 * @route POST /api/voice/browser/response-audio
 * @desc Resolve browser voice response audio by wake word on the server
 * @access Private
 */
router.post(
  ['/browser/response-audio', '/browser/response-audio/'],
  browserVoiceAudioRateLimit,
  requireUser(),
  handleBrowserResponseAudio
);

/**
 * @route POST /api/voice/commands/interpret
 * @desc Interpret and execute a voice command via HTTP (dashboard testing)
 * @access Private
 */
router.post('/commands/interpret', requireUser(), async (req, res) => {
  const {
    commandText,
    room = null,
    wakeWord = 'dashboard',
    deviceId = null,
    stt = null
  } = req.body || {};

  console.log('POST /api/voice/commands/interpret - Processing voice command via HTTP');

  if (!commandText || !commandText.trim()) {
    console.warn('POST /api/voice/commands/interpret - Missing commandText in request body');
    return res.status(400).json({
      success: false,
      message: 'commandText is required'
    });
  }

  try {
    const result = await voiceCommandService.processCommand({
      commandText: commandText.trim(),
      room: typeof room === 'string' && room.trim() ? room.trim() : null,
      wakeWord: typeof wakeWord === 'string' && wakeWord.trim() ? wakeWord.trim() : 'dashboard',
      deviceId: typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim() : null,
      stt: stt || null,
      userRole: req.user?.role
    });

    const llmProvider = result?.llm?.provider || 'unknown';
    const llmModel = result?.llm?.model || 'unknown';
    const llmMs = typeof result?.llm?.processingTimeMs === 'number' ? result.llm.processingTimeMs : null;
    const runtimeLabel = result?.llm?.runtime?.processor
      ? ` runtime=${result.llm.runtime.processor}`
      : '';
    const runtimeModelLabel = result?.llm?.runtime?.model
      ? ` runtimeModel=${result.llm.runtime.model}`
      : '';
    const llmTimingLabel = llmMs !== null ? ` llmMs=${llmMs}` : '';
    console.log(
      `POST /api/voice/commands/interpret - Success provider=${llmProvider} model=${llmModel}${llmTimingLabel}${runtimeLabel}${runtimeModelLabel} fallback=${result?.usedFallback ? 'yes' : 'no'}`
    );

    void eventStreamService.publishSafe({
      type: 'voice.command_processed',
      source: 'voice',
      category: 'voice',
      actorUserId: req.user?._id,
      payload: {
        wakeWord: typeof wakeWord === 'string' ? wakeWord : 'dashboard',
        room: typeof room === 'string' ? room : null,
        deviceId: typeof deviceId === 'string' ? deviceId : null
      },
      tags: ['voice', 'command']
    });

    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('POST /api/voice/commands/interpret - Error:', error.message);
    console.error(error.stack);

    void eventStreamService.publishSafe({
      type: 'voice.command_failed',
      source: 'voice',
      category: 'voice',
      severity: 'error',
      actorUserId: req.user?._id,
      payload: {
        wakeWord: typeof wakeWord === 'string' ? wakeWord : 'dashboard',
        room: typeof room === 'string' ? room : null,
        deviceId: typeof deviceId === 'string' ? deviceId : null,
        error: error.message || 'Unknown error'
      },
      tags: ['voice', 'command']
    });

    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to process voice command'
    });
  }
});

/**
 * @route POST /api/voice/test
 * @desc Test voice device connectivity and functionality
 * @access Private
 */
router.post('/test', voiceDiagnosticsRateLimit, admin, async (req, res) => {
  const { deviceId } = req.body;
  console.log(`POST /api/voice/test - Testing voice device: ${deviceId}`);
  
  if (!deviceId) {
    console.warn('POST /api/voice/test - Missing deviceId in request body');
    return res.status(400).json({
      success: false,
      message: 'Device ID is required'
    });
  }

  try {
    const testResult = await voiceDeviceService.testDevice(deviceId, {
      websocketStats: collectVoiceWebSocketStats(req.app)
    });
    
    console.log('%s', `POST /api/voice/test - Test completed for device ${deviceId}:`, testResult.success ? 'PASSED' : 'FAILED');
    res.status(200).json({
      success: testResult.success,
      message: testResult.message,
      deviceName: testResult.deviceName,
      room: testResult.room,
      testResults: testResult.testResults,
      diagnostics: testResult.diagnostics
    });
  } catch (error) {
    console.error('POST /api/voice/test - Error testing device:', {
      deviceId,
      error: error.message
    });
    console.error(error.stack);
    
    const statusCode = error.message === 'Voice device not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to test voice device'
    });
  }
});

router.post('/devices/:id/diagnostics', voiceDiagnosticsRateLimit, admin, async (req, res) => {
  const { id } = req.params;
  console.log(`POST /api/voice/devices/${id}/diagnostics - Diagnosing voice device`);

  try {
    const result = await voiceDeviceService.diagnoseDevice(id, {
      websocketStats: collectVoiceWebSocketStats(req.app)
    });

    return res.status(200).json({
      success: result.success,
      message: result.message,
      deviceName: result.deviceName,
      room: result.room,
      testResults: result.testResults,
      diagnostics: result.diagnostics
    });
  } catch (error) {
    console.error('POST /api/voice/devices/:id/diagnostics - Error:', {
      deviceId: id,
      error: error.message
    });
    const statusCode = error.message === 'Voice device not found' ? 404 : 500;
    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to diagnose voice device'
    });
  }
});

/**
 * @route PUT /api/voice/devices/:id/status
 * @desc Update voice device status
 * @access Private
 */
router.put('/devices/:id/status', admin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  console.log(`PUT /api/voice/devices/${id}/status - Updating device status to: ${status}`);
  
  if (!status) {
    console.warn(`PUT /api/voice/devices/${id}/status - Missing status in request body`);
    return res.status(400).json({
      success: false,
      message: 'Status is required'
    });
  }

  const validStatuses = ['online', 'offline', 'error', 'updating'];
  if (!validStatuses.includes(status)) {
    console.warn(`PUT /api/voice/devices/${id}/status - Invalid status: ${status}`);
    return res.status(400).json({
      success: false,
      message: `Status must be one of: ${validStatuses.join(', ')}`
    });
  }

  try {
    const device = await voiceDeviceService.updateDeviceStatus(id, status);
    
    console.log(`PUT /api/voice/devices/${id}/status - Successfully updated device ${device.name} status to ${status}`);
    res.status(200).json({
      success: true,
      message: `Device status updated to ${status}`,
      device: device
    });
  } catch (error) {
    console.error('%s', `PUT /api/voice/devices/${id}/status - Error:`, error.message);
    console.error(error.stack);
    
    const statusCode = error.message === 'Voice device not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to update device status'
    });
  }
});

/**
 * @route GET /api/voice/devices/room/:room
 * @desc Get voice devices by room
 * @access Private
 */
router.get('/devices/room/:room', requireUser(), async (req, res) => {
  const { room } = req.params;
  console.log(`GET /api/voice/devices/room/${room} - Fetching devices in room`);
  
  try {
    const devices = await voiceDeviceService.getDevicesByRoom(room);
    
    console.log(`GET /api/voice/devices/room/${room} - Successfully fetched ${devices.length} devices`);
    res.status(200).json({
      success: true,
      devices: devices,
      room: room,
      count: devices.length
    });
  } catch (error) {
    console.error('%s', `GET /api/voice/devices/room/${room} - Error:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch devices by room'
    });
  }
});

/**
 * @route GET /api/voice/devices/status/:status
 * @desc Get voice devices by status
 * @access Private
 */
router.get('/devices/status/:status', requireUser(), async (req, res) => {
  const { status } = req.params;
  console.log(`GET /api/voice/devices/status/${status} - Fetching devices with status`);
  
  const validStatuses = ['online', 'offline', 'error', 'updating'];
  if (!validStatuses.includes(status)) {
    console.warn(`GET /api/voice/devices/status/${status} - Invalid status parameter`);
    return res.status(400).json({
      success: false,
      message: `Status must be one of: ${validStatuses.join(', ')}`
    });
  }

  try {
    const devices = await voiceDeviceService.getDevicesByStatus(status);
    
    console.log(`GET /api/voice/devices/status/${status} - Successfully fetched ${devices.length} devices`);
    res.status(200).json({
      success: true,
      devices: devices,
      status: status,
      count: devices.length
    });
  } catch (error) {
    console.error('%s', `GET /api/voice/devices/status/${status} - Error:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch devices by status'
    });
  }
});

// Push updated wake word config to a specific device
router.post('/devices/:id/push-config', admin, async (req, res) => {
  const { id } = req.params;
  try {
    const app = req.app;
    const wsHttps = app.get('voiceWebSocket');
    const wsHttp = app.get('voiceWebSocketHttp');
    const tryPush = async (ws) => ws && typeof ws.pushConfigToDevice === 'function' ? await ws.pushConfigToDevice(id) : { success: false, error: 'WS instance unavailable' };
    let result = await tryPush(wsHttps);
    if (!result.success) {
      result = await tryPush(wsHttp);
    }
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.error || 'Failed to push config' });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('POST /api/voice/devices/:id/push-config - Error:', error.message);
    return res.status(500).json({ success: false, message: error.message || 'Failed to push config' });
  }
});

// Send a test TTS ping to a specific device
router.post('/devices/:id/ping-tts', admin, async (req, res) => {
  const { id } = req.params;
  const { text } = req.body || {};
  try {
    const app = req.app;
    const wsHttps = app.get('voiceWebSocket');
    const wsHttp = app.get('voiceWebSocketHttp');
    const tryPing = async (ws) => ws && typeof ws.playTtsToDevice === 'function' ? await ws.playTtsToDevice(id, text || 'Ping from hub') : { success: false, error: 'WS instance unavailable' };
    let result = await tryPing(wsHttps);
    if (!result.success) {
      result = await tryPing(wsHttp);
    }
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.error || 'Failed to send TTS' });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('POST /api/voice/devices/:id/ping-tts - Error:', error.message);
    return res.status(500).json({ success: false, message: error.message || 'Failed to send TTS' });
  }
});

// Update per-device settings (e.g., wake-word sensitivity)
router.put('/devices/:id/settings', admin, async (req, res) => {
  const { id } = req.params;
  const updates = req.body || {};
  try {
    const device = await VoiceDevice.findById(id);
    if (!device) {
      return res.status(404).json({ success: false, message: 'Voice device not found' });
    }

    const clampValue = (value, min, max) => Math.min(Math.max(value, min), max);
    const sanitizeWakeWordVad = (value = {}) => {
      const next = {};
      if (typeof value.speechThreshold === 'number' && Number.isFinite(value.speechThreshold)) {
        next.speechThreshold = clampValue(value.speechThreshold, 0, 1);
      }
      if (typeof value.history === 'number' && Number.isFinite(value.history)) {
        next.history = Math.max(1, Math.min(32, Math.round(value.history)));
      }
      if (typeof value.minActivations === 'number' && Number.isFinite(value.minActivations)) {
        next.minActivations = Math.max(1, Math.min(32, Math.round(value.minActivations)));
      }
      if (typeof value.mode === 'number' && Number.isFinite(value.mode)) {
        next.mode = Math.max(0, Math.min(3, Math.round(value.mode)));
      }
      if (typeof value.minRms === 'number' && Number.isFinite(value.minRms)) {
        next.minRms = value.minRms > 0
          ? clampValue(value.minRms, DEFAULT_WAKE_WORD_MIN_RMS, MAX_WAKE_WORD_MIN_RMS)
          : DEFAULT_WAKE_WORD_MIN_RMS;
      }
      return next;
    };
    const sanitizeVoiceTuning = (value = {}) => {
      const next = {};
      const boundedNumber = (key, min, max, round = false) => {
        const candidate = value[key];
        if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return;
        const bounded = clampValue(candidate, min, max);
        next[key] = round ? Math.round(bounded) : bounded;
      };
      boundedNumber('wakeConfirmationMs', 80, 1000, true);
      boundedNumber('wakeMinScoreHits', 1, 6, true);
      boundedNumber('wakeThresholdOffset', -0.2, 0.2);
      boundedNumber('commandPreRollMs', 500, 5000, true);
      boundedNumber('commandMaxDurationMs', 3000, 20000, true);
      boundedNumber('commandMinCaptureMs', 300, 3000, true);
      boundedNumber('commandSilenceMs', 250, 5000, true);
      boundedNumber('commandSpeechStartTimeoutMs', 1000, 10000, true);
      boundedNumber('commandMinSpeechMs', 40, 1000, true);
      boundedNumber('commandMinRms', 0.0005, 0.05);
      for (const key of ['silentEmptyWakes', 'backgroundGuardEnabled']) {
        if (typeof value[key] === 'boolean') next[key] = value[key];
      }
      return next;
    };
    const { volume, microphoneSensitivity, ...settingsUpdates } = updates || {};

    if (typeof volume === 'number' && Number.isFinite(volume)) {
      device.volume = clampValue(volume, 0, 100);
    }

    if (typeof microphoneSensitivity === 'number' && Number.isFinite(microphoneSensitivity)) {
      device.microphoneSensitivity = clampValue(microphoneSensitivity, 0, 100);
    }

    const nextSettings = { ...(device.settings || {}) };
    if (settingsUpdates && typeof settingsUpdates === 'object') {
      if (settingsUpdates.wakeWordVad && typeof settingsUpdates.wakeWordVad === 'object') {
        nextSettings.wakeWordVad = {
          ...(nextSettings.wakeWordVad || {}),
          ...sanitizeWakeWordVad(settingsUpdates.wakeWordVad)
        };
        delete settingsUpdates.wakeWordVad;
      }
      if (settingsUpdates.voiceTuning && typeof settingsUpdates.voiceTuning === 'object') {
        nextSettings.voiceTuning = {
          ...(nextSettings.voiceTuning || {}),
          ...sanitizeVoiceTuning(settingsUpdates.voiceTuning)
        };
        delete settingsUpdates.voiceTuning;
      }

      device.settings = {
        ...nextSettings,
        ...settingsUpdates
      };
    } else {
      device.settings = nextSettings;
    }

    await device.save();

    // Push updated config to device if connected
    try {
      const app = req.app;
      const wsHttps = app.get('voiceWebSocket');
      const wsHttp = app.get('voiceWebSocketHttp');
      const tryPush = async (ws) => ws && typeof ws.pushConfigToDevice === 'function' ? await ws.pushConfigToDevice(id) : { success: false };
      let result = await tryPush(wsHttps);
      if (!result.success) result = await tryPush(wsHttp);
    } catch (_) {}

    return res.status(200).json({ success: true, device });
  } catch (error) {
    console.error('PUT /api/voice/devices/:id/settings - Error:', error.message);
    return res.status(500).json({ success: false, message: error.message || 'Failed to update device settings' });
  }
});

module.exports = router;

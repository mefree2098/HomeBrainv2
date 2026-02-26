const express = require('express');
const router = express.Router();
const voiceDeviceService = require('../services/voiceDeviceService');
const voiceCommandService = require('../services/voiceCommandService');
const speechService = require('../services/speechService');
const { requireUser } = require('./middlewares/auth');
const voiceWs = require('../websocket/voiceWebSocket');
const VoiceDevice = require('../models/VoiceDevice');
const eventStreamService = require('../services/eventStreamService');

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
    console.error(`GET /api/voice/devices/${id} - Error:`, error.message);
    console.error(error.stack);
    
    const statusCode = error.message === 'Voice device not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to fetch voice device'
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
    language = 'en'
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
      language: typeof language === 'string' ? language : 'en'
    });

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
      stt: stt || null
    });

    void eventStreamService.publishSafe({
      type: 'voice.command_processed',
      source: 'voice',
      category: 'voice',
      payload: {
        wakeWord: typeof wakeWord === 'string' ? wakeWord : 'dashboard',
        room: typeof room === 'string' ? room : null,
        deviceId: typeof deviceId === 'string' ? deviceId : null,
        command: commandText.trim(),
        responseText: result?.responseText || null
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
      payload: {
        wakeWord: typeof wakeWord === 'string' ? wakeWord : 'dashboard',
        room: typeof room === 'string' ? room : null,
        deviceId: typeof deviceId === 'string' ? deviceId : null,
        command: commandText.trim(),
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
router.post('/test', requireUser(), async (req, res) => {
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
    const testResult = await voiceDeviceService.testDevice(deviceId);
    
    console.log(`POST /api/voice/test - Test completed for device ${deviceId}:`, testResult.success ? 'PASSED' : 'FAILED');
    res.status(200).json({
      success: testResult.success,
      message: testResult.message,
      deviceName: testResult.deviceName,
      room: testResult.room,
      testResults: testResult.testResults
    });
  } catch (error) {
    console.error(`POST /api/voice/test - Error testing device ${deviceId}:`, error.message);
    console.error(error.stack);
    
    const statusCode = error.message === 'Voice device not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to test voice device'
    });
  }
});

/**
 * @route PUT /api/voice/devices/:id/status
 * @desc Update voice device status
 * @access Private
 */
router.put('/devices/:id/status', requireUser(), async (req, res) => {
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
    console.error(`PUT /api/voice/devices/${id}/status - Error:`, error.message);
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
    console.error(`GET /api/voice/devices/room/${room} - Error:`, error.message);
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
    console.error(`GET /api/voice/devices/status/${status} - Error:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch devices by status'
    });
  }
});

// Push updated wake word config to a specific device
router.post('/devices/:id/push-config', requireUser(), async (req, res) => {
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
router.post('/devices/:id/ping-tts', requireUser(), async (req, res) => {
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
router.put('/devices/:id/settings', requireUser(), async (req, res) => {
  const { id } = req.params;
  const updates = req.body || {};
  try {
    const device = await VoiceDevice.findById(id);
    if (!device) {
      return res.status(404).json({ success: false, message: 'Voice device not found' });
    }

    const clampValue = (value, min, max) => Math.min(Math.max(value, min), max);
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
          ...settingsUpdates.wakeWordVad
        };
        delete settingsUpdates.wakeWordVad;
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

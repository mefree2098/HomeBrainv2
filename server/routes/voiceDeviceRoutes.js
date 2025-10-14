const express = require('express');
const router = express.Router();
const voiceDeviceService = require('../services/voiceDeviceService');
const { requireUser } = require('./middlewares/auth');
const voiceWs = require('../websocket/voiceWebSocket');

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
    const ws = app.get('voiceWebSocket');
    if (!ws || typeof ws.pushConfigToDevice !== 'function') {
      return res.status(503).json({ success: false, message: 'Voice WebSocket unavailable' });
    }
    const result = await ws.pushConfigToDevice(id);
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
    const ws = app.get('voiceWebSocket');
    if (!ws || typeof ws.playTtsToDevice !== 'function') {
      return res.status(503).json({ success: false, message: 'Voice WebSocket unavailable' });
    }
    const result = ws.playTtsToDevice(id, text || 'Ping from hub');
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.error || 'Failed to send TTS' });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('POST /api/voice/devices/:id/ping-tts - Error:', error.message);
    return res.status(500).json({ success: false, message: error.message || 'Failed to send TTS' });
  }
});

module.exports = router;
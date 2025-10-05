const express = require('express');
const router = express.Router();
const insteonService = require('../services/insteonService');
const { requireUser } = require('./middlewares/auth');

// Apply authentication to all routes
router.use(requireUser());

// Description: Test Insteon PLM connection
// Endpoint: GET /api/insteon/test
// Request: {}
// Response: { success: boolean, message: string, connected: boolean, plmInfo?: object }
router.get('/test', async (req, res) => {
  console.log('InsteonRoutes: Testing PLM connection');

  try {
    const result = await insteonService.testConnection();
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Connection test failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message,
      connected: false
    });
  }
});

// Description: Get Insteon PLM information
// Endpoint: GET /api/insteon/info
// Request: {}
// Response: { success: boolean, plmInfo: object }
router.get('/info', async (req, res) => {
  console.log('InsteonRoutes: Getting PLM info');

  try {
    const plmInfo = await insteonService.getPLMInfo();
    res.status(200).json({
      success: true,
      plmInfo
    });
  } catch (error) {
    console.error('InsteonRoutes: Failed to get PLM info:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Get PLM connection status
// Endpoint: GET /api/insteon/status
// Request: {}
// Response: { connected: boolean, deviceCount: number, connectionAttempts: number }
router.get('/status', async (req, res) => {
  console.log('InsteonRoutes: Getting PLM status');

  try {
    const status = insteonService.getStatus();
    res.status(200).json(status);
  } catch (error) {
    console.error('InsteonRoutes: Failed to get PLM status:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Connect to Insteon PLM
// Endpoint: POST /api/insteon/connect
// Request: {}
// Response: { success: boolean, message: string, port: string }
router.post('/connect', async (req, res) => {
  console.log('InsteonRoutes: Connecting to PLM');

  try {
    const result = await insteonService.connect();
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Connection failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Disconnect from Insteon PLM
// Endpoint: POST /api/insteon/disconnect
// Request: {}
// Response: { success: boolean, message: string }
router.post('/disconnect', async (req, res) => {
  console.log('InsteonRoutes: Disconnecting from PLM');

  try {
    const result = await insteonService.disconnect();
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Disconnection failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Get all devices linked to PLM
// Endpoint: GET /api/insteon/devices/linked
// Request: {}
// Response: { success: boolean, devices: Array<object> }
router.get('/devices/linked', async (req, res) => {
  console.log('InsteonRoutes: Getting all linked devices');

  try {
    const devices = await insteonService.getAllLinkedDevices();
    res.status(200).json({
      success: true,
      count: devices.length,
      devices
    });
  } catch (error) {
    console.error('InsteonRoutes: Failed to get linked devices:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message,
      devices: []
    });
  }
});

// Description: Import all devices from PLM to database
// Endpoint: POST /api/insteon/devices/import
// Request: {}
// Response: { success: boolean, message: string, imported: number, skipped: number, errors: number, devices: Array<object> }
router.post('/devices/import', async (req, res) => {
  console.log('InsteonRoutes: Importing devices from PLM');

  try {
    const result = await insteonService.importDevices();
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Device import failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message,
      imported: 0,
      skipped: 0,
      errors: 0
    });
  }
});

// Description: Scan all Insteon devices and update their status
// Endpoint: POST /api/insteon/devices/scan
// Request: {}
// Response: { success: boolean, message: string, results: object }
router.post('/devices/scan', async (req, res) => {
  console.log('InsteonRoutes: Scanning all Insteon devices');

  try {
    const result = await insteonService.scanAllDevices();
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Device scan failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Get specific device status from PLM
// Endpoint: GET /api/insteon/devices/:deviceId/status
// Request: { deviceId: string }
// Response: { success: boolean, status: boolean, brightness: number, level: number, isOnline: boolean }
router.get('/devices/:deviceId/status', async (req, res) => {
  const { deviceId } = req.params;
  console.log(`InsteonRoutes: Getting status for device ${deviceId}`);

  try {
    const status = await insteonService.getDeviceStatus(deviceId);
    res.status(200).json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error(`InsteonRoutes: Failed to get device ${deviceId} status:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Turn device on
// Endpoint: POST /api/insteon/devices/:deviceId/on
// Request: { deviceId: string, brightness?: number }
// Response: { success: boolean, message: string, status: boolean, brightness: number }
router.post('/devices/:deviceId/on', async (req, res) => {
  const { deviceId } = req.params;
  const { brightness = 100 } = req.body;

  console.log(`InsteonRoutes: Turning on device ${deviceId} at ${brightness}%`);

  try {
    const result = await insteonService.turnOn(deviceId, brightness);
    res.status(200).json(result);
  } catch (error) {
    console.error(`InsteonRoutes: Failed to turn on device ${deviceId}:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Turn device off
// Endpoint: POST /api/insteon/devices/:deviceId/off
// Request: { deviceId: string }
// Response: { success: boolean, message: string, status: boolean, brightness: number }
router.post('/devices/:deviceId/off', async (req, res) => {
  const { deviceId } = req.params;
  console.log(`InsteonRoutes: Turning off device ${deviceId}`);

  try {
    const result = await insteonService.turnOff(deviceId);
    res.status(200).json(result);
  } catch (error) {
    console.error(`InsteonRoutes: Failed to turn off device ${deviceId}:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Set device brightness
// Endpoint: POST /api/insteon/devices/:deviceId/brightness
// Request: { deviceId: string, brightness: number }
// Response: { success: boolean, message: string, status: boolean, brightness: number }
router.post('/devices/:deviceId/brightness', async (req, res) => {
  const { deviceId } = req.params;
  const { brightness } = req.body;

  console.log(`InsteonRoutes: Setting device ${deviceId} brightness to ${brightness}%`);

  if (brightness === undefined || brightness < 0 || brightness > 100) {
    return res.status(400).json({
      success: false,
      message: 'Brightness must be between 0 and 100'
    });
  }

  try {
    const result = await insteonService.setBrightness(deviceId, brightness);
    res.status(200).json(result);
  } catch (error) {
    console.error(`InsteonRoutes: Failed to set device ${deviceId} brightness:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Link new device to PLM
// Endpoint: POST /api/insteon/devices/link
// Request: { timeout?: number }
// Response: { success: boolean, message: string, address?: string, group?: number, type?: string }
router.post('/devices/link', async (req, res) => {
  const { timeout = 30 } = req.body;
  console.log(`InsteonRoutes: Starting device linking (timeout: ${timeout}s)`);

  try {
    const result = await insteonService.linkDevice(timeout);
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Device linking failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Unlink device from PLM and remove from database
// Endpoint: DELETE /api/insteon/devices/:deviceId/unlink
// Request: { deviceId: string }
// Response: { success: boolean, message: string }
router.delete('/devices/:deviceId/unlink', async (req, res) => {
  const { deviceId } = req.params;
  console.log(`InsteonRoutes: Unlinking device ${deviceId}`);

  try {
    const result = await insteonService.unlinkDevice(deviceId);
    res.status(200).json(result);
  } catch (error) {
    console.error(`InsteonRoutes: Failed to unlink device ${deviceId}:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Delete device from database only (keep in PLM)
// Endpoint: DELETE /api/insteon/devices/:deviceId
// Request: { deviceId: string }
// Response: { success: boolean, message: string }
router.delete('/devices/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  console.log(`InsteonRoutes: Deleting device ${deviceId} from database`);

  try {
    const result = await insteonService.deleteDevice(deviceId);
    res.status(200).json(result);
  } catch (error) {
    console.error(`InsteonRoutes: Failed to delete device ${deviceId}:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;

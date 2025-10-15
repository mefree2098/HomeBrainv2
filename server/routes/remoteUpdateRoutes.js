const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const remoteUpdateService = require('../services/remoteUpdateService');
const path = require('path');
const os = require('os');

// Description: Get current remote device software version
// Endpoint: GET /api/remote-updates/version
// Request: {}
// Response: { version: string }
router.get('/version', requireUser(), async (req, res) => {
  console.log('GET /api/remote-updates/version - Fetching current version');

  try {
    const version = remoteUpdateService.getCurrentVersion();

    res.status(200).json({
      success: true,
      version: version
    });

  } catch (error) {
    console.error('GET /api/remote-updates/version - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch version'
    });
  }
});

// Description: Check for updates for a specific device
// Endpoint: GET /api/remote-updates/check/:deviceId
// Request: {}
// Response: { updateAvailable: boolean, currentVersion: string, latestVersion: string, deviceName: string }
router.get('/check/:deviceId', requireUser(), async (req, res) => {
  const { deviceId } = req.params;
  console.log(`GET /api/remote-updates/check/${deviceId} - Checking for updates`);

  try {
    const result = await remoteUpdateService.checkForUpdates(deviceId);

    res.status(200).json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error(`GET /api/remote-updates/check/${deviceId} - Error:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to check for updates'
    });
  }
});

// Description: Generate update package
// Endpoint: POST /api/remote-updates/generate-package
// Request: {}
// Response: { success: boolean, version: string, packageName: string, checksum: string }
router.post('/generate-package', requireUser(), async (req, res) => {
  console.log('POST /api/remote-updates/generate-package - Generating update package');

  try {
    const force = Boolean(req.body?.force);
    const packageInfo = await remoteUpdateService.generateUpdatePackage(force);

    console.log('POST /api/remote-updates/generate-package - Package generated successfully');
    res.status(200).json({
      success: true,
      ...packageInfo
    });

  } catch (error) {
    console.error('POST /api/remote-updates/generate-package - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate update package'
    });
  }
});

// Description: Get update package information
// Endpoint: GET /api/remote-updates/package-info
// Request: {}
// Response: { success: boolean, version?: string, packageName?: string, size?: number, checksum?: string, downloadUrl?: string }
router.get('/package-info', requireUser(), async (req, res) => {
  console.log('GET /api/remote-updates/package-info - Fetching package information');

  try {
    const packageInfo = await remoteUpdateService.getUpdatePackageInfo();

    if (!packageInfo) {
      return res.status(404).json({
        success: false,
        message: 'Update package not found'
      });
    }

    res.status(200).json({
      success: true,
      ...packageInfo
    });

  } catch (error) {
    console.error('GET /api/remote-updates/package-info - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch package information'
    });
  }
});

// Description: Initiate update for a specific device
// Endpoint: POST /api/remote-updates/initiate/:deviceId
// Request: {}
// Response: { success: boolean, device: string, version: string, message: string }
router.post('/initiate/:deviceId', requireUser(), async (req, res) => {
  const { deviceId } = req.params;
  console.log(`POST /api/remote-updates/initiate/${deviceId} - Initiating update`);

  try {
    // Get WebSocket server instances from app (try both HTTP and HTTPS)
    const wsPrimary = req.app.get('voiceWebSocket');
    const wsHttp = req.app.get('voiceWebSocketHttp');
    const wsHttps = req.app.get('voiceWebSocketHttps');
    const sockets = [wsPrimary, wsHttp, wsHttps].filter(Boolean);

    // Build a device-safe base URL. Avoid localhost/127.0.0.1 which are not reachable from the device.
    const hostHeader = req.get('host') || '';
    const parts = hostHeader.split(':');
    const hostName = parts[0] || 'localhost';
    const port = parts[1] || String(process.env.PORT || 3000);
    const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostName);

    let lanIp = null;
    if (isLoopback) {
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const iface of nets[name] || []) {
          if (iface.family === 'IPv4' && !iface.internal) {
            lanIp = iface.address;
            break;
          }
        }
        if (lanIp) break;
      }
    }

    const baseUrl = isLoopback && lanIp
      ? `http://${lanIp}:${port}`
      : `${req.protocol}://${hostHeader}`;

    const result = await remoteUpdateService.initiateUpdate(deviceId, sockets, { force: Boolean(req.body?.force), baseUrl });

    console.log(`POST /api/remote-updates/initiate/${deviceId} - Update initiated successfully`);
    res.status(200).json(result);

  } catch (error) {
    console.error(`POST /api/remote-updates/initiate/${deviceId} - Error:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to initiate update'
    });
  }
});

// Description: Initiate update for all devices
// Endpoint: POST /api/remote-updates/initiate-all
// Request: {}
// Response: { success: boolean, totalDevices: number, initiated: number, failed: number, results: Array }
router.post('/initiate-all', requireUser(), async (req, res) => {
  console.log('POST /api/remote-updates/initiate-all - Initiating update for all devices');

  try {
    // Get WebSocket server instance from app
    const voiceWebSocket = req.app.get('voiceWebSocket');

    const result = await remoteUpdateService.initiateUpdateForAll(voiceWebSocket);

    console.log('POST /api/remote-updates/initiate-all - Update initiated for all devices');
    res.status(200).json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('POST /api/remote-updates/initiate-all - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to initiate update for all devices'
    });
  }
});

// Description: Get update statistics
// Endpoint: GET /api/remote-updates/statistics
// Request: {}
// Response: { success: boolean, totalDevices: number, currentVersion: string, upToDate: number, outdated: number, updating: number, offline: number, byVersion: object }
router.get('/statistics', requireUser(), async (req, res) => {
  console.log('GET /api/remote-updates/statistics - Fetching update statistics');

  try {
    const stats = await remoteUpdateService.getUpdateStatistics();

    res.status(200).json({
      success: true,
      ...stats
    });

  } catch (error) {
    console.error('GET /api/remote-updates/statistics - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch update statistics'
    });
  }
});

// Description: Get list of devices needing update
// Endpoint: GET /api/remote-updates/devices-needing-update
// Request: {}
// Response: { success: boolean, devices: Array<{ id, name, room, currentVersion, latestVersion, status, lastSeen }> }
router.get('/devices-needing-update', requireUser(), async (req, res) => {
  console.log('GET /api/remote-updates/devices-needing-update - Fetching devices needing update');

  try {
    const devices = await remoteUpdateService.getDevicesNeedingUpdate();

    res.status(200).json({
      success: true,
      devices: devices
    });

  } catch (error) {
    console.error('GET /api/remote-updates/devices-needing-update - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch devices needing update'
    });
  }
});

module.exports = router;

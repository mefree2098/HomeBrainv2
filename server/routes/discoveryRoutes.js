const express = require('express');
const router = express.Router();
const VoiceDevice = require('../models/VoiceDevice');
const { requireUser } = require('./middlewares/auth');

// Import discovery service (will be injected by server.js)
let discoveryService = null;

// Middleware to inject discovery service
router.use((req, res, next) => {
  if (req.app.locals.discoveryService) {
    discoveryService = req.app.locals.discoveryService;
  }
  next();
});

// Description: Enable/disable auto-discovery service
// Endpoint: POST /api/discovery/toggle
// Request: { enabled: boolean }
// Response: { success: boolean, enabled: boolean, message: string }
router.post('/toggle', requireUser(), async (req, res) => {
  console.log('POST /api/discovery/toggle - Toggling auto-discovery service');

  try {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      console.warn('POST /api/discovery/toggle - Invalid enabled parameter');
      return res.status(400).json({
        success: false,
        message: 'enabled parameter must be a boolean'
      });
    }

    if (!discoveryService) {
      console.error('POST /api/discovery/toggle - Discovery service not available');
      return res.status(500).json({
        success: false,
        message: 'Discovery service not available'
      });
    }

    if (enabled && !discoveryService.isRunning()) {
      discoveryService.start();
      console.log('POST /api/discovery/toggle - Auto-discovery service started');
    } else if (!enabled && discoveryService.isRunning()) {
      discoveryService.stop();
      console.log('POST /api/discovery/toggle - Auto-discovery service stopped');
    }

    res.status(200).json({
      success: true,
      enabled: discoveryService.isRunning(),
      message: `Auto-discovery ${discoveryService.isRunning() ? 'enabled' : 'disabled'}`
    });

  } catch (error) {
    console.error('POST /api/discovery/toggle - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to toggle auto-discovery'
    });
  }
});

// Description: Get auto-discovery service status
// Endpoint: GET /api/discovery/status
// Request: {}
// Response: { success: boolean, stats: object }
router.get('/status', requireUser(), async (req, res) => {
  console.log('GET /api/discovery/status - Getting auto-discovery status');

  try {
    if (!discoveryService) {
      console.warn('GET /api/discovery/status - Discovery service not available');
      return res.status(200).json({
        success: true,
        stats: {
          enabled: false,
          available: false,
          message: 'Discovery service not initialized'
        }
      });
    }

    const stats = discoveryService.getStats();

    console.log('GET /api/discovery/status - Successfully retrieved status');
    res.status(200).json({
      success: true,
      stats: {
        ...stats,
        available: true
      }
    });

  } catch (error) {
    console.error('GET /api/discovery/status - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get discovery status'
    });
  }
});

// Description: Get pending devices awaiting approval
// Endpoint: GET /api/discovery/pending
// Request: {}
// Response: { success: boolean, devices: Array<object>, count: number }
router.get('/pending', requireUser(), async (req, res) => {
  console.log('GET /api/discovery/pending - Getting pending devices');

  try {
    if (!discoveryService) {
      console.warn('GET /api/discovery/pending - Discovery service not available');
      return res.status(200).json({
        success: true,
        devices: [],
        count: 0
      });
    }

    const pendingDevices = discoveryService.getPendingDevices();

    console.log(`GET /api/discovery/pending - Successfully retrieved ${pendingDevices.length} pending devices`);
    res.status(200).json({
      success: true,
      devices: pendingDevices,
      count: pendingDevices.length
    });

  } catch (error) {
    console.error('GET /api/discovery/pending - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to get pending devices'
    });
  }
});

// Description: Approve a pending device
// Endpoint: POST /api/discovery/approve/:deviceId
// Request: { name: string, room: string, deviceType?: string }
// Response: { success: boolean, device: object, message: string }
router.post('/approve/:deviceId', requireUser(), async (req, res) => {
  const { deviceId } = req.params;
  console.log(`POST /api/discovery/approve/${deviceId} - Approving pending device`);

  try {
    const { name, room, deviceType } = req.body;

    if (!name || !room) {
      console.warn(`POST /api/discovery/approve/${deviceId} - Missing required fields`);
      return res.status(400).json({
        success: false,
        message: 'Name and room are required'
      });
    }

    if (!discoveryService) {
      console.error(`POST /api/discovery/approve/${deviceId} - Discovery service not available`);
      return res.status(500).json({
        success: false,
        message: 'Discovery service not available'
      });
    }

    // Approve the pending device
    const approvedDeviceInfo = discoveryService.approvePendingDevice(deviceId, {
      name: name.trim(),
      room: room.trim(),
      deviceType: deviceType || 'speaker'
    });

    // Create the device in database
    const device = new VoiceDevice({
      name: approvedDeviceInfo.name,
      room: approvedDeviceInfo.room,
      deviceType: approvedDeviceInfo.deviceType,
      status: 'offline', // Will become online when device connects
      serialNumber: approvedDeviceInfo.macAddress || approvedDeviceInfo.id,
      ipAddress: approvedDeviceInfo.ipAddress,
      firmwareVersion: approvedDeviceInfo.firmwareVersion,
      supportedWakeWords: ['Anna', 'Henry', 'Home Brain'],
      settings: {
        autoDiscovered: true,
        discoveredAt: approvedDeviceInfo.timestamp,
        approvedAt: approvedDeviceInfo.approvedAt
      }
    });

    await device.save();

    console.log(`POST /api/discovery/approve/${deviceId} - Device ${device.name} approved and created`);
    res.status(200).json({
      success: true,
      device: device,
      message: 'Device approved successfully'
    });

  } catch (error) {
    console.error(`POST /api/discovery/approve/${deviceId} - Error:`, error.message);
    console.error(error.stack);

    const statusCode = error.message === 'Pending device not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to approve device'
    });
  }
});

// Description: Reject a pending device
// Endpoint: POST /api/discovery/reject/:deviceId
// Request: {}
// Response: { success: boolean, message: string }
router.post('/reject/:deviceId', requireUser(), async (req, res) => {
  const { deviceId } = req.params;
  console.log(`POST /api/discovery/reject/${deviceId} - Rejecting pending device`);

  try {
    if (!discoveryService) {
      console.error(`POST /api/discovery/reject/${deviceId} - Discovery service not available`);
      return res.status(500).json({
        success: false,
        message: 'Discovery service not available'
      });
    }

    const rejectedDevice = discoveryService.rejectPendingDevice(deviceId);

    console.log(`POST /api/discovery/reject/${deviceId} - Device ${rejectedDevice.name} rejected`);
    res.status(200).json({
      success: true,
      message: 'Device rejected successfully'
    });

  } catch (error) {
    console.error(`POST /api/discovery/reject/${deviceId} - Error:`, error.message);
    console.error(error.stack);

    const statusCode = error.message === 'Pending device not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to reject device'
    });
  }
});

// Description: Clear all pending devices
// Endpoint: POST /api/discovery/clear-pending
// Request: {}
// Response: { success: boolean, cleared: number, message: string }
router.post('/clear-pending', requireUser(), async (req, res) => {
  console.log('POST /api/discovery/clear-pending - Clearing all pending devices');

  try {
    if (!discoveryService) {
      console.error('POST /api/discovery/clear-pending - Discovery service not available');
      return res.status(500).json({
        success: false,
        message: 'Discovery service not available'
      });
    }

    const pendingDevices = discoveryService.getPendingDevices();
    const count = pendingDevices.length;

    // Clear all pending devices
    pendingDevices.forEach(device => {
      discoveryService.rejectPendingDevice(device.id);
    });

    console.log(`POST /api/discovery/clear-pending - Cleared ${count} pending devices`);
    res.status(200).json({
      success: true,
      cleared: count,
      message: `Cleared ${count} pending devices`
    });

  } catch (error) {
    console.error('POST /api/discovery/clear-pending - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to clear pending devices'
    });
  }
});

module.exports = router;
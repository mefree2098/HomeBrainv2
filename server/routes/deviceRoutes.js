const express = require('express');
const router = express.Router();
const deviceService = require('../services/deviceService');
const { requireUser } = require('./middlewares/auth');

// Apply authentication middleware to all device routes
router.use(requireUser());

/**
 * GET /api/devices
 * Get all devices with optional filters
 */
router.get('/', async (req, res) => {
  try {
    console.log('GET /api/devices - Query params:', req.query);
    
    const filters = {};
    if (req.query.room) filters.room = req.query.room;
    if (req.query.type) filters.type = req.query.type;
    if (req.query.status !== undefined) filters.status = req.query.status === 'true';
    if (req.query.isOnline !== undefined) filters.isOnline = req.query.isOnline === 'true';
    if (req.query.source) filters.source = req.query.source;
    
    const devices = await deviceService.getAllDevices(filters);
    
    console.log(`GET /api/devices - Successfully returned ${devices.length} devices`);
    res.status(200).json({
      success: true,
      message: 'Devices fetched successfully',
      data: { devices }
    });
  } catch (error) {
    console.error('GET /api/devices - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch devices'
    });
  }
});

/**
 * GET /api/devices/stats
 * Get device statistics
 */
router.get('/stats', async (req, res) => {
  try {
    console.log('GET /api/devices/stats');
    
    const stats = await deviceService.getDeviceStats();
    
    console.log('GET /api/devices/stats - Successfully returned device statistics');
    res.status(200).json({
      success: true,
      message: 'Device statistics fetched successfully',
      data: { stats }
    });
  } catch (error) {
    console.error('GET /api/devices/stats - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch device statistics'
    });
  }
});

/**
 * GET /api/devices/by-room
 * Get devices grouped by room
 */
router.get('/by-room', async (req, res) => {
  try {
    console.log('GET /api/devices/by-room');
    
    const rooms = await deviceService.getDevicesByRoom();
    
    console.log(`GET /api/devices/by-room - Successfully returned ${rooms.length} rooms with devices`);
    res.status(200).json({
      success: true,
      message: 'Devices by room fetched successfully',
      data: { rooms }
    });
  } catch (error) {
    console.error('GET /api/devices/by-room - Error:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch devices by room'
    });
  }
});

/**
 * GET /api/devices/:id
 * Get a specific device by ID
 */
router.get('/:id', async (req, res) => {
  try {
    console.log('GET /api/devices/:id - Device ID:', req.params.id);
    
    const device = await deviceService.getDeviceById(req.params.id);
    
    console.log('GET /api/devices/:id - Successfully returned device:', device.name);
    res.status(200).json({
      success: true,
      message: 'Device fetched successfully',
      data: { device }
    });
  } catch (error) {
    console.error('GET /api/devices/:id - Error:', error.message);
    console.error(error.stack);
    
    const statusCode = error.message === 'Device not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to fetch device'
    });
  }
});

/**
 * POST /api/devices
 * Create a new device
 */
router.post('/', async (req, res) => {
  try {
    console.log('POST /api/devices - Device data:', req.body);
    
    const device = await deviceService.createDevice(req.body);
    
    console.log('POST /api/devices - Successfully created device:', device.name, 'with ID:', device._id);
    res.status(201).json({
      success: true,
      message: 'Device created successfully',
      data: { device }
    });
  } catch (error) {
    console.error('POST /api/devices - Error:', error.message);
    console.error(error.stack);
    
    const statusCode = error.message.includes('required fields') || 
                       error.message.includes('already exists') ? 400 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to create device'
    });
  }
});

/**
 * PUT /api/devices/:id
 * Update a device
 */
router.put('/:id', async (req, res) => {
  try {
    console.log('PUT /api/devices/:id - Device ID:', req.params.id);
    console.log('PUT /api/devices/:id - Update data:', req.body);
    
    const device = await deviceService.updateDevice(req.params.id, req.body);
    
    console.log('PUT /api/devices/:id - Successfully updated device:', device.name);
    res.status(200).json({
      success: true,
      message: 'Device updated successfully',
      data: { device }
    });
  } catch (error) {
    console.error('PUT /api/devices/:id - Error:', error.message);
    console.error(error.stack);
    
    const statusCode = error.message === 'Device not found' ? 404 : 
                       error.message.includes('already exists') ? 400 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update device'
    });
  }
});

/**
 * DELETE /api/devices/:id
 * Delete a device
 */
router.delete('/:id', async (req, res) => {
  try {
    console.log('DELETE /api/devices/:id - Device ID:', req.params.id);
    
    const device = await deviceService.deleteDevice(req.params.id);
    
    console.log('DELETE /api/devices/:id - Successfully deleted device:', device.name);
    res.status(200).json({
      success: true,
      message: 'Device deleted successfully',
      data: { device }
    });
  } catch (error) {
    console.error('DELETE /api/devices/:id - Error:', error.message);
    console.error(error.stack);
    
    const statusCode = error.message === 'Device not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to delete device'
    });
  }
});

/**
 * POST /api/devices/control
 * Control a device (toggle, set brightness, temperature, etc.)
 */
router.post('/control', async (req, res) => {
  try {
    console.log('POST /api/devices/control - Control data:', req.body);
    
    const { deviceId, action, value } = req.body;
    
    if (!deviceId || !action) {
      return res.status(400).json({
        success: false,
        error: 'Device ID and action are required'
      });
    }
    
    const device = await deviceService.controlDevice(deviceId, action, value);
    
    console.log('POST /api/devices/control - Successfully controlled device:', device.name, 'action:', action);
    res.status(200).json({
      success: true,
      message: 'Device controlled successfully',
      data: { device }
    });
  } catch (error) {
    console.error('POST /api/devices/control - Error:', error.message);
    console.error(error.stack);
    
    const statusCode = error.message === 'Device not found' ? 404 :
                       error.message.includes('Device ID and action are required') ||
                       error.message.includes('offline') ||
                       error.message.includes('only available') ||
                       error.message.includes('not supported') ||
                       error.message.includes('must be') ||
                       error.message.includes('Unknown action') ? 400 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to control device'
    });
  }
});

/**
 * POST /api/devices/:id/control
 * Alternative endpoint for controlling a specific device
 */
router.post('/:id/control', async (req, res) => {
  try {
    console.log('POST /api/devices/:id/control - Device ID:', req.params.id);
    console.log('POST /api/devices/:id/control - Control data:', req.body);
    
    const { action, value } = req.body;
    
    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'Action is required'
      });
    }
    
    const device = await deviceService.controlDevice(req.params.id, action, value);
    
    console.log('POST /api/devices/:id/control - Successfully controlled device:', device.name, 'action:', action);
    res.status(200).json({
      success: true,
      message: 'Device controlled successfully',
      data: { device }
    });
  } catch (error) {
    console.error('POST /api/devices/:id/control - Error:', error.message);
    console.error(error.stack);
    
    const statusCode = error.message === 'Device not found' ? 404 :
                       error.message.includes('Action is required') ||
                       error.message.includes('offline') ||
                       error.message.includes('only available') ||
                       error.message.includes('not supported') ||
                       error.message.includes('must be') ||
                       error.message.includes('Unknown action') ? 400 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to control device'
    });
  }
});

module.exports = router;

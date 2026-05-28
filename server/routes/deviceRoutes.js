const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const deviceService = require('../services/deviceService');
const deviceEnergySampleService = require('../services/deviceEnergySampleService');
const directRadioService = require('../services/directRadioService');
const { serializeDevices } = require('../services/devicePayloadService');
const { requireUser, requireAdmin } = require('./middlewares/auth');

// Apply authentication middleware to all device routes
router.use(requireUser());
const admin = requireAdmin();
const lockCodeRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_LOCK_CODE_RATE_LIMIT_WINDOW_MS || 5 * 60 * 1000)),
  limit: Math.max(10, Number(process.env.HOMEBRAIN_LOCK_CODE_RATE_LIMIT_MAX || 120)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many lock PIN management requests. Please retry shortly.'
  }
});

function actorFromRequest(req) {
  return String(req.user?.email || req.user?._id || req.user?.id || 'unknown');
}

function shouldIncludeRawDevicePayload(req) {
  return req.user?.role === 'admin'
    && (req.query.includeRaw === '1' || req.query.includeRaw === 'true');
}

function deviceActionStatusCode(error) {
  if (error.status) {
    return error.status;
  }
  const message = error.message || '';
  if (message === 'Device not found') {
    return 404;
  }
  if (
    message.includes('requires') ||
    message.includes('only available') ||
    message.includes('does not expose') ||
    message.includes('must be') ||
    message.includes('rejected') ||
    message.includes('required')
  ) {
    return 400;
  }
  if (message.includes('not ready')) {
    return 409;
  }
  return 500;
}

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
    
    const refreshSmartThings = req.query.refresh === '1' || req.query.refresh === 'true';
    const includeExcludedHarmony = req.query.includeExcludedHarmony === '1' || req.query.includeExcludedHarmony === 'true';
    const devices = await deviceService.getAllDevices(filters, {
      refreshSmartThings,
      includeExcludedHarmony
    });
    const serializedDevices = serializeDevices(devices, {
      includeRaw: shouldIncludeRawDevicePayload(req)
    });
    
    console.log(`GET /api/devices - Successfully returned ${serializedDevices.length} devices`);
    res.status(200).json({
      success: true,
      message: 'Devices fetched successfully',
      data: { devices: serializedDevices }
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
    const serializedRooms = Array.isArray(rooms)
      ? rooms.map((room) => ({
        ...room,
        devices: serializeDevices(room.devices, {
          includeRaw: shouldIncludeRawDevicePayload(req)
        })
      }))
      : [];
    
    console.log(`GET /api/devices/by-room - Successfully returned ${serializedRooms.length} rooms with devices`);
    res.status(200).json({
      success: true,
      message: 'Devices by room fetched successfully',
      data: { rooms: serializedRooms }
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
 * GET /api/devices/:id/energy-history
 * Get recent power and energy samples for a device
 */
router.get('/:id/energy-history', async (req, res) => {
  try {
    console.log('GET /api/devices/:id/energy-history - Device ID:', req.params.id);

    await deviceService.getDeviceById(req.params.id);
    const samples = await deviceEnergySampleService.getDeviceEnergyHistory(req.params.id, {
      hours: req.query.hours,
      limit: req.query.limit
    });

    res.status(200).json({
      success: true,
      message: 'Device energy history fetched successfully',
      data: {
        deviceId: req.params.id,
        hours: Number(req.query.hours) || 24,
        count: samples.length,
        samples
      }
    });
  } catch (error) {
    console.error('GET /api/devices/:id/energy-history - Error:', error.message);
    console.error(error.stack);

    const statusCode = error.message === 'Device not found' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to fetch device energy history'
    });
  }
});

/**
 * GET /api/devices/:id/lock-codes
 * Get redacted native lock PIN slot state for a HomeBrain Z-Wave lock
 */
router.get('/:id/lock-codes', lockCodeRateLimit, admin, async (req, res) => {
  try {
    console.log('GET /api/devices/:id/lock-codes - Device ID:', req.params.id);

    const state = await directRadioService.getLockCodeState(req.params.id, {
      refresh: req.query.refresh === '1' || req.query.refresh === 'true'
    });

    res.status(200).json({
      success: true,
      message: 'Lock PIN slots fetched successfully',
      data: state
    });
  } catch (error) {
    console.error('GET /api/devices/:id/lock-codes - Error:', error.message);
    console.error(error.stack);

    res.status(deviceActionStatusCode(error)).json({
      success: false,
      error: error.message || 'Failed to fetch lock PIN slots'
    });
  }
});

/**
 * PUT /api/devices/:id/lock-codes/:slot
 * Create, update, rename, or enable/disable a native Z-Wave lock PIN slot
 */
router.put('/:id/lock-codes/:slot', lockCodeRateLimit, admin, async (req, res) => {
  try {
    console.log('PUT /api/devices/:id/lock-codes/:slot - Device ID:', req.params.id, 'Slot:', req.params.slot);

    const state = await directRadioService.setLockCode(
      req.params.id,
      {
        ...req.body,
        slot: req.params.slot
      },
      {
        actor: actorFromRequest(req)
      }
    );

    res.status(200).json({
      success: true,
      message: 'Lock PIN slot updated successfully',
      data: state
    });
  } catch (error) {
    console.error('PUT /api/devices/:id/lock-codes/:slot - Error:', error.message);
    console.error(error.stack);

    res.status(deviceActionStatusCode(error)).json({
      success: false,
      error: error.message || 'Failed to update lock PIN slot'
    });
  }
});

/**
 * DELETE /api/devices/:id/lock-codes/:slot
 * Delete a native Z-Wave lock PIN slot
 */
router.delete('/:id/lock-codes/:slot', lockCodeRateLimit, admin, async (req, res) => {
  try {
    console.log('DELETE /api/devices/:id/lock-codes/:slot - Device ID:', req.params.id, 'Slot:', req.params.slot);

    const state = await directRadioService.deleteLockCode(req.params.id, req.params.slot, {
      actor: actorFromRequest(req)
    });

    res.status(200).json({
      success: true,
      message: 'Lock PIN slot deleted successfully',
      data: state
    });
  } catch (error) {
    console.error('DELETE /api/devices/:id/lock-codes/:slot - Error:', error.message);
    console.error(error.stack);

    res.status(deviceActionStatusCode(error)).json({
      success: false,
      error: error.message || 'Failed to delete lock PIN slot'
    });
  }
});

/**
 * GET /api/devices/:id/lock-code-events
 * Get HomeBrain and on-lock native audit events for a HomeBrain Z-Wave lock
 */
router.get('/:id/lock-code-events', lockCodeRateLimit, admin, async (req, res) => {
  try {
    console.log('GET /api/devices/:id/lock-code-events - Device ID:', req.params.id);

    const audit = await directRadioService.getLockCodeAudit(req.params.id, {
      limit: req.query.limit,
      includeDeviceLog: req.query.includeDeviceLog !== '0' && req.query.includeDeviceLog !== 'false'
    });

    res.status(200).json({
      success: true,
      message: 'Lock PIN audit events fetched successfully',
      data: audit
    });
  } catch (error) {
    console.error('GET /api/devices/:id/lock-code-events - Error:', error.message);
    console.error(error.stack);

    res.status(deviceActionStatusCode(error)).json({
      success: false,
      error: error.message || 'Failed to fetch lock PIN audit events'
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
router.post('/', admin, async (req, res) => {
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
router.put('/:id', admin, async (req, res) => {
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
router.delete('/:id', admin, async (req, res) => {
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
    
    const device = await deviceService.controlDevice(deviceId, action, value, {
      command: {
        source: req.body.source || 'manual',
        reason: req.body.reason || 'Manual device control from HomeBrain UI/API',
        actor: actorFromRequest(req)
      }
    });
    
    console.log('POST /api/devices/control - Successfully controlled device:', device.name, 'action:', action);
    res.status(200).json({
      success: true,
      message: 'Device controlled successfully',
      data: { device }
    });
  } catch (error) {
    console.error('POST /api/devices/control - Error:', error.message);
    console.error(error.stack);
    
    const statusCode = error.status || (error.message === 'Device not found' ? 404 :
                       error.message.includes('Device ID and action are required') ||
                       error.message.includes('offline') ||
                       error.message.includes('only available') ||
                       error.message.includes('not supported') ||
                       error.message.includes('must be') ||
                       error.message.includes('Unknown action') ? 400 : 500);
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
    
    const device = await deviceService.controlDevice(req.params.id, action, value, {
      command: {
        source: req.body.source || 'manual',
        reason: req.body.reason || 'Manual device control from HomeBrain UI/API',
        actor: actorFromRequest(req)
      }
    });
    
    console.log('POST /api/devices/:id/control - Successfully controlled device:', device.name, 'action:', action);
    res.status(200).json({
      success: true,
      message: 'Device controlled successfully',
      data: { device }
    });
  } catch (error) {
    console.error('POST /api/devices/:id/control - Error:', error.message);
    console.error(error.stack);
    
    const statusCode = error.status || (error.message === 'Device not found' ? 404 :
                       error.message.includes('Action is required') ||
                       error.message.includes('offline') ||
                       error.message.includes('only available') ||
                       error.message.includes('not supported') ||
                       error.message.includes('must be') ||
                       error.message.includes('Unknown action') ? 400 : 500);
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to control device'
    });
  }
});

module.exports = router;

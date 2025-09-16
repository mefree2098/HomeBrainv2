const express = require('express');
const router = express.Router();
const securityAlarmService = require('../services/securityAlarmService');
const settingsService = require('../services/settingsService');
const { requireUser } = require('./middlewares/auth');

// Create auth middleware instance
const auth = requireUser();

/**
 * GET /api/security-alarm
 * Get alarm system information
 */
router.get('/', auth, async (req, res) => {
  try {
    console.log('GET /api/security-alarm - Fetching alarm system');
    
    const alarm = await securityAlarmService.getAlarmSystem();
    
    console.log('Successfully retrieved alarm system');
    res.status(200).json({
      success: true,
      alarm: alarm
    });

  } catch (error) {
    console.error('Error in GET /api/security-alarm:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch alarm system',
      error: error.message
    });
  }
});

/**
 * GET /api/security-alarm/status
 * Get alarm status
 */
router.get('/status', auth, async (req, res) => {
  try {
    console.log('GET /api/security-alarm/status - Fetching alarm status');
    
    const status = await securityAlarmService.getAlarmStatus();
    
    console.log('Successfully retrieved alarm status');
    res.status(200).json({
      success: true,
      status: status
    });

  } catch (error) {
    console.error('Error in GET /api/security-alarm/status:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch alarm status',
      error: error.message
    });
  }
});

/**
 * POST /api/security-alarm/arm
 * Arm the security system
 */
router.post('/arm', auth, async (req, res) => {
  try {
    console.log('POST /api/security-alarm/arm - Arming security system');
    
    const { mode } = req.body;
    const userId = req.user?.id || req.user?._id;
    
    console.log('Request body:', req.body);
    console.log('User ID:', userId);
    console.log('Arm mode:', mode);
    
    if (!mode || !['stay', 'away'].includes(mode)) {
      console.log('Invalid arm mode provided:', mode);
      return res.status(400).json({
        success: false,
        message: 'Invalid arm mode. Must be "stay" or "away"'
      });
    }
    
    // Get SmartThings token from settings
    let smartthingsToken = null;
    try {
      smartthingsToken = await settingsService.getSetting('smartthingsToken');
    } catch (settingsError) {
      console.log('Could not retrieve SmartThings token:', settingsError.message);
    }
    
    const alarm = await securityAlarmService.armAlarm(mode, userId, smartthingsToken);
    
    console.log(`Successfully armed security system in ${mode} mode`);
    res.status(200).json({
      success: true,
      message: `Security system armed in ${mode} mode`,
      alarm: alarm
    });

  } catch (error) {
    console.error('Error in POST /api/security-alarm/arm:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to arm security system',
      error: error.message
    });
  }
});

/**
 * POST /api/security-alarm/disarm
 * Disarm the security system
 */
router.post('/disarm', auth, async (req, res) => {
  try {
    console.log('POST /api/security-alarm/disarm - Disarming security system');
    
    const userId = req.user?.id || req.user?._id;
    console.log('User ID:', userId);
    
    // Get SmartThings token from settings
    let smartthingsToken = null;
    try {
      smartthingsToken = await settingsService.getSetting('smartthingsToken');
    } catch (settingsError) {
      console.log('Could not retrieve SmartThings token:', settingsError.message);
    }
    
    const alarm = await securityAlarmService.disarmAlarm(userId, smartthingsToken);
    
    console.log('Successfully disarmed security system');
    res.status(200).json({
      success: true,
      message: 'Security system disarmed',
      alarm: alarm
    });

  } catch (error) {
    console.error('Error in POST /api/security-alarm/disarm:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to disarm security system',
      error: error.message
    });
  }
});

/**
 * POST /api/security-alarm/zones
 * Add a security zone
 */
router.post('/zones', auth, async (req, res) => {
  try {
    console.log('POST /api/security-alarm/zones - Adding security zone');
    
    const zoneData = req.body;
    console.log('Zone data:', zoneData);
    
    if (!zoneData.name || !zoneData.deviceId || !zoneData.deviceType) {
      console.log('Missing required zone fields');
      return res.status(400).json({
        success: false,
        message: 'Missing required zone fields: name, deviceId, deviceType'
      });
    }
    
    const alarm = await securityAlarmService.addZone(zoneData);
    
    console.log('Successfully added security zone');
    res.status(200).json({
      success: true,
      message: 'Security zone added successfully',
      alarm: alarm
    });

  } catch (error) {
    console.error('Error in POST /api/security-alarm/zones:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add security zone',
      error: error.message
    });
  }
});

/**
 * DELETE /api/security-alarm/zones/:deviceId
 * Remove a security zone
 */
router.delete('/zones/:deviceId', auth, async (req, res) => {
  try {
    console.log(`DELETE /api/security-alarm/zones/${req.params.deviceId} - Removing security zone`);
    
    const { deviceId } = req.params;
    console.log('Device ID:', deviceId);
    
    const alarm = await securityAlarmService.removeZone(deviceId);
    
    console.log('Successfully removed security zone');
    res.status(200).json({
      success: true,
      message: 'Security zone removed successfully',
      alarm: alarm
    });

  } catch (error) {
    console.error(`Error in DELETE /api/security-alarm/zones/${req.params.deviceId}:`, error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove security zone',
      error: error.message
    });
  }
});

/**
 * PUT /api/security-alarm/zones/:deviceId/bypass
 * Bypass or unbypass a security zone
 */
router.put('/zones/:deviceId/bypass', auth, async (req, res) => {
  try {
    console.log(`PUT /api/security-alarm/zones/${req.params.deviceId}/bypass - Updating zone bypass`);
    
    const { deviceId } = req.params;
    const { bypass } = req.body;
    
    console.log('Device ID:', deviceId);
    console.log('Bypass:', bypass);
    
    if (typeof bypass !== 'boolean') {
      console.log('Invalid bypass value provided:', bypass);
      return res.status(400).json({
        success: false,
        message: 'Invalid bypass value. Must be true or false'
      });
    }
    
    const alarm = await securityAlarmService.bypassZone(deviceId, bypass);
    
    console.log(`Successfully ${bypass ? 'bypassed' : 'unbypassed'} security zone`);
    res.status(200).json({
      success: true,
      message: `Security zone ${bypass ? 'bypassed' : 'unbypassed'} successfully`,
      alarm: alarm
    });

  } catch (error) {
    console.error(`Error in PUT /api/security-alarm/zones/${req.params.deviceId}/bypass:`, error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update zone bypass status',
      error: error.message
    });
  }
});

/**
 * POST /api/security-alarm/sync
 * Sync alarm status with SmartThings
 */
router.post('/sync', auth, async (req, res) => {
  try {
    console.log('POST /api/security-alarm/sync - Syncing with SmartThings');
    
    // Get SmartThings token from settings
    let smartthingsToken = null;
    try {
      smartthingsToken = await settingsService.getSetting('smartthingsToken');
    } catch (settingsError) {
      console.log('Could not retrieve SmartThings token:', settingsError.message);
      return res.status(400).json({
        success: false,
        message: 'SmartThings token not configured'
      });
    }
    
    if (!smartthingsToken) {
      return res.status(400).json({
        success: false,
        message: 'SmartThings token not configured'
      });
    }
    
    const alarm = await securityAlarmService.syncWithSmartThings(smartthingsToken);
    
    console.log('Successfully synced with SmartThings');
    res.status(200).json({
      success: true,
      message: 'Successfully synced with SmartThings',
      alarm: alarm
    });

  } catch (error) {
    console.error('Error in POST /api/security-alarm/sync:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to sync with SmartThings',
      error: error.message
    });
  }
});

/**
 * PUT /api/security-alarm/configure
 * Configure SmartThings integration
 */
router.put('/configure', auth, async (req, res) => {
  try {
    console.log('PUT /api/security-alarm/configure - Configuring SmartThings integration');
    
    const { smartthingsDeviceId } = req.body;
    console.log('SmartThings Device ID:', smartthingsDeviceId);
    
    if (!smartthingsDeviceId) {
      console.log('Missing SmartThings device ID');
      return res.status(400).json({
        success: false,
        message: 'SmartThings device ID is required'
      });
    }
    
    const alarm = await securityAlarmService.configureSmartThingsIntegration(smartthingsDeviceId);
    
    console.log('Successfully configured SmartThings integration');
    res.status(200).json({
      success: true,
      message: 'SmartThings integration configured successfully',
      alarm: alarm
    });

  } catch (error) {
    console.error('Error in PUT /api/security-alarm/configure:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to configure SmartThings integration',
      error: error.message
    });
  }
});

module.exports = router;
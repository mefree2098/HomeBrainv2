const express = require('express');
const router = express.Router();
const { requireAdmin } = require('./middlewares/auth');
const smartThingsService = require('../services/smartThingsService');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const Settings = require('../models/Settings');

// Create auth middleware instance
const auth = requireAdmin();

// Description: Get SmartThings integration status
// Endpoint: GET /api/smartthings/status
// Request: {}
// Response: { success: boolean, integration: Object }
router.get('/status', auth, async (req, res) => {
  try {
    console.log('SmartThings Routes: Getting integration status');

    const integration = await SmartThingsIntegration.getIntegration();
    const sanitizedIntegration = integration.toSanitized();

    console.log('SmartThings Routes: Integration status retrieved successfully');
    res.json({
      success: true,
      integration: sanitizedIntegration
    });
  } catch (error) {
    console.error('SmartThings Routes: Error getting integration status:', error.message);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Configure SmartThings OAuth settings
// Endpoint: POST /api/smartthings/configure
// Request: { clientId: string, clientSecret: string, redirectUri?: string }
// Response: { success: boolean, message: string }
router.post('/configure', auth, async (req, res) => {
  try {
    const { clientId, clientSecret, redirectUri } = req.body;

    console.log('SmartThings Routes: Configuring OAuth settings');

    if (!clientId || !clientSecret) {
      return res.status(400).json({
        success: false,
        message: 'Client ID and Client Secret are required'
      });
    }

    const integration = await SmartThingsIntegration.configureIntegration({
      clientId,
      clientSecret,
      redirectUri
    });

    console.log('SmartThings Routes: OAuth configuration updated successfully');
    res.json({
      success: true,
      message: 'SmartThings OAuth configuration updated successfully'
    });
  } catch (error) {
    console.error('SmartThings Routes: Error configuring OAuth:', error.message);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Get OAuth authorization URL
// Endpoint: GET /api/smartthings/auth/url
// Request: {}
// Response: { success: boolean, authUrl: string }
router.get('/auth/url', auth, async (req, res) => {
  try {
    console.log('SmartThings Routes: Generating authorization URL');

    const authUrl = await smartThingsService.getAuthorizationUrl();

    console.log('SmartThings Routes: Authorization URL generated successfully');
    res.json({
      success: true,
      authUrl: authUrl
    });
  } catch (error) {
    console.error('SmartThings Routes: Error generating authorization URL:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: OAuth callback endpoint (handles authorization code)
// Endpoint: GET /api/smartthings/callback
// Request: { code: string, state?: string }
// Response: Redirect to frontend with success/error status
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;

    console.log('SmartThings Routes: OAuth callback query params', req.query);

    console.log('SmartThings Routes: Handling OAuth callback');

    const resolvedClientUrl = (process.env.CLIENT_URL && process.env.CLIENT_URL.trim())
      ? process.env.CLIENT_URL.trim()
      : `${req.secure ? 'https' : 'http'}://${req.get('host')}`;
    const redirectBase = resolvedClientUrl.replace(/\/+$/, '');

    if (error) {
      const message = errorDescription || error;
      console.error('SmartThings Routes: OAuth error:', message);
      return res.redirect(`${redirectBase}/settings?smartthings=error&message=${encodeURIComponent(message)}`);
    }

    if (!code) {
      return res.redirect(`${redirectBase}/settings?smartthings=error&message=${encodeURIComponent('No authorization code received')}`);
    }

    await smartThingsService.exchangeCodeForToken(code, state);

    console.log('SmartThings Routes: OAuth callback handled successfully');
    res.redirect(`${redirectBase}/settings?smartthings=success`);
  } catch (error) {
    console.error('SmartThings Routes: Error handling OAuth callback:', error.message);
    const resolvedClientUrl = (process.env.CLIENT_URL && process.env.CLIENT_URL.trim())
      ? process.env.CLIENT_URL.trim()
      : `${req.secure ? 'https' : 'http'}://${req.get('host')}`;
    const redirectBase = resolvedClientUrl.replace(/\/+$/, '');
    res.redirect(`${redirectBase}/settings?smartthings=error&message=${encodeURIComponent(error.message)}`);
  }
});

// Description: Test SmartThings connection
// Endpoint: POST /api/smartthings/test
// Request: {}
// Response: { success: boolean, message: string, deviceCount?: number }
router.post('/test', auth, async (req, res) => {
  try {
    console.log('SmartThings Routes: Testing connection');

    const result = await smartThingsService.testConnection();

    console.log('SmartThings Routes: Connection test completed successfully');
    res.json(result);
  } catch (error) {
    console.error('SmartThings Routes: Connection test failed:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Disconnect SmartThings integration
// Endpoint: POST /api/smartthings/disconnect
// Request: {}
// Response: { success: boolean, message: string }
router.post('/disconnect', auth, async (req, res) => {
  try {
    console.log('SmartThings Routes: Disconnecting integration');

    await smartThingsService.disconnect();

    console.log('SmartThings Routes: Integration disconnected successfully');
    res.json({
      success: true,
      message: 'SmartThings integration disconnected successfully'
    });
  } catch (error) {
    console.error('SmartThings Routes: Error disconnecting:', error.message);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Get all SmartThings devices
// Endpoint: GET /api/smartthings/devices
// Request: {}
// Response: { success: boolean, devices: Array }
router.get('/devices', auth, async (req, res) => {
  try {
    console.log('SmartThings Routes: Fetching devices');

    const devices = await smartThingsService.getDevices();

    console.log('SmartThings Routes: Devices fetched successfully');
    res.json({
      success: true,
      devices: devices
    });
  } catch (error) {
    console.error('SmartThings Routes: Error fetching devices:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Get specific SmartThings device
// Endpoint: GET /api/smartthings/devices/:deviceId
// Request: {}
// Response: { success: boolean, device: Object }
router.get('/devices/:deviceId', auth, async (req, res) => {
  try {
    const { deviceId } = req.params;

    console.log(`SmartThings Routes: Fetching device ${deviceId}`);

    const device = await smartThingsService.getDevice(deviceId);

    console.log('SmartThings Routes: Device fetched successfully');
    res.json({
      success: true,
      device: device
    });
  } catch (error) {
    console.error('SmartThings Routes: Error fetching device:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Get SmartThings device status
// Endpoint: GET /api/smartthings/devices/:deviceId/status
// Request: {}
// Response: { success: boolean, status: Object }
router.get('/devices/:deviceId/status', auth, async (req, res) => {
  try {
    const { deviceId } = req.params;

    console.log(`SmartThings Routes: Fetching device status for ${deviceId}`);

    const status = await smartThingsService.getDeviceStatus(deviceId);

    console.log('SmartThings Routes: Device status fetched successfully');
    res.json({
      success: true,
      status: status
    });
  } catch (error) {
    console.error('SmartThings Routes: Error fetching device status:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Send command to SmartThings device
// Endpoint: POST /api/smartthings/devices/:deviceId/commands
// Request: { commands: Array }
// Response: { success: boolean, result: Object }
router.post('/devices/:deviceId/commands', auth, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { commands } = req.body;

    console.log(`SmartThings Routes: Sending command to device ${deviceId}`);

    if (!commands || !Array.isArray(commands)) {
      return res.status(400).json({
        success: false,
        message: 'Commands array is required'
      });
    }

    const result = await smartThingsService.sendDeviceCommand(deviceId, commands);

    console.log('SmartThings Routes: Command sent successfully');
    res.json({
      success: true,
      result: result
    });
  } catch (error) {
    console.error('SmartThings Routes: Error sending device command:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Turn device on
// Endpoint: POST /api/smartthings/devices/:deviceId/on
// Request: {}
// Response: { success: boolean, result: Object }
router.post('/devices/:deviceId/on', auth, async (req, res) => {
  try {
    const { deviceId } = req.params;

    console.log(`SmartThings Routes: Turning device ${deviceId} on`);

    const result = await smartThingsService.turnDeviceOn(deviceId);

    console.log('SmartThings Routes: Device turned on successfully');
    res.json({
      success: true,
      result: result
    });
  } catch (error) {
    console.error('SmartThings Routes: Error turning device on:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Turn device off
// Endpoint: POST /api/smartthings/devices/:deviceId/off
// Request: {}
// Response: { success: boolean, result: Object }
router.post('/devices/:deviceId/off', auth, async (req, res) => {
  try {
    const { deviceId } = req.params;

    console.log(`SmartThings Routes: Turning device ${deviceId} off`);

    const result = await smartThingsService.turnDeviceOff(deviceId);

    console.log('SmartThings Routes: Device turned off successfully');
    res.json({
      success: true,
      result: result
    });
  } catch (error) {
    console.error('SmartThings Routes: Error turning device off:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Set device level (for dimmable devices)
// Endpoint: POST /api/smartthings/devices/:deviceId/level
// Request: { level: number }
// Response: { success: boolean, result: Object }
router.post('/devices/:deviceId/level', auth, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { level } = req.body;

    console.log(`SmartThings Routes: Setting device ${deviceId} level to ${level}`);

    if (typeof level !== 'number' || level < 0 || level > 100) {
      return res.status(400).json({
        success: false,
        message: 'Level must be a number between 0 and 100'
      });
    }

    const result = await smartThingsService.setDeviceLevel(deviceId, level);

    console.log('SmartThings Routes: Device level set successfully');
    res.json({
      success: true,
      result: result
    });
  } catch (error) {
    console.error('SmartThings Routes: Error setting device level:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Get all SmartThings scenes
// Endpoint: GET /api/smartthings/scenes
// Request: {}
// Response: { success: boolean, scenes: Array }
router.get('/scenes', auth, async (req, res) => {
  try {
    console.log('SmartThings Routes: Fetching scenes');

    const scenes = await smartThingsService.getScenes();

    console.log('SmartThings Routes: Scenes fetched successfully');
    res.json({
      success: true,
      scenes: scenes
    });
  } catch (error) {
    console.error('SmartThings Routes: Error fetching scenes:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Execute SmartThings scene
// Endpoint: POST /api/smartthings/scenes/:sceneId/execute
// Request: {}
// Response: { success: boolean, result: Object }
router.post('/scenes/:sceneId/execute', auth, async (req, res) => {
  try {
    const { sceneId } = req.params;

    console.log(`SmartThings Routes: Executing scene ${sceneId}`);

    const result = await smartThingsService.executeScene(sceneId);

    console.log('SmartThings Routes: Scene executed successfully');
    res.json({
      success: true,
      result: result
    });
  } catch (error) {
    console.error('SmartThings Routes: Error executing scene:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Configure STHM virtual switches
// Endpoint: POST /api/smartthings/sthm/configure
// Request: { armAwayDeviceId?: string, armStayDeviceId?: string, disarmDeviceId?: string, silenceDeviceId?: string, locationId?: string }
// Response: { success: boolean, message: string }
router.post('/sthm/configure', auth, async (req, res) => {
  try {
    const { armAwayDeviceId, armStayDeviceId, disarmDeviceId, silenceDeviceId, locationId } = req.body;

    console.log('SmartThings Routes: Configuring STHM virtual switches');

    const integration = await smartThingsService.configureSthm({
      armAwayDeviceId,
      armStayDeviceId,
      disarmDeviceId,
      silenceDeviceId,
      locationId
    });

    console.log('SmartThings Routes: STHM configuration updated successfully');
    res.json({
      success: true,
      message: 'SmartThings security configuration updated successfully',
      integration: integration.toSanitized ? integration.toSanitized() : integration
    });
  } catch (error) {
    console.error('SmartThings Routes: Error configuring STHM:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Run STHM diagnostics
// Endpoint: GET /api/smartthings/sthm/diagnostics
// Request: {}
// Response: { success: boolean, diagnostics: Object }
router.get('/sthm/diagnostics', auth, async (req, res) => {
  const startedAt = Date.now();
  try {
    console.log('SmartThings Routes: Running STHM diagnostics');
    const includeDeepProbe = ['1', 'true', 'yes'].includes(String(req.query.deep || '').toLowerCase());

    const diagnostics = await Promise.race([
      smartThingsService.getSthmDiagnostics({
        includeDeepProbe,
        switchProbeTimeoutMs: 2000,
        deepProbeTimeoutMs: 2000
      }),
      new Promise((_, reject) => {
        const timeoutError = new Error('STHM diagnostics timed out');
        timeoutError.code = 'TIMEOUT';
        setTimeout(() => reject(timeoutError), 4500);
      })
    ]);

    console.log('SmartThings Routes: STHM diagnostics completed', {
      tookMs: Date.now() - startedAt,
      includeDeepProbe
    });
    res.json({
      success: true,
      diagnostics
    });
  } catch (error) {
    console.error('SmartThings Routes: Error running STHM diagnostics:', error.message);

    let integration = null;
    try {
      integration = await SmartThingsIntegration.getIntegration();
    } catch (integrationError) {
      console.error('SmartThings Routes: Unable to load integration for diagnostics fallback:', integrationError.message);
    }

    const fallbackIntegration = integration?.toSanitized ? integration.toSanitized() : integration;
    res.status(200).json({
      success: false,
      diagnostics: {
        generatedAt: new Date().toISOString(),
        integration: fallbackIntegration || null,
        fallback: true,
        tookMs: Date.now() - startedAt,
        error: error.message
      },
      message: error.message || 'Failed to run STHM diagnostics'
    });
  }
});

// Description: Arm STHM (Stay mode)
// Endpoint: POST /api/smartthings/sthm/arm-stay
// Request: {}
// Response: { success: boolean, result: Object }
router.post('/sthm/arm-stay', auth, async (req, res) => {
  try {
    console.log('SmartThings Routes: Arming STHM (Stay mode)');

    const result = await smartThingsService.armSthmStay();

    console.log('SmartThings Routes: STHM armed in Stay mode successfully');
    res.json({
      success: true,
      result: result
    });
  } catch (error) {
    console.error('SmartThings Routes: Error arming STHM (Stay):', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Arm STHM (Away mode)
// Endpoint: POST /api/smartthings/sthm/arm-away
// Request: {}
// Response: { success: boolean, result: Object }
router.post('/sthm/arm-away', auth, async (req, res) => {
  try {
    console.log('SmartThings Routes: Arming STHM (Away mode)');

    const result = await smartThingsService.armSthmAway();

    console.log('SmartThings Routes: STHM armed in Away mode successfully');
    res.json({
      success: true,
      result: result
    });
  } catch (error) {
    console.error('SmartThings Routes: Error arming STHM (Away):', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Disarm STHM
// Endpoint: POST /api/smartthings/sthm/disarm
// Request: {}
// Response: { success: boolean, result: Object }
router.post('/sthm/disarm', auth, async (req, res) => {
  try {
    console.log('SmartThings Routes: Disarming STHM');

    const result = await smartThingsService.disarmSthm();

    console.log('SmartThings Routes: STHM disarmed successfully');
    res.json({
      success: true,
      result: result
    });
  } catch (error) {
    console.error('SmartThings Routes: Error disarming STHM:', error.message);
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;

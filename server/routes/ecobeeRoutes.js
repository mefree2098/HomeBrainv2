const express = require('express');
const router = express.Router();
const { requireAdmin } = require('./middlewares/auth');
const ecobeeService = require('../services/ecobeeService');
const EcobeeIntegration = require('../models/EcobeeIntegration');

const auth = requireAdmin();

router.get('/status', auth, async (req, res) => {
  try {
    const integration = await EcobeeIntegration.getIntegration();
    const sanitizedIntegration = integration?.toSanitized
      ? integration.toSanitized()
      : integration;

    return res.status(200).json({
      success: true,
      integration: sanitizedIntegration
    });
  } catch (error) {
    console.error('EcobeeRoutes: Failed to fetch status:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load Ecobee status'
    });
  }
});

router.post('/configure', auth, async (req, res) => {
  try {
    const { clientId, redirectUri, scope } = req.body || {};

    if (!clientId || typeof clientId !== 'string' || !clientId.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Ecobee App Key is required'
      });
    }

    await EcobeeIntegration.configureIntegration({
      clientId,
      redirectUri,
      scope
    });

    return res.status(200).json({
      success: true,
      message: 'Ecobee OAuth configuration updated successfully'
    });
  } catch (error) {
    console.error('EcobeeRoutes: Failed to configure OAuth:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to configure Ecobee OAuth'
    });
  }
});

router.get('/auth/url', auth, async (req, res) => {
  try {
    const authUrl = await ecobeeService.getAuthorizationUrl();

    return res.status(200).json({
      success: true,
      authUrl
    });
  } catch (error) {
    console.error('EcobeeRoutes: Failed to build auth URL:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to build Ecobee authorization URL'
    });
  }
});

router.get('/callback', async (req, res) => {
  const resolvedClientUrl = (process.env.CLIENT_URL && process.env.CLIENT_URL.trim())
    ? process.env.CLIENT_URL.trim()
    : `${req.secure ? 'https' : 'http'}://${req.get('host')}`;
  const redirectBase = resolvedClientUrl.replace(/\/+$/, '');

  try {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error) {
      const message = errorDescription || error;
      return res.redirect(`${redirectBase}/settings?ecobee=error&message=${encodeURIComponent(message)}`);
    }

    if (!code) {
      return res.redirect(`${redirectBase}/settings?ecobee=error&message=${encodeURIComponent('No authorization code received')}`);
    }

    await ecobeeService.exchangeCodeForToken(code, state);

    return res.redirect(`${redirectBase}/settings?ecobee=success`);
  } catch (error) {
    console.error('EcobeeRoutes: Failed to handle callback:', error.message);
    return res.redirect(`${redirectBase}/settings?ecobee=error&message=${encodeURIComponent(error.message || 'Callback failed')}`);
  }
});

router.post('/test', auth, async (req, res) => {
  try {
    const result = await ecobeeService.testConnection();
    return res.status(200).json(result);
  } catch (error) {
    console.error('EcobeeRoutes: Connection test failed:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to test Ecobee connection'
    });
  }
});

router.post('/disconnect', auth, async (req, res) => {
  try {
    await ecobeeService.disconnect();
    return res.status(200).json({
      success: true,
      message: 'Ecobee integration disconnected successfully'
    });
  } catch (error) {
    console.error('EcobeeRoutes: Disconnect failed:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to disconnect Ecobee integration'
    });
  }
});

router.get('/devices', auth, async (req, res) => {
  try {
    const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
    const devices = await ecobeeService.getDevices({ forceSync: refresh });

    return res.status(200).json({
      success: true,
      devices
    });
  } catch (error) {
    console.error('EcobeeRoutes: Failed to fetch devices:', error.message);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to fetch Ecobee devices'
    });
  }
});

module.exports = router;

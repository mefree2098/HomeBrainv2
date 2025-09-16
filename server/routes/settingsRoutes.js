const express = require('express');
const router = express.Router();
const settingsService = require('../services/settingsService');
const { requireUser } = require('./middlewares/auth');

// Create auth middleware instance
const auth = requireUser();

/**
 * GET /api/settings
 * Get application settings (sanitized for frontend)
 */
router.get('/', auth, async (req, res) => {
  try {
    console.log('GET /api/settings - Fetching application settings');
    
    const settings = await settingsService.getSanitizedSettings();
    
    console.log('Successfully retrieved application settings');
    res.status(200).json({
      success: true,
      settings: settings
    });

  } catch (error) {
    console.error('Error in GET /api/settings:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch application settings',
      error: error.message
    });
  }
});

/**
 * PUT /api/settings
 * Update application settings
 */
router.put('/', auth, async (req, res) => {
  try {
    console.log('PUT /api/settings - Updating application settings');
    console.log('Request body keys:', Object.keys(req.body));
    
    const settings = await settingsService.updateSettings(req.body);
    const sanitizedSettings = settings.toSanitized();
    
    console.log('Successfully updated application settings');
    res.status(200).json({
      success: true,
      message: 'Settings updated successfully',
      settings: sanitizedSettings
    });

  } catch (error) {
    console.error('Error in PUT /api/settings:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update application settings',
      error: error.message
    });
  }
});

/**
 * GET /api/settings/:key
 * Get specific setting value
 */
router.get('/:key', auth, async (req, res) => {
  try {
    console.log(`GET /api/settings/${req.params.key} - Fetching specific setting`);
    
    const value = await settingsService.getSetting(req.params.key);
    
    console.log(`Successfully retrieved setting: ${req.params.key}`);
    res.status(200).json({
      success: true,
      key: req.params.key,
      value: value
    });

  } catch (error) {
    console.error(`Error in GET /api/settings/${req.params.key}:`, error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: `Failed to fetch setting: ${req.params.key}`,
      error: error.message
    });
  }
});

/**
 * POST /api/settings/test-elevenlabs
 * Test ElevenLabs API key connectivity
 */
router.post('/test-elevenlabs', auth, async (req, res) => {
  try {
    console.log('POST /api/settings/test-elevenlabs - Testing ElevenLabs connectivity');
    
    const { apiKey } = req.body;
    
    console.log('Request body keys:', Object.keys(req.body));
    console.log('API key received:', apiKey ? `${apiKey.substring(0, 8)}...` : 'undefined/null');
    console.log('API key length:', apiKey ? apiKey.length : 0);
    
    if (!apiKey || apiKey.trim() === '') {
      console.log('API key validation failed - empty or missing');
      return res.status(400).json({
        success: false,
        message: 'API key is required for testing'
      });
    }
    
    // Test the API key by making a request to ElevenLabs
    const axios = require('axios');
    
    try {
      console.log('Making request to ElevenLabs API...');
      const response = await axios.get('https://api.elevenlabs.io/v1/voices', {
        headers: {
          'xi-api-key': apiKey.trim(),
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      
      const voiceCount = response.data.voices ? response.data.voices.length : 0;
      
      console.log(`ElevenLabs API key test successful - found ${voiceCount} voices`);
      res.status(200).json({
        success: true,
        message: 'ElevenLabs API key is valid',
        voiceCount: voiceCount
      });
      
    } catch (apiError) {
      console.log('ElevenLabs API key test failed:', apiError.response?.status, apiError.message);
      console.log('ElevenLabs API error response:', apiError.response?.data);
      
      if (apiError.response?.status === 401) {
        res.status(400).json({
          success: false,
          message: 'Invalid ElevenLabs API key - authentication failed'
        });
      } else if (apiError.response?.status === 403) {
        res.status(400).json({
          success: false,
          message: 'ElevenLabs API key lacks necessary permissions'
        });
      } else {
        res.status(400).json({
          success: false,
          message: 'Failed to connect to ElevenLabs API',
          error: apiError.message
        });
      }
    }

  } catch (error) {
    console.error('Error in POST /api/settings/test-elevenlabs:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test ElevenLabs API key',
      error: error.message
    });
  }
});

module.exports = router;
const express = require('express');
const router = express.Router();
const settingsService = require('../services/settingsService');
const { testOpenAIModelCompatibility } = require('../services/llmService');
const { requireAdmin } = require('./middlewares/auth');

// Create auth middleware instance
const auth = requireAdmin();

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

/**
 * POST /api/settings/test-openai
 * Test OpenAI API key connectivity
 */
router.post('/test-openai', auth, async (req, res) => {
  try {
    console.log('POST /api/settings/test-openai - Testing OpenAI connectivity');
    
    const { apiKey, model } = req.body;
    
    console.log('Request body keys:', Object.keys(req.body));
    console.log('API key received:', apiKey ? `${apiKey.substring(0, 8)}...` : 'undefined/null');
    console.log('Model specified:', model || 'none');
    
    if (!apiKey || apiKey.trim() === '') {
      console.log('API key validation failed - empty or missing');
      return res.status(400).json({
        success: false,
        message: 'API key is required for testing'
      });
    }

    const testModel = (typeof model === 'string' && model.trim())
      ? model.trim()
      : 'gpt-5.2-codex';
    
    try {
      console.log(`Testing with model: ${testModel}`);

      await testOpenAIModelCompatibility(
        testModel,
        apiKey.trim(),
        'Return JSON with one key: {"status":"ok"}'
      );
      
      console.log('OpenAI API key test successful');
      res.status(200).json({
        success: true,
        message: 'OpenAI API key/model are valid for HomeBrain requests',
        model: testModel
      });
      
    } catch (apiError) {
      console.log('OpenAI API key test failed:', apiError.message);
      console.log('OpenAI API error details:', apiError);

      if (apiError.status === 401) {
        res.status(400).json({
          success: false,
          message: 'Invalid OpenAI API key - authentication failed'
        });
      } else if (apiError.status === 403) {
        res.status(400).json({
          success: false,
          message: 'OpenAI API key lacks necessary permissions'
        });
      } else if (apiError.status === 404) {
        res.status(400).json({
          success: false,
          message: `Model "${testModel}" not found or you do not have access. Try "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5", or "gpt-5-mini".`
        });
      } else if (apiError.status === 429) {
        res.status(400).json({
          success: false,
          message: 'OpenAI API rate limit exceeded'
        });
      } else if (apiError.code === 'unsupported_parameter' || apiError.code === 'invalid_request_error') {
        res.status(400).json({
          success: false,
          message: `Model configuration error: ${apiError.message}. HomeBrain now tries Responses API first with Chat Completions fallback; confirm the model ID is correct.`
        });
      } else {
        res.status(400).json({
          success: false,
          message: 'Failed to connect to OpenAI API',
          error: apiError.message
        });
      }
    }

  } catch (error) {
    console.error('Error in POST /api/settings/test-openai:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test OpenAI API key',
      error: error.message
    });
  }
});

/**
 * POST /api/settings/test-anthropic
 * Test Anthropic API key connectivity
 */
router.post('/test-anthropic', auth, async (req, res) => {
  try {
    console.log('POST /api/settings/test-anthropic - Testing Anthropic connectivity');
    
    const { apiKey, model } = req.body;
    
    console.log('Request body keys:', Object.keys(req.body));
    console.log('API key received:', apiKey ? `${apiKey.substring(0, 8)}...` : 'undefined/null');
    console.log('Model specified:', model || 'none');
    
    if (!apiKey || apiKey.trim() === '') {
      console.log('API key validation failed - empty or missing');
      return res.status(400).json({
        success: false,
        message: 'API key is required for testing'
      });
    }
    
    // Test the API key by making a request to Anthropic
    const Anthropic = require('@anthropic-ai/sdk');
    
    try {
      console.log('Creating Anthropic client and testing connection...');
      const anthropic = new Anthropic({
        apiKey: apiKey.trim()
      });
      
      // Make a simple message request to test the key
      const testModel = model || 'claude-3-haiku-20240307';
      console.log(`Testing with model: ${testModel}`);
      
      const response = await anthropic.messages.create({
        model: testModel,
        messages: [{ role: 'user', content: 'Hello, this is a test.' }],
        max_tokens: 10
      });
      
      console.log('Anthropic API key test successful');
      res.status(200).json({
        success: true,
        message: 'Anthropic API key is valid',
        model: testModel
      });
      
    } catch (apiError) {
      console.log('Anthropic API key test failed:', apiError.message);
      console.log('Anthropic API error details:', apiError);
      
      if (apiError.status === 401) {
        res.status(400).json({
          success: false,
          message: 'Invalid Anthropic API key - authentication failed'
        });
      } else if (apiError.status === 403) {
        res.status(400).json({
          success: false,
          message: 'Anthropic API key lacks necessary permissions'
        });
      } else if (apiError.status === 429) {
        res.status(400).json({
          success: false,
          message: 'Anthropic API rate limit exceeded'
        });
      } else {
        res.status(400).json({
          success: false,
          message: 'Failed to connect to Anthropic API',
          error: apiError.message
        });
      }
    }

  } catch (error) {
    console.error('Error in POST /api/settings/test-anthropic:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test Anthropic API key',
      error: error.message
    });
  }
});

/**
 * POST /api/settings/test-local-llm
 * Test local LLM endpoint connectivity
 */
router.post('/test-local-llm', auth, async (req, res) => {
  try {
    console.log('POST /api/settings/test-local-llm - Testing local LLM connectivity');
    
    const { endpoint, model } = req.body;
    
    console.log('Request body keys:', Object.keys(req.body));
    console.log('Endpoint received:', endpoint || 'undefined/null');
    console.log('Model specified:', model || 'none');
    
    if (!endpoint || endpoint.trim() === '') {
      console.log('Endpoint validation failed - empty or missing');
      return res.status(400).json({
        success: false,
        message: 'Endpoint URL is required for testing'
      });
    }
    
    // Test the endpoint by making a health check or simple request
    const axios = require('axios');
    
    try {
      console.log('Testing local LLM endpoint connectivity...');
      
      // First try a health check endpoint
      let testUrl = endpoint.trim();
      if (!testUrl.startsWith('http://') && !testUrl.startsWith('https://')) {
        testUrl = 'http://' + testUrl;
      }
      
      // Try common LLM server endpoints for health check
      let response;
      try {
        response = await axios.get(`${testUrl}/health`, { timeout: 5000 });
      } catch (healthError) {
        console.log('Health endpoint not available, trying completions endpoint...');
        // Try a simple completion request instead
        response = await axios.post(`${testUrl}/v1/completions`, {
          model: model || 'default',
          prompt: 'Test',
          max_tokens: 1
        }, { 
          timeout: 10000,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      console.log('Local LLM endpoint test successful');
      res.status(200).json({
        success: true,
        message: 'Local LLM endpoint is accessible',
        endpoint: testUrl
      });
      
    } catch (apiError) {
      console.log('Local LLM endpoint test failed:', apiError.message);
      console.log('Local LLM error details:', apiError.code);
      
      if (apiError.code === 'ECONNREFUSED') {
        res.status(400).json({
          success: false,
          message: 'Cannot connect to local LLM endpoint - connection refused'
        });
      } else if (apiError.code === 'ETIMEDOUT') {
        res.status(400).json({
          success: false,
          message: 'Local LLM endpoint connection timed out'
        });
      } else {
        res.status(400).json({
          success: false,
          message: 'Failed to connect to local LLM endpoint',
          error: apiError.message
        });
      }
    }

  } catch (error) {
    console.error('Error in POST /api/settings/test-local-llm:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test local LLM endpoint',
      error: error.message
    });
  }
});

// Description: Get LLM priority list
// Endpoint: GET /api/settings/llm-priority
// Request: {}
// Response: { success: boolean, priorityList: Array<string> }
router.get('/llm-priority', auth, async (req, res) => {
  try {
    console.log('GET /api/settings/llm-priority - Fetching LLM priority list');

    const settings = await settingsService.getSettings();
    const priorityList = settings.llmPriorityList || ['local', 'openai', 'anthropic'];

    console.log('Successfully retrieved LLM priority list:', priorityList);
    res.status(200).json({
      success: true,
      priorityList: priorityList
    });

  } catch (error) {
    console.error('Error in GET /api/settings/llm-priority:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch LLM priority list',
      error: error.message
    });
  }
});

// Description: Update LLM priority list
// Endpoint: PUT /api/settings/llm-priority
// Request: { priorityList: Array<string> }
// Response: { success: boolean, message: string, priorityList: Array<string> }
router.put('/llm-priority', auth, async (req, res) => {
  try {
    console.log('PUT /api/settings/llm-priority - Updating LLM priority list');

    const { priorityList } = req.body;

    if (!priorityList || !Array.isArray(priorityList)) {
      console.log('Invalid priority list format');
      return res.status(400).json({
        success: false,
        message: 'Priority list must be an array'
      });
    }

    // Validate that all providers are valid
    const validProviders = ['openai', 'anthropic', 'local'];
    const invalidProviders = priorityList.filter(p => !validProviders.includes(p));

    if (invalidProviders.length > 0) {
      console.log('Invalid providers in priority list:', invalidProviders);
      return res.status(400).json({
        success: false,
        message: `Invalid providers: ${invalidProviders.join(', ')}`
      });
    }

    console.log('New priority list:', priorityList);

    const settings = await settingsService.updateSettings({ llmPriorityList: priorityList });

    console.log('Successfully updated LLM priority list');
    res.status(200).json({
      success: true,
      message: 'LLM priority list updated successfully',
      priorityList: settings.llmPriorityList
    });

  } catch (error) {
    console.error('Error in PUT /api/settings/llm-priority:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update LLM priority list',
      error: error.message
    });
  }
});

/**
 * POST /api/settings/test-smartthings
 * Test SmartThings API connectivity
 */
router.post('/test-smartthings', auth, async (req, res) => {
  try {
    console.log('POST /api/settings/test-smartthings - Testing SmartThings connectivity');

    const { token, useOAuth } = req.body;

    // Import the SmartThings service
    const smartThingsService = require('../services/smartThingsService');

    if (useOAuth === false && token) {
      // Test with provided PAT
      console.log('Testing SmartThings with Personal Access Token');

      const axios = require('axios');
      const response = await axios.get('https://api.smartthings.com/v1/devices', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      console.log('SmartThings PAT test successful');
      res.status(200).json({
        success: true,
        message: 'SmartThings Personal Access Token is valid',
        deviceCount: response.data.items?.length || 0
      });
    } else {
      // Test with OAuth integration
      console.log('Testing SmartThings with OAuth');

      const result = await smartThingsService.testConnection();

      console.log('SmartThings OAuth test successful');
      res.status(200).json(result);
    }

  } catch (error) {
    console.log('SmartThings connectivity test failed:', error.message);
    console.log('SmartThings error details:', error.response?.data || error.code);

    if (error.response?.status === 401) {
      return res.status(400).json({
        success: false,
        message: 'SmartThings authentication failed - invalid token or OAuth not configured'
      });
    } else if (error.response?.status === 403) {
      return res.status(400).json({
        success: false,
        message: 'SmartThings access forbidden - check token permissions'
      });
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return res.status(400).json({
        success: false,
        message: 'Cannot connect to SmartThings API - network issue'
      });
    }

    console.error('Error in POST /api/settings/test-smartthings:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test SmartThings connectivity',
      error: error.message
    });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const ollamaService = require('../services/ollamaService');
const OllamaConfig = require('../models/OllamaConfig');

// Description: Get Ollama status and configuration
// Endpoint: GET /api/ollama/status
// Request: {}
// Response: { isInstalled: boolean, version: string, serviceRunning: boolean, installedModels: Array, activeModel: string, ... }
router.get('/status', requireUser, async (req, res) => {
  try {
    console.log('GET /api/ollama/status - Fetching Ollama status');

    // Set a timeout for the entire operation
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Status check timeout')), 15000)
    );

    const statusPromise = ollamaService.getStatus();

    const status = await Promise.race([statusPromise, timeoutPromise]).catch(error => {
      console.error('Status check timed out or failed:', error.message);
      // Return default status if check fails
      return {
        isInstalled: false,
        version: null,
        serviceRunning: false,
        serviceStatus: 'not_installed',
        installedModels: [],
        activeModel: null,
        configuration: {
          apiUrl: 'http://localhost:11434',
          maxConcurrentRequests: 1,
          contextLength: 2048,
          gpuLayers: -1
        },
        updateAvailable: false,
        latestVersion: null,
        lastUpdateCheck: null,
        statistics: {
          totalChats: 0,
          totalTokensProcessed: 0,
          averageResponseTime: 0
        },
        lastError: {
          message: 'Status check timeout - Ollama may not be accessible',
          timestamp: new Date()
        }
      };
    });

    res.status(200).json(status);
  } catch (error) {
    console.error('Error fetching Ollama status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Install Ollama
// Endpoint: POST /api/ollama/install
// Request: {}
// Response: { success: boolean, version: string }
router.post('/install', requireUser, async (req, res) => {
  try {
    console.log('POST /api/ollama/install - Starting Ollama installation');

    const result = await ollamaService.install();

    res.status(200).json(result);
  } catch (error) {
    console.error('Error installing Ollama:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Start Ollama service
// Endpoint: POST /api/ollama/service/start
// Request: {}
// Response: { success: boolean, message: string }
router.post('/service/start', requireUser, async (req, res) => {
  try {
    console.log('POST /api/ollama/service/start - Starting Ollama service');

    const result = await ollamaService.startService();

    res.status(200).json(result);
  } catch (error) {
    console.error('Error starting Ollama service:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Stop Ollama service
// Endpoint: POST /api/ollama/service/stop
// Request: {}
// Response: { success: boolean, message: string }
router.post('/service/stop', requireUser, async (req, res) => {
  try {
    console.log('POST /api/ollama/service/stop - Stopping Ollama service');

    const result = await ollamaService.stopService();

    res.status(200).json(result);
  } catch (error) {
    console.error('Error stopping Ollama service:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Check for Ollama updates
// Endpoint: GET /api/ollama/updates/check
// Request: {}
// Response: { updateAvailable: boolean, currentVersion: string, latestVersion: string }
router.get('/updates/check', requireUser, async (req, res) => {
  try {
    console.log('GET /api/ollama/updates/check - Checking for Ollama updates');

    const result = await ollamaService.checkForUpdates();

    res.status(200).json(result);
  } catch (error) {
    console.error('Error checking for updates:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Update Ollama to latest version
// Endpoint: POST /api/ollama/update
// Request: {}
// Response: { success: boolean, version: string }
router.post('/update', requireUser, async (req, res) => {
  try {
    console.log('POST /api/ollama/update - Updating Ollama');

    const result = await ollamaService.update();

    res.status(200).json(result);
  } catch (error) {
    console.error('Error updating Ollama:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: List installed models
// Endpoint: GET /api/ollama/models
// Request: {}
// Response: { models: Array<{ name: string, size: number, modifiedAt: Date, ... }> }
router.get('/models', requireUser, async (req, res) => {
  try {
    console.log('GET /api/ollama/models - Fetching installed models');

    const models = await ollamaService.listModels();

    res.status(200).json({ models });
  } catch (error) {
    console.error('Error fetching models:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Get available models for download
// Endpoint: GET /api/ollama/models/available
// Request: {}
// Response: { models: Array<{ name: string, description: string, size: string, parameterSize: string }> }
router.get('/models/available', requireUser, async (req, res) => {
  try {
    console.log('GET /api/ollama/models/available - Fetching available models');

    const models = await ollamaService.getAvailableModels();

    res.status(200).json({ models });
  } catch (error) {
    console.error('Error fetching available models:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Pull/download a model
// Endpoint: POST /api/ollama/models/pull
// Request: { modelName: string }
// Response: { success: boolean, message: string }
router.post('/models/pull', requireUser, async (req, res) => {
  try {
    const { modelName } = req.body;

    if (!modelName) {
      return res.status(400).json({ error: 'Model name is required' });
    }

    console.log(`POST /api/ollama/models/pull - Pulling model: ${modelName}`);

    const result = await ollamaService.pullModel(modelName);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error pulling model:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Delete a model
// Endpoint: DELETE /api/ollama/models/:name
// Request: {}
// Response: { success: boolean, message: string }
router.delete('/models/:name', requireUser, async (req, res) => {
  try {
    const modelName = req.params.name;

    console.log(`DELETE /api/ollama/models/${modelName} - Deleting model`);

    const result = await ollamaService.deleteModel(modelName);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error deleting model:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Set active model
// Endpoint: POST /api/ollama/models/activate
// Request: { modelName: string }
// Response: { success: boolean, activeModel: string }
router.post('/models/activate', requireUser, async (req, res) => {
  try {
    const { modelName } = req.body;

    if (!modelName) {
      return res.status(400).json({ error: 'Model name is required' });
    }

    console.log(`POST /api/ollama/models/activate - Activating model: ${modelName}`);

    const result = await ollamaService.setActiveModel(modelName);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error activating model:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Send chat message to model
// Endpoint: POST /api/ollama/chat
// Request: { modelName?: string, message: string, conversationHistory?: Array<{ role: string, content: string }> }
// Response: { message: string, model: string, done: boolean, totalDuration: number, ... }
router.post('/chat', requireUser, async (req, res) => {
  try {
    let { modelName, message, conversationHistory } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Use active model if not specified
    if (!modelName) {
      const config = await OllamaConfig.getConfig();
      modelName = config.activeModel;

      if (!modelName) {
        return res.status(400).json({ error: 'No active model set. Please specify a model or set an active model.' });
      }
    }

    console.log(`POST /api/ollama/chat - Sending message to model: ${modelName}`);

    // Build messages array
    const messages = conversationHistory || [];
    messages.push({ role: 'user', content: message });

    // Save user message to history
    const config = await OllamaConfig.getConfig();
    await config.addChatMessage('user', message, modelName);

    const result = await ollamaService.chat(modelName, messages);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error during chat:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Generate text completion
// Endpoint: POST /api/ollama/generate
// Request: { modelName?: string, prompt: string }
// Response: { response: string, model: string, done: boolean, totalDuration: number }
router.post('/generate', requireUser, async (req, res) => {
  try {
    let { modelName, prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Use active model if not specified
    if (!modelName) {
      const config = await OllamaConfig.getConfig();
      modelName = config.activeModel;

      if (!modelName) {
        return res.status(400).json({ error: 'No active model set. Please specify a model or set an active model.' });
      }
    }

    console.log(`POST /api/ollama/generate - Generating text with model: ${modelName}`);

    const result = await ollamaService.generate(modelName, prompt);

    res.status(200).json(result);
  } catch (error) {
    console.error('Error during generation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Get chat history
// Endpoint: GET /api/ollama/chat/history
// Request: { limit?: number }
// Response: { history: Array<{ role: string, content: string, timestamp: Date, model: string }> }
router.get('/chat/history', requireUser, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;

    console.log(`GET /api/ollama/chat/history - Fetching chat history (limit: ${limit})`);

    const history = await ollamaService.getChatHistory(limit);

    res.status(200).json({ history });
  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Clear chat history
// Endpoint: DELETE /api/ollama/chat/history
// Request: {}
// Response: { success: boolean, message: string }
router.delete('/chat/history', requireUser, async (req, res) => {
  try {
    console.log('DELETE /api/ollama/chat/history - Clearing chat history');

    const result = await ollamaService.clearChatHistory();

    res.status(200).json(result);
  } catch (error) {
    console.error('Error clearing chat history:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

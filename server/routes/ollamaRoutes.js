const express = require('express');
const router = express.Router();
const { requireAdmin } = require('./middlewares/auth');
const ollamaService = require('../services/ollamaService');
const spamFilterService = require('../services/spamFilterService');
const OllamaConfig = require('../models/OllamaConfig');
const settingsService = require('../services/settingsService');

// Create auth middleware instance
const auth = requireAdmin();

// Description: Get Ollama status and configuration
// Endpoint: GET /api/ollama/status
// Request: {}
// Response: { isInstalled: boolean, version: string, serviceRunning: boolean, installedModels: Array, activeModel: string, ... }
router.get('/status', auth, async (req, res) => {
  try {
    console.log('GET /api/ollama/status - Fetching Ollama status');

    // Set a timeout for the entire operation
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Status check timeout')), 15000)
    );

    const statusPromise = ollamaService.getStatus();

    const status = await Promise.race([statusPromise, timeoutPromise]).catch(async (error) => {
      console.error('Status check timed out or failed:', error.message);
      const cachedConfig = await OllamaConfig.getConfig().catch(() => null);
      const cachedSettings = await settingsService.getSettings().catch(() => null);
      const cachedSharedModel =
        cachedSettings?.homebrainLocalLlmModel ||
        cachedSettings?.localLlmModel ||
        cachedSettings?.spamFilterLocalLlmModel ||
        cachedConfig?.activeModel ||
        null;
      const cachedServiceStatus = cachedConfig?.serviceStatus || 'unknown';
      const cachedInstalled = Boolean(
        cachedConfig?.isInstalled ||
        cachedConfig?.version ||
        cachedServiceStatus !== 'not_installed' ||
        (Array.isArray(cachedConfig?.installedModels) && cachedConfig.installedModels.length > 0)
      );

      return {
        isInstalled: cachedInstalled,
        version: cachedConfig?.version || null,
        hostPlatform: process.platform,
        hostArch: process.arch,
        serviceRunning: cachedServiceStatus === 'running' || cachedServiceStatus === 'running_external',
        serviceStatus: cachedServiceStatus,
        serviceOwner: cachedConfig?.serviceOwner || null,
        installedModels: Array.isArray(cachedConfig?.installedModels) ? cachedConfig.installedModels : [],
        activeModel: cachedConfig?.activeModel || cachedSharedModel,
        sharedLocalLlmModel: cachedSharedModel,
        homebrainLocalLlmModel: cachedSharedModel,
        spamFilterLocalLlmModel: cachedSharedModel,
        configuration: cachedConfig?.configuration || {
          apiUrl: 'http://localhost:11434',
          maxConcurrentRequests: 1,
          contextLength: 2048,
          gpuLayers: -1
        },
        updateAvailable: Boolean(cachedConfig?.updateAvailable),
        latestVersion: cachedConfig?.latestVersion || null,
        lastUpdateCheck: cachedConfig?.lastUpdateCheck || null,
        statistics: cachedConfig?.statistics || {
          totalChats: 0,
          totalTokensProcessed: 0,
          averageResponseTime: 0
        },
        lastError: {
          message: `Live status unavailable: ${error.message}`,
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

// Description: Fetch recent Ollama service logs
// Endpoint: GET /api/ollama/logs
// Request: { lines?: number }
// Response: { success: boolean, source: string|null, sourceType: string|null, lines: string[], lineCount: number, truncated: boolean, message?: string }
router.get('/logs', auth, async (req, res) => {
  try {
    console.log('GET /api/ollama/logs - Fetching Ollama logs');

    const linesParam = Array.isArray(req.query.lines) ? req.query.lines[0] : req.query.lines;
    const parsedLines = linesParam !== undefined ? parseInt(linesParam, 10) : undefined;

    const result = await ollamaService.getServiceLogs({
      lines: Number.isNaN(parsedLines) ? undefined : parsedLines
    });

    res.status(200).json({
      success: Array.isArray(result.lines) && result.lines.length > 0,
      ...result
    });
  } catch (error) {
    console.error('Error fetching Ollama logs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch Ollama logs',
      error: error.message
    });
  }
});

// Description: Install Ollama
// Endpoint: POST /api/ollama/install
// Request: { sudoPassword?: string }
// Response: { success: boolean, version: string }
router.post('/install', auth, async (req, res) => {
  try {
    console.log('POST /api/ollama/install - Starting Ollama installation');

    const sudoPassword = typeof req.body?.sudoPassword === 'string' ? req.body.sudoPassword : null;
    const result = await ollamaService.install({ sudoPassword });

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
router.post('/service/start', auth, async (req, res) => {
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
router.post('/service/stop', auth, async (req, res) => {
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
router.get('/updates/check', auth, async (req, res) => {
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
// Request: { sudoPassword?: string }
// Response: { success: boolean, version: string }
router.post('/update', auth, async (req, res) => {
  try {
    console.log('POST /api/ollama/update - Updating Ollama');

    const sudoPassword = typeof req.body?.sudoPassword === 'string' ? req.body.sudoPassword : null;
    const result = await ollamaService.update({ sudoPassword });

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
router.get('/models', auth, async (req, res) => {
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
// Request: { q?: string, c?: string|string[], o?: "popular"|"newest", maxPages?: number }
// Response: { models: Array<{ name: string, description: string, size: string, parameterSize: string, capabilities?: string[], nanoFit?: boolean }> }
router.get('/models/available', auth, async (req, res) => {
  try {
    console.log('GET /api/ollama/models/available - Fetching available models');

    const query = typeof req.query?.q === 'string' ? req.query.q : '';
    const sort = req.query?.o === 'newest' ? 'newest' : 'popular';
    const maxPages = req.query?.maxPages ? Number.parseInt(req.query.maxPages, 10) : undefined;
    const capabilities = Array.isArray(req.query?.c)
      ? req.query.c
      : (typeof req.query?.c === 'string' && req.query.c.trim().length > 0 ? [req.query.c] : []);
    const models = await ollamaService.getAvailableModels({
      query,
      sort,
      capabilities,
      maxPages
    });

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
router.post('/models/pull', auth, async (req, res) => {
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

// Description: Get active model pull/download status
// Endpoint: GET /api/ollama/models/pull/status
// Request: {}
// Response: { active: boolean, modelName: string|null, phase: string, status: string, message: string, percent?: number|null, completed?: number|null, total?: number|null }
router.get('/models/pull/status', auth, async (req, res) => {
  try {
    console.log('GET /api/ollama/models/pull/status - Fetching model pull status');

    const status = ollamaService.getModelPullStatus();

    res.status(200).json(status);
  } catch (error) {
    console.error('Error fetching model pull status:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Delete a model
// Endpoint: DELETE /api/ollama/models/:name
// Request: {}
// Response: { success: boolean, message: string }
router.delete('/models/:name', auth, async (req, res) => {
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
router.post('/models/activate', auth, async (req, res) => {
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

// Description: Update the single shared local model used by HomeBrain, chat, and spam filtering
// Endpoint: POST /api/ollama/models/roles
// Request: { modelName?: string, homebrainLocalLlmModel?: string, spamFilterLocalLlmModel?: string }
// Response: { success: boolean, modelName: string, activeModel: string, homebrainLocalLlmModel: string, spamFilterLocalLlmModel: string }
router.post('/models/roles', auth, async (req, res) => {
  try {
    const requestedModelName = typeof req.body?.modelName === 'string'
      ? req.body.modelName.trim()
      : '';
    const homebrainLocalLlmModel = typeof req.body?.homebrainLocalLlmModel === 'string'
      ? req.body.homebrainLocalLlmModel.trim()
      : '';
    const spamFilterLocalLlmModel = typeof req.body?.spamFilterLocalLlmModel === 'string'
      ? req.body.spamFilterLocalLlmModel.trim()
      : '';
    const modelName = requestedModelName || homebrainLocalLlmModel || spamFilterLocalLlmModel;

    if (!modelName) {
      return res.status(400).json({ error: 'A shared model is required.' });
    }

    const config = await OllamaConfig.getConfig();
    const installedModels = Array.isArray(config?.installedModels) ? config.installedModels : [];
    const installedModelNames = new Set(
      installedModels
        .map((model) => (typeof model?.name === 'string' ? model.name.trim() : ''))
        .filter(Boolean)
    );

    if (!installedModelNames.has(modelName)) {
      return res.status(400).json({
        error: `Model not installed in Ollama: ${modelName}`
      });
    }

    await settingsService.updateSettings({
      homebrainLocalLlmModel: modelName,
      spamFilterLocalLlmModel: modelName
    });
    await ollamaService.setActiveModel(modelName);

    res.status(200).json({
      success: true,
      modelName,
      activeModel: modelName,
      homebrainLocalLlmModel: modelName,
      spamFilterLocalLlmModel: modelName
    });
  } catch (error) {
    console.error('Error updating shared Ollama model:', error);
    res.status(500).json({ error: error.message });
  }
});

// Description: Send chat message to model
// Endpoint: POST /api/ollama/chat
// Request: { modelName?: string, message: string, conversationHistory?: Array<{ role: string, content: string }> }
// Response: { message: string, model: string, done: boolean, totalDuration: number, ... }
router.post('/chat', auth, async (req, res) => {
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
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Description: Generate text completion
// Endpoint: POST /api/ollama/generate
// Request: { modelName?: string, prompt: string }
// Response: { response: string, model: string, done: boolean, totalDuration: number }
router.post('/generate', auth, async (req, res) => {
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
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Description: Classify an email with the configured spam-filter local model
// Endpoint: POST /api/ollama/spam/filter
// Request: { subject?: string, from?: string, to?: string, text?: string, html?: string, messageId?: string }
// Response: { success: boolean, classification: "spam"|"inbox"|"review", recommendedAction: string, ... }
router.post('/spam/filter', auth, async (req, res) => {
  try {
    console.log('POST /api/ollama/spam/filter - Classifying email with spam filter model');

    const result = await spamFilterService.classifyEmail(req.body || {});

    res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Error during spam filtering:', error);

    const status = /required|configured|not installed/i.test(error.message) ? 400 : 500;
    res.status(status).json({
      success: false,
      error: error.message
    });
  }
});

// Description: Get chat history
// Endpoint: GET /api/ollama/chat/history
// Request: { limit?: number }
// Response: { history: Array<{ role: string, content: string, timestamp: Date, model: string }> }
router.get('/chat/history', auth, async (req, res) => {
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
router.delete('/chat/history', auth, async (req, res) => {
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

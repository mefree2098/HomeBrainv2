const express = require('express');
const router = express.Router();
const whisperService = require('../services/whisperService');
const { requireAdmin } = require('./middlewares/auth');

const auth = requireAdmin();
const ALLOWED_START_MODELS = new Set(['tiny', 'base', 'small', 'small.en', 'medium']);
const ALLOWED_START_DEVICES = new Set(['auto', 'default', 'cpu', 'cuda']);
const ALLOWED_START_COMPUTE_TYPES = new Set(['auto', 'default', 'float16', 'int8_float16', 'float32', 'int8']);

function normalizeAllowedString(value, allowedValues, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    const error = new Error(`${fieldName} must be a string`);
    error.status = 400;
    throw error;
  }
  const normalized = value.trim().toLowerCase();
  if (!allowedValues.has(normalized)) {
    const error = new Error(`${fieldName} is not supported`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

router.get('/status', auth, async (req, res) => {
  try {
    console.log('GET /api/whisper/status - Fetching Whisper status');
    const status = await whisperService.getStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting Whisper status:', error.message);
    res.status(500).json({ error: error.message || 'Failed to get Whisper status' });
  }
});

router.post('/install', auth, async (req, res) => {
  try {
    console.log('POST /api/whisper/install - Installing Whisper dependencies');
    const result = await whisperService.installDependencies();
    res.json(result);
  } catch (error) {
    console.error('Error installing Whisper dependencies:', error.message);
    res.status(500).json({ error: error.message || 'Failed to install Whisper dependencies' });
  }
});

router.post('/service/start', auth, async (req, res) => {
  try {
    console.log('POST /api/whisper/service/start - Starting Whisper service');
    const { model, devicePreference, computePreference } = req.body || {};
    const normalizedModel = normalizeAllowedString(model, ALLOWED_START_MODELS, 'model');
    const normalizedDevicePreference = normalizeAllowedString(devicePreference, ALLOWED_START_DEVICES, 'devicePreference');
    const normalizedComputePreference = normalizeAllowedString(computePreference, ALLOWED_START_COMPUTE_TYPES, 'computePreference');
    const options = {};
    if (normalizedDevicePreference) {
      options.devicePreference = normalizedDevicePreference;
    }
    if (normalizedComputePreference) {
      options.computePreference = normalizedComputePreference;
    }
    const result = await whisperService.startService(normalizedModel || undefined, options);
    res.json(result);
  } catch (error) {
    console.error('Error starting Whisper service:', error.message);
    res.status(error.status || 500).json({ error: error.message || 'Failed to start Whisper service' });
  }
});

router.post('/service/stop', auth, async (req, res) => {
  try {
    console.log('POST /api/whisper/service/stop - Stopping Whisper service');
    const result = await whisperService.stopService();
    res.json(result);
  } catch (error) {
    console.error('Error stopping Whisper service:', error.message);
    res.status(500).json({ error: error.message || 'Failed to stop Whisper service' });
  }
});

router.get('/models', auth, async (req, res) => {
  try {
    console.log('GET /api/whisper/models - Listing installed Whisper models');
    const models = await whisperService.listInstalledModels();
    res.json({ models });
  } catch (error) {
    console.error('Error listing Whisper models:', error.message);
    res.status(500).json({ error: error.message || 'Failed to list Whisper models' });
  }
});

router.get('/models/available', auth, async (req, res) => {
  try {
    console.log('GET /api/whisper/models/available - Listing available Whisper models');
    const models = await whisperService.listAvailableModels();
    res.json({ models });
  } catch (error) {
    console.error('Error listing available Whisper models:', error.message);
    res.status(500).json({ error: error.message || 'Failed to list available Whisper models' });
  }
});

router.post('/models/download', auth, async (req, res) => {
  try {
    const { modelName } = req.body || {};
    if (!modelName) {
      return res.status(400).json({ error: 'modelName is required' });
    }
    console.log(`POST /api/whisper/models/download - Downloading model ${modelName}`);
    const result = await whisperService.downloadModel(modelName);
    res.json(result);
  } catch (error) {
    console.error('Error downloading Whisper model:', error.message);
    res.status(500).json({ error: error.message || 'Failed to download Whisper model' });
  }
});

router.post('/models/activate', auth, async (req, res) => {
  try {
    const { modelName } = req.body || {};
    if (!modelName) {
      return res.status(400).json({ error: 'modelName is required' });
    }
    console.log(`POST /api/whisper/models/activate - Activating model ${modelName}`);
    const result = await whisperService.setActiveModel(modelName);
    res.json(result);
  } catch (error) {
    console.error('Error setting active Whisper model:', error.message);
    res.status(500).json({ error: error.message || 'Failed to set active Whisper model' });
  }
});

router.get('/logs', auth, async (req, res) => {
  try {
    const status = await whisperService.getStatus();
    res.json({
      success: true,
      logs: status.logs || []
    });
  } catch (error) {
    console.error('Error fetching Whisper logs:', error.message);
    res.status(500).json({ error: error.message || 'Failed to fetch Whisper logs' });
  }
});

module.exports = router;

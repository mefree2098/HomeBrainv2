const express = require('express');
const router = express.Router();
const fs = require('fs');
const fsp = fs.promises;
const WakeWordModel = require('../models/WakeWordModel');
const wakeWordTrainingService = require('../services/wakeWordTrainingService');
const { requireAdmin } = require('./middlewares/auth');

const admin = requireAdmin();

const serializeModel = (model) => ({
  id: model._id,
  phrase: model.phrase,
  slug: model.slug,
  status: model.status,
  progress: model.progress ?? 0,
  statusMessage: model.statusMessage || null,
  engine: model.engine,
  format: model.format,
  modelPath: model.modelPath || null,
  checksum: model.checksum || null,
  metadata: model.metadata || {},
  trainingMetadata: model.trainingMetadata || {},
  error: model.error || null,
  profiles: Array.isArray(model.profiles) ? model.profiles.map((id) => id.toString()) : [],
  createdAt: model.createdAt,
  updatedAt: model.updatedAt,
  lastTrainedAt: model.lastTrainedAt || null
});

router.get('/', admin, async (req, res) => {
  try {
    const query = {};
    if (req.query.status) {
      query.status = req.query.status;
    }
    if (req.query.slug) {
      query.slug = req.query.slug.toLowerCase();
    }
    const models = await WakeWordModel.find(query).sort({ updatedAt: -1 });
    res.status(200).json({
      success: true,
      count: models.length,
      models: models.map(serializeModel)
    });
  } catch (error) {
    console.error('GET /api/wake-words - Error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch wake word models'
    });
  }
});

// Broadcast updated wake word configuration to connected devices
router.post('/broadcast', admin, async (req, res) => {
  try {
    const { phrase, slug } = req.body || {};
    const voiceWs = req.app.get('voiceWebSocket');
    if (!voiceWs || typeof voiceWs.broadcastWakeWordUpdate !== 'function') {
      return res.status(503).json({ success: false, message: 'Voice WebSocket unavailable' });
    }

    let phrases = [];
    if (phrase && typeof phrase === 'string' && phrase.trim()) {
      phrases = [phrase.trim()];
    } else if (slug && typeof slug === 'string' && slug.trim()) {
      const model = await WakeWordModel.findOne({ slug: slug.trim() });
      if (model && model.phrase) phrases = [model.phrase];
    } else {
      const readyModels = await WakeWordModel.find({ status: 'ready' });
      phrases = readyModels.map((m) => m.phrase).filter(Boolean);
    }

    const unique = Array.from(new Set(phrases));
    for (const p of unique) {
      await voiceWs.broadcastWakeWordUpdate(p);
    }

    return res.status(200).json({ success: true, count: unique.length, phrases: unique });
  } catch (error) {
    console.error('POST /api/wake-words/broadcast - Error:', error.message);
    return res.status(500).json({ success: false, message: error.message || 'Failed to broadcast wake word update' });
  }
});

router.get('/queue', admin, async (req, res) => {
  try {
    const queue = await wakeWordTrainingService.getQueueStatus();
    res.status(200).json({
      success: true,
      queue
    });
  } catch (error) {
    console.error('GET /api/wake-words/queue - Error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch queue status'
    });
  }
});

router.get('/:id', admin, async (req, res) => {
  try {
    const model = await WakeWordModel.findById(req.params.id);
    if (!model) {
      return res.status(404).json({
        success: false,
        message: 'Wake word model not found'
      });
    }
    res.status(200).json({
      success: true,
      model: serializeModel(model)
    });
  } catch (error) {
    console.error(`GET /api/wake-words/${req.params.id} - Error:`, error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch wake word model'
    });
  }
});

router.post('/', admin, async (req, res) => {
  try {
    const { phrase, slug, options, profiles } = req.body || {};
    if (!phrase) {
      return res.status(400).json({
        success: false,
        message: 'Wake word phrase is required'
      });
    }
    const model = await wakeWordTrainingService.requestTraining({
      phrase,
      slug,
      options,
      profiles
    });
    res.status(202).json({
      success: true,
      model: serializeModel(model)
    });
  } catch (error) {
    console.error('POST /api/wake-words - Error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to queue wake word training'
    });
  }
});

router.post('/:id/retrain', admin, async (req, res) => {
  try {
    const model = await WakeWordModel.findById(req.params.id);
    if (!model) {
      return res.status(404).json({
        success: false,
        message: 'Wake word model not found'
      });
    }
    await wakeWordTrainingService.requestTraining({
      phrase: model.phrase,
      slug: model.slug,
      options: req.body?.options || {}
    });
    const updated = await WakeWordModel.findById(model._id);
    res.status(202).json({
      success: true,
      model: serializeModel(updated)
    });
  } catch (error) {
    console.error(`POST /api/wake-words/${req.params.id}/retrain - Error:`, error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to queue retraining'
    });
  }
});

router.delete('/:id', admin, async (req, res) => {
  try {
    const model = await WakeWordModel.findById(req.params.id);
    if (!model) {
      return res.status(404).json({
        success: false,
        message: 'Wake word model not found'
      });
    }

    const filePath = model.modelPath;
    await model.deleteOne();

    if (filePath && fs.existsSync(filePath)) {
      try {
        await fsp.unlink(filePath);
      } catch (error) {
        console.warn(`Failed to remove wake word file ${filePath}:`, error.message);
      }
    }

    res.status(200).json({
      success: true,
      message: 'Wake word model deleted'
    });
  } catch (error) {
    console.error(`DELETE /api/wake-words/${req.params.id} - Error:`, error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete wake word model'
    });
  }
});

module.exports = router;

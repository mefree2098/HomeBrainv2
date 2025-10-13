const express = require('express');
const router = express.Router();
const fs = require('fs');
const fsp = fs.promises;
const WakeWordModel = require('../models/WakeWordModel');
const wakeWordTrainingService = require('../services/wakeWordTrainingService');
const { requireUser } = require('./middlewares/auth');

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

router.get('/', requireUser(), async (req, res) => {
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

router.get('/queue', requireUser(), async (req, res) => {
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

router.get('/:id', requireUser(), async (req, res) => {
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

router.post('/', requireUser(), async (req, res) => {
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

router.post('/:id/retrain', requireUser(), async (req, res) => {
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

router.delete('/:id', requireUser(), async (req, res) => {
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

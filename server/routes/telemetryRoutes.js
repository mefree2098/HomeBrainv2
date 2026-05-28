const express = require('express');
const router = express.Router();
const telemetryService = require('../services/telemetryService');
const { requireAdmin, requireUser } = require('./middlewares/auth');

const user = requireUser();
const admin = requireAdmin();

function queryString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function queryStringList(value) {
  if (Array.isArray(value)) {
    return value.map(queryString).filter(Boolean);
  }
  return queryString(value);
}

router.get('/overview', user, async (_req, res) => {
  try {
    const overview = await telemetryService.getOverview();
    return res.status(200).json({
      success: true,
      data: overview
    });
  } catch (error) {
    console.error('GET /api/telemetry/overview - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to load telemetry overview'
    });
  }
});

router.get('/series', user, async (req, res) => {
  try {
    const series = await telemetryService.getSeries({
      sourceKey: queryString(req.query.sourceKey),
      sourceType: queryString(req.query.sourceType),
      sourceId: queryString(req.query.sourceId),
      metricKeys: queryStringList(req.query.metricKeys),
      hours: queryString(req.query.hours),
      maxPoints: queryString(req.query.maxPoints)
    });

    return res.status(200).json({
      success: true,
      data: series
    });
  } catch (error) {
    console.error('GET /api/telemetry/series - Error:', error.message);
    const statusCode = error.message === 'Telemetry source not found' || error.message === 'A telemetry source is required.'
      ? 404
      : 500;

    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to load telemetry series'
    });
  }
});

router.post('/chart-builder', user, async (req, res) => {
  try {
    const plan = await telemetryService.buildChartFromPrompt({
      prompt: req.body?.prompt,
      preferredSourceKey: req.body?.preferredSourceKey
    });

    return res.status(200).json({
      success: true,
      data: plan
    });
  } catch (error) {
    console.error('POST /api/telemetry/chart-builder - Error:', error.message);
    const statusCode = error.message === 'A chart prompt is required.' ? 400 : 500;

    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to build chart from prompt'
    });
  }
});

router.delete('/', admin, async (req, res) => {
  try {
    const cleared = await telemetryService.clearData({
      sourceKey: req.query.sourceKey,
      sourceType: req.query.sourceType,
      sourceId: req.query.sourceId
    });

    return res.status(200).json({
      success: true,
      message: cleared.scope === 'all'
        ? 'Telemetry history cleared successfully'
        : 'Telemetry source history cleared successfully',
      data: cleared
    });
  } catch (error) {
    console.error('DELETE /api/telemetry - Error:', error.message);
    const statusCode = error.message === 'Telemetry source not found' ? 404 : 500;

    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to clear telemetry data'
    });
  }
});

module.exports = router;

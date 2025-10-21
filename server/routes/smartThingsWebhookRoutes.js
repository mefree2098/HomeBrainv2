const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const smartThingsWebhookService = require('../services/smartThingsWebhookService');

const auth = requireUser();

// SmartThings webhook endpoint (no authentication; SmartThings signs requests)
router.post('/', async (req, res) => {
  smartThingsWebhookService.log('debug', 'Incoming SmartThings webhook request', {
    headers: {
      userAgent: req.headers['user-agent'],
      lifecycle: req.body?.lifecycle || req.query?.lifecycle
    }
  });

  const rawBody = smartThingsWebhookService.getRawBody(req);
  let payload = req.body;

  try {
    await smartThingsWebhookService.verifyRequestSignature(rawBody, req.headers);
  } catch (error) {
    return res.status(401).json({ error: 'Invalid SmartThings signature' });
  }

  // Ensure payload is parsed even if JSON middleware was bypassed
  if (!payload || typeof payload !== 'object') {
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (parseError) {
      smartThingsWebhookService.log('error', 'Failed to parse SmartThings webhook payload', {
        error: parseError.message
      });
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }
  }

  try {
    const { statusCode, body } = await smartThingsWebhookService.handleLifecycle(payload, req.headers);
    if (body !== undefined) {
      res.status(statusCode).json(body);
    } else {
      res.sendStatus(statusCode);
    }
  } catch (error) {
    smartThingsWebhookService.log('error', 'SmartThings webhook lifecycle handling error', {
      error: error.message
    });
    res.status(500).json({ error: 'SmartThings webhook handling failed' });
  }
});

router.get('/metrics', auth, (req, res) => {
  const metrics = smartThingsWebhookService.getMetricsSnapshot();
  res.json({
    success: true,
    metrics
  });
});

router.get('/metrics/history', auth, (req, res) => {
  const limit = Number(req.query.limit);
  const history = smartThingsWebhookService.getMetricsHistory(Number.isNaN(limit) ? undefined : limit);
  res.json({
    success: true,
    count: history.length,
    history
  });
});

router.post('/metrics/config', auth, (req, res) => {
  try {
    const { intervalMs, historySize } = req.body || {};
    const updated = smartThingsWebhookService.updateMetricsConfig({ intervalMs, historySize });
    res.json({
      success: true,
      config: updated
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

router.get('/metrics/prometheus', auth, (req, res) => {
  const body = smartThingsWebhookService.getPrometheusMetrics();
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(body);
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { requireUser } = require('./middlewares/auth');
const smartThingsWebhookService = require('../services/smartThingsWebhookService');

const auth = requireUser();

// SmartThings webhook endpoint (no authentication; SmartThings signs requests)
router.post('/', async (req, res) => {
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

module.exports = router;

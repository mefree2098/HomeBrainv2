const express = require('express');
const alexaBridgeService = require('../services/alexaBridgeService');
const { requireAdmin } = require('./middlewares/auth');

const router = express.Router();
const admin = requireAdmin();

async function brokerAuth(req, res, next) {
  try {
    const registration = await alexaBridgeService.authenticateBrokerRequest(req);
    req.alexaBrokerRegistration = registration;
    next();
  } catch (error) {
    return res.status(error.status || 401).json({
      success: false,
      error: error.message || 'Broker authentication failed'
    });
  }
}

router.get('/', admin, async (_req, res) => {
  try {
    const summary = await alexaBridgeService.getSummary();
    return res.status(200).json({
      success: true,
      summary
    });
  } catch (error) {
    console.error('GET /api/alexa - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa summary'
    });
  }
});

router.get('/activity', admin, async (_req, res) => {
  try {
    const summary = await alexaBridgeService.getSummary();
    return res.status(200).json({
      success: true,
      activity: summary.recentActivity || []
    });
  } catch (error) {
    console.error('GET /api/alexa/activity - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa activity'
    });
  }
});

router.get('/exposures', admin, async (_req, res) => {
  try {
    const exposures = await alexaBridgeService.listExposures();
    return res.status(200).json({
      success: true,
      exposures,
      count: exposures.length
    });
  } catch (error) {
    console.error('GET /api/alexa/exposures - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa exposures'
    });
  }
});

router.put('/exposures/:entityType/:entityId', admin, async (req, res) => {
  try {
    const exposure = await alexaBridgeService.upsertExposure(
      req.params.entityType,
      req.params.entityId,
      req.body || {}
    );
    return res.status(200).json({
      success: true,
      exposure
    });
  } catch (error) {
    const statusCode = error.message.includes('Unable to find') ? 404 : 400;
    console.error(`PUT /api/alexa/exposures/${req.params.entityType}/${req.params.entityId} - Error:`, error.message);
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update Alexa exposure'
    });
  }
});

router.post('/link-codes', admin, async (req, res) => {
  try {
    const result = await alexaBridgeService.generateLinkCode({
      actor: String(req.user?.email || req.user?._id || 'admin'),
      mode: req.body?.mode === 'public' ? 'public' : 'private',
      ttlMinutes: req.body?.ttlMinutes
    });
    return res.status(201).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('POST /api/alexa/link-codes - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to issue Alexa link code'
    });
  }
});

router.post('/pair-broker', admin, async (req, res) => {
  try {
    const result = await alexaBridgeService.pairWithBroker(req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    const statusCode = error.message.includes('required') ? 400 : 500;
    console.error('POST /api/alexa/pair-broker - Error:', error.message);
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to pair Alexa broker'
    });
  }
});

router.post('/discovery-sync', admin, async (req, res) => {
  try {
    const result = await alexaBridgeService.pushCatalogToBroker(req.body?.reason || 'manual_admin_sync');
    return res.status(200).json({
      success: true,
      result
    });
  } catch (error) {
    console.error('POST /api/alexa/discovery-sync - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to sync Alexa discovery catalog'
    });
  }
});

router.post('/broker/register', async (req, res) => {
  try {
    const result = await alexaBridgeService.registerBroker(req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    const statusCode = error.message.includes('invalid') || error.message.includes('required') ? 400 : 500;
    console.error('POST /api/alexa/broker/register - Error:', error.message);
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to register Alexa broker'
    });
  }
});

router.get('/broker/health', brokerAuth, async (_req, res) => {
  try {
    const health = await alexaBridgeService.buildHealth();
    return res.status(200).json(health);
  } catch (error) {
    console.error('GET /api/alexa/broker/health - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa broker health'
    });
  }
});

router.get('/broker/catalog', brokerAuth, async (_req, res) => {
  try {
    const catalog = await alexaBridgeService.getCatalog();
    await alexaBridgeService.appendActivity(req.alexaBrokerRegistration, {
      direction: 'inbound',
      type: 'catalog_requested',
      status: 'success',
      message: `Broker requested Alexa catalog (${catalog.count} endpoints)`,
      details: { count: catalog.count }
    });
    return res.status(200).json(catalog);
  } catch (error) {
    console.error('GET /api/alexa/broker/catalog - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa catalog'
    });
  }
});

router.post('/broker/state', brokerAuth, async (req, res) => {
  try {
    const endpointIds = Array.isArray(req.body?.endpointIds)
      ? req.body.endpointIds
      : req.body?.endpointId
        ? [req.body.endpointId]
        : [];
    const state = await alexaBridgeService.getStateSnapshot(endpointIds);
    await alexaBridgeService.appendActivity(req.alexaBrokerRegistration, {
      direction: 'inbound',
      type: 'state_requested',
      status: 'success',
      message: `Broker requested Alexa state for ${state.count} endpoint(s)`,
      details: { count: state.count }
    });
    return res.status(200).json(state);
  } catch (error) {
    const statusCode = error.message.includes('Invalid') ? 400 : 500;
    console.error('POST /api/alexa/broker/state - Error:', error.message);
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa endpoint state'
    });
  }
});

router.post('/broker/execute', brokerAuth, async (req, res) => {
  try {
    const result = await alexaBridgeService.executeDirective(req.body || {});
    await alexaBridgeService.appendActivity(req.alexaBrokerRegistration, {
      direction: 'inbound',
      type: 'directive_executed',
      status: 'success',
      message: `Executed Alexa directive ${result.namespace}.${result.name}`,
      details: {
        endpointId: result.endpointId,
        entityType: result.entityType,
        entityId: result.entityId
      }
    });
    return res.status(200).json(result);
  } catch (error) {
    await alexaBridgeService.appendActivity(req.alexaBrokerRegistration, {
      direction: 'inbound',
      type: 'directive_failed',
      status: 'error',
      message: error.message || 'Alexa directive execution failed',
      details: {
        endpointId: req.body?.endpointId || req.body?.directive?.endpoint?.endpointId || null
      }
    });
    const statusCode = error.message.includes('required') || error.message.includes('Unsupported') || error.message.includes('invalid')
      ? 400
      : error.message.includes('not found')
        ? 404
        : 500;
    console.error('POST /api/alexa/broker/execute - Error:', error.message);
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to execute Alexa directive'
    });
  }
});

router.post('/broker/accounts', brokerAuth, async (req, res) => {
  try {
    const accounts = await alexaBridgeService.syncLinkedAccounts(req.body?.accounts || req.body?.account || []);
    return res.status(200).json({
      success: true,
      accounts,
      count: accounts.length
    });
  } catch (error) {
    console.error('POST /api/alexa/broker/accounts - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to sync Alexa linked accounts'
    });
  }
});

router.post('/broker/link-account', brokerAuth, async (req, res) => {
  try {
    const result = await alexaBridgeService.consumeLinkCodeForAccountLinking(req.body?.linkCode, {
      brokerClientId: req.body?.brokerClientId,
      actor: req.body?.actor || 'broker'
    });
    return res.status(200).json(result);
  } catch (error) {
    const statusCode = error.message.includes('invalid') || error.message.includes('required') ? 400 : 500;
    console.error('POST /api/alexa/broker/link-account - Error:', error.message);
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to consume Alexa account-link code'
    });
  }
});

module.exports = router;

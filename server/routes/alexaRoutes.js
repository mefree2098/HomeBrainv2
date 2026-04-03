const express = require('express');
const alexaBridgeService = require('../services/alexaBridgeService');
const alexaBrokerService = require('../services/alexaBrokerService');
const alexaCustomSkillService = require('../services/alexaCustomSkillService');
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

router.get('/service/status', admin, async (_req, res) => {
  try {
    const status = await alexaBrokerService.getStatus();
    return res.status(200).json({
      success: true,
      status
    });
  } catch (error) {
    console.error('GET /api/alexa/service/status - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa broker service status'
    });
  }
});

router.put('/service/config', admin, async (req, res) => {
  try {
    const result = await alexaBrokerService.updateConfig(req.body || {});
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('PUT /api/alexa/service/config - Error:', error.message);
    return res.status(400).json({
      success: false,
      error: error.message || 'Failed to update Alexa broker service configuration'
    });
  }
});

router.post('/service/install', admin, async (_req, res) => {
  try {
    const result = await alexaBrokerService.install();
    return res.status(200).json(result);
  } catch (error) {
    console.error('POST /api/alexa/service/install - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to install Alexa broker dependencies'
    });
  }
});

router.post('/service/deploy', admin, async (req, res) => {
  try {
    const result = await alexaBrokerService.deployService({
      actor: req.user?.email || req.user?._id || 'unknown',
      installDependencies: req.body?.installDependencies !== false
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error('POST /api/alexa/service/deploy - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to deploy Alexa broker service'
    });
  }
});

router.post('/service/start', admin, async (_req, res) => {
  try {
    const result = await alexaBrokerService.startService();
    return res.status(200).json(result);
  } catch (error) {
    console.error('POST /api/alexa/service/start - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to start Alexa broker service'
    });
  }
});

router.post('/service/stop', admin, async (_req, res) => {
  try {
    const result = await alexaBrokerService.stopService();
    return res.status(200).json(result);
  } catch (error) {
    console.error('POST /api/alexa/service/stop - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to stop Alexa broker service'
    });
  }
});

router.post('/service/restart', admin, async (_req, res) => {
  try {
    const result = await alexaBrokerService.restartService();
    return res.status(200).json(result);
  } catch (error) {
    console.error('POST /api/alexa/service/restart - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to restart Alexa broker service'
    });
  }
});

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

router.get('/delivery', admin, async (_req, res) => {
  try {
    const delivery = await alexaBridgeService.getBrokerDeliveryStatus();
    return res.status(200).json({
      success: true,
      delivery
    });
  } catch (error) {
    console.error('GET /api/alexa/delivery - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa delivery status'
    });
  }
});

router.get('/metrics', admin, async (_req, res) => {
  try {
    const metrics = await alexaBridgeService.getBrokerMetricsStatus();
    return res.status(200).json({
      success: true,
      metrics
    });
  } catch (error) {
    console.error('GET /api/alexa/metrics - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa broker metrics'
    });
  }
});

router.get('/audit', admin, async (req, res) => {
  try {
    const audit = await alexaBridgeService.getBrokerAuditLog(req.query?.limit);
    return res.status(200).json({
      success: true,
      audit
    });
  } catch (error) {
    console.error('GET /api/alexa/audit - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa broker audit log'
    });
  }
});

router.get('/readiness', admin, async (_req, res) => {
  try {
    const readiness = await alexaBridgeService.getCertificationReadiness();
    return res.status(200).json({
      success: true,
      readiness
    });
  } catch (error) {
    console.error('GET /api/alexa/readiness - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa readiness'
    });
  }
});

router.get('/voice-users', admin, async (_req, res) => {
  try {
    const voiceUsers = await alexaCustomSkillService.listVoiceUsers();
    const customSkill = await alexaCustomSkillService.getStatusSummary();
    return res.status(200).json({
      success: true,
      voiceUsers,
      customSkill
    });
  } catch (error) {
    console.error('GET /api/alexa/voice-users - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa voice users'
    });
  }
});

router.put('/voice-users/:voiceUserId', admin, async (req, res) => {
  try {
    const voiceUser = await alexaCustomSkillService.updateVoiceUser(req.params.voiceUserId, req.body || {});
    return res.status(200).json({
      success: true,
      voiceUser
    });
  } catch (error) {
    console.error(`PUT /api/alexa/voice-users/${req.params.voiceUserId} - Error:`, error.message);
    return res.status(error.message.includes('not found') ? 404 : 400).json({
      success: false,
      error: error.message || 'Failed to update Alexa voice user'
    });
  }
});

router.delete('/voice-users/:voiceUserId', admin, async (req, res) => {
  try {
    const result = await alexaCustomSkillService.deleteVoiceUser(req.params.voiceUserId);
    return res.status(200).json({
      success: true,
      result
    });
  } catch (error) {
    console.error(`DELETE /api/alexa/voice-users/${req.params.voiceUserId} - Error:`, error.message);
    return res.status(error.message.includes('not found') ? 404 : 400).json({
      success: false,
      error: error.message || 'Failed to delete Alexa voice user'
    });
  }
});

router.post('/events/flush', admin, async (req, res) => {
  try {
    const result = await alexaBridgeService.flushBrokerEvents(req.body?.limit);
    return res.status(200).json({
      success: true,
      result
    });
  } catch (error) {
    console.error('POST /api/alexa/events/flush - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to flush Alexa broker events'
    });
  }
});

router.post('/accounts/:brokerAccountId/discovery-sync', admin, async (req, res) => {
  try {
    const result = await alexaBridgeService.syncBrokerDiscoveryForAccount(req.params.brokerAccountId);
    return res.status(200).json({
      success: true,
      result
    });
  } catch (error) {
    console.error(`POST /api/alexa/accounts/${req.params.brokerAccountId}/discovery-sync - Error:`, error.message);
    return res.status(error.response?.status || 500).json({
      success: false,
      error: error.message || 'Failed to request Alexa household rediscovery'
    });
  }
});

router.post('/accounts/:brokerAccountId/revoke', admin, async (req, res) => {
  try {
    const result = await alexaBridgeService.revokeBrokerAccount(req.params.brokerAccountId, req.body?.reason);
    return res.status(200).json({
      success: true,
      result
    });
  } catch (error) {
    console.error(`POST /api/alexa/accounts/${req.params.brokerAccountId}/revoke - Error:`, error.message);
    return res.status(error.response?.status || 500).json({
      success: false,
      error: error.message || 'Failed to revoke Alexa household'
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

router.post('/broker/custom-skill', brokerAuth, async (req, res) => {
  try {
    const response = await alexaCustomSkillService.handleSkillRequest(req.body?.envelope || req.body || {}, {
      brokerAccountId: req.body?.brokerAccountId,
      linkedAccount: req.body?.linkedAccount
    });
    await alexaBridgeService.appendActivity(req.alexaBrokerRegistration, {
      direction: 'inbound',
      type: 'custom_skill_requested',
      status: 'success',
      message: 'Broker routed Alexa custom skill request to HomeBrain',
      details: {
        brokerAccountId: req.body?.brokerAccountId || '',
        requestType: req.body?.envelope?.request?.type || req.body?.request?.type || ''
      }
    });
    return res.status(200).json(response);
  } catch (error) {
    console.error('POST /api/alexa/broker/custom-skill - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to handle Alexa custom skill request'
    });
  }
});

router.get('/custom/audio/:clipId', async (req, res) => {
  try {
    const result = await alexaCustomSkillService.resolveAudioClip(req.params.clipId, req.query?.token);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).send(result.buffer);
  } catch (error) {
    return res.status(error.status || 404).json({
      success: false,
      error: error.message || 'Alexa custom audio clip could not be loaded'
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

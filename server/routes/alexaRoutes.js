const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { ZipFile } = require('yazl');
const alexaBridgeService = require('../services/alexaBridgeService');
const alexaBrokerService = require('../services/alexaBrokerService');
const alexaCustomSkillService = require('../services/alexaCustomSkillService');
const { AlexaSessionCaptureService } = require('../services/alexaSessionCaptureService');
const { requireAdmin } = require('./middlewares/auth');

const router = express.Router();
const admin = requireAdmin();
const alexaSessionCaptureService = new AlexaSessionCaptureService();
const { ipKeyGenerator } = rateLimit;
const brokerReadRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_ALEXA_BROKER_RATE_LIMIT_WINDOW_MS || 60 * 1000)),
  limit: Math.max(60, Number(process.env.HOMEBRAIN_ALEXA_BROKER_RATE_LIMIT_MAX || 600)),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator(req) {
    return typeof ipKeyGenerator === 'function'
      ? ipKeyGenerator(req.ip)
      : (req.ip || req.socket?.remoteAddress || 'unknown');
  },
  message: {
    success: false,
    error: 'Too many Alexa broker requests. Please retry shortly.'
  }
});
const alexaDeviceRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_ALEXA_DEVICE_RATE_LIMIT_WINDOW_MS || 60 * 1000)),
  limit: Math.max(10, Number(process.env.HOMEBRAIN_ALEXA_DEVICE_RATE_LIMIT_MAX || 120)),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator(req) {
    return typeof ipKeyGenerator === 'function'
      ? ipKeyGenerator(req.ip)
      : (req.ip || req.socket?.remoteAddress || 'unknown');
  },
  message: {
    success: false,
    error: 'Too many Alexa device requests. Please retry shortly.'
  }
});
const alexaSessionCaptureRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_ALEXA_SESSION_CAPTURE_RATE_LIMIT_WINDOW_MS || 60 * 1000)),
  limit: Math.max(5, Number(process.env.HOMEBRAIN_ALEXA_SESSION_CAPTURE_RATE_LIMIT_MAX || 30)),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator(req) {
    return typeof ipKeyGenerator === 'function'
      ? ipKeyGenerator(req.ip)
      : (req.ip || req.socket?.remoteAddress || 'unknown');
  },
  message: {
    success: false,
    error: 'Too many Alexa session capture requests. Please retry shortly.'
  }
});

function getHelperExtensionDir() {
  return path.join(__dirname, '..', 'assets', 'alexa-session-helper');
}

function getRequestOrigin(req) {
  const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http')
    .split(',')[0]
    .trim() || 'http';
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0]
    .trim();
  return host ? `${proto}://${host}` : '';
}

function buildHomeBrainExtensionPatterns(req) {
  const patterns = new Set([
    'http://localhost/*',
    'http://127.0.0.1/*'
  ]);
  const origin = getRequestOrigin(req);
  if (origin) {
    try {
      const parsed = new URL(origin);
      patterns.add(`${parsed.protocol}//${parsed.hostname}/*`);
    } catch (_error) {
      // Keep the localhost fallbacks.
    }
  }
  return Array.from(patterns);
}

function buildHelperManifest(req) {
  const extensionDir = getHelperExtensionDir();
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const homeBrainPatterns = buildHomeBrainExtensionPatterns(req);

  manifest.host_permissions = Array.from(new Set([
    ...homeBrainPatterns,
    ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [])
  ]));
  manifest.content_scripts = (Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [])
    .map((entry) => ({
      ...entry,
      matches: homeBrainPatterns
    }));

  return JSON.stringify(manifest, null, 2);
}

async function streamHelperExtensionZip(req, res) {
  const extensionDir = getHelperExtensionDir();
  const files = fs.readdirSync(extensionDir)
    .filter((file) => !file.startsWith('.'))
    .sort();
  const zipfile = new ZipFile();

  files.forEach((file) => {
    const zipPath = `homebrain-alexa-session-helper/${file}`;
    if (file === 'manifest.json') {
      zipfile.addBuffer(Buffer.from(`${buildHelperManifest(req)}\n`, 'utf8'), zipPath);
      return;
    }
    zipfile.addFile(path.join(extensionDir, file), zipPath);
  });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="homebrain-alexa-session-helper.zip"');

  await new Promise((resolve, reject) => {
    zipfile.outputStream.on('error', reject);
    zipfile.outputStream.on('end', resolve);
    zipfile.outputStream.pipe(res);
    zipfile.end();
  });
}

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

router.get('/session-capture/helper-extension.zip', alexaSessionCaptureRateLimit, admin, async (_req, res) => {
  try {
    await streamHelperExtensionZip(_req, res);
  } catch (error) {
    console.error('GET /api/alexa/session-capture/helper-extension.zip - Error:', error.message);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to download Alexa session helper extension'
      });
    }
    res.end();
  }
});

router.post('/session-capture/start', alexaSessionCaptureRateLimit, admin, async (req, res) => {
  try {
    const result = alexaSessionCaptureService.startCapture({
      actor: req.user?.email || req.user?._id || 'admin',
      amazonPage: req.body?.amazonPage,
      serviceHost: req.body?.serviceHost,
      req
    });
    return res.status(201).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('POST /api/alexa/session-capture/start - Error:', error.message);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to start Alexa session capture'
    });
  }
});

router.get('/session-capture/:captureId/status', alexaSessionCaptureRateLimit, admin, async (req, res) => {
  try {
    const status = alexaSessionCaptureService.getStatus(req.params.captureId);
    return res.status(200).json({
      success: true,
      capture: status
    });
  } catch (error) {
    return res.status(error.status || 404).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa session capture status'
    });
  }
});

router.post('/session-capture/:captureId/complete', alexaSessionCaptureRateLimit, async (req, res) => {
  let capture = null;
  try {
    capture = alexaSessionCaptureService.completeCapture(req.params.captureId, req.body || {});
    const actor = `alexa-session-capture:${capture.captureId}`;
    const configResult = await alexaBrokerService.updateConfig({
      alexaCommandProvider: 'homebrain',
      alexaCommandAmazonPage: capture.amazonPage,
      alexaCommandServiceHost: capture.serviceHost,
      alexaCommandSessionCookie: capture.cookie
    });

    let restartResult = null;
    let restartWarning = '';
    try {
      restartResult = await alexaBrokerService.restartService({
        actor,
        source: 'alexa_session_capture',
        reason: 'fresh Alexa session captured'
      });
    } catch (restartError) {
      restartWarning = restartError.message || 'Alexa session was saved, but the broker runtime could not be restarted automatically.';
    }

    const activated = alexaSessionCaptureService.markActivated(req.params.captureId, {
      message: restartWarning
        ? 'Alexa session was saved, but the broker restart needs attention.'
        : 'Alexa session was saved and broker runtime was refreshed.'
    });

    return res.status(200).json({
      success: true,
      capture: activated,
      status: restartResult?.status || configResult?.status || await alexaBrokerService.getStatus(),
      restartWarning: restartWarning || null
    });
  } catch (error) {
    alexaSessionCaptureService.markFailed(req.params.captureId, error);
    console.error('POST /api/alexa/session-capture/:captureId/complete - Error:', {
      captureId: req.params.captureId,
      message: error.message
    });
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || 'Failed to activate captured Alexa session'
    });
  }
});

router.post('/service/start', admin, async (_req, res) => {
  try {
    const result = await alexaBrokerService.startService({
      actor: _req.user?.email || _req.user?._id || 'unknown',
      source: 'admin_start'
    });
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
    const result = await alexaBrokerService.stopService({
      actor: _req.user?.email || _req.user?._id || 'unknown',
      source: 'admin_stop'
    });
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
    const result = await alexaBrokerService.restartService({
      actor: _req.user?.email || _req.user?._id || 'unknown',
      source: 'admin_restart',
      reason: 'admin restart request'
    });
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

router.get('/devices', alexaDeviceRateLimit, admin, async (req, res) => {
  try {
    const result = await alexaBridgeService.listAlexaDevices({
      brokerAccountId: req.query?.brokerAccountId
    });
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('GET /api/alexa/devices - Error:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch Alexa devices'
    });
  }
});

router.post('/devices/:alexaDeviceId/speak', alexaDeviceRateLimit, admin, async (req, res) => {
  try {
    const result = await alexaBridgeService.sendAlexaSpeech(req.params.alexaDeviceId, req.body || {});
    return res.status(200).json({
      success: true,
      ...result
    });
  } catch (error) {
    const statusCode = error.message.includes('required') ? 400 : error.status || error.response?.status || 500;
    console.error('POST /api/alexa/devices/:alexaDeviceId/speak - Error:', {
      alexaDeviceId: req.params.alexaDeviceId,
      message: error.message
    });
    return res.status(statusCode).json({
      success: false,
      error: error.response?.data?.error || error.response?.data?.message || error.message || 'Failed to send Alexa speech'
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

router.get('/broker/health', brokerReadRateLimit, brokerAuth, async (_req, res) => {
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

router.get('/broker/catalog', brokerReadRateLimit, brokerAuth, async (req, res) => {
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

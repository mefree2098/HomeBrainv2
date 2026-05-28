const express = require('express');
const rateLimit = require('express-rate-limit');
const directRadioService = require('../services/directRadioService');
const directRadioEngineLogService = require('../services/directRadioEngineLogService');
const directRadioProtocolCatalogService = require('../services/directRadioProtocolCatalogService');
const { requireAdmin } = require('./middlewares/auth');

const router = express.Router();
const DIRECT_RADIO_LOG_HEARTBEAT_MS = 25_000;
const directRadioRateLimit = rateLimit({
  windowMs: Math.max(60_000, Number(process.env.HOMEBRAIN_DIRECT_RADIO_RATE_LIMIT_WINDOW_MS || 60_000)),
  limit: Math.max(20, Number(process.env.HOMEBRAIN_DIRECT_RADIO_RATE_LIMIT_MAX || 180)),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many direct radio requests. Please retry shortly.'
  }
});

router.use(directRadioRateLimit, requireAdmin());

function sendError(res, error, fallbackMessage) {
  const status = error.status || error.statusCode || 500;
  res.status(status).json({
    success: false,
    message: error.message || fallbackMessage,
    error: error.message || fallbackMessage
  });
}

function parsePositiveInt(value, fallback, maximum = 1000) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.min(maximum, numeric);
}

function catalogOptions(req) {
  return {
    q: req.query.q || req.query.query,
    vendor: req.query.vendor,
    manufacturer: req.query.manufacturer,
    manufacturerId: req.query.manufacturerId,
    model: req.query.model,
    modelID: req.query.modelID,
    zigbeeModel: req.query.zigbeeModel,
    productType: req.query.productType,
    productId: req.query.productId,
    firmwareVersion: req.query.firmwareVersion,
    limit: req.query.limit,
    includeExposes: req.query.includeExposes,
    includeConfig: req.query.includeConfig
  };
}

router.get('/status', async (_req, res) => {
  try {
    const status = await directRadioService.refreshHardwareStatus({ log: false });
    res.status(200).json({
      success: true,
      status
    });
  } catch (error) {
    sendError(res, error, 'Failed to get direct radio status');
  }
});

router.get('/serial-ports', async (_req, res) => {
  try {
    const serialPorts = await directRadioService.detectSerialPorts({ log: true });
    res.status(200).json({
      success: true,
      serialPorts
    });
  } catch (error) {
    sendError(res, error, 'Failed to list serial ports');
  }
});

router.get('/catalog/summary', async (_req, res) => {
  try {
    const summary = await directRadioProtocolCatalogService.getSummary();
    res.status(200).json({
      success: true,
      summary
    });
  } catch (error) {
    sendError(res, error, 'Failed to summarize direct radio device catalog');
  }
});

router.get('/catalog/zigbee', async (req, res) => {
  try {
    const catalog = directRadioProtocolCatalogService.searchZigbeeCatalog(catalogOptions(req));
    res.status(200).json({
      success: true,
      catalog
    });
  } catch (error) {
    sendError(res, error, 'Failed to search Zigbee device catalog');
  }
});

router.get('/catalog/zwave', async (req, res) => {
  try {
    const catalog = await directRadioProtocolCatalogService.searchZWaveCatalog(catalogOptions(req));
    res.status(200).json({
      success: true,
      catalog
    });
  } catch (error) {
    sendError(res, error, 'Failed to search Z-Wave device catalog');
  }
});

router.get('/catalog/zwave/lookup', async (req, res) => {
  try {
    const entry = await directRadioProtocolCatalogService.lookupZWaveCatalogEntry(catalogOptions(req));
    res.status(entry ? 200 : 404).json({
      success: Boolean(entry),
      entry,
      message: entry ? undefined : 'No Z-Wave catalog entry matched those identifiers.'
    });
  } catch (error) {
    sendError(res, error, 'Failed to look up Z-Wave device catalog entry');
  }
});

router.get('/logs/latest', async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, 200);
    const logs = directRadioEngineLogService.latest({ limit });
    res.status(200).json({
      success: true,
      logs,
      count: logs.length
    });
  } catch (error) {
    sendError(res, error, 'Failed to get direct radio logs');
  }
});

router.post('/logs/clear', async (_req, res) => {
  try {
    const cleared = directRadioEngineLogService.latest({ limit: 2000 }).length;
    directRadioEngineLogService.reset();
    res.status(200).json({
      success: true,
      cleared
    });
  } catch (error) {
    sendError(res, error, 'Failed to clear direct radio logs');
  }
});

router.get('/logs/stream', async (req, res) => {
  const limit = parsePositiveInt(req.query.limit, 200);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const writeLog = (entry) => {
    try {
      res.write(`id: ${entry.id}\n`);
      res.write('event: log\n');
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch (error) {
      console.warn('GET /api/direct-radios/logs/stream - Failed to write log:', error.message);
    }
  };

  try {
    directRadioEngineLogService.latest({ limit }).forEach(writeLog);
  } catch (error) {
    console.error('GET /api/direct-radios/logs/stream - Failed initial replay:', error.message);
  }

  res.write('event: ready\n');
  res.write(`data: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(':\n\n');
    } catch (_error) {
      clearInterval(heartbeat);
    }
  }, DIRECT_RADIO_LOG_HEARTBEAT_MS);

  const listener = (entry) => writeLog(entry);
  directRadioEngineLogService.on('log', listener);

  let closed = false;
  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    directRadioEngineLogService.removeListener('log', listener);
    try {
      res.end();
    } catch (_error) {
      // No-op.
    }
  };

  req.on('close', cleanup);
  req.on('end', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

router.post('/pairing/start', async (req, res) => {
  try {
    const protocol = String(req.body?.protocol || '').trim().toLowerCase();
    const result = await directRadioService.startPairing(protocol, {
      durationSeconds: req.body?.durationSeconds,
      dskPin: req.body?.dskPin,
      zwaveSecurityMode: req.body?.zwaveSecurityMode || req.body?.securityMode
    });
    res.status(200).json({
      success: true,
      result,
      status: await directRadioService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to start direct radio pairing');
  }
});

router.post('/pairing/zwave/dsk-pin', async (req, res) => {
  try {
    const result = directRadioService.submitZWaveDskPin(req.body?.pin || req.body?.dskPin);
    res.status(200).json({
      success: true,
      result,
      status: await directRadioService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to submit Z-Wave DSK PIN');
  }
});

router.post('/zwave/nodes/:nodeId/refresh-info', async (req, res) => {
  try {
    const result = await directRadioService.refreshZWaveNodeInfo(req.params.nodeId, {
      waitForWakeup: req.body?.waitForWakeup,
      resetSecurityClasses: req.body?.resetSecurityClasses,
      pingFirst: req.body?.pingFirst
    });
    res.status(200).json({
      success: true,
      result,
      status: await directRadioService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to refresh Z-Wave node information');
  }
});

router.post('/zwave/nodes/:nodeId/remove-failed', async (req, res) => {
  try {
    const result = await directRadioService.removeFailedZWaveNode(req.params.nodeId, {
      confirm: req.body?.confirm,
      force: req.body?.force
    });
    res.status(200).json({
      success: true,
      result,
      status: await directRadioService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to remove failed Z-Wave node');
  }
});

router.post('/pairing/stop', async (req, res) => {
  try {
    const protocol = String(req.body?.protocol || 'all').trim().toLowerCase();
    const status = await directRadioService.stopPairing(protocol || 'all');
    res.status(200).json({
      success: true,
      status
    });
  } catch (error) {
    sendError(res, error, 'Failed to stop direct radio pairing');
  }
});

router.post('/exclusion/start', async (req, res) => {
  try {
    const protocol = String(req.body?.protocol || 'zwave').trim().toLowerCase();
    const result = await directRadioService.startExclusion(protocol, {
      durationSeconds: req.body?.durationSeconds,
      deviceId: req.body?.deviceId,
      migrationId: req.body?.migrationId
    });
    res.status(200).json({
      success: true,
      result,
      status: await directRadioService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to start direct radio exclusion');
  }
});

router.get('/migration-plan/:deviceId', async (req, res) => {
  try {
    const plan = await directRadioService.getMigrationPlan(req.params.deviceId, {
      protocol: req.query.protocol
    });
    res.status(200).json({
      success: true,
      plan
    });
  } catch (error) {
    sendError(res, error, 'Failed to build migration plan');
  }
});

router.post('/migrations/verify-step', async (req, res) => {
  try {
    const result = await directRadioService.verifyMigrationStep({
      migrationId: req.body?.migrationId,
      deviceId: req.body?.deviceId,
      protocol: String(req.body?.protocol || '').trim().toLowerCase(),
      phase: req.body?.phase,
      stepId: req.body?.stepId
    });
    res.status(200).json({
      success: true,
      ...result,
      status: await directRadioService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to verify migration step');
  }
});

router.post('/migrations', async (req, res) => {
  try {
    const result = await directRadioService.startMigration({
      deviceId: req.body?.deviceId,
      protocol: String(req.body?.protocol || '').trim().toLowerCase(),
      durationSeconds: req.body?.durationSeconds,
      dskPin: req.body?.dskPin,
      migrationId: req.body?.migrationId,
      zwaveSecurityMode: req.body?.zwaveSecurityMode || req.body?.securityMode
    });
    res.status(200).json({
      success: true,
      ...result,
      status: await directRadioService.getStatus()
    });
  } catch (error) {
    sendError(res, error, 'Failed to start device migration');
  }
});

module.exports = router;

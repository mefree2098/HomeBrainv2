const express = require('express');
const router = express.Router();
const insteonService = require('../services/insteonService');
const { requireAdmin } = require('./middlewares/auth');

// Apply authentication to all routes
router.use(requireAdmin());

// Description: Test Insteon PLM connection
// Endpoint: GET /api/insteon/test
// Request: {}
// Response: { success: boolean, message: string, connected: boolean, plmInfo?: object }
router.get('/test', async (req, res) => {
  console.log('InsteonRoutes: Testing PLM connection');

  try {
    const result = await insteonService.testConnection();
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Connection test failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message,
      connected: false
    });
  }
});

// Description: Get Insteon PLM information
// Endpoint: GET /api/insteon/info
// Request: {}
// Response: { success: boolean, plmInfo: object }
router.get('/info', async (req, res) => {
  console.log('InsteonRoutes: Getting PLM info');

  try {
    const plmInfo = await insteonService.getPLMInfo();
    res.status(200).json({
      success: true,
      plmInfo
    });
  } catch (error) {
    console.error('InsteonRoutes: Failed to get PLM info:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Get PLM connection status
// Endpoint: GET /api/insteon/status
// Request: {}
// Response: { connected: boolean, deviceCount: number, connectionAttempts: number }
router.get('/status', async (req, res) => {
  console.log('InsteonRoutes: Getting PLM status');

  try {
    const status = insteonService.getStatus();
    res.status(200).json(status);
  } catch (error) {
    console.error('InsteonRoutes: Failed to get PLM status:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: List local serial ports available for USB PLM use
// Endpoint: GET /api/insteon/serial-ports
// Request: {}
// Response: { success: boolean, count: number, ports: Array<object> }
router.get('/serial-ports', async (req, res) => {
  console.log('InsteonRoutes: Listing local serial ports');

  try {
    const ports = await insteonService.listLocalSerialPorts();
    const serialTransport = insteonService.getSerialTransportDiagnostics();
    res.status(200).json({
      success: true,
      count: ports.length,
      ports,
      serialTransportSupported: serialTransport.supported,
      serialTransportError: serialTransport.error
    });
  } catch (error) {
    console.error('InsteonRoutes: Failed to list serial ports:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message,
      ports: []
    });
  }
});

// Description: Connect to Insteon PLM
// Endpoint: POST /api/insteon/connect
// Request: {}
// Response: { success: boolean, message: string, port: string }
router.post('/connect', async (req, res) => {
  console.log('InsteonRoutes: Connecting to PLM');

  try {
    const result = await insteonService.connect();
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Connection failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Disconnect from Insteon PLM
// Endpoint: POST /api/insteon/disconnect
// Request: {}
// Response: { success: boolean, message: string }
router.post('/disconnect', async (req, res) => {
  console.log('InsteonRoutes: Disconnecting from PLM');

  try {
    const result = await insteonService.disconnect();
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Disconnection failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Test direct ISY REST API connectivity
// Endpoint: POST /api/insteon/isy/test
// Request: { connection?: { host, port?, username, password, useHttps?, ignoreTlsErrors? } } OR top-level equivalents
// Response: { success: boolean, message: string, connection?: object }
router.post('/isy/test', async (req, res) => {
  console.log('InsteonRoutes: Testing ISY connectivity');

  try {
    const result = await insteonService.testISYConnection(req.body || {});
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    console.error('InsteonRoutes: ISY connectivity test failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Extract device/group/program metadata from ISY without applying changes
// Endpoint: POST /api/insteon/isy/extract
// Request: { connection?: {...} } OR top-level ISY connection fields
// Response: { success: boolean, extraction: object }
router.post('/isy/extract', async (req, res) => {
  console.log('InsteonRoutes: Extracting ISY metadata');

  try {
    const extraction = await insteonService.extractISYData(req.body || {});
    res.status(200).json({
      success: true,
      extraction
    });
  } catch (error) {
    console.error('InsteonRoutes: ISY extraction failed:', error.message);
    console.error(error.stack);
    const statusCode = /isy host is required|isy credentials are required|isy request failed/i.test(String(error.message).toLowerCase())
      ? 400
      : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message
    });
  }
});

// Description: End-to-end ISY extraction and import (devices, topology, program stubs)
// Endpoint: POST /api/insteon/isy/sync
// Request: { dryRun?: boolean, importDevices?: boolean, importTopology?: boolean, importPrograms?: boolean, enableProgramWorkflows?: boolean, connection?: {...}, linkMode?: 'remote'|'manual' }
// Response: { success: boolean, dryRun: boolean, extractedCounts: object, devices?: object, topology?: object, programs?: object }
router.post('/isy/sync/start', async (req, res) => {
  console.log('InsteonRoutes: Starting async ISY sync workflow');

  try {
    const run = insteonService.startISYSyncRun(req.body || {});
    res.status(202).json({
      success: true,
      runId: run.id,
      run
    });
  } catch (error) {
    console.error('InsteonRoutes: Failed to start async ISY sync:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.get('/isy/sync/runs/:runId', async (req, res) => {
  const runId = req.params?.runId;
  try {
    const run = insteonService.getISYSyncRun(runId);
    if (!run) {
      return res.status(404).json({
        success: false,
        message: `ISY sync run "${runId}" was not found`
      });
    }

    return res.status(200).json({
      success: true,
      run
    });
  } catch (error) {
    console.error('InsteonRoutes: Failed to fetch ISY sync run:', error.message);
    console.error(error.stack);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.post('/isy/sync/runs/:runId/cancel', async (req, res) => {
  const runId = req.params?.runId;
  try {
    const run = insteonService.cancelISYSyncRun(runId);
    if (!run) {
      return res.status(404).json({
        success: false,
        message: `ISY sync run "${runId}" was not found`
      });
    }

    return res.status(200).json({
      success: true,
      message: ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(run.status)
        ? `ISY sync run is already ${run.status}.`
        : 'Cancellation requested.',
      run
    });
  } catch (error) {
    console.error('InsteonRoutes: Failed to cancel ISY sync run:', error.message);
    console.error(error.stack);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.post('/isy/sync', async (req, res) => {
  console.log('InsteonRoutes: Running ISY sync workflow');

  try {
    const result = await insteonService.syncFromISY(req.body || {});
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: ISY sync failed:', error.message);
    console.error(error.stack);
    const statusCode = /isy host is required|isy credentials are required|isy request failed/i.test(String(error.message).toLowerCase())
      ? 400
      : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Get all devices linked to PLM
// Endpoint: GET /api/insteon/devices/linked
// Request: {}
// Response: { success: boolean, devices: Array<object> }
router.get('/devices/linked', async (req, res) => {
  console.log('InsteonRoutes: Getting all linked devices');

  try {
    const devices = await insteonService.getAllLinkedDevices();
    res.status(200).json({
      success: true,
      count: devices.length,
      devices
    });
  } catch (error) {
    console.error('InsteonRoutes: Failed to get linked devices:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message,
      devices: []
    });
  }
});

// Description: Query all PLM-linked devices and return live reachability + status details
// Endpoint: GET /api/insteon/devices/linked/status
// Request: {}
// Response: { success: boolean, message: string, summary: object, devices: Array<object> }
router.post('/devices/linked/status/start', async (req, res) => {
  console.log('InsteonRoutes: Starting async linked-device status query');

  try {
    const run = insteonService.startLinkedStatusRun(req.body || {});
    res.status(202).json({
      success: true,
      runId: run.id,
      run
    });
  } catch (error) {
    console.error('InsteonRoutes: Failed to start linked-device status query:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.get('/devices/linked/status/runs/:runId', async (req, res) => {
  const runId = req.params?.runId;
  try {
    const run = insteonService.getLinkedStatusRun(runId);
    if (!run) {
      return res.status(404).json({
        success: false,
        message: `Linked-device query run "${runId}" was not found`
      });
    }

    return res.status(200).json({
      success: true,
      run
    });
  } catch (error) {
    console.error('InsteonRoutes: Failed to fetch linked-device query run:', error.message);
    console.error(error.stack);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.post('/devices/linked/status/runs/:runId/cancel', async (req, res) => {
  const runId = req.params?.runId;
  try {
    const run = insteonService.cancelLinkedStatusRun(runId);
    if (!run) {
      return res.status(404).json({
        success: false,
        message: `Linked-device query run "${runId}" was not found`
      });
    }

    return res.status(200).json({
      success: true,
      message: ['completed', 'failed', 'cancelled'].includes(run.status)
        ? `Linked-device query is already ${run.status}.`
        : 'Cancellation requested.',
      run
    });
  } catch (error) {
    console.error('InsteonRoutes: Failed to cancel linked-device query run:', error.message);
    console.error(error.stack);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

router.get('/devices/linked/status', async (req, res) => {
  console.log('InsteonRoutes: Querying linked device status from PLM');

  try {
    const result = await insteonService.queryLinkedDevicesStatus({
      levelTimeoutMs: req.query.levelTimeoutMs,
      pingTimeoutMs: req.query.pingTimeoutMs,
      infoTimeoutMs: req.query.infoTimeoutMs,
      pauseBetweenMs: req.query.pauseBetweenMs
    });
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Linked device status query failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message,
      summary: {
        linkedDevices: 0,
        reachable: 0,
        unreachable: 0,
        statusKnown: 0,
        statusUnknown: 0
      },
      devices: []
    });
  }
});

// Description: Import all devices from PLM to database
// Endpoint: POST /api/insteon/devices/import
// Request: {} OR ISY import payload
// Response: { success: boolean, message: string, imported: number, skipped: number, errors: number, devices: Array<object> }
router.post('/devices/import', async (req, res) => {
  const body = req.body || {};
  const hasISYPayload =
    Array.isArray(body.deviceIds) ||
    Array.isArray(body.addresses) ||
    Array.isArray(body.devices) ||
    typeof body.deviceIds === 'string' ||
    typeof body.rawDeviceList === 'string' ||
    typeof body.rawList === 'string' ||
    typeof body.text === 'string' ||
    typeof body.isyDeviceList === 'string';
  const hasISYTopologyPayload =
    Array.isArray(body.scenes) ||
    Array.isArray(body.linkRecords) ||
    Array.isArray(body.topology?.scenes) ||
    typeof body.scenes === 'string';

  console.log(
    `InsteonRoutes: Importing devices (${hasISYTopologyPayload ? 'ISY topology payload' : hasISYPayload ? 'ISY payload' : 'PLM link table'})`
  );

  try {
    let result;
    if (hasISYTopologyPayload) {
      result = await insteonService.applyISYSceneTopology(body);
    } else if (hasISYPayload) {
      result = await insteonService.importDevicesFromISY(body);
    } else {
      result = await insteonService.importDevices();
    }

    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Device import failed:', error.message);
    console.error(error.stack);
    const statusCode = /no valid insteon|isy .* must be|no valid isy scene topology/i.test(String(error.message).toLowerCase())
      ? 400
      : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message,
      imported: 0,
      skipped: 0,
      errors: 0
    });
  }
});

// Description: Import ISY device IDs and link each device to the current PLM
// Endpoint: POST /api/insteon/devices/import/isy
// Request: { deviceIds?: string[]|string, rawDeviceList?: string, group?: number, linkMode?: 'remote'|'manual', perDeviceTimeoutMs?: number, retries?: number, pauseBetweenMs?: number, skipLinking?: boolean }
// Response: { success: boolean, message: string, accepted: number, linked: number, alreadyLinked: number, imported: number, updated: number, failed: number, devices: Array<object> }
router.post('/devices/import/isy', async (req, res) => {
  console.log('InsteonRoutes: Importing ISY devices and linking to current PLM');

  try {
    const result = await insteonService.importDevicesFromISY(req.body || {});
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: ISY import failed:', error.message);
    console.error(error.stack);
    const statusCode = /no valid insteon device ids|isy import .* must be/i.test(String(error.message).toLowerCase())
      ? 400
      : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message,
      accepted: 0,
      linked: 0,
      imported: 0,
      updated: 0,
      failed: 0
    });
  }
});

// Description: Recreate ISY scene/link topology on the current PLM
// Endpoint: POST /api/insteon/devices/import/isy/topology
// Request: { scenes?: Array<object>, linkRecords?: Array<object>, dryRun?: boolean, sceneTimeoutMs?: number, pauseBetweenScenesMs?: number, continueOnError?: boolean, upsertDevices?: boolean }
// Response: { success: boolean, dryRun: boolean, sceneCount: number, plannedLinkOperations: number, appliedScenes: number, failedScenes: number, imported: number, updated: number, scenes: Array<object> }
router.post('/devices/import/isy/topology', async (req, res) => {
  console.log('InsteonRoutes: Syncing ISY scene topology to current PLM');

  try {
    const result = await insteonService.applyISYSceneTopology(req.body || {});
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: ISY topology sync failed:', error.message);
    console.error(error.stack);
    const statusCode = /no valid isy scene topology|isy topology .* must be|scenes must be valid json/i.test(String(error.message).toLowerCase())
      ? 400
      : 500;
    res.status(statusCode).json({
      success: false,
      message: error.message,
      dryRun: Boolean(req.body?.dryRun),
      sceneCount: 0,
      plannedLinkOperations: 0,
      appliedScenes: 0,
      failedScenes: 0
    });
  }
});

// Description: Scan all Insteon devices and update their status
// Endpoint: POST /api/insteon/devices/scan
// Request: {}
// Response: { success: boolean, message: string, results: object }
router.post('/devices/scan', async (req, res) => {
  console.log('InsteonRoutes: Scanning all Insteon devices');

  try {
    const result = await insteonService.scanAllDevices();
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Device scan failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Get specific device status from PLM
// Endpoint: GET /api/insteon/devices/:deviceId/status
// Request: { deviceId: string }
// Response: { success: boolean, status: boolean, brightness: number, level: number, isOnline: boolean }
router.get('/devices/:deviceId/status', async (req, res) => {
  const { deviceId } = req.params;
  console.log(`InsteonRoutes: Getting status for device ${deviceId}`);

  try {
    const status = await insteonService.getDeviceStatus(deviceId);
    res.status(200).json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error(`InsteonRoutes: Failed to get device ${deviceId} status:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Turn device on
// Endpoint: POST /api/insteon/devices/:deviceId/on
// Request: { deviceId: string, brightness?: number }
// Response: { success: boolean, message: string, status: boolean, brightness: number }
router.post('/devices/:deviceId/on', async (req, res) => {
  const { deviceId } = req.params;
  const { brightness = 100 } = req.body;

  console.log(`InsteonRoutes: Turning on device ${deviceId} at ${brightness}%`);

  try {
    const result = await insteonService.turnOn(deviceId, brightness);
    res.status(200).json(result);
  } catch (error) {
    console.error(`InsteonRoutes: Failed to turn on device ${deviceId}:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Turn device off
// Endpoint: POST /api/insteon/devices/:deviceId/off
// Request: { deviceId: string }
// Response: { success: boolean, message: string, status: boolean, brightness: number }
router.post('/devices/:deviceId/off', async (req, res) => {
  const { deviceId } = req.params;
  console.log(`InsteonRoutes: Turning off device ${deviceId}`);

  try {
    const result = await insteonService.turnOff(deviceId);
    res.status(200).json(result);
  } catch (error) {
    console.error(`InsteonRoutes: Failed to turn off device ${deviceId}:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Set device brightness
// Endpoint: POST /api/insteon/devices/:deviceId/brightness
// Request: { deviceId: string, brightness: number }
// Response: { success: boolean, message: string, status: boolean, brightness: number }
router.post('/devices/:deviceId/brightness', async (req, res) => {
  const { deviceId } = req.params;
  const { brightness } = req.body;

  console.log(`InsteonRoutes: Setting device ${deviceId} brightness to ${brightness}%`);

  if (brightness === undefined || brightness < 0 || brightness > 100) {
    return res.status(400).json({
      success: false,
      message: 'Brightness must be between 0 and 100'
    });
  }

  try {
    const result = await insteonService.setBrightness(deviceId, brightness);
    res.status(200).json(result);
  } catch (error) {
    console.error(`InsteonRoutes: Failed to set device ${deviceId} brightness:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Link new device to PLM
// Endpoint: POST /api/insteon/devices/link
// Request: { timeout?: number }
// Response: { success: boolean, message: string, address?: string, group?: number, type?: string }
router.post('/devices/link', async (req, res) => {
  const { timeout = 30 } = req.body;
  console.log(`InsteonRoutes: Starting device linking (timeout: ${timeout}s)`);

  try {
    const result = await insteonService.linkDevice(timeout);
    res.status(200).json(result);
  } catch (error) {
    console.error('InsteonRoutes: Device linking failed:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Unlink device from PLM and remove from database
// Endpoint: DELETE /api/insteon/devices/:deviceId/unlink
// Request: { deviceId: string }
// Response: { success: boolean, message: string }
router.delete('/devices/:deviceId/unlink', async (req, res) => {
  const { deviceId } = req.params;
  console.log(`InsteonRoutes: Unlinking device ${deviceId}`);

  try {
    const result = await insteonService.unlinkDevice(deviceId);
    res.status(200).json(result);
  } catch (error) {
    console.error(`InsteonRoutes: Failed to unlink device ${deviceId}:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Description: Delete device from database only (keep in PLM)
// Endpoint: DELETE /api/insteon/devices/:deviceId
// Request: { deviceId: string }
// Response: { success: boolean, message: string }
router.delete('/devices/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  console.log(`InsteonRoutes: Deleting device ${deviceId} from database`);

  try {
    const result = await insteonService.deleteDevice(deviceId);
    res.status(200).json(result);
  } catch (error) {
    console.error(`InsteonRoutes: Failed to delete device ${deviceId}:`, error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;

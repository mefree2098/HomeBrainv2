const express = require('express');
const fs = require('fs');
const router = express.Router();
const maintenanceService = require('../services/maintenanceService');
const deviceRestartService = require('../services/deviceRestartService');
const { requireAdmin } = require('./middlewares/auth');

router.use(requireAdmin());

function getMaintenanceActor(req) {
  return String(req.user?.email || req.user?._id || req.user?.id || 'unknown-admin');
}

router.get('/device-restart', async (req, res) => {
  try {
    return res.status(200).json(deviceRestartService.getStatus());
  } catch (error) {
    console.error('MaintenanceRoutes: Error fetching device restart status:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch device restart status',
      error: error.message
    });
  }
});

router.post('/device-restart/reboot', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: POST /device-restart/reboot - Dispatching whole-device reboot');
    const result = await deviceRestartService.requestManualReboot({
      actor: getMaintenanceActor(req)
    });
    return res.status(202).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error dispatching whole-device reboot:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to dispatch whole-device reboot',
      error: error.message
    });
  }
});

// Description: Clear all fake/demo data from the system
// Endpoint: DELETE /api/maintenance/fake-data
// Request: {}
// Response: { success: boolean, message: string, results: { devices: number, scenes: number, automations: number, voiceDevices: number, userProfiles: number, voiceCommands: number, securityAlarms: number } }
router.delete('/fake-data', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: DELETE /fake-data - Clearing all fake data');

    const result = await maintenanceService.clearAllFakeData();

    console.log('MaintenanceRoutes: Successfully cleared all fake data');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error clearing fake data:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear fake data'
    });
  }
});

// Description: Inject fake/demo data into the system
// Endpoint: POST /api/maintenance/fake-data
// Request: {}
// Response: { success: boolean, message: string, results: { devices: number, scenes: number, automations: number, voiceDevices: number, userProfiles: number } }
router.post('/fake-data', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: POST /fake-data - Injecting fake data');

    const result = await maintenanceService.injectFakeData();

    console.log('MaintenanceRoutes: Successfully injected fake data');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error injecting fake data:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to inject fake data'
    });
  }
});

// Description: Force re-sync all devices from SmartThings
// Endpoint: POST /api/maintenance/sync/smartthings
// Request: {}
// Response: { success: boolean, message: string, deviceCount: number, error?: string }
router.post('/sync/smartthings', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: POST /sync/smartthings - Force syncing SmartThings devices');

    const result = await maintenanceService.forceSmartThingsSync();

    // Check if the result indicates a configuration issue
    if (!result.success && result.error === 'NOT_CONFIGURED') {
      console.log('MaintenanceRoutes: SmartThings sync failed - not configured');
      return res.status(400).json(result);
    }

    console.log('MaintenanceRoutes: Successfully synced SmartThings devices');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error syncing SmartThings devices:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to sync SmartThings devices'
    });
  }
});

// Description: Force re-sync all devices from INSTEON
// Endpoint: POST /api/maintenance/sync/insteon
// Request: {}
// Response: { success: boolean, message: string, deviceCount: number }
router.post('/sync/insteon', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: POST /sync/insteon - Force syncing INSTEON devices');

    const result = await maintenanceService.forceInsteonSync();

    console.log('MaintenanceRoutes: Successfully synced INSTEON devices');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error syncing INSTEON devices:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to sync INSTEON devices'
    });
  }
});

router.post('/sync/insteon/start', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: POST /sync/insteon/start - Starting async INSTEON sync run');

    const run = maintenanceService.startInsteonSyncRun(req.body || {});
    return res.status(202).json({
      success: true,
      runId: run.id,
      run
    });
  } catch (error) {
    console.error('MaintenanceRoutes: Error starting async INSTEON sync run:', error.message);
    console.error(error.stack);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to start INSTEON sync run'
    });
  }
});

router.get('/sync/insteon/runs/:runId', async (req, res) => {
  const runId = req.params?.runId;
  try {
    const run = maintenanceService.getInsteonSyncRun(runId);
    if (!run) {
      return res.status(404).json({
        success: false,
        message: `INSTEON sync run "${runId}" was not found`
      });
    }

    return res.status(200).json({
      success: true,
      run
    });
  } catch (error) {
    console.error('MaintenanceRoutes: Error fetching INSTEON sync run:', error.message);
    console.error(error.stack);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch INSTEON sync run'
    });
  }
});

router.post('/sync/insteon/runs/:runId/cancel', async (req, res) => {
  const runId = req.params?.runId;
  try {
    const run = maintenanceService.cancelInsteonSyncRun(runId);
    if (!run) {
      return res.status(404).json({
        success: false,
        message: `INSTEON sync run "${runId}" was not found`
      });
    }

    return res.status(200).json({
      success: true,
      message: ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(run.status)
        ? `INSTEON sync run is already ${run.status}.`
        : 'Cancellation requested.',
      run
    });
  } catch (error) {
    console.error('MaintenanceRoutes: Error cancelling INSTEON sync run:', error.message);
    console.error(error.stack);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to cancel INSTEON sync run'
    });
  }
});

// Description: Force re-sync all devices from Harmony
// Endpoint: POST /api/maintenance/sync/harmony
// Request: {}
// Response: { success: boolean, message: string, hubsFound: number, created: number, updated: number, removed: number }
router.post('/sync/harmony', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: POST /sync/harmony - Force syncing Harmony devices');

    const result = await maintenanceService.forceHarmonySync();

    console.log('MaintenanceRoutes: Successfully synced Harmony devices');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error syncing Harmony devices:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to sync Harmony devices'
    });
  }
});

// Description: Clear all SmartThings devices from local database
// Endpoint: DELETE /api/maintenance/devices/smartthings
// Request: {}
// Response: { success: boolean, message: string, deletedCount: number }
router.delete('/devices/smartthings', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: DELETE /devices/smartthings - Clearing SmartThings devices');

    const result = await maintenanceService.clearSmartThingsDevices();

    console.log('MaintenanceRoutes: Successfully cleared SmartThings devices');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error clearing SmartThings devices:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear SmartThings devices'
    });
  }
});

// Description: Clear all INSTEON devices from local database
// Endpoint: DELETE /api/maintenance/devices/insteon
// Request: {}
// Response: { success: boolean, message: string, deletedCount: number }
router.delete('/devices/insteon', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: DELETE /devices/insteon - Clearing INSTEON devices');

    const result = await maintenanceService.clearInsteonDevices();

    console.log('MaintenanceRoutes: Successfully cleared INSTEON devices');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error clearing INSTEON devices:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear INSTEON devices'
    });
  }
});

// Description: Clear all Harmony devices from local database
// Endpoint: DELETE /api/maintenance/devices/harmony
// Request: {}
// Response: { success: boolean, message: string, deletedCount: number }
router.delete('/devices/harmony', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: DELETE /devices/harmony - Clearing Harmony devices');

    const result = await maintenanceService.clearHarmonyDevices();

    console.log('MaintenanceRoutes: Successfully cleared Harmony devices');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error clearing Harmony devices:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear Harmony devices'
    });
  }
});

// Description: Reset all settings to default values
// Endpoint: POST /api/maintenance/reset/settings
// Request: {}
// Response: { success: boolean, message: string }
router.post('/reset/settings', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: POST /reset/settings - Resetting settings to defaults');

    const result = await maintenanceService.resetSettingsToDefaults();

    console.log('MaintenanceRoutes: Successfully reset settings to defaults');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error resetting settings:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to reset settings'
    });
  }
});

// Description: Clear SmartThings integration configuration
// Endpoint: DELETE /api/maintenance/integrations/smartthings
// Request: {}
// Response: { success: boolean, message: string }
router.delete('/integrations/smartthings', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: DELETE /integrations/smartthings - Clearing SmartThings integration');

    const result = await maintenanceService.clearSmartThingsIntegration();

    console.log('MaintenanceRoutes: Successfully cleared SmartThings integration');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error clearing SmartThings integration:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear SmartThings integration'
    });
  }
});

// Description: Clear all voice command history
// Endpoint: DELETE /api/maintenance/voice-commands
// Request: {}
// Response: { success: boolean, message: string, deletedCount: number }
router.delete('/voice-commands', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: DELETE /voice-commands - Clearing voice command history');

    const result = await maintenanceService.clearVoiceCommandHistory();

    console.log('MaintenanceRoutes: Successfully cleared voice command history');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error clearing voice command history:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear voice command history'
    });
  }
});

// Description: Perform system health check
// Endpoint: GET /api/maintenance/health
// Request: {}
// Response: { success: boolean, message: string, health: Object }
router.get('/health', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: GET /health - Performing system health check');

    const result = await maintenanceService.performHealthCheck();

    console.log('MaintenanceRoutes: Successfully completed health check');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error performing health check:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to perform health check'
    });
  }
});

// Description: Export system configuration
// Endpoint: GET /api/maintenance/export
// Request: {}
// Response: { success: boolean, message: string, config: Object }
router.get('/export', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: GET /export - Exporting system configuration');

    const result = await maintenanceService.exportConfiguration();

    console.log('MaintenanceRoutes: Successfully exported configuration');
    res.status(200).json(result);
  } catch (error) {
    console.error('MaintenanceRoutes: Error exporting configuration:', error.message);
    console.error(error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to export configuration'
    });
  }
});

router.get('/backup/full', async (req, res) => {
  let backup = null;

  try {
    console.log('MaintenanceRoutes: GET /backup/full - Creating full disaster recovery backup');

    backup = await maintenanceService.createDisasterRecoveryBackup();

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${backup.archiveFilename}"`);
    res.setHeader('Cache-Control', 'no-store');

    const stream = fs.createReadStream(backup.archivePath);
    stream.on('error', async (error) => {
      console.error('MaintenanceRoutes: Error streaming disaster recovery backup:', error.message);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Failed to stream backup archive'
        });
      } else {
        res.destroy(error);
      }
      await backup?.cleanup?.().catch(() => {});
    });

    res.on('finish', () => {
      void backup?.cleanup?.().catch(() => {});
    });
    res.on('close', () => {
      void backup?.cleanup?.().catch(() => {});
    });

    stream.pipe(res);
  } catch (error) {
    console.error('MaintenanceRoutes: Error creating disaster recovery backup:', error.message);
    console.error(error.stack);
    await backup?.cleanup?.().catch(() => {});
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create disaster recovery backup'
    });
  }
});

router.get('/restore/latest', async (_req, res) => {
  try {
    const job = await maintenanceService.getLatestRestoreJob();
    return res.status(200).json({
      success: true,
      job
    });
  } catch (error) {
    console.error('MaintenanceRoutes: Error fetching latest restore job:', error.message);
    console.error(error.stack);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch latest restore status'
    });
  }
});

router.post('/restore', async (req, res) => {
  try {
    const archiveName = String(req.headers['x-backup-filename'] || '').trim();
    if (!archiveName) {
      return res.status(400).json({
        success: false,
        error: 'x-backup-filename header is required'
      });
    }

    const actor = req.user?.email || req.user?._id || 'unknown';
    const job = await maintenanceService.startDisasterRecoveryRestore(req, {
      archiveName,
      actor
    });

    let launched = false;
    const triggerLaunch = () => {
      if (launched) {
        return;
      }

      launched = true;
      void maintenanceService.launchQueuedDisasterRecoveryRestore(job.id).catch((error) => {
        console.error('MaintenanceRoutes: Error launching disaster recovery restore helper:', error.message);
        console.error(error.stack);
      });
    };

    res.on('finish', triggerLaunch);
    res.on('close', triggerLaunch);

    return res.status(202).json({
      success: true,
      message: 'Disaster recovery restore queued. HomeBrain will go temporarily offline while the restore is applied.',
      job
    });
  } catch (error) {
    console.error('MaintenanceRoutes: Error starting disaster recovery restore:', error.message);
    console.error(error.stack);

    const statusCode = error.code === 'RESTORE_RUNNING' ? 409 : 500;
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to start disaster recovery restore'
    });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const maintenanceService = require('../services/maintenanceService');

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
// Response: { success: boolean, message: string, deviceCount: number }
router.post('/sync/smartthings', async (req, res) => {
  try {
    console.log('MaintenanceRoutes: POST /sync/smartthings - Force syncing SmartThings devices');

    const result = await maintenanceService.forceSmartThingsSync();

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

module.exports = router;
/**
 * SmartThings Integration Test Script
 *
 * This script tests the SmartThings integration functionality including:
 * - OAuth configuration
 * - Connection testing
 * - Device retrieval
 * - Device control
 * - Scene management
 * - STHM (Smart Home Monitor) integration
 *
 * Usage: node server/scripts/testSmartThings.js
 */

require('dotenv').config({ path: './.env' });
const mongoose = require('mongoose');
const smartThingsService = require('../services/smartThingsService');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const Settings = require('../models/Settings');

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  gray: '\x1b[90m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function success(message) {
  log(`✓ ${message}`, colors.green);
}

function error(message) {
  log(`✗ ${message}`, colors.red);
}

function info(message) {
  log(`ℹ ${message}`, colors.blue);
}

function warn(message) {
  log(`⚠ ${message}`, colors.yellow);
}

function section(message) {
  console.log('');
  log('═'.repeat(60), colors.gray);
  log(message, colors.blue);
  log('═'.repeat(60), colors.gray);
}

async function connectToDatabase() {
  try {
    const dbUrl = process.env.DATABASE_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/HomeBrain';
    await mongoose.connect(dbUrl);
    success('Connected to MongoDB');
    return true;
  } catch (err) {
    error(`Failed to connect to MongoDB: ${err.message}`);
    return false;
  }
}

async function testIntegrationStatus() {
  section('Test 1: Get Integration Status');
  try {
    const integration = await SmartThingsIntegration.getIntegration();

    info(`Integration configured: ${integration.isConfigured}`);
    info(`Integration connected: ${integration.isConnected}`);

    if (integration.clientId) {
      const masked = integration.clientId.substring(0, 8) + '***';
      info(`Client ID: ${masked}`);
    }

    if (integration.isConnected && integration.accessToken) {
      info(`Access token exists: Yes`);
      info(`Token valid: ${integration.isTokenValid ? integration.isTokenValid() : 'N/A'}`);
      info(`Connected devices: ${integration.connectedDevices?.length || 0}`);
    }

    success('Integration status retrieved successfully');
    return integration;
  } catch (err) {
    error(`Failed to get integration status: ${err.message}`);
    throw err;
  }
}

async function testPersonalAccessToken() {
  section('Test 2: Check Personal Access Token (PAT) Configuration');
  try {
    const settings = await Settings.getSettings();

    if (settings.smartthingsToken && settings.smartthingsToken.trim() !== '') {
      success('Personal Access Token (PAT) is configured');
      info('PAT Mode: This integration will use PAT instead of OAuth');
      return true;
    } else {
      warn('Personal Access Token (PAT) is not configured');
      info('OAuth Mode: This integration requires OAuth configuration');
      return false;
    }
  } catch (err) {
    error(`Failed to check PAT configuration: ${err.message}`);
    return false;
  }
}

async function testConnection() {
  section('Test 3: Test SmartThings Connection');
  try {
    info('Testing connection to SmartThings API...');
    const result = await smartThingsService.testConnection();

    if (result.success) {
      success('Connection test successful');
      info(`Devices found: ${result.deviceCount}`);
      return true;
    } else {
      error('Connection test failed');
      return false;
    }
  } catch (err) {
    error(`Connection test failed: ${err.message}`);

    if (err.message.includes('No access token available')) {
      warn('SmartThings integration is not authorized');
      info('Please configure OAuth or set Personal Access Token in Settings');
    }

    return false;
  }
}

async function testGetDevices() {
  section('Test 4: Retrieve SmartThings Devices');
  try {
    info('Fetching devices from SmartThings...');
    const devices = await smartThingsService.getDevices();

    success(`Retrieved ${devices.length} devices`);

    if (devices.length > 0) {
      info('Sample devices:');
      devices.slice(0, 5).forEach((device, index) => {
        const capabilities = device.components?.[0]?.capabilities?.map(c => c.id).slice(0, 3).join(', ') || 'N/A';
        log(`  ${index + 1}. ${device.label || device.name} (${device.deviceId.substring(0, 8)}...)`, colors.gray);
        log(`     Type: ${device.type || 'Unknown'} | Capabilities: ${capabilities}`, colors.gray);
      });

      if (devices.length > 5) {
        log(`  ... and ${devices.length - 5} more devices`, colors.gray);
      }
    } else {
      warn('No devices found in your SmartThings account');
    }

    return devices;
  } catch (err) {
    error(`Failed to retrieve devices: ${err.message}`);
    return [];
  }
}

async function testDeviceStatus(deviceId) {
  section('Test 5: Get Device Status');
  try {
    if (!deviceId) {
      warn('No device ID provided, skipping device status test');
      return null;
    }

    info(`Fetching status for device: ${deviceId.substring(0, 8)}...`);
    const status = await smartThingsService.getDeviceStatus(deviceId);

    success('Device status retrieved successfully');

    if (status.components?.main) {
      const mainComponent = status.components.main;
      info('Device capabilities:');
      Object.keys(mainComponent).slice(0, 5).forEach(capability => {
        const value = JSON.stringify(mainComponent[capability]);
        log(`  ${capability}: ${value.substring(0, 50)}`, colors.gray);
      });
    }

    return status;
  } catch (err) {
    error(`Failed to get device status: ${err.message}`);
    return null;
  }
}

async function testGetScenes() {
  section('Test 6: Retrieve SmartThings Scenes');
  try {
    info('Fetching scenes from SmartThings...');
    const scenes = await smartThingsService.getScenes();

    success(`Retrieved ${scenes.length} scenes`);

    if (scenes.length > 0) {
      info('Available scenes:');
      scenes.forEach((scene, index) => {
        log(`  ${index + 1}. ${scene.sceneName} (${scene.sceneId.substring(0, 8)}...)`, colors.gray);
      });
    } else {
      warn('No scenes found in your SmartThings account');
    }

    return scenes;
  } catch (err) {
    error(`Failed to retrieve scenes: ${err.message}`);
    return [];
  }
}

async function testSthmConfiguration() {
  section('Test 7: Check STHM Configuration');
  try {
    const integration = await SmartThingsIntegration.getIntegration();

    if (integration.sthm) {
      const hasArmAway = integration.sthm.armAwayDeviceId && integration.sthm.armAwayDeviceId.trim() !== '';
      const hasArmStay = integration.sthm.armStayDeviceId && integration.sthm.armStayDeviceId.trim() !== '';
      const hasDisarm = integration.sthm.disarmDeviceId && integration.sthm.disarmDeviceId.trim() !== '';

      if (hasArmAway || hasArmStay || hasDisarm) {
        success('STHM virtual switches are configured');
        if (hasArmAway) info('✓ Arm Away switch configured');
        if (hasArmStay) info('✓ Arm Stay switch configured');
        if (hasDisarm) info('✓ Disarm switch configured');
        return true;
      } else {
        warn('STHM virtual switches are not configured');
        info('Configure STHM in Settings to enable security system integration');
        return false;
      }
    } else {
      warn('STHM configuration not found');
      return false;
    }
  } catch (err) {
    error(`Failed to check STHM configuration: ${err.message}`);
    return false;
  }
}

async function testOAuthConfiguration() {
  section('Test 8: Check OAuth Configuration');
  try {
    const integration = await SmartThingsIntegration.getIntegration();

    if (integration.clientId && integration.clientSecret) {
      success('OAuth credentials are configured');
      info(`Redirect URI: ${integration.redirectUri}`);

      if (integration.accessToken) {
        success('Access token is present');
        if (integration.refreshToken) {
          success('Refresh token is present');
        }
      } else {
        warn('No access token - authorization required');
        info('Use the Settings page to authorize SmartThings access');
      }

      return true;
    } else {
      warn('OAuth credentials are not configured');
      info('Configure OAuth in Settings to enable SmartThings integration');
      return false;
    }
  } catch (err) {
    error(`Failed to check OAuth configuration: ${err.message}`);
    return false;
  }
}

async function generateReport(results) {
  section('Test Summary');

  const {
    integration,
    hasPAT,
    connectionSuccess,
    devices,
    scenes,
    sthmConfigured,
    oauthConfigured
  } = results;

  console.log('');
  log('Integration Status:', colors.blue);
  log(`  Configured: ${integration?.isConfigured ? '✓ Yes' : '✗ No'}`,
    integration?.isConfigured ? colors.green : colors.red);
  log(`  Connected: ${integration?.isConnected ? '✓ Yes' : '✗ No'}`,
    integration?.isConnected ? colors.green : colors.red);
  log(`  Authentication: ${hasPAT ? 'Personal Access Token' : oauthConfigured ? 'OAuth' : 'Not configured'}`,
    (hasPAT || oauthConfigured) ? colors.green : colors.red);

  console.log('');
  log('Capabilities:', colors.blue);
  log(`  Connection Test: ${connectionSuccess ? '✓ Passed' : '✗ Failed'}`,
    connectionSuccess ? colors.green : colors.red);
  log(`  Devices: ${devices?.length || 0} found`,
    (devices?.length || 0) > 0 ? colors.green : colors.yellow);
  log(`  Scenes: ${scenes?.length || 0} found`,
    (scenes?.length || 0) > 0 ? colors.green : colors.yellow);
  log(`  STHM Integration: ${sthmConfigured ? '✓ Configured' : '✗ Not configured'}`,
    sthmConfigured ? colors.green : colors.yellow);

  console.log('');

  if (!integration?.isConnected) {
    log('⚠ Next Steps:', colors.yellow);
    log('  1. Configure OAuth credentials in Settings, or', colors.gray);
    log('  2. Set SmartThings Personal Access Token (PAT) in Settings', colors.gray);
    log('  3. Authorize access through the Settings page', colors.gray);
    log('  4. Run this test again to verify connection', colors.gray);
  } else {
    log('✓ SmartThings integration is fully operational!', colors.green);
  }

  console.log('');
}

async function runTests() {
  console.log('');
  log('╔════════════════════════════════════════════════════════════╗', colors.blue);
  log('║        SmartThings Integration Test Suite                 ║', colors.blue);
  log('╚════════════════════════════════════════════════════════════╝', colors.blue);
  console.log('');

  try {
    // Connect to database
    const dbConnected = await connectToDatabase();
    if (!dbConnected) {
      error('Cannot proceed without database connection');
      process.exit(1);
    }

    // Run all tests
    const integration = await testIntegrationStatus();
    const hasPAT = await testPersonalAccessToken();
    const oauthConfigured = await testOAuthConfiguration();
    const connectionSuccess = await testConnection();

    let devices = [];
    let scenes = [];
    let sthmConfigured = false;

    if (connectionSuccess) {
      devices = await testGetDevices();

      // Test device status if we have devices
      if (devices.length > 0) {
        await testDeviceStatus(devices[0].deviceId);
      }

      scenes = await testGetScenes();
      sthmConfigured = await testSthmConfiguration();
    }

    // Generate final report
    await generateReport({
      integration,
      hasPAT,
      connectionSuccess,
      devices,
      scenes,
      sthmConfigured,
      oauthConfigured
    });

    success('All tests completed');

  } catch (err) {
    error(`Test suite failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    info('Database connection closed');
  }
}

// Run the test suite
runTests();

#!/usr/bin/env node

/**
 * Test script for Insteon PLM integration
 * Tests all major Insteon service capabilities
 */

require('dotenv').config();
const mongoose = require('mongoose');
const insteonService = require('../services/insteonService');
const Settings = require('../models/Settings');
const Device = require('../models/Device');

const MONGODB_URI = process.env.DATABASE_URL;

async function connectDatabase() {
  console.log('Connecting to database...');
  await mongoose.connect(MONGODB_URI);
  console.log('✓ Database connected\n');
}

async function disconnectDatabase() {
  console.log('\nDisconnecting from database...');
  await mongoose.disconnect();
  console.log('✓ Database disconnected');
}

async function testInsteonIntegration() {
  console.log('='.repeat(60));
  console.log('INSTEON PLM INTEGRATION TEST');
  console.log('='.repeat(60));
  console.log();

  try {
    await connectDatabase();

    // Test 1: Check current status
    console.log('Test 1: Checking Insteon PLM status');
    console.log('-'.repeat(60));
    try {
      const status = insteonService.getStatus();
      console.log('✓ Status retrieved:');
      console.log(`  - Connected: ${status.connected}`);
      console.log(`  - Cached devices: ${status.deviceCount}`);
      console.log(`  - Connection attempts: ${status.connectionAttempts}`);
    } catch (error) {
      console.error('✗ Status check failed:', error.message);
    }
    console.log();

    // Test 2: Test connection
    console.log('Test 2: Testing PLM connection');
    console.log('-'.repeat(60));
    try {
      const result = await insteonService.testConnection();
      console.log(`✓ Connection test: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      console.log(`  - Message: ${result.message}`);
      console.log(`  - Connected: ${result.connected}`);
      if (result.plmInfo) {
        console.log('  - PLM Info:');
        console.log(`    - Device ID: ${result.plmInfo.deviceId}`);
        console.log(`    - Firmware: ${result.plmInfo.firmwareVersion}`);
        console.log(`    - Category: ${result.plmInfo.deviceCategory}`);
      }
    } catch (error) {
      console.error('✗ Connection test failed:', error.message);
      console.error('  Note: Make sure Insteon PLM is connected and port is configured correctly');
      console.error('  Current port setting can be checked in Settings collection');
    }
    console.log();

    // Test 3: Get linked devices
    console.log('Test 3: Getting linked devices from PLM');
    console.log('-'.repeat(60));
    try {
      const devices = await insteonService.getAllLinkedDevices();
      console.log(`✓ Found ${devices.length} linked devices:`);
      devices.slice(0, 5).forEach((device, index) => {
        console.log(`  ${index + 1}. Address: ${device.address}, Group: ${device.group}, Type: ${device.type}`);
      });
      if (devices.length > 5) {
        console.log(`  ... and ${devices.length - 5} more`);
      }
    } catch (error) {
      console.error('✗ Failed to get linked devices:', error.message);
    }
    console.log();

    // Test 4: Check devices in database
    console.log('Test 4: Checking Insteon devices in database');
    console.log('-'.repeat(60));
    try {
      const dbDevices = await Device.find({ 'properties.source': 'insteon' });
      console.log(`✓ Found ${dbDevices.length} Insteon devices in database:`);
      dbDevices.slice(0, 5).forEach((device, index) => {
        console.log(`  ${index + 1}. ${device.name} (${device.type}) - ${device.room}`);
        console.log(`     Address: ${device.properties.insteonAddress}, Status: ${device.status ? 'ON' : 'OFF'}`);
      });
      if (dbDevices.length > 5) {
        console.log(`  ... and ${dbDevices.length - 5} more`);
      }
    } catch (error) {
      console.error('✗ Failed to query database:', error.message);
    }
    console.log();

    // Test 5: Import devices (if none in database)
    console.log('Test 5: Device import test');
    console.log('-'.repeat(60));
    const dbDeviceCount = await Device.countDocuments({ 'properties.source': 'insteon' });
    if (dbDeviceCount === 0) {
      console.log('No Insteon devices in database, attempting import...');
      try {
        const importResult = await insteonService.importDevices();
        console.log(`✓ Import completed:`);
        console.log(`  - Imported: ${importResult.imported}`);
        console.log(`  - Skipped: ${importResult.skipped}`);
        console.log(`  - Errors: ${importResult.errors}`);
        if (importResult.errorDetails && importResult.errorDetails.length > 0) {
          console.log('  - Error details:');
          importResult.errorDetails.forEach(err => {
            console.log(`    - ${err.address}: ${err.error}`);
          });
        }
      } catch (error) {
        console.error('✗ Import failed:', error.message);
      }
    } else {
      console.log(`ℹ Skipping import - ${dbDeviceCount} Insteon devices already in database`);
      console.log('  To test import, delete existing Insteon devices first or use:');
      console.log('  Device.deleteMany({ "properties.source": "insteon" })');
    }
    console.log();

    // Test 6: Device status check (if devices exist)
    console.log('Test 6: Device status check');
    console.log('-'.repeat(60));
    const testDevice = await Device.findOne({ 'properties.source': 'insteon' });
    if (testDevice) {
      console.log(`Testing with device: ${testDevice.name} (${testDevice._id})`);
      try {
        const status = await insteonService.getDeviceStatus(testDevice._id);
        console.log('✓ Status retrieved:');
        console.log(`  - Status: ${status.status ? 'ON' : 'OFF'}`);
        console.log(`  - Brightness: ${status.brightness}%`);
        console.log(`  - Level: ${status.level}`);
        console.log(`  - Online: ${status.isOnline}`);
      } catch (error) {
        console.error('✗ Status check failed:', error.message);
      }
    } else {
      console.log('ℹ No Insteon devices in database to test');
    }
    console.log();

    // Test 7: Settings check
    console.log('Test 7: Checking Insteon settings');
    console.log('-'.repeat(60));
    try {
      const settings = await Settings.getSettings();
      console.log('✓ Current Insteon settings:');
      console.log(`  - Port: ${settings.insteonPort || 'Not configured'}`);
      console.log('  Note: Default port is /dev/ttyUSB0');
      console.log('  To change, update Settings.insteonPort in database');
    } catch (error) {
      console.error('✗ Settings check failed:', error.message);
    }
    console.log();

    // Summary
    console.log('='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log('All tests completed. Check results above for any failures.');
    console.log();
    console.log('Available Insteon API endpoints:');
    console.log('  GET    /api/insteon/test              - Test connection');
    console.log('  GET    /api/insteon/info              - Get PLM info');
    console.log('  GET    /api/insteon/status            - Get connection status');
    console.log('  POST   /api/insteon/connect           - Connect to PLM');
    console.log('  POST   /api/insteon/disconnect        - Disconnect from PLM');
    console.log('  GET    /api/insteon/devices/linked    - Get all linked devices');
    console.log('  POST   /api/insteon/devices/import    - Import devices to database');
    console.log('  POST   /api/insteon/devices/scan      - Scan and update all devices');
    console.log('  GET    /api/insteon/devices/:id/status - Get device status');
    console.log('  POST   /api/insteon/devices/:id/on    - Turn device on');
    console.log('  POST   /api/insteon/devices/:id/off   - Turn device off');
    console.log('  POST   /api/insteon/devices/:id/brightness - Set brightness');
    console.log('  POST   /api/insteon/devices/link      - Link new device');
    console.log('  DELETE /api/insteon/devices/:id/unlink - Unlink device');
    console.log('  DELETE /api/insteon/devices/:id       - Delete from database');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n✗ Test failed with error:', error.message);
    console.error(error.stack);
  } finally {
    // Cleanup
    try {
      await insteonService.disconnect();
    } catch (error) {
      // Ignore disconnect errors
    }
    await disconnectDatabase();
  }
}

// Run tests
testInsteonIntegration()
  .then(() => {
    console.log('\n✓ Test script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n✗ Test script failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  });

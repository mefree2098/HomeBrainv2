#!/usr/bin/env node

/**
 * Test script for Remote Update Service
 * Tests the remote device update functionality
 */

require('dotenv').config();
const mongoose = require('mongoose');
const remoteUpdateService = require('../services/remoteUpdateService');
const VoiceDevice = require('../models/VoiceDevice');

async function testRemoteUpdate() {
  console.log('='.repeat(60));
  console.log('HomeBrain Remote Update Service Test');
  console.log('='.repeat(60));
  console.log('');

  try {
    // Connect to database
    console.log('Connecting to database...');
    await mongoose.connect(process.env.DATABASE_URL);
    console.log('✓ Database connected');
    console.log('');

    // Initialize update service
    console.log('Initializing Remote Update Service...');
    await remoteUpdateService.initialize();
    console.log('✓ Remote Update Service initialized');
    console.log('');

    // Test 1: Get current version
    console.log('[Test 1] Get Current Version');
    console.log('-'.repeat(60));
    const currentVersion = remoteUpdateService.getCurrentVersion();
    console.log(`Current remote device version: ${currentVersion}`);
    console.log('✓ Test passed');
    console.log('');

    // Test 2: Generate update package
    console.log('[Test 2] Generate Update Package');
    console.log('-'.repeat(60));
    const packageInfo = await remoteUpdateService.generateUpdatePackage();
    console.log('Package generated successfully:');
    console.log(`  Version: ${packageInfo.version}`);
    console.log(`  Package: ${packageInfo.packageName}`);
    console.log(`  Checksum: ${packageInfo.checksum}`);
    console.log('✓ Test passed');
    console.log('');

    // Test 3: Get update statistics
    console.log('[Test 3] Get Update Statistics');
    console.log('-'.repeat(60));
    const stats = await remoteUpdateService.getUpdateStatistics();
    console.log('Update Statistics:');
    console.log(`  Total devices: ${stats.totalDevices}`);
    console.log(`  Current version: ${stats.currentVersion}`);
    console.log(`  Up to date: ${stats.upToDate}`);
    console.log(`  Outdated: ${stats.outdated}`);
    console.log(`  Updating: ${stats.updating}`);
    console.log(`  Offline: ${stats.offline}`);
    console.log(`  By version:`, stats.byVersion);
    console.log('✓ Test passed');
    console.log('');

    // Test 4: Get devices needing update
    console.log('[Test 4] Get Devices Needing Update');
    console.log('-'.repeat(60));
    const outdatedDevices = await remoteUpdateService.getDevicesNeedingUpdate();
    if (outdatedDevices.length > 0) {
      console.log(`Found ${outdatedDevices.length} device(s) needing update:`);
      outdatedDevices.forEach(device => {
        console.log(`  - ${device.name} (${device.room})`);
        console.log(`    Current: ${device.currentVersion} → Latest: ${device.latestVersion}`);
        console.log(`    Status: ${device.status}`);
      });
    } else {
      console.log('All devices are up to date');
    }
    console.log('✓ Test passed');
    console.log('');

    // Test 5: Check for updates on first device (if exists)
    const devices = await VoiceDevice.find({});
    if (devices.length > 0) {
      console.log('[Test 5] Check For Updates (First Device)');
      console.log('-'.repeat(60));
      const firstDevice = devices[0];
      const updateCheck = await remoteUpdateService.checkForUpdates(firstDevice._id.toString());
      console.log(`Device: ${updateCheck.deviceName}`);
      console.log(`  Current version: ${updateCheck.currentVersion}`);
      console.log(`  Latest version: ${updateCheck.latestVersion}`);
      console.log(`  Update available: ${updateCheck.updateAvailable ? 'Yes' : 'No'}`);
      console.log('✓ Test passed');
      console.log('');
    } else {
      console.log('[Test 5] Skipped - No devices found');
      console.log('');
    }

    // Test 6: Get package info
    console.log('[Test 6] Get Package Info');
    console.log('-'.repeat(60));
    const pkgInfo = await remoteUpdateService.getUpdatePackageInfo();
    if (pkgInfo) {
      console.log('Package Information:');
      console.log(`  Version: ${pkgInfo.version}`);
      console.log(`  Package: ${pkgInfo.packageName}`);
      console.log(`  Size: ${(pkgInfo.size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`  Checksum: ${pkgInfo.checksum}`);
      console.log(`  Download URL: ${pkgInfo.downloadUrl}`);
      console.log('✓ Test passed');
    } else {
      console.log('No package found');
      console.log('✓ Test passed (expected for first run)');
    }
    console.log('');

    console.log('='.repeat(60));
    console.log('All tests completed successfully!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('');
    console.error('✗ Test failed!');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  } finally {
    // Close database connection
    await mongoose.connection.close();
    console.log('');
    console.log('Database connection closed');
  }
}

// Run the test
if (require.main === module) {
  testRemoteUpdate()
    .then(() => {
      console.log('');
      console.log('Remote Update Service test completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Test failed:', error);
      process.exit(1);
    });
}

module.exports = testRemoteUpdate;

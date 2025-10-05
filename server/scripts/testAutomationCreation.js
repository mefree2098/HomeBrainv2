#!/usr/bin/env node

/**
 * Test script for automation creation with LLM integration
 * Tests the enhanced prompt engineering, device context, and self-healing features
 */

require('dotenv').config();
const mongoose = require('mongoose');
const dbInit = require('../models/init');
const automationService = require('../services/automationService');
const Device = require('../models/Device');

async function main() {
  try {
    console.log('='.repeat(80));
    console.log('Testing Enhanced Automation Creation System');
    console.log('='.repeat(80));
    console.log();

    // Connect to database
    await dbInit();
    console.log('✓ Connected to database');
    console.log();

    // Check available devices
    const devices = await Device.find().lean();
    console.log(`✓ Found ${devices.length} devices in the database:`);
    devices.slice(0, 5).forEach(device => {
      console.log(`  - ${device.name} (${device.type}) in ${device.room}`);
    });
    if (devices.length > 5) {
      console.log(`  ... and ${devices.length - 5} more`);
    }
    console.log();

    // Test automation creation
    const testRequests = [
      'Turn on the living room lights every morning at 7 AM',
      'When motion is detected in the hallway after sunset, turn on the hallway light',
      'Lock all doors when I say goodnight'
    ];

    for (const [index, request] of testRequests.entries()) {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`Test ${index + 1}: "${request}"`);
      console.log('='.repeat(80));

      try {
        const result = await automationService.createAutomationFromText(request);

        console.log(`\n✓ Success! Created automation:`);
        console.log(`  Name: ${result.automation.name}`);
        console.log(`  Description: ${result.automation.description}`);
        console.log(`  Trigger Type: ${result.automation.trigger.type}`);
        console.log(`  Actions: ${result.automation.actions.length}`);
        console.log(`  Category: ${result.automation.category}`);
        console.log(`  Enabled: ${result.automation.enabled}`);

        console.log(`\n  Trigger Conditions:`);
        console.log(`  ${JSON.stringify(result.automation.trigger.conditions, null, 2)}`);

        console.log(`\n  Actions:`);
        result.automation.actions.forEach((action, i) => {
          console.log(`    ${i + 1}. ${action.type} -> ${action.target}`);
          if (action.parameters) {
            console.log(`       Parameters: ${JSON.stringify(action.parameters)}`);
          }
        });

      } catch (error) {
        console.error(`\n✗ Failed to create automation:`);
        console.error(`  Error: ${error.message}`);

        if (error.stack) {
          console.error(`\n  Stack trace:`);
          console.error(error.stack.split('\n').slice(0, 5).join('\n'));
        }
      }
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log('Testing Complete');
    console.log('='.repeat(80));

  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n✓ Database connection closed');
    process.exit(0);
  }
}

// Run the test
main();

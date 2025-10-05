#!/usr/bin/env node

/**
 * Test Script for LLM Priority Fallback Mechanism
 *
 * This script tests the LLM priority list functionality by:
 * 1. Testing with default priority list (local -> openai -> anthropic)
 * 2. Testing with custom priority lists
 * 3. Verifying fallback behavior when providers fail
 * 4. Testing configuration of priority list
 */

require('dotenv').config();
const mongoose = require('mongoose');
require('../models/init');
const Settings = require('../models/Settings');
const { sendLLMRequestWithFallback } = require('../services/llmService');

const TEST_MESSAGE = 'Say "Hello, I am working!" in exactly those words.';

async function connectDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/homebrain', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✓ Database connected successfully');
  } catch (error) {
    console.error('✗ Database connection failed:', error.message);
    process.exit(1);
  }
}

async function testDefaultPriorityList() {
  console.log('\n=== Test 1: Default Priority List ===');

  try {
    const settings = await Settings.getSettings();
    console.log('Current priority list:', settings.llmPriorityList);

    console.log('\nSending test message with fallback mechanism...');
    const response = await sendLLMRequestWithFallback(TEST_MESSAGE);

    console.log('✓ Response received:', response.substring(0, 100) + (response.length > 100 ? '...' : ''));
    return true;
  } catch (error) {
    console.error('✗ Test failed:', error.message);
    return false;
  }
}

async function testCustomPriorityList() {
  console.log('\n=== Test 2: Custom Priority List (OpenAI first) ===');

  try {
    console.log('Testing with custom priority: [openai, anthropic, local]');
    const response = await sendLLMRequestWithFallback(TEST_MESSAGE, ['openai', 'anthropic', 'local']);

    console.log('✓ Response received:', response.substring(0, 100) + (response.length > 100 ? '...' : ''));
    return true;
  } catch (error) {
    console.error('✗ Test failed:', error.message);
    return false;
  }
}

async function testFallbackBehavior() {
  console.log('\n=== Test 3: Fallback Behavior (Invalid provider first) ===');

  try {
    // This should fail on 'local' (likely not configured) and fallback to next
    console.log('Testing with priority: [local, openai, anthropic]');
    console.log('(Local LLM will likely fail and fallback to OpenAI)');

    const response = await sendLLMRequestWithFallback(TEST_MESSAGE, ['local', 'openai', 'anthropic']);

    console.log('✓ Fallback successful! Response received:', response.substring(0, 100) + (response.length > 100 ? '...' : ''));
    return true;
  } catch (error) {
    console.error('✗ Test failed (all providers failed):', error.message);
    return false;
  }
}

async function testPriorityListConfiguration() {
  console.log('\n=== Test 4: Priority List Configuration ===');

  try {
    const settings = await Settings.getSettings();
    const originalPriority = [...settings.llmPriorityList];

    console.log('Original priority list:', originalPriority);

    // Update priority list
    const newPriority = ['anthropic', 'openai', 'local'];
    console.log('Updating priority list to:', newPriority);

    settings.llmPriorityList = newPriority;
    await settings.save();

    // Verify the update
    const updatedSettings = await Settings.getSettings();
    console.log('Updated priority list:', updatedSettings.llmPriorityList);

    if (JSON.stringify(updatedSettings.llmPriorityList) === JSON.stringify(newPriority)) {
      console.log('✓ Priority list updated successfully');

      // Restore original priority
      settings.llmPriorityList = originalPriority;
      await settings.save();
      console.log('✓ Original priority list restored:', originalPriority);

      return true;
    } else {
      console.error('✗ Priority list update failed');
      return false;
    }
  } catch (error) {
    console.error('✗ Test failed:', error.message);
    return false;
  }
}

async function testAllProvidersFail() {
  console.log('\n=== Test 5: All Providers Fail Scenario ===');

  try {
    // This should fail on all providers if none are configured
    console.log('Testing scenario where all providers would fail...');
    console.log('(This is expected to throw an error showing all providers were tried)');

    // Temporarily use providers that don't exist to simulate failure
    try {
      await sendLLMRequestWithFallback(TEST_MESSAGE, ['local']);
    } catch (error) {
      if (error.message.includes('All LLM providers failed')) {
        console.log('✓ Correct behavior: System reported all providers failed');
        console.log('  Error message:', error.message);
        return true;
      } else {
        console.error('✗ Unexpected error:', error.message);
        return false;
      }
    }

    console.error('✗ Expected an error but none was thrown');
    return false;
  } catch (error) {
    console.error('✗ Test failed unexpectedly:', error.message);
    return false;
  }
}

async function displayConfiguration() {
  console.log('\n=== Current LLM Configuration ===');

  try {
    const settings = await Settings.getSettings();

    console.log('\nPriority List:', settings.llmPriorityList);
    console.log('\nProvider Configurations:');
    console.log('  Local LLM:');
    console.log('    - Endpoint:', settings.localLlmEndpoint || '(not configured)');
    console.log('    - Model:', settings.localLlmModel || '(not configured)');
    console.log('  OpenAI:');
    console.log('    - API Key:', settings.openaiApiKey ? '(configured)' : '(not configured)');
    console.log('    - Model:', settings.openaiModel || '(not configured)');
    console.log('  Anthropic:');
    console.log('    - API Key:', settings.anthropicApiKey ? '(configured)' : '(not configured)');
    console.log('    - Model:', settings.anthropicModel || '(not configured)');

  } catch (error) {
    console.error('Failed to display configuration:', error.message);
  }
}

async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  HomeBrain - LLM Priority Fallback Mechanism Test Suite   ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  await connectDatabase();
  await displayConfiguration();

  const results = {
    test1: await testDefaultPriorityList(),
    test2: await testCustomPriorityList(),
    test3: await testFallbackBehavior(),
    test4: await testPriorityListConfiguration(),
    test5: await testAllProvidersFail(),
  };

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  Test Results Summary                                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`Test 1 (Default Priority List):      ${results.test1 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 2 (Custom Priority List):       ${results.test2 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 3 (Fallback Behavior):          ${results.test3 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 4 (Configuration):              ${results.test4 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 5 (All Providers Fail):         ${results.test5 ? '✓ PASS' : '✗ FAIL'}`);

  const passed = Object.values(results).filter(r => r).length;
  const total = Object.values(results).length;

  console.log(`\nTotal: ${passed}/${total} tests passed`);

  await mongoose.connection.close();
  console.log('\nDatabase connection closed');

  process.exit(passed === total ? 0 : 1);
}

// Run tests
runAllTests().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

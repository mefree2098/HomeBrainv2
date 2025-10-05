#!/usr/bin/env node

/**
 * Test Script for LLM Priority API Endpoints
 *
 * This script tests the LLM priority list API endpoints:
 * 1. Login to get auth token
 * 2. GET /api/settings/llm-priority
 * 3. PUT /api/settings/llm-priority with different priority orders
 */

const axios = require('axios');

const API_BASE = 'http://localhost:3000';
const TEST_USER = {
  email: 'admin@test.com',
  password: 'Admin123!'
};

let authToken = null;

async function login() {
  console.log('\n=== Step 1: Login ===');
  try {
    const response = await axios.post(`${API_BASE}/api/auth/login`, TEST_USER);

    if (response.data.success && response.data.accessToken) {
      authToken = response.data.accessToken;
      console.log('✓ Login successful');
      console.log('  User:', response.data.user.email);
      console.log('  Role:', response.data.user.role);
      return true;
    } else {
      console.error('✗ Login failed: No access token received');
      return false;
    }
  } catch (error) {
    console.error('✗ Login failed:', error.response?.data?.message || error.message);
    return false;
  }
}

async function getLLMPriority() {
  console.log('\n=== Step 2: Get Current LLM Priority List ===');
  try {
    const response = await axios.get(`${API_BASE}/api/settings/llm-priority`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    if (response.data.success && response.data.priorityList) {
      console.log('✓ Successfully retrieved priority list');
      console.log('  Current priority:', JSON.stringify(response.data.priorityList));
      return response.data.priorityList;
    } else {
      console.error('✗ Failed to get priority list: Invalid response');
      return null;
    }
  } catch (error) {
    console.error('✗ Failed to get priority list:', error.response?.data?.message || error.message);
    return null;
  }
}

async function updateLLMPriority(newPriority) {
  console.log(`\n=== Step 3: Update LLM Priority List ===`);
  console.log('  New priority:', JSON.stringify(newPriority));

  try {
    const response = await axios.put(
      `${API_BASE}/api/settings/llm-priority`,
      { priorityList: newPriority },
      {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.success) {
      console.log('✓ Successfully updated priority list');
      console.log('  Updated priority:', JSON.stringify(response.data.priorityList));
      return true;
    } else {
      console.error('✗ Failed to update priority list');
      return false;
    }
  } catch (error) {
    console.error('✗ Failed to update priority list:', error.response?.data?.message || error.message);
    return false;
  }
}

async function testInvalidPriority() {
  console.log('\n=== Step 4: Test Invalid Priority List (should fail) ===');

  try {
    await axios.put(
      `${API_BASE}/api/settings/llm-priority`,
      { priorityList: ['invalid', 'providers'] },
      {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.error('✗ Should have failed with invalid providers but succeeded');
    return false;
  } catch (error) {
    if (error.response?.status === 400) {
      console.log('✓ Correctly rejected invalid providers');
      console.log('  Error message:', error.response.data.message);
      return true;
    } else {
      console.error('✗ Unexpected error:', error.response?.data?.message || error.message);
      return false;
    }
  }
}

async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     HomeBrain - LLM Priority API Endpoint Tests           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  // Test 1: Login
  const loginSuccess = await login();
  if (!loginSuccess) {
    console.error('\n✗ Cannot proceed without authentication');
    process.exit(1);
  }

  // Test 2: Get current priority
  const originalPriority = await getLLMPriority();
  if (!originalPriority) {
    console.error('\n✗ Failed to get priority list');
    process.exit(1);
  }

  // Test 3: Update to new priority
  const test3 = await updateLLMPriority(['openai', 'anthropic', 'local']);

  // Test 4: Verify the update
  const updatedPriority = await getLLMPriority();
  const test4 = updatedPriority && JSON.stringify(updatedPriority) === JSON.stringify(['openai', 'anthropic', 'local']);

  if (test4) {
    console.log('✓ Verified priority list was updated correctly');
  } else {
    console.error('✗ Priority list verification failed');
  }

  // Test 5: Update to another priority
  const test5 = await updateLLMPriority(['anthropic', 'local', 'openai']);

  // Test 6: Test invalid priority (should fail)
  const test6 = await testInvalidPriority();

  // Test 7: Restore original priority
  console.log('\n=== Step 5: Restore Original Priority ===');
  const test7 = await updateLLMPriority(originalPriority);

  // Summary
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  Test Results Summary                                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`Test 1 (Login):                       ${loginSuccess ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 2 (Get Priority List):           ${originalPriority ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 3 (Update Priority):             ${test3 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 4 (Verify Update):               ${test4 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 5 (Update Again):                ${test5 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 6 (Reject Invalid):              ${test6 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 7 (Restore Original):            ${test7 ? '✓ PASS' : '✗ FAIL'}`);

  const passed = [loginSuccess, originalPriority, test3, test4, test5, test6, test7].filter(r => r).length;
  const total = 7;

  console.log(`\nTotal: ${passed}/${total} tests passed`);

  process.exit(passed === total ? 0 : 1);
}

// Run tests
runTests().catch((error) => {
  console.error('\nFatal error:', error.message);
  process.exit(1);
});

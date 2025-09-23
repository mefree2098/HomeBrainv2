#!/usr/bin/env node

/**
 * Test script for auto-discovery functionality
 * Tests the discovery API endpoints and simulates device discovery
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000';
let authToken = null;

// Test data
const testDevice = {
  name: 'Test Kitchen Speaker',
  room: 'Kitchen',
  deviceType: 'speaker'
};

async function authenticate() {
  console.log('Authenticating with test user...');

  try {
    // Try to register a test user (may fail if already exists)
    await axios.post(`${BASE_URL}/api/auth/register`, {
      email: 'test@example.com',
      password: 'testpassword123',
      name: 'Test User'
    });
    console.log('Test user registered');
  } catch (error) {
    // User might already exist, continue with login
  }

  // Login to get token
  const loginResponse = await axios.post(`${BASE_URL}/api/auth/login`, {
    email: 'test@example.com',
    password: 'testpassword123'
  });

  authToken = loginResponse.data.accessToken;
  console.log('✅ Authentication successful');
  console.log('');
}

async function testAutoDiscovery() {
  console.log('='.repeat(50));
  console.log('Testing HomeBrain Auto-Discovery System');
  console.log('='.repeat(50));
  console.log('');

  try {
    // Authenticate first
    await authenticate();

    // Set up headers for authenticated requests
    const headers = {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json'
    };

    // Test 1: Check discovery status
    console.log('1. Testing discovery status endpoint...');
    const statusResponse = await axios.get(`${BASE_URL}/api/discovery/status`, { headers });
    console.log('✅ Discovery Status:', JSON.stringify(statusResponse.data, null, 2));
    console.log('');

    // Test 2: Check pending devices
    console.log('2. Testing pending devices endpoint...');
    const pendingResponse = await axios.get(`${BASE_URL}/api/discovery/pending`, { headers });
    console.log('✅ Pending Devices:', JSON.stringify(pendingResponse.data, null, 2));
    console.log('');

    // Test 3: Toggle discovery service
    console.log('3. Testing discovery toggle (disable)...');
    const disableResponse = await axios.post(`${BASE_URL}/api/discovery/toggle`, {
      enabled: false
    }, { headers });
    console.log('✅ Discovery Disabled:', JSON.stringify(disableResponse.data, null, 2));
    console.log('');

    // Test 4: Re-enable discovery service
    console.log('4. Testing discovery toggle (enable)...');
    const enableResponse = await axios.post(`${BASE_URL}/api/discovery/toggle`, {
      enabled: true
    }, { headers });
    console.log('✅ Discovery Enabled:', JSON.stringify(enableResponse.data, null, 2));
    console.log('');

    // Test 5: Check status after toggle
    console.log('5. Checking status after toggle...');
    const finalStatusResponse = await axios.get(`${BASE_URL}/api/discovery/status`, { headers });
    console.log('✅ Final Status:', JSON.stringify(finalStatusResponse.data, null, 2));
    console.log('');

    console.log('🎉 All auto-discovery tests passed!');
    console.log('');
    console.log('Next Steps:');
    console.log('1. Navigate to https://preview-0py18bcb.ui.pythagora.ai/voice-devices');
    console.log('2. Click the "Auto-Discovery" button to see settings');
    console.log('3. Try the manual "Add Remote Device" button for comparison');
    console.log('4. The auto-discovery system is ready for remote devices to connect');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
    process.exit(1);
  }
}

// Run the test
testAutoDiscovery();
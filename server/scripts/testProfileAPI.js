// Test script for user profile API endpoints
const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api';

// Mock authentication token (you would get this from login in real scenario)
const AUTH_TOKEN = 'mock-token-for-testing';

const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Authorization': `Bearer ${AUTH_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

// Test profile data
const testProfile = {
  name: "Test Profile",
  wakeWords: ["Test", "Hey Test"],
  voiceId: "elevenlabs-voice-1",
  voiceName: "Sarah - Friendly Female",
  systemPrompt: "You are a test profile for API testing.",
  personality: "friendly",
  responseStyle: "conversational",
  preferredLanguage: "en-US",
  timezone: "America/New_York",
  speechRate: 1.0,
  speechPitch: 1.0,
  permissions: ["device_control", "scene_control"],
  active: true,
  contextMemory: true,
  learningMode: true,
  privacyMode: false
};

async function testProfileAPI() {
  console.log("🧪 Testing User Profile API endpoints...\n");

  try {
    // Test 1: Get available voices
    console.log("1️⃣ Testing GET /api/profiles/voices");
    try {
      const voicesResponse = await api.get('/profiles/voices');
      console.log("   ✅ Success:", voicesResponse.data.success);
      console.log("   📊 Found", voicesResponse.data.voices?.length || 0, "voices");
      console.log("   🗣️ Sample voices:", voicesResponse.data.voices?.slice(0, 2).map(v => v.name));
    } catch (error) {
      console.log("   ❌ Error:", error.response?.data?.message || error.message);
    }
    console.log("");

    // Test 2: Get all profiles
    console.log("2️⃣ Testing GET /api/profiles");
    try {
      const profilesResponse = await api.get('/profiles');
      console.log("   ✅ Success:", profilesResponse.data.success);
      console.log("   📊 Found", profilesResponse.data.profiles?.length || 0, "profiles");
      console.log("   👤 Profile names:", profilesResponse.data.profiles?.map(p => p.name));
    } catch (error) {
      console.log("   ❌ Error:", error.response?.data?.message || error.message);
    }
    console.log("");

    // Test 3: Create a new profile
    console.log("3️⃣ Testing POST /api/profiles");
    let createdProfile = null;
    try {
      const createResponse = await api.post('/profiles', testProfile);
      console.log("   ✅ Success:", createResponse.data.success);
      console.log("   📝 Created profile:", createResponse.data.profile?.name);
      console.log("   🆔 Profile ID:", createResponse.data.profile?._id);
      createdProfile = createResponse.data.profile;
    } catch (error) {
      console.log("   ❌ Error:", error.response?.data?.message || error.message);
    }
    console.log("");

    // Test 4: Get profile by ID (if we created one)
    if (createdProfile) {
      console.log("4️⃣ Testing GET /api/profiles/:id");
      try {
        const getProfileResponse = await api.get(`/profiles/${createdProfile._id}`);
        console.log("   ✅ Success:", getProfileResponse.data.success);
        console.log("   👤 Retrieved profile:", getProfileResponse.data.profile?.name);
        console.log("   🗣️ Wake words:", getProfileResponse.data.profile?.wakeWords);
      } catch (error) {
        console.log("   ❌ Error:", error.response?.data?.message || error.message);
      }
      console.log("");

      // Test 5: Update profile
      console.log("5️⃣ Testing PUT /api/profiles/:id");
      try {
        const updateData = {
          systemPrompt: "Updated test prompt for API testing",
          personality: "professional"
        };
        const updateResponse = await api.put(`/profiles/${createdProfile._id}`, updateData);
        console.log("   ✅ Success:", updateResponse.data.success);
        console.log("   📝 Updated profile:", updateResponse.data.profile?.name);
        console.log("   🎭 New personality:", updateResponse.data.profile?.personality);
      } catch (error) {
        console.log("   ❌ Error:", error.response?.data?.message || error.message);
      }
      console.log("");

      // Test 6: Toggle profile status
      console.log("6️⃣ Testing PATCH /api/profiles/:id/toggle");
      try {
        const toggleResponse = await api.patch(`/profiles/${createdProfile._id}/toggle`);
        console.log("   ✅ Success:", toggleResponse.data.success);
        console.log("   🔄 New status:", toggleResponse.data.profile?.active ? "Active" : "Inactive");
      } catch (error) {
        console.log("   ❌ Error:", error.response?.data?.message || error.message);
      }
      console.log("");

      // Test 7: Delete profile
      console.log("7️⃣ Testing DELETE /api/profiles/:id");
      try {
        const deleteResponse = await api.delete(`/profiles/${createdProfile._id}`);
        console.log("   ✅ Success:", deleteResponse.data.success);
        console.log("   🗑️ Profile deleted:", deleteResponse.data.message);
      } catch (error) {
        console.log("   ❌ Error:", error.response?.data?.message || error.message);
      }
      console.log("");
    }

    // Test 8: Test wake word lookup
    console.log("8️⃣ Testing GET /api/profiles/wake-word/:wakeWord");
    try {
      const wakeWordResponse = await api.get('/profiles/wake-word/Anna');
      console.log("   ✅ Success:", wakeWordResponse.data.success);
      console.log("   👤 Profiles with 'Anna':", wakeWordResponse.data.profiles?.map(p => p.name));
    } catch (error) {
      console.log("   ❌ Error:", error.response?.data?.message || error.message);
    }
    console.log("");

    console.log("🎉 API testing completed!\n");

  } catch (error) {
    console.error("❌ Unexpected error during testing:", error.message);
  }
}

// Check if server is running first
async function checkServer() {
  try {
    const response = await axios.get('http://localhost:3000/ping');
    console.log("✅ Server is running, response:", response.data);
    return true;
  } catch (error) {
    console.log("❌ Server is not responding:", error.message);
    console.log("💡 Make sure the server is running with 'npm run start'");
    return false;
  }
}

async function main() {
  console.log("🔍 Checking server status...");
  const serverRunning = await checkServer();
  
  if (serverRunning) {
    console.log("");
    await testProfileAPI();
  } else {
    console.log("\n⚠️  Please start the server first and try again.");
  }
}

// Run the tests
main();
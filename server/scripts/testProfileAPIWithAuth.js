// Test script for user profile API endpoints with proper authentication
const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api';

// Create axios instance without auth initially
const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Test user credentials
const testUser = {
  email: 'test@homebrain.local',
  password: 'TestPassword123!'
};

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

async function registerAndLogin() {
  try {
    console.log("👤 Creating test user...");
    
    // Try to register first
    try {
      const registerResponse = await api.post('/auth/register', testUser);
      console.log("   ✅ User registered successfully");
    } catch (error) {
      if (error.response?.status === 400 && error.response?.data?.message?.includes('already exists')) {
        console.log("   ℹ️  User already exists, proceeding with login");
      } else {
        throw error;
      }
    }

    // Login to get token
    console.log("🔑 Logging in...");
    const loginResponse = await api.post('/auth/login', testUser);
    const token = loginResponse.data.accessToken;
    
    if (!token) {
      throw new Error('No access token received from login');
    }

    console.log("   ✅ Login successful, token received");
    
    // Update axios instance with auth token
    api.defaults.headers.Authorization = `Bearer ${token}`;
    
    return token;

  } catch (error) {
    console.error("   ❌ Auth error:", error.response?.data?.message || error.message);
    throw error;
  }
}

async function testProfileAPI() {
  console.log("\n🧪 Testing User Profile API endpoints...\n");

  try {
    // Test 1: Get available voices
    console.log("1️⃣ Testing GET /api/profiles/voices");
    try {
      const voicesResponse = await api.get('/profiles/voices');
      console.log("   ✅ Success:", voicesResponse.data.success);
      console.log("   📊 Found", voicesResponse.data.voices?.length || 0, "voices");
      if (voicesResponse.data.voices?.length > 0) {
        console.log("   🗣️ Sample voices:", voicesResponse.data.voices.slice(0, 2).map(v => v.name));
      }
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
      if (profilesResponse.data.profiles?.length > 0) {
        console.log("   👤 Profile names:", profilesResponse.data.profiles.map(p => p.name));
      }
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
      
      // Check if it's a duplicate name error and try with a unique name
      if (error.response?.data?.message?.includes('already exists')) {
        console.log("   🔄 Trying with unique name...");
        const uniqueProfile = {
          ...testProfile,
          name: `Test Profile ${Date.now()}`
        };
        try {
          const createResponse = await api.post('/profiles', uniqueProfile);
          console.log("   ✅ Success with unique name:", createResponse.data.success);
          console.log("   📝 Created profile:", createResponse.data.profile?.name);
          console.log("   🆔 Profile ID:", createResponse.data.profile?._id);
          createdProfile = createResponse.data.profile;
        } catch (retryError) {
          console.log("   ❌ Retry error:", retryError.response?.data?.message || retryError.message);
        }
      }
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

      // Test 7: Update usage
      console.log("7️⃣ Testing PATCH /api/profiles/:id/usage");
      try {
        const usageResponse = await api.patch(`/profiles/${createdProfile._id}/usage`);
        console.log("   ✅ Success:", usageResponse.data.success);
        console.log("   📊 Usage count:", usageResponse.data.profile?.usageCount);
      } catch (error) {
        console.log("   ❌ Error:", error.response?.data?.message || error.message);
      }
      console.log("");

      // Test 8: Delete profile
      console.log("8️⃣ Testing DELETE /api/profiles/:id");
      try {
        const deleteResponse = await api.delete(`/profiles/${createdProfile._id}`);
        console.log("   ✅ Success:", deleteResponse.data.success);
        console.log("   🗑️ Profile deleted:", deleteResponse.data.message);
      } catch (error) {
        console.log("   ❌ Error:", error.response?.data?.message || error.message);
      }
      console.log("");
    }

    // Test 9: Test wake word lookup
    console.log("9️⃣ Testing GET /api/profiles/wake-word/:wakeWord");
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
  
  if (!serverRunning) {
    console.log("\n⚠️  Please start the server first and try again.");
    return;
  }

  try {
    await registerAndLogin();
    await testProfileAPI();
  } catch (error) {
    console.error("❌ Test failed:", error.message);
  }
}

// Run the tests
main();
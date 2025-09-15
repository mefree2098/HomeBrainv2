// Load environment variables
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/database");
const UserProfile = require("../models/UserProfile");

// Sample user profiles data
const sampleProfiles = [
  {
    name: "Anna",
    wakeWords: ["Anna", "Hey Anna"],
    voiceId: "elevenlabs-voice-1",
    voiceName: "Sarah - Friendly Female",
    systemPrompt: "You are Anna, a helpful and friendly home assistant. You have a warm personality and always try to be encouraging and supportive in your responses.",
    personality: "friendly",
    responseStyle: "conversational",
    preferredLanguage: "en-US",
    timezone: "America/New_York",
    speechRate: 1.0,
    speechPitch: 1.0,
    permissions: ["device_control", "scene_control", "automation_control"],
    active: true,
    contextMemory: true,
    learningMode: true,
    privacyMode: false
  },
  {
    name: "Henry",
    wakeWords: ["Henry", "Hey Henry"],
    voiceId: "elevenlabs-voice-2",
    voiceName: "James - Professional Male",
    systemPrompt: "You are Henry, a professional and efficient home assistant. You provide clear, concise responses and focus on getting tasks done efficiently.",
    personality: "professional",
    responseStyle: "concise",
    preferredLanguage: "en-US",
    timezone: "America/New_York",
    speechRate: 1.1,
    speechPitch: 0.9,
    permissions: ["device_control", "scene_control", "automation_control", "system_settings"],
    active: true,
    contextMemory: true,
    learningMode: true,
    privacyMode: false
  },
  {
    name: "Guest",
    wakeWords: ["Home Brain", "Computer"],
    voiceId: "elevenlabs-voice-3",
    voiceName: "Alex - Neutral Voice",
    systemPrompt: "You are a neutral home assistant for guests. Keep responses helpful but general, without accessing personal information or preferences.",
    personality: "neutral",
    responseStyle: "concise",
    preferredLanguage: "en-US",
    timezone: "America/New_York",
    speechRate: 1.0,
    speechPitch: 1.0,
    permissions: ["device_control"],
    active: false,
    contextMemory: false,
    learningMode: false,
    privacyMode: true
  }
];

async function seedProfiles() {
  try {
    console.log("🌱 Starting user profile seeding process...");
    
    // Connect to database
    await connectDB();
    console.log("✅ Connected to database");

    // Clear existing profiles (optional)
    const existingCount = await UserProfile.countDocuments();
    console.log(`📊 Found ${existingCount} existing profiles`);

    if (existingCount > 0) {
      console.log("⚠️  Profiles already exist. Skipping seeding to avoid duplicates.");
      console.log("💡 If you want to reseed, delete existing profiles first.");
      process.exit(0);
    }

    // Create profiles
    console.log("📝 Creating sample user profiles...");
    
    for (const profileData of sampleProfiles) {
      console.log(`   Creating profile: ${profileData.name}`);
      const profile = new UserProfile(profileData);
      await profile.save();
      console.log(`   ✅ Created profile: ${profile.name} (ID: ${profile._id})`);
    }

    console.log("🎉 Successfully seeded user profiles!");
    console.log(`📊 Created ${sampleProfiles.length} profiles`);

    // Display created profiles
    const profiles = await UserProfile.find().select('name wakeWords voiceId active');
    console.log("\n📋 Created profiles:");
    profiles.forEach(profile => {
      console.log(`   • ${profile.name} (${profile.active ? 'Active' : 'Inactive'})`);
      console.log(`     Wake words: ${profile.wakeWords.join(', ')}`);
      console.log(`     Voice: ${profile.voiceId}`);
      console.log(`     ID: ${profile._id}`);
      console.log("");
    });

    process.exit(0);

  } catch (error) {
    console.error("❌ Error seeding user profiles:", error.message);
    console.error("Full error:", error);
    process.exit(1);
  }
}

// Run the seeding function
seedProfiles();
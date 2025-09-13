const mongoose = require('mongoose');
require('../../models/init');
const UserProfile = require('../../models/UserProfile');
const Device = require('../../models/Device');
const Scene = require('../../models/Scene');
const Automation = require('../../models/Automation');

const createUserProfileSeedData = async () => {
  // Get some device, scene, and automation IDs for favorites
  const devices = await Device.find({}).limit(5).select('_id');
  const scenes = await Scene.find({}).limit(3).select('_id');
  const automations = await Automation.find({}).limit(2).select('_id');
  
  const userProfileSeedData = [
    {
      name: 'Anna',
      wakeWords: ['Anna', 'Hey Anna', 'Assistant Anna'],
      voiceId: 'elevenlabs-voice-1',
      voiceName: 'Sarah - Friendly Female',
      systemPrompt: 'You are Anna, a helpful and friendly home assistant. You speak in a warm, conversational tone and always try to be helpful. You have a good sense of humor and can engage in casual conversation while being efficient with home automation tasks. When users ask about their smart home, provide clear and friendly guidance.',
      personality: 'friendly',
      responseStyle: 'conversational',
      preferredLanguage: 'en-US',
      timezone: 'America/New_York',
      speechRate: 1.0,
      speechPitch: 1.0,
      active: true,
      permissions: ['device_control', 'scene_control', 'automation_control'],
      lastUsed: new Date(Date.now() - 1000 * 60 * 30), // 30 minutes ago
      usageCount: 247,
      favorites: {
        devices: devices.slice(0, 3).map(d => d._id),
        scenes: scenes.slice(0, 2).map(s => s._id),
        automations: automations.slice(0, 1).map(a => a._id)
      },
      contextMemory: true,
      learningMode: true,
      privacyMode: false
    },
    
    {
      name: 'Henry',
      wakeWords: ['Henry', 'Hey Henry', 'Assistant Henry'],
      voiceId: 'elevenlabs-voice-2',
      voiceName: 'James - Professional Male',
      systemPrompt: 'You are Henry, a professional and efficient home assistant. You provide clear, concise responses and focus on getting things done effectively. You speak in a polite but business-like manner, offering detailed information when requested but keeping responses organized and to the point. You excel at managing complex home automation scenarios.',
      personality: 'professional',
      responseStyle: 'detailed',
      preferredLanguage: 'en-US',
      timezone: 'America/New_York',
      speechRate: 1.1, // Slightly faster
      speechPitch: 0.9, // Slightly deeper
      active: true,
      permissions: ['device_control', 'scene_control', 'automation_control', 'system_settings'],
      lastUsed: new Date(Date.now() - 1000 * 60 * 60 * 2), // 2 hours ago
      usageCount: 156,
      favorites: {
        devices: devices.slice(2, 5).map(d => d._id),
        scenes: scenes.slice(1, 3).map(s => s._id),
        automations: automations.slice(0, 2).map(a => a._id)
      },
      contextMemory: true,
      learningMode: true,
      privacyMode: false
    },
    
    {
      name: 'Guest',
      wakeWords: ['Home Brain', 'Computer', 'Assistant'],
      voiceId: 'elevenlabs-voice-3',
      voiceName: 'Alex - Neutral Voice',
      systemPrompt: 'You are a neutral home assistant designed for guests. You provide helpful information about the home automation system but with limited access. You speak in a polite, informative manner without being overly familiar. Focus on basic controls and information while maintaining appropriate boundaries for guest users.',
      personality: 'neutral',
      responseStyle: 'concise',
      preferredLanguage: 'en-US',
      timezone: 'America/New_York',
      speechRate: 1.0,
      speechPitch: 1.0,
      active: false, // Disabled by default
      permissions: ['device_control'], // Limited permissions for guests
      lastUsed: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7), // 1 week ago
      usageCount: 23,
      favorites: {
        devices: [],
        scenes: [],
        automations: []
      },
      contextMemory: false, // No memory for privacy
      learningMode: false, // No learning for guest profile
      privacyMode: true // Enhanced privacy for guests
    },
    
    {
      name: 'Emma',
      wakeWords: ['Emma', 'Hey Emma', 'Assistant Emma'],
      voiceId: 'elevenlabs-voice-4',
      voiceName: 'Emma - Warm Female',
      systemPrompt: 'You are Emma, a warm and caring home assistant with a focus on family life. You speak with a nurturing tone and are particularly good at helping with daily routines, reminders, and creating a comfortable home environment. You have a gentle sense of humor and always prioritize safety and comfort for the family.',
      personality: 'friendly',
      responseStyle: 'conversational',
      preferredLanguage: 'en-US',
      timezone: 'America/New_York',
      speechRate: 0.95, // Slightly slower for clarity
      speechPitch: 1.1, // Slightly higher, warmer tone
      active: true,
      permissions: ['device_control', 'scene_control', 'automation_control'],
      lastUsed: new Date(Date.now() - 1000 * 60 * 60 * 6), // 6 hours ago
      usageCount: 89,
      birthDate: new Date('1985-06-15'), // Optional personal touch
      favorites: {
        devices: devices.slice(0, 2).map(d => d._id),
        scenes: scenes.slice(0, 3).map(s => s._id),
        automations: automations.slice(0, 1).map(a => a._id)
      },
      contextMemory: true,
      learningMode: true,
      privacyMode: false
    },
    
    {
      name: 'David',
      wakeWords: ['David', 'Hey David', 'Assistant David'],
      voiceId: 'elevenlabs-voice-5',
      voiceName: 'David - Deep Male',
      systemPrompt: 'You are David, a tech-savvy home assistant with expertise in advanced automation and system optimization. You speak with confidence and enjoy discussing technical details when appropriate. You can provide both simple explanations for everyday users and detailed technical information for power users. You excel at troubleshooting and system optimization.',
      personality: 'professional',
      responseStyle: 'technical',
      preferredLanguage: 'en-US',
      timezone: 'America/New_York',
      speechRate: 1.0,
      speechPitch: 0.8, // Deeper voice
      active: true,
      permissions: ['device_control', 'scene_control', 'automation_control', 'system_settings', 'user_management'],
      lastUsed: new Date(Date.now() - 1000 * 60 * 45), // 45 minutes ago
      usageCount: 312,
      favorites: {
        devices: devices.map(d => d._id), // All devices
        scenes: scenes.map(s => s._id), // All scenes
        automations: automations.map(a => a._id) // All automations
      },
      contextMemory: true,
      learningMode: true,
      privacyMode: false
    }
  ];
  
  return userProfileSeedData;
};

const seedUserProfiles = async () => {
  try {
    console.log('🌱 Starting user profile seeding...');
    
    // Create user profile data with favorites
    const userProfileSeedData = await createUserProfileSeedData();
    
    // Clear existing user profiles
    const deletedCount = await UserProfile.deleteMany({});
    console.log(`🗑️  Cleared ${deletedCount.deletedCount} existing user profiles`);
    
    // Insert seed data
    const profiles = await UserProfile.insertMany(userProfileSeedData);
    console.log(`✅ Successfully seeded ${profiles.length} user profiles`);
    
    // Log summary by personality and status
    const profilesByPersonality = {};
    const profilesByResponseStyle = {};
    let activeCount = 0;
    let totalUsage = 0;
    
    profiles.forEach(profile => {
      // Count by personality
      if (!profilesByPersonality[profile.personality]) {
        profilesByPersonality[profile.personality] = 0;
      }
      profilesByPersonality[profile.personality]++;
      
      // Count by response style
      if (!profilesByResponseStyle[profile.responseStyle]) {
        profilesByResponseStyle[profile.responseStyle] = 0;
      }
      profilesByResponseStyle[profile.responseStyle]++;
      
      // Count active profiles
      if (profile.active) {
        activeCount++;
      }
      
      // Sum usage
      totalUsage += profile.usageCount;
    });
    
    console.log('📊 Profiles by personality:');
    Object.entries(profilesByPersonality).forEach(([personality, count]) => {
      console.log(`   ${personality}: ${count} profiles`);
    });
    
    console.log('📊 Profiles by response style:');
    Object.entries(profilesByResponseStyle).forEach(([style, count]) => {
      console.log(`   ${style}: ${count} profiles`);
    });
    
    console.log(`📊 Active profiles: ${activeCount}/${profiles.length}`);
    console.log(`📊 Total usage count: ${totalUsage}`);
    
    // Show wake words coverage
    const allWakeWords = new Set();
    profiles.forEach(profile => {
      profile.wakeWords.forEach(word => allWakeWords.add(word.toLowerCase()));
    });
    console.log(`📊 Unique wake words: ${allWakeWords.size}`);
    console.log(`   Wake words: ${Array.from(allWakeWords).join(', ')}`);
    
    // Show most used profile
    const mostUsedProfile = profiles.reduce((prev, current) => 
      (prev.usageCount > current.usageCount) ? prev : current
    );
    console.log(`🏆 Most used profile: ${mostUsedProfile.name} (${mostUsedProfile.usageCount} uses)`);
    
    return profiles;
  } catch (error) {
    console.error('❌ Error seeding user profiles:', error.message);
    console.error(error.stack);
    throw error;
  }
};

// Allow running this script directly
if (require.main === module) {
  const { connectDB } = require('../../config/database');
  
  const runSeeding = async () => {
    try {
      await connectDB();
      await seedUserProfiles();
      console.log('🎉 User profile seeding completed successfully!');
      process.exit(0);
    } catch (error) {
      console.error('💥 User profile seeding failed:', error.message);
      process.exit(1);
    }
  };
  
  runSeeding();
}

module.exports = { seedUserProfiles, createUserProfileSeedData };
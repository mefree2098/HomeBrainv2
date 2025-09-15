#!/usr/bin/env node

require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/database");
const VoiceDevice = require("../models/VoiceDevice");

/**
 * Seed script to add sample voice devices to the database
 * Usage: node scripts/seedVoiceDevices.js
 */

const sampleVoiceDevices = [
  {
    name: "Living Room Voice Hub",
    room: "Living Room",
    deviceType: "hub",
    status: "online",
    brand: "HomeBrain",
    model: "HB-Hub-Pro",
    serialNumber: "HB001",
    wakeWordSupport: true,
    supportedWakeWords: ["Anna", "Henry", "Home Brain"],
    voiceRecognitionEnabled: true,
    volume: 65,
    microphoneSensitivity: 75,
    batteryLevel: null,
    powerSource: "wired",
    connectionType: "wifi",
    ipAddress: "192.168.1.100",
    firmwareVersion: "2.1.4",
    uptime: 2678400, // 31 days
    settings: {
      ledBrightness: 80,
      noiseReduction: true,
      echoSuppression: true
    }
  },
  {
    name: "Kitchen Assistant",
    room: "Kitchen",
    deviceType: "speaker",
    status: "online",
    brand: "HomeBrain",
    model: "HB-Speaker-Mini",
    serialNumber: "HB002",
    wakeWordSupport: true,
    supportedWakeWords: ["Anna", "Henry"],
    voiceRecognitionEnabled: true,
    volume: 50,
    microphoneSensitivity: 60,
    batteryLevel: 85,
    powerSource: "battery",
    connectionType: "wifi",
    ipAddress: "192.168.1.101",
    firmwareVersion: "1.8.2",
    uptime: 518400, // 6 days
    settings: {
      waterResistant: true,
      autoVolume: true
    }
  },
  {
    name: "Bedroom Speaker",
    room: "Bedroom",
    deviceType: "speaker",
    status: "online",
    brand: "HomeBrain",
    model: "HB-Speaker-Compact",
    serialNumber: "HB003",
    wakeWordSupport: true,
    supportedWakeWords: ["Anna"],
    voiceRecognitionEnabled: true,
    volume: 30,
    microphoneSensitivity: 40,
    batteryLevel: 92,
    powerSource: "battery",
    connectionType: "wifi",
    ipAddress: "192.168.1.102",
    firmwareVersion: "1.8.2",
    uptime: 432000, // 5 days
    settings: {
      nightMode: true,
      whispering: true
    }
  },
  {
    name: "Office Hub",
    room: "Office",
    deviceType: "display",
    status: "offline",
    brand: "HomeBrain",
    model: "HB-Display-7",
    serialNumber: "HB004",
    wakeWordSupport: true,
    supportedWakeWords: ["Henry", "Home Brain"],
    voiceRecognitionEnabled: true,
    volume: 55,
    microphoneSensitivity: 70,
    batteryLevel: 15,
    powerSource: "battery",
    connectionType: "wifi",
    ipAddress: "192.168.1.103",
    firmwareVersion: "2.0.1",
    uptime: 0,
    settings: {
      screenTimeout: 300,
      brightness: 70,
      touchEnabled: true
    }
  },
  {
    name: "Garage Monitor",
    room: "Garage",
    deviceType: "microphone",
    status: "online",
    brand: "HomeBrain",
    model: "HB-Mic-Outdoor",
    serialNumber: "HB005",
    wakeWordSupport: true,
    supportedWakeWords: ["Anna", "Henry"],
    voiceRecognitionEnabled: true,
    volume: 70,
    microphoneSensitivity: 85,
    batteryLevel: null,
    powerSource: "wired",
    connectionType: "wifi",
    ipAddress: "192.168.1.104",
    firmwareVersion: "1.6.3",
    uptime: 1209600, // 14 days
    settings: {
      weatherProof: true,
      noiseFiltering: "high",
      motionActivated: true
    }
  }
];

async function seedVoiceDevices() {
  try {
    console.log("🔊 Starting voice device seeding process...");
    
    // Connect to database
    await connectDB();
    console.log("📡 Connected to database");

    // Clear existing voice devices
    const deleteResult = await VoiceDevice.deleteMany({});
    console.log(`🗑️  Cleared ${deleteResult.deletedCount} existing voice devices`);

    // Insert sample voice devices
    const insertedDevices = await VoiceDevice.insertMany(sampleVoiceDevices);
    console.log(`✅ Successfully inserted ${insertedDevices.length} voice devices:`);
    
    insertedDevices.forEach(device => {
      console.log(`   - ${device.name} (${device.room}) - ${device.status}`);
    });

    // Display summary
    console.log("\n📊 Voice Device Summary:");
    const statusCounts = await VoiceDevice.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);
    
    statusCounts.forEach(stat => {
      console.log(`   - ${stat._id}: ${stat.count} devices`);
    });

    const totalDevices = await VoiceDevice.countDocuments();
    console.log(`   - Total: ${totalDevices} devices`);

    console.log("\n🎉 Voice device seeding completed successfully!");
    
  } catch (error) {
    console.error("❌ Error seeding voice devices:", error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Close database connection
    await mongoose.connection.close();
    console.log("📡 Database connection closed");
    process.exit(0);
  }
}

// Run the seeding function
if (require.main === module) {
  seedVoiceDevices();
}

module.exports = { seedVoiceDevices, sampleVoiceDevices };
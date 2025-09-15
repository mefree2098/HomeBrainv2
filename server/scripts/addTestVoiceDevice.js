#!/usr/bin/env node

/**
 * Simple script to add a test voice device using the API
 * This bypasses the seed script database connection issues
 */

const VoiceDevice = require("../models/VoiceDevice");
const mongoose = require('mongoose');

// Use the same connection as the main app
async function addTestDevice() {
  try {
    // Create a single test device if none exist
    const existingDevices = await VoiceDevice.countDocuments();
    
    if (existingDevices > 0) {
      console.log(`Found ${existingDevices} existing voice devices. Skipping creation.`);
      return;
    }

    const testDevice = new VoiceDevice({
      name: "Living Room Voice Hub",
      room: "Living Room", 
      deviceType: "hub",
      status: "online",
      brand: "HomeBrain",
      model: "HB-Hub-Pro",
      serialNumber: "HB001",
      wakeWordSupport: true,
      supportedWakeWords: ["Anna", "Henry"],
      voiceRecognitionEnabled: true,
      volume: 65,
      microphoneSensitivity: 75,
      powerSource: "wired",
      connectionType: "wifi",
      ipAddress: "192.168.1.100",
      firmwareVersion: "2.1.4",
      uptime: 2678400
    });

    await testDevice.save();
    console.log("✅ Test voice device added successfully:", testDevice.name);
    
  } catch (error) {
    console.error("❌ Error adding test voice device:", error.message);
    throw error;
  }
}

module.exports = { addTestDevice };
const mongoose = require('mongoose');
require('../../models/init');
const VoiceDevice = require('../../models/VoiceDevice');

const voiceDeviceSeedData = [
  {
    name: 'Living Room Voice Hub',
    room: 'Living Room',
    deviceType: 'hub',
    status: 'online',
    brand: 'Amazon',
    model: 'Echo Show 10',
    serialNumber: 'ECHO-LR-001',
    wakeWordSupport: true,
    supportedWakeWords: ['Alexa', 'Echo', 'Computer', 'Anna'],
    voiceRecognitionEnabled: true,
    volume: 65,
    microphoneSensitivity: 70,
    powerSource: 'wired',
    connectionType: 'wifi',
    ipAddress: '192.168.1.101',
    lastSeen: new Date(),
    lastInteraction: new Date(Date.now() - 1000 * 60 * 15), // 15 minutes ago
    uptime: 86400 * 7, // 7 days in seconds
    settings: {
      displayBrightness: 75,
      nightMode: true,
      adaptiveBrightness: true,
      showClock: true,
      rotationEnabled: true
    },
    firmwareVersion: '2.0.5',
    lastUpdate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3) // 3 days ago
  },
  
  {
    name: 'Kitchen Assistant',
    room: 'Kitchen',
    deviceType: 'speaker',
    status: 'online',
    brand: 'Google',
    model: 'Nest Audio',
    serialNumber: 'NEST-KT-002',
    wakeWordSupport: true,
    supportedWakeWords: ['Hey Google', 'Ok Google', 'Henry'],
    voiceRecognitionEnabled: true,
    volume: 55,
    microphoneSensitivity: 65,
    batteryLevel: 85,
    powerSource: 'battery',
    connectionType: 'wifi',
    ipAddress: '192.168.1.102',
    lastSeen: new Date(),
    lastInteraction: new Date(Date.now() - 1000 * 60 * 30), // 30 minutes ago
    uptime: 86400 * 5, // 5 days in seconds
    settings: {
      bassBoost: false,
      eqMode: 'balanced',
      lowPowerMode: false,
      touchControls: true
    },
    firmwareVersion: '1.8.2',
    lastUpdate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7) // 1 week ago
  },
  
  {
    name: 'Bedroom Speaker',
    room: 'Bedroom',
    deviceType: 'speaker',
    status: 'online',
    brand: 'Apple',
    model: 'HomePod mini',
    serialNumber: 'HPOD-BR-003',
    wakeWordSupport: true,
    supportedWakeWords: ['Hey Siri', 'Anna'],
    voiceRecognitionEnabled: true,
    volume: 40,
    microphoneSensitivity: 60,
    batteryLevel: 92,
    powerSource: 'battery',
    connectionType: 'wifi',
    ipAddress: '192.168.1.103',
    lastSeen: new Date(),
    lastInteraction: new Date(Date.now() - 1000 * 60 * 45), // 45 minutes ago
    uptime: 86400 * 12, // 12 days in seconds
    settings: {
      adaptiveEQ: true,
      spatialAudio: true,
      nightMode: true,
      touchSurface: true,
      personalRequests: false // Disabled for privacy in bedroom
    },
    firmwareVersion: '15.2.1',
    lastUpdate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2) // 2 days ago
  },
  
  {
    name: 'Office Hub',
    room: 'Office',
    deviceType: 'display',
    status: 'offline',
    brand: 'Amazon',
    model: 'Echo Show 8',
    serialNumber: 'ECHO-OF-004',
    wakeWordSupport: true,
    supportedWakeWords: ['Alexa', 'Echo', 'Computer'],
    voiceRecognitionEnabled: true,
    volume: 50,
    microphoneSensitivity: 55,
    batteryLevel: 15,
    powerSource: 'battery',
    connectionType: 'wifi',
    ipAddress: '192.168.1.104',
    lastSeen: new Date(Date.now() - 1000 * 60 * 60 * 8), // 8 hours ago (offline)
    lastInteraction: new Date(Date.now() - 1000 * 60 * 60 * 10), // 10 hours ago
    uptime: 86400 * 3, // 3 days in seconds
    settings: {
      displayBrightness: 80,
      nightMode: false,
      adaptiveBrightness: false,
      showClock: true,
      videoCallMode: true,
      workSchedule: {
        enabled: true,
        startTime: '09:00',
        endTime: '17:00'
      }
    },
    firmwareVersion: '2.0.3',
    lastUpdate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5) // 5 days ago
  },
  
  {
    name: 'Garage Monitor',
    room: 'Garage',
    deviceType: 'microphone',
    status: 'online',
    brand: 'Ring',
    model: 'Indoor Cam with Mic',
    serialNumber: 'RING-GR-005',
    wakeWordSupport: false, // Security camera with basic voice detection
    supportedWakeWords: [],
    voiceRecognitionEnabled: false,
    volume: 0, // No speaker, microphone only
    microphoneSensitivity: 80,
    powerSource: 'wired',
    connectionType: 'wifi',
    ipAddress: '192.168.1.105',
    lastSeen: new Date(),
    lastInteraction: new Date(Date.now() - 1000 * 60 * 60 * 2), // 2 hours ago
    uptime: 86400 * 30, // 30 days in seconds
    settings: {
      motionDetection: true,
      soundDetection: true,
      nightVision: true,
      recordingEnabled: true,
      privacyMode: false,
      alertSensitivity: 'medium'
    },
    firmwareVersion: '3.1.0',
    lastUpdate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14) // 2 weeks ago
  },
  
  {
    name: 'Bathroom Assistant',
    room: 'Bathroom',
    deviceType: 'speaker',
    status: 'online',
    brand: 'JBL',
    model: 'Link Portable',
    serialNumber: 'JBL-BA-006',
    wakeWordSupport: true,
    supportedWakeWords: ['Hey Google', 'Ok Google'],
    voiceRecognitionEnabled: true,
    volume: 30,
    microphoneSensitivity: 50,
    batteryLevel: 78,
    powerSource: 'both',
    connectionType: 'wifi',
    ipAddress: '192.168.1.106',
    lastSeen: new Date(),
    lastInteraction: new Date(Date.now() - 1000 * 60 * 20), // 20 minutes ago
    uptime: 86400 * 2, // 2 days in seconds
    settings: {
      waterproofMode: true,
      bassBoost: true,
      portableMode: true,
      autoShutoff: 30, // minutes
      privacyMode: true // Enhanced privacy for bathroom
    },
    firmwareVersion: '4.2.1',
    lastUpdate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 1) // 1 day ago
  }
];

const seedVoiceDevices = async () => {
  try {
    console.log('🌱 Starting voice device seeding...');
    
    // Clear existing voice devices
    const deletedCount = await VoiceDevice.deleteMany({});
    console.log(`🗑️  Cleared ${deletedCount.deletedCount} existing voice devices`);
    
    // Insert seed data
    const devices = await VoiceDevice.insertMany(voiceDeviceSeedData);
    console.log(`✅ Successfully seeded ${devices.length} voice devices`);
    
    // Log summary by room, status, and type
    const devicesByRoom = {};
    const devicesByStatus = {};
    const devicesByType = {};
    let batteryDeviceCount = 0;
    
    devices.forEach(device => {
      // Count by room
      if (!devicesByRoom[device.room]) {
        devicesByRoom[device.room] = 0;
      }
      devicesByRoom[device.room]++;
      
      // Count by status
      if (!devicesByStatus[device.status]) {
        devicesByStatus[device.status] = 0;
      }
      devicesByStatus[device.status]++;
      
      // Count by type
      if (!devicesByType[device.deviceType]) {
        devicesByType[device.deviceType] = 0;
      }
      devicesByType[device.deviceType]++;
      
      // Count battery devices
      if (device.batteryLevel !== null && device.batteryLevel !== undefined) {
        batteryDeviceCount++;
      }
    });
    
    console.log('📊 Voice devices by room:');
    Object.entries(devicesByRoom).forEach(([room, count]) => {
      console.log(`   ${room}: ${count} devices`);
    });
    
    console.log('📊 Voice devices by status:');
    Object.entries(devicesByStatus).forEach(([status, count]) => {
      console.log(`   ${status}: ${count} devices`);
    });
    
    console.log('📊 Voice devices by type:');
    Object.entries(devicesByType).forEach(([type, count]) => {
      console.log(`   ${type}: ${count} devices`);
    });
    
    console.log(`📊 Battery-powered devices: ${batteryDeviceCount}/${devices.length}`);
    
    // Check for low battery devices
    const lowBatteryDevices = devices.filter(d => d.batteryLevel && d.batteryLevel < 20);
    if (lowBatteryDevices.length > 0) {
      console.log(`⚠️  Low battery devices: ${lowBatteryDevices.length}`);
      lowBatteryDevices.forEach(device => {
        console.log(`   ${device.name}: ${device.batteryLevel}%`);
      });
    }
    
    return devices;
  } catch (error) {
    console.error('❌ Error seeding voice devices:', error.message);
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
      await seedVoiceDevices();
      console.log('🎉 Voice device seeding completed successfully!');
      process.exit(0);
    } catch (error) {
      console.error('💥 Voice device seeding failed:', error.message);
      process.exit(1);
    }
  };
  
  runSeeding();
}

module.exports = { seedVoiceDevices, voiceDeviceSeedData };
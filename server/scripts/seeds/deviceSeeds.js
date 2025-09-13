// Load environment variables from the server directory
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Override system DATABASE_URL with our MongoDB URL if needed
if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.startsWith('mongodb')) {
  process.env.DATABASE_URL = 'mongodb://localhost/HomeBrain';
}

const mongoose = require('mongoose');
require('../../models/init');
const Device = require('../../models/Device');

const deviceSeedData = [
  // Living Room Devices
  {
    name: 'Living Room Main Light',
    type: 'light',
    room: 'Living Room',
    status: true,
    brightness: 75,
    color: '#ffffff',
    brand: 'Philips',
    model: 'Hue Smart Bulb',
    isOnline: true,
    properties: {
      dimmable: true,
      colorChanging: true,
      wattage: 9.5
    }
  },
  {
    name: 'Living Room Floor Lamp',
    type: 'light',
    room: 'Living Room',
    status: false,
    brightness: 0,
    color: '#ffd700',
    brand: 'IKEA',
    model: 'TRÅDFRI',
    isOnline: true,
    properties: {
      dimmable: true,
      colorChanging: false,
      wattage: 8
    }
  },
  {
    name: 'Living Room Thermostat',
    type: 'thermostat',
    room: 'Living Room',
    status: true,
    temperature: 72,
    targetTemperature: 72,
    brand: 'Nest',
    model: 'Learning Thermostat',
    isOnline: true,
    properties: {
      heatingMode: 'auto',
      coolingMode: 'auto',
      humidity: 45
    }
  },

  // Kitchen Devices
  {
    name: 'Kitchen Ceiling Lights',
    type: 'light',
    room: 'Kitchen',
    status: false,
    brightness: 0,
    color: '#ffffff',
    brand: 'GE',
    model: 'C-Life Smart Bulb',
    isOnline: true,
    properties: {
      dimmable: true,
      colorChanging: false,
      wattage: 12
    }
  },
  {
    name: 'Kitchen Under-Cabinet Lights',
    type: 'light',
    room: 'Kitchen',
    status: false,
    brightness: 0,
    color: '#ffffff',
    brand: 'Govee',
    model: 'LED Strip Light',
    isOnline: true,
    properties: {
      dimmable: true,
      colorChanging: true,
      length: '16ft'
    }
  },

  // Bedroom Devices
  {
    name: 'Bedroom Main Light',
    type: 'light',
    room: 'Bedroom',
    status: true,
    brightness: 50,
    color: '#ffb347',
    brand: 'Philips',
    model: 'Hue Smart Bulb',
    isOnline: true,
    properties: {
      dimmable: true,
      colorChanging: true,
      wattage: 9.5
    }
  },
  {
    name: 'Bedroom Bedside Lamp',
    type: 'light',
    room: 'Bedroom',
    status: false,
    brightness: 0,
    color: '#ff6347',
    brand: 'Xiaomi',
    model: 'Mi Smart Lamp',
    isOnline: true,
    properties: {
      dimmable: true,
      colorChanging: true,
      wattage: 6
    }
  },

  // Security Devices
  {
    name: 'Front Door Lock',
    type: 'lock',
    room: 'Entrance',
    status: true, // true = locked
    brand: 'August',
    model: 'Smart Lock Pro',
    isOnline: true,
    properties: {
      autoLock: true,
      autoUnlock: false,
      batteryLevel: 85
    }
  },
  {
    name: 'Back Door Lock',
    type: 'lock',
    room: 'Back Door',
    status: true, // true = locked
    brand: 'Yale',
    model: 'Assure Lock SL',
    isOnline: true,
    properties: {
      autoLock: true,
      autoUnlock: false,
      batteryLevel: 92
    }
  },
  {
    name: 'Garage Door',
    type: 'garage',
    room: 'Garage',
    status: false, // false = closed
    brand: 'Chamberlain',
    model: 'MyQ Smart Garage',
    isOnline: true,
    properties: {
      autoClose: true,
      closeDelay: 300,
      lightTimeout: 180
    }
  },

  // Additional Devices
  {
    name: 'Porch Light',
    type: 'light',
    room: 'Porch',
    status: false,
    brightness: 0,
    color: '#ffffff',
    brand: 'Ring',
    model: 'Smart Outdoor Light',
    isOnline: true,
    properties: {
      dimmable: true,
      colorChanging: false,
      weatherProof: true,
      wattage: 15
    }
  },
  {
    name: 'Hallway Motion Sensor',
    type: 'sensor',
    room: 'Hallway',
    status: true, // true = active
    brand: 'SmartThings',
    model: 'Motion Sensor',
    isOnline: true,
    properties: {
      motionDetected: false,
      sensitivity: 'medium',
      batteryLevel: 78
    }
  },
  {
    name: 'Office Desk Lamp',
    type: 'light',
    room: 'Office',
    status: false,
    brightness: 0,
    color: '#ffffff',
    brand: 'BenQ',
    model: 'ScreenBar Halo',
    isOnline: true,
    properties: {
      dimmable: true,
      colorTemperature: 4000,
      wattage: 8
    }
  },
  {
    name: 'Bathroom Exhaust Fan',
    type: 'switch',
    room: 'Bathroom',
    status: false,
    brand: 'Leviton',
    model: 'Decora Smart Switch',
    isOnline: true,
    properties: {
      timer: 0,
      maxTimer: 60
    }
  }
];

const seedDevices = async () => {
  try {
    console.log('🌱 Starting device seeding...');
    
    // Clear existing devices
    const deletedCount = await Device.deleteMany({});
    console.log(`🗑️  Cleared ${deletedCount.deletedCount} existing devices`);
    
    // Insert seed data
    const devices = await Device.insertMany(deviceSeedData);
    console.log(`✅ Successfully seeded ${devices.length} devices`);
    
    // Log summary by room and type
    const devicesByRoom = {};
    const devicesByType = {};
    
    devices.forEach(device => {
      // Count by room
      if (!devicesByRoom[device.room]) {
        devicesByRoom[device.room] = 0;
      }
      devicesByRoom[device.room]++;
      
      // Count by type
      if (!devicesByType[device.type]) {
        devicesByType[device.type] = 0;
      }
      devicesByType[device.type]++;
    });
    
    console.log('📊 Devices by room:');
    Object.entries(devicesByRoom).forEach(([room, count]) => {
      console.log(`   ${room}: ${count} devices`);
    });
    
    console.log('📊 Devices by type:');
    Object.entries(devicesByType).forEach(([type, count]) => {
      console.log(`   ${type}: ${count} devices`);
    });
    
    return devices;
  } catch (error) {
    console.error('❌ Error seeding devices:', error.message);
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
      await seedDevices();
      console.log('🎉 Device seeding completed successfully!');
      process.exit(0);
    } catch (error) {
      console.error('💥 Device seeding failed:', error.message);
      process.exit(1);
    }
  };
  
  runSeeding();
}

module.exports = { seedDevices, deviceSeedData };
const mongoose = require('mongoose');
require('../../models/init');
const Scene = require('../../models/Scene');
const Device = require('../../models/Device');

const createSceneSeedData = async () => {
  // Get device IDs for scene actions
  const devices = await Device.find({}).select('_id name type room');
  
  if (devices.length === 0) {
    throw new Error('No devices found. Please seed devices first.');
  }
  
  // Helper function to find device by name
  const findDevice = (name) => devices.find(d => d.name === name);
  
  const sceneSeedData = [
    {
      name: 'Movie Night',
      description: 'Dim lights and create a cozy atmosphere for watching movies',
      category: 'entertainment',
      icon: 'film',
      color: '#8b5cf6',
      isDefault: true,
      deviceActions: [
        {
          deviceId: findDevice('Living Room Main Light')?._id,
          action: 'set_brightness',
          value: 25
        },
        {
          deviceId: findDevice('Living Room Floor Lamp')?._id,
          action: 'turn_on',
          value: 15
        },
        {
          deviceId: findDevice('Kitchen Ceiling Lights')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Living Room Thermostat')?._id,
          action: 'set_temperature',
          value: 70
        }
      ].filter(action => action.deviceId) // Remove actions where device wasn't found
    },
    
    {
      name: 'Good Morning',
      description: 'Turn on lights gradually and adjust temperature for a pleasant wake-up',
      category: 'comfort',
      icon: 'sun',
      color: '#fbbf24',
      isDefault: true,
      deviceActions: [
        {
          deviceId: findDevice('Bedroom Main Light')?._id,
          action: 'set_brightness',
          value: 60
        },
        {
          deviceId: findDevice('Kitchen Ceiling Lights')?._id,
          action: 'turn_on',
          value: 80
        },
        {
          deviceId: findDevice('Living Room Main Light')?._id,
          action: 'turn_on',
          value: 70
        },
        {
          deviceId: findDevice('Living Room Thermostat')?._id,
          action: 'set_temperature',
          value: 72
        }
      ].filter(action => action.deviceId)
    },
    
    {
      name: 'Good Night',
      description: 'Turn off all lights and ensure doors are locked for security',
      category: 'security',
      icon: 'moon',
      color: '#1e293b',
      isDefault: true,
      deviceActions: [
        {
          deviceId: findDevice('Living Room Main Light')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Living Room Floor Lamp')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Kitchen Ceiling Lights')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Kitchen Under-Cabinet Lights')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Bedroom Main Light')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Office Desk Lamp')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Front Door Lock')?._id,
          action: 'lock'
        },
        {
          deviceId: findDevice('Back Door Lock')?._id,
          action: 'lock'
        },
        {
          deviceId: findDevice('Living Room Thermostat')?._id,
          action: 'set_temperature',
          value: 68
        }
      ].filter(action => action.deviceId)
    },
    
    {
      name: 'Away Mode',
      description: 'Security mode when leaving home - lock doors and turn on security lighting',
      category: 'security',
      icon: 'shield',
      color: '#ef4444',
      isDefault: true,
      deviceActions: [
        {
          deviceId: findDevice('Front Door Lock')?._id,
          action: 'lock'
        },
        {
          deviceId: findDevice('Back Door Lock')?._id,
          action: 'lock'
        },
        {
          deviceId: findDevice('Garage Door')?._id,
          action: 'close'
        },
        {
          deviceId: findDevice('Porch Light')?._id,
          action: 'turn_on',
          value: 50
        },
        {
          deviceId: findDevice('Hallway Motion Sensor')?._id,
          action: 'turn_on'
        },
        // Turn off most lights to save energy
        {
          deviceId: findDevice('Living Room Main Light')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Kitchen Ceiling Lights')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Bedroom Main Light')?._id,
          action: 'turn_off'
        }
      ].filter(action => action.deviceId)
    },
    
    {
      name: 'Romantic Dinner',
      description: 'Soft, warm lighting for special occasions and intimate dining',
      category: 'comfort',
      icon: 'heart',
      color: '#ec4899',
      deviceActions: [
        {
          deviceId: findDevice('Living Room Main Light')?._id,
          action: 'set_brightness',
          value: 30
        },
        {
          deviceId: findDevice('Kitchen Ceiling Lights')?._id,
          action: 'set_brightness',
          value: 20
        },
        {
          deviceId: findDevice('Kitchen Under-Cabinet Lights')?._id,
          action: 'turn_on',
          value: 40
        },
        {
          deviceId: findDevice('Living Room Thermostat')?._id,
          action: 'set_temperature',
          value: 72
        }
      ].filter(action => action.deviceId)
    },
    
    {
      name: 'Work Mode',
      description: 'Bright, focused lighting for productivity and concentration',
      category: 'comfort',
      icon: 'briefcase',
      color: '#3b82f6',
      deviceActions: [
        {
          deviceId: findDevice('Office Desk Lamp')?._id,
          action: 'turn_on',
          value: 90
        },
        {
          deviceId: findDevice('Living Room Main Light')?._id,
          action: 'set_brightness',
          value: 80
        },
        {
          deviceId: findDevice('Kitchen Ceiling Lights')?._id,
          action: 'turn_on',
          value: 70
        },
        {
          deviceId: findDevice('Living Room Thermostat')?._id,
          action: 'set_temperature',
          value: 71
        }
      ].filter(action => action.deviceId)
    },
    
    {
      name: 'Energy Saver',
      description: 'Turn off non-essential devices to reduce energy consumption',
      category: 'energy',
      icon: 'leaf',
      color: '#10b981',
      deviceActions: [
        {
          deviceId: findDevice('Living Room Floor Lamp')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Kitchen Under-Cabinet Lights')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Bedroom Bedside Lamp')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Office Desk Lamp')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Porch Light')?._id,
          action: 'turn_off'
        },
        {
          deviceId: findDevice('Living Room Thermostat')?._id,
          action: 'set_temperature',
          value: 69
        }
      ].filter(action => action.deviceId)
    },
    
    {
      name: 'Welcome Home',
      description: 'Automatically activate when arriving home to create a welcoming atmosphere',
      category: 'comfort',
      icon: 'home',
      color: '#f59e0b',
      deviceActions: [
        {
          deviceId: findDevice('Porch Light')?._id,
          action: 'turn_on',
          value: 80
        },
        {
          deviceId: findDevice('Living Room Main Light')?._id,
          action: 'turn_on',
          value: 60
        },
        {
          deviceId: findDevice('Kitchen Ceiling Lights')?._id,
          action: 'turn_on',
          value: 50
        },
        {
          deviceId: findDevice('Front Door Lock')?._id,
          action: 'unlock'
        },
        {
          deviceId: findDevice('Living Room Thermostat')?._id,
          action: 'set_temperature',
          value: 72
        }
      ].filter(action => action.deviceId)
    }
  ];
  
  return sceneSeedData;
};

const seedScenes = async () => {
  try {
    console.log('🌱 Starting scene seeding...');
    
    // Create scene data with device references
    const sceneSeedData = await createSceneSeedData();
    
    // Clear existing scenes
    const deletedCount = await Scene.deleteMany({});
    console.log(`🗑️  Cleared ${deletedCount.deletedCount} existing scenes`);
    
    // Insert seed data
    const scenes = await Scene.insertMany(sceneSeedData);
    console.log(`✅ Successfully seeded ${scenes.length} scenes`);
    
    // Log summary by category
    const scenesByCategory = {};
    scenes.forEach(scene => {
      if (!scenesByCategory[scene.category]) {
        scenesByCategory[scene.category] = 0;
      }
      scenesByCategory[scene.category]++;
    });
    
    console.log('📊 Scenes by category:');
    Object.entries(scenesByCategory).forEach(([category, count]) => {
      console.log(`   ${category}: ${count} scenes`);
    });
    
    console.log('📊 Default scenes:', scenes.filter(s => s.isDefault).length);
    
    return scenes;
  } catch (error) {
    console.error('❌ Error seeding scenes:', error.message);
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
      await seedScenes();
      console.log('🎉 Scene seeding completed successfully!');
      process.exit(0);
    } catch (error) {
      console.error('💥 Scene seeding failed:', error.message);
      process.exit(1);
    }
  };
  
  runSeeding();
}

module.exports = { seedScenes, createSceneSeedData };
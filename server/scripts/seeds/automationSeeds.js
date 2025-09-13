const mongoose = require('mongoose');
require('../../models/init');
const Automation = require('../../models/Automation');
const Device = require('../../models/Device');
const Scene = require('../../models/Scene');

const createAutomationSeedData = async () => {
  // Get device and scene IDs for automation actions
  const devices = await Device.find({}).select('_id name type room');
  const scenes = await Scene.find({}).select('_id name');
  
  if (devices.length === 0) {
    throw new Error('No devices found. Please seed devices first.');
  }
  
  // Helper functions to find resources
  const findDevice = (name) => devices.find(d => d.name === name);
  const findScene = (name) => scenes.find(s => s.name === name);
  
  const automationSeedData = [
    {
      name: 'Morning Routine',
      description: 'Turn on lights and adjust temperature at 7 AM on weekdays',
      category: 'comfort',
      priority: 8,
      trigger: {
        type: 'time',
        conditions: {
          time: '07:00',
          timezone: 'America/New_York',
          repeat: 'weekdays'
        }
      },
      conditions: [
        {
          type: 'day_of_week',
          parameters: {
            days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
          }
        }
      ],
      actions: [
        {
          type: 'scene_activate',
          target: findScene('Good Morning')?._id || 'good_morning_scene',
          parameters: {}
        },
        {
          type: 'device_control',
          target: findDevice('Living Room Thermostat')?._id,
          parameters: {
            action: 'set_temperature',
            value: 72
          }
        }
      ].filter(action => action.target),
      enabled: true,
      cooldown: 60 // 1 hour cooldown
    },
    
    {
      name: 'Evening Security',
      description: 'Lock doors and turn on porch light at sunset',
      category: 'security',
      priority: 9,
      trigger: {
        type: 'schedule',
        conditions: {
          event: 'sunset',
          offset: 0 // At sunset
        }
      },
      actions: [
        {
          type: 'device_control',
          target: findDevice('Front Door Lock')?._id,
          parameters: {
            action: 'lock'
          }
        },
        {
          type: 'device_control',
          target: findDevice('Back Door Lock')?._id,
          parameters: {
            action: 'lock'
          }
        },
        {
          type: 'device_control',
          target: findDevice('Porch Light')?._id,
          parameters: {
            action: 'turn_on',
            brightness: 70
          }
        }
      ].filter(action => action.target),
      enabled: true,
      cooldown: 120 // 2 hours cooldown
    },
    
    {
      name: 'Motion Detection - Hallway',
      description: 'Turn on hallway and nearby lights when motion detected at night',
      category: 'security',
      priority: 7,
      trigger: {
        type: 'sensor',
        conditions: {
          deviceId: findDevice('Hallway Motion Sensor')?._id,
          sensorType: 'motion',
          value: true
        }
      },
      conditions: [
        {
          type: 'time_range',
          parameters: {
            startTime: '20:00',
            endTime: '06:00',
            timezone: 'America/New_York'
          }
        }
      ],
      actions: [
        {
          type: 'device_control',
          target: findDevice('Living Room Main Light')?._id,
          parameters: {
            action: 'turn_on',
            brightness: 30,
            duration: 300 // Auto turn off after 5 minutes
          }
        },
        {
          type: 'device_control',
          target: findDevice('Kitchen Ceiling Lights')?._id,
          parameters: {
            action: 'turn_on',
            brightness: 20,
            duration: 300
          }
        }
      ].filter(action => action.target),
      enabled: true,
      cooldown: 5 // 5 minutes cooldown to prevent rapid triggering
    },
    
    {
      name: 'Energy Saver - Away Mode',
      description: 'Turn off all lights and lower temperature when no one is home for 30 minutes',
      category: 'energy',
      priority: 6,
      trigger: {
        type: 'location',
        conditions: {
          presenceStatus: 'away',
          duration: 1800 // 30 minutes in seconds
        }
      },
      actions: [
        {
          type: 'scene_activate',
          target: findScene('Energy Saver')?._id || 'energy_saver_scene',
          parameters: {}
        },
        {
          type: 'device_control',
          target: findDevice('Living Room Thermostat')?._id,
          parameters: {
            action: 'set_temperature',
            value: 65 // Lower temperature to save energy
          }
        }
      ].filter(action => action.target),
      enabled: false, // Disabled by default until presence detection is set up
      cooldown: 60 // 1 hour cooldown
    },
    
    {
      name: 'Bedtime Routine',
      description: 'Automatically activate good night scene at 11 PM',
      category: 'comfort',
      priority: 7,
      trigger: {
        type: 'time',
        conditions: {
          time: '23:00',
          timezone: 'America/New_York',
          repeat: 'daily'
        }
      },
      actions: [
        {
          type: 'scene_activate',
          target: findScene('Good Night')?._id || 'good_night_scene',
          parameters: {}
        },
        {
          type: 'notification',
          target: 'user',
          parameters: {
            message: 'Good night scene activated. Sleep well!',
            type: 'info'
          }
        }
      ].filter(action => action.target !== null),
      enabled: true,
      cooldown: 480 // 8 hours cooldown
    },
    
    {
      name: 'Garage Door Safety',
      description: 'Auto-close garage door if left open for more than 10 minutes',
      category: 'security',
      priority: 8,
      trigger: {
        type: 'device_state',
        conditions: {
          deviceId: findDevice('Garage Door')?._id,
          property: 'status',
          value: true, // Open
          duration: 600 // 10 minutes
        }
      },
      actions: [
        {
          type: 'device_control',
          target: findDevice('Garage Door')?._id,
          parameters: {
            action: 'close'
          }
        },
        {
          type: 'notification',
          target: 'user',
          parameters: {
            message: 'Garage door has been automatically closed for security.',
            type: 'warning'
          }
        }
      ].filter(action => action.target),
      enabled: true,
      cooldown: 15 // 15 minutes cooldown
    },
    
    {
      name: 'Weather-Based Lighting',
      description: 'Turn on lights during cloudy/rainy weather in daytime',
      category: 'comfort',
      priority: 5,
      trigger: {
        type: 'weather',
        conditions: {
          condition: ['cloudy', 'rainy', 'overcast'],
          lightLevel: 'low',
          timeRange: {
            start: '08:00',
            end: '18:00'
          }
        }
      },
      actions: [
        {
          type: 'device_control',
          target: findDevice('Living Room Main Light')?._id,
          parameters: {
            action: 'turn_on',
            brightness: 50
          }
        },
        {
          type: 'device_control',
          target: findDevice('Kitchen Ceiling Lights')?._id,
          parameters: {
            action: 'turn_on',
            brightness: 60
          }
        }
      ].filter(action => action.target),
      enabled: false, // Disabled by default until weather API is integrated
      cooldown: 120 // 2 hours cooldown
    },
    
    {
      name: 'Welcome Home Automation',
      description: 'Activate welcome scene when first person arrives home',
      category: 'convenience',
      priority: 6,
      trigger: {
        type: 'location',
        conditions: {
          presenceStatus: 'home',
          previousStatus: 'away',
          firstArrival: true
        }
      },
      actions: [
        {
          type: 'scene_activate',
          target: findScene('Welcome Home')?._id || 'welcome_home_scene',
          parameters: {}
        },
        {
          type: 'notification',
          target: 'user',
          parameters: {
            message: 'Welcome home! Your preferred lighting has been activated.',
            type: 'success'
          }
        }
      ].filter(action => action.target !== null),
      enabled: false, // Disabled by default until presence detection is set up
      cooldown: 30 // 30 minutes cooldown
    }
  ];
  
  return automationSeedData;
};

const seedAutomations = async () => {
  try {
    console.log('🌱 Starting automation seeding...');
    
    // Create automation data with device and scene references
    const automationSeedData = await createAutomationSeedData();
    
    // Clear existing automations
    const deletedCount = await Automation.deleteMany({});
    console.log(`🗑️  Cleared ${deletedCount.deletedCount} existing automations`);
    
    // Insert seed data
    const automations = await Automation.insertMany(automationSeedData);
    console.log(`✅ Successfully seeded ${automations.length} automations`);
    
    // Log summary by category and status
    const automationsByCategory = {};
    let enabledCount = 0;
    
    automations.forEach(automation => {
      if (!automationsByCategory[automation.category]) {
        automationsByCategory[automation.category] = 0;
      }
      automationsByCategory[automation.category]++;
      
      if (automation.enabled) {
        enabledCount++;
      }
    });
    
    console.log('📊 Automations by category:');
    Object.entries(automationsByCategory).forEach(([category, count]) => {
      console.log(`   ${category}: ${count} automations`);
    });
    
    console.log(`📊 Enabled automations: ${enabledCount}/${automations.length}`);
    
    // Log trigger types
    const triggerTypes = {};
    automations.forEach(automation => {
      const triggerType = automation.trigger.type;
      if (!triggerTypes[triggerType]) {
        triggerTypes[triggerType] = 0;
      }
      triggerTypes[triggerType]++;
    });
    
    console.log('📊 Trigger types:');
    Object.entries(triggerTypes).forEach(([type, count]) => {
      console.log(`   ${type}: ${count} automations`);
    });
    
    return automations;
  } catch (error) {
    console.error('❌ Error seeding automations:', error.message);
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
      await seedAutomations();
      console.log('🎉 Automation seeding completed successfully!');
      process.exit(0);
    } catch (error) {
      console.error('💥 Automation seeding failed:', error.message);
      process.exit(1);
    }
  };
  
  runSeeding();
}

module.exports = { seedAutomations, createAutomationSeedData };
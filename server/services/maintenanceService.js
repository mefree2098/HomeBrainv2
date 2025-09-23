const Device = require('../models/Device');
const Scene = require('../models/Scene');
const Automation = require('../models/Automation');
const VoiceDevice = require('../models/VoiceDevice');
const UserProfile = require('../models/UserProfile');
const VoiceCommand = require('../models/VoiceCommand');
const SecurityAlarm = require('../models/SecurityAlarm');
const Settings = require('../models/Settings');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const smartThingsService = require('./smartThingsService');
const deviceService = require('./deviceService');

class MaintenanceService {
  constructor() {
    console.log('MaintenanceService: Initialized');
  }

  /**
   * Clear all fake/demo data from the system
   * @returns {Promise<Object>} Result of the operation
   */
  async clearAllFakeData() {
    console.log('MaintenanceService: Starting clearAllFakeData operation');

    const results = {
      devices: 0,
      scenes: 0,
      automations: 0,
      voiceDevices: 0,
      userProfiles: 0,
      voiceCommands: 0,
      securityAlarms: 0
    };

    try {
      // Clear devices
      const deletedDevices = await Device.deleteMany({});
      results.devices = deletedDevices.deletedCount;
      console.log(`MaintenanceService: Cleared ${results.devices} devices`);

      // Clear scenes
      const deletedScenes = await Scene.deleteMany({});
      results.scenes = deletedScenes.deletedCount;
      console.log(`MaintenanceService: Cleared ${results.scenes} scenes`);

      // Clear automations
      const deletedAutomations = await Automation.deleteMany({});
      results.automations = deletedAutomations.deletedCount;
      console.log(`MaintenanceService: Cleared ${results.automations} automations`);

      // Clear voice devices
      const deletedVoiceDevices = await VoiceDevice.deleteMany({});
      results.voiceDevices = deletedVoiceDevices.deletedCount;
      console.log(`MaintenanceService: Cleared ${results.voiceDevices} voice devices`);

      // Clear user profiles
      const deletedProfiles = await UserProfile.deleteMany({});
      results.userProfiles = deletedProfiles.deletedCount;
      console.log(`MaintenanceService: Cleared ${results.userProfiles} user profiles`);

      // Clear voice commands
      const deletedCommands = await VoiceCommand.deleteMany({});
      results.voiceCommands = deletedCommands.deletedCount;
      console.log(`MaintenanceService: Cleared ${results.voiceCommands} voice commands`);

      // Clear security alarms
      const deletedAlarms = await SecurityAlarm.deleteMany({});
      results.securityAlarms = deletedAlarms.deletedCount;
      console.log(`MaintenanceService: Cleared ${results.securityAlarms} security alarms`);

      console.log('MaintenanceService: Successfully cleared all fake data');

      return {
        success: true,
        message: 'All fake data cleared successfully',
        results
      };
    } catch (error) {
      console.error('MaintenanceService: Error clearing fake data:', error.message);
      console.error(error.stack);
      throw new Error('Failed to clear fake data');
    }
  }

  /**
   * Inject fake/demo data into the system
   * @returns {Promise<Object>} Result of the operation
   */
  async injectFakeData() {
    console.log('MaintenanceService: Starting injectFakeData operation');

    const results = {
      devices: 0,
      scenes: 0,
      automations: 0,
      voiceDevices: 0,
      userProfiles: 0
    };

    try {
      // Create fake devices
      const fakeDevices = [
        { name: 'Living Room Main Light', type: 'light', room: 'Living Room', status: true, brightness: 75, isOnline: true },
        { name: 'Living Room Lamp', type: 'light', room: 'Living Room', status: false, brightness: 0, isOnline: true },
        { name: 'Kitchen Lights', type: 'light', room: 'Kitchen', status: true, brightness: 90, isOnline: true },
        { name: 'Front Door Lock', type: 'lock', room: 'Entrance', status: true, isOnline: true },
        { name: 'Back Door Lock', type: 'lock', room: 'Back Door', status: true, isOnline: true },
        { name: 'Main Thermostat', type: 'thermostat', room: 'Living Room', status: true, temperature: 72, targetTemperature: 73, isOnline: true },
        { name: 'Garage Door', type: 'garage', room: 'Garage', status: false, isOnline: true },
        { name: 'Master Bedroom Light', type: 'light', room: 'Master Bedroom', status: false, brightness: 0, isOnline: true },
        { name: 'Guest Bedroom Light', type: 'light', room: 'Guest Bedroom', status: false, brightness: 0, isOnline: true },
        { name: 'Bathroom Light', type: 'light', room: 'Bathroom', status: false, brightness: 0, isOnline: true },
        { name: 'Porch Light', type: 'light', room: 'Outside', status: true, brightness: 80, isOnline: true },
        { name: 'Motion Sensor', type: 'sensor', room: 'Living Room', status: false, isOnline: true },
        { name: 'Window Blinds', type: 'switch', room: 'Living Room', status: false, isOnline: true },
        { name: 'Security Camera', type: 'camera', room: 'Front Door', status: true, isOnline: true }
      ];

      for (const deviceData of fakeDevices) {
        await Device.create(deviceData);
        results.devices++;
      }
      console.log(`MaintenanceService: Created ${results.devices} fake devices`);

      // Create fake scenes
      const fakeScenes = [
        {
          name: 'Good Morning',
          description: 'Turn on lights and adjust temperature for morning routine',
          devices: [],
          isActive: true
        },
        {
          name: 'Movie Night',
          description: 'Dim lights and activate entertainment mode',
          devices: [],
          isActive: true
        },
        {
          name: 'Bedtime',
          description: 'Turn off most lights, lock doors, and set night temperature',
          devices: [],
          isActive: true
        },
        {
          name: 'Away Mode',
          description: 'Turn off all lights, lock doors, and activate security',
          devices: [],
          isActive: true
        },
        {
          name: 'Dinner Time',
          description: 'Set ambient lighting for dining',
          devices: [],
          isActive: true
        },
        {
          name: 'Party Mode',
          description: 'Bright colorful lighting for entertaining',
          devices: [],
          isActive: true
        },
        {
          name: 'Reading Time',
          description: 'Comfortable lighting for reading',
          devices: [],
          isActive: true
        },
        {
          name: 'Romantic',
          description: 'Dim warm lighting for romantic atmosphere',
          devices: [],
          isActive: true
        }
      ];

      for (const sceneData of fakeScenes) {
        await Scene.create(sceneData);
        results.scenes++;
      }
      console.log(`MaintenanceService: Created ${results.scenes} fake scenes`);

      // Create fake automations
      const fakeAutomations = [
        {
          name: 'Sunrise Automation',
          description: 'Gradually turn on lights at sunrise',
          trigger: {
            type: 'time',
            conditions: { time: '07:00', days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] }
          },
          actions: [
            {
              type: 'device_control',
              target: 'living_room_lights',
              parameters: { action: 'turnOn', brightness: 50 }
            }
          ],
          enabled: true,
          category: 'comfort'
        },
        {
          name: 'Sunset Security',
          description: 'Turn on outdoor lights at sunset',
          trigger: {
            type: 'schedule',
            conditions: { event: 'sunset', offset: 0 }
          },
          actions: [
            {
              type: 'device_control',
              target: 'outdoor_lights',
              parameters: { action: 'turnOn', brightness: 100 }
            }
          ],
          enabled: true,
          category: 'security'
        },
        {
          name: 'Motion Detection',
          description: 'Turn on lights when motion is detected',
          trigger: {
            type: 'sensor',
            conditions: { sensor: 'motion_sensor', state: 'active', room: 'living_room' }
          },
          actions: [
            {
              type: 'device_control',
              target: 'room_lights',
              parameters: { action: 'turnOn', brightness: 75 }
            }
          ],
          enabled: true,
          category: 'convenience'
        }
      ];

      for (const automationData of fakeAutomations) {
        await Automation.create(automationData);
        results.automations++;
      }
      console.log(`MaintenanceService: Created ${results.automations} fake automations`);

      // Create fake voice devices
      const fakeVoiceDevices = [
        { name: 'Living Room Voice', room: 'Living Room', isOnline: true, isListening: true, wakeWord: 'Anna' },
        { name: 'Kitchen Voice', room: 'Kitchen', isOnline: true, isListening: true, wakeWord: 'Anna' },
        { name: 'Master Bedroom Voice', room: 'Master Bedroom', isOnline: true, isListening: true, wakeWord: 'Henry' },
        { name: 'Guest Bedroom Voice', room: 'Guest Bedroom', isOnline: false, isListening: false, wakeWord: 'Anna' },
        { name: 'Bathroom Voice', room: 'Bathroom', isOnline: true, isListening: true, wakeWord: 'Anna' },
        { name: 'Garage Voice', room: 'Garage', isOnline: true, isListening: true, wakeWord: 'Henry' }
      ];

      for (const voiceDeviceData of fakeVoiceDevices) {
        await VoiceDevice.create(voiceDeviceData);
        results.voiceDevices++;
      }
      console.log(`MaintenanceService: Created ${results.voiceDevices} fake voice devices`);

      // Create fake user profiles
      const fakeProfiles = [
        {
          name: 'Sarah',
          wakeWords: ['Anna', 'Hey Anna'],
          voiceId: 'Rachel',
          voiceName: 'Rachel',
          systemPrompt: 'You are Anna, a helpful and friendly home assistant.',
          personality: 'friendly',
          responseStyle: 'conversational',
          active: true,
          permissions: ['device_control', 'scene_control', 'automation_control']
        },
        {
          name: 'Mike',
          wakeWords: ['Henry', 'Hey Henry'],
          voiceId: 'Josh',
          voiceName: 'Josh',
          systemPrompt: 'You are Henry, a knowledgeable and efficient home assistant.',
          personality: 'professional',
          responseStyle: 'concise',
          active: true,
          permissions: ['device_control', 'scene_control', 'automation_control', 'system_settings']
        }
      ];

      for (const profileData of fakeProfiles) {
        await UserProfile.create(profileData);
        results.userProfiles++;
      }
      console.log(`MaintenanceService: Created ${results.userProfiles} fake user profiles`);

      console.log('MaintenanceService: Successfully injected fake data');

      return {
        success: true,
        message: 'Fake data injected successfully',
        results
      };
    } catch (error) {
      console.error('MaintenanceService: Error injecting fake data:', error.message);
      console.error(error.stack);
      throw new Error('Failed to inject fake data');
    }
  }

  /**
   * Force re-sync all devices from SmartThings
   * @returns {Promise<Object>} Result of the operation
   */
  async forceSmartThingsSync() {
    console.log('MaintenanceService: Starting SmartThings force sync');

    try {
      const devices = await smartThingsService.getDevices();
      console.log(`MaintenanceService: Successfully synced ${devices.length} SmartThings devices`);

      return {
        success: true,
        message: `Successfully synced ${devices.length} devices from SmartThings`,
        deviceCount: devices.length
      };
    } catch (error) {
      console.error('MaintenanceService: Error during SmartThings sync:', error.message);
      console.error(error.stack);
      throw new Error('Failed to sync SmartThings devices');
    }
  }

  /**
   * Clear all SmartThings devices from local database
   * @returns {Promise<Object>} Result of the operation
   */
  async clearSmartThingsDevices() {
    console.log('MaintenanceService: Starting SmartThings device cleanup');

    try {
      // Note: We don't have a direct way to identify SmartThings devices vs INSTEON
      // This would need to be enhanced with device source tracking
      const result = await Device.deleteMany({
        $or: [
          { brand: { $regex: /smartthings/i } },
          { properties: { source: 'smartthings' } }
        ]
      });

      console.log(`MaintenanceService: Cleared ${result.deletedCount} SmartThings devices`);

      return {
        success: true,
        message: `Successfully cleared ${result.deletedCount} SmartThings devices`,
        deletedCount: result.deletedCount
      };
    } catch (error) {
      console.error('MaintenanceService: Error clearing SmartThings devices:', error.message);
      console.error(error.stack);
      throw new Error('Failed to clear SmartThings devices');
    }
  }

  /**
   * Force re-sync all INSTEON devices
   * @returns {Promise<Object>} Result of the operation
   */
  async forceInsteonSync() {
    console.log('MaintenanceService: Starting INSTEON force sync');

    try {
      // Note: This would need integration with INSTEON service
      // For now, we'll return a placeholder response
      console.log('MaintenanceService: INSTEON sync would be implemented with physical INSTEON controller');

      return {
        success: true,
        message: 'INSTEON sync initiated - would communicate with INSTEON PLM when available',
        deviceCount: 0
      };
    } catch (error) {
      console.error('MaintenanceService: Error during INSTEON sync:', error.message);
      console.error(error.stack);
      throw new Error('Failed to sync INSTEON devices');
    }
  }

  /**
   * Clear all INSTEON devices from local database
   * @returns {Promise<Object>} Result of the operation
   */
  async clearInsteonDevices() {
    console.log('MaintenanceService: Starting INSTEON device cleanup');

    try {
      const result = await Device.deleteMany({
        $or: [
          { brand: { $regex: /insteon/i } },
          { properties: { source: 'insteon' } }
        ]
      });

      console.log(`MaintenanceService: Cleared ${result.deletedCount} INSTEON devices`);

      return {
        success: true,
        message: `Successfully cleared ${result.deletedCount} INSTEON devices`,
        deletedCount: result.deletedCount
      };
    } catch (error) {
      console.error('MaintenanceService: Error clearing INSTEON devices:', error.message);
      console.error(error.stack);
      throw new Error('Failed to clear INSTEON devices');
    }
  }

  /**
   * Reset all settings to default values
   * @returns {Promise<Object>} Result of the operation
   */
  async resetSettingsToDefaults() {
    console.log('MaintenanceService: Resetting settings to defaults');

    try {
      await Settings.deleteMany({});
      console.log('MaintenanceService: All settings cleared, defaults will be used');

      return {
        success: true,
        message: 'Settings reset to defaults successfully'
      };
    } catch (error) {
      console.error('MaintenanceService: Error resetting settings:', error.message);
      console.error(error.stack);
      throw new Error('Failed to reset settings');
    }
  }

  /**
   * Clear SmartThings integration configuration
   * @returns {Promise<Object>} Result of the operation
   */
  async clearSmartThingsIntegration() {
    console.log('MaintenanceService: Clearing SmartThings integration');

    try {
      await smartThingsService.disconnect();
      await SmartThingsIntegration.deleteMany({});

      console.log('MaintenanceService: SmartThings integration cleared');

      return {
        success: true,
        message: 'SmartThings integration cleared successfully'
      };
    } catch (error) {
      console.error('MaintenanceService: Error clearing SmartThings integration:', error.message);
      console.error(error.stack);
      throw new Error('Failed to clear SmartThings integration');
    }
  }

  /**
   * Clear all voice command history
   * @returns {Promise<Object>} Result of the operation
   */
  async clearVoiceCommandHistory() {
    console.log('MaintenanceService: Clearing voice command history');

    try {
      const result = await VoiceCommand.deleteMany({});

      console.log(`MaintenanceService: Cleared ${result.deletedCount} voice commands`);

      return {
        success: true,
        message: `Successfully cleared ${result.deletedCount} voice commands`,
        deletedCount: result.deletedCount
      };
    } catch (error) {
      console.error('MaintenanceService: Error clearing voice commands:', error.message);
      console.error(error.stack);
      throw new Error('Failed to clear voice command history');
    }
  }

  /**
   * Perform system health check
   * @returns {Promise<Object>} System health status
   */
  async performHealthCheck() {
    console.log('MaintenanceService: Performing system health check');

    try {
      const health = {
        database: { connected: true, collections: {} },
        devices: { total: 0, online: 0, offline: 0 },
        integrations: { smartthings: { configured: false, connected: false } },
        voiceSystem: { devices: 0, online: 0, listening: 0 }
      };

      // Check database collections
      health.database.collections.devices = await Device.countDocuments();
      health.database.collections.scenes = await Scene.countDocuments();
      health.database.collections.automations = await Automation.countDocuments();
      health.database.collections.voiceDevices = await VoiceDevice.countDocuments();
      health.database.collections.userProfiles = await UserProfile.countDocuments();

      // Check device statistics
      health.devices.total = await Device.countDocuments();
      health.devices.online = await Device.countDocuments({ isOnline: true });
      health.devices.offline = health.devices.total - health.devices.online;

      // Check SmartThings integration
      try {
        const integration = await SmartThingsIntegration.findOne();
        health.integrations.smartthings.configured = integration ? integration.isConfigured : false;
        health.integrations.smartthings.connected = integration ? integration.isConnected : false;
      } catch (error) {
        console.log('MaintenanceService: SmartThings integration not configured');
      }

      // Check voice system
      health.voiceSystem.devices = await VoiceDevice.countDocuments();
      health.voiceSystem.online = await VoiceDevice.countDocuments({ isOnline: true });
      health.voiceSystem.listening = await VoiceDevice.countDocuments({ isListening: true });

      console.log('MaintenanceService: System health check completed');

      return {
        success: true,
        message: 'System health check completed',
        health
      };
    } catch (error) {
      console.error('MaintenanceService: Error during health check:', error.message);
      console.error(error.stack);
      throw new Error('Failed to perform health check');
    }
  }

  /**
   * Export system configuration
   * @returns {Promise<Object>} Configuration export
   */
  async exportConfiguration() {
    console.log('MaintenanceService: Exporting system configuration');

    try {
      const config = {
        timestamp: new Date().toISOString(),
        settings: await Settings.findOne(),
        devices: await Device.find({}, { _id: 0, createdAt: 0, updatedAt: 0, lastSeen: 0 }),
        scenes: await Scene.find({}, { _id: 0, createdAt: 0, updatedAt: 0 }),
        automations: await Automation.find({}, { _id: 0, createdAt: 0, updatedAt: 0 }),
        voiceDevices: await VoiceDevice.find({}, { _id: 0, createdAt: 0, updatedAt: 0 }),
        userProfiles: await UserProfile.find({}, { _id: 0, createdAt: 0, updatedAt: 0 }),
        smartthingsIntegration: await SmartThingsIntegration.findOne({}, { _id: 0, accessToken: 0, refreshToken: 0, clientSecret: 0 })
      };

      console.log('MaintenanceService: Configuration exported successfully');

      return {
        success: true,
        message: 'Configuration exported successfully',
        config
      };
    } catch (error) {
      console.error('MaintenanceService: Error exporting configuration:', error.message);
      console.error(error.stack);
      throw new Error('Failed to export configuration');
    }
  }
}

module.exports = new MaintenanceService();
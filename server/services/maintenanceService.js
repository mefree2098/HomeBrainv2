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
const harmonyService = require('./harmonyService');

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
      const integrationDoc = await SmartThingsIntegration.getIntegration();
      const devices = await smartThingsService.getDevices();
      console.log(`MaintenanceService: Fetched ${devices.length} SmartThings devices from API`);

      const processedIds = [];
      const locationCounts = new Map();
      let created = 0;
      let updated = 0;
      let skipped = 0;

      for (const device of devices) {
        processedIds.push(device.deviceId);
        if (device.locationId) {
          const currentCount = locationCounts.get(device.locationId) || 0;
          locationCounts.set(device.locationId, currentCount + 1);
        }

        const mappedDevice = await this.mapSmartThingsDevice(device);

        if (!mappedDevice) {
          skipped += 1;
          continue;
        }

        const existing = await Device.findOne({ 'properties.smartThingsDeviceId': device.deviceId });

        if (existing) {
          existing.name = mappedDevice.name;
          existing.type = mappedDevice.type;
          existing.room = mappedDevice.room;
          existing.status = mappedDevice.status;
          existing.brightness = mappedDevice.brightness ?? 0;
          existing.temperature = mappedDevice.temperature;
          existing.targetTemperature = mappedDevice.targetTemperature;
          existing.properties = { ...(existing.properties || {}), ...mappedDevice.properties };
          existing.brand = mappedDevice.brand;
          existing.model = mappedDevice.model;
          existing.isOnline = mappedDevice.isOnline;
          existing.lastSeen = mappedDevice.lastSeen;

          await existing.save();
          updated += 1;
        } else {
          await Device.create(mappedDevice);
          created += 1;
        }
      }

      let removed = 0;
      if (processedIds.length > 0) {
        const removalResult = await Device.deleteMany({
          'properties.source': 'smartthings',
          'properties.smartThingsDeviceId': { $nin: processedIds }
        });
        removed = removalResult.deletedCount || 0;
      }

      // Persist preferred location ID for security operations
      if (integrationDoc && typeof integrationDoc.updateSecurityArmState === 'function' && locationCounts.size > 0) {
        const sortedLocations = [...locationCounts.entries()].sort((a, b) => b[1] - a[1]);
        const mostFrequentLocationId = sortedLocations[0][0];
        try {
          await integrationDoc.updateSecurityArmState({ locationId: mostFrequentLocationId });
        } catch (error) {
          console.warn('MaintenanceService: Unable to persist preferred SmartThings location:', error.message);
        }
      }

      console.log(`MaintenanceService: SmartThings sync summary - created: ${created}, updated: ${updated}, removed: ${removed}, skipped: ${skipped}`);

      return {
        success: true,
        message: `Synced ${devices.length} SmartThings devices (created ${created}, updated ${updated}, removed ${removed}, skipped ${skipped})`,
        deviceCount: devices.length,
        created,
        updated,
        removed,
        skipped
      };
    } catch (error) {
      console.error('MaintenanceService: Error during SmartThings sync:', error.message);
      console.error(error.stack);

      // Handle specific authentication errors more gracefully
      if (error.message.includes('No access token available') || error.message.includes('Please authorize')) {
        return {
          success: false,
          message: 'SmartThings integration is not configured or authorized. Please configure SmartThings in settings first.',
          deviceCount: 0,
          error: 'NOT_CONFIGURED'
        };
      }

      throw new Error('Failed to sync SmartThings devices');
    }
  }

  async mapSmartThingsDevice(device) {
    if (!device?.deviceId) {
      console.warn('MaintenanceService: Skipping SmartThings device with missing deviceId');
      return null;
    }

    const capabilities = this.collectSmartThingsCapabilities(device);
    const type = this.mapSmartThingsType(capabilities, device);

    if (!type) {
      console.warn(`MaintenanceService: Skipping SmartThings device ${device.deviceId} (${device.label || device.name}) with unsupported type`);
      return null;
    }

    const statusRoot = this.extractStatusRoot(device);

    const isOnline = (device.healthState?.state || '').toUpperCase() === 'ONLINE';
    const status = this.mapSmartThingsStatus(type, capabilities, statusRoot, isOnline);
    const brightness = this.mapSmartThingsBrightness(capabilities, statusRoot);
    const temperature = this.mapSmartThingsTemperature(statusRoot);
    const targetTemperature = this.mapSmartThingsTargetTemperature(statusRoot);

    const roomName = await this.resolveSmartThingsRoom(device) || 'SmartThings';
    const brand = device.manufacturerName || device.manufacturer || 'SmartThings';
    const model = device.deviceTypeName || device.presentationId || 'SmartThings Device';
    const categories = this.collectSmartThingsCategories(device);
    const upstreamProvider = this.detectSmartThingsUpstream(device);

    const lastSeen = device.healthState?.lastUpdatedDate ? new Date(device.healthState.lastUpdatedDate) : new Date();

    return {
      name: (device.label || device.name || device.deviceId).trim(),
      type,
      room: roomName,
      status,
      brightness: brightness ?? 0,
      temperature: temperature ?? undefined,
      targetTemperature: targetTemperature ?? undefined,
      properties: {
        ...(device.components ? { componentIds: device.components.map(component => component.id) } : {}),
        source: 'smartthings',
        smartThingsDeviceId: device.deviceId,
        smartThingsDeviceName: device.name || null,
        smartThingsLabel: device.label || null,
        smartThingsLocationId: device.locationId || null,
        smartThingsRoomId: device.roomId || null,
        smartThingsCapabilities: Array.from(capabilities),
        smartThingsCategories: Array.from(categories),
        smartThingsHealthState: device.healthState || null,
        smartThingsPresentationId: device.presentationId || null,
        smartThingsDeviceTypeName: device.deviceTypeName || null,
        smartThingsManufacturer: device.manufacturerName || device.manufacturer || null,
        smartThingsUpstream: upstreamProvider || null,
        isThermostat: type === 'thermostat'
      },
      brand,
      model,
      isOnline,
      lastSeen
    };
  }

  collectSmartThingsCapabilities(device) {
    const capabilities = new Set();

    (device.components || []).forEach((component) => {
      (component.capabilities || []).forEach((capability) => {
        if (capability?.id) {
          capabilities.add(capability.id);
        }
      });
    });

    return capabilities;
  }

  collectSmartThingsCategories(device) {
    const categories = new Set();

    (device.components || []).forEach((component) => {
      (component.categories || []).forEach((category) => {
        if (category?.name) {
          categories.add(category.name.toLowerCase());
        }
      });
    });

    return categories;
  }

  detectSmartThingsUpstream(device) {
    const haystack = [
      device?.manufacturerName,
      device?.manufacturer,
      device?.deviceTypeName,
      device?.presentationId,
      device?.name,
      device?.label
    ]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .toLowerCase();

    if (!haystack) {
      return '';
    }

    if (haystack.includes('ecobee')) {
      return 'ecobee';
    }

    return '';
  }

  mapSmartThingsType(capabilities, device) {
    const categories = this.collectSmartThingsCategories(device);

    if (
      capabilities.has('thermostat') ||
      capabilities.has('thermostatMode') ||
      capabilities.has('thermostatOperatingState') ||
      capabilities.has('thermostatSetpoint') ||
      capabilities.has('thermostatCoolingSetpoint') ||
      capabilities.has('thermostatHeatingSetpoint') ||
      capabilities.has('thermostatFanMode') ||
      categories.has('thermostat')
    ) {
      return 'thermostat';
    }

    if (capabilities.has('lock') || categories.has('lock')) {
      return 'lock';
    }

    if (capabilities.has('garageDoorControl') || capabilities.has('doorControl') || categories.has('garageDoor') || categories.has('garage')) {
      return 'garage';
    }

    if (capabilities.has('switchLevel') || capabilities.has('colorControl') || categories.has('light')) {
      return 'light';
    }

    if (capabilities.has('switch') || categories.has('switch')) {
      return 'switch';
    }

    if (
      capabilities.has('motionSensor') ||
      capabilities.has('contactSensor') ||
      capabilities.has('presenceSensor') ||
      capabilities.has('waterSensor') ||
      capabilities.has('humidityMeasurement') ||
      categories.has('sensor')
    ) {
      return 'sensor';
    }

    if (categories.has('camera')) {
      return 'camera';
    }

    // Default to switch for devices we can likely control
    if (capabilities.size > 0) {
      return 'switch';
    }

    return null;
  }

  extractStatusRoot(device) {
    if (device?.status?.main) {
      return device.status.main;
    }

    if (device?.status?.components?.main) {
      return device.status.components.main;
    }

    return device?.status || {};
  }

  getStatusValue(statusRoot, paths) {
    for (const path of paths) {
      let current = statusRoot;
      let found = true;

      for (const key of path) {
        if (current == null) {
          found = false;
          break;
        }
        current = current[key];
      }

      if (!found || current == null) {
        continue;
      }

      if (typeof current === 'object' && 'value' in current) {
        return current.value;
      }

      return current;
    }

    return undefined;
  }

  mapSmartThingsStatus(type, capabilities, statusRoot, isOnline) {
    const valueFor = (...paths) => this.getStatusValue(statusRoot, paths);

    if (type === 'lock') {
      const state = valueFor(
        ['lock', 'lock', 'value'],
        ['lock', 'lock'],
        ['lock', 'value'],
        ['lock']
      );
      return typeof state === 'string' ? state.toLowerCase() === 'locked' : !!state;
    }

    if (type === 'garage') {
      const state = valueFor(
        ['garageDoorControl', 'door', 'value'],
        ['garageDoorControl', 'door'],
        ['doorControl', 'door', 'value'],
        ['doorControl', 'door']
      );
      return typeof state === 'string' ? ['open', 'opening'].includes(state.toLowerCase()) : !!state;
    }

    if (capabilities.has('switch') || capabilities.has('switchLevel')) {
      const state = valueFor(
        ['switch', 'switch', 'value'],
        ['switch', 'switch'],
        ['switch', 'value'],
        ['switch']
      );
      if (typeof state === 'string') {
        return state.toLowerCase() === 'on';
      }
      if (typeof state === 'boolean') {
        return state;
      }
      return !!state;
    }

    if (capabilities.has('contactSensor')) {
      const state = valueFor(
        ['contactSensor', 'contact', 'value'],
        ['contactSensor', 'contact'],
        ['contactSensor']
      );
      return typeof state === 'string' ? state.toLowerCase() === 'open' : !!state;
    }

    if (capabilities.has('motionSensor')) {
      const state = valueFor(
        ['motionSensor', 'motion', 'value'],
        ['motionSensor', 'motion'],
        ['motionSensor']
      );
      return typeof state === 'string' ? state.toLowerCase() === 'active' : !!state;
    }

    if (type === 'thermostat') {
      const state = valueFor(
        ['thermostatOperatingState', 'operatingState', 'value'],
        ['thermostatOperatingState', 'operatingState'],
        ['thermostatMode', 'thermostatMode', 'value'],
        ['thermostatMode', 'thermostatMode']
      );
      if (typeof state === 'string') {
        return state.toLowerCase() !== 'off' && state.toLowerCase() !== 'idle';
      }
      return !!state;
    }

    // Default to online status when no specific capability matches
    return !!isOnline;
  }

  mapSmartThingsBrightness(capabilities, statusRoot) {
    if (!capabilities.has('switchLevel')) {
      return undefined;
    }

    const value = this.getStatusValue(statusRoot, [
      ['switchLevel', 'level', 'value'],
      ['switchLevel', 'level'],
      ['level']
    ]);

    if (value === undefined || value === null) {
      return undefined;
    }

    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
      return undefined;
    }

    return Math.min(Math.max(Math.round(numeric), 0), 100);
  }

  mapSmartThingsTemperature(statusRoot) {
    const value = this.getStatusValue(statusRoot, [
      ['temperatureMeasurement', 'temperature', 'value'],
      ['temperatureMeasurement', 'temperature'],
      ['temperature']
    ]);

    if (value === undefined || value === null) {
      return undefined;
    }

    const numeric = Number(value);
    return Number.isNaN(numeric) ? undefined : numeric;
  }

  mapSmartThingsTargetTemperature(statusRoot) {
    const heating = this.getStatusValue(statusRoot, [
      ['thermostatHeatingSetpoint', 'heatingSetpoint', 'value'],
      ['thermostatHeatingSetpoint', 'heatingSetpoint']
    ]);

    const cooling = this.getStatusValue(statusRoot, [
      ['thermostatCoolingSetpoint', 'coolingSetpoint', 'value'],
      ['thermostatCoolingSetpoint', 'coolingSetpoint']
    ]);

    const preferred = heating ?? cooling;
    if (preferred === undefined || preferred === null) {
      return undefined;
    }

    const numeric = Number(preferred);
    return Number.isNaN(numeric) ? undefined : numeric;
  }

  async resolveSmartThingsRoom(device) {
    const locationId = device.locationId || null;
    const roomId = device.roomId || null;

    if (!locationId) {
      return null;
    }

    const roomName = await smartThingsService.getRoomName(locationId, roomId);
    if (roomName) {
      return roomName;
    }

    const locationName = await smartThingsService.getLocationName(locationId);
    if (locationName) {
      return locationName;
    }

    if (roomId) {
      return `Room ${roomId.slice(0, 6)}`;
    }

    return null;
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
   * Force re-sync all Harmony activity devices
   * @returns {Promise<Object>} Result of the operation
   */
  async forceHarmonySync() {
    console.log('MaintenanceService: Starting Harmony force sync');

    try {
      const result = await harmonyService.syncDevices({ timeoutMs: 6000 });
      return {
        success: true,
        message: `Harmony sync complete (${result.created} created, ${result.updated} updated, ${result.removed} removed)`,
        ...result
      };
    } catch (error) {
      console.error('MaintenanceService: Error during Harmony sync:', error.message);
      console.error(error.stack);
      throw new Error('Failed to sync Harmony devices');
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
   * Clear all Harmony devices from local database
   * @returns {Promise<Object>} Result of the operation
   */
  async clearHarmonyDevices() {
    console.log('MaintenanceService: Starting Harmony device cleanup');

    try {
      const result = await Device.deleteMany({
        'properties.source': 'harmony'
      });

      console.log(`MaintenanceService: Cleared ${result.deletedCount} Harmony devices`);

      return {
        success: true,
        message: `Successfully cleared ${result.deletedCount} Harmony devices`,
        deletedCount: result.deletedCount
      };
    } catch (error) {
      console.error('MaintenanceService: Error clearing Harmony devices:', error.message);
      console.error(error.stack);
      throw new Error('Failed to clear Harmony devices');
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
        integrations: {
          smartthings: { configured: false, connected: false },
          harmony: { configuredHubs: 0, trackedDevices: 0, onlineDevices: 0 }
        },
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

      try {
        const settings = await Settings.getSettings();
        const configuredHubs = harmonyService.parseConfiguredHubAddresses(settings?.harmonyHubAddresses || '');
        health.integrations.harmony.configuredHubs = configuredHubs.length;
      } catch (error) {
        console.log('MaintenanceService: Unable to read configured Harmony hubs');
      }
      health.integrations.harmony.trackedDevices = await Device.countDocuments({ 'properties.source': 'harmony' });
      health.integrations.harmony.onlineDevices = await Device.countDocuments({
        'properties.source': 'harmony',
        isOnline: true
      });

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

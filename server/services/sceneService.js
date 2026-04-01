const Scene = require('../models/Scene');
const Device = require('../models/Device');
const deviceService = require('./deviceService');

/**
 * Service for managing smart home scenes
 */
class SceneService {
  
  /**
   * Get all scenes from the database
   * @returns {Promise<Array>} Array of scene objects
   */
  async getAllScenes() {
    try {
      console.log('SceneService: Fetching all scenes from database');
      const scenes = await Scene.find()
        .populate('deviceActions.deviceId', 'name type location status')
        .sort({ createdAt: -1 });
      
      console.log(`SceneService: Found ${scenes.length} scenes`);
      return scenes;
    } catch (error) {
      console.error('SceneService: Error fetching scenes:', error);
      throw new Error(`Failed to fetch scenes: ${error.message}`);
    }
  }

  /**
   * Get a single scene by ID
   * @param {string} sceneId - The scene ID
   * @returns {Promise<Object>} Scene object
   */
  async getSceneById(sceneId) {
    try {
      console.log(`SceneService: Fetching scene with ID: ${sceneId}`);
      const scene = await Scene.findById(sceneId)
        .populate('deviceActions.deviceId', 'name type location status');
      
      if (!scene) {
        throw new Error('Scene not found');
      }
      
      console.log(`SceneService: Found scene: ${scene.name}`);
      return scene;
    } catch (error) {
      console.error(`SceneService: Error fetching scene ${sceneId}:`, error);
      throw new Error(`Failed to fetch scene: ${error.message}`);
    }
  }

  /**
   * Create a new scene
   * @param {Object} sceneData - Scene data
   * @param {string} sceneData.name - Scene name
   * @param {string} sceneData.description - Scene description
   * @param {Array} sceneData.devices - Array of device IDs (backward compatibility)
   * @param {Array} sceneData.deviceActions - Array of device actions
   * @param {string} sceneData.category - Scene category
   * @param {string} sceneData.icon - Scene icon
   * @param {string} sceneData.color - Scene color
   * @returns {Promise<Object>} Created scene object
   */
  async createScene(sceneData) {
    try {
      console.log('SceneService: Creating new scene:', sceneData.name);
      
      // Validate required fields
      if (!sceneData.name) {
        throw new Error('Scene name is required');
      }

      // Handle backward compatibility: convert devices array to deviceActions
      let deviceActions = sceneData.deviceActions || [];
      if (sceneData.devices && Array.isArray(sceneData.devices)) {
        console.log('SceneService: Converting devices array to deviceActions for backward compatibility');
        
        // Validate that all device IDs exist
        const existingDevices = await Device.find({ _id: { $in: sceneData.devices } });
        if (existingDevices.length !== sceneData.devices.length) {
          throw new Error('One or more devices not found');
        }

        // Convert to deviceActions with default actions
        deviceActions = sceneData.devices.map(deviceId => ({
          deviceId,
          action: 'turn_on', // Default action for backward compatibility
          value: null
        }));
      }

      // Validate device actions if provided
      if (deviceActions.length > 0) {
        for (const action of deviceActions) {
          if (!action.deviceId || !action.action) {
            throw new Error('Each device action must have deviceId and action');
          }
          
          // Verify device exists
          const device = await Device.findById(action.deviceId);
          if (!device) {
            throw new Error(`Device with ID ${action.deviceId} not found`);
          }
        }
      }

      const newScene = new Scene({
        name: sceneData.name.trim(),
        description: sceneData.description ? sceneData.description.trim() : '',
        deviceActions,
        category: sceneData.category || 'custom',
        icon: sceneData.icon || 'home',
        color: sceneData.color || '#3b82f6',
        active: false,
        activationCount: 0
      });

      const savedScene = await newScene.save();
      console.log(`SceneService: Scene created successfully with ID: ${savedScene._id}`);
      
      // Populate device information before returning
      await savedScene.populate('deviceActions.deviceId', 'name type location status');
      
      return savedScene;
    } catch (error) {
      console.error('SceneService: Error creating scene:', error);
      throw new Error(`Failed to create scene: ${error.message}`);
    }
  }

  /**
   * Activate a scene - sets it as active and deactivates others
   * @param {string} sceneId - The scene ID to activate
   * @returns {Promise<Object>} Updated scene object and activation results
   */
  async activateScene(sceneId) {
    try {
      console.log(`SceneService: Activating scene with ID: ${sceneId}`);
      
      // First, deactivate all other scenes
      await Scene.updateMany({}, { active: false });
      console.log('SceneService: Deactivated all existing scenes');

      // Find and activate the requested scene
      const scene = await Scene.findById(sceneId);
      if (!scene) {
        throw new Error('Scene not found');
      }

      // Update scene status
      scene.active = true;
      scene.activationCount = (scene.activationCount || 0) + 1;
      scene.lastActivated = new Date();

      const updatedScene = await scene.save();
      console.log(`SceneService: Scene "${scene.name}" activated successfully`);

      // Populate device information
      await updatedScene.populate('deviceActions.deviceId', 'name type location status');

      // Execute device actions through the existing device control service so scenes and Alexa share the same behavior.
      const deviceActions = [];
      for (const action of updatedScene.deviceActions) {
        try {
          console.log(`SceneService: Executing action ${action.action} on device ${action.deviceId.name}`);
          const controlledDevice = await deviceService.controlDevice(
            action.deviceId._id.toString(),
            action.action,
            action.value
          );
          deviceActions.push({
            deviceId: action.deviceId._id,
            deviceName: controlledDevice?.name || action.deviceId.name,
            action: action.action,
            value: action.value,
            status: 'executed'
          });
        } catch (actionError) {
          console.error(`SceneService: Failed to execute action on device ${action.deviceId.name}:`, actionError);
          deviceActions.push({
            deviceId: action.deviceId._id,
            deviceName: action.deviceId.name,
            action: action.action,
            value: action.value,
            status: 'failed',
            error: actionError.message
          });
        }
      }

      return {
        scene: updatedScene,
        deviceActions,
        message: `Scene "${scene.name}" activated successfully`
      };
    } catch (error) {
      console.error(`SceneService: Error activating scene ${sceneId}:`, error);
      throw new Error(`Failed to activate scene: ${error.message}`);
    }
  }

  /**
   * Update an existing scene
   * @param {string} sceneId - The scene ID
   * @param {Object} updateData - Data to update
   * @returns {Promise<Object>} Updated scene object
   */
  async updateScene(sceneId, updateData) {
    try {
      console.log(`SceneService: Updating scene with ID: ${sceneId}`);
      
      const scene = await Scene.findById(sceneId);
      if (!scene) {
        throw new Error('Scene not found');
      }

      // Handle device actions validation if provided
      if (updateData.deviceActions) {
        for (const action of updateData.deviceActions) {
          if (action.deviceId) {
            const device = await Device.findById(action.deviceId);
            if (!device) {
              throw new Error(`Device with ID ${action.deviceId} not found`);
            }
          }
        }
      }

      // Update fields
      const allowedUpdates = ['name', 'description', 'deviceActions', 'category', 'icon', 'color'];
      for (const field of allowedUpdates) {
        if (updateData[field] !== undefined) {
          scene[field] = updateData[field];
        }
      }

      const updatedScene = await scene.save();
      console.log(`SceneService: Scene "${scene.name}" updated successfully`);
      
      // Populate device information
      await updatedScene.populate('deviceActions.deviceId', 'name type location status');
      
      return updatedScene;
    } catch (error) {
      console.error(`SceneService: Error updating scene ${sceneId}:`, error);
      throw new Error(`Failed to update scene: ${error.message}`);
    }
  }

  /**
   * Delete a scene
   * @param {string} sceneId - The scene ID
   * @returns {Promise<Object>} Deletion result
   */
  async deleteScene(sceneId) {
    try {
      console.log(`SceneService: Deleting scene with ID: ${sceneId}`);
      
      const scene = await Scene.findById(sceneId);
      if (!scene) {
        throw new Error('Scene not found');
      }

      const sceneName = scene.name;
      await Scene.findByIdAndDelete(sceneId);
      
      console.log(`SceneService: Scene "${sceneName}" deleted successfully`);
      
      return {
        message: `Scene "${sceneName}" deleted successfully`,
        deletedScene: { _id: sceneId, name: sceneName }
      };
    } catch (error) {
      console.error(`SceneService: Error deleting scene ${sceneId}:`, error);
      throw new Error(`Failed to delete scene: ${error.message}`);
    }
  }

  /**
   * Get scene statistics
   * @returns {Promise<Object>} Scene statistics
   */
  async getSceneStats() {
    try {
      console.log('SceneService: Calculating scene statistics');

      const totalScenes = await Scene.countDocuments();
      const activeScenes = await Scene.countDocuments({ active: true });
      const scenesByCategory = await Scene.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } }
      ]);

      const stats = {
        totalScenes,
        activeScenes,
        inactiveScenes: totalScenes - activeScenes,
        scenesByCategory: scenesByCategory.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {})
      };

      console.log('SceneService: Scene statistics calculated:', stats);
      return stats;
    } catch (error) {
      console.error('SceneService: Error calculating scene statistics:', error);
      throw new Error(`Failed to get scene statistics: ${error.message}`);
    }
  }

  /**
   * Create scene from natural language description
   * @param {string} description - Natural language description of the scene
   * @returns {Promise<Object>} Created scene object
   */
  async createSceneFromNaturalLanguage(description) {
    try {
      console.log('SceneService: Creating scene from natural language:', description);

      if (!description || description.trim() === '') {
        throw new Error('Scene description is required');
      }

      // Import LLM service
      const { sendLLMRequestWithFallback } = require('./llmService');

      // Build device context
      const devices = await Device.find({ isOnline: true }).lean();
      const devicesByRoom = {};

      devices.forEach(device => {
        if (!devicesByRoom[device.room]) {
          devicesByRoom[device.room] = [];
        }

        devicesByRoom[device.room].push({
          id: device._id.toString(),
          name: device.name,
          type: device.type,
          capabilities: this._getDeviceCapabilities(device.type)
        });
      });

      const deviceList = Object.entries(devicesByRoom).map(([room, devices]) => {
        return `Room: ${room}\n${devices.map(d =>
          `  - ${d.name} (ID: ${d.id}, Type: ${d.type}, Actions: ${d.capabilities.join(', ')})`
        ).join('\n')}`;
      }).join('\n\n');

      // Build LLM prompt
      const prompt = `You are an expert at creating smart home scenes. Parse the following scene description into a structured JSON format.

IMPORTANT RULES:
1. ONLY use device IDs from the provided device list below
2. DO NOT make up or invent device names or IDs
3. Use actual device IDs from the list
4. Match device capabilities to allowed actions for each device type
5. Return ONLY valid JSON with NO additional text or explanation

AVAILABLE DEVICES:
${deviceList}

REQUIRED JSON STRUCTURE:
{
  "name": "Brief scene name (max 50 chars)",
  "description": "Detailed description of what this scene does",
  "deviceActions": [
    {
      "deviceId": "EXACT_DEVICE_ID_FROM_LIST_ABOVE",
      "action": "turn_on|turn_off|set_brightness|set_temperature|lock|unlock|open|close",
      "value": 0-100 or temperature number or null
    }
  ],
  "category": "entertainment|security|comfort|energy|custom",
  "icon": "home|moon|sun|shield|heart|star|settings",
  "color": "#hexcolor"
}

DEVICE ACTION COMPATIBILITY:
- light: turn_on, turn_off, set_brightness (value: 0-100), set_color (value: #hex)
- thermostat: turn_on, turn_off, set_temperature (value: degrees)
- lock: lock, unlock
- switch: turn_on, turn_off
- garage: open, close
- sensor: (read-only, cannot be controlled)

USER REQUEST: "${description}"

Return ONLY the JSON object, nothing else:`;

      let parsedScene = null;
      let lastError = null;
      const MAX_RETRIES = 3;

      // Try up to MAX_RETRIES times
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`SceneService: LLM attempt ${attempt}/${MAX_RETRIES}`);

        try {
          // Send request to LLM with automatic fallback based on priority
          console.log('SceneService: Sending request to LLM with fallback');
          const llmResponse = await sendLLMRequestWithFallback(prompt);
          console.log('SceneService: LLM response received');
          console.log('SceneService: LLM Response Preview:', llmResponse.substring(0, 500));

          // Parse LLM response
          const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            lastError = 'No valid JSON found in LLM response';
            console.error('SceneService:', lastError);
            console.error('SceneService: Full LLM Response:', llmResponse);
            continue;
          }

          parsedScene = JSON.parse(jsonMatch[0]);

          // Validate scene structure
          if (!parsedScene.name) {
            throw new Error('Scene name is required');
          }

          if (!parsedScene.deviceActions || !Array.isArray(parsedScene.deviceActions)) {
            throw new Error('Device actions are required');
          }

          // Validate device references
          for (const action of parsedScene.deviceActions) {
            if (!action.deviceId) {
              throw new Error('Device ID is required for each action');
            }

            const device = await Device.findById(action.deviceId);
            if (!device) {
              throw new Error(`Device with ID ${action.deviceId} not found`);
            }
          }

          console.log('SceneService: Scene structure validated successfully');
          break; // Success!

        } catch (parseError) {
          lastError = `Parse error: ${parseError.message}`;
          console.error('SceneService:', lastError);
        }
      }

      // If we exhausted all retries, throw error
      if (!parsedScene) {
        throw new Error(`Failed to create valid scene after ${MAX_RETRIES} attempts. Last error: ${lastError}`);
      }

      // Create the scene using validated data
      const sceneData = {
        name: parsedScene.name,
        description: parsedScene.description || description.trim(),
        deviceActions: parsedScene.deviceActions,
        category: parsedScene.category || 'custom',
        icon: parsedScene.icon || 'home',
        color: parsedScene.color || '#3b82f6'
      };

      const newScene = await this.createScene(sceneData);

      console.log('SceneService: Scene created from natural language successfully');
      return {
        success: true,
        scene: newScene,
        message: 'Scene created successfully from natural language'
      };

    } catch (error) {
      console.error('SceneService: Error creating scene from natural language:', error);
      throw new Error(`Failed to create scene from natural language: ${error.message}`);
    }
  }

  /**
   * Get device capabilities based on device type
   * @param {string} deviceType - The device type
   * @returns {Array<string>} Array of capability strings
   * @private
   */
  _getDeviceCapabilities(deviceType) {
    switch (deviceType) {
      case 'light':
        return ['turn_on', 'turn_off', 'set_brightness', 'set_color'];
      case 'thermostat':
        return ['turn_on', 'turn_off', 'set_temperature'];
      case 'lock':
        return ['lock', 'unlock'];
      case 'switch':
        return ['turn_on', 'turn_off'];
      case 'garage':
        return ['open', 'close'];
      default:
        return ['turn_on', 'turn_off'];
    }
  }
}

module.exports = new SceneService();

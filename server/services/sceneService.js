const Scene = require('../models/Scene');
const Device = require('../models/Device');

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

      // Execute device actions (simulate for now - in real implementation this would control actual devices)
      const deviceActions = [];
      for (const action of updatedScene.deviceActions) {
        try {
          console.log(`SceneService: Executing action ${action.action} on device ${action.deviceId.name}`);
          // In a real implementation, this would call device control APIs
          deviceActions.push({
            deviceId: action.deviceId._id,
            deviceName: action.deviceId.name,
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
}

module.exports = new SceneService();
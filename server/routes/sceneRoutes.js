const express = require('express');
const router = express.Router();
const sceneService = require('../services/sceneService');

/**
 * GET /api/scenes
 * Get all scenes
 */
router.get('/', async (req, res) => {
  try {
    console.log('SceneRoutes: GET /api/scenes - Fetching all scenes');
    
    const scenes = await sceneService.getAllScenes();
    
    console.log(`SceneRoutes: Successfully retrieved ${scenes.length} scenes`);
    res.status(200).json({
      success: true,
      scenes: scenes,
      count: scenes.length
    });
  } catch (error) {
    console.error('SceneRoutes: Error fetching scenes:', error.message);
    console.error('SceneRoutes: Full error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch scenes'
    });
  }
});

/**
 * GET /api/scenes/stats
 * Get scene statistics
 */
router.get('/stats', async (req, res) => {
  try {
    console.log('SceneRoutes: GET /api/scenes/stats - Fetching scene statistics');
    
    const stats = await sceneService.getSceneStats();
    
    console.log('SceneRoutes: Successfully retrieved scene statistics');
    res.status(200).json({
      success: true,
      stats: stats
    });
  } catch (error) {
    console.error('SceneRoutes: Error fetching scene statistics:', error.message);
    console.error('SceneRoutes: Full error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch scene statistics'
    });
  }
});

/**
 * GET /api/scenes/:id
 * Get a single scene by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`SceneRoutes: GET /api/scenes/${id} - Fetching single scene`);
    
    if (!id || id === 'undefined') {
      return res.status(400).json({
        success: false,
        error: 'Scene ID is required'
      });
    }
    
    const scene = await sceneService.getSceneById(id);
    
    console.log(`SceneRoutes: Successfully retrieved scene: ${scene.name}`);
    res.status(200).json({
      success: true,
      scene: scene
    });
  } catch (error) {
    console.error(`SceneRoutes: Error fetching scene ${req.params.id}:`, error.message);
    console.error('SceneRoutes: Full error:', error);
    
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to fetch scene'
      });
    }
  }
});

/**
 * POST /api/scenes
 * Create a new scene
 */
router.post('/', async (req, res) => {
  try {
    console.log('SceneRoutes: POST /api/scenes - Creating new scene');
    console.log('SceneRoutes: Scene data received:', req.body);
    
    const { name, description, devices, deviceActions, category, icon, color } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Scene name is required'
      });
    }
    
    const sceneData = {
      name: name.trim(),
      description: description ? description.trim() : '',
      devices: devices || [],
      deviceActions: deviceActions || [],
      category: category || 'custom',
      icon: icon || 'home',
      color: color || '#3b82f6'
    };
    
    const newScene = await sceneService.createScene(sceneData);
    
    console.log(`SceneRoutes: Scene created successfully with ID: ${newScene._id}`);
    res.status(201).json({
      success: true,
      message: 'Scene created successfully',
      scene: newScene
    });
  } catch (error) {
    console.error('SceneRoutes: Error creating scene:', error.message);
    console.error('SceneRoutes: Full error:', error);
    
    if (error.message.includes('required') || error.message.includes('not found')) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to create scene'
      });
    }
  }
});

/**
 * POST /api/scenes/activate
 * Activate a scene
 */
router.post('/activate', async (req, res) => {
  try {
    console.log('SceneRoutes: POST /api/scenes/activate - Activating scene');
    console.log('SceneRoutes: Activation data received:', req.body);
    
    const { sceneId } = req.body;
    
    if (!sceneId) {
      return res.status(400).json({
        success: false,
        error: 'Scene ID is required'
      });
    }
    
    const result = await sceneService.activateScene(sceneId);
    
    console.log(`SceneRoutes: Scene activated successfully: ${result.scene.name}`);
    res.status(200).json({
      success: true,
      message: result.message,
      scene: result.scene,
      deviceActions: result.deviceActions
    });
  } catch (error) {
    console.error('SceneRoutes: Error activating scene:', error.message);
    console.error('SceneRoutes: Full error:', error);
    
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else if (error.message.includes('required')) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to activate scene'
      });
    }
  }
});

/**
 * PUT /api/scenes/:id
 * Update an existing scene
 */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`SceneRoutes: PUT /api/scenes/${id} - Updating scene`);
    console.log('SceneRoutes: Update data received:', req.body);
    
    if (!id || id === 'undefined') {
      return res.status(400).json({
        success: false,
        error: 'Scene ID is required'
      });
    }
    
    const updateData = req.body;
    
    // Validate name if provided
    if (updateData.name && updateData.name.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Scene name cannot be empty'
      });
    }
    
    const updatedScene = await sceneService.updateScene(id, updateData);
    
    console.log(`SceneRoutes: Scene updated successfully: ${updatedScene.name}`);
    res.status(200).json({
      success: true,
      message: 'Scene updated successfully',
      scene: updatedScene
    });
  } catch (error) {
    console.error(`SceneRoutes: Error updating scene ${req.params.id}:`, error.message);
    console.error('SceneRoutes: Full error:', error);
    
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else if (error.message.includes('required') || error.message.includes('cannot be empty')) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to update scene'
      });
    }
  }
});

/**
 * DELETE /api/scenes/:id
 * Delete a scene
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`SceneRoutes: DELETE /api/scenes/${id} - Deleting scene`);
    
    if (!id || id === 'undefined') {
      return res.status(400).json({
        success: false,
        error: 'Scene ID is required'
      });
    }
    
    const result = await sceneService.deleteScene(id);
    
    console.log(`SceneRoutes: Scene deleted successfully: ${result.deletedScene.name}`);
    res.status(200).json({
      success: true,
      message: result.message,
      deletedScene: result.deletedScene
    });
  } catch (error) {
    console.error(`SceneRoutes: Error deleting scene ${req.params.id}:`, error.message);
    console.error('SceneRoutes: Full error:', error);
    
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to delete scene'
      });
    }
  }
});

module.exports = router;
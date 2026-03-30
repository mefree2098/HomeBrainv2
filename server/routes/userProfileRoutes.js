const express = require('express');
const router = express.Router();
const userProfileService = require('../services/userProfileService');
const elevenLabsService = require('../services/elevenLabsService');
const { requireUser, requireAdmin } = require('./middlewares/auth');

// Create auth middleware instance
const auth = requireUser();
const admin = requireAdmin();

/**
 * GET /api/profiles
 * Get all user profiles
 */
router.get('/', auth, async (req, res) => {
  try {
    console.log('GET /api/profiles - Fetching all user profiles');
    
    const { active, name } = req.query;
    const filters = {};
    
    if (active !== undefined) {
      filters.active = active === 'true';
    }
    
    if (name) {
      filters.name = name;
    }

    const profiles = await userProfileService.getAllProfiles(filters);
    
    console.log(`Returning ${profiles.length} user profiles`);
    res.status(200).json({
      success: true,
      profiles: profiles
    });

  } catch (error) {
    console.error('Error in GET /api/profiles:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user profiles',
      error: error.message
    });
  }
});

/**
 * GET /api/profiles/voices
 * Get available ElevenLabs voices
 */
router.get('/voices', auth, async (req, res) => {
  try {
    console.log('GET /api/profiles/voices - Fetching available voices');
    
    const voices = await elevenLabsService.getVoices();
    
    console.log(`Returning ${voices.length} available voices`);
    res.status(200).json({
      success: true,
      voices: voices
    });

  } catch (error) {
    console.error('Error in GET /api/profiles/voices:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch available voices',
      error: error.message
    });
  }
});

/**
 * GET /api/profiles/voices/:voiceId
 * Get voice details by ID
 */
router.get('/voices/:voiceId', auth, async (req, res) => {
  try {
    console.log(`GET /api/profiles/voices/${req.params.voiceId} - Fetching voice details`);
    
    const voice = await elevenLabsService.getVoiceById(req.params.voiceId);
    
    if (!voice) {
      console.log(`Voice not found: ${req.params.voiceId}`);
      return res.status(404).json({
        success: false,
        message: 'Voice not found'
      });
    }

    console.log(`Returning voice details: ${voice.name}`);
    res.status(200).json({
      success: true,
      voice: voice
    });

  } catch (error) {
    console.error(`Error in GET /api/profiles/voices/${req.params.voiceId}:`, error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch voice details',
      error: error.message
    });
  }
});

/**
 * GET /api/profiles/wake-word/:wakeWord
 * Get profiles by wake word
 */
router.get('/wake-word/:wakeWord', auth, async (req, res) => {
  try {
    console.log(`GET /api/profiles/wake-word/${req.params.wakeWord} - Finding profiles by wake word`);
    
    const profiles = await userProfileService.getProfilesByWakeWord(req.params.wakeWord);
    
    console.log(`Found ${profiles.length} profiles with wake word: ${req.params.wakeWord}`);
    res.status(200).json({
      success: true,
      profiles: profiles
    });

  } catch (error) {
    console.error(`Error in GET /api/profiles/wake-word/${req.params.wakeWord}:`, error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to find profiles by wake word',
      error: error.message
    });
  }
});

/**
 * GET /api/profiles/:id
 * Get user profile by ID
 */
router.get('/:id', auth, async (req, res) => {
  try {
    console.log(`GET /api/profiles/${req.params.id} - Fetching user profile by ID`);
    
    const profile = await userProfileService.getProfileById(req.params.id);
    
    if (!profile) {
      console.log(`Profile not found: ${req.params.id}`);
      return res.status(404).json({
        success: false,
        message: 'User profile not found'
      });
    }

    console.log(`Returning user profile: ${profile.name}`);
    res.status(200).json({
      success: true,
      profile: profile
    });

  } catch (error) {
    console.error(`Error in GET /api/profiles/${req.params.id}:`, error.message);
    console.error('Full error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user profile',
      error: error.message
    });
  }
});

/**
 * POST /api/profiles
 * Create new user profile
 */
router.post('/', admin, async (req, res) => {
  try {
    console.log('POST /api/profiles - Creating new user profile');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    const {
      name,
      wakeWords,
      voiceId,
      voiceName,
      systemPrompt,
      personality,
      responseStyle,
      preferredLanguage,
      timezone,
      speechRate,
      speechPitch,
      permissions,
      avatar,
      birthDate,
      contextMemory,
      learningMode,
      privacyMode
    } = req.body;

    // Validate required fields
    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Profile name is required'
      });
    }

    if (!wakeWords || !Array.isArray(wakeWords) || wakeWords.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one wake word is required'
      });
    }

    if (!voiceId) {
      return res.status(400).json({
        success: false,
        message: 'Voice ID is required'
      });
    }

    if (!systemPrompt) {
      return res.status(400).json({
        success: false,
        message: 'System prompt is required'
      });
    }

    const profileData = {
      name,
      wakeWords,
      voiceId,
      voiceName,
      systemPrompt,
      personality,
      responseStyle,
      preferredLanguage,
      timezone,
      speechRate,
      speechPitch,
      permissions,
      avatar,
      birthDate,
      contextMemory,
      learningMode,
      privacyMode
    };

    const profile = await userProfileService.createProfile(profileData);
    
    console.log(`Successfully created user profile: ${profile.name}`);
    res.status(201).json({
      success: true,
      message: 'User profile created successfully',
      profile: profile
    });

  } catch (error) {
    console.error('Error in POST /api/profiles:', error.message);
    console.error('Full error:', error);
    
    if (error.message.includes('already exists') || error.message.includes('required')) {
      res.status(400).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to create user profile',
        error: error.message
      });
    }
  }
});

/**
 * PUT /api/profiles/:id
 * Update user profile
 */
router.put('/:id', admin, async (req, res) => {
  try {
    console.log(`PUT /api/profiles/${req.params.id} - Updating user profile`);
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    const updateData = { ...req.body };
    delete updateData._id; // Remove _id from update data
    
    const profile = await userProfileService.updateProfile(req.params.id, updateData);
    
    console.log(`Successfully updated user profile: ${profile.name}`);
    res.status(200).json({
      success: true,
      message: 'User profile updated successfully',
      profile: profile
    });

  } catch (error) {
    console.error(`Error in PUT /api/profiles/${req.params.id}:`, error.message);
    console.error('Full error:', error);
    
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else if (error.message.includes('already exists') || error.message.includes('required')) {
      res.status(400).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to update user profile',
        error: error.message
      });
    }
  }
});

/**
 * DELETE /api/profiles/:id
 * Delete user profile
 */
router.delete('/:id', admin, async (req, res) => {
  try {
    console.log(`DELETE /api/profiles/${req.params.id} - Deleting user profile`);
    
    await userProfileService.deleteProfile(req.params.id);
    
    console.log(`Successfully deleted user profile: ${req.params.id}`);
    res.status(200).json({
      success: true,
      message: 'User profile deleted successfully'
    });

  } catch (error) {
    console.error(`Error in DELETE /api/profiles/${req.params.id}:`, error.message);
    console.error('Full error:', error);
    
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to delete user profile',
        error: error.message
      });
    }
  }
});

/**
 * PATCH /api/profiles/:id/toggle
 * Toggle profile active status
 */
router.patch('/:id/toggle', admin, async (req, res) => {
  try {
    console.log(`PATCH /api/profiles/${req.params.id}/toggle - Toggling profile status`);
    
    const profile = await userProfileService.toggleActiveStatus(req.params.id);
    
    console.log(`Successfully toggled profile status: ${profile.name} - ${profile.active}`);
    res.status(200).json({
      success: true,
      message: `Profile ${profile.active ? 'activated' : 'deactivated'} successfully`,
      profile: profile
    });

  } catch (error) {
    console.error(`Error in PATCH /api/profiles/${req.params.id}/toggle:`, error.message);
    console.error('Full error:', error);
    
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to toggle profile status',
        error: error.message
      });
    }
  }
});

/**
 * PATCH /api/profiles/:id/usage
 * Update profile usage tracking
 */
router.patch('/:id/usage', auth, async (req, res) => {
  try {
    console.log(`PATCH /api/profiles/${req.params.id}/usage - Updating profile usage`);
    
    const profile = await userProfileService.updateUsage(req.params.id);
    
    console.log(`Successfully updated usage for profile: ${profile.name}`);
    res.status(200).json({
      success: true,
      message: 'Profile usage updated successfully',
      profile: profile
    });

  } catch (error) {
    console.error(`Error in PATCH /api/profiles/${req.params.id}/usage:`, error.message);
    console.error('Full error:', error);
    
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to update profile usage',
        error: error.message
      });
    }
  }
});

/**
 * GET /api/profiles/:id/dashboard-views
 * Get saved dashboard views for a profile
 */
router.get('/:id/dashboard-views', auth, async (req, res) => {
  try {
    console.log(`GET /api/profiles/${req.params.id}/dashboard-views - Fetching dashboard views`);

    const views = await userProfileService.getDashboardViews(req.params.id);

    res.status(200).json({
      success: true,
      views
    });
  } catch (error) {
    console.error(`Error in GET /api/profiles/${req.params.id}/dashboard-views:`, error.message);
    console.error('Full error:', error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch dashboard views',
        error: error.message
      });
    }
  }
});

/**
 * PUT /api/profiles/:id/dashboard-views
 * Replace saved dashboard views for a profile
 */
router.put('/:id/dashboard-views', auth, async (req, res) => {
  try {
    console.log(`PUT /api/profiles/${req.params.id}/dashboard-views - Replacing dashboard views`);

    const { views } = req.body;
    if (!Array.isArray(views)) {
      return res.status(400).json({
        success: false,
        message: 'Views payload must be an array'
      });
    }

    const savedViews = await userProfileService.replaceDashboardViews(req.params.id, views);

    res.status(200).json({
      success: true,
      message: 'Dashboard views updated successfully',
      views: savedViews
    });
  } catch (error) {
    console.error(`Error in PUT /api/profiles/${req.params.id}/dashboard-views:`, error.message);
    console.error('Full error:', error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to update dashboard views',
        error: error.message
      });
    }
  }
});

/**
 * GET /api/profiles/:id/security-visible-sensors
 * Get synced security sensor visibility preferences for a profile
 */
router.get('/:id/security-visible-sensors', auth, async (req, res) => {
  try {
    console.log(`GET /api/profiles/${req.params.id}/security-visible-sensors - Fetching synced security sensor visibility`);

    const sensorIds = await userProfileService.getSecurityVisibleSensorIds(req.params.id);

    res.status(200).json({
      success: true,
      sensorIds
    });
  } catch (error) {
    console.error(`Error in GET /api/profiles/${req.params.id}/security-visible-sensors:`, error.message);
    console.error('Full error:', error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch synced security sensor visibility',
        error: error.message
      });
    }
  }
});

/**
 * PUT /api/profiles/:id/security-visible-sensors
 * Replace synced security sensor visibility preferences for a profile
 */
router.put('/:id/security-visible-sensors', auth, async (req, res) => {
  try {
    console.log(`PUT /api/profiles/${req.params.id}/security-visible-sensors - Replacing synced security sensor visibility`);

    if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'sensorIds')) {
      return res.status(400).json({
        success: false,
        message: 'sensorIds is required and must be an array or null'
      });
    }

    const { sensorIds } = req.body;
    if (sensorIds !== null && !Array.isArray(sensorIds)) {
      return res.status(400).json({
        success: false,
        message: 'sensorIds must be an array or null'
      });
    }

    const savedSensorIds = await userProfileService.replaceSecurityVisibleSensorIds(req.params.id, sensorIds);

    res.status(200).json({
      success: true,
      message: 'Synced security sensor visibility updated successfully',
      sensorIds: savedSensorIds
    });
  } catch (error) {
    console.error(`Error in PUT /api/profiles/${req.params.id}/security-visible-sensors:`, error.message);
    console.error('Full error:', error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else if (error.message.includes('array or null')) {
      res.status(400).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to update synced security sensor visibility',
        error: error.message
      });
    }
  }
});

/**
 * POST /api/profiles/:id/favorites/devices
 * Add device to profile favorites
 */
router.post('/:id/favorites/devices', auth, async (req, res) => {
  try {
    console.log(`POST /api/profiles/${req.params.id}/favorites/devices - Adding favorite device`);
    
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({
        success: false,
        message: 'Device ID is required'
      });
    }

    const profile = await userProfileService.addFavoriteDevice(req.params.id, deviceId);
    
    console.log(`Successfully added favorite device for profile: ${profile.name}`);
    res.status(200).json({
      success: true,
      message: 'Device added to favorites successfully',
      profile: profile
    });

  } catch (error) {
    console.error(`Error in POST /api/profiles/${req.params.id}/favorites/devices:`, error.message);
    console.error('Full error:', error);
    
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to add device to favorites',
        error: error.message
      });
    }
  }
});

/**
 * DELETE /api/profiles/:id/favorites/devices/:deviceId
 * Remove device from profile favorites
 */
router.delete('/:id/favorites/devices/:deviceId', auth, async (req, res) => {
  try {
    console.log(`DELETE /api/profiles/${req.params.id}/favorites/devices/${req.params.deviceId} - Removing favorite device`);
    
    const profile = await userProfileService.removeFavoriteDevice(req.params.id, req.params.deviceId);
    
    console.log(`Successfully removed favorite device for profile: ${profile.name}`);
    res.status(200).json({
      success: true,
      message: 'Device removed from favorites successfully',
      profile: profile
    });

  } catch (error) {
    console.error(`Error in DELETE /api/profiles/${req.params.id}/favorites/devices/${req.params.deviceId}:`, error.message);
    console.error('Full error:', error);
    
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to remove device from favorites',
        error: error.message
      });
    }
  }
});

/**
 * POST /api/profiles/:id/favorites/scenes
 * Add scene to profile favorites
 */
router.post('/:id/favorites/scenes', auth, async (req, res) => {
  try {
    console.log(`POST /api/profiles/${req.params.id}/favorites/scenes - Adding favorite scene`);

    const { sceneId } = req.body;
    if (!sceneId) {
      return res.status(400).json({
        success: false,
        message: 'Scene ID is required'
      });
    }

    const profile = await userProfileService.addFavoriteScene(req.params.id, sceneId);

    console.log(`Successfully added favorite scene for profile: ${profile.name}`);
    res.status(200).json({
      success: true,
      message: 'Scene added to favorites successfully',
      profile: profile
    });
  } catch (error) {
    console.error(`Error in POST /api/profiles/${req.params.id}/favorites/scenes:`, error.message);
    console.error('Full error:', error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to add scene to favorites',
        error: error.message
      });
    }
  }
});

/**
 * DELETE /api/profiles/:id/favorites/scenes/:sceneId
 * Remove scene from profile favorites
 */
router.delete('/:id/favorites/scenes/:sceneId', auth, async (req, res) => {
  try {
    console.log(`DELETE /api/profiles/${req.params.id}/favorites/scenes/${req.params.sceneId} - Removing favorite scene`);

    const profile = await userProfileService.removeFavoriteScene(req.params.id, req.params.sceneId);

    console.log(`Successfully removed favorite scene for profile: ${profile.name}`);
    res.status(200).json({
      success: true,
      message: 'Scene removed from favorites successfully',
      profile: profile
    });
  } catch (error) {
    console.error(`Error in DELETE /api/profiles/${req.params.id}/favorites/scenes/${req.params.sceneId}:`, error.message);
    console.error('Full error:', error);

    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        message: error.message
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to remove scene from favorites',
        error: error.message
      });
    }
  }
});

module.exports = router;

const UserProfile = require('../models/UserProfile');
const elevenLabsService = require('./elevenLabsService');

class UserProfileService {
  /**
   * Get all user profiles
   * @param {Object} filters - Optional filters for the query
   * @returns {Promise<Array>} Array of user profiles
   */
  async getAllProfiles(filters = {}) {
    try {
      console.log('Fetching all user profiles with filters:', filters);
      
      const query = {};
      
      // Apply filters
      if (filters.active !== undefined) {
        query.active = filters.active;
      }
      
      if (filters.name) {
        query.name = { $regex: filters.name, $options: 'i' };
      }
      
      const profiles = await UserProfile.find(query)
        .populate('favorites.devices')
        .populate('favorites.scenes')
        .populate('favorites.automations')
        .sort({ lastUsed: -1, createdAt: -1 });
      
      console.log(`Retrieved ${profiles.length} user profiles`);
      return profiles;

    } catch (error) {
      console.error('Error fetching user profiles:', error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Get user profile by ID
   * @param {string} profileId - Profile ID
   * @returns {Promise<Object>} User profile object
   */
  async getProfileById(profileId) {
    try {
      console.log(`Fetching user profile with ID: ${profileId}`);
      
      const profile = await UserProfile.findById(profileId)
        .populate('favorites.devices')
        .populate('favorites.scenes')
        .populate('favorites.automations');
      
      if (!profile) {
        console.log(`User profile not found: ${profileId}`);
        return null;
      }

      console.log(`Retrieved user profile: ${profile.name}`);
      return profile;

    } catch (error) {
      console.error(`Error fetching user profile ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Create new user profile
   * @param {Object} profileData - Profile data
   * @returns {Promise<Object>} Created user profile
   */
  async createProfile(profileData) {
    try {
      console.log('Creating new user profile:', profileData.name);
      
      // Validate required fields
      if (!profileData.name) {
        throw new Error('Profile name is required');
      }
      
      if (!profileData.wakeWords || !Array.isArray(profileData.wakeWords) || profileData.wakeWords.length === 0) {
        throw new Error('At least one wake word is required');
      }
      
      if (!profileData.voiceId) {
        throw new Error('Voice ID is required');
      }
      
      if (!profileData.systemPrompt) {
        throw new Error('System prompt is required');
      }

      // Validate voice ID with ElevenLabs
      console.log('Validating voice ID with ElevenLabs service');
      const isValidVoice = await elevenLabsService.validateVoiceId(profileData.voiceId);
      if (!isValidVoice) {
        console.warn(`Invalid voice ID provided: ${profileData.voiceId}, proceeding anyway`);
      }

      // Check if profile name already exists
      const existingProfile = await UserProfile.findOne({ name: { $regex: new RegExp(`^${profileData.name}$`, 'i') } });
      if (existingProfile) {
        throw new Error(`Profile with name "${profileData.name}" already exists`);
      }

      // Set default permissions if not provided
      if (!profileData.permissions) {
        profileData.permissions = ['device_control', 'scene_control', 'automation_control'];
      }

      const profile = new UserProfile(profileData);
      await profile.save();
      
      console.log(`Successfully created user profile: ${profile.name} with ID: ${profile._id}`);
      return profile;

    } catch (error) {
      console.error('Error creating user profile:', error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Update user profile
   * @param {string} profileId - Profile ID
   * @param {Object} updateData - Data to update
   * @returns {Promise<Object>} Updated user profile
   */
  async updateProfile(profileId, updateData) {
    try {
      console.log(`Updating user profile ${profileId} with data:`, Object.keys(updateData));
      
      const existingProfile = await UserProfile.findById(profileId);
      if (!existingProfile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      // If updating voice ID, validate it
      if (updateData.voiceId && updateData.voiceId !== existingProfile.voiceId) {
        console.log('Validating new voice ID with ElevenLabs service');
        const isValidVoice = await elevenLabsService.validateVoiceId(updateData.voiceId);
        if (!isValidVoice) {
          console.warn(`Invalid voice ID provided: ${updateData.voiceId}, proceeding anyway`);
        }
      }

      // If updating name, check for duplicates
      if (updateData.name && updateData.name !== existingProfile.name) {
        const duplicateProfile = await UserProfile.findOne({ 
          name: { $regex: new RegExp(`^${updateData.name}$`, 'i') },
          _id: { $ne: profileId }
        });
        if (duplicateProfile) {
          throw new Error(`Profile with name "${updateData.name}" already exists`);
        }
      }

      // Update the profile
      const updatedProfile = await UserProfile.findByIdAndUpdate(
        profileId,
        { 
          ...updateData,
          updatedAt: Date.now()
        },
        { 
          new: true, 
          runValidators: true 
        }
      ).populate('favorites.devices')
       .populate('favorites.scenes')
       .populate('favorites.automations');
      
      console.log(`Successfully updated user profile: ${updatedProfile.name}`);
      return updatedProfile;

    } catch (error) {
      console.error(`Error updating user profile ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Delete user profile
   * @param {string} profileId - Profile ID
   * @returns {Promise<boolean>} True if deleted successfully
   */
  async deleteProfile(profileId) {
    try {
      console.log(`Deleting user profile with ID: ${profileId}`);
      
      const profile = await UserProfile.findById(profileId);
      if (!profile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      await UserProfile.findByIdAndDelete(profileId);
      
      console.log(`Successfully deleted user profile: ${profile.name}`);
      return true;

    } catch (error) {
      console.error(`Error deleting user profile ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Toggle profile active status
   * @param {string} profileId - Profile ID
   * @returns {Promise<Object>} Updated profile
   */
  async toggleActiveStatus(profileId) {
    try {
      console.log(`Toggling active status for profile: ${profileId}`);
      
      const profile = await UserProfile.findById(profileId);
      if (!profile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      profile.active = !profile.active;
      profile.updatedAt = Date.now();
      await profile.save();
      
      console.log(`Profile ${profile.name} active status changed to: ${profile.active}`);
      return profile;

    } catch (error) {
      console.error(`Error toggling profile status ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Update profile usage tracking
   * @param {string} profileId - Profile ID
   * @returns {Promise<Object>} Updated profile
   */
  async updateUsage(profileId) {
    try {
      console.log(`Updating usage for profile: ${profileId}`);
      
      const profile = await UserProfile.findByIdAndUpdate(
        profileId,
        {
          $inc: { usageCount: 1 },
          lastUsed: Date.now(),
          updatedAt: Date.now()
        },
        { new: true }
      );

      if (!profile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      console.log(`Updated usage for profile: ${profile.name} (count: ${profile.usageCount})`);
      return profile;

    } catch (error) {
      console.error(`Error updating profile usage ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Add device to profile favorites
   * @param {string} profileId - Profile ID
   * @param {string} deviceId - Device ID
   * @returns {Promise<Object>} Updated profile
   */
  async addFavoriteDevice(profileId, deviceId) {
    try {
      console.log(`Adding device ${deviceId} to favorites for profile ${profileId}`);
      
      const profile = await UserProfile.findByIdAndUpdate(
        profileId,
        {
          $addToSet: { 'favorites.devices': deviceId },
          updatedAt: Date.now()
        },
        { new: true }
      ).populate('favorites.devices');

      if (!profile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      console.log(`Added device to favorites for profile: ${profile.name}`);
      return profile;

    } catch (error) {
      console.error(`Error adding favorite device ${deviceId} to profile ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Remove device from profile favorites
   * @param {string} profileId - Profile ID
   * @param {string} deviceId - Device ID
   * @returns {Promise<Object>} Updated profile
   */
  async removeFavoriteDevice(profileId, deviceId) {
    try {
      console.log(`Removing device ${deviceId} from favorites for profile ${profileId}`);
      
      const profile = await UserProfile.findByIdAndUpdate(
        profileId,
        {
          $pull: { 'favorites.devices': deviceId },
          updatedAt: Date.now()
        },
        { new: true }
      ).populate('favorites.devices');

      if (!profile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      console.log(`Removed device from favorites for profile: ${profile.name}`);
      return profile;

    } catch (error) {
      console.error(`Error removing favorite device ${deviceId} from profile ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Get profiles by wake word
   * @param {string} wakeWord - Wake word to search for
   * @returns {Promise<Array>} Array of profiles that use this wake word
   */
  async getProfilesByWakeWord(wakeWord) {
    try {
      console.log(`Finding profiles with wake word: ${wakeWord}`);
      
      const profiles = await UserProfile.find({
        wakeWords: { $in: [wakeWord] },
        active: true
      }).select('name wakeWords voiceId systemPrompt');
      
      console.log(`Found ${profiles.length} profiles with wake word "${wakeWord}"`);
      return profiles;

    } catch (error) {
      console.error(`Error finding profiles with wake word ${wakeWord}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }
}

module.exports = new UserProfileService();
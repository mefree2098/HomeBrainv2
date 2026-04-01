const UserProfile = require('../models/UserProfile');
const elevenLabsService = require('./elevenLabsService');
const wakeWordTrainingService = require('./wakeWordTrainingService');
const voiceAcknowledgmentService = require('./voiceAcknowledgmentService');
const { normalizeDashboardViews } = require('../utils/dashboardViews');

const normalizeVisibleSensorIds = (sensorIds) => {
  if (sensorIds === undefined || sensorIds === null) {
    return null;
  }

  if (!Array.isArray(sensorIds)) {
    throw new Error('Sensor IDs payload must be an array or null');
  }

  const seen = new Set();
  const normalized = [];

  for (const entry of sensorIds) {
    if (typeof entry !== 'string') {
      continue;
    }

    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
};

const normalizeAlexaMappings = (mappings) => {
  if (mappings === undefined) {
    return undefined;
  }

  if (mappings === null) {
    return [];
  }

  if (!Array.isArray(mappings)) {
    throw new Error('Alexa mappings must be an array');
  }

  const seen = new Set();
  const normalized = [];

  for (const entry of mappings) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const personId = typeof entry.personId === 'string' ? entry.personId.trim() : '';
    const speakerLabel = typeof entry.speakerLabel === 'string' ? entry.speakerLabel.trim() : '';
    const householdId = typeof entry.householdId === 'string' ? entry.householdId.trim() : '';
    const locale = typeof entry.locale === 'string' ? entry.locale.trim() : '';
    const alexaUserId = typeof entry.alexaUserId === 'string' ? entry.alexaUserId.trim() : '';
    const alexaAccountId = typeof entry.alexaAccountId === 'string' ? entry.alexaAccountId.trim() : '';
    const defaultForHousehold = entry.defaultForHousehold === true;
    const fallback = entry.fallback === true;
    const enabled = entry.enabled !== false;

    if (!personId && !defaultForHousehold && !fallback) {
      continue;
    }

    const dedupeKey = [
      personId || '*',
      householdId || '*',
      locale || '*',
      defaultForHousehold ? 'default' : 'nodefault',
      fallback ? 'fallback' : 'nofallback'
    ].join('::').toLowerCase();

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    normalized.push({
      personId: personId || undefined,
      speakerLabel: speakerLabel || undefined,
      householdId: householdId || undefined,
      locale: locale || undefined,
      alexaUserId: alexaUserId || undefined,
      alexaAccountId: alexaAccountId || undefined,
      defaultForHousehold,
      fallback,
      enabled
    });
  }

  return normalized;
};

class UserProfileService {
  normalizeAlexaMappings(mappings) {
    return normalizeAlexaMappings(mappings);
  }

  async validateAlexaMappings(alexaMappings = [], excludedProfileId = null) {
    const normalized = normalizeAlexaMappings(alexaMappings) || [];
    if (normalized.length === 0) {
      return normalized;
    }

    const exactMappings = normalized.filter((entry) => entry.personId && entry.enabled !== false);
    if (exactMappings.length > 0) {
      const profiles = await UserProfile.find({
        ...(excludedProfileId ? { _id: { $ne: excludedProfileId } } : {}),
        'alexaMappings.personId': { $in: exactMappings.map((entry) => entry.personId) }
      }).select('name alexaMappings');

      for (const profile of profiles) {
        const conflictingEntry = (profile.alexaMappings || []).find((mapping) => {
          if (!mapping?.personId || mapping.enabled === false) {
            return false;
          }

          return exactMappings.some((candidate) => candidate.personId === mapping.personId);
        });

        if (conflictingEntry) {
          throw new Error(`Alexa speaker mapping for personId "${conflictingEntry.personId}" already belongs to profile "${profile.name}"`);
        }
      }
    }

    const defaultByHousehold = new Map();
    for (const entry of normalized) {
      if (!entry.defaultForHousehold || !entry.householdId || entry.enabled === false) {
        continue;
      }

      const key = entry.householdId.toLowerCase();
      if (defaultByHousehold.has(key)) {
        throw new Error(`Only one Alexa default mapping is allowed per household (${entry.householdId}) on a profile`);
      }

      defaultByHousehold.set(key, entry);
    }

    if (defaultByHousehold.size > 0) {
      const profiles = await UserProfile.find({
        ...(excludedProfileId ? { _id: { $ne: excludedProfileId } } : {}),
        'alexaMappings.defaultForHousehold': true,
        'alexaMappings.householdId': { $in: Array.from(defaultByHousehold.values()).map((entry) => entry.householdId) }
      }).select('name alexaMappings');

      for (const profile of profiles) {
        const conflict = (profile.alexaMappings || []).find((mapping) => {
          if (!mapping?.defaultForHousehold || !mapping?.householdId || mapping.enabled === false) {
            return false;
          }

          return defaultByHousehold.has(String(mapping.householdId).toLowerCase());
        });

        if (conflict) {
          throw new Error(`Alexa household default mapping for "${conflict.householdId}" already belongs to profile "${profile.name}"`);
        }
      }
    }

    return normalized;
  }

  buildAlexaProfileSummary(profile) {
    if (!profile) {
      return null;
    }

    return {
      profileId: profile._id?.toString?.() || profile.id || null,
      name: profile.name || '',
      voiceId: profile.voiceId || '',
      voiceName: profile.voiceName || '',
      preferredLanguage: profile.preferredLanguage || 'en-US',
      timezone: profile.timezone || 'UTC',
      permissions: Array.isArray(profile.permissions) ? profile.permissions : [],
      alexaMappings: Array.isArray(profile.alexaMappings)
        ? profile.alexaMappings.map((entry) => ({
          personId: entry?.personId || '',
          speakerLabel: entry?.speakerLabel || '',
          householdId: entry?.householdId || '',
          locale: entry?.locale || '',
          alexaUserId: entry?.alexaUserId || '',
          alexaAccountId: entry?.alexaAccountId || '',
          defaultForHousehold: entry?.defaultForHousehold === true,
          fallback: entry?.fallback === true,
          enabled: entry?.enabled !== false
        }))
        : []
    };
  }

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
        .populate('wakeWordModels')
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
        .populate('favorites.automations')
        .populate('wakeWordModels');
      
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

      if (Object.prototype.hasOwnProperty.call(profileData, 'alexaMappings')) {
        profileData.alexaMappings = await this.validateAlexaMappings(profileData.alexaMappings);
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

      await wakeWordTrainingService.syncProfileWakeWords(profile);

      const populatedProfile = await UserProfile.findById(profile._id)
        .populate('favorites.devices')
        .populate('favorites.scenes')
        .populate('favorites.automations')
        .populate('wakeWordModels');

      await voiceAcknowledgmentService.queueAcknowledgmentGeneration(populatedProfile, { force: true });
      
      console.log(`Successfully created user profile: ${populatedProfile.name} with ID: ${populatedProfile._id}`);
      return populatedProfile;

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

      if (Object.prototype.hasOwnProperty.call(updateData, 'alexaMappings')) {
        updateData.alexaMappings = await this.validateAlexaMappings(updateData.alexaMappings, profileId);
      }

      // Update the profile
      const updatedProfile = await UserProfile.findByIdAndUpdate(
        profileId,
        {
          ...updateData,
          updatedAt: Date.now()
        },
        { 
          returnDocument: 'after', 
          runValidators: true 
        }
      ).populate('favorites.devices')
       .populate('favorites.scenes')
       .populate('favorites.automations')
       .populate('wakeWordModels');

      if (!updatedProfile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      await wakeWordTrainingService.syncProfileWakeWords(updatedProfile);

      const refreshedProfile = await UserProfile.findById(profileId)
        .populate('favorites.devices')
        .populate('favorites.scenes')
        .populate('favorites.automations')
        .populate('wakeWordModels');

      await voiceAcknowledgmentService.queueAcknowledgmentGeneration(refreshedProfile, { force: true });
      
      console.log(`Successfully updated user profile: ${refreshedProfile.name}`);
      return refreshedProfile;

    } catch (error) {
      console.error(`Error updating user profile ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  async resolveAlexaProfile(options = {}) {
    try {
      const personId = typeof options.personId === 'string' ? options.personId.trim() : '';
      const householdId = typeof options.householdId === 'string' ? options.householdId.trim() : '';
      const locale = typeof options.locale === 'string' ? options.locale.trim() : '';
      const buildResolution = async (profile, matchType) => {
        if (profile?._id) {
          await this.updateUsage(profile._id.toString()).catch(() => {});
        }

        return {
          profile,
          profileSummary: this.buildAlexaProfileSummary(profile),
          matchType
        };
      };

      const activeProfiles = await UserProfile.find({ active: true })
        .select('name voiceId voiceName preferredLanguage timezone permissions alexaMappings lastUsed usageCount')
        .sort({ lastUsed: -1, usageCount: -1, name: 1 });

      const exactPersonMatch = activeProfiles.find((profile) => (profile.alexaMappings || []).some((mapping) => (
        mapping?.enabled !== false
        && mapping?.personId
        && mapping.personId === personId
        && (!mapping.householdId || !householdId || mapping.householdId === householdId)
      )));
      if (exactPersonMatch) {
        return buildResolution(exactPersonMatch, 'person');
      }

      const householdDefault = activeProfiles.find((profile) => (profile.alexaMappings || []).some((mapping) => (
        mapping?.enabled !== false
        && mapping?.defaultForHousehold === true
        && mapping?.householdId
        && householdId
        && mapping.householdId === householdId
      )));
      if (householdDefault) {
        return buildResolution(householdDefault, 'household_default');
      }

      const localeFallback = activeProfiles.find((profile) => (profile.alexaMappings || []).some((mapping) => (
        mapping?.enabled !== false
        && mapping?.fallback === true
        && (!mapping.locale || !locale || mapping.locale === locale)
      )));
      if (localeFallback) {
        return buildResolution(localeFallback, 'fallback');
      }

      const firstProfile = activeProfiles[0] || null;
      return buildResolution(firstProfile, firstProfile ? 'first_active_profile' : 'none');
    } catch (error) {
      console.error('Error resolving Alexa profile:', error.message);
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
      await wakeWordTrainingService.unregisterProfile(profileId);
      await voiceAcknowledgmentService.removeForProfile(profileId);

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
        { returnDocument: 'after' }
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
        { returnDocument: 'after' }
      )
        .populate('favorites.devices')
        .populate('favorites.scenes')
        .populate('favorites.automations');

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
        { returnDocument: 'after' }
      )
        .populate('favorites.devices')
        .populate('favorites.scenes')
        .populate('favorites.automations');

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
   * Add scene to profile favorites
   * @param {string} profileId - Profile ID
   * @param {string} sceneId - Scene ID
   * @returns {Promise<Object>} Updated profile
   */
  async addFavoriteScene(profileId, sceneId) {
    try {
      console.log(`Adding scene ${sceneId} to favorites for profile ${profileId}`);

      const profile = await UserProfile.findByIdAndUpdate(
        profileId,
        {
          $addToSet: { 'favorites.scenes': sceneId },
          updatedAt: Date.now()
        },
        { returnDocument: 'after' }
      )
        .populate('favorites.devices')
        .populate('favorites.scenes')
        .populate('favorites.automations');

      if (!profile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      console.log(`Added scene to favorites for profile: ${profile.name}`);
      return profile;
    } catch (error) {
      console.error(`Error adding favorite scene ${sceneId} to profile ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Remove scene from profile favorites
   * @param {string} profileId - Profile ID
   * @param {string} sceneId - Scene ID
   * @returns {Promise<Object>} Updated profile
   */
  async removeFavoriteScene(profileId, sceneId) {
    try {
      console.log(`Removing scene ${sceneId} from favorites for profile ${profileId}`);

      const profile = await UserProfile.findByIdAndUpdate(
        profileId,
        {
          $pull: { 'favorites.scenes': sceneId },
          updatedAt: Date.now()
        },
        { returnDocument: 'after' }
      )
        .populate('favorites.devices')
        .populate('favorites.scenes')
        .populate('favorites.automations');

      if (!profile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      console.log(`Removed scene from favorites for profile: ${profile.name}`);
      return profile;
    } catch (error) {
      console.error(`Error removing favorite scene ${sceneId} from profile ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Get saved dashboard views for a profile
   * @param {string} profileId
   * @returns {Promise<Array>}
   */
  async getDashboardViews(profileId) {
    try {
      console.log(`Fetching dashboard views for profile: ${profileId}`);

      const profile = await UserProfile.findById(profileId).select('name dashboardViews');
      if (!profile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      const normalizedViews = normalizeDashboardViews(profile.dashboardViews);
      const needsPersistence = JSON.stringify(profile.dashboardViews || []) !== JSON.stringify(normalizedViews);

      if (needsPersistence) {
        profile.dashboardViews = normalizedViews;
        profile.updatedAt = Date.now();
        await profile.save();
      }

      return normalizedViews;
    } catch (error) {
      console.error(`Error fetching dashboard views for profile ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Replace saved dashboard views for a profile
   * @param {string} profileId
   * @param {Array} views
   * @returns {Promise<Array>}
   */
  async replaceDashboardViews(profileId, views) {
    try {
      console.log(`Replacing dashboard views for profile: ${profileId}`);

      const profile = await UserProfile.findById(profileId).select('name dashboardViews updatedAt');
      if (!profile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      profile.dashboardViews = normalizeDashboardViews(views);
      profile.updatedAt = Date.now();
      await profile.save();

      return profile.dashboardViews;
    } catch (error) {
      console.error(`Error replacing dashboard views for profile ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Get synced security sensor visibility preferences for a profile
   * @param {string} profileId
   * @returns {Promise<Array<string> | null>}
   */
  async getSecurityVisibleSensorIds(profileId) {
    try {
      console.log(`Fetching security visible sensor IDs for profile: ${profileId}`);

      const profile = await UserProfile.findById(profileId).select('name securityPreferences updatedAt');
      if (!profile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      const storedSensorIds = normalizeVisibleSensorIds(profile.securityPreferences?.visibleSensorIds);
      const persistedSensorIds = profile.securityPreferences?.visibleSensorIds;
      const storedValueChanged = (
        (storedSensorIds === null && Array.isArray(persistedSensorIds) && persistedSensorIds.length > 0) ||
        (storedSensorIds !== null && JSON.stringify(persistedSensorIds || []) !== JSON.stringify(storedSensorIds))
      );

      if (storedValueChanged) {
        if (!profile.securityPreferences) {
          profile.securityPreferences = {};
        }

        profile.securityPreferences.visibleSensorIds = storedSensorIds ?? undefined;
        profile.updatedAt = Date.now();
        profile.markModified('securityPreferences');
        await profile.save();
      }

      return storedSensorIds;
    } catch (error) {
      console.error(`Error fetching security visible sensor IDs for profile ${profileId}:`, error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  /**
   * Replace synced security sensor visibility preferences for a profile
   * @param {string} profileId
   * @param {Array<string> | null} sensorIds
   * @returns {Promise<Array<string> | null>}
   */
  async replaceSecurityVisibleSensorIds(profileId, sensorIds) {
    try {
      console.log(`Replacing security visible sensor IDs for profile: ${profileId}`);

      const profile = await UserProfile.findById(profileId).select('name securityPreferences updatedAt');
      if (!profile) {
        throw new Error(`Profile with ID ${profileId} not found`);
      }

      const normalizedSensorIds = normalizeVisibleSensorIds(sensorIds);

      if (!profile.securityPreferences) {
        profile.securityPreferences = {};
      }

      profile.securityPreferences.visibleSensorIds = normalizedSensorIds ?? undefined;
      profile.updatedAt = Date.now();
      profile.markModified('securityPreferences');
      await profile.save();

      return normalizedSensorIds;
    } catch (error) {
      console.error(`Error replacing security visible sensor IDs for profile ${profileId}:`, error.message);
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

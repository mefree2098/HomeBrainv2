const Settings = require('../models/Settings');

class SettingsService {
  /**
   * Get application settings
   * @returns {Promise<Object>} Settings object
   */
  async getSettings() {
    try {
      console.log('SettingsService: Fetching application settings');
      const settings = await Settings.getSettings();
      console.log('SettingsService: Successfully retrieved settings');
      return settings;
    } catch (error) {
      console.error('SettingsService: Error fetching settings:', error.message);
      console.error('SettingsService: Full error:', error);
      throw new Error('Failed to fetch application settings');
    }
  }

  /**
   * Update application settings
   * @param {Object} updates - Settings to update
   * @returns {Promise<Object>} Updated settings object
   */
  async updateSettings(updates) {
    try {
      console.log('SettingsService: Updating application settings');
      console.log('SettingsService: Update keys:', Object.keys(updates));
      
      // Validate required fields and sanitize input
      const allowedFields = [
        'location', 'timezone', 'wakeWordSensitivity', 'voiceVolume',
        'microphoneSensitivity', 'enableVoiceConfirmation', 'enableNotifications',
        'insteonPort', 'smartthingsToken', 'elevenlabsApiKey', 'enableSecurityMode',
        // AI Provider Settings
        'llmProvider', 'openaiApiKey', 'openaiModel',
        'anthropicApiKey', 'anthropicModel',
        'localLlmEndpoint', 'localLlmModel', 'llmPriorityList',
        // SmartThings OAuth Settings
        'smartthingsClientId', 'smartthingsClientSecret', 'smartthingsRedirectUri', 'smartthingsUseOAuth'
      ];
      
      const sanitizedUpdates = {};
      Object.keys(updates).forEach(key => {
        if (allowedFields.includes(key)) {
          sanitizedUpdates[key] = updates[key];
        }
      });
      
      console.log('SettingsService: Sanitized update keys:', Object.keys(sanitizedUpdates));
      
      const settings = await Settings.updateSettings(sanitizedUpdates);
      console.log('SettingsService: Successfully updated settings');
      return settings;
    } catch (error) {
      console.error('SettingsService: Error updating settings:', error.message);
      console.error('SettingsService: Full error:', error);
      throw new Error('Failed to update application settings');
    }
  }

  /**
   * Get sanitized settings for frontend (masks sensitive data)
   * @returns {Promise<Object>} Sanitized settings object
   */
  async getSanitizedSettings() {
    try {
      console.log('SettingsService: Fetching sanitized settings for frontend');
      const settings = await this.getSettings();
      const sanitized = settings.toSanitized();
      console.log('SettingsService: Successfully retrieved sanitized settings');
      return sanitized;
    } catch (error) {
      console.error('SettingsService: Error fetching sanitized settings:', error.message);
      throw new Error('Failed to fetch sanitized settings');
    }
  }

  /**
   * Get specific setting value
   * @param {string} key - Setting key
   * @returns {Promise<any>} Setting value
   */
  async getSetting(key) {
    try {
      console.log(`SettingsService: Getting specific setting: ${key}`);
      const settings = await this.getSettings();
      const value = settings[key];
      console.log(`SettingsService: Retrieved setting ${key}:`, value ? '[SET]' : '[NOT_SET]');
      return value;
    } catch (error) {
      console.error(`SettingsService: Error getting setting ${key}:`, error.message);
      throw new Error(`Failed to get setting: ${key}`);
    }
  }

  /**
   * Get ElevenLabs API key (prioritizes database over environment variable)
   * @returns {Promise<string|null>} API key or null if not set
   */
  async getElevenLabsApiKey() {
    try {
      console.log('SettingsService: Getting ElevenLabs API key');

      // First check database settings
      const dbApiKey = await this.getSetting('elevenlabsApiKey');
      if (dbApiKey && dbApiKey.trim() !== '') {
        console.log('SettingsService: Found ElevenLabs API key in database');
        return dbApiKey.trim();
      }

      // Fallback to environment variable
      const envApiKey = process.env.ELEVENLABS_API_KEY;
      if (envApiKey && envApiKey.trim() !== '') {
        console.log('SettingsService: Found ElevenLabs API key in environment variables');
        return envApiKey.trim();
      }

      console.log('SettingsService: No ElevenLabs API key found');
      return null;
    } catch (error) {
      console.error('SettingsService: Error getting ElevenLabs API key:', error.message);
      return null;
    }
  }

  /**
   * Get OpenAI API key from database settings
   * @returns {Promise<string|null>} API key or null if not set
   */
  async getOpenAIApiKey() {
    try {
      console.log('SettingsService: Getting OpenAI API key');
      const dbApiKey = await this.getSetting('openaiApiKey');
      if (dbApiKey && dbApiKey.trim() !== '') {
        console.log('SettingsService: Found OpenAI API key in database');
        return dbApiKey.trim();
      }
      console.log('SettingsService: No OpenAI API key found');
      return null;
    } catch (error) {
      console.error('SettingsService: Error getting OpenAI API key:', error.message);
      return null;
    }
  }

  /**
   * Get Anthropic API key from database settings
   * @returns {Promise<string|null>} API key or null if not set
   */
  async getAnthropicApiKey() {
    try {
      console.log('SettingsService: Getting Anthropic API key');
      const dbApiKey = await this.getSetting('anthropicApiKey');
      if (dbApiKey && dbApiKey.trim() !== '') {
        console.log('SettingsService: Found Anthropic API key in database');
        return dbApiKey.trim();
      }
      console.log('SettingsService: No Anthropic API key found');
      return null;
    } catch (error) {
      console.error('SettingsService: Error getting Anthropic API key:', error.message);
      return null;
    }
  }
}

module.exports = new SettingsService();
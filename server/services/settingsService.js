const Settings = require('../models/Settings');

const SENSITIVE_SETTING_FIELDS = new Set([
  'elevenlabsApiKey',
  'lanWhisperApiKey',
  's2ProApiKey',
  'smartthingsToken',
  'smartthingsClientSecret',
  'openaiApiKey',
  'anthropicApiKey',
  'isyPassword',
  'hardwareOrbWifiPassword',
  'smbBackupPassword',
  'dynamicDnsAzureClientSecret'
]);

function maskSecretValue(value) {
  if (!value) {
    return value;
  }

  const normalized = String(value);
  if (normalized.length <= 4) {
    return '********';
  }

  return normalized.replace(/.(?=.{4})/g, '*');
}

class SettingsService {
  isSensitiveField(key) {
    return SENSITIVE_SETTING_FIELDS.has(key);
  }

  isMaskedSecretValue(value) {
    if (typeof value !== 'string') {
      return false;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }

    if (/^[*•]+$/.test(trimmed)) {
      return true;
    }

    return /^[*•]{4,}[^*•\s]+$/.test(trimmed);
  }

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
        'insteonPort', 'isyHost', 'isyPort', 'isyUsername', 'isyPassword', 'isyUseHttps', 'isyIgnoreTlsErrors',
        'smartthingsToken', 'elevenlabsApiKey', 'elevenlabsDefaultVoiceId',
        'harmonyHubAddresses',
        'hardwareOrbWifiSsid', 'hardwareOrbWifiPassword',
        'sttProvider', 'sttModel', 'sttLanguage', 'lanWhisperEndpoint', 'lanWhisperApiKey',
        'lanWhisperTimeoutMs', 'ttsProvider', 'ttsProviderPriorityList', 's2ProEndpoint',
        's2ProApiKey', 's2ProDefaultVoiceId', 's2ProModel', 's2ProOutputFormat', // gitleaks:allow
        's2ProTimeoutMs', 'enableSecurityMode',
        // AI Provider Settings
        'llmProvider', 'openaiApiKey', 'openaiModel',
        'anthropicApiKey', 'anthropicModel',
        'codexPath', 'codexHome', 'codexHomeProfile', 'codexAwsVolumeRoot', 'codexModel', 'codexEffort',
        'localLlmEndpoint', 'localLlmModel', 'homebrainLocalLlmModel', 'spamFilterLocalLlmModel', 'llmPriorityList',
        'deviceCommandCoordinator',
        'integrationPreferences',
        // SmartThings OAuth Settings
        'smartthingsClientId', 'smartthingsClientSecret', 'smartthingsRedirectUri', 'smartthingsUseOAuth',
        // Voice/Discovery Preferences
        'voiceRegion', 'autoDiscoveryEnabled',
        // Auth session lifetime
        'authSessionMaxAgeDays',
        // Whole-device restart schedule
        'deviceRestartScheduleEnabled', 'deviceRestartScheduleFrequency',
        'deviceRestartScheduleDayOfWeek', 'deviceRestartScheduleTime',
        // SMB disaster recovery backup
        'smbBackupShareUrl', 'smbBackupRemoteDirectory', 'smbBackupUsername',
        'smbBackupPassword', 'smbBackupDomain', 'smbBackupScheduleEnabled',
        'smbBackupScheduleTime', 'smbBackupRetentionCount',
        'dynamicDnsEnabled', 'dynamicDnsProvider', 'dynamicDnsCheckIntervalSeconds',
        'dynamicDnsPublicIpUrl', 'dynamicDnsPrimaryHostname',
        'dynamicDnsAzureTenantId', 'dynamicDnsAzureClientId', 'dynamicDnsAzureClientSecret',
        'dynamicDnsAzureSubscriptionId', 'dynamicDnsAzureResourceGroup',
        'dynamicDnsAzureZoneName', 'dynamicDnsAzureTtlSeconds'
      ];
      const sanitizedUpdates = {};
      Object.keys(updates).forEach(key => {
        if (allowedFields.includes(key)) {
          if (this.isSensitiveField(key)) {
            if (this.isMaskedSecretValue(updates[key])) {
              return;
            }
            if (typeof updates[key] === 'string' && updates[key].trim() === '') {
              // Treat blank sensitive values as "no change" to avoid wiping stored credentials.
              return;
            }
          }
          sanitizedUpdates[key] = updates[key];
        }
      });

      const sharedLocalModelCandidate = [
        sanitizedUpdates.homebrainLocalLlmModel,
        sanitizedUpdates.localLlmModel,
        sanitizedUpdates.spamFilterLocalLlmModel
      ]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .find(Boolean);

      if (sharedLocalModelCandidate) {
        sanitizedUpdates.localLlmModel = sharedLocalModelCandidate;
        sanitizedUpdates.homebrainLocalLlmModel = sharedLocalModelCandidate;
        sanitizedUpdates.spamFilterLocalLlmModel = sharedLocalModelCandidate;
      }

      [
        'codexPath',
        'codexHome',
        'codexAwsVolumeRoot',
        'codexModel',
        'codexEffort',
        'openaiModel',
        'anthropicModel',
        'localLlmEndpoint',
        'lanWhisperEndpoint',
        's2ProEndpoint',
        's2ProDefaultVoiceId',
        's2ProModel'
      ]
        .forEach((key) => {
          if (typeof sanitizedUpdates[key] === 'string') {
            sanitizedUpdates[key] = key === 'codexEffort'
              ? sanitizedUpdates[key].trim().toLowerCase()
              : sanitizedUpdates[key].trim();
          }
        });

      if (typeof sanitizedUpdates.sttProvider === 'string') {
        const normalizedSttProvider = sanitizedUpdates.sttProvider.trim().toLowerCase();
        if (['openai', 'local', 'lan_whisper'].includes(normalizedSttProvider)) {
          sanitizedUpdates.sttProvider = normalizedSttProvider;
        } else {
          delete sanitizedUpdates.sttProvider;
        }
      }

      if (typeof sanitizedUpdates.ttsProvider === 'string') {
        const normalizedTtsProvider = sanitizedUpdates.ttsProvider.trim().toLowerCase();
        if (['elevenlabs', 's2_pro'].includes(normalizedTtsProvider)) {
          sanitizedUpdates.ttsProvider = normalizedTtsProvider;
        } else {
          delete sanitizedUpdates.ttsProvider;
        }
      }

      if (Array.isArray(sanitizedUpdates.ttsProviderPriorityList)) {
        const validTtsProviders = new Set(['s2_pro', 'elevenlabs']);
        const normalizedPriority = sanitizedUpdates.ttsProviderPriorityList
          .map((provider) => (typeof provider === 'string' ? provider.trim().toLowerCase() : ''))
          .filter((provider, index, arr) => validTtsProviders.has(provider) && arr.indexOf(provider) === index);
        sanitizedUpdates.ttsProviderPriorityList = normalizedPriority.length
          ? normalizedPriority
          : ['s2_pro', 'elevenlabs'];
      }

      if (typeof sanitizedUpdates.s2ProOutputFormat === 'string') {
        const normalizedFormat = sanitizedUpdates.s2ProOutputFormat.trim().toLowerCase();
        if (['mp3', 'wav', 'opus', 'flac', 'pcm'].includes(normalizedFormat)) {
          sanitizedUpdates.s2ProOutputFormat = normalizedFormat;
        } else {
          delete sanitizedUpdates.s2ProOutputFormat;
        }
      }

      if (Object.prototype.hasOwnProperty.call(sanitizedUpdates, 'lanWhisperTimeoutMs')) {
        const timeoutMs = Number(sanitizedUpdates.lanWhisperTimeoutMs);
        sanitizedUpdates.lanWhisperTimeoutMs = Number.isFinite(timeoutMs)
          ? Math.min(120000, Math.max(1000, Math.trunc(timeoutMs)))
          : 30000;
      }

      if (Object.prototype.hasOwnProperty.call(sanitizedUpdates, 's2ProTimeoutMs')) {
        const timeoutMs = Number(sanitizedUpdates.s2ProTimeoutMs);
        sanitizedUpdates.s2ProTimeoutMs = Number.isFinite(timeoutMs)
          ? Math.min(120000, Math.max(1000, Math.trunc(timeoutMs)))
          : 30000;
      }

      if (typeof sanitizedUpdates.hardwareOrbWifiSsid === 'string') {
        sanitizedUpdates.hardwareOrbWifiSsid = sanitizedUpdates.hardwareOrbWifiSsid.trim();
      }

      [
        'smbBackupShareUrl',
        'smbBackupRemoteDirectory',
        'smbBackupUsername',
        'smbBackupDomain',
        'dynamicDnsPublicIpUrl',
        'dynamicDnsPrimaryHostname',
        'dynamicDnsAzureTenantId',
        'dynamicDnsAzureClientId',
        'dynamicDnsAzureSubscriptionId',
        'dynamicDnsAzureResourceGroup',
        'dynamicDnsAzureZoneName'
      ]
        .forEach((key) => {
          if (typeof sanitizedUpdates[key] === 'string') {
            sanitizedUpdates[key] = sanitizedUpdates[key].trim();
          }
        });

      if (Object.prototype.hasOwnProperty.call(sanitizedUpdates, 'smbBackupRetentionCount')) {
        const retentionCount = Number(sanitizedUpdates.smbBackupRetentionCount);
        sanitizedUpdates.smbBackupRetentionCount = Number.isFinite(retentionCount)
          ? Math.min(30, Math.max(1, Math.trunc(retentionCount)))
          : 3;
      }

      if (Object.prototype.hasOwnProperty.call(sanitizedUpdates, 'dynamicDnsCheckIntervalSeconds')) {
        const intervalSeconds = Number(sanitizedUpdates.dynamicDnsCheckIntervalSeconds);
        sanitizedUpdates.dynamicDnsCheckIntervalSeconds = Number.isFinite(intervalSeconds)
          ? Math.min(3600, Math.max(60, Math.trunc(intervalSeconds)))
          : 60;
      }

      if (Object.prototype.hasOwnProperty.call(sanitizedUpdates, 'dynamicDnsAzureTtlSeconds')) {
        const ttlSeconds = Number(sanitizedUpdates.dynamicDnsAzureTtlSeconds);
        sanitizedUpdates.dynamicDnsAzureTtlSeconds = Number.isFinite(ttlSeconds)
          ? Math.min(86400, Math.max(30, Math.trunc(ttlSeconds)))
          : 60;
      }

      if (typeof sanitizedUpdates.dynamicDnsProvider === 'string') {
        const normalizedProvider = sanitizedUpdates.dynamicDnsProvider.trim().toLowerCase();
        if (normalizedProvider === 'azure') {
          sanitizedUpdates.dynamicDnsProvider = normalizedProvider;
        } else {
          delete sanitizedUpdates.dynamicDnsProvider;
        }
      }

      if (typeof sanitizedUpdates.codexHomeProfile === 'string') {
        const normalizedProfile = sanitizedUpdates.codexHomeProfile.trim().toLowerCase();
        const validProfiles = new Set(['auto', 'azure', 'aws', 'local', 'custom']);
        if (validProfiles.has(normalizedProfile)) {
          sanitizedUpdates.codexHomeProfile = normalizedProfile;
        } else {
          delete sanitizedUpdates.codexHomeProfile;
        }
      }

      if (
        typeof sanitizedUpdates.codexHomeProfile === 'string' &&
        sanitizedUpdates.codexHomeProfile !== 'aws' &&
        Object.prototype.hasOwnProperty.call(sanitizedUpdates, 'codexAwsVolumeRoot')
      ) {
        delete sanitizedUpdates.codexAwsVolumeRoot;
      }

      if (typeof sanitizedUpdates.deviceRestartScheduleFrequency === 'string') {
        const normalizedFrequency = sanitizedUpdates.deviceRestartScheduleFrequency.trim().toLowerCase();
        const validFrequencies = new Set(['daily', 'weekly', 'biweekly']);
        if (validFrequencies.has(normalizedFrequency)) {
          sanitizedUpdates.deviceRestartScheduleFrequency = normalizedFrequency;
        } else {
          delete sanitizedUpdates.deviceRestartScheduleFrequency;
        }
      }

      if (Object.prototype.hasOwnProperty.call(sanitizedUpdates, 'deviceRestartScheduleDayOfWeek')) {
        const normalizedDay = Number(sanitizedUpdates.deviceRestartScheduleDayOfWeek);
        sanitizedUpdates.deviceRestartScheduleDayOfWeek = Number.isFinite(normalizedDay)
          ? Math.min(6, Math.max(0, Math.trunc(normalizedDay)))
          : 0;
      }

      if (typeof sanitizedUpdates.deviceRestartScheduleTime === 'string') {
        const trimmedScheduleTime = sanitizedUpdates.deviceRestartScheduleTime.trim();
        const match = trimmedScheduleTime.match(/^(\d{1,2}):(\d{2})$/);
        const hour = match ? Number(match[1]) : NaN;
        const minute = match ? Number(match[2]) : NaN;
        if (
          match &&
          Number.isInteger(hour) &&
          Number.isInteger(minute) &&
          hour >= 0 &&
          hour <= 23 &&
          minute >= 0 &&
          minute <= 59
        ) {
          sanitizedUpdates.deviceRestartScheduleTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        } else {
          delete sanitizedUpdates.deviceRestartScheduleTime;
        }
      }

      if (typeof sanitizedUpdates.smbBackupScheduleTime === 'string') {
        const trimmedScheduleTime = sanitizedUpdates.smbBackupScheduleTime.trim();
        const match = trimmedScheduleTime.match(/^(\d{1,2}):(\d{2})$/);
        const hour = match ? Number(match[1]) : NaN;
        const minute = match ? Number(match[2]) : NaN;
        if (
          match &&
          Number.isInteger(hour) &&
          Number.isInteger(minute) &&
          hour >= 0 &&
          hour <= 23 &&
          minute >= 0 &&
          minute <= 59
        ) {
          sanitizedUpdates.smbBackupScheduleTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
        } else {
          delete sanitizedUpdates.smbBackupScheduleTime;
        }
      }
      
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

  async getSanitizedSetting(key) {
    try {
      console.log('SettingsService: Getting sanitized setting:', String(key || ''));
      const settings = await this.getSettings();
      const value = settings[key];
      return this.isSensitiveField(key) ? maskSecretValue(value) : value;
    } catch (error) {
      console.error('SettingsService: Error getting sanitized setting:', String(key || ''), error.message);
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

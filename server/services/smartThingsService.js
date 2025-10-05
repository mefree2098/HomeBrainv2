const axios = require('axios');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const Settings = require('../models/Settings');

class SmartThingsService {
  constructor() {
    this.baseUrl = 'https://api.smartthings.com/v1';
    this.authUrl = 'https://api.smartthings.com/oauth/authorize';
    this.tokenUrl = 'https://api.smartthings.com/oauth/token';
  }

  /**
   * Get OAuth authorization URL
   * @returns {Promise<string>} Authorization URL
   */
  async getAuthorizationUrl() {
    try {
      console.log('SmartThingsService: Generating OAuth authorization URL');

      const integration = await SmartThingsIntegration.getIntegration();

      if (!integration.clientId || !integration.redirectUri) {
        throw new Error('SmartThings OAuth configuration incomplete. Please configure Client ID and Redirect URI.');
      }

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: integration.clientId,
        redirect_uri: integration.redirectUri,
        scope: integration.scope.join(' '),
        state: Date.now().toString() // Simple state for CSRF protection
      });

      const authUrl = `${this.authUrl}?${params.toString()}`;
      console.log('SmartThingsService: Authorization URL generated successfully');

      return authUrl;
    } catch (error) {
      console.error('SmartThingsService: Error generating authorization URL:', error.message);
      throw error;
    }
  }

  /**
   * Exchange authorization code for access token
   * @param {string} code - Authorization code from SmartThings
   * @param {string} state - State parameter for CSRF protection
   * @returns {Promise<Object>} Token response
   */
  async exchangeCodeForToken(code, state) {
    try {
      console.log('SmartThingsService: Exchanging authorization code for tokens');

      const integration = await SmartThingsIntegration.getIntegration();

      if (!integration.clientId || !integration.clientSecret || !integration.redirectUri) {
        throw new Error('SmartThings OAuth configuration incomplete');
      }

      const tokenData = {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: integration.redirectUri,
        client_id: integration.clientId,
        client_secret: integration.clientSecret
      };

      const response = await axios.post(this.tokenUrl, tokenData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      await integration.updateTokens(response.data);

      console.log('SmartThingsService: Successfully exchanged code for tokens');
      return response.data;
    } catch (error) {
      console.error('SmartThingsService: Error exchanging code for token:', error.response?.data || error.message);
      throw new Error('Failed to exchange authorization code for access token');
    }
  }

  /**
   * Refresh access token using refresh token
   * @returns {Promise<Object>} New token data
   */
  async refreshAccessToken() {
    try {
      console.log('SmartThingsService: Refreshing access token');

      const integration = await SmartThingsIntegration.getIntegration();

      if (!integration.refreshToken) {
        throw new Error('No refresh token available');
      }

      const tokenData = {
        grant_type: 'refresh_token',
        refresh_token: integration.refreshToken,
        client_id: integration.clientId,
        client_secret: integration.clientSecret
      };

      const response = await axios.post(this.tokenUrl, tokenData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      await integration.updateTokens(response.data);

      console.log('SmartThingsService: Access token refreshed successfully');
      return response.data;
    } catch (error) {
      console.error('SmartThingsService: Error refreshing access token:', error.response?.data || error.message);

      // Clear tokens if refresh fails
      const integration = await SmartThingsIntegration.getIntegration();
      await integration.clearTokens('Refresh token failed');

      throw new Error('Failed to refresh access token');
    }
  }

  /**
   * Get valid access token (refreshing if necessary)
   * @returns {Promise<string>} Valid access token
   */
  async getValidAccessToken() {
    try {
      const integration = await SmartThingsIntegration.getIntegration();

      // Check if we should use OAuth or fallback to PAT
      const settings = await Settings.getSettings();
      if (!settings.smartthingsUseOAuth && settings.smartthingsToken) {
        console.log('SmartThingsService: Using Personal Access Token (PAT)');
        return settings.smartthingsToken;
      }

      if (!integration.accessToken) {
        throw new Error('No access token available. Please authorize the application.');
      }

      if (integration.isTokenValid()) {
        return integration.accessToken;
      }

      // Token is expired, try to refresh
      console.log('SmartThingsService: Access token expired, attempting refresh');
      await this.refreshAccessToken();

      const refreshedIntegration = await SmartThingsIntegration.getIntegration();
      return refreshedIntegration.accessToken;
    } catch (error) {
      console.error('SmartThingsService: Error getting valid access token:', error.message);
      throw error;
    }
  }

  /**
   * Make authenticated request to SmartThings API
   * @param {string} endpoint - API endpoint (without base URL)
   * @param {Object} options - Axios options
   * @returns {Promise<Object>} API response
   */
  async makeAuthenticatedRequest(endpoint, options = {}) {
    try {
      const accessToken = await this.getValidAccessToken();

      const config = {
        ...options,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...options.headers
        },
        timeout: 10000
      };

      const response = await axios({
        url: `${this.baseUrl}${endpoint}`,
        ...config
      });

      return response.data;
    } catch (error) {
      console.error(`SmartThingsService: API request failed for ${endpoint}:`, error.response?.data || error.message);

      // If unauthorized, clear tokens and require re-authorization
      if (error.response?.status === 401) {
        const integration = await SmartThingsIntegration.getIntegration();
        await integration.clearTokens('Access token invalid');
      }

      throw new Error(`SmartThings API request failed: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Get all devices with status and health information
   * @returns {Promise<Array>} List of devices with status
   */
  async getDevices() {
    try {
      console.log('SmartThingsService: Fetching devices');

      const data = await this.makeAuthenticatedRequest('/devices?includeStatus=true&includeHealth=true');

      const integration = await SmartThingsIntegration.getIntegration();
      await integration.updateDevices(data.items || []);

      console.log(`SmartThingsService: Successfully fetched ${data.items?.length || 0} devices`);
      return data.items || [];
    } catch (error) {
      console.error('SmartThingsService: Error fetching devices:', error.message);
      throw error;
    }
  }

  /**
   * Get single device details
   * @param {string} deviceId - Device ID
   * @returns {Promise<Object>} Device details
   */
  async getDevice(deviceId) {
    try {
      console.log(`SmartThingsService: Fetching device details for ${deviceId}`);

      const data = await this.makeAuthenticatedRequest(`/devices/${deviceId}`);

      console.log('SmartThingsService: Successfully fetched device details');
      return data;
    } catch (error) {
      console.error('SmartThingsService: Error fetching device:', error.message);
      throw error;
    }
  }

  /**
   * Get device status
   * @param {string} deviceId - Device ID
   * @returns {Promise<Object>} Device status
   */
  async getDeviceStatus(deviceId) {
    try {
      console.log(`SmartThingsService: Fetching device status for ${deviceId}`);

      const data = await this.makeAuthenticatedRequest(`/devices/${deviceId}/status`);

      console.log('SmartThingsService: Successfully fetched device status');
      return data;
    } catch (error) {
      console.error('SmartThingsService: Error fetching device status:', error.message);
      throw error;
    }
  }

  /**
   * Send command to device
   * @param {string} deviceId - Device ID
   * @param {Array} commands - Array of command objects
   * @returns {Promise<Object>} Command response
   */
  async sendDeviceCommand(deviceId, commands) {
    try {
      console.log(`SmartThingsService: Sending command to device ${deviceId}`);

      const data = await this.makeAuthenticatedRequest(`/devices/${deviceId}/commands`, {
        method: 'POST',
        data: { commands }
      });

      console.log('SmartThingsService: Command sent successfully');
      return data;
    } catch (error) {
      console.error('SmartThingsService: Error sending device command:', error.message);
      throw error;
    }
  }

  /**
   * Turn device on
   * @param {string} deviceId - Device ID
   * @returns {Promise<Object>} Command response
   */
  async turnDeviceOn(deviceId) {
    const command = [{
      component: 'main',
      capability: 'switch',
      command: 'on'
    }];
    return this.sendDeviceCommand(deviceId, command);
  }

  /**
   * Turn device off
   * @param {string} deviceId - Device ID
   * @returns {Promise<Object>} Command response
   */
  async turnDeviceOff(deviceId) {
    const command = [{
      component: 'main',
      capability: 'switch',
      command: 'off'
    }];
    return this.sendDeviceCommand(deviceId, command);
  }

  /**
   * Set device level (for dimmable devices)
   * @param {string} deviceId - Device ID
   * @param {number} level - Level (0-100)
   * @returns {Promise<Object>} Command response
   */
  async setDeviceLevel(deviceId, level) {
    const command = [{
      component: 'main',
      capability: 'switchLevel',
      command: 'setLevel',
      arguments: [level]
    }];
    return this.sendDeviceCommand(deviceId, command);
  }

  /**
   * Get all scenes
   * @returns {Promise<Array>} List of scenes
   */
  async getScenes() {
    try {
      console.log('SmartThingsService: Fetching scenes');

      const data = await this.makeAuthenticatedRequest('/scenes');

      console.log(`SmartThingsService: Successfully fetched ${data.items?.length || 0} scenes`);
      return data.items || [];
    } catch (error) {
      console.error('SmartThingsService: Error fetching scenes:', error.message);
      throw error;
    }
  }

  /**
   * Execute scene
   * @param {string} sceneId - Scene ID
   * @returns {Promise<Object>} Execution response
   */
  async executeScene(sceneId) {
    try {
      console.log(`SmartThingsService: Executing scene ${sceneId}`);

      const data = await this.makeAuthenticatedRequest(`/scenes/${sceneId}/execute`, {
        method: 'POST'
      });

      console.log('SmartThingsService: Scene executed successfully');
      return data;
    } catch (error) {
      console.error('SmartThingsService: Error executing scene:', error.message);
      throw error;
    }
  }

  /**
   * Configure STHM virtual switches
   * @param {Object} sthm - STHM device IDs
   * @returns {Promise<Object>} Updated integration
   */
  async configureSthm(sthm) {
    try {
      console.log('SmartThingsService: Configuring STHM virtual switches');

      const integration = await SmartThingsIntegration.getIntegration();
      integration.sthm = {
        armAwayDeviceId: sthm.armAwayDeviceId || '',
        armStayDeviceId: sthm.armStayDeviceId || '',
        disarmDeviceId: sthm.disarmDeviceId || ''
      };

      await integration.save();

      console.log('SmartThingsService: STHM configuration updated successfully');
      return integration;
    } catch (error) {
      console.error('SmartThingsService: Error configuring STHM:', error.message);
      throw error;
    }
  }

  /**
   * Arm STHM (Stay mode) using virtual switch
   * @returns {Promise<Object>} Command response
   */
  async armSthmStay() {
    try {
      const integration = await SmartThingsIntegration.getIntegration();

      if (!integration.sthm.armStayDeviceId) {
        throw new Error('STHM Arm Stay virtual switch not configured');
      }

      console.log('SmartThingsService: Arming STHM (Stay mode)');
      return this.turnDeviceOn(integration.sthm.armStayDeviceId);
    } catch (error) {
      console.error('SmartThingsService: Error arming STHM (Stay):', error.message);
      throw error;
    }
  }

  /**
   * Arm STHM (Away mode) using virtual switch
   * @returns {Promise<Object>} Command response
   */
  async armSthmAway() {
    try {
      const integration = await SmartThingsIntegration.getIntegration();

      if (!integration.sthm.armAwayDeviceId) {
        throw new Error('STHM Arm Away virtual switch not configured');
      }

      console.log('SmartThingsService: Arming STHM (Away mode)');
      return this.turnDeviceOn(integration.sthm.armAwayDeviceId);
    } catch (error) {
      console.error('SmartThingsService: Error arming STHM (Away):', error.message);
      throw error;
    }
  }

  /**
   * Disarm STHM using virtual switch
   * @returns {Promise<Object>} Command response
   */
  async disarmSthm() {
    try {
      const integration = await SmartThingsIntegration.getIntegration();

      if (!integration.sthm.disarmDeviceId) {
        throw new Error('STHM Disarm virtual switch not configured');
      }

      console.log('SmartThingsService: Disarming STHM');
      return this.turnDeviceOn(integration.sthm.disarmDeviceId);
    } catch (error) {
      console.error('SmartThingsService: Error disarming STHM:', error.message);
      throw error;
    }
  }

  /**
   * Test connection with current tokens
   * @returns {Promise<Object>} Connection test result
   */
  async testConnection() {
    try {
      console.log('SmartThingsService: Testing connection');

      const devices = await this.getDevices();

      const integration = await SmartThingsIntegration.getIntegration();

      // Only update if integration has save method (is an actual database document)
      if (typeof integration.save === 'function') {
        integration.isConnected = true;
        integration.lastError = '';
        await integration.save();
      }

      console.log('SmartThingsService: Connection test successful');
      return {
        success: true,
        message: 'SmartThings connection successful',
        deviceCount: devices.length
      };
    } catch (error) {
      console.error('SmartThingsService: Connection test failed:', error.message);

      const integration = await SmartThingsIntegration.getIntegration();

      // Only update if integration has save method (is an actual database document)
      if (typeof integration.save === 'function') {
        integration.isConnected = false;
        integration.lastError = error.message;
        await integration.save();
      }

      throw error;
    }
  }

  /**
   * Disconnect and clear all tokens
   * @returns {Promise<void>}
   */
  async disconnect() {
    try {
      console.log('SmartThingsService: Disconnecting SmartThings integration');

      const integration = await SmartThingsIntegration.getIntegration();

      // Check if integration has clearTokens method (actual database document)
      if (integration && typeof integration.clearTokens === 'function') {
        await integration.clearTokens('User disconnected');
        console.log('SmartThingsService: Tokens cleared from database integration');
      } else {
        // If no actual integration exists, just delete any existing documents
        await SmartThingsIntegration.deleteMany({});
        console.log('SmartThingsService: Cleared any existing integration documents');
      }

      console.log('SmartThingsService: Successfully disconnected');
    } catch (error) {
      console.error('SmartThingsService: Error disconnecting:', error.message);
      throw error;
    }
  }
}

module.exports = new SmartThingsService();
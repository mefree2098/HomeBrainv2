const axios = require('axios');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const Settings = require('../models/Settings');
const Device = require('../models/Device');

class SmartThingsService {
  constructor() {
    this.baseUrl = 'https://api.smartthings.com/v1';
    this.authUrl = 'https://api.smartthings.com/oauth/authorize';
    this.tokenUrl = 'https://api.smartthings.com/oauth/token';
    this.roomsCache = new Map();
    this.locationNameCache = new Map();
  }

  /**
   * Get OAuth authorization URL
   * @returns {Promise<string>} Authorization URL
   */
  async getAuthorizationUrl() {
    try {
      console.log('SmartThingsService: Generating OAuth authorization URL');

      const integration = await SmartThingsIntegration.getIntegration();

      const clientId = integration.clientId ? integration.clientId.trim() : '';
      const redirectUri = integration.redirectUri ? integration.redirectUri.trim() : '';
      const scope = Array.isArray(integration.scope) && integration.scope.length > 0
        ? integration.scope
        : ['r:devices:*', 'x:devices:*', 'r:scenes:*', 'x:scenes:*', 'r:locations:*'];

      if (!clientId || !redirectUri) {
        throw new Error('SmartThings OAuth configuration incomplete. Please configure Client ID and Redirect URI.');
      }

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scope.join(' '),
        state: Date.now().toString() // Simple state for CSRF protection
      });

      console.log('SmartThingsService: Authorization context', {
        clientId,
        redirectUri,
        scope,
        authUrl: `${this.authUrl}?${params.toString()}`
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
      const startTime = Date.now();
      console.log('SmartThingsService: Exchanging authorization code for tokens');

      const integration = await SmartThingsIntegration.getIntegration();

      const clientId = integration.clientId ? integration.clientId.trim() : '';
      const clientSecret = integration.clientSecret ? integration.clientSecret.trim() : '';
      const redirectUri = integration.redirectUri ? integration.redirectUri.trim() : '';

      if (!clientId || !clientSecret || !redirectUri) {
        throw new Error('SmartThings OAuth configuration incomplete');
      }

      const tokenData = new URLSearchParams();
      tokenData.append('grant_type', 'authorization_code');
      tokenData.append('code', code);
      tokenData.append('redirect_uri', redirectUri);
      tokenData.append('client_id', clientId);
      tokenData.append('client_secret', clientSecret);

      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');

      const response = await axios.post(this.tokenUrl, tokenData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          Authorization: `Basic ${basicAuth}`,
          'User-Agent': 'HomeBrain/SmartThingsIntegration'
        },
        timeout: 10000
      });

      console.log('SmartThingsService: Token exchange response', {
        status: response.status,
        tookMs: Date.now() - startTime
      });

      await integration.updateTokens(response.data);

      console.log('SmartThingsService: Successfully exchanged code for tokens');
      return response.data;
    } catch (error) {
      const errorDetails = error.response?.data?.error_description || error.response?.data?.message || error.response?.data?.error?.message || error.response?.data?.error || error.message;
      console.error('SmartThingsService: Error exchanging code for token:', {
        status: error.response?.status,
        data: error.response?.data,
        headers: error.response?.headers,
        message: error.message
      });
      throw new Error(`Failed to exchange authorization code for access token: ${errorDetails || 'Unknown error'}`);
    }
  }

  /**
   * Refresh access token using refresh token
   * @returns {Promise<Object>} New token data
   */
  async refreshAccessToken() {
    try {
      const startTime = Date.now();
      console.log('SmartThingsService: Refreshing access token');

      const integration = await SmartThingsIntegration.getIntegration();

      const clientId = integration.clientId ? integration.clientId.trim() : '';
      const clientSecret = integration.clientSecret ? integration.clientSecret.trim() : '';

      if (!integration.refreshToken) {
        throw new Error('No refresh token available');
      }

      if (!clientId || !clientSecret) {
        throw new Error('SmartThings OAuth configuration incomplete');
      }

      const tokenData = new URLSearchParams();
      tokenData.append('grant_type', 'refresh_token');
      tokenData.append('refresh_token', integration.refreshToken);
      tokenData.append('client_id', clientId);
      tokenData.append('client_secret', clientSecret);

      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');

      const response = await axios.post(this.tokenUrl, tokenData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          Authorization: `Basic ${basicAuth}`,
          'User-Agent': 'HomeBrain/SmartThingsIntegration'
        },
        timeout: 10000
      });

      console.log('SmartThingsService: Refresh response', {
        status: response.status,
        tookMs: Date.now() - startTime
      });

      await integration.updateTokens(response.data);

      console.log('SmartThingsService: Access token refreshed successfully');
      return response.data;
    } catch (error) {
      const errorDetails = error.response?.data?.error_description || error.response?.data?.message || error.response?.data?.error?.message || error.response?.data?.error || error.message;
      console.error('SmartThingsService: Error refreshing access token:', {
        status: error.response?.status,
        data: error.response?.data,
        headers: error.response?.headers,
        message: error.message
      });

      // Clear tokens if refresh fails
      const integration = await SmartThingsIntegration.getIntegration();
      await integration.clearTokens('Refresh token failed');

      throw new Error(`Failed to refresh access token: ${errorDetails || 'Unknown error'}`);
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

      const apiError = new Error(`SmartThings API request failed: ${error.response?.data?.message || error.message}`);
      apiError.status = error.response?.status;
      apiError.data = error.response?.data;
      throw apiError;
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

  async getRoomName(locationId, roomId) {
    if (!locationId || !roomId) {
      return null;
    }

    if (!this.roomsCache.has(locationId)) {
      try {
        const response = await this.makeAuthenticatedRequest(`/locations/${locationId}/rooms`);
        const roomMap = new Map();
        (response?.items || []).forEach((room) => {
          if (room?.roomId || room?.id) {
            roomMap.set(room.roomId || room.id, room.name || '');
          }
        });
        this.roomsCache.set(locationId, roomMap);
      } catch (error) {
        console.warn(`SmartThingsService: Unable to fetch rooms for location ${locationId}: ${error.message}`);
        this.roomsCache.set(locationId, new Map());
      }
    }

    const rooms = this.roomsCache.get(locationId);
    return rooms?.get(roomId) || null;
  }

  async getLocationName(locationId) {
    if (!locationId) {
      return null;
    }

    if (this.locationNameCache.has(locationId)) {
      return this.locationNameCache.get(locationId);
    }

    try {
      const response = await this.makeAuthenticatedRequest(`/locations/${locationId}`);
      const name = response?.name || null;
      this.locationNameCache.set(locationId, name);
      return name;
    } catch (error) {
      console.warn(`SmartThingsService: Unable to fetch location ${locationId}: ${error.message}`);
      this.locationNameCache.set(locationId, null);
      return null;
    }
  }

  normalizeArmState(state) {
    if (!state) {
      throw new Error('Arm state is required');
    }

    const normalized = state.toString().trim().toLowerCase();

    if (normalized === 'disarmed' || normalized === 'disarm') {
      return 'Disarmed';
    }

    if (normalized === 'armedstay' || normalized === 'stay' || normalized === 'armstay' || normalized === 'armed_stay') {
      return 'ArmedStay';
    }

    if (normalized === 'armedaway' || normalized === 'away' || normalized === 'armaway' || normalized === 'armed_away') {
      return 'ArmedAway';
    }

    throw new Error(`Unsupported SmartThings arm state: ${state}`);
  }

  async resolveLocationId(locationId) {
    if (locationId) {
      return locationId.trim();
    }

    const integration = await SmartThingsIntegration.getIntegration();

    if (integration?.sthm?.locationId) {
      return integration.sthm.locationId;
    }

    const connectedDeviceWithLocation = integration?.connectedDevices?.find(device => device.locationId);
    if (connectedDeviceWithLocation) {
      return connectedDeviceWithLocation.locationId;
    }

    const anySmartThingsDevice = await Device.findOne({ 'properties.source': 'smartthings', 'properties.smartThingsLocationId': { $exists: true, $ne: null } });
    if (anySmartThingsDevice?.properties?.smartThingsLocationId) {
      return anySmartThingsDevice.properties.smartThingsLocationId;
    }

    throw new Error('Unable to determine SmartThings location ID. Please ensure at least one device is synced.');
  }

  async getSecurityArmState(locationId) {
    const resolvedLocationId = await this.resolveLocationId(locationId);

    const candidateEndpoints = [
      `/locations/${resolvedLocationId}/security/armState`,
      `/locations/${resolvedLocationId}/security/arm-state`
    ];

    let response = null;

    for (const endpoint of candidateEndpoints) {
      try {
        response = await this.makeAuthenticatedRequest(endpoint);
        break;
      } catch (error) {
        if (error.status && error.status === 404) {
          continue;
        }
        throw error;
      }
    }

    if (!response) {
      throw new Error('SmartThings security arm state endpoint is unavailable');
    }

    const armState = response?.armState || response?.location?.security?.armState || null;
    const normalizedState = armState ? this.normalizeArmState(armState) : null;

    const integration = await SmartThingsIntegration.getIntegration();
    if (integration && typeof integration.updateSecurityArmState === 'function' && normalizedState) {
      await integration.updateSecurityArmState({ armState: normalizedState, locationId: resolvedLocationId });
    }

    return {
      locationId: resolvedLocationId,
      armState: normalizedState,
      raw: response
    };
  }

  async setSecurityArmState(state, locationId) {
    const normalizedState = this.normalizeArmState(state);
    const resolvedLocationId = await this.resolveLocationId(locationId);

    const candidateEndpoints = [
      { method: 'POST', path: `/locations/${resolvedLocationId}/security/armState` },
      { method: 'PUT', path: `/locations/${resolvedLocationId}/security/armState` },
      { method: 'POST', path: `/locations/${resolvedLocationId}/security/arm-state` },
      { method: 'PUT', path: `/locations/${resolvedLocationId}/security/arm-state` }
    ];

    let appliedDirect = false;

    for (const endpoint of candidateEndpoints) {
      try {
        await this.makeAuthenticatedRequest(endpoint.path, {
          method: endpoint.method,
          data: { armState: normalizedState }
        });
        appliedDirect = true;
        break;
      } catch (error) {
        if (error.status && ![404, 405].includes(error.status)) {
          throw error;
        }
      }
    }

    if (!appliedDirect) {
      console.warn('SmartThingsService: Direct security arm endpoint unavailable, falling back to Rules API');

      const ruleName = `HomeBrain STHM ${normalizedState} ${Date.now()}`;
      const rulePayload = {
        name: ruleName,
        actions: [
          {
            type: 'location',
            location: {
              security: {
                armState: normalizedState
              }
            }
          }
        ]
      };

      const rulesBasePath = `/rules?locationId=${encodeURIComponent(resolvedLocationId)}`;

      const ruleResponse = await this.makeAuthenticatedRequest(rulesBasePath, {
        method: 'POST',
        data: rulePayload
      });

      const ruleId = ruleResponse?.id || ruleResponse?.ruleId;
      if (!ruleId) {
        throw new Error('Failed to create SmartThings rule for arming state');
      }

      try {
        await this.makeAuthenticatedRequest(`/rules/${ruleId}/execute?locationId=${encodeURIComponent(resolvedLocationId)}`, { method: 'POST' });
      } finally {
        await this.makeAuthenticatedRequest(`/rules/${ruleId}?locationId=${encodeURIComponent(resolvedLocationId)}`, { method: 'DELETE' }).catch((cleanupError) => {
          console.warn(`SmartThingsService: Failed to delete temporary rule ${ruleId}: ${cleanupError.message}`);
        });
      }
    }

    const integration = await SmartThingsIntegration.getIntegration();
    if (integration && typeof integration.updateSecurityArmState === 'function') {
      await integration.updateSecurityArmState({ armState: normalizedState, locationId: resolvedLocationId });
    }

    return {
      locationId: resolvedLocationId,
      armState: normalizedState
    };
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
        ...(integration.sthm || {}),
        armAwayDeviceId: sthm.armAwayDeviceId || '',
        armStayDeviceId: sthm.armStayDeviceId || '',
        disarmDeviceId: sthm.disarmDeviceId || '',
        locationId: sthm.locationId || integration.sthm?.locationId || ''
      };

      await integration.save();

      if (sthm.locationId && typeof integration.updateSecurityArmState === 'function') {
        await integration.updateSecurityArmState({ locationId: sthm.locationId });
      }

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
      console.log('SmartThingsService: Arming STHM (Stay mode)');
      return this.setSecurityArmState('ArmedStay');
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
      console.log('SmartThingsService: Arming STHM (Away mode)');
      return this.setSecurityArmState('ArmedAway');
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
      console.log('SmartThingsService: Disarming STHM');
      return this.setSecurityArmState('Disarmed');
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

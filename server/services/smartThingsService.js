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
    this.deviceStatusSyncIntervalMs = Number(process.env.SMARTTHINGS_DEVICE_SYNC_INTERVAL_MS || 60000);
    this.deviceStatusSyncTimer = null;
    this.deviceStatusSyncInProgress = false;
    if (this.deviceStatusSyncIntervalMs > 0) {
      this.startDeviceStatusSync();
    }
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

  startDeviceStatusSync() {
    if (this.deviceStatusSyncTimer) {
      clearInterval(this.deviceStatusSyncTimer);
    }

    const intervalMs = Math.max(this.deviceStatusSyncIntervalMs, 15000);

    this.deviceStatusSyncTimer = setInterval(() => {
      this.runDeviceStatusSync().catch((error) => {
        console.error('SmartThingsService: Device status sync error:', error.message);
      });
    }, intervalMs);

    if (typeof this.deviceStatusSyncTimer.unref === 'function') {
      this.deviceStatusSyncTimer.unref();
    }

    setImmediate(() => {
      this.runDeviceStatusSync().catch((error) => {
        console.error('SmartThingsService: Initial device status sync error:', error.message);
      });
    });
  }

  async runDeviceStatusSync() {
    if (this.deviceStatusSyncInProgress) {
      return;
    }

    this.deviceStatusSyncInProgress = true;

    try {
      const integration = await SmartThingsIntegration.findOne();
      if (!integration || !integration.isConfigured) {
        return;
      }

      if (!integration.accessToken && !integration.refreshToken) {
        return;
      }

      const trackedDevices = await Device.find({ 'properties.source': 'smartthings', 'properties.smartThingsDeviceId': { $exists: true } });
      if (trackedDevices.length === 0) {
        return;
      }

      const deviceResponse = await this.makeAuthenticatedRequest('/devices?includeStatus=true&includeHealth=true');
      const apiDevices = Array.isArray(deviceResponse?.items) ? deviceResponse.items : [];
      if (apiDevices.length === 0) {
        return;
      }

      const trackedMap = new Map();
      trackedDevices.forEach((doc) => {
        const smartThingsId = doc?.properties?.smartThingsDeviceId;
        if (smartThingsId) {
          trackedMap.set(smartThingsId, doc);
        }
      });

      if (trackedMap.size === 0) {
        return;
      }

      const bulkOps = [];
      let updatedCount = 0;

      for (const device of apiDevices) {
        const tracked = trackedMap.get(device.deviceId);
        if (!tracked) {
          continue;
        }

        const updates = await this.buildSmartThingsDeviceUpdate(tracked, device);
        if (updates) {
          bulkOps.push({
            updateOne: {
              filter: { _id: tracked._id },
              update: { $set: updates }
            }
          });
          updatedCount += 1;
        }
      }

      if (bulkOps.length > 0) {
        await Device.bulkWrite(bulkOps, { ordered: false });
        console.log(`SmartThingsService: Updated state for ${updatedCount} SmartThings devices`);
      }
    } catch (error) {
      console.error('SmartThingsService: Device status sync failure:', error.message);
    } finally {
      this.deviceStatusSyncInProgress = false;
    }
  }

  async buildSmartThingsDeviceUpdate(existingDevice, apiDevice) {
    const updates = {};
    let changed = false;

    const capabilities = this.collectSmartThingsCapabilities(apiDevice);
    const statusRoot = this.extractStatusRoot(apiDevice);
    const detectedType = existingDevice.type || this.mapSmartThingsType(capabilities, apiDevice);
    if (!detectedType) {
      return null;
    }

    const isOnline = (apiDevice.healthState?.state || '').toUpperCase() === 'ONLINE';

    const statusValue = this.mapSmartThingsStatus(detectedType, capabilities, statusRoot, isOnline);
    if (typeof statusValue === 'boolean' && statusValue !== existingDevice.status) {
      updates.status = statusValue;
      changed = true;
    }

    const brightnessValue = this.mapSmartThingsBrightness(capabilities, statusRoot);
    if (typeof brightnessValue === 'number' && brightnessValue !== existingDevice.brightness) {
      updates.brightness = brightnessValue;
      changed = true;
    }

    const temperatureValue = this.mapSmartThingsTemperature(statusRoot);
    if (typeof temperatureValue === 'number' && temperatureValue !== existingDevice.temperature) {
      updates.temperature = temperatureValue;
      changed = true;
    }

    const targetTemperatureValue = this.mapSmartThingsTargetTemperature(statusRoot);
    if (typeof targetTemperatureValue === 'number' && targetTemperatureValue !== existingDevice.targetTemperature) {
      updates.targetTemperature = targetTemperatureValue;
      changed = true;
    }

    if (isOnline !== existingDevice.isOnline) {
      updates.isOnline = isOnline;
      changed = true;
    }

    const lastSeen = apiDevice.healthState?.lastUpdatedDate ? new Date(apiDevice.healthState.lastUpdatedDate) : new Date();
    const existingLastSeen = existingDevice.lastSeen instanceof Date ? existingDevice.lastSeen.getTime() : null;
    if (existingLastSeen !== lastSeen.getTime()) {
      updates.lastSeen = lastSeen;
      changed = true;
    }

    const nextHealthState = apiDevice.healthState || null;
    const currentHealthState = existingDevice?.properties?.smartThingsHealthState || null;
    if (JSON.stringify(currentHealthState) !== JSON.stringify(nextHealthState)) {
      updates['properties.smartThingsHealthState'] = nextHealthState;
      changed = true;
    }

    const preferredName = (apiDevice.label || apiDevice.name || '').trim();
    if (preferredName && preferredName !== existingDevice.name) {
      updates.name = preferredName;
      changed = true;
    }

    if (apiDevice.locationId && apiDevice.roomId) {
      const roomName = await this.getRoomName(apiDevice.locationId, apiDevice.roomId);
      if (roomName && roomName !== existingDevice.room) {
        updates.room = roomName;
        changed = true;
      }
    }

    updates.updatedAt = new Date();

    return changed ? updates : null;
  }

  collectSmartThingsCapabilities(device) {
    const capabilities = new Set();

    (device.components || []).forEach((component) => {
      (component.capabilities || []).forEach((capability) => {
        if (capability?.id) {
          capabilities.add(capability.id);
        }
      });
    });

    return capabilities;
  }

  mapSmartThingsType(capabilities, device) {
    const categories = new Set();
    (device.components || []).forEach((component) => {
      (component.categories || []).forEach((category) => {
        if (category?.name) {
          categories.add(category.name.toLowerCase());
        }
      });
    });

    if (capabilities.has('thermostatMode') || capabilities.has('thermostatCoolingSetpoint') || capabilities.has('thermostatHeatingSetpoint') || categories.has('thermostat')) {
      return 'thermostat';
    }

    if (capabilities.has('lock') || categories.has('lock')) {
      return 'lock';
    }

    if (capabilities.has('garageDoorControl') || capabilities.has('doorControl') || categories.has('garageDoor') || categories.has('garage')) {
      return 'garage';
    }

    if (capabilities.has('switchLevel') || capabilities.has('colorControl') || categories.has('light')) {
      return 'light';
    }

    if (capabilities.has('switch') || categories.has('switch')) {
      return 'switch';
    }

    if (
      capabilities.has('motionSensor') ||
      capabilities.has('contactSensor') ||
      capabilities.has('presenceSensor') ||
      capabilities.has('waterSensor') ||
      capabilities.has('humidityMeasurement') ||
      categories.has('sensor')
    ) {
      return 'sensor';
    }

    if (capabilities.has('audioVolume') || categories.has('audio') || categories.has('speaker')) {
      return 'speaker';
    }

    if (categories.has('camera')) {
      return 'camera';
    }

    if (capabilities.size > 0) {
      return 'switch';
    }

    return null;
  }

  extractStatusRoot(device) {
    if (device?.status?.main) {
      return device.status.main;
    }

    if (device?.status?.components?.main) {
      return device.status.components.main;
    }

    return device?.status || {};
  }

  getStatusValue(statusRoot, paths) {
    for (const path of paths) {
      let current = statusRoot;
      let found = true;

      for (const key of path) {
        if (current == null) {
          found = false;
          break;
        }
        current = current[key];
      }

      if (!found || current == null) {
        continue;
      }

      if (typeof current === 'object' && 'value' in current) {
        return current.value;
      }

      return current;
    }

    return undefined;
  }

  mapSmartThingsStatus(type, capabilities, statusRoot, isOnline) {
    const valueFor = (...paths) => this.getStatusValue(statusRoot, paths);

    if (type === 'lock') {
      const state = valueFor(
        ['lock', 'lock', 'value'],
        ['lock', 'lock'],
        ['lock', 'value'],
        ['lock']
      );
      return typeof state === 'string' ? state.toLowerCase() === 'locked' : !!state;
    }

    if (type === 'garage') {
      const state = valueFor(
        ['garageDoorControl', 'door', 'value'],
        ['garageDoorControl', 'door'],
        ['doorControl', 'door', 'value'],
        ['doorControl', 'door']
      );
      return typeof state === 'string' ? ['open', 'opening'].includes(state.toLowerCase()) : !!state;
    }

    if (capabilities.has('switch') || capabilities.has('switchLevel')) {
      const state = valueFor(
        ['switch', 'switch', 'value'],
        ['switch', 'switch'],
        ['switch', 'value'],
        ['switch']
      );
      if (typeof state === 'string') {
        return state.toLowerCase() === 'on';
      }
      if (typeof state === 'boolean') {
        return state;
      }
      return !!state;
    }

    if (capabilities.has('contactSensor')) {
      const state = valueFor(
        ['contactSensor', 'contact', 'value'],
        ['contactSensor', 'contact'],
        ['contactSensor']
      );
      return typeof state === 'string' ? state.toLowerCase() === 'open' : !!state;
    }

    if (capabilities.has('motionSensor')) {
      const state = valueFor(
        ['motionSensor', 'motion', 'value'],
        ['motionSensor', 'motion'],
        ['motionSensor']
      );
      return typeof state === 'string' ? state.toLowerCase() === 'active' : !!state;
    }

    if (type === 'thermostat') {
      const state = valueFor(
        ['thermostatOperatingState', 'operatingState', 'value'],
        ['thermostatOperatingState', 'operatingState'],
        ['thermostatMode', 'thermostatMode', 'value'],
        ['thermostatMode', 'thermostatMode']
      );
      if (typeof state === 'string') {
        return state.toLowerCase() !== 'off' && state.toLowerCase() !== 'idle';
      }
      return !!state;
    }

    return !!isOnline;
  }

  mapSmartThingsBrightness(capabilities, statusRoot) {
    if (!capabilities.has('switchLevel')) {
      return undefined;
    }

    const value = this.getStatusValue(statusRoot, [
      ['switchLevel', 'level', 'value'],
      ['switchLevel', 'level'],
      ['level']
    ]);

    if (value === undefined || value === null) {
      return undefined;
    }

    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
      return undefined;
    }

    return Math.min(Math.max(Math.round(numeric), 0), 100);
  }

  mapSmartThingsTemperature(statusRoot) {
    const value = this.getStatusValue(statusRoot, [
      ['temperatureMeasurement', 'temperature', 'value'],
      ['temperatureMeasurement', 'temperature'],
      ['temperature']
    ]);

    if (value === undefined || value === null) {
      return undefined;
    }

    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
      return undefined;
    }

    return numeric;
  }

  mapSmartThingsTargetTemperature(statusRoot) {
    const value = this.getStatusValue(statusRoot, [
      ['thermostatCoolingSetpoint', 'coolingSetpoint', 'value'],
      ['thermostatCoolingSetpoint', 'coolingSetpoint'],
      ['thermostatHeatingSetpoint', 'heatingSetpoint', 'value'],
      ['thermostatHeatingSetpoint', 'heatingSetpoint']
    ]);

    if (value === undefined || value === null) {
      return undefined;
    }

    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
      return undefined;
    }

    return numeric;
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

    for (const endpoint of candidateEndpoints) {
      try {
        const response = await this.makeAuthenticatedRequest(endpoint);
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
      } catch (error) {
        if (error.status && [404, 405, 422].includes(error.status)) {
          continue;
        }
        throw error;
      }
    }

    return {
      locationId: resolvedLocationId,
      armState: null,
      raw: null
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
          data: {
            armState: normalizedState,
            locationId: resolvedLocationId
          }
        });
        appliedDirect = true;
        break;
      } catch (error) {
        if (!error.status || ![403, 404, 405, 422].includes(error.status)) {
          throw error;
        }

        if (error.status === 403) {
          console.warn(`SmartThingsService: Security arm endpoint denied (403) for ${endpoint.method} ${endpoint.path}, attempting rules fallback`);
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
            location: {
              security: {
                armState: normalizedState
              }
            }
          }
        ]
      };

      try {
        console.debug('SmartThingsService: Creating temporary rule for STHM armState', {
          ruleName,
          normalizedState,
          resolvedLocationId
        });
        console.debug('SmartThingsService: Rule payload', rulePayload);
        const ruleResponse = await this.makeAuthenticatedRequest(`/locations/${resolvedLocationId}/rules`, {
          method: 'POST',
          data: rulePayload,
          headers: {
            'X-ST-Location': resolvedLocationId,
            'X-ST-LOCATION': resolvedLocationId
          }
        });
        console.debug('SmartThingsService: Temporary rule created', ruleResponse);

        const ruleId =
          ruleResponse?.id ||
          ruleResponse?.ruleId ||
          ruleResponse?.rule?.id ||
          (typeof ruleResponse?.rule === 'string' ? ruleResponse.rule : null) ||
          (typeof ruleResponse?.links?.self?.href === 'string'
            ? ruleResponse.links.self.href.split('/').pop()
            : null);
        if (!ruleId) {
          console.error('SmartThingsService: Unexpected rule creation response', ruleResponse);
          throw new Error('Failed to create SmartThings rule for arming state');
        }

        const maxExecutionAttempts = 5;
        let executionAttempt = 0;
        let executionSucceeded = false;
        let lastExecutionError = null;

        while (executionAttempt < maxExecutionAttempts && !executionSucceeded) {
          if (executionAttempt > 0) {
            const backoffMs = Math.min(250 * Math.pow(2, executionAttempt - 1), 2000);
            console.debug(`SmartThingsService: Rule execution retry ${executionAttempt + 1}/${maxExecutionAttempts} after ${backoffMs}ms`, { ruleId });
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }

          try {
            console.debug('SmartThingsService: Executing temporary rule', { ruleId, locationId: resolvedLocationId });
            await this.makeAuthenticatedRequest(`/locations/${resolvedLocationId}/rules/${ruleId}/execute`, {
              method: 'POST',
              headers: {
                'X-ST-Location': resolvedLocationId,
                'X-ST-LOCATION': resolvedLocationId
              }
            });
            executionSucceeded = true;
          } catch (executionError) {
            lastExecutionError = executionError;
            if (executionError.status === 404 && executionAttempt < maxExecutionAttempts - 1) {
              executionAttempt += 1;
              continue;
            }
            throw executionError;
          }
        }

        if (!executionSucceeded) {
          throw lastExecutionError || new Error('Failed to execute SmartThings rule for arming state');
        }

        await this.makeAuthenticatedRequest(`/locations/${resolvedLocationId}/rules/${ruleId}`, {
          method: 'DELETE',
          headers: {
            'X-ST-Location': resolvedLocationId,
            'X-ST-LOCATION': resolvedLocationId
          }
        }).catch((cleanupError) => {
          console.warn(`SmartThingsService: Failed to delete temporary rule ${ruleId}: ${cleanupError.message}`);
        });
      } catch (error) {
        const errorPayload = error.data || error.message;
        console.error('SmartThingsService: Failed to apply security arm state via Rules API:', JSON.stringify(errorPayload, null, 2));

        if (error.status === 403) {
          const scopeError = new Error('SmartThings rejected rule execution (missing w:rules:* scope). Update the SmartThings app OAuth scopes, reconnect HomeBrain, then try again.');
          scopeError.status = error.status;
          scopeError.data = error.data;
          throw scopeError;
        }

        throw error;
      }

      appliedDirect = true;
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

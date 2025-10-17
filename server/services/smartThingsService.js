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

  resolveSmartThingsEndpoint(href) {
    if (!href || typeof href !== 'string') {
      return null;
    }

    if (/^https?:\/\//i.test(href)) {
      try {
        const url = new URL(href);
        return `${url.pathname}${url.search || ''}`;
      } catch (error) {
        console.warn(`SmartThingsService: Failed to parse SmartThings href "${href}": ${error.message}`);
        return null;
      }
    }

    return href;
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
      const status = error.response?.status;
      const isExpectedSecurityFallback = (
        endpoint.includes('/security/') &&
        [403, 404, 405, 422].includes(status)
      );

      const logPayload = error.response?.data || error.message;
      if (isExpectedSecurityFallback) {
        console.debug(`SmartThingsService: Expected fallback for ${endpoint} (${status}):`, logPayload);
      } else {
        console.error(`SmartThingsService: API request failed for ${endpoint}:`, logPayload);
      }

      // If unauthorized, clear tokens and require re-authorization
      if (status === 401) {
        const integration = await SmartThingsIntegration.getIntegration();
        await integration.clearTokens('Access token invalid');
      }

      const apiError = new Error(`SmartThings API request failed: ${error.response?.data?.message || error.message}`);
      apiError.status = status;
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

      const devices = [];
      const visited = new Set();
      const maxPages = 10;
      let nextEndpoint = '/devices?includeStatus=true&includeHealth=true';
      let page = 0;

      while (nextEndpoint) {
        page += 1;
        console.log(`SmartThingsService: Fetching SmartThings devices page ${page}`);

        const response = await this.makeAuthenticatedRequest(nextEndpoint);
        if (Array.isArray(response?.items) && response.items.length > 0) {
          devices.push(...response.items);
        }

        const nextHref = response?.links?.next?.href;
        const resolvedNext = this.resolveSmartThingsEndpoint(nextHref);

        if (!resolvedNext || visited.has(resolvedNext)) {
          nextEndpoint = null;
        } else if (page >= maxPages) {
          console.warn(`SmartThingsService: Reached pagination limit (${maxPages}) while fetching devices; additional devices may not be listed`);
          nextEndpoint = null;
        } else {
          visited.add(resolvedNext);
          nextEndpoint = resolvedNext;
        }
      }

      const integration = await SmartThingsIntegration.getIntegration();
      if (integration && typeof integration.updateDevices === 'function') {
        await integration.updateDevices(devices);
      }

      console.log(`SmartThingsService: Successfully fetched ${devices.length} devices`);
      return devices;
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

  async getSthmVirtualSwitchConfig({ requireAll = true } = {}) {
    const integration = await SmartThingsIntegration.getIntegration();
    const rawConfig = integration?.sthm || {};

    const sanitize = (value) => (typeof value === 'string' ? value.trim() : '');

    const config = {
      armAwayDeviceId: sanitize(rawConfig.armAwayDeviceId),
      armStayDeviceId: sanitize(rawConfig.armStayDeviceId),
      disarmDeviceId: sanitize(rawConfig.disarmDeviceId),
      locationId: sanitize(rawConfig.locationId),
      lastArmState: sanitize(rawConfig.lastArmState)
    };

    if (requireAll) {
      const missing = [];
      if (!config.disarmDeviceId) {
        missing.push('Disarm');
      }
      if (!config.armStayDeviceId) {
        missing.push('Arm Stay');
      }
      if (!config.armAwayDeviceId) {
        missing.push('Arm Away');
      }

      if (missing.length > 0) {
        const error = new Error(`SmartThings STHM virtual switches are not fully configured. Missing: ${missing.join(', ')}. Please assign the devices named "STHM Disarm", "STHM Arm Stay", and "STHM Arm Away" in integration settings.`);
        error.code = 'SMARTTHINGS_STHM_UNCONFIGURED';
        error.status = 400;
        throw error;
      }
    }

    return { integration, config };
  }

  async determineArmStateFromVirtualSwitches(config) {
    const candidates = [
      { armState: 'Disarmed', deviceId: config.disarmDeviceId },
      { armState: 'ArmedStay', deviceId: config.armStayDeviceId },
      { armState: 'ArmedAway', deviceId: config.armAwayDeviceId }
    ];

    for (const candidate of candidates) {
      if (!candidate.deviceId) {
        continue;
      }

      try {
        const status = await this.getDeviceStatus(candidate.deviceId);
        const switchValue =
          status?.components?.main?.switch?.switch?.value ??
          status?.components?.main?.switch?.switch ??
          status?.components?.main?.switch?.value ??
          status?.components?.main?.switch;

        if (typeof switchValue === 'string' && switchValue.toLowerCase() === 'on') {
          return {
            armState: candidate.armState,
            source: 'virtualSwitch-status',
            deviceId: candidate.deviceId,
            raw: status
          };
        }

        if (switchValue === true) {
          return {
            armState: candidate.armState,
            source: 'virtualSwitch-status',
            deviceId: candidate.deviceId,
            raw: status
          };
        }
      } catch (error) {
        console.warn(`SmartThingsService: Unable to read STHM virtual switch ${candidate.armState} status (${candidate.deviceId}): ${error.message}`);
      }
    }

    return null;
  }

  async determineArmStateFromSecurityDevices({ integration, locationId }) {
    const candidateIds = new Set();
    const connectedDevices = Array.isArray(integration?.connectedDevices) ? integration.connectedDevices : [];

    for (const device of connectedDevices) {
      if (device?.deviceId && Array.isArray(device.capabilities) && device.capabilities.includes('securitySystem')) {
        candidateIds.add(device.deviceId.trim());
      }
    }

    if (candidateIds.size === 0) {
      try {
        const devices = await this.getDevices();
        for (const device of devices) {
          const deviceId = device?.deviceId;
          if (!deviceId || candidateIds.has(deviceId)) {
            continue;
          }
          const capabilities = device?.components?.[0]?.capabilities?.map(cap => cap.id) || [];
          if (capabilities.includes('securitySystem')) {
            candidateIds.add(deviceId.trim());
          }
        }
      } catch (error) {
        console.warn(`SmartThingsService: Unable to enumerate devices for security status detection: ${error.message}`);
      }
    }

    for (const deviceId of candidateIds) {
      try {
        const status = await this.getDeviceStatus(deviceId);
        const securityComponent = status?.components?.main?.securitySystem;
        const rawValue = securityComponent?.securitySystemStatus?.value ?? securityComponent?.securitySystemStatus;
        if (!rawValue) {
          continue;
        }

        const normalized = this.normalizeArmState(rawValue);

        if (integration && typeof integration.updateSecurityArmState === 'function') {
          await integration.updateSecurityArmState({
            armState: normalized,
            locationId: locationId || undefined
          });
        } else if (integration?.sthm) {
          integration.sthm.lastArmState = normalized;
          integration.sthm.lastArmStateUpdatedAt = new Date();
          if (locationId) {
            integration.sthm.locationId = locationId;
          }
        }

        return {
          armState: normalized,
          source: 'securitySystem-device',
          deviceId,
          raw: status
        };
      } catch (error) {
        console.warn(`SmartThingsService: Unable to read security device ${deviceId} status: ${error.message}`);
      }
    }

    return null;
  }

  async pulseVirtualSwitch(deviceId, { ensureReset = true, delayMs = 300 } = {}) {
    if (!deviceId) {
      throw new Error('SmartThings virtual switch device ID is required');
    }

    if (ensureReset) {
      try {
        await this.sendDeviceCommand(deviceId, [{
          component: 'main',
          capability: 'switch',
          command: 'off'
        }]);
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 1000)));
        }
      } catch (error) {
        if (error?.status && [400, 404, 409, 422].includes(error.status)) {
          console.debug(`SmartThingsService: Ignoring pre-reset failure for STHM switch ${deviceId}: ${error.message}`);
        } else {
          throw error;
        }
      }
    }

    try {
      await this.sendDeviceCommand(deviceId, [{
        component: 'main',
        capability: 'switch',
        command: 'on'
      }]);
    } catch (error) {
      if (error?.status && [400, 404, 422].includes(error.status)) {
        console.debug(`SmartThingsService: Switch "on" command rejected for ${deviceId}, attempting momentary push: ${error.message}`);
        await this.sendDeviceCommand(deviceId, [{
          component: 'main',
          capability: 'momentary',
          command: 'push'
        }]);
        return;
      }

      throw error;
    }
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
    const providedLocationId = typeof locationId === 'string' ? locationId.trim() : '';
    let resolvedLocationId = providedLocationId || null;

    const { integration, config } = await this.getSthmVirtualSwitchConfig({ requireAll: false });

    if (!resolvedLocationId && config.locationId) {
      resolvedLocationId = config.locationId;
    }

    if (!resolvedLocationId) {
      try {
        resolvedLocationId = await this.resolveLocationId();
      } catch (resolveError) {
        console.debug(`SmartThingsService: Unable to auto-resolve SmartThings location for security state lookup: ${resolveError.message}`);
      }
    }

    if (resolvedLocationId) {
      const candidateEndpoints = [
        `/locations/${resolvedLocationId}/security/armState`,
        `/locations/${resolvedLocationId}/security/arm-state`
      ];

      for (const endpoint of candidateEndpoints) {
        try {
          const response = await this.makeAuthenticatedRequest(endpoint);
          const armState = response?.armState || response?.location?.security?.armState || null;
          const normalizedState = armState ? this.normalizeArmState(armState) : null;

          if (integration && typeof integration.updateSecurityArmState === 'function' && normalizedState) {
            await integration.updateSecurityArmState({ armState: normalizedState, locationId: resolvedLocationId });
          } else if (integration?.sthm && normalizedState) {
            integration.sthm.lastArmState = normalizedState;
            integration.sthm.lastArmStateUpdatedAt = new Date();
            integration.sthm.locationId = resolvedLocationId;
          }

          return {
            locationId: resolvedLocationId,
            armState: normalizedState,
            raw: response,
            source: 'smartthings-security-endpoint'
          };
        } catch (error) {
          if (error.status && [404, 405, 422].includes(error.status)) {
            continue;
          }

          if (error.status && [401, 403].includes(error.status)) {
            console.warn(`SmartThingsService: Direct security armState request (${endpoint}) denied (${error.status}); falling back to virtual switches`);
            break;
          }

          console.warn(`SmartThingsService: Security armState request failed via ${endpoint}: ${error.message}`);
          break;
        }
      }
    }

    let fallback = await this.determineArmStateFromVirtualSwitches(config);

    if (!fallback?.armState) {
      fallback = await this.determineArmStateFromSecurityDevices({
        integration,
        locationId: resolvedLocationId || config.locationId || null
      });
    }

    if (fallback?.armState) {
      const fallbackLocation = resolvedLocationId || config.locationId || null;

      if (fallback.source !== 'securitySystem-device') {
        if (integration && typeof integration.updateSecurityArmState === 'function') {
          await integration.updateSecurityArmState({
            armState: fallback.armState,
            locationId: fallbackLocation || undefined
          });
        } else if (integration?.sthm) {
          integration.sthm.lastArmState = fallback.armState;
          integration.sthm.lastArmStateUpdatedAt = new Date();
          if (fallbackLocation) {
            integration.sthm.locationId = fallbackLocation;
          }
        }
      }

      return {
        locationId: fallbackLocation,
        armState: fallback.armState,
        raw: fallback.raw || null,
        source: fallback.source,
        deviceId: fallback.deviceId || null
      };
    }

    const storedArmState = integration?.sthm?.lastArmState || null;
    const fallbackLocation = resolvedLocationId || config.locationId || null;

    return {
      locationId: fallbackLocation,
      armState: storedArmState || null,
      raw: null,
      source: storedArmState ? 'cached' : 'unknown'
    };
  }

  async setSecurityArmState(state, locationId) {
    const normalizedState = this.normalizeArmState(state);
    const { integration, config } = await this.getSthmVirtualSwitchConfig({ requireAll: true });

    const requestedLocationId = typeof locationId === 'string' ? locationId.trim() : '';
    let resolvedLocationId = requestedLocationId || config.locationId || null;

    if (!resolvedLocationId) {
      try {
        resolvedLocationId = await this.resolveLocationId();
      } catch (resolveError) {
        console.debug(`SmartThingsService: Unable to auto-resolve SmartThings location for STHM command: ${resolveError.message}`);
      }
    }

    const deviceMap = {
      Disarmed: config.disarmDeviceId,
      ArmedStay: config.armStayDeviceId,
      ArmedAway: config.armAwayDeviceId
    };

    const targetDeviceId = deviceMap[normalizedState];
    if (!targetDeviceId) {
      throw new Error(`SmartThings virtual switch not configured for STHM state ${normalizedState}`);
    }

    console.log(`SmartThingsService: Triggering STHM virtual switch ${targetDeviceId} for state ${normalizedState}`);
    await this.pulseVirtualSwitch(targetDeviceId, { ensureReset: true, delayMs: 300 });

    if (integration && typeof integration.updateSecurityArmState === 'function') {
      await integration.updateSecurityArmState({
        armState: normalizedState,
        locationId: resolvedLocationId || config.locationId || ''
      });
    } else if (integration?.sthm) {
      integration.sthm.lastArmState = normalizedState;
      integration.sthm.lastArmStateUpdatedAt = new Date();
      if (resolvedLocationId || config.locationId) {
        integration.sthm.locationId = resolvedLocationId || config.locationId;
      }
    }

    return {
      locationId: resolvedLocationId || config.locationId || null,
      armState: normalizedState,
      triggeredDeviceId: targetDeviceId,
      via: 'virtualSwitch'
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

      const payload = (Array.isArray(commands) ? commands : [commands]).map((command, index) => {
        if (!command || typeof command !== 'object') {
          throw new Error(`SmartThings command at index ${index} must be an object`);
        }

        const normalized = { ...command };

        const capability = typeof normalized.capability === 'string' ? normalized.capability.trim() : '';
        const smartCommand = typeof normalized.command === 'string' ? normalized.command.trim() : '';
        const component = typeof normalized.component === 'string' ? normalized.component.trim() : 'main';

        if (!capability || !smartCommand) {
          throw new Error(`SmartThings command at index ${index} requires both capability and command`);
        }

        normalized.capability = capability;
        normalized.command = smartCommand;
        normalized.component = component || 'main';

        return normalized;
      });

      if (payload.length === 0) {
        throw new Error('At least one SmartThings command is required');
      }

      const data = await this.makeAuthenticatedRequest(`/devices/${deviceId}/commands`, {
        method: 'POST',
        data: { commands: payload }
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
    const numericLevel = Number(level);
    if (!Number.isFinite(numericLevel)) {
      throw new Error('Level must be a number between 0 and 100');
    }

    const clampedLevel = Math.max(0, Math.min(100, Math.round(numericLevel)));

    const command = [{
      component: 'main',
      capability: 'switchLevel',
      command: 'setLevel',
      arguments: [clampedLevel]
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
      if (typeof integration.save !== 'function') {
        throw new Error('SmartThings integration is not fully configured. Complete OAuth setup before configuring STHM virtual switches.');
      }

      const sanitize = (value) => (typeof value === 'string' ? value.trim() : '');

      const nextArmAwayId = sanitize(sthm.armAwayDeviceId || integration.sthm?.armAwayDeviceId || '');
      const nextArmStayId = sanitize(sthm.armStayDeviceId || integration.sthm?.armStayDeviceId || '');
      const nextDisarmId = sanitize(sthm.disarmDeviceId || integration.sthm?.disarmDeviceId || '');

      let nextLocationId = sanitize(sthm.locationId || integration.sthm?.locationId || '');
      if (!nextLocationId) {
        const probeDeviceId = nextDisarmId || nextArmStayId || nextArmAwayId;
        if (probeDeviceId) {
          try {
            const deviceDetails = await this.getDevice(probeDeviceId);
            nextLocationId = sanitize(
              deviceDetails?.locationId ||
              deviceDetails?.location?.locationId ||
              deviceDetails?.location?.id ||
              ''
            );
          } catch (lookupError) {
            console.debug(`SmartThingsService: Unable to infer STHM location from device ${probeDeviceId}: ${lookupError.message}`);
          }
        }
      }

      integration.sthm = {
        ...(integration.sthm || {}),
        armAwayDeviceId: nextArmAwayId,
        armStayDeviceId: nextArmStayId,
        disarmDeviceId: nextDisarmId,
        locationId: nextLocationId
      };

      await integration.save();

      if (nextLocationId && typeof integration.updateSecurityArmState === 'function') {
        await integration.updateSecurityArmState({ locationId: nextLocationId });
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

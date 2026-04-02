const axios = require('axios');
const Device = require('../models/Device');
const EcobeeIntegration = require('../models/EcobeeIntegration');
const {
  buildEcobeeThermostatIdentityQuery,
  buildEcobeeSensorIdentityQuery,
  selectCanonicalDevice,
  mergeDuplicateDeviceGroups,
  describeDevices
} = require('./deviceIdentityService');

const DEFAULT_SCOPE = ['smartWrite'];

const toNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const toDeci = (value) => {
  const numeric = toNumber(value);
  if (numeric == null) {
    return null;
  }
  return Math.round(numeric * 10);
};

const fromDeci = (value) => {
  const numeric = toNumber(value);
  if (numeric == null) {
    return null;
  }
  return Number((numeric / 10).toFixed(1));
};

const normalizeString = (value, fallback = '') => (
  typeof value === 'string' ? value.trim() : fallback
);

const normalizeList = (values) => {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => normalizeString(value))
    .filter((value) => value.length > 0);
};

const splitEquipmentStatus = (value) => normalizeString(value)
  .split(',')
  .map((token) => token.trim())
  .filter((token) => token.length > 0);

const parseBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'online', 'connected'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'offline', 'disconnected'].includes(normalized)) {
      return false;
    }
  }

  return fallback;
};

class EcobeeService {
  constructor() {
    this.baseUrl = 'https://api.ecobee.com';
    this.authUrl = 'https://api.ecobee.com/authorize';
    this.tokenUrl = 'https://api.ecobee.com/token';
    this.deviceStatusSyncIntervalMs = Number(process.env.ECOBEE_DEVICE_SYNC_INTERVAL_MS || 5 * 60 * 1000);
    this.deviceStatusSyncTimer = null;
    this.deviceStatusSyncInProgress = false;
    this.lastRecordedConnectionState = null;
    this.backgroundTasksEnabled = process.env.ECOBEE_BACKGROUND_TASKS !== 'false' && process.env.NODE_ENV !== 'test';

    if (this.backgroundTasksEnabled && this.deviceStatusSyncIntervalMs > 0) {
      this.startDeviceStatusSync();
    }
  }

  startDeviceStatusSync() {
    if (this.deviceStatusSyncTimer) {
      clearTimeout(this.deviceStatusSyncTimer);
      this.deviceStatusSyncTimer = null;
    }

    const scheduleNext = () => {
      const intervalMs = Math.max(this.deviceStatusSyncIntervalMs, 2000);
      this.deviceStatusSyncTimer = setTimeout(async () => {
        try {
          await this.runDeviceStatusSync({ reason: 'periodic-tick' });
        } catch (error) {
          console.warn('EcobeeService: Device status sync error:', error.message);
        } finally {
          scheduleNext();
        }
      }, intervalMs);

      if (typeof this.deviceStatusSyncTimer.unref === 'function') {
        this.deviceStatusSyncTimer.unref();
      }
    };

    scheduleNext();

    this.runDeviceStatusSync({ reason: 'initial-start' }).catch((error) => {
      console.warn('EcobeeService: Initial status sync error:', error.message);
    });
  }

  stopDeviceStatusSync() {
    if (this.deviceStatusSyncTimer) {
      clearTimeout(this.deviceStatusSyncTimer);
      this.deviceStatusSyncTimer = null;
    }
  }

  async persistConnectionStatus({ isConnected, lastError = '', reason = 'unspecified' } = {}) {
    const connected = Boolean(isConnected);
    const normalizedError = connected ? '' : (typeof lastError === 'string' ? lastError : '');

    try {
      const integration = await EcobeeIntegration.getIntegration();
      if (!integration || typeof integration.save !== 'function') {
        this.lastRecordedConnectionState = connected;
        return false;
      }

      const connectionChanged = integration.isConnected !== connected;
      const errorChanged = (integration.lastError || '') !== normalizedError;
      if (!connectionChanged && !errorChanged) {
        this.lastRecordedConnectionState = connected;
        return false;
      }

      integration.isConnected = connected;
      integration.lastError = normalizedError;
      await integration.save();

      this.lastRecordedConnectionState = connected;
      console.log(`EcobeeService: Persisted connection state ${connected ? 'connected' : 'disconnected'} (${reason})`);
      return true;
    } catch (error) {
      console.warn(`EcobeeService: Failed to persist connection state (${reason}): ${error.message}`);
      return false;
    }
  }

  async getAuthorizationUrl() {
    const integration = await EcobeeIntegration.getIntegration();

    const clientId = normalizeString(integration.clientId);
    const redirectUri = normalizeString(integration.redirectUri);
    const scopes = normalizeList(integration.scope);

    if (!clientId || !redirectUri) {
      throw new Error('Ecobee OAuth configuration incomplete. Please configure App Key and Redirect URI.');
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: (scopes.length > 0 ? scopes : DEFAULT_SCOPE).join(' '),
      state: Date.now().toString()
    });

    return `${this.authUrl}?${params.toString()}`;
  }

  async exchangeCodeForToken(code, state) {
    const integration = await EcobeeIntegration.getIntegration();

    const clientId = normalizeString(integration.clientId);
    const redirectUri = normalizeString(integration.redirectUri);

    if (!clientId || !redirectUri) {
      throw new Error('Ecobee OAuth configuration incomplete');
    }

    const tokenData = new URLSearchParams();
    tokenData.append('grant_type', 'authorization_code');
    tokenData.append('code', code);
    tokenData.append('client_id', clientId);
    tokenData.append('redirect_uri', redirectUri);

    const response = await axios.post(this.tokenUrl, tokenData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'HomeBrain/EcobeeIntegration'
      },
      timeout: 10000
    });

    if (!response?.data?.access_token) {
      throw new Error('Ecobee token exchange did not return an access token');
    }

    await integration.updateTokens(response.data);

    await this.syncDevices({ reason: 'oauth-callback', fullSync: true });
    await this.persistConnectionStatus({ isConnected: true, lastError: '', reason: 'oauth-callback' });

    return response.data;
  }

  async refreshAccessToken() {
    const integration = await EcobeeIntegration.getIntegration();

    const clientId = normalizeString(integration.clientId);
    if (!clientId) {
      throw new Error('Ecobee OAuth configuration incomplete');
    }

    if (!integration.refreshToken) {
      throw new Error('No Ecobee refresh token available');
    }

    const tokenData = new URLSearchParams();
    tokenData.append('grant_type', 'refresh_token');
    tokenData.append('refresh_token', integration.refreshToken);
    tokenData.append('code', integration.refreshToken);
    tokenData.append('client_id', clientId);

    const response = await axios.post(this.tokenUrl, tokenData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'HomeBrain/EcobeeIntegration'
      },
      timeout: 10000
    });

    if (!response?.data?.access_token) {
      throw new Error('Ecobee token refresh did not return an access token');
    }

    await integration.updateTokens(response.data);
    return response.data;
  }

  async getValidAccessToken() {
    const integration = await EcobeeIntegration.getIntegration();

    if (!integration.accessToken) {
      if (integration.refreshToken) {
        await this.refreshAccessToken();
        const refreshedIntegration = await EcobeeIntegration.getIntegration();
        if (refreshedIntegration.accessToken) {
          return refreshedIntegration.accessToken;
        }
      }
      throw new Error('No Ecobee access token available. Please authorize the application.');
    }

    if (integration.isTokenValid()) {
      return integration.accessToken;
    }

    await this.refreshAccessToken();

    const refreshedIntegration = await EcobeeIntegration.getIntegration();
    if (!refreshedIntegration.accessToken) {
      throw new Error('Failed to refresh Ecobee access token');
    }

    return refreshedIntegration.accessToken;
  }

  async makeAuthenticatedRequest(endpoint, options = {}) {
    const {
      method = 'post',
      data,
      headers = {},
      timeout = 10000
    } = options;

    try {
      const accessToken = await this.getValidAccessToken();
      const response = await axios({
        url: `${this.baseUrl}${endpoint}`,
        method,
        data,
        timeout,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json;charset=UTF-8',
          Accept: 'application/json',
          ...headers
        }
      });

      const payload = response?.data || {};
      const statusCode = Number(payload?.status?.code ?? 0);
      if (Number.isFinite(statusCode) && statusCode !== 0) {
        const statusMessage = payload?.status?.message || payload?.status?.error || 'Unknown Ecobee API error';
        const apiError = new Error(`Ecobee API error (${statusCode}): ${statusMessage}`);
        apiError.status = 400;
        apiError.data = payload;
        throw apiError;
      }

      if (this.lastRecordedConnectionState !== true) {
        await this.persistConnectionStatus({
          isConnected: true,
          lastError: '',
          reason: `request:${endpoint}`
        });
      }

      return payload;
    } catch (error) {
      const status = error?.response?.status;

      if (status === 401) {
        const integration = await EcobeeIntegration.getIntegration();
        if (integration && typeof integration.clearTokens === 'function') {
          await integration.clearTokens('Ecobee access token invalid');
        }
      }

      await this.persistConnectionStatus({
        isConnected: false,
        lastError: error?.response?.data?.status?.message || error.message,
        reason: `request-failed:${endpoint}`
      });

      const errorMessage = error?.response?.data?.status?.message || error.message || 'Ecobee API request failed';
      const apiError = new Error(errorMessage);
      apiError.status = status;
      apiError.data = error?.response?.data;
      throw apiError;
    }
  }

  buildThermostatSelection(options = {}) {
    const {
      includeRuntime = true,
      includeSensors = true,
      includeSettings = true,
      includeEquipmentStatus = true,
      thermostatIdentifiers = []
    } = options;

    const identifiers = normalizeList(thermostatIdentifiers);

    return {
      selectionType: identifiers.length > 0 ? 'thermostats' : 'registered',
      selectionMatch: identifiers.length > 0 ? identifiers.join(',') : '',
      includeRuntime: !!includeRuntime,
      includeSensors: !!includeSensors,
      includeSettings: !!includeSettings,
      includeEquipmentStatus: !!includeEquipmentStatus
    };
  }

  async getThermostats(options = {}) {
    const selection = this.buildThermostatSelection(options);

    const payload = await this.makeAuthenticatedRequest('/1/thermostat', {
      method: 'post',
      data: {
        selection
      }
    });

    const thermostatList = Array.isArray(payload?.thermostatList) ? payload.thermostatList : [];

    const integration = await EcobeeIntegration.getIntegration();
    if (integration && typeof integration.updateDevices === 'function') {
      await integration.updateDevices(thermostatList);
    }

    return thermostatList;
  }

  getSensorCapability(sensor, capabilityType) {
    if (!sensor || !Array.isArray(sensor.capability)) {
      return null;
    }

    const targetType = normalizeString(capabilityType).toLowerCase();

    const match = sensor.capability.find((capability) => {
      const type = normalizeString(capability?.type).toLowerCase();
      return type === targetType;
    });

    return match?.value ?? null;
  }

  parseSensorOccupancy(value) {
    if (value == null) {
      return null;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'occupied', 'active', 'yes'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'unoccupied', 'inactive', 'no'].includes(normalized)) {
      return false;
    }

    return null;
  }

  resolveTargetTemperature(runtime = {}, settings = {}) {
    const desiredHeat = fromDeci(runtime.desiredHeat);
    const desiredCool = fromDeci(runtime.desiredCool);
    const hvacMode = normalizeString(settings.hvacMode).toLowerCase();

    if (hvacMode === 'heat' || hvacMode === 'auxheatonly') {
      return desiredHeat;
    }

    if (hvacMode === 'cool') {
      return desiredCool;
    }

    if (desiredHeat != null && desiredCool != null) {
      return Number(((desiredHeat + desiredCool) / 2).toFixed(1));
    }

    return desiredHeat != null ? desiredHeat : desiredCool;
  }

  mapThermostatToDevice(thermostat) {
    const identifier = normalizeString(thermostat?.identifier);
    if (!identifier) {
      return null;
    }

    const runtime = thermostat?.runtime || {};
    const settings = thermostat?.settings || {};

    const hvacMode = normalizeString(settings.hvacMode);
    const connected = parseBoolean(runtime.connected, true);
    const equipmentStatus = normalizeString(thermostat?.equipmentStatus);
    const equipmentTokens = splitEquipmentStatus(equipmentStatus);
    const hasActiveEquipment = equipmentTokens.some((token) => !['off', 'idle'].includes(token.toLowerCase()));

    const thermostatTemperature = fromDeci(runtime.actualTemperature);
    const targetTemperature = this.resolveTargetTemperature(runtime, settings);

    const properties = {
      source: 'ecobee',
      ecobeeDeviceType: 'thermostat',
      ecobeeThermostatIdentifier: identifier,
      ecobeeHvacMode: hvacMode,
      ecobeeEquipmentStatus: equipmentStatus,
      ecobeeEquipmentTokens: equipmentTokens,
      ecobeeRuntimeRevision: normalizeString(runtime.runtimeRev),
      ecobeeThermostatRevision: normalizeString(thermostat?.thermostatRev)
    };

    if (hvacMode && hvacMode.toLowerCase() !== 'off') {
      properties.ecobeeLastActiveHvacMode = hvacMode;
    }

    return {
      name: normalizeString(thermostat?.name) || `Ecobee Thermostat ${identifier}`,
      type: 'thermostat',
      room: normalizeString(thermostat?.name) || 'Ecobee',
      status: hvacMode.toLowerCase() !== 'off' || hasActiveEquipment,
      temperature: thermostatTemperature,
      targetTemperature,
      properties,
      brand: 'ecobee',
      model: normalizeString(thermostat?.modelNumber) || 'Smart Thermostat',
      isOnline: connected,
      lastSeen: new Date()
    };
  }

  mapSensorToDevice(thermostat, sensor) {
    const thermostatIdentifier = normalizeString(thermostat?.identifier);
    const sensorId = normalizeString(sensor?.id);

    if (!thermostatIdentifier || !sensorId) {
      return null;
    }

    const thermostatName = normalizeString(thermostat?.name) || thermostatIdentifier;
    const sensorName = normalizeString(sensor?.name) || sensorId;
    const sensorType = normalizeString(sensor?.type) || 'sensor';

    const rawTemperature = this.getSensorCapability(sensor, 'temperature');
    const rawOccupancy = this.getSensorCapability(sensor, 'occupancy');
    const rawHumidity = this.getSensorCapability(sensor, 'humidity');

    const temperature = fromDeci(rawTemperature);
    const occupancy = this.parseSensorOccupancy(rawOccupancy);
    const humidity = toNumber(rawHumidity);

    const sensorKey = `${thermostatIdentifier}:${sensorId}`;

    return {
      name: `${thermostatName} - ${sensorName}`,
      type: 'sensor',
      room: thermostatName,
      status: occupancy === true,
      temperature,
      properties: {
        source: 'ecobee',
        ecobeeDeviceType: 'sensor',
        ecobeeThermostatIdentifier: thermostatIdentifier,
        ecobeeSensorId: sensorId,
        ecobeeSensorKey: sensorKey,
        ecobeeSensorName: sensorName,
        ecobeeSensorType: sensorType,
        ecobeeSensorCapabilities: Array.isArray(sensor?.capability)
          ? sensor.capability.map((capability) => normalizeString(capability?.type)).filter(Boolean)
          : [],
        ecobeeSensorOccupancy: occupancy,
        ecobeeSensorHumidity: humidity
      },
      brand: 'ecobee',
      model: sensorType,
      isOnline: parseBoolean(thermostat?.runtime?.connected, true),
      lastSeen: new Date()
    };
  }

  async upsertMappedDevice(mappedDevice) {
    const deviceType = normalizeString(mappedDevice?.properties?.ecobeeDeviceType).toLowerCase();

    let query = null;
    if (deviceType === 'thermostat') {
      query = buildEcobeeThermostatIdentityQuery(mappedDevice.properties.ecobeeThermostatIdentifier);
    } else if (deviceType === 'sensor') {
      query = buildEcobeeSensorIdentityQuery(mappedDevice.properties.ecobeeSensorKey);
    }

    if (!query) {
      return { created: 0, updated: 0, deduped: 0, device: null };
    }

    const matchingDevices = await Device.find(query);
    const existing = selectCanonicalDevice(matchingDevices);
    const duplicateDevices = matchingDevices.filter((candidate) => (
      String(candidate?._id || '') !== String(existing?._id || '')
    ));

    if (existing) {
      mergeDuplicateDeviceGroups(existing, duplicateDevices);
      existing.name = mappedDevice.name;
      existing.type = mappedDevice.type;
      existing.room = mappedDevice.room;
      existing.status = mappedDevice.status;
      existing.temperature = mappedDevice.temperature;
      existing.targetTemperature = mappedDevice.targetTemperature;
      existing.properties = {
        ...(existing.properties || {}),
        ...(mappedDevice.properties || {})
      };
      existing.brand = mappedDevice.brand;
      existing.model = mappedDevice.model;
      existing.isOnline = mappedDevice.isOnline;
      existing.lastSeen = mappedDevice.lastSeen || new Date();

      await existing.save();

      const duplicateIds = duplicateDevices
        .map((candidate) => String(candidate?._id || ''))
        .filter(Boolean);
      if (duplicateIds.length > 0) {
        await Device.deleteMany({ _id: { $in: duplicateIds } });
        console.warn(
          `EcobeeService: Removed ${duplicateIds.length} duplicate HomeBrain row(s) for ${deviceType} ${mappedDevice.properties.ecobeeThermostatIdentifier || mappedDevice.properties.ecobeeSensorKey}: ${describeDevices(duplicateDevices)}`
        );
      }

      return { created: 0, updated: 1, deduped: duplicateIds.length, device: existing };
    }

    const createdDevice = await Device.create(mappedDevice);
    return { created: 1, updated: 0, deduped: 0, device: createdDevice };
  }

  async syncDevices(options = {}) {
    const {
      thermostatIdentifiers = [],
      reason = 'manual',
      fullSync = normalizeList(thermostatIdentifiers).length === 0
    } = options;

    const identifiers = normalizeList(thermostatIdentifiers);

    const thermostats = await this.getThermostats({
      thermostatIdentifiers: identifiers,
      includeRuntime: true,
      includeSensors: true,
      includeSettings: true,
      includeEquipmentStatus: true
    });

    const mappedDevices = [];
    const processedThermostatIdentifiers = new Set();
    const processedSensorKeys = new Set();

    thermostats.forEach((thermostat) => {
      const mappedThermostat = this.mapThermostatToDevice(thermostat);
      if (mappedThermostat) {
        mappedDevices.push(mappedThermostat);
        processedThermostatIdentifiers.add(mappedThermostat.properties.ecobeeThermostatIdentifier);
      }

      const sensors = Array.isArray(thermostat?.remoteSensors) ? thermostat.remoteSensors : [];
      sensors.forEach((sensor) => {
        const mappedSensor = this.mapSensorToDevice(thermostat, sensor);
        if (!mappedSensor) {
          return;
        }
        mappedDevices.push(mappedSensor);
        processedSensorKeys.add(mappedSensor.properties.ecobeeSensorKey);
      });
    });

    let created = 0;
    let updated = 0;
    let deduped = 0;

    for (const mappedDevice of mappedDevices) {
      const result = await this.upsertMappedDevice(mappedDevice);
      created += result.created;
      updated += result.updated;
      deduped += result.deduped || 0;
    }

    let removed = 0;
    if (fullSync) {
      const thermostatIds = Array.from(processedThermostatIdentifiers);
      const sensorKeys = Array.from(processedSensorKeys);

      const removalResult = await Device.deleteMany({
        'properties.source': 'ecobee',
        $or: [
          {
            'properties.ecobeeDeviceType': 'thermostat',
            'properties.ecobeeThermostatIdentifier': { $nin: thermostatIds }
          },
          {
            'properties.ecobeeDeviceType': 'sensor',
            'properties.ecobeeSensorKey': { $nin: sensorKeys }
          },
          {
            'properties.ecobeeDeviceType': { $exists: false }
          }
        ]
      });

      removed = removalResult?.deletedCount || 0;
    }

    const integration = await EcobeeIntegration.getIntegration();
    if (integration && typeof integration.save === 'function') {
      integration.lastSync = new Date();
      integration.lastError = '';
      integration.isConnected = true;
      await integration.save();
    }

    return {
      success: true,
      message: `Ecobee sync completed (${reason})`,
      thermostatCount: thermostats.length,
      sensorCount: processedSensorKeys.size,
      deviceCount: mappedDevices.length,
      created,
      updated,
      deduped,
      removed,
      thermostats
    };
  }

  async runDeviceStatusSync({ force = false, reason = 'unspecified', thermostatIdentifiers = [] } = {}) {
    if (this.deviceStatusSyncInProgress && !force) {
      return {
        success: false,
        skipped: true,
        reason: 'already-in-progress'
      };
    }

    this.deviceStatusSyncInProgress = true;

    try {
      const integration = await EcobeeIntegration.getIntegration();

      if (!integration || !integration.isConfigured) {
        return {
          success: false,
          skipped: true,
          reason: 'not-configured'
        };
      }

      if (!integration.accessToken && !integration.refreshToken) {
        return {
          success: false,
          skipped: true,
          reason: 'not-authorized'
        };
      }

      let identifiers = normalizeList(thermostatIdentifiers);
      if (!force && identifiers.length === 0) {
        const trackedIdentifiers = await Device.distinct('properties.ecobeeThermostatIdentifier', {
          'properties.source': 'ecobee',
          'properties.ecobeeDeviceType': 'thermostat',
          'properties.ecobeeThermostatIdentifier': { $exists: true, $ne: '' }
        });
        identifiers = normalizeList(trackedIdentifiers);
      }

      const syncResult = await this.syncDevices({
        thermostatIdentifiers: identifiers,
        fullSync: identifiers.length === 0,
        reason
      });

      await this.persistConnectionStatus({ isConnected: true, lastError: '', reason: `sync:${reason}` });
      return syncResult;
    } catch (error) {
      await this.persistConnectionStatus({ isConnected: false, lastError: error.message, reason: `sync-failed:${reason}` });
      throw error;
    } finally {
      this.deviceStatusSyncInProgress = false;
    }
  }

  async getDevices({ forceSync = false } = {}) {
    if (forceSync) {
      await this.runDeviceStatusSync({ force: true, reason: 'manual-refresh' });
    }

    return Device.find({ 'properties.source': 'ecobee' }).sort({ type: 1, name: 1 });
  }

  async getThermostatByIdentifier(thermostatIdentifier, options = {}) {
    const identifier = normalizeString(thermostatIdentifier);
    if (!identifier) {
      throw new Error('Thermostat identifier is required');
    }

    const thermostats = await this.getThermostats({
      thermostatIdentifiers: [identifier],
      includeRuntime: options.includeRuntime !== false,
      includeSensors: options.includeSensors !== false,
      includeSettings: options.includeSettings !== false,
      includeEquipmentStatus: options.includeEquipmentStatus !== false
    });

    return thermostats[0] || null;
  }

  async setHvacMode(thermostatIdentifier, hvacMode) {
    const identifier = normalizeString(thermostatIdentifier);
    const mode = normalizeString(hvacMode);

    if (!identifier || !mode) {
      throw new Error('Thermostat identifier and hvacMode are required');
    }

    await this.makeAuthenticatedRequest('/1/thermostat', {
      method: 'post',
      data: {
        selection: {
          selectionType: 'thermostats',
          selectionMatch: identifier
        },
        functions: [{
          type: 'setHvacMode',
          params: {
            hvacMode: mode
          }
        }]
      }
    });

    return { success: true, thermostatIdentifier: identifier, hvacMode: mode };
  }

  async setTemperatureHold(thermostatIdentifier, targetTemperature, hvacMode = '') {
    const identifier = normalizeString(thermostatIdentifier);
    const targetDeci = toDeci(targetTemperature);

    if (!identifier) {
      throw new Error('Thermostat identifier is required');
    }

    if (targetDeci == null) {
      throw new Error('Target temperature must be a valid number');
    }

    const mode = normalizeString(hvacMode).toLowerCase();

    const holdParams = {
      holdType: 'nextTransition'
    };

    if (mode === 'heat' || mode === 'auxheatonly') {
      holdParams.heatHoldTemp = targetDeci;
    } else if (mode === 'cool') {
      holdParams.coolHoldTemp = targetDeci;
    } else {
      holdParams.heatHoldTemp = targetDeci - 10;
      holdParams.coolHoldTemp = targetDeci + 10;
    }

    await this.makeAuthenticatedRequest('/1/thermostat', {
      method: 'post',
      data: {
        selection: {
          selectionType: 'thermostats',
          selectionMatch: identifier
        },
        functions: [{
          type: 'setHold',
          params: holdParams
        }]
      }
    });

    return {
      success: true,
      thermostatIdentifier: identifier,
      targetTemperature: Number(targetTemperature),
      applied: holdParams
    };
  }

  async testConnection() {
    try {
      const syncResult = await this.syncDevices({ reason: 'test-connection', fullSync: true });

      await this.persistConnectionStatus({
        isConnected: true,
        lastError: '',
        reason: 'test-connection'
      });

      return {
        success: true,
        message: 'Ecobee connection successful',
        thermostatCount: syncResult.thermostatCount,
        sensorCount: syncResult.sensorCount,
        deviceCount: syncResult.deviceCount,
        devices: syncResult.thermostats
      };
    } catch (error) {
      await this.persistConnectionStatus({
        isConnected: false,
        lastError: error.message,
        reason: 'test-connection-failed'
      });
      throw error;
    }
  }

  async disconnect() {
    const integration = await EcobeeIntegration.getIntegration();

    if (integration && typeof integration.clearTokens === 'function') {
      await integration.clearTokens('User disconnected');
    } else {
      await EcobeeIntegration.deleteMany({});
    }

    await this.persistConnectionStatus({ isConnected: false, lastError: 'User disconnected', reason: 'disconnect' });
  }
}

module.exports = new EcobeeService();

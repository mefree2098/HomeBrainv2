const axios = require('axios');
const dgram = require('dgram');
const WebSocket = require('ws');
const Device = require('../models/Device');
const TempestEvent = require('../models/TempestEvent');
const TempestIntegration = require('../models/TempestIntegration');
const TempestObservation = require('../models/TempestObservation');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const {
  DEVICE_TYPE_LABELS,
  buildDisplayMetrics,
  cToF,
  decodeSensorStatus,
  normalizeDiscoveryResponse,
  normalizeEventPayload,
  normalizeObservationPayload,
  roundNumber,
  toNumber
} = require('./tempestData');

const DEFAULT_DISCOVERY_INTERVAL_MS = Math.max(15 * 60 * 1000, Number(process.env.TEMPEST_SYNC_INTERVAL_MS || 6 * 60 * 60 * 1000));
const DEFAULT_HTTP_TIMEOUT_MS = 12000;
const OBSERVATION_RETENTION_LIMIT = 720;

const clampInteger = (value, fallback, minimum, maximum) => {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, numeric));
};

const trimString = (value, fallback = '') => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
};

const buildTempestDeviceQuery = ({ stationId, deviceId, serialNumber, hubSerialNumber } = {}) => {
  const orConditions = [];

  if (toNumber(stationId) !== null) {
    orConditions.push({ 'properties.tempest.stationId': toNumber(stationId) });
  }

  if (toNumber(deviceId) !== null) {
    orConditions.push({ 'properties.tempest.deviceIds': toNumber(deviceId) });
  }

  if (trimString(serialNumber)) {
    orConditions.push({ 'properties.tempest.serialNumbers': trimString(serialNumber) });
  }

  if (trimString(hubSerialNumber)) {
    orConditions.push({ 'properties.tempest.hubSerialNumber': trimString(hubSerialNumber) });
  }

  if (orConditions.length === 0) {
    return null;
  }

  return {
    'properties.source': 'tempest',
    $or: orConditions
  };
};

class TempestService {
  constructor() {
    this.restBase = trimString(process.env.TEMPEST_REST_BASE, 'https://swd.weatherflow.com/swd/rest');
    this.websocketUrlBase = trimString(process.env.TEMPEST_WS_BASE, 'wss://ws.weatherflow.com/swd/data');
    this.discoveryIntervalMs = DEFAULT_DISCOVERY_INTERVAL_MS;
    this.backgroundEnabled = process.env.NODE_ENV !== 'test';
    this.initialized = false;
    this.initializing = null;
    this.discoveryTimer = null;
    this.websocket = null;
    this.websocketSelectionKey = '';
    this.websocketReconnectTimer = null;
    this.websocketReconnectAttempt = 0;
    this.udpSocket = null;
    this.udpListening = false;
    this.udpConfigKey = '';
  }

  async initialize() {
    if (!this.backgroundEnabled) {
      return;
    }

    if (this.initialized) {
      return;
    }

    if (this.initializing) {
      return this.initializing;
    }

    this.initializing = (async () => {
      await this.refreshRuntime({ reason: 'initialize' });
      this.startDiscoveryTimer();
      this.initialized = true;
      this.initializing = null;
    })().catch((error) => {
      this.initializing = null;
      throw error;
    });

    return this.initializing;
  }

  startDiscoveryTimer() {
    if (!this.backgroundEnabled || this.discoveryTimer || this.discoveryIntervalMs <= 0) {
      return;
    }

    this.discoveryTimer = setInterval(() => {
      this.refreshRuntime({ reason: 'scheduled-sync' }).catch((error) => {
        console.warn('TempestService: scheduled sync failed:', error.message);
      });
    }, this.discoveryIntervalMs);

    if (typeof this.discoveryTimer.unref === 'function') {
      this.discoveryTimer.unref();
    }
  }

  async refreshRuntime({ reason = 'manual' } = {}) {
    const integration = await TempestIntegration.getIntegration();
    const resolvedToken = this.resolveToken(null, integration);

    if (!integration.enabled || !resolvedToken) {
      this.stopRealtime();
      return {
        success: true,
        skipped: true,
        reason: !integration.enabled ? 'integration-disabled' : 'missing-token'
      };
    }

    const syncResult = await this.syncStations({ integration, reason });
    await this.ensureRealtimeConnections(syncResult.integration || integration);
    return syncResult;
  }

  async shutdown() {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }

    this.stopRealtime();
  }

  stopRealtime() {
    this.stopWebSocket({ resetSelection: true });
    this.stopUdpListener();
  }

  resolveToken(candidate, integration) {
    const explicit = trimString(candidate, '');
    if (explicit) {
      return explicit;
    }

    const persisted = trimString(integration?.token, '');
    if (persisted) {
      return persisted;
    }

    return trimString(process.env.TEMPEST_TOKEN, '');
  }

  async requestJson(path, params = {}, { timeout = DEFAULT_HTTP_TIMEOUT_MS, retries = 3 } = {}) {
    const url = `${this.restBase}${path}`;
    let lastError = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const response = await axios.get(url, {
          params,
          timeout
        });
        return response.data;
      } catch (error) {
        lastError = error;
        const status = error?.response?.status;
        const shouldRetry = (!status || status >= 500) && attempt < retries;
        if (!shouldRetry) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }

    if (lastError?.response?.status === 401 || lastError?.response?.status === 403) {
      throw new Error('Tempest authentication failed. Verify the Personal Access Token.');
    }

    throw new Error(lastError?.message || 'Tempest request failed');
  }

  async testConnection({ token } = {}) {
    const resolvedToken = this.resolveToken(token);
    if (!resolvedToken) {
      throw new Error('A Tempest Personal Access Token is required.');
    }

    const payload = await this.requestJson('/stations', { token: resolvedToken });
    const stations = normalizeDiscoveryResponse(payload);

    return {
      success: true,
      stations
    };
  }

  async getSelectedStationDevice(selectedStationId = null) {
    const targetStationId = toNumber(selectedStationId);
    const query = {
      'properties.source': 'tempest'
    };

    if (targetStationId !== null) {
      query['properties.tempest.stationId'] = targetStationId;
    }

    return Device.findOne(query).sort({ 'properties.tempest.stationName': 1, name: 1 });
  }

  async listProvisionedStations() {
    const devices = await Device.find({ 'properties.source': 'tempest' }).sort({ room: 1, name: 1 });
    return devices.map((device) => this.buildStationSummary(device));
  }

  buildStationSummary(device) {
    const plain = typeof device?.toObject === 'function'
      ? device.toObject({ depopulate: true })
      : device;
    const tempest = plain?.properties?.tempest || {};
    const display = tempest.display || {};
    const health = tempest.health || {};

    return {
      id: plain?._id?.toString?.() || plain?._id || null,
      stationId: toNumber(tempest.stationId),
      name: trimString(tempest.stationName, trimString(plain?.name, 'Tempest Station')),
      room: trimString(plain?.room, 'Outside'),
      model: trimString(plain?.model, DEVICE_TYPE_LABELS[tempest.primaryDeviceType] || 'Tempest'),
      brand: trimString(plain?.brand, 'WeatherFlow'),
      isOnline: plain?.isOnline !== false,
      observedAt: tempest.lastObservationAt || plain?.lastSeen || null,
      lastEventAt: tempest.lastEventAt || null,
      location: {
        latitude: toNumber(tempest.latitude),
        longitude: toNumber(tempest.longitude),
        timezone: trimString(tempest.timezone, '')
      },
      metrics: {
        temperatureF: toNumber(display.temperatureF),
        feelsLikeF: toNumber(display.feelsLikeF),
        dewPointF: toNumber(display.dewPointF),
        humidityPct: toNumber(display.humidityPct),
        windLullMph: toNumber(display.windLullMph),
        windAvgMph: toNumber(display.windAvgMph),
        windGustMph: toNumber(display.windGustMph),
        windRapidMph: toNumber(display.windRapidMph),
        windDirectionDeg: toNumber(display.windDirectionDeg),
        pressureMb: toNumber(display.pressureMb),
        pressureInHg: toNumber(display.pressureInHg),
        pressureTrend: trimString(display.pressureTrend, ''),
        rainLastMinuteIn: toNumber(display.rainLastMinuteIn),
        rainTodayIn: toNumber(display.rainTodayIn),
        rainRateInPerHr: toNumber(display.rainRateInPerHr),
        illuminanceLux: toNumber(display.illuminanceLux),
        uvIndex: toNumber(display.uvIndex),
        solarRadiationWm2: toNumber(display.solarRadiationWm2),
        lightningAvgDistanceKm: toNumber(display.lightningAvgDistanceKm),
        lightningAvgDistanceMiles: toNumber(display.lightningAvgDistanceMiles),
        lightningCount: toNumber(display.lightningCount),
        batteryVolts: toNumber(display.batteryVolts)
      },
      status: {
        sensorStatusFlags: Array.isArray(health.sensorStatusFlags) ? health.sensorStatusFlags : [],
        firmwareRevision: trimString(health.firmwareRevision, ''),
        hubFirmwareRevision: trimString(health.hubFirmwareRevision, ''),
        signalRssi: toNumber(health.rssi),
        hubRssi: toNumber(health.hubRssi),
        websocketConnected: health.websocketConnected === true,
        udpListening: health.udpListening === true
      }
    };
  }

  buildStationDevicePayload(station, integration, existingDevice) {
    const existingTempest = existingDevice?.properties?.tempest || {};
    const sensorDevices = Array.isArray(station.devices)
      ? station.devices.filter((device) => device.type !== 'HB')
      : [];

    return {
      name: station.name,
      type: 'sensor',
      room: trimString(integration?.room, existingDevice?.room || 'Outside'),
      status: existingDevice?.status ?? true,
      temperature: existingDevice?.temperature,
      properties: {
        ...(existingDevice?.properties || {}),
        source: 'tempest',
        tempest: {
          ...existingTempest,
          stationId: station.stationId,
          stationName: station.name,
          publicName: station.publicName,
          latitude: station.latitude,
          longitude: station.longitude,
          timezone: station.timezone,
          elevationM: station.elevationM,
          isLocalMode: station.isLocalMode,
          deviceIds: station.sensorDeviceIds,
          serialNumbers: station.sensorSerialNumbers,
          hubDeviceId: station.hubDeviceId,
          hubSerialNumber: station.hubSerialNumber,
          primaryDeviceId: station.primaryDeviceId,
          primaryDeviceType: station.primaryDeviceType,
          devices: sensorDevices,
          stationItems: station.stationItems,
          createdEpoch: station.createdEpoch,
          lastModifiedEpoch: station.lastModifiedEpoch,
          metrics: existingTempest.metrics || {},
          derived: existingTempest.derived || {},
          display: existingTempest.display || {},
          health: existingTempest.health || {}
        }
      },
      brand: 'WeatherFlow',
      model: DEVICE_TYPE_LABELS[station.primaryDeviceType] || 'Tempest',
      isOnline: existingDevice?.isOnline ?? false,
      lastSeen: existingDevice?.lastSeen || new Date()
    };
  }

  async upsertStationDevice(station, integration) {
    const existingDevice = await Device.findOne({
      'properties.source': 'tempest',
      'properties.tempest.stationId': station.stationId
    });

    const payload = this.buildStationDevicePayload(station, integration, existingDevice);
    let device = existingDevice;

    if (device) {
      device.name = payload.name;
      device.type = payload.type;
      device.room = payload.room;
      device.status = payload.status;
      device.temperature = payload.temperature;
      device.properties = payload.properties;
      device.brand = payload.brand;
      device.model = payload.model;
      device.isOnline = payload.isOnline;
      device.lastSeen = payload.lastSeen;
      await device.save();
    } else {
      device = await Device.create(payload);
    }

    const normalized = deviceUpdateEmitter.normalizeDevices([device]);
    if (normalized.length > 0) {
      deviceUpdateEmitter.emit('devices:update', normalized);
    }

    return device;
  }

  async syncStations({ integration: providedIntegration = null, reason = 'manual' } = {}) {
    const integration = providedIntegration || await TempestIntegration.getIntegration();
    const persistedIntegration = integration._id
      ? integration
      : await TempestIntegration.findOne() || new TempestIntegration(TempestIntegration.getDefaultIntegration());
    const resolvedToken = this.resolveToken(null, integration);

    if (!resolvedToken) {
      throw new Error('A Tempest Personal Access Token is required before syncing stations.');
    }

    const payload = await this.requestJson('/stations', { token: resolvedToken });
    const stations = normalizeDiscoveryResponse(payload);

    for (const station of stations) {
      await this.upsertStationDevice(station, persistedIntegration);
    }

    const selectedStation = stations.find((station) => station.stationId === toNumber(persistedIntegration.selectedStationId))
      || stations[0]
      || null;

    if (selectedStation) {
      persistedIntegration.selectedStationId = selectedStation.stationId;
      persistedIntegration.selectedDeviceIds = selectedStation.sensorDeviceIds;
    }

    persistedIntegration.isConnected = true;
    persistedIntegration.lastError = '';
    persistedIntegration.lastDiscoveryAt = new Date();
    persistedIntegration.lastSyncAt = new Date();
    if (!persistedIntegration.token && integration.token) {
      persistedIntegration.token = integration.token;
    }
    await persistedIntegration.save();

    if (selectedStation) {
      await this.syncLatestObservationForStation({
        integration: persistedIntegration,
        stationId: selectedStation.stationId
      }).catch((error) => {
        console.warn('TempestService: latest observation sync failed:', error.message);
      });
    }

    return {
      success: true,
      reason,
      integration: persistedIntegration,
      stations
    };
  }

  async syncLatestObservationForStation({ integration: providedIntegration = null, stationId = null } = {}) {
    const integration = providedIntegration || await TempestIntegration.getIntegration();
    const selectedStationId = toNumber(stationId) ?? toNumber(integration.selectedStationId);
    const resolvedToken = this.resolveToken(null, integration);

    if (selectedStationId === null || !resolvedToken) {
      return null;
    }

    const payload = await this.requestJson(`/observations/station/${selectedStationId}`, {
      token: resolvedToken
    });

    const observations = Array.isArray(payload?.obs) ? payload.obs : [];
    for (const observation of observations) {
      await this.ingestObservation({
        type: trimString(payload?.type, 'obs_st'),
        values: observation,
        deviceId: toNumber(payload?.device_id),
        stationId: selectedStationId,
        source: 'rest',
        raw: payload
      });
    }

    return this.getSelectedStationSnapshot(selectedStationId);
  }

  async configureIntegration(configuration = {}) {
    const integration = await TempestIntegration.findOne() || new TempestIntegration(TempestIntegration.getDefaultIntegration());

    if (Object.prototype.hasOwnProperty.call(configuration, 'token')) {
      integration.token = trimString(configuration.token, '');
    }
    if (Object.prototype.hasOwnProperty.call(configuration, 'enabled')) {
      integration.enabled = configuration.enabled === true;
    }
    if (Object.prototype.hasOwnProperty.call(configuration, 'websocketEnabled')) {
      integration.websocketEnabled = configuration.websocketEnabled !== false;
    }
    if (Object.prototype.hasOwnProperty.call(configuration, 'udpEnabled')) {
      integration.udpEnabled = configuration.udpEnabled === true;
    }
    if (Object.prototype.hasOwnProperty.call(configuration, 'udpBindAddress')) {
      integration.udpBindAddress = trimString(configuration.udpBindAddress, integration.udpBindAddress || '0.0.0.0');
    }
    if (Object.prototype.hasOwnProperty.call(configuration, 'udpPort')) {
      integration.udpPort = clampInteger(configuration.udpPort, integration.udpPort || 50222, 1, 65535);
    }
    if (Object.prototype.hasOwnProperty.call(configuration, 'room')) {
      integration.room = trimString(configuration.room, 'Outside');
    }
    if (Object.prototype.hasOwnProperty.call(configuration, 'selectedStationId')) {
      integration.selectedStationId = toNumber(configuration.selectedStationId);
    }
    if (Object.prototype.hasOwnProperty.call(configuration, 'selectedDeviceIds') && Array.isArray(configuration.selectedDeviceIds)) {
      integration.selectedDeviceIds = configuration.selectedDeviceIds
        .map((deviceId) => toNumber(deviceId))
        .filter((deviceId) => deviceId !== null);
    }

    const calibration = configuration.calibration || {};
    if (typeof calibration === 'object' && calibration) {
      integration.calibration = {
        ...integration.calibration?.toObject?.(),
        ...integration.calibration,
        ...calibration
      };
    }

    await integration.save();

    if (integration.enabled) {
      await this.refreshRuntime({ reason: 'configure' });
    } else {
      integration.isConnected = false;
      integration.lastError = '';
      integration.websocket.connected = false;
      integration.udp.listening = false;
      await integration.save();
      this.stopRealtime();
    }

    return this.getStatus();
  }

  async getStatus() {
    const integration = await TempestIntegration.getIntegration();
    const stations = await this.listProvisionedStations();
    const selectedStation = stations.find((station) => station.stationId === toNumber(integration.selectedStationId)) || null;

    return {
      integration: integration.toSanitized ? integration.toSanitized() : integration,
      health: {
        isConnected: integration.isConnected === true,
        websocketConnected: integration.websocket?.connected === true,
        websocketLastConnectedAt: integration.websocket?.lastConnectedAt || null,
        websocketLastMessageAt: integration.websocket?.lastMessageAt || null,
        websocketReconnectCount: integration.websocket?.reconnectCount || 0,
        udpListening: integration.udp?.listening === true,
        udpLastMessageAt: integration.udp?.lastMessageAt || null,
        lastDiscoveryAt: integration.lastDiscoveryAt || null,
        lastObservationAt: integration.lastObservationAt || null,
        lastError: integration.lastError || ''
      },
      selectedStation,
      stations
    };
  }

  async updateIntegrationState(update) {
    const integration = await TempestIntegration.findOne() || new TempestIntegration(TempestIntegration.getDefaultIntegration());
    Object.assign(integration, update);
    await integration.save();
    return integration;
  }

  async updateRealtimeState({ websocketConnected, websocketLastConnectedAt, websocketLastMessageAt, websocketReconnectCount, udpListening, udpLastMessageAt, lastError }) {
    const integration = await TempestIntegration.findOne();
    if (!integration) {
      return;
    }

    if (typeof websocketConnected === 'boolean') {
      integration.websocket.connected = websocketConnected;
    }
    if (websocketLastConnectedAt !== undefined) {
      integration.websocket.lastConnectedAt = websocketLastConnectedAt;
    }
    if (websocketLastMessageAt !== undefined) {
      integration.websocket.lastMessageAt = websocketLastMessageAt;
    }
    if (websocketReconnectCount !== undefined) {
      integration.websocket.reconnectCount = websocketReconnectCount;
    }
    if (typeof udpListening === 'boolean') {
      integration.udp.listening = udpListening;
    }
    if (udpLastMessageAt !== undefined) {
      integration.udp.lastMessageAt = udpLastMessageAt;
    }
    if (lastError !== undefined) {
      integration.lastError = lastError;
    }
    await integration.save();
  }

  async ensureRealtimeConnections(providedIntegration = null) {
    if (!this.backgroundEnabled) {
      return;
    }

    const integration = providedIntegration || await TempestIntegration.getIntegration();
    const resolvedToken = this.resolveToken(null, integration);

    if (!integration.enabled || !resolvedToken) {
      this.stopRealtime();
      return;
    }

    const selectedDeviceIds = Array.isArray(integration.selectedDeviceIds)
      ? integration.selectedDeviceIds.map((deviceId) => toNumber(deviceId)).filter((deviceId) => deviceId !== null)
      : [];

    if (integration.websocketEnabled && selectedDeviceIds.length > 0) {
      this.startWebSocket(resolvedToken, selectedDeviceIds);
    } else {
      this.stopWebSocket({ resetSelection: true });
    }

    if (integration.udpEnabled) {
      this.startUdpListener({
        bindAddress: trimString(integration.udpBindAddress, '0.0.0.0'),
        port: clampInteger(integration.udpPort, 50222, 1, 65535)
      });
    } else {
      this.stopUdpListener();
    }
  }

  startWebSocket(token, deviceIds) {
    const selectionKey = `${token}:${deviceIds.sort((a, b) => a - b).join(',')}`;
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN && this.websocketSelectionKey === selectionKey) {
      return;
    }

    this.stopWebSocket({ resetSelection: false });
    this.websocketSelectionKey = selectionKey;

    const wsUrl = `${this.websocketUrlBase}?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(wsUrl);
    this.websocket = socket;

    socket.on('open', () => {
      this.websocketReconnectAttempt = 0;
      void this.updateRealtimeState({
        websocketConnected: true,
        websocketLastConnectedAt: new Date(),
        websocketReconnectCount: 0,
        lastError: ''
      }).catch(() => {});

      deviceIds.forEach((deviceId) => {
        socket.send(JSON.stringify({
          type: 'listen_start',
          device_id: deviceId,
          id: `homebrain-${deviceId}`
        }));
        socket.send(JSON.stringify({
          type: 'listen_rapid_start',
          device_id: deviceId,
          id: `homebrain-rapid-${deviceId}`
        }));
      });
    });

    socket.on('message', (raw) => {
      const receivedAt = new Date();
      void this.updateRealtimeState({
        websocketConnected: true,
        websocketLastMessageAt: receivedAt,
        lastError: ''
      }).catch(() => {});

      let payload = null;
      try {
        payload = JSON.parse(raw.toString());
      } catch (error) {
        console.warn('TempestService: failed to parse websocket payload:', error.message);
        return;
      }

      void this.ingestMessage(payload, { source: 'ws', receivedAt }).catch((error) => {
        console.warn('TempestService: websocket ingest failed:', error.message);
      });
    });

    socket.on('close', () => {
      void this.updateRealtimeState({
        websocketConnected: false
      }).catch(() => {});
      this.scheduleWebSocketReconnect();
    });

    socket.on('error', (error) => {
      console.warn('TempestService: websocket error:', error.message);
      void this.updateRealtimeState({
        websocketConnected: false,
        lastError: error.message || 'Tempest websocket error'
      }).catch(() => {});
    });
  }

  scheduleWebSocketReconnect() {
    if (!this.backgroundEnabled || !this.websocketSelectionKey) {
      return;
    }

    if (this.websocketReconnectTimer) {
      clearTimeout(this.websocketReconnectTimer);
      this.websocketReconnectTimer = null;
    }

    this.websocketReconnectAttempt += 1;
    const delay = Math.min(30_000, 1_500 * (2 ** (this.websocketReconnectAttempt - 1)));
    const jitter = Math.floor(Math.random() * 750);

    this.websocketReconnectTimer = setTimeout(async () => {
      this.websocketReconnectTimer = null;
      const integration = await TempestIntegration.getIntegration();
      await this.updateRealtimeState({
        websocketReconnectCount: this.websocketReconnectAttempt
      }).catch(() => {});
      await this.ensureRealtimeConnections(integration);
    }, delay + jitter);

    if (typeof this.websocketReconnectTimer.unref === 'function') {
      this.websocketReconnectTimer.unref();
    }
  }

  stopWebSocket({ resetSelection = true } = {}) {
    if (this.websocketReconnectTimer) {
      clearTimeout(this.websocketReconnectTimer);
      this.websocketReconnectTimer = null;
    }

    const socket = this.websocket;
    this.websocket = null;

    if (socket) {
      try {
        socket.removeAllListeners();
        socket.close();
      } catch (error) {
        // Ignore close errors during shutdown.
      }
    }

    if (resetSelection) {
      this.websocketSelectionKey = '';
      this.websocketReconnectAttempt = 0;
    }
  }

  startUdpListener({ bindAddress, port }) {
    const configKey = `${bindAddress}:${port}`;
    if (this.udpSocket && this.udpConfigKey === configKey) {
      return;
    }

    this.stopUdpListener();
    const socket = dgram.createSocket('udp4');
    this.udpSocket = socket;
    this.udpConfigKey = configKey;

    socket.on('error', (error) => {
      console.warn('TempestService: udp listener error:', error.message);
      void this.updateRealtimeState({
        udpListening: false,
        lastError: error.message || 'Tempest UDP listener error'
      }).catch(() => {});
    });

    socket.on('listening', () => {
      this.udpListening = true;
      void this.updateRealtimeState({
        udpListening: true,
        lastError: ''
      }).catch(() => {});
    });

    socket.on('message', (buffer, rinfo) => {
      const receivedAt = new Date();
      void this.updateRealtimeState({
        udpListening: true,
        udpLastMessageAt: receivedAt
      }).catch(() => {});

      let payload = null;
      try {
        payload = JSON.parse(buffer.toString('utf8'));
      } catch (error) {
        console.warn('TempestService: failed to parse udp payload:', error.message);
        return;
      }

      void this.ingestMessage(payload, {
        source: 'udp',
        receivedAt,
        rinfo
      }).catch((error) => {
        console.warn('TempestService: udp ingest failed:', error.message);
      });
    });

    socket.bind(port, bindAddress, () => {
      try {
        socket.setBroadcast(true);
      } catch (error) {
        // Some environments do not need broadcast enabled after bind.
      }
    });
  }

  stopUdpListener() {
    const socket = this.udpSocket;
    this.udpSocket = null;
    this.udpConfigKey = '';
    this.udpListening = false;

    if (socket) {
      try {
        socket.removeAllListeners();
        socket.close();
      } catch (error) {
        // Ignore close errors during shutdown.
      }
    }
  }

  async findStationDevice(lookup) {
    const query = buildTempestDeviceQuery(lookup);
    if (!query) {
      return null;
    }

    return Device.findOne(query);
  }

  async updateDeviceFromObservation(device, observation, extras = {}) {
    if (!device || !observation) {
      return null;
    }

    const tempest = {
      ...(device.properties?.tempest || {})
    };
    const mergedMetrics = {
      ...(tempest.metrics || {}),
      ...(observation.metrics || {})
    };
    const mergedDerived = {
      ...(tempest.derived || {}),
      ...(observation.derived || {})
    };

    tempest.metrics = mergedMetrics;
    tempest.derived = mergedDerived;
    tempest.display = buildDisplayMetrics(mergedMetrics, mergedDerived);
    tempest.lastObservationAt = observation.observedAt;
    tempest.lastObservationType = observation.observationType;
    tempest.lastSource = observation.source;
    tempest.health = {
      ...(tempest.health || {}),
      websocketConnected: extras.source === 'ws' ? true : tempest.health?.websocketConnected === true,
      udpListening: extras.source === 'udp' ? true : tempest.health?.udpListening === true
    };

    if (extras.firmwareRevision) {
      tempest.health.firmwareRevision = trimString(extras.firmwareRevision, tempest.health.firmwareRevision || '');
    }

    device.temperature = cToF(mergedMetrics.temp_c) ?? device.temperature;
    device.status = true;
    device.isOnline = true;
    device.lastSeen = observation.observedAt;
    device.properties = {
      ...(device.properties || {}),
      source: 'tempest',
      tempest
    };
    await device.save();

    const normalized = deviceUpdateEmitter.normalizeDevices([device]);
    if (normalized.length > 0) {
      deviceUpdateEmitter.emit('devices:update', normalized);
    }

    const integration = await TempestIntegration.findOne();
    if (integration) {
      integration.isConnected = true;
      integration.lastObservationAt = observation.observedAt;
      integration.lastError = '';
      await integration.save();
    }

    return device;
  }

  async updateDeviceFromStatusMessage(device, message, { source }) {
    if (!device) {
      return null;
    }

    const tempest = {
      ...(device.properties?.tempest || {})
    };
    const health = {
      ...(tempest.health || {})
    };

    if (message.type === 'device_status') {
      health.firmwareRevision = trimString(message.firmware_revision, health.firmwareRevision || '');
      health.rssi = toNumber(message.rssi);
      health.hubRssi = toNumber(message.hub_rssi);
      health.uptimeSeconds = toNumber(message.uptime);
      health.voltage = toNumber(message.voltage);
      health.sensorStatus = toNumber(message.sensor_status);
      health.sensorStatusFlags = decodeSensorStatus(message.sensor_status);
    }

    if (message.type === 'hub_status') {
      health.hubFirmwareRevision = trimString(message.firmware_revision, health.hubFirmwareRevision || '');
      health.hubUptimeSeconds = toNumber(message.uptime);
      health.hubRssi = toNumber(message.rssi);
      health.resetFlags = trimString(message.reset_flags, '');
    }

    health.websocketConnected = source === 'ws' ? true : health.websocketConnected === true;
    health.udpListening = source === 'udp' ? true : health.udpListening === true;

    tempest.health = health;
    tempest.lastHealthUpdateAt = new Date();
    device.properties = {
      ...(device.properties || {}),
      source: 'tempest',
      tempest
    };
    device.isOnline = true;
    device.lastSeen = new Date();
    await device.save();

    const normalized = deviceUpdateEmitter.normalizeDevices([device]);
    if (normalized.length > 0) {
      deviceUpdateEmitter.emit('devices:update', normalized);
    }

    return device;
  }

  async ingestObservation({ type, values, deviceId, stationId = null, serialNumber = '', hubSerialNumber = '', source, raw, firmwareRevision = '' }) {
    const device = await this.findStationDevice({
      stationId,
      deviceId,
      serialNumber,
      hubSerialNumber
    });
    if (!device) {
      return null;
    }

    const integration = await TempestIntegration.getIntegration();
    const tempest = device.properties?.tempest || {};
    const observation = normalizeObservationPayload({
      type,
      values,
      deviceId: toNumber(deviceId) ?? toNumber(tempest.primaryDeviceId) ?? toNumber(tempest.deviceIds?.[0]),
      stationId: toNumber(tempest.stationId),
      stationName: trimString(tempest.stationName, device.name),
      source,
      raw,
      calibration: integration.calibration || {},
      previousMetrics: tempest.metrics || {}
    });

    if (!observation) {
      return null;
    }

    await TempestObservation.updateOne(
      {
        stationId: observation.stationId,
        deviceId: observation.deviceId,
        observedAt: observation.observedAt,
        observationType: observation.observationType
      },
      {
        $setOnInsert: {
          stationName: observation.stationName,
          source: observation.source,
          metrics: observation.metrics,
          derived: observation.derived,
          raw: observation.raw,
          createdAt: new Date()
        }
      },
      {
        upsert: true
      }
    );

    await this.updateDeviceFromObservation(device, observation, {
      source,
      firmwareRevision
    });

    return observation;
  }

  async ingestEvent({ type, values, deviceId, stationId = null, serialNumber = '', hubSerialNumber = '', source, raw, receivedAt }) {
    const device = await this.findStationDevice({
      stationId,
      deviceId,
      serialNumber,
      hubSerialNumber
    });
    if (!device) {
      return null;
    }

    const tempest = device.properties?.tempest || {};
    const event = normalizeEventPayload({
      type,
      values,
      deviceId: toNumber(deviceId) ?? toNumber(tempest.primaryDeviceId) ?? toNumber(tempest.deviceIds?.[0]),
      stationId: toNumber(tempest.stationId),
      stationName: trimString(tempest.stationName, device.name),
      source,
      raw,
      receivedAt
    });

    if (!event) {
      return null;
    }

    await TempestEvent.updateOne(
      {
        stationId: event.stationId,
        deviceId: event.deviceId,
        eventType: event.eventType,
        eventAt: event.eventAt
      },
      {
        $setOnInsert: {
          stationName: event.stationName,
          source: event.source,
          payload: event.payload,
          raw: event.raw,
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    const health = {
      ...(tempest.health || {})
    };
    const eventState = {
      ...(tempest.events || {})
    };

    if (event.eventType === 'lightning_strike') {
      eventState.lastLightningStrikeAt = event.eventAt;
      eventState.lastLightningStrike = event.payload;
    }

    if (event.eventType === 'precip_start') {
      eventState.lastPrecipStartAt = event.eventAt;
    }

    device.properties = {
      ...(device.properties || {}),
      source: 'tempest',
      tempest: {
        ...tempest,
        health,
        events: eventState,
        lastEventAt: event.eventAt
      }
    };
    device.isOnline = true;
    device.lastSeen = event.eventAt;
    await device.save();

    const normalized = deviceUpdateEmitter.normalizeDevices([device]);
    if (normalized.length > 0) {
      deviceUpdateEmitter.emit('devices:update', normalized);
    }

    return event;
  }

  async ingestMessage(message, { source, receivedAt = new Date() } = {}) {
    if (!message || typeof message !== 'object') {
      return null;
    }

    const type = trimString(message.type, '');
    if (!type || type === 'ack') {
      return null;
    }

    if (['obs_st', 'obs_air', 'obs_sky'].includes(type)) {
      const values = Array.isArray(message.obs) ? message.obs[0] : null;
      return this.ingestObservation({
        type,
        values,
        deviceId: toNumber(message.device_id),
        stationId: toNumber(message.station_id),
        serialNumber: trimString(message.serial_number, ''),
        hubSerialNumber: trimString(message.hub_sn, ''),
        source,
        raw: message,
        firmwareRevision: trimString(message.firmware_revision, '')
      });
    }

    if (type === 'rapid_wind') {
      return this.ingestObservation({
        type,
        values: message.ob,
        deviceId: toNumber(message.device_id),
        stationId: toNumber(message.station_id),
        serialNumber: trimString(message.serial_number, ''),
        hubSerialNumber: trimString(message.hub_sn, ''),
        source,
        raw: message,
        firmwareRevision: trimString(message.firmware_revision, '')
      });
    }

    if (type === 'evt_strike' || type === 'evt_precip') {
      return this.ingestEvent({
        type,
        values: message.evt,
        deviceId: toNumber(message.device_id),
        stationId: toNumber(message.station_id),
        serialNumber: trimString(message.serial_number, ''),
        hubSerialNumber: trimString(message.hub_sn, ''),
        source,
        raw: message,
        receivedAt
      });
    }

    if (type === 'device_status' || type === 'hub_status') {
      const device = await this.findStationDevice({
        stationId: toNumber(message.station_id),
        serialNumber: trimString(message.serial_number, ''),
        hubSerialNumber: trimString(message.hub_sn, '')
      });
      return this.updateDeviceFromStatusMessage(device, message, { source });
    }

    return null;
  }

  async getSelectedStationSnapshot(stationId = null) {
    const device = await this.getSelectedStationDevice(stationId);
    if (!device) {
      return null;
    }

    return this.buildStationSummary(device);
  }

  async getObservations({ stationId = null, hours = 24, limit = OBSERVATION_RETENTION_LIMIT } = {}) {
    const resolvedStationId = toNumber(stationId);
    const query = {};
    if (resolvedStationId !== null) {
      query.stationId = resolvedStationId;
    } else {
      const station = await this.getSelectedStationSnapshot();
      if (station?.stationId !== null) {
        query.stationId = station.stationId;
      }
    }

    const hoursBack = clampInteger(hours, 24, 1, 24 * 14);
    const maxRecords = clampInteger(limit, OBSERVATION_RETENTION_LIMIT, 10, 2000);
    query.observedAt = {
      $gte: new Date(Date.now() - hoursBack * 60 * 60 * 1000)
    };

    const observations = await TempestObservation.find(query)
      .sort({ observedAt: -1 })
      .limit(maxRecords);

    return observations
      .map((entry) => ({
        stationId: entry.stationId,
        deviceId: entry.deviceId,
        observationType: entry.observationType,
        source: entry.source,
        observedAt: entry.observedAt,
        metrics: entry.metrics,
        derived: entry.derived
      }))
      .reverse();
  }

  async getEvents({ stationId = null, limit = 40 } = {}) {
    const resolvedStationId = toNumber(stationId);
    const query = {};
    if (resolvedStationId !== null) {
      query.stationId = resolvedStationId;
    } else {
      const station = await this.getSelectedStationSnapshot();
      if (station?.stationId !== null) {
        query.stationId = station.stationId;
      }
    }

    const maxRecords = clampInteger(limit, 40, 1, 250);
    const events = await TempestEvent.find(query)
      .sort({ eventAt: -1 })
      .limit(maxRecords);

    return events.map((event) => ({
      stationId: event.stationId,
      deviceId: event.deviceId,
      eventType: event.eventType,
      source: event.source,
      eventAt: event.eventAt,
      payload: event.payload
    }));
  }

  async getDashboardData({ hours = 24 } = {}) {
    const station = await this.getSelectedStationSnapshot();
    if (!station) {
      return {
        available: false,
        station: null,
        observations: [],
        events: []
      };
    }

    return {
      available: true,
      station,
      observations: await this.getObservations({ stationId: station.stationId, hours, limit: OBSERVATION_RETENTION_LIMIT }),
      events: await this.getEvents({ stationId: station.stationId, limit: 32 })
    };
  }
}

module.exports = new TempestService();

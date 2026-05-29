'use strict';

// DirectRadioService Zigbee methods (mixed onto the prototype). Extracted from
// directRadioService.js (Phase 5b full decomposition).

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const mongoose = require('mongoose');
const path = require('path');
const Device = require('../models/Device');
const EventStreamEvent = require('../models/EventStreamEvent');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const directRadioEngineLogService = require('./directRadioEngineLogService');
const eventStreamService = require('./eventStreamService');
const {
  DIRECT_RADIO_SOURCES,
  buildDirectFeatureProperties,
  buildNormalizedCapabilities,
  buildMigrationPlan,
  inferFeaturesFromSmartThings,
  isDirectRadioDevice,
  normalizeFeature
} = require('./directRadioDeviceCatalog');
const directRadioProtocolCatalogService = require('./directRadioProtocolCatalogService');
const {
  inferDirectDeviceType,
  isDirectLightContext
} = require('./deviceTypeClassification');
const {
  resolveLocalSerialById,
  resolveRealPath,
  buildFallbackSerialPort,
  hasPortCandidate,
  listFallbackSerialDevicePaths,
  addFallbackSerialPortCandidates,
  normalizeSerialPort,
  serialDescriptorSearchText,
  enrichSerialPortForDirectRadios,
  looksLikeSonoffMg24ThreadStick,
  scorePortForProtocol,
  choosePortForProtocol,
  describeSerialEndpoints
} = require('./directRadio/serialPorts');
const {
  toFiniteNumber,
  clampPercent,
  normalizeZWaveBatteryReport,
  hexToRgbPercent,
  kelvinToMired,
  miredToKelvin,
  roundTo,
  celsiusToFahrenheit
} = require('./directRadio/conversions');
const {
  DATA_DIR,
  ZIGBEE_DIR,
  ZWAVE_DIR,
  CONFIG_PATH,
  DEFAULT_PAIRING_SECONDS,
  MAX_PAIRING_SECONDS,
  DEFAULT_HARDWARE_SCAN_INTERVAL_MS,
  DIRECT_DEVICE_PROJECTION,
  ZWAVE_NODE_STATUS,
  trimString,
  normalizeZWaveStatus,
  isZWaveStatusUnavailable,
  isZWaveNodeOnline,
  isZWaveNodeCommandReady,
  isTerminalPairingStatus,
  isZWavePairingCompletionReason,
  buildDirectDeviceQuery,
  isZWaveDirectUpdateInterviewComplete,
  normalizeDirectRoom,
  shouldReplaceGeneratedDirectName,
  shouldReplaceGeneratedDirectRoom,
  inferFeaturesFromExistingDirectRecord,
  mergeDirectDeviceUpdateForExisting,
  directFeatureCount,
  directRecordTimestamp,
  isGenericDirectRadioName,
  isIncompleteDirectRadioDuplicate,
  directRecordMatchesIdentity,
  isDuplicateDirectRadioRecord,
  selectPrimaryDirectDeviceRecord,
  parseEnabledFlag,
  boundedSeconds,
  boundedIntervalMs,
  delay,
  enumMemberName,
  getNumericNodeId,
  parseOptionalBoolean,
  normalizeZWaveSecurityMode,
  shouldUseSecureZWaveMigration,
  uniqueStrings,
  normalizeSourceText,
  getDeviceIdString,
  getDeviceProperties,
  toPlainDeviceSnapshot,
  getSmartThingsMigration,
  isRetiredSmartThingsMigrationSource,
  normalizeMigrationNameTokens,
  scoreTokenOverlap,
  countTokenOverlap,
  filterStrongMigrationTokens,
  hasManufacturerIdentityMatch,
  smartThingsNetworkTypeMatchesProtocol,
  readSmartThingsBatteryLevel,
  readSmartThingsTemperatureF,
  copySmartThingsHistoryProperties,
  mergeSmartThingsTelemetryFallback,
  normalizeSmartThingsState,
  isSmartThingsDeviceGoneError,
  getSmartThingsHubId,
  getSmartThingsProvisioningState,
  isSmartThingsUnprovisionedState,
  getNewestSmartThingsTimestamp,
  summarizeSmartThingsExclusionEvidence,
  collectSmartThingsExclusionCounters,
  findSmartThingsExclusionCounterIncrease,
  normalizeObjectId,
  ensureDirSync,
  readJsonFile,
  writeJsonFile,
  randomByteArray,
  randomHex,
  protocolSource,
  withTimeout,
  ZIGBEE_COMMON_ENDPOINT_IDS,
  getZigbeeEndpointId,
  collectZigbeeEndpointClusterTokens,
  getZigbeeEndpoints,
  getZigbeeClusterPreferenceForAction,
  scoreZigbeeEndpoint,
  readZigbeeEndpoint,
  readZigbeeEndpointAttribute,
  endpointHasZigbeeCluster,
  readZigbeeAttributeFromResponse,
  readZigbeeLiveSensorState,
  normalizeZigbeeSwitchState,
  normalizeZigbeePercent,
  normalizeZigbeeActiveState,
  normalizeZigbeeContactOpen,
  normalizeZigbeeBatteryPercent,
  normalizeZigbeeBatteryVoltage,
  looksLikeBatteryVoltage,
  normalizeZigbeeBatteryVoltageFromState,
  inferZigbeeBatteryPercentFromVoltage,
  fillBatteryPercentFromVoltage,
  coerceZigbeeNumericValue,
  normalizeZigbeeScaledNumber,
  normalizeZigbeePowerWatts,
  normalizeZigbeeEnergyKwh,
  normalizeZigbeeVoltageVolts,
  normalizeZigbeeCurrentAmps,
  normalizeZigbeeTemperatureC,
  normalizeZigbeeHumidityPercent,
  normalizeZigbeeIlluminanceLux,
  normalizeZigbeeColorTemperatureKelvin,
  readZigbeeStateObjectValue,
  assignDefined,
  assignDefinedIfMissing,
  readZigbeeMessageData,
  hasDirectFeature,
  applyZoneStatusToDirectState,
  extractZigbeeMessageState,
  mergeDirectState,
  readZigbeeStateObject,
  readZigbeeEndpointSensorAttributes,
  directStateToTopLevel,
  inferFeaturesFromDirectRadioState,
  readZigbeeDirectRadioState,
  readZigbeeRuntimeState,
  scoreDetachedSmartThingsMigrationSource,
  buildRecoveredSmartThingsMigrationSnapshot,
  extractZigbeeOnOffReadResponse,
  extractZigbeeBrightnessReadResponse,
  extractZigbeeColorTemperatureReadResponse,
  normalizeZigbeeClusterToken,
  collectZigbeeClusterTokens,
  extractZigbeeDefinition,
  inferFeaturesFromZigbeeDefinition,
  getZWaveValue,
  valueMetadataLabel,
  findZWaveValueByLabel,
  normalizeNumber,
  normalizeInteger,
  normalizeCatalogVolumeOptions,
  normalizeCatalogSoundOptions,
  isSirenVolumeParameter,
  isSirenSoundParameter,
  getSirenVolumeConfigParameterFromCatalog,
  getSirenSoundConfigParameterFromCatalog,
  getSirenVolumeOptionsFromParameter,
  getSirenSoundOptionsFromParameter,
  getSirenVolumeRangeFromParameter,
  getSirenSoundRangeFromParameter,
  resolveSirenVolumeValue,
  resolveSirenSoundValue,
  buildSirenVolumeProperties,
  buildSirenSoundProperties,
  hasZWaveValue,
  normalizeLockCodeSlot,
  normalizeLockCodeName,
  normalizeLockPin,
  enumLabel,
  operationSucceeded,
  getLockCodeAssignments,
  getAssignmentForSlot,
  getZWaveAccessControl,
  getZWaveLockCodeCapabilities,
  codeNameForSlot,
  lockEventActionFromLabel,
  extractLockUserId,
  serializeLockCodeSlot,
  serializeDoorLockLogRecord
} = require('./directRadioHelpers');

module.exports = {
isCompleteZigbeeNetwork(zigbee) {
    return Boolean(
      zigbee
      && Number.isFinite(Number(zigbee.panID)) && Number(zigbee.panID) > 0
      && Array.isArray(zigbee.extendedPanID) && zigbee.extendedPanID.length === 8
      && Array.isArray(zigbee.networkKey) && zigbee.networkKey.length === 16
      && Array.isArray(zigbee.channelList) && zigbee.channelList.length > 0
    );
  },

deriveZigbeeNetworkFromBackup(backup) {
    if (!backup || typeof backup !== 'object') {
      return null;
    }
    const networkKey = this.parseHexBytes(backup?.network_key?.key, 16);
    const extendedPanID = this.parseHexBytes(backup?.extended_pan_id, 8);
    let panID = null;
    const rawPan = backup.pan_id;
    if (typeof rawPan === 'string' && /^(0x)?[0-9a-fA-F]+$/.test(rawPan.trim())) {
      panID = parseInt(rawPan.trim().replace(/^0x/, ''), 16);
    } else if (Number.isFinite(Number(rawPan))) {
      panID = Number(rawPan);
    }
    const channel = Number(backup.channel);
    const channelList = Array.isArray(backup.channel_mask) && backup.channel_mask.length
      ? backup.channel_mask.map(Number).filter((value) => Number.isFinite(value))
      : (Number.isFinite(channel) && channel > 0 ? [channel] : null);
    const network = { panID, extendedPanID, networkKey, channelList };
    return this.isCompleteZigbeeNetwork(network) ? network : null;
  },

async recoverZigbeeNetworkFromBackup() {
    const backup = await readJsonFile(path.join(ZIGBEE_DIR, 'coordinator-backup.json'), null);
    return this.deriveZigbeeNetworkFromBackup(backup);
  },

detectExistingZigbeeNetwork() {
    try {
      if (fs.existsSync(path.join(ZIGBEE_DIR, 'coordinator-backup.json'))) {
        return true;
      }
      const dbPath = path.join(ZIGBEE_DIR, 'database.db');
      if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
        return true;
      }
    } catch (_error) {
      // Treat inability to inspect as "no detectable prior network".
    }
    return false;
  },

async startZigbee(serialPath) {
    try {
      this.log('info', 'zigbee', 'Starting Zigbee coordinator', {
        serialPath
      });
      const { Controller } = require('zigbee-herdsman');
      this.zigbee.converters = require('zigbee-herdsman-converters');
      const config = await this.ensureControllerConfig();
      if (this.zigbee.networkResetRisk || !this.isCompleteZigbeeNetwork(config.zigbee)) {
        this.zigbee.started = false;
        this.zigbee.error = 'Zigbee start aborted: network credentials are missing and could not be recovered. Refusing to form a new network (which would unpair every device). Restore controller-config.json / coordinator-backup.json and retry.';
        this.log('error', 'zigbee', 'Aborting Zigbee coordinator start to avoid forming a new network and unpairing all devices. Restore the radio state directory (controller-config.json + coordinator-backup.json) and restart.', {
          serialPath
        });
        return;
      }
      const controller = new Controller({
        network: {
          panID: config.zigbee.panID,
          extendedPanID: config.zigbee.extendedPanID,
          channelList: config.zigbee.channelList,
          networkKey: config.zigbee.networkKey,
          networkKeyDistribute: false
        },
        serialPort: {
          path: serialPath,
          adapter: 'zstack',
          baudRate: Number(process.env.HOMEBRAIN_ZIGBEE_BAUD_RATE || 115200),
          rtscts: parseEnabledFlag(process.env.HOMEBRAIN_ZIGBEE_RTSCTS, false)
        },
        databasePath: path.join(ZIGBEE_DIR, 'database.db'),
        databaseBackupPath: path.join(ZIGBEE_DIR, 'database.backup.db'),
        backupPath: path.join(ZIGBEE_DIR, 'coordinator-backup.json'),
        adapter: {
          disableLED: process.env.HOMEBRAIN_ZIGBEE_DISABLE_LED === 'true',
          transmitPower: Number(process.env.HOMEBRAIN_ZIGBEE_TRANSMIT_POWER || 20)
        },
        acceptJoiningDeviceHandler: async () => true
      });

      controller.on('deviceJoined', (payload) => {
        this.log('info', 'zigbee', 'Zigbee device joined', {
          ieeeAddr: payload?.device?.ieeeAddr || null,
          modelID: payload?.device?.modelID || null
        });
        this.dispatchHandler('zigbee:deviceJoined', 'zigbee', () => this.handleZigbeeDeviceChanged(payload?.device, 'deviceJoined'), { ieeeAddr: payload?.device?.ieeeAddr || null });
      });
      controller.on('deviceInterview', (payload) => {
        this.log(payload?.status === 'successful' ? 'info' : 'warn', 'zigbee', 'Zigbee device interview update', {
          status: payload?.status || null,
          ieeeAddr: payload?.device?.ieeeAddr || null,
          modelID: payload?.device?.modelID || null
        });
        if (payload?.status === 'successful') {
          this.dispatchHandler('zigbee:deviceInterview', 'zigbee', () => this.handleZigbeeDeviceChanged(payload.device, 'deviceInterview'), { ieeeAddr: payload?.device?.ieeeAddr || null });
        }
      });
      controller.on('deviceAnnounce', (payload) => {
        this.log('info', 'zigbee', 'Zigbee device announced', {
          ieeeAddr: payload?.device?.ieeeAddr || null,
          networkAddress: payload?.device?.networkAddress || null
        });
        this.dispatchHandler('zigbee:deviceAnnounce', 'zigbee', () => this.handleZigbeeDeviceChanged(payload?.device, 'deviceAnnounce'), { ieeeAddr: payload?.device?.ieeeAddr || null });
      });
      controller.on('message', (payload) => {
        this.log('info', 'zigbee', 'Zigbee message received', {
          ieeeAddr: payload?.device?.ieeeAddr || null,
          cluster: payload?.cluster || null,
          type: payload?.type || null,
          dataKeys: payload?.data && typeof payload.data === 'object' ? Object.keys(payload.data).slice(0, 12) : []
        });
        this.dispatchHandler('zigbee:message', 'zigbee', () => this.handleZigbeeDeviceChanged(payload?.device, 'message', { message: payload }), { ieeeAddr: payload?.device?.ieeeAddr || null, cluster: payload?.cluster || null });
      });
      controller.on('adapterDisconnected', () => {
        this.zigbee.started = false;
        this.zigbee.error = 'Zigbee adapter disconnected';
        this.log('error', 'zigbee', 'Zigbee adapter disconnected', {
          serialPath
        });
      });

      this.zigbee.controller = controller;
      this.zigbee.lastStartResult = await controller.start();
      this.zigbee.started = true;
      this.zigbee.error = null;
      this.zigbee.networkReset = String(this.zigbee.lastStartResult || '').toLowerCase() === 'reset';
      if (this.zigbee.networkReset) {
        this.log('error', 'zigbee', 'CRITICAL: Zigbee network was RESET on startup — the coordinator formed a brand-new network, so every previously paired Zigbee device has been removed and must be re-paired. This almost always means the saved network key / coordinator backup was lost or no longer matches the configured network. Restore the radio state directory (controller-config.json + coordinator-backup.json) before re-pairing.', {
          serialPath,
          lastStartResult: this.zigbee.lastStartResult || null
        });
      } else {
        this.log('info', 'zigbee', 'Zigbee coordinator started', {
          serialPath,
          lastStartResult: this.zigbee.lastStartResult || null
        });
      }
      await this.syncZigbeeDevices();
    } catch (error) {
      this.zigbee.started = false;
      this.zigbee.error = error.message;
      this.log('error', 'zigbee', 'Zigbee coordinator failed to start', {
        serialPath,
        error: error.message
      });
      console.warn(`DirectRadioService: Zigbee controller failed to start: ${error.message}`);
    }
  },

async reinterviewZigbeeDevice(ieeeAddr) {
    const address = trimString(ieeeAddr);
    if (!address) {
      const error = new Error('A Zigbee IEEE address is required to re-interview.');
      error.status = 400;
      throw error;
    }
    await this.start();
    const controller = this.zigbee.controller;
    if (!controller || !this.zigbee.started) {
      const error = new Error('Zigbee coordinator is not ready.');
      error.status = 503;
      throw error;
    }
    const device = typeof controller.getDeviceByIeeeAddr === 'function'
      ? controller.getDeviceByIeeeAddr(address)
      : null;
    if (!device) {
      const error = new Error(`No Zigbee device is paired with IEEE address ${address}.`);
      error.status = 404;
      throw error;
    }
    if (typeof device.interview !== 'function') {
      const error = new Error('This Zigbee device does not support a HomeBrain re-interview request.');
      error.status = 501;
      throw error;
    }

    // Sleepy battery sensors must be awake during the interview for IAS Zone
    // enrollment to complete; surface that guidance when it fails.
    const isSleepy = device.type === 'EndDevice' || device.powerSource === 'Battery';
    this.log('info', 'zigbee', 'Zigbee device re-interview requested', {
      ieeeAddr: address,
      modelID: device.modelID || null,
      isSleepy
    });

    try {
      // ignoreCache=true forces a full re-interview, re-running IAS Zone
      // enrollment for contact/motion sensors.
      await device.interview(true);
    } catch (error) {
      this.log('warn', 'zigbee', 'Zigbee device re-interview failed', {
        ieeeAddr: address,
        error: error.message
      });
      const wrapped = new Error(isSleepy
        ? `Re-interview failed: ${error.message}. Wake the sensor (open/close it or press its button) and retry so IAS Zone enrollment can complete.`
        : `Re-interview failed: ${error.message}.`);
      wrapped.status = 502;
      throw wrapped;
    }

    await this.handleZigbeeDeviceChanged(device, 'reinterview').catch((error) => {
      this.log('warn', 'zigbee', 'Failed to save Zigbee device after re-interview', {
        ieeeAddr: address,
        error: error.message
      });
    });

    return {
      ieeeAddr: address,
      modelID: device.modelID || null,
      interviewCompleted: device.interviewCompleted !== false,
      iasZone: this.readZigbeeIasEnrollment(device),
      isSleepy,
      message: `HomeBrain re-ran the Zigbee interview for ${address}.`
    };
  },

readZigbeeIasEnrollment(device) {
    try {
      const endpoints = Array.isArray(device?.endpoints) ? device.endpoints : [];
      let coordinatorIeee = null;
      try {
        coordinatorIeee = this.zigbee.controller?.getDevicesByType?.('Coordinator')?.[0]?.ieeeAddr || null;
      } catch (_error) {
        coordinatorIeee = null;
      }
      for (const endpoint of endpoints) {
        if (typeof endpoint?.getClusterAttributeValue !== 'function') {
          continue;
        }
        if (!endpointHasZigbeeCluster(endpoint, ['ssIasZone', 'ssiaszone', 1280])) {
          continue;
        }
        const cieAddr = endpoint.getClusterAttributeValue('ssIasZone', 'iasCieAddr');
        const zoneState = endpoint.getClusterAttributeValue('ssIasZone', 'zoneState');
        return {
          enrolled: Number(zoneState) === 1,
          zoneState: zoneState ?? null,
          cieAddr: cieAddr ?? null,
          coordinatorIeee,
          cieMatchesCoordinator: Boolean(cieAddr && coordinatorIeee && String(cieAddr) === String(coordinatorIeee))
        };
      }
    } catch (_error) {
      // best-effort only
    }
    return null;
  },

async syncZigbeeDevices() {
    const devices = this.zigbee.controller?.getDevices?.() || [];
    this.log('info', 'zigbee', 'Synchronizing Zigbee device inventory', {
      reportedDeviceCount: devices.length
    });
    for (const zigbeeDevice of devices) {
      if (zigbeeDevice?.type === 'Coordinator') {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await this.handleZigbeeDeviceChanged(zigbeeDevice, 'sync');
    }
  },

normalizeZigbeeDevice(zigbeeDevice, reason = 'sync', options = {}) {
    if (!zigbeeDevice) {
      return null;
    }

    const catalogMatchInput = {
      modelID: zigbeeDevice.modelID,
      manufacturerName: zigbeeDevice.manufacturerName
    };
    let definition = null;
    let catalogEntry = directRadioProtocolCatalogService.findZigbeeCatalogEntry(catalogMatchInput);
    if (!catalogEntry) {
      definition = extractZigbeeDefinition(this.zigbee.converters, zigbeeDevice);
      catalogEntry = directRadioProtocolCatalogService.findZigbeeCatalogEntry({
        ...catalogMatchInput,
        definition
      });
    }
    const baseFeatures = uniqueStrings([
      ...inferFeaturesFromZigbeeDefinition(definition, zigbeeDevice),
      ...(Array.isArray(catalogEntry?.homebrainFeatures) ? catalogEntry.homebrainFeatures : [])
    ].map(normalizeFeature)).sort();
    const directId = trimString(zigbeeDevice.ieeeAddr);
    if (!directId) {
      return null;
    }

    const name = trimString(catalogEntry?.description || definition?.description)
      || trimString(zigbeeDevice.modelID)
      || trimString(zigbeeDevice.manufacturerName)
      || `Zigbee ${directId.slice(-6)}`;
    const status = zigbeeDevice.interviewCompleted !== false;

    const runtimeState = readZigbeeRuntimeState(zigbeeDevice, {
      features: baseFeatures,
      message: options.message,
      liveSensorState: options.liveSensorState
    });
    const { directRadioState, ...runtimeUpdate } = runtimeState;
    const features = uniqueStrings([
      ...baseFeatures,
      ...inferFeaturesFromDirectRadioState(directRadioState)
    ].map(normalizeFeature)).sort();

    return {
      identity: {
        protocol: 'zigbee',
        id: directId,
        source: DIRECT_RADIO_SOURCES.zigbee
      },
      update: {
        name,
        type: this.inferDeviceTypeFromFeatures(features, {
          name,
          model: catalogEntry?.model || definition?.model || zigbeeDevice.modelID,
          vendor: catalogEntry?.vendor || definition?.vendor,
          description: catalogEntry?.description || definition?.description,
          manufacturerName: zigbeeDevice.manufacturerName
        }),
        room: 'Unassigned',
        ...runtimeUpdate,
        isOnline: status,
        lastSeen: new Date(),
        brand: trimString(catalogEntry?.vendor || definition?.vendor || zigbeeDevice.manufacturerName) || undefined,
        model: trimString(catalogEntry?.model || definition?.model || zigbeeDevice.modelID) || undefined,
        properties: {
          source: DIRECT_RADIO_SOURCES.zigbee,
          homebrainDirect: {
            protocol: 'zigbee',
            ieeeAddr: directId,
            networkAddress: zigbeeDevice.networkAddress,
            modelID: zigbeeDevice.modelID || null,
            manufacturerName: zigbeeDevice.manufacturerName || null,
            interviewCompleted: zigbeeDevice.interviewCompleted !== false,
            lastReason: reason,
            lastSeen: new Date().toISOString(),
            catalog: directRadioProtocolCatalogService.buildCatalogReference(catalogEntry)
          },
          ...(directRadioState ? { directRadioState } : {}),
          ...(directRadioState?.batteryLevel !== undefined ? { homeBrainBatteryLevel: directRadioState.batteryLevel, batteryLevel: directRadioState.batteryLevel } : {}),
          directRadioFeatures: features,
          directRadioCapabilities: buildNormalizedCapabilities(features, 'zigbee'),
          directRadioCatalog: directRadioProtocolCatalogService.compactCatalogForDevice(catalogEntry),
          ...buildDirectFeatureProperties(features)
        }
      }
    };
  },

async handleZigbeeDeviceChanged(zigbeeDevice, reason, options = {}) {
    const shouldReadLiveSensorState = ['message', 'deviceAnnounce', 'deviceInterview', 'refresh'].includes(reason);
    const liveSensorState = shouldReadLiveSensorState
      ? await readZigbeeLiveSensorState(zigbeeDevice).catch((error) => {
        this.log('debug', 'zigbee', 'Unable to read live Zigbee IAS zone status', {
          reason,
          ieeeAddr: trimString(zigbeeDevice?.ieeeAddr) || null,
          error: error?.message || String(error || 'Unknown Zigbee read error')
        });
        return {};
      })
      : {};
    const normalized = this.normalizeZigbeeDevice(zigbeeDevice, reason, {
      ...options,
      liveSensorState
    });
    if (!normalized) {
      return null;
    }
    this.log('info', 'zigbee', 'Zigbee device state normalized', {
      reason,
      ieeeAddr: normalized.identity?.id || null,
      liveZoneStatus: liveSensorState?.zoneStatus ?? null,
      features: normalized.update?.properties?.directRadioFeatures || [],
      observedStatus: Object.prototype.hasOwnProperty.call(normalized.update || {}, 'status')
        ? normalized.update.status
        : null,
      observedBrightness: Object.prototype.hasOwnProperty.call(normalized.update || {}, 'brightness')
        ? normalized.update.brightness
        : null,
      observedColorTemperature: Object.prototype.hasOwnProperty.call(normalized.update || {}, 'colorTemperature')
        ? normalized.update.colorTemperature
        : null,
      directStateKeys: normalized.update?.properties?.directRadioState
        ? Object.keys(normalized.update.properties.directRadioState)
        : []
    });
    return this.upsertDirectDevice(normalized.identity, normalized.update);
  },

async readZigbeeOnOffState(endpoint, device) {
    if (!endpoint) {
      return undefined;
    }

    if (typeof endpoint.read === 'function') {
      try {
        const response = await withTimeout(
          endpoint.read('genOnOff', ['onOff']),
          5_000,
          'Zigbee on/off readback timed out'
        );
        const status = extractZigbeeOnOffReadResponse(response);
        if (status !== undefined) {
          return status;
        }
      } catch (error) {
        this.log('warn', 'zigbee', 'Zigbee on/off readback failed after command', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          error: error.message
        });
      }
    }

    return normalizeZigbeeSwitchState(readZigbeeEndpointAttribute(
      endpoint,
      ['genOnOff', 'genonoff', 6],
      ['onOff', 'onoff', 'state']
    ));
  },

async readZigbeeBrightnessState(endpoint, device) {
    if (!endpoint) {
      return undefined;
    }

    if (typeof endpoint.read === 'function') {
      try {
        const response = await withTimeout(
          endpoint.read('genLevelCtrl', ['currentLevel']),
          5_000,
          'Zigbee brightness readback timed out'
        );
        const brightness = extractZigbeeBrightnessReadResponse(response);
        if (brightness !== undefined) {
          return brightness;
        }
      } catch (error) {
        this.log('warn', 'zigbee', 'Zigbee brightness readback failed after command', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          error: error.message
        });
      }
    }

    return normalizeZigbeePercent(readZigbeeEndpointAttribute(
      endpoint,
      ['genLevelCtrl', 'genlevelctrl', 8],
      ['currentLevel', 'current_level']
    ), 'level');
  },

async readZigbeeColorTemperatureState(endpoint, device) {
    if (!endpoint) {
      return undefined;
    }

    if (typeof endpoint.read === 'function') {
      try {
        const response = await withTimeout(
          endpoint.read('lightingColorCtrl', ['colorTemperature']),
          5_000,
          'Zigbee color temperature readback timed out'
        );
        const colorTemperature = extractZigbeeColorTemperatureReadResponse(response);
        if (colorTemperature !== undefined) {
          return colorTemperature;
        }
      } catch (error) {
        this.log('warn', 'zigbee', 'Zigbee color temperature readback failed after command', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          error: error.message
        });
      }
    }

    return normalizeZigbeeColorTemperatureKelvin(readZigbeeEndpointAttribute(
      endpoint,
      ['lightingColorCtrl', 'lightingcolorctrl', 768],
      ['colorTemperature', 'colorTemperatureMireds', 'colorTemp', 'colortemp', 'color_temp']
    ));
  },

async controlZigbeeDevice(device, normalizedAction, commandValue, updateData = {}) {
    const zigbeeDevice = this.getDirectNodeForDevice(device);
    const endpoint = readZigbeeEndpoint(zigbeeDevice, normalizedAction);
    if (!endpoint || typeof endpoint.command !== 'function') {
      throw new Error('Zigbee device endpoint is not ready');
    }

    this.log('info', 'zigbee', 'Sending Zigbee device command', {
      deviceId: device?._id?.toString?.() || null,
      name: device?.name || null,
      action: normalizedAction,
      value: commandValue ?? null
    });

    switch (normalizedAction) {
      case 'toggle':
      case 'turnon':
      case 'turnoff': {
        const command = commandValue === true || normalizedAction === 'turnon'
          ? 'on'
          : normalizedAction === 'toggle'
            ? 'toggle'
            : 'off';
        await withTimeout(
          endpoint.command('genOnOff', command, {}),
          10_000,
          'Zigbee on/off command timed out before the device acknowledged it'
        );
        const observedStatus = await this.readZigbeeOnOffState(endpoint, device);
        if (observedStatus !== undefined) {
          updateData.status = observedStatus;
        }
        this.log('info', 'zigbee', 'Zigbee on/off command readback completed', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          action: normalizedAction,
          expectedStatus: command === 'toggle' ? null : command === 'on',
          observedStatus: observedStatus ?? null
        });
        break;
      }
      case 'setbrightness': {
        const level = Math.round((Math.max(0, Math.min(100, Number(commandValue))) / 100) * 254);
        await withTimeout(
          endpoint.command('genLevelCtrl', 'moveToLevelWithOnOff', { level, transtime: 0 }),
          10_000,
          'Zigbee brightness command timed out before the device acknowledged it'
        );
        const observedBrightness = await this.readZigbeeBrightnessState(endpoint, device);
        if (observedBrightness !== undefined) {
          updateData.brightness = observedBrightness;
          updateData.status = observedBrightness > 0;
        }
        this.log('info', 'zigbee', 'Zigbee brightness command readback completed', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          expectedBrightness: Math.max(0, Math.min(100, Number(commandValue))),
          observedBrightness: observedBrightness ?? null
        });
        break;
      }
      case 'setcolor': {
        const rgb = hexToRgbPercent(commandValue);
        if (!rgb) throw new Error('Color value must be a valid hex color string');
        await withTimeout(
          endpoint.command('lightingColorCtrl', 'moveToColor', {
            colorx: Math.round((rgb.red / 255) * 65279),
            colory: Math.round((rgb.green / 255) * 65279),
            transtime: 0
          }),
          10_000,
          'Zigbee color command timed out before the device acknowledged it'
        );
        break;
      }
      case 'setcolortemperature': {
        const colortemp = kelvinToMired(commandValue);
        if (!colortemp) throw new Error('Color temperature must be a valid kelvin value');
        await withTimeout(
          endpoint.command('lightingColorCtrl', 'moveToColorTemp', { colortemp, transtime: 0 }),
          10_000,
          'Zigbee color temperature command timed out before the device acknowledged it'
        );
        const observedColorTemperature = await this.readZigbeeColorTemperatureState(endpoint, device);
        updateData.colorTemperature = observedColorTemperature ?? Math.round(Number(commandValue));
        updateData.status = true;
        this.log('info', 'zigbee', 'Zigbee color temperature command readback completed', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          expectedColorTemperature: Math.round(Number(commandValue)),
          observedColorTemperature: observedColorTemperature ?? null
        });
        break;
      }
      case 'lock':
        await withTimeout(
          endpoint.command('closuresDoorLock', 'lockDoor', {}),
          10_000,
          'Zigbee lock command timed out before the device acknowledged it'
        );
        break;
      case 'unlock':
        await withTimeout(
          endpoint.command('closuresDoorLock', 'unlockDoor', {}),
          10_000,
          'Zigbee unlock command timed out before the device acknowledged it'
        );
        break;
      case 'alarmoff':
      case 'turnoffalarm':
      case 'silencealarm': {
        await withTimeout(
          endpoint.command('genOnOff', 'off', {}),
          10_000,
          'Zigbee alarm off command timed out before the device acknowledged it'
        );
        const observedStatus = await this.readZigbeeOnOffState(endpoint, device);
        updateData.status = observedStatus ?? false;
        break;
      }
      default:
        throw new Error('This Zigbee device does not support the requested action yet');
    }

    updateData.isOnline = true;
    updateData.lastSeen = new Date();
    this.log('info', 'zigbee', 'Zigbee device command accepted', {
      deviceId: device?._id?.toString?.() || null,
      name: device?.name || null,
      action: normalizedAction
    });
  }
};

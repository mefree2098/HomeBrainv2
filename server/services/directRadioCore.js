'use strict';

// DirectRadioService Core methods (mixed onto the prototype). Extracted from
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
  applyContactOpenDebounce,
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
  resolveDirectProtocol,
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
  getZigbeeInterviewState,
  isZigbeeInterviewSuccessful,
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
publishLog(input = {}) {
    return directRadioEngineLogService.publish(input);
  },

log(level, protocol, message, details = {}) {
    return this.publishLog({
      level,
      protocol,
      message,
      details
    });
  },

async start(options = {}) {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this._start(options)
      .finally(() => {
        this.startPromise = null;
      });

    return this.startPromise;
  },

async _start(options = {}) {
    if (this.started && !options.force) {
      return this.getStatus();
    }

    this.started = true;
    this.log('info', 'system', 'Starting direct radio runtime', {
      force: options.force === true
    });
    ensureDirSync(DATA_DIR);
    ensureDirSync(ZIGBEE_DIR);
    ensureDirSync(ZWAVE_DIR);
    await this.ensureControllerConfig();
    await this.repairMigratedSmartThingsIdentities();

    if (!parseEnabledFlag(process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED, true)) {
      this.log('warn', 'system', 'Direct radio runtime is disabled by configuration');
      return this.getStatus();
    }

    await this.detectSerialPorts();

    const shouldStartZigbee = parseEnabledFlag(process.env.HOMEBRAIN_ZIGBEE_ENABLED, true);
    const shouldStartZWave = parseEnabledFlag(process.env.HOMEBRAIN_ZWAVE_ENABLED, true);

    if (shouldStartZigbee && this.detected.zigbee?.path && !this.zigbee.started) {
      await this.startZigbee(this.detected.zigbee.path);
    }
    if (shouldStartZWave && this.detected.zwave?.path && !this.zwave.started) {
      await this.startZWave(this.detected.zwave.path);
    }

    const status = await this.getStatus();
    this.ensureHardwareMonitor();
    const zwaveNodeHealth = status.controllers?.zwave?.nodeHealth || {};
    this.log(zwaveNodeHealth.degraded ? 'warn' : 'info', 'system', 'Direct radio startup check complete', {
      zigbeeStarted: status.controllers?.zigbee?.started === true,
      zwaveStarted: status.controllers?.zwave?.started === true,
      zigbeePort: status.controllers?.zigbee?.detectedPort || null,
      zwavePort: status.controllers?.zwave?.detectedPort || null,
      zwaveNodeHealth
    });
    return status;
  },

ensureHardwareMonitor() {
    if (this.hardwareMonitorTimer || !parseEnabledFlag(process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED, true)) {
      return;
    }

    const intervalMs = boundedIntervalMs(process.env.HOMEBRAIN_DIRECT_RADIO_SCAN_INTERVAL_MS);
    this.hardwareMonitorTimer = setInterval(() => {
      if (this.zigbee.started && this.zwave.started) {
        return;
      }

      void this.refreshHardwareStatus({ log: false }).catch((error) => {
        this.log('warn', 'system', 'Direct radio hardware monitor refresh failed', {
          error: error.message
        });
      });
    }, intervalMs);

    if (typeof this.hardwareMonitorTimer.unref === 'function') {
      this.hardwareMonitorTimer.unref();
    }
  },

parseHexBytes(hex, length) {
    if (typeof hex !== 'string') {
      return null;
    }
    const clean = hex.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]+$/.test(clean) || clean.length !== length * 2) {
      return null;
    }
    const bytes = [];
    for (let i = 0; i < clean.length; i += 2) {
      bytes.push(parseInt(clean.slice(i, i + 2), 16));
    }
    return bytes;
  },

async ensureControllerConfig() {
    const existing = await readJsonFile(CONFIG_PATH, {});

    // --- Zigbee network credentials (safety-critical) ---
    // Losing these and regenerating random ones makes zigbee-herdsman form a
    // brand-new network on next start, which unpairs EVERY paired Zigbee device.
    // So when the saved config is incomplete we recover the real credentials
    // from the coordinator backup before ever generating new random ones, and we
    // refuse to mint a fresh key when a prior network exists but is unrecoverable.
    this.zigbee.networkResetRisk = false;
    this.zigbee.networkRecovered = false;

    let zigbeeNetwork = {
      panID: Number(existing?.zigbee?.panID) || null,
      extendedPanID: Array.isArray(existing?.zigbee?.extendedPanID) && existing.zigbee.extendedPanID.length === 8
        ? existing.zigbee.extendedPanID
        : null,
      networkKey: Array.isArray(existing?.zigbee?.networkKey) && existing.zigbee.networkKey.length === 16
        ? existing.zigbee.networkKey
        : null,
      channelList: Array.isArray(existing?.zigbee?.channelList) && existing.zigbee.channelList.length > 0
        ? existing.zigbee.channelList
        : null
    };

    if (!this.isCompleteZigbeeNetwork(zigbeeNetwork)) {
      const recovered = await this.recoverZigbeeNetworkFromBackup();
      if (recovered) {
        zigbeeNetwork = recovered;
        this.zigbee.networkRecovered = true;
        this.log('warn', 'zigbee', 'Recovered Zigbee network credentials from coordinator-backup.json because controller-config.json was missing or incomplete. This prevents a network reset that would unpair every Zigbee device.', {
          configPath: CONFIG_PATH
        });
      } else if (this.detectExistingZigbeeNetwork()) {
        // Prior network exists but credentials are unrecoverable: refuse to mint
        // new keys (which would silently wipe all devices). startZigbee checks
        // this flag and aborts instead of forming a new network.
        this.zigbee.networkResetRisk = true;
        this.log('error', 'zigbee', 'CRITICAL: Zigbee controller-config.json is missing/incomplete and a previously paired network exists (database/backup present), but the network credentials could not be recovered. Refusing to auto-generate a new network key because that would unpair every Zigbee device. Restore controller-config.json / coordinator-backup.json from backup before starting Zigbee.', {
          configPath: CONFIG_PATH
        });
      } else {
        // Genuine first-time setup: no prior network, safe to generate fresh.
        zigbeeNetwork = {
          panID: 0x1a00 + crypto.randomInt(0, 0x3ff),
          extendedPanID: randomByteArray(8),
          networkKey: randomByteArray(16),
          channelList: [15]
        };
        this.log('info', 'zigbee', 'No existing Zigbee network detected; generating fresh network credentials (first-time setup).');
      }
    }

    const next = {
      zigbee: zigbeeNetwork,
      zwave: {
        securityKeys: {
          S2_AccessControl: trimString(existing?.zwave?.securityKeys?.S2_AccessControl) || randomHex(16),
          S2_Authenticated: trimString(existing?.zwave?.securityKeys?.S2_Authenticated) || randomHex(16),
          S2_Unauthenticated: trimString(existing?.zwave?.securityKeys?.S2_Unauthenticated) || randomHex(16),
          S0_Legacy: trimString(existing?.zwave?.securityKeys?.S0_Legacy) || randomHex(16)
        },
        securityKeysLongRange: {
          S2_AccessControl: trimString(existing?.zwave?.securityKeysLongRange?.S2_AccessControl) || randomHex(16),
          S2_Authenticated: trimString(existing?.zwave?.securityKeysLongRange?.S2_Authenticated) || randomHex(16)
        }
      }
    };

    // Never persist incomplete/placeholder Zigbee creds — that would lock in bad
    // state that looks "complete" on the next start. Only write the zigbee
    // section when it is complete; otherwise preserve any previously-saved
    // complete creds, or omit the section so a later restore can heal it.
    if (!this.isCompleteZigbeeNetwork(next.zigbee)) {
      if (this.isCompleteZigbeeNetwork(existing?.zigbee)) {
        next.zigbee = existing.zigbee;
      } else {
        delete next.zigbee;
      }
    }

    await writeJsonFile(CONFIG_PATH, next);
    return next;
  },

async detectSerialPorts(options = {}) {
    const logScan = options.log !== false;
    if (logScan) {
      this.log('info', 'system', 'Scanning serial ports for Zigbee and Z-Wave adapters');
    }
    let SerialPortModule;
    try {
      SerialPortModule = require('serialport');
    } catch (error) {
      this.serialPorts = [];
      this.detected.zigbee = null;
      this.detected.zwave = null;
      this.zigbee.error = `serialport unavailable: ${error.message}`;
      this.zwave.error = `serialport unavailable: ${error.message}`;
      if (logScan) {
        this.log('error', 'system', 'Serial port module unavailable for direct radio scan', {
          error: error.message
        });
      }
      return this.serialPorts;
    }

    let rawPorts = [];
    try {
      // serialport v8 exports the class directly (with a static .list); v9+
      // exports { SerialPort } with the static .list on the class. Support both.
      const listSerialPorts = typeof SerialPortModule.list === 'function'
        ? SerialPortModule.list.bind(SerialPortModule)
        : (typeof SerialPortModule.SerialPort?.list === 'function'
          ? SerialPortModule.SerialPort.list.bind(SerialPortModule.SerialPort)
          : null);
      if (!listSerialPorts) {
        throw new Error('serialport.list is not available');
      }
      rawPorts = await listSerialPorts();
    } catch (error) {
      this.serialPorts = [];
      this.zigbee.error = `Failed to list serial ports: ${error.message}`;
      this.zwave.error = `Failed to list serial ports: ${error.message}`;
      if (logScan) {
        this.log('error', 'system', 'Failed to list serial ports for direct radio scan', {
          error: error.message
        });
      }
      return this.serialPorts;
    }

    const stableLinks = resolveLocalSerialById();
    const rawCandidates = addFallbackSerialPortCandidates(rawPorts, stableLinks);
    this.serialPorts = rawCandidates
      .map((port) => normalizeSerialPort(port, stableLinks))
      .filter((port) => Boolean(port.path))
      .map(enrichSerialPortForDirectRadios);

    const used = new Set();
    const configuredZigbee = trimString(process.env.HOMEBRAIN_ZIGBEE_PORT);
    const configuredZWave = trimString(process.env.HOMEBRAIN_ZWAVE_PORT);

    this.detected.zigbee = configuredZigbee
      ? { path: configuredZigbee, configured: true, score: 100 }
      : choosePortForProtocol(this.serialPorts, 'zigbee', used);
    if (this.detected.zigbee?.path) {
      used.add(this.detected.zigbee.path);
    }

    this.detected.zwave = configuredZWave
      ? { path: configuredZWave, configured: true, score: 100 }
      : choosePortForProtocol(this.serialPorts, 'zwave', used);
    if (this.detected.zwave?.path) {
      used.add(this.detected.zwave.path);
    }

    const scanSummary = JSON.stringify({
      ports: this.serialPorts.map((port) => ({
        path: port.path,
        stablePath: port.stablePath,
        preferredProtocol: port.preferredProtocol,
        scores: port.scores
      })),
      zigbeePort: this.detected.zigbee?.path || null,
      zwavePort: this.detected.zwave?.path || null
    });
    const scanChanged = this.lastSerialScanSummary !== scanSummary;
    this.lastSerialScanSummary = scanSummary;

    if (logScan || scanChanged) {
      this.log('info', 'system', 'Serial port scan complete', {
        serialPortCount: this.serialPorts.length,
        zigbeePort: this.detected.zigbee?.path || null,
        zigbeeScore: this.detected.zigbee?.scores?.zigbee ?? this.detected.zigbee?.score ?? null,
        zwavePort: this.detected.zwave?.path || null,
        zwaveScore: this.detected.zwave?.scores?.zwave ?? this.detected.zwave?.score ?? null,
        likelyDirectRadioPorts: this.serialPorts
          .filter((port) => port.likelyZigbee || port.likelyZWave)
          .map((port) => ({
            path: port.path,
            stablePath: port.stablePath,
            preferredProtocol: port.preferredProtocol,
            scores: port.scores
          }))
      });
    }

    return this.serialPorts;
  },

async refreshHardwareStatus(options = {}) {
    await this.start();

    if (!parseEnabledFlag(process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED, true)) {
      return this.getStatus();
    }

    await this.detectSerialPorts({ log: options.log !== false });

    const shouldStartZigbee = parseEnabledFlag(process.env.HOMEBRAIN_ZIGBEE_ENABLED, true);
    const shouldStartZWave = parseEnabledFlag(process.env.HOMEBRAIN_ZWAVE_ENABLED, true);

    if (shouldStartZigbee && this.detected.zigbee?.path && !this.zigbee.started) {
      this.log('info', 'zigbee', 'Detected Zigbee adapter during refresh; attempting coordinator start', {
        serialPath: this.detected.zigbee.path
      });
      await this.startZigbee(this.detected.zigbee.path);
    }

    if (shouldStartZWave && this.detected.zwave?.path && !this.zwave.started) {
      this.log('info', 'zwave', 'Detected Z-Wave adapter during refresh; attempting controller start', {
        serialPath: this.detected.zwave.path
      });
      await this.startZWave(this.detected.zwave.path);
    }

    return this.getStatus();
  },

  getZWaveControllerNodes(options = {}) {
    const controller = this.getZWaveController();
    if (!controller) {
      return null;
    }

    try {
      const nodes = controller.nodes;
      if (!nodes || (typeof nodes.values !== 'function' && typeof nodes.get !== 'function')) {
        return null;
      }
      this.zwave.nodeCacheError = null;
      return nodes;
    } catch (error) {
      const message = error?.message || String(error);
      this.zwave.nodeCacheError = message;
      if (options.log !== false) {
        this.log('warn', 'zwave', 'Z-Wave controller nodes are not available yet', {
          context: options.context || null,
          error: message
        });
      }
      return null;
    }
  },

  summarizeZWaveNodeHealth(nodes = null) {
    const summaries = Array.isArray(nodes) ? nodes : this.getZWaveNodeSummaries();
    const deviceNodes = summaries.filter((node) => node && node.isControllerNode !== true);
    const incompleteNodes = deviceNodes.filter((node) => node.incomplete === true);
    const offlineNodes = deviceNodes.filter((node) => node.isOnline === false);
    const readyNodes = deviceNodes.filter((node) => node.ready === true);
    const onlineNodes = deviceNodes.filter((node) => node.isOnline !== false);
    const degradedNodeIds = Array.from(new Set([
      ...incompleteNodes.map((node) => node.id),
      ...offlineNodes.map((node) => node.id)
    ]))
      .filter((nodeId) => nodeId !== null && nodeId !== undefined)
      .sort((left, right) => Number(left) - Number(right));

    return {
      nodeCount: deviceNodes.length,
      readyNodeCount: readyNodes.length,
      onlineNodeCount: onlineNodes.length,
      incompleteNodeCount: incompleteNodes.length,
      offlineNodeCount: offlineNodes.length,
      degraded: degradedNodeIds.length > 0,
      degradedNodeIds
    };
  },

  buildZWaveNodeHealthDiagnostics(nodeHealth = {}) {
    if (!nodeHealth.degraded) {
      return [];
    }

    const parts = [];
    if (nodeHealth.incompleteNodeCount > 0) {
      parts.push(`${nodeHealth.incompleteNodeCount} incomplete`);
    }
    if (nodeHealth.offlineNodeCount > 0) {
      parts.push(`${nodeHealth.offlineNodeCount} offline`);
    }
    const nodeList = Array.isArray(nodeHealth.degradedNodeIds) && nodeHealth.degradedNodeIds.length > 0
      ? `: nodes ${nodeHealth.degradedNodeIds.join(', ')}`
      : '';

    return [`Z-Wave controller is running but node health is degraded (${parts.join(', ')})${nodeList}.`];
  },

dispatchHandler(label, protocol, fn, context = {}) {
    const onError = (error) => {
      this.log('error', protocol, `Unhandled error in ${label} handler`, {
        ...context,
        error: error && error.message ? error.message : String(error),
        stack: error && error.stack ? String(error.stack).split('\n').slice(0, 5).join(' | ') : null
      });
    };
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        result.then(undefined, onError);
      }
      return result;
    } catch (error) {
      onError(error);
      return undefined;
    }
  },

inferDeviceTypeFromFeatures(features = [], context = {}) {
    return inferDirectDeviceType(features.map(normalizeFeature), context);
  },

getDirectUpdateReason(update = {}) {
    return trimString(update?.properties?.homebrainDirect?.lastReason);
  },

getDirectUpdateProtocol(identity, update = {}) {
    return trimString(
      identity?.protocol
      || update?.properties?.homebrainDirect?.protocol
      || update?.properties?.source
    ).toLowerCase();
  },

hasLiveZigbeeSecuritySensorEvidence(update = {}) {
    const direct = update?.properties?.homebrainDirect && typeof update.properties.homebrainDirect === 'object'
      ? update.properties.homebrainDirect
      : {};
    const reason = this.getDirectUpdateReason(update).toLowerCase();
    const messageCluster = trimString(direct.lastMessageCluster).toLowerCase();
    const hasLiveZoneStatus = direct.lastLiveZoneStatus !== undefined && direct.lastLiveZoneStatus !== null;

    // A live zone status (from an IAS report or a successful live endpoint
    // read) is direct radio evidence regardless of why the update happened —
    // including refresh, deviceInterview, and reinterview paths.
    if (hasLiveZoneStatus) {
      return true;
    }

    if (reason === 'message') {
      // Older normalized updates did not stamp the message cluster. Treat them
      // as live so existing event paths keep working, while newer metadata lets
      // us reject cached state attached to unrelated Zigbee messages.
      return !messageCluster || messageCluster === 'ssiaszone';
    }

    return false;
  },

shouldEvaluateSecurityAlarmForDirectDeviceUpdate(identity, update = {}) {
    const protocol = this.getDirectUpdateProtocol(identity, update);
    const reason = this.getDirectUpdateReason(update).toLowerCase();

    if (protocol === 'zigbee') {
      return this.hasLiveZigbeeSecuritySensorEvidence(update);
    }

    if (protocol === 'zwave') {
      return reason === 'node value updated';
    }

    return false;
  },

getPairingBaselineIdentities(protocol) {
    const normalizedProtocol = trimString(protocol, '').toLowerCase();
    const session = this.activePairings?.get?.(normalizedProtocol);
    return new Set((Array.isArray(session?.baselineIdentities) ? session.baselineIdentities : [])
      .map((identity) => trimString(identity))
      .map((identity) => identity?.toLowerCase?.())
      .filter(Boolean));
  },

isUsableZigbeeMigrationUpdate(update) {
    const properties = update?.properties && typeof update.properties === 'object'
      ? update.properties
      : {};
    const direct = properties.homebrainDirect && typeof properties.homebrainDirect === 'object'
      ? properties.homebrainDirect
      : {};
    const directState = properties.directRadioState && typeof properties.directRadioState === 'object'
      ? properties.directRadioState
      : {};
    const features = new Set((Array.isArray(properties.directRadioFeatures) ? properties.directRadioFeatures : [])
      .map(normalizeFeature)
      .filter(Boolean));
    const hasIdentity = Boolean(
      trimString(direct.modelID)
        || trimString(direct.manufacturerName)
        || trimString(direct.catalog?.model)
        || trimString(update?.model)
        || trimString(update?.brand)
    );
    const hasRuntimeState = Object.keys(directState).length > 0;
    const hasContactState = (
      Object.prototype.hasOwnProperty.call(directState, 'contactOpen')
        && typeof directState.contactOpen === 'boolean'
    ) || ['open', 'closed'].includes(trimString(directState.contact).toLowerCase());
    const routeOnlyRepeater = features.has('repeater')
      && hasIdentity
      && normalizeSourceText(direct.deviceType) === 'router'
      && !features.has('switch')
      && !features.has('power')
      && !features.has('energy');
    const incompleteShell = direct.incomplete === true || (!hasIdentity && features.size === 0 && !hasRuntimeState);

    if (incompleteShell || !hasIdentity || features.size === 0 || (!hasRuntimeState && !routeOnlyRepeater)) {
      return false;
    }

    return !features.has('contact') || hasContactState;
  },

shouldCompleteActiveMigration(identity, update, migration) {
    if (!migration?.sourceDeviceId) {
      return false;
    }

    const protocol = trimString(identity?.protocol, '').toLowerCase();
    if (protocol !== 'zigbee') {
      return true;
    }

    const identityId = trimString(identity?.id)?.toLowerCase?.();
    if (!identityId) {
      return false;
    }

    if (this.getPairingBaselineIdentities(protocol).has(identityId)) {
      return false;
    }

    const reason = this.getDirectUpdateReason(update);
    return reason === 'deviceInterview' || this.isUsableZigbeeMigrationUpdate(update);
  },

async upsertDirectDevice(identity, update, options = {}) {
    const activeMigration = options.skipActiveMigration ? null : this.findActiveMigration(identity.protocol);
    if (activeMigration?.sourceDeviceId) {
      if (this.shouldCompleteActiveMigration(identity, update, activeMigration)) {
        return this.completeMigration(activeMigration.id, identity, update);
      }

      const identityId = trimString(identity?.id);
      const reason = this.getDirectUpdateReason(update);
      const baselineIdentity = this.getPairingBaselineIdentities(identity.protocol).has(identityId?.toLowerCase?.());
      this.log('info', identity.protocol, baselineIdentity
        ? 'Ignored existing direct radio device update during SmartThings migration pairing'
        : 'Waiting for Zigbee interview before completing SmartThings migration', {
        migrationId: activeMigration.id,
        sourceDeviceId: activeMigration.sourceDeviceId || null,
        identity: identityId || null,
        reason: reason || null
      });

      if (!baselineIdentity) {
        this.markPairingDetected(identity.protocol, identity, null, reason || 'direct device update');
        return null;
      }

      return this.withDirectDeviceUpsertLock(identity, () => this.upsertDirectDeviceRecord(identity, update, {
        ...options,
        skipActiveMigration: true,
        suppressPairingCompletion: true
      }));
    }

    return this.withDirectDeviceUpsertLock(identity, () => this.upsertDirectDeviceRecord(identity, update, options));
  },

async upsertDirectDeviceRecord(identity, update, options = {}) {
    const query = buildDirectDeviceQuery(identity);
    const existingRecords = await Device.find(query);
    const existing = selectPrimaryDirectDeviceRecord(existingRecords);
    if (!existing && options.allowCreate === false) {
      return null;
    }
    const previousDevice = existing?.toObject ? existing.toObject() : existing;
    const directUpdate = applyContactOpenDebounce(existing, update);
    const payload = mergeDirectDeviceUpdateForExisting(existing, directUpdate);

    // Devices created during a pairing window inherit the window's optional
    // room assignment instead of landing in Unassigned.
    if (!existing) {
      const pairingSession = this.activePairings?.get?.(identity.protocol);
      const sessionRoom = trimString(pairingSession?.assignRoom);
      if (pairingSession && !isTerminalPairingStatus(pairingSession.status) && sessionRoom) {
        payload.room = sessionRoom;
      }
    }

    let device = existing
      ? await Device.findByIdAndUpdate(existing._id, payload, { returnDocument: 'after', runValidators: true })
      : await new Device(payload).save();

    device = await this.reclaimAwaitingSmartThingsMigrationSourceIfMatched(device, identity);
    device = await this.attachRecoveredSmartThingsMigrationIfMatched(device, identity);
    device = await this.repairRecoveredSmartThingsMigrationIfMismatched(device, identity);
    device = await this.finalizePendingSmartThingsMigrationIfReady(device, identity);
    await this.evaluateSecurityAlarmForDirectDeviceUpdate(device, previousDevice, identity, directUpdate);

    this.log('info', identity.protocol, existing ? 'Direct radio device updated' : 'Direct radio device created', {
      deviceId: device?._id?.toString?.() || null,
      name: device?.name || update?.name || null,
      identity: identity.id
    });

    const reclaimedDuplicateDeviceId = trimString(device?.__homebrainReclaimedDuplicateDeviceId);
    const duplicateRecords = (existingRecords || [])
      .filter((record) => getDeviceIdString(record) !== reclaimedDuplicateDeviceId)
      .filter((record) => isDuplicateDirectRadioRecord(record, device, identity));
    if (duplicateRecords.length > 0 && directFeatureCount(device) > 0) {
      const deviceService = require('./deviceService');
      const deletedDeviceIds = [];
      const deletionErrors = [];
      for (const duplicate of duplicateRecords) {
        try {
          const deletedDevice = await deviceService.deleteDevice(duplicate._id, {
            skipDirectRadioCleanup: true,
            skipDirectRadioCleanupReason: 'direct_radio_duplicate_record'
          });
          deletedDeviceIds.push(deletedDevice?._id?.toString?.() || String(duplicate._id));
        } catch (error) {
          const stillExists = duplicate?._id ? await Device.exists({ _id: duplicate._id }) : true;
          if (!stillExists) {
            deletedDeviceIds.push(String(duplicate._id));
            continue;
          }
          deletionErrors.push({
            deviceId: String(duplicate?._id || ''),
            message: error?.message || String(error || 'Unknown duplicate cleanup error')
          });
        }
      }
      this.log(deletionErrors.length > 0 ? 'warn' : 'info', identity.protocol, 'Removed duplicate direct radio device records', {
        deviceId: device?._id?.toString?.() || null,
        identity: identity.id,
        duplicateCount: deletedDeviceIds.length,
        deletedDeviceIds,
        deletionErrors
      });
    }
    this.emitDeviceUpdate(device);
    if (!options.suppressPairingCompletion) {
      this.completePairingSession(identity.protocol, identity, device, directUpdate?.properties?.homebrainDirect?.lastReason || 'direct device update');
    }
    return device;
  },

async evaluateSecurityAlarmForDirectDeviceUpdate(device, previousDevice, identity, update) {
    if (!this.shouldEvaluateSecurityAlarmForDirectDeviceUpdate(identity, update)) {
      return {
        triggered: false,
        reason: 'not_live_security_sensor_event',
        protocol: this.getDirectUpdateProtocol(identity, update) || null,
        updateReason: this.getDirectUpdateReason(update) || null
      };
    }

    try {
      const securityAlarmService = require('./securityAlarmService');
      const result = await securityAlarmService.evaluateNativeSecuritySensorUpdate(device, {
        previousDevice,
        source: 'direct_radio',
        protocol: identity?.protocol || update?.properties?.homebrainDirect?.protocol || null,
        reason: this.getDirectUpdateReason(update)
      });

      if (result?.triggered) {
        this.log('warn', 'security', 'Triggered security alarm from direct radio sensor update', {
          deviceId: getDeviceIdString(device),
          protocol: identity?.protocol || update?.properties?.homebrainDirect?.protocol || null,
          zoneName: result.zoneName || null,
          sensorType: result.sensorType || null,
          alarmState: result.alarmState || null
        });
      }

      return result;
    } catch (error) {
      this.log('warn', 'security', 'Failed to evaluate security alarm for direct radio update', {
        deviceId: getDeviceIdString(device),
        protocol: identity?.protocol || update?.properties?.homebrainDirect?.protocol || null,
        error: error?.message || String(error || 'Unknown security alarm evaluation error')
      });
      return null;
    }
  },

async remapSecurityZonesForMigratedDevice(sourceDevice, directDevice) {
    try {
      const SecurityAlarm = require('../models/SecurityAlarm');
      if (SecurityAlarm.db?.readyState !== 1) {
        return null;
      }
      const securityAlarmService = require('./securityAlarmService');
      const result = await securityAlarmService.remapZonesForMigratedDevice(sourceDevice, directDevice);
      if (result?.remappedZoneCount > 0) {
        this.log('info', 'security', 'Remapped security alarm zones to native migrated device', {
          sourceDeviceId: getDeviceIdString(sourceDevice),
          directDeviceId: getDeviceIdString(directDevice),
          remappedZoneCount: result.remappedZoneCount,
          alarmIds: result.alarmIds || []
        });
      }
      return result;
    } catch (error) {
      this.log('warn', 'security', 'Failed to remap security alarm zones for native migration', {
        sourceDeviceId: getDeviceIdString(sourceDevice),
        directDeviceId: getDeviceIdString(directDevice),
        error: error?.message || String(error || 'Unknown security zone remap error')
      });
      return null;
    }
  },

emitDeviceUpdate(device) {
    if (!device) {
      return;
    }
    const payload = deviceUpdateEmitter.normalizeDevices([device]);
    if (payload.length > 0) {
      deviceUpdateEmitter.emit('devices:update', payload);
    }
  },

getDirectNodeForDevice(device) {
    const protocol = resolveDirectProtocol(device);
    if (!protocol) {
      return null;
    }

    if (protocol === 'zigbee') {
      const ieeeAddr = trimString(device?.properties?.homebrainDirect?.ieeeAddr);
      return ieeeAddr ? this.zigbee.controller?.getDeviceByIeeeAddr?.(ieeeAddr) || null : null;
    }

    if (protocol === 'zwave') {
      const nodeId = Number(device?.properties?.homebrainDirect?.nodeId);
      if (!Number.isFinite(nodeId)) {
        return null;
      }
      const nodes = this.getZWaveControllerNodes({ log: false, context: 'device lookup' });
      return nodes?.get?.(nodeId) || this.zwave.driver?.getNode?.(nodeId) || null;
    }

    return null;
  },

async controlDevice(device, normalizedAction, commandValue, updateData = {}) {
    await this.start();
    const protocol = resolveDirectProtocol(device);

    if (protocol === 'zigbee') {
      await this.controlZigbeeDevice(device, normalizedAction, commandValue, updateData);
      return;
    }

    if (protocol === 'zwave') {
      await this.controlZWaveDevice(device, normalizedAction, commandValue, updateData);
      return;
    }

    throw new Error('Direct radio protocol is not configured for this device');
  },

async refreshDirectDeviceState(device, options = {}) {
    const protocol = resolveDirectProtocol(device);
    if (!protocol) {
      return null;
    }

    const node = this.getDirectNodeForDevice(device);
    if (!node) {
      return null;
    }

    const normalized = protocol === 'zigbee'
      ? this.normalizeZigbeeDevice(node, 'refresh')
      : this.normalizeZWaveNode(node, 'refresh');
    if (!normalized?.update) {
      return null;
    }

    const directUpdate = applyContactOpenDebounce(device, normalized.update);
    const merged = mergeDirectDeviceUpdateForExisting(device, directUpdate);
    const commandState = options?.preserveCommandState && typeof options.preserveCommandState === 'object'
      ? options.preserveCommandState
      : null;
    if (commandState) {
      if (!Object.prototype.hasOwnProperty.call(directUpdate, 'status')
        && Object.prototype.hasOwnProperty.call(commandState, 'status')) {
        merged.status = commandState.status;
      }
      if (!Object.prototype.hasOwnProperty.call(directUpdate, 'brightness')
        && Object.prototype.hasOwnProperty.call(commandState, 'brightness')) {
        merged.brightness = commandState.brightness;
      }
      if (!Object.prototype.hasOwnProperty.call(directUpdate, 'color')
        && Object.prototype.hasOwnProperty.call(commandState, 'color')) {
        merged.color = commandState.color;
      }
      if (!Object.prototype.hasOwnProperty.call(directUpdate, 'colorTemperature')
        && Object.prototype.hasOwnProperty.call(commandState, 'colorTemperature')) {
        merged.colorTemperature = commandState.colorTemperature;
      }
      const commandProperties = commandState.properties && typeof commandState.properties === 'object'
        ? commandState.properties
        : null;
      if (commandProperties) {
        merged.properties = merged.properties && typeof merged.properties === 'object'
          ? merged.properties
          : {};
        const normalizedProperties = normalized.update.properties && typeof normalized.update.properties === 'object'
          ? normalized.update.properties
          : {};
        ['supportsSirenVolume', 'sirenVolume', 'sirenVolumeOptions', 'supportsSirenSound', 'sirenSound', 'sirenSoundOptions'].forEach((key) => {
          if (!Object.prototype.hasOwnProperty.call(normalizedProperties, key)
            && Object.prototype.hasOwnProperty.call(commandProperties, key)) {
            merged.properties[key] = commandProperties[key];
          }
        });
      }
    }

    return merged;
  },

getDetectedPortDetails(protocol) {
    const detectedPath = this.detected?.[protocol]?.path;
    if (!detectedPath) {
      return null;
    }

    const match = this.serialPorts.find((port) => (
      port.path === detectedPath
      || port.stablePath === detectedPath
      || port.rawPath === detectedPath
      || port.realPath === detectedPath
    ));

    return match || {
      path: detectedPath,
      configured: this.detected?.[protocol]?.configured === true,
      scores: {
        [protocol]: this.detected?.[protocol]?.score ?? null
      }
    };
  },

buildControllerDiagnostics(protocol, portDetails = null) {
    const controller = protocol === 'zigbee' ? this.zigbee : this.zwave;
    const detected = this.detected?.[protocol];
    const configuredPort = trimString(protocol === 'zigbee'
      ? process.env.HOMEBRAIN_ZIGBEE_PORT
      : process.env.HOMEBRAIN_ZWAVE_PORT);
    const protocolEnabled = parseEnabledFlag(protocol === 'zigbee'
      ? process.env.HOMEBRAIN_ZIGBEE_ENABLED
      : process.env.HOMEBRAIN_ZWAVE_ENABLED, true);
    const label = protocol === 'zigbee' ? 'Zigbee' : 'Z-Wave';
    const expected = protocol === 'zigbee'
      ? 'SONOFF ZBDongle-P / TI CC2652P coordinator'
      : 'Zooz ZST39 LR / 800-series Z-Wave stick';
    const likelyCount = this.serialPorts.filter((port) => (
      protocol === 'zigbee' ? port.likelyZigbee : port.likelyZWave
    )).length;
    const diagnostics = [];

    if (!parseEnabledFlag(process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED, true)) {
      diagnostics.push('Direct Zigbee/Z-Wave radios are disabled by HOMEBRAIN_DIRECT_RADIOS_ENABLED.');
      return diagnostics;
    }

    if (!protocolEnabled) {
      diagnostics.push(`${label} runtime is disabled by configuration.`);
      return diagnostics;
    }

    if (!detected?.path) {
      diagnostics.push(`No ${label} USB adapter detected. Expected ${expected}; HomeBrain currently sees ${describeSerialEndpoints(this.serialPorts)}.`);
      diagnostics.push('Check the Jetson USB connection, container/device passthrough if applicable, and read permissions for the HomeBrain service user. Stable USB adapters should appear under /dev/serial/by-id/.');
      return diagnostics;
    }

    if (!configuredPort && likelyCount === 0 && portDetails?.path) {
      diagnostics.push(`${label} is using ${portDetails.path}, but the serial descriptor did not strongly identify the expected adapter. If this is correct, set ${protocol === 'zigbee' ? 'HOMEBRAIN_ZIGBEE_PORT' : 'HOMEBRAIN_ZWAVE_PORT'} to the stable /dev/serial/by-id path.`);
    }

    if (!controller.started) {
      diagnostics.push(controller.error
        ? `${label} adapter was detected at ${detected.path}, but the controller did not start: ${controller.error}`
        : `${label} adapter was detected at ${detected.path}, but the controller is not started yet.`);
    }

    if (controller.error && controller.started) {
      diagnostics.push(`${label} controller last reported: ${controller.error}`);
    }

    return diagnostics;
  },

async getStatus() {
    await this.reconcileActiveZWavePairingFromController().catch((error) => {
      this.log('warn', 'zwave', 'Unable to reconcile active Z-Wave pairing from controller nodes', {
        error: error.message
      });
    });

    const zigbeeDevices = this.zigbee.controller?.getDevices?.() || [];
    let zigbeeNetwork = null;
    if (this.zigbee.started && typeof this.zigbee.controller?.getNetworkParameters === 'function') {
      try {
        const params = await withTimeout(
          this.zigbee.controller.getNetworkParameters(),
          5_000,
          'Timed out reading Zigbee network parameters'
        );
        zigbeeNetwork = {
          panID: params?.panID ?? null,
          extendedPanID: params?.extendedPanID ?? null,
          channel: params?.channel ?? null
        };
      } catch (error) {
        zigbeeNetwork = { error: error.message };
      }
    }
    const zwaveNodes = this.getZWaveControllerNodes({ log: false, context: 'status' });
    const activeMigrations = Array.from(this.activeMigrations.values())
      .filter((migration) => (
        ['awaiting_smartthings_exclusion', 'excluding', 'excluded', 'pairing', 'exclusion_failed', 'pairing_failed'].includes(migration.status)
        && (Number(migration.expiresAt || 0) > Date.now() || Number(migration.exclusionExpiresAt || 0) > Date.now() || migration.status === 'excluded')
      ));
    const zigbeePortDetails = this.getDetectedPortDetails('zigbee');
    const zwavePortDetails = this.getDetectedPortDetails('zwave');
    const zigbeeDiagnostics = this.buildControllerDiagnostics('zigbee', zigbeePortDetails);
    const zwaveDiagnostics = this.buildControllerDiagnostics('zwave', zwavePortDetails);
    const zwaveNodeCacheError = this.zwave.nodeCacheError || null;
    const zwaveNodeSummaries = this.getZWaveNodeSummaries();
    const zwaveNodeHealth = this.summarizeZWaveNodeHealth(zwaveNodeSummaries);
    const zwaveNodeHealthDiagnostics = this.buildZWaveNodeHealthDiagnostics(zwaveNodeHealth);
    const zwaveStatusDiagnostics = zwaveNodeCacheError && this.zwave.started
      ? [...zwaveDiagnostics, `Z-Wave controller node cache is still starting: ${zwaveNodeCacheError}`, ...zwaveNodeHealthDiagnostics]
      : [...zwaveDiagnostics, ...zwaveNodeHealthDiagnostics];

    const zigbeeDeviceSummaries = zigbeeDevices
      .filter((device) => device?.type !== 'Coordinator')
      .map((device) => {
        const lastSeenTime = Number(device?.lastSeen);
        const linkquality = Number(device?.linkquality);
        return {
          ieeeAddr: trimString(device?.ieeeAddr) || null,
          networkAddress: device?.networkAddress ?? null,
          type: device?.type || null,
          modelID: device?.modelID || null,
          manufacturerName: device?.manufacturerName || null,
          interviewCompleted: isZigbeeInterviewSuccessful(device),
          interviewState: getZigbeeInterviewState(device) || null,
          lastSeen: Number.isFinite(lastSeenTime) ? new Date(lastSeenTime).toISOString() : null,
          linkquality: Number.isFinite(linkquality) ? linkquality : null,
          endpoints: Array.isArray(device?.endpoints)
            ? device.endpoints.map((endpoint) => ({
              id: endpoint?.ID ?? endpoint?.id ?? null,
              profileID: endpoint?.profileID ?? null,
              deviceID: endpoint?.deviceID ?? null,
              inputClusters: Array.isArray(endpoint?.inputClusters) ? endpoint.inputClusters.slice(0, 24) : [],
              outputClusters: Array.isArray(endpoint?.outputClusters) ? endpoint.outputClusters.slice(0, 24) : []
            }))
            : []
        };
      });

    return {
      enabled: parseEnabledFlag(process.env.HOMEBRAIN_DIRECT_RADIOS_ENABLED, true),
      dataDir: DATA_DIR,
      serialPorts: this.serialPorts,
      diagnostics: [...zigbeeDiagnostics, ...zwaveStatusDiagnostics],
      controllers: {
        zigbee: {
          expectedHardware: 'SONOFF ZBDongle-P / TI CC2652P Z-Stack coordinator',
          source: DIRECT_RADIO_SOURCES.zigbee,
          detectedPort: this.detected.zigbee?.path || null,
          detectedPortDetails: zigbeePortDetails,
          configuredPort: trimString(process.env.HOMEBRAIN_ZIGBEE_PORT) || null,
          started: this.zigbee.started,
          error: this.zigbee.error,
          diagnostics: zigbeeDiagnostics,
          permitJoinUntil: this.zigbee.permitJoinUntil,
          lastStartResult: this.zigbee.lastStartResult,
          network: zigbeeNetwork,
          pairedDeviceCount: zigbeeDeviceSummaries.length,
          devices: zigbeeDeviceSummaries
        },
        zwave: {
          expectedHardware: 'Zooz ZST39 LR / 800-series Z-Wave SerialAPI USB stick',
          source: DIRECT_RADIO_SOURCES.zwave,
          detectedPort: this.detected.zwave?.path || null,
          detectedPortDetails: zwavePortDetails,
          configuredPort: trimString(process.env.HOMEBRAIN_ZWAVE_PORT) || null,
          started: this.zwave.started,
          // Surface stick firmware so known-bad 800-series SDK builds (e.g.
          // the 7.21.x/7.22.0 controller lockups fixed in Zooz fw 1.50) are
          // visible without opening the case.
          controllerFirmwareVersion: this.zwave.driver?.controller?.firmwareVersion ?? null,
          controllerSdkVersion: this.zwave.driver?.controller?.sdkVersion ?? null,
          error: this.zwave.error,
          diagnostics: zwaveStatusDiagnostics,
          nodeCacheError: zwaveNodeCacheError,
          inclusionUntil: this.zwave.inclusionUntil,
          exclusionUntil: this.zwave.exclusionUntil,
          inclusionState: this.getZWaveInclusionStateLabel(),
          pendingDsk: this.zwave.pendingDsk,
          pairedNodeCount: zwaveNodes && typeof zwaveNodes.size === 'number' ? zwaveNodes.size : 0,
          nonControllerNodeCount: zwaveNodeHealth.nodeCount,
          readyNodeCount: zwaveNodeHealth.readyNodeCount,
          onlineNodeCount: zwaveNodeHealth.onlineNodeCount,
          incompleteNodeCount: zwaveNodeHealth.incompleteNodeCount,
          offlineNodeCount: zwaveNodeHealth.offlineNodeCount,
          degraded: zwaveNodeHealth.degraded,
          degradedNodeIds: zwaveNodeHealth.degradedNodeIds,
          nodeHealth: zwaveNodeHealth,
          nodes: zwaveNodeSummaries
        }
      },
      pairings: {
        zigbee: this.serializePairingSession(this.activePairings.get('zigbee')),
        zwave: this.serializePairingSession(this.activePairings.get('zwave'))
      },
      migrations: activeMigrations
    };
  },

async restartRuntime(options = {}) {
    const reason = trimString(options.reason) || 'manual_restart';
    const hardResetZigbee = options.hardResetZigbee === true;
    this.log('warn', 'system', 'Restarting direct radio runtime on request', { reason, hardResetZigbee });

    if (hardResetZigbee && typeof this.zigbee.controller?.reset === 'function') {
      // A watchdog (hard) reset reboots the whole CC2652 including the RF
      // core, which a soft reset leaves untouched. Recovers coordinators whose
      // receiver wedged (e.g. after sustained near-field interference).
      try {
        await withTimeout(
          this.zigbee.controller.reset('hard'),
          15_000,
          'Zigbee coordinator hardware reset timed out'
        );
        this.log('warn', 'zigbee', 'Issued Zigbee coordinator hardware (watchdog) reset', { reason });
      } catch (error) {
        this.log('warn', 'zigbee', 'Zigbee coordinator hardware reset failed', {
          reason,
          error: error.message
        });
      }
    }

    await this.shutdown();
    this.started = false;
    let status = null;
    try {
      status = await this.start({ force: true });
    } catch (error) {
      // Z-Wave value queries can race driver readiness right after a restart;
      // the controllers themselves may still have started fine.
      this.log('warn', 'system', 'Direct radio restart status readback failed; retrying status', {
        reason,
        error: error.message
      });
    }
    if (!status) {
      await delay(3_000);
      status = await this.getStatus();
    }
    this.log('info', 'system', 'Direct radio runtime restart finished', {
      reason,
      hardResetZigbee,
      zigbeeStarted: status?.controllers?.zigbee?.started === true,
      zwaveStarted: status?.controllers?.zwave?.started === true
    });
    return status;
  },

async shutdown() {
    const startedAt = Date.now();
    const pairingTimeoutMs = Math.max(1000, Number(process.env.HOMEBRAIN_DIRECT_RADIO_PAIRING_SHUTDOWN_TIMEOUT_MS || 5000));
    const zwaveTimeoutMs = Math.max(5000, Number(process.env.HOMEBRAIN_ZWAVE_DESTROY_TIMEOUT_MS || 45000));
    const zigbeeTimeoutMs = Math.max(1000, Number(process.env.HOMEBRAIN_ZIGBEE_STOP_TIMEOUT_MS || 15000));
    console.log('DirectRadioService: Shutdown started');
    if (this.hardwareMonitorTimer) {
      clearInterval(this.hardwareMonitorTimer);
      this.hardwareMonitorTimer = null;
    }
    await withTimeout(
      this.stopPairing('all'),
      pairingTimeoutMs,
      `Direct radio pairing stop did not finish within ${pairingTimeoutMs}ms`
    ).catch((error) => {
      console.warn(`DirectRadioService: Failed to stop pairing sessions: ${error.message}`);
    });
    if (this.zwave.driver) {
      try {
        const zwaveStartedAt = Date.now();
        await withTimeout(
          this.zwave.driver.destroy(),
          zwaveTimeoutMs,
          `Z-Wave driver destroy did not finish within ${zwaveTimeoutMs}ms`
        );
        console.log(`DirectRadioService: Z-Wave driver destroyed in ${Date.now() - zwaveStartedAt}ms`);
      } catch (error) {
        console.warn(`DirectRadioService: Failed to destroy Z-Wave driver: ${error.message}`);
      }
      this.zwave.driver = null;
    }
    if (this.zigbee.controller) {
      try {
        const zigbeeStartedAt = Date.now();
        await withTimeout(
          this.zigbee.controller.stop(),
          zigbeeTimeoutMs,
          `Zigbee controller stop did not finish within ${zigbeeTimeoutMs}ms`
        );
        console.log(`DirectRadioService: Zigbee controller stopped in ${Date.now() - zigbeeStartedAt}ms`);
      } catch (error) {
        console.warn(`DirectRadioService: Failed to stop Zigbee controller: ${error.message}`);
      }
      this.zigbee.controller = null;
    }
    this.zigbee.started = false;
    this.zwave.started = false;
    console.log(`DirectRadioService: Shutdown finished in ${Date.now() - startedAt}ms`);
  }
};

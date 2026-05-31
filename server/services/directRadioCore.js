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
    this.log('info', 'system', 'Direct radio startup check complete', {
      zigbeeStarted: status.controllers?.zigbee?.started === true,
      zwaveStarted: status.controllers?.zwave?.started === true,
      zigbeePort: status.controllers?.zigbee?.detectedPort || null,
      zwavePort: status.controllers?.zwave?.detectedPort || null
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

getPairingBaselineIdentities(protocol) {
    const normalizedProtocol = trimString(protocol, '').toLowerCase();
    const session = this.activePairings?.get?.(normalizedProtocol);
    return new Set((Array.isArray(session?.baselineIdentities) ? session.baselineIdentities : [])
      .map((identity) => trimString(identity))
      .map((identity) => identity?.toLowerCase?.())
      .filter(Boolean));
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

    return this.getDirectUpdateReason(update) === 'deviceInterview';
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
    const payload = mergeDirectDeviceUpdateForExisting(existing, update);

    let device = existing
      ? await Device.findByIdAndUpdate(existing._id, payload, { returnDocument: 'after', runValidators: true })
      : await new Device(payload).save();

    device = await this.reclaimAwaitingSmartThingsMigrationSourceIfMatched(device, identity);
    device = await this.attachRecoveredSmartThingsMigrationIfMatched(device, identity);
    device = await this.repairRecoveredSmartThingsMigrationIfMismatched(device, identity);

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
          const deletedDevice = await deviceService.deleteDevice(duplicate._id);
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
      this.completePairingSession(identity.protocol, identity, device, update?.properties?.homebrainDirect?.lastReason || 'direct device update');
    }
    return device;
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
    if (!isDirectRadioDevice(device)) {
      return null;
    }
    const protocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol)
      || (normalizeSourceText(device?.properties?.source) === DIRECT_RADIO_SOURCES.zigbee ? 'zigbee' : 'zwave');

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
    const protocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol)
      || (normalizeSourceText(device?.properties?.source) === DIRECT_RADIO_SOURCES.zigbee ? 'zigbee' : 'zwave');

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
    if (!isDirectRadioDevice(device)) {
      return null;
    }

    const node = this.getDirectNodeForDevice(device);
    if (!node) {
      return null;
    }

    const protocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol);
    const normalized = protocol === 'zigbee'
      ? this.normalizeZigbeeDevice(node, 'refresh')
      : this.normalizeZWaveNode(node, 'refresh');
    if (!normalized?.update) {
      return null;
    }

    const merged = mergeDirectDeviceUpdateForExisting(device, normalized.update);
    const commandState = options?.preserveCommandState && typeof options.preserveCommandState === 'object'
      ? options.preserveCommandState
      : null;
    if (commandState) {
      if (!Object.prototype.hasOwnProperty.call(normalized.update, 'status')
        && Object.prototype.hasOwnProperty.call(commandState, 'status')) {
        merged.status = commandState.status;
      }
      if (!Object.prototype.hasOwnProperty.call(normalized.update, 'brightness')
        && Object.prototype.hasOwnProperty.call(commandState, 'brightness')) {
        merged.brightness = commandState.brightness;
      }
      if (!Object.prototype.hasOwnProperty.call(normalized.update, 'color')
        && Object.prototype.hasOwnProperty.call(commandState, 'color')) {
        merged.color = commandState.color;
      }
      if (!Object.prototype.hasOwnProperty.call(normalized.update, 'colorTemperature')
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
    const zwaveStatusDiagnostics = zwaveNodeCacheError && this.zwave.started
      ? [...zwaveDiagnostics, `Z-Wave controller node cache is still starting: ${zwaveNodeCacheError}`]
      : zwaveDiagnostics;

    const zigbeeDeviceSummaries = zigbeeDevices
      .filter((device) => device?.type !== 'Coordinator')
      .map((device) => ({
        ieeeAddr: trimString(device?.ieeeAddr) || null,
        networkAddress: device?.networkAddress ?? null,
        type: device?.type || null,
        modelID: device?.modelID || null,
        manufacturerName: device?.manufacturerName || null,
        interviewCompleted: device?.interviewCompleted === true,
        endpoints: Array.isArray(device?.endpoints)
          ? device.endpoints.map((endpoint) => ({
            id: endpoint?.ID ?? endpoint?.id ?? null,
            profileID: endpoint?.profileID ?? null,
            deviceID: endpoint?.deviceID ?? null,
            inputClusters: Array.isArray(endpoint?.inputClusters) ? endpoint.inputClusters.slice(0, 24) : [],
            outputClusters: Array.isArray(endpoint?.outputClusters) ? endpoint.outputClusters.slice(0, 24) : []
          }))
          : []
      }));

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
          error: this.zwave.error,
          diagnostics: zwaveStatusDiagnostics,
          nodeCacheError: zwaveNodeCacheError,
          inclusionUntil: this.zwave.inclusionUntil,
          exclusionUntil: this.zwave.exclusionUntil,
          inclusionState: this.getZWaveInclusionStateLabel(),
          pendingDsk: this.zwave.pendingDsk,
          pairedNodeCount: zwaveNodes && typeof zwaveNodes.size === 'number' ? zwaveNodes.size : 0,
          nodes: this.getZWaveNodeSummaries()
        }
      },
      pairings: {
        zigbee: this.serializePairingSession(this.activePairings.get('zigbee')),
        zwave: this.serializePairingSession(this.activePairings.get('zwave'))
      },
      migrations: activeMigrations
    };
  },

async shutdown() {
    if (this.hardwareMonitorTimer) {
      clearInterval(this.hardwareMonitorTimer);
      this.hardwareMonitorTimer = null;
    }
    await this.stopPairing('all').catch(() => {});
    if (this.zigbee.controller) {
      try {
        await this.zigbee.controller.stop();
      } catch (error) {
        console.warn(`DirectRadioService: Failed to stop Zigbee controller: ${error.message}`);
      }
    }
    if (this.zwave.driver) {
      try {
        await this.zwave.driver.destroy();
      } catch (error) {
        console.warn(`DirectRadioService: Failed to destroy Z-Wave driver: ${error.message}`);
      }
    }
    this.zigbee.started = false;
    this.zwave.started = false;
  }
};

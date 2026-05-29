'use strict';

// DirectRadioService Migration methods (mixed onto the prototype). Extracted from
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
attachZWaveMigrationRequestHandlers(driver, zwave) {
    if (!driver || driver.__homebrainMigrationRequestHandlersAttached || typeof driver.registerRequestHandler !== 'function') {
      return;
    }

    try {
      const serialApi = require('@zwave-js/serial/serialapi');
      this.zwave.removeNodeStatusEnum = serialApi.RemoveNodeStatus;
      this.zwave.addNodeStatusEnum = serialApi.AddNodeStatus;

      if (!driver.__homebrainMigrationWaitWrapped && typeof driver.waitForMessage === 'function') {
        const waitForMessage = driver.waitForMessage.bind(driver);
        driver.waitForMessage = async (...args) => {
          const message = await waitForMessage(...args);
          this.observeZWaveMigrationMessage(message);
          return message;
        };
        driver.__homebrainMigrationWaitWrapped = true;
      }

      driver.registerRequestHandler(zwave.FunctionType.RemoveNodeFromNetwork, (message) => {
        this.observeZWaveMigrationMessage(message);
        return false;
      });
      driver.registerRequestHandler(zwave.FunctionType.AddNodeToNetwork, (message) => {
        this.observeZWaveMigrationMessage(message);
        return false;
      });
      driver.__homebrainMigrationRequestHandlersAttached = true;
    } catch (error) {
      this.log('warn', 'zwave', 'Unable to attach Z-Wave migration status handlers', {
        error: error.message
      });
    }
  },

attachZWaveControllerMigrationListeners(controller) {
    if (!controller || controller.__homebrainMigrationListenersAttached || typeof controller.on !== 'function') {
      return;
    }

    controller.on('exclusion failed', () => {
      this.recordZWaveExclusionFailed('The Z-Wave controller reported that exclusion failed.');
    });
    controller.on('inclusion failed', () => {
      this.recordZWaveInclusionFailed('The Z-Wave controller reported that inclusion failed.');
    });
    controller.on('inclusion started', (strategy) => {
      this.log('info', 'zwave', 'Z-Wave controller inclusion started', {
        strategy: strategy === undefined ? null : String(strategy),
        state: this.getZWaveInclusionStateLabel()
      });
    });
    controller.on('exclusion started', () => {
      this.log('info', 'zwave', 'Z-Wave controller exclusion started', {
        state: this.getZWaveInclusionStateLabel()
      });
    });
    controller.on('inclusion stopped', () => {
      this.log('info', 'zwave', 'Z-Wave controller inclusion stopped', {
        state: this.getZWaveInclusionStateLabel()
      });
    });
    controller.on('exclusion stopped', () => {
      this.log('info', 'zwave', 'Z-Wave controller exclusion stopped', {
        state: this.getZWaveInclusionStateLabel()
      });
    });
    controller.on('inclusion state changed', (state) => {
      this.log('info', 'zwave', 'Z-Wave controller inclusion state changed', {
        state: enumMemberName(require('zwave-js').InclusionState, state)
      });
    });
    controller.__homebrainMigrationListenersAttached = true;
  },

observeZWaveMigrationMessage(message) {
    if (!message || message.status === undefined || message.status === null) {
      return;
    }

    const functionName = enumMemberName({ 74: 'AddNodeToNetwork', 75: 'RemoveNodeFromNetwork' }, message.functionType);
    const constructorName = message.constructor?.name || '';
    if (functionName === 'RemoveNodeFromNetwork' || constructorName === 'RemoveNodeFromNetworkRequestStatusReport') {
      this.recordZWaveExclusionStatus(message.status, message.statusContext || {});
    } else if (functionName === 'AddNodeToNetwork' || constructorName === 'AddNodeToNetworkRequestStatusReport') {
      this.recordZWaveInclusionStatus(message.status, message.statusContext || {});
    }
  },

appendMigrationEvent(migration, event) {
    if (!migration) {
      return;
    }
    const events = Array.isArray(migration.zwaveEvents) ? migration.zwaveEvents : [];
    migration.zwaveEvents = [...events.slice(-19), event];
    migration.updatedAt = event.timestamp || new Date().toISOString();
  },

findCurrentMigrationSession(protocol, statuses = []) {
    const statusSet = new Set(statuses.filter(Boolean));
    const now = Date.now();
    return Array.from(this.activeMigrations.values())
      .filter((migration) => migration?.protocol === protocol)
      .filter((migration) => statusSet.size === 0 || statusSet.has(migration.status))
      .filter((migration) => {
        if (migration.status === 'completed' || migration.status === 'excluded') {
          return true;
        }
        return Number(migration.expiresAt || 0) > now || Number(migration.exclusionExpiresAt || 0) > now;
      })
      .sort((left, right) => (
        new Date(right.updatedAt || right.startedAt || 0).getTime()
        - new Date(left.updatedAt || left.startedAt || 0).getTime()
      ))[0] || null;
  },

findMigrationSession({ migrationId, deviceId, protocol } = {}) {
    const safeMigrationId = trimString(migrationId);
    if (safeMigrationId && this.activeMigrations.has(safeMigrationId)) {
      return this.activeMigrations.get(safeMigrationId);
    }

    const safeDeviceId = trimString(deviceId);
    const candidates = Array.from(this.activeMigrations.values())
      .filter((migration) => !safeDeviceId || String(migration.sourceDeviceId) === safeDeviceId)
      .filter((migration) => !protocol || migration.protocol === protocol)
      .sort((left, right) => (
        new Date(right.updatedAt || right.startedAt || 0).getTime()
        - new Date(left.updatedAt || left.startedAt || 0).getTime()
      ));
    return candidates[0] || null;
  },

recordZWaveExclusionStatus(status, statusContext = {}) {
    const migration = this.findCurrentMigrationSession('zwave', ['excluding']);
    if (!migration || status === undefined || status === null) {
      return;
    }

    const timestamp = new Date().toISOString();
    const statusName = enumMemberName(this.zwave.removeNodeStatusEnum, status);
    const nodeId = getNumericNodeId(statusContext);
    this.appendMigrationEvent(migration, {
      kind: 'exclusion',
      status,
      statusName,
      nodeId,
      timestamp
    });

    if (statusName === 'NodeFound') {
      migration.exclusionNodeFoundAt = timestamp;
    }
    if (['RemovingSlave', 'RemovingController'].includes(statusName) && nodeId !== null) {
      migration.exclusionNodeId = nodeId;
    }
    if (statusName === 'Done') {
      migration.status = 'excluded';
      migration.exclusionStatus = 'verified';
      migration.exclusionVerifiedAt = timestamp;
      migration.exclusionNodeId = nodeId ?? migration.exclusionNodeId ?? null;
      migration.expiresAt = Math.max(Number(migration.expiresAt || 0), Date.now() + 15 * 60 * 1000);
      this.log('info', 'zwave', 'Z-Wave exclusion verified by controller status', {
        migrationId: migration.id,
        deviceId: migration.sourceDeviceId,
        nodeId: migration.exclusionNodeId
      });
    }
    if (statusName === 'Failed') {
      migration.status = 'exclusion_failed';
      migration.exclusionStatus = 'failed';
      migration.exclusionFailedAt = timestamp;
      this.log('warn', 'zwave', 'Z-Wave exclusion failed during migration', {
        migrationId: migration.id,
        deviceId: migration.sourceDeviceId
      });
    }
  },

recordZWaveExclusionFailed(message) {
    const migration = this.findCurrentMigrationSession('zwave', ['excluding']);
    if (!migration) {
      return;
    }

    const timestamp = new Date().toISOString();
    this.appendMigrationEvent(migration, {
      kind: 'exclusion_failed',
      statusName: 'Failed',
      message,
      timestamp
    });
    migration.status = 'exclusion_failed';
    migration.exclusionStatus = 'failed';
    migration.exclusionFailedAt = timestamp;
  },

findActiveMigration(protocol) {
    const now = Date.now();
    for (const migration of this.activeMigrations.values()) {
      if (migration.protocol === protocol && migration.expiresAt > now && migration.status === 'pairing') {
        return migration;
      }
    }
    return null;
  },

async findDetachedSmartThingsMigrationSource(directDevice, protocol) {
    const directDeviceId = getDeviceIdString(directDevice);
    if (!directDeviceId || !['zigbee', 'zwave'].includes(protocol)) {
      return null;
    }

    const networkTypes = protocol === 'zigbee'
      ? ['ZIGBEE', 'zigbee', 'Zigbee']
      : ['ZWAVE', 'zwave', 'ZWave', 'ZW', 'zw'];
    const candidates = await Device.find({
      _id: { $ne: directDeviceId },
      $and: [
        {
          $or: [
            { 'properties.source': 'smartthings' },
            { 'properties.smartThingsDeviceId': { $exists: true, $ne: null } }
          ]
        },
        {
          $or: [
            { 'properties.smartThingsMigration.retiredSource': { $exists: false } },
            { 'properties.smartThingsMigration.retiredSource': { $ne: true } }
          ]
        },
        { 'properties.smartThingsDeviceNetworkType': { $in: networkTypes } }
      ]
    });

    const scored = (Array.isArray(candidates) ? candidates : [])
      .map((candidate) => ({
        candidate,
        score: scoreDetachedSmartThingsMigrationSource(directDevice, candidate, protocol)
      }))
      .filter((entry) => entry.score >= 55)
      .sort((left, right) => right.score - left.score);

    return scored[0]?.candidate || null;
  },

buildRecoveredSmartThingsMigrationSnapshot(directDevice, sourceDevice, protocol, migrationId = null) {
    const baseSnapshot = toPlainDeviceSnapshot(directDevice);
    const features = uniqueStrings([
      ...(Array.isArray(getDeviceProperties(baseSnapshot).directRadioFeatures)
        ? getDeviceProperties(baseSnapshot).directRadioFeatures
        : []),
      ...inferFeaturesFromExistingDirectRecord(baseSnapshot),
      ...inferFeaturesFromSmartThings(sourceDevice)
    ].map(normalizeFeature)).sort();
    const directUpdate = mergeSmartThingsTelemetryFallback({
      ...baseSnapshot,
      properties: {
        ...getDeviceProperties(baseSnapshot),
        directRadioFeatures: features
      }
    }, sourceDevice);
    const validation = this.buildMigrationValidation(sourceDevice, directUpdate, features);
    return buildRecoveredSmartThingsMigrationSnapshot({
      directDevice: directUpdate,
      sourceDevice,
      protocol,
      migrationId,
      validation
    });
  },

async attachRecoveredSmartThingsMigrationIfMatched(device, identity, migrationId = null) {
    const protocol = identity?.protocol;
    if (!device || !['zigbee', 'zwave'].includes(protocol) || getSmartThingsMigration(device)) {
      return device;
    }

    const sourceDevice = await this.findDetachedSmartThingsMigrationSource(device, protocol);
    if (!sourceDevice) {
      return device;
    }

    const snapshot = this.buildRecoveredSmartThingsMigrationSnapshot(device, sourceDevice, protocol, migrationId);
    const updated = await Device.findByIdAndUpdate(device._id, {
      temperature: snapshot.temperature,
      properties: snapshot.properties,
      updatedAt: new Date()
    }, { returnDocument: 'after', runValidators: true });

    this.log('info', protocol, 'Recovered SmartThings migration context for detached native device', {
      deviceId: getDeviceIdString(updated || device),
      sourceDeviceId: getDeviceIdString(sourceDevice),
      migrationId: snapshot.properties.smartThingsMigration?.migrationId || null
    });

    return updated || device;
  },

async repairRecoveredSmartThingsMigrationIfMismatched(device, identity) {
    const protocol = identity?.protocol;
    const migration = getSmartThingsMigration(device);
    if (
      !device
      || !['zigbee', 'zwave'].includes(protocol)
      || !migration?.recoveredAt
      || migration?.finalizedAt
    ) {
      return device;
    }

    const currentSourceDeviceId = trimString(migration.sourceDeviceId);
    const currentSource = currentSourceDeviceId
      ? await Device.findById(currentSourceDeviceId).catch(() => null)
      : null;
    const currentScore = currentSource
      ? scoreDetachedSmartThingsMigrationSource(device, currentSource, protocol)
      : -Infinity;
    if (currentScore >= 55) {
      return device;
    }

    const replacementSource = await this.findDetachedSmartThingsMigrationSource(device, protocol);
    const replacementSourceDeviceId = getDeviceIdString(replacementSource);
    if (!replacementSource || replacementSourceDeviceId === currentSourceDeviceId) {
      return device;
    }

    const snapshot = this.buildRecoveredSmartThingsMigrationSnapshot(
      device,
      replacementSource,
      protocol,
      migration.migrationId
    );
    const updated = await Device.findByIdAndUpdate(device._id, {
      temperature: snapshot.temperature,
      properties: snapshot.properties,
      updatedAt: new Date()
    }, { returnDocument: 'after', runValidators: true });

    this.log('info', protocol, 'Repaired mismatched recovered SmartThings migration context', {
      deviceId: getDeviceIdString(updated || device),
      previousSourceDeviceId: currentSourceDeviceId || null,
      previousSourceName: currentSource?.name || migration.sourceDeviceName || null,
      replacementSourceDeviceId,
      replacementSourceName: replacementSource?.name || null,
      migrationId: snapshot.properties.smartThingsMigration?.migrationId || null
    });

    return updated || device;
  },

severMigratedSmartThingsIdentity(properties = {}) {
    const props = (properties && typeof properties === 'object' && !Array.isArray(properties))
      ? { ...properties }
      : {};
    const migration = (props.smartThingsMigration && typeof props.smartThingsMigration === 'object')
      ? { ...props.smartThingsMigration }
      : {};
    const smartThingsDeviceId = migration.smartThingsDeviceId || props.smartThingsDeviceId || null;
    const smartThingsId = migration.smartThingsId || props.smartThingsId || null;
    props.smartThingsMigration = {
      ...migration,
      ...(smartThingsDeviceId ? { smartThingsDeviceId } : {}),
      ...(smartThingsId ? { smartThingsId } : {}),
      retiredSource: true
    };
    delete props.smartThingsDeviceId;
    delete props.smartThingsId;
    return props;
  },

async repairMigratedSmartThingsIdentities() {
    let candidates;
    try {
      candidates = await Device.find({
        $and: [
          {
            $or: [
              { 'properties.smartThingsDeviceId': { $exists: true, $ne: null } },
              { 'properties.smartThingsId': { $exists: true, $ne: null } }
            ]
          },
          {
            $or: [
              { 'properties.source': /^homebrain-/i },
              { 'properties.homebrainDirect.protocol': { $exists: true } }
            ]
          }
        ]
      });
    } catch (error) {
      this.log('warn', 'system', 'Failed to query migrated SmartThings identities for repair', {
        error: error.message
      });
      return 0;
    }

    let repaired = 0;
    let failed = 0;
    // Per-device try/catch: one bad record (e.g. legacy doc failing schema
    // validation) must not abort the repair for every other migrated device.
    for (const device of candidates) {
      try {
        device.properties = this.severMigratedSmartThingsIdentity(getDeviceProperties(device));
        if (typeof device.markModified === 'function') {
          device.markModified('properties');
        }
        await device.save();
        repaired += 1;
      } catch (error) {
        failed += 1;
        this.log('warn', 'system', 'Failed to repair a migrated SmartThings identity; continuing with the rest', {
          deviceId: getDeviceIdString(device),
          error: error.message
        });
      }
    }
    if (repaired > 0 || failed > 0) {
      this.log(failed > 0 ? 'warn' : 'info', 'system', 'Repaired migrated devices that still carried a SmartThings identity (prevents source regression).', {
        repaired,
        failed
      });
    }
    return repaired;
  },

async completeMigration(migrationId, identity, update) {
    const migration = this.activeMigrations.get(migrationId);
    if (!migration?.sourceDeviceId) {
      return this.upsertDirectDevice(identity, update);
    }

    const existing = await Device.findById(migration.sourceDeviceId);
    if (!existing) {
      this.activeMigrations.delete(migrationId);
      return this.upsertDirectDevice(identity, update);
    }

    const previousProperties = existing.properties && typeof existing.properties === 'object'
      ? existing.properties
      : {};
    const source = protocolSource(identity.protocol);
    const features = uniqueStrings([
      ...(Array.isArray(update.properties?.directRadioFeatures) ? update.properties.directRadioFeatures : []),
      ...inferFeaturesFromSmartThings(existing)
    ]);
    const validation = this.buildMigrationValidation(existing, update, features);
    const migratedProperties = {
      ...previousProperties,
      ...(update.properties || {}),
      source,
      directRadioFeatures: features,
      directRadioCapabilities: buildNormalizedCapabilities(features, identity.protocol),
      ...buildDirectFeatureProperties(features),
      smartThingsMigration: {
        migratedAt: new Date().toISOString(),
        previousSource: previousProperties.source || 'smartthings',
        smartThingsDeviceId: previousProperties.smartThingsDeviceId || null,
        migrationId,
        validation
      }
    };

    const updated = await Device.findByIdAndUpdate(existing._id, {
      status: update.status,
      brightness: update.brightness,
      isOnline: update.isOnline !== false,
      lastSeen: new Date(),
      brand: existing.brand || update.brand,
      model: existing.model || update.model,
      properties: this.severMigratedSmartThingsIdentity(migratedProperties)
    }, { returnDocument: 'after', runValidators: true });

    migration.status = 'completed';
    migration.completedAt = new Date().toISOString();
    migration.inclusionStatus = 'verified';
    migration.inclusionVerifiedAt = migration.completedAt;
    migration.updatedAt = migration.completedAt;
    migration.directIdentity = identity;
    migration.directDeviceId = updated?._id?.toString?.() || existing._id?.toString?.() || null;
    migration.validation = validation;
    this.log('info', identity.protocol, 'SmartThings migration completed on direct radio', {
      migrationId,
      deviceId: updated?._id?.toString?.() || existing._id?.toString?.() || null,
      identity: identity.id,
      validation
    });
    this.emitDeviceUpdate(updated);
    return updated;
  },

buildMigrationValidation(existingDevice, directUpdate, features = []) {
    const previousProperties = existingDevice?.properties && typeof existingDevice.properties === 'object'
      ? existingDevice.properties
      : {};
    const directProperties = directUpdate?.properties && typeof directUpdate.properties === 'object'
      ? directUpdate.properties
      : {};
    const smartThingsBattery = clampPercent(
      previousProperties.smartThingsBatteryLevel
      ?? previousProperties.batteryLevel
      ?? previousProperties.battery
      ?? previousProperties.smartThingsAttributeValues?.battery?.battery
    );
    const directBattery = clampPercent(
      directProperties.homeBrainBatteryLevel
      ?? directProperties.directBatteryLevel
      ?? directProperties.batteryLevel
      ?? directProperties.battery
    );
    const featureSet = new Set(features.map(normalizeFeature));
    const checks = [
      {
        key: 'state',
        label: 'Primary state',
        previous: Boolean(existingDevice?.status),
        homebrain: Boolean(directUpdate?.status),
        matched: Boolean(existingDevice?.status) === Boolean(directUpdate?.status)
      },
      {
        key: 'battery',
        label: 'Battery level',
        previous: smartThingsBattery,
        homebrain: directBattery,
        matched: smartThingsBattery === null || directBattery !== null,
        required: featureSet.has('battery')
      },
      {
        key: 'features',
        label: 'Feature coverage',
        previous: inferFeaturesFromSmartThings(existingDevice),
        homebrain: Array.from(featureSet).sort(),
        matched: inferFeaturesFromSmartThings(existingDevice)
          .every((feature) => featureSet.has(normalizeFeature(feature)))
      }
    ];

    return {
      validatedAt: new Date().toISOString(),
      status: checks.every((check) => check.matched) ? 'passed' : 'needs_review',
      checks
    };
  },

buildMigrationFinalizationValidation(device, protocol, reason) {
    const properties = device?.properties && typeof device.properties === 'object'
      ? device.properties
      : {};
    const direct = properties.homebrainDirect && typeof properties.homebrainDirect === 'object'
      ? properties.homebrainDirect
      : {};
    const expectedSource = protocolSource(protocol);
    const source = normalizeSourceText(properties.source);
    const directProtocol = normalizeSourceText(direct.protocol);
    const features = uniqueStrings(Array.isArray(properties.directRadioFeatures)
      ? properties.directRadioFeatures
      : []);
    const featureSet = new Set(features.map(normalizeFeature));
    const previousFeatures = inferFeaturesFromSmartThings(device);
    const optionalSmartThingsFeatures = new Set(['firmware', 'health']);
    const requiredPreviousFeatures = previousFeatures
      .map(normalizeFeature)
      .filter((feature) => feature && !optionalSmartThingsFeatures.has(feature));
    const identity = protocol === 'zigbee'
      ? trimString(direct.ieeeAddr)
      : trimString(direct.nodeId);
    const checks = [
      {
        key: 'native_route',
        label: 'Native HomeBrain route',
        previous: properties.smartThingsMigration?.previousSource || 'smartthings',
        homebrain: source,
        matched: source === expectedSource && directProtocol === protocol,
        required: true
      },
      {
        key: 'identity',
        label: 'Direct radio identity',
        previous: properties.smartThingsMigration?.smartThingsDeviceId || properties.smartThingsDeviceId || null,
        homebrain: identity || null,
        matched: Boolean(identity),
        required: true
      },
      {
        key: 'online',
        label: 'Online state',
        previous: null,
        homebrain: device?.isOnline !== false,
        matched: device?.isOnline !== false,
        required: true
      },
      {
        key: 'features',
        label: 'Feature coverage',
        previous: requiredPreviousFeatures.length > 0 ? requiredPreviousFeatures : previousFeatures,
        homebrain: features,
        matched: requiredPreviousFeatures.length === 0
          ? features.length > 0
          : requiredPreviousFeatures.every((feature) => featureSet.has(normalizeFeature(feature))),
        required: true
      }
    ];

    return {
      validatedAt: new Date().toISOString(),
      status: checks.every((check) => check.matched) ? 'passed' : 'needs_review',
      finalized: checks.every((check) => check.matched),
      method: 'native_route_confirmation',
      reason: trimString(reason) || 'Native HomeBrain route and controls verified',
      checks
    };
  },

async markSmartThingsMigrationSourceRetired(sourceDevice, directDevice, finalization, migration = {}) {
    const sourceDeviceId = getDeviceIdString(sourceDevice);
    const directDeviceId = getDeviceIdString(directDevice);
    if (!sourceDeviceId || !directDeviceId || sourceDeviceId === directDeviceId) {
      return null;
    }

    const sourceProperties = getDeviceProperties(sourceDevice);
    const sourceMigration = getSmartThingsMigration(sourceDevice) || {};
    const finalizedAt = finalization?.finalizedAt || new Date().toISOString();
    const nextProperties = {
      ...sourceProperties,
      smartThingsMigration: {
        ...sourceMigration,
        migratedAt: sourceMigration.migratedAt || migration.migratedAt || finalizedAt,
        previousSource: sourceMigration.previousSource || sourceProperties.source || 'smartthings',
        smartThingsDeviceId: sourceMigration.smartThingsDeviceId || sourceProperties.smartThingsDeviceId || null,
        sourceDeviceId,
        sourceDeviceName: sourceDevice.name || null,
        directDeviceId,
        replacementDeviceId: directDeviceId,
        migrationId: migration.migrationId || sourceMigration.migrationId || null,
        finalizedAt,
        finalizedBy: 'homebrain',
        retiredAt: finalizedAt,
        retiredSource: true,
        status: 'finalized_source',
        validation: finalization?.validation || migration.validation || null
      }
    };

    const updatedSource = await Device.findByIdAndUpdate(sourceDeviceId, {
      properties: nextProperties,
      updatedAt: new Date()
    }, { returnDocument: 'after', runValidators: true });

    this.log('info', 'smartthings', 'Retired SmartThings source after native migration finalization', {
      sourceDeviceId,
      directDeviceId,
      migrationId: nextProperties.smartThingsMigration.migrationId
    });
    await this.remapSecurityZonesForMigratedDevice(updatedSource || sourceDevice, directDevice);
    this.emitDeviceUpdate(updatedSource);
    return updatedSource;
  },

async finalizeDeviceMigration({ deviceId, migrationId, reason } = {}) {
    const safeDeviceId = normalizeObjectId(deviceId);
    let device = await Device.findById(safeDeviceId);
    if (!device) {
      const error = new Error('Device not found');
      error.status = 404;
      throw error;
    }

    let properties = getDeviceProperties(device);
    const direct = properties.homebrainDirect && typeof properties.homebrainDirect === 'object'
      ? properties.homebrainDirect
      : {};
    const protocol = normalizeSourceText(direct.protocol)
      || (normalizeSourceText(properties.source) === DIRECT_RADIO_SOURCES.zigbee ? 'zigbee' : '')
      || (normalizeSourceText(properties.source) === DIRECT_RADIO_SOURCES.zwave ? 'zwave' : '');
    if (!['zigbee', 'zwave'].includes(protocol)) {
      const error = new Error('Native direct-radio protocol is not ready for this migrated device.');
      error.status = 409;
      throw error;
    }

    let migration = getSmartThingsMigration(device);
    let sourceDevice = null;
    if (!migration) {
      sourceDevice = await this.findDetachedSmartThingsMigrationSource(device, protocol);
      if (!sourceDevice) {
        const error = new Error('This device does not have an open SmartThings migration to finalize.');
        error.status = 400;
        throw error;
      }
      const recoveredSnapshot = this.buildRecoveredSmartThingsMigrationSnapshot(
        device,
        sourceDevice,
        protocol,
        migrationId
      );
      device = {
        ...toPlainDeviceSnapshot(device),
        ...recoveredSnapshot,
        properties: recoveredSnapshot.properties
      };
      properties = recoveredSnapshot.properties;
      migration = getSmartThingsMigration(device);
    } else if (migration.sourceDeviceId) {
      const maybeSource = await Device.findById(migration.sourceDeviceId).catch(() => null);
      if (maybeSource && getDeviceIdString(maybeSource) !== safeDeviceId) {
        sourceDevice = maybeSource;
      }
    }

    const validation = this.buildMigrationFinalizationValidation(device, protocol, reason);
    if (validation.status !== 'passed') {
      const error = new Error('HomeBrain cannot finalize this migration until the native radio route is ready.');
      error.status = 409;
      error.validation = validation;
      throw error;
    }

    const finalizedAt = new Date().toISOString();
    const nextProperties = {
      ...properties,
      source: protocolSource(protocol),
      smartThingsMigration: {
        ...migration,
        migrationId: trimString(migrationId) || migration.migrationId || null,
        finalizedAt,
        finalizedBy: 'homebrain',
        validation: {
          ...(migration.validation && typeof migration.validation === 'object' ? migration.validation : {}),
          ...validation,
          finalizedAt,
          finalized: true,
          status: 'passed'
        }
      }
    };

    const updated = await Device.findByIdAndUpdate(device._id, {
      temperature: device.temperature,
      properties: this.severMigratedSmartThingsIdentity(nextProperties),
      isOnline: device.isOnline !== false,
      updatedAt: new Date()
    }, { returnDocument: 'after', runValidators: true });

    const retiredSourceDevice = sourceDevice
      ? await this.markSmartThingsMigrationSourceRetired(sourceDevice, updated || device, {
        finalizedAt,
        validation: nextProperties.smartThingsMigration.validation
      }, nextProperties.smartThingsMigration)
      : null;

    this.log('info', protocol, 'SmartThings migration finalized on direct radio', {
      deviceId: updated?._id?.toString?.() || safeDeviceId,
      name: updated?.name || device.name || null,
      protocol,
      migrationId: nextProperties.smartThingsMigration.migrationId,
      validation: nextProperties.smartThingsMigration.validation
    });
    this.emitDeviceUpdate(updated);

    return {
      device: updated,
      retiredSourceDevice,
      finalization: {
        deviceId: updated?._id?.toString?.() || safeDeviceId,
        protocol,
        finalizedAt,
        validation: nextProperties.smartThingsMigration.validation
      }
    };
  },

async getMigrationPlan(deviceId, options = {}) {
    const safeDeviceId = normalizeObjectId(deviceId);
    const device = await Device.findById(safeDeviceId).lean();
    if (!device) {
      const error = new Error('Device not found');
      error.status = 404;
      throw error;
    }
    return buildMigrationPlan(device, options);
  },

async startMigration({ deviceId, protocol, durationSeconds, dskPin, migrationId, zwaveSecurityMode, securityMode, exclusionConfirmed } = {}) {
    const safeDeviceId = normalizeObjectId(deviceId);
    const device = await Device.findById(safeDeviceId).lean();
    if (!device) {
      const error = new Error('Device not found');
      error.status = 404;
      throw error;
    }

    const plan = buildMigrationPlan(device, { protocol });
    const targetProtocol = ['zigbee', 'zwave'].includes(protocol) ? protocol : plan.recommendedProtocol;
    if (!['zigbee', 'zwave'].includes(targetProtocol)) {
      const error = new Error('Choose Zigbee or Z-Wave before starting migration');
      error.status = 400;
      throw error;
    }
    if (!plan.supported) {
      const error = new Error('This SmartThings device looks cloud-only or virtual and cannot be migrated to a direct radio.');
      error.status = 400;
      throw error;
    }

    const seconds = boundedSeconds(durationSeconds);
    const now = Date.now();
    const requestedMigrationId = trimString(migrationId);
    let migration = null;
    if (requestedMigrationId) {
      migration = this.activeMigrations.get(requestedMigrationId) || null;
      if (!migration) {
        const error = new Error('Migration session not found. Restart the guided migration from HomeBrain.');
        error.status = 404;
        throw error;
      }
    } else if (targetProtocol === 'zwave') {
      migration = Array.from(this.activeMigrations.values())
        .filter((entry) => entry.sourceDeviceId === safeDeviceId && entry.protocol === 'zwave')
        .filter((entry) => ['excluded', 'excluding'].includes(entry.status))
        .sort((left, right) => (
          new Date(right.updatedAt || right.startedAt || 0).getTime()
          - new Date(left.updatedAt || left.startedAt || 0).getTime()
        ))[0] || null;
    }

    if (targetProtocol === 'zwave') {
      if (exclusionConfirmed === true) {
        // The operator excluded the device themselves (SmartThings app or a
        // device factory-reset / native general exclusion). SmartThings' cloud
        // API cannot reliably drive Z-Wave exclusion, so rather than block on it
        // forever, trust this explicit confirmation and proceed to native
        // inclusion.
        if (!migration || migration.sourceDeviceId !== safeDeviceId) {
          migration = {
            id: requestedMigrationId || `migration-${now}-${crypto.randomBytes(4).toString('hex')}`,
            sourceDeviceId: String(device._id),
            smartThingsDeviceId: device.properties?.smartThingsDeviceId || null,
            protocol: targetProtocol,
            startedAt: new Date(now).toISOString()
          };
          this.activeMigrations.set(migration.id, migration);
        }
        if (!migration.exclusionVerifiedAt) {
          this.markSmartThingsExclusionVerified(migration, {
            source: 'manual_confirmation',
            removalVerified: false,
            message: 'Exclusion confirmed by the operator; proceeding to native inclusion.'
          });
        }
      } else if (!migration || migration.sourceDeviceId !== safeDeviceId || !migration.exclusionVerifiedAt) {
        const error = new Error('Z-Wave exclusion has not been verified yet. Run a native HomeBrain exclusion (general Z-Wave exclusion on HomeBrain\'s own controller), or confirm you already excluded the device (SmartThings app or device reset) to proceed.');
        error.status = 409;
        error.code = 'ZWAVE_EXCLUSION_NOT_VERIFIED';
        throw error;
      }
    }

    if (!migration || migration.status === 'completed') {
      migration = {
        id: requestedMigrationId || `migration-${now}-${crypto.randomBytes(4).toString('hex')}`,
        sourceDeviceId: String(device._id),
        smartThingsDeviceId: device.properties?.smartThingsDeviceId || null,
        protocol: targetProtocol,
        startedAt: new Date(now).toISOString()
      };
    }

    Object.assign(migration, {
      sourceDeviceId: String(device._id),
      smartThingsDeviceId: device.properties?.smartThingsDeviceId || null,
      protocol: targetProtocol,
      status: 'pairing',
      pairingStartedAt: new Date(now).toISOString(),
      expiresAt: now + seconds * 1000,
      plan,
      updatedAt: new Date(now).toISOString()
    });
    this.activeMigrations.set(migration.id, migration);

    try {
      if (targetProtocol === 'zigbee' && migration.smartThingsDeviceId && !migration.smartThingsRemovalRequest) {
        const removalRequest = await this.requestSmartThingsDeviceRemoval(migration, device);
        this.log(removalRequest.status === 'failed' ? 'warn' : 'info', 'zigbee', 'Requested SmartThings Zigbee device removal before opening HomeBrain pairing', {
          migrationId: migration.id,
          deviceId: migration.sourceDeviceId,
          smartThingsDeviceId: migration.smartThingsDeviceId,
          removalRequestStatus: removalRequest.status
        });
      }
      if (targetProtocol === 'zigbee') {
        await this.startPairing('zigbee', { durationSeconds: seconds });
      } else {
        this.zwave.s2DskPin = trimString(dskPin);
        await this.startPairing('zwave', {
          durationSeconds: seconds,
          zwaveSecurityMode: normalizeZWaveSecurityMode(
            zwaveSecurityMode ?? securityMode,
            shouldUseSecureZWaveMigration(device, plan) ? 'default' : 'insecure'
          )
        });
      }
    } catch (error) {
      migration.status = 'pairing_failed';
      migration.inclusionStatus = 'failed';
      migration.inclusionFailedAt = new Date().toISOString();
      migration.updatedAt = migration.inclusionFailedAt;
      throw error;
    }

    return {
      migration,
      plan: {
        ...plan,
        recommendedProtocol: targetProtocol,
        manualSteps: plan.manualSteps
      }
    };
  },

buildMigrationVerificationResult(migration, result = {}) {
    const expiresAt = result.expiresAt ?? migration.exclusionExpiresAt ?? migration.expiresAt ?? null;
    const secondsRemaining = expiresAt
      ? Math.max(0, Math.ceil((Number(expiresAt) - Date.now()) / 1000))
      : 0;
    return {
      migrationId: migration.id,
      deviceId: migration.sourceDeviceId || null,
      protocol: migration.protocol,
      phase: result.phase || null,
      status: result.status || 'pending',
      verified: result.status === 'verified',
      canAdvance: result.status === 'verified',
      message: result.message || '',
      guidance: result.guidance || [],
      evidence: {
        exclusionVerifiedAt: migration.exclusionVerifiedAt || null,
        inclusionVerifiedAt: migration.inclusionVerifiedAt || null,
        completedAt: migration.completedAt || null,
        directIdentity: migration.directIdentity || null,
        directDeviceId: migration.directDeviceId || null,
        validation: migration.validation || null,
        zwaveEvents: Array.isArray(migration.zwaveEvents) ? migration.zwaveEvents.slice(-8) : [],
        smartThings: migration.smartThingsExclusionEvidence || null,
        expiresAt,
        secondsRemaining
      }
    };
  },

getSmartThingsService() {
    return this.smartThingsService || require('./smartThingsService');
  },

async getLocalMigrationDevice(migration) {
    const sourceDeviceId = trimString(migration?.sourceDeviceId);
    if (!sourceDeviceId || Device.db?.readyState !== 1) {
      return null;
    }

    try {
      return await Device.findById(sourceDeviceId).lean();
    } catch (error) {
      console.warn(`DirectRadioService: Failed to load migration source device ${sourceDeviceId}: ${error.message}`);
      return null;
    }
  },

async collectSmartThingsExclusionEvidence(migration) {
    const smartThingsDeviceId = trimString(migration.smartThingsDeviceId);
    const smartThings = this.getSmartThingsService();
    const evidence = {
      device: null,
      health: null,
      hubHealth: null,
      status: null,
      localDevice: await this.getLocalMigrationDevice(migration),
      gone: false,
      error: null
    };

    try {
      evidence.device = await smartThings.getDevice(smartThingsDeviceId);
    } catch (error) {
      if (isSmartThingsDeviceGoneError(error)) {
        evidence.gone = true;
        migration.smartThingsExclusionEvidence = summarizeSmartThingsExclusionEvidence({
          localDevice: evidence.localDevice,
          source: 'missing_device'
        });
        return evidence;
      }
      evidence.error = error;
      return evidence;
    }

    const hubId = getSmartThingsHubId(evidence.device);
    if (typeof smartThings.getDeviceHealth === 'function') {
      try {
        evidence.health = await smartThings.getDeviceHealth(smartThingsDeviceId);
      } catch (error) {
        this.log('warn', migration.protocol || 'smartthings', 'SmartThings device health was not available during migration verification', {
          migrationId: migration.id,
          smartThingsDeviceId,
          error: error.message
        });
      }
    }

    if (hubId && typeof smartThings.getHubHealth === 'function') {
      try {
        evidence.hubHealth = await smartThings.getHubHealth(hubId);
      } catch (error) {
        this.log('warn', migration.protocol || 'smartthings', 'SmartThings hub health was not available during migration verification', {
          migrationId: migration.id,
          smartThingsDeviceId,
          hubId,
          error: error.message
        });
      }
    }

    if (typeof smartThings.getDeviceStatus === 'function') {
      try {
        evidence.status = await smartThings.getDeviceStatus(smartThingsDeviceId);
      } catch (error) {
        this.log('warn', migration.protocol || 'smartthings', 'SmartThings device status was not available during migration verification', {
          migrationId: migration.id,
          smartThingsDeviceId,
          error: error.message
        });
      }
    }

    migration.smartThingsExclusionEvidence = summarizeSmartThingsExclusionEvidence({
      device: evidence.device,
      health: evidence.health,
      hubHealth: evidence.hubHealth,
      status: evidence.status,
      localDevice: evidence.localDevice,
      source: 'smartthings_api'
    });
    return evidence;
  },

markSmartThingsExclusionVerified(migration, { source, message, removalVerified = false } = {}) {
    const timestamp = new Date().toISOString();
    migration.status = 'excluded';
    migration.exclusionStatus = 'verified';
    migration.exclusionVerifiedAt = timestamp;
    migration.smartThingsExclusionVerifiedAt = timestamp;
    if (removalVerified) {
      migration.smartThingsRemovalVerifiedAt = timestamp;
    }
    migration.smartThingsExclusionVerificationSource = source || 'smartthings_api';
    migration.updatedAt = timestamp;
    migration.expiresAt = Math.max(Number(migration.expiresAt || 0), Date.now() + 15 * 60 * 1000);
    this.log('info', migration.protocol || 'smartthings', 'SmartThings migration exclusion verified', {
      migrationId: migration.id,
      deviceId: migration.sourceDeviceId,
      smartThingsDeviceId: migration.smartThingsDeviceId,
      source: migration.smartThingsExclusionVerificationSource
    });
    return this.buildMigrationVerificationResult(migration, {
      phase: 'physical_exclusion',
      status: 'verified',
      message: message || 'SmartThings no longer has a live route to this device. HomeBrain can now open native inclusion.'
    });
  },

async requestSmartThingsDeviceRemoval(migration, sourceDevice) {
    const smartThingsDeviceId = trimString(migration?.smartThingsDeviceId || sourceDevice?.properties?.smartThingsDeviceId);
    if (!smartThingsDeviceId) {
      return { status: 'skipped', reason: 'missing_smartthings_device_id' };
    }

    const smartThings = this.getSmartThingsService();
    let deviceDetails = null;
    if (typeof smartThings.getDevice === 'function') {
      try {
        deviceDetails = await smartThings.getDevice(smartThingsDeviceId);
      } catch (error) {
        if (isSmartThingsDeviceGoneError(error)) {
          migration.smartThingsRemovalRequest = {
            status: 'already_missing',
            requestedAt: new Date().toISOString()
          };
          migration.smartThingsExclusionEvidence = summarizeSmartThingsExclusionEvidence({
            localDevice: sourceDevice,
            source: 'already_missing'
          });
          return migration.smartThingsRemovalRequest;
        }
        migration.smartThingsRemovalRequest = {
          status: 'failed',
          requestedAt: new Date().toISOString(),
          error: error.message,
          statusCode: Number(error?.status ?? error?.response?.status) || null
        };
        return migration.smartThingsRemovalRequest;
      }
    }

    const hubId = getSmartThingsHubId(deviceDetails);
    if (hubId && typeof smartThings.getHubHealth === 'function') {
      try {
        migration.smartThingsHubHealthBeforeExclusion = await smartThings.getHubHealth(hubId);
      } catch (error) {
        this.log('warn', migration.protocol || 'smartthings', 'SmartThings hub baseline was not available before removal request', {
          migrationId: migration.id,
          smartThingsDeviceId,
          hubId,
          error: error.message
        });
      }
    }

    try {
      const response = typeof smartThings.deleteDevice === 'function'
        ? await smartThings.deleteDevice(smartThingsDeviceId)
        : null;
      migration.smartThingsRemovalRequest = {
        status: 'requested',
        requestedAt: new Date().toISOString(),
        response: response || null
      };
      return migration.smartThingsRemovalRequest;
    } catch (error) {
      if (isSmartThingsDeviceGoneError(error)) {
        migration.smartThingsRemovalRequest = {
          status: 'already_missing',
          requestedAt: new Date().toISOString()
        };
        return migration.smartThingsRemovalRequest;
      }
      migration.smartThingsRemovalRequest = {
        status: 'failed',
        requestedAt: new Date().toISOString(),
        error: error.message,
        statusCode: Number(error?.status ?? error?.response?.status) || null
      };
      this.log('warn', migration.protocol || 'smartthings', 'SmartThings device removal request failed during migration start', {
        migrationId: migration.id,
        smartThingsDeviceId,
        error: error.message,
        statusCode: migration.smartThingsRemovalRequest.statusCode
      });
      return migration.smartThingsRemovalRequest;
    }
  },

async verifySmartThingsExclusion(migration) {
    const smartThingsDeviceId = trimString(migration.smartThingsDeviceId);
    if (!smartThingsDeviceId) {
      return this.buildMigrationVerificationResult(migration, {
        phase: 'physical_exclusion',
        status: 'failed',
        message: 'This migration does not have a SmartThings device ID to verify against.',
        guidance: [
          'Refresh the device details and restart the guided migration from the SmartThings-backed device record.'
        ]
      });
    }

    const evidence = await this.collectSmartThingsExclusionEvidence(migration);
    if (evidence.gone) {
      return this.markSmartThingsExclusionVerified(migration, {
        source: 'missing_device',
        removalVerified: true,
        message: 'SmartThings no longer reports this device. HomeBrain can now open native inclusion.'
      });
    }
    if (evidence.error) {
      return this.buildMigrationVerificationResult(migration, {
        phase: 'physical_exclusion',
        status: 'pending',
        message: `HomeBrain could not verify SmartThings exclusion yet: ${evidence.error.message}`,
        guidance: [
          'Start SmartThings removal again from HomeBrain, or use the hub Z-Wave exclusion utility if SmartThings rejects the API request.',
          'Trigger the physical exclude action at the switch while the SmartThings hub is in exclusion/removal mode.',
          'Then tap Verify SmartThings exclusion again.'
        ]
      });
    }

    const counterIncrease = findSmartThingsExclusionCounterIncrease(
      migration.smartThingsHubHealthBeforeExclusion?.hubRadioState || migration.smartThingsHubHealthBeforeExclusion,
      evidence.hubHealth?.hubRadioState || evidence.hubHealth
    );
    if (counterIncrease) {
      migration.smartThingsExclusionCounter = counterIncrease;
      return this.markSmartThingsExclusionVerified(migration, {
        source: 'hub_exclusion_counter',
        message: `SmartThings reported an exclusion counter increase at ${counterIncrease.path}. HomeBrain can now open native inclusion.`
      });
    }

    const hubConnectivity = normalizeSmartThingsState(evidence.hubHealth?.connectivity);
    const healthState = normalizeSmartThingsState(
      evidence.health?.state || evidence.localDevice?.properties?.smartThingsHealthState?.state
    );
    const provisioningState = getSmartThingsProvisioningState(evidence.device);
    if (isSmartThingsUnprovisionedState(provisioningState)) {
      return this.markSmartThingsExclusionVerified(migration, {
        source: 'device_unprovisioned',
        message: 'SmartThings reports this device is no longer provisioned on its old radio network. HomeBrain can now open native inclusion.'
      });
    }
    if (healthState === 'OFFLINE' && hubConnectivity !== 'DISCONNECTED') {
      return this.markSmartThingsExclusionVerified(migration, {
        source: 'device_health_offline',
        message: 'SmartThings still has a stale device tile, but its device health is OFFLINE. HomeBrain will treat the old SmartThings radio route as gone and can now open native inclusion.'
      });
    }

    const expiresAt = Number(migration.exclusionExpiresAt || migration.expiresAt || 0);
    const timedOut = expiresAt > 0 && expiresAt <= Date.now();
    return this.buildMigrationVerificationResult(migration, {
      phase: 'physical_exclusion',
      status: timedOut ? 'failed' : 'pending',
      message: timedOut
        ? 'SmartThings still reports this device as reachable after the exclusion window. HomeBrain will not start native inclusion yet.'
        : 'SmartThings still reports this device as reachable. Stay on this step until SmartThings removal, the hub exclusion counter, or device health verifies.',
      guidance: [
        'Use HomeBrain Start SmartThings removal to request SmartThings removal over API, or open Hub > Z-Wave utilities > Z-Wave exclusion if SmartThings rejects the API request.',
        'At the switch, tap the local on/up paddle once. If it does not exclude, toggle on/up and off/down quickly 3 times.',
        'Do not start HomeBrain inclusion until SmartThings removal, exclusion counter, unprovisioned state, or OFFLINE health verifies.'
      ],
      expiresAt
    });
  },

async verifyMigrationExclusion(migration) {
    if (
      migration.status === 'awaiting_smartthings_exclusion'
      || migration.exclusionStatus === 'waiting_smartthings'
      || migration.smartThingsDeviceId
    ) {
      return this.verifySmartThingsExclusion(migration);
    }

    if (migration.exclusionVerifiedAt) {
      return this.buildMigrationVerificationResult(migration, {
        phase: 'physical_exclusion',
        status: 'verified',
        message: 'Z-Wave exclusion verified. The controller received the device removal confirmation, so HomeBrain can open inclusion next.'
      });
    }

    if (migration.status === 'exclusion_failed' || migration.exclusionFailedAt) {
      return this.buildMigrationVerificationResult(migration, {
        phase: 'physical_exclusion',
        status: 'failed',
        message: 'Z-Wave exclusion failed. Re-open exclusion and repeat the physical exclude action at the switch.',
        guidance: [
          'Tap the local on/up paddle once, then wait a few seconds.',
          'If nothing reports back, toggle on/up and off/down quickly 3 times.',
          'Keep the switch powered and make sure the Zooz stick is close enough to hear the device.'
        ]
      });
    }

    const expiresAt = Number(migration.exclusionExpiresAt || migration.expiresAt || 0);
    if (expiresAt > Date.now()) {
      return this.buildMigrationVerificationResult(migration, {
        phase: 'physical_exclusion',
        status: 'pending',
        message: 'HomeBrain has not received the Z-Wave exclusion confirmation yet. Stay on this step until the controller reports Done.',
        guidance: [
          'Tap the local on/up paddle once.',
          'If the switch does not exclude, quickly toggle on/up and off/down 3 times.',
          'Do not start inclusion until this step verifies.'
        ],
        expiresAt
      });
    }

    return this.buildMigrationVerificationResult(migration, {
      phase: 'physical_exclusion',
      status: 'failed',
      message: 'The Z-Wave exclusion window closed without a controller confirmation.',
      guidance: [
        'Start Z-Wave exclusion again from HomeBrain.',
        'Repeat the physical exclude action at the switch while the window is open.',
        'Move the switch or Zooz stick closer if the controller still does not report the removal.'
      ],
      expiresAt
    });
  },

verifyMigrationInclusion(migration) {
    const phase = migration.protocol === 'zigbee' ? 'physical_pairing' : 'physical_inclusion';
    if (migration.status === 'completed' && migration.inclusionVerifiedAt) {
      return this.buildMigrationVerificationResult(migration, {
        phase,
        status: 'verified',
        message: migration.protocol === 'zigbee'
          ? 'Zigbee pairing verified. HomeBrain created or updated the native device record from coordinator data.'
          : 'Z-Wave inclusion verified. HomeBrain received the new node and updated the native device record.'
      });
    }

    if (migration.status === 'pairing_failed' || migration.inclusionFailedAt) {
      return this.buildMigrationVerificationResult(migration, {
        phase,
        status: 'failed',
        message: migration.protocol === 'zigbee'
          ? 'Zigbee pairing failed before HomeBrain discovered the device.'
          : 'Z-Wave inclusion failed before HomeBrain received a verified node.',
        guidance: migration.protocol === 'zigbee'
          ? [
              'Open pairing again and factory reset the device while permit-join is active.',
              'Keep battery devices awake until HomeBrain captures the interview data.'
            ]
          : [
              'Open inclusion again only after exclusion has verified.',
              'Tap the local paddle once; if no node appears, use the quick 3-toggle sequence.',
              'Leave the switch powered until HomeBrain reports the interview.'
            ]
      });
    }

    const expiresAt = Number(migration.expiresAt || 0);
    if (expiresAt > Date.now()) {
      return this.buildMigrationVerificationResult(migration, {
        phase,
        status: 'pending',
        message: migration.protocol === 'zigbee'
          ? 'HomeBrain has not discovered the Zigbee device yet. Stay on this step while permit-join is open.'
          : 'HomeBrain has not received the new Z-Wave node yet. Stay on this step until inclusion verifies.',
        guidance: migration.protocol === 'zigbee'
          ? [
              'Keep the device in pairing mode until HomeBrain shows the native device.',
              'Wake battery sensors again if discovery starts but attributes are missing.'
            ]
          : [
              'Tap the local on/up paddle once or press the module button once.',
              'If no node appears, use the quick 3-toggle sequence.',
              'Do not finish migration until HomeBrain verifies the included node.'
            ],
        expiresAt
      });
    }

    return this.buildMigrationVerificationResult(migration, {
      phase,
      status: 'failed',
      message: migration.protocol === 'zigbee'
        ? 'The Zigbee pairing window closed without a verified HomeBrain device.'
        : 'The Z-Wave inclusion window closed without a verified HomeBrain node.',
      guidance: migration.protocol === 'zigbee'
        ? [
            'Open pairing again and repeat the device reset/pair action.',
            'Move the device closer to the SONOFF coordinator for the first join.'
          ]
        : [
            'Open inclusion again and repeat the switch include action.',
            'If inclusion repeatedly times out, run exclusion again first, then retry inclusion close to the Zooz stick.'
          ],
      expiresAt
    });
  },

async verifyMigrationReadiness(migration) {
    if (migration.status !== 'completed') {
      return this.verifyMigrationInclusion(migration);
    }

    const device = await Device.findById(migration.sourceDeviceId).lean();
    const expectedSource = protocolSource(migration.protocol);
    const directProtocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol);
    const directRouteReady = normalizeSourceText(device?.properties?.source) === expectedSource
      && directProtocol === migration.protocol
      && device?.isOnline !== false;

    return this.buildMigrationVerificationResult(migration, directRouteReady
      ? {
          phase: 'verification',
          status: 'verified',
          message: 'HomeBrain verified the native route, online state, and migration metadata. Keep SmartThings available until you are satisfied the real control path behaves correctly.'
        }
      : {
          phase: 'verification',
          status: 'failed',
          message: 'HomeBrain found the migration session, but the native route is not ready on the device record yet.',
          guidance: [
            'Wait for the radio interview to finish and refresh the device details.',
            'Do not retire the SmartThings route until HomeBrain shows the native route online.'
          ]
        });
  },

async verifyMigrationStep({ migrationId, deviceId, protocol, phase, stepId } = {}) {
    const safeDeviceId = trimString(deviceId) ? normalizeObjectId(deviceId) : '';
    const normalizedProtocol = normalizeSourceText(protocol);
    const migration = this.findMigrationSession({
      migrationId,
      deviceId: safeDeviceId,
      protocol: ['zigbee', 'zwave'].includes(normalizedProtocol) ? normalizedProtocol : undefined
    });
    if (!migration) {
      const error = new Error('Migration session not found. Start the guided migration from HomeBrain before verifying this step.');
      error.status = 404;
      throw error;
    }
    if (safeDeviceId && migration.sourceDeviceId !== safeDeviceId) {
      const error = new Error('Migration session does not match this device.');
      error.status = 409;
      throw error;
    }

    const normalizedPhase = normalizeSourceText(phase);
    let verification;
    if (normalizedPhase === 'physical_exclusion' || normalizedPhase === 'exclusion') {
      verification = await this.verifyMigrationExclusion(migration);
    } else if (['physical_inclusion', 'physical_pairing', 'permit_join', 'inclusion'].includes(normalizedPhase)) {
      verification = this.verifyMigrationInclusion(migration);
    } else if (normalizedPhase === 'verification') {
      verification = await this.verifyMigrationReadiness(migration);
    } else {
      verification = this.buildMigrationVerificationResult(migration, {
        phase: normalizedPhase || null,
        status: 'verified',
        message: 'Step does not require radio verification.'
      });
    }

    return {
      verification: {
        ...verification,
        stepId: stepId || null
      },
      migration
    };
  },

async startExclusion(protocol, options = {}) {
    if (protocol !== 'zwave') {
      const error = new Error('Only Z-Wave supports controller-driven exclusion.');
      error.status = 400;
      throw error;
    }

    const seconds = boundedSeconds(options.durationSeconds);
    const safeDeviceId = trimString(options.deviceId) ? normalizeObjectId(options.deviceId) : '';
    if (safeDeviceId) {
      const device = await Device.findById(safeDeviceId).lean();
      if (!device) {
        const error = new Error('Device not found');
        error.status = 404;
        throw error;
      }
      const plan = buildMigrationPlan(device, { protocol: 'zwave' });
      if (!plan.supported) {
        const error = new Error('This SmartThings device looks cloud-only or virtual and cannot be migrated to a direct radio.');
        error.status = 400;
        throw error;
      }

      const smartThingsDeviceId = trimString(device.properties?.smartThingsDeviceId);
      // When the caller opts into native exclusion, skip the SmartThings-API
      // removal branch and drive a real Z-Wave general exclusion on HomeBrain's
      // own controller (which can exclude a device even if it still believes it
      // belongs to the SmartThings hub).
      if (smartThingsDeviceId && options.useNativeExclusion !== true) {
        const requestedMigrationId = trimString(options.migrationId);
        const existingMigration = requestedMigrationId
          ? this.activeMigrations.get(requestedMigrationId)
          : Array.from(this.activeMigrations.values())
            .filter((entry) => entry.sourceDeviceId === safeDeviceId && entry.protocol === 'zwave')
            .filter((entry) => !['completed'].includes(entry.status))
            .sort((left, right) => (
              new Date(right.updatedAt || right.startedAt || 0).getTime()
              - new Date(left.updatedAt || left.startedAt || 0).getTime()
            ))[0];
        const now = Date.now();
        const migration = existingMigration || {
          id: requestedMigrationId || `migration-${now}-${crypto.randomBytes(4).toString('hex')}`,
          sourceDeviceId: String(device._id),
          smartThingsDeviceId,
          protocol: 'zwave',
          startedAt: new Date(now).toISOString()
        };
        Object.assign(migration, {
          sourceDeviceId: String(device._id),
          smartThingsDeviceId,
          protocol: 'zwave',
          status: 'awaiting_smartthings_exclusion',
          exclusionStatus: 'waiting_smartthings',
          exclusionStartedAt: new Date(now).toISOString(),
          exclusionExpiresAt: now + seconds * 1000,
          expiresAt: now + seconds * 1000,
          plan,
          updatedAt: new Date(now).toISOString()
        });
        const removalRequest = await this.requestSmartThingsDeviceRemoval(migration, device);
        if (removalRequest.status === 'already_missing') {
          this.markSmartThingsExclusionVerified(migration, {
            source: 'missing_device_at_start',
            removalVerified: true,
            message: 'SmartThings no longer reports this device. HomeBrain can now open native Z-Wave inclusion.'
          });
        }
        this.activeMigrations.set(migration.id, migration);
        this.log('info', 'zwave', 'Requested SmartThings Z-Wave removal and prepared exclusion verification', {
          migrationId: migration.id,
          deviceId: migration.sourceDeviceId,
          smartThingsDeviceId,
          removalRequestStatus: removalRequest.status
        });
        return {
          protocol,
          mode: removalRequest.status === 'requested' ? 'smartthings_api_exclusion' : 'smartthings_exclusion',
          expiresAt: new Date(migration.exclusionExpiresAt).toISOString(),
          smartThingsRemovalRequest: removalRequest,
          migration
        };
      }
    }

    await this.start();
    const controller = this.getZWaveController();
    if (!controller || !this.zwave.started) {
      this.log('warn', 'zwave', 'Cannot open Z-Wave exclusion because the controller is not ready', {
        detectedPort: this.detected.zwave?.path || null,
        error: this.zwave.error || null
      });
      const error = new Error('Z-Wave controller is not ready.');
      error.status = 503;
      throw error;
    }

    let migration = null;
    if (safeDeviceId) {
      const device = await Device.findById(safeDeviceId).lean();
      if (!device) {
        const error = new Error('Device not found');
        error.status = 404;
        throw error;
      }
      const plan = buildMigrationPlan(device, { protocol: 'zwave' });
      if (!plan.supported) {
        const error = new Error('This SmartThings device looks cloud-only or virtual and cannot be migrated to a direct radio.');
        error.status = 400;
        throw error;
      }

      const requestedMigrationId = trimString(options.migrationId);
      const existingMigration = requestedMigrationId
        ? this.activeMigrations.get(requestedMigrationId)
        : Array.from(this.activeMigrations.values())
          .filter((entry) => entry.sourceDeviceId === safeDeviceId && entry.protocol === 'zwave')
          .filter((entry) => !['completed'].includes(entry.status))
          .sort((left, right) => (
            new Date(right.updatedAt || right.startedAt || 0).getTime()
            - new Date(left.updatedAt || left.startedAt || 0).getTime()
          ))[0];
      const now = Date.now();
      migration = existingMigration || {
        id: requestedMigrationId || `migration-${now}-${crypto.randomBytes(4).toString('hex')}`,
        sourceDeviceId: String(device._id),
        smartThingsDeviceId: device.properties?.smartThingsDeviceId || null,
        protocol: 'zwave',
        startedAt: new Date(now).toISOString()
      };
      Object.assign(migration, {
        sourceDeviceId: String(device._id),
        smartThingsDeviceId: device.properties?.smartThingsDeviceId || null,
        protocol: 'zwave',
        status: 'excluding',
        exclusionStatus: 'waiting',
        exclusionStartedAt: new Date(now).toISOString(),
        exclusionExpiresAt: now + seconds * 1000,
        expiresAt: now + seconds * 1000,
        plan,
        updatedAt: new Date(now).toISOString()
      });
      this.activeMigrations.set(migration.id, migration);
    }

    const zwave = require('zwave-js');
    const resetResult = await this.closeZWavePairingWindow({
      zwave,
      reason: 'start_exclusion',
      sessionMessage: 'Previous Z-Wave add/remove window was stopped before starting exclusion.'
    });
    this.log('info', 'zwave', 'Opening Z-Wave exclusion window', {
      durationSeconds: seconds,
      serialPath: this.detected.zwave?.path || null,
      migrationId: migration?.id || null,
      previousWindow: resetResult
    });
    let exclusionStarted = false;
    try {
      exclusionStarted = await controller.beginExclusion({ strategy: zwave.ExclusionStrategy.ExcludeOnly });
    } catch (error) {
      if (migration) {
        migration.status = 'exclusion_failed';
        migration.exclusionStatus = 'failed';
        migration.exclusionFailedAt = new Date().toISOString();
        migration.updatedAt = migration.exclusionFailedAt;
      }
      throw error;
    }
    if (exclusionStarted !== true) {
      await this.closeZWavePairingWindow({
        zwave,
        reason: 'retry_exclusion_after_busy',
        markSession: false,
        sessionMessage: 'HomeBrain reset the Z-Wave controller after the first exclusion start did not open.'
      });
      await delay(350);
      try {
        exclusionStarted = await controller.beginExclusion({ strategy: zwave.ExclusionStrategy.ExcludeOnly });
      } catch (error) {
        if (migration) {
          migration.status = 'exclusion_failed';
          migration.exclusionStatus = 'failed';
          migration.exclusionFailedAt = new Date().toISOString();
          migration.updatedAt = migration.exclusionFailedAt;
        }
        throw error;
      }
    }
    if (exclusionStarted !== true) {
      const state = this.getZWaveInclusionStateLabel(zwave);
      const message = state
        ? `Z-Wave exclusion did not start because the controller is still ${state}. HomeBrain reset the stale window, but the controller did not accept the new exclusion request.`
        : 'Z-Wave exclusion did not start because the controller reported it was already busy after HomeBrain reset the stale window.';
      if (migration) {
        migration.status = 'exclusion_failed';
        migration.exclusionStatus = 'failed';
        migration.exclusionFailedAt = new Date().toISOString();
        migration.updatedAt = migration.exclusionFailedAt;
      }
      this.zwave.exclusionUntil = null;
      this.log('warn', 'zwave', 'Z-Wave exclusion window did not start', {
        migrationId: migration?.id || null,
        state,
        previousWindow: resetResult
      });
      const error = new Error(message);
      error.status = 409;
      error.code = 'ZWAVE_EXCLUSION_NOT_STARTED';
      throw error;
    }
    this.zwave.exclusionUntil = new Date(Date.now() + seconds * 1000).toISOString();
    const stopTimer = setTimeout(() => {
      void this.stopPairing('zwave').catch(() => {});
    }, seconds * 1000);
    if (typeof stopTimer.unref === 'function') {
      stopTimer.unref();
    }
    this.pairingTimers.zwave = stopTimer;
    this.log('info', 'zwave', 'Z-Wave exclusion window is open', {
      expiresAt: this.zwave.exclusionUntil,
      migrationId: migration?.id || null
    });
    return {
      protocol,
      mode: 'exclusion',
      expiresAt: this.zwave.exclusionUntil,
      migration
    };
  }
};

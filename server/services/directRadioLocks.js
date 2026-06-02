'use strict';

// DirectRadioService Locks methods (mixed onto the prototype). Extracted from
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
  getZWaveUserCodeApi,
  getZWaveUserCodeSupportedUsers,
  getZWaveLockCodeCapabilities,
  codeNameForSlot,
  lockEventActionFromLabel,
  extractLockUserId,
  serializeLockCodeSlot,
  serializeDoorLockLogRecord
} = require('./directRadioHelpers');

module.exports = {
buildDirectDeviceUpsertLockKey(identity = {}) {
    const protocol = trimString(identity.protocol).toLowerCase();
    const id = trimString(identity.id);
    return protocol && id ? `${protocol}:${id}` : '';
  },

async withDirectDeviceUpsertLock(identity, action) {
    const lockKey = this.buildDirectDeviceUpsertLockKey(identity);
    if (!lockKey || typeof action !== 'function') {
      return action?.();
    }

    const previous = this.directDeviceUpsertLocks.get(lockKey) || Promise.resolve();
    let releaseCurrent = null;
    const current = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
    const queued = previous.catch(() => {}).then(() => current);
    this.directDeviceUpsertLocks.set(lockKey, queued);

    await previous.catch(() => {});
    try {
      return await action();
    } finally {
      releaseCurrent?.();
      if (this.directDeviceUpsertLocks.get(lockKey) === queued) {
        this.directDeviceUpsertLocks.delete(lockKey);
      }
    }
  },

async publishZWaveLockCodeEvent(node, event = {}) {
    const device = await this.findDeviceForZWaveNode(node);
    if (!device || device.type !== 'lock') {
      return null;
    }

    const slot = normalizeLockCodeSlot(event.slot || event.userId);
    const payload = {
      deviceId: device._id?.toString?.() || String(device._id || ''),
      deviceName: device.name || null,
      nodeId: normalizeLockCodeSlot(node?.id),
      slot,
      codeName: slot ? codeNameForSlot(device, slot) : null,
      action: event.action || 'unknown',
      label: event.label || null,
      source: event.source || 'zwave',
      actor: event.actor || null,
      notification: event.notification || null
    };

    return eventStreamService.publishSafe({
      type: event.type || 'lock_code.used',
      source: 'homebrain-zwave',
      category: 'security',
      severity: event.severity || 'info',
      payload,
      tags: ['lock', 'pin', 'zwave', `device:${payload.deviceId}`]
    });
  },

handleZWaveLockNotification(node, endpoint, ccId, args = {}) {
    const label = trimString(args.eventLabel || args.label);
    const eventText = `${label} ${trimString(args.label)}`.toLowerCase();
    if (!/\b(lock|unlock|code|keypad|access)\b/.test(eventText)) {
      return;
    }

    const userId = extractLockUserId(args.parameters);
    void this.publishZWaveLockCodeEvent(node, {
      type: userId ? 'lock_code.used' : 'lock.state_event',
      action: lockEventActionFromLabel(label),
      userId,
      label,
      notification: {
        endpoint: endpoint?.index ?? null,
        commandClass: ccId ?? null,
        type: args.type ?? null,
        event: args.event ?? null,
        parameters: args.parameters || null
      }
    }).catch((error) => {
      this.log('warn', 'zwave', 'Failed to record Z-Wave lock notification', {
        nodeId: node?.id || null,
        error: error.message
      });
    });
  },

handleZWaveLockUserChanged(node, eventType, args = {}) {
    const slot = normalizeLockCodeSlot(args.userId || args.credentialSlot);
    if (!slot) {
      return;
    }

    const type = eventType === 'deleted'
      ? 'lock_code.deleted'
      : eventType === 'added'
        ? 'lock_code.added'
        : 'lock_code.modified';
    void this.publishZWaveLockCodeEvent(node, {
      type,
      action: `code_${eventType}`,
      userId: slot,
      label: `Lock code ${eventType}`
    }).catch((error) => {
      this.log('warn', 'zwave', 'Failed to record Z-Wave lock code change event', {
        nodeId: node?.id || null,
        slot,
        error: error.message
      });
    });
  },

async getNativeZWaveLockContext(deviceId) {
    const device = await Device.findById(deviceId);
    if (!device) {
      const error = new Error('Device not found');
      error.status = 404;
      throw error;
    }
    if (device.type !== 'lock') {
      const error = new Error('Lock PIN management is only available for lock devices');
      error.status = 400;
      throw error;
    }

    const source = normalizeSourceText(device?.properties?.source);
    const protocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol);
    if (source !== DIRECT_RADIO_SOURCES.zwave && protocol !== 'zwave') {
      const error = new Error('Lock PIN management requires a HomeBrain-native Z-Wave lock. Migrate this SmartThings lock to HomeBrain Z-Wave first.');
      error.status = 400;
      throw error;
    }

    await this.start();
    const node = this.getDirectNodeForDevice(device);
    if (!node) {
      const error = new Error('Z-Wave node is not ready for this lock');
      error.status = 409;
      throw error;
    }

    const accessControl = getZWaveAccessControl(node);
    const userCodeApi = accessControl ? null : getZWaveUserCodeApi(node);
    if (!accessControl && !userCodeApi) {
      const error = new Error('This Z-Wave lock is paired without secure User Code/User Credential support. Exclude it from Z-Wave and add it again with Legacy S0 for older Kwikset/Schlage locks, or S2 Access Control for newer locks, so HomeBrain can manage PIN slots.');
      error.code = 'ZWAVE_LOCK_ACCESS_CONTROL_UNAVAILABLE';
      error.status = 400;
      throw error;
    }

    return {
      device,
      node,
      accessControl,
      userCodeApi,
      lockCodeBackend: accessControl ? 'accessControl' : 'userCode'
    };
  },

async readZWaveLockUsers(device, accessControl, options = {}) {
    const userCodeApi = options.userCodeApi || null;
    const node = options.node || null;
    if (!accessControl && userCodeApi) {
      const zwave = require('zwave-js');
      let maxUsers = getZWaveUserCodeSupportedUsers(node);
      if ((options.refresh === true || maxUsers <= 0) && typeof userCodeApi.getUsersCount === 'function') {
        maxUsers = Number(await userCodeApi.getUsersCount()) || maxUsers;
      }
      maxUsers = Math.max(0, Math.min(250, Number(maxUsers) || 0));
      const users = [];
      for (let userId = 1; userId <= maxUsers; userId += 1) {
        let userIdStatus = getZWaveValue(node, zwave.UserCodeCCValues.userIdStatus(userId));
        if ((options.refresh === true || userIdStatus === undefined) && typeof userCodeApi.get === 'function') {
          // eslint-disable-next-line no-await-in-loop
          const result = await userCodeApi.get(userId);
          if (result?.userIdStatus !== undefined) {
            userIdStatus = result.userIdStatus;
          }
        }
        if (
          userIdStatus === undefined
          || userIdStatus === zwave.UserIDStatus.Available
          || userIdStatus === zwave.UserIDStatus.StatusNotAvailable
        ) {
          continue;
        }
        users.push({
          userId,
          active: userIdStatus !== zwave.UserIDStatus.Disabled,
          userType: zwave.UserCredentialUserType.General
        });
      }
      return users
        .map((user) => serializeLockCodeSlot(device, user))
        .filter(Boolean)
        .sort((left, right) => left.slot - right.slot);
    }

    const refresh = options.refresh === true;
    let users = [];
    if (!refresh && typeof accessControl.getUsersCached === 'function') {
      users = accessControl.getUsersCached() || [];
    }
    if ((refresh || users.length === 0) && typeof accessControl.getUsers === 'function') {
      users = await accessControl.getUsers();
    }

    return users
      .map((user) => serializeLockCodeSlot(device, user))
      .filter(Boolean)
      .sort((left, right) => left.slot - right.slot);
  },

async readZWaveLockAuditFromDevice(device, node, options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 25));
    const api = node?.commandClasses?.['Door Lock Logging'];
    if (!api || typeof api.getRecord !== 'function') {
      return [];
    }

    let count = 0;
    if (typeof api.getRecordsCount === 'function') {
      try {
        count = Number(await api.getRecordsCount()) || 0;
      } catch (error) {
        this.log('warn', 'zwave', 'Unable to read Z-Wave door lock audit count', {
          deviceId: device?._id?.toString?.() || null,
          nodeId: node?.id || null,
          error: error.message
        });
      }
    }

    const records = [];
    const maxRecord = count > 0 ? Math.min(count, limit) : limit;
    for (let recordNumber = 1; recordNumber <= maxRecord; recordNumber += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const record = await api.getRecord(recordNumber);
        const serialized = serializeDoorLockLogRecord(device, record, recordNumber);
        if (serialized) {
          records.push(serialized);
        }
      } catch (error) {
        this.log('warn', 'zwave', 'Unable to read Z-Wave door lock audit record', {
          deviceId: device?._id?.toString?.() || null,
          nodeId: node?.id || null,
          recordNumber,
          error: error.message
        });
        break;
      }
    }

    return records;
  },

async readHomeBrainLockAudit(device, node, options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 25));
    if (EventStreamEvent.db?.readyState !== 1) {
      return [];
    }

    const deviceId = device?._id?.toString?.() || String(device?._id || '');
    const nodeId = normalizeLockCodeSlot(node?.id || device?.properties?.homebrainDirect?.nodeId);
    const query = {
      category: 'security',
      type: { $in: ['lock_code.used', 'lock.state_event', 'lock_code.added', 'lock_code.modified', 'lock_code.deleted', 'lock_code.set'] },
      $or: [
        { 'payload.deviceId': deviceId },
        ...(nodeId ? [{ 'payload.nodeId': nodeId }] : [])
      ]
    };

    const docs = await EventStreamEvent.find(query)
      .sort({ createdAt: -1 })
      .limit(limit);

    return docs.map((doc) => {
      const event = typeof doc.toObject === 'function' ? doc.toObject() : doc;
      const payload = event.payload || {};
      return {
        id: event._id?.toString?.() || String(event._id || ''),
        source: 'homebrain',
        type: event.type,
        action: payload.action || 'unknown',
        label: payload.label || event.type,
        slot: normalizeLockCodeSlot(payload.slot),
        codeName: payload.codeName || (payload.slot ? codeNameForSlot(device, payload.slot) : null),
        actor: payload.actor || null,
        createdAt: event.createdAt || null
      };
    }).reverse();
  },

async getLockCodeState(deviceId, options = {}) {
    const { device, node, accessControl, userCodeApi, lockCodeBackend } = await this.getNativeZWaveLockContext(deviceId);
    const capabilities = getZWaveLockCodeCapabilities(node, accessControl, userCodeApi);
    const slots = await this.readZWaveLockUsers(device, accessControl, {
      refresh: options.refresh === true,
      userCodeApi,
      node
    });
    let maxSlots = capabilities.maxSlots || Math.max(0, ...slots.map((slot) => slot.slot));
    if (maxSlots <= 0 && userCodeApi && typeof userCodeApi.getUsersCount === 'function') {
      maxSlots = Number(await userCodeApi.getUsersCount()) || maxSlots;
    }
    const occupied = new Set(slots.map((slot) => slot.slot));

    return {
      deviceId: device._id?.toString?.() || String(device._id || ''),
      deviceName: device.name,
      nodeId: normalizeLockCodeSlot(node.id),
      native: true,
      capabilities: {
        ...capabilities,
        backend: lockCodeBackend,
        maxSlots
      },
      slots,
      availableSlots: Array.from({ length: maxSlots }, (_value, index) => index + 1)
        .filter((slot) => !occupied.has(slot))
    };
  },

async setLockCode(deviceId, payload = {}, options = {}) {
    const { device, node, accessControl, userCodeApi } = await this.getNativeZWaveLockContext(deviceId);
    const capabilities = getZWaveLockCodeCapabilities(node, accessControl, userCodeApi);
    const zwave = require('zwave-js');
    const slot = normalizeLockCodeSlot(payload.slot || payload.userId);
    if (!slot || (capabilities.maxSlots > 0 && slot > capabilities.maxSlots)) {
      throw new Error(`Lock code slot must be between 1 and ${capabilities.maxSlots || 'the supported slot count'}.`);
    }

    const name = normalizeLockCodeName(payload.name, `Code ${slot}`);
    const enabled = payload.enabled !== false;
    const pinProvided = trimString(payload.pin).length > 0;

    if (accessControl && pinProvided) {
      const pin = normalizeLockPin(payload.pin, capabilities);
      if (capabilities.supportsNames) {
        await accessControl.setUser(slot, { active: true, userName: name });
      }
      const credentialResult = await accessControl.setCredential(
        slot,
        zwave.UserCredentialType.PINCode,
        slot,
        pin
      );
      if (!operationSucceeded(credentialResult, zwave.SetCredentialResult.OK)) {
        throw new Error(`Lock rejected PIN update: ${enumLabel(zwave.SetCredentialResult, credentialResult, 'unknown')}`);
      }
    }

    if (accessControl && typeof accessControl.setUser === 'function' && (pinProvided || Object.prototype.hasOwnProperty.call(payload, 'enabled') || capabilities.supportsNames)) {
      const userResult = await accessControl.setUser(slot, {
        active: enabled,
        ...(capabilities.supportsNames ? { userName: name } : {})
      });
      if (!operationSucceeded(userResult, zwave.SetUserResult.OK)) {
        throw new Error(`Lock rejected user update: ${enumLabel(zwave.SetUserResult, userResult, 'unknown')}`);
      }
    }

    if (!accessControl && userCodeApi) {
      if (pinProvided) {
        const pin = normalizeLockPin(payload.pin, capabilities);
        const userCodeResult = await userCodeApi.set(
          slot,
          enabled ? zwave.UserIDStatus.Enabled : zwave.UserIDStatus.Disabled,
          pin
        );
        if (!operationSucceeded(userCodeResult)) {
          throw new Error('Lock rejected legacy User Code PIN update');
        }
      } else if (Object.prototype.hasOwnProperty.call(payload, 'enabled')) {
        const existing = typeof userCodeApi.get === 'function' ? await userCodeApi.get(slot) : null;
        const existingCode = existing?.userCode ?? getZWaveValue(node, zwave.UserCodeCCValues.userCode(slot));
        if (!existingCode) {
          throw new Error('Enter the PIN when enabling or disabling this legacy User Code slot so HomeBrain can preserve the credential.');
        }
        const userCodeResult = await userCodeApi.set(
          slot,
          enabled ? zwave.UserIDStatus.Enabled : zwave.UserIDStatus.Disabled,
          existingCode
        );
        if (!operationSucceeded(userCodeResult)) {
          throw new Error('Lock rejected legacy User Code status update');
        }
      }
    }

    const now = new Date().toISOString();
    const actor = trimString(options.actor || payload.actor) || 'unknown';
    await Device.updateOne(
      { _id: device._id },
      {
        $set: {
          [`properties.lockCodes.assignments.${slot}`]: {
            name,
            enabled,
            source: 'homebrain',
            updatedAt: now,
            updatedBy: actor
          },
          'properties.lockCodes.lastManagedAt': now,
          'properties.lockCodes.lastManagedBy': actor
        }
      }
    );

    await this.publishZWaveLockCodeEvent(node, {
      type: 'lock_code.set',
      action: pinProvided ? 'code_set' : 'code_named',
      userId: slot,
      label: pinProvided ? 'Lock PIN set' : 'Lock PIN label updated',
      actor,
      source: 'homebrain'
    });

    return this.getLockCodeState(deviceId, { refresh: false });
  },

async deleteLockCode(deviceId, slotValue, options = {}) {
    const { device, node, accessControl, userCodeApi } = await this.getNativeZWaveLockContext(deviceId);
    const slot = normalizeLockCodeSlot(slotValue);
    if (!slot) {
      throw new Error('Lock code slot is required');
    }

    const zwave = require('zwave-js');
    if (accessControl) {
      const result = await accessControl.deleteUser(slot);
      if (!operationSucceeded(result, zwave.SetUserResult.OK)) {
        throw new Error(`Lock rejected PIN deletion: ${enumLabel(zwave.SetUserResult, result, 'unknown')}`);
      }
    } else {
      const result = await userCodeApi.clear(slot);
      if (!operationSucceeded(result)) {
        throw new Error('Lock rejected legacy User Code PIN deletion');
      }
    }

    const now = new Date().toISOString();
    const actor = trimString(options.actor) || 'unknown';
    await Device.updateOne(
      { _id: device._id },
      {
        $unset: {
          [`properties.lockCodes.assignments.${slot}`]: ''
        },
        $set: {
          'properties.lockCodes.lastManagedAt': now,
          'properties.lockCodes.lastManagedBy': actor
        }
      }
    );

    await this.publishZWaveLockCodeEvent(node, {
      type: 'lock_code.deleted',
      action: 'code_deleted',
      userId: slot,
      label: 'Lock PIN deleted',
      actor,
      source: 'homebrain'
    });

    return this.getLockCodeState(deviceId, { refresh: false });
  },

async getLockCodeAudit(deviceId, options = {}) {
    const { device, node } = await this.getNativeZWaveLockContext(deviceId);
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    const [homebrain, lock] = await Promise.all([
      this.readHomeBrainLockAudit(device, node, { limit }),
      options.includeDeviceLog === false
        ? Promise.resolve([])
        : this.readZWaveLockAuditFromDevice(device, node, { limit })
    ]);

    return {
      deviceId: device._id?.toString?.() || String(device._id || ''),
      deviceName: device.name,
      nodeId: normalizeLockCodeSlot(node.id),
      events: [...homebrain, ...lock]
        .filter((event) => event && event.createdAt)
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        .slice(0, limit)
    };
  }
};

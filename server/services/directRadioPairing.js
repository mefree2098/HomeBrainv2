'use strict';

// DirectRadioService Pairing methods (mixed onto the prototype). Extracted from
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
clearPairingTimer(protocol) {
    const timer = this.pairingTimers?.[protocol];
    if (timer) {
      clearTimeout(timer);
      this.pairingTimers[protocol] = null;
    }
  },

async closeZWavePairingWindow(options = {}) {
    const controller = this.getZWaveController();
    this.clearPairingTimer('zwave');
    this.zwave.inclusionUntil = null;
    this.zwave.exclusionUntil = null;
    this.zwave.pendingDsk = null;
    this.resolvePendingZWaveDsk(false);

    const beforeState = this.getZWaveInclusionStateLabel(options.zwave);
    const result = {
      beforeState,
      afterState: beforeState,
      stoppedInclusion: false,
      stoppedExclusion: false,
      inclusionStopError: null,
      exclusionStopError: null
    };

    if (controller) {
      if (typeof controller.stopInclusion === 'function') {
        try {
          result.stoppedInclusion = await controller.stopInclusion();
        } catch (error) {
          result.inclusionStopError = error.message;
          this.log('warn', 'zwave', 'Failed to stop existing Z-Wave inclusion window', {
            error: error.message,
            reason: options.reason || null,
            beforeState
          });
        }
      }

      if (typeof controller.stopExclusion === 'function') {
        try {
          result.stoppedExclusion = await controller.stopExclusion();
        } catch (error) {
          result.exclusionStopError = error.message;
          this.log('warn', 'zwave', 'Failed to stop existing Z-Wave exclusion window', {
            error: error.message,
            reason: options.reason || null,
            beforeState
          });
        }
      }
      result.afterState = this.getZWaveInclusionStateLabel(options.zwave);
    }

    const session = options.markSession === false ? null : this.activePairings.get('zwave');
    if (session && !isTerminalPairingStatus(session.status)) {
      session.status = 'stopped';
      session.stoppedAt = new Date().toISOString();
      session.message = options.sessionMessage || 'Previous Z-Wave pairing was stopped before starting a new request.';
      this.appendPairingEvent('zwave', {
        kind: 'stopped',
        message: session.message,
        details: {
          reason: options.reason || null,
          beforeState: result.beforeState,
          afterState: result.afterState,
          stoppedInclusion: result.stoppedInclusion,
          stoppedExclusion: result.stoppedExclusion
        }
      });
    }

    if (result.stoppedInclusion || result.stoppedExclusion || beforeState === 'Including' || beforeState === 'Excluding') {
      this.log('info', 'zwave', 'Closed existing Z-Wave inclusion/exclusion window', {
        reason: options.reason || null,
        ...result
      });
    }

    return result;
  },

getPairingBaseline(protocol) {
    if (protocol === 'zigbee') {
      const devices = this.zigbee.controller?.getDevices?.() || [];
      return devices
        .filter((device) => device?.type !== 'Coordinator')
        .map((device) => trimString(device?.ieeeAddr))
        .filter(Boolean);
    }

    if (protocol === 'zwave') {
      const nodes = this.getZWaveControllerNodes({ log: false, context: 'pairing baseline' });
      if (!nodes || typeof nodes.values !== 'function') {
        return [];
      }
      return Array.from(nodes.values())
        .filter((node) => node && !node.isControllerNode)
        .map((node) => String(node.id || '').trim())
        .filter(Boolean);
    }

    return [];
  },

createPairingSession(protocol, seconds, options = {}) {
    const now = Date.now();
    const session = {
      id: `pairing-${protocol}-${now}-${crypto.randomBytes(4).toString('hex')}`,
      protocol,
      mode: options.mode || (protocol === 'zigbee' ? 'permit_join' : 'inclusion'),
      status: 'opening',
      startedAt: new Date(now).toISOString(),
      expiresAt: now + seconds * 1000,
      baselineIdentities: this.getPairingBaseline(protocol),
      targetIdentity: trimString(options.targetIdentity) || null,
      detectedIdentity: null,
      directDeviceId: null,
      directDeviceName: null,
      pendingDsk: null,
      message: options.message || null,
      events: []
    };
    this.activePairings.set(protocol, session);
    return session;
  },

appendPairingEvent(protocol, event = {}) {
    const session = this.activePairings.get(protocol);
    if (!session) {
      return null;
    }
    const timestamp = event.timestamp || new Date().toISOString();
    session.events = [
      ...(Array.isArray(session.events) ? session.events : []).slice(-19),
      {
        ...event,
        timestamp
      }
    ];
    session.updatedAt = timestamp;
    return session;
  },

markPairingFailed(protocol, message, details = {}) {
    const session = this.activePairings.get(protocol);
    if (!session || isTerminalPairingStatus(session.status)) {
      return session || null;
    }
    const timestamp = new Date().toISOString();
    session.status = 'failed';
    session.failedAt = timestamp;
    session.message = message || `${protocol} pairing failed.`;
    this.appendPairingEvent(protocol, {
      kind: 'failed',
      message: session.message,
      details,
      timestamp
    });
    return session;
  },

markPairingActive(protocol, message) {
    const session = this.activePairings.get(protocol);
    if (!session || isTerminalPairingStatus(session.status)) {
      return session || null;
    }
    session.status = 'active';
    if (message) {
      session.message = message;
    }
    session.updatedAt = new Date().toISOString();
    return session;
  },

markPairingDetected(protocol, identity, device, reason) {
    const session = this.activePairings.get(protocol);
    if (!session || isTerminalPairingStatus(session.status)) {
      return session || null;
    }

    const identityId = trimString(identity?.id);
    if (!identityId) {
      return session;
    }

    const timestamp = new Date().toISOString();
    session.status = protocol === 'zwave' ? 'interviewing' : 'active';
    session.detectedIdentity = identity || null;
    session.directDeviceId = device?._id?.toString?.() || session.directDeviceId || null;
    session.directDeviceName = device?.name || session.directDeviceName || null;
    session.message = protocol === 'zwave'
      ? `Z-Wave node ${identityId} was detected. HomeBrain is waiting for the interview to finish before saving it as a usable device.`
      : session.message;
    this.appendPairingEvent(protocol, {
      kind: 'detected',
      reason,
      identity: identity || null,
      directDeviceId: session.directDeviceId,
      directDeviceName: session.directDeviceName,
      timestamp
    });
    return session;
  },

completePairingSession(protocol, identity, device, reason) {
    const session = this.activePairings.get(protocol);
    if (!session || isTerminalPairingStatus(session.status)) {
      return session || null;
    }

    const identityId = trimString(identity?.id);
    const strongReason = protocol === 'zwave'
      ? isZWaveDirectUpdateInterviewComplete(device, reason)
      : ['deviceJoined', 'deviceInterview'].includes(reason);
    const isNewIdentity = identityId && !session.baselineIdentities.includes(identityId);
    const isExpectedReplacement = protocol === 'zwave'
      && session.mode === 'replace_failed'
      && identityId
      && identityId === trimString(session.targetIdentity ?? session.replaceNodeId);
    if (protocol === 'zwave' && !strongReason) {
      if (isNewIdentity || isExpectedReplacement) {
        return this.markPairingDetected(protocol, identity, device, reason);
      }
      return session;
    }
    if (!strongReason && !isNewIdentity && !isExpectedReplacement) {
      return session;
    }

    const timestamp = new Date().toISOString();
    session.status = 'completed';
    session.completedAt = timestamp;
    session.detectedIdentity = identity || null;
    session.directDeviceId = device?._id?.toString?.() || null;
    session.directDeviceName = device?.name || null;
    session.message = device?.name
      ? `${device.name} joined HomeBrain.`
      : `${protocol === 'zwave' ? 'Z-Wave' : 'Zigbee'} device joined HomeBrain.`;
    this.appendPairingEvent(protocol, {
      kind: 'completed',
      reason,
      identity: identity || null,
      directDeviceId: session.directDeviceId,
      directDeviceName: session.directDeviceName,
      timestamp
    });
    this.clearPairingTimer(protocol);
    void this.stopPairing(protocol).catch((error) => {
      console.warn(`DirectRadioService: Failed to close ${protocol} pairing after completion: ${error.message}`);
    });
    return session;
  },

async reconcileActiveZWavePairingFromController() {
    const session = this.activePairings.get('zwave');
    if (!session || ['completed', 'failed', 'expired', 'stopped'].includes(session.status)) {
      return null;
    }
    if (Device.db?.readyState !== 1) {
      return null;
    }

    const nodes = this.getZWaveControllerNodes({ log: false, context: 'pairing reconciliation' });
    if (!nodes || typeof nodes.values !== 'function') {
      return null;
    }

    for (const node of nodes.values()) {
      if (!node || node.isControllerNode) {
        continue;
      }
      const identityId = String(node.id || '').trim();
      if (!identityId || session.baselineIdentities.includes(identityId)) {
        continue;
      }
      this.log('info', 'zwave', 'Z-Wave pairing detected a new controller node before interview completion', {
        nodeId: node.id || null,
        pairingId: session.id,
        securityMode: session.zwaveSecurityMode || null
      });
      this.attachZWaveNodeStatusListeners(node);
      return this.handleZWaveNodeChanged(node, node.ready === true ? 'node ready' : 'node added');
    }

    return null;
  },

armPairingTimer(protocol, sessionId, seconds) {
    this.clearPairingTimer(protocol);
    const timer = setTimeout(() => {
      const session = this.activePairings.get(protocol);
      if (session?.id === sessionId && !['completed', 'failed', 'stopped'].includes(session.status)) {
        session.status = 'expired';
        session.expiredAt = new Date().toISOString();
        const operation = protocol === 'zwave' && session.mode === 'replace_failed'
          ? 'Z-Wave failed-node replacement'
          : protocol === 'zwave'
            ? 'Z-Wave inclusion'
            : 'Zigbee pairing';
        session.message = `${operation} window expired before HomeBrain detected a completed device.`;
        this.appendPairingEvent(protocol, {
          kind: 'expired',
          message: session.message
        });
        this.log('warn', protocol, `${operation} window expired before completed device was detected`, {
          pairingId: session.id,
          mode: session.mode || null,
          startedAt: session.startedAt || null,
          expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
          baselineIdentityCount: Array.isArray(session.baselineIdentities) ? session.baselineIdentities.length : 0,
          baselineIdentities: Array.isArray(session.baselineIdentities) ? session.baselineIdentities : [],
          targetIdentity: session.targetIdentity || null,
          detectedIdentity: session.detectedIdentity || null
        });
      }
      void this.stopPairing(protocol).catch((error) => {
        console.warn(`DirectRadioService: Failed to auto-stop ${protocol} pairing: ${error.message}`);
      });
    }, seconds * 1000);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.pairingTimers[protocol] = timer;
  },

serializePairingSession(session) {
    if (!session) {
      return null;
    }
    const expiresAt = Number(session.expiresAt || 0);
    return {
      id: session.id,
      protocol: session.protocol,
      mode: session.mode,
      status: session.status,
      zwaveSecurityMode: session.zwaveSecurityMode || null,
      replaceNodeId: session.replaceNodeId || null,
      startedAt: session.startedAt || null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      secondsRemaining: expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)) : 0,
      pendingDsk: session.pendingDsk || null,
      detectedIdentity: session.detectedIdentity || null,
      directDeviceId: session.directDeviceId || null,
      directDeviceName: session.directDeviceName || null,
      message: session.message || null,
      completedAt: session.completedAt || null,
      failedAt: session.failedAt || null,
      expiredAt: session.expiredAt || null,
      events: Array.isArray(session.events) ? session.events.slice(-8) : []
    };
  },

async startPairing(protocol, options = {}) {
    await this.start();
    const seconds = boundedSeconds(options.durationSeconds);
    if (protocol === 'zigbee') {
      if (!this.zigbee.controller || !this.zigbee.started) {
        this.log('warn', 'zigbee', 'Cannot open Zigbee permit-join because the coordinator is not ready', {
          requestedSeconds: seconds,
          detectedPort: this.detected.zigbee?.path || null,
          error: this.zigbee.error || null
        });
        const error = new Error('Zigbee controller is not ready. Plug in the SONOFF ZBDongle-P or set HOMEBRAIN_ZIGBEE_PORT.');
        error.status = 503;
        throw error;
      }
      this.clearPairingTimer('zigbee');
      const session = this.createPairingSession('zigbee', seconds);
      this.log('info', 'zigbee', 'Opening Zigbee permit-join window', {
        durationSeconds: seconds,
        serialPath: this.detected.zigbee?.path || null,
        pairingId: session.id,
        baselineIdentityCount: session.baselineIdentities.length,
        baselineIdentities: session.baselineIdentities
      });
      await this.zigbee.controller.permitJoin(seconds);
      this.zigbee.permitJoinUntil = new Date(Date.now() + seconds * 1000).toISOString();
      session.status = 'active';
      session.expiresAt = Date.now() + seconds * 1000;
      session.message = 'Zigbee permit-join is open. HomeBrain will finish as soon as a device joins or interviews.';
      this.armPairingTimer('zigbee', session.id, seconds);
      this.log('info', 'zigbee', 'Zigbee permit-join window is open', {
        expiresAt: this.zigbee.permitJoinUntil,
        pairingId: session.id
      });
      return {
        protocol,
        mode: 'permit_join',
        expiresAt: this.zigbee.permitJoinUntil,
        pairing: this.serializePairingSession(session)
      };
    }

    if (protocol === 'zwave') {
      const controller = this.getZWaveController();
      if (!controller || !this.zwave.started) {
        this.log('warn', 'zwave', 'Cannot open Z-Wave inclusion because the controller is not ready', {
          requestedSeconds: seconds,
          detectedPort: this.detected.zwave?.path || null,
          error: this.zwave.error || null
        });
        const error = new Error('Z-Wave controller is not ready. Plug in the Zooz ZST39 LR stick or set HOMEBRAIN_ZWAVE_PORT.');
        error.status = 503;
        throw error;
      }
      const zwave = require('zwave-js');
      const resetResult = await this.closeZWavePairingWindow({
        zwave,
        reason: 'start_inclusion',
        sessionMessage: 'Previous Z-Wave add/remove window was stopped before starting inclusion.'
      });
      const { mode: zwaveSecurityMode, options: inclusionOptions } = this.buildZWaveInclusionOptions(
        zwave,
        options.zwaveSecurityMode ?? options.securityMode
      );
      const session = this.createPairingSession('zwave', seconds, {
        message: zwaveSecurityMode === 'insecure'
          ? 'Z-Wave standard inclusion is opening without S2 security, so no DSK PIN is required.'
          : 'Z-Wave secure inclusion is opening. HomeBrain may ask for the first 5 digits from the device DSK label.'
      });
      session.zwaveSecurityMode = zwaveSecurityMode;
      this.zwave.s2DskPin = trimString(options.dskPin);
      this.zwave.pendingDsk = null;
      this.log('info', 'zwave', 'Opening Z-Wave inclusion window', {
        durationSeconds: seconds,
        serialPath: this.detected.zwave?.path || null,
        pairingId: session.id,
        securityMode: zwaveSecurityMode,
        previousWindow: resetResult
      });
      let inclusionStarted = false;
      try {
        inclusionStarted = await controller.beginInclusion(inclusionOptions);
      } catch (error) {
        this.markPairingFailed('zwave', error.message || 'Z-Wave inclusion failed to start.');
        throw error;
      }
      if (inclusionStarted !== true) {
        await this.closeZWavePairingWindow({
          zwave,
          reason: 'retry_inclusion_after_busy',
          markSession: false,
          sessionMessage: 'HomeBrain reset the Z-Wave controller after the first inclusion start did not open.'
        });
        await delay(350);
        try {
          inclusionStarted = await controller.beginInclusion(inclusionOptions);
        } catch (error) {
          this.markPairingFailed('zwave', error.message || 'Z-Wave inclusion failed to start.');
          throw error;
        }
      }
      if (inclusionStarted !== true) {
        const state = this.getZWaveInclusionStateLabel(zwave);
        const message = state
          ? `Z-Wave inclusion did not start because the controller is still ${state}. HomeBrain reset the stale window, but the controller did not accept the new inclusion request.`
          : 'Z-Wave inclusion did not start because the controller reported it was already busy after HomeBrain reset the stale window.';
        this.markPairingFailed('zwave', message, {
          state,
          previousWindow: resetResult
        });
        this.zwave.inclusionUntil = null;
        const error = new Error(message);
        error.status = 409;
        error.code = 'ZWAVE_INCLUSION_NOT_STARTED';
        throw error;
      }
      this.zwave.inclusionUntil = new Date(Date.now() + seconds * 1000).toISOString();
      session.status = 'active';
      session.expiresAt = Date.now() + seconds * 1000;
      session.message = zwaveSecurityMode === 'insecure'
        ? 'Z-Wave standard inclusion is open. No DSK PIN is required; HomeBrain will finish as soon as the controller reports the new node.'
        : 'Z-Wave secure inclusion is open. If prompted, enter the first 5 digits printed on the device DSK label or QR code.';
      this.armPairingTimer('zwave', session.id, seconds);
      this.log('info', 'zwave', 'Z-Wave inclusion window is open', {
        expiresAt: this.zwave.inclusionUntil,
        pairingId: session.id,
        securityMode: zwaveSecurityMode
      });
      return {
        protocol,
        mode: 'inclusion',
        expiresAt: this.zwave.inclusionUntil,
        pairing: this.serializePairingSession(session)
      };
    }

    const error = new Error('Protocol must be zigbee or zwave');
    error.status = 400;
    throw error;
  },

async stopPairing(protocol = 'all') {
    if ((protocol === 'zigbee' || protocol === 'all') && this.zigbee.controller && this.zigbee.started) {
      this.clearPairingTimer('zigbee');
      await this.zigbee.controller.permitJoin(0);
      this.zigbee.permitJoinUntil = null;
      const session = this.activePairings.get('zigbee');
      if (session && !['completed', 'failed', 'expired'].includes(session.status)) {
        session.status = 'stopped';
        session.stoppedAt = new Date().toISOString();
        session.message = session.message || 'Zigbee pairing was stopped.';
      }
      this.log('info', 'zigbee', 'Zigbee permit-join window closed', {
        pairingId: session?.id || null,
        sessionStatus: session?.status || null,
        detectedIdentity: session?.detectedIdentity || null,
        baselineIdentityCount: Array.isArray(session?.baselineIdentities) ? session.baselineIdentities.length : 0
      });
    }

    if ((protocol === 'zwave' || protocol === 'all') && this.getZWaveController()) {
      await this.closeZWavePairingWindow({
        reason: 'stop_pairing',
        sessionMessage: 'Z-Wave pairing was stopped.'
      });
      this.log('info', 'zwave', 'Z-Wave inclusion/exclusion windows closed');
    }

    return this.getStatus();
  }
};

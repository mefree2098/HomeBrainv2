'use strict';

// DirectRadioService Zwave methods (mixed onto the prototype). Extracted from
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

const ZWAVE_NODE_ROUTE_RECOVERY_COOLDOWN_MS = 2 * 60 * 1000;
const ZWAVE_NODE_ROUTE_RECOVERY_TIMEOUT_MS = 45 * 1000;
const ZWAVE_NODE_ROUTE_RECOVERY_PING_TIMEOUT_MS = 10 * 1000;
const ZWAVE_JS_LOG_TAIL_MAX_BYTES = 4 * 1024 * 1024;

function normalizeOptionalMilliseconds(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function isZWaveCommandDeliveryError(error) {
  const text = [
    error?.code,
    error?.name,
    error?.message,
    error?.stack
  ].filter(Boolean).join(' ').toLowerCase();
  return text.includes('zw0204')
    || text.includes('did not acknowledge')
    || text.includes('not acknowledged')
    || text.includes('no ack')
    || text.includes('no_ack')
    || text.includes('transmission failed');
}

function normalizeZWaveJsLogLevel(value, fallback = 'debug') {
  const normalized = trimString(value).toLowerCase();
  return ['debug', 'info', 'warn', 'error'].includes(normalized) ? normalized : fallback;
}

function parseBoundedInteger(value, fallback, min, max) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}

function serializeMaybeKnown(value, enumObject = null) {
  if (value && typeof value === 'object' && value.error) {
    return {
      known: false,
      value: null,
      label: 'error',
      error: value.error
    };
  }
  if (value === undefined) {
    return {
      known: false,
      value: null,
      label: 'unknown'
    };
  }
  return {
    known: true,
    value,
    label: enumObject ? enumMemberName(enumObject, value) : String(value)
  };
}

function getZWaveCore() {
  try {
    return require('@zwave-js/core');
  } catch (_error) {
    return {};
  }
}

function getZWaveSecurityClassEntries(core = getZWaveCore()) {
  const securityClass = core.SecurityClass || {};
  return [
    ['S2_AccessControl', securityClass.S2_AccessControl],
    ['S2_Authenticated', securityClass.S2_Authenticated],
    ['S2_Unauthenticated', securityClass.S2_Unauthenticated],
    ['S0_Legacy', securityClass.S0_Legacy]
  ].filter(([, value]) => value !== undefined);
}

function extractZWavePinFromDsk(dsk) {
  const safeDsk = trimString(dsk);
  const match = safeDsk.match(/^(\d{5})(?:-\d{5}){7}$/);
  return match ? match[1] : '';
}

function zWaveDskMatchesChallenge(fullDsk, challengeDsk) {
  const fullDigits = trimString(fullDsk).replace(/\D/g, '');
  const challengeDigits = trimString(challengeDsk).replace(/\D/g, '');
  if (fullDigits.length !== 40 || challengeDigits.length < 35) {
    return false;
  }
  return fullDigits.endsWith(challengeDigits);
}

async function normalizeZWaveDskCredential(value) {
  const raw = trimString(value);
  if (!raw) {
    return {
      pin: '',
      dsk: '',
      source: null,
      parsedQr: null
    };
  }

  const core = getZWaveCore();
  const digitsOnly = raw.replace(/\D/g, '');
  if (/^\d{5}$/.test(digitsOnly) && digitsOnly.length === 5) {
    return {
      pin: digitsOnly,
      dsk: '',
      source: 'pin',
      parsedQr: null
    };
  }

  const unformattedDsk = digitsOnly.length === 40
    ? digitsOnly.match(/.{1,5}/g).join('-')
    : '';
  const tryParseDsk = typeof core.tryParseDSKFromQRCodeString === 'function'
    ? trimString(core.tryParseDSKFromQRCodeString(raw))
    : '';
  const directDsk = unformattedDsk
    || tryParseDsk
    || (typeof core.isValidDSK === 'function' && core.isValidDSK(raw) ? raw : '');
  if (directDsk) {
    return {
      pin: extractZWavePinFromDsk(directDsk),
      dsk: directDsk,
      source: 'dsk',
      parsedQr: null
    };
  }

  if (typeof core.parseQRCodeString === 'function') {
    try {
      const parsedQr = await core.parseQRCodeString(raw);
      const qrDsk = trimString(parsedQr?.dsk);
      if (qrDsk) {
        return {
          pin: extractZWavePinFromDsk(qrDsk),
          dsk: qrDsk,
          source: 'qr',
          parsedQr: {
            manufacturerId: parsedQr.manufacturerId ?? null,
            productType: parsedQr.productType ?? null,
            productId: parsedQr.productId ?? null,
            supportedProtocols: Array.isArray(parsedQr.supportedProtocols)
              ? parsedQr.supportedProtocols.slice()
              : null,
            requestedSecurityClasses: Array.isArray(parsedQr.requestedSecurityClasses)
              ? parsedQr.requestedSecurityClasses.slice()
              : null
          }
        };
      }
    } catch (error) {
      // Fall through to the validation error below.
    }
  }

  const error = new Error('Enter the 5 digit DSK PIN, a full Z-Wave DSK, or the raw Z-Wave QR code payload.');
  error.status = 400;
  throw error;
}

function serializeZWaveJsLogConfig(config = null) {
  if (!config || typeof config !== 'object') {
    return null;
  }
  return {
    enabled: config.enabled === true,
    level: trimString(config.level) || null,
    logToFile: config.logToFile === true,
    filename: trimString(config.filename) || null,
    maxFiles: Number.isFinite(Number(config.maxFiles)) ? Number(config.maxFiles) : null,
    raw: config.raw === true,
    forceConsole: config.forceConsole === true,
    nodeFilter: Array.isArray(config.nodeFilter) ? config.nodeFilter.slice(0, 200) : null
  };
}

function readZWaveSecurityClass(source, securityClass, nodeId = null) {
  try {
    if (typeof source?.hasSecurityClass === 'function') {
      if (nodeId !== null && nodeId !== undefined) {
        return source.hasSecurityClass(nodeId, securityClass);
      }
      return source.hasSecurityClass(securityClass);
    }
  } catch (error) {
    return {
      error: error.message || String(error)
    };
  }
  return undefined;
}

function readZWaveHighestSecurityClass(source, nodeId = null) {
  try {
    if (nodeId !== null && nodeId !== undefined && typeof source?.getHighestSecurityClass === 'function') {
      return source.getHighestSecurityClass(nodeId);
    }
    if (typeof source?.getHighestSecurityClass === 'function') {
      return source.getHighestSecurityClass();
    }
  } catch (error) {
    return {
      error: error.message || String(error)
    };
  }
  return undefined;
}

async function readTextTail(filePath, maxBytes = ZWAVE_JS_LOG_TAIL_MAX_BYTES) {
  const stats = await fsp.stat(filePath);
  const start = Math.max(0, stats.size - maxBytes);
  const length = Math.max(0, stats.size - start);
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function resolveZWaveJsLogFile() {
  const candidates = [];
  try {
    const stats = await fsp.stat(ZWAVE_JS_LOG_CURRENT_FILENAME);
    if (stats.isFile() || stats.isSymbolicLink?.()) {
      candidates.push({
        file: ZWAVE_JS_LOG_CURRENT_FILENAME,
        mtimeMs: stats.mtimeMs || 0
      });
    }
  } catch (_error) {
    // Fall through to dated log discovery.
  }

  try {
    const entries = await fsp.readdir(ZWAVE_JS_LOG_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^zwavejs_.*\.log$/.test(entry.name)) {
        continue;
      }
      const file = path.join(ZWAVE_JS_LOG_DIR, entry.name);
      try {
        const stats = await fsp.stat(file);
        candidates.push({ file, mtimeMs: stats.mtimeMs || 0 });
      } catch (_error) {
        // Ignore files that disappeared between readdir and stat.
      }
    }
  } catch (_error) {
    // Missing log directory means logging has not been initialized yet.
  }

  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((entry) => entry.file)[0] || null;
}
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
  isZWaveNodeCommandProbeCandidate,
  getEffectiveZWaveNodeRuntime,
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
  hasZWaveUserCodeSupport,
  getZWaveLockCodeCapabilities,
  codeNameForSlot,
  lockEventActionFromLabel,
  extractLockUserId,
  serializeLockCodeSlot,
  serializeDoorLockLogRecord
} = require('./directRadioHelpers');

const ZWAVE_JS_LOG_DIR = path.join(ZWAVE_DIR, 'logs');
const ZWAVE_JS_LOG_FILENAME = path.join(ZWAVE_JS_LOG_DIR, 'zwavejs_%DATE%.log');
const ZWAVE_JS_LOG_CURRENT_FILENAME = path.join(ZWAVE_JS_LOG_DIR, 'zwavejs_current.log');

module.exports = {
  async normalizeZWaveDskCredential(value) {
    return normalizeZWaveDskCredential(value);
  },

  buildZWaveJsLogConfig() {
    ensureDirSync(ZWAVE_JS_LOG_DIR);
    const enabled = parseEnabledFlag(process.env.HOMEBRAIN_ZWAVE_JS_LOG_ENABLED, true);
    const logToFile = parseEnabledFlag(process.env.HOMEBRAIN_ZWAVE_JS_LOG_TO_FILE, true);
    const raw = parseEnabledFlag(process.env.HOMEBRAIN_ZWAVE_JS_LOG_RAW, false);
    const maxFiles = parseBoundedInteger(process.env.HOMEBRAIN_ZWAVE_JS_LOG_MAX_FILES, 14, 1, 365);
    return {
      enabled,
      logToFile,
      filename: trimString(process.env.HOMEBRAIN_ZWAVE_JS_LOG_FILE) || ZWAVE_JS_LOG_FILENAME,
      level: normalizeZWaveJsLogLevel(process.env.HOMEBRAIN_ZWAVE_JS_LOG_LEVEL, 'debug'),
      maxFiles,
      raw,
      forceConsole: parseEnabledFlag(process.env.HOMEBRAIN_ZWAVE_JS_LOG_FORCE_CONSOLE, false)
    };
  },

async getZWaveJsLogTail(options = {}) {
    const limit = parseBoundedInteger(options.limit, 400, 1, 5000);
    const nodeId = getNumericNodeId(options.nodeId);
    const file = await resolveZWaveJsLogFile();
    if (!file) {
      return {
        file: null,
        lines: [],
        count: 0,
        message: 'No zwave-js log file is available yet.'
      };
    }

    const text = await readTextTail(file, ZWAVE_JS_LOG_TAIL_MAX_BYTES);
    const nodePattern = Number.isInteger(nodeId)
      ? new RegExp(`(?:\\[Node\\s*0*${nodeId}\\]|\\bnode\\s+0*${nodeId}\\b|\\bNode\\s+0*${nodeId}\\b)`)
      : null;
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .filter((line) => !nodePattern || nodePattern.test(line))
      .slice(-limit);
    return {
      file,
      nodeId: Number.isInteger(nodeId) ? nodeId : null,
      lines,
      count: lines.length
    };
  },

getZWaveInclusionStateLabel(zwave = null) {
    const controller = this.getZWaveController();
    const state = controller?.inclusionState;
    if (state === undefined || state === null) {
      return null;
    }

    let zwaveModule = zwave;
    if (!zwaveModule) {
      try {
        zwaveModule = require('zwave-js');
      } catch (_error) {
        zwaveModule = null;
      }
    }
    return enumMemberName(zwaveModule?.InclusionState, state);
  },

async startZWave(serialPath) {
    try {
      this.log('info', 'zwave', 'Starting Z-Wave controller', {
        serialPath
      });
      const zwave = require('zwave-js');
      const config = await this.ensureControllerConfig();
      const keyBuffer = (hex) => Buffer.from(hex, 'hex');
      const cacheThrottle = process.env.HOMEBRAIN_ZWAVE_CACHE_THROTTLE || 'fast';
      const logConfig = this.buildZWaveJsLogConfig();
      const driver = new zwave.Driver(serialPath, {
        storage: {
          cacheDir: path.join(ZWAVE_DIR, 'cache'),
          lockDir: path.join(ZWAVE_DIR, 'locks'),
          throttle: cacheThrottle
        },
        securityKeys: {
          S2_AccessControl: keyBuffer(config.zwave.securityKeys.S2_AccessControl),
          S2_Authenticated: keyBuffer(config.zwave.securityKeys.S2_Authenticated),
          S2_Unauthenticated: keyBuffer(config.zwave.securityKeys.S2_Unauthenticated),
          S0_Legacy: keyBuffer(config.zwave.securityKeys.S0_Legacy)
        },
        securityKeysLongRange: {
          S2_AccessControl: keyBuffer(config.zwave.securityKeysLongRange.S2_AccessControl),
          S2_Authenticated: keyBuffer(config.zwave.securityKeysLongRange.S2_Authenticated)
        },
        logConfig,
        inclusionUserCallbacks: this.buildZWaveInclusionCallbacks(zwave)
      });

      driver.on('driver ready', () => {
        this.zwave.started = true;
        this.zwave.error = null;
        this.attachZWaveMigrationRequestHandlers(driver, zwave);
        this.attachZWaveControllerMigrationListeners(driver.controller);
        this.log('info', 'zwave', 'Z-Wave driver ready', {
          serialPath,
          homeId: driver.controller?.homeId || null,
          cacheThrottle,
          zwaveJsLog: {
            enabled: logConfig.enabled === true,
            logToFile: logConfig.logToFile === true,
            filename: logConfig.filename,
            level: logConfig.level,
            raw: logConfig.raw === true
          }
        });
        this.dispatchHandler('zwave:syncNodes', 'zwave', () => this.syncZWaveNodes());
      });
      driver.on('all nodes ready', () => {
        const nodeHealth = typeof this.summarizeZWaveNodeHealth === 'function'
          ? this.summarizeZWaveNodeHealth()
          : {};
        this.log(nodeHealth.degraded ? 'warn' : 'info', 'zwave', nodeHealth.degraded
          ? 'Z-Wave driver reported all nodes ready with degraded nodes'
          : 'Z-Wave driver reported all nodes ready', {
          nodeCount: driver.controller?.nodes?.size ?? null,
          nodeHealth
        });
        this.dispatchHandler('zwave:syncNodes', 'zwave', () => this.syncZWaveNodes());
      });
      driver.on('node added', (node) => {
        this.log('info', 'zwave', 'Z-Wave node added', {
          nodeId: node?.id || null
        });
        this.attachZWaveNodeStatusListeners(node);
        this.dispatchHandler('zwave:node added', 'zwave', () => this.handleZWaveNodeChanged(node, 'node added'), { nodeId: node?.id || null });
      });
      driver.on('node removed', (node, reason) => {
        this.log('info', 'zwave', 'Z-Wave node removed', {
          nodeId: node?.id || null,
          reason: reason === undefined ? null : String(reason)
        });
        this.recordZWaveNodeRemoved(node, reason);
      });
      driver.on('node ready', (node) => {
        this.log('info', 'zwave', 'Z-Wave node ready', {
          nodeId: node?.id || null,
          manufacturer: node?.manufacturer || null,
          productLabel: node?.productLabel || null
        });
        this.attachZWaveNodeStatusListeners(node);
        this.dispatchHandler('zwave:node ready', 'zwave', () => this.handleZWaveNodeChanged(node, 'node ready'), { nodeId: node?.id || null });
      });
      driver.on('node value updated', (node) => {
        this.log('info', 'zwave', 'Z-Wave node value updated', {
          nodeId: node?.id || null
        });
        this.attachZWaveNodeStatusListeners(node);
        this.dispatchHandler('zwave:node value updated', 'zwave', () => this.handleZWaveNodeChanged(node, 'node value updated'), { nodeId: node?.id || null });
      });
      driver.on('error', (error) => {
        this.zwave.error = error.message;
        this.log('error', 'zwave', 'Z-Wave driver error', {
          serialPath,
          error: error.message
        });
      });

      this.zwave.driver = driver;
      await driver.start();
      this.zwave.started = true;
      this.zwave.error = null;
      this.log('info', 'zwave', 'Z-Wave controller started', {
        serialPath
      });
    } catch (error) {
      this.zwave.started = false;
      this.zwave.error = error.message;
      this.log('error', 'zwave', 'Z-Wave controller failed to start', {
        serialPath,
        error: error.message
      });
      console.warn(`DirectRadioService: Z-Wave controller failed to start: ${error.message}`);
    }
  },

buildZWaveInclusionCallbacks(zwave) {
    const core = getZWaveCore();
    const fallbackSecurityClasses = getZWaveSecurityClassEntries(core).map(([, value]) => value);
    return {
      grantSecurityClasses: async (requested) => ({
        securityClasses: Array.isArray(requested?.securityClasses)
          ? requested.securityClasses
          : fallbackSecurityClasses,
        clientSideAuth: false
      }),
      validateDSKAndEnterPIN: async (dsk) => {
        this.zwave.pendingDsk = dsk;
        let configuredCredential = { pin: '', dsk: '', source: null, parsedQr: null };
        const configuredInput = this.zwave.s2Dsk || this.zwave.s2DskPin || process.env.HOMEBRAIN_ZWAVE_S2_DSK_PIN;
        try {
          configuredCredential = await normalizeZWaveDskCredential(configuredInput);
        } catch (error) {
          this.log('warn', 'zwave', 'Ignoring invalid preloaded Z-Wave S2 DSK credential', {
            error: error.message
          });
        }
        const configuredPin = configuredCredential.dsk
          ? (zWaveDskMatchesChallenge(configuredCredential.dsk, dsk) ? configuredCredential.pin : '')
          : configuredCredential.pin;
        if (/^\d{5}$/.test(configuredPin)) {
          this.zwave.pendingDsk = null;
          this.log('info', 'zwave', 'Z-Wave S2 DSK PIN supplied before bootstrap', {
            credentialSource: configuredCredential.source || 'unknown',
            hasFullDsk: Boolean(configuredCredential.dsk),
            challengeMatched: configuredCredential.dsk ? zWaveDskMatchesChallenge(configuredCredential.dsk, dsk) : null
          });
          return configuredPin;
        }
        this.log('warn', 'zwave', 'Z-Wave S2 DSK PIN required', {
          hasDskChallenge: Boolean(dsk)
        });
        this.markZWaveDskRequired(dsk);
        console.warn(`DirectRadioService: Z-Wave S2 DSK PIN required for ${dsk}`);
        const submittedPin = await this.waitForZWaveDskPin(dsk);
        if (/^\d{5}$/.test(submittedPin)) {
          this.zwave.pendingDsk = null;
          this.log('info', 'zwave', 'Z-Wave S2 DSK PIN submitted for active inclusion', {
            dsk
          });
          return submittedPin;
        }
        this.markPairingFailed('zwave', 'Z-Wave S2 pairing timed out waiting for the 5 digit DSK PIN.', {
          dsk
        });
        return false;
      },
      abort: () => {
        this.zwave.pendingDsk = null;
        this.resolvePendingZWaveDsk(false);
        this.markPairingFailed('zwave', 'Z-Wave inclusion was aborted before security completed.');
        this.log('warn', 'zwave', 'Z-Wave inclusion user callback aborted');
      }
    };
  },

buildZWaveInclusionOptions(zwave, securityMode) {
    const mode = normalizeZWaveSecurityMode(securityMode, 'insecure');
    switch (mode) {
      case 's2':
        return {
          mode,
          options: { strategy: zwave.InclusionStrategy.Security_S2 }
        };
      case 's0':
        return {
          mode,
          options: { strategy: zwave.InclusionStrategy.Security_S0 }
        };
      case 'default':
        return {
          mode,
          options: { strategy: zwave.InclusionStrategy.Default, forceSecurity: true }
        };
      case 'insecure':
      default:
        return {
          mode: 'insecure',
          options: { strategy: zwave.InclusionStrategy.Insecure }
        };
    }
  },

buildZWaveReplacementOptions(zwave, securityMode) {
    const requestedMode = normalizeZWaveSecurityMode(securityMode, 's0');
    const mode = requestedMode === 'default' ? 's0' : requestedMode;
    switch (mode) {
      case 's2':
        return {
          mode,
          options: { strategy: zwave.InclusionStrategy.Security_S2 }
        };
      case 'insecure':
        return {
          mode,
          options: { strategy: zwave.InclusionStrategy.Insecure }
        };
      case 's0':
      default:
        return {
          mode: 's0',
          options: { strategy: zwave.InclusionStrategy.Security_S0 }
        };
    }
  },

markZWaveDskRequired(dsk) {
    const session = this.activePairings.get('zwave');
    if (!session || isTerminalPairingStatus(session.status)) {
      return null;
    }
    session.status = 'awaiting_dsk';
    session.pendingDsk = dsk;
    session.message = 'Z-Wave S2 security requires the first 5 digits from the device DSK label or QR code. If you do not have that label, stop this attempt, exclude/reset the partial node, and retry with Standard/no PIN inclusion.';
    this.appendPairingEvent('zwave', {
      kind: 'dsk_required',
      dsk,
      message: session.message
    });
    return session;
  },

waitForZWaveDskPin(dsk) {
    this.resolvePendingZWaveDsk(false);
    const session = this.activePairings.get('zwave');
    const expiresAt = Number(session?.expiresAt || 0);
    const timeoutMs = Math.max(10_000, Math.min(120_000, expiresAt > Date.now() ? expiresAt - Date.now() : 90_000));

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.resolvePendingZWaveDsk(false);
      }, timeoutMs);
      if (typeof timeout.unref === 'function') {
        timeout.unref();
      }
      this.zwave.pendingDskRequest = {
        dsk,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
        timeout,
        resolve
      };
    });
  },

resolvePendingZWaveDsk(value) {
    const pending = this.zwave.pendingDskRequest;
    if (!pending) {
      return false;
    }
    this.zwave.pendingDskRequest = null;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    pending.resolve(value);
    return true;
  },

submitZWaveDskPin(pin) {
    const safePin = trimString(pin);
    if (!/^\d{5}$/.test(safePin)) {
      const error = new Error('Enter the 5 digit DSK PIN printed on the Z-Wave device label or QR code.');
      error.status = 400;
      throw error;
    }

    const hadPendingRequest = this.resolvePendingZWaveDsk(safePin);
    this.zwave.s2DskPin = safePin;
    this.zwave.s2Dsk = '';
    this.zwave.pendingDsk = null;
    this.markPairingActive('zwave', hadPendingRequest
      ? 'Z-Wave S2 PIN submitted. Keep the switch powered while HomeBrain finishes the interview.'
      : 'Z-Wave S2 PIN saved for the active inclusion attempt.');
    this.appendPairingEvent('zwave', {
      kind: 'dsk_pin_submitted',
      pendingRequest: hadPendingRequest
    });

    return {
      accepted: true,
      pendingRequest: hadPendingRequest,
      pairing: this.serializePairingSession(this.activePairings.get('zwave'))
    };
  },

hasStableZWaveDeviceProbeIdentity(device) {
    const direct = device?.properties?.homebrainDirect && typeof device.properties.homebrainDirect === 'object'
      ? device.properties.homebrainDirect
      : {};
    const features = Array.isArray(device?.properties?.directRadioFeatures)
      ? device.properties.directRadioFeatures.map(normalizeFeature).filter(Boolean)
      : [];
    return Boolean(
      direct.manufacturerId
      || direct.productType
      || direct.productId
      || direct.catalog
      || device?.properties?.directRadioCatalog
      || features.length > 0
    );
  },

isZWaveKnownDeviceProbeCandidate(node, device) {
    if (!node || node.isControllerNode === true || !device) {
      return false;
    }
    const nodeId = Number(node.id);
    const deviceNodeId = Number(device?.properties?.homebrainDirect?.nodeId);
    if (!Number.isFinite(nodeId) || !Number.isFinite(deviceNodeId) || nodeId !== deviceNodeId) {
      return false;
    }
    const listening = node.isListening === true
      || node.isFrequentListening === true
      || (typeof node.isFrequentListening === 'string' && trimString(node.isFrequentListening));
    if (!listening) {
      return false;
    }
    return this.hasStableZWaveDeviceProbeIdentity(device);
  },

markZWaveNodeReachability(node, result = {}) {
    if (!node) {
      return null;
    }
    const probe = {
      ok: result.ok === true,
      at: Date.now(),
      reason: trimString(result.reason) || null,
      source: trimString(result.source) || null,
      error: trimString(result.error) || null,
      knownDeviceIdentity: result.knownDeviceIdentity === true
    };
    node.__homebrainReachabilityProbe = probe;
    return probe;
  },

getZWaveNodeRouteRecoveryMap() {
    if (!this.zwave || typeof this.zwave !== 'object') {
      this.zwave = {};
    }
    if (!(this.zwave.nodeRouteRecoveries instanceof Map)) {
      this.zwave.nodeRouteRecoveries = new Map();
    }
    return this.zwave.nodeRouteRecoveries;
  },

isZWaveAutoRouteRecoveryCandidate(node) {
    return isZWaveNodeCommandProbeCandidate(node);
  },

async persistZWaveNodeRecoveryResult(node, reason, logMessage) {
    try {
      await this.handleZWaveNodeChanged(node, reason);
    } catch (error) {
      this.log('warn', 'zwave', logMessage || 'Failed to save Z-Wave node after route recovery', {
        nodeId: node?.id || null,
        reason,
        error: error.message
      });
    }
  },

async runZWaveNodeRouteRecovery({ controller, node, nodeId, device, reason, force, pingTimeoutMs, routeRebuildTimeoutMs }) {
    const before = this.serializeZWaveNodeSummary(node);
    const knownDeviceIdentity = this.isZWaveKnownDeviceProbeCandidate(node, device);
    const controllerCandidate = this.isZWaveAutoRouteRecoveryCandidate(node);
    if (!force && !knownDeviceIdentity && !controllerCandidate) {
      const error = new Error(`Z-Wave node ${nodeId} is not a safe route-recovery candidate`);
      error.status = 409;
      error.code = 'ZWAVE_ROUTE_RECOVERY_NOT_CANDIDATE';
      throw error;
    }

    if (isZWaveNodeCommandReady(node)) {
      await this.persistZWaveNodeRecoveryResult(node, 'route recovery skipped: already ready');
      return {
        nodeId,
        recovered: true,
        skipped: true,
        reason: 'already_ready',
        before,
        node: this.serializeZWaveNodeSummary(node),
        message: `Z-Wave node ${nodeId} is already command-ready.`
      };
    }

    this.log('warn', 'zwave', 'Starting bounded Z-Wave node route recovery', {
      nodeId,
      reason,
      force,
      knownDeviceIdentity,
      controllerCandidate,
      ready: node.ready === undefined ? null : Boolean(node.ready),
      status: node.status === undefined ? null : node.status,
      interviewStage: node.interviewStage === undefined ? null : String(node.interviewStage)
    });

    const pingBefore = await this.probeZWaveNodeCommandReadiness(node, {
      reason: `${reason}: ping before route rebuild`,
      device,
      timeoutMs: pingTimeoutMs
    });
    if (pingBefore.ready === true && isZWaveNodeCommandReady(node)) {
      await this.persistZWaveNodeRecoveryResult(node, 'route recovery ping recovered');
      return {
        nodeId,
        recovered: true,
        routeRebuilt: false,
        pingBefore,
        before,
        node: this.serializeZWaveNodeSummary(node),
        message: `Z-Wave node ${nodeId} answered a recovery ping.`
      };
    }

    if (typeof controller?.rebuildNodeRoutes !== 'function') {
      const error = new Error('This Z-Wave controller does not support node route rebuilding');
      error.status = 501;
      throw error;
    }

    let routeRebuilt = false;
    let routeRebuildError = null;
    try {
      routeRebuilt = await withTimeout(
        controller.rebuildNodeRoutes(nodeId),
        routeRebuildTimeoutMs,
        `Z-Wave node ${nodeId} route rebuild timed out after ${routeRebuildTimeoutMs}ms`
      );
    } catch (error) {
      routeRebuilt = false;
      routeRebuildError = error.message || String(error);
    }

    this.log(routeRebuilt ? 'info' : 'warn', 'zwave', 'Z-Wave node route rebuild finished', {
      nodeId,
      reason,
      routeRebuilt,
      routeRebuildError
    });

    const pingAfter = await this.probeZWaveNodeCommandReadiness(node, {
      reason: `${reason}: ping after route rebuild`,
      device,
      timeoutMs: pingTimeoutMs
    });
    const recovered = pingAfter.ready === true && isZWaveNodeCommandReady(node);
    await this.persistZWaveNodeRecoveryResult(
      node,
      recovered ? 'route recovery ping recovered' : 'route recovery failed',
      recovered
        ? 'Failed to save Z-Wave node after route recovery'
        : 'Failed to save Z-Wave node after failed route recovery'
    );

    return {
      nodeId,
      recovered,
      routeRebuilt,
      routeRebuildError,
      pingBefore,
      pingAfter,
      before,
      node: this.serializeZWaveNodeSummary(node),
      message: recovered
        ? `Z-Wave node ${nodeId} answered after route recovery.`
        : `Z-Wave node ${nodeId} still did not answer after route recovery.`
    };
  },

async recoverZWaveNodeRoutes(nodeId, options = {}) {
    await this.start();
    const { controller, node } = this.getZWaveNode(nodeId);
    this.attachZWaveNodeStatusListeners(node);
    const numericNodeId = Number(node.id);
    const reason = trimString(options.reason) || 'route recovery requested';
    const force = parseOptionalBoolean(options.force, false);
    const automatic = parseOptionalBoolean(options.automatic ?? options.auto, false);
    const pingTimeoutMs = normalizeOptionalMilliseconds(
      options.pingTimeoutMs,
      ZWAVE_NODE_ROUTE_RECOVERY_PING_TIMEOUT_MS,
      1000,
      15000
    );
    const routeRebuildTimeoutMs = normalizeOptionalMilliseconds(
      options.routeRebuildTimeoutMs,
      ZWAVE_NODE_ROUTE_RECOVERY_TIMEOUT_MS,
      5000,
      90000
    );
    const cooldownMs = normalizeOptionalMilliseconds(
      options.cooldownMs,
      automatic ? ZWAVE_NODE_ROUTE_RECOVERY_COOLDOWN_MS : 0,
      0,
      10 * 60 * 1000
    );
    const recoveryMap = this.getZWaveNodeRouteRecoveryMap();
    const existing = recoveryMap.get(numericNodeId);
    if (existing?.promise) {
      const result = await existing.promise;
      return {
        ...result,
        coalesced: true
      };
    }
    if (automatic && cooldownMs > 0 && existing?.finishedAt && Date.now() - existing.finishedAt < cooldownMs) {
      return {
        nodeId: numericNodeId,
        recovered: existing.lastResult?.recovered === true,
        skipped: true,
        reason: 'cooldown',
        lastResult: existing.lastResult || null,
        node: this.serializeZWaveNodeSummary(node),
        message: `Z-Wave node ${numericNodeId} route recovery was recently attempted.`
      };
    }

    const device = options.device || await this.findDeviceForZWaveNode(node).catch((error) => {
      this.log('warn', 'zwave', 'Unable to load HomeBrain device before Z-Wave route recovery', {
        nodeId: numericNodeId,
        error: error.message
      });
      return null;
    });
    const promise = this.runZWaveNodeRouteRecovery({
      controller,
      node,
      nodeId: numericNodeId,
      device,
      reason,
      force,
      pingTimeoutMs,
      routeRebuildTimeoutMs
    });

    recoveryMap.set(numericNodeId, {
      startedAt: Date.now(),
      promise
    });
    try {
      const result = await promise;
      recoveryMap.set(numericNodeId, {
        finishedAt: Date.now(),
        lastResult: result
      });
      return result;
    } catch (error) {
      recoveryMap.set(numericNodeId, {
        finishedAt: Date.now(),
        lastError: error.message || String(error)
      });
      throw error;
    }
  },

scheduleZWaveNodeRouteRecovery(node, reason, options = {}) {
    const nodeId = getNumericNodeId(node);
    if (!Number.isInteger(nodeId) || nodeId <= 0 || node?.isControllerNode === true) {
      return false;
    }
    if (!this.isZWaveAutoRouteRecoveryCandidate(node)) {
      return false;
    }
    const recoveryMap = this.getZWaveNodeRouteRecoveryMap();
    const existing = recoveryMap.get(nodeId);
    if (existing?.promise || existing?.scheduledAt) {
      return false;
    }
    recoveryMap.set(nodeId, {
      scheduledAt: Date.now()
    });
    const delayMs = normalizeOptionalMilliseconds(options.delayMs, 1000, 0, 30000);
    void (async () => {
      if (delayMs > 0) {
        await delay(delayMs);
      }
      try {
        await this.recoverZWaveNodeRoutes(nodeId, {
          reason,
          automatic: true,
          cooldownMs: options.cooldownMs
        });
      } catch (error) {
        this.log('warn', 'zwave', 'Automatic Z-Wave node route recovery failed', {
          nodeId,
          reason,
          error: error.message
        });
      }
    })();
    return true;
  },

async probeZWaveNodeCommandReadiness(node, context = {}) {
    if (isZWaveNodeCommandReady(node)) {
      return {
        ready: true,
        skipped: true,
        reason: 'already_ready'
      };
    }
    const knownDeviceIdentity = this.isZWaveKnownDeviceProbeCandidate(node, context.device);
    if (!isZWaveNodeCommandProbeCandidate(node) && !knownDeviceIdentity) {
      return {
        ready: false,
        skipped: true,
        reason: 'not_probe_candidate'
      };
    }

    const nodeId = Number(node.id);
    const reason = trimString(context.reason) || 'command readiness probe';
    const timeoutMs = Math.max(1000, Math.min(10000, Number(context.timeoutMs) || 5000));
    let ping = null;
    let pingError = null;

    this.log('info', 'zwave', 'Probing interviewed listening Z-Wave node before declaring it not ready', {
      nodeId: Number.isFinite(nodeId) ? nodeId : null,
      reason,
      action: trimString(context.action) || null,
      knownDeviceIdentity,
      ready: node.ready === undefined ? null : Boolean(node.ready),
      status: node.status === undefined ? null : node.status,
      interviewStage: node.interviewStage === undefined ? null : String(node.interviewStage)
    });

    if (typeof node.ping === 'function') {
      try {
        ping = await Promise.race([
          node.ping(true),
          delay(timeoutMs).then(() => {
            throw new Error(`Z-Wave ping timed out after ${timeoutMs}ms`);
          })
        ]);
      } catch (error) {
        ping = false;
        pingError = error?.message || String(error);
      }
    } else {
      ping = false;
      pingError = 'Node does not expose ping()';
    }

    if (ping === true) {
      const probe = this.markZWaveNodeReachability(node, {
        ok: true,
        reason,
        source: 'ping',
        knownDeviceIdentity
      });
      this.log('info', 'zwave', 'Z-Wave readiness probe succeeded', {
        nodeId: Number.isFinite(nodeId) ? nodeId : null,
        reason,
        action: trimString(context.action) || null,
        knownDeviceIdentity
      });
      return {
        ready: true,
        recovered: true,
        ping,
        probe
      };
    }

    const probe = this.markZWaveNodeReachability(node, {
      ok: false,
      reason,
      source: 'ping',
      error: pingError,
      knownDeviceIdentity
    });
    this.log('warn', 'zwave', 'Z-Wave readiness probe failed', {
      nodeId: Number.isFinite(nodeId) ? nodeId : null,
      reason,
      action: trimString(context.action) || null,
      knownDeviceIdentity,
      error: pingError
    });
    return {
      ready: false,
      recovered: false,
      ping,
      error: pingError,
      probe
    };
  },

async refreshZWaveNodeInfo(nodeId, options = {}) {
    await this.start();
    const { node } = this.getZWaveNode(nodeId);
    if (typeof node.refreshInfo !== 'function') {
      const error = new Error('This Z-Wave node does not support a HomeBrain re-interview request');
      error.status = 501;
      throw error;
    }

    this.attachZWaveNodeStatusListeners(node);
    const numericNodeId = Number(node.id);
    const waitForWakeup = parseOptionalBoolean(options.waitForWakeup, false);
    const requestedResetSecurityClasses = parseOptionalBoolean(options.resetSecurityClasses, false);
    const confirmSecurityReset = parseOptionalBoolean(options.confirmSecurityReset ?? options.allowSecurityReset, false);
    const resetSecurityClasses = requestedResetSecurityClasses && confirmSecurityReset;
    if (requestedResetSecurityClasses && !confirmSecurityReset) {
      this.log('warn', 'zwave', 'Ignored Z-Wave security-class reset without explicit confirmation', {
        nodeId: numericNodeId
      });
    }
    const pingFirst = parseOptionalBoolean(options.pingFirst, true);
    const skipRefreshIfPingSucceeds = parseOptionalBoolean(options.skipRefreshIfPingSucceeds, false);
    const before = this.serializeZWaveNodeSummary(node);
    let ping = null;
    let pingError = null;

    if (pingFirst && typeof node.ping === 'function') {
      try {
        ping = await node.ping(true);
      } catch (error) {
        ping = false;
        pingError = error.message;
      }
    }

    this.log('info', 'zwave', 'Z-Wave node re-interview requested', {
      nodeId: numericNodeId,
      waitForWakeup,
      resetSecurityClasses,
      skipRefreshIfPingSucceeds,
      ping,
      pingError
    });

    if (ping === true && skipRefreshIfPingSucceeds && resetSecurityClasses !== true) {
      await this.handleZWaveNodeChanged(node, 'ping succeeded').catch((error) => {
        this.log('warn', 'zwave', 'Failed to save Z-Wave node after successful ping', {
          nodeId: numericNodeId,
          error: error.message
        });
      });

      return {
        node: this.serializeZWaveNodeSummary(node),
        before,
        ping,
        pingError,
        waitForWakeup,
        resetSecurityClasses,
        skippedRefresh: true,
        message: `Node ${numericNodeId} answered the Z-Wave ping, so HomeBrain skipped the fresh interview.`
      };
    }

    await node.refreshInfo({
      resetSecurityClasses,
      waitForWakeup
    });

    await this.handleZWaveNodeChanged(node, 'refresh-info requested').catch((error) => {
      this.log('warn', 'zwave', 'Failed to save Z-Wave node after re-interview request', {
        nodeId: numericNodeId,
        error: error.message
      });
    });

    return {
      node: this.serializeZWaveNodeSummary(node),
      before,
      ping,
      pingError,
      waitForWakeup,
      resetSecurityClasses,
      skippedRefresh: false,
      message: `HomeBrain requested a fresh Z-Wave interview for node ${numericNodeId}.`
    };
  },

async replaceFailedZWaveNode(nodeId, options = {}) {
    await this.start();
    const { controller, node } = this.getZWaveNode(nodeId);
    const numericNodeId = Number(node.id);
    const confirm = parseOptionalBoolean(options.confirm, false);
    const force = parseOptionalBoolean(options.force, false);
    if (!confirm) {
      const error = new Error('Confirm failed-node replacement before starting a Z-Wave replace window');
      error.status = 400;
      throw error;
    }
    if (typeof controller.replaceFailedNode !== 'function') {
      const error = new Error('This Z-Wave controller does not support failed-node replacement');
      error.status = 501;
      throw error;
    }

    let failed = null;
    if (typeof controller.isFailedNode === 'function') {
      try {
        failed = await controller.isFailedNode(numericNodeId);
      } catch (error) {
        this.log('warn', 'zwave', 'Unable to verify Z-Wave failed-node status before replacement', {
          nodeId: numericNodeId,
          error: error.message
        });
      }
    }

    if (failed === false && !force) {
      const error = new Error(`Z-Wave node ${numericNodeId} is still responding. Re-interview it first, or force replacement only after confirming it is a stuck partial node.`);
      error.status = 409;
      error.failed = false;
      throw error;
    }

    const zwave = require('zwave-js');
    const seconds = boundedSeconds(options.durationSeconds);
    const resetResult = await this.closeZWavePairingWindow({
      zwave,
      reason: 'start_replace_failed',
      sessionMessage: 'Previous Z-Wave add/remove window was stopped before starting failed-node replacement.'
    });
    const { mode: zwaveSecurityMode, options: replacementOptions } = this.buildZWaveReplacementOptions(
      zwave,
      options.zwaveSecurityMode ?? options.securityMode
    );
    const dskCredential = zwaveSecurityMode === 'insecure'
      ? { pin: '', dsk: '', source: null, parsedQr: null }
      : await this.normalizeZWaveDskCredential(options.dskPin);
    const session = this.createPairingSession('zwave', seconds, {
      mode: 'replace_failed',
      targetIdentity: String(numericNodeId),
      message: zwaveSecurityMode === 's0'
        ? `Z-Wave legacy S0 replacement is opening for node ${numericNodeId}.`
        : `Z-Wave replacement is opening for node ${numericNodeId}.`
    });
    session.zwaveSecurityMode = zwaveSecurityMode;
    session.replaceNodeId = numericNodeId;
    session.zwaveDskCredentialSource = dskCredential.source || null;
    session.zwaveDskPreloaded = Boolean(dskCredential.pin);
    this.zwave.s2DskPin = dskCredential.pin;
    this.zwave.s2Dsk = dskCredential.dsk;
    this.zwave.pendingDsk = null;

    this.log('info', 'zwave', 'Opening Z-Wave failed-node replacement window', {
      nodeId: numericNodeId,
      durationSeconds: seconds,
      pairingId: session.id,
      securityMode: zwaveSecurityMode,
      previousWindow: resetResult,
      failed,
      force
    });

    let replacementStarted = false;
    try {
      replacementStarted = await controller.replaceFailedNode(numericNodeId, replacementOptions);
    } catch (error) {
      this.markPairingFailed('zwave', error.message || 'Z-Wave failed-node replacement failed to start.', {
        nodeId: numericNodeId,
        failed,
        force
      });
      throw error;
    }

    if (replacementStarted !== true) {
      const state = this.getZWaveInclusionStateLabel(zwave);
      const message = state
        ? `Z-Wave failed-node replacement did not start because the controller is still ${state}.`
        : 'Z-Wave failed-node replacement did not start because the controller reported it was busy.';
      this.markPairingFailed('zwave', message, {
        nodeId: numericNodeId,
        state,
        previousWindow: resetResult
      });
      const error = new Error(message);
      error.status = 409;
      error.code = 'ZWAVE_REPLACEMENT_NOT_STARTED';
      throw error;
    }

    this.zwave.inclusionUntil = new Date(Date.now() + seconds * 1000).toISOString();
    session.status = 'active';
    session.expiresAt = Date.now() + seconds * 1000;
    session.message = zwaveSecurityMode === 's0'
      ? `Z-Wave legacy S0 replacement is open for node ${numericNodeId}. Perform the device include action while this window is live.`
      : `Z-Wave replacement is open for node ${numericNodeId}. Perform the device include action while this window is live.`;
    this.armPairingTimer('zwave', session.id, seconds);
    this.log('info', 'zwave', 'Z-Wave failed-node replacement window is open', {
      nodeId: numericNodeId,
      expiresAt: this.zwave.inclusionUntil,
      pairingId: session.id,
      securityMode: zwaveSecurityMode
    });

    return {
      nodeId: numericNodeId,
      failed,
      force,
      mode: 'replace_failed',
      zwaveSecurityMode,
      expiresAt: this.zwave.inclusionUntil,
      pairing: this.serializePairingSession(session),
      message: session.message
    };
  },

async removeFailedZWaveNode(nodeId, options = {}) {
    await this.start();
    const { controller, node } = this.getZWaveNode(nodeId);
    const numericNodeId = Number(node.id);
    const confirm = parseOptionalBoolean(options.confirm, false);
    const force = parseOptionalBoolean(options.force, false);
    if (!confirm) {
      const error = new Error('Confirm failed-node removal before deleting a Z-Wave node from HomeBrain');
      error.status = 400;
      throw error;
    }
    if (typeof controller.removeFailedNode !== 'function') {
      const error = new Error('This Z-Wave controller does not support failed-node removal');
      error.status = 501;
      throw error;
    }

    let failed = null;
    if (typeof controller.isFailedNode === 'function') {
      try {
        failed = await controller.isFailedNode(numericNodeId);
      } catch (error) {
        this.log('warn', 'zwave', 'Unable to verify Z-Wave failed-node status before removal', {
          nodeId: numericNodeId,
          error: error.message
        });
      }
    }

    if (failed === false && !force) {
      const error = new Error(`Z-Wave node ${numericNodeId} is still responding. Re-interview it first, or force removal only after confirming it is a ghost node.`);
      error.status = 409;
      error.failed = false;
      throw error;
    }

    await controller.removeFailedNode(numericNodeId);
    const nodes = this.getZWaveControllerNodes({ log: false, context: 'failed node removal' });
    if (typeof nodes?.delete === 'function') {
      try {
        nodes.delete(numericNodeId);
      } catch (error) {
        this.log('warn', 'zwave', 'Unable to evict removed Z-Wave node from the live node cache', {
          nodeId: numericNodeId,
          error: error.message
        });
      }
    }
    const query = {
      'properties.homebrainDirect.protocol': 'zwave',
      'properties.homebrainDirect.nodeId': {
        $in: [numericNodeId, String(numericNodeId)]
      }
    };
    const matchingDevices = await Device.find(query).select('_id name').lean();
    let deletedDeviceCount = 0;
    const deletionCleanups = [];
    const deletionErrors = [];
    if (matchingDevices.length > 0) {
      const deviceService = require('./deviceService');
      for (const device of matchingDevices) {
        try {
          const deletedDevice = await deviceService.deleteDevice(device._id);
          deletedDeviceCount += 1;
          if (deletedDevice?.deletionCleanup) {
            deletionCleanups.push({
              deviceId: String(device._id),
              name: device.name || deletedDevice.name || null,
              cleanup: deletedDevice.deletionCleanup
            });
          }
        } catch (error) {
          const deletionError = {
            deviceId: String(device._id),
            name: device.name || null,
            message: error?.message || String(error || 'Unknown device deletion error')
          };
          deletionErrors.push(deletionError);
          this.log('warn', 'zwave', 'Z-Wave failed node removed, but matching HomeBrain device cleanup failed', {
            nodeId: numericNodeId,
            ...deletionError
          });
        }
      }
    }

    this.log('warn', 'zwave', 'Z-Wave failed node removed from HomeBrain', {
      nodeId: numericNodeId,
      failed,
      force,
      deletedDeviceCount,
      deletionCleanups,
      deletionErrors
    });

    return {
      nodeId: numericNodeId,
      failed,
      force,
      deletedDeviceCount,
      deletionCleanups,
      deletionErrors,
      message: `Z-Wave node ${numericNodeId} was removed from the controller.`
    };
  },

recordZWaveNodeRemoved(node, reason) {
    const migration = this.findCurrentMigrationSession('zwave', ['excluding']);
    if (!migration) {
      return;
    }

    const timestamp = new Date().toISOString();
    const nodeId = getNumericNodeId(node);
    this.appendMigrationEvent(migration, {
      kind: 'node_removed',
      statusName: 'NodeRemoved',
      nodeId,
      reason: reason === undefined ? null : String(reason),
      timestamp
    });
    migration.status = 'excluded';
    migration.exclusionStatus = 'verified';
    migration.exclusionVerifiedAt = migration.exclusionVerifiedAt || timestamp;
    migration.exclusionNodeId = nodeId ?? migration.exclusionNodeId ?? null;
    migration.expiresAt = Math.max(Number(migration.expiresAt || 0), Date.now() + 15 * 60 * 1000);
  },

recordZWaveInclusionStatus(status, statusContext = {}) {
    const migration = this.findCurrentMigrationSession('zwave', ['pairing']);
    if (!migration || status === undefined || status === null) {
      return;
    }

    const timestamp = new Date().toISOString();
    const statusName = enumMemberName(this.zwave.addNodeStatusEnum, status);
    const nodeId = getNumericNodeId(statusContext);
    this.appendMigrationEvent(migration, {
      kind: 'inclusion',
      status,
      statusName,
      nodeId,
      timestamp
    });

    if (['AddingSlave', 'AddingController'].includes(statusName) && nodeId !== null) {
      migration.inclusionNodeId = nodeId;
    }
    if (statusName === 'Failed') {
      migration.status = 'pairing_failed';
      migration.inclusionStatus = 'failed';
      migration.inclusionFailedAt = timestamp;
      this.log('warn', 'zwave', 'Z-Wave inclusion failed during migration', {
        migrationId: migration.id,
        deviceId: migration.sourceDeviceId
      });
    }
  },

recordZWaveInclusionFailed(message) {
    const migration = this.findCurrentMigrationSession('zwave', ['pairing']);
    if (!migration) {
      return;
    }

    const timestamp = new Date().toISOString();
    this.appendMigrationEvent(migration, {
      kind: 'inclusion_failed',
      statusName: 'Failed',
      message,
      timestamp
    });
    migration.status = 'pairing_failed';
    migration.inclusionStatus = 'failed';
    migration.inclusionFailedAt = timestamp;
  },

getZWaveController() {
    return this.zwave.driver?.controller || null;
  },

getZWaveNode(nodeId, options = {}) {
    const numericNodeId = getNumericNodeId(nodeId);
    if (!Number.isInteger(numericNodeId) || numericNodeId <= 0) {
      const error = new Error('Z-Wave node id is invalid');
      error.status = 400;
      throw error;
    }

    const controller = this.getZWaveController();
    const nodes = this.getZWaveControllerNodes({ context: 'node lookup' });
    if (!controller || !nodes || typeof nodes.get !== 'function') {
      const error = new Error('Z-Wave controller nodes are not available yet');
      error.status = 503;
      throw error;
    }

    const node = nodes.get(numericNodeId);
    if (!node) {
      const error = new Error(`Z-Wave node ${numericNodeId} is not present on the controller`);
      error.status = 404;
      throw error;
    }
    if (node.isControllerNode && options.allowController !== true) {
      const error = new Error('The Z-Wave controller node cannot be repaired as a device');
      error.status = 400;
      throw error;
    }

    return {
      controller,
      node,
      nodeId: numericNodeId
    };
  },

getZWaveNodeFeatures(node) {
    try {
      return this.normalizeZWaveNode(node, 'status')?.update?.properties?.directRadioFeatures || [];
    } catch (_error) {
      return [];
    }
  },

serializeZWaveNodeSummary(node) {
    if (!node) {
      return null;
    }
    const nodeId = getNumericNodeId(node);
    const features = this.getZWaveNodeFeatures(node);
    const manufacturer = trimString(node.deviceConfig?.manufacturer || node.manufacturer);
    const productLabel = trimString(node.deviceConfig?.label || node.productLabel);
    const interviewStage = node.interviewStage === undefined || node.interviewStage === null
      ? null
      : String(node.interviewStage);
    const effectiveRuntime = getEffectiveZWaveNodeRuntime(node);

    return {
      id: nodeId,
      name: trimString(node.name) || productLabel || (nodeId ? `Z-Wave Node ${nodeId}` : 'Z-Wave Node'),
      isControllerNode: node.isControllerNode === true,
      ready: effectiveRuntime.ready === true,
      status: effectiveRuntime.status,
      controllerReady: node.ready === undefined ? null : Boolean(node.ready),
      controllerStatus: node.status === undefined ? null : node.status,
      isOnline: isZWaveNodeOnline(node),
      interviewStage,
      isListening: node.isListening === undefined ? null : node.isListening,
      isFrequentListening: node.isFrequentListening === undefined ? null : node.isFrequentListening,
      manufacturerId: node.manufacturerId || null,
      productType: node.productType || null,
      productId: node.productId || null,
      manufacturer: manufacturer || null,
      productLabel: productLabel || null,
      features,
      incomplete: node.isControllerNode !== true && (
        effectiveRuntime.ready !== true
        || features.length === 0
        || (!node.manufacturerId && !node.productType && !node.productId && !manufacturer && !productLabel)
      )
    };
  },

getZWaveNodeSecurityDiagnostics(node) {
    const core = getZWaveCore();
    const securityClassEnum = core.SecurityClass || {};
    const nodeId = getNumericNodeId(node);
    const controller = this.getZWaveController();
    const nodeHighest = readZWaveHighestSecurityClass(node);
    const driverHighest = readZWaveHighestSecurityClass(this.zwave?.driver, nodeId);
    const classes = getZWaveSecurityClassEntries(core).map(([name, value]) => ({
      name,
      value,
      node: serializeMaybeKnown(readZWaveSecurityClass(node, value)),
      driver: serializeMaybeKnown(readZWaveSecurityClass(this.zwave?.driver, value, nodeId))
    }));
    let isSecure = undefined;
    try {
      isSecure = node?.isSecure;
    } catch (error) {
      isSecure = { error: error.message || String(error) };
    }

    return {
      isSecure: serializeMaybeKnown(isSecure),
      nodeHighestSecurityClass: nodeHighest && typeof nodeHighest === 'object' && nodeHighest.error
        ? nodeHighest
        : serializeMaybeKnown(nodeHighest, securityClassEnum),
      driverHighestSecurityClass: driverHighest && typeof driverHighest === 'object' && driverHighest.error
        ? driverHighest
        : serializeMaybeKnown(driverHighest, securityClassEnum),
      classes,
      controllerHomeId: controller?.homeId ?? null,
      controllerOwnNodeId: controller?.ownNodeId ?? null
    };
  },

getZWaveNodeValueDiagnostics(node, options = {}) {
    const core = getZWaveCore();
    const commandClasses = core.CommandClasses || {};
    const limit = parseBoundedInteger(options.limit, 120, 1, 500);
    let definedValueIds = [];
    try {
      definedValueIds = typeof node?.getDefinedValueIDs === 'function' ? (node.getDefinedValueIDs() || []) : [];
    } catch (error) {
      return {
        error: error.message || String(error),
        count: 0,
        values: []
      };
    }

    return {
      count: definedValueIds.length,
      limited: definedValueIds.length > limit,
      values: definedValueIds.slice(0, limit).map((valueId) => {
        let metadata = null;
        try {
          metadata = node?.valueDB?.getMetadata?.(valueId) || null;
        } catch (_error) {
          metadata = null;
        }
        return {
          commandClass: valueId?.commandClass ?? null,
          commandClassName: enumMemberName(commandClasses, valueId?.commandClass),
          endpoint: valueId?.endpoint ?? 0,
          property: valueId?.property ?? null,
          propertyName: valueId?.propertyName ?? null,
          propertyKey: valueId?.propertyKey ?? null,
          propertyKeyName: valueId?.propertyKeyName ?? null,
          label: valueMetadataLabel({ metadata, ...valueId }) || null,
          readable: metadata?.readable ?? null,
          writeable: metadata?.writeable ?? null
        };
      })
    };
  },

async getZWaveNodeDiagnostics(nodeId, options = {}) {
    await this.start();
    const { node } = this.getZWaveNode(nodeId);
    this.attachZWaveNodeStatusListeners(node);
    return {
      node: this.serializeZWaveNodeSummary(node),
      security: this.getZWaveNodeSecurityDiagnostics(node),
      values: this.getZWaveNodeValueDiagnostics(node, {
        limit: options.valueLimit ?? options.limit
      }),
      zwaveJsLog: {
        config: serializeZWaveJsLogConfig(typeof this.zwave?.driver?.getLogConfig === 'function'
          ? this.zwave.driver.getLogConfig()
          : null),
        latest: await this.getZWaveJsLogTail({
          nodeId: getNumericNodeId(node),
          limit: options.logLimit || 80
        })
      }
    };
  },

getZWaveNodeSummaries() {
    const nodes = this.getZWaveControllerNodes({ log: false, context: 'node summaries' });
    if (!nodes || typeof nodes.values !== 'function') {
      return [];
    }

    return Array.from(nodes.values())
      .map((node) => this.serializeZWaveNodeSummary(node))
      .filter(Boolean)
      .sort((left, right) => Number(left.id || 0) - Number(right.id || 0));
  },

async findDeviceForZWaveNode(node) {
    const nodeId = normalizeLockCodeSlot(node?.id);
    if (!nodeId || Device.db?.readyState !== 1) {
      return null;
    }

    return Device.findOne({
      $or: [
        { 'properties.homebrainDirect.nodeId': nodeId },
        { 'properties.homebrainDirect.nodeId': String(nodeId) }
      ]
    });
  },

attachZWaveNodeStatusListeners(node) {
    if (!node || node.__homebrainStatusListenersAttached || typeof node.on !== 'function') {
      return;
    }

    const updateFromNode = (reason) => {
      if (node.isControllerNode) {
        return;
      }
      this.log('info', 'zwave', `Z-Wave node ${reason}`, {
        nodeId: node.id || null,
        interviewStage: node.interviewStage === undefined ? null : String(node.interviewStage),
        ready: node.ready === undefined ? null : Boolean(node.ready),
        status: node.status === undefined ? null : node.status
      });
      void this.handleZWaveNodeChanged(node, reason).catch((error) => {
        this.log('warn', 'zwave', 'Failed to update Z-Wave node after status event', {
          nodeId: node.id || null,
          reason,
          error: error.message
        });
      });
      if (trimString(reason).toLowerCase() === 'dead') {
        const scheduled = this.scheduleZWaveNodeRouteRecovery(node, 'dead event');
        if (scheduled) {
          this.log('warn', 'zwave', 'Scheduled bounded Z-Wave route recovery after dead event', {
            nodeId: node.id || null
          });
        }
      }
    };

    node.on('dead', () => updateFromNode('dead'));
    node.on('alive', () => updateFromNode('alive'));
    node.on('interview completed', () => updateFromNode('interview completed'));
    node.on('interview failed', () => updateFromNode('interview failed'));
    node.on('ready', () => updateFromNode('ready'));
    node.on('node info received', () => updateFromNode('node info received'));
    node.on('notification', (...args) => this.handleZWaveLockNotification(node, ...args));
    node.on('user added', (_endpoint, args) => this.handleZWaveLockUserChanged(node, 'added', args));
    node.on('user modified', (_endpoint, args) => this.handleZWaveLockUserChanged(node, 'modified', args));
    node.on('user deleted', (_endpoint, args) => this.handleZWaveLockUserChanged(node, 'deleted', args));
    node.__homebrainStatusListenersAttached = true;
  },

async syncZWaveNodes() {
    const nodes = this.getZWaveControllerNodes({ context: 'node sync' });
    if (!nodes || typeof nodes.values !== 'function') {
      this.log('warn', 'zwave', 'Z-Wave node sync skipped because controller nodes are unavailable');
      return;
    }

    this.log('info', 'zwave', 'Synchronizing Z-Wave node inventory', {
      reportedNodeCount: nodes.size ?? null
    });
    for (const node of nodes.values()) {
      if (!node || node.isControllerNode) {
        continue;
      }
      this.attachZWaveNodeStatusListeners(node);
      if (!isZWaveNodeCommandReady(node)) {
        this.log('debug', 'zwave', 'Z-Wave startup sync observed node that is not command-ready', {
          nodeId: node.id || null,
          ready: node.ready === undefined ? null : Boolean(node.ready),
          status: node.status ?? null,
          interviewStage: node.interviewStage ?? null
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await this.handleZWaveNodeChanged(node, 'sync');
      if (!isZWaveNodeCommandReady(node)) {
        const scheduled = this.scheduleZWaveNodeRouteRecovery(node, 'startup sync');
        if (scheduled) {
          this.log('warn', 'zwave', 'Scheduled bounded Z-Wave route recovery during startup sync', {
            nodeId: node.id || null,
            ready: node.ready === undefined ? null : Boolean(node.ready),
            status: node.status ?? null,
            interviewStage: node.interviewStage ?? null
          });
        }
      }
    }
  },

normalizeZWaveNode(node, reason = 'sync') {
    if (!node) {
      return null;
    }

    const nodeId = Number(node.id);
    if (!Number.isFinite(nodeId)) {
      return null;
    }
    if (node.isControllerNode === true) {
      return null;
    }

    const zwave = require('zwave-js');
    const hasValue = (valueDef) => {
      try {
        return node.valueDB?.hasValue?.(valueDef.id || valueDef);
      } catch (_error) {
        return false;
      }
    };
    const features = new Set();
    if (hasValue(zwave.BinarySwitchCCValues.currentValue) || hasValue(zwave.BinarySwitchCCValues.targetValue)) features.add('switch');
    if (hasValue(zwave.MultilevelSwitchCCValues.currentValue) || hasValue(zwave.MultilevelSwitchCCValues.targetValue)) {
      features.add('switch');
      features.add('brightness');
    }
    if (hasValue(zwave.DoorLockCCValues.currentMode) || hasValue(zwave.DoorLockCCValues.targetMode)) {
      features.add('lock');
      features.add('battery');
    }
    const accessControl = getZWaveAccessControl(node);
    if (accessControl || hasZWaveUserCodeSupport(node)) {
      features.add('lockCodes');
    }
    if (hasValue(zwave.BatteryCCValues.level)) features.add('battery');
    if (hasValue(zwave.ColorSwitchCCValues.hexColor)) features.add('color');
    // Only treat a Sound Switch device as a triggerable alarm when it exposes
    // toneId ("Play Tone"); volume alone cannot actually sound the siren.
    if (hasValue(zwave.SoundSwitchCCValues.toneId)) features.add('alarm');
    if (hasValue(zwave.ThermostatModeCCValues.thermostatMode)) features.add('thermostat');
    if (findZWaveValueByLabel(node, /\btemperature\b/i) !== undefined) features.add('temperature');
    if (findZWaveValueByLabel(node, /\bhumidity\b/i) !== undefined) features.add('humidity');
    if (findZWaveValueByLabel(node, /\billuminance|luminance|light\b/i) !== undefined) features.add('illuminance');
    if (findZWaveValueByLabel(node, /\bpower\b/i) !== undefined) features.add('power');
    if (findZWaveValueByLabel(node, /\benergy\b/i) !== undefined) features.add('energy');
    if (findZWaveValueByLabel(node, /\bwater|leak\b/i) !== undefined) features.add('water');
    if (findZWaveValueByLabel(node, /\btamper\b/i) !== undefined) features.add('tamper');

    const catalogEntry = directRadioProtocolCatalogService.getZWaveNodeCatalogEntry(node);
    const directRadioCatalog = directRadioProtocolCatalogService.compactCatalogForDevice(catalogEntry);
    const sirenVolumeParameter = getSirenVolumeConfigParameterFromCatalog(directRadioCatalog);
    const sirenSoundParameter = getSirenSoundConfigParameterFromCatalog(directRadioCatalog);
    const sirenVolumeValue = sirenVolumeParameter
      ? getZWaveValue(node, zwave.ConfigurationCCValues.paramInformation(
        normalizeInteger(sirenVolumeParameter.parameter),
        normalizeInteger(sirenVolumeParameter.valueBitMask) ?? undefined
      ))
      : getZWaveValue(node, zwave.SoundSwitchCCValues.volume);
    const sirenSoundValue = sirenSoundParameter
      ? getZWaveValue(node, zwave.ConfigurationCCValues.paramInformation(
        normalizeInteger(sirenSoundParameter.parameter),
        normalizeInteger(sirenSoundParameter.valueBitMask) ?? undefined
      ))
      : getZWaveValue(node, zwave.SoundSwitchCCValues.defaultToneId);
    const sirenVolumeProperties = sirenVolumeParameter
      ? buildSirenVolumeProperties(sirenVolumeParameter, sirenVolumeValue)
      : hasZWaveValue(node, zwave.SoundSwitchCCValues.volume)
        ? { supportsSirenVolume: true, ...(normalizeInteger(sirenVolumeValue) !== null ? { sirenVolume: normalizeInteger(sirenVolumeValue) } : {}) }
        : {};
    const sirenSoundProperties = sirenSoundParameter
      ? buildSirenSoundProperties(sirenSoundParameter, sirenSoundValue)
      : hasZWaveValue(node, zwave.SoundSwitchCCValues.defaultToneId)
        ? { supportsSirenSound: true, ...(normalizeInteger(sirenSoundValue) !== null ? { sirenSound: normalizeInteger(sirenSoundValue) } : {}) }
        : {};
    (Array.isArray(catalogEntry?.homebrainFeatures) ? catalogEntry.homebrainFeatures : [])
      .map(normalizeFeature)
      .filter(Boolean)
      .forEach((feature) => features.add(feature));

    const currentLockMode = getZWaveValue(node, zwave.DoorLockCCValues.currentMode);
    const binaryValue = getZWaveValue(node, zwave.BinarySwitchCCValues.currentValue);
    const multilevelValue = getZWaveValue(node, zwave.MultilevelSwitchCCValues.currentValue);
    const brightness = clampPercent(multilevelValue);
    const locked = currentLockMode === zwave.DoorLockMode.Secured || currentLockMode === true || currentLockMode === 'Secured';
    const hasLock = features.has('lock');
    const batteryReport = normalizeZWaveBatteryReport(getZWaveValue(node, zwave.BatteryCCValues.level), {
      zeroIsUnknown: hasLock,
      pendingWhenMissing: hasLock && features.has('battery')
    });
    const directRadioState = {};
    if (batteryReport.level !== null) {
      directRadioState.batteryLevel = batteryReport.level;
    }
    if (batteryReport.low) {
      directRadioState.batteryLow = true;
    }
    const hasSwitch = features.has('switch');
    const nodeName = trimString(node.name)
      || trimString(node.deviceConfig?.label)
      || trimString(node.productLabel)
      || trimString(catalogEntry?.label || catalogEntry?.model)
      || `Z-Wave Node ${nodeId}`;
    const effectiveRuntime = getEffectiveZWaveNodeRuntime(node);
    const reachabilityProbe = effectiveRuntime.reachabilityProbe;

    const directFeatures = Array.from(features).sort();
    return {
      identity: {
        protocol: 'zwave',
        id: String(nodeId),
        source: DIRECT_RADIO_SOURCES.zwave
      },
      update: {
        name: nodeName,
        type: this.inferDeviceTypeFromFeatures(directFeatures, {
          name: nodeName,
          productLabel: node.productLabel,
          manufacturer: node.deviceConfig?.manufacturer,
          deviceConfig: node.deviceConfig
        }),
        room: trimString(node.location) || 'Unassigned',
        status: hasLock ? locked : hasSwitch ? Boolean(binaryValue || (brightness && brightness > 0)) : false,
        brightness: brightness ?? undefined,
        isOnline: isZWaveNodeOnline(node),
        lastSeen: new Date(),
        brand: trimString(node.deviceConfig?.manufacturer) || undefined,
        model: trimString(node.deviceConfig?.label || node.productLabel) || undefined,
        properties: {
          source: DIRECT_RADIO_SOURCES.zwave,
          homebrainDirect: {
            protocol: 'zwave',
            nodeId,
            manufacturerId: node.manufacturerId || null,
            productType: node.productType || null,
            productId: node.productId || null,
            interviewStage: String(node.interviewStage || ''),
            ready: effectiveRuntime.ready,
            status: effectiveRuntime.status,
            controllerReady: node.ready === undefined ? null : Boolean(node.ready),
            controllerStatus: node.status,
            isListening: node.isListening,
            isFrequentListening: node.isFrequentListening,
            lastReason: reason,
            lastSeen: new Date().toISOString(),
            ...(reachabilityProbe ? {
              lastReachabilityProbeAt: new Date(reachabilityProbe.at).toISOString(),
              lastReachabilityProbeReason: reachabilityProbe.reason || null,
              lastReachabilityProbeSource: reachabilityProbe.source || null
            } : {}),
            catalog: directRadioProtocolCatalogService.buildCatalogReference(catalogEntry)
          },
          homeBrainBatteryLevel: batteryReport.level,
          batteryLevel: batteryReport.level,
          homeBrainBatteryLow: batteryReport.low,
          homeBrainBatteryReportPending: batteryReport.pending,
          ...(Object.keys(directRadioState).length > 0 ? { directRadioState } : {}),
          directRadioFeatures: directFeatures,
          directRadioCapabilities: buildNormalizedCapabilities(directFeatures, 'zwave'),
          directRadioCatalog,
          ...sirenVolumeProperties,
          ...sirenSoundProperties,
          ...buildDirectFeatureProperties(directFeatures)
        }
      }
    };
  },

async handleZWaveNodeChanged(node, reason) {
    const normalized = this.normalizeZWaveNode(node, reason);
    if (!normalized) {
      return null;
    }
    this.log('info', 'zwave', 'Z-Wave node state normalized', {
      reason,
      nodeId: normalized.identity?.id || null,
      features: normalized.update?.properties?.directRadioFeatures || []
    });
    if (!isZWaveDirectUpdateInterviewComplete(normalized.update, reason)) {
      this.markPairingDetected('zwave', normalized.identity, null, reason);
      const activeMigration = this.findActiveMigration('zwave');
      if (activeMigration?.sourceDeviceId) {
        const timestamp = new Date().toISOString();
        activeMigration.inclusionStatus = 'interviewing';
        activeMigration.directIdentity = normalized.identity;
        activeMigration.pendingDirectName = normalized.update?.name || null;
        activeMigration.updatedAt = timestamp;
      }
      if (Device.db?.readyState !== 1) {
        this.log('info', 'zwave', 'Z-Wave node interview is not complete; skipping partial device persistence until the database is ready', {
          reason,
          nodeId: normalized.identity?.id || null
        });
        return null;
      }
      const updatedExisting = await this.upsertDirectDevice(normalized.identity, normalized.update, {
        allowCreate: false,
        skipActiveMigration: true,
        suppressPairingCompletion: true
      });
      if (!updatedExisting) {
        this.log('info', 'zwave', 'Z-Wave node interview is not complete; deferring HomeBrain device creation', {
          reason,
          nodeId: normalized.identity?.id || null,
          ready: normalized.update?.properties?.homebrainDirect?.ready ?? null,
          status: normalized.update?.properties?.homebrainDirect?.status ?? null
        });
      }
      return updatedExisting;
    }
    return this.upsertDirectDevice(normalized.identity, normalized.update);
  },

async setZWaveValue(node, valueDef, value, options = {}) {
    const result = await node.setValue(valueDef.id || valueDef, value, options);
    const status = result?.status;
    const zwave = require('zwave-js');
    if (status === zwave.SetValueStatus.Fail || status === zwave.SetValueStatus.NoDeviceSupport || status === zwave.SetValueStatus.NotImplemented) {
      throw new Error(result?.message || 'Z-Wave command was not accepted by the device');
    }
    return result;
  },

normalizeSirenVolumeCommand(device, rawValue) {
    const parameter = getSirenVolumeConfigParameterFromCatalog(device?.properties?.directRadioCatalog);
    const value = resolveSirenVolumeValue(rawValue, parameter);
    return {
      value,
      parameter,
      options: parameter ? getSirenVolumeOptionsFromParameter(parameter) : []
    };
  },

normalizeSirenSoundCommand(device, rawValue) {
    const parameter = getSirenSoundConfigParameterFromCatalog(device?.properties?.directRadioCatalog);
    const value = resolveSirenSoundValue(rawValue, parameter);
    return {
      value,
      parameter,
      options: parameter ? getSirenSoundOptionsFromParameter(parameter) : []
    };
  },

isSirenLikeDirectDevice(device) {
    const features = Array.isArray(device?.properties?.directRadioFeatures)
      ? device.properties.directRadioFeatures.map(normalizeFeature)
      : [];
    const descriptor = [
      device?.type,
      device?.name,
      device?.brand,
      device?.model
    ].map((entry) => trimString(entry).toLowerCase()).filter(Boolean).join(' ');
    return device?.type === 'siren'
      || device?.properties?.supportsAlarm === true
      || features.includes('alarm')
      || features.includes('chime')
      || /\b(?:siren|alarm|sounder|chime)\b/.test(descriptor);
  },

supportsSirenVolumeControl(device) {
    const protocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol)
      || (normalizeSourceText(device?.properties?.source) === DIRECT_RADIO_SOURCES.zwave ? 'zwave' : '');
    if (protocol !== 'zwave') {
      return false;
    }
    if (!this.isSirenLikeDirectDevice(device)) {
      return false;
    }
    return Boolean(
      getSirenVolumeConfigParameterFromCatalog(device?.properties?.directRadioCatalog)
      || device?.properties?.supportsSirenVolume === true
    );
  },

supportsSirenSoundControl(device) {
    const protocol = normalizeSourceText(device?.properties?.homebrainDirect?.protocol)
      || (normalizeSourceText(device?.properties?.source) === DIRECT_RADIO_SOURCES.zwave ? 'zwave' : '');
    if (protocol !== 'zwave') {
      return false;
    }
    if (!this.isSirenLikeDirectDevice(device)) {
      return false;
    }
    return Boolean(
      getSirenSoundConfigParameterFromCatalog(device?.properties?.directRadioCatalog)
      || device?.properties?.supportsSirenSound === true
    );
  },

async setZWaveSirenVolume(device, node, rawValue, updateData = {}) {
    const zwave = require('zwave-js');
    const command = this.normalizeSirenVolumeCommand(device, rawValue);

    if (command.parameter) {
      await this.setZWaveValue(
        node,
        zwave.ConfigurationCCValues.paramInformation(
          normalizeInteger(command.parameter.parameter),
          normalizeInteger(command.parameter.valueBitMask) ?? undefined
        ),
        command.value
      );
    } else if (hasZWaveValue(node, zwave.SoundSwitchCCValues.volume)) {
      await this.setZWaveValue(node, zwave.SoundSwitchCCValues.volume, command.value);
    } else {
      throw new Error('Siren volume control is not available for this Z-Wave device');
    }

    updateData.properties = {
      ...(device?.properties && typeof device.properties === 'object' ? device.properties : {}),
      ...(updateData.properties && typeof updateData.properties === 'object' ? updateData.properties : {}),
      supportsSirenVolume: true,
      sirenVolume: command.value,
      ...(command.options.length > 0 ? { sirenVolumeOptions: command.options } : {})
    };
  },

async setZWaveSirenSound(device, node, rawValue, updateData = {}) {
    const zwave = require('zwave-js');
    const command = this.normalizeSirenSoundCommand(device, rawValue);

    if (command.parameter) {
      await this.setZWaveValue(
        node,
        zwave.ConfigurationCCValues.paramInformation(
          normalizeInteger(command.parameter.parameter),
          normalizeInteger(command.parameter.valueBitMask) ?? undefined
        ),
        command.value
      );
    } else if (hasZWaveValue(node, zwave.SoundSwitchCCValues.defaultToneId)) {
      await this.setZWaveValue(node, zwave.SoundSwitchCCValues.defaultToneId, command.value);
    } else {
      throw new Error('Siren sound control is not available for this Z-Wave device');
    }

    updateData.properties = {
      ...(device?.properties && typeof device.properties === 'object' ? device.properties : {}),
      ...(updateData.properties && typeof updateData.properties === 'object' ? updateData.properties : {}),
      supportsSirenSound: true,
      sirenSound: command.value,
      ...(command.options.length > 0 ? { sirenSoundOptions: command.options } : {})
    };
  },

async controlZWaveSiren(node, on) {
    const zwave = require('zwave-js');
    // A siren's "on" must make it sound. Different sirens expose different control
    // command classes, so try them in priority order:
    //  - Binary Switch / Multilevel Switch: switch-style sirens (incl. Aeotec ZW080 Gen5)
    //  - Sound Switch toneId (255 = play default tone, 0 = stop): tone-playing sirens
    //    (e.g. Aeotec Siren 6)
    //  - Basic: simple/legacy sirens that only expose Basic on/off
    const candidates = [
      { def: zwave.BinarySwitchCCValues.targetValue, value: Boolean(on), label: 'binary_switch' },
      { def: zwave.SoundSwitchCCValues.toneId, value: on ? 255 : 0, label: 'sound_switch' },
      { def: zwave.MultilevelSwitchCCValues.targetValue, value: on ? 99 : 0, label: 'multilevel_switch' },
      { def: zwave.BasicCCValues.targetValue, value: on ? 255 : 0, label: 'basic' }
    ];

    // Capability is determined from the node's interviewed command classes, NOT
    // from whether a value is currently cached -- a freshly-included siren has not
    // cached a targetValue yet, which is exactly what made the previous check fail.
    let definedIds = [];
    try {
      definedIds = typeof node.getDefinedValueIDs === 'function' ? (node.getDefinedValueIDs() || []) : [];
    } catch (_error) {
      definedIds = [];
    }
    const supportsCandidate = (candidate) => {
      const cc = (candidate.def.id || candidate.def).commandClass;
      return definedIds.some((valueId) => valueId && valueId.commandClass === cc);
    };

    const supportedCandidates = candidates.filter(supportsCandidate);
    const orderedCandidates = supportedCandidates.length > 0
      ? [
          ...supportedCandidates,
          ...candidates.filter((candidate) => !supportedCandidates.includes(candidate))
        ]
      : candidates;

    // Try each trigger and use the first the controller accepts. Some sirens expose
    // an interviewed value ID for one CC but reject its command, so keep falling
    // through alternate siren trigger methods before reporting failure.
    // setZWaveValue throws on
    // NoDeviceSupport, so an unsupported CC is skipped without sending a command.
    let lastError = null;
    for (const candidate of orderedCandidates) {
      try {
        await this.setZWaveValue(node, candidate.def, candidate.value);
        return candidate.label;
      } catch (error) {
        if (isZWaveCommandDeliveryError(error)) {
          throw error;
        }
        lastError = error;
      }
    }
    const detail = lastError ? ` (last error: ${lastError.message})` : '';
    throw new Error(`This Z-Wave siren does not expose a supported on/off trigger -- tried Binary Switch, Sound Switch tone, Multilevel Switch, and Basic${detail}.`);
  },

async controlZWaveDevice(device, normalizedAction, commandValue, updateData = {}) {
    const node = this.getDirectNodeForDevice(device);
    if (!isZWaveNodeCommandReady(node)) {
      const probe = await this.probeZWaveNodeCommandReadiness(node, {
        reason: 'command',
        action: normalizedAction,
        device
      });
      if (probe.ready !== true || !isZWaveNodeCommandReady(node)) {
        throw new Error(probe.error
          ? `Z-Wave node is not ready (${probe.error})`
          : 'Z-Wave node is not ready');
      }
    }
    let effectiveAction = normalizedAction;
    if (device?.type === 'lock') {
      if (normalizedAction === 'turnon') {
        effectiveAction = 'lock';
      } else if (normalizedAction === 'turnoff') {
        effectiveAction = 'unlock';
      } else if (normalizedAction === 'toggle') {
        effectiveAction = device?.status ? 'unlock' : 'lock';
      }
    }
    const zwave = require('zwave-js');
    this.log('info', 'zwave', 'Sending Z-Wave device command', {
      deviceId: device?._id?.toString?.() || null,
      name: device?.name || null,
      nodeId: device?.properties?.homebrainDirect?.nodeId || null,
      action: effectiveAction,
      requestedAction: normalizedAction === effectiveAction ? undefined : normalizedAction,
      value: commandValue ?? null
    });

    const executeZWaveCommand = async () => {
      switch (effectiveAction) {
        case 'toggle':
        case 'turnon':
        case 'turnoff': {
          const target = normalizedAction === 'toggle' ? Boolean(commandValue) : normalizedAction === 'turnon';
          if (device?.type === 'siren') {
            await this.controlZWaveSiren(node, target);
          } else if (device?.properties?.supportsBrightness || device?.brightness > 0) {
            await this.setZWaveValue(node, zwave.MultilevelSwitchCCValues.targetValue, target ? Math.max(1, Number(device?.brightness) || 99) : 0);
          } else {
            await this.setZWaveValue(node, zwave.BinarySwitchCCValues.targetValue, target);
          }
          break;
        }
        case 'setbrightness':
          await this.setZWaveValue(node, zwave.MultilevelSwitchCCValues.targetValue, Math.max(0, Math.min(99, Math.round(Number(commandValue)))));
          break;
        case 'setcolor':
          await this.setZWaveValue(node, zwave.ColorSwitchCCValues.hexColor, trimString(commandValue).replace(/^#/, ''));
          break;
        case 'settemperature': {
          const mode = normalizeSourceText(device?.properties?.hvacMode || device?.properties?.zwaveThermostatMode || '');
          const setpointType = mode === 'cool' ? 2 : 1;
          await this.setZWaveValue(node, zwave.ThermostatSetpointCCValues.setpoint(setpointType), Number(commandValue));
          break;
        }
        case 'setmode': {
          const modeMap = {
            off: zwave.ThermostatMode.Off,
            heat: zwave.ThermostatMode.Heat,
            cool: zwave.ThermostatMode.Cool,
            auto: zwave.ThermostatMode.Auto
          };
          const mode = modeMap[normalizeSourceText(commandValue)];
          if (mode === undefined) {
            throw new Error('Unsupported thermostat mode');
          }
          await this.setZWaveValue(node, zwave.ThermostatModeCCValues.thermostatMode, mode);
          break;
        }
        case 'lock':
          await this.setZWaveValue(node, zwave.DoorLockCCValues.targetMode, zwave.DoorLockMode.Secured);
          break;
        case 'unlock':
          await this.setZWaveValue(node, zwave.DoorLockCCValues.targetMode, zwave.DoorLockMode.Unsecured);
          break;
        case 'setsirenvolume':
          await this.setZWaveSirenVolume(device, node, commandValue, updateData);
          break;
        case 'setsirensound':
          await this.setZWaveSirenSound(device, node, commandValue, updateData);
          break;
        case 'alarmoff':
        case 'turnoffalarm':
        case 'silencealarm':
          if (device?.properties?.supportsAlarm) {
            await this.setZWaveValue(node, zwave.BinarySwitchCCValues.targetValue, false).catch(async () => {
              await this.setZWaveValue(node, zwave.SoundSwitchCCValues.volume, 0);
            });
          }
          break;
        default:
          throw new Error('This Z-Wave device does not support the requested action yet');
      }
    };

    try {
      await executeZWaveCommand();
    } catch (error) {
      if (!isZWaveCommandDeliveryError(error)) {
        throw error;
      }
      this.log('warn', 'zwave', 'Z-Wave command delivery failed; attempting bounded route recovery before one retry', {
        deviceId: device?._id?.toString?.() || null,
        name: device?.name || null,
        nodeId: node?.id || device?.properties?.homebrainDirect?.nodeId || null,
        action: effectiveAction,
        error: error.message
      });
      let recovery = null;
      try {
        recovery = await this.recoverZWaveNodeRoutes(node?.id || device?.properties?.homebrainDirect?.nodeId, {
          reason: `command delivery failure: ${effectiveAction}`,
          device,
          pingTimeoutMs: ZWAVE_NODE_ROUTE_RECOVERY_PING_TIMEOUT_MS,
          routeRebuildTimeoutMs: ZWAVE_NODE_ROUTE_RECOVERY_TIMEOUT_MS
        });
      } catch (recoveryError) {
        this.log('warn', 'zwave', 'Z-Wave command route recovery failed before retry', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          nodeId: node?.id || device?.properties?.homebrainDirect?.nodeId || null,
          action: effectiveAction,
          commandError: error.message,
          recoveryError: recoveryError.message
        });
        throw error;
      }
      if (recovery?.recovered !== true) {
        this.log('warn', 'zwave', 'Z-Wave command route recovery did not restore reachability', {
          deviceId: device?._id?.toString?.() || null,
          name: device?.name || null,
          nodeId: node?.id || device?.properties?.homebrainDirect?.nodeId || null,
          action: effectiveAction,
          commandError: error.message,
          recovery
        });
        throw error;
      }
      this.log('info', 'zwave', 'Retrying Z-Wave command after route recovery', {
        deviceId: device?._id?.toString?.() || null,
        name: device?.name || null,
        nodeId: node?.id || device?.properties?.homebrainDirect?.nodeId || null,
        action: effectiveAction
      });
      await executeZWaveCommand();
    }

    const commandTimestamp = new Date().toISOString();
    const effectiveRuntime = getEffectiveZWaveNodeRuntime(node);
    const reachabilityProbe = effectiveRuntime.reachabilityProbe;
    const direct = device?.properties?.homebrainDirect && typeof device.properties.homebrainDirect === 'object'
      ? device.properties.homebrainDirect
      : {};
    const updateProperties = updateData.properties && typeof updateData.properties === 'object'
      ? updateData.properties
      : {};
    updateData.properties = {
      ...(device?.properties && typeof device.properties === 'object' ? device.properties : {}),
      ...updateProperties,
      homebrainDirect: {
        ...direct,
        ...(updateProperties.homebrainDirect && typeof updateProperties.homebrainDirect === 'object'
          ? updateProperties.homebrainDirect
          : {}),
        ready: effectiveRuntime.ready,
        status: effectiveRuntime.status,
        controllerReady: node.ready === undefined ? null : Boolean(node.ready),
        controllerStatus: node.status === undefined ? null : node.status,
        lastReason: 'command accepted',
        lastSeen: commandTimestamp,
        lastCommandAcceptedAt: commandTimestamp,
        ...(reachabilityProbe ? {
          lastReachabilityProbeAt: new Date(reachabilityProbe.at).toISOString(),
          lastReachabilityProbeReason: reachabilityProbe.reason || null,
          lastReachabilityProbeSource: reachabilityProbe.source || null
        } : {})
      }
    };
    updateData.isOnline = isZWaveNodeOnline(node);
    updateData.lastSeen = new Date();
    this.log('info', 'zwave', 'Z-Wave device command accepted', {
      deviceId: device?._id?.toString?.() || null,
      name: device?.name || null,
      action: effectiveAction
    });
  }
};

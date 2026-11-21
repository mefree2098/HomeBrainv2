'use strict';

const { inferFeaturesFromSmartThings } = require('./directRadioDeviceCatalog');
const {
  addFallbackSerialPortCandidates,
  normalizeSerialPort,
  enrichSerialPortForDirectRadios,
  looksLikeSonoffMg24ThreadStick,
  scorePortForProtocol,
  choosePortForProtocol
} = require('./directRadio/serialPorts');
const {
  isZWaveNodeOnline,
  isZWaveNodeCommandReady,
  isZWaveNodeCommandProbeCandidate,
  getEffectiveZWaveNodeRuntime,
  isZWaveDirectUpdateInterviewComplete,
  applyContactOpenDebounce,
  normalizeContactOpenDebounceSeconds,
  mergeDirectDeviceUpdateForExisting,
  isDuplicateDirectRadioRecord,
  selectPrimaryDirectDeviceRecord,
  mergeSmartThingsTelemetryFallback,
  scoreDetachedSmartThingsMigrationSource,
  buildRecoveredSmartThingsMigrationSnapshot,
  inferFeaturesFromZigbeeDefinition,
  getSirenVolumeConfigParameterFromCatalog,
  getSirenVolumeOptionsFromParameter
} = require('./directRadioHelpers');

class DirectRadioService {
  constructor() {
    this.started = false;
    this.startPromise = null;
    this.serialPorts = [];
    this.detected = {
      zigbee: null,
      zwave: null
    };
    this.lastSerialScanSummary = '';
    this.hardwareMonitorTimer = null;
    this.zigbee = {
      controller: null,
      converters: null,
      started: false,
      error: null,
      permitJoinUntil: null,
      lastStartResult: null
    };
    this.zwave = {
      driver: null,
      started: false,
      error: null,
      inclusionUntil: null,
      exclusionUntil: null,
      s2DskPin: '',
      s2Dsk: '',
      pendingDsk: null,
      pendingDskRequest: null,
      addNodeStatusEnum: null,
      removeNodeStatusEnum: null,
      nodeRouteRecoveries: new Map()
    };
    this.activeMigrations = new Map();
    this.activePairings = new Map();
    this.directDeviceUpsertLocks = new Map();
    this.pairingTimers = {
      zigbee: null,
      zwave: null
    };
    this.zigbeePermitJoinRenewalTimer = null;
  }
}

// Behavior is composed from focused mixin modules (Phase 5b decomposition).
Object.assign(
  DirectRadioService.prototype,
  require('./directRadioCore'),
  require('./directRadioLocks'),
  require('./directRadioPairing'),
  require('./directRadioZwave'),
  require('./directRadioZigbee'),
  require('./directRadioMigration')
);

const directRadioService = new DirectRadioService();

directRadioService.DirectRadioService = DirectRadioService;

directRadioService._test = {
  addFallbackSerialPortCandidates,
  choosePortForProtocol,
  enrichSerialPortForDirectRadios,
  inferFeaturesFromSmartThings,
  inferFeaturesFromZigbeeDefinition,
  getSirenVolumeConfigParameterFromCatalog,
  getSirenVolumeOptionsFromParameter,
  isDuplicateDirectRadioRecord,
  isZWaveDirectUpdateInterviewComplete,
  isZWaveNodeCommandReady,
  isZWaveNodeCommandProbeCandidate,
  isZWaveNodeOnline,
  getEffectiveZWaveNodeRuntime,
  looksLikeSonoffMg24ThreadStick,
  applyContactOpenDebounce,
  normalizeContactOpenDebounceSeconds,
  mergeSmartThingsTelemetryFallback,
  mergeDirectDeviceUpdateForExisting,
  normalizeSerialPort,
  selectPrimaryDirectDeviceRecord,
  buildRecoveredSmartThingsMigrationSnapshot,
  scoreDetachedSmartThingsMigrationSource,
  scorePortForProtocol
};

module.exports = directRadioService;

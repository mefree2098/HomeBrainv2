const crypto = require('node:crypto');
const mongoose = require('mongoose');
const axios = require('axios');
const net = require('node:net');
const VoiceDevice = require('../models/VoiceDevice');
const Device = require('../models/Device');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const eventStreamService = require('./eventStreamService');
const reachyMiniPackageService = require('./reachyMiniPackageService');
const reachySnapshotService = require('./reachySnapshotService');
const {
  issueDeviceToken,
  buildOnboardingSettings,
  applyDeviceActivation,
  applyOnboardingReissue,
  validateDeviceCredentials,
  validateDeviceAccess
} = require('./voiceDeviceLifecycleService');

const REACHY_DEVICE_TYPE = 'robot';
const REACHY_DEVICE_SOURCE = 'reachy';
const REACHY_PROTOCOL_VERSION = 1;
const MAX_SPEECH_LENGTH = 1000;
// This is the stable entrypoint installed once through Reachy's supported app
// installation flow. Runtime updates never attempt to register a new local app
// with the daemon; the launcher selects a verified, versioned release itself.
const REACHY_APP_NAME = 'reachy-homebrain-app';
const REACHY_DAEMON_PORT = 8000;
const MAX_MOTION_DURATION_MS = 5_000;
const MIN_MOTION_DURATION_MS = 100;
const MIN_MOVE_DURATION_MS = 300;
const COMMAND_DURATION_TTL_MARGIN_MS = 1_000;
const APP_MANAGEMENT_STATES = new Set([
  'idle',
  'checking',
  'staging',
  'staged',
  'updating',
  'completed',
  'failed',
  'manual_reinstall_required',
  'version_collision',
  'downgrade_blocked'
]);

const ROBOT_MODES = new Set([
  'sleeping',
  'idle',
  'listening',
  'thinking',
  'speaking',
  'moving',
  'error',
  'released'
]);
const MOTOR_MODES = new Set(['disabled', 'enabled', 'gravity_compensation']);
const LOOK_DIRECTIONS = new Set(['left', 'right', 'up', 'down', 'center', 'speaker']);
const EMOTIONS = new Set([
  'neutral',
  'happy',
  'curious',
  'sad',
  'listening',
  'speaking',
  'alert'
]);
const MOVES = new Set([
  'nod',
  'shake_head',
  'greet',
  'celebrate',
  'dance',
  'yes',
  'no'
]);
const CAPABILITIES = new Set([
  'audio_input',
  'audio_output',
  'camera',
  'head_motion',
  'body_rotation',
  'antennas',
  'imu',
  'speech_direction',
  'face_tracking',
  'wake_word',
  'snapshot'
]);
const ROBOT_EVENT_TYPES = new Set([
  'online',
  'offline',
  'motion_started',
  'motion_completed',
  'motion_failed',
  'motion_stopped',
  'person_present',
  'person_cleared',
  'speech_detected',
  'voice_session_started',
  'voice_session_completed',
  'app_handoff',
  'snapshot_ready',
  'error'
]);
const COMMAND_RESULT_STATUSES = new Set([
  'accepted',
  'started',
  'completed',
  'failed',
  'cancelled',
  'rejected'
]);
const SEMANTIC_ACTIONS = new Set([
  'wake',
  'sleep',
  'neutral',
  'stop',
  'look',
  'set_antennas',
  'set_body_yaw',
  'set_motor_mode',
  'play_emotion',
  'play_move',
  'start_face_tracking',
  'stop_face_tracking',
  'set_volume',
  'set_microphone_volume',
  'snapshot',
  'release_app'
]);
const SAFE_SETTING_KEYS = new Set([
  'wakeWordEnabled',
  'microphoneEnabled',
  'cameraEnabled',
  'presenceDetectionEnabled',
  'snapshotEnabled',
  'allowHighRiskVoiceActions',
  'speechDirectionEnabled',
  'faceTrackingDefault',
  'idleMotionEnabled',
  'defaultEmotion',
  'speakerVolume',
  'microphoneVolume',
  'commandTtlMs',
  'telemetryIntervalMs',
  'visionMode'
]);
const WORKFLOW_META_PARAMETER_KEYS = new Set([
  'command',
  'action',
  'deviceId',
  'commandParameters',
  'disableActionRetry',
  'retryOnFailure',
  'actionRetry',
  'workflowRetry',
  'retryable',
  'workflowRetryCount',
  'actionRetryCount',
  'workflowRetries',
  'actionRetries',
  'retryAttempts',
  'workflowRetryDelayMs',
  'actionRetryDelayMs',
  'retryDelayMs',
  'workflowRetryBackoff',
  'actionRetryBackoff',
  'retryBackoff',
  'continueOnFailure',
  'continueOnError',
  'stopOnFailure',
  'stopWorkflowOnFailure',
  'critical',
  'required'
]);

const COMMAND_ALIASES = Object.freeze({
  rest: 'neutral',
  stop_motion: 'stop',
  emotion: 'play_emotion',
  dance: 'play_move',
  take_snapshot: 'snapshot',
  release: 'release_app',
  motor_mode: 'set_motor_mode',
  look_at_speaker: 'look'
});

function createServiceError(message, status = 400, code = 'REACHY_INVALID_REQUEST') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function createUpdateCancelledError() {
  return createServiceError('Reachy companion update was cancelled', 503, 'REACHY_UPDATE_CANCELLED');
}

function throwIfUpdateCancelled(signal) {
  if (signal?.aborted) throw createUpdateCancelledError();
}

function delayWithSignal(milliseconds, signal) {
  throwIfUpdateCancelled(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, Math.max(0, Number(milliseconds) || 0));
    const onAbort = () => {
      clearTimeout(timer);
      reject(createUpdateCancelledError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimString(value, maxLength = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeReceiptTimestamp(value) {
  const numeric = Number(value);
  const timestamp = new Date(
    Number.isFinite(numeric) && numeric > 0 && numeric < 10_000_000_000
      ? numeric * 1000
      : value
  );
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function normalizeReleaseIdentity(value, timestampKey, fallbackRequestId = '') {
  if (!isRecord(value)) return null;
  const requestId = trimString(value.requestId || fallbackRequestId, 100);
  const version = trimString(value.version, 100);
  const aggregateSha256 = trimString(value.aggregateSha256, 128).toLowerCase();
  if (!requestId || !version || !/^[a-f0-9]{64}$/.test(aggregateSha256)) return null;
  const normalized = { requestId, version, aggregateSha256 };
  const timestamp = normalizeReceiptTimestamp(value[timestampKey]);
  if (timestamp) normalized[timestampKey] = timestamp;
  return normalized;
}

// Launcher state is security-sensitive update evidence. Persist only the
// bounded, correlation-safe subset used to resume an interrupted transaction;
// never retain launcher paths, tracebacks, or arbitrary state-file fields.
function normalizeReleaseStatus(value) {
  if (!isRecord(value)) return null;
  const lastConfirmed = normalizeReleaseIdentity(value.lastConfirmed, 'confirmedAt');
  const lastStaged = normalizeReleaseIdentity(value.lastStaged, 'stagedAt');
  const lastAuthorizedIdentity = normalizeReleaseIdentity(value.lastAuthorized, 'authorizedAt');
  const lastAuthorized = lastAuthorizedIdentity
    ? { ...lastAuthorizedIdentity, launchReady: value.lastAuthorized?.launchReady === true }
    : null;
  const pendingIdentity = normalizeReleaseIdentity(value.pending, 'expiresAt');
  const pending = pendingIdentity
    ? {
        ...pendingIdentity,
        attempts: Math.max(0, Math.min(1000, Math.round(Number(value.pending?.attempts) || 0))),
        launchReady: value.pending?.launchReady === true
      }
    : null;
  const stagedEntries = isRecord(value.stagedRequests)
    ? Object.entries(value.stagedRequests).map(([requestId, receipt]) => (
        normalizeReleaseIdentity(receipt, 'stagedAt', requestId)
      )).filter(Boolean)
    : [];
  stagedEntries.sort((left, right) => (
    new Date(right.stagedAt || 0).getTime() - new Date(left.stagedAt || 0).getTime()
  ));
  const stagedRequests = Object.fromEntries(
    stagedEntries.slice(0, 64).map((receipt) => [receipt.requestId, {
      version: receipt.version,
      aggregateSha256: receipt.aggregateSha256,
      ...(receipt.stagedAt ? { stagedAt: receipt.stagedAt } : {})
    }])
  );
  if (!lastConfirmed && !lastStaged && !lastAuthorized && !pending && stagedEntries.length === 0) return null;
  return { lastConfirmed, lastStaged, lastAuthorized, pending, stagedRequests };
}

function normalizeDaemonReport(value) {
  if (!isRecord(value)) return null;
  const daemonVersion = trimString(value.daemonVersion, 100) || null;
  const state = trimString(value.state, 64).toLowerCase() || null;
  const wireless = typeof value.wireless === 'boolean' ? value.wireless : null;
  const simulation = typeof value.simulation === 'boolean' ? value.simulation : null;
  if (!daemonVersion && !state && wireless === null && simulation === null) return null;
  return { daemonVersion, wireless, simulation, state };
}

function releaseReceiptMatches(receipt, identity) {
  if (!isRecord(receipt)) return false;
  return trimString(receipt.requestId, 100) === trimString(identity.requestId, 100)
    && trimString(receipt.version, 100) === trimString(identity.version, 100)
    && trimString(receipt.aggregateSha256, 128).toLowerCase()
      === trimString(identity.aggregateSha256, 128).toLowerCase();
}

function releaseRequestId(parentRequestId) {
  const parent = trimString(parentRequestId, 100);
  if (!parent) return crypto.randomUUID();
  return `release-${crypto.createHash('sha256').update(parent, 'utf8').digest('hex').slice(0, 32)}`;
}

function normalizeUnitId(value, options = {}) {
  if (value === undefined || value === null || value === '') {
    if (options.required === true) {
      throw createServiceError(
        'Reachy did not report its stable hardware identity',
        403,
        'REACHY_IDENTITY_REQUIRED'
      );
    }
    return '';
  }
  if (typeof value !== 'string') {
    throw createServiceError('Reachy hardware identity must be a string', 400, 'REACHY_IDENTITY_INVALID');
  }
  const normalized = value.trim();
  if (!/^[a-f0-9]{16}$/.test(normalized)) {
    throw createServiceError(
      'Reachy hardware identity must be the 16-character lowercase daemon hardware ID',
      400,
      'REACHY_IDENTITY_INVALID'
    );
  }
  return normalized;
}

function identityFingerprint(value) {
  const normalized = normalizeUnitId(value);
  return normalized
    ? crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
    : null;
}

function clampNumber(value, minimum, maximum, fieldName) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
    throw createServiceError(`${fieldName} must be a number between ${minimum} and ${maximum}`);
  }
  return numeric;
}

function requireBoolean(value, fieldName) {
  if (typeof value !== 'boolean') {
    throw createServiceError(`${fieldName} must be a boolean`);
  }
  return value;
}

function rejectUnknownKeys(value, allowedKeys, context) {
  const source = isRecord(value) ? value : {};
  const unknown = Object.keys(source).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw createServiceError(`Unsupported ${context} parameter(s): ${unknown.join(', ')}`);
  }
}

function normalizeCommandName(value) {
  const normalized = trimString(value, 64).toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'look_at_speaker') {
    return 'look';
  }
  return COMMAND_ALIASES[normalized] || normalized;
}

function normalizeSemanticCommand(command, rawParameters = {}) {
  const normalizedCommand = normalizeCommandName(command);
  const parameters = isRecord(rawParameters) ? rawParameters : {};

  switch (normalizedCommand) {
    case 'wake':
    case 'sleep':
    case 'neutral':
    case 'stop':
    case 'release_app':
      rejectUnknownKeys(parameters, new Set(), normalizedCommand);
      return { command: normalizedCommand, parameters: {} };

    case 'look': {
      rejectUnknownKeys(parameters, new Set(['direction', 'durationMs']), normalizedCommand);
      const direction = trimString(parameters.direction || (normalizeCommandName(command) === 'look' && String(command).includes('speaker') ? 'speaker' : ''), 32).toLowerCase();
      if (!LOOK_DIRECTIONS.has(direction)) {
        throw createServiceError(`direction must be one of: ${Array.from(LOOK_DIRECTIONS).join(', ')}`);
      }
      const result = { direction };
      if (parameters.durationMs !== undefined) {
        result.durationMs = Math.round(clampNumber(
          parameters.durationMs,
          MIN_MOTION_DURATION_MS,
          MAX_MOTION_DURATION_MS,
          'durationMs'
        ));
      }
      return { command: normalizedCommand, parameters: result };
    }

    case 'play_emotion': {
      rejectUnknownKeys(parameters, new Set(['emotion', 'durationMs']), normalizedCommand);
      const emotion = trimString(parameters.emotion, 32).toLowerCase();
      if (!EMOTIONS.has(emotion)) {
        throw createServiceError(`emotion must be one of: ${Array.from(EMOTIONS).join(', ')}`);
      }
      const result = { emotion };
      if (parameters.durationMs !== undefined) {
        result.durationMs = Math.round(clampNumber(
          parameters.durationMs,
          MIN_MOTION_DURATION_MS,
          MAX_MOTION_DURATION_MS,
          'durationMs'
        ));
      }
      return { command: normalizedCommand, parameters: result };
    }

    case 'play_move': {
      rejectUnknownKeys(parameters, new Set(['move', 'durationMs']), normalizedCommand);
      const originalCommand = trimString(command, 64).toLowerCase().replace(/[\s-]+/g, '_');
      const move = trimString(parameters.move || (originalCommand === 'dance' ? 'dance' : ''), 32).toLowerCase();
      if (!MOVES.has(move)) {
        throw createServiceError(`move must be one of: ${Array.from(MOVES).join(', ')}`);
      }
      const result = { move };
      if (parameters.durationMs !== undefined) {
        result.durationMs = Math.round(clampNumber(
          parameters.durationMs,
          MIN_MOVE_DURATION_MS,
          MAX_MOTION_DURATION_MS,
          'durationMs'
        ));
      }
      return { command: normalizedCommand, parameters: result };
    }

    case 'set_antennas': {
      rejectUnknownKeys(parameters, new Set(['position', 'durationMs']), normalizedCommand);
      const position = trimString(parameters.position, 32).toLowerCase();
      const positions = new Set(['neutral', 'up', 'down', 'happy', 'sad', 'curious']);
      if (!positions.has(position)) {
        throw createServiceError(`position must be one of: ${Array.from(positions).join(', ')}`);
      }
      const result = { position };
      if (parameters.durationMs !== undefined) {
        result.durationMs = Math.round(clampNumber(
          parameters.durationMs,
          MIN_MOTION_DURATION_MS,
          MAX_MOTION_DURATION_MS,
          'durationMs'
        ));
      }
      return { command: normalizedCommand, parameters: result };
    }

    case 'set_body_yaw': {
      rejectUnknownKeys(parameters, new Set(['angleDeg']), normalizedCommand);
      return {
        command: normalizedCommand,
        parameters: { angleDeg: clampNumber(parameters.angleDeg, -45, 45, 'angleDeg') }
      };
    }

    case 'start_face_tracking':
    case 'stop_face_tracking':
      rejectUnknownKeys(parameters, new Set(), normalizedCommand);
      return { command: normalizedCommand, parameters: {} };

    case 'set_motor_mode': {
      rejectUnknownKeys(parameters, new Set(['mode']), normalizedCommand);
      const mode = trimString(parameters.mode, 32).toLowerCase();
      if (!MOTOR_MODES.has(mode)) {
        throw createServiceError(`mode must be one of: ${Array.from(MOTOR_MODES).join(', ')}`);
      }
      return { command: normalizedCommand, parameters: { mode } };
    }

    case 'set_volume': {
      rejectUnknownKeys(parameters, new Set(['volume']), normalizedCommand);
      return {
        command: normalizedCommand,
        parameters: { volume: Math.round(clampNumber(parameters.volume, 0, 100, 'volume')) }
      };
    }

    case 'set_microphone_volume':
      rejectUnknownKeys(parameters, new Set(['volume']), normalizedCommand);
      return {
        command: normalizedCommand,
        parameters: { volume: Math.round(clampNumber(parameters.volume, 0, 100, 'volume')) }
      };

    case 'snapshot': {
      rejectUnknownKeys(parameters, new Set(['quality']), normalizedCommand);
      const result = {};
      if (parameters.quality !== undefined) {
        result.quality = Math.round(clampNumber(parameters.quality, 10, 95, 'quality'));
      }
      return { command: normalizedCommand, parameters: result };
    }

    default:
      throw createServiceError(`Unsupported Reachy command: ${normalizedCommand || 'missing'}`);
  }
}

function getCommandDurationMs(command, parameters = {}) {
  if (Number.isFinite(Number(parameters.durationMs))) {
    return Number(parameters.durationMs);
  }
  switch (command) {
    case 'look': return 800;
    case 'set_antennas': return 500;
    case 'play_emotion': return parameters.emotion === 'neutral' ? 1_000 : 550;
    case 'play_move': return 1_000;
    case 'neutral': return 1_000;
    default: return 0;
  }
}

function normalizeCommandResultDetails(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, 500);
  if (depth >= 4) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((entry) => normalizeCommandResultDetails(entry, depth + 1));
  }
  if (!isRecord(value)) return null;
  const output = {};
  for (const [rawKey, entry] of Object.entries(value).slice(0, 32)) {
    const key = trimString(rawKey, 64);
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    output[key] = normalizeCommandResultDetails(entry, depth + 1);
  }
  return output;
}

function defaultSafeSettings() {
  return {
    wakeWordEnabled: true,
    microphoneEnabled: true,
    cameraEnabled: false,
    presenceDetectionEnabled: false,
    snapshotEnabled: false,
    allowHighRiskVoiceActions: false,
    speechDirectionEnabled: false,
    faceTrackingDefault: false,
    // Physical movement is opt-in. Reachy must never begin autonomous wobble
    // merely because it enrolled or reconnected to HomeBrain.
    idleMotionEnabled: false,
    defaultEmotion: 'neutral',
    speakerVolume: 50,
    microphoneVolume: 50,
    commandTtlMs: 15_000,
    telemetryIntervalMs: 15_000,
    visionMode: 'off'
  };
}

function normalizeSafeSettings(input = {}, options = {}) {
  if (!isRecord(input)) {
    throw createServiceError('settings must be an object');
  }
  rejectUnknownKeys(input, SAFE_SETTING_KEYS, 'settings');
  const output = options.mergeDefaults === false ? {} : defaultSafeSettings();

  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'wakeWordEnabled':
      case 'microphoneEnabled':
      case 'cameraEnabled':
      case 'presenceDetectionEnabled':
      case 'snapshotEnabled':
      case 'speechDirectionEnabled':
      case 'faceTrackingDefault':
      case 'idleMotionEnabled':
        output[key] = requireBoolean(value, key);
        break;
      case 'allowHighRiskVoiceActions':
        requireBoolean(value, key);
        if (value === true) {
          throw createServiceError('High-risk Reachy voice actions require a trusted confirmation channel and cannot be enabled');
        }
        output[key] = false;
        break;
      case 'speakerVolume':
      case 'microphoneVolume':
        output[key] = Math.round(clampNumber(value, 0, 100, key));
        break;
      case 'commandTtlMs':
        output[key] = Math.round(clampNumber(value, 1_000, 30_000, key));
        break;
      case 'telemetryIntervalMs':
        output[key] = Math.round(clampNumber(value, 5_000, 300_000, key));
        break;
      case 'defaultEmotion': {
        const emotion = trimString(value, 32).toLowerCase();
        if (!EMOTIONS.has(emotion)) {
          throw createServiceError(`defaultEmotion must be one of: ${Array.from(EMOTIONS).join(', ')}`);
        }
        output[key] = emotion;
        break;
      }
      case 'visionMode': {
        const mode = trimString(value, 32).toLowerCase();
        if (!['off', 'on_demand', 'presence_only'].includes(mode)) {
          throw createServiceError('visionMode must be one of: off, on_demand, presence_only');
        }
        output[key] = mode;
        break;
      }
      default:
        break;
    }
  }

  if (output.cameraEnabled === false) {
    output.snapshotEnabled = false;
    output.faceTrackingDefault = false;
    output.presenceDetectionEnabled = false;
    if (output.visionMode === 'on_demand') {
      output.visionMode = 'off';
    }
  }
  if (output.visionMode === 'off') {
    output.presenceDetectionEnabled = false;
  }
  return output;
}

function normalizeCapabilities(input) {
  if (!Array.isArray(input)) {
    throw createServiceError('capabilities must be an array');
  }
  return Array.from(new Set(input
    .map((value) => trimString(value, 64).toLowerCase().replace(/[\s-]+/g, '_'))
    .filter((value) => CAPABILITIES.has(value))));
}

function normalizeCapabilityMetadata(input = {}) {
  if (!isRecord(input)) return { actions: [], emotions: [], moves: [], motorModes: [] };
  const actions = Array.isArray(input.actions)
    ? Array.from(new Set(input.actions.map(normalizeCommandName).filter((action) => SEMANTIC_ACTIONS.has(action))))
    : [];
  const emotions = Array.isArray(input.emotions)
    ? Array.from(new Set(input.emotions.map((value) => trimString(value, 32).toLowerCase()).filter((value) => EMOTIONS.has(value))))
    : [];
  const moves = Array.isArray(input.moves)
    ? Array.from(new Set(input.moves.map((value) => trimString(value, 32).toLowerCase()).filter((value) => MOVES.has(value))))
    : [];
  const motorModes = Array.isArray(input.motorModes)
    ? Array.from(new Set(input.motorModes.map((value) => trimString(value, 32).toLowerCase()).filter((value) => MOTOR_MODES.has(value))))
    : [];
  return { actions, emotions, moves, motorModes };
}

function normalizeWakeDetectorModels(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input.map((model) => {
    const basename = String(model || '').split(/[\\/]/).pop();
    return trimString(basename, 100);
  }).filter(Boolean))).slice(0, 16);
}

function normalizeRobotState(input = {}) {
  if (!isRecord(input)) {
    throw createServiceError('robot state must be an object');
  }
  const output = {};
  if (typeof input.sleeping === 'boolean') {
    output.mode = input.sleeping ? 'sleeping' : 'idle';
    output.awake = !input.sleeping;
  }
  const mode = trimString(input.mode, 32).toLowerCase();
  if (mode && ROBOT_MODES.has(mode)) output.mode = mode;
  const motorMode = trimString(input.motorMode, 32).toLowerCase();
  if (motorMode && MOTOR_MODES.has(motorMode)) output.motorMode = motorMode;
  if (typeof input.faceTracking === 'boolean') output.faceTracking = input.faceTracking;
  if (typeof input.personPresent === 'boolean') output.personPresent = input.personPresent;
  if (typeof input.speechDetected === 'boolean') output.speechDetected = input.speechDetected;
  if (typeof input.awake === 'boolean') output.awake = input.awake;
  if (input.speechDirection !== undefined && Number.isFinite(Number(input.speechDirection))) {
    output.speechDirection = Math.max(-180, Math.min(180, Number(input.speechDirection)));
  }
  if (input.speechConfidence !== undefined && Number.isFinite(Number(input.speechConfidence))) {
    output.speechConfidence = Math.max(0, Math.min(1, Number(input.speechConfidence)));
  }
  const activeMotion = trimString(input.activeMotion, 64);
  if (activeMotion) output.activeMotion = activeMotion;
  const lastAction = trimString(input.lastAction, 64);
  if (lastAction) output.lastAction = lastAction;
  const activeApp = trimString(input.activeApp, 100);
  if (activeApp) output.activeApp = activeApp;
  if (Number.isFinite(Number(input.temperatureC))) {
    output.temperatureC = Math.max(-20, Math.min(100, Number(input.temperatureC)));
  }
  return output;
}

function applyStatePrivacy(state = {}, safeSettings = {}) {
  const output = { ...(isRecord(state) ? state : {}) };
  if (safeSettings.speechDirectionEnabled !== true) {
    output.speechDetected = false;
    delete output.speechDirection;
    delete output.speechConfidence;
    delete output.speechDirectionAvailable;
  }
  return output;
}

function normalizeWorkflowAction(action = {}) {
  if (!isRecord(action)) {
    throw createServiceError('Reachy workflow action must be an object');
  }
  const parameters = isRecord(action.parameters) ? action.parameters : {};
  const command = normalizeCommandName(parameters.command || parameters.action);
  const target = trimString(
    typeof action.target === 'string'
      ? action.target
      : action.target?.deviceId || action.target?.id || parameters.deviceId,
    100
  );
  if (!target) {
    throw createServiceError('Reachy workflow action requires a robot target');
  }
  if (!command) {
    throw createServiceError('Reachy workflow action requires a command');
  }

  const nestedParameters = isRecord(parameters.commandParameters)
    ? parameters.commandParameters
    : Object.fromEntries(Object.entries(parameters).filter(([key]) => !WORKFLOW_META_PARAMETER_KEYS.has(key)));

  if (command === 'speak') {
    rejectUnknownKeys(nestedParameters, new Set(['text', 'message', 'voiceId']), 'speak');
    const text = trimString(nestedParameters.text || nestedParameters.message, MAX_SPEECH_LENGTH);
    if (!text) {
      throw createServiceError('Reachy speak action requires text');
    }
    return {
      target,
      command,
      parameters: {
        text,
        ...(trimString(nestedParameters.voiceId, 128) ? { voiceId: trimString(nestedParameters.voiceId, 128) } : {})
      }
    };
  }

  if (command === 'snapshot') {
    throw createServiceError(
      'Reachy snapshot is interactive/read-once and is not supported in workflows',
      400,
      'REACHY_WORKFLOW_SNAPSHOT_UNSUPPORTED'
    );
  }

  const normalized = normalizeSemanticCommand(command, nestedParameters);
  return { target, ...normalized };
}

function getReachySettings(device) {
  return isRecord(device?.settings?.reachy) ? device.settings.reachy : {};
}

function toId(value) {
  return value?._id?.toString?.() || value?.toString?.() || '';
}

function isPrivateReachyAddress(value) {
  const address = trimString(value, 100).replace(/^::ffff:/i, '');
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    return octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254);
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb');
  }
  return false;
}

function compareVersions(left, right) {
  const normalize = (value) => String(value || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .slice(0, 4)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const a = normalize(left);
  const b = normalize(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    if (av === bv) continue;
    if (typeof av === 'number' && typeof bv === 'number') return av < bv ? -1 : 1;
    return String(av).localeCompare(String(bv));
  }
  return 0;
}

class ReachyMiniService {
  constructor(options = {}) {
    this.voiceWebSocket = null;
    this.pendingCommands = new Map();
    this.commandResults = new Map();
    this.pendingStopPreemptions = new Map();
    this.robotEventDebounce = new Map();
    this.updateOperations = new Map();
    this.pendingAppManagement = new Map();
    this.pendingPrepareUpdates = new Map();
    this.pendingConfirmUpdates = new Map();
    this.pendingRollbackUpdates = new Map();
    this.interruptedUpdateResumes = new Set();
    this.updateRecoveryTimer = null;
    this.updateRecoveryRunning = false;
    this.shuttingDown = false;
    const reconnectAttempts = Number(options.reconnectAttempts);
    const reconnectIntervalMs = Number(options.reconnectIntervalMs);
    const commandTimeoutGraceMs = Number(options.commandTimeoutGraceMs);
    const daemonStatusPollAttempts = Number(options.daemonStatusPollAttempts);
    const daemonStatusPollIntervalMs = Number(options.daemonStatusPollIntervalMs);
    const updateLockTtlMs = Number(options.updateLockTtlMs);
    const managementAckTimeoutMs = Number(options.managementAckTimeoutMs);
    const managementRetryIntervalMs = Number(options.managementRetryIntervalMs);
    const requiredHealthReports = Number(options.requiredHealthReports);
    const updateRecoveryIntervalMs = Number(options.updateRecoveryIntervalMs);
    const confirmationReceiptAttempts = Number(options.confirmationReceiptAttempts);
    this.reconnectAttempts = Number.isFinite(reconnectAttempts) ? Math.max(1, reconnectAttempts) : 60;
    this.reconnectIntervalMs = Number.isFinite(reconnectIntervalMs) ? Math.max(0, reconnectIntervalMs) : 1_000;
    this.commandTimeoutGraceMs = Number.isFinite(commandTimeoutGraceMs) ? Math.max(0, commandTimeoutGraceMs) : 2_000;
    this.daemonStatusPollAttempts = Number.isFinite(daemonStatusPollAttempts) ? Math.max(1, daemonStatusPollAttempts) : 20;
    this.daemonStatusPollIntervalMs = Number.isFinite(daemonStatusPollIntervalMs) ? Math.max(0, daemonStatusPollIntervalMs) : 250;
    this.updateLockTtlMs = Number.isFinite(updateLockTtlMs) ? Math.max(1_000, updateLockTtlMs) : 15 * 60 * 1000;
    this.managementAckTimeoutMs = Number.isFinite(managementAckTimeoutMs) ? Math.max(100, managementAckTimeoutMs) : 12_000;
    this.managementRetryIntervalMs = Number.isFinite(managementRetryIntervalMs) ? Math.max(25, managementRetryIntervalMs) : 1_000;
    this.requiredHealthReports = Number.isFinite(requiredHealthReports) ? Math.max(1, Math.round(requiredHealthReports)) : 2;
    this.updateRecoveryIntervalMs = Number.isFinite(updateRecoveryIntervalMs) ? Math.max(100, updateRecoveryIntervalMs) : 30_000;
    this.confirmationReceiptAttempts = Number.isFinite(confirmationReceiptAttempts)
      ? Math.max(1, Math.round(confirmationReceiptAttempts))
      : 10;
  }

  setVoiceWebSocket(voiceWebSocket) {
    this.voiceWebSocket = voiceWebSocket || null;
  }

  isConnected(deviceId) {
    if (!this.voiceWebSocket) return false;
    if (typeof this.voiceWebSocket.isDeviceAuthenticated === 'function') {
      return this.voiceWebSocket.isDeviceAuthenticated(String(deviceId));
    }
    return Boolean(this.voiceWebSocket.deviceConnections?.get?.(String(deviceId))?.authenticated);
  }

  registerPendingCommand(deviceId, envelope, ttlMs) {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // API callers may intentionally poll instead of awaiting. Keep terminal
    // failures from becoming process-level unhandled rejections.
    promise.catch(() => {});
    const entry = {
      deviceId: String(deviceId),
      commandId: envelope.commandId,
      command: envelope.action,
      status: 'sent',
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      resolve: resolvePromise,
      reject: rejectPromise,
      promise,
      timer: null
    };
    entry.timer = setTimeout(() => {
      const error = createServiceError('Reachy command timed out before a terminal result', 504, 'REACHY_COMMAND_TIMEOUT');
      if (entry.command === 'stop') this.finalizeStopPreemption(entry.commandId, false);
      this.settlePendingCommand(entry, {
        commandId: entry.commandId,
        command: entry.command,
        status: 'failed',
        message: error.message,
        code: error.code,
        timestamp: new Date().toISOString()
      }, error);
    }, Math.max(1, Number(ttlMs) + this.commandTimeoutGraceMs));
    entry.timer.unref?.();
    this.pendingCommands.set(entry.commandId, entry);
    return entry;
  }

  settlePendingCommand(entry, result, error = null) {
    if (!entry || this.pendingCommands.get(entry.commandId) !== entry) return false;
    clearTimeout(entry.timer);
    this.pendingCommands.delete(entry.commandId);
    const stored = { ...result, deviceId: entry.deviceId, terminal: true };
    this.commandResults.set(entry.commandId, stored);
    const cleanup = setTimeout(() => this.commandResults.delete(entry.commandId), 5 * 60 * 1000);
    cleanup.unref?.();
    if (error) entry.reject(error);
    else entry.resolve(stored);
    return true;
  }

  markCommandsPreemptRequested(deviceId, stopCommandId) {
    const preempted = new Map();
    for (const entry of this.pendingCommands.values()) {
      if (entry.deviceId !== String(deviceId) || entry.commandId === stopCommandId || entry.command === 'stop') continue;
      preempted.set(entry.commandId, entry.status);
      entry.statusBeforePreempt = entry.status;
      entry.status = 'preempt_requested';
      entry.preemptedBy = stopCommandId;
    }
    if (preempted.size > 0) this.pendingStopPreemptions.set(stopCommandId, preempted);
    return preempted;
  }

  finalizeStopPreemption(stopCommandId, confirmed) {
    const preempted = this.pendingStopPreemptions.get(stopCommandId);
    this.pendingStopPreemptions.delete(stopCommandId);
    if (!preempted) return;
    for (const [commandId, previousStatus] of preempted.entries()) {
      const entry = this.pendingCommands.get(commandId);
      if (!entry || entry.preemptedBy !== stopCommandId) continue;
      delete entry.preemptedBy;
      delete entry.statusBeforePreempt;
      if (!confirmed) {
        entry.status = previousStatus || 'started';
        continue;
      }
      const error = createServiceError(
        'Reachy command was cancelled after emergency stop was confirmed',
        409,
        'REACHY_COMMAND_PREEMPTED'
      );
      this.settlePendingCommand(entry, {
        commandId: entry.commandId,
        command: entry.command,
        status: 'cancelled',
        message: error.message,
        code: error.code,
        preemptedBy: stopCommandId,
        timestamp: new Date().toISOString()
      }, error);
    }
  }

  failPendingCommandsForDevice(deviceId, code = 'REACHY_DISCONNECTED', message = 'Reachy disconnected before command completion') {
    for (const entry of this.pendingCommands.values()) {
      if (entry.deviceId !== String(deviceId)) continue;
      const error = createServiceError(message, 503, code);
      this.settlePendingCommand(entry, {
        commandId: entry.commandId,
        command: entry.command,
        status: 'failed',
        message,
        code,
        timestamp: new Date().toISOString()
      }, error);
    }
  }

  getCommandStatus(deviceId, commandId) {
    const normalizedId = trimString(commandId, 100);
    const pending = this.pendingCommands.get(normalizedId);
    if (pending && pending.deviceId === String(deviceId)) {
      return {
        commandId: pending.commandId,
        command: pending.command,
        status: pending.status,
        terminal: false,
        issuedAt: pending.issuedAt,
        expiresAt: pending.expiresAt
      };
    }
    const terminal = this.commandResults.get(normalizedId);
    if (terminal && terminal.deviceId === String(deviceId)) return { ...terminal };
    throw createServiceError('Reachy command correlation was not found', 404, 'REACHY_COMMAND_NOT_FOUND');
  }

  shutdown() {
    this.shuttingDown = true;
    clearInterval(this.updateRecoveryTimer);
    this.updateRecoveryTimer = null;
    // Disarm any possibly prepared candidate synchronously while the socket is
    // still OPEN. Abort handlers run in a later microtask, after a WebSocket
    // server may already have begun closing connections.
    for (const [deviceId, operation] of this.updateOperations.entries()) {
      const rollback = operation.rollback;
      if (
        operation.rollbackArmed === true
        && trimString(operation.requestId, 100)
        && trimString(rollback?.version, 100)
        && /^[a-f0-9]{64}$/i.test(trimString(rollback?.aggregateSha256, 128))
      ) {
        this.voiceWebSocket?.sendMessage?.(String(deviceId), {
          type: 'app_management',
          action: 'rollback',
          requestId: operation.requestId,
          version: rollback.version,
          aggregateSha256: rollback.aggregateSha256
        });
      }
      operation.controller.abort();
    }
    this.updateOperations.clear();
    for (const pending of this.pendingAppManagement.values()) {
      clearTimeout(pending.timer);
      clearInterval(pending.retryTimer);
      pending.reject(createUpdateCancelledError());
    }
    this.pendingAppManagement.clear();
    for (const pending of this.pendingPrepareUpdates.values()) {
      clearTimeout(pending.timer);
      clearInterval(pending.retryTimer);
      pending.reject(createUpdateCancelledError());
    }
    this.pendingPrepareUpdates.clear();
    for (const pending of this.pendingConfirmUpdates.values()) {
      clearTimeout(pending.timer);
      clearInterval(pending.retryTimer);
      pending.reject(createUpdateCancelledError());
    }
    this.pendingConfirmUpdates.clear();
    for (const pending of this.pendingRollbackUpdates.values()) {
      clearTimeout(pending.timer);
      clearInterval(pending.retryTimer);
      pending.reject(createUpdateCancelledError());
    }
    this.pendingRollbackUpdates.clear();
    for (const entry of Array.from(this.pendingCommands.values())) {
      const error = createServiceError('HomeBrain is shutting down', 503, 'REACHY_SERVER_SHUTDOWN');
      this.settlePendingCommand(entry, {
        commandId: entry.commandId,
        command: entry.command,
        status: 'failed',
        message: error.message,
        code: error.code,
        timestamp: new Date().toISOString()
      }, error);
    }
    this.commandResults.clear();
    this.pendingStopPreemptions.clear();
    this.robotEventDebounce.clear();
    this.interruptedUpdateResumes.clear();
  }

  cancelUpdateOperation(deviceId) {
    const operation = this.updateOperations.get(String(deviceId));
    if (operation) {
      operation.controller.abort();
      this.updateOperations.delete(String(deviceId));
    }
    for (const [requestId, pending] of this.pendingAppManagement.entries()) {
      if (pending.deviceId !== String(deviceId)) continue;
      clearTimeout(pending.timer);
      clearInterval(pending.retryTimer);
      pending.reject(createUpdateCancelledError());
      this.pendingAppManagement.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingPrepareUpdates.entries()) {
      if (pending.deviceId !== String(deviceId)) continue;
      clearTimeout(pending.timer);
      clearInterval(pending.retryTimer);
      pending.reject(createUpdateCancelledError());
      this.pendingPrepareUpdates.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingConfirmUpdates.entries()) {
      if (pending.deviceId !== String(deviceId)) continue;
      clearTimeout(pending.timer);
      clearInterval(pending.retryTimer);
      pending.reject(createUpdateCancelledError());
      this.pendingConfirmUpdates.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingRollbackUpdates.entries()) {
      if (pending.deviceId !== String(deviceId)) continue;
      clearTimeout(pending.timer);
      clearInterval(pending.retryTimer);
      pending.reject(createUpdateCancelledError());
      this.pendingRollbackUpdates.delete(requestId);
    }
    return Boolean(operation);
  }

  sanitizeRobot(device) {
    if (!device) return null;
    const reachy = getReachySettings(device);
    const safeSettings = normalizeSafeSettings(reachy.safeSettings || {}, { mergeDefaults: true });
    const wakeDetectorModels = normalizeWakeDetectorModels(reachy.wakeDetector?.models);
    const wakeDetectorActive = reachy.wakeDetector?.active === true && wakeDetectorModels.length > 0;
    const capabilities = Array.isArray(reachy.capabilities)
      ? reachy.capabilities.filter((capability) => capability !== 'wake_word' || (
          wakeDetectorActive && safeSettings.wakeWordEnabled && device.wakeWordSupport !== false
        ))
      : [];
    const id = toId(device);
    return {
      id,
      _id: id,
      name: device.name,
      room: device.room,
      deviceType: device.deviceType,
      status: device.status,
      // Persisted status is historical and may remain "online" after a hub
      // crash. Only a live authenticated socket authorizes robot controls.
      online: this.isConnected(id),
      registered: device.settings?.registered === true,
      brand: device.brand || 'Pollen Robotics',
      model: device.model || 'Reachy Mini Wireless',
      serialNumber: device.serialNumber || null,
      appVersion: reachy.appVersion || reachy.appManagement?.installedVersion || null,
      sdkVersion: trimString(reachy.sdkVersion, 100) || null,
      daemonVersion: trimString(reachy.daemonVersion || reachy.daemon?.daemonVersion, 100) || null,
      daemon: normalizeDaemonReport(reachy.daemon),
      lastSeen: device.lastSeen || null,
      lastInteraction: device.lastInteraction || null,
      volume: device.volume,
      microphoneSensitivity: device.microphoneSensitivity,
      unitId: reachy.unitId || null,
      protocolVersion: reachy.protocolVersion || REACHY_PROTOCOL_VERSION,
      genericDeviceId: reachy.genericDeviceId || null,
      capabilities,
      capabilityMetadata: normalizeCapabilityMetadata(reachy.capabilityMetadata || {}),
      supportedActions: normalizeCapabilityMetadata(reachy.capabilityMetadata || {}).actions,
      state: isRecord(reachy.state) ? reachy.state : {},
      privacyFault: trimString(reachy.privacyFault, 300) || null,
      lastError: trimString(reachy.lastError || reachy.state?.lastError, 500) || null,
      wakeDetector: {
        active: wakeDetectorActive,
        engine: trimString(reachy.wakeDetector?.engine, 64) || null,
        error: trimString(reachy.wakeDetector?.error, 300) || null,
        models: wakeDetectorModels
      },
      lastEvent: isRecord(reachy.lastEvent) ? reachy.lastEvent : null,
      lastCommand: isRecord(reachy.lastCommand) ? reachy.lastCommand : null,
      companion: isRecord(reachy.appManagement) ? reachy.appManagement : {
        installedVersion: reachy.appVersion || null,
        state: 'idle'
      },
      settings: safeSettings,
      onboarding: {
        state: device.settings?.lifecycle?.state || (device.settings?.registered === true ? 'activated' : 'pending'),
        registrationExpires: device.settings?.registrationExpires || null,
        claimTokenExpires: device.settings?.claimTokenExpires || null
      }
    };
  }

  async getRobots() {
    const devices = await VoiceDevice.find({ deviceType: REACHY_DEVICE_TYPE }).sort({ name: 1 });
    return devices.map((device) => this.sanitizeRobot(device));
  }

  async getRobot(deviceId) {
    if (!mongoose.Types.ObjectId.isValid(deviceId)) {
      throw createServiceError('Invalid Reachy device ID', 400, 'REACHY_INVALID_ID');
    }
    const device = await VoiceDevice.findOne({ _id: deviceId, deviceType: REACHY_DEVICE_TYPE });
    if (!device) {
      throw createServiceError('Reachy Mini not found', 404, 'REACHY_NOT_FOUND');
    }
    return device;
  }

  async resolveRobot(target) {
    const value = trimString(target, 200);
    if (!value) throw createServiceError('Reachy Mini target is required');
    const query = mongoose.Types.ObjectId.isValid(value)
      ? { _id: value, deviceType: REACHY_DEVICE_TYPE }
      : { name: { $regex: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }, deviceType: REACHY_DEVICE_TYPE };
    const device = await VoiceDevice.findOne(query);
    if (!device) throw createServiceError(`Reachy Mini not found: ${value}`, 404, 'REACHY_NOT_FOUND');
    return device;
  }

  async rejectUnitIdentity(device, reportedUnitId, code, message, status = 403) {
    void eventStreamService.publishSafe({
      type: 'reachy.identity_rejected',
      source: REACHY_DEVICE_SOURCE,
      category: 'security',
      severity: 'error',
      payload: {
        deviceId: toId(device),
        name: device?.name || null,
        code,
        reportedFingerprint: identityFingerprint(reportedUnitId),
        storedFingerprint: identityFingerprint(getReachySettings(device).unitId)
      },
      tags: ['reachy', 'security', 'identity']
    });
    throw createServiceError(message, status, code);
  }

  async bindRobotUnitIdentity(device, reportedUnitId, options = {}) {
    const required = options.required !== false;
    const unitId = normalizeUnitId(reportedUnitId, { required });
    if (!unitId) return device;
    const deviceId = toId(device);
    const storedUnitId = normalizeUnitId(getReachySettings(device).unitId);
    if (storedUnitId) {
      if (storedUnitId !== unitId) {
        return this.rejectUnitIdentity(
          device,
          unitId,
          'REACHY_IDENTITY_MISMATCH',
          'Reachy hardware identity does not match the identity bound to these credentials'
        );
      }
      return device;
    }

    const duplicateQuery = {
      _id: { $ne: device._id },
      deviceType: REACHY_DEVICE_TYPE,
      'settings.reachy.unitId': unitId
    };
    const duplicate = await VoiceDevice.findOne(duplicateQuery);
    if (duplicate) {
      return this.rejectUnitIdentity(
        device,
        unitId,
        'REACHY_IDENTITY_DUPLICATE',
        'This Reachy hardware identity is already bound to another HomeBrain device',
        409
      );
    }

    let bound = null;
    try {
      bound = await VoiceDevice.findOneAndUpdate({
        _id: device._id,
        deviceType: REACHY_DEVICE_TYPE,
        $or: [
          { 'settings.reachy.unitId': { $exists: false } },
          { 'settings.reachy.unitId': null },
          { 'settings.reachy.unitId': '' }
        ]
      }, {
        $set: {
          'settings.reachy.unitId': unitId,
          'settings.reachy.identityBoundAt': new Date()
        }
      }, {
        returnDocument: 'after',
        runValidators: true
      });
    } catch (error) {
      // The explicit duplicate lookup handles the common case. The unique
      // index closes the remaining cross-process race, which is translated to
      // the same stable service error rather than leaking a Mongo exception.
      if (error?.code !== 11000) throw error;
    }
    if (bound) {
      void eventStreamService.publishSafe({
        type: 'reachy.identity_bound',
        source: REACHY_DEVICE_SOURCE,
        category: 'security',
        payload: { deviceId, name: bound.name, identityFingerprint: identityFingerprint(unitId) },
        tags: ['reachy', 'security', 'identity']
      });
      return bound;
    }

    // Re-read both sides after a lost compare-and-set or duplicate-index race.
    // This makes same-identity reconnects idempotent and duplicate enrollment
    // failures deterministic without depending on a database error shape.
    const current = await this.getRobot(deviceId);
    const currentUnitId = normalizeUnitId(getReachySettings(current).unitId);
    if (currentUnitId === unitId) return current;
    if (currentUnitId) {
      return this.rejectUnitIdentity(
        current,
        unitId,
        'REACHY_IDENTITY_MISMATCH',
        'Reachy hardware identity changed while it was being bound'
      );
    }
    const racedDuplicate = await VoiceDevice.findOne(duplicateQuery);
    if (racedDuplicate) {
      return this.rejectUnitIdentity(
        current,
        unitId,
        'REACHY_IDENTITY_DUPLICATE',
        'This Reachy hardware identity is already bound to another HomeBrain device',
        409
      );
    }
    throw createServiceError(
      'Reachy hardware identity could not be bound atomically; retry authentication',
      409,
      'REACHY_IDENTITY_BIND_CONFLICT'
    );
  }

  async registerRobot(input = {}) {
    const name = trimString(input.name, 100);
    const room = trimString(input.room, 100);
    const unitId = normalizeUnitId(input.unitId);
    const serialNumber = trimString(input.serialNumber, 128);
    if (!name || !room) {
      throw createServiceError('name and room are required');
    }
    if (unitId) {
      const duplicate = await VoiceDevice.findOne({
        deviceType: REACHY_DEVICE_TYPE,
        'settings.reachy.unitId': unitId
      });
      if (duplicate) {
        throw createServiceError('A Reachy Mini with this unit ID is already registered', 409, 'REACHY_DUPLICATE');
      }
    }

    const safeSettings = normalizeSafeSettings(input.settings || {}, { mergeDefaults: true });
    const onboarding = buildOnboardingSettings({}, { state: 'registered' });
    const device = new VoiceDevice({
      name,
      room,
      deviceType: REACHY_DEVICE_TYPE,
      status: 'offline',
      brand: 'Pollen Robotics',
      model: 'Reachy Mini Wireless',
      ...(serialNumber ? { serialNumber } : {}),
      wakeWordSupport: true,
      supportedWakeWords: Array.isArray(input.supportedWakeWords) && input.supportedWakeWords.length
        ? input.supportedWakeWords.map((word) => trimString(word, 50)).filter(Boolean).slice(0, 8)
        : ['Anna'],
      voiceRecognitionEnabled: true,
      volume: safeSettings.speakerVolume,
      microphoneSensitivity: safeSettings.microphoneVolume,
      powerSource: 'both',
      connectionType: 'wifi',
      settings: {
        ...onboarding.settings,
        reachy: {
          protocolVersion: REACHY_PROTOCOL_VERSION,
          unitId: unitId || null,
          safeSettings,
          capabilities: [],
          state: { mode: 'released', motorMode: 'disabled', awake: false }
        }
      }
    });
    await device.save();
    await this.upsertMirroredDevice(device, { online: false });

    void eventStreamService.publishSafe({
      type: 'reachy.registered',
      source: REACHY_DEVICE_SOURCE,
      category: 'robot',
      payload: { deviceId: toId(device), name, room, unitId: unitId || null },
      tags: ['reachy', 'robot', 'onboarding']
    });

    return { device, onboarding };
  }

  async activateRobot(input = {}) {
    const registrationCode = trimString(input.registrationCode, 100);
    const claimToken = trimString(input.claimToken, 200);
    const deviceId = trimString(input.deviceId, 100);
    if (!registrationCode && !claimToken) {
      throw createServiceError('Registration code or claim token is required');
    }

    let device = null;
    let accessMethod = null;
    if (claimToken && deviceId) {
      const access = await validateDeviceAccess(deviceId, { claimToken }, {
        allowRegistrationCode: false,
        allowDeviceToken: false
      });
      if (access.authorized && access.device?.deviceType === REACHY_DEVICE_TYPE) {
        device = access.device;
        accessMethod = access.method;
      }
    }
    if (!device && registrationCode) {
      const candidate = await VoiceDevice.findOne({
        deviceType: REACHY_DEVICE_TYPE,
        'settings.registrationCode': registrationCode,
        'settings.registered': false
      });
      const access = validateDeviceCredentials(candidate, { registrationCode }, {
        allowClaimToken: false,
        allowDeviceToken: false
      });
      if (access.authorized) {
        device = candidate;
        accessMethod = access.method;
      }
    }
    if (!device) {
      throw createServiceError('Invalid or expired Reachy onboarding credentials', 404, 'REACHY_ONBOARDING_INVALID');
    }

    device = await this.bindRobotUnitIdentity(device, input.unitId, { required: true });
    const issued = issueDeviceToken();
    applyDeviceActivation(device, issued, {
      ipAddress: trimString(input.ipAddress, 100),
      firmwareVersion: trimString(input.firmwareVersion, 100)
    });
    const reachy = getReachySettings(device);
    device.settings.reachy = {
      ...reachy,
      unitId: reachy.unitId,
      protocolVersion: REACHY_PROTOCOL_VERSION
    };
    device.markModified?.('settings');
    await device.save();

    await this.upsertMirroredDevice(device, { online: true });

    void eventStreamService.publishSafe({
      type: 'reachy.activated',
      source: REACHY_DEVICE_SOURCE,
      category: 'robot',
      payload: { deviceId: toId(device), name: device.name, room: device.room, accessMethod },
      tags: ['reachy', 'robot', 'activation']
    });
    return { device, deviceToken: issued.deviceToken, accessMethod };
  }

  async reissueOnboarding(deviceId) {
    const device = await this.getRobot(deviceId);
    const onboarding = applyOnboardingReissue(device);
    await device.save();
    await reachySnapshotService.removeDevice(deviceId);
    // Credential rotation is an immediate revocation boundary, not merely a
    // database update. Drain robot work and close both active and in-flight
    // authentication sockets only after the new onboarding state is durable.
    this.cancelUpdateOperation(deviceId);
    this.failPendingCommandsForDevice(
      deviceId,
      'REACHY_CREDENTIALS_REISSUED',
      'Reachy credentials were reissued before command completion'
    );
    this.voiceWebSocket?.revokeDeviceCredentials?.(String(deviceId));
    await this.voiceWebSocket?.waitForDeviceMessages?.(String(deviceId));
    // An already-admitted telemetry handler may have held an older Mongoose
    // snapshot when rotation began. Reassert the new credential generation
    // after that bounded per-device queue drains so stale status cannot restore
    // the old token or online state.
    device.status = 'offline';
    device.markModified?.('settings');
    await device.save();
    await this.upsertMirroredDevice(device, { online: false });
    void eventStreamService.publishSafe({
      type: 'reachy.onboarding_reissued',
      source: REACHY_DEVICE_SOURCE,
      category: 'security',
      payload: { deviceId: toId(device), expiresAt: onboarding.registrationExpires },
      tags: ['reachy', 'security', 'onboarding']
    });
    return { device, onboarding };
  }

  async updateSettings(deviceId, input) {
    const device = await this.getRobot(deviceId);
    const reachy = getReachySettings(device);
    const current = normalizeSafeSettings(reachy.safeSettings || {}, { mergeDefaults: true });
    const patch = normalizeSafeSettings(input, { mergeDefaults: false });
    const safeSettings = normalizeSafeSettings({ ...current, ...patch }, { mergeDefaults: true });
    const state = { ...(isRecord(reachy.state) ? reachy.state : {}) };
    if (!safeSettings.cameraEnabled || !safeSettings.presenceDetectionEnabled) {
      state.personPresent = false;
    }
    if (!safeSettings.cameraEnabled) {
      state.faceTracking = false;
      state.cameraActive = false;
    }
    if (!safeSettings.microphoneEnabled || !safeSettings.wakeWordEnabled) {
      state.speechDetected = false;
      state.voiceSessionActive = false;
      if (['listening', 'thinking'].includes(state.mode)) state.mode = 'idle';
    }
    if (!safeSettings.speechDirectionEnabled) {
      state.speechDetected = false;
      delete state.speechDirection;
      delete state.speechConfidence;
      delete state.speechDirectionAvailable;
    }
    state.updatedAt = new Date();
    device.volume = safeSettings.speakerVolume;
    device.microphoneSensitivity = safeSettings.microphoneVolume;
    device.settings.reachy = { ...reachy, safeSettings, state };
    device.markModified?.('settings');
    await device.save();
    if (!safeSettings.cameraEnabled || !safeSettings.snapshotEnabled) {
      await reachySnapshotService.removeDevice(deviceId);
    }

    const liveConnection = this.voiceWebSocket?.deviceConnections?.get?.(String(deviceId));
    if (liveConnection) liveConnection.device = device;
    if (!safeSettings.microphoneEnabled || !safeSettings.wakeWordEnabled) {
      this.voiceWebSocket?.audioSessions?.delete?.(String(deviceId));
      if (liveConnection) {
        liveConnection.pendingWakeWord = null;
        liveConnection.captureGrant = null;
      }
    }

    // Clear privacy-derived state in the generic device mirror before the new
    // configuration is delivered. No ordinary presence event is emitted, so
    // disabling a sensor cannot itself trigger occupancy automations.
    await this.upsertMirroredDevice(device, { online: this.isConnected(deviceId), state });

    if (this.isConnected(deviceId)) {
      this.voiceWebSocket.sendMessage(String(deviceId), {
        type: 'robot_config_update',
        protocolVersion: REACHY_PROTOCOL_VERSION,
        settings: safeSettings,
        timestamp: new Date().toISOString()
      });
    }
    void eventStreamService.publishSafe({
      type: 'reachy.settings_updated',
      source: REACHY_DEVICE_SOURCE,
      category: 'robot',
      payload: { deviceId: toId(device), changedKeys: Object.keys(patch) },
      tags: ['reachy', 'configuration']
    });
    return device;
  }

  buildRobotConfig(device) {
    const reachy = getReachySettings(device);
    return {
      protocolVersion: REACHY_PROTOCOL_VERSION,
      unitId: reachy.unitId || null,
      settings: normalizeSafeSettings(reachy.safeSettings || {}, { mergeDefaults: true }),
      inboundMessageTypes: ['robot_capabilities', 'robot_state', 'robot_event', 'robot_command_result'],
      outboundMessageTypes: ['robot_command', 'robot_config_update', 'tts_response', 'status_request', 'app_management']
    };
  }

  async upsertMirroredDevice(voiceDevice, options = {}) {
    if (!voiceDevice) return null;
    const voiceDeviceId = toId(voiceDevice);
    const reachy = getReachySettings(voiceDevice);
    const state = { ...(isRecord(reachy.state) ? reachy.state : {}), ...(isRecord(options.state) ? options.state : {}) };
    const online = options.online !== undefined ? options.online === true : voiceDevice.status === 'online';
    const awake = typeof state.awake === 'boolean'
      ? state.awake
      : !['sleeping', 'released', 'error'].includes(state.mode);
    const query = reachy.genericDeviceId && mongoose.Types.ObjectId.isValid(reachy.genericDeviceId)
      ? { _id: reachy.genericDeviceId }
      : { 'properties.reachy.voiceDeviceId': voiceDeviceId };
    const update = {
      $set: {
        name: voiceDevice.name,
        type: 'robot',
        room: voiceDevice.room,
        status: Boolean(online && awake),
        isOnline: online,
        lastSeen: voiceDevice.lastSeen || new Date(),
        brand: voiceDevice.brand || 'Pollen Robotics',
        model: voiceDevice.model || 'Reachy Mini Wireless',
        'properties.source': REACHY_DEVICE_SOURCE,
        'properties.reachy.voiceDeviceId': voiceDeviceId,
        'properties.reachy.unitId': reachy.unitId || null,
        'properties.reachy.protocolVersion': reachy.protocolVersion || REACHY_PROTOCOL_VERSION,
        'properties.reachy.capabilities': Array.isArray(reachy.capabilities) ? reachy.capabilities : [],
        'properties.reachy.state': state,
        'properties.reachy.connected': online,
        updatedAt: new Date()
      },
      $setOnInsert: { groups: [], createdAt: new Date() }
    };
    const mirrored = await Device.findOneAndUpdate(query, update, {
      upsert: true,
      returnDocument: 'after',
      runValidators: true,
      setDefaultsOnInsert: true
    });
    const mirroredId = toId(mirrored);
    if (mirroredId && reachy.genericDeviceId !== mirroredId) {
      voiceDevice.settings.reachy = { ...reachy, genericDeviceId: mirroredId, state };
      voiceDevice.markModified?.('settings');
      await voiceDevice.save();
    }
    if (mirrored) {
      deviceUpdateEmitter.emit('devices:update', deviceUpdateEmitter.normalizeDevice(mirrored));
    }
    return mirrored;
  }

  async handleConnected(deviceId, deviceInfo = {}) {
    let device = await this.getRobot(deviceId);
    device = await this.bindRobotUnitIdentity(device, deviceInfo.unitId, { required: true });
    const reachy = getReachySettings(device);
    let capabilities = Array.isArray(deviceInfo.capabilities)
      ? normalizeCapabilities(deviceInfo.capabilities)
      : (reachy.capabilities || []);
    const safeSettings = normalizeSafeSettings(reachy.safeSettings || {}, { mergeDefaults: true });
    const wakeDetectorActive = deviceInfo.wakeDetector?.active === true
      || (Array.isArray(deviceInfo.capabilities) && deviceInfo.capabilities.includes('wake_word'));
    if (!safeSettings.wakeWordEnabled || !device.wakeWordSupport || !device.supportedWakeWords?.length || !wakeDetectorActive) {
      capabilities = capabilities.filter((capability) => capability !== 'wake_word');
    }
    const state = normalizeRobotState(deviceInfo.state || {});
    const peerAddress = trimString(deviceInfo.peerAddress, 100).replace(/^::ffff:/i, '');
    device.status = 'online';
    device.lastSeen = new Date();
    device.settings.reachy = {
      ...reachy,
      unitId: reachy.unitId,
      capabilities,
      capabilityMetadata: normalizeCapabilityMetadata(deviceInfo.capabilityMetadata || reachy.capabilityMetadata || {}),
      appVersion: trimString(deviceInfo.package?.version || deviceInfo.appVersion || deviceInfo.version, 100) || reachy.appVersion || null,
      appPackage: trimString(deviceInfo.package?.package, 100) || reachy.appPackage || null,
      appAggregateSha256: trimString(deviceInfo.package?.aggregateSha256, 128) || reachy.appAggregateSha256 || null,
      sdkVersion: trimString(deviceInfo.package?.reachySdkVersion || deviceInfo.sdkVersion, 100)
        || reachy.sdkVersion
        || null,
      daemon: normalizeDaemonReport(deviceInfo.package?.daemon) || reachy.daemon || null,
      daemonVersion: trimString(deviceInfo.package?.daemon?.daemonVersion || deviceInfo.daemonVersion, 100)
        || reachy.daemonVersion
        || null,
      launcherVersion: trimString(deviceInfo.package?.launcherVersion, 100) || reachy.launcherVersion || null,
      launcherApi: Number.isInteger(Number(deviceInfo.package?.launcherApi))
        ? Number(deviceInfo.package.launcherApi)
        : (reachy.launcherApi || null),
      launcherFingerprint: trimString(deviceInfo.package?.launcherFingerprint, 128).toLowerCase()
        || reachy.launcherFingerprint
        || null,
      dependencyFingerprint: trimString(deviceInfo.package?.dependencyFingerprint, 128).toLowerCase()
        || reachy.dependencyFingerprint
        || null,
      releaseStatus: normalizeReleaseStatus(deviceInfo.package?.releaseStatus)
        || reachy.releaseStatus
        || null,
      daemonAddress: isPrivateReachyAddress(peerAddress) ? peerAddress : (reachy.daemonAddress || null),
      wakeDetector: {
        active: wakeDetectorActive,
        engine: trimString(deviceInfo.wakeDetector?.engine, 64) || null,
        error: trimString(deviceInfo.wakeDetector?.error, 300) || null,
        models: normalizeWakeDetectorModels(deviceInfo.wakeDetector?.models)
      },
      state: applyStatePrivacy({ ...(reachy.state || {}), ...state }, safeSettings),
      connectedAt: new Date()
    };
    device.markModified?.('settings');
    await device.save();
    await this.upsertMirroredDevice(device, { online: true, state });
    void eventStreamService.publishSafe({
      type: 'reachy.online',
      source: REACHY_DEVICE_SOURCE,
      category: 'robot',
      payload: { deviceId, name: device.name, capabilities },
      tags: ['reachy', 'connectivity']
    });
    this.scheduleInterruptedUpdateResume(deviceId, device.settings.reachy.appManagement);
    return device;
  }

  async findInterruptedUpdateDevices() {
    if (mongoose.connection.readyState !== 1) return [];
    return VoiceDevice.find({
      deviceType: REACHY_DEVICE_TYPE,
      'settings.reachy.appManagement.state': { $in: ['staging', 'staged', 'updating'] },
      'settings.reachy.appManagement.requestId': { $type: 'string', $ne: '' }
    });
  }

  async initializeUpdateRecovery() {
    if (this.shuttingDown) return;
    await this.reconcileInterruptedUpdates();
    if (this.updateRecoveryTimer || this.shuttingDown) return;
    this.updateRecoveryTimer = setInterval(() => {
      void this.reconcileInterruptedUpdates().catch((error) => {
        console.warn(`ReachyMiniService: periodic update recovery failed: ${error.message}`);
      });
    }, this.updateRecoveryIntervalMs);
    this.updateRecoveryTimer.unref?.();
  }

  async reconcileInterruptedUpdates() {
    if (this.shuttingDown || this.updateRecoveryRunning) return [];
    this.updateRecoveryRunning = true;
    const results = [];
    try {
      const devices = await this.findInterruptedUpdateDevices();
      for (const device of devices) {
        if (this.shuttingDown) break;
        const deviceId = toId(device);
        const reachy = getReachySettings(device);
        const management = isRecord(reachy.appManagement) ? reachy.appManagement : {};
        if (!deviceId || !trimString(management.requestId, 100)) continue;
        if (this.updateOperations.has(deviceId) || this.interruptedUpdateResumes.has(deviceId)) {
          results.push({ deviceId, action: 'active' });
          continue;
        }
        if (this.isConnected(deviceId)) {
          results.push({ deviceId, action: this.scheduleInterruptedUpdateResume(deviceId, management) ? 'scheduled' : 'active' });
          continue;
        }
        if (!isPrivateReachyAddress(reachy.daemonAddress)) {
          results.push({ deviceId, action: 'waiting_for_private_address' });
          continue;
        }
        try {
          const daemonStatus = await this.getDaemonAppStatus(device);
          if (daemonStatus.name && daemonStatus.name !== REACHY_APP_NAME) {
            // An interrupted Reachy transaction never grants authority to stop
            // or replace a different daemon app.
            results.push({ deviceId, action: 'other_app_active', app: daemonStatus.name });
            continue;
          }
          const restartable = daemonStatus.state === 'done'
            || !daemonStatus.raw
            || (daemonStatus.name === REACHY_APP_NAME && ['error', 'stopping'].includes(daemonStatus.state));
          if (!restartable) {
            results.push({ deviceId, action: 'waiting_for_reconnect', daemonState: daemonStatus.state });
            continue;
          }
          await this.restartManagedApp(device, {
            deviceId,
            requestId: management.requestId,
            safeRelease: false
          });
          await this.updateAppManagementState(deviceId, {
            recovery: {
              ...(isRecord(management.recovery) ? management.recovery : {}),
              state: 'launcher_restarted_after_homebrain_crash',
              launcherRestartedAt: new Date()
            }
          });
          results.push({ deviceId, action: 'launcher_started' });
        } catch (error) {
          // Daemon availability is transient during robot boot. Preserve the
          // durable transaction and retry; never convert a recoverable offline
          // window into a terminal update failure.
          console.warn(`ReachyMiniService: deferred offline update recovery for ${deviceId}: ${error.message}`);
          results.push({ deviceId, action: 'deferred', error: trimString(error.message, 500) });
        }
      }
      return results;
    } finally {
      this.updateRecoveryRunning = false;
    }
  }

  scheduleInterruptedUpdateResume(deviceId, management = {}) {
    const id = String(deviceId);
    if (
      this.shuttingDown
      || !['staging', 'staged', 'updating'].includes(management?.state)
      || !trimString(management?.requestId, 100)
      || this.updateOperations.has(id)
      || this.interruptedUpdateResumes.has(id)
    ) {
      return false;
    }
    this.interruptedUpdateResumes.add(id);
    setImmediate(() => {
      this.resumeInterruptedCompanionUpdate(id).catch(async (error) => {
        if (['REACHY_UPDATE_CANCELLED', 'REACHY_UPDATE_OFFLINE'].includes(error.code)) return;
        console.error(`ReachyMiniService: interrupted update reconciliation failed for ${id}: ${error.message}`);
        try {
          await this.updateAppManagementState(id, {
            state: 'failed',
            error: error.message,
            failedAt: new Date(),
            recovery: { state: 'resume_failed', failedAt: new Date(), error: trimString(error.message, 500) }
          });
        } catch (_persistError) {
          // Best effort after a startup reconciliation failure.
        }
      }).finally(() => this.interruptedUpdateResumes.delete(id));
    });
    return true;
  }

  async resumeInterruptedCompanionUpdate(deviceId) {
    if (this.shuttingDown) throw createUpdateCancelledError();
    const device = await this.getRobot(deviceId);
    const reachy = getReachySettings(device);
    const management = isRecord(reachy.appManagement) ? reachy.appManagement : {};
    const result = {
      requestId: trimString(management.requestId, 100),
      version: trimString(management.targetVersion || management.version, 100),
      aggregateSha256: trimString(management.aggregateSha256, 128).toLowerCase()
    };
    if (!result.requestId || !result.version || !/^[a-f0-9]{64}$/.test(result.aggregateSha256)) {
      throw createServiceError('Interrupted Reachy update is missing its durable target identity', 409, 'REACHY_UPDATE_RESUME_INVALID');
    }
    if (management.state === 'staging') {
      if (!this.isConnected(deviceId)) {
        throw createServiceError('Reachy is offline while package staging is resumed', 503, 'REACHY_UPDATE_OFFLINE');
      }
      const manifestUrl = trimString(management.manifestUrl, 1000);
      if (!manifestUrl) {
        throw createServiceError('Interrupted Reachy staging is missing its durable manifest URL', 409, 'REACHY_UPDATE_RESUME_INVALID');
      }
      const sent = this.voiceWebSocket?.sendMessage?.(String(deviceId), {
        type: 'app_management',
        action: 'package_stage',
        requestId: result.requestId,
        manifestUrl
      });
      if (!sent) {
        throw createServiceError('Reachy disconnected while package staging was resumed', 503, 'REACHY_UPDATE_OFFLINE');
      }
      await this.updateAppManagementState(deviceId, {
        recovery: {
          ...(isRecord(management.recovery) ? management.recovery : {}),
          state: 'staging_replayed_after_homebrain_restart',
          replayedAt: new Date()
        },
        error: null
      });
      return { success: true, status: 'staging', replayed: true, ...result };
    }
    const runningTarget = trimString(reachy.appVersion, 100) === result.version
      && trimString(reachy.appAggregateSha256, 128).toLowerCase() === result.aggregateSha256;
    if (!runningTarget) {
      // The previous runtime is still active (for example HomeBrain restarted
      // after prepare but before release). Re-enter the idempotent prepare /
      // release path using the original durable correlation tuple.
      return this.activateStagedCompanionUpdate(deviceId, result);
    }
    if (this.updateOperations.has(String(deviceId))) {
      throw createServiceError('Reachy update reconciliation is already active', 409, 'REACHY_UPDATE_IN_PROGRESS');
    }
    const operation = { requestId: result.requestId, controller: new AbortController(), resumed: true };
    operation.rollback = {
      version: trimString(management.previousVersion, 100),
      aggregateSha256: trimString(management.previousAggregateSha256, 128).toLowerCase()
    };
    operation.rollbackArmed = Boolean(
      operation.rollback.version && /^[a-f0-9]{64}$/.test(operation.rollback.aggregateSha256)
    );
    this.updateOperations.set(String(deviceId), operation);
    const signal = operation.controller.signal;
    try {
      const baseline = Math.max(0, Number(reachy.healthReportSequence) || 0);
      const connectedAt = new Date(reachy.connectedAt || Date.now()).getTime();
      await this.waitForUpdatedReconnect(
        deviceId,
        result.version,
        result.aggregateSha256,
        new Date(Math.max(0, connectedAt - 1)),
        {
          signal,
          minimumHealthSequence: baseline + this.requiredHealthReports,
          healthRequestId: result.requestId
        }
      );
      if (!await this.waitForDurableReleaseAuthorization(deviceId, result, signal)) {
        throw createServiceError(
          'Interrupted Reachy update target lacked the exact durable launcher release receipt',
          409,
          'REACHY_RELEASE_RECEIPT_MISSING'
        );
      }
      const confirmation = await this.confirmCompanionUpdate(deviceId, result, signal);
      operation.rollbackArmed = false;
      await this.updateAppManagementState(deviceId, {
        state: 'completed',
        installedVersion: result.version,
        latestVersion: result.version,
        updateAvailable: false,
        lastUpdatedAt: new Date(),
        completedAt: new Date(),
        recovery: {
          state: confirmation.reconciled
            ? 'confirmation_receipt_reconciled_after_homebrain_restart'
            : 'resumed_after_homebrain_restart',
          completedAt: new Date()
        },
        error: null
      });
      return { success: true, status: 'completed', resumed: true, ...result };
    } catch (error) {
      if (error.code === 'REACHY_UPDATE_CANCELLED') throw error;
      const previousVersion = trimString(management.previousVersion, 100);
      const previousAggregateSha256 = trimString(management.previousAggregateSha256, 128).toLowerCase();
      if (!previousVersion || !/^[a-f0-9]{64}$/.test(previousAggregateSha256)) throw error;
      const recoveryStartedAt = new Date();
      const recoveryDevice = await this.getRobot(deviceId);
      const recoveryBaseline = Math.max(0, Number(getReachySettings(recoveryDevice).healthReportSequence) || 0);
      if (this.isConnected(deviceId)) {
        await this.requestRollbackUpdate(deviceId, {
          requestId: result.requestId,
          version: previousVersion,
          aggregateSha256: previousAggregateSha256
        }, signal);
      }
      await this.restartManagedApp(recoveryDevice, {
        signal,
        deviceId,
        requestId: result.requestId,
        safeRelease: false
      });
      await this.waitForUpdatedReconnect(
        deviceId,
        previousVersion,
        previousAggregateSha256,
        recoveryStartedAt,
        {
          signal,
          minimumHealthSequence: recoveryBaseline + this.requiredHealthReports,
          healthRequestId: result.requestId
        }
      );
      const rollbackError = createServiceError(
        `Interrupted Reachy update was rolled back after reconciliation failed: ${error.message}`,
        502,
        'REACHY_UPDATE_ROLLED_BACK'
      );
      await this.updateAppManagementState(deviceId, {
        state: 'failed',
        installedVersion: previousVersion,
        updateAvailable: true,
        failedAt: new Date(),
        error: rollbackError.message,
        recovery: { state: 'recovered_after_homebrain_restart', completedAt: new Date() }
      });
      throw rollbackError;
    } finally {
      if (this.updateOperations.get(String(deviceId)) === operation) {
        this.updateOperations.delete(String(deviceId));
      }
    }
  }

  async handleDisconnected(deviceId) {
    this.failPendingCommandsForDevice(deviceId);
    let device;
    try {
      device = await this.getRobot(deviceId);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
    device.status = 'offline';
    device.lastSeen = new Date();
    await device.save();
    await this.upsertMirroredDevice(device, { online: false });
    void eventStreamService.publishSafe({
      type: 'reachy.offline',
      source: REACHY_DEVICE_SOURCE,
      category: 'robot',
      payload: { deviceId, name: device.name },
      tags: ['reachy', 'connectivity']
    });
    return device;
  }

  async handleCapabilities(deviceId, message = {}) {
    const device = await this.getRobot(deviceId);
    let capabilities = normalizeCapabilities(message.capabilities);
    const reachy = getReachySettings(device);
    const safeSettings = normalizeSafeSettings(reachy.safeSettings || {}, { mergeDefaults: true });
    const wakeDetectorActive = message.wakeDetector?.active === true || capabilities.includes('wake_word');
    if (!safeSettings.wakeWordEnabled || !device.wakeWordSupport || !device.supportedWakeWords?.length || !wakeDetectorActive) {
      capabilities = capabilities.filter((capability) => capability !== 'wake_word');
    }
    device.settings.reachy = {
      ...reachy,
      capabilities,
      capabilityMetadata: normalizeCapabilityMetadata(message.metadata || message.capabilityMetadata || reachy.capabilityMetadata || {}),
      sdkVersion: trimString(message.package?.reachySdkVersion || message.sdkVersion, 100) || reachy.sdkVersion || null,
      daemon: normalizeDaemonReport(message.package?.daemon) || reachy.daemon || null,
      daemonVersion: trimString(message.package?.daemon?.daemonVersion || message.daemonVersion, 100)
        || reachy.daemonVersion
        || null,
      appVersion: trimString(message.package?.version, 100) || reachy.appVersion || null,
      appPackage: trimString(message.package?.package, 100) || reachy.appPackage || null,
      appAggregateSha256: trimString(message.package?.aggregateSha256, 128) || reachy.appAggregateSha256 || null,
      launcherVersion: trimString(message.package?.launcherVersion, 100) || reachy.launcherVersion || null,
      launcherApi: Number.isInteger(Number(message.package?.launcherApi))
        ? Number(message.package.launcherApi)
        : (reachy.launcherApi || null),
      launcherFingerprint: trimString(message.package?.launcherFingerprint, 128).toLowerCase()
        || reachy.launcherFingerprint
        || null,
      dependencyFingerprint: trimString(message.package?.dependencyFingerprint, 128).toLowerCase()
        || reachy.dependencyFingerprint
        || null,
      releaseStatus: normalizeReleaseStatus(message.package?.releaseStatus)
        || reachy.releaseStatus
        || null,
      wakeDetector: {
        active: wakeDetectorActive,
        engine: trimString(message.wakeDetector?.engine, 64) || null,
        error: trimString(message.wakeDetector?.error, 300) || null,
        models: normalizeWakeDetectorModels(message.wakeDetector?.models)
      },
      capabilitiesUpdatedAt: new Date()
    };
    device.markModified?.('settings');
    await device.save();
    await this.upsertMirroredDevice(device, { online: true });
    return capabilities;
  }

  async handleRuntimeStatus(deviceId, runtime = {}) {
    const device = await this.getRobot(deviceId);
    const reachy = getReachySettings(device);
    const packageReport = isRecord(runtime.package) ? runtime.package : {};
    const daemonReport = normalizeDaemonReport(packageReport.daemon);
    const wakeWord = isRecord(runtime.wakeWord) ? runtime.wakeWord : {};
    const safeSettings = normalizeSafeSettings(reachy.safeSettings || {}, { mergeDefaults: true });
    const state = applyStatePrivacy(normalizeRobotState(runtime.state || {}), safeSettings);
    const wakeDetectorActive = wakeWord.state === 'ready';
    let capabilities = Array.isArray(reachy.capabilities) ? reachy.capabilities : [];
    capabilities = wakeDetectorActive
      ? Array.from(new Set([...capabilities, 'wake_word']))
      : capabilities.filter((capability) => capability !== 'wake_word');
    const privacyFault = runtime.privacyFault == null ? null : (trimString(runtime.privacyFault, 300) || null);
    const privacyFaultChanged = Boolean(privacyFault && privacyFault !== reachy.privacyFault);
    const stateWithRuntime = { ...(reachy.state || {}), ...state };
    if (privacyFault) stateWithRuntime.lastError = privacyFault;
    else if (reachy.lastErrorSource === 'privacy') delete stateWithRuntime.lastError;
    const nextState = applyStatePrivacy(
      {
        ...stateWithRuntime,
        updatedAt: new Date()
      },
      safeSettings
    );
    device.lastSeen = new Date();
    device.status = 'online';
    device.settings.reachy = {
      ...reachy,
      appVersion: trimString(packageReport.version || runtime.version, 100) || reachy.appVersion || null,
      appPackage: trimString(packageReport.package, 100) || reachy.appPackage || null,
      appAggregateSha256: trimString(packageReport.aggregateSha256, 128) || reachy.appAggregateSha256 || null,
      launcherVersion: trimString(packageReport.launcherVersion, 100) || reachy.launcherVersion || null,
      launcherApi: Number.isInteger(Number(packageReport.launcherApi))
        ? Number(packageReport.launcherApi)
        : (reachy.launcherApi || null),
      launcherFingerprint: trimString(packageReport.launcherFingerprint, 128).toLowerCase()
        || reachy.launcherFingerprint
        || null,
      dependencyFingerprint: trimString(packageReport.dependencyFingerprint, 128).toLowerCase()
        || reachy.dependencyFingerprint
        || null,
      releaseStatus: normalizeReleaseStatus(packageReport.releaseStatus)
        || reachy.releaseStatus
        || null,
      sdkVersion: trimString(packageReport.reachySdkVersion, 100) || reachy.sdkVersion || null,
      daemon: daemonReport || reachy.daemon || null,
      daemonVersion: trimString(daemonReport?.daemonVersion, 100) || reachy.daemonVersion || null,
      pythonVersion: trimString(packageReport.pythonVersion || runtime.python, 100) || reachy.pythonVersion || null,
      privacyFault,
      lastError: privacyFault || (reachy.lastErrorSource === 'privacy' ? null : reachy.lastError || null),
      lastErrorSource: privacyFault ? 'privacy' : (reachy.lastErrorSource === 'privacy' ? null : reachy.lastErrorSource || null),
      capabilities,
      capabilityMetadata: normalizeCapabilityMetadata(runtime.capabilities || reachy.capabilityMetadata || {}),
      state: nextState,
      wakeDetector: {
        active: wakeDetectorActive,
        engine: trimString(wakeWord.engine, 64) || null,
        error: trimString(wakeWord.error, 300) || null,
        models: normalizeWakeDetectorModels(wakeWord.models)
      },
      healthReportSequence: Math.max(0, Number(reachy.healthReportSequence) || 0) + 1,
      healthReportAt: new Date()
    };
    device.markModified?.('settings');
    await device.save();
    // Publish the fail-closed database state before advancing the snapshot
    // epoch. An upload admitted from the prior state is then invalidated by
    // the purge, while any later upload sees the persisted privacy fault.
    if (privacyFaultChanged) {
      await reachySnapshotService.removeDevice(deviceId);
    }
    await this.upsertMirroredDevice(device, { online: true, state: nextState });
    return device.settings.reachy;
  }

  async handleRobotState(deviceId, message = {}) {
    const device = await this.getRobot(deviceId);
    let state = normalizeRobotState(message.state || message);
    if (Object.keys(state).length === 0) {
      throw createServiceError('robot_state did not contain supported state fields');
    }
    const reachy = getReachySettings(device);
    const safeSettings = normalizeSafeSettings(reachy.safeSettings || {}, { mergeDefaults: true });
    state = applyStatePrivacy(state, safeSettings);
    const nextState = applyStatePrivacy(
      { ...(reachy.state || {}), ...state, updatedAt: new Date() },
      safeSettings
    );
    device.status = state.mode === 'error' ? 'error' : 'online';
    device.lastSeen = new Date();
    device.settings.reachy = { ...reachy, state: nextState };
    device.markModified?.('settings');
    await device.save();
    await this.upsertMirroredDevice(device, { online: true, state: nextState });
    void eventStreamService.publishSafe({
      type: 'reachy.state_updated',
      source: REACHY_DEVICE_SOURCE,
      category: 'robot',
      payload: { deviceId, state },
      tags: ['reachy', 'state']
    });
    return state;
  }

  normalizeRobotEvent(message = {}) {
    const source = { ...(isRecord(message.data) ? message.data : {}), ...message };
    const eventType = trimString(source.eventType || source.event, 64)
      .toLowerCase()
      .replace(/[\s.-]+/g, '_')
      .replace(/^robot_/, '');
    if (!ROBOT_EVENT_TYPES.has(eventType)) {
      throw createServiceError(`Unsupported Reachy event: ${eventType || 'missing'}`);
    }
    const event = {
      eventType,
      timestamp: Number.isFinite(new Date(source.timestamp).getTime())
        ? new Date(source.timestamp).toISOString()
        : new Date().toISOString()
    };
    for (const key of ['commandId', 'motion', 'emotion', 'errorCode', 'message', 'snapshotId', 'component']) {
      const value = trimString(source[key], key === 'message' ? 500 : 100);
      if (value) event[key] = value;
    }
    if (Number.isFinite(Number(source.direction))) {
      event.direction = Math.max(-180, Math.min(180, Number(source.direction)));
    }
    if (Number.isFinite(Number(source.confidence))) {
      event.confidence = Math.max(0, Math.min(1, Number(source.confidence)));
    }
    return event;
  }

  async handleRobotEvent(deviceId, message = {}) {
    const event = this.normalizeRobotEvent(message);
    const device = await this.getRobot(deviceId);
    const reachy = getReachySettings(device);
    const safeSettings = normalizeSafeSettings(reachy.safeSettings || {}, { mergeDefaults: true });
    if (['person_present', 'person_cleared'].includes(event.eventType)) {
      if (!safeSettings.cameraEnabled || !safeSettings.presenceDetectionEnabled) {
        return { ...event, ignored: true, reason: 'presence_privacy_disabled' };
      }
    }
    if (event.eventType === 'speech_detected' && !safeSettings.speechDirectionEnabled) {
      return { ...event, ignored: true, reason: 'speech_direction_privacy_disabled' };
    }
    const debounceKey = `${deviceId}:${event.eventType}`;
    const previousEventAt = this.robotEventDebounce.get(debounceKey) || 0;
    const debounceMs = event.eventType === 'speech_detected' ? 1_000 : 500;
    if (Date.now() - previousEventAt < debounceMs) {
      return { ...event, coalesced: true };
    }
    this.robotEventDebounce.set(debounceKey, Date.now());
    const statePatch = {};
    if (event.eventType === 'person_present') statePatch.personPresent = true;
    if (event.eventType === 'person_cleared') statePatch.personPresent = false;
    if (event.eventType === 'speech_detected') statePatch.speechDetected = true;
    if (event.eventType === 'voice_session_completed') statePatch.speechDetected = false;
    if (event.eventType === 'online') statePatch.mode = reachy.state?.mode || 'idle';
    if (event.eventType === 'offline') statePatch.mode = 'released';
    if (event.eventType === 'motion_started') {
      statePatch.mode = 'moving';
      if (event.motion) statePatch.activeMotion = event.motion;
    }
    if (['motion_completed', 'motion_stopped'].includes(event.eventType)) {
      statePatch.mode = 'idle';
      statePatch.activeMotion = null;
    }
    if (['error', 'motion_failed'].includes(event.eventType)) statePatch.mode = 'error';
    if (event.eventType === 'error' && event.message) statePatch.lastError = event.message;
    const nextState = { ...(reachy.state || {}), ...statePatch, updatedAt: new Date() };
    device.status = ['error', 'motion_failed'].includes(event.eventType)
      ? 'error'
      : event.eventType === 'offline' ? 'offline' : 'online';
    device.lastSeen = new Date();
    const privacyFault = event.eventType === 'error' && event.component === 'privacy'
      ? (event.message || 'Physical privacy state could not be confirmed')
      : reachy.privacyFault || null;
    const privacyFaultChanged = Boolean(privacyFault && privacyFault !== reachy.privacyFault);
    device.settings.reachy = {
      ...reachy,
      state: nextState,
      lastEvent: event,
      privacyFault,
      lastError: event.eventType === 'error' && event.message ? event.message : reachy.lastError || null,
      lastErrorSource: event.eventType === 'error' && event.message
        ? (event.component === 'privacy' ? 'privacy' : 'robot')
        : reachy.lastErrorSource || null
    };
    device.markModified?.('settings');
    await device.save();
    // Keep the same persistence-then-purge ordering as runtime_status so
    // there is no epoch at which an old permission snapshot can be adopted.
    if (privacyFaultChanged) {
      await reachySnapshotService.removeDevice(deviceId);
    }
    await this.upsertMirroredDevice(device, { online: event.eventType !== 'offline', state: nextState });

    void eventStreamService.publishSafe({
      type: `reachy.${event.eventType}`,
      source: REACHY_DEVICE_SOURCE,
      category: event.eventType.startsWith('person_') ? 'presence' : 'robot',
      severity: event.eventType === 'error' ? 'error' : 'info',
      payload: { deviceId, name: device.name, ...event },
      tags: ['reachy', 'robot', event.eventType]
    });
    return event;
  }

  async handleCommandResult(deviceId, message = {}) {
    const commandId = trimString(message.commandId, 100);
    const status = trimString(
      message.status || (message.success === true ? 'completed' : message.success === false ? 'failed' : ''),
      32
    ).toLowerCase();
    if (!commandId || !COMMAND_RESULT_STATUSES.has(status)) {
      throw createServiceError('robot_command_result requires a commandId and valid status');
    }
    const pending = this.pendingCommands.get(commandId);
    if (!pending || pending.deviceId !== String(deviceId)) {
      const duplicate = this.commandResults.get(commandId);
      return { ignored: true, duplicate: Boolean(duplicate), commandId, status };
    }
    const nestedError = isRecord(message.error) ? message.error : {};
    const errorCode = trimString(nestedError.code || message.code, 100) || null;
    const errorMessage = trimString(nestedError.message || message.message || (typeof message.error === 'string' ? message.error : ''), 500) || null;
    const result = {
      commandId,
      status,
      command: trimString(message.action || message.command?.action || message.command, 64) || pending.command,
      message: errorMessage,
      code: errorCode,
      ...(message.details !== undefined ? { details: normalizeCommandResultDetails(message.details) } : {}),
      timestamp: new Date().toISOString()
    };
    pending.status = status;
    const terminal = ['completed', 'failed', 'cancelled', 'rejected'].includes(status);
    if (terminal) {
      const failure = status === 'completed'
        ? null
        : createServiceError(
            result.message || `Reachy command ${status}`,
            502,
            result.code || `REACHY_COMMAND_${status.toUpperCase()}`
          );
      this.settlePendingCommand(pending, result, failure);
      if (pending.command === 'stop') {
        this.finalizeStopPreemption(commandId, status === 'completed');
      }
    }

    // The robot's terminal result is authoritative. Resolve/reject waiting
    // callers and emergency-stop preemption before any database I/O so a
    // transient persistence outage cannot turn a completed command into a
    // false timeout.
    let device = null;
    let persisted = false;
    try {
      device = await this.getRobot(deviceId);
      const reachy = getReachySettings(device);
      device.lastSeen = new Date();
      device.settings.reachy = { ...reachy, lastCommand: result };
      device.markModified?.('settings');
      await device.save();
      persisted = true;
    } catch (error) {
      console.warn(`ReachyMiniService: command result persistence failed for ${deviceId}: ${error.message}`);
    }
    void eventStreamService.publishSafe({
      type: `reachy.command_${status}`,
      source: REACHY_DEVICE_SOURCE,
      category: 'robot',
      severity: ['failed', 'rejected'].includes(status) ? 'error' : 'info',
      payload: { deviceId, name: device?.name || null, persisted, ...result },
      correlationId: commandId,
      tags: ['reachy', 'command', status]
    });
    return { ...result, terminal, persisted };
  }

  async dispatchCommand(deviceId, command, parameters = {}, context = {}) {
    const executionAuthorized = () => (
      typeof context.authorizeExecution !== 'function'
      || context.authorizeExecution() === true
    );
    const device = await this.getRobot(deviceId);
    if (!executionAuthorized()) {
      throw createServiceError(
        'Reachy command authorization was revoked',
        409,
        'REACHY_AUTHORIZATION_REVOKED'
      );
    }
    if (device.settings?.registered !== true) {
      throw createServiceError('Reachy Mini has not completed onboarding', 409, 'REACHY_NOT_ACTIVATED');
    }
    const normalized = normalizeSemanticCommand(command, parameters);
    const safeSettings = normalizeSafeSettings(getReachySettings(device).safeSettings || {}, { mergeDefaults: true });
    const supportedActions = normalizeCapabilityMetadata(getReachySettings(device).capabilityMetadata || {}).actions;
    if (!['stop', 'stop_face_tracking'].includes(normalized.command) && !supportedActions.includes(normalized.command)) {
      throw createServiceError(
        `Reachy does not report support for ${normalized.command}`,
        409,
        'REACHY_CAPABILITY_UNAVAILABLE'
      );
    }
    if (normalized.command === 'snapshot' && (!safeSettings.cameraEnabled || !safeSettings.snapshotEnabled)) {
      throw createServiceError('Snapshots are disabled in Reachy privacy settings', 403, 'REACHY_CAMERA_DISABLED');
    }
    if (normalized.command === 'start_face_tracking' && !safeSettings.cameraEnabled) {
      throw createServiceError('Face tracking is disabled in Reachy camera privacy settings', 403, 'REACHY_CAMERA_DISABLED');
    }
    if (
      normalized.command === 'start_face_tracking'
      && Array.isArray(getReachySettings(device).capabilities)
      && !getReachySettings(device).capabilities.includes('face_tracking')
    ) {
      throw createServiceError('This Reachy does not report face-tracking capability', 409, 'REACHY_CAPABILITY_UNAVAILABLE');
    }
    if (!this.voiceWebSocket || !this.isConnected(deviceId)) {
      throw createServiceError('Reachy Mini is not connected', 409, 'REACHY_OFFLINE');
    }
    const requestedTtlMs = context.ttlMs === undefined
      ? Number(safeSettings.commandTtlMs || 15_000)
      : clampNumber(context.ttlMs, 1_000, 30_000, 'ttlMs');
    const minimumCommandTtlMs = getCommandDurationMs(normalized.command, normalized.parameters)
      + COMMAND_DURATION_TTL_MARGIN_MS;
    const ttlMs = Math.max(1_000, Math.min(30_000, Math.round(Math.max(
      requestedTtlMs,
      minimumCommandTtlMs
    ))));
    const issuedAt = new Date();
    const commandId = crypto.randomUUID();
    const commandPayload = {
      id: commandId,
      action: normalized.command,
      parameters: normalized.parameters,
      issuedAt: issuedAt.toISOString(),
      ttlMs
    };
    const envelope = {
      type: 'robot_command',
      protocolVersion: REACHY_PROTOCOL_VERSION,
      command: commandPayload,
      commandId,
      action: normalized.command,
      parameters: normalized.parameters,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
      ttlMs,
      source: trimString(context.source, 64) || 'api'
    };
    // getRobot is an asynchronous boundary. A credential rotation can replace
    // the device socket while that read is in flight, so the caller-bound
    // generation must still be current at the exact wire side-effect boundary.
    if (!executionAuthorized()) {
      throw createServiceError(
        'Reachy command authorization was revoked',
        409,
        'REACHY_AUTHORIZATION_REVOKED'
      );
    }
    const pending = this.registerPendingCommand(deviceId, envelope, ttlMs);
    if (normalized.command === 'stop') {
      this.markCommandsPreemptRequested(deviceId, commandId);
    }
    if (!executionAuthorized()) {
      const error = createServiceError(
        'Reachy command authorization was revoked',
        409,
        'REACHY_AUTHORIZATION_REVOKED'
      );
      if (normalized.command === 'stop') this.finalizeStopPreemption(commandId, false);
      this.settlePendingCommand(pending, {
        commandId,
        command: normalized.command,
        status: 'rejected',
        message: error.message,
        code: error.code,
        timestamp: new Date().toISOString()
      }, error);
      throw error;
    }
    if (!this.voiceWebSocket.sendMessage(String(deviceId), envelope)) {
      const error = createServiceError('Failed to send command to Reachy Mini', 503, 'REACHY_SEND_FAILED');
      if (normalized.command === 'stop') this.finalizeStopPreemption(commandId, false);
      this.settlePendingCommand(pending, {
        commandId,
        command: normalized.command,
        status: 'failed',
        message: error.message,
        code: error.code,
        timestamp: new Date().toISOString()
      }, error);
      throw error;
    }
    const reachy = getReachySettings(device);
    const commandSafeSettings = normalized.command === 'stop'
      ? { ...safeSettings, idleMotionEnabled: false }
      : safeSettings;
    device.lastInteraction = issuedAt;
    device.settings.reachy = {
      ...reachy,
      safeSettings: commandSafeSettings,
      state: normalized.command === 'stop'
        ? {
            ...(isRecord(reachy.state) ? reachy.state : {}),
            activeMotion: null,
            idleMotionEnabled: false,
            updatedAt: issuedAt
          }
        : reachy.state,
      lastCommand: {
        commandId,
        command: normalized.command,
        status: 'sent',
        issuedAt,
        expiresAt: envelope.expiresAt
      }
    };
    device.markModified?.('settings');
    if (normalized.command === 'stop') {
      // The stop command disables wobble in the running companion. Follow it on
      // the same ordered socket with the durable live policy so reconnects and
      // later config refreshes cannot silently re-enable autonomous motion.
      this.voiceWebSocket.sendMessage(String(deviceId), {
        type: 'robot_config_update',
        protocolVersion: REACHY_PROTOCOL_VERSION,
        settings: commandSafeSettings,
        timestamp: issuedAt.toISOString()
      });
      const liveConnection = this.voiceWebSocket?.deviceConnections?.get?.(String(deviceId));
      if (liveConnection) liveConnection.device = device;
    }
    // A successful WebSocket send is the authoritative side-effect boundary.
    // Persistence remains important for observability, but a database outage
    // after the robot starts moving must not report "send failed" and invite a
    // duplicate physical command on retry.
    void (async () => {
      try {
        await device.save();
      } catch (error) {
        console.warn(`ReachyMiniService: sent command persistence failed for ${deviceId}: ${error.message}`);
      }
    })();
    void eventStreamService.publishSafe({
      type: 'reachy.command_sent',
      source: REACHY_DEVICE_SOURCE,
      category: 'robot',
      actorUserId: context.actorUserId || undefined,
      payload: { deviceId: String(deviceId), name: device.name, command: normalized.command, commandId },
      correlationId: commandId,
      tags: ['reachy', 'command']
    });
    if (context.awaitTerminal === true) {
      return pending.promise;
    }
    return { ...envelope, status: 'sent', terminal: false };
  }

  async speak(deviceId, text, options = {}) {
    const device = await this.getRobot(deviceId);
    const normalizedText = trimString(text, MAX_SPEECH_LENGTH);
    if (!normalizedText) throw createServiceError('text is required');
    if (String(text).trim().length > MAX_SPEECH_LENGTH) {
      throw createServiceError(`text cannot exceed ${MAX_SPEECH_LENGTH} characters`);
    }
    if (device.settings?.registered !== true) {
      throw createServiceError('Reachy Mini has not completed onboarding', 409, 'REACHY_NOT_ACTIVATED');
    }
    if (!this.voiceWebSocket || !this.isConnected(deviceId)) {
      throw createServiceError('Reachy Mini is not connected', 409, 'REACHY_OFFLINE');
    }
    if (!Array.isArray(getReachySettings(device).capabilities) || !getReachySettings(device).capabilities.includes('audio_output')) {
      throw createServiceError('This Reachy does not report audio-output capability', 409, 'REACHY_CAPABILITY_UNAVAILABLE');
    }
    const voiceId = trimString(options.voiceId, 128);
    const commandId = crypto.randomUUID();
    const sent = voiceId
      ? this.voiceWebSocket.sendMessage(String(deviceId), {
          type: 'tts_response',
          text: normalizedText,
          voice: voiceId,
          commandId
        })
      : (await this.voiceWebSocket.playTtsToDevice(String(deviceId), normalizedText)).success;
    if (!sent) throw createServiceError('Failed to send speech to Reachy Mini', 503, 'REACHY_SEND_FAILED');
    void eventStreamService.publishSafe({
      type: 'reachy.speech_sent',
      source: REACHY_DEVICE_SOURCE,
      category: 'robot',
      actorUserId: options.actorUserId || undefined,
      payload: { deviceId: String(deviceId), name: device.name, commandId },
      correlationId: commandId,
      tags: ['reachy', 'speech']
    });
    return { commandId, sent: true };
  }

  async updateAppManagementState(deviceId, patch = {}) {
    const device = await this.getRobot(deviceId);
    const reachy = getReachySettings(device);
    const current = isRecord(reachy.appManagement) ? reachy.appManagement : {};
    const state = trimString(patch.state, 32);
    if (state && !APP_MANAGEMENT_STATES.has(state)) {
      throw createServiceError(`Invalid Reachy app management state: ${state}`);
    }
    device.settings.reachy = {
      ...reachy,
      appManagement: {
        ...current,
        ...patch,
        ...(state ? { state } : {}),
        updatedAt: new Date()
      }
    };
    device.markModified?.('settings');
    await device.save();
    if (['completed', 'failed', 'manual_reinstall_required', 'version_collision', 'downgrade_blocked'].includes(state)) {
      setImmediate(() => {
        try {
          const platformManagedService = require('./platformManagedService');
          platformManagedService.reconcileReachyFleetStatus?.().catch((error) => {
            console.warn(`ReachyMiniService: platform status reconciliation failed: ${error.message}`);
          });
        } catch (_error) {
          // Platform management is optional during isolated service tests/startup.
        }
      });
    }
    return device.settings.reachy.appManagement;
  }

  async getCompanionStatus(deviceId, options = {}) {
    const device = await this.getRobot(deviceId);
    const manifest = await reachyMiniPackageService.buildManifest({ force: options.force === true, runtimeOnly: true });
    const reachy = getReachySettings(device);
    const management = isRecord(reachy.appManagement) ? reachy.appManagement : {};
    // The authenticated runtime report is authoritative. Management state can
    // lag during a restart or rollback and must not mask what is really active.
    const installedVersion = trimString(reachy.appVersion || management.installedVersion, 100) || null;
    const versionComparison = installedVersion ? compareVersions(installedVersion, manifest.version) : -1;
    const installedAggregateSha256 = trimString(reachy.appAggregateSha256, 128).toLowerCase() || null;
    const versionCollision = Boolean(
      installedVersion
      && versionComparison === 0
      && installedAggregateSha256
      && installedAggregateSha256 !== manifest.aggregateSha256
    );
    const downgradeBlocked = Boolean(installedVersion && versionComparison > 0);
    const updateAvailable = Boolean(!versionCollision && !downgradeBlocked && versionComparison < 0);
    const integrityStatus = !installedAggregateSha256
      ? 'unknown'
      : versionCollision
        ? 'version_collision'
        : (versionComparison === 0 && installedAggregateSha256 === manifest.aggregateSha256)
            ? 'verified'
            : 'different_version';
    const targetCompatibility = isRecord(manifest.compatibility) ? manifest.compatibility : {};
    const launcherApi = Number(reachy.launcherApi);
    const dependencyFingerprint = trimString(reachy.dependencyFingerprint, 128).toLowerCase();
    const launcherFingerprint = trimString(reachy.launcherFingerprint, 128).toLowerCase();
    const compatibilityKnown = Number.isInteger(launcherApi)
      && launcherApi > 0
      && /^[a-f0-9]{64}$/.test(dependencyFingerprint)
      && /^[a-f0-9]{64}$/.test(launcherFingerprint);
    const manualReinstallRequired = installedVersion !== null && (
      targetCompatibility.requiresManualReinstall === true
      || !compatibilityKnown
      || launcherApi !== Number(targetCompatibility.launcherApi)
      || dependencyFingerprint !== trimString(targetCompatibility.dependencyFingerprint, 128).toLowerCase()
      || launcherFingerprint !== trimString(targetCompatibility.launcherFingerprint, 128).toLowerCase()
    );
    const unavailableReason = !device.settings?.registered
      ? 'Reachy onboarding is incomplete.'
      : !this.isConnected(deviceId)
        ? 'Reachy companion is offline.'
      : !isPrivateReachyAddress(reachy.daemonAddress)
          ? 'Reachy did not report a valid private-LAN IP address for daemon orchestration.'
          : null;
    return {
      deviceId: String(deviceId),
      name: trimString(device.name, 100) || 'Reachy Mini',
      room: trimString(device.room, 100) || null,
      online: this.isConnected(deviceId),
      installedVersion,
      installedAggregateSha256,
      latestVersion: manifest.version,
      updateAvailable,
      current: Boolean(
        installedVersion
        && versionComparison === 0
        && installedAggregateSha256
        && installedAggregateSha256 === manifest.aggregateSha256
      ),
      integrityStatus,
      provenance: installedAggregateSha256 ? 'reported_runtime' : 'bundled_unverified',
      versionCollision,
      downgradeBlocked,
      state: management.state || 'idle',
      lastCheckedAt: management.lastCheckedAt || null,
      lastUpdatedAt: management.lastUpdatedAt || null,
      unavailableReason,
      error: management.error || null,
      requestId: management.requestId || null,
      requestedAt: management.requestedAt || null,
      updateStartedAt: management.updateStartedAt || null,
      aggregateSha256: manifest.aggregateSha256,
      recovery: isRecord(management.recovery) ? management.recovery : null,
      compatibility: {
        launcherVersion: reachy.launcherVersion || null,
        launcherApi: compatibilityKnown ? launcherApi : null,
        dependencyFingerprint: compatibilityKnown ? dependencyFingerprint : null,
        launcherFingerprint: compatibilityKnown ? launcherFingerprint : null,
        target: targetCompatibility,
        status: manualReinstallRequired ? 'manual_reinstall_required' : compatibilityKnown ? 'compatible' : 'unknown'
      },
      manualReinstallRequired
    };
  }

  async checkCompanionUpdate(deviceId, options = {}) {
    const status = await this.getCompanionStatus(deviceId, { force: options.force === true });
    await this.updateAppManagementState(deviceId, {
      state: status.state === 'failed' ? 'idle' : status.state,
      installedVersion: status.installedVersion,
      latestVersion: status.latestVersion,
      updateAvailable: status.updateAvailable,
      aggregateSha256: status.aggregateSha256,
      compatibility: status.compatibility,
      manualReinstallRequired: status.manualReinstallRequired,
      versionCollision: status.versionCollision,
      downgradeBlocked: status.downgradeBlocked,
      lastCheckedAt: new Date(),
      error: null
    });
    return this.getCompanionStatus(deviceId);
  }

  async getCompanionFleetStatus(options = {}) {
    if (mongoose.connection.readyState !== 1) {
      const manifest = await reachyMiniPackageService.buildManifest({ force: options.force === true, runtimeOnly: true });
      return {
        installed: false,
        paired: false,
        setupRequired: true,
        active: false,
        currentVersion: '',
        latestVersion: manifest.version,
        updateAvailable: false,
        devices: []
      };
    }
    const robots = await VoiceDevice.find({ deviceType: REACHY_DEVICE_TYPE }).sort({ name: 1 });
    const statuses = [];
    for (const robot of robots) {
      try {
        statuses.push(await this.getCompanionStatus(toId(robot), options));
      } catch (error) {
        statuses.push({
          deviceId: toId(robot),
          name: trimString(robot.name, 100) || 'Reachy Mini',
          room: trimString(robot.room, 100) || null,
          online: this.isConnected(toId(robot)),
          installedVersion: getReachySettings(robot).appVersion || null,
          latestVersion: null,
          updateAvailable: false,
          state: 'failed',
          unavailableReason: error.message
        });
      }
    }
    const latestVersion = statuses.find((entry) => entry.latestVersion)?.latestVersion || null;
    const installedVersions = Array.from(new Set(statuses.map((entry) => entry.installedVersion).filter(Boolean)));
    return {
      paired: statuses.length > 0,
      installed: statuses.some((entry) => Boolean(entry.installedVersion)),
      setupRequired: statuses.length === 0 || statuses.some((entry) => !entry.installedVersion),
      active: statuses.some((entry) => !entry.unavailableReason),
      currentVersion: installedVersions.length === 1 ? installedVersions[0] : (installedVersions.length ? 'mixed' : ''),
      latestVersion: latestVersion || '',
      updateAvailable: statuses.some((entry) => entry.updateAvailable),
      devices: statuses
    };
  }

  async requestCompanionUpdate(deviceId, options = {}) {
    if (this.shuttingDown) throw createUpdateCancelledError();
    const status = await this.checkCompanionUpdate(deviceId, { force: true });
    if (status.unavailableReason) {
      throw createServiceError(status.unavailableReason, 409, 'REACHY_UPDATE_UNAVAILABLE');
    }
    if (status.manualReinstallRequired) {
      await this.updateAppManagementState(deviceId, {
        state: 'manual_reinstall_required',
        error: 'Reachy launcher/dependency compatibility changed; run the bootstrap installer again',
        lastCheckedAt: new Date()
      });
      throw createServiceError(
        'This Reachy update changes launcher or Python dependencies and requires a manual reinstall',
        409,
        'REACHY_MANUAL_REINSTALL_REQUIRED'
      );
    }
    if (status.versionCollision) {
      await this.updateAppManagementState(deviceId, {
        state: 'version_collision',
        error: 'The Reachy package changed without a version bump; publish a new version before updating',
        lastCheckedAt: new Date()
      });
      throw createServiceError(
        'Reachy package fingerprint changed without a version bump; increment the companion version before updating',
        409,
        'REACHY_VERSION_COLLISION'
      );
    }
    if (status.downgradeBlocked) {
      await this.updateAppManagementState(deviceId, {
        state: 'downgrade_blocked',
        error: 'Automatic Reachy companion downgrades are not supported',
        lastCheckedAt: new Date()
      });
      throw createServiceError(
        'The hub package is older than the installed Reachy companion; downgrade is blocked',
        409,
        'REACHY_DOWNGRADE_BLOCKED'
      );
    }
    if (['staging', 'staged', 'updating'].includes(status.state) && status.requestId) {
      const activeSince = new Date(status.updateStartedAt || status.requestedAt || 0).getTime();
      const locallyActive = this.updateOperations.has(String(deviceId))
        || this.interruptedUpdateResumes.has(String(deviceId))
        || this.pendingPrepareUpdates.has(status.requestId)
        || this.pendingConfirmUpdates.has(status.requestId);
      const stale = !locallyActive && (
        !Number.isFinite(activeSince)
        || activeSince <= 0
        || Date.now() - activeSince > this.updateLockTtlMs
      );
      if (!stale) {
        throw createServiceError(
          'A Reachy companion update is already in progress for this robot',
          409,
          'REACHY_UPDATE_IN_PROGRESS'
        );
      }
      await this.updateAppManagementState(deviceId, {
        state: 'failed',
        requestId: null,
        error: 'A stale Reachy update was recovered after HomeBrain restarted',
        failedAt: new Date(),
        recovery: { state: 'stale_operation_recovered', recoveredAt: new Date() }
      });
      status.state = 'failed';
      status.requestId = null;
    }
    if (!status.updateAvailable && options.force !== true) {
      return { ...status, accepted: false, reason: 'already_current' };
    }
    const requestId = crypto.randomUUID();
    const device = await this.getRobot(deviceId);
    const reachy = getReachySettings(device);
    const manifestUrl = trimString(options.manifestUrl, 1000)
      || `/api/reachy-mini/${deviceId}/companion/manifest`;
    const message = {
      type: 'app_management',
      action: 'package_stage',
      requestId,
      manifestUrl
    };
    await this.updateAppManagementState(deviceId, {
      state: 'staging',
      requestId,
      targetVersion: status.latestVersion,
      aggregateSha256: status.aggregateSha256,
      previousVersion: trimString(reachy.appVersion, 100) || null,
      previousAggregateSha256: trimString(reachy.appAggregateSha256, 128) || null,
      recovery: {
        state: 'armed',
        previousVersion: trimString(reachy.appVersion, 100) || null,
        previousAggregateSha256: trimString(reachy.appAggregateSha256, 128) || null
      },
      manifestUrl,
      requestedAt: new Date(),
      error: null
    });
    if (!this.voiceWebSocket?.sendMessage?.(String(deviceId), message)) {
      await this.updateAppManagementState(deviceId, {
        state: 'failed',
        error: 'Failed to request Reachy companion package staging',
        failedAt: new Date()
      });
      throw createServiceError('Failed to request Reachy companion package staging', 503, 'REACHY_SEND_FAILED');
    }
    void eventStreamService.publishSafe({
      type: 'reachy.companion_update_requested',
      source: REACHY_DEVICE_SOURCE,
      category: 'platform',
      actorUserId: options.actorUserId || undefined,
      payload: { deviceId: String(deviceId), requestId, targetVersion: status.latestVersion },
      correlationId: requestId,
      tags: ['reachy', 'update', 'companion']
    });
    return { ...status, accepted: true, state: 'staging', requestId };
  }

  async requestDaemon(device, method, endpoint, data = undefined, options = {}) {
    const address = trimString(getReachySettings(device).daemonAddress, 100).replace(/^::ffff:/i, '');
    if (!isPrivateReachyAddress(address)) {
      throw createServiceError('Reachy daemon address is not a private IP literal', 409, 'REACHY_DAEMON_ADDRESS_REJECTED');
    }
    if (!/^\/api\/apps\/[A-Za-z0-9_./-]*$/.test(endpoint) || endpoint.includes('..')) {
      throw createServiceError('Reachy daemon endpoint rejected', 500, 'REACHY_DAEMON_PATH_REJECTED');
    }
    const host = net.isIP(address) === 6 ? `[${address}]` : address;
    const response = await axios.request({
      method,
      url: `http://${host}:${REACHY_DAEMON_PORT}${endpoint}`,
      data,
      timeout: 8_000,
      maxRedirects: 0,
      proxy: false,
      maxContentLength: 1024 * 1024,
      maxBodyLength: 1024 * 1024,
      validateStatus: (status) => status >= 200 && status < 300,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: options.signal
    });
    return response.data;
  }

  async waitForUpdatedReconnect(deviceId, expectedVersion, expectedAggregateSha256, afterTime, options = {}) {
    const afterMs = new Date(afterTime).getTime();
    const normalizedVersion = trimString(expectedVersion, 100);
    const normalizedAggregate = trimString(expectedAggregateSha256, 128);
    const minimumHealthSequence = Math.max(0, Number(options.minimumHealthSequence) || 0);
    const healthRequestId = trimString(options.healthRequestId, 100) || crypto.randomUUID();
    for (let attempt = 0; attempt < this.reconnectAttempts; attempt += 1) {
      throwIfUpdateCancelled(options.signal);
      const device = await this.getRobot(deviceId);
      const reachy = getReachySettings(device);
      const connectedAt = new Date(reachy.connectedAt || 0).getTime();
      const healthReportAt = new Date(reachy.healthReportAt || 0).getTime();
      const identityMatches = this.isConnected(deviceId)
        && connectedAt > afterMs
        && (!normalizedVersion || trimString(reachy.appVersion, 100) === normalizedVersion)
        && (!normalizedAggregate || trimString(reachy.appAggregateSha256, 128) === normalizedAggregate);
      if (identityMatches) {
        if (
          Math.max(0, Number(reachy.healthReportSequence) || 0) >= minimumHealthSequence
          && healthReportAt > afterMs
        ) {
          return device;
        }
        this.voiceWebSocket?.sendMessage?.(String(deviceId), {
          type: 'status_request',
          requestId: healthRequestId
        });
      }
      await delayWithSignal(this.reconnectIntervalMs, options.signal);
    }
    throw createServiceError(
      'Updated Reachy companion did not reconnect with the expected version and package fingerprint',
      504,
      'REACHY_UPDATE_RECONNECT_TIMEOUT'
    );
  }

  async durableConfirmationMatches(deviceId, identity) {
    const device = await this.getRobot(deviceId);
    return releaseReceiptMatches(getReachySettings(device).releaseStatus?.lastConfirmed, identity);
  }

  async durableReleaseAuthorizationMatches(deviceId, identity) {
    const device = await this.getRobot(deviceId);
    return releaseReceiptMatches(getReachySettings(device).releaseStatus?.lastAuthorized, {
      requestId: releaseRequestId(identity.requestId),
      version: identity.version,
      aggregateSha256: identity.aggregateSha256
    });
  }

  async waitForDurableConfirmation(deviceId, identity, signal) {
    const statusRequestId = `confirm-proof-${crypto.createHash('sha256')
      .update(trimString(identity.requestId, 100), 'utf8')
      .digest('hex')
      .slice(0, 24)}`;
    for (let attempt = 0; attempt < this.confirmationReceiptAttempts; attempt += 1) {
      throwIfUpdateCancelled(signal);
      if (await this.durableConfirmationMatches(deviceId, identity)) return true;
      if (this.isConnected(deviceId)) {
        this.voiceWebSocket?.sendMessage?.(String(deviceId), {
          type: 'status_request',
          requestId: statusRequestId
        });
      }
      await delayWithSignal(this.reconnectIntervalMs, signal);
    }
    return this.durableConfirmationMatches(deviceId, identity);
  }

  async waitForDurableReleaseAuthorization(deviceId, identity, signal) {
    const statusRequestId = `release-proof-${crypto.createHash('sha256')
      .update(trimString(identity.requestId, 100), 'utf8')
      .digest('hex')
      .slice(0, 24)}`;
    for (let attempt = 0; attempt < this.confirmationReceiptAttempts; attempt += 1) {
      throwIfUpdateCancelled(signal);
      if (await this.durableReleaseAuthorizationMatches(deviceId, identity)) return true;
      if (this.isConnected(deviceId)) {
        this.voiceWebSocket?.sendMessage?.(String(deviceId), {
          type: 'status_request',
          requestId: statusRequestId
        });
      }
      await delayWithSignal(this.reconnectIntervalMs, signal);
    }
    return this.durableReleaseAuthorizationMatches(deviceId, identity);
  }

  async confirmCompanionUpdate(deviceId, identity, signal) {
    if (await this.durableConfirmationMatches(deviceId, identity)) {
      return { success: true, status: 'confirmed', reconciled: true, source: 'durable_receipt', ...identity };
    }
    try {
      const result = await this.requestConfirmUpdate(deviceId, identity, signal);
      return { ...result, reconciled: false };
    } catch (error) {
      if (error.code !== 'REACHY_CONFIRM_ACK_TIMEOUT') throw error;
      if (!await this.waitForDurableConfirmation(deviceId, identity, signal)) throw error;
      return { success: true, status: 'confirmed', reconciled: true, source: 'durable_receipt', ...identity };
    }
  }

  requestGracefulAppRelease(deviceId, parentRequestId, signal, identity = {}) {
    throwIfUpdateCancelled(signal);
    const requestId = releaseRequestId(parentRequestId);
    if (this.pendingAppManagement.has(requestId)) {
      throw createServiceError('Reachy safe release correlation is already active', 409, 'REACHY_UPDATE_IN_PROGRESS');
    }
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    promise.catch(() => {});
    const timer = setTimeout(() => {
      const current = this.pendingAppManagement.get(requestId);
      if (current) clearInterval(current.retryTimer);
      this.pendingAppManagement.delete(requestId);
      rejectPromise(createServiceError(
        'Reachy launcher did not acknowledge safe release',
        504,
        'REACHY_RELEASE_ACK_TIMEOUT'
      ));
    }, this.managementAckTimeoutMs);
    const pending = {
      requestId,
      parentRequestId: trimString(parentRequestId, 100),
      deviceId: String(deviceId),
      version: trimString(identity.version, 100),
      aggregateSha256: trimString(identity.aggregateSha256, 128).toLowerCase(),
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
      retryTimer: null
    };
    this.pendingAppManagement.set(requestId, pending);
    const payload = {
      type: 'app_management',
      action: 'release',
      requestId,
      parentRequestId: pending.parentRequestId,
      version: pending.version,
      aggregateSha256: pending.aggregateSha256
    };
    const send = () => this.voiceWebSocket?.sendMessage?.(String(deviceId), payload);
    send();
    pending.retryTimer = setInterval(send, this.managementRetryIntervalMs);
    const onAbort = () => {
      const pending = this.pendingAppManagement.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      clearInterval(pending.retryTimer);
      this.pendingAppManagement.delete(requestId);
      pending.reject(createUpdateCancelledError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    return promise.finally(() => signal?.removeEventListener?.('abort', onAbort));
  }

  requestPrepareUpdate(deviceId, result, signal) {
    throwIfUpdateCancelled(signal);
    const requestId = trimString(result.requestId, 100);
    if (!requestId || this.pendingPrepareUpdates.has(requestId)) {
      throw createServiceError('Reachy update prepare correlation is already active', 409, 'REACHY_UPDATE_IN_PROGRESS');
    }
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    promise.catch(() => {});
    const timer = setTimeout(() => {
      const current = this.pendingPrepareUpdates.get(requestId);
      if (current) clearInterval(current.retryTimer);
      this.pendingPrepareUpdates.delete(requestId);
      rejectPromise(createServiceError(
        'Reachy launcher did not acknowledge the prepared runtime release',
        504,
        'REACHY_PREPARE_ACK_TIMEOUT'
      ));
    }, this.managementAckTimeoutMs);
    timer.unref?.();
    const pending = {
      requestId,
      deviceId: String(deviceId),
      version: trimString(result.version, 100),
      aggregateSha256: trimString(result.aggregateSha256, 128).toLowerCase(),
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
      retryTimer: null
    };
    this.pendingPrepareUpdates.set(requestId, pending);
    const payload = {
      type: 'app_management',
      action: 'prepare_update',
      requestId,
      version: pending.version,
      aggregateSha256: pending.aggregateSha256
    };
    const send = () => this.voiceWebSocket?.sendMessage?.(String(deviceId), payload);
    send();
    pending.retryTimer = setInterval(send, this.managementRetryIntervalMs);
    const onAbort = () => {
      const current = this.pendingPrepareUpdates.get(requestId);
      if (!current) return;
      clearTimeout(current.timer);
      clearInterval(current.retryTimer);
      this.pendingPrepareUpdates.delete(requestId);
      current.reject(createUpdateCancelledError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    return promise.finally(() => signal?.removeEventListener?.('abort', onAbort));
  }

  handleUpdateStatus(deviceId, message = {}) {
    if (message.action !== 'prepare_update') {
      return { ignored: true, action: trimString(message.action, 64) || null };
    }
    const requestId = trimString(message.requestId, 100);
    const pending = this.pendingPrepareUpdates.get(requestId);
    if (!pending || pending.deviceId !== String(deviceId)) {
      return { ignored: true, duplicate: true, action: 'prepare_update', requestId };
    }
    const version = trimString(message.version, 100);
    const aggregateSha256 = trimString(message.aggregateSha256, 128).toLowerCase();
    const valid = message.success === true
      && message.status === 'prepared'
      && version === pending.version
      && aggregateSha256 === pending.aggregateSha256;
    clearTimeout(pending.timer);
    clearInterval(pending.retryTimer);
    this.pendingPrepareUpdates.delete(requestId);
    if (!valid) {
      const error = createServiceError(
        'Reachy prepared-update acknowledgement did not match the requested version and fingerprint',
        409,
        'REACHY_PREPARE_CORRELATION_FAILED'
      );
      pending.reject(error);
      return { success: false, action: 'prepare_update', requestId, error: error.message };
    }
    const result = { success: true, action: 'prepare_update', requestId, status: 'prepared', version, aggregateSha256 };
    pending.resolve(result);
    return result;
  }

  requestConfirmUpdate(deviceId, result, signal) {
    throwIfUpdateCancelled(signal);
    const requestId = trimString(result.requestId, 100);
    if (!requestId || this.pendingConfirmUpdates.has(requestId)) {
      throw createServiceError('Reachy update confirmation correlation is already active', 409, 'REACHY_UPDATE_IN_PROGRESS');
    }
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    promise.catch(() => {});
    const timer = setTimeout(() => {
      const current = this.pendingConfirmUpdates.get(requestId);
      if (current) clearInterval(current.retryTimer);
      this.pendingConfirmUpdates.delete(requestId);
      rejectPromise(createServiceError(
        'Reachy launcher did not acknowledge runtime health confirmation',
        504,
        'REACHY_CONFIRM_ACK_TIMEOUT'
      ));
    }, this.managementAckTimeoutMs);
    const pending = {
      requestId,
      deviceId: String(deviceId),
      version: trimString(result.version, 100),
      aggregateSha256: trimString(result.aggregateSha256, 128).toLowerCase(),
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
      retryTimer: null
    };
    this.pendingConfirmUpdates.set(requestId, pending);
    const payload = {
      type: 'app_management',
      action: 'confirm_update',
      requestId,
      version: pending.version,
      aggregateSha256: pending.aggregateSha256
    };
    const send = () => this.voiceWebSocket?.sendMessage?.(String(deviceId), payload);
    send();
    pending.retryTimer = setInterval(send, this.managementRetryIntervalMs);
    const onAbort = () => {
      const current = this.pendingConfirmUpdates.get(requestId);
      if (!current) return;
      clearTimeout(current.timer);
      clearInterval(current.retryTimer);
      this.pendingConfirmUpdates.delete(requestId);
      current.reject(createUpdateCancelledError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    return promise.finally(() => signal?.removeEventListener?.('abort', onAbort));
  }

  handleConfirmUpdateResult(deviceId, message = {}) {
    const requestId = trimString(message.requestId, 100);
    const pending = this.pendingConfirmUpdates.get(requestId);
    if (!pending || pending.deviceId !== String(deviceId)) {
      return { ignored: true, duplicate: true, action: 'confirm_update', requestId };
    }
    const version = trimString(message.version, 100);
    const aggregateSha256 = trimString(message.aggregateSha256, 128).toLowerCase();
    const valid = message.success === true
      && message.status === 'confirmed'
      && version === pending.version
      && aggregateSha256 === pending.aggregateSha256;
    clearTimeout(pending.timer);
    clearInterval(pending.retryTimer);
    this.pendingConfirmUpdates.delete(requestId);
    if (!valid) {
      const errorMessage = trimString(
        (isRecord(message.error) ? message.error.message : message.error) || message.message,
        500
      ) || 'Reachy runtime health confirmation was rejected or mismatched';
      const error = createServiceError(errorMessage, 409, 'REACHY_CONFIRM_CORRELATION_FAILED');
      pending.reject(error);
      return { success: false, action: 'confirm_update', requestId, error: error.message };
    }
    const confirmed = { success: true, action: 'confirm_update', requestId, status: 'confirmed', version, aggregateSha256 };
    pending.resolve(confirmed);
    return confirmed;
  }

  requestRollbackUpdate(deviceId, rollback, signal) {
    throwIfUpdateCancelled(signal);
    const requestId = trimString(rollback.requestId, 100);
    const version = trimString(rollback.version, 100);
    const aggregateSha256 = trimString(rollback.aggregateSha256, 128).toLowerCase();
    if (!requestId || !version || !/^[a-f0-9]{64}$/.test(aggregateSha256)) {
      throw createServiceError('Reachy rollback requires the prior version and full fingerprint', 409, 'REACHY_ROLLBACK_IDENTITY_REQUIRED');
    }
    if (this.pendingRollbackUpdates.has(requestId)) {
      throw createServiceError('Reachy rollback correlation is already active', 409, 'REACHY_UPDATE_IN_PROGRESS');
    }
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    promise.catch(() => {});
    const timer = setTimeout(() => {
      const current = this.pendingRollbackUpdates.get(requestId);
      if (current) clearInterval(current.retryTimer);
      this.pendingRollbackUpdates.delete(requestId);
      rejectPromise(createServiceError(
        'Reachy launcher did not acknowledge the correlated rollback',
        504,
        'REACHY_ROLLBACK_ACK_TIMEOUT'
      ));
    }, this.managementAckTimeoutMs);
    const pending = {
      requestId,
      deviceId: String(deviceId),
      version,
      aggregateSha256,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
      retryTimer: null
    };
    this.pendingRollbackUpdates.set(requestId, pending);
    const payload = {
      type: 'app_management',
      action: 'rollback',
      requestId,
      version,
      aggregateSha256
    };
    const send = () => this.voiceWebSocket?.sendMessage?.(String(deviceId), payload);
    send();
    pending.retryTimer = setInterval(send, this.managementRetryIntervalMs);
    const onAbort = () => {
      const current = this.pendingRollbackUpdates.get(requestId);
      if (!current) return;
      clearTimeout(current.timer);
      clearInterval(current.retryTimer);
      this.pendingRollbackUpdates.delete(requestId);
      current.reject(createUpdateCancelledError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    return promise.finally(() => signal?.removeEventListener?.('abort', onAbort));
  }

  handleRollbackUpdateResult(deviceId, message = {}) {
    const requestId = trimString(message.requestId, 100);
    const pending = this.pendingRollbackUpdates.get(requestId);
    if (!pending || pending.deviceId !== String(deviceId)) {
      return { ignored: true, duplicate: true, action: 'rollback', requestId };
    }
    const version = trimString(message.version, 100);
    const aggregateSha256 = trimString(message.aggregateSha256, 128).toLowerCase();
    const valid = message.success === true
      && message.status === 'rolled_back'
      && version === pending.version
      && aggregateSha256 === pending.aggregateSha256;
    clearTimeout(pending.timer);
    clearInterval(pending.retryTimer);
    this.pendingRollbackUpdates.delete(requestId);
    if (!valid) {
      const errorMessage = trimString(
        (isRecord(message.error) ? message.error.message : message.error) || message.message,
        500
      ) || 'Reachy rollback acknowledgement was rejected or mismatched';
      const error = createServiceError(errorMessage, 409, 'REACHY_ROLLBACK_CORRELATION_FAILED');
      pending.reject(error);
      return { success: false, action: 'rollback', requestId, error: error.message };
    }
    const rolledBack = { success: true, action: 'rollback', requestId, status: 'rolled_back', version, aggregateSha256 };
    pending.resolve(rolledBack);
    return rolledBack;
  }

  async getDaemonAppStatus(device, signal) {
    const response = await this.requestDaemon(
      device,
      'GET',
      '/api/apps/current-app-status',
      undefined,
      { signal }
    );
    if (!response) return { state: 'done', name: null, raw: response };
    const state = trimString(response.state || response.status, 32).toLowerCase() || 'unknown';
    const name = trimString(response.info?.name || response.name || response.app_name, 100) || null;
    return { state, name, raw: response };
  }

  async waitForDaemonDone(device, signal) {
    for (let attempt = 0; attempt < this.daemonStatusPollAttempts; attempt += 1) {
      throwIfUpdateCancelled(signal);
      const status = await this.getDaemonAppStatus(device, signal);
      if (status.name && status.name !== REACHY_APP_NAME) {
        throw createServiceError(
          `Reachy is running another app (${status.name}); HomeBrain will not stop it`,
          409,
          'REACHY_DAEMON_APP_CONFLICT'
        );
      }
      if (status.state === 'done' || !status.raw) return status;
      await delayWithSignal(this.daemonStatusPollIntervalMs, signal);
    }
    return this.getDaemonAppStatus(device, signal);
  }

  async restartManagedApp(device, options = {}) {
    throwIfUpdateCancelled(options.signal);
    let status = await this.getDaemonAppStatus(device, options.signal);
    let releaseAcknowledged = null;
    if (status.name && status.name !== REACHY_APP_NAME) {
      throw createServiceError(
        `Reachy is running another app (${status.name}); HomeBrain will not stop it`,
        409,
        'REACHY_DAEMON_APP_CONFLICT'
      );
    }

    if (['running', 'starting'].includes(status.state)) {
      if (options.safeRelease === false) {
        await this.requestDaemon(device, 'POST', '/api/apps/stop-current-app', undefined, { signal: options.signal });
        status = await this.waitForDaemonDone(device, options.signal);
      } else {
        try {
          await this.requestGracefulAppRelease(
            device._id || options.deviceId,
            options.requestId,
            options.signal,
            { version: options.version, aggregateSha256: options.aggregateSha256 }
          );
          releaseAcknowledged = true;
          status = await this.waitForDaemonDone(device, options.signal);
        } catch (error) {
          if (error.code !== 'REACHY_RELEASE_ACK_TIMEOUT') throw error;
          // The ACK and socket can disappear together because the authorized
          // app intentionally exits. A stopped daemon is observable evidence
          // that the release happened; after restart the launcher's durable
          // lastAuthorized receipt is still required before confirmation.
          status = await this.waitForDaemonDone(device, options.signal);
          if (status.state !== 'done' && status.raw) throw error;
          releaseAcknowledged = false;
        }
        if (['running', 'starting'].includes(status.state)) {
          await this.requestDaemon(device, 'POST', '/api/apps/stop-current-app', undefined, { signal: options.signal });
          status = await this.waitForDaemonDone(device, options.signal);
        }
      }
    } else if (status.state === 'error') {
      await this.requestDaemon(device, 'POST', '/api/apps/stop-current-app', undefined, { signal: options.signal });
      status = await this.waitForDaemonDone(device, options.signal);
    } else if (status.state === 'stopping') {
      status = await this.waitForDaemonDone(device, options.signal);
    } else if (!['done'].includes(status.state) && status.raw) {
      throw createServiceError(
        `Reachy daemon reported an unsupported app state: ${status.state}`,
        502,
        'REACHY_DAEMON_STATE_INVALID'
      );
    }
    if (status.state !== 'done' && status.raw) {
      throw createServiceError('Reachy app did not stop before restart', 504, 'REACHY_DAEMON_STOP_TIMEOUT');
    }
    throwIfUpdateCancelled(options.signal);
    await this.requestDaemon(device, 'POST', `/api/apps/start-app/${REACHY_APP_NAME}`, undefined, { signal: options.signal });
    return {
      started: true,
      releaseAcknowledged,
      releaseRequestId: options.requestId ? releaseRequestId(options.requestId) : null
    };
  }

  async activateStagedCompanionUpdate(deviceId, result) {
    if (this.shuttingDown) throw createUpdateCancelledError();
    if (this.updateOperations.has(String(deviceId))) {
      throw createServiceError('A Reachy companion activation is already running', 409, 'REACHY_UPDATE_IN_PROGRESS');
    }
    const operation = { requestId: result.requestId, controller: new AbortController() };
    this.updateOperations.set(String(deviceId), operation);
    try {
      return await this._activateStagedCompanionUpdate(deviceId, result, operation.controller.signal);
    } finally {
      if (this.updateOperations.get(String(deviceId)) === operation) {
        this.updateOperations.delete(String(deviceId));
      }
    }
  }

  async _activateStagedCompanionUpdate(deviceId, result, signal) {
    throwIfUpdateCancelled(signal);
    const device = await this.getRobot(deviceId);
    const reachy = getReachySettings(device);
    const management = reachy.appManagement || {};
    const activeOperation = this.updateOperations.get(String(deviceId));
    if (activeOperation) {
      activeOperation.rollback = {
        version: trimString(management.previousVersion, 100),
        aggregateSha256: trimString(management.previousAggregateSha256, 128).toLowerCase()
      };
      // Rollback is an idempotent disarm operation, so arm this before the
      // prepare send to cover prepare-committed/ACK-lost shutdown ambiguity.
      activeOperation.rollbackArmed = Boolean(
        activeOperation.rollback.version
        && /^[a-f0-9]{64}$/.test(activeOperation.rollback.aggregateSha256)
      );
    }
    if (trimString(result.aggregateSha256, 128) !== trimString(management.aggregateSha256, 128)) {
      throw createServiceError('Staged companion package checksum did not match the hub manifest', 409, 'REACHY_PACKAGE_CHECKSUM_MISMATCH');
    }
    if (trimString(result.version, 100) !== trimString(management.targetVersion, 100)) {
      throw createServiceError('Staged companion version did not match the requested version', 409, 'REACHY_PACKAGE_VERSION_MISMATCH');
    }

    const healthBaseline = Math.max(0, Number(reachy.healthReportSequence) || 0);
    let completionRecovery = { state: 'not_required' };
    try {
      // Staging is deliberately non-active. The exact retryable prepare tuple
      // durably arms the pending pointer, but the companion remains connected
      // until a separately correlated release is acknowledged.
      await this.requestPrepareUpdate(deviceId, result, signal);
      throwIfUpdateCancelled(signal);

      await this.updateAppManagementState(deviceId, {
        state: 'updating',
        updateStartedAt: new Date(),
        recovery: {
          state: 'armed',
          previousVersion: management.previousVersion || null,
          previousAggregateSha256: management.previousAggregateSha256 || null
        },
        error: null
      });
      const reconnectAfter = new Date();
      const restartResult = await this.restartManagedApp(device, {
        signal,
        deviceId,
        requestId: result.requestId,
        version: result.version,
        aggregateSha256: result.aggregateSha256,
        safeRelease: true
      });
      await this.waitForUpdatedReconnect(
        deviceId,
        result.version,
        result.aggregateSha256,
        reconnectAfter,
        {
          signal,
          minimumHealthSequence: healthBaseline + this.requiredHealthReports,
          healthRequestId: result.requestId
        }
      );
      if (
        restartResult?.releaseAcknowledged === false
        && !await this.waitForDurableReleaseAuthorization(deviceId, result, signal)
      ) {
        throw createServiceError(
          'Reachy launcher did not report the exact durable release authorization after a lost acknowledgement',
          504,
          'REACHY_RELEASE_RECEIPT_MISSING'
        );
      }
      // Promotion from pending to last-known-good is a separate, correlated
      // handshake. Merely receiving auth_success must never make a candidate
      // permanent before HomeBrain verifies the persisted version and digest.
      const confirmation = await this.confirmCompanionUpdate(deviceId, result, signal);
      if (activeOperation) activeOperation.rollbackArmed = false;
      if (confirmation.reconciled) {
        completionRecovery = {
          state: 'confirmation_receipt_reconciled',
          reconciledAt: new Date(),
          reason: 'confirm_acknowledgement_lost'
        };
      }
    } catch (updateError) {
      if (updateError.code === 'REACHY_UPDATE_CANCELLED') {
        if (
          management.previousVersion
          && /^[a-f0-9]{64}$/i.test(management.previousAggregateSha256 || '')
          && this.isConnected(deviceId)
        ) {
          if (this.shuttingDown) {
            // Shutdown cannot await a new correlation map after it has started
            // draining, but still sends the exact idempotent disarm tuple.
            this.voiceWebSocket?.sendMessage?.(String(deviceId), {
              type: 'app_management',
              action: 'rollback',
              requestId: result.requestId,
              version: management.previousVersion,
              aggregateSha256: management.previousAggregateSha256
            });
          } else {
            await this.requestRollbackUpdate(deviceId, {
              requestId: result.requestId,
              version: management.previousVersion,
              aggregateSha256: management.previousAggregateSha256
            }).catch(() => {});
          }
        }
        throw updateError;
      }
      const recoveryStartedAt = new Date();
      await this.updateAppManagementState(deviceId, {
        state: 'updating',
        recovery: {
          state: 'attempting',
          previousVersion: management.previousVersion || null,
          previousAggregateSha256: management.previousAggregateSha256 || null,
          startedAt: recoveryStartedAt,
          trigger: trimString(updateError.message, 500)
        }
      });
      try {
        const recoveryDevice = await this.getRobot(deviceId);
        const recoveryReachy = getReachySettings(recoveryDevice);
        const recoveryHealthBaseline = Math.max(0, Number(recoveryReachy.healthReportSequence) || 0);
        if (!management.previousVersion || !/^[a-f0-9]{64}$/i.test(management.previousAggregateSha256 || '')) {
          throw createServiceError(
            'The previous Reachy runtime has no verified rollback identity',
            409,
            'REACHY_ROLLBACK_IDENTITY_REQUIRED'
          );
        }
        if (this.isConnected(deviceId)) {
          await this.requestRollbackUpdate(deviceId, {
            requestId: result.requestId,
            version: management.previousVersion,
            aggregateSha256: management.previousAggregateSha256
          }, signal);
        }
        await this.restartManagedApp(recoveryDevice, {
          signal,
          deviceId,
          requestId: result.requestId,
          safeRelease: false
        });
        await this.waitForUpdatedReconnect(
          deviceId,
          management.previousVersion,
          management.previousAggregateSha256,
          recoveryStartedAt,
          {
            signal,
            minimumHealthSequence: recoveryHealthBaseline + this.requiredHealthReports,
            healthRequestId: result.requestId
          }
        );
        const rollbackError = createServiceError(
          `Reachy update failed and the previous runtime was restored: ${updateError.message}`,
          502,
          'REACHY_UPDATE_ROLLED_BACK'
        );
        await this.updateAppManagementState(deviceId, {
          state: 'failed',
          installedVersion: management.previousVersion || null,
          updateAvailable: true,
          failedAt: new Date(),
          error: rollbackError.message,
          recovery: {
            state: 'recovered',
            previousVersion: management.previousVersion || null,
            previousAggregateSha256: management.previousAggregateSha256 || null,
            startedAt: recoveryStartedAt,
            completedAt: new Date(),
            trigger: trimString(updateError.message, 500)
          }
        });
        void eventStreamService.publishSafe({
          type: 'reachy.companion_update_rolled_back',
          source: REACHY_DEVICE_SOURCE,
          category: 'platform',
          severity: 'warning',
          payload: { deviceId: String(deviceId), requestId: result.requestId, error: updateError.message },
          correlationId: result.requestId,
          tags: ['reachy', 'update', 'rollback']
        });
        throw rollbackError;
      } catch (recoveryError) {
        if (recoveryError.code === 'REACHY_UPDATE_CANCELLED') throw recoveryError;
        if (recoveryError.code === 'REACHY_UPDATE_ROLLED_BACK') throw recoveryError;
        const combinedError = createServiceError(
          `Reachy update failed and automatic recovery did not reconnect: ${recoveryError.message}`,
          503,
          'REACHY_UPDATE_RECOVERY_FAILED'
        );
        await this.updateAppManagementState(deviceId, {
          state: 'failed',
          failedAt: new Date(),
          error: combinedError.message,
          recovery: {
            state: 'failed',
            previousVersion: management.previousVersion || null,
            previousAggregateSha256: management.previousAggregateSha256 || null,
            startedAt: recoveryStartedAt,
            failedAt: new Date(),
            trigger: trimString(updateError.message, 500),
            error: trimString(recoveryError.message, 500)
          }
        });
        throw combinedError;
      }
    }
    await this.updateAppManagementState(deviceId, {
      state: 'completed',
      installedVersion: result.version,
      latestVersion: result.version,
      updateAvailable: false,
      lastUpdatedAt: new Date(),
      completedAt: new Date(),
      recovery: completionRecovery,
      error: null
    });
    void eventStreamService.publishSafe({
      type: 'reachy.companion_updated',
      source: REACHY_DEVICE_SOURCE,
      category: 'platform',
      payload: { deviceId: String(deviceId), version: result.version, requestId: result.requestId },
      correlationId: result.requestId,
      tags: ['reachy', 'update', 'companion']
    });
  }

  async handleAppManagementResult(deviceId, message = {}) {
    if (this.shuttingDown) throw createUpdateCancelledError();
    if (message.action === 'confirm_update') {
      return this.handleConfirmUpdateResult(deviceId, message);
    }
    if (message.action === 'rollback') {
      return this.handleRollbackUpdateResult(deviceId, message);
    }
    if (message.action === 'release') {
      const requestId = trimString(message.requestId, 100);
      const pending = this.pendingAppManagement.get(requestId);
      if (!pending || pending.deviceId !== String(deviceId)) {
        return { ignored: true, duplicate: true, requestId, action: 'release' };
      }
      clearTimeout(pending.timer);
      clearInterval(pending.retryTimer);
      this.pendingAppManagement.delete(requestId);
      const releaseVersion = trimString(message.version, 100);
      const releaseAggregate = trimString(message.aggregateSha256, 128).toLowerCase();
      const releaseMatches = message.success === true
        && message.status === 'releasing'
        && (!pending.version || releaseVersion === pending.version)
        && (!pending.aggregateSha256 || releaseAggregate === pending.aggregateSha256);
      if (!releaseMatches) {
        const errorMessage = trimString(
          (isRecord(message.error) ? message.error.message : message.error) || message.message,
          500
        ) || 'Reachy launcher rejected safe release';
        const error = createServiceError(errorMessage, 502, 'REACHY_RELEASE_REJECTED');
        pending.reject(error);
        return { success: false, action: 'release', requestId, error: errorMessage };
      }
      const result = {
        success: true,
        action: 'release',
        requestId,
        status: 'releasing',
        version: releaseVersion,
        aggregateSha256: releaseAggregate
      };
      pending.resolve(result);
      return result;
    }
    if (message.action !== 'package_stage') {
      throw createServiceError('Unsupported Reachy app management result action');
    }
    const requestId = trimString(message.requestId, 100);
    const device = await this.getRobot(deviceId);
    const management = getReachySettings(device).appManagement || {};
    if (!requestId || requestId !== trimString(management.requestId, 100)) {
      throw createServiceError('Reachy app management result did not match an active request', 409, 'REACHY_UPDATE_CORRELATION_FAILED');
    }
    if (['staged', 'updating', 'completed'].includes(management.state)) {
      return { success: true, status: management.state, requestId, duplicate: true };
    }
    if (message.success !== true || message.status === 'failed') {
      const errorMessage = trimString(message.error, 500) || 'Reachy companion failed to stage the update package';
      const state = /manual_reinstall_required/i.test(errorMessage)
        ? 'manual_reinstall_required'
        : 'failed';
      await this.updateAppManagementState(deviceId, {
        state,
        error: errorMessage,
        failedAt: new Date()
      });
      void eventStreamService.publishSafe({
        type: 'reachy.companion_update_failed',
        source: REACHY_DEVICE_SOURCE,
        category: 'platform',
        severity: 'error',
        payload: { deviceId: String(deviceId), requestId, error: errorMessage },
        correlationId: requestId,
        tags: ['reachy', 'update', 'failure']
      });
      return { success: false, status: 'failed', error: errorMessage };
    }
    if (message.status !== 'staged') {
      throw createServiceError('Reachy package stage result had an invalid status');
    }
    const result = {
      requestId,
      version: trimString(message.version, 100),
      aggregateSha256: trimString(message.aggregateSha256, 128)
    };
    await this.updateAppManagementState(deviceId, { state: 'staged', ...result, error: null });
    setImmediate(() => {
      this.activateStagedCompanionUpdate(deviceId, result).catch(async (error) => {
        if (error.code === 'REACHY_UPDATE_CANCELLED') return;
        console.error('ReachyMiniService: companion update failed', {
          deviceId: String(deviceId),
          error: error.message
        });
        try {
          await this.updateAppManagementState(deviceId, {
            state: 'failed',
            error: error.message,
            failedAt: new Date()
          });
        } catch (_updateError) {
          // Best-effort persistence after a background failure.
        }
      });
    });
    return { success: true, status: 'staged', requestId };
  }

  async deleteRobot(deviceId, context = {}) {
    this.cancelUpdateOperation(deviceId);
    const device = await this.getRobot(deviceId);
    await reachySnapshotService.removeDevice(deviceId);
    const reachy = getReachySettings(device);
    if (this.isConnected(deviceId) && this.voiceWebSocket) {
      try {
        const issuedAt = new Date();
        const commandId = crypto.randomUUID();
        this.voiceWebSocket.sendMessage(String(deviceId), {
          type: 'robot_command',
          protocolVersion: REACHY_PROTOCOL_VERSION,
          command: {
            id: commandId,
            action: 'release_app',
            parameters: {},
            issuedAt: issuedAt.toISOString(),
            ttlMs: 5_000
          },
          commandId,
          action: 'release_app',
          parameters: {},
          issuedAt: issuedAt.toISOString(),
          expiresAt: new Date(issuedAt.getTime() + 5_000).toISOString(),
          ttlMs: 5_000,
          source: 'device-removal'
        });
      } catch (_error) {
        // Credential revocation and record removal must continue even if the
        // best-effort release message cannot be delivered.
      }
      const connection = this.voiceWebSocket.deviceConnections?.get?.(String(deviceId));
      if (connection?.ws && typeof connection.ws.close === 'function') {
        connection.ws.close(1008, 'Reachy registration revoked');
      }
    }

    const genericDeviceId = trimString(reachy.genericDeviceId, 100);
    if (genericDeviceId && mongoose.Types.ObjectId.isValid(genericDeviceId)) {
      await Device.deleteOne({ _id: genericDeviceId });
    } else {
      await Device.deleteMany({ 'properties.reachy.voiceDeviceId': String(deviceId) });
    }
    await VoiceDevice.deleteOne({ _id: deviceId, deviceType: REACHY_DEVICE_TYPE });
    void eventStreamService.publishSafe({
      type: 'reachy.removed',
      source: REACHY_DEVICE_SOURCE,
      category: 'security',
      actorUserId: context.actorUserId || undefined,
      payload: { deviceId: String(deviceId), name: device.name, genericDeviceId: genericDeviceId || null },
      tags: ['reachy', 'security', 'removal']
    });
    return { deviceId: String(deviceId), genericDeviceId: genericDeviceId || null };
  }

  async executeWorkflowAction(action, context = {}) {
    const normalized = normalizeWorkflowAction(action);
    const device = await this.resolveRobot(normalized.target);
    if (normalized.command === 'speak') {
      const result = await this.speak(toId(device), normalized.parameters.text, {
        voiceId: normalized.parameters.voiceId,
        source: 'workflow'
      });
      return {
        target: toId(device),
        message: `Sent speech to ${device.name}`,
        command: 'speak',
        ...result
      };
    }
    const result = await this.dispatchCommand(toId(device), normalized.command, normalized.parameters, {
      source: 'workflow',
      workflowId: context.workflowId || null,
      awaitTerminal: true
    });
    return {
      target: toId(device),
      message: `Sent ${normalized.command.replace(/_/g, ' ')} to ${device.name}`,
      command: normalized.command,
      commandId: result.commandId,
      status: result.status,
      terminal: true
    };
  }
}

const reachyMiniService = new ReachyMiniService();

module.exports = reachyMiniService;
module.exports.ReachyMiniService = ReachyMiniService;
module.exports.REACHY_DEVICE_TYPE = REACHY_DEVICE_TYPE;
module.exports.REACHY_DEVICE_SOURCE = REACHY_DEVICE_SOURCE;
module.exports.REACHY_PROTOCOL_VERSION = REACHY_PROTOCOL_VERSION;
module.exports.SAFE_SETTING_KEYS = SAFE_SETTING_KEYS;
module.exports.normalizeSafeSettings = normalizeSafeSettings;
module.exports.normalizeSemanticCommand = normalizeSemanticCommand;
module.exports.normalizeRobotState = normalizeRobotState;
module.exports.normalizeWorkflowAction = normalizeWorkflowAction;
module.exports.normalizeCapabilityMetadata = normalizeCapabilityMetadata;

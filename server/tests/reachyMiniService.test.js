const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const VoiceDevice = require('../models/VoiceDevice');
const reachyMiniPackageService = require('../services/reachyMiniPackageService');
const reachySnapshotService = require('../services/reachySnapshotService');

const {
  ReachyMiniService,
  normalizeSafeSettings,
  normalizeSemanticCommand
} = require('../services/reachyMiniService');

const DEVICE_ID = '507f1f77bcf86cd799439011';

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeDevice(overrides = {}) {
  const device = {
    _id: DEVICE_ID,
    name: 'Reachy',
    room: 'Office',
    deviceType: 'robot',
    status: 'online',
    wakeWordSupport: true,
    supportedWakeWords: ['Anna'],
    settings: {
      registered: true,
      reachy: {
        safeSettings: normalizeSafeSettings(),
        appVersion: '0.1.0',
        appAggregateSha256: 'a'.repeat(64),
        launcherFingerprint: 'e'.repeat(64),
        capabilities: ['audio_input', 'audio_output', 'camera', 'face_tracking', 'snapshot'],
        capabilityMetadata: {
          actions: [
            'wake', 'sleep', 'neutral', 'stop', 'look', 'set_antennas', 'set_body_yaw',
            'set_motor_mode', 'play_emotion', 'play_move', 'start_face_tracking',
            'stop_face_tracking', 'set_volume', 'set_microphone_volume', 'snapshot', 'release_app'
          ],
          emotions: ['neutral', 'happy', 'curious', 'sad', 'listening', 'speaking', 'alert'],
          moves: ['nod', 'shake_head', 'greet', 'celebrate', 'dance', 'yes', 'no'],
          motorModes: ['disabled', 'enabled', 'gravity_compensation']
        },
        daemonAddress: '192.168.1.55',
        appManagement: {}
      }
    },
    saves: 0,
    markModified() {},
    async save() {
      this.saves += 1;
      return this;
    }
  };
  Object.assign(device, overrides);
  return device;
}

function connectedService(options = {}) {
  const device = fakeDevice();
  const sent = [];
  const service = new ReachyMiniService(options);
  service.getRobot = async () => device;
  service.upsertMirroredDevice = async () => null;
  service.setVoiceWebSocket({
    isDeviceAuthenticated: () => true,
    sendMessage(_deviceId, message) {
      sent.push(message);
      return true;
    }
  });
  return { service, device, sent };
}

test('safe Reachy settings default camera and high-risk voice controls off', () => {
  const settings = normalizeSafeSettings();
  assert.equal(settings.cameraEnabled, false);
  assert.equal(settings.snapshotEnabled, false);
  assert.equal(settings.allowHighRiskVoiceActions, false);
  assert.equal(settings.speechDirectionEnabled, false);
  assert.equal(settings.idleMotionEnabled, false);
  assert.throws(
    () => normalizeSafeSettings({ deviceToken: 'secret' }),
    /Unsupported settings parameter/
  );
  assert.deepEqual(
    normalizeSafeSettings({ cameraEnabled: false, snapshotEnabled: true }),
    { ...settings, snapshotEnabled: false }
  );
  assert.throws(
    () => normalizeSafeSettings({ allowHighRiskVoiceActions: true }),
    /trusted confirmation channel/
  );
});

test('semantic command validation is allowlist-only and canonical', () => {
  assert.deepEqual(normalizeSemanticCommand('look-at-speaker'), {
    command: 'look',
    parameters: { direction: 'speaker' }
  });
  assert.deepEqual(normalizeSemanticCommand('emotion', { emotion: 'listening' }), {
    command: 'play_emotion',
    parameters: { emotion: 'listening' }
  });
  assert.throws(() => normalizeSemanticCommand('shell', { command: 'rm -rf /' }), /Unsupported Reachy command/);
  assert.throws(() => normalizeSemanticCommand('happy', {}), /Unsupported Reachy command/);
});

test('motion duration boundaries match the companion and body yaw rejects ignored duration', () => {
  assert.equal(normalizeSemanticCommand('look', { direction: 'left', durationMs: 100 }).parameters.durationMs, 100);
  assert.equal(normalizeSemanticCommand('look', { direction: 'left', durationMs: 5_000 }).parameters.durationMs, 5_000);
  assert.equal(normalizeSemanticCommand('play_move', { move: 'dance', durationMs: 300 }).parameters.durationMs, 300);
  assert.throws(() => normalizeSemanticCommand('look', { direction: 'left', durationMs: 99 }), /between 100 and 5000/);
  assert.throws(() => normalizeSemanticCommand('play_emotion', { emotion: 'happy', durationMs: 5_001 }), /between 100 and 5000/);
  assert.throws(() => normalizeSemanticCommand('play_move', { move: 'dance', durationMs: 299 }), /between 300 and 5000/);
  assert.throws(() => normalizeSemanticCommand('set_body_yaw', { angleDeg: 5, durationMs: 500 }), /Unsupported set_body_yaw parameter/);
});

test('workflow validation rejects read-once snapshot actions', () => {
  const { normalizeWorkflowAction } = require('../services/reachyMiniService');
  assert.throws(() => normalizeWorkflowAction({
    type: 'reachy_action',
    target: DEVICE_ID,
    parameters: { command: 'snapshot' }
  }), (error) => error.code === 'REACHY_WORKFLOW_SNAPSHOT_UNSUPPORTED');
});

test('persisted online status is never treated as a live authenticated socket', () => {
  const service = new ReachyMiniService();
  const device = fakeDevice({ status: 'online' });
  assert.equal(service.sanitizeRobot(device).online, false);
});

test('sanitized robot readiness exposes bounded wake-model status without filesystem paths', () => {
  const service = new ReachyMiniService();
  const device = fakeDevice();
  device.settings.reachy.capabilities.push('wake_word');
  device.settings.reachy.safeSettings.wakeWordEnabled = true;
  device.settings.reachy.wakeDetector = {
    active: true,
    engine: 'openwakeword',
    error: null,
    models: ['/home/reachy/private/models/anna.onnx']
  };
  let robot = service.sanitizeRobot(device);
  assert.deepEqual(robot.wakeDetector, {
    active: true,
    engine: 'openwakeword',
    error: null,
    models: ['anna.onnx']
  });
  assert.equal(robot.capabilities.includes('wake_word'), true);

  device.settings.reachy.wakeDetector.models = [];
  robot = service.sanitizeRobot(device);
  assert.equal(robot.wakeDetector.active, false);
  assert.equal(robot.capabilities.includes('wake_word'), false);
});

test('companion status exposes bounded fleet identity and authoritative socket state only', async (t) => {
  const originalBuildManifest = reachyMiniPackageService.buildManifest;
  t.after(() => { reachyMiniPackageService.buildManifest = originalBuildManifest; });
  const { service, device } = connectedService();
  device.name = 'R'.repeat(150);
  device.room = 'Office';
  device.settings.reachy.launcherApi = 1;
  device.settings.reachy.dependencyFingerprint = 'f'.repeat(64);
  device.settings.reachy.launcherFingerprint = 'e'.repeat(64);
  reachyMiniPackageService.buildManifest = async () => ({
    version: '0.1.0',
    aggregateSha256: 'a'.repeat(64),
    compatibility: {
      launcherApi: 1,
      dependencyFingerprint: 'f'.repeat(64),
      launcherFingerprint: 'e'.repeat(64),
      requiresManualReinstall: false
    }
  });
  const status = await service.getCompanionStatus(DEVICE_ID);
  assert.equal(status.name, 'R'.repeat(100));
  assert.equal(status.room, 'Office');
  assert.equal(status.online, true);
  assert.equal(status.current, true);
  assert.equal(status.integrityStatus, 'verified');
  assert.equal(Object.hasOwn(status, 'daemonAddress'), false);
  assert.equal(Object.hasOwn(status, 'manifestUrl'), false);

  device.settings.reachy.launcherFingerprint = 'd'.repeat(64);
  const incompatible = await service.getCompanionStatus(DEVICE_ID);
  assert.equal(incompatible.manualReinstallRequired, true);
  assert.equal(incompatible.compatibility.status, 'manual_reinstall_required');
  assert.equal(incompatible.compatibility.launcherFingerprint, 'd'.repeat(64));
});

test('same-version runtime without a digest is unverified rather than falsely current', async (t) => {
  const originalBuildManifest = reachyMiniPackageService.buildManifest;
  t.after(() => { reachyMiniPackageService.buildManifest = originalBuildManifest; });
  const { service, device } = connectedService();
  device.settings.reachy.appAggregateSha256 = null;
  device.settings.reachy.launcherApi = 1;
  device.settings.reachy.dependencyFingerprint = 'f'.repeat(64);
  device.settings.reachy.launcherFingerprint = 'e'.repeat(64);
  reachyMiniPackageService.buildManifest = async () => ({
    version: '0.1.0',
    aggregateSha256: 'a'.repeat(64),
    compatibility: {
      launcherApi: 1,
      dependencyFingerprint: 'f'.repeat(64),
      launcherFingerprint: 'e'.repeat(64),
      requiresManualReinstall: false
    }
  });
  const status = await service.getCompanionStatus(DEVICE_ID);
  assert.equal(status.current, false);
  assert.equal(status.updateAvailable, false);
  assert.equal(status.integrityStatus, 'unknown');
  assert.equal(status.provenance, 'bundled_unverified');
  assert.equal(status.manualReinstallRequired, false);
});

test('Reachy hardware identity is atomically first-bound and same reconnect is idempotent', async (t) => {
  const originalFindOne = VoiceDevice.findOne;
  const originalFindOneAndUpdate = VoiceDevice.findOneAndUpdate;
  t.after(() => {
    VoiceDevice.findOne = originalFindOne;
    VoiceDevice.findOneAndUpdate = originalFindOneAndUpdate;
  });
  const service = new ReachyMiniService();
  const device = fakeDevice();
  device.settings.reachy.unitId = null;
  let compareAndSetCalls = 0;
  VoiceDevice.findOne = async () => null;
  VoiceDevice.findOneAndUpdate = async () => {
    compareAndSetCalls += 1;
    device.settings.reachy.unitId = '0123456789abcdef';
    return device;
  };

  const bound = await service.bindRobotUnitIdentity(device, '0123456789abcdef');
  assert.equal(bound.settings.reachy.unitId, '0123456789abcdef');
  assert.equal(compareAndSetCalls, 1);
  const reconnect = await service.bindRobotUnitIdentity(bound, '0123456789abcdef');
  assert.equal(reconnect, bound);
  assert.equal(compareAndSetCalls, 1);
});

test('Reachy hardware identity mismatch and duplicate enrollment are rejected', async (t) => {
  const originalFindOne = VoiceDevice.findOne;
  const originalFindOneAndUpdate = VoiceDevice.findOneAndUpdate;
  t.after(() => {
    VoiceDevice.findOne = originalFindOne;
    VoiceDevice.findOneAndUpdate = originalFindOneAndUpdate;
  });
  const service = new ReachyMiniService();
  const bound = fakeDevice();
  bound.settings.reachy.unitId = '0123456789abcdef';
  await assert.rejects(
    service.bindRobotUnitIdentity(bound, 'fedcba9876543210'),
    (error) => error.code === 'REACHY_IDENTITY_MISMATCH' && error.status === 403
  );

  const unbound = fakeDevice();
  unbound.settings.reachy.unitId = null;
  const duplicate = fakeDevice({ _id: '507f191e810c19729de860ea', name: 'Other Reachy' });
  let duplicateLookups = 0;
  VoiceDevice.findOne = async () => {
    duplicateLookups += 1;
    return duplicateLookups === 1 ? null : duplicate;
  };
  VoiceDevice.findOneAndUpdate = async () => null;
  service.getRobot = async () => unbound;
  await assert.rejects(
    service.bindRobotUnitIdentity(unbound, 'aaaaaaaaaaaaaaaa'),
    (error) => error.code === 'REACHY_IDENTITY_DUPLICATE' && error.status === 409
  );
  assert.equal(duplicateLookups, 2);
});

test('dispatch sends canonical nested and compatibility command fields', async (t) => {
  const { service, sent } = connectedService();
  t.after(() => service.shutdown());
  const result = await service.dispatchCommand(DEVICE_ID, 'look', { direction: 'left' }, {
    source: 'api',
    ttlMs: 5_000
  });

  assert.equal(result.status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'robot_command');
  assert.equal(sent[0].protocolVersion, 1);
  assert.equal(sent[0].command.id, sent[0].commandId);
  assert.equal(sent[0].command.action, 'look');
  assert.deepEqual(sent[0].command.parameters, { direction: 'left' });
  assert.equal(sent[0].action, 'look');
  assert.equal(sent[0].ttlMs, 5_000);
  assert.ok(Date.parse(sent[0].expiresAt) > Date.parse(sent[0].issuedAt));
});

test('credential rotation during robot lookup cannot route an old utterance to a replacement socket', async (t) => {
  const service = new ReachyMiniService();
  t.after(() => service.shutdown());
  const device = fakeDevice();
  const oldConnection = { authenticated: true, revoked: false };
  const replacementConnection = { authenticated: true, revoked: false };
  const deviceConnections = new Map([[DEVICE_ID, oldConnection]]);
  const sent = [];
  service.setVoiceWebSocket({
    deviceConnections,
    isDeviceAuthenticated: (deviceId) => deviceConnections.get(String(deviceId))?.authenticated === true,
    sendMessage(deviceId, message) {
      sent.push({ deviceId, message });
      return true;
    }
  });

  let releaseLookup;
  let lookupStartedResolve;
  const lookupStarted = new Promise((resolve) => { lookupStartedResolve = resolve; });
  service.getRobot = async () => {
    lookupStartedResolve();
    await new Promise((resolve) => { releaseLookup = resolve; });
    return device;
  };
  const authorizeExecution = () => (
    oldConnection.authenticated === true
    && oldConnection.revoked !== true
    && deviceConnections.get(DEVICE_ID) === oldConnection
  );

  const dispatch = service.dispatchCommand(DEVICE_ID, 'look', { direction: 'left' }, {
    source: 'voice',
    authorizeExecution
  });
  await lookupStarted;
  oldConnection.authenticated = false;
  oldConnection.revoked = true;
  deviceConnections.set(DEVICE_ID, replacementConnection);
  releaseLookup();

  await assert.rejects(
    dispatch,
    (error) => error.code === 'REACHY_AUTHORIZATION_REVOKED' && error.status === 409
  );
  assert.equal(sent.some((entry) => entry.message.type === 'robot_command'), false);
  assert.equal(service.pendingCommands.size, 0);
});

test('command TTL always covers the accepted physical motion duration', async (t) => {
  const { service, sent } = connectedService();
  t.after(() => service.shutdown());
  await service.dispatchCommand(DEVICE_ID, 'look', { direction: 'left', durationMs: 5_000 }, {
    source: 'api',
    ttlMs: 1_000
  });
  assert.equal(sent[0].parameters.durationMs, 5_000);
  assert.equal(sent[0].ttlMs, 6_000);
  assert.ok(Date.parse(sent[0].expiresAt) - Date.parse(sent[0].issuedAt) >= 5_000);
});

test('camera privacy gates start tracking but always permits stop tracking', async (t) => {
  const { service } = connectedService();
  t.after(() => service.shutdown());
  await assert.rejects(
    service.dispatchCommand(DEVICE_ID, 'start_face_tracking'),
    (error) => error.code === 'REACHY_CAMERA_DISABLED'
  );
  const stopped = await service.dispatchCommand(DEVICE_ID, 'stop_face_tracking');
  assert.equal(stopped.action, 'stop_face_tracking');
});

test('server rejects semantic actions absent from authenticated capability metadata', async (t) => {
  const { service, device } = connectedService();
  t.after(() => service.shutdown());
  device.settings.reachy.capabilityMetadata.actions = ['wake', 'stop'];
  await assert.rejects(
    service.dispatchCommand(DEVICE_ID, 'play_move', { move: 'dance' }),
    (error) => error.code === 'REACHY_CAPABILITY_UNAVAILABLE'
  );
});

test('onboarding reissue durably revokes the live robot socket, snapshots, and command work', async (t) => {
  const { service, device } = connectedService();
  t.after(() => service.shutdown());
  device.settings.deviceTokenHash = 'old-token-hash';
  device.settings.registered = true;
  device.settings.lifecycle = { state: 'activated' };
  let revoked = null;
  let snapshotsRevoked = null;
  const originalRemoveDevice = reachySnapshotService.removeDevice;
  t.after(() => { reachySnapshotService.removeDevice = originalRemoveDevice; });
  reachySnapshotService.removeDevice = async (id) => { snapshotsRevoked = id; };
  service.voiceWebSocket.revokeDeviceCredentials = (id) => { revoked = id; };

  const result = await service.reissueOnboarding(DEVICE_ID);

  assert.equal(result.device.settings.registered, false);
  assert.equal(Object.hasOwn(result.device.settings, 'deviceTokenHash'), false);
  assert.equal(result.device.status, 'offline');
  assert.equal(revoked, DEVICE_ID);
  assert.equal(snapshotsRevoked, DEVICE_ID);
});

test('disabling microphone updates live socket policy and clears buffered audio immediately', async (t) => {
  const { service, device, sent } = connectedService();
  t.after(() => service.shutdown());
  const connection = {
    device,
    pendingWakeWord: { wakeWord: 'anna' },
    captureGrant: { expiresAt: Date.now() + 5000 },
    authenticated: true
  };
  service.voiceWebSocket.deviceConnections = new Map([[DEVICE_ID, connection]]);
  service.voiceWebSocket.audioSessions = new Map([[DEVICE_ID, { chunks: [Buffer.from('private')] }]]);
  await service.updateSettings(DEVICE_ID, { microphoneEnabled: false });
  assert.equal(connection.device.settings.reachy.safeSettings.microphoneEnabled, false);
  assert.equal(connection.pendingWakeWord, null);
  assert.equal(connection.captureGrant, null);
  assert.equal(service.voiceWebSocket.audioSessions.has(DEVICE_ID), false);
  assert.equal(sent.at(-1).type, 'robot_config_update');
  assert.equal(sent.at(-1).settings.microphoneEnabled, false);
});

test('privacy disable clears persisted and mirrored derived sensor state before config delivery', async (t) => {
  const { service, device, sent } = connectedService();
  t.after(() => service.shutdown());
  device.settings.reachy.safeSettings = normalizeSafeSettings({
    cameraEnabled: true,
    presenceDetectionEnabled: true,
    snapshotEnabled: true,
    microphoneEnabled: true,
    wakeWordEnabled: true
  });
  device.settings.reachy.state = {
    mode: 'listening',
    personPresent: true,
    faceTracking: true,
    cameraActive: true,
    speechDetected: true,
    voiceSessionActive: true
  };
  let mirroredState = null;
  service.upsertMirroredDevice = async (_device, options) => {
    mirroredState = { ...options.state };
    assert.equal(sent.some((message) => message.type === 'robot_config_update'), false);
  };
  await service.updateSettings(DEVICE_ID, {
    cameraEnabled: false,
    microphoneEnabled: false
  });
  const state = device.settings.reachy.state;
  assert.equal(state.personPresent, false);
  assert.equal(state.faceTracking, false);
  assert.equal(state.cameraActive, false);
  assert.equal(state.speechDetected, false);
  assert.equal(state.voiceSessionActive, false);
  assert.equal(state.mode, 'idle');
  assert.equal(mirroredState.personPresent, false);
  assert.equal(mirroredState.speechDetected, false);
  assert.equal(sent.at(-1).type, 'robot_config_update');
});

test('offline privacy disable still clears persisted and mirrored presence', async (t) => {
  const { service, device } = connectedService();
  t.after(() => service.shutdown());
  service.setVoiceWebSocket(null);
  device.settings.reachy.safeSettings = normalizeSafeSettings({
    cameraEnabled: true,
    presenceDetectionEnabled: true
  });
  device.settings.reachy.state = { personPresent: true, faceTracking: true };
  let mirrorOnline = true;
  service.upsertMirroredDevice = async (_device, options) => { mirrorOnline = options.online; };
  await service.updateSettings(DEVICE_ID, { presenceDetectionEnabled: false });
  assert.equal(device.settings.reachy.state.personPresent, false);
  assert.equal(mirrorOnline, false);
});

test('disabling speech direction clears DoA state and rejects later direction telemetry', async (t) => {
  const { service, device } = connectedService();
  t.after(() => service.shutdown());
  device.settings.reachy.safeSettings = normalizeSafeSettings({
    microphoneEnabled: true,
    wakeWordEnabled: true,
    speechDirectionEnabled: true
  });
  device.settings.reachy.state = {
    mode: 'idle',
    speechDetected: true,
    speechDirection: 42,
    speechConfidence: 0.8
  };
  let mirroredState = null;
  service.upsertMirroredDevice = async (_device, options) => {
    mirroredState = { ...options.state };
  };

  await service.updateSettings(DEVICE_ID, { speechDirectionEnabled: false });
  assert.equal(device.settings.reachy.state.speechDetected, false);
  assert.equal(Object.hasOwn(device.settings.reachy.state, 'speechDirection'), false);
  assert.equal(Object.hasOwn(device.settings.reachy.state, 'speechConfidence'), false);
  assert.equal(mirroredState.speechDetected, false);
  assert.equal(Object.hasOwn(mirroredState, 'speechDirection'), false);

  await service.handleRobotState(DEVICE_ID, {
    state: { speechDetected: true, speechDirection: 90, speechConfidence: 0.99 }
  });
  assert.equal(device.settings.reachy.state.speechDetected, false);
  assert.equal(Object.hasOwn(device.settings.reachy.state, 'speechDirection'), false);
  const ignored = await service.handleRobotEvent(DEVICE_ID, {
    event: 'speech_detected', direction: 90, confidence: 0.99
  });
  assert.equal(ignored.ignored, true);
  assert.equal(ignored.reason, 'speech_direction_privacy_disabled');
});

test('presence events are ignored when camera/presence privacy is disabled', async () => {
  const { service, device } = connectedService();
  const beforeSaves = device.saves;
  const result = await service.handleRobotEvent(DEVICE_ID, {
    event: 'robot.person.present',
    data: { confidence: 0.99 }
  });
  assert.equal(result.ignored, true);
  assert.equal(result.reason, 'presence_privacy_disabled');
  assert.equal(device.saves, beforeSaves);
  service.shutdown();
});

test('interrupted staging replays the exact durable request and manifest URL', async () => {
  const { service, device, sent } = connectedService();
  const aggregate = '2'.repeat(64);
  device.settings.reachy.appManagement = {
    state: 'staging',
    requestId: 'stage-crash-1',
    targetVersion: '0.2.0',
    aggregateSha256: aggregate,
    manifestUrl: `/api/reachy-mini/${DEVICE_ID}/companion/manifest`,
    requestedAt: new Date()
  };

  const result = await service.resumeInterruptedCompanionUpdate(DEVICE_ID);

  assert.equal(result.replayed, true);
  assert.deepEqual(sent, [{
    type: 'app_management',
    action: 'package_stage',
    requestId: 'stage-crash-1',
    manifestUrl: `/api/reachy-mini/${DEVICE_ID}/companion/manifest`
  }]);
  assert.equal(device.settings.reachy.appManagement.state, 'staging');
  assert.equal(device.settings.reachy.appManagement.recovery.state, 'staging_replayed_after_homebrain_restart');
});

test('startup recovery restarts only the HomeBrain launcher after release-before-daemon-start crash', async () => {
  const service = new ReachyMiniService();
  const device = fakeDevice();
  device.settings.reachy.appManagement = {
    state: 'updating',
    requestId: 'release-crash-1',
    targetVersion: '0.2.0',
    aggregateSha256: '3'.repeat(64),
    recovery: { state: 'armed' }
  };
  service.findInterruptedUpdateDevices = async () => [device];
  service.isConnected = () => false;
  service.getRobot = async () => device;
  service.getDaemonAppStatus = async () => ({ state: 'done', name: null, raw: { state: 'done' } });
  const restarts = [];
  service.restartManagedApp = async (_device, options) => restarts.push(options);

  const results = await service.reconcileInterruptedUpdates();

  assert.equal(results[0].action, 'launcher_started');
  assert.deepEqual(restarts, [{ deviceId: DEVICE_ID, requestId: 'release-crash-1', safeRelease: false }]);
  assert.equal(device.settings.reachy.appManagement.recovery.state, 'launcher_restarted_after_homebrain_crash');
});

test('periodic update recovery never races an active in-process activation', async () => {
  const service = new ReachyMiniService();
  const device = fakeDevice();
  device.settings.reachy.appManagement = { state: 'updating', requestId: 'active-update-1' };
  service.findInterruptedUpdateDevices = async () => [device];
  service.isConnected = () => false;
  service.updateOperations.set(DEVICE_ID, { requestId: 'active-update-1', controller: new AbortController() });
  let daemonReads = 0;
  service.getDaemonAppStatus = async () => {
    daemonReads += 1;
    return { state: 'done', name: null, raw: null };
  };

  const results = await service.reconcileInterruptedUpdates();

  assert.deepEqual(results, [{ deviceId: DEVICE_ID, action: 'active' }]);
  assert.equal(daemonReads, 0);
  service.shutdown();
});

test('all lost confirm ACKs complete only with the exact durable launcher receipt', async () => {
  const { service, device } = connectedService({ reconnectIntervalMs: 0, confirmationReceiptAttempts: 2 });
  const identity = { requestId: 'confirm-proof-1', version: '0.2.0', aggregateSha256: '4'.repeat(64) };
  service.requestConfirmUpdate = async () => {
    throw Object.assign(new Error('ACK lost'), { code: 'REACHY_CONFIRM_ACK_TIMEOUT' });
  };
  service.voiceWebSocket.sendMessage = (_deviceId, message) => {
    if (message.type === 'status_request') {
      device.settings.reachy.releaseStatus = {
        lastConfirmed: { ...identity, confirmedAt: new Date().toISOString() }
      };
    }
    return true;
  };

  const result = await service.confirmCompanionUpdate(DEVICE_ID, identity);

  assert.equal(result.reconciled, true);
  assert.equal(result.source, 'durable_receipt');
});

test('matching runtime identity cannot replace a missing durable confirmation receipt', async () => {
  const { service, device } = connectedService({ reconnectIntervalMs: 0, confirmationReceiptAttempts: 1 });
  const identity = { requestId: 'confirm-proof-missing', version: '0.2.0', aggregateSha256: '5'.repeat(64) };
  device.settings.reachy.appVersion = identity.version;
  device.settings.reachy.appAggregateSha256 = identity.aggregateSha256;
  service.requestConfirmUpdate = async () => {
    throw Object.assign(new Error('ACK lost'), { code: 'REACHY_CONFIRM_ACK_TIMEOUT' });
  };

  await assert.rejects(
    service.confirmCompanionUpdate(DEVICE_ID, identity),
    (error) => error.code === 'REACHY_CONFIRM_ACK_TIMEOUT'
  );
});

test('lost release acknowledgement retries one deterministic tuple', async (t) => {
  const { service, sent } = connectedService({ managementAckTimeoutMs: 250, managementRetryIntervalMs: 20 });
  t.after(() => service.shutdown());
  const aggregate = '6'.repeat(64);
  let sends = 0;
  service.voiceWebSocket.sendMessage = (_deviceId, message) => {
    sent.push(message);
    sends += 1;
    if (sends === 2) {
      setImmediate(() => service.handleAppManagementResult(DEVICE_ID, {
        action: 'release',
        requestId: message.requestId,
        success: true,
        status: 'releasing',
        version: '0.2.0',
        aggregateSha256: aggregate
      }));
    }
    return true;
  };

  const released = await service.requestGracefulAppRelease(
    DEVICE_ID,
    'parent-update-1',
    undefined,
    { version: '0.2.0', aggregateSha256: aggregate }
  );

  assert.equal(released.status, 'releasing');
  assert.ok(sends >= 2);
  assert.equal(new Set(sent.map((message) => JSON.stringify(message))).size, 1);
  assert.equal(sent[0].requestId, `release-${crypto.createHash('sha256').update('parent-update-1').digest('hex').slice(0, 32)}`);
});

test('release ACK loss plus observed app exit continues only to durable-receipt verification', async (t) => {
  const { service, device } = connectedService({
    managementAckTimeoutMs: 100,
    managementRetryIntervalMs: 25,
    daemonStatusPollIntervalMs: 0
  });
  t.after(() => service.shutdown());
  const calls = [];
  let statusReads = 0;
  service.requestDaemon = async (_device, method, endpoint) => {
    calls.push({ method, endpoint });
    if (method === 'GET') {
      statusReads += 1;
      return statusReads === 1
        ? { state: 'running', info: { name: 'reachy-homebrain-app' } }
        : { state: 'done', info: { name: 'reachy-homebrain-app' } };
    }
    return { status: 'started' };
  };
  service.voiceWebSocket.sendMessage = () => true;

  const result = await service.restartManagedApp(device, {
    deviceId: DEVICE_ID,
    requestId: 'release-exit-1',
    version: '0.2.0',
    aggregateSha256: '7'.repeat(64),
    safeRelease: true
  });

  assert.equal(result.releaseAcknowledged, false);
  assert.equal(calls.at(-1).endpoint, '/api/apps/start-app/reachy-homebrain-app');
  assert.equal(calls.some((call) => call.endpoint === '/api/apps/stop-current-app'), false);
});

test('terminal command result resolves a waiting workflow and duplicate is ignored', async (t) => {
  const { service, sent } = connectedService();
  t.after(() => service.shutdown());
  const waiting = service.dispatchCommand(DEVICE_ID, 'wake', {}, { awaitTerminal: true, source: 'workflow' });
  await tick();
  const commandId = sent[0].commandId;

  const started = await service.handleCommandResult(DEVICE_ID, { commandId, status: 'started' });
  assert.equal(started.terminal, false);
  await service.handleCommandResult(DEVICE_ID, { commandId, status: 'completed' });
  const result = await waiting;
  assert.equal(result.status, 'completed');
  assert.equal(result.terminal, true);

  const duplicate = await service.handleCommandResult(DEVICE_ID, { commandId, status: 'completed' });
  assert.deepEqual(duplicate, { ignored: true, duplicate: true, commandId, status: 'completed' });
});

test('nested companion error code and reason propagate to waiting callers', async (t) => {
  const { service, sent, device } = connectedService();
  t.after(() => service.shutdown());
  const waiting = service.dispatchCommand(DEVICE_ID, 'play_move', { move: 'dance' }, { awaitTerminal: true });
  await tick();
  const commandId = sent[0].commandId;

  await service.handleCommandResult(DEVICE_ID, {
    type: 'robot_command_result',
    commandId,
    action: 'play_move',
    status: 'failed',
    error: { code: 'REACHY_MOTOR_FAULT', message: 'motor controller unavailable' }
  });
  await assert.rejects(waiting, (error) => {
    assert.equal(error.code, 'REACHY_MOTOR_FAULT');
    assert.match(error.message, /motor controller unavailable/);
    return true;
  });
  assert.equal(device.settings.reachy.lastCommand.code, 'REACHY_MOTOR_FAULT');
  assert.equal(device.settings.reachy.lastCommand.message, 'motor controller unavailable');
});

test('terminal robot result settles callers even when persistence fails', async (t) => {
  const { service, sent, device } = connectedService();
  t.after(() => service.shutdown());
  const waiting = service.dispatchCommand(DEVICE_ID, 'wake', {}, { awaitTerminal: true });
  await tick();
  const commandId = sent[0].commandId;
  device.save = async () => { throw new Error('database unavailable'); };
  const handled = await service.handleCommandResult(DEVICE_ID, {
    commandId,
    action: 'wake',
    status: 'completed',
    details: { sleeping: false, nested: { values: [1, 2, 3] } }
  });
  const settled = await waiting;
  assert.equal(handled.persisted, false);
  assert.equal(handled.terminal, true);
  assert.deepEqual(settled.details, { sleeping: false, nested: { values: [1, 2, 3] } });
  assert.equal(service.pendingCommands.has(commandId), false);
});

test('a command remains accepted and pollable when persistence fails after the wire send', async (t) => {
  const { service, sent, device } = connectedService();
  t.after(() => service.shutdown());
  device.save = async () => { throw new Error('database unavailable'); };

  const accepted = await service.dispatchCommand(DEVICE_ID, 'wake');
  await tick();
  const wireCommands = sent.filter((message) => message.type === 'robot_command');
  assert.equal(wireCommands.length, 1);
  assert.equal(accepted.commandId, wireCommands[0].commandId);
  assert.equal(accepted.status, 'sent');
  assert.equal(service.getCommandStatus(DEVICE_ID, accepted.commandId).status, 'sent');
  assert.equal(service.pendingCommands.has(accepted.commandId), true);
});

test('emergency stop durably disables idle motion until an operator explicitly re-enables it', async (t) => {
  const { service, sent, device } = connectedService();
  t.after(() => service.shutdown());
  device.settings.reachy.safeSettings.idleMotionEnabled = true;

  await service.dispatchCommand(DEVICE_ID, 'stop');
  const stopCommand = sent.find((message) => message.type === 'robot_command');
  const stopConfig = sent.find((message) => message.type === 'robot_config_update');
  assert.equal(stopCommand.action, 'stop');
  assert.equal(stopConfig.settings.idleMotionEnabled, false);
  assert.equal(device.settings.reachy.safeSettings.idleMotionEnabled, false);
  assert.equal(device.settings.reachy.state.idleMotionEnabled, false);

  await service.updateSettings(DEVICE_ID, { idleMotionEnabled: true });
  const latestConfig = sent.filter((message) => message.type === 'robot_config_update').at(-1);
  assert.equal(latestConfig.settings.idleMotionEnabled, true);
  assert.equal(device.settings.reachy.safeSettings.idleMotionEnabled, true);
});

test('emergency stop exposes preempt_requested until hardware stop is confirmed', async (t) => {
  const { service, sent } = connectedService();
  t.after(() => service.shutdown());
  const motion = service.dispatchCommand(DEVICE_ID, 'play_move', { move: 'dance' }, { awaitTerminal: true });
  await tick();
  const motionId = sent[0].commandId;
  const stop = await service.dispatchCommand(DEVICE_ID, 'stop');
  assert.equal(service.getCommandStatus(DEVICE_ID, motionId).status, 'preempt_requested');
  assert.equal(service.getCommandStatus(DEVICE_ID, motionId).terminal, false);
  await service.handleCommandResult(DEVICE_ID, {
    commandId: stop.commandId,
    action: 'stop',
    status: 'completed'
  });
  await assert.rejects(motion, (error) => error.code === 'REACHY_COMMAND_PREEMPTED');
  assert.equal(service.getCommandStatus(DEVICE_ID, motionId).status, 'cancelled');
  assert.equal(service.getCommandStatus(DEVICE_ID, motionId).preemptedBy, stop.commandId);
});

test('failed stop restores prior command to non-terminal state', async (t) => {
  const { service, sent } = connectedService();
  t.after(() => service.shutdown());
  service.dispatchCommand(DEVICE_ID, 'play_move', { move: 'dance' });
  await tick();
  const motionId = sent[0].commandId;
  const stop = await service.dispatchCommand(DEVICE_ID, 'stop');
  await service.handleCommandResult(DEVICE_ID, {
    commandId: stop.commandId,
    action: 'stop',
    status: 'failed',
    error: { code: 'REACHY_STOP_FAILED', message: 'cancel_move failed' }
  });
  assert.equal(service.getCommandStatus(DEVICE_ID, motionId).status, 'sent');
  assert.equal(service.getCommandStatus(DEVICE_ID, motionId).terminal, false);
});

test('pending command timeout is terminal and queryable', async () => {
  const service = new ReachyMiniService({ commandTimeoutGraceMs: 0 });
  const keepAlive = setInterval(() => {}, 100);
  const commandId = crypto.randomUUID();
  const entry = service.registerPendingCommand(DEVICE_ID, {
    commandId,
    action: 'wake',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5).toISOString()
  }, 5);
  await assert.rejects(entry.promise, (error) => error.code === 'REACHY_COMMAND_TIMEOUT');
  clearInterval(keepAlive);
  assert.equal(service.getCommandStatus(DEVICE_ID, commandId).terminal, true);
  assert.equal(service.getCommandStatus(DEVICE_ID, commandId).code, 'REACHY_COMMAND_TIMEOUT');
  service.shutdown();
});

test('runtime status exposes bounded SDK, daemon, and privacy diagnostics without firmware mislabeling', async (t) => {
  const { service, device } = connectedService();
  t.after(() => service.shutdown());
  const originalRemoveDevice = reachySnapshotService.removeDevice;
  const snapshotRevocations = [];
  t.after(() => { reachySnapshotService.removeDevice = originalRemoveDevice; });
  reachySnapshotService.removeDevice = async (deviceId) => { snapshotRevocations.push(deviceId); };
  await service.handleRuntimeStatus(DEVICE_ID, {
    package: {
      version: '0.1.0',
      aggregateSha256: 'a'.repeat(64),
      reachySdkVersion: '1.9.2',
      daemon: {
        daemonVersion: '1.4.0',
        wireless: true,
        simulation: false,
        state: 'running'
      }
    },
    state: { mode: 'error' },
    privacyFault: 'physical privacy state could not be confirmed',
    wakeWord: { state: 'unavailable', models: [], error: null }
  });

  const robot = service.sanitizeRobot(device);
  assert.equal(robot.sdkVersion, '1.9.2');
  assert.equal(robot.daemonVersion, '1.4.0');
  assert.deepEqual(robot.daemon, {
    daemonVersion: '1.4.0',
    wireless: true,
    simulation: false,
    state: 'running'
  });
  assert.equal(robot.privacyFault, 'physical privacy state could not be confirmed');
  assert.equal(robot.lastError, 'physical privacy state could not be confirmed');
  assert.equal(Object.hasOwn(robot, 'firmwareVersion'), false);
  assert.deepEqual(snapshotRevocations, [DEVICE_ID]);

  await service.handleRobotEvent(DEVICE_ID, {
    event: 'error',
    component: 'privacy',
    message: 'privacy output confirmation failed'
  });
  assert.equal(service.sanitizeRobot(device).privacyFault, 'privacy output confirmation failed');
  assert.deepEqual(snapshotRevocations, [DEVICE_ID, DEVICE_ID]);

  await service.handleRuntimeStatus(DEVICE_ID, {
    package: { version: '0.1.0', aggregateSha256: 'a'.repeat(64) },
    state: { mode: 'idle' },
    privacyFault: null,
    wakeWord: { state: 'unavailable', models: [], error: null }
  });
  assert.equal(service.sanitizeRobot(device).privacyFault, null);
  assert.equal(service.sanitizeRobot(device).lastError, null);
  assert.deepEqual(snapshotRevocations, [DEVICE_ID, DEVICE_ID]);
});

test('privacy faults are persisted before snapshot purge advances the permission epoch', async (t) => {
  const { service, device } = connectedService();
  t.after(() => service.shutdown());
  const originalRemoveDevice = reachySnapshotService.removeDevice;
  t.after(() => { reachySnapshotService.removeDevice = originalRemoveDevice; });

  let saveStartedResolve;
  let releaseSave;
  const saveStarted = new Promise((resolve) => { saveStartedResolve = resolve; });
  const saveHeld = new Promise((resolve) => { releaseSave = resolve; });
  let persisted = false;
  let purgeObservedPersisted = null;
  device.save = async () => {
    saveStartedResolve();
    await saveHeld;
    persisted = true;
    return device;
  };
  reachySnapshotService.removeDevice = async () => {
    purgeObservedPersisted = persisted;
  };

  const handling = service.handleRuntimeStatus(DEVICE_ID, {
    package: { version: '0.1.0', aggregateSha256: 'a'.repeat(64) },
    state: { mode: 'error' },
    privacyFault: 'camera shutdown confirmation failed',
    wakeWord: { state: 'unavailable', models: [], error: null }
  });

  await saveStarted;
  assert.equal(purgeObservedPersisted, null);
  releaseSave();
  await handling;
  assert.equal(purgeObservedPersisted, true);
});

test('shutdown synchronously sends an exact rollback before aborting update work', () => {
  const { service, sent } = connectedService();
  const controller = new AbortController();
  service.updateOperations.set(DEVICE_ID, {
    requestId: 'shutdown-update-1',
    controller,
    rollbackArmed: true,
    rollback: {
      version: '0.1.0',
      aggregateSha256: 'a'.repeat(64)
    }
  });

  service.shutdown();

  assert.deepEqual(sent[0], {
    type: 'app_management',
    action: 'rollback',
    requestId: 'shutdown-update-1',
    version: '0.1.0',
    aggregateSha256: 'a'.repeat(64)
  });
  assert.equal(controller.signal.aborted, true);
});

test('all companion event names normalize to the backend event contract', () => {
  const service = new ReachyMiniService();
  const expected = new Map([
    ['robot.online', 'online'],
    ['robot.offline', 'offline'],
    ['robot.motion.completed', 'motion_completed'],
    ['robot.motion.failed', 'motion_failed'],
    ['robot.voice.session.started', 'voice_session_started'],
    ['robot.voice.session.completed', 'voice_session_completed'],
    ['robot.error', 'error'],
    ['robot.person.present', 'person_present'],
    ['robot.person.cleared', 'person_cleared']
  ]);
  for (const [wireName, normalized] of expected) {
    assert.equal(service.normalizeRobotEvent({ event: wireName, data: {} }).eventType, normalized);
  }
});

test('single-flight update gate rejects a second request before overwriting correlation', async () => {
  const service = new ReachyMiniService();
  service.checkCompanionUpdate = async () => ({
    state: 'staging',
    requestId: 'existing-request',
    requestedAt: new Date(),
    updateAvailable: false,
    unavailableReason: null
  });
  await assert.rejects(
    service.requestCompanionUpdate(DEVICE_ID),
    (error) => error.status === 409 && error.code === 'REACHY_UPDATE_IN_PROGRESS'
  );
});

test('daemon state machine refuses to stop another active Reachy app', async () => {
  const service = new ReachyMiniService({ daemonStatusPollIntervalMs: 0 });
  const calls = [];
  service.requestDaemon = async (_device, method, endpoint) => {
    calls.push({ method, endpoint });
    return { state: 'running', info: { name: 'teleoperation' } };
  };
  await assert.rejects(
    service.restartManagedApp(fakeDevice(), { deviceId: DEVICE_ID }),
    (error) => error.code === 'REACHY_DAEMON_APP_CONFLICT'
  );
  assert.deepEqual(calls, [{ method: 'GET', endpoint: '/api/apps/current-app-status' }]);
});

test('daemon state machine starts the stable launcher without install/update APIs', async () => {
  const service = new ReachyMiniService();
  const calls = [];
  service.requestDaemon = async (_device, method, endpoint) => {
    calls.push({ method, endpoint });
    if (method === 'GET') return null;
    return { status: 'started' };
  };
  await service.restartManagedApp(fakeDevice(), { deviceId: DEVICE_ID });
  assert.deepEqual(calls, [
    { method: 'GET', endpoint: '/api/apps/current-app-status' },
    { method: 'POST', endpoint: '/api/apps/start-app/reachy-homebrain-app' }
  ]);
  assert.equal(calls.some((call) => /install|update|remove/.test(call.endpoint)), false);
});

test('verified release activation succeeds only after fingerprint reconnect', async () => {
  const { service, device } = connectedService();
  const aggregate = 'b'.repeat(64);
  device.settings.reachy.appManagement = {
    requestId: 'update-1',
    targetVersion: '0.2.0',
    aggregateSha256: aggregate,
    previousVersion: '0.1.0',
    previousAggregateSha256: 'a'.repeat(64)
  };
  const restarts = [];
  service.requestPrepareUpdate = async (_id, result) => {
    assert.equal(result.version, '0.2.0');
    assert.equal(result.aggregateSha256, aggregate);
  };
  service.requestConfirmUpdate = async (_id, result) => {
    assert.equal(result.aggregateSha256, aggregate);
  };
  service.restartManagedApp = async (_device, options) => restarts.push(options);
  service.waitForUpdatedReconnect = async (_id, version, fingerprint) => {
    assert.equal(version, '0.2.0');
    assert.equal(fingerprint, aggregate);
  };

  await service.activateStagedCompanionUpdate(DEVICE_ID, {
    requestId: 'update-1',
    version: '0.2.0',
    aggregateSha256: aggregate
  });

  assert.equal(restarts.length, 1);
  assert.equal(device.settings.reachy.appManagement.state, 'completed');
  assert.equal(device.settings.reachy.appManagement.installedVersion, '0.2.0');
  assert.deepEqual(device.settings.reachy.appManagement.recovery, { state: 'not_required' });
});

test('failed candidate is restarted once more and records successful automatic rollback', async () => {
  const { service, device } = connectedService();
  const aggregate = 'b'.repeat(64);
  device.settings.reachy.appManagement = {
    requestId: 'update-2',
    targetVersion: '0.2.0',
    aggregateSha256: aggregate,
    previousVersion: '0.1.0',
    previousAggregateSha256: 'a'.repeat(64)
  };
  let restartCount = 0;
  let reconnectCount = 0;
  service.requestPrepareUpdate = async () => {};
  service.requestConfirmUpdate = async () => {
    throw Object.assign(new Error('candidate never became healthy'), { code: 'REACHY_CONFIRM_ACK_TIMEOUT' });
  };
  service.requestRollbackUpdate = async (_id, rollback) => {
    assert.equal(rollback.version, '0.1.0');
    assert.equal(rollback.aggregateSha256, 'a'.repeat(64));
  };
  service.restartManagedApp = async () => { restartCount += 1; };
  service.waitForUpdatedReconnect = async (_id, version) => {
    reconnectCount += 1;
    if (reconnectCount === 1) {
      throw Object.assign(new Error('candidate import crashed'), { code: 'REACHY_UPDATE_RECONNECT_TIMEOUT' });
    }
    assert.equal(version, '0.1.0');
  };

  await assert.rejects(
    service.activateStagedCompanionUpdate(DEVICE_ID, {
      requestId: 'update-2',
      version: '0.2.0',
      aggregateSha256: aggregate
    }),
    (error) => error.code === 'REACHY_UPDATE_ROLLED_BACK'
  );
  assert.equal(restartCount, 2);
  assert.equal(device.settings.reachy.appManagement.state, 'failed');
  assert.equal(device.settings.reachy.appManagement.installedVersion, '0.1.0');
  assert.equal(device.settings.reachy.appManagement.recovery.state, 'recovered');
});

test('shutdown aborts fingerprint polling without later state mutation', async () => {
  const { service, device } = connectedService({ reconnectAttempts: 1000, reconnectIntervalMs: 1000 });
  const aggregate = 'b'.repeat(64);
  device.settings.reachy.appManagement = {
    requestId: 'update-3',
    targetVersion: '0.2.0',
    aggregateSha256: aggregate,
    previousVersion: '0.1.0',
    previousAggregateSha256: 'a'.repeat(64)
  };
  service.restartManagedApp = async () => {};
  service.requestPrepareUpdate = async () => {};
  service.requestConfirmUpdate = async () => {};
  service.isConnected = () => false;
  const updating = service.activateStagedCompanionUpdate(DEVICE_ID, {
    requestId: 'update-3',
    version: '0.2.0',
    aggregateSha256: aggregate
  });
  await tick();
  service.shutdown();
  const savesAtShutdown = device.saves;
  await assert.rejects(updating, (error) => error.code === 'REACHY_UPDATE_CANCELLED');
  await tick();
  assert.equal(device.saves, savesAtShutdown);
  assert.equal(service.updateOperations.size, 0);
});

test('prepare-update handshake is correlated to request, version, and full digest', async (t) => {
  const { service, sent } = connectedService();
  t.after(() => service.shutdown());
  const aggregate = 'c'.repeat(64);
  const controller = new AbortController();
  const prepared = service.requestPrepareUpdate(DEVICE_ID, {
    requestId: 'prepare-1',
    version: '0.2.0',
    aggregateSha256: aggregate
  }, controller.signal);
  assert.deepEqual(sent[0], {
    type: 'app_management',
    action: 'prepare_update',
    requestId: 'prepare-1',
    version: '0.2.0',
    aggregateSha256: aggregate
  });
  service.handleUpdateStatus(DEVICE_ID, {
    type: 'update_status',
    action: 'prepare_update',
    requestId: 'prepare-1',
    success: true,
    status: 'prepared',
    version: '0.2.0',
    aggregateSha256: aggregate
  });
  assert.equal((await prepared).status, 'prepared');
});

test('mismatched prepare-update acknowledgement cannot trigger restart', async (t) => {
  const { service } = connectedService();
  t.after(() => service.shutdown());
  const prepared = service.requestPrepareUpdate(DEVICE_ID, {
    requestId: 'prepare-2',
    version: '0.2.0',
    aggregateSha256: 'd'.repeat(64)
  });
  service.handleUpdateStatus(DEVICE_ID, {
    action: 'prepare_update',
    requestId: 'prepare-2',
    success: true,
    status: 'prepared',
    version: '0.2.0',
    aggregateSha256: 'e'.repeat(64)
  });
  await assert.rejects(prepared, (error) => error.code === 'REACHY_PREPARE_CORRELATION_FAILED');
});

test('candidate promotion requires correlated confirm-update acknowledgement', async (t) => {
  const { service, sent } = connectedService();
  t.after(() => service.shutdown());
  const aggregate = 'f'.repeat(64);
  const confirmed = service.requestConfirmUpdate(DEVICE_ID, {
    requestId: 'confirm-1',
    version: '0.2.0',
    aggregateSha256: aggregate
  });
  assert.deepEqual(sent[0], {
    type: 'app_management',
    action: 'confirm_update',
    requestId: 'confirm-1',
    version: '0.2.0',
    aggregateSha256: aggregate
  });
  service.handleAppManagementResult(DEVICE_ID, {
    type: 'app_management_result',
    action: 'confirm_update',
    requestId: 'confirm-1',
    success: true,
    status: 'confirmed',
    version: '0.2.0',
    aggregateSha256: aggregate
  });
  assert.equal((await confirmed).status, 'confirmed');
});

test('lost confirm acknowledgement retries the exact idempotent tuple', async (t) => {
  const { service, sent } = connectedService({
    managementAckTimeoutMs: 250,
    managementRetryIntervalMs: 20
  });
  t.after(() => service.shutdown());
  const aggregate = '1'.repeat(64);
  let sends = 0;
  service.voiceWebSocket.sendMessage = (_deviceId, message) => {
    sent.push(message);
    sends += 1;
    if (sends === 2) {
      setImmediate(() => service.handleConfirmUpdateResult(DEVICE_ID, {
        action: 'confirm_update',
        requestId: 'confirm-retry',
        success: true,
        status: 'confirmed',
        version: '0.2.0',
        aggregateSha256: aggregate
      }));
    }
    return true;
  };
  const confirmed = await service.requestConfirmUpdate(DEVICE_ID, {
    requestId: 'confirm-retry',
    version: '0.2.0',
    aggregateSha256: aggregate
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(sends >= 2);
  assert.equal(sent.every((message) => (
    message.requestId === 'confirm-retry'
    && message.version === '0.2.0'
    && message.aggregateSha256 === aggregate
  )), true);
});

test('lost rollback acknowledgement retries the exact prior identity', async (t) => {
  const { service, sent } = connectedService({
    managementAckTimeoutMs: 250,
    managementRetryIntervalMs: 20
  });
  t.after(() => service.shutdown());
  const aggregate = 'a'.repeat(64);
  let sends = 0;
  service.voiceWebSocket.sendMessage = (_deviceId, message) => {
    sent.push(message);
    sends += 1;
    if (sends === 2) {
      setImmediate(() => service.handleRollbackUpdateResult(DEVICE_ID, {
        action: 'rollback',
        requestId: 'rollback-retry',
        success: true,
        status: 'rolled_back',
        version: '0.1.0',
        aggregateSha256: aggregate
      }));
    }
    return true;
  };
  const rolledBack = await service.requestRollbackUpdate(DEVICE_ID, {
    requestId: 'rollback-retry',
    version: '0.1.0',
    aggregateSha256: aggregate
  });
  assert.equal(rolledBack.status, 'rolled_back');
  assert.ok(sends >= 2);
  assert.equal(sent.every((message) => message.action === 'rollback' && message.requestId === 'rollback-retry'), true);
});

test('ambiguous prepare acknowledgement is disarmed before any later restart can launch it', async () => {
  const { service, device } = connectedService();
  const aggregate = 'b'.repeat(64);
  device.settings.reachy.appManagement = {
    requestId: 'prepare-ack-lost',
    targetVersion: '0.2.0',
    aggregateSha256: aggregate,
    previousVersion: '0.1.0',
    previousAggregateSha256: 'a'.repeat(64)
  };
  service.requestPrepareUpdate = async () => {
    throw Object.assign(new Error('prepare acknowledgement lost'), { code: 'REACHY_PREPARE_ACK_TIMEOUT' });
  };
  let rollback = null;
  service.requestRollbackUpdate = async (_deviceId, requested) => { rollback = requested; };
  service.restartManagedApp = async () => {};
  service.waitForUpdatedReconnect = async (_id, version, digest) => {
    assert.equal(version, '0.1.0');
    assert.equal(digest, 'a'.repeat(64));
  };
  await assert.rejects(
    service.activateStagedCompanionUpdate(DEVICE_ID, {
      requestId: 'prepare-ack-lost',
      version: '0.2.0',
      aggregateSha256: aggregate
    }),
    (error) => error.code === 'REACHY_UPDATE_ROLLED_BACK'
  );
  assert.deepEqual(rollback, {
    requestId: 'prepare-ack-lost',
    version: '0.1.0',
    aggregateSha256: 'a'.repeat(64)
  });
  service.shutdown();
});

const EventEmitter = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const VoiceDevice = require('../models/VoiceDevice');
const VoiceCommand = require('../models/VoiceCommand');
const WakeWordModel = require('../models/WakeWordModel');
const VoiceWebSocketServer = require('../websocket/voiceWebSocket');
const reachyMiniService = require('../services/reachyMiniService');
const voiceCommandService = require('../services/voiceCommandService');
const voiceAcknowledgmentService = require('../services/voiceAcknowledgmentService');
const { hashDeviceToken } = require('../services/voiceDeviceLifecycleService');
const { redactMessageForLog } = VoiceWebSocketServer;

class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.sent = [];
  }

  send(payload, callback) {
    this.sent.push(JSON.parse(payload));
    if (typeof callback === 'function') {
      callback();
    }
    return true;
  }

  close(code, reason) {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, reason);
  }
}

const deviceId = '507f1f77bcf86cd799439011';

function createDevice() {
  return {
    _id: { toString: () => deviceId },
    name: 'Pi5',
    room: 'Living Room',
    supportedWakeWords: ['Anna'],
    settings: {
      registered: true,
      deviceTokenHash: 'hashed-token',
      lifecycle: { state: 'activated' }
    }
  };
}

function createReachyDevice() {
  const device = createDevice();
  device.deviceType = 'robot';
  device.supportedWakeWords = ['Anna'];
  device.settings.wakeWordThreshold = 0.55;
  device.settings.reachy = {
    safeSettings: { microphoneEnabled: true, wakeWordEnabled: true }
  };
  return device;
}

function connectReachy(voiceWs, ws = new MockWebSocket()) {
  const connection = {
    ws,
    authenticated: true,
    device: createReachyDevice(),
    pendingWakeWord: null,
    captureGrant: null,
    lastPing: Date.now()
  };
  voiceWs.deviceConnections.set(deviceId, connection);
  return connection;
}

test('TTS voice lookup logs untrusted device identifiers as structured fields', async (t) => {
  const originalWarn = console.warn;
  const warnings = [];
  t.after(() => { console.warn = originalWarn; });
  console.warn = (...args) => warnings.push(args);

  const untrustedDeviceId = 'device-%s-%d';
  const voiceWs = new VoiceWebSocketServer();
  const ws = new MockWebSocket();
  voiceWs.deviceConnections.set(untrustedDeviceId, {
    ws,
    authenticated: true,
    device: createDevice()
  });
  voiceWs.getPreferredVoiceId = async () => {
    throw new Error('lookup-%s-failed');
  };

  const result = await voiceWs.playTtsToDevice(untrustedDeviceId, 'safe test phrase');

  assert.deepEqual(result, { success: true });
  assert.deepEqual(warnings, [[
    'Failed to resolve preferred voice for device',
    { deviceId: untrustedDeviceId, error: 'lookup-%s-failed' }
  ]]);
  assert.equal(ws.sent[0].voice, 'default');
});

test('voice websocket buffers early auth messages while device record loads', async (t) => {
  const originalFindById = VoiceDevice.findById;
  let resolveFindById;

  t.after(() => {
    VoiceDevice.findById = originalFindById;
  });

  VoiceDevice.findById = async () => new Promise((resolve) => {
    resolveFindById = resolve;
  });

  const voiceWs = new VoiceWebSocketServer();
  const ws = new MockWebSocket();
  const handled = [];
  voiceWs.handleMessage = async (handledDeviceId, rawMessage) => {
    handled.push({
      deviceId: handledDeviceId,
      type: JSON.parse(rawMessage.toString()).type
    });
  };

  const connectionPromise = voiceWs.handleConnection(ws, {
    url: `/ws/voice-device/${deviceId}`,
    headers: { host: 'localhost:3000' }
  });

  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'authenticate',
    deviceToken: 'device-token'
  })));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(handled.length, 0);

  resolveFindById(createDevice());
  await connectionPromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(handled, [{ deviceId, type: 'authenticate' }]);
  assert.equal(voiceWs.deviceConnections.has(deviceId), false);
  assert.equal(voiceWs.pendingConnections.has(ws), true);
  assert.equal(ws.sent[0].type, 'welcome');
});

test('pending and superseded sockets cannot inject frames into an authenticated Reachy connection', async (t) => {
  const originalFindByIdAndUpdate = VoiceDevice.findByIdAndUpdate;
  const originalEvent = reachyMiniService.handleRobotEvent;
  const originalManagement = reachyMiniService.handleAppManagementResult;
  t.after(() => {
    VoiceDevice.findByIdAndUpdate = originalFindByIdAndUpdate;
    reachyMiniService.handleRobotEvent = originalEvent;
    reachyMiniService.handleAppManagementResult = originalManagement;
  });
  let offlineWrites = 0;
  let injectedFrames = 0;
  VoiceDevice.findByIdAndUpdate = async () => { offlineWrites += 1; };
  reachyMiniService.handleRobotEvent = async () => { injectedFrames += 1; };
  reachyMiniService.handleAppManagementResult = async () => { injectedFrames += 1; };

  const voiceWs = new VoiceWebSocketServer();
  const authenticatedWs = new MockWebSocket();
  const pendingWs = new MockWebSocket();
  const device = createDevice();
  device.deviceType = 'robot';
  device.settings.reachy = {
    safeSettings: { microphoneEnabled: true, wakeWordEnabled: true }
  };
  const active = { ws: authenticatedWs, authenticated: true, device, lastPing: Date.now() };
  const pending = { ws: pendingWs, authenticated: false, device, lastPing: Date.now() };
  voiceWs.deviceConnections.set(deviceId, active);
  voiceWs.pendingConnections.set(pendingWs, pending);

  for (const frame of [
    { type: 'robot_event', event: 'person_present' },
    { type: 'app_management_result', action: 'confirm_update', success: true },
    { type: 'audio_data', sessionId: 'attacker', isStart: true, sampleRate: 16000, channels: 1, format: 'S16LE' }
  ]) {
    await voiceWs.handleMessage(deviceId, Buffer.from(JSON.stringify(frame)), pendingWs);
  }
  assert.equal(injectedFrames, 0);
  assert.equal(voiceWs.audioSessions.size, 0);
  assert.equal(voiceWs.deviceConnections.get(deviceId), active);

  await voiceWs.handleDisconnection(deviceId, 1000, 'pending closed', pendingWs);
  assert.equal(offlineWrites, 0);
  assert.equal(voiceWs.deviceConnections.get(deviceId), active);

  const supersededWs = new MockWebSocket();
  await voiceWs.handleMessage(deviceId, Buffer.from(JSON.stringify({
    type: 'robot_event',
    event: 'person_present'
  })), supersededWs);
  assert.equal(supersededWs.readyState, WebSocket.CLOSED);
  assert.equal(injectedFrames, 0);
  assert.equal(voiceWs.deviceConnections.get(deviceId), active);
});

test('per-device inbound queue drains a delayed old generation before promoting its replacement', async (t) => {
  const originalEvent = reachyMiniService.handleRobotEvent;
  t.after(() => { reachyMiniService.handleRobotEvent = originalEvent; });
  const voiceWs = new VoiceWebSocketServer();
  const oldWs = new MockWebSocket();
  const newWs = new MockWebSocket();
  const oldConnection = connectReachy(voiceWs, oldWs);
  const newConnection = {
    ws: newWs,
    deviceId,
    authenticated: false,
    device: createReachyDevice(),
    lastPing: Date.now()
  };
  voiceWs.pendingConnections.set(newWs, newConnection);
  let releaseOld;
  let oldStarted = false;
  reachyMiniService.handleRobotEvent = async () => {
    oldStarted = true;
    await new Promise((resolve) => { releaseOld = resolve; });
  };
  voiceWs.handleAuthentication = async (_id, _message, connection) => {
    connection.authenticated = true;
    voiceWs.deviceConnections.set(deviceId, connection);
    voiceWs.pendingConnections.delete(connection.ws);
  };

  const oldFrame = voiceWs.enqueueMessage(deviceId, Buffer.from(JSON.stringify({
    type: 'robot_event', event: 'person_present'
  })), oldWs);
  while (!oldStarted) await new Promise((resolve) => setImmediate(resolve));
  const replacementAuth = voiceWs.enqueueMessage(deviceId, Buffer.from(JSON.stringify({
    type: 'authenticate', deviceToken: 'new-token'
  })), newWs);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(voiceWs.deviceConnections.get(deviceId), oldConnection);

  releaseOld();
  await Promise.all([oldFrame, replacementAuth]);
  assert.equal(voiceWs.deviceConnections.get(deviceId), newConnection);

  await voiceWs.enqueueMessage(deviceId, Buffer.from(JSON.stringify({
    type: 'robot_event', event: 'person_present'
  })), oldWs);
  assert.equal(oldWs.readyState, WebSocket.CLOSED);
});

test('credential revocation closes active and pending generations and clears audio', () => {
  const voiceWs = new VoiceWebSocketServer();
  const activeWs = new MockWebSocket();
  const pendingWs = new MockWebSocket();
  connectReachy(voiceWs, activeWs);
  voiceWs.pendingConnections.set(pendingWs, {
    ws: pendingWs,
    deviceId,
    authenticated: false,
    device: createReachyDevice()
  });
  voiceWs.audioSessions.set(deviceId, { chunks: [Buffer.from('private')] });

  assert.equal(voiceWs.revokeDeviceCredentials(deviceId), 2);
  assert.equal(activeWs.readyState, WebSocket.CLOSED);
  assert.equal(pendingWs.readyState, WebSocket.CLOSED);
  assert.equal(voiceWs.deviceConnections.has(deviceId), false);
  assert.equal(voiceWs.pendingConnections.has(pendingWs), false);
  assert.equal(voiceWs.audioSessions.has(deviceId), false);
});

test('revocation during interpretation prevents execution and never routes TTS to a replacement', async (t) => {
  const originalSave = VoiceCommand.prototype.save;
  const originalUpdate = VoiceDevice.findByIdAndUpdate;
  const originalContext = voiceCommandService.getContext;
  const originalInterpret = voiceCommandService.interpretCommand;
  const originalExecute = voiceCommandService.executeActions;
  const originalAcknowledgment = voiceAcknowledgmentService.getRandomAcknowledgment;
  t.after(() => {
    VoiceCommand.prototype.save = originalSave;
    VoiceDevice.findByIdAndUpdate = originalUpdate;
    voiceCommandService.getContext = originalContext;
    voiceCommandService.interpretCommand = originalInterpret;
    voiceCommandService.executeActions = originalExecute;
    voiceAcknowledgmentService.getRandomAcknowledgment = originalAcknowledgment;
  });
  VoiceCommand.prototype.save = async function save() { return this; };
  VoiceDevice.findByIdAndUpdate = async () => createReachyDevice();
  voiceAcknowledgmentService.getRandomAcknowledgment = async () => null;
  voiceCommandService.getContext = async () => ({ deviceMap: new Map(), sceneMap: new Map() });
  let releaseInterpretation;
  let interpretationStarted = false;
  voiceCommandService.interpretCommand = async () => {
    interpretationStarted = true;
    await new Promise((resolve) => { releaseInterpretation = resolve; });
    return {
      interpretation: {
        intent: 'device_control',
        confidence: 1,
        normalizedCommand: 'turn on lamp',
        actions: [{ type: 'device_control', deviceId: 'lamp-1', action: 'turn_on' }],
        response: 'Done',
        followUpQuestion: null
      },
      llm: { provider: 'test', model: 'test' }
    };
  };
  let executions = 0;
  voiceCommandService.executeActions = async () => {
    executions += 1;
    return { status: 'success', results: [], entities: {} };
  };
  const voiceWs = new VoiceWebSocketServer();
  voiceWs.getPreferredVoiceId = async () => 'default';
  const oldWs = new MockWebSocket();
  const oldConnection = connectReachy(voiceWs, oldWs);
  oldConnection.pendingWakeWord = { wakeWord: 'anna' };

  const processing = voiceWs.processVoiceCommandText(deviceId, {
    commandText: 'please adjust the lamp',
    sourceConnection: oldConnection
  });
  while (!interpretationStarted) await new Promise((resolve) => setImmediate(resolve));

  voiceWs.revokeDeviceCredentials(deviceId);
  const replacementWs = new MockWebSocket();
  connectReachy(voiceWs, replacementWs);
  releaseInterpretation();
  await processing;

  assert.equal(executions, 0);
  assert.equal(replacementWs.sent.some((message) => message.type === 'tts_response'), false);
});

test('loopback proxy uses the validated rightmost X-Forwarded-For address', async (t) => {
  const originalFindById = VoiceDevice.findById;
  t.after(() => { VoiceDevice.findById = originalFindById; });
  VoiceDevice.findById = async () => createReachyDevice();
  const voiceWs = new VoiceWebSocketServer();
  const ws = new MockWebSocket();

  await voiceWs.handleConnection(ws, {
    url: `/ws/voice-device/${deviceId}`,
    headers: {
      host: 'localhost:3000',
      'x-forwarded-for': '192.168.50.9, 10.0.0.44'
    },
    socket: { remoteAddress: '127.0.0.1' }
  });

  assert.equal(voiceWs.pendingConnections.get(ws).peerAddress, '10.0.0.44');
  assert.notEqual(voiceWs.pendingConnections.get(ws).peerAddress, '192.168.50.9');
});

test('voice websocket ignores stale socket disconnects for an active device connection', async (t) => {
  const originalFindByIdAndUpdate = VoiceDevice.findByIdAndUpdate;
  let updateCount = 0;

  t.after(() => {
    VoiceDevice.findByIdAndUpdate = originalFindByIdAndUpdate;
  });

  VoiceDevice.findByIdAndUpdate = async () => {
    updateCount += 1;
    return createDevice();
  };

  const voiceWs = new VoiceWebSocketServer();
  const currentWs = new MockWebSocket();
  const staleWs = new MockWebSocket();

  voiceWs.deviceConnections.set(deviceId, {
    ws: currentWs,
    device: createDevice(),
    authenticated: true,
    lastPing: Date.now()
  });

  await voiceWs.handleDisconnection(deviceId, 1006, 'stale socket', staleWs);

  assert.equal(voiceWs.deviceConnections.get(deviceId).ws, currentWs);
  assert.equal(updateCount, 0);

  await voiceWs.handleDisconnection(deviceId, 1000, 'current socket', currentWs);

  assert.equal(voiceWs.deviceConnections.has(deviceId), false);
  assert.equal(updateCount, 1);
});

test('buildWakeWordConfig includes sanitized remote audio settings', async (t) => {
  const originalFind = WakeWordModel.find;

  t.after(() => {
    WakeWordModel.find = originalFind;
  });

  WakeWordModel.find = async () => [];

  const voiceWs = new VoiceWebSocketServer();
  const device = createDevice();
  device.settings.audio = {
    recordingDevice: ' auto ',
    preferredInputName: ' Jabra ',
    recorder: 'arecord',
    audioType: 'raw',
    sampleRate: 16000,
    channels: 1,
    threshold: 0.25,
    ignoredKey: 'ignored'
  };

  const { config } = await voiceWs.buildWakeWordConfig(device, { deviceToken: 'token' }, {
    platform: 'linux',
    arch: 'arm64'
  });

  assert.deepEqual(config.audio, {
    recordingDevice: 'auto',
    preferredInputName: 'Jabra',
    recorder: 'arecord',
    audioType: 'raw',
    sampleRate: 16000,
    channels: 1,
    threshold: 0.25
  });
});

test('buildWakeWordConfig normalizes zero wake-word RMS gate to the default', async (t) => {
  const originalFind = WakeWordModel.find;

  t.after(() => {
    WakeWordModel.find = originalFind;
  });

  WakeWordModel.find = async () => [];

  const voiceWs = new VoiceWebSocketServer();
  const device = createDevice();
  device.settings.wakeWordVad = { minRms: 0 };

  const { config } = await voiceWs.buildWakeWordConfig(device, { deviceToken: 'token' }, {
    platform: 'linux',
    arch: 'arm64'
  });

  assert.equal(config.wakeWord.vad.minRms, 0.004);
});

test('buildWakeWordConfig uses calibrated model thresholds and excludes missing assets', async (t) => {
  const originalFind = WakeWordModel.find;
  const originalAssets = require('../utils/wakeWordAssets').getAssetsForWakeWords;
  t.after(() => {
    WakeWordModel.find = originalFind;
    require('../utils/wakeWordAssets').getAssetsForWakeWords = originalAssets;
  });
  WakeWordModel.find = async () => [{
    slug: 'anna',
    metadata: { threshold: 0.72, recommendedSensitivity: 0.28 }
  }];
  require('../utils/wakeWordAssets').getAssetsForWakeWords = () => [{
    label: 'Anna',
    slug: 'anna',
    fileName: 'anna.onnx',
    checksum: 'a'.repeat(64),
    size: 100,
    threshold: 0.55,
    sensitivity: null,
    engine: 'openwakeword',
    format: 'onnx',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    dependencies: []
  }];

  const voiceWs = new VoiceWebSocketServer();
  const device = createDevice();
  device.supportedWakeWords = ['Anna', 'Home Brain'];
  const { config } = await voiceWs.buildWakeWordConfig(device, { deviceToken: 'token' }, {
    platform: 'linux',
    arch: 'arm64'
  });

  assert.deepEqual(config.wakeWords, ['Anna']);
  assert.deepEqual(config.wakeWord.enabled, ['Anna']);
  assert.deepEqual(config.wakeWord.missing, ['Home Brain']);
  assert.equal(config.wakeWord.assets[0].threshold, 0.72);
  assert.equal(config.wakeWord.assets[0].sensitivity, 0.28);
});

test('speaker wake acknowledgment advertises adaptive endpointing instead of a five-second cutoff', async (t) => {
  const originalSave = VoiceCommand.prototype.save;
  const originalUpdate = VoiceDevice.findByIdAndUpdate;
  t.after(() => {
    VoiceCommand.prototype.save = originalSave;
    VoiceDevice.findByIdAndUpdate = originalUpdate;
  });
  VoiceCommand.prototype.save = async function save() { return this; };
  VoiceDevice.findByIdAndUpdate = async () => createDevice();

  const voiceWs = new VoiceWebSocketServer();
  const ws = new MockWebSocket();
  const connection = {
    ws,
    authenticated: true,
    device: createDevice(),
    pendingWakeWord: null,
    lastPing: Date.now()
  };
  voiceWs.deviceConnections.set(deviceId, connection);

  await voiceWs.handleWakeWordDetection(deviceId, {
    wakeWord: 'Anna',
    confidence: 0.95,
    timestamp: new Date().toISOString()
  });

  const acknowledgment = ws.sent.find((message) => message.type === 'wake_word_ack');
  assert.equal(acknowledgment.timeout, 15000);
  assert.deepEqual(acknowledgment.endpointing, {
    minCaptureMs: 1800,
    silenceMs: 1100,
    speechStartTimeoutMs: 6000,
    minSpeechMs: 160,
    minRms: 0.0025
  });
});

test('stripWakeWordPrefix removes wake words from one-breath commands', () => {
  const voiceWs = new VoiceWebSocketServer();

  assert.equal(
    voiceWs.stripWakeWordPrefix('Hey Anna, what time is it?', 'anna'),
    'what time is it?'
  );
  assert.equal(
    voiceWs.stripWakeWordPrefix('hey henry turn on the kitchen lights', 'hey henry'),
    'turn on the kitchen lights'
  );
  assert.equal(
    voiceWs.stripWakeWordPrefix('turn on the kitchen lights', 'anna'),
    'turn on the kitchen lights'
  );
  assert.equal(
    voiceWs.stripWakeWordPrefix('Henry should not be stripped after Anna woke', 'anna'),
    'Henry should not be stripped after Anna woke'
  );
});

test('websocket logging never includes household audio, transcripts, or credentials', () => {
  const audioData = Buffer.alloc(4096, 7).toString('base64');
  const redacted = redactMessageForLog({
    type: 'audio_data',
    sessionId: 'session-1',
    sequence: 4,
    audioData,
    command: 'unlock the front door',
    transcript: 'private household conversation',
    deviceToken: 'top-secret-token'
  });
  const serialized = JSON.stringify(redacted);
  assert.equal(redacted.audioData, '[redacted audio]');
  assert.equal(redacted.command, '[redacted text]');
  assert.equal(redacted.transcript, '[redacted text]');
  assert.equal(redacted.deviceToken, '[redacted secret]');
  assert.equal(serialized.includes(audioData), false);
  assert.equal(serialized.includes('unlock the front door'), false);
  assert.equal(serialized.includes('private household conversation'), false);
  assert.equal(serialized.includes('top-secret-token'), false);
});

test('Reachy audio and wake messages are dropped after microphone privacy is disabled', async () => {
  const voiceWs = new VoiceWebSocketServer();
  const device = createDevice();
  device.deviceType = 'robot';
  device.settings.reachy = {
    safeSettings: { microphoneEnabled: false, wakeWordEnabled: false }
  };
  const connection = {
    authenticated: true,
    device,
    pendingWakeWord: { wakeWord: 'anna' }
  };
  voiceWs.deviceConnections.set(deviceId, connection);
  voiceWs.audioSessions.set(deviceId, { chunks: [Buffer.from('private audio')] });

  await voiceWs.handleAudioData(deviceId, {
    type: 'audio_data',
    sessionId: 'private-session',
    audioData: Buffer.from('private audio').toString('base64')
  });
  assert.equal(voiceWs.audioSessions.has(deviceId), false);
  assert.equal(connection.pendingWakeWord, null);

  connection.pendingWakeWord = { wakeWord: 'anna' };
  await voiceWs.handleWakeWordDetection(deviceId, {
    type: 'wake_word_detected',
    wakeWord: 'anna',
    confidence: 1
  });
  assert.equal(connection.pendingWakeWord, null);
});

test('Reachy wake capture grants reject unsupported, non-finite, stale, and unpersisted detections', async (t) => {
  const originalSave = VoiceCommand.prototype.save;
  const originalFindByIdAndUpdate = VoiceDevice.findByIdAndUpdate;
  t.after(() => {
    VoiceCommand.prototype.save = originalSave;
    VoiceDevice.findByIdAndUpdate = originalFindByIdAndUpdate;
  });
  let saves = 0;
  VoiceCommand.prototype.save = async function save() {
    saves += 1;
    return this;
  };
  VoiceDevice.findByIdAndUpdate = async () => createReachyDevice();

  const voiceWs = new VoiceWebSocketServer();
  const ws = new MockWebSocket();
  const connection = connectReachy(voiceWs, ws);
  const now = new Date().toISOString();
  for (const message of [
    { wakeWord: 'Computer', confidence: 0.99, timestamp: now },
    { wakeWord: 'Anna', confidence: Number.NaN, timestamp: now },
    { wakeWord: 'Anna', confidence: 0.99, timestamp: new Date(Date.now() - 60000).toISOString() },
    { wakeWord: 'Anna', confidence: 0.2, timestamp: now }
  ]) {
    await voiceWs.handleWakeWordDetection(deviceId, message);
    assert.equal(connection.captureGrant, null);
    assert.equal(connection.pendingWakeWord, null);
  }
  assert.equal(saves, 0);
  assert.equal(ws.sent.some((message) => message.type === 'wake_word_ack'), false);

  VoiceCommand.prototype.save = async () => {
    throw new Error('persistence unavailable');
  };
  await voiceWs.handleWakeWordDetection(deviceId, {
    wakeWord: 'Anna',
    confidence: 0.99,
    timestamp: new Date().toISOString()
  });
  assert.equal(connection.captureGrant, null);
  assert.equal(connection.pendingWakeWord, null);
  assert.equal(ws.sent.some((message) => message.type === 'wake_word_ack'), false);
});

test('Reachy text commands consume one fresh wake grant and cannot replay it', async (t) => {
  const originalSave = VoiceCommand.prototype.save;
  const originalFindByIdAndUpdate = VoiceDevice.findByIdAndUpdate;
  t.after(() => {
    VoiceCommand.prototype.save = originalSave;
    VoiceDevice.findByIdAndUpdate = originalFindByIdAndUpdate;
  });
  VoiceCommand.prototype.save = async function save() { return this; };
  VoiceDevice.findByIdAndUpdate = async () => createReachyDevice();

  const voiceWs = new VoiceWebSocketServer();
  const ws = new MockWebSocket();
  const connection = connectReachy(voiceWs, ws);
  let processed = 0;
  voiceWs.processVoiceCommandText = async () => { processed += 1; };

  await voiceWs.handleVoiceCommand(deviceId, { command: 'turn on the lamp' });
  assert.equal(processed, 0);

  await voiceWs.handleWakeWordDetection(deviceId, {
    wakeWord: 'Anna', confidence: 0.99, timestamp: new Date().toISOString()
  });
  assert.ok(connection.captureGrant);
  const captureGrantId = connection.captureGrant.id;
  const wakeAck = ws.sent.findLast((message) => message.type === 'wake_word_ack');
  assert.equal(wakeAck.captureGrantId, captureGrantId);
  assert.equal(wakeAck.sessionId, captureGrantId);
  await voiceWs.handleVoiceCommand(deviceId, { command: 'turn on the lamp', captureGrantId });
  assert.equal(processed, 1);
  assert.equal(connection.captureGrant, null);
  await voiceWs.handleVoiceCommand(deviceId, { command: 'turn on the lamp again', captureGrantId });
  assert.equal(processed, 1);

  await voiceWs.handleWakeWordDetection(deviceId, {
    wakeWord: 'Anna', confidence: 0.99, timestamp: new Date().toISOString()
  });
  connection.captureGrant.expiresAt = Date.now() - 1;
  await voiceWs.handleVoiceCommand(deviceId, {
    command: 'expired command',
    captureGrantId: connection.captureGrant.id
  });
  assert.equal(processed, 1);
  assert.equal(connection.pendingWakeWord, null);
});

test('Reachy audio requires a one-shot grant and enforces session, sequence, encoding, duration, and byte bounds', async (t) => {
  const originalSave = VoiceCommand.prototype.save;
  const originalFindByIdAndUpdate = VoiceDevice.findByIdAndUpdate;
  t.after(() => {
    VoiceCommand.prototype.save = originalSave;
    VoiceDevice.findByIdAndUpdate = originalFindByIdAndUpdate;
  });
  VoiceCommand.prototype.save = async function save() { return this; };
  VoiceDevice.findByIdAndUpdate = async () => createReachyDevice();

  const voiceWs = new VoiceWebSocketServer();
  const ws = new MockWebSocket();
  const connection = connectReachy(voiceWs, ws);
  const start = (sessionId = connection.captureGrant?.id, captureGrantId = connection.captureGrant?.id) => voiceWs.handleAudioData(deviceId, {
    sessionId,
    captureGrantId,
    isStart: true,
    sampleRate: 16000,
    channels: 1,
    format: 'S16LE'
  });
  const wake = () => voiceWs.handleWakeWordDetection(deviceId, {
    wakeWord: 'Anna', confidence: 0.99, timestamp: new Date().toISOString()
  });
  const chunk = Buffer.from([1, 0, 2, 0]).toString('base64');

  await start('before-wake');
  assert.equal(voiceWs.audioSessions.size, 0);

  await wake();
  await start('wrong-grant-session', crypto.randomUUID());
  assert.equal(voiceWs.audioSessions.size, 0);
  assert.equal(connection.captureGrant, null);

  await wake();
  const mismatchedGrant = connection.captureGrant.id;
  await start('client-chosen-session', mismatchedGrant);
  assert.equal(voiceWs.audioSessions.size, 0);
  assert.equal(connection.captureGrant, null);

  await wake();
  const boundSession = connection.captureGrant.id;
  await start(boundSession);
  assert.equal(voiceWs.audioSessions.get(deviceId).sessionId, boundSession);
  assert.equal(connection.captureGrant, null);
  await voiceWs.handleAudioData(deviceId, {
    sessionId: 'other-session', sequence: 0, audioData: chunk,
    sampleRate: 16000, channels: 1, format: 'S16LE'
  });
  assert.equal(voiceWs.audioSessions.size, 0);

  await wake();
  const sequenceSession = connection.captureGrant.id;
  await start(sequenceSession);
  await voiceWs.handleAudioData(deviceId, {
    sessionId: sequenceSession, sequence: 0, audioData: chunk,
    sampleRate: 16000, channels: 1, format: 'S16LE'
  });
  assert.equal(voiceWs.audioSessions.get(deviceId).lastSequence, 0);
  await voiceWs.handleAudioData(deviceId, {
    sessionId: sequenceSession, sequence: 0, audioData: chunk,
    sampleRate: 16000, channels: 1, format: 'S16LE'
  });
  assert.equal(voiceWs.audioSessions.size, 0);

  await wake();
  const base64Session = connection.captureGrant.id;
  await start(base64Session);
  await voiceWs.handleAudioData(deviceId, {
    sessionId: base64Session, sequence: 0, audioData: 'AQ A=',
    sampleRate: 16000, channels: 1, format: 'S16LE'
  });
  assert.equal(voiceWs.audioSessions.size, 0);

  await wake();
  const durationSession = connection.captureGrant.id;
  await start(durationSession);
  voiceWs.audioSessions.get(deviceId).startedAtMs = Date.now() - voiceWs.reachyAudioSessionMaxMs - 1;
  await voiceWs.handleAudioData(deviceId, {
    sessionId: durationSession, sequence: 0, audioData: chunk,
    sampleRate: 16000, channels: 1, format: 'S16LE'
  });
  assert.equal(voiceWs.audioSessions.size, 0);

  await wake();
  voiceWs.reachyAudioSessionMaxBytes = 2;
  const byteSession = connection.captureGrant.id;
  await start(byteSession);
  await voiceWs.handleAudioData(deviceId, {
    sessionId: byteSession, sequence: 0, audioData: chunk,
    sampleRate: 16000, channels: 1, format: 'S16LE'
  });
  assert.equal(voiceWs.audioSessions.size, 0);
  assert.ok(ws.sent.filter((message) => message.type === 'audio_error').length >= 6);
});

test('Reachy identity mismatch is rejected before auth_success and cannot send later events', async (t) => {
  const originalFindById = VoiceDevice.findById;
  const originalHandleConnected = reachyMiniService.handleConnected;
  const originalHandleRobotEvent = reachyMiniService.handleRobotEvent;
  t.after(() => {
    VoiceDevice.findById = originalFindById;
    reachyMiniService.handleConnected = originalHandleConnected;
    reachyMiniService.handleRobotEvent = originalHandleRobotEvent;
  });
  const device = createDevice();
  device.deviceType = 'robot';
  device.settings.deviceTokenHash = hashDeviceToken('device-token');
  device.settings.reachy = { unitId: 'hardware-001', safeSettings: {} };
  VoiceDevice.findById = async () => device;
  reachyMiniService.handleConnected = async () => {
    throw Object.assign(new Error('hardware mismatch'), { code: 'REACHY_IDENTITY_MISMATCH' });
  };
  let eventHandled = false;
  reachyMiniService.handleRobotEvent = async () => { eventHandled = true; };

  const voiceWs = new VoiceWebSocketServer();
  const ws = new MockWebSocket();
  voiceWs.deviceConnections.set(deviceId, {
    ws,
    device,
    peerAddress: '192.168.1.45',
    authenticated: false,
    credentials: null,
    deviceInfo: null,
    pendingWakeWord: { wakeWord: 'anna' }
  });
  voiceWs.audioSessions.set(deviceId, { chunks: [Buffer.from('private')] });
  await voiceWs.handleAuthentication(deviceId, {
    type: 'authenticate',
    deviceToken: 'device-token',
    deviceInfo: { unitId: 'hardware-002' }
  });
  const connection = voiceWs.deviceConnections.get(deviceId);
  assert.equal(connection.authenticated, false);
  assert.equal(connection.credentials, null);
  assert.equal(connection.pendingWakeWord, null);
  assert.equal(voiceWs.audioSessions.has(deviceId), false);
  assert.equal(ws.sent.some((message) => message.type === 'auth_success'), false);
  assert.equal(ws.sent.some((message) => message.type === 'auth_failed'), true);
  assert.equal(ws.readyState, WebSocket.CLOSED);

  await voiceWs.handleMessage(deviceId, Buffer.from(JSON.stringify({
    type: 'robot_event',
    event: 'person_present'
  })));
  assert.equal(eventHandled, false);
});

test('post-credential authentication failures clear state and close fail-closed', async (t) => {
  const originalFindById = VoiceDevice.findById;
  const originalFindByIdAndUpdate = VoiceDevice.findByIdAndUpdate;
  const originalHandleConnected = reachyMiniService.handleConnected;
  t.after(() => {
    VoiceDevice.findById = originalFindById;
    VoiceDevice.findByIdAndUpdate = originalFindByIdAndUpdate;
    reachyMiniService.handleConnected = originalHandleConnected;
  });
  const device = createDevice();
  device.deviceType = 'robot';
  device.settings.deviceTokenHash = hashDeviceToken('device-token');
  device.settings.reachy = { unitId: 'hardware-001', safeSettings: {} };
  VoiceDevice.findById = async () => device;
  VoiceDevice.findByIdAndUpdate = async () => device;
  reachyMiniService.handleConnected = async () => device;

  const voiceWs = new VoiceWebSocketServer();
  voiceWs.buildWakeWordConfig = async () => { throw new Error('injected config failure'); };
  const ws = new MockWebSocket();
  voiceWs.deviceConnections.set(deviceId, {
    ws,
    device,
    peerAddress: '192.168.1.45',
    authenticated: false,
    credentials: null,
    deviceInfo: null,
    pendingWakeWord: { wakeWord: 'anna' }
  });
  voiceWs.audioSessions.set(deviceId, { chunks: [Buffer.from('private')] });
  await voiceWs.handleAuthentication(deviceId, {
    type: 'authenticate',
    deviceToken: 'device-token',
    deviceInfo: { unitId: 'hardware-001' }
  });
  const connection = voiceWs.deviceConnections.get(deviceId);
  assert.equal(connection.authenticated, false);
  assert.equal(connection.credentials, null);
  assert.equal(connection.deviceInfo, null);
  assert.equal(connection.pendingWakeWord, null);
  assert.equal(voiceWs.audioSessions.has(deviceId), false);
  assert.equal(ws.sent.some((message) => message.type === 'auth_success'), false);
  assert.equal(ws.sent.some((message) => message.type === 'auth_failed'), true);
  assert.equal(ws.readyState, WebSocket.CLOSED);
});

test('credential rotation during authentication is revalidated before socket promotion', async (t) => {
  const originalFindById = VoiceDevice.findById;
  const originalFindByIdAndUpdate = VoiceDevice.findByIdAndUpdate;
  t.after(() => {
    VoiceDevice.findById = originalFindById;
    VoiceDevice.findByIdAndUpdate = originalFindByIdAndUpdate;
  });
  const valid = createDevice();
  valid.settings.deviceTokenHash = hashDeviceToken('device-token');
  const revoked = createDevice();
  revoked.settings = {
    ...revoked.settings,
    registered: false,
    deviceTokenHash: undefined,
    registrationCode: 'NEWCODE',
    registrationExpires: new Date(Date.now() + 60_000)
  };
  let reads = 0;
  VoiceDevice.findById = async () => {
    reads += 1;
    return reads === 1 ? valid : revoked;
  };
  VoiceDevice.findByIdAndUpdate = async () => valid;
  const voiceWs = new VoiceWebSocketServer();
  voiceWs.buildWakeWordConfig = async () => ({ config: {}, assets: [] });
  const ws = new MockWebSocket();
  const connection = {
    ws,
    deviceId,
    device: valid,
    authenticated: false,
    pendingWakeWord: null,
    captureGrant: null
  };
  voiceWs.pendingConnections.set(ws, connection);

  await voiceWs.handleAuthentication(deviceId, {
    type: 'authenticate',
    deviceToken: 'device-token',
    deviceInfo: {}
  }, connection);

  assert.equal(voiceWs.deviceConnections.has(deviceId), false);
  assert.equal(connection.authenticated, false);
  assert.equal(ws.readyState, WebSocket.CLOSED);
  assert.equal(ws.sent.some((message) => message.type === 'auth_success'), false);
  assert.equal(ws.sent.some((message) => message.type === 'auth_failed'), true);
});

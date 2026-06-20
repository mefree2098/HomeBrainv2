const EventEmitter = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const VoiceDevice = require('../models/VoiceDevice');
const WakeWordModel = require('../models/WakeWordModel');
const VoiceWebSocketServer = require('../websocket/voiceWebSocket');

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
  assert.equal(voiceWs.deviceConnections.has(deviceId), true);
  assert.equal(ws.sent[0].type, 'welcome');
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

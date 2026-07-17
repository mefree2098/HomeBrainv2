const test = require('node:test');
const assert = require('node:assert/strict');

const VoiceDevice = require('../models/VoiceDevice');
const ttsProviderService = require('../services/ttsProviderService');
const voiceAcknowledgmentService = require('../services/voiceAcknowledgmentService');
const { hashDeviceToken } = require('../services/voiceDeviceLifecycleService');
const router = require('../routes/remoteDeviceRoutes');

const DEVICE_ID = '507f1f77bcf86cd799439011';

function routeHandlers(routePath, method) {
  const layer = router.stack.find((candidate) => (
    candidate.route?.path === routePath && candidate.route.methods?.[method]
  ));
  assert.ok(layer, `${method.toUpperCase()} ${routePath} exists`);
  return layer.route.stack.map((entry) => entry.handle);
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; }
  };
}

function request({ token = 'device-secret', body = {}, query = {}, ip = '192.0.2.25' } = {}) {
  return {
    params: { deviceId: DEVICE_ID },
    body,
    query,
    ip,
    socket: { remoteAddress: ip },
    url: `/api/remote-devices/${DEVICE_ID}/tts`,
    get(name) {
      if (String(name).toLowerCase() === 'x-homebrain-device-token') return token;
      return undefined;
    }
  };
}

test('Reachy TTS accepts only POST JSON and never puts spoken text in the URL', async (t) => {
  const originalFindById = VoiceDevice.findById;
  const originalTts = ttsProviderService.textToSpeechDetailed;
  const originalCached = voiceAcknowledgmentService.findCachedAudio;
  const originalError = console.error;
  const errors = [];
  t.after(() => {
    VoiceDevice.findById = originalFindById;
    ttsProviderService.textToSpeechDetailed = originalTts;
    voiceAcknowledgmentService.findCachedAudio = originalCached;
    console.error = originalError;
  });
  VoiceDevice.findById = async () => ({
    _id: DEVICE_ID,
    settings: { registered: true, deviceTokenHash: hashDeviceToken('device-secret') }
  });
  voiceAcknowledgmentService.findCachedAudio = async () => null;
  let providerRequest = null;
  ttsProviderService.textToSpeechDetailed = async (text, voiceId) => {
    providerRequest = { text, voiceId };
    return { audioBuffer: Buffer.from('audio'), contentType: 'audio/mpeg', provider: 'test' };
  };
  console.error = (...args) => errors.push(args.map(String).join(' '));

  const spokenText = 'private household reminder';
  const req = request({ body: { text: spokenText, voiceId: 'voice-1' } });
  const res = response();
  const postHandler = routeHandlers('/:deviceId/tts', 'post').at(-1);
  await postHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(providerRequest, { text: spokenText, voiceId: 'voice-1' });
  assert.equal(req.url.includes(spokenText), false);
  assert.equal(JSON.stringify(req.query).includes(spokenText), false);
  assert.equal(errors.join('\n').includes(spokenText), false);

  const getRes = response();
  await routeHandlers('/:deviceId/tts', 'get').at(-1)(
    request({ query: { text: spokenText } }),
    getRes
  );
  assert.equal(getRes.statusCode, 405);
  assert.equal(getRes.body.success, false);
});

test('Reachy TTS requires a valid steady-state device token', async (t) => {
  const originalFindById = VoiceDevice.findById;
  t.after(() => { VoiceDevice.findById = originalFindById; });
  VoiceDevice.findById = async () => ({
    _id: DEVICE_ID,
    settings: { registered: true, deviceTokenHash: hashDeviceToken('correct-token') }
  });
  const res = response();
  await routeHandlers('/:deviceId/tts', 'post').at(-1)(
    request({ token: 'wrong-token', body: { text: 'hello' } }),
    res
  );
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /credentials/i);
});

test('Reachy TTS body validation is strict and bounded', () => {
  assert.deepEqual(router.normalizeRemoteTtsPayload({ text: ' hello ', voiceId: 'voice:1' }), {
    text: 'hello',
    voiceId: 'voice:1'
  });
  assert.throws(() => router.normalizeRemoteTtsPayload({ text: 42 }), /must be a string/);
  assert.throws(() => router.normalizeRemoteTtsPayload({ text: 'x'.repeat(1001) }), /between 1 and 1000/);
  assert.throws(() => router.normalizeRemoteTtsPayload({ text: 'hello', voiceId: { id: 'bad' } }), /must be a string/);
  assert.throws(() => router.normalizeRemoteTtsPayload({ text: 'hello', extra: true }), /Unsupported TTS field/);
});

test('Reachy TTS rate limiting is scoped to both device and requester IP', () => {
  router.ttsIpAccessWindow.clear();
  router.ttsDeviceAccessWindow.clear();
  const now = Date.now();
  router.ttsDeviceAccessWindow.set(DEVICE_ID, Array.from({ length: 30 }, () => now));
  const res = response();
  let nextCalled = false;
  router.remoteTtsRateLimit(request({ body: { text: 'hello' } }), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers['Retry-After']) >= 1);
  router.ttsIpAccessWindow.clear();
  router.ttsDeviceAccessWindow.clear();
});

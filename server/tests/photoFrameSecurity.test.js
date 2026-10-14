const assert = require('node:assert/strict');
const { test, before, after, afterEach, mock } = require('node:test');
const express = require('express');
const PhotoFrame = require('../models/PhotoFrame');
const SecurityAlarm = require('../models/SecurityAlarm');
const alarmService = require('../services/securityAlarmService');
const { normalizeConfig } = require('../services/photoFrameConfig');
const { hashToken } = require('../services/photoFrameService').__private__;
const TOKEN = 'a'.repeat(64);
let baseURL;
let server;
let nextId = 100;

function frame(enabled = true) {
  return {
    _id: String(nextId++).padStart(24, '0'), name: 'Touchscreen',
    config: normalizeConfig({ securityControlsEnabled: enabled }),
    deviceTokenHash: hashToken(TOKEN), photos: [], save: async function () { return this; }
  };
}
function stubFrame(document) {
  mock.method(PhotoFrame, 'findById', id => {
    const result = Promise.resolve(String(id) === document._id ? document : null);
    result.select = () => result;
    return result;
  });
}
function status(requireForArm = false, requireForDisarm = false) {
  return { alarmState: 'disarmed', isOnline: true, pinSettings: { requireForArm, requireForDisarm }, userCodes: [{ code: 'must-stay-private' }], zones: [{ secret: 'private-zone' }] };
}
async function request(document, body, token = TOKEN) {
  return fetch(`${baseURL}/api/photo-frames/${document._id}/device/security`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-HomeBrain-Frame-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
before(async () => {
  const app = express(); app.use(express.json()); app.use('/api/photo-frames', require('../routes/photoFrameRoutes'));
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => mock.restoreAll());
after(async () => { await new Promise(resolve => server.close(resolve)); });

test('security is opt-in; missing, malformed, or disabled flags cannot grant alarm control', async () => {
  assert.equal(normalizeConfig().securityControlsEnabled, false);
  assert.throws(() => normalizeConfig({ securityControlsEnabled: 'true' }), { status: 400 });
  const document = frame(false); stubFrame(document);
  const calls = mock.method(alarmService, 'getAlarmStatus', async () => status());
  for (const enabled of [undefined, false, 'true']) {
    document.config.securityControlsEnabled = enabled;
    assert.equal((await request(document)).status, 403);
    assert.equal((await request(document, { action: 'disarm', securityControlsEnabled: true })).status, 403);
  }
  assert.equal(calls.mock.callCount(), 0);
});

test('security status requires this frame credential and exposes only status and PIN requirement flags', async () => {
  const document = frame(); stubFrame(document);
  mock.method(alarmService, 'getAlarmStatus', async options => { assert.equal(options.refreshDoorLocks, false); return status(true, false); });
  const denied = await request(document, undefined, 'b'.repeat(64));
  assert.equal(denied.status, 401); assert.equal((await denied.json()).code, 'FRAME_CREDENTIAL_INVALID');
  const response = await request(document);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { success: true, security: { alarmState: 'disarmed', available: true, pinSettings: { requireForArm: true, requireForDisarm: false } } });
  const other = frame(); assert.equal((await request(other)).status, 404);
});

test('the frame forwards only arm/disarm and PIN, preserving the platform exit delay and actor attribution', async () => {
  const document = frame(); stubFrame(document); mock.method(alarmService, 'getAlarmStatus', async () => status());
  const commands = [];
  mock.method(alarmService, 'armAlarm', async (...args) => commands.push(['arm', ...args]));
  mock.method(alarmService, 'disarmAlarm', async (...args) => commands.push(['disarm', ...args]));
  for (const action of ['armStay', 'armAway', 'disarm']) {
    const response = await request(document, { action, pin: '1234', exitDelaySeconds: 0, requireForDisarm: false });
    assert.equal(response.status, 200); assert.equal(JSON.stringify(await response.json()).includes('1234'), false);
  }
  assert.deepEqual(commands, [
    ['arm', 'stay', 'Photo frame: Touchscreen', { pin: '1234' }],
    ['arm', 'away', 'Photo frame: Touchscreen', { pin: '1234' }],
    ['disarm', 'Photo frame: Touchscreen', { pin: '1234' }]
  ]);
  assert.equal((await request(document, { action: 'trigger' })).status, 400);
  assert.equal((await request(document, { action: 'disarm', pin: { value: '1234' } })).status, 400);
  assert.equal(commands.length, 3);
});

test('an unavailable alarm cannot be controlled and a database outage does not revoke pairing', async () => {
  const document = frame(); stubFrame(document);
  mock.method(alarmService, 'getAlarmStatus', async () => ({ ...status(), isOnline: false }));
  const commands = mock.method(alarmService, 'armAlarm', async () => { throw new Error('No command should be sent'); });
  assert.equal((await request(document, { action: 'armStay' })).status, 503); assert.equal(commands.mock.callCount(), 0);
  mock.method(PhotoFrame, 'findById', () => {
    const result = Promise.reject(new Error('Database temporarily unavailable')); result.select = () => result; return result;
  });
  const response = await request(document); assert.equal(response.status, 500); assert.equal((await response.json()).code, undefined);
});

test('real platform PIN enforcement blocks arm and disarm before any actuator call', async () => {
  const document = frame(); stubFrame(document); mock.method(alarmService, 'getAlarmStatus', async () => status(true, true));
  const alarm = { alarmState: 'disarmed', pinSettings: { requireForArm: true, requireForDisarm: true }, userCodes: [{ code: '1234', name: 'Test', enabled: true }] };
  mock.method(SecurityAlarm, 'getMainAlarm', async () => alarm);
  const hardware = mock.method(alarmService, 'sendSmartThingsArmCommand', async () => { throw new Error('No actuator should be called'); });
  const silence = mock.method(alarmService, 'clearTriggeredAlarm', async () => { throw new Error('No actuator should be called'); });
  for (const action of ['armStay', 'disarm']) {
    alarm.alarmState = action === 'disarm' ? 'triggered' : 'disarmed';
    for (const pin of [undefined, '9999']) {
      const response = await request(document, { action, pin, pinSettings: { requireForArm: false, requireForDisarm: false } });
      assert.equal(response.status, 401);
      const result = await response.json(); assert.match(result.message, /PIN/); assert.equal(result.code, undefined);
    }
  }
  assert.equal(hardware.mock.callCount(), 0); assert.equal(silence.mock.callCount(), 0);
});

test('failed PIN attempts are limited per frame while status remains readable', async () => {
  const document = frame(); stubFrame(document); mock.method(alarmService, 'getAlarmStatus', async () => status(true, true));
  const commands = mock.method(alarmService, 'armAlarm', async () => { throw Object.assign(new Error('Invalid security PIN'), { statusCode: 401 }); });
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await request(document, { action: 'armStay', pin: '9999' })).status, 401);
  const blocked = await request(document, { action: 'armStay', pin: '9999' });
  assert.equal(blocked.status, 429); assert.match((await blocked.json()).message, /15 minutes/); assert.equal(commands.mock.callCount(), 5);
  assert.equal((await request(document)).status, 200);
});

test('ordinary and read-only users cannot enable security on a frame', async context => {
  const jwt = require('jsonwebtoken'); const UserService = require('../services/userService');
  const previous = process.env.JWT_SECRET; process.env.JWT_SECRET = 'frame-security-test-secret';
  context.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  const document = frame(false); stubFrame(document);
  const user = { _id: 'qa', role: 'user', isActive: true, isReadOnly: false }; mock.method(UserService, 'get', async () => user);
  const headers = { Authorization: 'Bearer ' + jwt.sign({ sub: 'qa' }, process.env.JWT_SECRET), 'Content-Type': 'application/json' };
  const update = () => fetch(`${baseURL}/api/photo-frames/${document._id}`, { method: 'PUT', headers, body: JSON.stringify({ config: { securityControlsEnabled: true } }) });
  assert.equal((await update()).status, 403); user.role = 'admin'; user.isReadOnly = true;
  assert.equal((await update()).status, 403); user.isReadOnly = false;
  assert.equal((await update()).status, 200); assert.equal(document.config.securityControlsEnabled, true);
});

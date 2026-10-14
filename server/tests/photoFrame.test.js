const assert = require('node:assert/strict');
const { test, afterEach, after, before, mock } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { normalizeConfig, POSITIONS } = require('../services/photoFrameConfig');
const PhotoFrame = require('../models/PhotoFrame');
const storageRoot = path.join(os.tmpdir(), `homebrain-frame-test-${process.pid}`);
process.env.HOMEBRAIN_PHOTO_FRAME_STORAGE = storageRoot;
process.env.HOMEBRAIN_PHOTO_FRAME_OTA_STORAGE = path.join(storageRoot, 'ota');
const service = require('../services/photoFrameService');
const updates = require('../services/photoFrameUpdateService');
const { inspectPhoto, framePath, hashToken, formatMetrics } = service.__private__;
const FRAME_A = '123456789012345678901234';
const FRAME_B = '123456789012345678901235';
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=';
let server;
let baseURL;

function clockConfig() {
  const config = normalizeConfig();
  for (const slot of Object.values(config.overlays)) slot.enabled = false;
  config.overlays.topCenter = { ...config.overlays.topCenter, enabled: true, lines: [{ metric: 'time', label: '', text: '' }] };
  return config;
}
function document(id, token) {
  return { _id: id, name: 'Frame', room: 'Living room', config: clockConfig(), photos: [], deviceTokenHash: hashToken(token), lastSeen: null, save: async function () { return this; } };
}
function stubFrames(frames) {
  mock.method(PhotoFrame, 'findById', (id) => {
    const result = Promise.resolve(frames[id] || null);
    result.select = () => result;
    return result;
  });
}

before(async () => {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  app.use('/api/photo-frames', require('../routes/photoFrameRoutes'));
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => mock.restoreAll());
after(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(storageRoot, { recursive: true, force: true }); });

test('all six optional positions retain their one-line and two-line constraints', () => {
  const config = normalizeConfig();
  assert.equal(POSITIONS.length, 6);
  for (const position of POSITIONS) {
    const tooMany = Array.from({ length: position.maxLines + 1 }, () => ({ metric: 'time' }));
    assert.throws(() => normalizeConfig({ overlays: { [position.id]: { lines: tooMany } } }), /at most/);
    config.overlays[position.id].enabled = false;
  }
  assert.ok(Object.values(normalizeConfig(config).overlays).every((slot) => !slot.enabled));
  assert.throws(() => normalizeConfig({ overlays: { middle: {} } }), /position/);
});

test('invalid settings cannot produce unsafe CSS, multiline slots, or broken schedules', () => {
  for (const input of [
    { timeZone: 'Mars/Olympus' }, { intervalSeconds: 0 }, { intervalSeconds: null },
    { shuffle: 'false' }, { fit: 'javascript:x' }, { orientation: 'upside-down' },
    { sleep: { start: '25:00' } }, { sleep: { start: '07:00', end: '07:00' } },
    { overlays: { topLeft: { font: 'url(evil)' } } },
    { overlays: { topLeft: { color: 'red;position:fixed' } } },
    { overlays: { topLeft: { panelOpacity: 1 } } },
    { overlays: { topLeft: { lines: [{ metric: 'text', text: 'one\ntwo' }] } } },
    { overlays: { topLeft: { lines: [{ metric: 'disarmAlarm' }] } } }
  ]) assert.throws(() => normalizeConfig(input), { status: 400 });
});

test('rainfall uses a rolling recorded total, and unavailable sensor data never becomes zero', () => {
  const now = new Date('2026-10-13T18:00:00Z');
  const values = formatMetrics({ weather: { fetchedAt: now.toISOString(), current: { temperatureF: null, airQualityIndex: null }, tempest: { station: { metrics: { rainTodayIn: 9 }, observedAt: now.toISOString() } } } }, now);
  assert.equal(values.outsideTemperature.value, null);
  assert.equal(values.outsideAqi.value, null);
  assert.equal(values.insideTemperature.value, null);
  assert.equal(values.rain24h.value, null);
  assert.equal(formatMetrics({ rain: { observationCount: 10, rainTotalMm: null, lastObservedAt: now } }, now).rain24h.value, null);
  const recorded = formatMetrics({ rain: { observationCount: 1200, rainTotalMm: 25.4, lastObservedAt: now } }, now);
  assert.equal(recorded.rain24h.value, '1.00 in');
  assert.match(recorded.rain24h.text, /recorded \(24h\)/);
});

test('offline sensor data is stale, alarm credentials and security details never enter display values', () => {
  const now = new Date();
  const result = formatMetrics({ weather: { indoorAir: { monitor: { temperatureF: 70, observedAt: now.toISOString(), isOnline: false } } }, alarm: { alarmState: 'disarmed', isOnline: false, pinSettings: { secret: 'hidden' } } }, now);
  assert.equal(result.insideTemperature.stale, true);
  assert.equal(result.alarm.value, null);
  assert.equal(JSON.stringify(result).includes('pinSettings'), false);
  assert.equal(JSON.stringify(result).includes('hidden'), false);
});

test('raster upload validates byte size, file signature, dimensions, and filesystem paths', () => {
  const photo = inspectPhoto(PNG);
  assert.equal(photo.contentType, 'image/png');
  assert.equal(photo.width, 1);
  assert.equal(photo.height, 1);
  assert.throws(() => inspectPhoto(Buffer.from('<svg onload="evil"/>').toString('base64')), /valid JPEG or PNG/);
  assert.throws(() => inspectPhoto('not a picture'), /JPEG or PNG/);
  const giant = Buffer.from(PNG, 'base64'); giant.writeUInt32BE(16000, 16);
  assert.throws(() => inspectPhoto(giant.toString('base64')), /8192/);
  assert.throws(() => framePath('../secrets', 'image'), /Invalid/);
  assert.throws(() => framePath(FRAME_A, '../../credentials'), /Invalid/);
});

test('frame tokens are scoped to one frame and rotating immediately invalidates the previous token', async () => {
  const frame = document(FRAME_A, TOKEN_A);
  stubFrames({ [FRAME_A]: frame, [FRAME_B]: document(FRAME_B, TOKEN_B) });
  assert.equal(await service.authenticate(FRAME_A, TOKEN_A), frame);
  await assert.rejects(service.authenticate(FRAME_B, TOKEN_A), { status: 401 });
  await assert.rejects(service.authenticate(FRAME_A, 'bad'), { status: 401 });
  const paired = await service.pair(FRAME_A);
  assert.notEqual(paired.token, TOKEN_A);
  assert.equal(frame.deviceTokenHash, hashToken(paired.token));
  assert.ok(!paired.playerPath.includes('?token='));
  assert.ok(paired.playerPath.includes('#frame='));
  await assert.rejects(service.authenticate(FRAME_A, TOKEN_A), { status: 401 });
  assert.equal(await service.authenticate(FRAME_A, paired.token), frame);
  assert.equal(JSON.stringify(service.serialize(frame)).includes(frame.deviceTokenHash), false);
});

test('upload and deletion persist real photo bytes while preserving an independently edited layout', async () => {
  const frame = document(FRAME_A, TOKEN_A);
  stubFrames({ [FRAME_A]: frame });
  const result = await service.upload(FRAME_A, { name: 'Snapshot', data: PNG });
  assert.equal(result.photos.length, 1);
  const id = result.photos[0].id;
  assert.deepEqual(await fs.readFile(framePath(FRAME_A, id)), Buffer.from(PNG, 'base64'));
  assert.equal(result.config.overlays.topCenter.lines[0].metric, 'time');
  await service.removePhoto(FRAME_A, id);
  assert.equal(frame.photos.length, 0);
  await assert.rejects(fs.access(framePath(FRAME_A, id)), { code: 'ENOENT' });
});

test('failed metadata saves clean up the just-written file', async () => {
  const frame = document(FRAME_B, TOKEN_B);
  frame.save = async () => { throw new Error('database unavailable'); };
  stubFrames({ [FRAME_B]: frame });
  await assert.rejects(service.upload(FRAME_B, { name: 'Snapshot', data: PNG }), /database unavailable/);
  assert.deepEqual(await fs.readdir(framePath(FRAME_B)), []);
});

test('photo ordering rejects missing, duplicate, and foreign photo IDs', async () => {
  const frame = document(FRAME_A, TOKEN_A);
  frame.photos = [{ id: 'one' }, { id: 'two' }];
  stubFrames({ [FRAME_A]: frame });
  for (const ids of [['one'], ['one', 'one'], ['one', 'foreign']]) await assert.rejects(service.reorder(FRAME_A, ids), { status: 400 });
  await service.reorder(FRAME_A, ['two', 'one']);
  assert.deepEqual(frame.photos.map((photo) => photo.id), ['two', 'one']);
});

test('HTTP management rejects anonymous and frame-token requests while device manifest accepts its own token', async () => {
  const frame = document(FRAME_A, TOKEN_A);
  stubFrames({ [FRAME_A]: frame });
  mock.method(PhotoFrame, 'updateOne', async () => ({}));
  for (const target of ['/api/photo-frames', '/api/photo-frames/catalog', '/api/photo-frames/releases', `/api/photo-frames/${FRAME_A}/manifest`]) {
    const result = await fetch(baseURL + target, { headers: { 'X-HomeBrain-Frame-Token': TOKEN_A } });
    assert.equal(result.status, 401);
  }
  const noToken = await fetch(`${baseURL}/api/photo-frames/${FRAME_A}/device/manifest`);
  assert.equal(noToken.status, 401);
  const response = await fetch(`${baseURL}/api/photo-frames/${FRAME_A}/device/manifest`, { headers: { 'X-HomeBrain-Frame-Token': TOKEN_A } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const result = await response.json();
  assert.equal(result.manifest.frameId, FRAME_A);
  assert.deepEqual(result.manifest.values, {});
  assert.ok(!JSON.stringify(result).includes('deviceTokenHash'));
  const player = await fetch(`${baseURL}/api/photo-frames/player/?preview=1`);
  assert.equal(player.status, 200);
  assert.match(await player.text(), /player.js/);
});

function apkFixture() { const bytes = Buffer.alloc(256, 42); bytes.writeUInt32LE(0x04034b50); return bytes; }
const software = (versionCode = 1) => ({ versionCode, versionName: `${versionCode}.0.0`, sha256: crypto.createHash('sha256').update(apkFixture()).digest('hex'), otaCapable: true });

test('OTA signing identity persists, release payload binds exact artifact bytes, and corrupt files fail closed', async () => {
  const identity = await updates.publicKey();
  const der = Buffer.from(identity.publicKey, 'base64');
  assert.equal(identity.fingerprint, crypto.createHash('sha256').update(der).digest('hex'));
  assert.equal((await fs.stat(path.join(storageRoot, 'ota/signing-key.pem'))).mode & 0o777, 0o600);
  assert.deepEqual(await updates.publicKey(), identity);
  const release = await updates.publish(apkFixture(), { versionName: '2.0.0', versionCode: 2 });
  const signed = await updates.__private__.getRelease(release.releaseId);
  const key = crypto.createPublicKey({ key: der, type: 'spki', format: 'der' });
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(signed.payload), key, Buffer.from(signed.signature, 'base64')), true);
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(signed.payload + ' '), key, Buffer.from(signed.signature, 'base64')), false);
  assert.equal(release.sha256, crypto.createHash('sha256').update(apkFixture()).digest('hex'));
  const frame = { _id: FRAME_A, ota: { id: crypto.randomUUID(), releaseId: release.releaseId, status: 'queued' } };
  assert.equal(await updates.download(frame, frame.ota.id), updates.__private__.releasePath(release.releaseId, 'apk'));
  await fs.appendFile(updates.__private__.releasePath(release.releaseId, 'apk'), 'corrupt');
  await assert.rejects(updates.download(frame, frame.ota.id), /failed verification/);
  assert.ok((await updates.listReleases()).some((item) => item.releaseId === release.releaseId));
  await assert.rejects(updates.publish(Buffer.from('not an apk'), { versionCode: 3, versionName: '3.0' }), { status: 400 });
  await assert.rejects(updates.publish(apkFixture(), { versionCode: 0, versionName: '2.0' }), { status: 400 });
});

test('OTA queues only compatible upgrades with a provisioned installer and reserves the assignment atomically', async () => {
  const release = await updates.publish(apkFixture(), { versionCode: 3, versionName: '3.0.0' });
  const frame = { _id: FRAME_A, hardwareProfile: 'humblestead-10.1-1280x800', software: software(), ota: null };
  let writes = 0;
  mock.method(PhotoFrame, 'updateOne', async (filter, update) => {
    writes++;
    assert.deepEqual(filter['ota.status'].$nin, updates.__private__.ACTIVE);
    if (frame.ota) return { matchedCount: 0 };
    frame.ota = update.$set.ota;
    assert.equal(update.$inc.__v, 1);
    return { matchedCount: 1 };
  });
  await assert.rejects(updates.queue({ ...frame, hardwareProfile: 'different' }, release.releaseId), /different frame hardware/);
  await assert.rejects(updates.queue({ ...frame, software: { ...software(), otaCapable: false } }, release.releaseId), /installer ready/);
  await assert.rejects(updates.queue({ ...frame, software: software(3) }, release.releaseId), /newer/);
  assert.equal(writes, 0);
  const job = await updates.queue(frame, release.releaseId);
  assert.equal(job.status, 'queued');
  await assert.rejects(updates.queue(frame, release.releaseId), { status: 409 });
  const poll = await updates.poll(frame);
  assert.equal(poll.update.jobId, job.id);
  assert.equal(JSON.parse(poll.update.payload).releaseId, release.releaseId);
  assert.equal(poll.update.status, 'queued');
});

test('OTA progress cannot claim completion for another version, regress phases, or overwrite another assignment', async () => {
  const id = crypto.randomUUID();
  const frame = { _id: FRAME_A, ota: { id, status: 'verifying', versionCode: 3, sha256: software(3).sha256 } };
  let lastWrite;
  mock.method(PhotoFrame, 'updateOne', async (filter, update) => { lastWrite = { filter, update }; return { matchedCount: 1 }; });
  const input = { software: software(), jobId: id, status: 'complete', progress: 100 };
  await assert.rejects(updates.report(frame, input), /Installed version/);
  await assert.rejects(updates.report(frame, { ...input, status: 'downloading' }), /backward/);
  await assert.rejects(updates.report(frame, { ...input, jobId: crypto.randomUUID() }), /assignment changed/);
  await assert.rejects(updates.report(frame, { ...input, software: { ...software(3), sha256: '0'.repeat(64) } }), /APK digest/);
  await updates.report(frame, { ...input, software: software(3) });
  assert.equal(lastWrite.update.$set['ota.status'], 'complete');
  assert.equal(lastWrite.update.$set.playerVersion, '3.0.0');
  assert.equal(lastWrite.filter['ota.id'], id);
  assert.equal(lastWrite.filter['ota.status'], 'verifying');
  assert.equal(lastWrite.update.$set.config, undefined);
  mock.restoreAll();
  mock.method(PhotoFrame, 'updateOne', async () => ({ matchedCount: 0 }));
  await assert.rejects(updates.report(frame, { ...input, software: software(3) }), /assignment changed/);
});

test('only a queued OTA can be canceled, and terminal assignments no longer offer an artifact', async () => {
  const frame = { _id: FRAME_A, ota: { id: crypto.randomUUID(), status: 'queued' } };
  mock.method(PhotoFrame, 'updateOne', async (filter) => { assert.equal(filter['ota.status'], 'queued'); return { matchedCount: frame.ota.status === 'queued' ? 1 : 0 }; });
  await updates.cancel(frame);
  frame.ota.status = 'installing';
  await assert.rejects(updates.cancel(frame), { status: 409 });
  frame.ota.status = 'complete';
  assert.equal((await updates.poll(frame)).update, null);
  await assert.rejects(updates.download(frame, frame.ota.id), { status: 404 });
});

test('OTA HTTP endpoints enforce frame scope and prevent device credentials from publishing or assigning updates', async () => {
  const release = await updates.publish(apkFixture(), { versionName: '4.0.0', versionCode: 4 });
  const a = document(FRAME_A, TOKEN_A), b = document(FRAME_B, TOKEN_B);
  a.ota = { id: crypto.randomUUID(), status: 'queued', releaseId: release.releaseId, versionCode: 4 };
  stubFrames({ [FRAME_A]: a, [FRAME_B]: b });
  const headers = { 'X-HomeBrain-Frame-Token': TOKEN_A };
  for (const target of [`${FRAME_B}/device/updates`, `${FRAME_B}/device/updates/${a.ota.id}/apk`]) {
    assert.equal((await fetch(`${baseURL}/api/photo-frames/${target}`, { headers })).status, 401);
  }
  const poll = await fetch(`${baseURL}/api/photo-frames/${FRAME_A}/device/updates`, { headers });
  assert.equal(poll.status, 200);
  assert.equal(poll.headers.get('cache-control'), 'private, no-store');
  assert.equal((await poll.json()).update.jobId, a.ota.id);
  const download = await fetch(`${baseURL}/api/photo-frames/${FRAME_A}/device/updates/${a.ota.id}/apk`, { headers });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), apkFixture());
  assert.equal((await fetch(`${baseURL}/api/photo-frames/${FRAME_A}/device/updates/${crypto.randomUUID()}/apk`, { headers })).status, 404);
  for (const target of ['releases', `${FRAME_A}/updates`]) {
    assert.equal((await fetch(`${baseURL}/api/photo-frames/${target}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ releaseId: release.releaseId }) })).status, 401);
  }
});

test('OTA HTTP accepts raw APKs from administrators and blocks read-only or ordinary accounts', async (context) => {
  const jwt = require('jsonwebtoken');
  const UserService = require('../services/userService');
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'photo-frame-test-only-secret';
  context.after(() => { if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret; });
  const user = { _id: 'qa', role: 'admin', isActive: true, isReadOnly: false };
  mock.method(UserService, 'get', async () => user);
  const headers = { Authorization: `Bearer ${jwt.sign({ sub: 'qa' }, process.env.JWT_SECRET)}`, 'Content-Type': 'application/vnd.android.package-archive', 'X-Frame-Version-Name': '7.0.0', 'X-Frame-Version-Code': '7' };
  const frame = { ...document(FRAME_A, TOKEN_A), hardwareProfile: 'humblestead-10.1-1280x800', software: software() };
  stubFrames({ [FRAME_A]: frame });
  mock.method(PhotoFrame, 'updateOne', async () => ({ matchedCount: 1 }));
  const response = await fetch(`${baseURL}/api/photo-frames/releases`, { method: 'POST', headers, body: apkFixture() });
  assert.equal(response.status, 201);
  const { release } = await response.json();
  assert.equal(release.versionCode, 7);
  assert.equal(release.bytes, apkFixture().length);
  const managementHeaders = { Authorization: headers.Authorization, 'Content-Type': 'application/json' };
  const assignment = await fetch(`${baseURL}/api/photo-frames/${FRAME_A}/updates`, { method: 'POST', headers: managementHeaders, body: JSON.stringify({ releaseId: release.releaseId }) });
  assert.equal(assignment.status, 200);
  assert.equal((await assignment.json()).job.versionCode, 7);
  user.isReadOnly = true;
  assert.equal((await fetch(`${baseURL}/api/photo-frames/releases`, { headers: managementHeaders })).status, 200);
  assert.equal((await fetch(`${baseURL}/api/photo-frames/releases`, { method: 'POST', headers, body: apkFixture() })).status, 403);
  assert.equal((await fetch(`${baseURL}/api/photo-frames/${FRAME_A}/updates`, { method: 'POST', headers: managementHeaders, body: JSON.stringify({ releaseId: release.releaseId }) })).status, 403);
  assert.equal((await fetch(`${baseURL}/api/photo-frames/${FRAME_A}/updates`, { method: 'DELETE', headers: managementHeaders })).status, 403);
  user.isReadOnly = false; user.role = 'user';
  assert.equal((await fetch(`${baseURL}/api/photo-frames/releases`, { headers: managementHeaders })).status, 403);
});

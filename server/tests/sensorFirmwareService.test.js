const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const users = require('../services/userService');
const oidc = require('../services/oidcService');
const { createSensorNodeRouter } = require('../routes/sensorNodeRoutes');
const { SensorFirmwareService, firmwareCommand, MAX_IMAGE_BYTES, _private: { validateImage, compareVersions } } = require('../services/sensorFirmwareService');
const { SensorNodeService, _private: { hashSecret } } = require('../services/sensorNodeService');

// A correctly checksummed ESP32-C6 application-shaped fixture. The real built
// artifact is also passed through this validator during release preparation.
function image(version = '1.3.0', fill = 0) {
  const bytes = Buffer.alloc(416, fill);
  bytes[0] = 0xE9; bytes[1] = 1; bytes.writeUInt16LE(13, 12); bytes[23] = 1;
  bytes.writeUInt32LE(352, 28);
  bytes.write(`HOMEBRAIN_SENSOR_OTA:1:seeed-xiao-esp32-c6:${version}\0`, 40, 'latin1');
  // Segment ends at byte 384, checksum at 399; digest follows.
  const body = Buffer.alloc(400); bytes.copy(body, 0, 0, 384);
  let xor = 0xEF;
  for (const byte of body.subarray(32, 384)) xor ^= byte;
  body[399] = xor;
  return Buffer.concat([body, createHash('sha256').update(body).digest()]);
}

test('firmware validation rejects wrong boards, bootloader/merged images, truncation, tampering and excessive size', () => {
  const good = image();
  for (const input of [[...good], { length: good.length }, good.toString('latin1'), null]) {
    assert.throws(() => validateImage(input), /octet-stream/);
  }
  assert.equal(validateImage(good).version, '1.3.0');
  assert.equal(validateImage(good).size, good.length);
  for (const bad of [good.subarray(0, -1), Buffer.concat([good, Buffer.alloc(1)]), Buffer.alloc(MAX_IMAGE_BYTES + 1), Buffer.from('not firmware')]) {
    assert.throws(() => validateImage(bad));
  }
  for (const index of [0, 12, 23, 28, 100, 399, 431]) {
    const corrupt = Buffer.from(good); corrupt[index] ^= 0xFF;
    assert.throws(() => validateImage(corrupt));
  }
  assert.ok(compareVersions('1.10.0', '1.9.99') > 0);
  assert.ok(Number.isNaN(compareVersions('dev', '1.3.0')));
});

const nodeId = '507f1f77bcf86cd799439011';
const clone = (value) => value == null ? value : structuredClone(value);
function fixture() {
  let node = { _id: nodeId, name: 'Climate', room: 'Test', hardwareProfile: 'seeed-xiao-esp32-c6',
    profile: 'climate', hardwareId: 'XIAO-C6-A0F26287B788', firmwareVersion: '1.3.0', otaProtocol: 1,
    deviceTokenHash: hashSecret(nodeId, 'device-secret'), firmwareUpdate: null };
  const releases = [];
  const materialize = () => {
    const doc = clone(node);
    doc.save = async () => {
      const { save, ...data } = doc;
      // Mongoose save only updates modified fields. Firmware status can change
      // concurrently; an ordinary reading must not overwrite its job.
      node = { ...data, firmwareUpdate: node.firmwareUpdate };
    };
    return doc;
  };
  const NodeModel = {
    findById: async (id) => String(id) === nodeId ? materialize() : null,
    findOneAndUpdate: async (filter, operation) => {
      if (String(filter._id) !== nodeId) return null;
      for (const [path, expected] of Object.entries(filter)) {
        if (path === '_id') continue;
        const value = path.split('.').reduce((part, key) => part?.[key], node);
        if (expected?.$nin) { if (expected.$nin.includes(value)) return null; }
        else if (expected instanceof Date) { if (new Date(value).getTime() !== expected.getTime()) return null; }
        else if (value !== expected) return null;
      }
      for (const [path, value] of Object.entries(operation.$set)) {
        const parts = path.split('.');
        let target = node;
        for (const key of parts.slice(0, -1)) target = target[key];
        target[parts.at(-1)] = clone(value);
      }
      return clone(node);
    }
  };
  const ReleaseModel = {
    find: () => ({ sort: () => ({ lean: async () => releases.map(({ image: _image, ...meta }) => meta) }) }),
    findOne: async (q) => releases.find(r => r.version === q.version),
    findById: (id) => {
      const value = releases.find(r => r._id === String(id));
      return { then: (resolve) => resolve(value), select: async () => value };
    },
    create: async (data) => {
      const release = { ...data, _id: (releases.length + 1).toString(16).padStart(24, '0'), createdAt: new Date() };
      releases.push(release); return release;
    }
  };
  return { node: () => materialize(), change: (data) => Object.assign(node, data),
    firmware: new SensorFirmwareService({ ReleaseModel, NodeModel }),
    sensors: new SensorNodeService({ SensorNodeModel: NodeModel }) };
}

test('release publication is immutable and latest means version order', async () => {
  const f = fixture();
  const first = await f.firmware.publish(image('1.4.0'), 'Recovery checks');
  assert.equal((await f.firmware.publish(image('1.4.0'))).id, first.id);
  await assert.rejects(f.firmware.publish(image('1.4.0', 1)), { status: 409 });
  await f.firmware.publish(image('1.3.0'));
  const list = await f.firmware.listReleases();
  assert.equal(list[0].version, '1.4.0');
  assert.equal(list[0].image, undefined);
});

test('queued sleepy devices, concurrent requests, failure/retry and terminal reports are handled without regressions', async () => {
  const f = fixture(), release = await f.firmware.publish(image('1.4.0'));
  for (const releaseId of [[release.id], { $ne: null }, { id: release.id }, 1, null]) {
    await assert.rejects(f.firmware.queue(f.node(), releaseId), { status: 400 });
  }
  f.change({ otaProtocol: 0 });
  await assert.rejects(f.firmware.queue(f.node(), release.id), { status: 409 });
  f.change({ otaProtocol: 1 });
  const jobs = await Promise.allSettled([f.firmware.queue(f.node(), release.id), f.firmware.queue(f.node(), release.id)]);
  assert.equal(jobs.filter(j => j.status === 'fulfilled').length, 1);
  const job = f.node().firmwareUpdate;
  assert.equal((await f.firmware.queue(f.node(), release.id)).id, job.id);
  assert.equal(firmwareCommand(f.node()).id, job.id);
  assert.equal((await f.firmware.expire(f.node())).firmwareUpdate.phase, 'queued');
  await assert.rejects(f.firmware.report(f.node(), { id: 'another-job', phase: 'downloading' }), { status: 410 });
  await f.firmware.report(f.node(), { id: job.id, phase: 'installing', progress: 100 });
  await f.firmware.report(f.node(), { id: job.id, phase: 'downloading', progress: 20 });
  assert.equal(f.node().firmwareUpdate.phase, 'installing');
  await assert.rejects(f.firmware.report(f.node(), { id: job.id, phase: 'succeeded', version: '1.4.0', imageSha256: 'wrong' }), { status: 409 });
  await f.firmware.report(f.node(), { id: job.id, phase: 'failed', error: 'Checksum failed' });
  await f.firmware.report(f.node(), { id: job.id, phase: 'rebooting' });
  assert.equal(f.node().firmwareUpdate.phase, 'failed');
  assert.equal(firmwareCommand(f.node()), undefined);
  await assert.rejects(f.firmware.download(f.node(), job.id), { status: 409 });
  const retry = await f.firmware.queue(f.node(), release.id);
  assert.notEqual(retry.id, job.id);
  f.change({ firmwareUpdate: { ...retry, phase: 'downloading', updatedAt: new Date(Date.now() - 31 * 60_000) } });
  assert.equal((await f.firmware.status(f.node())).update.phase, 'failed');
  f.change({ firmwareVersion: '1.5.0' });
  await assert.rejects(f.firmware.queue(f.node(), release.id), /older/);
});

test('authenticated legacy Atmosphere migrates its corrected MAC while unrelated identities remain rejected', async () => {
  const f = fixture();
  f.change({ hardwareId: 'XIAO-C6-87FEFF62F2A0', firmwareVersion: '1.2.0', otaProtocol: 0 });
  const reading = { firmware_version: '1.3.0', ota_protocol: 1, hardware_id: 'XIAO-C6-A0F26287B788', readings: { temperature_c: 20 } };
  await assert.rejects(f.sensors.ingestReading(nodeId, 'wrong', reading), { status: 401 });
  await assert.rejects(f.sensors.ingestReading(nodeId, 'device-secret', { ...reading, hardware_id: 'XIAO-C6-10BDA39F5564' }), { status: 409 });
  await f.sensors.ingestReading(nodeId, 'device-secret', reading);
  assert.equal(f.node().hardwareId, reading.hardware_id);
  assert.equal(f.node().otaProtocol, 1);
  assert.equal(f.node()._id, nodeId);
});

test('HTTP flow: publish → queue → device config → authenticated download → reboot confirmation', async (t) => {
  const f = fixture();
  const old = { get: users.get, oidc: oidc.verifyIssuedAccessToken, secret: process.env.JWT_SECRET };
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  const user = { _id: nodeId, role: 'admin', isActive: true, platforms: { homebrain: true }, isReadOnly: false };
  users.get = async () => user;
  oidc.verifyIssuedAccessToken = async () => { throw Object.assign(new Error('Invalid token'), { status: 401 }); };
  const app = express();
  app.use(express.json());
  app.use('/api/sensor-nodes', createSensorNodeRouter(f.sensors, f.firmware));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    users.get = old.get; oidc.verifyIssuedAccessToken = old.oidc;
    if (old.secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old.secret;
  });
  const base = `http://127.0.0.1:${server.address().port}/api/sensor-nodes`;
  const admin = `Bearer ${jwt.sign({ sub: nodeId }, process.env.JWT_SECRET)}`;
  const sensor = 'Sensor device-secret';
  const send = (path, method = 'GET', auth, body) => fetch(base + path, {
    method, headers: { ...(auth ? { Authorization: auth } : {}),
      'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' },
    ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {})
  });
  for (const auth of [undefined, sensor]) {
    assert.equal((await send('/firmware/releases', 'POST', auth, image())).status, 401);
    assert.equal((await send(`/${nodeId}/firmware`, 'POST', auth, {})).status, 401);
  }
  user.isReadOnly = true;
  assert.equal((await send('/firmware/releases', 'POST', admin, image())).status, 403);
  user.isReadOnly = false;
  const published = await send('/firmware/releases', 'POST', admin, image('1.4.0'));
  assert.equal(published.status, 201);
  const { release } = await published.json();
  const queued = await send(`/${nodeId}/firmware`, 'POST', admin, { releaseId: release.id });
  assert.equal(queued.status, 202);
  const config = await (await send(`/${nodeId}/config`, 'GET', sensor)).json();
  const job = config.config.firmware_update;
  assert.equal(job.version, '1.4.0');
  const path = job.path.replace('/api/sensor-nodes', '');
  assert.equal((await send(path, 'GET', admin)).status, 401);
  assert.equal((await send(path, 'GET', 'Sensor wrong')).status, 401);
  assert.equal((await send(path.replace(nodeId, '507f1f77bcf86cd799439012'), 'GET', sensor)).status, 404);
  const download = await send(path, 'GET', sensor);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('cache-control'), /no-store/);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.length, job.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), job.sha256);
  for (const phase of ['downloading', 'installing', 'rebooting']) {
    assert.equal((await send(`/${nodeId}/firmware/status`, 'POST', sensor, { id: job.id, phase, progress: 50 })).status, 200);
  }
  // Rebooting is not success; the sensor must confirm the exact running image.
  assert.equal((await (await send(`/${nodeId}/firmware`, 'GET', admin)).json()).update.phase, 'rebooting');
  assert.equal((await send(`/${nodeId}/firmware/status`, 'POST', sensor,
    { id: job.id, phase: 'succeeded', version: job.version, imageSha256: job.image_sha256 })).status, 200);
  const completed = await (await send(`/${nodeId}/config`, 'GET', sensor)).json();
  assert.equal(completed.config.firmware_update, undefined);
  assert.equal((await send(path, 'GET', sensor)).status, 409);
});

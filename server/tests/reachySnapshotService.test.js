const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const {
  ReachySnapshotService,
  MAX_SNAPSHOT_BYTES,
  inspectJpeg
} = require('../services/reachySnapshotService');

function jpeg(width = 32, height = 16) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x0c, 0x03,
    0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
    0x12, 0x34,
    0xff, 0xd9
  ]);
}

test('JPEG inspection validates dimensions and rejects malformed content', () => {
  assert.deepEqual(inspectJpeg(jpeg(640, 480)), { width: 640, height: 480 });
  assert.throws(() => inspectJpeg(Buffer.from('not an image')), /valid JPEG/);
  assert.throws(() => inspectJpeg(jpeg(4097, 10)), /must not exceed/);
  assert.throws(() => inspectJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), /frame\/scan/);
  assert.throws(() => inspectJpeg(jpeg().subarray(0, jpeg().length - 2)), /end marker/);
});

test('snapshot storage is owner-only, short-lived, and read once', async (t) => {
  const service = new ReachySnapshotService();
  t.after(() => service.cleanup());
  const snapshotId = crypto.randomUUID();
  const buffer = jpeg(320, 240);
  const created = await service.store({
    deviceId: 'robot-1',
    snapshotId,
    buffer,
    capturedAt: '2026-07-17T12:00:00.000Z'
  });
  const internal = service.snapshots.get(snapshotId);
  const stat = await fs.stat(internal.filePath);

  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(created.width, 320);
  assert.equal(created.height, 240);
  assert.equal(created.capturedAt, '2026-07-17T12:00:00.000Z');
  await assert.rejects(service.take('another-robot', snapshotId), (error) => error.status === 404);

  const consumed = await service.take('robot-1', snapshotId);
  assert.deepEqual(consumed.buffer, buffer);
  await assert.rejects(fs.stat(internal.filePath), (error) => error.code === 'ENOENT');
  await assert.rejects(service.take('robot-1', snapshotId), (error) => error.status === 404);
});

test('snapshot validation enforces UUID, size, uniqueness, and expiry', async (t) => {
  const service = new ReachySnapshotService();
  t.after(() => service.cleanup());
  await assert.rejects(
    service.store({ deviceId: 'robot-1', snapshotId: 'not-a-command-id', buffer: jpeg() }),
    (error) => error.status === 400
  );
  await assert.rejects(
    service.store({ deviceId: 'robot-1', snapshotId: crypto.randomUUID(), buffer: Buffer.alloc(MAX_SNAPSHOT_BYTES + 1) }),
    (error) => error.status === 413
  );

  const snapshotId = crypto.randomUUID();
  await service.store({ deviceId: 'robot-1', snapshotId, buffer: jpeg() });
  await assert.rejects(
    service.store({ deviceId: 'robot-1', snapshotId, buffer: jpeg() }),
    (error) => error.status === 409
  );
  service.snapshots.get(snapshotId).expiresAt = new Date(Date.now() - 1).toISOString();
  await assert.rejects(service.take('robot-1', snapshotId), (error) => error.status === 410);
  assert.equal(service.snapshots.has(snapshotId), false);
});

test('snapshot boundaries reject coercible IDs, epochs, timestamps, and payloads', async (t) => {
  const service = new ReachySnapshotService();
  t.after(() => service.cleanup());
  const snapshotId = crypto.randomUUID();

  assert.throws(() => service.getDeviceEpoch(['robot-1']), (error) => error.status === 400);
  await assert.rejects(
    service.store({ deviceId: 'robot-1', snapshotId: [snapshotId], buffer: jpeg() }),
    (error) => error.status === 400
  );
  await assert.rejects(
    service.store({ deviceId: 'robot-1', snapshotId, buffer: jpeg(), expectedDeviceEpoch: '0' }),
    (error) => error.status === 400
  );
  await assert.rejects(
    service.store({ deviceId: 'robot-1', snapshotId, buffer: Array.from(jpeg()) }),
    (error) => error.status === 400
  );
  await assert.rejects(
    service.store({ deviceId: 'robot-1', snapshotId, buffer: jpeg(), capturedAt: ['2026-07-17T12:00:00Z'] }),
    (error) => error.status === 400
  );
  await assert.rejects(
    service.store({ deviceId: 'robot-1', snapshotId, buffer: jpeg(), capturedAt: 'not-a-timestamp' }),
    (error) => error.status === 400
  );
  assert.throws(() => inspectJpeg(Array.from(jpeg())), (error) => error.status === 400);
  assert.equal(service.snapshots.size, 0);
});

test('snapshot read failure still consumes metadata and securely removes the file', async (t) => {
  const service = new ReachySnapshotService();
  const snapshotId = crypto.randomUUID();
  await service.store({ deviceId: 'robot-1', snapshotId, buffer: jpeg() });
  const filePath = service.snapshots.get(snapshotId).filePath;
  const originalReadFile = fs.readFile;
  fs.readFile = async () => { throw new Error('injected read failure'); };
  t.after(async () => {
    fs.readFile = originalReadFile;
    await service.cleanup();
  });

  await assert.rejects(service.take('robot-1', snapshotId), /injected read failure/);
  assert.equal(service.snapshots.has(snapshotId), false);
  await assert.rejects(fs.stat(filePath), (error) => error.code === 'ENOENT');
});

test('concurrent snapshot reads have exactly one consumer', async (t) => {
  const service = new ReachySnapshotService();
  const snapshotId = crypto.randomUUID();
  const buffer = jpeg();
  await service.store({ deviceId: 'robot-1', snapshotId, buffer });
  const originalReadFile = fs.readFile;
  let releaseRead;
  fs.readFile = () => new Promise((resolve) => { releaseRead = resolve; });
  t.after(async () => {
    fs.readFile = originalReadFile;
    await service.cleanup();
  });

  const first = service.take('robot-1', snapshotId);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.take('robot-1', snapshotId), (error) => error.status === 409);
  releaseRead(buffer);
  assert.deepEqual((await first).buffer, buffer);
  await assert.rejects(service.take('robot-1', snapshotId), (error) => error.status === 404);
});

test('concurrent duplicate uploads reserve the command ID before filesystem I/O', async (t) => {
  const service = new ReachySnapshotService();
  const snapshotId = crypto.randomUUID();
  const originalWriteFile = fs.writeFile;
  let releaseWrite;
  fs.writeFile = () => new Promise((resolve) => { releaseWrite = resolve; });
  t.after(async () => {
    fs.writeFile = originalWriteFile;
    await service.cleanup();
  });

  const first = service.store({ deviceId: 'robot-1', snapshotId, buffer: jpeg() });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    service.store({ deviceId: 'robot-1', snapshotId, buffer: jpeg() }),
    (error) => error.status === 409
  );
  releaseWrite();
  await first;
  assert.equal(service.snapshots.size, 1);
});

test('device privacy revocation purges every unconsumed snapshot immediately', async (t) => {
  const service = new ReachySnapshotService();
  t.after(() => service.cleanup());
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  await service.store({ deviceId: 'robot-1', snapshotId: first, buffer: jpeg() });
  await service.store({ deviceId: 'robot-1', snapshotId: second, buffer: jpeg() });
  await service.store({ deviceId: 'robot-2', snapshotId: crypto.randomUUID(), buffer: jpeg() });
  const paths = [
    service.snapshots.get(first).filePath,
    service.snapshots.get(second).filePath
  ];

  assert.equal(await service.removeDevice('robot-1'), 2);
  await assert.rejects(service.take('robot-1', first), (error) => error.status === 404);
  await assert.rejects(service.take('robot-1', second), (error) => error.status === 404);
  for (const filePath of paths) {
    await assert.rejects(fs.stat(filePath), (error) => error.code === 'ENOENT');
  }
  assert.equal(service.snapshots.size, 1);
});

test('an upload cannot adopt an epoch captured before privacy revocation', async (t) => {
  const service = new ReachySnapshotService();
  t.after(() => service.cleanup());
  const expectedDeviceEpoch = service.getDeviceEpoch('robot-1');

  await service.removeDevice('robot-1');
  await assert.rejects(
    service.store({
      deviceId: 'robot-1',
      snapshotId: crypto.randomUUID(),
      buffer: jpeg(),
      expectedDeviceEpoch
    }),
    (error) => error.status === 403 && /revoked before upload/i.test(error.message)
  );
  assert.equal(service.snapshots.size, 0);
});

test('revocation during a snapshot read prevents image bytes from being returned', async (t) => {
  const service = new ReachySnapshotService();
  const snapshotId = crypto.randomUUID();
  const buffer = jpeg();
  await service.store({ deviceId: 'robot-1', snapshotId, buffer });
  const originalReadFile = fs.readFile;
  let releaseRead;
  fs.readFile = () => new Promise((resolve) => { releaseRead = resolve; });
  t.after(async () => {
    fs.readFile = originalReadFile;
    await service.cleanup();
  });

  const reading = service.take('robot-1', snapshotId);
  await new Promise((resolve) => setImmediate(resolve));
  await service.removeDevice('robot-1');
  releaseRead(buffer);
  await assert.rejects(reading, (error) => error.status === 403);
  assert.equal(service.snapshots.has(snapshotId), false);
});

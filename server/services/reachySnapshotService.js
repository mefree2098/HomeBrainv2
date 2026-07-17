const crypto = require('node:crypto');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const SNAPSHOT_TTL_MS = 2 * 60 * 1000;

function inspectJpeg(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw Object.assign(new Error('Snapshot payload is not a valid JPEG'), { status: 400 });
  }
  let offset = 2;
  let width = null;
  let height = null;
  let sawScan = false;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      throw Object.assign(new Error('Snapshot JPEG marker structure is invalid'), { status: 400 });
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) {
      throw Object.assign(new Error('Snapshot JPEG structure is truncated'), { status: 400 });
    }
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9) {
      if (!width || !height || !sawScan || offset !== buffer.length) {
        throw Object.assign(new Error('Snapshot JPEG is missing a valid frame/scan or has trailing data'), { status: 400 });
      }
      return { width, height };
    }
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw Object.assign(new Error('Snapshot JPEG contains an invalid standalone marker'), { status: 400 });
    }
    if (offset + 2 > buffer.length) {
      throw Object.assign(new Error('Snapshot JPEG structure is truncated'), { status: 400 });
    }
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) {
      throw Object.assign(new Error('Snapshot JPEG structure is truncated'), { status: 400 });
    }
    if (sofMarkers.has(marker)) {
      if (length < 8) throw Object.assign(new Error('Snapshot JPEG dimensions are malformed'), { status: 400 });
      height = buffer.readUInt16BE(offset + 3);
      width = buffer.readUInt16BE(offset + 5);
      if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw Object.assign(new Error(`Snapshot dimensions must not exceed ${MAX_DIMENSION}x${MAX_DIMENSION}`), { status: 400 });
      }
    }
    if (marker !== 0xda) {
      offset += length;
      continue;
    }

    if (!width || !height) {
      throw Object.assign(new Error('Snapshot JPEG scan appears before a valid frame header'), { status: 400 });
    }
    sawScan = true;
    offset += length;
    let foundMarker = false;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const markerStart = offset;
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) break;
      const scanMarker = buffer[offset];
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        offset += 1;
        continue;
      }
      offset = markerStart;
      foundMarker = true;
      break;
    }
    if (!foundMarker) {
      throw Object.assign(new Error('Snapshot JPEG scan is missing an end marker'), { status: 400 });
    }
  }
  throw Object.assign(new Error('Snapshot JPEG is missing an end-of-image marker'), { status: 400 });
}

class ReachySnapshotService {
  constructor() {
    this.snapshots = new Map();
    this.deviceEpochs = new Map();
  }

  getDeviceEpoch(deviceId) {
    return this.deviceEpochs.get(String(deviceId)) || 0;
  }

  async store({ deviceId, snapshotId, buffer, capturedAt = null, expectedDeviceEpoch = undefined }) {
    const normalizedDeviceId = String(deviceId);
    const boundDeviceEpoch = expectedDeviceEpoch === undefined
      ? this.getDeviceEpoch(normalizedDeviceId)
      : Number(expectedDeviceEpoch);
    if (!Number.isInteger(boundDeviceEpoch) || boundDeviceEpoch < 0) {
      throw Object.assign(new Error('Snapshot permission epoch is invalid'), { status: 400 });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshotId || '')) {
      throw Object.assign(new Error('snapshotId must be the snapshot command UUID'), { status: 400 });
    }
    if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_SNAPSHOT_BYTES) {
      throw Object.assign(new Error(`Snapshot must be between 1 byte and ${MAX_SNAPSHOT_BYTES} bytes`), { status: 413 });
    }
    if (this.snapshots.has(snapshotId)) {
      throw Object.assign(new Error('Snapshot was already uploaded'), { status: 409 });
    }
    const dimensions = inspectJpeg(buffer);
    // The route captures this epoch before its asynchronous permission read.
    // Reject before reservation if a privacy disable completed in between.
    if (boundDeviceEpoch !== this.getDeviceEpoch(normalizedDeviceId)) {
      throw Object.assign(new Error('Snapshot permission was revoked before upload'), { status: 403 });
    }
    const filePath = path.join(os.tmpdir(), `homebrain-reachy-snapshot-${crypto.randomUUID()}.jpg`);
    const expiresAt = new Date(Date.now() + SNAPSHOT_TTL_MS);
    const parsedCapturedAt = capturedAt && Number.isFinite(new Date(capturedAt).getTime())
      ? new Date(capturedAt).toISOString()
      : null;
    const snapshot = {
      id: snapshotId,
      deviceId: normalizedDeviceId,
      bytes: buffer.length,
      contentType: 'image/jpeg',
      width: dimensions.width,
      height: dimensions.height,
      capturedAt: parsedCapturedAt,
      expiresAt: expiresAt.toISOString(),
      filePath,
      deviceEpoch: boundDeviceEpoch,
      reserving: true,
      consuming: false,
      timer: null
    };
    // Reserve synchronously before the first await so concurrent uploads of
    // the same command UUID cannot both create private temp files.
    this.snapshots.set(snapshotId, snapshot);
    try {
      await fsPromises.writeFile(filePath, buffer, { mode: 0o600, flag: 'wx' });
      if (
        this.snapshots.get(snapshotId) !== snapshot
        || snapshot.deviceEpoch !== this.getDeviceEpoch(normalizedDeviceId)
      ) {
        throw Object.assign(new Error('Snapshot permission was revoked during upload'), { status: 403 });
      }
      snapshot.reserving = false;
      snapshot.timer = setTimeout(() => this.remove(snapshotId).catch(() => {}), SNAPSHOT_TTL_MS);
      snapshot.timer.unref?.();
      return this.toPublic(snapshot);
    } catch (error) {
      if (this.snapshots.get(snapshotId) === snapshot) this.snapshots.delete(snapshotId);
      await fsPromises.rm(filePath, { force: true }).catch(() => {});
      throw error;
    }
  }

  toPublic(snapshot) {
    return {
      id: snapshot.id,
      bytes: snapshot.bytes,
      contentType: snapshot.contentType,
      width: snapshot.width,
      height: snapshot.height,
      capturedAt: snapshot.capturedAt,
      expiresAt: snapshot.expiresAt
    };
  }

  async take(deviceId, snapshotId) {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.deviceId !== String(deviceId)) {
      throw Object.assign(new Error('Snapshot not found or already consumed'), { status: 404 });
    }
    if (Date.parse(snapshot.expiresAt) <= Date.now()) {
      await this.remove(snapshotId);
      throw Object.assign(new Error('Snapshot expired'), { status: 410 });
    }
    if (snapshot.reserving) {
      throw Object.assign(new Error('Snapshot upload is still being committed'), { status: 409 });
    }
    if (snapshot.consuming) {
      throw Object.assign(new Error('Snapshot is already being consumed'), { status: 409 });
    }
    if (snapshot.deviceEpoch !== this.getDeviceEpoch(deviceId)) {
      await this.remove(snapshotId);
      throw Object.assign(new Error('Snapshot permission was revoked'), { status: 403 });
    }
    snapshot.consuming = true;
    let buffer;
    let revoked = false;
    try {
      buffer = await fsPromises.readFile(snapshot.filePath);
      revoked = snapshot.deviceEpoch !== this.getDeviceEpoch(deviceId);
    } finally {
      this.snapshots.delete(snapshotId);
      clearTimeout(snapshot.timer);
      await fsPromises.rm(snapshot.filePath, { force: true });
    }
    if (revoked) {
      throw Object.assign(new Error('Snapshot permission was revoked'), { status: 403 });
    }
    return { snapshot: this.toPublic(snapshot), buffer };
  }

  async remove(snapshotId) {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) return false;
    this.snapshots.delete(snapshotId);
    clearTimeout(snapshot.timer);
    await fsPromises.rm(snapshot.filePath, { force: true });
    return true;
  }

  async removeDevice(deviceId) {
    const normalizedDeviceId = String(deviceId);
    // Increment before the first await so in-flight uploads/reads fail their
    // post-I/O epoch check and can never return pre-revocation image bytes.
    this.deviceEpochs.set(normalizedDeviceId, this.getDeviceEpoch(normalizedDeviceId) + 1);
    const matching = Array.from(this.snapshots.entries())
      .filter(([, snapshot]) => snapshot.deviceId === normalizedDeviceId)
      .map(([snapshotId]) => snapshotId);
    await Promise.all(matching.map((snapshotId) => this.remove(snapshotId)));
    return matching.length;
  }

  async cleanup() {
    await Promise.all(Array.from(this.snapshots.keys()).map((id) => this.remove(id)));
    this.deviceEpochs.clear();
  }
}

module.exports = new ReachySnapshotService();
module.exports.ReachySnapshotService = ReachySnapshotService;
module.exports.MAX_SNAPSHOT_BYTES = MAX_SNAPSHOT_BYTES;
module.exports.SNAPSHOT_TTL_MS = SNAPSHOT_TTL_MS;
module.exports.inspectJpeg = inspectJpeg;

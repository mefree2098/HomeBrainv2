const { createHash, randomUUID } = require('node:crypto');
const SensorFirmwareRelease = require('../models/SensorFirmwareRelease');
const SensorNode = require('../models/SensorNode');

const HARDWARE = 'seeed-xiao-esp32-c6';
const MAX_IMAGE_BYTES = 0x1D0000;
const ACTIVE = ['queued', 'downloading', 'installing', 'rebooting'];
const RANK = { queued: 0, downloading: 1, installing: 2, rebooting: 3, succeeded: 4, failed: 4 };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const digest = (data) => createHash('sha256').update(data).digest('hex');
const validVersion = (version) => typeof version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version);
function compareVersions(a, b) {
  if (!validVersion(a) || !validVersion(b)) return NaN;
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
}

function validateImage(image) {
  if (!Buffer.isBuffer(image) || image.length < 320 || image.length > MAX_IMAGE_BYTES) {
    throw fail('Upload an application firmware .bin that fits the sensor OTA slot (maximum 1,900,544 bytes).');
  }
  if (image[0] !== 0xE9 || image.readUInt16LE(12) !== 13 || image[23] !== 1 || image[1] < 1 || image[1] > 16) {
    throw fail('This is not an ESP32-C6 application image with an embedded checksum.');
  }
  // ESP image: 24-byte header, length-prefixed segments, XOR checksum at the
  // end of a 16-byte block, then an appended SHA-256 of the preceding bytes.
  let offset = 24, checksum = 0xEF;
  for (let i = 0; i < image[1]; i++) {
    if (offset + 8 > image.length) throw fail('Truncated firmware segment header.');
    const length = image.readUInt32LE(offset + 4);
    offset += 8;
    if (length > image.length - offset) throw fail('Truncated firmware segment.');
    for (const byte of image.subarray(offset, offset + length)) checksum ^= byte;
    offset += length;
  }
  const checksumOffset = Math.floor(offset / 16) * 16 + 15;
  if (checksumOffset + 33 !== image.length || image[checksumOffset] !== checksum
      || digest(image.subarray(0, checksumOffset + 1)) !== image.subarray(checksumOffset + 1).toString('hex')) {
    throw fail('Firmware checksum is invalid or the image is incomplete.');
  }
  // The marker is compiled into every supported build, binding the supplied
  // image to its version and board rather than trusting an upload filename.
  const markers = [...image.toString('latin1').matchAll(/HOMEBRAIN_SENSOR_OTA:1:seeed-xiao-esp32-c6:(\d{1,4}\.\d{1,4}\.\d{1,4})\x00/g)];
  if (markers.length !== 1) throw fail('Image does not contain a supported HomeBrain sensor OTA manifest.');
  return { version: markers[0][1], hardwareProfile: HARDWARE, protocol: 1, size: image.length,
    sha256: digest(image), imageSha256: image.subarray(-32).toString('hex') };
}

function releaseSummary(release) {
  return { id: String(release._id), version: release.version, hardwareProfile: release.hardwareProfile,
    protocol: release.protocol, size: release.size, sha256: release.sha256, imageSha256: release.imageSha256,
    notes: release.notes || '', createdAt: release.createdAt };
}

function firmwareCommand(node) {
  const job = node.firmwareUpdate;
  if (node.otaProtocol !== 1 || !job || !ACTIVE.includes(job.phase)) return undefined;
  return { id: job.id, version: job.version, hardware_profile: HARDWARE, protocol: 1,
    size: job.size, sha256: job.sha256, image_sha256: job.imageSha256,
    path: `/api/sensor-nodes/${node._id}/firmware/download/${job.id}` };
}

class SensorFirmwareService {
  constructor({ ReleaseModel = SensorFirmwareRelease, NodeModel = SensorNode } = {}) {
    this.Release = ReleaseModel;
    this.Node = NodeModel;
  }

  async listReleases() {
    const releases = await this.Release.find({}).sort({ createdAt: -1 }).lean();
    return releases.map(releaseSummary).sort((a, b) => compareVersions(b.version, a.version));
  }

  async publish(image, notes = '') {
    const manifest = validateImage(image);
    const existing = await this.Release.findOne({ version: manifest.version });
    if (existing) {
      if (existing.sha256 !== manifest.sha256) throw fail('This version already exists with different firmware. Increment the firmware version.', 409);
      return releaseSummary(existing);
    }
    const release = await this.Release.create({ ...manifest, image, notes: String(notes).trim().slice(0, 2000) });
    return releaseSummary(release);
  }

  async expire(node) {
    const job = node.firmwareUpdate;
    // Queued jobs wait indefinitely for sleepy/offline devices. A device spends
    // at most a few minutes downloading and verifying, even on a failed boot.
    if (job && ACTIVE.includes(job.phase) && job.phase !== 'queued'
        && Date.now() - new Date(job.updatedAt).getTime() > 30 * 60_000) {
      return await this.Node.findOneAndUpdate({ _id: node._id, 'firmwareUpdate.id': job.id,
        'firmwareUpdate.updatedAt': job.updatedAt, 'firmwareUpdate.phase': job.phase }, { $set: {
        'firmwareUpdate.phase': 'failed', 'firmwareUpdate.error': 'The sensor stopped reporting update progress. Retry when it is online.',
        'firmwareUpdate.updatedAt': new Date()
      } }, { new: true }) || node;
    }
    return node;
  }

  async status(input) {
    const node = await this.expire(input);
    const releases = await this.listReleases();
    const latest = releases.find((r) => r.hardwareProfile === node.hardwareProfile && r.protocol === 1) || null;
    return { supported: node.otaProtocol === 1, currentVersion: node.firmwareVersion || '', latest,
      updateAvailable: !!latest && compareVersions(latest.version, node.firmwareVersion) > 0,
      update: node.firmwareUpdate || null };
  }

  async queue(input, releaseId) {
    const node = await this.expire(input);
    if (node.otaProtocol !== 1) throw fail('This sensor needs the one-time USB installation of OTA firmware first.', 409);
    if (!/^[a-f0-9]{24}$/i.test(String(releaseId || ''))) throw fail('Choose a published firmware release.');
    const release = await this.Release.findById(releaseId);
    if (!release) throw fail('Firmware release not found.', 404);
    if (release.hardwareProfile !== node.hardwareProfile || release.protocol !== 1) throw fail('Firmware is incompatible with this sensor.');
    // Same-version reinstall is useful for recovery and for verifying the initial
    // OTA bootstrap. A downgrade requires a separately versioned recovery build.
    if (!(compareVersions(release.version, node.firmwareVersion) >= 0)) throw fail('Cannot install firmware older than the running version.');
    if (node.firmwareUpdate && ACTIVE.includes(node.firmwareUpdate.phase)) {
      if (String(node.firmwareUpdate.releaseId) === String(releaseId)) return node.firmwareUpdate;
      throw fail('An update is already in progress for this sensor.', 409);
    }
    const now = new Date();
    const job = { id: randomUUID(), releaseId: String(release._id), version: release.version,
      size: release.size, sha256: release.sha256, imageSha256: release.imageSha256,
      phase: 'queued', progress: 0, error: '', requestedAt: now, updatedAt: now };
    const updated = await this.Node.findOneAndUpdate({ _id: node._id,
      'firmwareUpdate.phase': { $nin: ACTIVE } }, { $set: { firmwareUpdate: job } }, { new: true });
    if (!updated) throw fail('An update was just queued. Refresh to see its progress.', 409);
    return updated.firmwareUpdate;
  }

  async download(node, jobId) {
    const job = node.firmwareUpdate;
    if (!job || job.id !== jobId || !ACTIVE.includes(job.phase)) throw fail('This update is no longer available.', 409);
    const release = await this.Release.findById(job.releaseId).select('+image');
    if (!release || !release.image || release.sha256 !== job.sha256) throw fail('Firmware artifact unavailable.', 404);
    return release;
  }

  async report(node, payload = {}) {
    const job = node.firmwareUpdate;
    if (!job || payload.id !== job.id) throw fail('This update has been superseded.', 410);
    const phase = payload.phase;
    if (!Object.hasOwn(RANK, phase) || phase === 'queued') throw fail('Invalid firmware update status.');
    if (!ACTIVE.includes(job.phase)) return job; // Idempotent terminal acknowledgement.
    if (RANK[phase] < RANK[job.phase]) return job; // Late progress must not regress.
    if (phase === 'succeeded' && (payload.version !== job.version || payload.imageSha256 !== job.imageSha256)) {
      throw fail('The running firmware does not match the requested release.', 409);
    }
    const progress = phase === 'succeeded' ? 100 : Math.min(100, Math.max(Number(job.progress) || 0,
      Number.isFinite(payload.progress) ? Math.round(payload.progress) : 0));
    const updated = await this.Node.findOneAndUpdate({ _id: node._id, 'firmwareUpdate.id': job.id,
      'firmwareUpdate.phase': job.phase }, { $set: { 'firmwareUpdate.phase': phase,
      'firmwareUpdate.progress': progress, 'firmwareUpdate.updatedAt': new Date(),
      'firmwareUpdate.error': phase === 'failed' ? String(payload.error || 'Firmware update failed.').slice(0, 300) : ''
    } }, { new: true });
    if (!updated) throw fail('Update state changed. Retry the status report.', 409);
    return updated.firmwareUpdate;
  }
}

module.exports = new SensorFirmwareService();
module.exports.SensorFirmwareService = SensorFirmwareService;
module.exports.firmwareCommand = firmwareCommand;
module.exports.MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;
module.exports._private = { validateImage, compareVersions, releaseSummary, digest, ACTIVE };

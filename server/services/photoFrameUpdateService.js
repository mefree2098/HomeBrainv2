const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const PhotoFrame = require('../models/PhotoFrame');

const ROOT = path.resolve(process.env.HOMEBRAIN_PHOTO_FRAME_OTA_STORAGE || path.join(__dirname, '../data/photo-frame-ota'));
const MAX_BYTES = 16 * 1024 * 1024;
const PACKAGE = 'com.homebrain.photoframe';
const HARDWARE = 'humblestead-10.1-1280x800';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTIVE = ['queued', 'downloading', 'verifying', 'installing', 'restarting'];
const PHASES = [...ACTIVE, 'complete', 'failed'];
const failure = (status, message) => Object.assign(new Error(message), { status });
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
let keyPromise;

// An atomic, exclusive publication prevents a second process from replacing the
// hub identity while devices are pairing. Include this directory in hub backups.
async function key() {
  if (!keyPromise) keyPromise = (async () => {
    await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
    const file = path.join(ROOT, 'signing-key.pem');
    try { return crypto.createPrivateKey(await fs.readFile(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { privateKey } = await new Promise((resolve, reject) => crypto.generateKeyPair('rsa', { modulusLength: 2048 }, (error, publicKey, privateKey) => error ? reject(error) : resolve({ publicKey, privateKey })));
    const temporary = path.join(ROOT, `key-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    try { await fs.link(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; } finally { await fs.unlink(temporary); }
    return crypto.createPrivateKey(await fs.readFile(file));
  })().catch((error) => { keyPromise = null; throw error; });
  return keyPromise;
}
async function publicKey() {
  const der = crypto.createPublicKey(await key()).export({ type: 'spki', format: 'der' });
  return { algorithm: 'SHA256withRSA', publicKey: der.toString('base64'), fingerprint: sha256(der) };
}
function releasePath(id, extension) {
  if (!UUID.test(String(id))) throw failure(400, 'Invalid release ID');
  return path.join(ROOT, 'releases', `${id}.${extension}`);
}
async function getRelease(id) {
  try {
    const release = JSON.parse(await fs.readFile(releasePath(id, 'json'), 'utf8'));
    const verifier = crypto.createPublicKey(await key());
    if (!crypto.verify('RSA-SHA256', Buffer.from(release.payload), verifier, Buffer.from(release.signature, 'base64'))) throw failure(500, 'Release signature is invalid');
    const details = JSON.parse(release.payload);
    if (details.releaseId !== id || details.kind !== 'runtime-apk' || details.packageName !== PACKAGE) throw failure(500, 'Release metadata is invalid');
    return { ...release, details };
  } catch (error) { if (error.code === 'ENOENT') throw failure(404, 'Release not found'); throw error; }
}
async function listReleases() {
  let files;
  try { files = await fs.readdir(path.join(ROOT, 'releases')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const releases = await Promise.all(files.filter((file) => UUID.test(file.slice(0, -5)) && file.endsWith('.json')).map(async (file) => (await getRelease(file.slice(0, -5))).details));
  return releases.sort((a, b) => b.versionCode - a.versionCode);
}
async function publish(bytes, input = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 100 || bytes.length > MAX_BYTES || bytes.readUInt32LE(0) !== 0x04034b50) throw failure(400, 'Upload an Android APK of at most 16 MB');
  const versionCode = Number(input.versionCode);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000 || typeof input.versionName !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/.test(input.versionName)) throw failure(400, 'Enter the APK’s version name and positive version code');
  const details = {
    protocol: 1, kind: 'runtime-apk', releaseId: crypto.randomUUID(), packageName: PACKAGE,
    hardwareProfile: HARDWARE, versionCode, versionName: input.versionName,
    bytes: bytes.length, sha256: sha256(bytes), createdAt: new Date().toISOString()
  };
  // Devices additionally inspect the signed APK's manifest and certificate. A
  // hub signature cannot authorize a different app, signer, or a downgrade.
  const payload = JSON.stringify(details);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(payload), await key()).toString('base64');
  await fs.mkdir(path.join(ROOT, 'releases'), { recursive: true, mode: 0o700 });
  await fs.writeFile(releasePath(details.releaseId, 'apk'), bytes, { flag: 'wx', mode: 0o600 });
  try { await fs.writeFile(releasePath(details.releaseId, 'json'), JSON.stringify({ payload, signature }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { await fs.unlink(releasePath(details.releaseId, 'apk')); throw error; }
  return details;
}
async function queue(frame, releaseId) {
  const { details } = await getRelease(releaseId);
  if (details.hardwareProfile !== frame.hardwareProfile) throw failure(400, 'This release is for different frame hardware');
  if (!frame.software?.otaCapable) throw failure(409, 'The frame must report its OTA installer ready before an update can be queued');
  if (details.versionCode <= frame.software.versionCode) throw failure(409, 'Choose a release newer than the installed version');
  const now = new Date();
  const job = { id: crypto.randomUUID(), releaseId, versionName: details.versionName, versionCode: details.versionCode, sha256: details.sha256, status: 'queued', progress: 0, message: 'Waiting for the frame to connect', requestedAt: now, updatedAt: now };
  const result = await PhotoFrame.updateOne({ _id: frame._id, 'ota.status': { $nin: ACTIVE } }, { $set: { ota: job }, $inc: { __v: 1 } });
  if (result.matchedCount !== 1) throw failure(409, 'An update is already active for this frame');
  return job;
}
async function cancel(frame) {
  // Cancellation is possible only before the frame claims the job. Never
  // interrupt PackageInstaller or replace an in-flight assignment.
  const result = await PhotoFrame.updateOne({ _id: frame._id, 'ota.id': frame.ota?.id, 'ota.status': 'queued' }, { $set: { 'ota.status': 'canceled', 'ota.message': 'Canceled before download', 'ota.updatedAt': new Date() }, $inc: { __v: 1 } });
  if (result.matchedCount !== 1) throw failure(409, 'Only a queued update can be canceled');
}
async function poll(frame) {
  const identity = await publicKey();
  let update = null;
  if (ACTIVE.includes(frame.ota?.status)) {
    const release = await getRelease(frame.ota.releaseId);
    update = { jobId: frame.ota.id, status: frame.ota.status, payload: release.payload, signature: release.signature,
      downloadPath: `/api/photo-frames/${frame._id}/device/updates/${frame.ota.id}/apk` };
  }
  return { protocol: 1, ...identity, update };
}
async function download(frame, jobId) {
  if (frame.ota?.id !== jobId || !ACTIVE.includes(frame.ota?.status)) throw failure(404, 'No assigned update');
  const { details } = await getRelease(frame.ota.releaseId);
  const file = releasePath(details.releaseId, 'apk');
  const bytes = await fs.readFile(file);
  if (bytes.length !== details.bytes || sha256(bytes) !== details.sha256) throw failure(500, 'Release file failed verification');
  return file;
}
async function report(frame, input = {}) {
  const software = input.software;
  if (!software || !Number.isSafeInteger(software.versionCode) || software.versionCode < 1 || typeof software.versionName !== 'string' || software.versionName.length > 40 || typeof software.otaCapable !== 'boolean') throw failure(400, 'Invalid installed software report');
  if (software.sha256 !== undefined && (typeof software.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(software.sha256))) throw failure(400, 'Invalid installed APK digest');
  const set = { software: { versionCode: software.versionCode, versionName: software.versionName, sha256: software.sha256 || null, otaCapable: software.otaCapable, reportedAt: new Date() }, playerVersion: software.versionName, lastSeen: new Date() };
  const filter = { _id: frame._id };
  if (input.jobId) {
    if (!UUID.test(input.jobId) || frame.ota?.id !== input.jobId) throw failure(409, 'Update assignment changed');
    if (!ACTIVE.includes(frame.ota?.status)) throw failure(409, 'Update is no longer active');
    if (!PHASES.includes(input.status) || !Number.isFinite(input.progress) || input.progress < 0 || input.progress > 100) throw failure(400, 'Invalid update progress');
    const previous = ACTIVE.indexOf(frame.ota.status);
    if (ACTIVE.includes(input.status) && ACTIVE.indexOf(input.status) < previous) throw failure(409, 'Update progress cannot move backward');
    if (input.status === 'complete' && software.versionCode !== frame.ota.versionCode) throw failure(409, 'Installed version does not match the assigned release');
    if (input.status === 'complete' && (!frame.ota.sha256 || software.sha256 !== frame.ota.sha256)) throw failure(409, 'Installed APK digest does not match the assigned release');
    filter['ota.id'] = input.jobId;
    filter['ota.status'] = frame.ota.status;
    Object.assign(set, { 'ota.status': input.status, 'ota.progress': input.status === 'complete' ? 100 : input.progress,
      'ota.message': typeof input.message === 'string' ? input.message.replace(/[\u0000-\u001f]/g, '').slice(0, 240) : '', 'ota.updatedAt': new Date() });
  }
  const result = await PhotoFrame.updateOne(filter, { $set: set });
  if (result.matchedCount !== 1) throw failure(409, 'Update assignment changed; poll again');
}

module.exports = { publicKey, listReleases, publish, queue, cancel, poll, download, report, MAX_BYTES, __private__: { getRelease, releasePath, ACTIVE } };

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { Types } = require('mongoose');
const PhotoFrame = require('../models/PhotoFrame');
const { normalizeConfig, METRICS, POSITIONS, invalid } = require('./photoFrameConfig');

const STORAGE_ROOT = path.resolve(process.env.HOMEBRAIN_PHOTO_FRAME_STORAGE || path.join(__dirname, '../data/photo-frames'));
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_LIBRARY_BYTES = 1024 * 1024 * 1024;
const MAX_PHOTOS = 500;
const FRAME_ID = /^[0-9a-f]{24}$/i;
const PHOTO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function failure(status, message) { return Object.assign(new Error(message), { status }); }
function framePath(frameId, photoId) {
  if (typeof frameId !== 'string' || !FRAME_ID.test(frameId)) throw invalid('Invalid frame or photo ID');
  const directory = path.join(STORAGE_ROOT, path.basename(frameId));
  if (photoId === undefined) return directory;
  if (typeof photoId !== 'string' || !PHOTO_ID.test(photoId)) throw invalid('Invalid frame or photo ID');
  return path.join(directory, path.basename(photoId));
}
function cleanName(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\r\n\u0000-\u001f]/.test(value)) throw invalid('Enter a valid name of at most 120 characters');
  return value.trim();
}

// Decode only raster formats that the player supports. Never serve user-supplied
// MIME types or SVG/HTML. Dimension checks also bound the device's decode memory.
function inspectPhoto(encoded) {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw invalid('Upload a JPEG or PNG of at most 5 MB');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) throw invalid('Upload a JPEG or PNG of at most 5 MB');
  let width = 0;
  let height = 0;
  let contentType;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    contentType = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length > 10 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    contentType = 'image/jpeg';
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break;
      }
      offset += length + 2;
    }
  }
  if (!contentType || !width || !height || width > 8192 || height > 8192 || width * height > 40_000_000) throw invalid('Use a valid JPEG or PNG, no larger than 8192 pixels per side or 40 megapixels');
  return { bytes, contentType, width, height };
}

function serialize(frame) {
  return {
    id: String(frame._id), name: frame.name, room: frame.room,
    hardwareProfile: frame.hardwareProfile,
    width: frame.config.orientation === 'portrait' ? 800 : 1280,
    height: frame.config.orientation === 'portrait' ? 1280 : 800,
    config: frame.config, photos: (frame.photos || []).map((photo) => ({
      id: photo.id, name: photo.name, contentType: photo.contentType,
      bytes: photo.bytes, createdAt: photo.createdAt,
      url: `/api/photo-frames/${frame._id}/photos/${photo.id}`
    })),
    lastSeen: frame.lastSeen,
    online: Boolean(frame.lastSeen && Date.now() - new Date(frame.lastSeen).getTime() < 90_000),
    playerVersion: frame.playerVersion, software: frame.software || null, ota: frame.ota || null, updatedAt: frame.updatedAt
  };
}

const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const rounded = (value, suffix, digits = 0) => finite(value) ? `${Number(value).toFixed(digits)}${suffix}` : null;
const timestamp = (value) => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString() : null;

function formatMetrics({ weather = null, alarm = null, rain = null } = {}, now = new Date()) {
  const current = weather?.current || {};
  const today = weather?.today || {};
  const station = weather?.tempest?.station;
  const outdoor = station?.metrics || {};
  const indoor = weather?.indoorAir?.monitor;
  const values = {};
  const put = (key, label, value, observedAt, live = true, maxAgeMs = 30 * 60_000) => {
    const observed = timestamp(observedAt);
    values[key] = {
      text: value === null ? `${label} —` : `${label}${label ? ' ' : ''}${value}`,
      value, observedAt: observed,
      stale: value !== null && (!live || !observed || now.getTime() - new Date(observed).getTime() > maxAgeMs)
    };
  };
  const observedAt = station?.observedAt || weather?.fetchedAt;
  put('outsideTemperature', 'Outside', rounded(current.temperatureF, '°F'), observedAt, station?.isOnline !== false);
  put('insideTemperature', 'Inside', rounded(indoor?.temperatureF, '°F'), indoor?.observedAt, indoor?.isOnline !== false);
  put('outsideAqi', 'Outside AQI', rounded(current.airQualityIndex, ''), weather?.fetchedAt);
  put('insideAqi', 'Inside AQI', rounded(indoor?.usAqi, ''), indoor?.observedAt, indoor?.isOnline !== false);
  const alarmLabels = { armedStay: 'Armed · stay', armedAway: 'Armed · away', disarmed: 'Disarmed', arming: 'Arming', triggered: 'ALARM TRIGGERED' };
  put('alarm', '', alarm?.isOnline === false ? null : (alarmLabels[alarm?.alarmState] || null), alarm ? now : null);
  if (values.alarm.value === null) values.alarm.text = 'Alarm status unavailable';
  const forecast = weather && today.condition ? `${today.condition}${finite(today.highF) ? ` · ${Math.round(today.highF)}°` : ''}${finite(today.lowF) ? ` / ${Math.round(today.lowF)}°` : ''}${finite(today.precipitationChance) ? ` · ${today.precipitationChance}% rain` : ''}` : null;
  put('forecast', '', forecast, weather?.fetchedAt, true, 6 * 60 * 60_000);
  // A calendar-day total is deliberately never substituted for a rolling window.
  put('rain24h', 'Rain recorded (24h)', rain?.observationCount > 0 && finite(rain.rainTotalMm) ? rounded(rain.rainTotalMm / 25.4, ' in', 2) : null, rain?.lastObservedAt);
  put('lightning', 'Lightning (24h)', rounded(outdoor.lightningCount, ' strikes'), station?.observedAt, station?.isOnline !== false);
  put('outsideHumidity', 'Outside humidity', rounded(current.humidity, '%'), observedAt, station?.isOnline !== false);
  put('insideHumidity', 'Inside humidity', rounded(indoor?.humidityPct, '%'), indoor?.observedAt, indoor?.isOnline !== false);
  put('co2', 'CO₂', rounded(indoor?.co2Ppm, ' ppm'), indoor?.observedAt, indoor?.isOnline !== false);
  put('pm25', 'PM2.5', rounded(indoor?.pm25UgM3, ' µg/m³', 1), indoor?.observedAt, indoor?.isOnline !== false);
  put('wind', 'Wind', rounded(current.windSpeedMph, ' mph'), observedAt, station?.isOnline !== false);
  put('uv', 'UV', rounded(outdoor.uvIndex, '', 1), station?.observedAt, station?.isOnline !== false);
  for (const key of ['sunrise', 'sunset']) {
    put(key, key === 'sunrise' ? 'Sunrise' : 'Sunset', today[key] || null, weather?.fetchedAt, true, 6 * 60 * 60_000);
    values[key].kind = 'solarTime';
    values[key].timeZone = weather?.location?.timezone || null;
  }
  return values;
}

async function loadMetrics(config) {
  const selected = new Set(Object.values(config.overlays).filter((slot) => slot.enabled).flatMap((slot) => slot.lines.map((line) => line.metric)));
  const needsWeather = [...selected].some((key) => !['time', 'date', 'dateTime', 'text', 'alarm'].includes(key));
  const [weather, alarm] = await Promise.all([
    needsWeather ? require('./weatherService').fetchDashboardWeather().catch(() => null) : null,
    selected.has('alarm') ? require('./securityAlarmService').getAlarmStatus().catch(() => null) : null
  ]);
  const stationId = weather?.tempest?.station?.stationId;
  let rain = null;
  if (selected.has('rain24h') && finite(stationId)) {
    const startAt = new Date(Date.now() - 24 * 60 * 60_000);
    const [summary, hasRainReading] = await Promise.all([
      require('./telemetryService').getTempestObservationWindowAggregate(stationId, startAt).catch(() => null),
      require('../models/TempestObservation').exists({
        stationId: Number(stationId), observedAt: { $gte: startAt },
        $or: [
          { 'metrics.rain_mm_last_minute_final': { $type: 'number' } },
          { 'metrics.rain_mm_last_minute': { $type: 'number' } }
        ]
      }).catch(() => null)
    ]);
    // Mongo's $sum yields zero even when every record lacks a rain field.
    // Temperature-only station history therefore cannot imply a dry day.
    rain = hasRainReading ? summary : null;
  }
  return formatMetrics({ weather, alarm, rain });
}

async function getFrame(frameId, includeToken = false) {
  framePath(frameId);
  let query = PhotoFrame.findById(new Types.ObjectId(frameId));
  if (includeToken) query = query.select('+deviceTokenHash');
  const frame = await query;
  if (!frame) throw failure(404, 'Photo frame not found');
  return frame;
}

async function authenticate(frameId, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw failure(401, 'Invalid frame credential');
  const frame = await getFrame(frameId, true);
  if (!frame.deviceTokenHash || !crypto.timingSafeEqual(Buffer.from(hashToken(token), 'hex'), Buffer.from(frame.deviceTokenHash, 'hex'))) throw failure(401, 'Frame credential expired; pair this frame again');
  return frame;
}

async function list() { return (await PhotoFrame.find().sort({ createdAt: 1 })).map(serialize); }
async function create(input) {
  const name = cleanName(input.name, 'HomeBrain photo frame');
  if (name.length > 80) throw invalid('Frame name must be at most 80 characters');
  const room = input.room === '' || input.room === undefined ? '' : cleanName(input.room, '');
  if (room.length > 80) throw invalid('Room must be at most 80 characters');
  return serialize(await PhotoFrame.create({ name, room, config: normalizeConfig(input.config) }));
}
async function update(frameId, input) {
  const frame = await getFrame(frameId);
  if (input.name !== undefined) {
    frame.name = cleanName(input.name, frame.name);
    if (frame.name.length > 80) throw invalid('Frame name must be at most 80 characters');
  }
  if (input.room !== undefined) {
    frame.room = input.room === '' ? '' : cleanName(input.room, frame.room);
    if (frame.room.length > 80) throw invalid('Room must be at most 80 characters');
  }
  if (input.config !== undefined) frame.config = normalizeConfig(input.config);
  await frame.save(); return serialize(frame);
}
async function pair(frameId) {
  const frame = await getFrame(frameId, true);
  const { fingerprint } = await require('./photoFrameUpdateService').publicKey();
  const token = crypto.randomBytes(32).toString('hex');
  frame.deviceTokenHash = hashToken(token);
  await frame.save();
  return { frameId: String(frame._id), token, playerPath: `/api/photo-frames/player/#frame=${frame._id}&token=${token}&key=${fingerprint}` };
}
async function upload(frameId, input) {
  const photo = inspectPhoto(input.data);
  const frame = await getFrame(frameId);
  if (frame.photos.length >= MAX_PHOTOS || frame.photos.reduce((sum, item) => sum + item.bytes, 0) + photo.bytes.length > MAX_LIBRARY_BYTES) throw failure(413, 'This frame’s library is full (500 photos or 1 GB)');
  const id = crypto.randomUUID();
  const name = cleanName(input.name, 'Photo');
  await fs.mkdir(framePath(frameId), { recursive: true, mode: 0o700 });
  await fs.writeFile(framePath(frameId, id), photo.bytes, { flag: 'wx', mode: 0o600 });
  try {
    frame.photos.push({ id, name, contentType: photo.contentType, bytes: photo.bytes.length });
    await frame.save();
  } catch (error) {
    await fs.unlink(framePath(frameId, id)).catch(() => {});
    throw error;
  }
  return serialize(frame);
}
async function removePhoto(frameId, photoId) {
  framePath(frameId, photoId);
  const frame = await getFrame(frameId);
  if (!frame.photos.some((photo) => photo.id === photoId)) throw failure(404, 'Photo not found');
  frame.photos = frame.photos.filter((photo) => photo.id !== photoId);
  await frame.save();
  await fs.unlink(framePath(frameId, photoId)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  return serialize(frame);
}
async function reorder(frameId, ids) {
  const frame = await getFrame(frameId);
  if (!Array.isArray(ids) || ids.length !== frame.photos.length || new Set(ids).size !== ids.length || ids.some((id) => !frame.photos.some((photo) => photo.id === id))) throw invalid('Photo order must include every photo exactly once');
  frame.photos = ids.map((id) => frame.photos.find((photo) => photo.id === id));
  await frame.save(); return serialize(frame);
}
async function readPhoto(frame, photoId) {
  const file = framePath(String(frame._id), photoId);
  const photo = frame.photos.find((item) => item.id === photoId);
  if (!photo) throw failure(404, 'Photo not found');
  try { await fs.access(file); } catch { throw failure(404, 'Photo file not found'); }
  return { file, photo };
}
async function manifest(frame, device = false) {
  if (device) {
    // Heartbeats must not replace a concurrently edited layout or photo library.
    await PhotoFrame.updateOne({ _id: frame._id }, { $set: { lastSeen: new Date() } });
  }
  const result = serialize(frame);
  const values = await loadMetrics(result.config);
  const selected = new Set(Object.values(result.config.overlays).filter((slot) => slot.enabled).flatMap((slot) => slot.lines.map((line) => line.metric)));
  return {
    version: 1, playerVersion: '1.0.0', frameId: result.id, name: result.name,
    width: result.width, height: result.height, config: result.config,
    photos: result.photos.map((photo) => ({ ...photo, url: device ? `/api/photo-frames/${frame._id}/device/photos/${photo.id}` : photo.url })),
    values: Object.fromEntries(Object.entries(values).filter(([key]) => selected.has(key))),
    generatedAt: new Date().toISOString(), pollSeconds: 15
  };
}
async function preview(config) {
  const normalized = normalizeConfig(config);
  return { config: normalized, values: await loadMetrics(normalized), generatedAt: new Date().toISOString() };
}

module.exports = {
  list, create, update, pair, upload, removePhoto, reorder, getFrame, readPhoto,
  authenticate, manifest, preview, serialize,
  catalog: { positions: POSITIONS, metrics: METRICS, defaults: normalizeConfig(), maxPhotoBytes: MAX_PHOTO_BYTES, maxPhotos: MAX_PHOTOS, maxLibraryBytes: MAX_LIBRARY_BYTES },
  __private__: { inspectPhoto, framePath, hashToken, formatMetrics }
};

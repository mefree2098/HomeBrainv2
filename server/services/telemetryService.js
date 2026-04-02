const Device = require('../models/Device');
const DeviceEnergySample = require('../models/DeviceEnergySample');
const TelemetrySample = require('../models/TelemetrySample');
const TempestEvent = require('../models/TempestEvent');
const TempestObservation = require('../models/TempestObservation');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const resourceMonitorService = require('./resourceMonitorService');

const RETENTION_DAYS = Math.max(
  1,
  Number(process.env.HOMEBRAIN_TELEMETRY_RETENTION_DAYS || 365)
);
const DEFAULT_QUERY_HOURS = 24;
const MAX_QUERY_HOURS = 24 * 365;
const DEFAULT_MAX_POINTS = 240;
const MAX_MAX_POINTS = 720;
const MAX_DEFAULT_METRICS = 4;
const METRIC_SCAN_LIMIT = 64;

const METRIC_LABELS = {
  online: 'Online',
  status: 'Status',
  brightness_pct: 'Brightness',
  temperature: 'Temperature',
  target_temperature: 'Target Temperature',
  color_temperature_k: 'Color Temperature',
  power_w: 'Power',
  energy_kwh: 'Energy',
  battery_pct: 'Battery',
  humidity_pct: 'Humidity',
  level_pct: 'Level',
  contact_open: 'Contact Open',
  motion_active: 'Motion',
  occupancy_active: 'Occupancy',
  presence_present: 'Presence',
  locked: 'Locked',
  water_detected: 'Water Detected',
  smoke_detected: 'Smoke Detected',
  carbon_monoxide_detected: 'CO Detected',
  illuminance_lux: 'Illuminance',
  temperature_f: 'Temperature',
  feels_like_f: 'Feels Like',
  dew_point_f: 'Dew Point',
  wind_lull_mph: 'Wind Lull',
  wind_avg_mph: 'Wind Average',
  wind_gust_mph: 'Wind Gust',
  wind_rapid_mph: 'Rapid Wind',
  wind_direction_deg: 'Wind Direction',
  pressure_mb: 'Pressure',
  pressure_inhg: 'Pressure',
  rain_last_minute_in: 'Rain Last Minute',
  rain_today_in: 'Rain Today',
  rain_rate_in_hr: 'Rain Rate',
  uv_index: 'UV Index',
  solar_radiation_wm2: 'Solar Radiation',
  lightning_avg_distance_miles: 'Lightning Distance',
  lightning_count: 'Lightning Count',
  battery_volts: 'Battery Voltage'
};

const FEATURED_METRIC_PRIORITY = [
  'temperature_f',
  'temperature',
  'humidity_pct',
  'pressure_inhg',
  'wind_avg_mph',
  'wind_gust_mph',
  'rain_rate_in_hr',
  'power_w',
  'energy_kwh',
  'battery_pct',
  'brightness_pct',
  'status',
  'online'
];

const INTERESTING_METRIC_PATTERN = /(temp|humid|power|energy|battery|level|speed|volume|pressure|illuminance|lux|uv|rain|motion|contact|occup|presence|lock|water|smoke|carbon|co2|air|heat|cool|fan|setpoint|signal|rssi|volt|current|watt|percent|pct|status|online|active)/i;
const IGNORED_METRIC_PARTS = new Set([
  'id',
  '_id',
  'ids',
  'name',
  'names',
  'label',
  'labels',
  'room',
  'rooms',
  'group',
  'groups',
  'icon',
  'icons',
  'image',
  'images',
  'url',
  'uri',
  'serial',
  'serialnumber',
  'serialnumbers',
  'manufacturer',
  'brand',
  'model',
  'token',
  'secret',
  'password',
  'description',
  'history',
  'raw',
  'html',
  'address',
  'addresses',
  'latitude',
  'longitude',
  'timezone',
  'stationid',
  'deviceid'
]);
const BOOLEAN_STATE_MAP = {
  on: 1,
  off: 0,
  open: 1,
  closed: 0,
  lock: 1,
  locked: 1,
  unlock: 0,
  unlocked: 0,
  active: 1,
  inactive: 0,
  present: 1,
  not_present: 0,
  detected: 1,
  clear: 0,
  wet: 1,
  dry: 0,
  occupied: 1,
  unoccupied: 0,
  online: 1,
  offline: 0,
  cooling: 1,
  heating: 1,
  yes: 1,
  no: 0,
  true: 1,
  false: 0
};
const BINARY_METRIC_PATTERN = /(^|_)(online|status|open|closed|locked|active|detected|present|occupied|water|smoke|carbon|contact|motion|occupancy|presence)($|_)/i;

const TELEMETRY_STORAGE_COLLECTIONS = [
  {
    key: 'telemetry_samples',
    label: 'Unified Telemetry',
    model: TelemetrySample
  },
  {
    key: 'device_energy_samples',
    label: 'Device Energy History',
    model: DeviceEnergySample
  },
  {
    key: 'tempest_observations',
    label: 'Tempest Observations',
    model: TempestObservation
  },
  {
    key: 'tempest_events',
    label: 'Tempest Events',
    model: TempestEvent
  }
];

function clampInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(numeric)));
}

function roundNumber(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const multiplier = 10 ** digits;
  return Math.round(numeric * multiplier) / multiplier;
}

function toNonNegativeInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }

  return Math.round(numeric);
}

function summarizeStorageCollections(collections = []) {
  const safeCollections = Array.isArray(collections) ? collections : [];

  return {
    collectionCount: safeCollections.length,
    totalDocumentCount: safeCollections.reduce((sum, entry) => sum + toNonNegativeInteger(entry.documentCount), 0),
    logicalSizeBytes: safeCollections.reduce((sum, entry) => sum + toNonNegativeInteger(entry.logicalSizeBytes), 0),
    storageSizeBytes: safeCollections.reduce((sum, entry) => sum + toNonNegativeInteger(entry.storageSizeBytes), 0),
    indexSizeBytes: safeCollections.reduce((sum, entry) => sum + toNonNegativeInteger(entry.indexSizeBytes), 0),
    footprintBytes: safeCollections.reduce((sum, entry) => sum + toNonNegativeInteger(entry.footprintBytes), 0),
    collections: safeCollections
  };
}

function normalizeDiskCapacity(disk = {}) {
  const totalBytes = toNonNegativeInteger(disk?.totalBytes);
  const usedBytes = toNonNegativeInteger(disk?.usedBytes);
  const freeBytes = toNonNegativeInteger(disk?.availableBytes);
  const totalGB = Number.isFinite(Number(disk?.totalGB)) ? Number(disk.totalGB) : 0;
  const usedGB = Number.isFinite(Number(disk?.usedGB)) ? Number(disk.usedGB) : 0;
  const freeGB = Number.isFinite(Number(disk?.availableGB)) ? Number(disk.availableGB) : 0;

  return {
    totalBytes,
    usedBytes,
    freeBytes,
    totalGB,
    usedGB,
    freeGB,
    usagePercent: Number.isFinite(Number(disk?.usagePercent)) ? Number(disk.usagePercent) : 0,
    totalLabel: typeof disk?.total === 'string' ? disk.total : '',
    usedLabel: typeof disk?.used === 'string' ? disk.used : '',
    freeLabel: typeof disk?.available === 'string' ? disk.available : '',
    available: totalBytes > 0 || totalGB > 0
  };
}

function parseOptionalDate(value) {
  if (!value) {
    return null;
  }

  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sanitizeMetricPart(part = '') {
  return String(part)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function metricPath(parts = []) {
  return parts
    .map((part) => sanitizeMetricPart(part))
    .filter(Boolean)
    .join('.');
}

function normalizeMetricValue(value) {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const numericValue = Number(trimmed);
  if (Number.isFinite(numericValue)) {
    return numericValue;
  }

  const normalizedState = sanitizeMetricPart(trimmed);
  if (Object.prototype.hasOwnProperty.call(BOOLEAN_STATE_MAP, normalizedState)) {
    return BOOLEAN_STATE_MAP[normalizedState];
  }

  return null;
}

function asPlainMetrics(value) {
  if (!value) {
    return {};
  }

  if (value instanceof Map) {
    return Object.fromEntries(value.entries());
  }

  if (typeof value.toObject === 'function') {
    return value.toObject();
  }

  return typeof value === 'object' ? value : {};
}

function addMetric(metrics, key, value) {
  const normalizedValue = normalizeMetricValue(value);
  if (normalizedValue === null) {
    return;
  }

  const rounded = roundNumber(normalizedValue);
  if (rounded === null) {
    return;
  }

  metrics[key] = rounded;
}

function shouldIgnoreMetricPath(parts = []) {
  if (parts.length === 0) {
    return false;
  }

  const last = sanitizeMetricPart(parts[parts.length - 1]);
  if (!last) {
    return true;
  }

  if (IGNORED_METRIC_PARTS.has(last)) {
    return true;
  }

  if (last.endsWith('timestamp') || last.endsWith('time') || last.endsWith('date')) {
    return true;
  }

  return false;
}

function collectInterestingMetrics(value, parts = [], metrics = {}, depth = 0) {
  if (value == null || depth > 5) {
    return metrics;
  }

  if (value instanceof Date || Array.isArray(value)) {
    return metrics;
  }

  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, child]) => {
      const nextParts = parts.concat(key);
      if (shouldIgnoreMetricPath(nextParts)) {
        return;
      }
      collectInterestingMetrics(child, nextParts, metrics, depth + 1);
    });
    return metrics;
  }

  const numericValue = normalizeMetricValue(value);
  if (numericValue === null) {
    return metrics;
  }

  const key = metricPath(parts);
  if (!key) {
    return metrics;
  }

  const condensedKey = key.replace(/\./g, '_');
  if (!INTERESTING_METRIC_PATTERN.test(condensedKey) && !BINARY_METRIC_PATTERN.test(condensedKey)) {
    return metrics;
  }

  if (!Object.prototype.hasOwnProperty.call(metrics, condensedKey)) {
    addMetric(metrics, condensedKey, numericValue);
  }

  return metrics;
}

function metricsEqual(left, right) {
  const leftMetrics = asPlainMetrics(left);
  const rightMetrics = asPlainMetrics(right);
  const leftKeys = Object.keys(leftMetrics).sort();
  const rightKeys = Object.keys(rightMetrics).sort();

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key, index) => key === rightKeys[index] && leftMetrics[key] === rightMetrics[key]);
}

function inferMetricLabel(key) {
  if (Object.prototype.hasOwnProperty.call(METRIC_LABELS, key)) {
    return METRIC_LABELS[key];
  }

  return key
    .replace(/\./g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b[a-z]/g, (match) => match.toUpperCase())
    .replace(/\bPct\b/g, '%')
    .replace(/\bWm2\b/g, 'W/m²')
    .trim();
}

function inferMetricUnit(key) {
  if (/_pct$/.test(key)) {
    return '%';
  }
  if (/_f$/.test(key)) {
    return '°F';
  }
  if (/_c$/.test(key)) {
    return '°C';
  }
  if (/_mph$/.test(key)) {
    return 'mph';
  }
  if (/_deg$/.test(key)) {
    return '°';
  }
  if (/_inhg$/.test(key)) {
    return 'inHg';
  }
  if (/_mb$/.test(key)) {
    return 'mb';
  }
  if (/_in_hr$/.test(key)) {
    return 'in/hr';
  }
  if (/_in$/.test(key)) {
    return 'in';
  }
  if (/_w$/.test(key)) {
    return 'W';
  }
  if (/_kwh$/.test(key)) {
    return 'kWh';
  }
  if (/_lux$/.test(key)) {
    return 'lux';
  }
  if (/_wm2$/.test(key)) {
    return 'W/m²';
  }
  if (/_volts$/.test(key)) {
    return 'V';
  }
  return '';
}

function isBinaryMetric(key) {
  return BINARY_METRIC_PATTERN.test(key);
}

function metricPriority(key) {
  const featuredIndex = FEATURED_METRIC_PRIORITY.indexOf(key);
  if (featuredIndex >= 0) {
    return featuredIndex;
  }

  if (key.startsWith('smartthings_')) {
    return FEATURED_METRIC_PRIORITY.length + 20;
  }

  if (key.startsWith('property_')) {
    return FEATURED_METRIC_PRIORITY.length + 30;
  }

  return FEATURED_METRIC_PRIORITY.length + 10;
}

function buildMetricDescriptors(keys = []) {
  return Array.from(new Set(keys.filter(Boolean)))
    .sort((left, right) => {
      const priorityDiff = metricPriority(left) - metricPriority(right);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return inferMetricLabel(left).localeCompare(inferMetricLabel(right));
    })
    .map((key) => ({
      key,
      label: inferMetricLabel(key),
      unit: inferMetricUnit(key),
      binary: isBinaryMetric(key)
    }));
}

function pickFeaturedMetricKeys(descriptors = [], limit = MAX_DEFAULT_METRICS) {
  return descriptors
    .slice(0, limit)
    .map((descriptor) => descriptor.key);
}

function downsamplePoints(points = [], maxPoints = DEFAULT_MAX_POINTS) {
  if (points.length <= maxPoints) {
    return points;
  }

  const sampled = [];
  const lastIndex = points.length - 1;
  const interiorSlots = Math.max(0, maxPoints - 2);

  sampled.push(points[0]);

  if (interiorSlots > 0) {
    for (let index = 1; index <= interiorSlots; index += 1) {
      const ratio = index / (interiorSlots + 1);
      const pointIndex = Math.min(lastIndex - 1, Math.max(1, Math.round(ratio * lastIndex)));
      const point = points[pointIndex];
      if (!point) {
        continue;
      }

      if (sampled[sampled.length - 1]?.observedAt !== point.observedAt) {
        sampled.push(point);
      }
    }
  }

  const lastPoint = points[lastIndex];
  if (sampled[sampled.length - 1]?.observedAt !== lastPoint?.observedAt) {
    sampled.push(lastPoint);
  }

  return sampled;
}

function mergePointsByTimestamp(points = []) {
  const merged = [];

  points.forEach((point) => {
    if (!point?.observedAt) {
      return;
    }

    const previous = merged[merged.length - 1];
    if (previous && previous.observedAt === point.observedAt) {
      previous.values = {
        ...previous.values,
        ...point.values
      };
      return;
    }

    merged.push({
      observedAt: point.observedAt,
      values: { ...point.values }
    });
  });

  return merged;
}

function buildMetricStats(points = [], metricKeys = []) {
  return metricKeys.map((key) => {
    const values = points
      .map((point) => point?.values?.[key])
      .filter((value) => typeof value === 'number' && Number.isFinite(value));

    const latest = values.length > 0 ? values[values.length - 1] : null;
    const min = values.length > 0 ? Math.min(...values) : null;
    const max = values.length > 0 ? Math.max(...values) : null;
    const average = values.length > 0
      ? roundNumber(values.reduce((sum, value) => sum + value, 0) / values.length, 3)
      : null;

    return {
      key,
      latest,
      min,
      max,
      average
    };
  });
}

function normalizeMetricKeyList(input) {
  const values = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : [];

  return Array.from(new Set(values
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function extractDeviceMetrics(device = {}) {
  const metrics = {};
  const properties = device?.properties && typeof device.properties === 'object'
    ? device.properties
    : {};

  addMetric(metrics, 'online', device.isOnline);
  addMetric(metrics, 'status', device.status);
  addMetric(metrics, 'brightness_pct', device.brightness);
  addMetric(metrics, 'temperature', device.temperature);
  addMetric(metrics, 'target_temperature', device.targetTemperature);
  addMetric(metrics, 'color_temperature_k', device.colorTemperature);

  const smartThingsValues = properties.smartThingsAttributeValues || properties.smartthingsAttributeValues || {};
  addMetric(metrics, 'power_w', smartThingsValues?.powerMeter?.power);
  addMetric(metrics, 'energy_kwh', smartThingsValues?.energyMeter?.energy);
  addMetric(metrics, 'battery_pct', smartThingsValues?.battery?.battery);
  addMetric(metrics, 'humidity_pct', smartThingsValues?.relativeHumidityMeasurement?.humidity);
  addMetric(metrics, 'level_pct', smartThingsValues?.switchLevel?.level);
  addMetric(metrics, 'illuminance_lux', smartThingsValues?.illuminanceMeasurement?.illuminance);
  addMetric(metrics, 'contact_open', smartThingsValues?.contactSensor?.contact);
  addMetric(metrics, 'motion_active', smartThingsValues?.motionSensor?.motion);
  addMetric(metrics, 'occupancy_active', smartThingsValues?.occupancySensor?.occupancy);
  addMetric(metrics, 'presence_present', smartThingsValues?.presenceSensor?.presence);
  addMetric(metrics, 'locked', smartThingsValues?.lock?.lock);
  addMetric(metrics, 'water_detected', smartThingsValues?.waterSensor?.water);
  addMetric(metrics, 'smoke_detected', smartThingsValues?.smokeDetector?.smoke);
  addMetric(metrics, 'carbon_monoxide_detected', smartThingsValues?.carbonMonoxideDetector?.carbonMonoxide);

  collectInterestingMetrics(properties, [], metrics);

  return metrics;
}

function extractTempestMetrics(observation = {}) {
  if (observation?.observationType === 'rapid_wind') {
    return {};
  }

  const display = observation?.display && typeof observation.display === 'object'
    ? observation.display
    : {};
  const metrics = {};

  addMetric(metrics, 'temperature_f', display.temperatureF);
  addMetric(metrics, 'feels_like_f', display.feelsLikeF);
  addMetric(metrics, 'dew_point_f', display.dewPointF);
  addMetric(metrics, 'humidity_pct', display.humidityPct);
  addMetric(metrics, 'wind_lull_mph', display.windLullMph);
  addMetric(metrics, 'wind_avg_mph', display.windAvgMph);
  addMetric(metrics, 'wind_gust_mph', display.windGustMph);
  addMetric(metrics, 'wind_rapid_mph', display.windRapidMph);
  addMetric(metrics, 'wind_direction_deg', display.windDirectionDeg);
  addMetric(metrics, 'pressure_mb', display.pressureMb);
  addMetric(metrics, 'pressure_inhg', display.pressureInHg);
  addMetric(metrics, 'rain_last_minute_in', display.rainLastMinuteIn);
  addMetric(metrics, 'rain_today_in', display.rainTodayIn);
  addMetric(metrics, 'rain_rate_in_hr', display.rainRateInPerHr);
  addMetric(metrics, 'illuminance_lux', display.illuminanceLux);
  addMetric(metrics, 'uv_index', display.uvIndex);
  addMetric(metrics, 'solar_radiation_wm2', display.solarRadiationWm2);
  addMetric(metrics, 'lightning_avg_distance_miles', display.lightningAvgDistanceMiles);
  addMetric(metrics, 'lightning_count', display.lightningCount);
  addMetric(metrics, 'battery_volts', display.batteryVolts);

  return metrics;
}

class TelemetryService {
  constructor() {
    this.initialized = false;
    this.handleDeviceUpdates = this.handleDeviceUpdates.bind(this);
  }

  initialize() {
    if (this.initialized) {
      return;
    }

    deviceUpdateEmitter.on('devices:update', this.handleDeviceUpdates);
    this.initialized = true;
  }

  shutdown() {
    if (!this.initialized) {
      return;
    }

    deviceUpdateEmitter.removeListener('devices:update', this.handleDeviceUpdates);
    this.initialized = false;
  }

  handleDeviceUpdates(devices = []) {
    void this.recordDeviceSnapshots(devices).catch((error) => {
      console.warn(`TelemetryService: failed to record device telemetry: ${error.message}`);
    });
  }

  async recordDeviceSnapshots(devices = []) {
    if (!Array.isArray(devices)) {
      return { insertedCount: 0, skippedCount: 0 };
    }

    const dedupedDevices = new Map();
    devices.forEach((device) => {
      const deviceId = String(device?._id || device?.id || '').trim();
      if (!deviceId) {
        return;
      }
      dedupedDevices.set(deviceId, device);
    });

    const results = await Promise.allSettled(
      Array.from(dedupedDevices.values()).map((device) => this.recordDeviceSnapshot(device))
    );

    return results.reduce((summary, result) => {
      if (result.status === 'fulfilled' && result.value?.inserted) {
        summary.insertedCount += 1;
      } else {
        summary.skippedCount += 1;
      }
      return summary;
    }, { insertedCount: 0, skippedCount: 0 });
  }

  async recordDeviceSnapshot(device = {}) {
    const sourceId = String(device?._id || device?.id || '').trim();
    const sourceOrigin = String(device?.properties?.source || '').trim().toLowerCase();

    if (!sourceId || sourceOrigin === 'tempest') {
      return { inserted: false, skipped: true };
    }

    const metrics = extractDeviceMetrics(device);
    if (Object.keys(metrics).length === 0) {
      return { inserted: false, skipped: true };
    }

    const recordedAt = parseOptionalDate(device?.lastSeen) || new Date();
    const payload = {
      sourceType: 'device',
      sourceId,
      sourceKey: `device:${sourceId}`,
      sourceName: String(device?.name || '').trim(),
      sourceCategory: String(device?.type || '').trim(),
      sourceRoom: String(device?.room || '').trim(),
      sourceOrigin,
      streamType: 'device_state',
      metricKeys: Object.keys(metrics).sort(),
      metrics,
      metadata: {
        hasProperties: device?.properties && typeof device.properties === 'object',
        sourceOrigin
      },
      recordedAt,
      createdAt: new Date()
    };

    const latestSample = await TelemetrySample.findOne({
      sourceKey: payload.sourceKey,
      streamType: payload.streamType
    })
      .sort({ recordedAt: -1 })
      .select('metrics sourceName sourceCategory sourceRoom sourceOrigin');

    if (latestSample && metricsEqual(latestSample.metrics, payload.metrics)) {
      const metadataUpdates = {};

      if (latestSample.sourceName !== payload.sourceName) {
        metadataUpdates.sourceName = payload.sourceName;
      }
      if (latestSample.sourceCategory !== payload.sourceCategory) {
        metadataUpdates.sourceCategory = payload.sourceCategory;
      }
      if (latestSample.sourceRoom !== payload.sourceRoom) {
        metadataUpdates.sourceRoom = payload.sourceRoom;
      }
      if (latestSample.sourceOrigin !== payload.sourceOrigin) {
        metadataUpdates.sourceOrigin = payload.sourceOrigin;
      }

      if (Object.keys(metadataUpdates).length > 0) {
        await TelemetrySample.updateOne(
          { _id: latestSample._id },
          { $set: metadataUpdates }
        );
      }

      return { inserted: false, skipped: true };
    }

    await TelemetrySample.create(payload);
    return { inserted: true };
  }

  async recordTempestObservation(device = {}, observation = {}) {
    const sourceId = String(device?._id || device?.id || '').trim();
    if (!sourceId || observation?.observationType === 'rapid_wind') {
      return { inserted: false, skipped: true };
    }

    const metrics = extractTempestMetrics(observation);
    if (Object.keys(metrics).length === 0) {
      return { inserted: false, skipped: true };
    }

    const recordedAt = parseOptionalDate(observation?.observedAt);
    if (!recordedAt) {
      return { inserted: false, skipped: true };
    }

    await TelemetrySample.updateOne(
      {
        sourceKey: `tempest_station:${sourceId}`,
        streamType: 'tempest_observation',
        recordedAt,
        'metadata.observationType': String(observation?.observationType || '')
      },
      {
        $setOnInsert: {
          sourceType: 'tempest_station',
          sourceId,
          sourceKey: `tempest_station:${sourceId}`,
          sourceName: String(device?.name || observation?.stationName || '').trim(),
          sourceCategory: 'weather_station',
          sourceRoom: String(device?.room || '').trim(),
          sourceOrigin: 'tempest',
          streamType: 'tempest_observation',
          metricKeys: Object.keys(metrics).sort(),
          metrics,
          metadata: {
            stationId: observation?.stationId ?? null,
            deviceId: observation?.deviceId ?? null,
            observationType: String(observation?.observationType || ''),
            source: String(observation?.source || ''),
            stationName: String(observation?.stationName || '')
          },
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    return { inserted: true };
  }

  async buildSourceSummaryFromLatest(entry) {
    const latestSample = entry?.lastSample;
    if (!latestSample?.sourceKey) {
      return null;
    }

    const metricHistory = await TelemetrySample.find({ sourceKey: latestSample.sourceKey })
      .sort({ recordedAt: -1 })
      .limit(METRIC_SCAN_LIMIT)
      .select('metricKeys')
      .lean();
    const metricKeySet = new Set(
      metricHistory.flatMap((sample) => Array.isArray(sample.metricKeys) ? sample.metricKeys : [])
    );
    const descriptors = buildMetricDescriptors(Array.from(metricKeySet));
    const featuredMetricKeys = pickFeaturedMetricKeys(descriptors);
    const metrics = asPlainMetrics(latestSample.metrics);
    const lastValues = {};
    descriptors.forEach((descriptor) => {
      lastValues[descriptor.key] = typeof metrics[descriptor.key] === 'number'
        ? metrics[descriptor.key]
        : null;
    });

    return {
      sourceKey: latestSample.sourceKey,
      sourceType: latestSample.sourceType,
      sourceId: latestSample.sourceId,
      name: latestSample.sourceName || 'Unnamed Source',
      category: latestSample.sourceCategory || '',
      room: latestSample.sourceRoom || '',
      origin: latestSample.sourceOrigin || '',
      streamType: latestSample.streamType,
      sampleCount: Number(entry.sampleCount || 0),
      metricCount: descriptors.length,
      lastSampleAt: latestSample.recordedAt,
      availableMetrics: descriptors,
      featuredMetricKeys,
      lastValues
    };
  }

  async getCollectionStorageStats({ key, label, model }) {
    const collectionName = model?.collection?.collectionName || '';

    const fallback = {
      key,
      label,
      collectionName,
      documentCount: 0,
      logicalSizeBytes: 0,
      storageSizeBytes: 0,
      indexSizeBytes: 0,
      footprintBytes: 0,
      averageDocumentBytes: 0,
      available: true
    };

    if (!collectionName || !model?.db?.db?.command) {
      return {
        ...fallback,
        available: false,
        error: 'Collection stats unavailable'
      };
    }

    try {
      const stats = await model.db.db.command({ collStats: collectionName, scale: 1 });
      const documentCount = toNonNegativeInteger(stats?.count);
      const logicalSizeBytes = toNonNegativeInteger(stats?.size);
      const storageSizeBytes = toNonNegativeInteger(stats?.storageSize);
      const indexSizeBytes = toNonNegativeInteger(stats?.totalIndexSize);
      const footprintBytes = storageSizeBytes + indexSizeBytes;

      return {
        key,
        label,
        collectionName,
        documentCount,
        logicalSizeBytes,
        storageSizeBytes,
        indexSizeBytes,
        footprintBytes,
        averageDocumentBytes: toNonNegativeInteger(stats?.avgObjSize),
        available: true
      };
    } catch (error) {
      const message = String(error?.message || '');
      if (error?.codeName === 'NamespaceNotFound' || /namespace.*not found/i.test(message) || /ns not found/i.test(message)) {
        return fallback;
      }

      return {
        ...fallback,
        available: false,
        error: message || 'Collection stats unavailable'
      };
    }
  }

  async getStorageFootprint() {
    const collections = await Promise.all(
      TELEMETRY_STORAGE_COLLECTIONS.map((entry) => this.getCollectionStorageStats(entry))
    );

    return summarizeStorageCollections(
      collections.sort((left, right) => right.footprintBytes - left.footprintBytes)
    );
  }

  async getOverview() {
    const [totalSamples, lastSample, streamBreakdown, sourceTypeBreakdown, latestBySource, storage, disk] = await Promise.all([
      TelemetrySample.countDocuments({}),
      TelemetrySample.findOne({}).sort({ recordedAt: -1 }).select('recordedAt').lean(),
      TelemetrySample.aggregate([
        { $group: { _id: '$streamType', count: { $sum: 1 } } }
      ]),
      TelemetrySample.aggregate([
        { $group: { _id: '$sourceType', count: { $sum: 1 } } }
      ]),
      TelemetrySample.aggregate([
        { $sort: { recordedAt: -1 } },
        {
          $group: {
            _id: '$sourceKey',
            sampleCount: { $sum: 1 },
            lastSample: { $first: '$$ROOT' }
          }
        },
        { $sort: { 'lastSample.recordedAt': -1 } }
      ]),
      this.getStorageFootprint(),
      resourceMonitorService.getDiskUsage()
    ]);

    const sources = (await Promise.all(
      latestBySource.map((entry) => this.buildSourceSummaryFromLatest(entry))
    ))
      .filter(Boolean);

    return {
      retentionDays: RETENTION_DAYS,
      totalSamples,
      sourceCount: sources.length,
      lastSampleAt: lastSample?.recordedAt || null,
      streamCounts: streamBreakdown.reduce((acc, entry) => {
        if (entry?._id) {
          acc[entry._id] = Number(entry.count || 0);
        }
        return acc;
      }, {}),
      sourceTypeCounts: sourceTypeBreakdown.reduce((acc, entry) => {
        if (entry?._id) {
          acc[entry._id] = Number(entry.count || 0);
        }
        return acc;
      }, {}),
      storage,
      disk: normalizeDiskCapacity(disk),
      sources
    };
  }

  async resolveSourceSummary({ sourceKey, sourceType, sourceId } = {}) {
    const resolvedSourceKey = sourceKey
      || (sourceType && sourceId ? `${sourceType}:${sourceId}` : '');

    if (!resolvedSourceKey) {
      throw new Error('A telemetry source is required.');
    }

    const latestEntry = await TelemetrySample.aggregate([
      { $match: { sourceKey: resolvedSourceKey } },
      { $sort: { recordedAt: -1 } },
      {
        $group: {
          _id: '$sourceKey',
          sampleCount: { $sum: 1 },
          lastSample: { $first: '$$ROOT' }
        }
      }
    ]);

    if (!latestEntry[0]) {
      throw new Error('Telemetry source not found');
    }

    const summary = await this.buildSourceSummaryFromLatest(latestEntry[0]);
    if (!summary) {
      throw new Error('Telemetry source not found');
    }

    return summary;
  }

  async getSeries(options = {}) {
    const source = await this.resolveSourceSummary(options);
    const hours = clampInteger(options.hours, DEFAULT_QUERY_HOURS, 1, MAX_QUERY_HOURS);
    const maxPoints = clampInteger(options.maxPoints, DEFAULT_MAX_POINTS, 30, MAX_MAX_POINTS);
    const requestedMetricKeys = normalizeMetricKeyList(options.metricKeys);
    const availableMetricSet = new Set(source.availableMetrics.map((descriptor) => descriptor.key));
    const selectedMetricKeys = requestedMetricKeys.length > 0
      ? requestedMetricKeys.filter((key) => availableMetricSet.has(key))
      : source.featuredMetricKeys;
    const effectiveMetricKeys = selectedMetricKeys.length > 0
      ? selectedMetricKeys
      : source.availableMetrics.slice(0, MAX_DEFAULT_METRICS).map((descriptor) => descriptor.key);

    const startAt = new Date(Date.now() - hours * 60 * 60 * 1000);
    const samples = await TelemetrySample.find({
      sourceKey: source.sourceKey,
      recordedAt: { $gte: startAt }
    })
      .sort({ recordedAt: 1 })
      .select('recordedAt metrics')
      .lean();

    const mergedPoints = mergePointsByTimestamp(
      samples.map((sample) => {
        const metrics = asPlainMetrics(sample.metrics);
        const values = {};

        effectiveMetricKeys.forEach((key) => {
          values[key] = typeof metrics[key] === 'number' ? metrics[key] : null;
        });

        return {
          observedAt: sample.recordedAt instanceof Date
            ? sample.recordedAt.toISOString()
            : new Date(sample.recordedAt).toISOString(),
          values
        };
      })
    );
    const points = downsamplePoints(mergedPoints, maxPoints);

    return {
      source,
      metrics: source.availableMetrics.filter((descriptor) => effectiveMetricKeys.includes(descriptor.key)),
      range: {
        hours,
        startAt,
        endAt: new Date(),
        rawPointCount: mergedPoints.length,
        pointCount: points.length,
        maxPoints
      },
      points,
      stats: buildMetricStats(points, effectiveMetricKeys)
    };
  }

  async clearData({ sourceKey, sourceType, sourceId } = {}) {
    const resolvedSourceKey = sourceKey
      || (sourceType && sourceId ? `${sourceType}:${sourceId}` : '');

    if (!resolvedSourceKey) {
      const [telemetryResult, energyResult, tempestObservationResult, tempestEventResult] = await Promise.all([
        TelemetrySample.deleteMany({}),
        DeviceEnergySample.deleteMany({}),
        TempestObservation.deleteMany({}),
        TempestEvent.deleteMany({})
      ]);

      return {
        scope: 'all',
        telemetryDeleted: telemetryResult.deletedCount || 0,
        energyDeleted: energyResult.deletedCount || 0,
        tempestObservationsDeleted: tempestObservationResult.deletedCount || 0,
        tempestEventsDeleted: tempestEventResult.deletedCount || 0
      };
    }

    const summary = await this.resolveSourceSummary({ sourceKey: resolvedSourceKey });
    const telemetryResult = await TelemetrySample.deleteMany({ sourceKey: summary.sourceKey });

    let energyDeleted = 0;
    let tempestObservationsDeleted = 0;
    let tempestEventsDeleted = 0;

    if (summary.sourceType === 'device') {
      const energyResult = await DeviceEnergySample.deleteMany({ deviceId: summary.sourceId });
      energyDeleted = energyResult.deletedCount || 0;
    }

    if (summary.sourceType === 'tempest_station') {
      const stationDevice = await Device.findById(summary.sourceId).lean();
      const stationId = stationDevice?.properties?.tempest?.stationId;

      if (stationId != null) {
        const [observationResult, eventResult] = await Promise.all([
          TempestObservation.deleteMany({ stationId }),
          TempestEvent.deleteMany({ stationId })
        ]);
        tempestObservationsDeleted = observationResult.deletedCount || 0;
        tempestEventsDeleted = eventResult.deletedCount || 0;
      }
    }

    return {
      scope: summary.sourceKey,
      telemetryDeleted: telemetryResult.deletedCount || 0,
      energyDeleted,
      tempestObservationsDeleted,
      tempestEventsDeleted
    };
  }
}

const telemetryService = new TelemetryService();

module.exports = telemetryService;
module.exports.TelemetryService = TelemetryService;
module.exports.__private__ = {
  buildMetricDescriptors,
  buildMetricStats,
  downsamplePoints,
  extractDeviceMetrics,
  extractTempestMetrics,
  inferMetricLabel,
  inferMetricUnit,
  isBinaryMetric,
  mergePointsByTimestamp,
  normalizeDiskCapacity,
  pickFeaturedMetricKeys,
  summarizeStorageCollections
};

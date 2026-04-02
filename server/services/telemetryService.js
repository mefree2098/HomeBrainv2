const Device = require('../models/Device');
const DeviceEnergySample = require('../models/DeviceEnergySample');
const TelemetrySample = require('../models/TelemetrySample');
const TempestEvent = require('../models/TempestEvent');
const TempestObservation = require('../models/TempestObservation');
const { sendLLMRequestWithFallback } = require('./llmService');
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
const TIMELINE_EVENT_LIMIT = 120;
const TEMPEST_MODULE_WINDOWS = [
  { key: 'day', label: 'Last 24 Hours', hours: 24 },
  { key: 'week', label: 'Last 7 Days', hours: 24 * 7 },
  { key: 'month', label: 'Last 30 Days', hours: 24 * 30 },
  { key: 'year', label: 'Last 12 Months', hours: 24 * 365 }
];
const DEFAULT_CHART_BUILDER_HOURS = 24 * 7;
const CHART_BUILDER_SOURCE_LIMIT = 18;
const SUPPORTED_CHART_TYPES = new Set(['area', 'line']);

const METRIC_LABELS = {
  online: 'Online',
  status: 'Status',
  websocket_connected: 'Websocket Connected',
  udp_listening: 'UDP Listening',
  signal_rssi_dbm: 'Signal RSSI',
  hub_rssi_dbm: 'Hub RSSI',
  sensor_fault_count: 'Sensor Fault Count',
  brightness_pct: 'Brightness',
  temperature: 'Temperature',
  target_temperature: 'Target Temperature',
  color_temperature_k: 'Color Temperature',
  power_w: 'Power',
  energy_kwh: 'Energy',
  battery_pct: 'Battery',
  humidity_pct: 'Humidity',
  level_pct: 'Level',
  running: 'Running',
  completed: 'Completed',
  execution_started: 'Execution Started',
  execution_completed: 'Execution Completed',
  execution_succeeded: 'Execution Succeeded',
  execution_partial: 'Execution Partial',
  execution_failed: 'Execution Failed',
  execution_cancelled: 'Execution Cancelled',
  total_actions: 'Total Actions',
  successful_actions: 'Successful Actions',
  failed_actions: 'Failed Actions',
  duration_ms: 'Duration',
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
  'execution_failed',
  'execution_succeeded',
  'duration_ms',
  'failed_actions',
  'successful_actions',
  'total_actions',
  'pressure_inhg',
  'wind_avg_mph',
  'wind_gust_mph',
  'rain_rate_in_hr',
  'rain_today_in',
  'lightning_count',
  'signal_rssi_dbm',
  'power_w',
  'energy_kwh',
  'battery_pct',
  'battery_volts',
  'brightness_pct',
  'status',
  'online',
  'websocket_connected'
];

const INTERESTING_METRIC_PATTERN = /(temp|humid|power|energy|battery|level|speed|volume|pressure|illuminance|lux|uv|rain|motion|contact|occup|presence|lock|water|smoke|carbon|co2|air|heat|cool|fan|setpoint|signal|rssi|volt|current|watt|percent|pct|status|online|active|execution|success|fail|duration|action)/i;
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
const BINARY_METRIC_PATTERN = /(^|_)(online|status|open|closed|locked|active|detected|present|occupied|water|smoke|carbon|contact|motion|occupancy|presence|connected|listening)($|_)/i;
const TIMELINE_PRIORITY_KEYS = new Set([
  'status',
  'online',
  'locked',
  'contact_open',
  'motion_active',
  'occupancy_active',
  'presence_present',
  'water_detected',
  'smoke_detected',
  'carbon_monoxide_detected',
  'websocket_connected',
  'udp_listening'
]);

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
    filesystem: typeof disk?.filesystem === 'string' ? disk.filesystem : '',
    mountedOn: typeof disk?.mountedOn === 'string' ? disk.mountedOn : '',
    targetPath: typeof disk?.targetPath === 'string' ? disk.targetPath : '',
    available: totalBytes > 0 || totalGB > 0
  };
}

function celsiusToFahrenheit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return roundNumber((numeric * 9) / 5 + 32, 1);
}

function metersPerSecondToMph(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return roundNumber(numeric * 2.2369362921, 1);
}

function millimetersToInches(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return roundNumber(numeric / 25.4, 3);
}

function millibarsToInHg(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return roundNumber(numeric * 0.0295299831, 2);
}

function toCompassDirection(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '';
  }

  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round(numeric / 45) % directions.length];
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
  if (/_ms$/.test(key)) {
    return 'ms';
  }
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
  if (/_dbm$/.test(key)) {
    return 'dBm';
  }
  if (/_volts$/.test(key)) {
    return 'V';
  }
  return '';
}

function formatBinaryMetricState(key, value) {
  if (value == null) {
    return '--';
  }

  const active = Number(value) >= 0.5;

  switch (key) {
    case 'online':
      return active ? 'Online' : 'Offline';
    case 'locked':
      return active ? 'Locked' : 'Unlocked';
    case 'contact_open':
      return active ? 'Open' : 'Closed';
    case 'motion_active':
      return active ? 'Motion' : 'Idle';
    case 'occupancy_active':
      return active ? 'Occupied' : 'Clear';
    case 'presence_present':
      return active ? 'Present' : 'Away';
    case 'water_detected':
      return active ? 'Wet' : 'Dry';
    case 'websocket_connected':
      return active ? 'Connected' : 'Disconnected';
    case 'udp_listening':
      return active ? 'Listening' : 'Not Listening';
    default:
      return active ? 'On' : 'Off';
  }
}

function formatMetricChangeValue(metricKey, value) {
  if (value == null) {
    return '--';
  }

  if (isBinaryMetric(metricKey)) {
    return formatBinaryMetricState(metricKey, value);
  }

  const unit = inferMetricUnit(metricKey);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '--';
  }

  const digits = Math.abs(numeric) >= 100 ? 0 : Math.abs(numeric) >= 10 ? 1 : 2;
  const formatted = numeric.toLocaleString([], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
  return unit ? `${formatted} ${unit}` : formatted;
}

function describeTimelineEvent(metricKey, previousValue, nextValue) {
  if (nextValue == null) {
    return `${inferMetricLabel(metricKey)} updated`;
  }

  if (metricKey === 'status') {
    return Number(nextValue) >= 0.5 ? 'Turned On' : 'Turned Off';
  }
  if (metricKey === 'online') {
    return Number(nextValue) >= 0.5 ? 'Came Online' : 'Went Offline';
  }
  if (metricKey === 'locked') {
    return Number(nextValue) >= 0.5 ? 'Locked' : 'Unlocked';
  }
  if (metricKey === 'contact_open') {
    return Number(nextValue) >= 0.5 ? 'Contact Opened' : 'Contact Closed';
  }
  if (metricKey === 'motion_active') {
    return Number(nextValue) >= 0.5 ? 'Motion Detected' : 'Motion Cleared';
  }
  if (metricKey === 'presence_present') {
    return Number(nextValue) >= 0.5 ? 'Presence Detected' : 'Presence Cleared';
  }
  if (metricKey === 'water_detected') {
    return Number(nextValue) >= 0.5 ? 'Water Detected' : 'Water Cleared';
  }
  if (metricKey === 'websocket_connected') {
    return Number(nextValue) >= 0.5 ? 'Websocket Connected' : 'Websocket Disconnected';
  }
  if (metricKey === 'udp_listening') {
    return Number(nextValue) >= 0.5 ? 'UDP Listener Active' : 'UDP Listener Inactive';
  }

  const label = inferMetricLabel(metricKey);
  if (previousValue == null) {
    return `${label} recorded at ${formatMetricChangeValue(metricKey, nextValue)}`;
  }

  return `${label} changed from ${formatMetricChangeValue(metricKey, previousValue)} to ${formatMetricChangeValue(metricKey, nextValue)}`;
}

function timelineMetricPriority(key) {
  if (TIMELINE_PRIORITY_KEYS.has(key)) {
    return 0;
  }

  const priority = FEATURED_METRIC_PRIORITY.indexOf(key);
  if (priority >= 0) {
    return priority + 10;
  }

  return 100;
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
  const sourceOrigin = String(properties.source || '').trim().toLowerCase();

  addMetric(metrics, 'online', device.isOnline);
  addMetric(metrics, 'status', device.status);

  if (sourceOrigin === 'tempest') {
    const tempest = properties.tempest && typeof properties.tempest === 'object'
      ? properties.tempest
      : {};
    const health = tempest.health && typeof tempest.health === 'object'
      ? tempest.health
      : {};
    const display = tempest.display && typeof tempest.display === 'object'
      ? tempest.display
      : {};

    addMetric(metrics, 'signal_rssi_dbm', health.rssi);
    addMetric(metrics, 'hub_rssi_dbm', health.hubRssi);
    addMetric(metrics, 'websocket_connected', health.websocketConnected);
    addMetric(metrics, 'udp_listening', health.udpListening);
    addMetric(metrics, 'sensor_fault_count', Array.isArray(health.sensorStatusFlags) ? health.sensorStatusFlags.length : null);
    addMetric(metrics, 'battery_volts', display.batteryVolts);

    return metrics;
  }

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

function buildWorkflowExecutionMetrics({
  status = 'running',
  phase = 'started',
  totalActions = 0,
  successfulActions = 0,
  failedActions = 0,
  durationMs = null
} = {}) {
  const normalizedStatus = String(status || 'running').trim() || 'running';
  const normalizedPhase = String(phase || 'started').trim() === 'completed' ? 'completed' : 'started';
  const metrics = {};

  addMetric(metrics, 'running', normalizedStatus === 'running' ? 1 : 0);
  addMetric(metrics, 'completed', normalizedPhase === 'completed' ? 1 : 0);
  addMetric(metrics, 'execution_started', normalizedPhase === 'started' ? 1 : 0);
  addMetric(metrics, 'execution_completed', normalizedPhase === 'completed' ? 1 : 0);
  addMetric(metrics, 'execution_succeeded', normalizedStatus === 'success' ? 1 : 0);
  addMetric(metrics, 'execution_partial', normalizedStatus === 'partial_success' ? 1 : 0);
  addMetric(metrics, 'execution_failed', normalizedStatus === 'failed' ? 1 : 0);
  addMetric(metrics, 'execution_cancelled', normalizedStatus === 'cancelled' ? 1 : 0);
  addMetric(metrics, 'total_actions', totalActions);
  addMetric(metrics, 'successful_actions', successfulActions);
  addMetric(metrics, 'failed_actions', failedActions);
  addMetric(metrics, 'duration_ms', durationMs);

  return metrics;
}

function buildSourceTimelineEvents(samples = [], descriptors = []) {
  const descriptorMap = new Map((Array.isArray(descriptors) ? descriptors : []).map((descriptor) => [descriptor.key, descriptor]));
  const events = [];
  let previousMetrics = null;

  samples.forEach((sample) => {
    const metrics = asPlainMetrics(sample?.metrics);
    const observedAt = sample?.recordedAt instanceof Date
      ? sample.recordedAt.toISOString()
      : parseOptionalDate(sample?.recordedAt)?.toISOString?.() || null;

    if (!observedAt) {
      previousMetrics = metrics;
      return;
    }

    if (!previousMetrics) {
      previousMetrics = metrics;
      return;
    }

    const changedKeys = Array.from(new Set([
      ...Object.keys(previousMetrics),
      ...Object.keys(metrics)
    ]))
      .filter((key) => previousMetrics[key] !== metrics[key])
      .filter((key) => {
        const descriptor = descriptorMap.get(key);
        if (descriptor?.binary) {
          return true;
        }
        return TIMELINE_PRIORITY_KEYS.has(key);
      })
      .sort((left, right) => timelineMetricPriority(left) - timelineMetricPriority(right));

    changedKeys.forEach((key) => {
      const descriptor = descriptorMap.get(key) || {
        key,
        label: inferMetricLabel(key),
        unit: inferMetricUnit(key),
        binary: isBinaryMetric(key)
      };
      const previousValue = typeof previousMetrics[key] === 'number' ? previousMetrics[key] : null;
      const nextValue = typeof metrics[key] === 'number' ? metrics[key] : null;

      events.push({
        id: `${observedAt}:${key}`,
        observedAt,
        key,
        label: descriptor.label,
        unit: descriptor.unit,
        binary: descriptor.binary,
        previousValue,
        nextValue,
        summary: describeTimelineEvent(key, previousValue, nextValue)
      });
    });

    previousMetrics = metrics;
  });

  return events
    .sort((left, right) => new Date(right.observedAt).getTime() - new Date(left.observedAt).getTime())
    .slice(0, TIMELINE_EVENT_LIMIT);
}

function normalizePromptText(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function extractPromptKeywords(value) {
  return Array.from(new Set(
    normalizePromptText(value)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3)
  ));
}

function inferRequestedHoursFromPrompt(prompt) {
  const text = normalizePromptText(prompt);
  const directMatch = text.match(/(\d+)\s*(hour|hours|hr|hrs|day|days|week|weeks|month|months|year|years)\b/);

  if (directMatch) {
    const count = clampInteger(directMatch[1], DEFAULT_CHART_BUILDER_HOURS, 1, MAX_QUERY_HOURS);
    const unit = directMatch[2];

    if (/hour|hr/.test(unit)) {
      return count;
    }
    if (/day/.test(unit)) {
      return count * 24;
    }
    if (/week/.test(unit)) {
      return count * 24 * 7;
    }
    if (/month/.test(unit)) {
      return count * 24 * 30;
    }
    if (/year/.test(unit)) {
      return count * 24 * 365;
    }
  }

  if (/\b24h\b|\blast 24\b|\btoday\b|\bdaily\b/.test(text)) {
    return 24;
  }
  if (/\b7d\b|\bweekly\b|\blast week\b/.test(text)) {
    return 24 * 7;
  }
  if (/\b30d\b|\bmonthly\b|\blast month\b/.test(text)) {
    return 24 * 30;
  }
  if (/\b90d\b|\bquarter\b/.test(text)) {
    return 24 * 90;
  }
  if (/\b1y\b|\byearly\b|\blast year\b/.test(text)) {
    return 24 * 365;
  }

  return DEFAULT_CHART_BUILDER_HOURS;
}

function scoreSourceForPrompt(source, prompt, keywords = [], preferredSourceKey = '') {
  const normalizedPrompt = normalizePromptText(prompt);
  const weightedKeywords = new Set(keywords);
  const haystacks = [
    source?.name,
    source?.category,
    source?.room,
    source?.origin,
    source?.sourceType,
    source?.streamType,
    ...(Array.isArray(source?.availableMetrics)
      ? source.availableMetrics.flatMap((metric) => [metric.key, metric.label])
      : [])
  ]
    .filter(Boolean)
    .map((value) => normalizePromptText(value));

  let score = source?.sourceKey === preferredSourceKey ? 30 : 0;

  haystacks.forEach((entry) => {
    if (!entry) {
      return;
    }

    if (normalizedPrompt && entry && normalizedPrompt.includes(entry)) {
      score += 16;
    }

    weightedKeywords.forEach((keyword) => {
      if (entry.includes(keyword)) {
        score += entry === keyword ? 10 : 5;
      }
    });
  });

  if (/weather|tempest|rain|wind|pressure|humidity|uv|solar|lightning/.test(normalizedPrompt) && source?.sourceType === 'tempest_station') {
    score += 12;
  }

  if (/device|switch|light|fan|thermostat|lock|sensor/.test(normalizedPrompt) && source?.sourceType === 'device') {
    score += 12;
  }

  return score;
}

function selectMetricKeysForPrompt(prompt, source) {
  const normalizedPrompt = normalizePromptText(prompt);
  const descriptors = Array.isArray(source?.availableMetrics) ? source.availableMetrics : [];
  const matches = descriptors.filter((descriptor) => {
    const haystack = `${descriptor.key} ${descriptor.label}`.toLowerCase();
    return haystack.split(/\s+/).some((token) => token && normalizedPrompt.includes(token));
  });

  if (/(on\/off|turned on|turned off|power state|state history|switch history)/.test(normalizedPrompt)) {
    const statusMetric = descriptors.find((descriptor) => descriptor.key === 'status');
    if (statusMetric) {
      return [statusMetric.key];
    }
  }

  if (/\blightning\b/.test(normalizedPrompt)) {
    return descriptors
      .filter((descriptor) => ['lightning_count', 'lightning_avg_distance_miles'].includes(descriptor.key))
      .map((descriptor) => descriptor.key)
      .slice(0, MAX_DEFAULT_METRICS);
  }

  if (/\brain\b/.test(normalizedPrompt)) {
    return descriptors
      .filter((descriptor) => ['rain_today_in', 'rain_rate_in_hr', 'rain_last_minute_in'].includes(descriptor.key))
      .map((descriptor) => descriptor.key)
      .slice(0, MAX_DEFAULT_METRICS);
  }

  if (matches.length > 0) {
    return matches.slice(0, MAX_DEFAULT_METRICS).map((descriptor) => descriptor.key);
  }

  return Array.isArray(source?.featuredMetricKeys) && source.featuredMetricKeys.length > 0
    ? source.featuredMetricKeys.slice(0, MAX_DEFAULT_METRICS)
    : descriptors.slice(0, MAX_DEFAULT_METRICS).map((descriptor) => descriptor.key);
}

function defaultChartTitle(prompt, source, metricKeys = []) {
  const trimmedPrompt = String(prompt || '').trim();
  if (trimmedPrompt) {
    return trimmedPrompt.length > 80 ? `${trimmedPrompt.slice(0, 77)}...` : trimmedPrompt;
  }

  if (source?.name && metricKeys.length > 0) {
    return `${source.name}: ${metricKeys.map((key) => inferMetricLabel(key)).join(', ')}`;
  }

  return 'Telemetry Chart';
}

function extractJsonObject(input) {
  if (typeof input !== 'string') {
    return null;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }

    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch (_nestedError) {
      return null;
    }
  }
}

function normalizeChartType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SUPPORTED_CHART_TYPES.has(normalized) ? normalized : 'area';
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
    void this.backfillExistingDeviceTelemetry().catch((error) => {
      console.warn(`TelemetryService: failed to backfill device telemetry: ${error.message}`);
    });
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

  async backfillExistingDeviceTelemetry() {
    const devices = await Device.find({}).lean();
    return this.recordDeviceSnapshots(devices);
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

    if (!sourceId) {
      return { inserted: false, skipped: true };
    }

    const metrics = extractDeviceMetrics(device);
    if (Object.keys(metrics).length === 0) {
      return { inserted: false, skipped: true };
    }

    const sourceType = sourceOrigin === 'tempest' ? 'tempest_station' : 'device';
    const sourceKey = sourceOrigin === 'tempest'
      ? `tempest_station:${sourceId}`
      : `device:${sourceId}`;
    const sourceName = sourceOrigin === 'tempest'
      ? String(device?.properties?.tempest?.stationName || device?.name || '').trim()
      : String(device?.name || '').trim();
    const sourceCategory = sourceOrigin === 'tempest'
      ? 'weather_station'
      : String(device?.type || '').trim();
    const streamType = sourceOrigin === 'tempest' ? 'tempest_device_state' : 'device_state';

    const recordedAt = parseOptionalDate(device?.lastSeen) || new Date();
    const payload = {
      sourceType,
      sourceId,
      sourceKey,
      sourceName,
      sourceCategory,
      sourceRoom: String(device?.room || '').trim(),
      sourceOrigin,
      streamType,
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

  async recordWorkflowExecution(context = {}, details = {}) {
    const sourceId = String(context?.workflowId || context?.automationId || context?.historyId || '').trim();
    if (!sourceId) {
      return { inserted: false, skipped: true };
    }

    const phase = String(details?.phase || 'started').trim() === 'completed' ? 'completed' : 'started';
    const status = String(details?.status || (phase === 'completed' ? 'success' : 'running')).trim() || 'running';
    const recordedAt = parseOptionalDate(
      details?.recordedAt
      || details?.completedAt
      || details?.startedAt
    ) || new Date();
    const metrics = buildWorkflowExecutionMetrics({
      status,
      phase,
      totalActions: details?.totalActions ?? context?.totalActions ?? 0,
      successfulActions: details?.successfulActions ?? 0,
      failedActions: details?.failedActions ?? 0,
      durationMs: details?.durationMs ?? null
    });

    await TelemetrySample.updateOne(
      {
        sourceKey: `workflow:${sourceId}`,
        streamType: 'workflow_execution',
        recordedAt,
        'metadata.historyId': String(context?.historyId || ''),
        'metadata.phase': phase
      },
      {
        $setOnInsert: {
          sourceType: 'workflow',
          sourceId,
          sourceKey: `workflow:${sourceId}`,
          sourceName: String(context?.workflowName || context?.automationName || 'Workflow').trim(),
          sourceCategory: 'workflow',
          sourceRoom: '',
          sourceOrigin: 'workflow_runtime',
          streamType: 'workflow_execution',
          metricKeys: Object.keys(metrics).sort(),
          metrics,
          metadata: {
            historyId: String(context?.historyId || ''),
            automationId: String(context?.automationId || ''),
            automationName: String(context?.automationName || '').trim(),
            workflowId: String(context?.workflowId || '').trim(),
            workflowName: String(context?.workflowName || '').trim(),
            correlationId: String(context?.correlationId || '').trim(),
            triggerType: String(context?.triggerType || '').trim(),
            triggerSource: String(context?.triggerSource || '').trim(),
            phase,
            status,
            message: String(details?.message || '').trim()
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

  async listSourceSummaries() {
    const latestBySource = await TelemetrySample.aggregate([
      { $sort: { recordedAt: -1 } },
      {
        $group: {
          _id: '$sourceKey',
          sampleCount: { $sum: 1 },
          lastSample: { $first: '$$ROOT' }
        }
      },
      { $sort: { 'lastSample.recordedAt': -1 } }
    ]);

    return (await Promise.all(
      latestBySource.map((entry) => this.buildSourceSummaryFromLatest(entry))
    )).filter(Boolean);
  }

  async getTempestObservationWindowAggregate(stationId, startAt) {
    const resolvedStationId = Number(stationId);
    if (!Number.isFinite(resolvedStationId)) {
      return null;
    }

    const [aggregate] = await TempestObservation.aggregate([
      {
        $match: {
          stationId: resolvedStationId,
          observationType: { $ne: 'rapid_wind' },
          observedAt: { $gte: startAt }
        }
      },
      { $sort: { observedAt: 1 } },
      {
        $group: {
          _id: null,
          observationCount: { $sum: 1 },
          averageTemperatureC: { $avg: '$metrics.temp_c' },
          minTemperatureC: { $min: '$metrics.temp_c' },
          maxTemperatureC: { $max: '$metrics.temp_c' },
          averageHumidityPct: { $avg: '$metrics.humidity_pct' },
          minHumidityPct: { $min: '$metrics.humidity_pct' },
          maxHumidityPct: { $max: '$metrics.humidity_pct' },
          averageDewPointC: { $avg: '$derived.dew_point_c' },
          averagePressureMb: { $avg: '$metrics.pressure_mb' },
          minPressureMb: { $min: '$metrics.pressure_mb' },
          maxPressureMb: { $max: '$metrics.pressure_mb' },
          rainTotalMm: {
            $sum: {
              $ifNull: [
                '$metrics.rain_mm_last_minute_final',
                { $ifNull: ['$metrics.rain_mm_last_minute', 0] }
              ]
            }
          },
          rainPeakRateMmPerHr: { $max: '$derived.rain_rate_mm_per_hr' },
          averageWindMps: { $avg: '$metrics.wind_avg_mps' },
          peakWindGustMps: { $max: '$metrics.wind_gust_mps' },
          lastWindDirectionDeg: { $last: '$metrics.wind_direction_deg' },
          averageSolarWm2: { $avg: '$metrics.solar_radiation_wm2' },
          peakSolarWm2: { $max: '$metrics.solar_radiation_wm2' },
          peakUvIndex: { $max: '$metrics.uv_index' },
          averageIlluminanceLux: { $avg: '$metrics.illuminance_lux' },
          peakIlluminanceLux: { $max: '$metrics.illuminance_lux' },
          averageBatteryVolts: { $avg: '$metrics.battery_volts' },
          minBatteryVolts: { $min: '$metrics.battery_volts' },
          maxBatteryVolts: { $max: '$metrics.battery_volts' },
          lastObservedAt: { $last: '$observedAt' }
        }
      }
    ]);

    return aggregate || null;
  }

  async getTempestSignalWindowAggregate(sourceKey, startAt) {
    const [aggregate] = await TelemetrySample.aggregate([
      {
        $match: {
          sourceKey,
          streamType: 'tempest_device_state',
          recordedAt: { $gte: startAt }
        }
      },
      { $sort: { recordedAt: 1 } },
      {
        $group: {
          _id: null,
          sampleCount: { $sum: 1 },
          averageRssiDbm: { $avg: '$metrics.signal_rssi_dbm' },
          minRssiDbm: { $min: '$metrics.signal_rssi_dbm' },
          maxRssiDbm: { $max: '$metrics.signal_rssi_dbm' },
          averageHubRssiDbm: { $avg: '$metrics.hub_rssi_dbm' },
          websocketConnectedPct: {
            $avg: {
              $multiply: [
                { $ifNull: ['$metrics.websocket_connected', 0] },
                100
              ]
            }
          },
          udpListeningPct: {
            $avg: {
              $multiply: [
                { $ifNull: ['$metrics.udp_listening', 0] },
                100
              ]
            }
          },
          latestRssiDbm: { $last: '$metrics.signal_rssi_dbm' },
          latestWebsocketConnected: { $last: '$metrics.websocket_connected' },
          latestUdpListening: { $last: '$metrics.udp_listening' },
          lastRecordedAt: { $last: '$recordedAt' }
        }
      }
    ]);

    return aggregate || null;
  }

  async getTempestLightningWindowAggregate(stationId, startAt) {
    const resolvedStationId = Number(stationId);
    if (!Number.isFinite(resolvedStationId)) {
      return null;
    }

    const [aggregate] = await TempestEvent.aggregate([
      {
        $match: {
          stationId: resolvedStationId,
          eventType: 'lightning_strike',
          eventAt: { $gte: startAt }
        }
      },
      { $sort: { eventAt: 1 } },
      {
        $group: {
          _id: null,
          strikeCount: { $sum: 1 },
          averageDistanceMiles: { $avg: '$payload.distanceMiles' },
          lastStrikeAt: { $last: '$eventAt' },
          lastStrikeDistanceMiles: { $last: '$payload.distanceMiles' }
        }
      }
    ]);

    return aggregate || null;
  }

  buildTempestWindowSummary(window, observationAggregate, signalAggregate, lightningAggregate) {
    return {
      key: window.key,
      label: window.label,
      hours: window.hours,
      humidity: {
        averagePct: roundNumber(observationAggregate?.averageHumidityPct, 1),
        minPct: roundNumber(observationAggregate?.minHumidityPct, 1),
        maxPct: roundNumber(observationAggregate?.maxHumidityPct, 1),
        averageDewPointF: celsiusToFahrenheit(observationAggregate?.averageDewPointC)
      },
      wind: {
        averageMph: metersPerSecondToMph(observationAggregate?.averageWindMps),
        peakGustMph: metersPerSecondToMph(observationAggregate?.peakWindGustMps),
        directionDeg: roundNumber(observationAggregate?.lastWindDirectionDeg, 0),
        directionLabel: toCompassDirection(observationAggregate?.lastWindDirectionDeg)
      },
      pressure: {
        averageInHg: millibarsToInHg(observationAggregate?.averagePressureMb),
        minInHg: millibarsToInHg(observationAggregate?.minPressureMb),
        maxInHg: millibarsToInHg(observationAggregate?.maxPressureMb)
      },
      rain: {
        totalIn: millimetersToInches(observationAggregate?.rainTotalMm),
        peakRateInPerHr: millimetersToInches(observationAggregate?.rainPeakRateMmPerHr),
        observationCount: toNonNegativeInteger(observationAggregate?.observationCount)
      },
      solar: {
        averageWm2: roundNumber(observationAggregate?.averageSolarWm2, 0),
        peakWm2: roundNumber(observationAggregate?.peakSolarWm2, 0),
        peakUvIndex: roundNumber(observationAggregate?.peakUvIndex, 1),
        peakIlluminanceLux: roundNumber(observationAggregate?.peakIlluminanceLux, 0),
        averageIlluminanceLux: roundNumber(observationAggregate?.averageIlluminanceLux, 0)
      },
      lightning: {
        strikeCount: toNonNegativeInteger(lightningAggregate?.strikeCount),
        averageDistanceMiles: roundNumber(lightningAggregate?.averageDistanceMiles, 1),
        lastStrikeAt: lightningAggregate?.lastStrikeAt || null,
        lastStrikeDistanceMiles: roundNumber(lightningAggregate?.lastStrikeDistanceMiles, 1)
      },
      signal: {
        averageRssiDbm: roundNumber(signalAggregate?.averageRssiDbm, 1),
        minRssiDbm: roundNumber(signalAggregate?.minRssiDbm, 1),
        maxRssiDbm: roundNumber(signalAggregate?.maxRssiDbm, 1),
        averageHubRssiDbm: roundNumber(signalAggregate?.averageHubRssiDbm, 1),
        websocketConnectedPct: roundNumber(signalAggregate?.websocketConnectedPct, 1),
        udpListeningPct: roundNumber(signalAggregate?.udpListeningPct, 1),
        latestRssiDbm: roundNumber(signalAggregate?.latestRssiDbm, 1),
        latestWebsocketConnected: roundNumber(signalAggregate?.latestWebsocketConnected, 0),
        latestUdpListening: roundNumber(signalAggregate?.latestUdpListening, 0),
        sampleCount: toNonNegativeInteger(signalAggregate?.sampleCount)
      },
      battery: {
        averageVolts: roundNumber(observationAggregate?.averageBatteryVolts, 2),
        minVolts: roundNumber(observationAggregate?.minBatteryVolts, 2),
        maxVolts: roundNumber(observationAggregate?.maxBatteryVolts, 2)
      },
      temperature: {
        averageF: celsiusToFahrenheit(observationAggregate?.averageTemperatureC),
        minF: celsiusToFahrenheit(observationAggregate?.minTemperatureC),
        maxF: celsiusToFahrenheit(observationAggregate?.maxTemperatureC)
      },
      meta: {
        observationCount: toNonNegativeInteger(observationAggregate?.observationCount),
        lastObservedAt: observationAggregate?.lastObservedAt || null,
        lastSignalAt: signalAggregate?.lastRecordedAt || null
      }
    };
  }

  async getTempestModuleTelemetry({ sourceId, sourceKey } = {}) {
    const resolvedSourceKey = sourceKey || (sourceId ? `tempest_station:${sourceId}` : '');
    if (!resolvedSourceKey) {
      throw new Error('A telemetry source is required.');
    }

    const stationSource = await this.resolveSourceSummary({
      sourceKey: resolvedSourceKey
    });

    if (stationSource.sourceType !== 'tempest_station') {
      throw new Error('Weather module telemetry requires a Tempest station source.');
    }

    const stationDevice = await Device.findById(stationSource.sourceId).lean();
    const stationId = Number(stationDevice?.properties?.tempest?.stationId);
    const windows = await Promise.all(
      TEMPEST_MODULE_WINDOWS.map(async (window) => {
        const startAt = new Date(Date.now() - window.hours * 60 * 60 * 1000);
        const [observationAggregate, signalAggregate, lightningAggregate] = await Promise.all([
          this.getTempestObservationWindowAggregate(stationId, startAt),
          this.getTempestSignalWindowAggregate(stationSource.sourceKey, startAt),
          this.getTempestLightningWindowAggregate(stationId, startAt)
        ]);

        return this.buildTempestWindowSummary(window, observationAggregate, signalAggregate, lightningAggregate);
      })
    );

    return {
      generatedAt: new Date().toISOString(),
      sourceKey: stationSource.sourceKey,
      sourceId: stationSource.sourceId,
      stationId: Number.isFinite(stationId) ? stationId : null,
      stationName: stationSource.name,
      windows
    };
  }

  async buildChartFromPrompt({ prompt, preferredSourceKey = '' } = {}) {
    const trimmedPrompt = String(prompt || '').trim();
    if (!trimmedPrompt) {
      throw new Error('A chart prompt is required.');
    }

    const sources = await this.listSourceSummaries();
    if (sources.length === 0) {
      throw new Error('No telemetry sources are available yet.');
    }

    const keywords = extractPromptKeywords(trimmedPrompt);
    const rankedSources = sources
      .map((source) => ({
        source,
        score: scoreSourceForPrompt(source, trimmedPrompt, keywords, preferredSourceKey)
      }))
      .sort((left, right) => right.score - left.score);

    const shortlistedSources = rankedSources
      .slice(0, CHART_BUILDER_SOURCE_LIMIT)
      .map((entry) => entry.source);
    const heuristicSource = shortlistedSources[0] || sources[0];
    const heuristicMetricKeys = selectMetricKeysForPrompt(trimmedPrompt, heuristicSource);
    const heuristicHours = inferRequestedHoursFromPrompt(trimmedPrompt);
    const heuristicChart = {
      title: defaultChartTitle(trimmedPrompt, heuristicSource, heuristicMetricKeys),
      description: `Charting ${heuristicSource.name} across ${heuristicHours >= 24 ? Math.round(heuristicHours / 24) : heuristicHours}${heuristicHours >= 24 ? ' day(s)' : ' hour(s)'}.`,
      sourceKey: heuristicSource.sourceKey,
      metricKeys: heuristicMetricKeys,
      hours: heuristicHours,
      chartType: 'area',
      reason: 'Generated from HomeBrain telemetry heuristics.'
    };

    let plannedChart = heuristicChart;

    try {
      const llmPrompt = [
        'You are HomeBrain\'s telemetry chart planner.',
        'Return JSON only with this schema:',
        '{',
        '  "title": string,',
        '  "description": string,',
        '  "sourceKey": string,',
        '  "metricKeys": string[],',
        '  "hours": number,',
        '  "chartType": "area" | "line",',
        '  "reason": string',
        '}',
        'Rules:',
        '- Choose exactly one sourceKey from the provided source catalog.',
        `- Use between 1 and ${MAX_DEFAULT_METRICS} metricKeys from that source only.`,
        `- Choose hours between 1 and ${MAX_QUERY_HOURS}.`,
        '- If the user asks for on/off history, prefer the "status" metric when available.',
        '- If the user references rain or lightning, prefer the weather-station source and those metrics.',
        '',
        `User request: ${trimmedPrompt}`,
        preferredSourceKey ? `Preferred source (use this unless the prompt clearly asks for another source): ${preferredSourceKey}` : '',
        '',
        'Source catalog:',
        ...shortlistedSources.map((source) => `- ${source.sourceKey} | ${source.name} | ${source.category || 'general'} | ${source.room || source.origin || 'house-wide'} | metrics: ${(source.availableMetrics || []).map((metric) => `${metric.key} (${metric.label})`).join(', ')}`),
        '',
        'Return only the JSON object.'
      ].filter(Boolean).join('\n');

      const rawResponse = await sendLLMRequestWithFallback(llmPrompt);
      const parsedResponse = extractJsonObject(rawResponse);
      if (parsedResponse && typeof parsedResponse === 'object' && !Array.isArray(parsedResponse)) {
        const selectedSource = sources.find((source) => source.sourceKey === parsedResponse.sourceKey)
          || sources.find((source) => source.sourceKey === preferredSourceKey)
          || heuristicSource;
        const selectedMetricKeys = normalizeMetricKeyList(parsedResponse.metricKeys)
          .filter((metricKey) => selectedSource.availableMetrics.some((descriptor) => descriptor.key === metricKey))
          .slice(0, MAX_DEFAULT_METRICS);

        plannedChart = {
          title: String(parsedResponse.title || '').trim() || heuristicChart.title,
          description: String(parsedResponse.description || '').trim() || heuristicChart.description,
          sourceKey: selectedSource.sourceKey,
          metricKeys: selectedMetricKeys.length > 0 ? selectedMetricKeys : heuristicMetricKeys,
          hours: clampInteger(parsedResponse.hours, heuristicHours, 1, MAX_QUERY_HOURS),
          chartType: normalizeChartType(parsedResponse.chartType),
          reason: String(parsedResponse.reason || '').trim() || 'Generated from natural language.'
        };
      }
    } catch (error) {
      console.warn(`TelemetryService: falling back to heuristic chart builder: ${error.message}`);
    }

    const source = sources.find((entry) => entry.sourceKey === plannedChart.sourceKey) || heuristicSource;
    const metricKeys = plannedChart.metricKeys
      .filter((metricKey) => source.availableMetrics.some((descriptor) => descriptor.key === metricKey))
      .slice(0, MAX_DEFAULT_METRICS);

    return {
      prompt: trimmedPrompt,
      chart: {
        title: plannedChart.title || heuristicChart.title,
        description: plannedChart.description || heuristicChart.description,
        sourceKey: source.sourceKey,
        metricKeys: metricKeys.length > 0 ? metricKeys : heuristicMetricKeys,
        hours: clampInteger(plannedChart.hours, heuristicHours, 1, MAX_QUERY_HOURS),
        chartType: normalizeChartType(plannedChart.chartType),
        reason: plannedChart.reason || heuristicChart.reason
      },
      source
    };
  }

  async getOverview() {
    const [totalSamples, lastSample, streamBreakdown, sourceTypeBreakdown, sources, storage, disk] = await Promise.all([
      TelemetrySample.countDocuments({}),
      TelemetrySample.findOne({}).sort({ recordedAt: -1 }).select('recordedAt').lean(),
      TelemetrySample.aggregate([
        { $group: { _id: '$streamType', count: { $sum: 1 } } }
      ]),
      TelemetrySample.aggregate([
        { $group: { _id: '$sourceType', count: { $sum: 1 } } }
      ]),
      this.listSourceSummaries(),
      this.getStorageFootprint(),
      resourceMonitorService.getDiskUsage()
    ]);

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
    const events = buildSourceTimelineEvents(samples, source.availableMetrics);

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
      stats: buildMetricStats(points, effectiveMetricKeys),
      events
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
  buildSourceTimelineEvents,
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

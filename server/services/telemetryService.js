const Device = require('../models/Device');
const DeviceEnergySample = require('../models/DeviceEnergySample');
const TelemetrySample = require('../models/TelemetrySample');
const TempestEvent = require('../models/TempestEvent');
const TempestObservation = require('../models/TempestObservation');
const RainMachineDailyStat = require('../models/RainMachineDailyStat');
const RainMachineWateringDay = require('../models/RainMachineWateringDay');
const SenseMonitorSnapshot = require('../models/SenseMonitorSnapshot');
const SenseTrendSnapshot = require('../models/SenseTrendSnapshot');
const { sendLLMRequestWithFallback } = require('./llmService');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const resourceMonitorService = require('./resourceMonitorService');
const { decorateTelemetrySourceSummary } = require('./integrationModuleCatalog');
const TelemetrySourceSummary = require('../models/TelemetrySourceSummary');

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
const TEMPEST_MODULE_AGGREGATE_MAX_TIME_MS = clampInteger(
  process.env.TEMPEST_MODULE_AGGREGATE_MAX_TIME_MS,
  1500,
  250,
  10000
);
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
  solar_power_w: 'Solar Power',
  net_power_w: 'Net Power',
  always_on_w: 'Always On',
  other_w: 'Other',
  untracked_w: 'Untracked',
  energy_kwh: 'Energy',
  daily_energy_kwh: 'Daily Energy',
  weekly_energy_kwh: 'Weekly Energy',
  monthly_energy_kwh: 'Monthly Energy',
  yearly_energy_kwh: 'Yearly Energy',
  cycle_energy_kwh: 'Billing Cycle Energy',
  daily_consumption_kwh: 'Daily Consumption',
  weekly_consumption_kwh: 'Weekly Consumption',
  monthly_consumption_kwh: 'Monthly Consumption',
  yearly_consumption_kwh: 'Yearly Consumption',
  cycle_consumption_kwh: 'Billing Cycle Consumption',
  daily_production_kwh: 'Daily Production',
  weekly_production_kwh: 'Weekly Production',
  monthly_production_kwh: 'Monthly Production',
  yearly_production_kwh: 'Yearly Production',
  cycle_production_kwh: 'Billing Cycle Production',
  daily_net_production_kwh: 'Daily Net Production',
  weekly_net_production_kwh: 'Weekly Net Production',
  monthly_net_production_kwh: 'Monthly Net Production',
  yearly_net_production_kwh: 'Yearly Net Production',
  cycle_net_production_kwh: 'Billing Cycle Net Production',
  daily_from_grid_kwh: 'Daily From Grid',
  weekly_from_grid_kwh: 'Weekly From Grid',
  monthly_from_grid_kwh: 'Monthly From Grid',
  yearly_from_grid_kwh: 'Yearly From Grid',
  cycle_from_grid_kwh: 'Billing Cycle From Grid',
  daily_to_grid_kwh: 'Daily To Grid',
  weekly_to_grid_kwh: 'Weekly To Grid',
  monthly_to_grid_kwh: 'Monthly To Grid',
  yearly_to_grid_kwh: 'Yearly To Grid',
  cycle_to_grid_kwh: 'Billing Cycle To Grid',
  daily_solar_powered_pct: 'Daily Solar Powered',
  weekly_solar_powered_pct: 'Weekly Solar Powered',
  monthly_solar_powered_pct: 'Monthly Solar Powered',
  yearly_solar_powered_pct: 'Yearly Solar Powered',
  cycle_solar_powered_pct: 'Billing Cycle Solar Powered',
  daily_production_pct: 'Daily Production Percentage',
  weekly_production_pct: 'Weekly Production Percentage',
  monthly_production_pct: 'Monthly Production Percentage',
  yearly_production_pct: 'Yearly Production Percentage',
  cycle_production_pct: 'Billing Cycle Production Percentage',
  active_device_count: 'Active Devices',
  current_share_pct: 'Current Share',
  voltage_l1_v: 'L1 Voltage',
  voltage_l2_v: 'L2 Voltage',
  voltage_v: 'Voltage',
  current_a: 'Current',
  frequency_hz: 'Frequency',
  battery_pct: 'Battery',
  battery_low: 'Battery Low',
  humidity_pct: 'Humidity',
  pm2_5_ugm3: 'PM2.5',
  air_quality_index: 'Indoor AQI',
  co2_ppm: 'CO2',
  tvoc_ppb: 'TVOC',
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
  vibration_active: 'Vibration',
  acceleration_active: 'Acceleration',
  tamper_active: 'Tamper',
  presence_present: 'Presence',
  locked: 'Locked',
  water_detected: 'Water Detected',
  smoke_detected: 'Smoke Detected',
  carbon_monoxide_detected: 'CO Detected',
  illuminance_lux: 'Illuminance',
  temperature_c: 'Temperature',
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
  battery_volts: 'Battery Voltage',
  queue_length: 'Queue Length',
  running_program_count: 'Running Programs',
  active_zone_count: 'Active Zones',
  active_restrictions_count: 'Active Restrictions',
  rain_delay_hours: 'Rain Delay',
  remaining_sec: 'Remaining Duration',
  user_duration_sec: 'Scheduled Duration',
  machine_duration_sec: 'Machine Duration',
  scheduled_duration_sec: 'Scheduled Duration',
  watered_duration_sec: 'Watered Duration',
  program_count: 'Programs',
  zone_count: 'Zones',
  cycle_count: 'Cycles',
  adjustment_pct: 'Adjustment',
  simulated_adjustment_pct: 'Simulated Adjustment',
  water_saved_pct: 'Water Saved',
  min_temp_c: 'Min Temperature',
  max_temp_c: 'Max Temperature'
};

const FEATURED_METRIC_PRIORITY = [
  'temperature_f',
  'temperature',
  'humidity_pct',
  'air_quality_index',
  'pm2_5_ugm3',
  'co2_ppm',
  'tvoc_ppb',
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
  'active_zone_count',
  'queue_length',
  'rain_delay_hours',
  'water_saved_pct',
  'adjustment_pct',
  'power_w',
  'solar_power_w',
  'net_power_w',
  'always_on_w',
  'other_w',
  'daily_consumption_kwh',
  'daily_production_kwh',
  'daily_energy_kwh',
  'energy_kwh',
  'battery_pct',
  'battery_low',
  'battery_volts',
  'brightness_pct',
  'status',
  'online',
  'websocket_connected'
];

const INTERESTING_METRIC_PATTERN = /(temp|humid|power|energy|battery|level|speed|volume|pressure|illuminance|lux|uv|rain|motion|contact|occup|presence|lock|water|smoke|carbon|co2|air|heat|cool|fan|setpoint|signal|rssi|volt|current|watt|percent|pct|status|online|active|tamper|vibration|accel|execution|success|fail|duration|action)/i;
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
const BINARY_METRIC_PATTERN = /(^|_)(online|status|open|closed|locked|active|detected|present|occupied|water|smoke|carbon|contact|motion|occupancy|presence|tamper|vibration|acceleration|connected|listening)($|_)/i;
const TIMELINE_PRIORITY_KEYS = new Set([
  'status',
  'online',
  'locked',
  'contact_open',
  'motion_active',
  'occupancy_active',
  'vibration_active',
  'acceleration_active',
  'tamper_active',
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
    key: 'telemetry_source_summaries',
    label: 'Telemetry Source Summaries',
    model: TelemetrySourceSummary
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
  },
  {
    key: 'rainmachine_daily_stats',
    label: 'RainMachine Daily Stats',
    model: RainMachineDailyStat
  },
  {
    key: 'rainmachine_watering_days',
    label: 'RainMachine Watering History',
    model: RainMachineWateringDay
  },
  {
    key: 'sense_monitor_snapshots',
    label: 'Sense Monitor Snapshots',
    model: SenseMonitorSnapshot
  },
  {
    key: 'sense_trend_snapshots',
    label: 'Sense Trend Snapshots',
    model: SenseTrendSnapshot
  }
];
const TELEMETRY_LOOKUP_TEXT_PATTERN = /^[A-Za-z0-9:_./-]{1,240}$/;

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

function asPlainNumberMap(value) {
  const output = {};
  Object.entries(asPlainMetrics(value)).forEach(([key, rawValue]) => {
    const numeric = Number(rawValue);
    if (Number.isFinite(numeric)) {
      output[key] = numeric;
    }
  });
  return output;
}

function normalizeTelemetryLookupText(value) {
  if (Array.isArray(value)) {
    return normalizeTelemetryLookupText(value[0]);
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const normalized = String(value).trim();
    return TELEMETRY_LOOKUP_TEXT_PATTERN.test(normalized) ? normalized : '';
  }

  return '';
}

function resolveTelemetrySourceKey({ sourceKey, sourceType, sourceId } = {}) {
  const directSourceKey = normalizeTelemetryLookupText(sourceKey);
  if (directSourceKey) {
    return directSourceKey;
  }

  const normalizedSourceType = normalizeTelemetryLookupText(sourceType);
  const normalizedSourceId = normalizeTelemetryLookupText(sourceId);
  return normalizedSourceType && normalizedSourceId
    ? `${normalizedSourceType}:${normalizedSourceId}`
    : '';
}

function normalizeMetricKeys(keys = []) {
  return Array.from(new Set((Array.isArray(keys) ? keys : [])
    .flatMap((entry) => Array.isArray(entry) ? entry : [entry])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)))
    .sort();
}

function flattenMetricKeySets(metricKeySets = []) {
  return normalizeMetricKeys((Array.isArray(metricKeySets) ? metricKeySets : []).flatMap((entry) => (
    Array.isArray(entry) ? entry : []
  )));
}

function buildSourceSummaryFromSnapshot(snapshot = {}) {
  if (!snapshot?.sourceKey) {
    return null;
  }

  const metricKeys = normalizeMetricKeys(snapshot.metricKeys);
  const descriptors = buildMetricDescriptors(metricKeys);
  const lastValues = asPlainNumberMap(snapshot.lastValues);

  return decorateTelemetrySourceSummary({
    sourceKey: snapshot.sourceKey,
    sourceType: snapshot.sourceType,
    sourceId: snapshot.sourceId,
    name: snapshot.sourceName || 'Unnamed Source',
    category: snapshot.sourceCategory || '',
    room: snapshot.sourceRoom || '',
    origin: snapshot.sourceOrigin || '',
    streamType: snapshot.streamType || '',
    sampleCount: Number(snapshot.sampleCount || 0),
    streamCounts: asPlainNumberMap(snapshot.streamCounts),
    metricCount: descriptors.length,
    lastSampleAt: snapshot.lastSampleAt || null,
    availableMetrics: descriptors,
    featuredMetricKeys: pickFeaturedMetricKeys(descriptors),
    lastValues: descriptors.reduce((acc, descriptor) => {
      acc[descriptor.key] = typeof lastValues[descriptor.key] === 'number'
        ? lastValues[descriptor.key]
        : null;
      return acc;
    }, {})
  });
}

function summarizeSourceBreakdowns(sources = []) {
  const summary = {
    totalSamples: 0,
    streamCounts: {},
    sourceTypeCounts: {},
    lastSampleAt: null
  };

  (Array.isArray(sources) ? sources : []).forEach((source) => {
    const sampleCount = Math.max(0, Number(source?.sampleCount) || 0);
    summary.totalSamples += sampleCount;

    if (source?.sourceType) {
      summary.sourceTypeCounts[source.sourceType] = (summary.sourceTypeCounts[source.sourceType] || 0) + sampleCount;
    }

    Object.entries(source?.streamCounts || {}).forEach(([streamType, count]) => {
      const numericCount = Math.max(0, Number(count) || 0);
      if (streamType && numericCount > 0) {
        summary.streamCounts[streamType] = (summary.streamCounts[streamType] || 0) + numericCount;
      }
    });

    const sampleAt = parseOptionalDate(source?.lastSampleAt);
    if (sampleAt && (!summary.lastSampleAt || sampleAt > summary.lastSampleAt)) {
      summary.lastSampleAt = sampleAt;
    }
  });

  return summary;
}

function shouldRebuildSourceSummaries({ summaryCount, sampleCount, summarySampleCount, allowEstimatedDrift = false } = {}) {
  const normalizedSummaryCount = toNonNegativeInteger(summaryCount);
  const normalizedSampleCount = toNonNegativeInteger(sampleCount);
  const normalizedSummarySampleCount = toNonNegativeInteger(summarySampleCount);

  if (normalizedSampleCount <= 0) {
    return false;
  }

  if (normalizedSummaryCount <= 0) {
    return true;
  }

  const allowedDrift = allowEstimatedDrift && normalizedSampleCount >= 100
    ? Math.ceil(normalizedSampleCount * 0.01)
    : 0;

  return Math.abs(normalizedSampleCount - normalizedSummarySampleCount) > allowedDrift;
}

function buildNumericMetricMap(input = {}) {
  const metrics = {};
  Object.entries(asPlainMetrics(input)).forEach(([key, value]) => {
    addMetric(metrics, key, value);
  });
  return metrics;
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
  if (/_sec$/.test(key)) {
    return 'sec';
  }
  if (/_minutes$/.test(key)) {
    return 'min';
  }
  if (/_hours$/.test(key)) {
    return 'hr';
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
  if (/_v$/.test(key)) {
    return 'V';
  }
  if (/_a$/.test(key)) {
    return 'A';
  }
  if (/_hz$/.test(key)) {
    return 'Hz';
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
  if (/_ugm3$/.test(key)) {
    return 'ug/m³';
  }
  if (/_ppm$/.test(key)) {
    return 'ppm';
  }
  if (/_ppb$/.test(key)) {
    return 'ppb';
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
    case 'vibration_active':
      return active ? 'Vibration' : 'Clear';
    case 'acceleration_active':
      return active ? 'Acceleration' : 'Clear';
    case 'tamper_active':
      return active ? 'Tamper' : 'Clear';
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
  if (metricKey === 'vibration_active') {
    return Number(nextValue) >= 0.5 ? 'Vibration Detected' : 'Vibration Cleared';
  }
  if (metricKey === 'acceleration_active') {
    return Number(nextValue) >= 0.5 ? 'Acceleration Detected' : 'Acceleration Cleared';
  }
  if (metricKey === 'tamper_active') {
    return Number(nextValue) >= 0.5 ? 'Tamper Detected' : 'Tamper Cleared';
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

  if (sourceOrigin === 'rainmachine') {
    const rainMachine = properties.rainmachine && typeof properties.rainmachine === 'object'
      ? properties.rainmachine
      : {};

    addMetric(metrics, 'queue_length', rainMachine.queueLength);
    addMetric(metrics, 'running_program_count', rainMachine.runningProgramCount);
    addMetric(metrics, 'active_zone_count', rainMachine.activeZoneCount);
    addMetric(metrics, 'active_restrictions_count', rainMachine.activeRestrictionsCount);
    addMetric(metrics, 'rain_delay_hours', rainMachine.rainDelayHours);
    addMetric(metrics, 'remaining_sec', rainMachine.remainingSeconds);
    addMetric(metrics, 'user_duration_sec', rainMachine.userDurationSeconds);
    addMetric(metrics, 'machine_duration_sec', rainMachine.machineDurationSeconds);
    addMetric(metrics, 'program_count', rainMachine.programCount);
    addMetric(metrics, 'zone_count', rainMachine.zoneCount);
    addMetric(metrics, 'cycle_count', rainMachine.cycleCount);
    addMetric(metrics, 'status', device.status ?? (rainMachine.stateLabel === 'running' || rainMachine.stateLabel === 'pending'));

    return metrics;
  }

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

  if (sourceOrigin === 'sense') {
    const sense = properties.sense && typeof properties.sense === 'object'
      ? properties.sense
      : {};
    const trends = sense.trends && typeof sense.trends === 'object'
      ? sense.trends
      : {};
    const entityType = String(sense.entityType || '').trim().toLowerCase();

    addMetric(metrics, 'power_w', sense.currentPowerW);
    addMetric(metrics, 'current_share_pct', sense.currentSharePct);
    addMetric(metrics, 'current_cost_usd_per_hr', sense.currentCostUsdPerHour);
    addMetric(metrics, 'month_to_date_cost_usd', sense.monthToDateCostUsd);
    addMetric(metrics, 'projected_month_cost_usd', sense.projectedMonthCostUsd);
    addMetric(metrics, 'electricity_rate_cents_per_kwh', sense.electricityRateCentsPerKwh);

    if (entityType === 'monitor') {
      addMetric(metrics, 'solar_power_w', sense.solarPowerW);
      addMetric(metrics, 'net_power_w', sense.netPowerW);
      addMetric(metrics, 'always_on_w', sense.alwaysOnW);
      addMetric(metrics, 'other_w', sense.otherW);
      addMetric(metrics, 'untracked_w', sense.untrackedW);
      addMetric(metrics, 'active_device_count', sense.activeDeviceCount);
      addMetric(metrics, 'voltage_l1_v', Array.isArray(sense.voltage) ? sense.voltage[0] : null);
      addMetric(metrics, 'voltage_l2_v', Array.isArray(sense.voltage) ? sense.voltage[1] : null);
      addMetric(metrics, 'frequency_hz', sense.frequencyHz);
    }

    const trendMappings = [
      ['day', 'daily'],
      ['week', 'weekly'],
      ['month', 'monthly'],
      ['year', 'yearly'],
      ['cycle', 'cycle']
    ];

    trendMappings.forEach(([trendKey, prefix]) => {
      const trend = trends[trendKey] && typeof trends[trendKey] === 'object'
        ? trends[trendKey]
        : {};

      if (entityType === 'monitor') {
        addMetric(metrics, `${prefix}_consumption_kwh`, trend.consumptionTotalKwh);
        addMetric(metrics, `${prefix}_production_kwh`, trend.productionTotalKwh);
        addMetric(metrics, `${prefix}_production_pct`, trend.productionPct);
        addMetric(metrics, `${prefix}_net_production_kwh`, trend.netProductionKwh);
        addMetric(metrics, `${prefix}_from_grid_kwh`, trend.fromGridKwh);
        addMetric(metrics, `${prefix}_to_grid_kwh`, trend.toGridKwh);
        addMetric(metrics, `${prefix}_solar_powered_pct`, trend.solarPoweredPct);
        addMetric(metrics, `${prefix}_cost_usd`, trend.costUsd);
      } else {
        addMetric(metrics, `${prefix}_energy_kwh`, trend.energyKwh);
        addMetric(metrics, `${prefix}_cost_usd`, trend.costUsd);
      }
    });

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

  const directRadioState = properties.directRadioState && typeof properties.directRadioState === 'object'
    ? properties.directRadioState
    : {};
  addMetric(metrics, 'battery_pct', directRadioState.batteryLevel ?? properties.homeBrainBatteryLevel ?? properties.batteryLevel);
  addMetric(metrics, 'battery_low', directRadioState.batteryLow);
  addMetric(metrics, 'battery_volts', directRadioState.batteryVoltage);
  addMetric(metrics, 'contact_open', directRadioState.contactOpen ?? directRadioState.contact);
  addMetric(metrics, 'motion_active', directRadioState.motionActive ?? directRadioState.motion);
  addMetric(metrics, 'occupancy_active', directRadioState.occupancyActive ?? directRadioState.occupancy);
  addMetric(metrics, 'vibration_active', directRadioState.vibrationActive ?? directRadioState.vibration);
  addMetric(metrics, 'acceleration_active', directRadioState.accelerationActive ?? directRadioState.acceleration);
  addMetric(metrics, 'tamper_active', directRadioState.tamperActive ?? directRadioState.tamper);
  addMetric(metrics, 'water_detected', directRadioState.waterDetected ?? directRadioState.water);
  addMetric(metrics, 'humidity_pct', directRadioState.humidity);
  addMetric(metrics, 'illuminance_lux', directRadioState.illuminance);
  addMetric(metrics, 'temperature_c', directRadioState.temperatureC);
  addMetric(metrics, 'temperature_f', directRadioState.temperatureF);
  addMetric(metrics, 'color_temperature_k', directRadioState.colorTemperatureK);
  addMetric(metrics, 'power_w', directRadioState.powerW);
  addMetric(metrics, 'energy_kwh', directRadioState.energyKwh);
  addMetric(metrics, 'voltage_v', directRadioState.voltageV);
  addMetric(metrics, 'current_a', directRadioState.currentA);

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
    .slice(0, 2048)
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
  const unitMultipliers = new Map([
    ['hour', 1], ['hours', 1], ['hr', 1], ['hrs', 1],
    ['day', 24], ['days', 24],
    ['week', 24 * 7], ['weeks', 24 * 7],
    ['month', 24 * 30], ['months', 24 * 30],
    ['year', 24 * 365], ['years', 24 * 365]
  ]);
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] < '0' || text[index] > '9') continue;
    const numberStart = index;
    while (index < text.length && text[index] >= '0' && text[index] <= '9') index += 1;
    const numberEnd = index;
    while (index < text.length && text[index] === ' ') index += 1;
    const unitStart = index;
    while (index < text.length && text[index] >= 'a' && text[index] <= 'z') index += 1;
    const unit = text.slice(unitStart, index);
    if (unitMultipliers.has(unit)) {
      const count = clampInteger(text.slice(numberStart, numberEnd), DEFAULT_CHART_BUILDER_HOURS, 1, MAX_QUERY_HOURS);
      return Math.min(MAX_QUERY_HOURS, count * unitMultipliers.get(unit));
    }
  }

  const padded = ` ${text} `;
  if (padded.includes(' 24h ') || padded.includes(' last 24 ') || padded.includes(' today ') || padded.includes(' daily ')) {
    return 24;
  }
  if (padded.includes(' 7d ') || padded.includes(' weekly ') || padded.includes(' last week ')) {
    return 24 * 7;
  }
  if (padded.includes(' 30d ') || padded.includes(' monthly ') || padded.includes(' last month ')) {
    return 24 * 30;
  }
  if (padded.includes(' 90d ') || padded.includes(' quarter ')) {
    return 24 * 90;
  }
  if (padded.includes(' 1y ') || padded.includes(' yearly ') || padded.includes(' last year ')) {
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

  if (/indoor|air|quality|aqi|pm2|pm25|humidity|temperature|govee|co2|voc/.test(normalizedPrompt) && source?.sourceType === 'govee_air_quality') {
    score += 12;
  }

  if (/device|switch|light|fan|thermostat|lock|sensor/.test(normalizedPrompt) && source?.sourceType === 'device') {
    score += 12;
  }

  if (/rainmachine|irrigation|sprinkler|watering|zones/.test(normalizedPrompt) && (source?.sourceType === 'rainmachine_report' || source?.origin === 'rainmachine')) {
    score += 14;
  }

  if (/sense|energy|power|usage|solar|always on|grid/.test(normalizedPrompt) && (source?.sourceType === 'sense_monitor' || source?.sourceType === 'sense_device' || source?.origin === 'sense')) {
    score += 14;
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

async function mapSettledWithConcurrency(items = [], concurrency = 8, worker) {
  const list = Array.isArray(items) ? items : [];
  const limit = clampInteger(concurrency, 8, 1, 32);
  const results = new Array(list.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        results[index] = {
          status: 'fulfilled',
          value: await worker(list[index], index)
        };
      } catch (reason) {
        results[index] = {
          status: 'rejected',
          reason
        };
      }
    }
  }

  const workerCount = Math.min(limit, list.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return results;
}

class TelemetryService {
  constructor(options = {}) {
    this.initialized = false;
    this.handleDeviceUpdates = this.handleDeviceUpdates.bind(this);
    this.deviceSnapshotConcurrency = clampInteger(
      options.deviceSnapshotConcurrency ?? process.env.HOMEBRAIN_TELEMETRY_DEVICE_SNAPSHOT_CONCURRENCY,
      8,
      1,
      32
    );
    this.deviceSnapshotFlushDelayMs = clampInteger(
      options.deviceSnapshotFlushDelayMs ?? process.env.HOMEBRAIN_TELEMETRY_DEVICE_SNAPSHOT_FLUSH_DELAY_MS,
      100,
      0,
      5000
    );
    this.pendingDeviceSnapshots = new Map();
    this.deviceSnapshotFlushTimer = null;
    this.deviceSnapshotFlushInFlight = false;
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
    if (this.initialized) {
      deviceUpdateEmitter.removeListener('devices:update', this.handleDeviceUpdates);
      this.initialized = false;
    }

    if (this.deviceSnapshotFlushTimer) {
      clearTimeout(this.deviceSnapshotFlushTimer);
      this.deviceSnapshotFlushTimer = null;
    }
    this.pendingDeviceSnapshots.clear();
  }

  handleDeviceUpdates(devices = []) {
    try {
      this.enqueueDeviceSnapshots(devices);
    } catch (error) {
      console.warn(`TelemetryService: failed to queue device telemetry: ${error.message}`);
    }
  }

  async backfillExistingDeviceTelemetry() {
    const devices = await Device.find({}).lean();
    return this.recordDeviceSnapshots(devices);
  }

  enqueueDeviceSnapshots(devices = []) {
    if (!Array.isArray(devices)) {
      return {
        queuedCount: 0,
        pendingCount: this.pendingDeviceSnapshots.size
      };
    }

    let queuedCount = 0;
    devices.forEach((device) => {
      const deviceId = String(device?._id || device?.id || '').trim();
      if (!deviceId) {
        return;
      }

      this.pendingDeviceSnapshots.set(deviceId, device);
      queuedCount += 1;
    });

    if (queuedCount > 0) {
      this.scheduleDeviceSnapshotFlush();
    }

    return {
      queuedCount,
      pendingCount: this.pendingDeviceSnapshots.size
    };
  }

  scheduleDeviceSnapshotFlush() {
    if (this.deviceSnapshotFlushTimer || this.deviceSnapshotFlushInFlight) {
      return;
    }

    this.deviceSnapshotFlushTimer = setTimeout(() => {
      this.deviceSnapshotFlushTimer = null;
      void this.flushPendingDeviceSnapshots().catch((error) => {
        console.warn(`TelemetryService: failed to record queued device telemetry: ${error.message}`);
      });
    }, this.deviceSnapshotFlushDelayMs);

    if (typeof this.deviceSnapshotFlushTimer.unref === 'function') {
      this.deviceSnapshotFlushTimer.unref();
    }
  }

  async flushPendingDeviceSnapshots() {
    if (this.deviceSnapshotFlushTimer) {
      clearTimeout(this.deviceSnapshotFlushTimer);
      this.deviceSnapshotFlushTimer = null;
    }

    if (this.deviceSnapshotFlushInFlight) {
      return {
        insertedCount: 0,
        skippedCount: 0,
        pendingCount: this.pendingDeviceSnapshots.size
      };
    }

    if (this.pendingDeviceSnapshots.size === 0) {
      return {
        insertedCount: 0,
        skippedCount: 0,
        pendingCount: 0
      };
    }

    const devices = Array.from(this.pendingDeviceSnapshots.values());
    this.pendingDeviceSnapshots.clear();
    this.deviceSnapshotFlushInFlight = true;

    try {
      const summary = await this.recordDeviceSnapshots(devices);
      return {
        ...summary,
        pendingCount: this.pendingDeviceSnapshots.size
      };
    } finally {
      this.deviceSnapshotFlushInFlight = false;
      if (this.pendingDeviceSnapshots.size > 0) {
        this.scheduleDeviceSnapshotFlush();
      }
    }
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

    const results = await mapSettledWithConcurrency(
      Array.from(dedupedDevices.values()),
      this.deviceSnapshotConcurrency,
      (device) => this.recordDeviceSnapshot(device)
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
    const senseEntityType = String(device?.properties?.sense?.entityType || '').trim().toLowerCase();

    if (!sourceId) {
      return { inserted: false, skipped: true };
    }

    const metrics = extractDeviceMetrics(device);
    if (Object.keys(metrics).length === 0) {
      return { inserted: false, skipped: true };
    }

    const sourceType = sourceOrigin === 'tempest'
      ? 'tempest_station'
      : sourceOrigin === 'sense' && senseEntityType === 'monitor'
        ? 'sense_monitor'
        : sourceOrigin === 'sense'
          ? 'sense_device'
          : 'device';
    const sourceKey = sourceOrigin === 'tempest'
      ? `tempest_station:${sourceId}`
      : sourceOrigin === 'sense' && senseEntityType === 'monitor'
        ? `sense_monitor:${sourceId}`
        : sourceOrigin === 'sense'
          ? `sense_device:${sourceId}`
          : `device:${sourceId}`;
    const sourceName = sourceOrigin === 'tempest'
      ? String(device?.properties?.tempest?.stationName || device?.name || '').trim()
      : String(device?.name || '').trim();
    const sourceCategory = sourceOrigin === 'tempest'
      ? 'weather_station'
      : sourceOrigin === 'sense' && senseEntityType === 'monitor'
        ? 'energy_monitor'
        : sourceOrigin === 'sense'
          ? 'energy_device'
          : String(device?.type || '').trim();
    const streamType = sourceOrigin === 'tempest'
      ? 'tempest_device_state'
      : sourceOrigin === 'sense' && senseEntityType === 'monitor'
        ? 'sense_monitor_state'
        : sourceOrigin === 'sense'
          ? 'sense_device_state'
          : 'device_state';

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

      await this.updateSourceSummaryMetadata(payload);
      return { inserted: false, skipped: true };
    }

    const sample = await TelemetrySample.create(payload);
    await this.updateSourceSummaryForSample({ ...payload, _id: sample._id }, { sampleInserted: true });
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

    const result = await TelemetrySample.updateOne(
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

    if (result?.upsertedCount || result?.upsertedId) {
      await this.updateSourceSummaryForSample({
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
        recordedAt,
        _id: result.upsertedId?._id || result.upsertedId || null
      }, { sampleInserted: true });
    }

    return { inserted: true };
  }

  async recordRainMachineDailyStat(controller = {}, stat = {}) {
    const controllerId = String(controller?.id || stat?.controllerId || '').trim();
    const controllerName = String(controller?.name || stat?.controllerName || 'RainMachine').trim();
    if (!controllerId) {
      return { inserted: false, skipped: true };
    }

    const recordedAt = parseOptionalDate(stat?.dayDate || stat?.day);
    if (!recordedAt) {
      return { inserted: false, skipped: true };
    }

    const metrics = buildNumericMetricMap(stat?.metrics);
    if (Object.keys(metrics).length === 0) {
      return { inserted: false, skipped: true };
    }

    const result = await TelemetrySample.updateOne(
      {
        sourceKey: `rainmachine_report:${controllerId}:daily_stats`,
        streamType: 'rainmachine_daily_stat',
        recordedAt,
        'metadata.day': String(stat?.day || '')
      },
      {
        $setOnInsert: {
          sourceType: 'rainmachine_report',
          sourceId: controllerId,
          sourceKey: `rainmachine_report:${controllerId}:daily_stats`,
          sourceName: `${controllerName} Daily Stats`,
          sourceCategory: 'irrigation_report',
          sourceRoom: String(controller?.room || '').trim(),
          sourceOrigin: 'rainmachine',
          streamType: 'rainmachine_daily_stat',
          metricKeys: Object.keys(metrics).sort(),
          metrics,
          metadata: {
            day: String(stat?.day || ''),
            controllerName,
            details: stat?.details || {}
          },
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    if (result?.upsertedCount || result?.upsertedId) {
      await this.updateSourceSummaryForSample({
        sourceType: 'rainmachine_report',
        sourceId: controllerId,
        sourceKey: `rainmachine_report:${controllerId}:daily_stats`,
        sourceName: `${controllerName} Daily Stats`,
        sourceCategory: 'irrigation_report',
        sourceRoom: String(controller?.room || '').trim(),
        sourceOrigin: 'rainmachine',
        streamType: 'rainmachine_daily_stat',
        metricKeys: Object.keys(metrics).sort(),
        metrics,
        recordedAt,
        _id: result.upsertedId?._id || result.upsertedId || null
      }, { sampleInserted: true });
    }

    return { inserted: true };
  }

  async recordRainMachineWateringDay(controller = {}, wateringDay = {}) {
    const controllerId = String(controller?.id || wateringDay?.controllerId || '').trim();
    const controllerName = String(controller?.name || wateringDay?.controllerName || 'RainMachine').trim();
    if (!controllerId) {
      return { inserted: false, skipped: true };
    }

    const recordedAt = parseOptionalDate(wateringDay?.dayDate || wateringDay?.day);
    if (!recordedAt) {
      return { inserted: false, skipped: true };
    }

    const metrics = buildNumericMetricMap(wateringDay?.summary);
    if (Object.keys(metrics).length === 0) {
      return { inserted: false, skipped: true };
    }

    const result = await TelemetrySample.updateOne(
      {
        sourceKey: `rainmachine_report:${controllerId}:watering_log`,
        streamType: 'rainmachine_watering_log',
        recordedAt,
        'metadata.day': String(wateringDay?.day || ''),
        'metadata.simulated': wateringDay?.simulated === true
      },
      {
        $setOnInsert: {
          sourceType: 'rainmachine_report',
          sourceId: controllerId,
          sourceKey: `rainmachine_report:${controllerId}:watering_log`,
          sourceName: `${controllerName} Watering Log`,
          sourceCategory: 'irrigation_report',
          sourceRoom: String(controller?.room || '').trim(),
          sourceOrigin: 'rainmachine',
          streamType: 'rainmachine_watering_log',
          metricKeys: Object.keys(metrics).sort(),
          metrics,
          metadata: {
            day: String(wateringDay?.day || ''),
            simulated: wateringDay?.simulated === true,
            controllerName,
            programCount: Array.isArray(wateringDay?.programs) ? wateringDay.programs.length : 0
          },
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    if (result?.upsertedCount || result?.upsertedId) {
      await this.updateSourceSummaryForSample({
        sourceType: 'rainmachine_report',
        sourceId: controllerId,
        sourceKey: `rainmachine_report:${controllerId}:watering_log`,
        sourceName: `${controllerName} Watering Log`,
        sourceCategory: 'irrigation_report',
        sourceRoom: String(controller?.room || '').trim(),
        sourceOrigin: 'rainmachine',
        streamType: 'rainmachine_watering_log',
        metricKeys: Object.keys(metrics).sort(),
        metrics,
        recordedAt,
        _id: result.upsertedId?._id || result.upsertedId || null
      }, { sampleInserted: true });
    }

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

    const result = await TelemetrySample.updateOne(
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

    if (result?.upsertedCount || result?.upsertedId) {
      await this.updateSourceSummaryForSample({
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
        recordedAt,
        _id: result.upsertedId?._id || result.upsertedId || null
      }, { sampleInserted: true });
    }

    return { inserted: true };
  }

  async updateSourceSummaryMetadata(payload = {}) {
    const sourceKey = String(payload?.sourceKey || '').trim();
    if (!sourceKey) {
      return { updated: false };
    }

    await TelemetrySourceSummary.updateOne(
      { sourceKey },
      {
        $set: {
          sourceType: payload.sourceType,
          sourceId: String(payload.sourceId || '').trim(),
          sourceName: String(payload.sourceName || '').trim(),
          sourceCategory: String(payload.sourceCategory || '').trim(),
          sourceRoom: String(payload.sourceRoom || '').trim(),
          sourceOrigin: String(payload.sourceOrigin || '').trim(),
          updatedAt: new Date()
        },
        $setOnInsert: {
          sourceKey,
          sampleCount: 0,
          metricKeys: normalizeMetricKeys(payload.metricKeys || Object.keys(asPlainMetrics(payload.metrics))),
          streamCounts: {},
          lastValues: {},
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    return { updated: true };
  }

  async updateSourceSummaryForSample(payload = {}, options = {}) {
    const sourceKey = String(payload?.sourceKey || '').trim();
    const streamType = String(payload?.streamType || '').trim();
    const sourceId = String(payload?.sourceId || '').trim();
    const sourceType = String(payload?.sourceType || '').trim();
    const recordedAt = parseOptionalDate(payload?.recordedAt) || new Date();
    const metrics = asPlainNumberMap(payload?.metrics);
    const metricKeys = normalizeMetricKeys(payload?.metricKeys || Object.keys(metrics));

    if (!sourceKey || !sourceId || !sourceType || !streamType) {
      return { updated: false };
    }

    const now = new Date();
    const update = {
      $set: {
        sourceType,
        sourceId,
        sourceName: String(payload.sourceName || '').trim(),
        sourceCategory: String(payload.sourceCategory || '').trim(),
        sourceRoom: String(payload.sourceRoom || '').trim(),
        sourceOrigin: String(payload.sourceOrigin || '').trim(),
        updatedAt: now
      },
      $setOnInsert: {
        sourceKey,
        lastValues: {},
        createdAt: now
      },
      $addToSet: {
        metricKeys: { $each: metricKeys }
      }
    };

    if (options.sampleInserted !== false) {
      update.$inc = {
        sampleCount: 1,
        [`streamCounts.${streamType}`]: 1
      };
    } else {
      update.$setOnInsert.sampleCount = 0;
      update.$setOnInsert.streamCounts = {};
    }

    await TelemetrySourceSummary.updateOne({ sourceKey }, update, { upsert: true });

    await TelemetrySourceSummary.updateOne(
      {
        sourceKey,
        $or: [
          { lastSampleAt: { $exists: false } },
          { lastSampleAt: null },
          { lastSampleAt: { $lte: recordedAt } }
        ]
      },
      {
        $set: {
          streamType,
          lastSampleAt: recordedAt,
          latestSampleId: payload?._id || null,
          lastValues: metrics,
          updatedAt: now
        }
      }
    );

    return { updated: true };
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

  async rebuildSourceSummaries() {
    const latestBySource = await TelemetrySample.aggregate([
      { $sort: { sourceKey: 1, recordedAt: -1 } },
      {
        $group: {
          _id: '$sourceKey',
          sampleCount: { $sum: 1 },
          lastSample: { $first: '$$ROOT' },
          metricKeySets: { $addToSet: '$metricKeys' }
        }
      }
    ]).allowDiskUse(true);

    const streamCountsBySource = await TelemetrySample.aggregate([
      {
        $group: {
          _id: {
            sourceKey: '$sourceKey',
            streamType: '$streamType'
          },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: '$_id.sourceKey',
          streams: {
            $push: {
              k: '$_id.streamType',
              v: '$count'
            }
          }
        }
      }
    ]).allowDiskUse(true);

    const streamCountMap = new Map(streamCountsBySource.map((entry) => [
      entry._id,
      Object.fromEntries((entry.streams || [])
        .filter((stream) => stream?.k)
        .map((stream) => [stream.k, Number(stream.v || 0)]))
    ]));
    const rebuiltAt = new Date();
    const operations = latestBySource
      .map((entry) => {
        const sample = entry?.lastSample || {};
        const sourceKey = String(entry?._id || sample.sourceKey || '').trim();
        if (!sourceKey) {
          return null;
        }

        const metrics = asPlainNumberMap(sample.metrics);
        const metricKeys = flattenMetricKeySets(entry.metricKeySets);

        return {
          updateOne: {
            filter: { sourceKey },
            update: {
              $set: {
                sourceKey,
                sourceType: sample.sourceType,
                sourceId: String(sample.sourceId || '').trim(),
                sourceName: String(sample.sourceName || '').trim(),
                sourceCategory: String(sample.sourceCategory || '').trim(),
                sourceRoom: String(sample.sourceRoom || '').trim(),
                sourceOrigin: String(sample.sourceOrigin || '').trim(),
                streamType: sample.streamType,
                streamCounts: streamCountMap.get(sourceKey) || {},
                metricKeys,
                sampleCount: Number(entry.sampleCount || 0),
                lastValues: metrics,
                lastSampleAt: sample.recordedAt || null,
                latestSampleId: sample._id || null,
                rebuiltAt,
                updatedAt: rebuiltAt
              },
              $setOnInsert: {
                createdAt: rebuiltAt
              }
            },
            upsert: true
          }
        };
      })
      .filter(Boolean);
    const rebuiltSourceKeys = operations
      .map((operation) => operation.updateOne.filter.sourceKey)
      .filter(Boolean);

    await TelemetrySourceSummary.updateMany(
      rebuiltSourceKeys.length > 0
        ? { sourceKey: { $nin: rebuiltSourceKeys }, sampleCount: { $gt: 0 } }
        : { sampleCount: { $gt: 0 } },
      {
        $set: {
          sampleCount: 0,
          streamCounts: {},
          lastValues: {},
          lastSampleAt: null,
          latestSampleId: null,
          rebuiltAt,
          updatedAt: rebuiltAt
        }
      }
    );

    if (operations.length > 0) {
      await TelemetrySourceSummary.bulkWrite(operations, { ordered: false });
    }

    return {
      sourceCount: operations.length,
      rebuiltAt
    };
  }

  async ensureSourceSummaries() {
    const summaryCount = await TelemetrySourceSummary.estimatedDocumentCount();
    const estimatedSampleCount = await TelemetrySample.estimatedDocumentCount();
    if (estimatedSampleCount <= 0) {
      return { rebuilt: false, summaryCount, sampleCount: estimatedSampleCount };
    }

    let summarySampleCount = 0;
    if (summaryCount > 0) {
      const [totals] = await TelemetrySourceSummary.aggregate([
        {
          $group: {
            _id: null,
            sampleCount: { $sum: '$sampleCount' }
          }
        }
      ]);
      summarySampleCount = toNonNegativeInteger(totals?.sampleCount);
    }

    let sampleCount = estimatedSampleCount;
    let shouldRebuild = shouldRebuildSourceSummaries({
      summaryCount,
      sampleCount,
      summarySampleCount,
      allowEstimatedDrift: true
    });

    if (!shouldRebuild && toNonNegativeInteger(sampleCount) !== summarySampleCount) {
      sampleCount = await TelemetrySample.countDocuments({});
      shouldRebuild = shouldRebuildSourceSummaries({
        summaryCount,
        sampleCount,
        summarySampleCount
      });
    }

    if (!shouldRebuild) {
      return {
        rebuilt: false,
        summaryCount,
        sampleCount,
        summarySampleCount
      };
    }

    const result = await this.rebuildSourceSummaries();
    return {
      rebuilt: true,
      summaryCount: result.sourceCount,
      rebuiltAt: result.rebuiltAt
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
    let snapshots = await TelemetrySourceSummary.find({})
      .sort({ lastSampleAt: -1 })
      .lean();

    if (snapshots.length === 0) {
      await this.ensureSourceSummaries();
      snapshots = await TelemetrySourceSummary.find({})
        .sort({ lastSampleAt: -1 })
        .lean();
    }

    return snapshots
      .map((snapshot) => buildSourceSummaryFromSnapshot(snapshot))
      .filter(Boolean);
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
    ]).option({ maxTimeMS: TEMPEST_MODULE_AGGREGATE_MAX_TIME_MS });

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
    ]).option({ maxTimeMS: TEMPEST_MODULE_AGGREGATE_MAX_TIME_MS });

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
    ]).option({ maxTimeMS: TEMPEST_MODULE_AGGREGATE_MAX_TIME_MS });

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
    const resolvedSourceKey = resolveTelemetrySourceKey({
      sourceKey,
      sourceType: 'tempest_station',
      sourceId
    });
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
    const [sources, storage, disk] = await Promise.all([
      this.listSourceSummaries(),
      this.getStorageFootprint(),
      resourceMonitorService.getDiskUsage()
    ]);
    const sourceBreakdowns = summarizeSourceBreakdowns(sources);

    return {
      retentionDays: RETENTION_DAYS,
      totalSamples: sourceBreakdowns.totalSamples,
      sourceCount: sources.length,
      lastSampleAt: sourceBreakdowns.lastSampleAt,
      streamCounts: sourceBreakdowns.streamCounts,
      sourceTypeCounts: sourceBreakdowns.sourceTypeCounts,
      storage,
      disk: normalizeDiskCapacity(disk),
      sources
    };
  }

  async resolveSourceSummary({ sourceKey, sourceType, sourceId } = {}) {
    const resolvedSourceKey = resolveTelemetrySourceKey({ sourceKey, sourceType, sourceId });

    if (!resolvedSourceKey) {
      throw new Error('A telemetry source is required.');
    }

    let snapshot = await TelemetrySourceSummary.findOne({ sourceKey: resolvedSourceKey }).lean();
    let sourceSummary = buildSourceSummaryFromSnapshot(snapshot);
    if (sourceSummary) {
      return sourceSummary;
    }

    await this.ensureSourceSummaries();

    snapshot = await TelemetrySourceSummary.findOne({ sourceKey: resolvedSourceKey }).lean();
    sourceSummary = buildSourceSummaryFromSnapshot(snapshot);
    if (sourceSummary) {
      return sourceSummary;
    }

    const latestEntry = await TelemetrySample.aggregate([
      { $match: { sourceKey: resolvedSourceKey } },
      { $sort: { sourceKey: 1, recordedAt: -1 } },
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
    const resolvedSourceKey = resolveTelemetrySourceKey({ sourceKey, sourceType, sourceId });

    if (!resolvedSourceKey) {
      const [
        telemetryResult,
        energyResult,
        tempestObservationResult,
        tempestEventResult,
        rainMachineDailyStatResult,
        rainMachineWateringDayResult,
        senseMonitorSnapshotResult,
        senseTrendSnapshotResult,
        sourceSummaryResult
      ] = await Promise.all([
        TelemetrySample.deleteMany({}),
        DeviceEnergySample.deleteMany({}),
        TempestObservation.deleteMany({}),
        TempestEvent.deleteMany({}),
        RainMachineDailyStat.deleteMany({}),
        RainMachineWateringDay.deleteMany({}),
        SenseMonitorSnapshot.deleteMany({}),
        SenseTrendSnapshot.deleteMany({}),
        TelemetrySourceSummary.deleteMany({})
      ]);

      return {
        scope: 'all',
        telemetryDeleted: telemetryResult.deletedCount || 0,
        energyDeleted: energyResult.deletedCount || 0,
        tempestObservationsDeleted: tempestObservationResult.deletedCount || 0,
        tempestEventsDeleted: tempestEventResult.deletedCount || 0,
        rainMachineDailyStatsDeleted: rainMachineDailyStatResult.deletedCount || 0,
        rainMachineWateringDaysDeleted: rainMachineWateringDayResult.deletedCount || 0,
        senseMonitorSnapshotsDeleted: senseMonitorSnapshotResult.deletedCount || 0,
        senseTrendSnapshotsDeleted: senseTrendSnapshotResult.deletedCount || 0,
        sourceSummariesDeleted: sourceSummaryResult.deletedCount || 0
      };
    }

    const summary = await this.resolveSourceSummary({ sourceKey: resolvedSourceKey });
    const telemetryResult = await TelemetrySample.deleteMany({ sourceKey: summary.sourceKey });
    const sourceSummaryResult = await TelemetrySourceSummary.deleteOne({ sourceKey: summary.sourceKey });

    let energyDeleted = 0;
    let tempestObservationsDeleted = 0;
    let tempestEventsDeleted = 0;
    let rainMachineDailyStatsDeleted = 0;
    let rainMachineWateringDaysDeleted = 0;
    let senseMonitorSnapshotsDeleted = 0;
    let senseTrendSnapshotsDeleted = 0;

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

    if (summary.sourceType === 'rainmachine_report') {
      if (summary.sourceKey.endsWith(':daily_stats')) {
        const dailyResult = await RainMachineDailyStat.deleteMany({ controllerId: summary.sourceId });
        rainMachineDailyStatsDeleted = dailyResult.deletedCount || 0;
      }

      if (summary.sourceKey.endsWith(':watering_log')) {
        const wateringResult = await RainMachineWateringDay.deleteMany({ controllerId: summary.sourceId });
        rainMachineWateringDaysDeleted = wateringResult.deletedCount || 0;
      }
    }

    if (summary.sourceType === 'sense_monitor' || summary.sourceType === 'sense_device') {
      const sourceDevice = await Device.findById(summary.sourceId).lean();
      const monitorId = sourceDevice?.properties?.sense?.monitorId;

      if (summary.sourceType === 'sense_monitor' && monitorId) {
        const [monitorSnapshotResult, trendSnapshotResult] = await Promise.all([
          SenseMonitorSnapshot.deleteMany({ monitorId }),
          SenseTrendSnapshot.deleteMany({ monitorId })
        ]);
        senseMonitorSnapshotsDeleted = monitorSnapshotResult.deletedCount || 0;
        senseTrendSnapshotsDeleted = trendSnapshotResult.deletedCount || 0;
      }

      if (summary.sourceType === 'sense_device' && monitorId) {
        const trendSnapshotResult = await SenseTrendSnapshot.updateMany(
          { monitorId },
          {
            $pull: {
              deviceBreakdown: {
                senseDeviceId: sourceDevice?.properties?.sense?.senseDeviceId
              }
            }
          }
        );
        senseTrendSnapshotsDeleted = trendSnapshotResult.modifiedCount || trendSnapshotResult.nModified || 0;
      }
    }

    return {
      scope: summary.sourceKey,
      telemetryDeleted: telemetryResult.deletedCount || 0,
      energyDeleted,
      tempestObservationsDeleted,
      tempestEventsDeleted,
      rainMachineDailyStatsDeleted,
      rainMachineWateringDaysDeleted,
      senseMonitorSnapshotsDeleted,
      senseTrendSnapshotsDeleted,
      sourceSummariesDeleted: sourceSummaryResult.deletedCount || 0
    };
  }
}

const telemetryService = new TelemetryService();

module.exports = telemetryService;
module.exports.TelemetryService = TelemetryService;
module.exports.__private__ = {
  buildSourceTimelineEvents,
  buildSourceSummaryFromSnapshot,
  buildMetricDescriptors,
  buildMetricStats,
  downsamplePoints,
  extractDeviceMetrics,
  extractTempestMetrics,
  flattenMetricKeySets,
  inferRequestedHoursFromPrompt,
  inferMetricLabel,
  inferMetricUnit,
  isBinaryMetric,
  mapSettledWithConcurrency,
  mergePointsByTimestamp,
  normalizeDiskCapacity,
  normalizeMetricKeys,
  normalizeTelemetryLookupText,
  pickFeaturedMetricKeys,
  resolveTelemetrySourceKey,
  shouldRebuildSourceSummaries,
  summarizeSourceBreakdowns,
  summarizeStorageCollections
};

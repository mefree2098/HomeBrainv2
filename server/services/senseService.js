const { randomUUID } = require('crypto');
const axios = require('axios');
const WebSocket = require('ws');
const Device = require('../models/Device');
const SenseIntegration = require('../models/SenseIntegration');
const SenseMonitorSnapshot = require('../models/SenseMonitorSnapshot');
const SenseTrendSnapshot = require('../models/SenseTrendSnapshot');
const deviceEnergySampleService = require('./deviceEnergySampleService');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const {
  describeDevices,
  mergeDuplicateDeviceGroups,
  selectCanonicalDevice
} = require('./deviceIdentityService');

const SENSE_API_BASE = 'https://api.sense.com/apiservice/api/v1/';
const SENSE_WS_BASE = 'wss://clientrt.sense.com/monitors';
const DEFAULT_HTTP_TIMEOUT_MS = Math.max(5000, Number(process.env.SENSE_HTTP_TIMEOUT_MS || 12000));
const DEFAULT_POLL_INTERVAL_SECONDS = Math.max(5, Number(process.env.SENSE_POLL_INTERVAL_SECONDS || 10));
const DEFAULT_TREND_SYNC_INTERVAL_MINUTES = Math.max(5, Number(process.env.SENSE_TREND_SYNC_INTERVAL_MINUTES || 15));
const SENSE_FAILURE_BACKOFF_BASE_MS = Math.max(
  30_000,
  Number(process.env.SENSE_FAILURE_BACKOFF_BASE_MS || 60_000)
);
const SENSE_FAILURE_BACKOFF_MAX_MS = Math.max(
  SENSE_FAILURE_BACKOFF_BASE_MS,
  Number(process.env.SENSE_FAILURE_BACKOFF_MAX_MS || 10 * 60_000)
);
const DEFAULT_ELECTRICITY_RATE_CENTS_PER_KWH = Number.isFinite(Number(process.env.SENSE_ELECTRICITY_RATE_CENTS_PER_KWH))
  ? Math.max(0, Number(process.env.SENSE_ELECTRICITY_RATE_CENTS_PER_KWH))
  : 11;
const DEFAULT_ALWAYS_ON_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_DEVICE_CATALOG_CACHE_MS = 60 * 60 * 1000;
const MAX_DASHBOARD_HOURS = 24 * 14;
const MAX_DASHBOARD_POINTS = 360;
const WEBSOCKET_STATE_PERSIST_INTERVAL_MS = Math.max(5000, Number(process.env.SENSE_WS_STATE_PERSIST_INTERVAL_MS || 30000));
const SENSE_STATUS_SNAPSHOT_SELECT = 'observedAt powerW solarW netW alwaysOnW activeDeviceCount';
const SENSE_STATUS_TREND_SELECT = 'scale startAt syncedAt consumptionTotalKwh productionTotalKwh productionPct netProductionKwh fromGridKwh toGridKwh solarPoweredPct';
const SENSE_DASHBOARD_SNAPSHOT_SELECT = 'observedAt powerW solarW netW alwaysOnW otherW untrackedW activeDeviceCount frequencyHz voltage activeDevices';
const SENSE_DASHBOARD_TREND_SELECT = 'scale startAt syncedAt consumptionTotalKwh productionTotalKwh productionPct netProductionKwh fromGridKwh toGridKwh solarPoweredPct deviceBreakdown';
const SCALE_ORDER = ['day', 'week', 'month', 'year', 'cycle'];
const SCALE_TO_API = {
  day: 'DAY',
  week: 'WEEK',
  month: 'MONTH',
  year: 'YEAR',
  cycle: 'CYCLE'
};

const trimString = (value, fallback = '') => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || fallback;
  }

  if (value == null) {
    return fallback;
  }

  const trimmed = String(value).trim();
  return trimmed || fallback;
};

const clampInteger = (value, fallback, minimum, maximum) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(minimum, Math.min(maximum, Math.trunc(numeric)));
};

const clampDecimal = (value, fallback, minimum, maximum, digits = 4) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const bounded = Math.max(minimum, Math.min(maximum, numeric));
  const multiplier = 10 ** digits;
  return Math.round(bounded * multiplier) / multiplier;
};

const roundNumber = (value, digits = 2) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const multiplier = 10 ** digits;
  return Math.round(numeric * multiplier) / multiplier;
};

const sanitizeElectricityRateCentsPerKwh = (value, fallback = DEFAULT_ELECTRICITY_RATE_CENTS_PER_KWH) => clampDecimal(
  value,
  fallback,
  0,
  500,
  4
);

const calculateCostUsd = (energyKwh, rateCentsPerKwh) => {
  const energy = Number(energyKwh);
  const rateCents = Number(rateCentsPerKwh);
  if (!Number.isFinite(energy) || !Number.isFinite(rateCents)) {
    return null;
  }

  return roundNumber((energy * rateCents) / 100, 2);
};

const calculateCurrentCostRateUsdPerHour = (powerW, rateCentsPerKwh) => {
  const watts = Number(powerW);
  const rateCents = Number(rateCentsPerKwh);
  if (!Number.isFinite(watts) || !Number.isFinite(rateCents)) {
    return null;
  }

  return roundNumber(((watts / 1000) * rateCents) / 100, 4);
};

const getUtcMonthStart = (value) => new Date(Date.UTC(
  value.getUTCFullYear(),
  value.getUTCMonth(),
  1
));

const getUtcDaysInMonth = (value) => new Date(Date.UTC(
  value.getUTCFullYear(),
  value.getUTCMonth() + 1,
  0
)).getUTCDate();

const resolveMonthProjectionContext = (startAt, now = new Date()) => {
  const referenceNow = parseOptionalDate(now) || new Date();
  let resolvedStartAt = parseOptionalDate(startAt);

  if (!resolvedStartAt || resolvedStartAt > referenceNow) {
    resolvedStartAt = getUtcMonthStart(referenceNow);
  }

  const daysInMonth = getUtcDaysInMonth(resolvedStartAt);
  const elapsedMs = Math.max(60 * 60 * 1000, referenceNow.getTime() - resolvedStartAt.getTime());

  return {
    startAt: resolvedStartAt,
    daysInMonth,
    elapsedDays: elapsedMs / (24 * 60 * 60 * 1000),
    projectionFactor: daysInMonth / (elapsedMs / (24 * 60 * 60 * 1000))
  };
};

const projectMonthlyEnergyWindow = ({
  monthEnergyKwh = null,
  dayEnergyKwh = null,
  monthStartAt = null,
  now = new Date()
} = {}) => {
  const monthEnergy = Number(monthEnergyKwh);
  if (Number.isFinite(monthEnergy) && monthEnergy >= 0) {
    const context = resolveMonthProjectionContext(monthStartAt, now);
    return {
      monthToDateKwh: roundNumber(monthEnergy, 4),
      projectedMonthKwh: roundNumber(Math.max(monthEnergy, monthEnergy * context.projectionFactor), 4),
      daysElapsed: roundNumber(context.elapsedDays, 2),
      daysInMonth: context.daysInMonth,
      method: 'month-to-date'
    };
  }

  const dayEnergy = Number(dayEnergyKwh);
  if (Number.isFinite(dayEnergy) && dayEnergy >= 0) {
    const referenceNow = parseOptionalDate(now) || new Date();
    const daysInMonth = getUtcDaysInMonth(referenceNow);
    return {
      monthToDateKwh: null,
      projectedMonthKwh: roundNumber(dayEnergy * daysInMonth, 4),
      daysElapsed: null,
      daysInMonth,
      method: 'daily-run-rate'
    };
  }

  return {
    monthToDateKwh: null,
    projectedMonthKwh: null,
    daysElapsed: null,
    daysInMonth: null,
    method: 'unavailable'
  };
};

const decorateTrendWindowWithCost = (trend = null, rateCentsPerKwh = DEFAULT_ELECTRICITY_RATE_CENTS_PER_KWH) => {
  if (!trend || typeof trend !== 'object') {
    return trend;
  }

  return {
    ...trend,
    costUsd: calculateCostUsd(trend.consumptionTotalKwh, rateCentsPerKwh)
  };
};

const decorateDeviceUsageWindowWithCost = (window = null, rateCentsPerKwh = DEFAULT_ELECTRICITY_RATE_CENTS_PER_KWH) => {
  if (!window || typeof window !== 'object') {
    return window;
  }

  return {
    ...window,
    costUsd: calculateCostUsd(window.energyKwh, rateCentsPerKwh)
  };
};

const parseOptionalDate = (value) => {
  if (!value) {
    return null;
  }

  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const safeArray = (value) => Array.isArray(value) ? value : [];

const asPlainObject = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const pickFirstString = (...values) => {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) {
      return trimmed;
    }
  }

  return '';
};

const pickFirstNumber = (...values) => {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
};

const sumNumbers = (values = []) => values.reduce((total, value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? total + numeric : total;
}, 0);

const buildSenseDeviceId = () => randomUUID().replace(/-/g, '');

const normalizeMonitorOptions = (monitors = []) => safeArray(monitors)
  .map((entry) => {
    const monitor = asPlainObject(entry);
    const monitorId = pickFirstString(monitor.id, monitor.monitor_id, monitor.monitorId);
    if (!monitorId) {
      return null;
    }

    return {
      id: monitorId,
      name: pickFirstString(monitor.name, monitor.monitor_name, `Sense Monitor ${monitorId.slice(0, 6)}`),
      timezone: pickFirstString(monitor.timezone, monitor.tz),
      solarConfigured: monitor.solar_configured === true || monitor.solarConfigured === true
    };
  })
  .filter(Boolean);

const normalizeMonitorOverview = (payload = {}) => {
  const overview = asPlainObject(payload.monitor_overview || payload.monitorOverview || payload);
  const monitor = asPlainObject(overview.monitor || overview);
  const monitorId = pickFirstString(monitor.id, monitor.monitor_id, monitor.monitorId);

  return {
    monitorId,
    name: pickFirstString(monitor.name, monitor.monitor_name, monitorId ? `Sense Monitor ${monitorId.slice(0, 6)}` : 'Sense Monitor'),
    solarConfigured: monitor.solar_configured === true || monitor.solarConfigured === true,
    timezone: pickFirstString(monitor.timezone, monitor.tz),
    serialNumber: pickFirstString(monitor.serial_number, monitor.serialNumber),
    model: pickFirstString(monitor.model, monitor.monitor_type, 'Home Energy Monitor'),
    wifiStrengthDbm: pickFirstNumber(monitor.wifi_strength_dbm, monitor.wifiStrengthDbm),
    raw: overview
  };
};

const resolveCatalogRoom = (entry = {}) => pickFirstString(
  entry.location_name,
  entry.room,
  entry.location?.name,
  entry.location?.label,
  entry.location?.display_name
);

const normalizeCatalogDevice = (raw = {}) => {
  const entry = asPlainObject(raw);
  const senseDeviceId = pickFirstString(entry.id, entry.device_id, entry.deviceId);
  if (!senseDeviceId) {
    return null;
  }

  return {
    senseDeviceId,
    name: pickFirstString(entry.name, entry.alias, entry.display_name, `Device ${senseDeviceId}`),
    icon: pickFirstString(entry.icon, entry.device_icon, entry.image),
    room: resolveCatalogRoom(entry),
    make: pickFirstString(entry.make, entry.manufacturer, 'Sense'),
    model: pickFirstString(entry.model, entry.device_type, 'Detected Load'),
    alwaysOn: pickFirstString(entry.name, entry.alias).toLowerCase() === 'always on',
    raw: entry
  };
};

const extractAlwaysOnWatts = (payload = {}) => {
  const root = asPlainObject(payload);
  const candidates = [
    root.w,
    root.avg_w,
    root.power_w,
    root.always_on_w,
    root.alwaysOnW,
    root.total?.w,
    root.total?.avg_w,
    root.total?.always_on_w,
    root.always_on?.w,
    root.always_on?.avg_w,
    root.always_on?.always_on_w
  ];

  const numeric = pickFirstNumber(...candidates);
  if (numeric !== null) {
    return roundNumber(numeric, 1);
  }

  const devices = safeArray(root.devices || root.device_breakdown);
  const alwaysOn = devices.find((device) => pickFirstString(device.name, device.alias).toLowerCase() === 'always on');
  return roundNumber(pickFirstNumber(alwaysOn?.w, alwaysOn?.power_w), 1);
};

function normalizeRealtimePayload(payload = {}, options = {}) {
  const root = asPlainObject(payload);
  const observedAt = parseOptionalDate(root.time || root.created_at || root.recordedAt) || new Date();
  const deviceCatalog = options.deviceCatalog instanceof Map ? options.deviceCatalog : new Map();
  const rawDevices = safeArray(root.devices);
  const powerW = roundNumber(pickFirstNumber(root.w, root.total_w, root.power_w, root.active_power) || 0, 1) || 0;
  const solarW = roundNumber(pickFirstNumber(root.solar_w, root.production_w) || 0, 1) || 0;
  const voltage = safeArray(root.voltage)
    .map((value) => roundNumber(value, 1))
    .filter((value) => value !== null);
  const frequencyHz = roundNumber(pickFirstNumber(root.hz, root.frequency_hz, root.frequency), 2);

  const activeDevices = rawDevices
    .map((entry) => {
      const device = asPlainObject(entry);
      const senseDeviceId = pickFirstString(device.id, device.device_id, device.deviceId);
      if (!senseDeviceId) {
        return null;
      }

      const power = roundNumber(pickFirstNumber(device.w, device.power_w, device.power) || 0, 1) || 0;
      const catalog = deviceCatalog.get(senseDeviceId) || {};
      return {
        senseDeviceId,
        name: pickFirstString(device.name, catalog.name, `Device ${senseDeviceId}`),
        icon: pickFirstString(device.icon, catalog.icon),
        powerW: power,
        alwaysOn: catalog.alwaysOn === true || pickFirstString(device.name).toLowerCase() === 'always on',
        synthetic: false
      };
    })
    .filter(Boolean)
    .filter((entry) => entry.powerW > 0.05)
    .sort((left, right) => right.powerW - left.powerW);

  const activeDevicePowerW = roundNumber(sumNumbers(activeDevices.map((entry) => entry.powerW)), 1) || 0;
  const alwaysOnW = extractAlwaysOnWatts(options.alwaysOnInfo || {});
  const otherW = roundNumber(Math.max(0, powerW - activeDevicePowerW), 1) || 0;
  const displayDevices = [...activeDevices];

  if (otherW >= 10) {
    displayDevices.push({
      senseDeviceId: 'sense-other',
      name: 'Other',
      icon: 'other',
      powerW: otherW,
      alwaysOn: false,
      synthetic: true
    });
  }

  const devicesWithShare = displayDevices
    .map((entry) => ({
      ...entry,
      sharePct: powerW > 0
        ? roundNumber((entry.powerW / powerW) * 100, 1)
        : 0
    }))
    .sort((left, right) => right.powerW - left.powerW);

  return {
    monitorId: pickFirstString(options.monitorId),
    monitorName: pickFirstString(options.monitorName, 'Sense Monitor'),
    observedAt,
    powerW,
    solarW,
    netW: roundNumber(powerW - solarW, 1) || 0,
    alwaysOnW,
    otherW,
    untrackedW: otherW,
    activeDeviceCount: activeDevices.length,
    frequencyHz,
    voltage,
    activeDevices: devicesWithShare,
    metadata: {
      source: pickFirstString(options.source, 'http'),
      rawDeviceCount: rawDevices.length
    }
  };
}

function normalizeTrendSnapshot(scale, usagePayload = {}, solarPayload = {}) {
  const usage = asPlainObject(usagePayload);
  const solar = asPlainObject(solarPayload);
  const deviceBreakdown = safeArray(usage.device_breakdown || usage.consumption?.devices)
    .map((entry) => {
      const device = asPlainObject(entry);
      const senseDeviceId = pickFirstString(device.id, device.device_id, device.deviceId);
      if (!senseDeviceId) {
        return null;
      }

      const totalKwh = roundNumber(
        pickFirstNumber(
          device.consumption?.usage_total_kwh,
          device.total_kwh,
          device.usage_total_kwh
        ) || 0,
        4
      ) || 0;

      return {
        senseDeviceId,
        name: pickFirstString(device.name, device.alias, `Device ${senseDeviceId}`),
        icon: pickFirstString(device.icon, device.device_icon),
        totalKwh
      };
    })
    .filter(Boolean);

  const consumptionTotalKwh = roundNumber(
    pickFirstNumber(
      usage.consumption?.usage_total_kwh,
      usage.consumption?.total,
      usage.usage_total_kwh,
      usage.total
    ) || 0,
    4
  ) || 0;
  const productionTotalKwh = roundNumber(
    pickFirstNumber(
      solar.total?.production_kwh,
      solar.production?.total,
      solar.production_kwh
    ) || 0,
    4
  ) || 0;
  const fromGridKwh = roundNumber(pickFirstNumber(solar.total?.from_grid_kwh, solar.from_grid_kwh), 4);
  const toGridKwh = roundNumber(pickFirstNumber(solar.total?.to_grid_kwh, solar.to_grid_kwh), 4);
  const netProductionKwh = roundNumber(pickFirstNumber(solar.total?.net_kwh, solar.net_kwh), 4);
  const solarPoweredPct = roundNumber(pickFirstNumber(solar.total?.solar_percentage, solar.solar_percentage), 2);
  const productionPct = roundNumber(
    pickFirstNumber(
      solar.total?.production_percentage,
      solar.production_pct,
      consumptionTotalKwh > 0 ? (productionTotalKwh / consumptionTotalKwh) * 100 : null
    ),
    2
  );

  const deviceBreakdownWithShare = deviceBreakdown
    .map((entry) => ({
      ...entry,
      sharePct: consumptionTotalKwh > 0
        ? roundNumber((entry.totalKwh / consumptionTotalKwh) * 100, 2)
        : null
    }))
    .sort((left, right) => right.totalKwh - left.totalKwh);

  return {
    scale,
    startAt: parseOptionalDate(usage.start || solar.start) || new Date(),
    syncedAt: new Date(),
    consumptionTotalKwh,
    productionTotalKwh,
    productionPct,
    netProductionKwh,
    fromGridKwh,
    toGridKwh,
    solarPoweredPct,
    deviceBreakdown: deviceBreakdownWithShare,
    metadata: {
      usageDeviceCount: deviceBreakdownWithShare.length,
      solarPresent: Object.keys(solar).length > 0
    }
  };
}

function downsampleSnapshots(points = [], maxPoints = MAX_DASHBOARD_POINTS) {
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

      if (sampled[sampled.length - 1]?.observedAt?.getTime?.() !== point?.observedAt?.getTime?.()) {
        sampled.push(point);
      }
    }
  }

  const lastPoint = points[lastIndex];
  if (sampled[sampled.length - 1]?.observedAt?.getTime?.() !== lastPoint?.observedAt?.getTime?.()) {
    sampled.push(lastPoint);
  }

  return sampled;
}

function buildTrendSummaryMap(trendDocs = []) {
  const monitor = {};
  const devices = new Map();

  trendDocs.forEach((doc) => {
    if (!doc?.scale) {
      return;
    }

    monitor[doc.scale] = {
      startAt: doc.startAt,
      syncedAt: doc.syncedAt,
      consumptionTotalKwh: doc.consumptionTotalKwh,
      productionTotalKwh: doc.productionTotalKwh,
      productionPct: doc.productionPct,
      netProductionKwh: doc.netProductionKwh,
      fromGridKwh: doc.fromGridKwh,
      toGridKwh: doc.toGridKwh,
      solarPoweredPct: doc.solarPoweredPct
    };

    safeArray(doc.deviceBreakdown).forEach((entry) => {
      const senseDeviceId = pickFirstString(entry.senseDeviceId);
      if (!senseDeviceId) {
        return;
      }

      const existing = devices.get(senseDeviceId) || {
        senseDeviceId,
        name: pickFirstString(entry.name),
        icon: pickFirstString(entry.icon)
      };

      existing[doc.scale] = {
        energyKwh: roundNumber(entry.totalKwh, 4),
        sharePct: roundNumber(entry.sharePct, 2)
      };
      if (!existing.name) {
        existing.name = pickFirstString(entry.name);
      }
      if (!existing.icon) {
        existing.icon = pickFirstString(entry.icon);
      }

      devices.set(senseDeviceId, existing);
    });
  });

  return { monitor, devices };
}

class SenseService {
  constructor() {
    this.backgroundEnabled = process.env.NODE_ENV !== 'test';
    this.initialized = false;
    this.initializing = null;
    this.refreshPromise = null;
    this.pollTimer = null;
    this.pollIntervalMs = 0;
    this.websocket = null;
    this.websocketReconnectTimer = null;
    this.websocketReconnectAttempt = 0;
    this.websocketMonitorId = '';
    this.latestRealtimeSummary = null;
    this.latestTrendSummary = {
      monitor: {},
      devices: new Map()
    };
    this.lastPersistedRealtimeAt = 0;
    this.lastRealtimeStatePersistAt = 0;
    this.lastCatalogSyncAt = 0;
    this.lastAlwaysOnFetchAt = 0;
    this.cachedAlwaysOnInfo = null;
    this.deviceCatalog = new Map();
    this.consecutiveRefreshFailures = 0;
    this.failureBackoffUntil = 0;
    this.failureBackoffMs = 0;
  }

  async initialize() {
    if (!this.backgroundEnabled) {
      return;
    }

    if (this.initialized) {
      return;
    }

    if (this.initializing) {
      return this.initializing;
    }

    this.initializing = (async () => {
      await this.refreshRuntime({
        reason: 'initialize',
        forceRealtime: true,
        forceTrend: true
      });
      await this.ensurePollTimer();
      this.initialized = true;
      this.initializing = null;
    })().catch((error) => {
      this.initializing = null;
      throw error;
    });

    return this.initializing;
  }

  async shutdown() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.pollIntervalMs = 0;
    this.stopWebSocket({ resetMonitor: true });
    this.initialized = false;
    this.initializing = null;
    this.refreshPromise = null;
    this.resetRefreshFailureBackoff();
  }

  resetRefreshFailureBackoff() {
    this.consecutiveRefreshFailures = 0;
    this.failureBackoffUntil = 0;
    this.failureBackoffMs = 0;
  }

  noteRefreshFailure() {
    this.consecutiveRefreshFailures += 1;
    const exponent = Math.max(0, this.consecutiveRefreshFailures - 1);
    const nextBackoffMs = Math.min(
      SENSE_FAILURE_BACKOFF_MAX_MS,
      SENSE_FAILURE_BACKOFF_BASE_MS * (2 ** exponent)
    );
    this.failureBackoffMs = nextBackoffMs;
    this.failureBackoffUntil = Date.now() + nextBackoffMs;
    return nextBackoffMs;
  }

  getRefreshBackoffRemainingMs(now = Date.now()) {
    const remainingMs = this.failureBackoffUntil - now;
    return Math.max(0, Number.isFinite(remainingMs) ? remainingMs : 0);
  }

  async ensurePollTimer() {
    if (!this.backgroundEnabled) {
      return;
    }

    const integration = await SenseIntegration.getIntegration();
    const enabled = integration.enabled === true;
    const requestedIntervalMs = Math.max(
      5000,
      clampInteger(
        integration.pollIntervalSeconds,
        DEFAULT_POLL_INTERVAL_SECONDS,
        5,
        300
      ) * 1000
    );
    const backoffRemainingMs = this.getRefreshBackoffRemainingMs();
    const nextIntervalMs = Math.max(requestedIntervalMs, backoffRemainingMs);

    if (!enabled) {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.pollIntervalMs = 0;
      return;
    }

    if (this.pollTimer && this.pollIntervalMs === nextIntervalMs) {
      return;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.pollIntervalMs = nextIntervalMs;
    this.pollTimer = setInterval(() => {
      this.refreshRuntime({ reason: 'scheduled-poll' }).catch((error) => {
        console.warn(`SenseService: scheduled refresh failed: ${error.message}`);
      });
    }, nextIntervalMs);

    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  async refreshRuntime({ reason = 'manual', forceRealtime = false, forceTrend = false, mfaCode = '' } = {}) {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.performRefresh({ reason, forceRealtime, forceTrend, mfaCode })
      .then((result) => {
        this.resetRefreshFailureBackoff();
        return result;
      }, (error) => {
        this.noteRefreshFailure(error);
        throw error;
      })
      .finally(async () => {
        this.refreshPromise = null;
        try {
          await this.ensurePollTimer();
        } catch (error) {
          console.warn(`SenseService: failed to refresh poll timer: ${error.message}`);
        }
      });

    return this.refreshPromise;
  }

  async performRefresh({ reason = 'manual', forceRealtime = false, forceTrend = false, mfaCode = '' } = {}) {
    const integration = await this.resolvePersistedIntegration();

    if (!integration.enabled) {
      integration.isConnected = false;
      integration.lastError = '';
      integration.websocket = {
        ...(integration.websocket || {}),
        connected: false
      };
      await integration.save();
      this.stopWebSocket({ resetMonitor: true });

      return {
        success: true,
        skipped: true,
        reason: 'integration-disabled'
      };
    }

    if (!trimString(integration.email) && !trimString(integration.refreshToken)) {
      integration.isConnected = false;
      integration.lastError = 'Sense account email is required.';
      await integration.save();
      throw new Error(integration.lastError);
    }

    if (!trimString(integration.password) && !trimString(integration.refreshToken)) {
      integration.isConnected = false;
      integration.lastError = 'Sense account password is required.';
      await integration.save();
      throw new Error(integration.lastError);
    }

    try {
      await this.ensureAuthenticated(integration, { mfaCode });
      const overview = await this.syncMonitorOverview(integration, { force: forceTrend || reason === 'initialize' });
      await this.syncDeviceCatalog(integration, {
        force: forceTrend || !this.lastCatalogSyncAt || (Date.now() - this.lastCatalogSyncAt) >= DEFAULT_DEVICE_CATALOG_CACHE_MS
      });

      if (integration.realtimeEnabled) {
        this.startWebSocket(integration);
      } else {
        this.stopWebSocket({ resetMonitor: true });
      }

      const latestRealtimeAt = parseOptionalDate(this.latestRealtimeSummary?.observedAt);
      const shouldRefreshRealtime = forceRealtime
        || !integration.realtimeEnabled
        || !this.latestRealtimeSummary
        || this.latestRealtimeSummary.monitorId !== integration.monitorId
        || !latestRealtimeAt
        || (Date.now() - latestRealtimeAt.getTime()) > (this.pollIntervalMs * 2 || 20000);

      if (shouldRefreshRealtime) {
        const realtimePayload = await this.requestRealtimeUpdate(integration);
        await this.ingestRealtimePayload(integration, realtimePayload, {
          source: 'http',
          forcePersist: true
        });
      }

      if (this.shouldSyncTrends(integration, forceTrend)) {
        await this.syncTrendData(integration);
      }

      integration.monitorName = overview.name || integration.monitorName;
      integration.solarConfigured = overview.solarConfigured === true;
      integration.isConnected = true;
      integration.lastSyncAt = new Date();
      integration.lastError = '';
      await integration.save();

      return {
        success: true,
        integration,
        overview
      };
    } catch (error) {
      integration.isConnected = false;
      integration.lastError = error.message || 'Sense sync failed';
      integration.websocket = {
        ...(integration.websocket || {}),
        connected: false
      };
      await integration.save();
      throw error;
    }
  }

  shouldSyncTrends(integration, forceTrend) {
    if (forceTrend) {
      return true;
    }

    const lastTrendSyncAt = parseOptionalDate(integration.lastTrendSyncAt);
    if (!lastTrendSyncAt) {
      return true;
    }

    const intervalMs = Math.max(
      DEFAULT_TREND_SYNC_INTERVAL_MINUTES,
      clampInteger(
        integration.trendSyncIntervalMinutes,
        DEFAULT_TREND_SYNC_INTERVAL_MINUTES,
        5,
        1440
      )
    ) * 60 * 1000;

    return (Date.now() - lastTrendSyncAt.getTime()) >= intervalMs;
  }

  async resolvePersistedIntegration() {
    const integration = await SenseIntegration.getIntegration();
    if (integration._id) {
      return integration;
    }

    const existing = await SenseIntegration.findOne();
    if (existing) {
      return existing;
    }

    const created = new SenseIntegration(SenseIntegration.getDefaultIntegration());
    await created.save();
    return created;
  }

  async ensureAuthenticated(integration, { mfaCode = '' } = {}) {
    if (trimString(integration.accessToken) && trimString(integration.monitorId)) {
      return integration;
    }

    if (trimString(integration.refreshToken) && trimString(integration.userId)) {
      try {
        await this.renewAuth(integration);
        return integration;
      } catch (error) {
        if (!trimString(integration.email) || !trimString(integration.password)) {
          throw error;
        }
      }
    }

    await this.authenticate(integration, { mfaCode });
    return integration;
  }

  async authenticate(integration, { mfaCode = '', persist = true } = {}) {
    const email = trimString(integration.email);
    const password = trimString(integration.password);
    if (!email || !password) {
      throw new Error('Sense account email and password are required.');
    }

    const deviceId = trimString(integration.deviceId) || buildSenseDeviceId();
    integration.deviceId = deviceId;

    const response = await this.postForm('authenticate', {
      email,
      password
    }, {
      deviceId,
      retryAuth: false
    }).catch(async (error) => {
      const responseData = error?.response?.data;
      if (error?.response?.status === 401 && responseData?.mfa_token) {
        const code = trimString(mfaCode);
        if (!code) {
          throw new Error('Sense multi-factor authentication code required. Save again with a fresh MFA code.');
        }

        return this.postForm('authenticate/mfa', {
          totp: code,
          mfa_token: responseData.mfa_token,
          client_time: new Date().toISOString()
        }, {
          deviceId,
          retryAuth: false
        });
      }

      throw error;
    });

    await this.applyAuthPayload(integration, response, { persist });
    return integration;
  }

  async renewAuth(integration) {
    if (!trimString(integration.userId) || !trimString(integration.refreshToken)) {
      throw new Error('Sense refresh token is not available. Re-authentication is required.');
    }

    const response = await this.postForm('renew', {
      user_id: integration.userId,
      refresh_token: integration.refreshToken
    }, {
      integration,
      deviceId: integration.deviceId,
      retryAuth: false
    });

    await this.applyAuthPayload(integration, response, { persist: true });
    return integration;
  }

  async applyAuthPayload(integration, payload, { persist = true } = {}) {
    const data = asPlainObject(payload);
    const monitors = normalizeMonitorOptions(data.monitors);

    integration.accessToken = trimString(data.access_token, integration.accessToken || '');
    integration.refreshToken = trimString(data.refresh_token, integration.refreshToken || '');
    integration.userId = trimString(data.user_id, integration.userId || '');
    integration.deviceId = trimString(integration.deviceId) || buildSenseDeviceId();
    integration.availableMonitors = monitors;
    integration.lastAuthenticatedAt = new Date();
    if (!trimString(integration.monitorId) && monitors[0]?.id) {
      integration.monitorId = monitors[0].id;
      integration.monitorName = monitors[0].name;
    } else if (trimString(integration.monitorId)) {
      const selectedMonitor = monitors.find((entry) => entry.id === integration.monitorId);
      if (selectedMonitor) {
        integration.monitorName = selectedMonitor.name;
      }
    }

    if (persist && integration._id) {
      await integration.save();
    }

    return integration;
  }

  buildHeaders({ integration, deviceId, includeAuth = true } = {}) {
    const resolvedDeviceId = trimString(deviceId, trimString(integration?.deviceId, '')) || buildSenseDeviceId();
    const headers = {
      'x-sense-device-id': resolvedDeviceId
    };

    if (includeAuth && trimString(integration?.accessToken)) {
      headers.Authorization = `bearer ${trimString(integration.accessToken)}`;
    }

    return headers;
  }

  async postForm(path, data = {}, options = {}) {
    const deviceId = trimString(options.deviceId, trimString(options.integration?.deviceId, '')) || buildSenseDeviceId();
    const payload = new URLSearchParams();
    Object.entries(data).forEach(([key, value]) => {
      if (value === undefined || value === null) {
        return;
      }
      payload.append(key, String(value));
    });

    const response = await axios.post(
      `${SENSE_API_BASE}${path}`,
      payload.toString(),
      {
        headers: {
          ...this.buildHeaders({
            integration: options.integration,
            deviceId,
            includeAuth: options.includeAuth !== false
          }),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: options.timeout || DEFAULT_HTTP_TIMEOUT_MS,
        validateStatus: () => true
      }
    );

    if (response.status >= 200 && response.status < 300) {
      return response.data;
    }

    const error = new Error(this.extractApiErrorMessage(response.data, `Sense API request failed (${response.status})`));
    error.response = response;
    throw error;
  }

  extractApiErrorMessage(payload, fallback = 'Sense API request failed') {
    const body = asPlainObject(payload);
    return pickFirstString(
      body.error_reason,
      body.error,
      body.message,
      body.statusText,
      fallback
    );
  }

  async requestApi(path, { integration, params, timeout = DEFAULT_HTTP_TIMEOUT_MS, retryAuth = true } = {}) {
    const response = await axios.get(
      `${SENSE_API_BASE}${path}`,
      {
        headers: this.buildHeaders({ integration, includeAuth: true }),
        params,
        timeout,
        validateStatus: () => true
      }
    );

    if (response.status >= 200 && response.status < 300) {
      return response.data;
    }

    if (retryAuth && (response.status === 401 || response.status === 403)) {
      let renewError = null;
      if (trimString(integration?.refreshToken) && trimString(integration?.userId)) {
        try {
          await this.renewAuth(integration);
          return this.requestApi(path, {
            integration,
            params,
            timeout,
            retryAuth: false
          });
        } catch (error) {
          renewError = error;
        }
      }

      if (trimString(integration?.email) && trimString(integration?.password)) {
        await this.authenticate(integration);
        return this.requestApi(path, {
          integration,
          params,
          timeout,
          retryAuth: false
        });
      }

      if (renewError) {
        throw renewError;
      }
    }

    throw new Error(this.extractApiErrorMessage(response.data, `Sense API request failed (${response.status})`));
  }

  async syncMonitorOverview(integration) {
    if (!trimString(integration.monitorId)) {
      const selectedMonitor = safeArray(integration.availableMonitors)[0];
      if (selectedMonitor?.id) {
        integration.monitorId = selectedMonitor.id;
        integration.monitorName = selectedMonitor.name;
      }
    }

    if (!trimString(integration.monitorId)) {
      throw new Error('Sense monitor ID is missing. Test or save the integration again to discover your monitor.');
    }

    const overviewPayload = await this.requestApi(
      `app/monitors/${integration.monitorId}/overview`,
      { integration }
    );
    const overview = normalizeMonitorOverview(overviewPayload);

    integration.monitorId = overview.monitorId || integration.monitorId;
    integration.monitorName = overview.name || integration.monitorName;
    integration.solarConfigured = overview.solarConfigured === true;
    integration.snapshot = {
      ...(integration.snapshot || {}),
      overview: {
        monitorId: overview.monitorId,
        name: overview.name,
        timezone: overview.timezone,
        serialNumber: overview.serialNumber,
        model: overview.model,
        wifiStrengthDbm: overview.wifiStrengthDbm,
        solarConfigured: overview.solarConfigured
      }
    };

    await integration.save();
    return overview;
  }

  async syncDeviceCatalog(integration, { force = false } = {}) {
    if (!force && this.deviceCatalog.size > 0 && (Date.now() - this.lastCatalogSyncAt) < DEFAULT_DEVICE_CATALOG_CACHE_MS) {
      return Array.from(this.deviceCatalog.values());
    }

    let rawDevices = null;
    try {
      rawDevices = await this.requestApi(`monitors/${integration.monitorId}/devices`, { integration });
    } catch (error) {
      rawDevices = await this.requestApi(`app/monitors/${integration.monitorId}/devices`, { integration });
    }

    const catalog = safeArray(rawDevices)
      .map((entry) => normalizeCatalogDevice(entry))
      .filter(Boolean);

    this.deviceCatalog = new Map(catalog.map((entry) => [entry.senseDeviceId, entry]));
    this.lastCatalogSyncAt = Date.now();

    await this.upsertSenseDevices({
      integration,
      summary: this.latestRealtimeSummary,
      emitUpdates: false
    });

    return catalog;
  }

  async fetchAlwaysOnInfo(integration, { force = false } = {}) {
    if (!force && this.cachedAlwaysOnInfo && (Date.now() - this.lastAlwaysOnFetchAt) < DEFAULT_ALWAYS_ON_CACHE_MS) {
      return this.cachedAlwaysOnInfo;
    }

    try {
      this.cachedAlwaysOnInfo = await this.requestApi(`app/monitors/${integration.monitorId}/devices/always_on`, { integration });
      this.lastAlwaysOnFetchAt = Date.now();
    } catch (error) {
      if (!this.cachedAlwaysOnInfo) {
        throw error;
      }
    }

    return this.cachedAlwaysOnInfo;
  }

  async requestRealtimeUpdate(integration) {
    return this.requestApi(`app/${integration.monitorId}/realtime_update`, { integration });
  }

  runBackgroundTask(label, task) {
    Promise.resolve()
      .then(() => task())
      .catch((error) => {
        console.warn(`SenseService: ${label} failed: ${error.message}`);
      });
  }

  startWebSocket(integration) {
    const monitorId = trimString(integration.monitorId);
    if (!monitorId || !trimString(integration.accessToken)) {
      return;
    }

    if (this.websocket && this.websocket.readyState === WebSocket.OPEN && this.websocketMonitorId === monitorId) {
      return;
    }

    this.stopWebSocket({ resetMonitor: false });
    this.websocketMonitorId = monitorId;

    const socket = new WebSocket(`${SENSE_WS_BASE}/${monitorId}/realtimefeed?access_token=${encodeURIComponent(integration.accessToken)}`);
    this.websocket = socket;

    socket.on('open', () => {
      this.websocketReconnectAttempt = 0;
      this.runBackgroundTask('websocket open state update', async () => {
        await this.updateRealtimeState(integration, {
          websocket: {
            connected: true,
            lastConnectedAt: new Date(),
            reconnectCount: 0
          },
          lastError: ''
        }, {
          forcePersist: true
        });
      });
    });

    socket.on('message', (raw) => {
      let payload = null;
      try {
        payload = JSON.parse(raw.toString());
      } catch (error) {
        console.warn(`SenseService: failed to parse websocket payload: ${error.message}`);
        return;
      }

      if (payload?.type === 'error') {
        this.runBackgroundTask('websocket error payload handling', async () => {
          await this.handleWebSocketError(integration, payload);
        });
        return;
      }

      if (payload?.type !== 'realtime_update') {
        return;
      }

      this.runBackgroundTask('websocket heartbeat update', async () => {
        await this.updateRealtimeState(integration, {
          websocket: {
            connected: true,
            lastMessageAt: new Date()
          },
          lastError: ''
        }, {
          throttlePersist: true
        });
      });

      void this.ingestRealtimePayload(integration, payload.payload || payload, {
        source: 'ws'
      }).catch((error) => {
        console.warn(`SenseService: websocket ingest failed: ${error.message}`);
      });
    });

    socket.on('close', () => {
      this.runBackgroundTask('websocket close state update', async () => {
        await this.updateRealtimeState(integration, {
          websocket: {
            connected: false
          }
        }, {
          forcePersist: true
        });
      });
      this.scheduleWebSocketReconnect();
    });

    socket.on('error', (error) => {
      console.warn(`SenseService: websocket error: ${error.message}`);
      this.runBackgroundTask('websocket error state update', async () => {
        await this.updateRealtimeState(integration, {
          websocket: {
            connected: false
          },
          lastError: error.message || 'Sense websocket error'
        }, {
          forcePersist: true
        });
      });
    });
  }

  async handleWebSocketError(integration, payload = {}) {
    const errorPayload = asPlainObject(payload.payload || payload);
    const authorized = errorPayload.authorized !== false;
    const message = pickFirstString(errorPayload.error_reason, errorPayload.message, 'Sense websocket error');

    await this.updateRealtimeState(integration, {
      websocket: {
        connected: false
      },
      lastError: message
    });

    if (!authorized) {
      try {
        await this.renewAuth(integration);
      } catch (error) {
        console.warn(`SenseService: websocket auth renewal failed: ${error.message}`);
      }
    }

    this.scheduleWebSocketReconnect();
  }

  scheduleWebSocketReconnect() {
    if (!this.backgroundEnabled || !this.websocketMonitorId) {
      return;
    }

    if (this.websocketReconnectTimer) {
      clearTimeout(this.websocketReconnectTimer);
      this.websocketReconnectTimer = null;
    }

    this.websocketReconnectAttempt += 1;
    const delay = Math.min(30000, 1500 * (2 ** (this.websocketReconnectAttempt - 1)));
    const jitter = Math.floor(Math.random() * 750);

    this.websocketReconnectTimer = setTimeout(async () => {
      this.websocketReconnectTimer = null;
      try {
        const integration = await this.resolvePersistedIntegration();
        if (!integration.enabled || !integration.realtimeEnabled) {
          return;
        }

        await this.updateRealtimeState(integration, {
          websocket: {
            reconnectCount: this.websocketReconnectAttempt
          }
        });
        this.startWebSocket(integration);
      } catch (error) {
        console.warn(`SenseService: websocket reconnect failed: ${error.message}`);
      }
    }, delay + jitter);

    if (typeof this.websocketReconnectTimer.unref === 'function') {
      this.websocketReconnectTimer.unref();
    }
  }

  stopWebSocket({ resetMonitor = true } = {}) {
    if (this.websocketReconnectTimer) {
      clearTimeout(this.websocketReconnectTimer);
      this.websocketReconnectTimer = null;
    }

    const socket = this.websocket;
    this.websocket = null;

    if (socket) {
      try {
        socket.removeAllListeners();
        socket.close();
      } catch (_error) {
        // Ignore websocket close issues during shutdown.
      }
    }

    if (resetMonitor) {
      this.websocketMonitorId = '';
      this.websocketReconnectAttempt = 0;
    }
  }

  async updateRealtimeState(integration, updates = {}, { forcePersist = false, throttlePersist = false } = {}) {
    const previousWebsocket = {
      ...(integration.websocket?.toObject ? integration.websocket.toObject() : integration.websocket || {})
    };
    const previousLastError = trimString(integration.lastError);
    const previousLastRealtimeAt = parseOptionalDate(integration.lastRealtimeAt)?.getTime() || 0;
    const previousLastSyncAt = parseOptionalDate(integration.lastSyncAt)?.getTime() || 0;
    const nextWebsocket = {
      ...previousWebsocket
    };
    const websocketUpdates = asPlainObject(updates.websocket);
    const updateDoc = {};

    Object.entries(websocketUpdates).forEach(([key, value]) => {
      if (value !== undefined) {
        nextWebsocket[key] = value;
      }
    });

    if (Object.keys(nextWebsocket).length > 0) {
      integration.websocket = nextWebsocket;
      updateDoc.websocket = nextWebsocket;
    }

    if (updates.lastError !== undefined) {
      integration.lastError = trimString(updates.lastError);
      updateDoc.lastError = integration.lastError;
    }

    if (updates.lastRealtimeAt) {
      integration.lastRealtimeAt = updates.lastRealtimeAt;
      updateDoc.lastRealtimeAt = updates.lastRealtimeAt;
    }

    if (updates.lastSyncAt) {
      integration.lastSyncAt = updates.lastSyncAt;
      updateDoc.lastSyncAt = updates.lastSyncAt;
    }

    if (Object.keys(updateDoc).length === 0) {
      return;
    }

    const now = Date.now();
    const connectedChanged = Boolean(previousWebsocket.connected) !== Boolean(nextWebsocket.connected);
    const reconnectCountChanged = Number(previousWebsocket.reconnectCount || 0) !== Number(nextWebsocket.reconnectCount || 0);
    const lastConnectedAtChanged = (parseOptionalDate(previousWebsocket.lastConnectedAt)?.getTime() || 0)
      !== (parseOptionalDate(nextWebsocket.lastConnectedAt)?.getTime() || 0);
    const lastErrorChanged = previousLastError !== trimString(integration.lastError);
    const lastRealtimeAtChanged = previousLastRealtimeAt !== (parseOptionalDate(integration.lastRealtimeAt)?.getTime() || 0);
    const lastSyncAtChanged = previousLastSyncAt !== (parseOptionalDate(integration.lastSyncAt)?.getTime() || 0);
    const shouldPersist = forcePersist
      || connectedChanged
      || reconnectCountChanged
      || lastConnectedAtChanged
      || lastErrorChanged
      || lastRealtimeAtChanged
      || lastSyncAtChanged
      || !throttlePersist
      || (now - this.lastRealtimeStatePersistAt) >= WEBSOCKET_STATE_PERSIST_INTERVAL_MS;

    if (!shouldPersist) {
      return;
    }

    if (integration._id) {
      await SenseIntegration.updateOne(
        { _id: integration._id },
        { $set: updateDoc }
      );
      this.lastRealtimeStatePersistAt = now;
      return;
    }

    if (typeof integration.save === 'function') {
      await integration.save();
      this.lastRealtimeStatePersistAt = now;
    }
  }

  async ingestRealtimePayload(integration, payload, { source = 'http', forcePersist = false } = {}) {
    let alwaysOnInfo = null;
    try {
      alwaysOnInfo = await this.fetchAlwaysOnInfo(integration);
    } catch (error) {
      console.warn(`SenseService: always-on fetch failed: ${error.message}`);
    }

    const summary = normalizeRealtimePayload(payload, {
      deviceCatalog: this.deviceCatalog,
      monitorId: integration.monitorId,
      monitorName: integration.monitorName,
      alwaysOnInfo,
      source
    });

    this.latestRealtimeSummary = summary;

    const observedAt = parseOptionalDate(summary.observedAt) || new Date();
    const now = observedAt.getTime();
    const persistIntervalMs = Math.max(
      5000,
      clampInteger(
        integration.pollIntervalSeconds,
        DEFAULT_POLL_INTERVAL_SECONDS,
        5,
        300
      ) * 1000
    );

    if (!forcePersist && (now - this.lastPersistedRealtimeAt) < persistIntervalMs) {
      return summary;
    }

    await this.persistRealtimeSummary(integration, summary, { source });
    return summary;
  }

  async persistRealtimeSummary(integration, summary, { source = 'http' } = {}) {
    const observedAt = parseOptionalDate(summary.observedAt) || new Date();
    await SenseMonitorSnapshot.create({
      monitorId: integration.monitorId,
      monitorName: integration.monitorName,
      observedAt,
      powerW: summary.powerW,
      solarW: summary.solarW,
      netW: summary.netW,
      alwaysOnW: summary.alwaysOnW,
      otherW: summary.otherW,
      untrackedW: summary.untrackedW,
      activeDeviceCount: summary.activeDeviceCount,
      voltage: summary.voltage,
      frequencyHz: summary.frequencyHz,
      activeDevices: summary.activeDevices,
      metadata: {
        source,
        ...summary.metadata
      }
    });

    const updatedDevices = await this.upsertSenseDevices({
      integration,
      summary,
      emitUpdates: true
    });

    if (updatedDevices.length > 0) {
      try {
        await deviceEnergySampleService.recordSamplesForDevices(updatedDevices);
      } catch (error) {
        console.warn(`SenseService: failed to persist energy samples: ${error.message}`);
      }
    }

    this.lastPersistedRealtimeAt = observedAt.getTime();
    integration.isConnected = true;
    integration.lastRealtimeAt = observedAt;
    integration.lastSyncAt = new Date();
    integration.lastError = '';
    integration.snapshot = {
      ...(integration.snapshot || {}),
      live: {
        observedAt: observedAt.toISOString(),
        powerW: summary.powerW,
        solarW: summary.solarW,
        netW: summary.netW,
        alwaysOnW: summary.alwaysOnW,
        otherW: summary.otherW,
        activeDeviceCount: summary.activeDeviceCount
      }
    };
    await integration.save();
  }

  async findCanonicalSenseDevice(query) {
    const devices = await Device.find(query);
    if (devices.length === 0) {
      return null;
    }

    const canonical = selectCanonicalDevice(devices);
    const duplicates = devices.filter((device) => String(device._id) !== String(canonical._id));
    if (duplicates.length > 0) {
      const groupsChanged = mergeDuplicateDeviceGroups(canonical, duplicates);
      if (groupsChanged && typeof canonical.save === 'function') {
        await canonical.save();
      }

      await Device.deleteMany({ _id: { $in: duplicates.map((device) => device._id) } });
      console.warn(
        `SenseService: removed ${duplicates.length} duplicate HomeBrain row(s): ${describeDevices(duplicates)}`
      );
    }

    return canonical;
  }

  getDeviceTrendSummary(senseDeviceId) {
    return this.latestTrendSummary.devices.get(senseDeviceId) || {};
  }

  getMonitorTrendSummary() {
    return this.latestTrendSummary.monitor || {};
  }

  async upsertSenseDevices({ integration, summary = null, emitUpdates = true } = {}) {
    const updatedDevices = [];
    const currentPowerByDeviceId = new Map();
    const activeDevices = safeArray(summary?.activeDevices)
      .filter((entry) => entry?.synthetic !== true);

    activeDevices.forEach((entry) => {
      currentPowerByDeviceId.set(entry.senseDeviceId, entry);
    });

    const catalogEntries = new Map(this.deviceCatalog);
    activeDevices.forEach((entry) => {
      if (!catalogEntries.has(entry.senseDeviceId)) {
        catalogEntries.set(entry.senseDeviceId, {
          senseDeviceId: entry.senseDeviceId,
          name: entry.name,
          icon: entry.icon,
          room: integration.room,
          make: 'Sense',
          model: 'Detected Load'
        });
      }
    });

    const observedAt = parseOptionalDate(summary?.observedAt) || new Date();
    const monitorName = trimString(integration.monitorName, 'Sense Monitor');
    const rateCentsPerKwh = sanitizeElectricityRateCentsPerKwh(
      integration.electricityRateCentsPerKwh,
      DEFAULT_ELECTRICITY_RATE_CENTS_PER_KWH
    );
    const monitorTrendSummary = this.getMonitorTrendSummary();
    const monitorMonthProjection = projectMonthlyEnergyWindow({
      monthEnergyKwh: monitorTrendSummary.month?.consumptionTotalKwh,
      dayEnergyKwh: monitorTrendSummary.day?.consumptionTotalKwh,
      monthStartAt: monitorTrendSummary.month?.startAt,
      now: observedAt
    });
    const monitorQuery = {
      'properties.source': 'sense',
      'properties.sense.entityType': 'monitor',
      'properties.sense.monitorId': integration.monitorId
    };
    let monitorDevice = await this.findCanonicalSenseDevice(monitorQuery);
    if (!monitorDevice) {
      monitorDevice = new Device({
        name: `${monitorName} Whole Home`,
        type: 'sensor',
        room: trimString(integration.room, 'Electrical Panel'),
        status: true,
        isOnline: true,
        brand: 'Sense',
        model: 'Home Energy Monitor',
        properties: {
          source: 'sense',
          sense: {
            entityType: 'monitor',
            monitorId: integration.monitorId
          }
        }
      });
    }

    monitorDevice.name = `${monitorName} Whole Home`;
    monitorDevice.room = trimString(integration.room, monitorDevice.room || 'Electrical Panel');
    monitorDevice.status = summary ? summary.powerW > 0 : true;
    monitorDevice.isOnline = integration.isConnected === true;
    monitorDevice.lastSeen = observedAt;
    monitorDevice.brand = 'Sense';
    monitorDevice.model = 'Home Energy Monitor';
    monitorDevice.properties = {
      ...(monitorDevice.properties || {}),
      source: 'sense',
      sense: {
        ...(monitorDevice.properties?.sense || {}),
        entityType: 'monitor',
        monitorId: integration.monitorId,
        monitorName,
        solarConfigured: integration.solarConfigured === true,
        currentPowerW: summary?.powerW ?? 0,
        solarPowerW: summary?.solarW ?? 0,
        netPowerW: summary?.netW ?? 0,
        alwaysOnW: summary?.alwaysOnW ?? null,
        otherW: summary?.otherW ?? 0,
        untrackedW: summary?.untrackedW ?? 0,
        activeDeviceCount: summary?.activeDeviceCount ?? 0,
        voltage: safeArray(summary?.voltage),
        frequencyHz: summary?.frequencyHz ?? null,
        electricityRateCentsPerKwh: rateCentsPerKwh,
        currentCostUsdPerHour: calculateCurrentCostRateUsdPerHour(summary?.powerW ?? 0, rateCentsPerKwh),
        monthToDateCostUsd: calculateCostUsd(monitorTrendSummary.month?.consumptionTotalKwh, rateCentsPerKwh),
        projectedMonthCostUsd: calculateCostUsd(monitorMonthProjection.projectedMonthKwh, rateCentsPerKwh),
        lastSnapshotAt: observedAt.toISOString(),
        trends: Object.entries(monitorTrendSummary).reduce((acc, [scale, trend]) => {
          acc[scale] = decorateTrendWindowWithCost(trend, rateCentsPerKwh);
          return acc;
        }, {})
      }
    };
    await monitorDevice.save();
    updatedDevices.push(monitorDevice);

    for (const catalogEntry of catalogEntries.values()) {
      const deviceQuery = {
        'properties.source': 'sense',
        'properties.sense.entityType': 'device',
        'properties.sense.monitorId': integration.monitorId,
        'properties.sense.senseDeviceId': catalogEntry.senseDeviceId
      };
      let device = await this.findCanonicalSenseDevice(deviceQuery);
      if (!device) {
        device = new Device({
          name: catalogEntry.name,
          type: 'sensor',
          room: trimString(catalogEntry.room, trimString(integration.room, 'Electrical Panel')),
          status: false,
          isOnline: true,
          brand: 'Sense',
          model: trimString(catalogEntry.model, 'Detected Load'),
          properties: {
            source: 'sense',
            sense: {
              entityType: 'device',
              monitorId: integration.monitorId,
              senseDeviceId: catalogEntry.senseDeviceId
            }
          }
        });
      }

      const current = currentPowerByDeviceId.get(catalogEntry.senseDeviceId) || null;
      const powerW = current?.powerW ?? 0;
      const deviceTrendSummary = this.getDeviceTrendSummary(catalogEntry.senseDeviceId);
      const deviceMonthProjection = projectMonthlyEnergyWindow({
        monthEnergyKwh: deviceTrendSummary.month?.energyKwh,
        dayEnergyKwh: deviceTrendSummary.day?.energyKwh,
        monthStartAt: monitorTrendSummary.month?.startAt,
        now: observedAt
      });

      device.name = trimString(catalogEntry.name, device.name || `Device ${catalogEntry.senseDeviceId}`);
      device.room = trimString(catalogEntry.room, trimString(integration.room, device.room || 'Electrical Panel'));
      device.type = 'sensor';
      device.status = powerW > 0.05;
      device.isOnline = integration.isConnected === true;
      device.lastSeen = observedAt;
      device.brand = 'Sense';
      device.model = trimString(catalogEntry.model, device.model || 'Detected Load');
      device.properties = {
        ...(device.properties || {}),
        source: 'sense',
        sense: {
          ...(device.properties?.sense || {}),
          entityType: 'device',
          monitorId: integration.monitorId,
          senseDeviceId: catalogEntry.senseDeviceId,
          icon: trimString(catalogEntry.icon),
          currentPowerW: roundNumber(powerW, 1) || 0,
          currentSharePct: current?.sharePct ?? 0,
          electricityRateCentsPerKwh: rateCentsPerKwh,
          currentCostUsdPerHour: calculateCurrentCostRateUsdPerHour(powerW, rateCentsPerKwh),
          monthToDateCostUsd: calculateCostUsd(deviceTrendSummary.month?.energyKwh, rateCentsPerKwh),
          projectedMonthCostUsd: calculateCostUsd(deviceMonthProjection.projectedMonthKwh, rateCentsPerKwh),
          lastSnapshotAt: observedAt.toISOString(),
          trends: Object.entries(deviceTrendSummary).reduce((acc, [scale, trend]) => {
            acc[scale] = decorateDeviceUsageWindowWithCost(trend, rateCentsPerKwh);
            return acc;
          }, {})
        }
      };
      await device.save();
      updatedDevices.push(device);
    }

    if (emitUpdates) {
      const normalized = deviceUpdateEmitter.normalizeDevices(updatedDevices);
      if (normalized.length > 0) {
        deviceUpdateEmitter.emit('devices:update', normalized);
      }
    }

    return updatedDevices;
  }

  async syncTrendData(integration) {
    const trendDocs = [];

    for (const scale of SCALE_ORDER) {
      const startAt = new Date();
      const usagePayload = await this.requestApi(
        `app/monitors/${integration.monitorId}/history/usage`,
        {
          integration,
          params: {
            scale: SCALE_TO_API[scale],
            start: startAt.toISOString().slice(0, 19)
          }
        }
      );

      let solarPayload = {};
      if (integration.solarConfigured === true) {
        try {
          solarPayload = await this.requestApi(
            `app/monitors/${integration.monitorId}/history/usage/solar`,
            {
              integration,
              params: {
                scale: SCALE_TO_API[scale],
                start: startAt.toISOString().slice(0, 19)
              }
            }
          );
        } catch (error) {
          console.warn(`SenseService: solar trend sync failed for ${scale}: ${error.message}`);
        }
      }

      const normalized = normalizeTrendSnapshot(scale, usagePayload, solarPayload);
      await SenseTrendSnapshot.findOneAndUpdate(
        {
          monitorId: integration.monitorId,
          scale,
          startAt: normalized.startAt
        },
        {
          $set: {
            monitorName: integration.monitorName,
            syncedAt: normalized.syncedAt,
            consumptionTotalKwh: normalized.consumptionTotalKwh,
            productionTotalKwh: normalized.productionTotalKwh,
            productionPct: normalized.productionPct,
            netProductionKwh: normalized.netProductionKwh,
            fromGridKwh: normalized.fromGridKwh,
            toGridKwh: normalized.toGridKwh,
            solarPoweredPct: normalized.solarPoweredPct,
            deviceBreakdown: normalized.deviceBreakdown,
            metadata: normalized.metadata
          },
          $setOnInsert: {
            createdAt: new Date()
          }
        },
        {
          upsert: true,
          new: true
        }
      );

      trendDocs.push({
        monitorId: integration.monitorId,
        monitorName: integration.monitorName,
        ...normalized
      });
    }

    this.latestTrendSummary = buildTrendSummaryMap(trendDocs);
    await this.upsertSenseDevices({
      integration,
      summary: this.latestRealtimeSummary,
      emitUpdates: true
    });

    integration.lastTrendSyncAt = new Date();
    integration.lastSyncAt = new Date();
    integration.snapshot = {
      ...(integration.snapshot || {}),
      trends: SCALE_ORDER.reduce((acc, scale) => {
        const trend = this.latestTrendSummary.monitor?.[scale];
        if (trend) {
          acc[scale] = trend;
        }
        return acc;
      }, {})
    };
    await integration.save();

    return trendDocs;
  }

  async testConnection(input = {}) {
    const persisted = await this.resolvePersistedIntegration();
    const integration = {
      email: trimString(input.email, trimString(persisted.email)),
      password: trimString(input.password, trimString(persisted.password)),
      deviceId: trimString(persisted.deviceId) || buildSenseDeviceId(),
      accessToken: trimString(persisted.accessToken),
      refreshToken: trimString(persisted.refreshToken),
      userId: trimString(persisted.userId),
      monitorId: trimString(input.monitorId, trimString(persisted.monitorId)),
      monitorName: trimString(persisted.monitorName),
      availableMonitors: safeArray(persisted.availableMonitors)
    };

    await this.authenticate(integration, {
      mfaCode: trimString(input.mfaCode),
      persist: false
    });
    const overview = await this.requestApi(
      `app/monitors/${integration.monitorId}/overview`,
      { integration }
    );
    const normalizedOverview = normalizeMonitorOverview(overview);

    return {
      success: true,
      monitors: integration.availableMonitors,
      monitor: normalizedOverview
    };
  }

  async configureIntegration(input = {}) {
    const integration = await this.resolvePersistedIntegration();
    const nextEnabled = input.enabled !== undefined ? input.enabled === true : integration.enabled === true;

    integration.email = trimString(input.email, integration.email || '');
    if (trimString(input.password)) {
      integration.password = trimString(input.password);
    }
    if (trimString(input.monitorId)) {
      integration.monitorId = trimString(input.monitorId);
    }
    integration.enabled = nextEnabled;
    integration.realtimeEnabled = input.realtimeEnabled !== undefined
      ? input.realtimeEnabled === true
      : integration.realtimeEnabled !== false;
    integration.room = trimString(input.room, trimString(integration.room, 'Electrical Panel'));
    integration.pollIntervalSeconds = clampInteger(
      input.pollIntervalSeconds,
      integration.pollIntervalSeconds || DEFAULT_POLL_INTERVAL_SECONDS,
      5,
      300
    );
    integration.trendSyncIntervalMinutes = clampInteger(
      input.trendSyncIntervalMinutes,
      integration.trendSyncIntervalMinutes || DEFAULT_TREND_SYNC_INTERVAL_MINUTES,
      5,
      1440
    );
    integration.electricityRateCentsPerKwh = sanitizeElectricityRateCentsPerKwh(
      input.electricityRateCentsPerKwh,
      integration.electricityRateCentsPerKwh ?? DEFAULT_ELECTRICITY_RATE_CENTS_PER_KWH
    );

    await integration.save();

    if (integration.enabled) {
      await this.refreshRuntime({
        reason: 'configure',
        forceRealtime: true,
        forceTrend: true,
        mfaCode: trimString(input.mfaCode)
      });
    } else {
      this.stopWebSocket({ resetMonitor: true });
      integration.isConnected = false;
      integration.lastError = '';
      integration.websocket = {
        ...(integration.websocket?.toObject ? integration.websocket.toObject() : integration.websocket || {}),
        connected: false
      };
      await integration.save();
    }

    return this.getStatus();
  }

  async getStatus() {
    const integration = await this.resolvePersistedIntegration();
    integration.electricityRateCentsPerKwh = sanitizeElectricityRateCentsPerKwh(
      integration.electricityRateCentsPerKwh,
      DEFAULT_ELECTRICITY_RATE_CENTS_PER_KWH
    );
    const rateCentsPerKwh = integration.electricityRateCentsPerKwh;
    const latestSnapshot = trimString(integration.monitorId)
      ? await SenseMonitorSnapshot.findOne({ monitorId: integration.monitorId })
        .select(SENSE_STATUS_SNAPSHOT_SELECT)
        .sort({ observedAt: -1 })
        .lean()
      : null;
    const latestTrends = trimString(integration.monitorId)
      ? await SenseTrendSnapshot.find({ monitorId: integration.monitorId })
        .select(SENSE_STATUS_TREND_SELECT)
        .sort({ syncedAt: -1 })
        .lean()
      : [];
    const trendSummary = buildTrendSummaryMap(
      latestTrends.reduce((acc, entry) => {
        if (!acc.some((candidate) => candidate.scale === entry.scale)) {
          acc.push(entry);
        }
        return acc;
      }, [])
    );

    return {
      success: true,
      integration: integration.toSanitized(),
      health: {
        isConnected: integration.isConnected === true,
        websocketConnected: integration.websocket?.connected === true,
        websocketLastConnectedAt: integration.websocket?.lastConnectedAt || null,
        websocketLastMessageAt: integration.websocket?.lastMessageAt || null,
        websocketReconnectCount: Number(integration.websocket?.reconnectCount || 0),
        lastAuthenticatedAt: integration.lastAuthenticatedAt || null,
        lastRealtimeAt: integration.lastRealtimeAt || null,
        lastTrendSyncAt: integration.lastTrendSyncAt || null,
        pollIntervalSeconds: Number(integration.pollIntervalSeconds || DEFAULT_POLL_INTERVAL_SECONDS),
        failureBackoffSeconds: Math.ceil(this.getRefreshBackoffRemainingMs() / 1000),
        consecutiveRefreshFailures: this.consecutiveRefreshFailures,
        lastError: integration.lastError || ''
      },
      latestSnapshot: latestSnapshot
        ? {
            observedAt: latestSnapshot.observedAt,
            powerW: latestSnapshot.powerW,
            solarW: latestSnapshot.solarW,
            netW: latestSnapshot.netW,
            alwaysOnW: latestSnapshot.alwaysOnW,
            activeDeviceCount: latestSnapshot.activeDeviceCount
          }
        : null,
      latestTrends: Object.entries(trendSummary.monitor).reduce((acc, [scale, trend]) => {
        acc[scale] = decorateTrendWindowWithCost(trend, rateCentsPerKwh);
        return acc;
      }, {}),
      monitors: safeArray(integration.availableMonitors)
    };
  }

  async syncNow() {
    await this.refreshRuntime({
      reason: 'manual-sync',
      forceRealtime: true,
      forceTrend: true
    });

    return {
      success: true,
      message: 'Sense sync completed'
    };
  }

  async getDashboard(options = {}) {
    const requestedHours = clampInteger(options.hours, 6, 1, MAX_DASHBOARD_HOURS);
    const hours = requestedHours;
    const integration = await this.resolvePersistedIntegration();
    integration.electricityRateCentsPerKwh = sanitizeElectricityRateCentsPerKwh(
      integration.electricityRateCentsPerKwh,
      DEFAULT_ELECTRICITY_RATE_CENTS_PER_KWH
    );

    if (integration.enabled && (
      !this.latestRealtimeSummary
      || this.latestRealtimeSummary.monitorId !== integration.monitorId
      || (Date.now() - (parseOptionalDate(this.latestRealtimeSummary.observedAt)?.getTime() || 0)) > Math.max(this.pollIntervalMs * 2, 20000)
    )) {
      try {
        await this.refreshRuntime({
          reason: 'dashboard',
          forceRealtime: true
        });
      } catch (error) {
        console.warn(`SenseService: dashboard refresh failed: ${error.message}`);
      }
    }

    const latestIntegration = await this.resolvePersistedIntegration();
    latestIntegration.electricityRateCentsPerKwh = sanitizeElectricityRateCentsPerKwh(
      latestIntegration.electricityRateCentsPerKwh,
      DEFAULT_ELECTRICITY_RATE_CENTS_PER_KWH
    );
    const rateCentsPerKwh = latestIntegration.electricityRateCentsPerKwh;
    const startAt = new Date(Date.now() - hours * 60 * 60 * 1000);
    const snapshots = trimString(latestIntegration.monitorId)
      ? await SenseMonitorSnapshot.find({
          monitorId: latestIntegration.monitorId,
          observedAt: { $gte: startAt }
        })
          .select(SENSE_DASHBOARD_SNAPSHOT_SELECT)
          .sort({ observedAt: 1 })
          .lean()
      : [];
    const downsampledSnapshots = downsampleSnapshots(snapshots, MAX_DASHBOARD_POINTS).map((snapshot) => ({
      observedAt: snapshot.observedAt,
      powerW: snapshot.powerW,
      solarW: snapshot.solarW,
      netW: snapshot.netW,
      alwaysOnW: snapshot.alwaysOnW,
      otherW: snapshot.otherW,
      activeDevices: safeArray(snapshot.activeDevices)
    }));

    const trendDocs = trimString(latestIntegration.monitorId)
      ? await SenseTrendSnapshot.find({ monitorId: latestIntegration.monitorId })
        .select(SENSE_DASHBOARD_TREND_SELECT)
        .sort({ syncedAt: -1 })
        .lean()
      : [];
    const latestTrendDocs = trendDocs.reduce((acc, entry) => {
      if (!acc.some((candidate) => candidate.scale === entry.scale)) {
        acc.push(entry);
      }
      return acc;
    }, []);
    const trendSummary = buildTrendSummaryMap(latestTrendDocs);
    const decoratedTrends = Object.entries(trendSummary.monitor).reduce((acc, [scale, trend]) => {
      acc[scale] = decorateTrendWindowWithCost(trend, rateCentsPerKwh);
      return acc;
    }, {});
    const monthProjection = projectMonthlyEnergyWindow({
      monthEnergyKwh: decoratedTrends.month?.consumptionTotalKwh,
      dayEnergyKwh: decoratedTrends.day?.consumptionTotalKwh,
      monthStartAt: decoratedTrends.month?.startAt
    });

    const currentCatalog = Array.from(this.deviceCatalog.values());
    const latestLive = this.latestRealtimeSummary && this.latestRealtimeSummary.monitorId === latestIntegration.monitorId
      ? this.latestRealtimeSummary
      : (snapshots[snapshots.length - 1]
        ? {
            monitorId: latestIntegration.monitorId,
            monitorName: latestIntegration.monitorName,
            observedAt: snapshots[snapshots.length - 1].observedAt,
            powerW: snapshots[snapshots.length - 1].powerW,
            solarW: snapshots[snapshots.length - 1].solarW,
            netW: snapshots[snapshots.length - 1].netW,
            alwaysOnW: snapshots[snapshots.length - 1].alwaysOnW,
            otherW: snapshots[snapshots.length - 1].otherW,
            untrackedW: snapshots[snapshots.length - 1].untrackedW,
            activeDeviceCount: snapshots[snapshots.length - 1].activeDeviceCount,
            frequencyHz: snapshots[snapshots.length - 1].frequencyHz,
            voltage: snapshots[snapshots.length - 1].voltage,
            activeDevices: safeArray(snapshots[snapshots.length - 1].activeDevices)
          }
        : null);

    const deviceUsageMap = new Map();
    currentCatalog.forEach((entry) => {
      deviceUsageMap.set(entry.senseDeviceId, {
        senseDeviceId: entry.senseDeviceId,
        name: entry.name,
        icon: entry.icon,
        room: entry.room,
        currentPowerW: 0,
        currentSharePct: 0
      });
    });

    safeArray(latestLive?.activeDevices)
      .filter((entry) => entry?.synthetic !== true)
      .forEach((entry) => {
        const current = deviceUsageMap.get(entry.senseDeviceId) || {
          senseDeviceId: entry.senseDeviceId,
          name: entry.name,
          icon: entry.icon,
          room: ''
        };
        current.currentPowerW = entry.powerW;
        current.currentSharePct = entry.sharePct;
        current.name = current.name || entry.name;
        current.icon = current.icon || entry.icon;
        deviceUsageMap.set(entry.senseDeviceId, current);
      });

    trendSummary.devices.forEach((entry, senseDeviceId) => {
      const current = deviceUsageMap.get(senseDeviceId) || {
        senseDeviceId,
        name: entry.name,
        icon: entry.icon,
        room: ''
      };
      SCALE_ORDER.forEach((scale) => {
        if (entry[scale]) {
          current[scale] = entry[scale];
        }
      });
      current.name = current.name || entry.name;
      current.icon = current.icon || entry.icon;
      deviceUsageMap.set(senseDeviceId, current);
    });

    const deviceUsage = Array.from(deviceUsageMap.values())
      .map((entry) => {
        const decoratedEntry = {
          ...entry,
          day: decorateDeviceUsageWindowWithCost(entry.day, rateCentsPerKwh),
          week: decorateDeviceUsageWindowWithCost(entry.week, rateCentsPerKwh),
          month: decorateDeviceUsageWindowWithCost(entry.month, rateCentsPerKwh),
          year: decorateDeviceUsageWindowWithCost(entry.year, rateCentsPerKwh),
          cycle: decorateDeviceUsageWindowWithCost(entry.cycle, rateCentsPerKwh)
        };
        const projectedMonth = projectMonthlyEnergyWindow({
          monthEnergyKwh: entry.month?.energyKwh,
          dayEnergyKwh: entry.day?.energyKwh,
          monthStartAt: decoratedTrends.month?.startAt
        });

        return {
          ...decoratedEntry,
          currentCostUsdPerHour: calculateCurrentCostRateUsdPerHour(entry.currentPowerW, rateCentsPerKwh),
          monthToDateCostUsd: calculateCostUsd(decoratedEntry.month?.energyKwh, rateCentsPerKwh),
          projectedMonthCostUsd: calculateCostUsd(projectedMonth.projectedMonthKwh, rateCentsPerKwh)
        };
      })
      .sort((left, right) => {
        const powerDiff = (right.currentPowerW || 0) - (left.currentPowerW || 0);
        if (powerDiff !== 0) {
          return powerDiff;
        }

        return (right.day?.energyKwh || 0) - (left.day?.energyKwh || 0);
      });

    return {
      success: true,
      integration: latestIntegration.toSanitized(),
      generatedAt: new Date().toISOString(),
      monitor: {
        monitorId: latestIntegration.monitorId,
        name: latestIntegration.monitorName || 'Sense Monitor',
        room: latestIntegration.room,
        solarConfigured: latestIntegration.solarConfigured === true
      },
      health: {
        isConnected: latestIntegration.isConnected === true,
        websocketConnected: latestIntegration.websocket?.connected === true,
        lastRealtimeAt: latestIntegration.lastRealtimeAt || null,
        lastTrendSyncAt: latestIntegration.lastTrendSyncAt || null,
        lastError: latestIntegration.lastError || ''
      },
      costs: {
        electricityRateCentsPerKwh: rateCentsPerKwh,
        electricityRateUsdPerKwh: roundNumber(rateCentsPerKwh / 100, 4),
        currentUsdPerHour: calculateCurrentCostRateUsdPerHour(latestLive?.powerW, rateCentsPerKwh),
        monthToDateUsd: calculateCostUsd(decoratedTrends.month?.consumptionTotalKwh, rateCentsPerKwh),
        projectedMonthUsd: calculateCostUsd(monthProjection.projectedMonthKwh, rateCentsPerKwh),
        daysElapsed: monthProjection.daysElapsed,
        daysInMonth: monthProjection.daysInMonth,
        projectionMethod: monthProjection.method
      },
      live: latestLive,
      recentSnapshots: {
        hours,
        pointCount: downsampledSnapshots.length,
        rawPointCount: snapshots.length,
        points: downsampledSnapshots
      },
      trends: decoratedTrends,
      activeDevices: safeArray(latestLive?.activeDevices)
        .map((entry) => {
          const usage = deviceUsage.find((candidate) => candidate.senseDeviceId === entry.senseDeviceId);
          return {
            ...entry,
            currentCostUsdPerHour: calculateCurrentCostRateUsdPerHour(entry.powerW, rateCentsPerKwh),
            monthToDateCostUsd: usage?.monthToDateCostUsd ?? null,
            projectedMonthCostUsd: usage?.projectedMonthCostUsd ?? null
          };
        })
        .sort((left, right) => right.powerW - left.powerW),
      deviceUsage
    };
  }
}

const senseService = new SenseService();

module.exports = senseService;
module.exports.SenseService = SenseService;
module.exports.__private__ = {
  buildTrendSummaryMap,
  calculateCostUsd,
  calculateCurrentCostRateUsdPerHour,
  decorateDeviceUsageWindowWithCost,
  decorateTrendWindowWithCost,
  downsampleSnapshots,
  extractAlwaysOnWatts,
  normalizeCatalogDevice,
  normalizeMonitorOptions,
  normalizeMonitorOverview,
  normalizeRealtimePayload,
  normalizeTrendSnapshot,
  projectMonthlyEnergyWindow,
  resolveMonthProjectionContext
};

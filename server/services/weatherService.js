const axios = require('axios');
const settingsService = require('./settingsService');
const goveeAirQualityService = require('./goveeAirQualityService');
const tempestService = require('./tempestService');
const telemetryService = require('./telemetryService');
const integrationRegistryService = require('./integrationRegistryService');
const { getModuleDefinition } = require('./integrationModuleCatalog');
const weatherCacheStore = require('./weatherCacheStore');

const DEFAULT_FORECAST_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_AIR_QUALITY_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_GEOCODE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_FORECAST_STALE_IF_ERROR_MS = 30 * 60 * 1000;
const DEFAULT_AIR_QUALITY_STALE_IF_ERROR_MS = 30 * 60 * 1000;
const DEFAULT_GEOCODE_STALE_IF_ERROR_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DASHBOARD_WEATHER_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_WEATHER_TEMPEST_SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_WEATHER_TEMPEST_STALE_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_WEATHER_GOVEE_SYNC_COOLDOWN_MS = 60 * 1000;
const DEFAULT_WEATHER_GOVEE_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_WEATHER_MODULE_TELEMETRY_TIMEOUT_MS = 1500;
const WEATHER_CACHE_COORDINATE_PRECISION = 2;
const WEATHER_RECOVERY_COORDINATE_PRECISION = 1;
const forecastCache = new Map();
const airQualityCache = new Map();
const geocodeCache = new Map();
const dashboardWeatherCache = new Map();
let lastWeatherTempestRefreshAttemptAt = 0;
let lastWeatherGoveeRefreshAttemptAt = 0;
const PERSISTED_WEATHER_CACHE_KIND_FORECAST = 'forecast';
const PERSISTED_WEATHER_CACHE_KIND_AIR_QUALITY = 'air_quality';

const US_STATE_ABBREVIATIONS = Object.freeze({
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia'
});

const WEATHER_LABELS = {
  0: { label: 'Clear', icon: 'sunny' },
  1: { label: 'Mostly Clear', icon: 'partly-cloudy' },
  2: { label: 'Partly Cloudy', icon: 'partly-cloudy' },
  3: { label: 'Overcast', icon: 'cloudy' },
  45: { label: 'Fog', icon: 'fog' },
  48: { label: 'Rime Fog', icon: 'fog' },
  51: { label: 'Light Drizzle', icon: 'drizzle' },
  53: { label: 'Drizzle', icon: 'drizzle' },
  55: { label: 'Heavy Drizzle', icon: 'drizzle' },
  56: { label: 'Freezing Drizzle', icon: 'sleet' },
  57: { label: 'Heavy Freezing Drizzle', icon: 'sleet' },
  61: { label: 'Light Rain', icon: 'rain' },
  63: { label: 'Rain', icon: 'rain' },
  65: { label: 'Heavy Rain', icon: 'rain' },
  66: { label: 'Freezing Rain', icon: 'sleet' },
  67: { label: 'Heavy Freezing Rain', icon: 'sleet' },
  71: { label: 'Light Snow', icon: 'snow' },
  73: { label: 'Snow', icon: 'snow' },
  75: { label: 'Heavy Snow', icon: 'snow' },
  77: { label: 'Snow Grains', icon: 'snow' },
  80: { label: 'Rain Showers', icon: 'rain' },
  81: { label: 'Heavy Showers', icon: 'rain' },
  82: { label: 'Violent Showers', icon: 'rain' },
  85: { label: 'Snow Showers', icon: 'snow' },
  86: { label: 'Heavy Snow Showers', icon: 'snow' },
  95: { label: 'Thunderstorm', icon: 'storm' },
  96: { label: 'Storm and Hail', icon: 'storm' },
  99: { label: 'Severe Storm', icon: 'storm' }
};

const toNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const parsePositiveInteger = (value, fallback) => {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
};

const parseBooleanFlag = (value, fallback = false) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }

  return fallback;
};

const weatherModuleTelemetryTimeoutMs = () => parsePositiveInteger(
  process.env.WEATHER_MODULE_TELEMETRY_TIMEOUT_MS,
  DEFAULT_WEATHER_MODULE_TELEMETRY_TIMEOUT_MS
);

async function withTimeout(promise, timeoutMs, fallback = null) {
  let timeoutId;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function loadTempestModuleTelemetry(sourceId) {
  if (!sourceId) {
    return null;
  }

  const telemetryPromise = telemetryService.getTempestModuleTelemetry({ sourceId })
    .catch(() => null);

  return withTimeout(
    telemetryPromise,
    weatherModuleTelemetryTimeoutMs(),
    null
  );
}

const FORECAST_CACHE_TTL_MS = parsePositiveInteger(
  process.env.WEATHER_FORECAST_CACHE_TTL_MS,
  DEFAULT_FORECAST_CACHE_TTL_MS
);
const AIR_QUALITY_CACHE_TTL_MS = parsePositiveInteger(
  process.env.WEATHER_AIR_QUALITY_CACHE_TTL_MS,
  DEFAULT_AIR_QUALITY_CACHE_TTL_MS
);
const GEOCODE_CACHE_TTL_MS = parsePositiveInteger(
  process.env.WEATHER_GEOCODE_CACHE_TTL_MS,
  DEFAULT_GEOCODE_CACHE_TTL_MS
);
const FORECAST_STALE_IF_ERROR_MS = parsePositiveInteger(
  process.env.WEATHER_FORECAST_STALE_IF_ERROR_MS,
  DEFAULT_FORECAST_STALE_IF_ERROR_MS
);
const AIR_QUALITY_STALE_IF_ERROR_MS = parsePositiveInteger(
  process.env.WEATHER_AIR_QUALITY_STALE_IF_ERROR_MS,
  DEFAULT_AIR_QUALITY_STALE_IF_ERROR_MS
);
const GEOCODE_STALE_IF_ERROR_MS = parsePositiveInteger(
  process.env.WEATHER_GEOCODE_STALE_IF_ERROR_MS,
  DEFAULT_GEOCODE_STALE_IF_ERROR_MS
);
const DASHBOARD_WEATHER_CACHE_TTL_MS = parsePositiveInteger(
  process.env.WEATHER_DASHBOARD_CACHE_TTL_MS,
  DEFAULT_DASHBOARD_WEATHER_CACHE_TTL_MS
);
const WEATHER_TEMPEST_SYNC_COOLDOWN_MS = parsePositiveInteger(
  process.env.WEATHER_TEMPEST_SYNC_COOLDOWN_MS,
  DEFAULT_WEATHER_TEMPEST_SYNC_COOLDOWN_MS
);
const WEATHER_TEMPEST_STALE_AFTER_MS = parsePositiveInteger(
  process.env.WEATHER_TEMPEST_STALE_AFTER_MS,
  DEFAULT_WEATHER_TEMPEST_STALE_AFTER_MS
);
const WEATHER_GOVEE_SYNC_COOLDOWN_MS = parsePositiveInteger(
  process.env.WEATHER_GOVEE_SYNC_COOLDOWN_MS,
  DEFAULT_WEATHER_GOVEE_SYNC_COOLDOWN_MS
);
const WEATHER_GOVEE_STALE_AFTER_MS = parsePositiveInteger(
  process.env.WEATHER_GOVEE_STALE_AFTER_MS,
  DEFAULT_WEATHER_GOVEE_STALE_AFTER_MS
);

function normalizeCoordinates(latitude, longitude) {
  const lat = toNumber(latitude);
  const lon = toNumber(longitude);

  if (lat === null || lon === null) {
    return null;
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }

  return { latitude: lat, longitude: lon };
}

function buildCoordinateCacheKey(location, precision = WEATHER_CACHE_COORDINATE_PRECISION) {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);
  return `${latitude.toFixed(precision)},${longitude.toFixed(precision)}`;
}

function buildForecastCacheKey(location, precision = WEATHER_CACHE_COORDINATE_PRECISION) {
  // Auto-detect coordinates drift slightly between refreshes; bucket them so one driveway
  // does not fan out into new forecast/AQI cache misses every minute.
  return buildCoordinateCacheKey(location, precision);
}

function buildAirQualityCacheKey(location, precision = WEATHER_CACHE_COORDINATE_PRECISION) {
  return buildForecastCacheKey(location, precision);
}

function buildDashboardWeatherCacheKey(location, options = {}) {
  return [
    buildForecastCacheKey(location),
    location?.source || 'unknown',
    location?.name || '',
    parseBooleanFlag(options.includeModuleTelemetry) ? 'module-telemetry' : 'current-only'
  ].join('|');
}

function buildRecoveryCacheKeys(location, kind) {
  const exactKey = kind === PERSISTED_WEATHER_CACHE_KIND_AIR_QUALITY
    ? buildAirQualityCacheKey(location)
    : buildForecastCacheKey(location);
  const coarseKey = kind === PERSISTED_WEATHER_CACHE_KIND_AIR_QUALITY
    ? buildAirQualityCacheKey(location, WEATHER_RECOVERY_COORDINATE_PRECISION)
    : buildForecastCacheKey(location, WEATHER_RECOVERY_COORDINATE_PRECISION);

  return Array.from(new Set([exactKey, coarseKey].filter(Boolean)));
}

function parseUpdatedAtTimestamp(value) {
  if (!value) {
    return 0;
  }

  const candidate = value instanceof Date ? value : new Date(value);
  return Number.isNaN(candidate.getTime()) ? 0 : candidate.getTime();
}

function isTempestSnapshotStale(tempestStation, nowMs = Date.now()) {
  if (!tempestStation) {
    return false;
  }

  if (toNumber(tempestStation.stationId) === null) {
    return false;
  }

  const observedAtMs = parseUpdatedAtTimestamp(tempestStation.observedAt);
  const observationStale = observedAtMs === 0 || (nowMs - observedAtMs) > WEATHER_TEMPEST_STALE_AFTER_MS;
  const websocketStale = tempestStation.status?.websocketConnected === false;

  return observationStale || websocketStale;
}

async function getWeatherTempestSnapshot() {
  return tempestService.getSelectedStationSnapshot().catch(() => null);
}

async function getWeatherIndoorAirSnapshot() {
  return goveeAirQualityService.getLatestSnapshot().catch(() => null);
}

function isIndoorAirSnapshotStale(indoorAirSnapshot, nowMs = Date.now()) {
  if (!indoorAirSnapshot) {
    return false;
  }

  const observedAtMs = parseUpdatedAtTimestamp(indoorAirSnapshot.observedAt);
  return observedAtMs === 0 || (nowMs - observedAtMs) > WEATHER_GOVEE_STALE_AFTER_MS;
}

async function refreshIndoorAirForWeatherIfNeeded(indoorAirSnapshot, options = {}) {
  const forceIndoorAirSync = parseBooleanFlag(options.forceIndoorAirSync);
  const stale = !forceIndoorAirSync && isIndoorAirSnapshotStale(indoorAirSnapshot);

  if (!forceIndoorAirSync && !stale) {
    return {
      refreshed: false,
      indoorAirSnapshot
    };
  }

  const nowMs = Date.now();
  if (
    !forceIndoorAirSync
    && lastWeatherGoveeRefreshAttemptAt > 0
    && (nowMs - lastWeatherGoveeRefreshAttemptAt) < WEATHER_GOVEE_SYNC_COOLDOWN_MS
  ) {
    return {
      refreshed: false,
      result: {
        success: true,
        skipped: true,
        reason: 'weather-indoor-air-refresh-cooldown',
        lastRefreshAttemptAt: new Date(lastWeatherGoveeRefreshAttemptAt).toISOString()
      },
      indoorAirSnapshot
    };
  }

  try {
    if (!forceIndoorAirSync) {
      lastWeatherGoveeRefreshAttemptAt = nowMs;
    }

    const result = await goveeAirQualityService.syncNow({
      reason: forceIndoorAirSync ? 'weather-manual-refresh' : 'weather-stale-indoor-air-refresh',
      allowDisabled: false
    });

    if (result?.skipped) {
      return {
        refreshed: false,
        result,
        indoorAirSnapshot
      };
    }

    return {
      refreshed: true,
      result,
      indoorAirSnapshot: await getWeatherIndoorAirSnapshot()
    };
  } catch (error) {
    console.warn(`WeatherService: Govee indoor air refresh failed before weather fetch: ${error.message}`);
    return {
      refreshed: false,
      error,
      indoorAirSnapshot
    };
  }
}

async function refreshTempestForWeatherIfNeeded(tempestStation, options = {}) {
  const forceTempestSync = parseBooleanFlag(options.forceTempestSync);
  const stale = !forceTempestSync && isTempestSnapshotStale(tempestStation);

  if (!forceTempestSync && !stale) {
    return {
      refreshed: false,
      tempestStation
    };
  }

  const reason = forceTempestSync ? 'weather-manual-refresh' : 'weather-stale-tempest-refresh';
  const nowMs = Date.now();
  if (
    !forceTempestSync
    && lastWeatherTempestRefreshAttemptAt > 0
    && (nowMs - lastWeatherTempestRefreshAttemptAt) < WEATHER_TEMPEST_SYNC_COOLDOWN_MS
  ) {
    return {
      refreshed: false,
      result: {
        success: true,
        skipped: true,
        reason: 'weather-stale-refresh-cooldown',
        lastRefreshAttemptAt: new Date(lastWeatherTempestRefreshAttemptAt).toISOString()
      },
      tempestStation
    };
  }

  try {
    if (!forceTempestSync) {
      lastWeatherTempestRefreshAttemptAt = nowMs;
    }

    const result = await tempestService.refreshRuntime({
      reason,
      minIntervalMs: WEATHER_TEMPEST_SYNC_COOLDOWN_MS
    });

    if (result?.skipped) {
      return {
        refreshed: false,
        result,
        tempestStation
      };
    }

    return {
      refreshed: true,
      result,
      tempestStation: await getWeatherTempestSnapshot()
    };
  } catch (error) {
    console.warn(`WeatherService: Tempest refresh failed before weather fetch: ${error.message}`);
    return {
      refreshed: false,
      error,
      tempestStation
    };
  }
}

async function getClimateCapabilityPreference(capabilityKey) {
  try {
    return await integrationRegistryService.getCapabilityPreference(capabilityKey);
  } catch (_error) {
    return {
      mode: 'auto',
      moduleId: '',
      resourceId: '',
      updatedAt: null
    };
  }
}

function buildClimateSourceDescriptor({ capability, moduleId, resourceId, label, deviceType, room, sourceKey, available, live }) {
  const moduleDefinition = getModuleDefinition(moduleId) || {};
  return {
    capability,
    moduleId,
    moduleName: moduleDefinition.label || moduleId,
    provider: moduleDefinition.provider || '',
    resourceId: resourceId ? String(resourceId) : '',
    label: label || moduleDefinition.label || '',
    deviceType: deviceType || '',
    room: room || '',
    sourceKey: sourceKey || '',
    available: available === true,
    live: live === true
  };
}

async function buildClimateSourceMetadata({ tempestStation, indoorAirSnapshot } = {}) {
  const [outdoorPreference, indoorPreference] = await Promise.all([
    getClimateCapabilityPreference('outdoor_climate'),
    getClimateCapabilityPreference('indoor_climate')
  ]);
  const tempestStationId = tempestStation?.stationId ?? tempestStation?.id ?? tempestStation?.deviceId ?? '';
  const indoorResourceId = [
    indoorAirSnapshot?.sku,
    indoorAirSnapshot?.device
  ].filter(Boolean).join(':') || indoorAirSnapshot?.device || indoorAirSnapshot?.id || '';

  const outdoorClimate = buildClimateSourceDescriptor({
    capability: 'outdoor_climate',
    moduleId: outdoorPreference.mode === 'selected' && outdoorPreference.moduleId ? outdoorPreference.moduleId : 'tempest',
    resourceId: outdoorPreference.mode === 'selected' && outdoorPreference.resourceId ? outdoorPreference.resourceId : tempestStationId,
    label: tempestStation?.name || 'Tempest Weather Station',
    deviceType: 'weather_station',
    room: tempestStation?.room || 'Outside',
    sourceKey: tempestStationId ? `tempest_station:${tempestStationId}` : '',
    available: Boolean(tempestStation),
    live: tempestStation?.status?.websocketConnected === true
  });

  const indoorClimate = buildClimateSourceDescriptor({
    capability: 'indoor_climate',
    moduleId: indoorPreference.mode === 'selected' && indoorPreference.moduleId ? indoorPreference.moduleId : 'govee-indoor-air',
    resourceId: indoorPreference.mode === 'selected' && indoorPreference.resourceId ? indoorPreference.resourceId : indoorResourceId,
    label: indoorAirSnapshot?.deviceName || 'Govee Indoor Air',
    deviceType: 'air_quality_monitor',
    room: indoorAirSnapshot?.room || 'Inside',
    sourceKey: indoorAirSnapshot?.sourceKey || (indoorAirSnapshot?.device ? `govee_air_quality:${indoorAirSnapshot.device}` : ''),
    available: Boolean(indoorAirSnapshot),
    live: indoorAirSnapshot?.isOnline !== false
  });

  return {
    preferences: {
      outdoorClimate: outdoorPreference,
      indoorClimate: indoorPreference
    },
    outdoorClimate,
    indoorClimate
  };
}

async function hydratePersistentWeatherCacheEntry(cache, kind, key, ttlMs) {
  const persisted = await weatherCacheStore.getEntry(kind, [key]).catch(() => null);
  if (!persisted || persisted.value === undefined) {
    return null;
  }

  const updatedAt = parseUpdatedAtTimestamp(persisted.updatedAt);
  const hydratedEntry = {
    value: persisted.value,
    expiresAt: updatedAt > 0 ? updatedAt + ttlMs : 0,
    updatedAt
  };
  cache.set(key, hydratedEntry);
  return hydratedEntry;
}

async function loadPersistentWeatherFallback(kind, keys, staleIfErrorMs) {
  const persisted = await weatherCacheStore.getEntry(kind, keys).catch(() => null);
  if (!persisted || persisted.value === undefined) {
    return null;
  }

  const updatedAt = parseUpdatedAtTimestamp(persisted.updatedAt);
  if (updatedAt <= 0) {
    return null;
  }

  if ((Date.now() - updatedAt) > staleIfErrorMs) {
    return null;
  }

  return {
    key: persisted.key,
    value: persisted.value,
    updatedAt
  };
}

async function readThroughWeatherCache(cache, { kind, key, recoveryKeys = [], ttlMs, staleIfErrorMs, loader }) {
  const now = Date.now();
  let cached = cache.get(key);

  if (!cached) {
    cached = await hydratePersistentWeatherCacheEntry(cache, kind, key, ttlMs);
  }

  if (cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }

  const wrappedLoader = async () => {
    const value = await loader();
    await weatherCacheStore.setEntry(kind, [key, ...recoveryKeys], value);
    return value;
  };

  try {
    return await readThroughCache(cache, key, ttlMs, wrappedLoader, {
      staleIfErrorMs
    });
  } catch (error) {
    const persistedFallback = await loadPersistentWeatherFallback(kind, [key, ...recoveryKeys], staleIfErrorMs);
    if (persistedFallback) {
      cache.set(key, {
        value: persistedFallback.value,
        expiresAt: Date.now() + ttlMs,
        updatedAt: persistedFallback.updatedAt
      });
      return persistedFallback.value;
    }

    throw error;
  }
}

async function readThroughCache(cache, key, ttlMs, loader, options = {}) {
  const now = Date.now();
  const staleIfErrorMs = parsePositiveInteger(options.staleIfErrorMs, ttlMs);
  const cached = cache.get(key);

  if (cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }

  if (cached?.promise) {
    return cached.promise;
  }

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      cache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
        updatedAt: Date.now()
      });
      return value;
    })
    .catch((error) => {
      if (cached?.value !== undefined) {
        const updatedAt = Number(cached.updatedAt || 0);
        if (updatedAt > 0 && (now - updatedAt) <= staleIfErrorMs) {
          cache.set(key, {
            value: cached.value,
            expiresAt: now + ttlMs,
            updatedAt
          });
          return cached.value;
        }
      }

      cache.delete(key);
      throw error;
    });

  cache.set(key, {
    expiresAt: cached?.expiresAt || 0,
    promise,
    value: cached?.value,
    updatedAt: cached?.updatedAt || 0
  });

  return promise;
}

function describeWeatherCode(code) {
  const normalizedCode = toNumber(code);
  if (normalizedCode === null) {
    return { label: 'Unknown', icon: 'cloudy' };
  }

  return WEATHER_LABELS[normalizedCode] || { label: 'Unknown', icon: 'cloudy' };
}

function buildLocationName(result, fallback = 'Saved location') {
  const pieces = [
    typeof result?.name === 'string' ? result.name.trim() : '',
    typeof result?.admin1 === 'string' ? result.admin1.trim() : '',
    typeof result?.country === 'string' ? result.country.trim() : ''
  ].filter(Boolean);

  if (pieces.length === 0) {
    return fallback;
  }

  return [...new Set(pieces)].join(', ');
}

function normalizeLocationQuery(query) {
  return typeof query === 'string'
    ? query
      .trim()
      .replace(/\s*,\s*/g, ', ')
      .replace(/\s{2,}/g, ' ')
    : '';
}

function parseUsCityStateQuery(query) {
  const normalized = normalizeLocationQuery(query);
  const match = normalized.match(/^([^,]+),\s*([A-Za-z]{2})(?:,\s*(?:US|USA|United States))?$/i);
  if (!match) {
    return null;
  }

  const city = match[1]?.trim();
  const stateCode = match[2]?.trim().toUpperCase();
  const stateName = US_STATE_ABBREVIATIONS[stateCode];

  if (!city || !stateName) {
    return null;
  }

  return {
    city,
    stateCode,
    stateName,
    normalizedQuery: `${city}, ${stateName}, United States`
  };
}

function pickUsCityStateResult(results, parsedQuery) {
  if (!Array.isArray(results) || results.length === 0 || !parsedQuery) {
    return null;
  }

  const stateName = parsedQuery.stateName.toLowerCase();
  const stateCode = parsedQuery.stateCode.toLowerCase();

  return results.find((result) => {
    const admin1 = typeof result?.admin1 === 'string' ? result.admin1.trim().toLowerCase() : '';
    return admin1 === stateName || admin1 === stateCode;
  }) || null;
}

async function fetchGeocodeCandidates(params) {
  const response = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
    params: {
      count: 5,
      language: 'en',
      format: 'json',
      ...params
    },
    timeout: 10000
  });

  return Array.isArray(response?.data?.results) ? response.data.results : [];
}

function createWeatherPayload(forecastResponse, airQualityResponse, location) {
  if (!location && airQualityResponse && typeof airQualityResponse === 'object') {
    const looksLikeLocation = (
      Object.prototype.hasOwnProperty.call(airQualityResponse, 'name')
      || Object.prototype.hasOwnProperty.call(airQualityResponse, 'latitude')
      || Object.prototype.hasOwnProperty.call(airQualityResponse, 'longitude')
      || Object.prototype.hasOwnProperty.call(airQualityResponse, 'source')
    );

    if (looksLikeLocation) {
      location = airQualityResponse;
      airQualityResponse = null;
    }
  }

  const current = forecastResponse?.current || {};
  const daily = forecastResponse?.daily || {};
  const hourly = forecastResponse?.hourly || {};
  const airQualityCurrent = airQualityResponse?.current || {};
  const todayCode = Array.isArray(daily.weather_code) ? daily.weather_code[0] : current.weather_code;
  const currentDescriptor = describeWeatherCode(current.weather_code);
  const todayDescriptor = describeWeatherCode(todayCode);
  const hourlyTimes = Array.isArray(hourly.time) ? hourly.time : [];
  const hourlyTemperatures = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
  const hourlyPrecipitation = Array.isArray(hourly.precipitation_probability) ? hourly.precipitation_probability : [];
  const hourlyWind = Array.isArray(hourly.wind_speed_10m) ? hourly.wind_speed_10m : [];
  const hourlyCodes = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];

  return {
    fetchedAt: new Date().toISOString(),
    location: {
      name: location?.name || 'Unknown location',
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      timezone: forecastResponse?.timezone || location?.timezone || 'auto',
      source: location?.source || 'geocode'
    },
    current: {
      temperatureF: toNumber(current.temperature_2m),
      apparentTemperatureF: toNumber(current.apparent_temperature),
      humidity: toNumber(current.relative_humidity_2m),
      windSpeedMph: toNumber(current.wind_speed_10m),
      precipitationIn: toNumber(current.precipitation),
      airQualityIndex: toNumber(airQualityCurrent.us_aqi),
      isDay: current.is_day === 1,
      weatherCode: toNumber(current.weather_code),
      condition: currentDescriptor.label,
      icon: currentDescriptor.icon
    },
    today: {
      highF: Array.isArray(daily.temperature_2m_max) ? toNumber(daily.temperature_2m_max[0]) : null,
      lowF: Array.isArray(daily.temperature_2m_min) ? toNumber(daily.temperature_2m_min[0]) : null,
      precipitationChance: Array.isArray(daily.precipitation_probability_max) ? toNumber(daily.precipitation_probability_max[0]) : null,
      sunrise: Array.isArray(daily.sunrise) ? daily.sunrise[0] || null : null,
      sunset: Array.isArray(daily.sunset) ? daily.sunset[0] || null : null,
      weatherCode: toNumber(todayCode),
      condition: todayDescriptor.label,
      icon: todayDescriptor.icon
    },
    hourlyForecast: hourlyTimes.slice(0, 24).map((time, index) => {
      const descriptor = describeWeatherCode(hourlyCodes[index]);
      return {
        time,
        temperatureF: toNumber(hourlyTemperatures[index]),
        precipitationChance: toNumber(hourlyPrecipitation[index]),
        windSpeedMph: toNumber(hourlyWind[index]),
        weatherCode: toNumber(hourlyCodes[index]),
        condition: descriptor.label,
        icon: descriptor.icon
      };
    })
  };
}

function createTempestFallbackWeatherPayload(location, tempestStation) {
  const stationName = tempestStation?.name || 'Tempest Station';
  const stationMetrics = tempestStation?.metrics || {};
  const fallbackCondition = tempestStation?.status?.websocketConnected
    ? 'Live Tempest Station'
    : 'Tempest Snapshot';
  const fallbackIcon = stationMetrics.rainRateInPerHr && stationMetrics.rainRateInPerHr > 0
    ? 'rain'
    : 'partly-cloudy';

  return {
    fetchedAt: new Date().toISOString(),
    location: {
      name: location?.name || stationName,
      latitude: location?.latitude ?? tempestStation?.location?.latitude ?? null,
      longitude: location?.longitude ?? tempestStation?.location?.longitude ?? null,
      timezone: location?.timezone || tempestStation?.location?.timezone || 'auto',
      source: location?.source || 'saved'
    },
    current: {
      temperatureF: toNumber(stationMetrics.temperatureF),
      apparentTemperatureF: toNumber(stationMetrics.feelsLikeF),
      humidity: toNumber(stationMetrics.humidityPct),
      windSpeedMph: toNumber(stationMetrics.windAvgMph),
      precipitationIn: toNumber(stationMetrics.rainLastMinuteIn),
      airQualityIndex: null,
      isDay: true,
      weatherCode: null,
      condition: fallbackCondition,
      icon: fallbackIcon
    },
    today: {
      highF: null,
      lowF: null,
      precipitationChance: null,
      sunrise: null,
      sunset: null,
      weatherCode: null,
      condition: fallbackCondition,
      icon: fallbackIcon
    },
    hourlyForecast: []
  };
}

function mergeTempestCurrentConditions(weatherPayload, tempestStation) {
  if (!weatherPayload || !tempestStation) {
    return weatherPayload;
  }

  const livePrecipitationNow = toNumber(tempestStation?.metrics?.rainLastMinuteIn);
  if (livePrecipitationNow === null) {
    return weatherPayload;
  }

  return {
    ...weatherPayload,
    current: {
      ...weatherPayload.current,
      precipitationIn: livePrecipitationNow
    }
  };
}

async function geocodeLocation(query, source) {
  const normalizedQuery = normalizeLocationQuery(query);
  const cacheKey = normalizedQuery.toLowerCase();
  const resolvedLocation = await readThroughCache(geocodeCache, cacheKey, GEOCODE_CACHE_TTL_MS, async () => {
    const exactMatches = await fetchGeocodeCandidates({ name: normalizedQuery });
    let result = exactMatches[0] || null;

    if (!result) {
      const parsedUsQuery = parseUsCityStateQuery(normalizedQuery);
      if (parsedUsQuery) {
        const usMatches = await fetchGeocodeCandidates({
          name: parsedUsQuery.city,
          countryCode: 'US'
        });
        result = pickUsCityStateResult(usMatches, parsedUsQuery) || usMatches[0] || null;
      }
    }

    if (!result) {
      throw new Error(`Unable to resolve weather location for "${normalizedQuery || query}".`);
    }

    return {
      latitude: result.latitude,
      longitude: result.longitude,
      timezone: result.timezone || null,
      name: buildLocationName(result, normalizedQuery || query)
    };
  }, {
    staleIfErrorMs: GEOCODE_STALE_IF_ERROR_MS
  });

  return {
    ...resolvedLocation,
    source
  };
}

async function resolveWeatherLocation({ latitude, longitude, address, label }) {
  const coordinates = normalizeCoordinates(latitude, longitude);
  if (coordinates) {
    return {
      ...coordinates,
      timezone: null,
      name: typeof label === 'string' && label.trim() ? label.trim() : 'Current location',
      source: 'auto'
    };
  }

  const trimmedAddress = typeof address === 'string' ? address.trim() : '';
  if (trimmedAddress) {
    return geocodeLocation(trimmedAddress, 'custom');
  }

  const savedLocation = await settingsService.getSetting('location');
  if (typeof savedLocation === 'string' && savedLocation.trim()) {
    return geocodeLocation(savedLocation.trim(), 'saved');
  }

  throw new Error('No weather location is configured. Add an address in Settings or choose a custom/auto weather source.');
}

async function buildDashboardWeatherPayload(location, options = {}) {
  const forecastCacheKey = buildForecastCacheKey(location);
  const airQualityCacheKey = buildAirQualityCacheKey(location);
  const forecastRecoveryKeys = buildRecoveryCacheKeys(location, PERSISTED_WEATHER_CACHE_KIND_FORECAST);
  const airQualityRecoveryKeys = buildRecoveryCacheKeys(location, PERSISTED_WEATHER_CACHE_KIND_AIR_QUALITY);
  const tempestStation = Object.prototype.hasOwnProperty.call(options, 'tempestStation')
    ? options.tempestStation
    : await getWeatherTempestSnapshot();
  const indoorAirSnapshot = Object.prototype.hasOwnProperty.call(options, 'indoorAirSnapshot')
    ? options.indoorAirSnapshot
    : await getWeatherIndoorAirSnapshot();
  const includeModuleTelemetry = parseBooleanFlag(options.includeModuleTelemetry);

  const forecastPromise = (async () => {
    try {
      return await readThroughWeatherCache(forecastCache, {
        kind: PERSISTED_WEATHER_CACHE_KIND_FORECAST,
        key: forecastCacheKey,
        recoveryKeys: forecastRecoveryKeys,
        ttlMs: FORECAST_CACHE_TTL_MS,
        staleIfErrorMs: FORECAST_STALE_IF_ERROR_MS,
        loader: async () => {
          const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
            params: {
              latitude: location.latitude,
              longitude: location.longitude,
              current: [
                'temperature_2m',
                'relative_humidity_2m',
                'apparent_temperature',
                'is_day',
                'precipitation',
                'weather_code',
                'wind_speed_10m'
              ].join(','),
              daily: [
                'weather_code',
                'temperature_2m_max',
                'temperature_2m_min',
                'precipitation_probability_max',
                'sunrise',
                'sunset'
              ].join(','),
              hourly: [
                'temperature_2m',
                'precipitation_probability',
                'weather_code',
                'wind_speed_10m'
              ].join(','),
              temperature_unit: 'fahrenheit',
              wind_speed_unit: 'mph',
              precipitation_unit: 'inch',
              timezone: 'auto',
              forecast_days: 2
            },
            timeout: 10000
          });

          return response.data;
        }
      });
    } catch (error) {
      if (!tempestStation) {
        throw error;
      }

      return null;
    }
  })();

  const airQualityPromise = readThroughWeatherCache(airQualityCache, {
    kind: PERSISTED_WEATHER_CACHE_KIND_AIR_QUALITY,
    key: airQualityCacheKey,
    recoveryKeys: airQualityRecoveryKeys,
    ttlMs: AIR_QUALITY_CACHE_TTL_MS,
    staleIfErrorMs: AIR_QUALITY_STALE_IF_ERROR_MS,
    loader: async () => {
      const response = await axios.get('https://air-quality-api.open-meteo.com/v1/air-quality', {
        params: {
          latitude: location.latitude,
          longitude: location.longitude,
          current: 'us_aqi',
          timezone: 'auto'
        },
        timeout: 10000
      });

      return response.data;
    }
  }).catch(() => null);

  const [forecastResponse, airQualityResponse] = await Promise.all([
    forecastPromise,
    airQualityPromise
  ]);

  let moduleTelemetry = null;
  if (includeModuleTelemetry && tempestStation?.id) {
    moduleTelemetry = await loadTempestModuleTelemetry(tempestStation.id);
  }

  const weatherPayload = mergeTempestCurrentConditions(
    forecastResponse
      ? createWeatherPayload(forecastResponse, airQualityResponse, location)
      : createTempestFallbackWeatherPayload(location, tempestStation),
    tempestStation
  );
  const climateSources = await buildClimateSourceMetadata({ tempestStation, indoorAirSnapshot });

  return {
    ...weatherPayload,
    climate: {
      outdoor: climateSources.outdoorClimate,
      indoor: climateSources.indoorClimate,
      preferences: climateSources.preferences
    },
    sources: {
      outdoorClimate: climateSources.outdoorClimate,
      indoorClimate: climateSources.indoorClimate
    },
    tempest: tempestStation
      ? {
          available: true,
          station: tempestStation,
          moduleTelemetry
        }
      : {
          available: false,
          station: null,
          moduleTelemetry: null
        },
    indoorAir: indoorAirSnapshot
      ? {
          available: true,
          monitor: indoorAirSnapshot
        }
      : {
          available: false,
          monitor: null
        }
  };
}

async function fetchDashboardWeather(options = {}) {
  const location = await resolveWeatherLocation(options);
  const forceTempestSync = parseBooleanFlag(options.forceTempestSync);
  const forceIndoorAirSync = parseBooleanFlag(options.forceIndoorAirSync);
  const includeModuleTelemetry = parseBooleanFlag(options.includeModuleTelemetry);
  const refreshIndoorAir = parseBooleanFlag(options.refreshIndoorAir);
  let tempestStation = await getWeatherTempestSnapshot();
  const refreshResult = await refreshTempestForWeatherIfNeeded(tempestStation, options);
  tempestStation = refreshResult.tempestStation || tempestStation;
  let indoorAirSnapshot = await getWeatherIndoorAirSnapshot();
  const indoorAirRefreshResult = (forceIndoorAirSync || refreshIndoorAir)
    ? await refreshIndoorAirForWeatherIfNeeded(indoorAirSnapshot, options)
    : { refreshed: false, indoorAirSnapshot };
  indoorAirSnapshot = indoorAirRefreshResult.indoorAirSnapshot || indoorAirSnapshot;

  const dashboardCacheKey = buildDashboardWeatherCacheKey(location, { includeModuleTelemetry });
  if (refreshResult.refreshed || indoorAirRefreshResult.refreshed) {
    dashboardWeatherCache.delete(dashboardCacheKey);
  }

  if (forceTempestSync || forceIndoorAirSync) {
    return buildDashboardWeatherPayload(location, { tempestStation, indoorAirSnapshot, includeModuleTelemetry });
  }

  return readThroughCache(
    dashboardWeatherCache,
    dashboardCacheKey,
    DASHBOARD_WEATHER_CACHE_TTL_MS,
    () => buildDashboardWeatherPayload(location, { tempestStation, indoorAirSnapshot, includeModuleTelemetry })
  );
}

async function fetchWeatherDashboard(options = {}) {
  const includeModuleTelemetry = parseBooleanFlag(options.includeModuleTelemetry);
  const forecast = await fetchDashboardWeather({
    ...options,
    includeModuleTelemetry: false,
    refreshIndoorAir: parseBooleanFlag(options.refreshIndoorAir)
  });
  const tempest = await tempestService.getDashboardData({
    hours: options.tempestHistoryHours || 24
  }).catch(() => ({
    available: false,
    station: null,
    observations: [],
    events: [],
    moduleTelemetry: null
  }));
  const indoorAir = await goveeAirQualityService.getDashboardData({
    hours: options.indoorAirHistoryHours || 24
  }).catch(() => ({
    available: false,
    monitor: null,
    samples: [],
    health: null
  }));

  const moduleTelemetry = forecast?.tempest?.moduleTelemetry
    ?? (includeModuleTelemetry && tempest?.available && tempest?.station?.id
      ? await loadTempestModuleTelemetry(tempest.station.id)
      : null);

  return {
    fetchedAt: new Date().toISOString(),
    forecast,
    climate: forecast?.climate || null,
    sources: forecast?.sources || null,
    hourlyForecast: Array.isArray(forecast.hourlyForecast) ? forecast.hourlyForecast : [],
    tempest: {
      ...tempest,
      moduleTelemetry
    },
    indoorAir
  };
}

module.exports = {
  buildLocationName,
  createWeatherPayload,
  describeWeatherCode,
  fetchDashboardWeather,
  fetchWeatherDashboard,
  normalizeCoordinates,
  normalizeLocationQuery,
  parseUsCityStateQuery,
  pickUsCityStateResult,
  __resetWeatherCachesForTests: () => {
    forecastCache.clear();
    airQualityCache.clear();
    geocodeCache.clear();
    dashboardWeatherCache.clear();
    lastWeatherTempestRefreshAttemptAt = 0;
    lastWeatherGoveeRefreshAttemptAt = 0;
    weatherCacheStore.resetForTests();
  }
};

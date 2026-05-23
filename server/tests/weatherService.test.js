const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const axios = require('axios');
const tempestService = require('../services/tempestService');
const telemetryService = require('../services/telemetryService');
const goveeAirQualityService = require('../services/goveeAirQualityService');

const {
  buildLocationName,
  createWeatherPayload,
  describeWeatherCode,
  fetchDashboardWeather,
  fetchWeatherDashboard,
  normalizeCoordinates,
  normalizeLocationQuery,
  parseUsCityStateQuery,
  pickUsCityStateResult,
  __resetWeatherCachesForTests
} = require('../services/weatherService');

async function setupIsolatedWeatherCache(t) {
  const originalPersistPath = process.env.WEATHER_PERSIST_PATH;
  const originalNodeEnv = process.env.NODE_ENV;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-weather-cache-'));
  const persistPath = path.join(tempDir, 'weather-provider-cache.json');

  process.env.WEATHER_PERSIST_PATH = persistPath;
  process.env.NODE_ENV = 'test';
  __resetWeatherCachesForTests();

  t.after(async () => {
    if (originalPersistPath === undefined) {
      delete process.env.WEATHER_PERSIST_PATH;
    } else {
      process.env.WEATHER_PERSIST_PATH = originalPersistPath;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    __resetWeatherCachesForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  return persistPath;
}

test('normalizeCoordinates validates latitude and longitude ranges', () => {
  assert.deepEqual(normalizeCoordinates('39.7392', '-104.9903'), {
    latitude: 39.7392,
    longitude: -104.9903
  });
  assert.equal(normalizeCoordinates('123', '45'), null);
  assert.equal(normalizeCoordinates('39', '-999'), null);
});

test('describeWeatherCode maps known weather codes to readable labels', () => {
  assert.deepEqual(describeWeatherCode(0), { label: 'Clear', icon: 'sunny' });
  assert.deepEqual(describeWeatherCode(63), { label: 'Rain', icon: 'rain' });
  assert.deepEqual(describeWeatherCode(999), { label: 'Unknown', icon: 'cloudy' });
});

test('normalizeLocationQuery standardizes comma spacing', () => {
  assert.equal(normalizeLocationQuery('  Lehi,UT  '), 'Lehi, UT');
  assert.equal(normalizeLocationQuery('Salt   Lake City ,  UT'), 'Salt Lake City, UT');
});

test('parseUsCityStateQuery supports compact city/state input', () => {
  assert.deepEqual(parseUsCityStateQuery('Lehi,UT'), {
    city: 'Lehi',
    stateCode: 'UT',
    stateName: 'Utah',
    normalizedQuery: 'Lehi, Utah, United States'
  });
  assert.equal(parseUsCityStateQuery('Paris, France'), null);
});

test('pickUsCityStateResult chooses the matching state from broader US results', () => {
  const parsed = parseUsCityStateQuery('Lehi, UT');
  const result = pickUsCityStateResult([
    { name: 'Lehi', admin1: 'Arkansas' },
    { name: 'Lehi', admin1: 'Utah' }
  ], parsed);

  assert.deepEqual(result, { name: 'Lehi', admin1: 'Utah' });
});

test('buildLocationName creates a readable fallback label', () => {
  assert.equal(buildLocationName({
    name: 'Lehi',
    admin1: 'Utah',
    country: 'United States'
  }, 'Lehi, UT'), 'Lehi, Utah, United States');
});

test('createWeatherPayload normalizes current and daily forecast data', () => {
  const payload = createWeatherPayload(
    {
      timezone: 'America/Denver',
      current: {
        temperature_2m: 67.4,
        apparent_temperature: 65.2,
        relative_humidity_2m: 42,
        wind_speed_10m: 7.8,
        precipitation: 0,
        weather_code: 2,
        is_day: 1
      },
      daily: {
        weather_code: [61],
        temperature_2m_max: [74.3],
        temperature_2m_min: [49.8],
        precipitation_probability_max: [55],
        sunrise: ['2026-03-23T07:01'],
        sunset: ['2026-03-23T19:14']
      }
    },
    {
      name: 'Denver, Colorado, United States',
      latitude: 39.7392,
      longitude: -104.9903,
      source: 'custom'
    }
  );

  assert.equal(payload.location.name, 'Denver, Colorado, United States');
  assert.equal(payload.current.temperatureF, 67.4);
  assert.equal(payload.current.condition, 'Partly Cloudy');
  assert.equal(payload.today.highF, 74.3);
  assert.equal(payload.today.condition, 'Light Rain');
  assert.equal(payload.today.sunrise, '2026-03-23T07:01');
  assert.equal(Array.isArray(payload.hourlyForecast), true);
});

test('fetchDashboardWeather skips heavy telemetry and stale indoor-air sync by default', async (t) => {
  await setupIsolatedWeatherCache(t);
  const originalAxiosGet = axios.get;
  const originalGetSelectedStationSnapshot = tempestService.getSelectedStationSnapshot;
  const originalGetTempestModuleTelemetry = telemetryService.getTempestModuleTelemetry;
  const originalGetLatestSnapshot = goveeAirQualityService.getLatestSnapshot;
  const originalSyncNow = goveeAirQualityService.syncNow;

  t.after(() => {
    axios.get = originalAxiosGet;
    tempestService.getSelectedStationSnapshot = originalGetSelectedStationSnapshot;
    telemetryService.getTempestModuleTelemetry = originalGetTempestModuleTelemetry;
    goveeAirQualityService.getLatestSnapshot = originalGetLatestSnapshot;
    goveeAirQualityService.syncNow = originalSyncNow;
  });

  axios.get = async (url) => {
    const requestUrl = new URL(url);
    if (requestUrl.hostname === 'api.open-meteo.com' && requestUrl.pathname === '/v1/forecast') {
      return {
        data: {
          timezone: 'America/Denver',
          current: {
            temperature_2m: 67.4,
            apparent_temperature: 65.2,
            relative_humidity_2m: 42,
            wind_speed_10m: 7.8,
            precipitation: 0,
            weather_code: 2,
            is_day: 1
          },
          daily: {
            weather_code: [61],
            temperature_2m_max: [74.3],
            temperature_2m_min: [49.8],
            precipitation_probability_max: [55],
            sunrise: ['2026-03-23T07:01'],
            sunset: ['2026-03-23T19:14']
          }
        }
      };
    }

    if (requestUrl.hostname === 'air-quality-api.open-meteo.com') {
      return {
        data: {
          current: {
            us_aqi: 38
          }
        }
      };
    }

    throw new Error(`Unexpected axios request: ${url}`);
  };

  tempestService.getSelectedStationSnapshot = async () => ({
    id: 'tempest-device-1',
    name: 'Backyard Tempest',
    room: 'Outside',
    observedAt: new Date().toISOString(),
    metrics: {
      temperatureF: 66.9,
      rainLastMinuteIn: 0.03
    },
    status: {
      websocketConnected: true
    }
  });

  let telemetryCalls = 0;
  let syncCalls = 0;

  telemetryService.getTempestModuleTelemetry = async () => {
    telemetryCalls += 1;
    return null;
  };
  goveeAirQualityService.getLatestSnapshot = async () => ({
    id: 'govee-sample-1',
    device: 'AA:BB:CC',
    sku: 'H5106',
    deviceName: 'Inside Air',
    room: 'Inside',
    observedAt: '2026-04-02T16:00:00.000Z',
    temperatureF: 71.2,
    humidityPct: 42,
    pm25UgM3: 4.5,
    usAqi: 19,
    qualityLabel: 'Good'
  });
  goveeAirQualityService.syncNow = async () => {
    syncCalls += 1;
    return { success: true };
  };

  const payload = await fetchDashboardWeather({
    latitude: '39.7392',
    longitude: '-104.9903',
    label: 'Current location'
  });

  assert.equal(telemetryCalls, 0);
  assert.equal(syncCalls, 0);
  assert.equal(payload.tempest.moduleTelemetry, null);
  assert.equal(payload.indoorAir.available, true);
  assert.equal(payload.indoorAir.monitor?.deviceName, 'Inside Air');
});

test('fetchDashboardWeather attaches Tempest module telemetry when requested', async (t) => {
  await setupIsolatedWeatherCache(t);
  const originalAxiosGet = axios.get;
  const originalGetSelectedStationSnapshot = tempestService.getSelectedStationSnapshot;
  const originalGetTempestModuleTelemetry = telemetryService.getTempestModuleTelemetry;

  t.after(() => {
    axios.get = originalAxiosGet;
    tempestService.getSelectedStationSnapshot = originalGetSelectedStationSnapshot;
    telemetryService.getTempestModuleTelemetry = originalGetTempestModuleTelemetry;
  });

  const moduleTelemetry = {
    generatedAt: '2026-04-02T17:00:00.000Z',
    sourceKey: 'tempest_station:tempest-device-1',
    sourceId: 'tempest-device-1',
    stationId: 12345,
    stationName: 'Backyard Tempest',
    windows: []
  };

  let telemetryArgs = null;

  axios.get = async (url) => {
    const requestUrl = new URL(url);
    if (requestUrl.hostname === 'api.open-meteo.com' && requestUrl.pathname === '/v1/forecast') {
      return {
        data: {
          timezone: 'America/Denver',
          current: {
            temperature_2m: 67.4,
            apparent_temperature: 65.2,
            relative_humidity_2m: 42,
            wind_speed_10m: 7.8,
            precipitation: 0,
            weather_code: 2,
            is_day: 1
          },
          daily: {
            weather_code: [61],
            temperature_2m_max: [74.3],
            temperature_2m_min: [49.8],
            precipitation_probability_max: [55],
            sunrise: ['2026-03-23T07:01'],
            sunset: ['2026-03-23T19:14']
          }
        }
      };
    }

    if (requestUrl.hostname === 'air-quality-api.open-meteo.com') {
      return {
        data: {
          current: {
            us_aqi: 38
          }
        }
      };
    }

    throw new Error(`Unexpected axios request: ${url}`);
  };

  tempestService.getSelectedStationSnapshot = async () => ({
    id: 'tempest-device-1',
    name: 'Backyard Tempest',
    room: 'Outside',
    observedAt: new Date().toISOString(),
    metrics: {
      temperatureF: 66.9,
      rainLastMinuteIn: 0.03
    },
    status: {
      websocketConnected: true
    }
  });

  telemetryService.getTempestModuleTelemetry = async (args) => {
    telemetryArgs = args;
    return moduleTelemetry;
  };

  const payload = await fetchDashboardWeather({
    latitude: '39.7392',
    longitude: '-104.9903',
    label: 'Current location',
    includeModuleTelemetry: true
  });

  assert.deepEqual(telemetryArgs, { sourceId: 'tempest-device-1' });
  assert.deepEqual(payload.tempest.moduleTelemetry, moduleTelemetry);
  assert.equal(payload.tempest.station?.name, 'Backyard Tempest');
  assert.equal(payload.current.precipitationIn, 0.03);
});

test('fetchWeatherDashboard does not block on Tempest module telemetry by default', async (t) => {
  await setupIsolatedWeatherCache(t);
  const originalAxiosGet = axios.get;
  const originalGetSelectedStationSnapshot = tempestService.getSelectedStationSnapshot;
  const originalGetDashboardData = tempestService.getDashboardData;
  const originalGetTempestModuleTelemetry = telemetryService.getTempestModuleTelemetry;

  t.after(() => {
    axios.get = originalAxiosGet;
    tempestService.getSelectedStationSnapshot = originalGetSelectedStationSnapshot;
    tempestService.getDashboardData = originalGetDashboardData;
    telemetryService.getTempestModuleTelemetry = originalGetTempestModuleTelemetry;
  });

  axios.get = async (url) => {
    const requestUrl = new URL(url);
    if (requestUrl.hostname === 'api.open-meteo.com' && requestUrl.pathname === '/v1/forecast') {
      return {
        data: {
          timezone: 'America/Denver',
          current: {
            temperature_2m: 67.4,
            apparent_temperature: 65.2,
            relative_humidity_2m: 42,
            wind_speed_10m: 7.8,
            precipitation: 0,
            weather_code: 2,
            is_day: 1
          },
          daily: {
            weather_code: [61],
            temperature_2m_max: [74.3],
            temperature_2m_min: [49.8],
            precipitation_probability_max: [55],
            sunrise: ['2026-03-23T07:01'],
            sunset: ['2026-03-23T19:14']
          }
        }
      };
    }

    if (requestUrl.hostname === 'air-quality-api.open-meteo.com') {
      return {
        data: {
          current: {
            us_aqi: 38
          }
        }
      };
    }

    throw new Error(`Unexpected axios request: ${url}`);
  };

  const station = {
    id: 'tempest-device-1',
    stationId: 12345,
    name: 'Backyard Tempest',
    room: 'Outside',
    observedAt: new Date().toISOString(),
    metrics: {
      temperatureF: 66.9,
      rainLastMinuteIn: 0.03
    },
    status: {
      websocketConnected: true
    }
  };

  let telemetryCalls = 0;
  tempestService.getSelectedStationSnapshot = async () => station;
  tempestService.getDashboardData = async () => ({
    available: true,
    station,
    observations: [],
    events: []
  });
  telemetryService.getTempestModuleTelemetry = async () => {
    telemetryCalls += 1;
    return { generatedAt: '2026-04-02T17:00:00.000Z' };
  };

  const payload = await fetchWeatherDashboard({
    latitude: '39.7392',
    longitude: '-104.9903',
    label: 'Current location'
  });

  assert.equal(telemetryCalls, 0);
  assert.equal(payload.tempest.moduleTelemetry, null);
});

test('fetchWeatherDashboard times out optional Tempest module telemetry', async (t) => {
  await setupIsolatedWeatherCache(t);
  const originalAxiosGet = axios.get;
  const originalGetSelectedStationSnapshot = tempestService.getSelectedStationSnapshot;
  const originalGetDashboardData = tempestService.getDashboardData;
  const originalGetTempestModuleTelemetry = telemetryService.getTempestModuleTelemetry;
  const originalTimeoutMs = process.env.WEATHER_MODULE_TELEMETRY_TIMEOUT_MS;

  t.after(() => {
    axios.get = originalAxiosGet;
    tempestService.getSelectedStationSnapshot = originalGetSelectedStationSnapshot;
    tempestService.getDashboardData = originalGetDashboardData;
    telemetryService.getTempestModuleTelemetry = originalGetTempestModuleTelemetry;
    if (originalTimeoutMs === undefined) {
      delete process.env.WEATHER_MODULE_TELEMETRY_TIMEOUT_MS;
    } else {
      process.env.WEATHER_MODULE_TELEMETRY_TIMEOUT_MS = originalTimeoutMs;
    }
  });

  process.env.WEATHER_MODULE_TELEMETRY_TIMEOUT_MS = '25';

  axios.get = async (url) => {
    const requestUrl = new URL(url);
    if (requestUrl.hostname === 'api.open-meteo.com' && requestUrl.pathname === '/v1/forecast') {
      return {
        data: {
          timezone: 'America/Denver',
          current: {
            temperature_2m: 67.4,
            apparent_temperature: 65.2,
            relative_humidity_2m: 42,
            wind_speed_10m: 7.8,
            precipitation: 0,
            weather_code: 2,
            is_day: 1
          },
          daily: {
            weather_code: [61],
            temperature_2m_max: [74.3],
            temperature_2m_min: [49.8],
            precipitation_probability_max: [55],
            sunrise: ['2026-03-23T07:01'],
            sunset: ['2026-03-23T19:14']
          }
        }
      };
    }

    if (requestUrl.hostname === 'air-quality-api.open-meteo.com') {
      return {
        data: {
          current: {
            us_aqi: 38
          }
        }
      };
    }

    throw new Error(`Unexpected axios request: ${url}`);
  };

  const station = {
    id: 'tempest-device-1',
    stationId: 12345,
    name: 'Backyard Tempest',
    room: 'Outside',
    observedAt: new Date().toISOString(),
    metrics: {
      temperatureF: 66.9,
      rainLastMinuteIn: 0.03
    },
    status: {
      websocketConnected: true
    }
  };

  tempestService.getSelectedStationSnapshot = async () => station;
  tempestService.getDashboardData = async () => ({
    available: true,
    station,
    observations: [],
    events: []
  });
  telemetryService.getTempestModuleTelemetry = async () => new Promise(() => {});

  const startedAt = Date.now();
  const payload = await fetchWeatherDashboard({
    latitude: '39.7392',
    longitude: '-104.9903',
    label: 'Current location',
    includeModuleTelemetry: true
  });

  assert.equal(payload.tempest.moduleTelemetry, null);
  assert.ok(Date.now() - startedAt < 500);
});

test('fetchWeatherDashboard forces a Tempest runtime refresh when requested', async (t) => {
  await setupIsolatedWeatherCache(t);
  const originalAxiosGet = axios.get;
  const originalRefreshRuntime = tempestService.refreshRuntime;
  const originalGetSelectedStationSnapshot = tempestService.getSelectedStationSnapshot;
  const originalGetDashboardData = tempestService.getDashboardData;
  const originalGetTempestModuleTelemetry = telemetryService.getTempestModuleTelemetry;

  t.after(() => {
    axios.get = originalAxiosGet;
    tempestService.refreshRuntime = originalRefreshRuntime;
    tempestService.getSelectedStationSnapshot = originalGetSelectedStationSnapshot;
    tempestService.getDashboardData = originalGetDashboardData;
    telemetryService.getTempestModuleTelemetry = originalGetTempestModuleTelemetry;
  });

  let refreshCalls = 0;
  let refreshArgs = null;

  axios.get = async (url) => {
    if (url.includes('api.open-meteo.com/v1/forecast')) {
      return {
        data: {
          timezone: 'America/Denver',
          current: {
            temperature_2m: 67.4,
            apparent_temperature: 65.2,
            relative_humidity_2m: 42,
            wind_speed_10m: 7.8,
            precipitation: 0,
            weather_code: 2,
            is_day: 1
          },
          daily: {
            weather_code: [61],
            temperature_2m_max: [74.3],
            temperature_2m_min: [49.8],
            precipitation_probability_max: [55],
            sunrise: ['2026-03-23T07:01'],
            sunset: ['2026-03-23T19:14']
          }
        }
      };
    }

    if (url.includes('air-quality-api.open-meteo.com')) {
      return {
        data: {
          current: {
            us_aqi: 38
          }
        }
      };
    }

    throw new Error(`Unexpected axios request: ${url}`);
  };

  tempestService.refreshRuntime = async (args) => {
    refreshCalls += 1;
    refreshArgs = args;
    return { success: true };
  };
  tempestService.getSelectedStationSnapshot = async () => ({
    id: 'tempest-device-1',
    stationId: 12345,
    name: 'Backyard Tempest',
    room: 'Outside',
    observedAt: '2026-04-02T17:00:00.000Z',
    metrics: {
      temperatureF: 66.9,
      rainLastMinuteIn: 0.03
    },
    status: {
      websocketConnected: true
    }
  });
  tempestService.getDashboardData = async () => ({
    available: true,
    station: {
      id: 'tempest-device-1',
      stationId: 12345,
      name: 'Backyard Tempest',
      room: 'Outside',
      observedAt: '2026-04-02T17:00:00.000Z',
      metrics: {
        temperatureF: 66.9,
        rainLastMinuteIn: 0.03
      },
      status: {
        websocketConnected: true
      }
    },
    observations: [],
    events: [],
    moduleTelemetry: null
  });
  telemetryService.getTempestModuleTelemetry = async () => null;

  const payload = await fetchWeatherDashboard({
    latitude: '39.7392',
    longitude: '-104.9903',
    label: 'Current location',
    forceTempestSync: true
  });

  assert.equal(refreshCalls, 1);
  assert.equal(refreshArgs?.reason, 'weather-manual-refresh');
  assert.equal(refreshArgs?.minIntervalMs, 5 * 60 * 1000);
  assert.equal(payload.tempest.available, true);
});

test('fetchWeatherDashboard refreshes a stale Tempest station before loading page telemetry', async (t) => {
  await setupIsolatedWeatherCache(t);
  const originalAxiosGet = axios.get;
  const originalRefreshRuntime = tempestService.refreshRuntime;
  const originalGetSelectedStationSnapshot = tempestService.getSelectedStationSnapshot;
  const originalGetDashboardData = tempestService.getDashboardData;
  const originalGetTempestModuleTelemetry = telemetryService.getTempestModuleTelemetry;
  const originalDateNow = Date.now;

  t.after(() => {
    axios.get = originalAxiosGet;
    tempestService.refreshRuntime = originalRefreshRuntime;
    tempestService.getSelectedStationSnapshot = originalGetSelectedStationSnapshot;
    tempestService.getDashboardData = originalGetDashboardData;
    telemetryService.getTempestModuleTelemetry = originalGetTempestModuleTelemetry;
    Date.now = originalDateNow;
  });

  Date.now = () => Date.parse('2026-04-02T17:00:00.000Z');

  axios.get = async (url) => {
    if (url.includes('api.open-meteo.com/v1/forecast')) {
      return {
        data: {
          timezone: 'America/Denver',
          current: {
            temperature_2m: 67.4,
            apparent_temperature: 65.2,
            relative_humidity_2m: 42,
            wind_speed_10m: 7.8,
            precipitation: 0,
            weather_code: 2,
            is_day: 1
          },
          daily: {
            weather_code: [61],
            temperature_2m_max: [74.3],
            temperature_2m_min: [49.8],
            precipitation_probability_max: [55],
            sunrise: ['2026-03-23T07:01'],
            sunset: ['2026-03-23T19:14']
          }
        }
      };
    }

    if (url.includes('air-quality-api.open-meteo.com')) {
      return {
        data: {
          current: {
            us_aqi: 38
          }
        }
      };
    }

    throw new Error(`Unexpected axios request: ${url}`);
  };

  const staleStation = {
    id: 'tempest-device-1',
    stationId: 12345,
    name: 'Backyard Tempest',
    room: 'Outside',
    observedAt: '2026-04-02T16:30:00.000Z',
    metrics: {
      temperatureF: 66.9,
      rainLastMinuteIn: 0
    },
    status: {
      websocketConnected: true
    }
  };
  const freshStation = {
    ...staleStation,
    observedAt: '2026-04-02T16:59:50.000Z',
    metrics: {
      temperatureF: 68.1,
      rainLastMinuteIn: 0
    }
  };
  const observations = [
    {
      stationId: 12345,
      deviceId: 67890,
      observationType: 'obs_st',
      source: 'ws',
      observedAt: freshStation.observedAt,
      metrics: { temp_c: 20.1 },
      derived: {}
    }
  ];

  let refreshCalls = 0;
  let refreshArgs = null;
  const loadOrder = [];

  tempestService.refreshRuntime = async (args) => {
    refreshCalls += 1;
    refreshArgs = args;
    loadOrder.push('refresh');
    return { success: true, reason: args.reason };
  };
  tempestService.getSelectedStationSnapshot = async () => (refreshCalls > 0 ? freshStation : staleStation);
  tempestService.getDashboardData = async () => {
    loadOrder.push('dashboard-data');
    assert.equal(refreshCalls, 1);
    return {
      available: true,
      station: freshStation,
      observations,
      events: [],
      moduleTelemetry: null
    };
  };
  telemetryService.getTempestModuleTelemetry = async () => null;

  const payload = await fetchWeatherDashboard({
    latitude: '39.7392',
    longitude: '-104.9903',
    label: 'Current location'
  });

  assert.equal(refreshCalls, 1);
  assert.equal(refreshArgs?.reason, 'weather-stale-tempest-refresh');
  assert.equal(refreshArgs?.minIntervalMs, 5 * 60 * 1000);
  assert.deepEqual(loadOrder, ['refresh', 'dashboard-data']);
  assert.equal(payload.tempest.station?.observedAt, freshStation.observedAt);
  assert.equal(payload.tempest.observations.length, 1);
  assert.equal(payload.forecast.tempest.station?.observedAt, freshStation.observedAt);
});

test('fetchDashboardWeather falls back to stale cached forecast data when Open-Meteo is rate limited', async (t) => {
  await setupIsolatedWeatherCache(t);
  const originalAxiosGet = axios.get;
  const originalGetSelectedStationSnapshot = tempestService.getSelectedStationSnapshot;
  const originalDateNow = Date.now;

  const baseNow = Date.parse('2026-04-07T22:20:00.000Z');
  let nowOffsetMs = 0;

  t.after(() => {
    axios.get = originalAxiosGet;
    tempestService.getSelectedStationSnapshot = originalGetSelectedStationSnapshot;
    Date.now = originalDateNow;
  });

  Date.now = () => baseNow + nowOffsetMs;

  const forecastPayload = {
    timezone: 'America/Denver',
    current: {
      temperature_2m: 67.4,
      apparent_temperature: 65.2,
      relative_humidity_2m: 42,
      wind_speed_10m: 7.8,
      precipitation: 0,
      weather_code: 2,
      is_day: 1
    },
    daily: {
      weather_code: [61],
      temperature_2m_max: [74.3],
      temperature_2m_min: [49.8],
      precipitation_probability_max: [55],
      sunrise: ['2026-03-23T07:01'],
      sunset: ['2026-03-23T19:14']
    },
    hourly: {
      time: ['2026-04-07T16:00'],
      temperature_2m: [67.4],
      precipitation_probability: [10],
      weather_code: [2],
      wind_speed_10m: [7.8]
    }
  };

  let forecastRequests = 0;

  axios.get = async (url) => {
    if (url.includes('api.open-meteo.com/v1/forecast')) {
      forecastRequests += 1;
      if (forecastRequests === 1) {
        return { data: forecastPayload };
      }

      const error = new Error('Request failed with status code 429');
      error.response = { status: 429 };
      throw error;
    }

    if (url.includes('air-quality-api.open-meteo.com')) {
      return {
        data: {
          current: {
            us_aqi: 38
          }
        }
      };
    }

    throw new Error(`Unexpected axios request: ${url}`);
  };

  tempestService.getSelectedStationSnapshot = async () => ({
    id: 'tempest-device-1',
    name: 'Backyard Tempest',
    room: 'Outside',
    observedAt: '2026-04-02T17:00:00.000Z',
    metrics: {
      temperatureF: 66.9
    },
    status: {
      websocketConnected: true
    }
  });

  const initial = await fetchDashboardWeather({
    latitude: '40.1122',
    longitude: '-111.6543',
    label: 'Current location'
  });

  nowOffsetMs = (5 * 60 * 1000) + 1_000;

  const fallback = await fetchDashboardWeather({
    latitude: '40.1122',
    longitude: '-111.6543',
    label: 'Current location'
  });

  assert.equal(forecastRequests, 2);
  assert.equal(initial.current.temperatureF, 67.4);
  assert.equal(fallback.current.temperatureF, 67.4);
  assert.equal(fallback.tempest.station?.name, 'Backyard Tempest');
});

test('fetchDashboardWeather reuses the same forecast cache entry across minor auto-location jitter', async (t) => {
  await setupIsolatedWeatherCache(t);
  const originalAxiosGet = axios.get;
  const originalGetSelectedStationSnapshot = tempestService.getSelectedStationSnapshot;

  t.after(() => {
    axios.get = originalAxiosGet;
    tempestService.getSelectedStationSnapshot = originalGetSelectedStationSnapshot;
  });

  const forecastPayload = {
    timezone: 'America/Denver',
    current: {
      temperature_2m: 72.6,
      apparent_temperature: 71.1,
      relative_humidity_2m: 38,
      wind_speed_10m: 6.2,
      precipitation: 0,
      weather_code: 1,
      is_day: 1
    },
    daily: {
      weather_code: [1],
      temperature_2m_max: [76.4],
      temperature_2m_min: [51.2],
      precipitation_probability_max: [12],
      sunrise: ['2026-04-07T06:54'],
      sunset: ['2026-04-07T19:46']
    },
    hourly: {
      time: ['2026-04-07T16:00'],
      temperature_2m: [72.6],
      precipitation_probability: [12],
      weather_code: [1],
      wind_speed_10m: [6.2]
    }
  };

  let forecastRequests = 0;
  let airQualityRequests = 0;

  axios.get = async (url) => {
    if (url.includes('api.open-meteo.com/v1/forecast')) {
      forecastRequests += 1;
      return { data: forecastPayload };
    }

    if (url.includes('air-quality-api.open-meteo.com')) {
      airQualityRequests += 1;
      return {
        data: {
          current: {
            us_aqi: 29
          }
        }
      };
    }

    throw new Error(`Unexpected axios request: ${url}`);
  };

  tempestService.getSelectedStationSnapshot = async () => null;

  await fetchDashboardWeather({
    latitude: '40.3322',
    longitude: '-111.7743',
    label: 'Current location'
  });

  const payload = await fetchDashboardWeather({
    latitude: '40.3349',
    longitude: '-111.7712',
    label: 'Current location'
  });

  assert.equal(forecastRequests, 1);
  assert.equal(airQualityRequests, 1);
  assert.equal(payload.current.temperatureF, 72.6);
  assert.equal(payload.today.highF, 76.4);
});

test('fetchDashboardWeather falls back to Tempest-only weather when Open-Meteo is rate limited without cache', async (t) => {
  await setupIsolatedWeatherCache(t);
  const originalAxiosGet = axios.get;
  const originalGetSelectedStationSnapshot = tempestService.getSelectedStationSnapshot;

  t.after(() => {
    axios.get = originalAxiosGet;
    tempestService.getSelectedStationSnapshot = originalGetSelectedStationSnapshot;
  });

  axios.get = async (url) => {
    if (url.includes('api.open-meteo.com/v1/forecast')) {
      const error = new Error('Request failed with status code 429');
      error.response = { status: 429 };
      throw error;
    }

    if (url.includes('air-quality-api.open-meteo.com')) {
      return {
        data: {
          current: {
            us_aqi: 38
          }
        }
      };
    }

    throw new Error(`Unexpected axios request: ${url}`);
  };

  tempestService.getSelectedStationSnapshot = async () => ({
    id: 'tempest-device-2',
    name: 'Lehi',
    room: 'Outside',
    location: {
      latitude: 40.41,
      longitude: -111.85,
      timezone: 'America/Denver'
    },
    metrics: {
      temperatureF: 71.2,
      feelsLikeF: 70.1,
      humidityPct: 28,
      windAvgMph: 4.8,
      rainLastMinuteIn: 0,
      rainRateInPerHr: 0
    },
    status: {
      websocketConnected: true
    }
  });

  const payload = await fetchDashboardWeather({
    latitude: '41.2211',
    longitude: '-111.9322',
    label: 'Current location'
  });

  assert.equal(payload.current.temperatureF, 71.2);
  assert.equal(payload.current.apparentTemperatureF, 70.1);
  assert.equal(payload.current.condition, 'Live Tempest Station');
  assert.equal(Array.isArray(payload.hourlyForecast), true);
  assert.equal(payload.hourlyForecast.length, 0);
  assert.equal(payload.tempest.station?.name, 'Lehi');
});

test('fetchDashboardWeather restores persisted forecast and AQI cache after a restart during provider throttling', async (t) => {
  const originalAxiosGet = axios.get;
  const originalGetSelectedStationSnapshot = tempestService.getSelectedStationSnapshot;
  const persistPath = await setupIsolatedWeatherCache(t);

  t.after(async () => {
    axios.get = originalAxiosGet;
    tempestService.getSelectedStationSnapshot = originalGetSelectedStationSnapshot;
  });

  const forecastPayload = {
    timezone: 'America/Denver',
    current: {
      temperature_2m: 72.6,
      apparent_temperature: 71.1,
      relative_humidity_2m: 38,
      wind_speed_10m: 6.2,
      precipitation: 0,
      weather_code: 1,
      is_day: 1
    },
    daily: {
      weather_code: [1],
      temperature_2m_max: [76.4],
      temperature_2m_min: [51.2],
      precipitation_probability_max: [12],
      sunrise: ['2026-04-07T06:54'],
      sunset: ['2026-04-07T19:46']
    },
    hourly: {
      time: ['2026-04-07T16:00'],
      temperature_2m: [72.6],
      precipitation_probability: [12],
      weather_code: [1],
      wind_speed_10m: [6.2]
    }
  };

  const liveTempestStation = {
    id: 'tempest-device-1',
    name: 'Lehi',
    room: 'Outside',
    observedAt: '2026-04-07T22:35:31.000Z',
    lastEventAt: '2026-04-02T17:00:00.000Z',
    metrics: {
      temperatureF: 75.1,
      feelsLikeF: 75.1,
      humidityPct: 18,
      windAvgMph: 3,
      rainLastMinuteIn: 0,
      rainTodayIn: 0,
      pressureInHg: 25.07,
      uvIndex: 3.5
    },
    status: {
      websocketConnected: true
    }
  };

  let shouldThrottle = false;

  axios.get = async (url) => {
    if (url.includes('api.open-meteo.com/v1/forecast')) {
      if (shouldThrottle) {
        const error = new Error('Request failed with status code 429');
        error.response = { status: 429 };
        throw error;
      }
      return { data: forecastPayload };
    }

    if (url.includes('air-quality-api.open-meteo.com')) {
      if (shouldThrottle) {
        const error = new Error('Request failed with status code 429');
        error.response = { status: 429 };
        throw error;
      }
      return {
        data: {
          current: {
            us_aqi: 29
          }
        }
      };
    }

    throw new Error(`Unexpected axios request: ${url}`);
  };

  tempestService.getSelectedStationSnapshot = async () => liveTempestStation;

  const initial = await fetchDashboardWeather({
    latitude: '40.3322',
    longitude: '-111.7743',
    label: 'Current location'
  });

  assert.equal(initial.today.highF, 76.4);
  assert.equal(initial.current.airQualityIndex, 29);
  assert.equal(initial.current.condition, 'Mostly Clear');

  __resetWeatherCachesForTests();
  shouldThrottle = true;

  const restored = await fetchDashboardWeather({
    latitude: '40.3349',
    longitude: '-111.7712',
    label: 'Current location'
  });

  assert.equal(restored.today.highF, 76.4);
  assert.equal(restored.current.airQualityIndex, 29);
  assert.equal(restored.current.condition, 'Mostly Clear');
  assert.equal(restored.tempest.station?.name, 'Lehi');
});

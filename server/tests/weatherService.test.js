const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const tempestService = require('../services/tempestService');
const telemetryService = require('../services/telemetryService');

const {
  buildLocationName,
  createWeatherPayload,
  describeWeatherCode,
  fetchDashboardWeather,
  normalizeCoordinates,
  normalizeLocationQuery,
  parseUsCityStateQuery,
  pickUsCityStateResult
} = require('../services/weatherService');

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

test('fetchDashboardWeather attaches Tempest module telemetry to the current weather payload', async (t) => {
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

  telemetryService.getTempestModuleTelemetry = async (args) => {
    telemetryArgs = args;
    return moduleTelemetry;
  };

  const payload = await fetchDashboardWeather({
    latitude: '39.7392',
    longitude: '-104.9903',
    label: 'Current location'
  });

  assert.deepEqual(telemetryArgs, { sourceId: 'tempest-device-1' });
  assert.deepEqual(payload.tempest.moduleTelemetry, moduleTelemetry);
  assert.equal(payload.tempest.station?.name, 'Backyard Tempest');
});

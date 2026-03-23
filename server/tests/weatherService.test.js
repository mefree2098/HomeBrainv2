const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createWeatherPayload,
  describeWeatherCode,
  normalizeCoordinates
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
});

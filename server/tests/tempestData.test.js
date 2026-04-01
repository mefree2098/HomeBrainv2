const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeSensorStatus,
  normalizeDiscoveryResponse,
  normalizeEventPayload,
  normalizeObservationPayload,
  summarizeLightningMetrics
} = require('../services/tempestData');

test('normalizeDiscoveryResponse extracts Tempest station metadata and preferred device ids', () => {
  const stations = normalizeDiscoveryResponse({
    stations: [
      {
        station_id: 42,
        name: 'Backyard Tempest',
        latitude: 39.73,
        longitude: -104.99,
        timezone: 'America/Denver',
        is_local_mode: false,
        devices: [
          { device_id: 2001, device_type: 'HB', serial_number: 'HB-0001', firmware_revision: '35' },
          { device_id: 2002, device_type: 'ST', serial_number: 'ST-0001', firmware_revision: '171' }
        ]
      }
    ]
  });

  assert.equal(stations.length, 1);
  assert.equal(stations[0].stationId, 42);
  assert.deepEqual(stations[0].sensorDeviceIds, [2002]);
  assert.equal(stations[0].hubDeviceId, 2001);
  assert.equal(stations[0].primaryDeviceType, 'ST');
});

test('normalizeObservationPayload parses Tempest observation arrays and applies calibration', () => {
  const normalized = normalizeObservationPayload({
    type: 'obs_st',
    values: [1603481377, 0.5, 1.2, 2.5, 45, 3, 1014.8, 28.8, 71, 16639, 1.83, 139, 0.2, 0, 12, 3, 2.42, 1, 5.1, null, null, 0],
    deviceId: 62009,
    stationId: 1001,
    stationName: 'Backyard Tempest',
    source: 'ws',
    raw: { type: 'obs_st' },
    calibration: {
      tempOffsetC: 1,
      pressureOffsetMb: -1.2,
      windSpeedMultiplier: 2,
      rainMultiplier: 1.5
    },
    previousMetrics: {
      pressure_mb: 1013.2
    }
  });

  assert.ok(normalized);
  assert.equal(normalized.stationId, 1001);
  assert.equal(normalized.deviceId, 62009);
  assert.equal(normalized.metrics.temp_c, 29.8);
  assert.equal(normalized.metrics.pressure_mb, 1013.6);
  assert.equal(normalized.metrics.wind_avg_mps, 2.4);
  assert.equal(normalized.metrics.rain_mm_last_minute, 0.3);
  assert.equal(normalized.derived.pressure_trend, 'steady');
  assert.equal(normalized.display.temperatureF, 85.6);
});

test('normalizeObservationPayload parses rapid wind observations', () => {
  const normalized = normalizeObservationPayload({
    type: 'rapid_wind',
    values: [1603481377, 5.2, 180],
    deviceId: 62009,
    stationId: 1001,
    stationName: 'Backyard Tempest',
    source: 'ws',
    raw: { type: 'rapid_wind' },
    calibration: {},
    previousMetrics: {}
  });

  assert.ok(normalized);
  assert.equal(normalized.observationType, 'rapid_wind');
  assert.equal(normalized.metrics.wind_rapid_mps, 5.2);
  assert.equal(normalized.display.windRapidMph, 11.6);
});

test('normalizeEventPayload maps lightning and precipitation events', () => {
  const lightning = normalizeEventPayload({
    type: 'evt_strike',
    values: [1603481377, 15, 932],
    deviceId: 62009,
    stationId: 1001,
    stationName: 'Backyard Tempest',
    source: 'ws',
    raw: {}
  });

  const precipitation = normalizeEventPayload({
    type: 'evt_precip',
    values: [1603481377],
    deviceId: 62009,
    stationId: 1001,
    stationName: 'Backyard Tempest',
    source: 'udp',
    raw: {}
  });

  assert.equal(lightning?.eventType, 'lightning_strike');
  assert.equal(lightning?.payload.distanceMiles, 9.3);
  assert.equal(precipitation?.eventType, 'precip_start');
});

test('decodeSensorStatus expands Tempest device fault flags', () => {
  assert.deepEqual(decodeSensorStatus(0), []);
  assert.deepEqual(decodeSensorStatus(16 + 64), [
    'Temperature sensor failure',
    'Wind sensor failure'
  ]);
});

test('summarizeLightningMetrics prefers recent strike events over stale display metrics', () => {
  const summary = summarizeLightningMetrics(
    {
      count: 3,
      averageDistanceMiles: 8.36,
      lastStrikeAt: new Date('2026-04-01T05:24:00Z')
    },
    {
      lightningCount: 0,
      lightningAvgDistanceMiles: null,
      lightningAvgDistanceKm: null
    }
  );

  assert.equal(summary.lightningCount, 3);
  assert.equal(summary.lightningAvgDistanceMiles, 8.4);
  assert.equal(summary.lightningAvgDistanceKm, 13.5);
  assert.equal(summary.lastLightningStrikeAt?.toISOString?.(), '2026-04-01T05:24:00.000Z');
});

test('summarizeLightningMetrics falls back to station display values when no recent strikes exist', () => {
  const summary = summarizeLightningMetrics(
    {},
    {
      lightningCount: 2,
      lightningAvgDistanceMiles: 11.2,
      lightningAvgDistanceKm: 18
    }
  );

  assert.equal(summary.lightningCount, 2);
  assert.equal(summary.lightningAvgDistanceMiles, 11.2);
  assert.equal(summary.lightningAvgDistanceKm, 18);
  assert.equal(summary.lastLightningStrikeAt, null);
});

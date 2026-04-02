const test = require('node:test');
const assert = require('node:assert/strict');

const telemetryService = require('../services/telemetryService');

const {
  buildMetricDescriptors,
  downsamplePoints,
  extractDeviceMetrics,
  extractTempestMetrics,
  mergePointsByTimestamp,
  pickFeaturedMetricKeys
} = telemetryService.__private__;

test('extractDeviceMetrics maps device state and smartthings telemetry into chartable metrics', () => {
  const metrics = extractDeviceMetrics({
    _id: 'device-1',
    isOnline: true,
    status: false,
    brightness: 42,
    temperature: 71,
    targetTemperature: 73,
    properties: {
      smartThingsAttributeValues: {
        powerMeter: { power: 128.4 },
        energyMeter: { energy: 4.62 },
        battery: { battery: 87 },
        contactSensor: { contact: 'open' },
        motionSensor: { motion: 'inactive' }
      }
    }
  });

  assert.equal(metrics.online, 1);
  assert.equal(metrics.status, 0);
  assert.equal(metrics.brightness_pct, 42);
  assert.equal(metrics.temperature, 71);
  assert.equal(metrics.target_temperature, 73);
  assert.equal(metrics.power_w, 128.4);
  assert.equal(metrics.energy_kwh, 4.62);
  assert.equal(metrics.battery_pct, 87);
  assert.equal(metrics.contact_open, 1);
  assert.equal(metrics.motion_active, 0);
});

test('extractTempestMetrics keeps display-oriented weather metrics and skips rapid wind snapshots', () => {
  const regularMetrics = extractTempestMetrics({
    observationType: 'obs_st',
    display: {
      temperatureF: 73.5,
      humidityPct: 44,
      windAvgMph: 8.2,
      pressureInHg: 29.92,
      rainRateInPerHr: 0.04,
      uvIndex: 6.2
    }
  });

  assert.equal(regularMetrics.temperature_f, 73.5);
  assert.equal(regularMetrics.humidity_pct, 44);
  assert.equal(regularMetrics.wind_avg_mph, 8.2);
  assert.equal(regularMetrics.pressure_inhg, 29.92);
  assert.equal(regularMetrics.rain_rate_in_hr, 0.04);
  assert.equal(regularMetrics.uv_index, 6.2);

  assert.deepEqual(extractTempestMetrics({
    observationType: 'rapid_wind',
    display: {
      windRapidMph: 21.1
    }
  }), {});
});

test('buildMetricDescriptors prioritizes featured metrics for default chart selections', () => {
  const descriptors = buildMetricDescriptors([
    'energy_kwh',
    'humidity_pct',
    'online',
    'power_w',
    'temperature_f'
  ]);

  assert.deepEqual(
    pickFeaturedMetricKeys(descriptors, 3),
    ['temperature_f', 'humidity_pct', 'power_w']
  );
});

test('mergePointsByTimestamp and downsamplePoints collapse duplicate timestamps and preserve endpoints', () => {
  const merged = mergePointsByTimestamp([
    {
      observedAt: '2026-04-01T00:00:00.000Z',
      values: { temperature_f: 70 }
    },
    {
      observedAt: '2026-04-01T00:00:00.000Z',
      values: { humidity_pct: 40 }
    },
    {
      observedAt: '2026-04-01T01:00:00.000Z',
      values: { temperature_f: 71 }
    },
    {
      observedAt: '2026-04-01T02:00:00.000Z',
      values: { temperature_f: 72 }
    },
    {
      observedAt: '2026-04-01T03:00:00.000Z',
      values: { temperature_f: 73 }
    }
  ]);

  assert.equal(merged.length, 4);
  assert.deepEqual(merged[0].values, {
    temperature_f: 70,
    humidity_pct: 40
  });

  const downsampled = downsamplePoints(merged, 3);
  assert.equal(downsampled.length, 3);
  assert.equal(downsampled[0].observedAt, '2026-04-01T00:00:00.000Z');
  assert.equal(downsampled[downsampled.length - 1].observedAt, '2026-04-01T03:00:00.000Z');
});

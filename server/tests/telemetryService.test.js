const test = require('node:test');
const assert = require('node:assert/strict');

const telemetryService = require('../services/telemetryService');

const {
  buildSourceTimelineEvents,
  buildMetricDescriptors,
  downsamplePoints,
  extractDeviceMetrics,
  extractTempestMetrics,
  mergePointsByTimestamp,
  normalizeDiskCapacity,
  pickFeaturedMetricKeys,
  summarizeStorageCollections
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

test('extractDeviceMetrics captures Tempest connectivity telemetry without duplicating observation metrics', () => {
  const metrics = extractDeviceMetrics({
    _id: 'tempest-device-1',
    isOnline: true,
    status: true,
    properties: {
      source: 'tempest',
      tempest: {
        display: {
          batteryVolts: 2.45,
          temperatureF: 73.5
        },
        health: {
          rssi: -68,
          hubRssi: -72,
          websocketConnected: true,
          udpListening: false,
          sensorStatusFlags: ['light_wind', 'rain_check']
        }
      }
    }
  });

  assert.equal(metrics.online, 1);
  assert.equal(metrics.status, 1);
  assert.equal(metrics.signal_rssi_dbm, -68);
  assert.equal(metrics.hub_rssi_dbm, -72);
  assert.equal(metrics.websocket_connected, 1);
  assert.equal(metrics.udp_listening, 0);
  assert.equal(metrics.sensor_fault_count, 2);
  assert.equal(metrics.battery_volts, 2.45);
  assert.equal(metrics.temperature_f, undefined);
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

test('buildSourceTimelineEvents highlights binary state transitions for device history', () => {
  const events = buildSourceTimelineEvents([
    {
      recordedAt: '2026-04-01T00:00:00.000Z',
      metrics: {
        status: 0,
        online: 1
      }
    },
    {
      recordedAt: '2026-04-01T01:00:00.000Z',
      metrics: {
        status: 1,
        online: 1
      }
    },
    {
      recordedAt: '2026-04-01T02:00:00.000Z',
      metrics: {
        status: 1,
        online: 0
      }
    }
  ], buildMetricDescriptors(['status', 'online']));

  assert.equal(events.length, 2);
  assert.equal(events[0].summary, 'Went Offline');
  assert.equal(events[1].summary, 'Turned On');
});

test('summarizeStorageCollections totals footprint across telemetry collections', () => {
  const summary = summarizeStorageCollections([
    {
      key: 'telemetry_samples',
      documentCount: 120,
      logicalSizeBytes: 4096,
      storageSizeBytes: 8192,
      indexSizeBytes: 2048,
      footprintBytes: 10240
    },
    {
      key: 'tempest_observations',
      documentCount: 24,
      logicalSizeBytes: 1024,
      storageSizeBytes: 2048,
      indexSizeBytes: 512,
      footprintBytes: 2560
    }
  ]);

  assert.equal(summary.collectionCount, 2);
  assert.equal(summary.totalDocumentCount, 144);
  assert.equal(summary.logicalSizeBytes, 5120);
  assert.equal(summary.storageSizeBytes, 10240);
  assert.equal(summary.indexSizeBytes, 2560);
  assert.equal(summary.footprintBytes, 12800);
});

test('normalizeDiskCapacity maps resource monitor disk output into free and total values', () => {
  const disk = normalizeDiskCapacity({
    totalBytes: 1_000_000,
    usedBytes: 640_000,
    availableBytes: 360_000,
    totalGB: 0.93,
    usedGB: 0.60,
    availableGB: 0.33,
    usagePercent: 64,
    total: '932M',
    used: '596M',
    available: '336M'
  });

  assert.equal(disk.totalBytes, 1_000_000);
  assert.equal(disk.usedBytes, 640_000);
  assert.equal(disk.freeBytes, 360_000);
  assert.equal(disk.totalGB, 0.93);
  assert.equal(disk.freeGB, 0.33);
  assert.equal(disk.freeLabel, '336M');
  assert.equal(disk.available, true);
});

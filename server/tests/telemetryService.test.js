const test = require('node:test');
const assert = require('node:assert/strict');

const telemetryService = require('../services/telemetryService');
const { TelemetryService } = telemetryService;

const {
  buildSourceTimelineEvents,
  buildSourceSummaryFromSnapshot,
  buildMetricDescriptors,
  downsamplePoints,
  extractDeviceMetrics,
  extractTempestMetrics,
  mergePointsByTimestamp,
  normalizeDiskCapacity,
  pickFeaturedMetricKeys,
  resolveTelemetrySourceKey,
  shouldRebuildSourceSummaries,
  summarizeSourceBreakdowns,
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

test('extractDeviceMetrics captures RainMachine controller and zone runtime telemetry', () => {
  const metrics = extractDeviceMetrics({
    _id: 'rainmachine-zone-1',
    isOnline: true,
    status: true,
    properties: {
      source: 'rainmachine',
      rainmachine: {
        entityType: 'zone',
        controllerId: 'AA:BB:CC',
        queueLength: 2,
        runningProgramCount: 1,
        activeZoneCount: 1,
        activeRestrictionsCount: 0,
        rainDelayHours: 0,
        remainingSeconds: 420,
        userDurationSeconds: 600,
        machineDurationSeconds: 480,
        cycleCount: 2
      }
    }
  });

  assert.equal(metrics.online, 1);
  assert.equal(metrics.status, 1);
  assert.equal(metrics.queue_length, 2);
  assert.equal(metrics.running_program_count, 1);
  assert.equal(metrics.active_zone_count, 1);
  assert.equal(metrics.remaining_sec, 420);
  assert.equal(metrics.user_duration_sec, 600);
  assert.equal(metrics.machine_duration_sec, 480);
  assert.equal(metrics.cycle_count, 2);
});

test('extractDeviceMetrics captures Sense monitor and device telemetry for reporting charts', () => {
  const monitorMetrics = extractDeviceMetrics({
    _id: 'sense-monitor-1',
    isOnline: true,
    status: true,
    properties: {
      source: 'sense',
      sense: {
        entityType: 'monitor',
        currentPowerW: 5200.4,
        currentCostUsdPerHour: 0.572,
        monthToDateCostUsd: 118.42,
        projectedMonthCostUsd: 332.8,
        electricityRateCentsPerKwh: 11,
        solarPowerW: 1250.3,
        netPowerW: 3950.1,
        alwaysOnW: 410.4,
        otherW: 979.4,
        untrackedW: 979.4,
        activeDeviceCount: 3,
        voltage: [121.2, 118.8],
        frequencyHz: 59.94,
        trends: {
          day: {
            consumptionTotalKwh: 31.8754,
            costUsd: 3.51,
            productionTotalKwh: 10.25,
            productionPct: 32.16,
            fromGridKwh: 22.5,
            toGridKwh: 1.2,
            solarPoweredPct: 43.2
          }
        }
      }
    }
  });

  assert.equal(monitorMetrics.power_w, 5200.4);
  assert.equal(monitorMetrics.current_cost_usd_per_hr, 0.572);
  assert.equal(monitorMetrics.month_to_date_cost_usd, 118.42);
  assert.equal(monitorMetrics.projected_month_cost_usd, 332.8);
  assert.equal(monitorMetrics.electricity_rate_cents_per_kwh, 11);
  assert.equal(monitorMetrics.solar_power_w, 1250.3);
  assert.equal(monitorMetrics.net_power_w, 3950.1);
  assert.equal(monitorMetrics.always_on_w, 410.4);
  assert.equal(monitorMetrics.active_device_count, 3);
  assert.equal(monitorMetrics.voltage_l1_v, 121.2);
  assert.equal(monitorMetrics.voltage_l2_v, 118.8);
  assert.equal(monitorMetrics.frequency_hz, 59.94);
  assert.equal(monitorMetrics.daily_consumption_kwh, 31.8754);
  assert.equal(monitorMetrics.daily_cost_usd, 3.51);
  assert.equal(monitorMetrics.daily_production_kwh, 10.25);
  assert.equal(monitorMetrics.daily_solar_powered_pct, 43.2);

  const deviceMetrics = extractDeviceMetrics({
    _id: 'sense-device-1',
    isOnline: true,
    status: true,
    properties: {
      source: 'sense',
      sense: {
        entityType: 'device',
        currentPowerW: 1500.3,
        currentSharePct: 28.9,
        currentCostUsdPerHour: 0.165,
        monthToDateCostUsd: 13.26,
        projectedMonthCostUsd: 38.84,
        electricityRateCentsPerKwh: 11,
        trends: {
          day: { energyKwh: 6.125, costUsd: 0.67 },
          month: { energyKwh: 120.5, costUsd: 13.26 }
        }
      }
    }
  });

  assert.equal(deviceMetrics.power_w, 1500.3);
  assert.equal(deviceMetrics.current_share_pct, 28.9);
  assert.equal(deviceMetrics.current_cost_usd_per_hr, 0.165);
  assert.equal(deviceMetrics.month_to_date_cost_usd, 13.26);
  assert.equal(deviceMetrics.projected_month_cost_usd, 38.84);
  assert.equal(deviceMetrics.electricity_rate_cents_per_kwh, 11);
  assert.equal(deviceMetrics.daily_energy_kwh, 6.125);
  assert.equal(deviceMetrics.daily_cost_usd, 0.67);
  assert.equal(deviceMetrics.monthly_energy_kwh, 120.5);
  assert.equal(deviceMetrics.monthly_cost_usd, 13.26);
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

test('buildSourceSummaryFromSnapshot produces chartable source metadata without sample scans', () => {
  const summary = buildSourceSummaryFromSnapshot({
    sourceKey: 'device:abc',
    sourceType: 'device',
    sourceId: 'abc',
    sourceName: 'Kitchen Switch',
    sourceCategory: 'switch',
    sourceRoom: 'Kitchen',
    sourceOrigin: 'smartthings',
    streamType: 'device_state',
    streamCounts: {
      device_state: 12
    },
    sampleCount: 12,
    metricKeys: ['status', 'power_w', 'online'],
    lastValues: {
      status: 1,
      online: 1,
      power_w: 42.5
    },
    lastSampleAt: new Date('2026-04-01T00:00:00.000Z')
  });

  assert.equal(summary.sourceKey, 'device:abc');
  assert.equal(summary.sampleCount, 12);
  assert.deepEqual(summary.streamCounts, { device_state: 12 });
  assert.equal(summary.lastValues.status, 1);
  assert.equal(summary.lastValues.power_w, 42.5);
  assert.deepEqual(summary.featuredMetricKeys, ['power_w', 'status', 'online']);
});

test('summarizeSourceBreakdowns derives overview counts from source summaries', () => {
  const summary = summarizeSourceBreakdowns([
    {
      sourceType: 'device',
      sampleCount: 10,
      streamCounts: {
        device_state: 10
      },
      lastSampleAt: new Date('2026-04-01T00:00:00.000Z')
    },
    {
      sourceType: 'tempest_station',
      sampleCount: 7,
      streamCounts: {
        tempest_observation: 5,
        tempest_device_state: 2
      },
      lastSampleAt: new Date('2026-04-02T00:00:00.000Z')
    }
  ]);

  assert.equal(summary.totalSamples, 17);
  assert.deepEqual(summary.sourceTypeCounts, {
    device: 10,
    tempest_station: 7
  });
  assert.deepEqual(summary.streamCounts, {
    device_state: 10,
    tempest_observation: 5,
    tempest_device_state: 2
  });
  assert.equal(summary.lastSampleAt.toISOString(), '2026-04-02T00:00:00.000Z');
});

test('shouldRebuildSourceSummaries catches metadata-only and drifted summary totals', () => {
  assert.equal(shouldRebuildSourceSummaries({
    summaryCount: 0,
    sampleCount: 12,
    summarySampleCount: 0
  }), true);
  assert.equal(shouldRebuildSourceSummaries({
    summaryCount: 4,
    sampleCount: 1393075,
    summarySampleCount: 0
  }), true);
  assert.equal(shouldRebuildSourceSummaries({
    summaryCount: 4,
    sampleCount: 10000,
    summarySampleCount: 9950
  }), false);
  assert.equal(shouldRebuildSourceSummaries({
    summaryCount: 4,
    sampleCount: 10000,
    summarySampleCount: 8000
  }), true);
  assert.equal(shouldRebuildSourceSummaries({
    summaryCount: 4,
    sampleCount: 0,
    summarySampleCount: 8000
  }), false);
});

test('resolveTelemetrySourceKey rejects object-shaped query payloads before Mongo lookups', () => {
  assert.equal(resolveTelemetrySourceKey({ sourceKey: ' device:abc ' }), 'device:abc');
  assert.equal(resolveTelemetrySourceKey({ sourceKey: ['device:abc', 'device:def'] }), 'device:abc');
  assert.equal(resolveTelemetrySourceKey({ sourceType: 'device', sourceId: 'abc' }), 'device:abc');
  assert.equal(resolveTelemetrySourceKey({ sourceKey: { $ne: '' } }), '');
  assert.equal(resolveTelemetrySourceKey({ sourceType: 'device', sourceId: { $ne: '' } }), '');
  assert.equal(resolveTelemetrySourceKey({ sourceKey: 'device:abc$ne' }), '');
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

test('TelemetryService limits concurrent device snapshot writes', async () => {
  const service = new TelemetryService({ deviceSnapshotConcurrency: 2 });
  let activeWrites = 0;
  let maxActiveWrites = 0;

  service.recordDeviceSnapshot = async (device) => {
    activeWrites += 1;
    maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeWrites -= 1;
    return { inserted: device.inserted };
  };

  const summary = await service.recordDeviceSnapshots([
    { _id: 'a', inserted: true },
    { _id: 'b', inserted: false },
    { _id: 'c', inserted: true },
    { _id: 'd', inserted: true }
  ]);

  assert.equal(maxActiveWrites, 2);
  assert.deepEqual(summary, {
    insertedCount: 3,
    skippedCount: 1
  });
});

test('TelemetryService coalesces queued device updates before flushing', async () => {
  const service = new TelemetryService({
    deviceSnapshotConcurrency: 1,
    deviceSnapshotFlushDelayMs: 1000
  });
  const flushedBatches = [];

  service.recordDeviceSnapshots = async (devices) => {
    flushedBatches.push(devices);
    return {
      insertedCount: devices.length,
      skippedCount: 0
    };
  };

  const firstQueue = service.enqueueDeviceSnapshots([
    { _id: 'device-1', name: 'Old Name' },
    { _id: 'device-2', name: 'Kitchen' }
  ]);
  const secondQueue = service.enqueueDeviceSnapshots([
    { _id: 'device-1', name: 'New Name' }
  ]);

  assert.equal(firstQueue.queuedCount, 2);
  assert.equal(secondQueue.pendingCount, 2);

  const summary = await service.flushPendingDeviceSnapshots();
  service.shutdown();

  assert.deepEqual(summary, {
    insertedCount: 2,
    skippedCount: 0,
    pendingCount: 0
  });
  assert.equal(flushedBatches.length, 1);
  assert.deepEqual(flushedBatches[0].map((device) => device.name), ['New Name', 'Kitchen']);
});

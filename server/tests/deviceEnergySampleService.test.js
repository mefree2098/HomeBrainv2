const test = require('node:test');
const assert = require('node:assert/strict');

const DeviceEnergySample = require('../models/DeviceEnergySample');
const deviceEnergySampleService = require('../services/deviceEnergySampleService');

test('recordSamplesForDevices inserts new SmartThings power samples and skips unchanged readings', async (t) => {
  const originalAggregate = DeviceEnergySample.aggregate;
  const originalInsertMany = DeviceEnergySample.insertMany;

  t.after(() => {
    DeviceEnergySample.aggregate = originalAggregate;
    DeviceEnergySample.insertMany = originalInsertMany;
  });

  let aggregatePipeline = null;
  let insertedDocs = null;

  DeviceEnergySample.aggregate = async (pipeline) => {
    aggregatePipeline = pipeline;
    return [
      {
        _id: 'device-1',
        sample: {
          deviceId: 'device-1',
          powerValue: 812,
          powerUnit: 'W',
          energyValue: 2.1,
          energyUnit: 'kWh'
        }
      }
    ];
  };

  DeviceEnergySample.insertMany = async (docs) => {
    insertedDocs = docs;
    return docs;
  };

  const result = await deviceEnergySampleService.recordSamplesForDevices([
    {
      _id: 'device-1',
      lastSeen: new Date('2026-03-31T16:02:00.000Z'),
      properties: {
        source: 'smartthings',
        smartThingsCapabilities: ['powerMeter', 'energyMeter'],
        smartThingsAttributeValues: {
          powerMeter: { power: 812 },
          energyMeter: { energy: 2.1 }
        },
        smartThingsAttributeMetadata: {
          powerMeter: {
            power: {
              unit: 'W',
              timestamp: '2026-03-31T16:02:00.000Z'
            }
          },
          energyMeter: {
            energy: {
              unit: 'kWh',
              timestamp: '2026-03-31T16:02:00.000Z'
            }
          }
        }
      }
    },
    {
      _id: 'device-2',
      lastSeen: new Date('2026-03-31T16:05:00.000Z'),
      properties: {
        source: 'smartthings',
        smartThingsCapabilities: ['powerMeter', 'energyMeter'],
        smartThingsAttributeValues: {
          powerMeter: { power: 33 },
          energyMeter: { energy: 0.88 }
        },
        smartThingsAttributeMetadata: {
          powerMeter: {
            power: {
              unit: 'W',
              timestamp: '2026-03-31T16:05:00.000Z'
            }
          },
          energyMeter: {
            energy: {
              unit: 'kWh',
              timestamp: '2026-03-31T16:04:00.000Z'
            }
          }
        }
      }
    },
    {
      _id: 'device-3',
      properties: {
        source: 'smartthings',
        smartThingsCapabilities: ['powerMeter']
      }
    }
  ]);

  assert.equal(Array.isArray(aggregatePipeline), true);
  assert.deepEqual(aggregatePipeline[0], {
    $match: {
      deviceId: {
        $in: ['device-1', 'device-2']
      }
    }
  });
  assert.deepEqual(aggregatePipeline[1], {
    $sort: {
      deviceId: 1,
      recordedAt: -1
    }
  });
  assert.equal(result.insertedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(Array.isArray(insertedDocs), true);
  assert.equal(insertedDocs.length, 1);
  assert.equal(insertedDocs[0].deviceId, 'device-2');
  assert.equal(insertedDocs[0].powerValue, 33);
  assert.equal(insertedDocs[0].powerUnit, 'W');
  assert.equal(insertedDocs[0].energyValue, 0.88);
  assert.equal(insertedDocs[0].energyUnit, 'kWh');
  assert.equal(insertedDocs[0].recordedAt.toISOString(), '2026-03-31T16:05:00.000Z');
});

test('getDeviceEnergyHistory returns samples in ascending order with normalized power details', async (t) => {
  const originalFind = DeviceEnergySample.find;

  t.after(() => {
    DeviceEnergySample.find = originalFind;
  });

  let capturedQuery = null;
  let capturedSort = null;
  let capturedLimit = null;

  DeviceEnergySample.find = (query) => {
    capturedQuery = query;
    return {
      sort(sort) {
        capturedSort = sort;
        return {
          limit(limit) {
            capturedLimit = limit;
            return Promise.resolve([
              {
                recordedAt: new Date('2026-03-31T17:10:00.000Z'),
                source: 'smartthings',
                powerValue: 44,
                powerUnit: 'W',
                powerTimestamp: new Date('2026-03-31T17:10:00.000Z'),
                energyValue: 0.93,
                energyUnit: 'kWh',
                energyTimestamp: new Date('2026-03-31T17:09:00.000Z')
              },
              {
                recordedAt: new Date('2026-03-31T17:00:00.000Z'),
                source: 'smartthings',
                powerValue: 12,
                powerUnit: 'W',
                powerTimestamp: new Date('2026-03-31T17:00:00.000Z'),
                energyValue: 0.9,
                energyUnit: 'kWh',
                energyTimestamp: new Date('2026-03-31T16:59:00.000Z')
              }
            ]);
          }
        };
      }
    };
  };

  const history = await deviceEnergySampleService.getDeviceEnergyHistory('device-9', {
    hours: 6,
    limit: 100
  });

  assert.equal(capturedQuery.deviceId, 'device-9');
  assert.equal(capturedQuery.recordedAt.$gte instanceof Date, true);
  assert.deepEqual(capturedSort, { recordedAt: -1 });
  assert.equal(capturedLimit, 100);
  assert.equal(history.length, 2);
  assert.equal(history[0].recordedAt.toISOString(), '2026-03-31T17:00:00.000Z');
  assert.equal(history[0].power.value, 12);
  assert.equal(history[1].recordedAt.toISOString(), '2026-03-31T17:10:00.000Z');
  assert.equal(history[1].energy.value, 0.93);
});

test('recordSamplesForDevices captures Sense monitor and device energy telemetry', async (t) => {
  const originalAggregate = DeviceEnergySample.aggregate;
  const originalInsertMany = DeviceEnergySample.insertMany;

  t.after(() => {
    DeviceEnergySample.aggregate = originalAggregate;
    DeviceEnergySample.insertMany = originalInsertMany;
  });

  let insertedDocs = null;

  DeviceEnergySample.aggregate = async () => [];
  DeviceEnergySample.insertMany = async (docs) => {
    insertedDocs = docs;
    return docs;
  };

  const result = await deviceEnergySampleService.recordSamplesForDevices([
    {
      _id: 'sense-monitor-1',
      lastSeen: new Date('2026-04-01T12:00:00.000Z'),
      properties: {
        source: 'sense',
        sense: {
          entityType: 'monitor',
          currentPowerW: 5200.4,
          lastSnapshotAt: '2026-04-01T12:00:05.000Z',
          trends: {
            day: {
              consumptionTotalKwh: 31.8754
            }
          }
        }
      }
    },
    {
      _id: 'sense-device-1',
      lastSeen: new Date('2026-04-01T12:00:00.000Z'),
      properties: {
        source: 'sense',
        sense: {
          entityType: 'device',
          currentPowerW: 1500.3,
          lastSnapshotAt: '2026-04-01T12:00:05.000Z',
          trends: {
            day: {
              energyKwh: 6.125
            }
          }
        }
      }
    }
  ]);

  assert.equal(result.insertedCount, 2);
  assert.equal(result.skippedCount, 0);
  assert.equal(Array.isArray(insertedDocs), true);
  assert.equal(insertedDocs.length, 2);
  assert.deepEqual(
    insertedDocs.map((entry) => ({
      deviceId: entry.deviceId,
      source: entry.source,
      powerValue: entry.powerValue,
      energyValue: entry.energyValue,
      recordedAt: entry.recordedAt.toISOString()
    })),
    [
      {
        deviceId: 'sense-monitor-1',
        source: 'sense',
        powerValue: 5200.4,
        energyValue: 31.8754,
        recordedAt: '2026-04-01T12:00:05.000Z'
      },
      {
        deviceId: 'sense-device-1',
        source: 'sense',
        powerValue: 1500.3,
        energyValue: 6.125,
        recordedAt: '2026-04-01T12:00:05.000Z'
      }
    ]
  );
});

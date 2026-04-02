const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
const TempestEvent = require('../models/TempestEvent');
const tempestService = require('../services/tempestService');

test('getSelectedStationSnapshot merges recent lightning events into station metrics', async () => {
  const originalGetSelectedStationDevice = tempestService.getSelectedStationDevice;
  const originalAggregate = TempestEvent.aggregate;

  tempestService.getSelectedStationDevice = async () => ({
    _id: 'tempest-device-1',
    name: 'Backyard Tempest',
    room: 'Outside',
    isOnline: true,
    lastSeen: new Date('2026-04-01T05:10:00Z'),
    properties: {
      source: 'tempest',
      tempest: {
        stationId: 42,
        stationName: 'Backyard Tempest',
        lastEventAt: new Date('2026-04-01T04:00:00Z'),
        display: {
          lightningCount: 0,
          lightningAvgDistanceMiles: null,
          lightningAvgDistanceKm: null
        },
        health: {
          websocketConnected: true
        }
      }
    }
  });

  TempestEvent.aggregate = async (pipeline) => {
    assert.equal(pipeline[0]?.$match?.stationId, 42);
    assert.equal(pipeline[0]?.$match?.eventType, 'lightning_strike');
    assert.ok(pipeline[0]?.$match?.eventAt?.$gte instanceof Date);

    return [{
      _id: null,
      count: 4,
      averageDistanceMiles: 7.84,
      lastStrikeAt: new Date('2026-04-01T05:24:00Z'),
      lastStrikeDistanceMiles: 6.1
    }];
  };

  try {
    const station = await tempestService.getSelectedStationSnapshot();

    assert.equal(station?.stationId, 42);
    assert.equal(station?.metrics.lightningCount, 4);
    assert.equal(station?.metrics.lightningAvgDistanceMiles, 7.8);
    assert.equal(station?.metrics.lightningAvgDistanceKm, 12.6);
    assert.equal(station?.lastEventAt?.toISOString?.(), '2026-04-01T05:24:00.000Z');
  } finally {
    tempestService.getSelectedStationDevice = originalGetSelectedStationDevice;
    TempestEvent.aggregate = originalAggregate;
  }
});

test('upsertStationDevice dedupes duplicate HomeBrain rows for one Tempest station', async (t) => {
  const originalFind = Device.find;
  const originalCreate = Device.create;
  const originalDeleteMany = Device.deleteMany;

  t.after(() => {
    Device.find = originalFind;
    Device.create = originalCreate;
    Device.deleteMany = originalDeleteMany;
  });

  const canonicalDevice = {
    _id: 'tempest-canonical',
    name: 'Backyard Tempest',
    room: 'Outside',
    groups: ['Weather'],
    properties: {
      source: 'tempest',
      tempest: {
        stationId: 42,
        metrics: {},
        derived: {},
        display: {},
        health: {}
      }
    },
    createdAt: new Date('2026-04-01T00:00:00Z'),
    async save() {
      this.saved = true;
    }
  };

  const duplicateDevice = {
    _id: 'tempest-duplicate',
    name: 'Backyard Tempest Duplicate',
    groups: ['Favorites'],
    properties: {
      tempest: {
        stationId: '42'
      }
    },
    createdAt: new Date('2026-04-02T00:00:00Z')
  };

  const station = {
    stationId: 42,
    name: 'Backyard Tempest',
    publicName: 'Backyard',
    latitude: 40.0,
    longitude: -105.0,
    timezone: 'America/Denver',
    elevationM: 1500,
    isLocalMode: false,
    sensorDeviceIds: [111],
    sensorSerialNumbers: ['SN-111'],
    hubDeviceId: 222,
    hubSerialNumber: 'HUB-222',
    primaryDeviceId: 111,
    primaryDeviceType: 'ST',
    devices: [],
    stationItems: [],
    createdEpoch: 1,
    lastModifiedEpoch: 2
  };

  Device.find = async (query) => {
    assert.deepEqual(query, {
      'properties.tempest.stationId': {
        $in: [42, '42']
      }
    });
    return [duplicateDevice, canonicalDevice];
  };
  Device.create = async () => {
    throw new Error('Device.create should not be called when a canonical Tempest row already exists');
  };
  Device.deleteMany = async (query) => {
    assert.deepEqual(query, {
      _id: { $in: ['tempest-duplicate'] }
    });
    return { deletedCount: 1 };
  };

  const result = await tempestService.upsertStationDevice(station, { room: 'Outside' });

  assert.equal(result.deduped, 1);
  assert.deepEqual(result.device.groups, ['Weather', 'Favorites']);
  assert.equal(result.device.saved, true);
});

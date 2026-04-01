const test = require('node:test');
const assert = require('node:assert/strict');

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

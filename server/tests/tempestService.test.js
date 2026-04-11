const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
const TempestEvent = require('../models/TempestEvent');
const TempestIntegration = require('../models/TempestIntegration');
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

test('buildStationSummary backfills rain metrics from raw Tempest observations when persisted display fields are stale', () => {
  const summary = tempestService.buildStationSummary({
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
        metrics: {
          rain_mm_last_minute: 0.254,
          rain_mm_today: 0.762
        },
        derived: {
          rain_rate_mm_per_hr: 15.24
        },
        display: {
          rainTodayIn: 0.03,
          rainRateInPerHr: null
        },
        health: {
          websocketConnected: true
        }
      }
    }
  });

  assert.equal(summary.metrics.rainTodayIn, 0.03);
  assert.equal(summary.metrics.rainLastMinuteIn, 0.01);
  assert.equal(summary.metrics.rainRateInPerHr, 0.6);
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

test('getSelectedStationDevice prefers the freshest Tempest duplicate and removes stale rows', async (t) => {
  const originalFind = Device.find;
  const originalDeleteMany = Device.deleteMany;

  t.after(() => {
    Device.find = originalFind;
    Device.deleteMany = originalDeleteMany;
  });

  const staleDuplicate = {
    _id: 'tempest-stale',
    name: 'Backyard Tempest',
    room: 'Outside',
    groups: ['Weather'],
    lastSeen: new Date('2026-04-02T12:17:00Z'),
    createdAt: new Date('2026-04-01T00:00:00Z'),
    properties: {
      source: 'tempest',
      tempest: {
        stationId: 42,
        lastObservationAt: new Date('2026-04-02T12:17:00Z')
      }
    }
  };

  const freshCanonical = {
    _id: 'tempest-fresh',
    name: 'Lehi',
    room: 'Outside',
    groups: ['Favorites'],
    lastSeen: new Date('2026-04-07T22:35:31Z'),
    createdAt: new Date('2026-04-03T00:00:00Z'),
    properties: {
      source: 'tempest',
      tempest: {
        stationId: 42,
        lastObservationAt: new Date('2026-04-07T22:35:31Z')
      }
    },
    async save() {
      this.saved = true;
    }
  };

  Device.find = async (query) => {
    assert.deepEqual(query, {
      'properties.source': 'tempest',
      'properties.tempest.stationId': {
        $in: [42, '42']
      }
    });
    return [staleDuplicate, freshCanonical];
  };

  Device.deleteMany = async (query) => {
    assert.deepEqual(query, {
      _id: { $in: ['tempest-stale'] }
    });
    return { deletedCount: 1 };
  };

  const device = await tempestService.getSelectedStationDevice(42);

  assert.equal(device?._id, 'tempest-fresh');
  assert.deepEqual(device.groups, ['Favorites', 'Weather']);
  assert.equal(device.saved, true);
});

test('getSelectedStationDevice matches mixed string and numeric Tempest station ids', async (t) => {
  const originalFind = Device.find;

  t.after(() => {
    Device.find = originalFind;
  });

  const freshCanonical = {
    _id: 'tempest-string-station',
    name: 'Lehi',
    room: 'Outside',
    groups: [],
    lastSeen: new Date('2026-04-07T22:35:31Z'),
    createdAt: new Date('2026-04-03T00:00:00Z'),
    properties: {
      source: 'tempest',
      tempest: {
        stationId: '42',
        lastObservationAt: new Date('2026-04-07T22:35:31Z')
      }
    }
  };

  Device.find = async (query) => {
    assert.deepEqual(query, {
      'properties.source': 'tempest',
      'properties.tempest.stationId': {
        $in: [42, '42']
      }
    });
    return [freshCanonical];
  };

  const device = await tempestService.getSelectedStationDevice(42);

  assert.equal(device?._id, 'tempest-string-station');
});

test('getStatus reports an environment-backed token as configured without exposing the raw secret', async (t) => {
  const originalGetIntegration = TempestIntegration.getIntegration;
  const originalListProvisionedStations = tempestService.listProvisionedStations;
  const originalToken = process.env.TEMPEST_TOKEN;

  t.after(() => {
    TempestIntegration.getIntegration = originalGetIntegration;
    tempestService.listProvisionedStations = originalListProvisionedStations;
    if (originalToken === undefined) {
      delete process.env.TEMPEST_TOKEN;
    } else {
      process.env.TEMPEST_TOKEN = originalToken;
    }
  });

  process.env.TEMPEST_TOKEN = 'tempest_env_secret_1234';

  TempestIntegration.getIntegration = async () => ({
    token: '',
    enabled: true,
    websocket: {
      connected: false,
      lastConnectedAt: null,
      lastMessageAt: null,
      reconnectCount: 0
    },
    udp: {
      listening: false,
      lastMessageAt: null
    },
    isConnected: false,
    lastDiscoveryAt: null,
    lastObservationAt: null,
    lastError: '',
    selectedStationId: null,
    toSanitized() {
      return {
        token: '',
        enabled: true,
        websocketEnabled: true,
        udpEnabled: false,
        udpBindAddress: '0.0.0.0',
        udpPort: 50222,
        room: 'Outside',
        selectedStationId: null,
        selectedDeviceIds: [],
        calibration: {}
      };
    }
  });

  tempestService.listProvisionedStations = async () => [];

  const status = await tempestService.getStatus();

  assert.equal(status.integration.tokenConfigured, true);
  assert.equal(status.integration.tokenSource, 'environment');
  assert.match(status.integration.token, /^\*+1234$/);
  assert.equal(status.integration.token.includes('tempest_env_secret_1234'), false);
});

test('testConnection uses the persisted Tempest token when no explicit token is provided', async (t) => {
  const originalGetIntegration = TempestIntegration.getIntegration;
  const originalRequestJson = tempestService.requestJson;

  t.after(() => {
    TempestIntegration.getIntegration = originalGetIntegration;
    tempestService.requestJson = originalRequestJson;
  });

  TempestIntegration.getIntegration = async () => ({
    token: 'persisted-tempest-token',
    enabled: true
  });

  tempestService.requestJson = async (path, params) => {
    assert.equal(path, '/stations');
    assert.equal(params.token, 'persisted-tempest-token');
    return { stations: [] };
  };

  const result = await tempestService.testConnection();

  assert.equal(result.success, true);
  assert.deepEqual(result.stations, []);
});

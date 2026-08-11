const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const senseService = require('../services/senseService');
const Device = require('../models/Device');
const SenseIntegration = require('../models/SenseIntegration');

const {
  buildSenseApiUrl,
  buildTrendSummaryMap,
  calculateCostUsd,
  normalizeRealtimePayload,
  normalizeTrendSnapshot,
  projectMonthlyEnergyWindow
} = senseService.__private__;

test('Sense API URL construction cannot escape the configured API origin or path', () => {
  assert.equal(
    buildSenseApiUrl('app/monitors/monitor-1/overview'),
    'https://api.sense.com/apiservice/api/v1/app/monitors/monitor-1/overview'
  );
  assert.throws(() => buildSenseApiUrl('https://attacker.example/data'), /must remain/);
  assert.throws(() => buildSenseApiUrl('/outside-api'), /must remain/);
});

test('normalizeRealtimePayload builds load shares and synthetic residual usage for the Sense dashboard', () => {
  const catalog = new Map([
    ['hvac-1', { senseDeviceId: 'hvac-1', name: 'HVAC', icon: 'fan' }],
    ['dryer-1', { senseDeviceId: 'dryer-1', name: 'Dryer', icon: 'dryer' }],
    ['always-1', { senseDeviceId: 'always-1', name: 'Always On', icon: 'plug', alwaysOn: true }]
  ]);

  const summary = normalizeRealtimePayload({
    time: '2026-04-10T12:00:00.000Z',
    w: 5200.4,
    solar_w: 1250.3,
    voltage: [121.24, 118.77],
    hz: 59.944,
    devices: [
      { id: 'hvac-1', w: 2400.2 },
      { id: 'dryer-1', w: 1500.3 },
      { id: 'always-1', w: 320.5 }
    ]
  }, {
    monitorId: 'monitor-1',
    monitorName: 'Main Panel',
    deviceCatalog: catalog,
    alwaysOnInfo: {
      total: {
        avg_w: 410.4
      }
    },
    source: 'ws'
  });

  assert.equal(summary.monitorId, 'monitor-1');
  assert.equal(summary.monitorName, 'Main Panel');
  assert.equal(summary.powerW, 5200.4);
  assert.equal(summary.solarW, 1250.3);
  assert.equal(summary.netW, 3950.1);
  assert.equal(summary.alwaysOnW, 410.4);
  assert.equal(summary.otherW, 979.4);
  assert.equal(summary.activeDeviceCount, 3);
  assert.deepEqual(summary.voltage, [121.2, 118.8]);
  assert.equal(summary.frequencyHz, 59.94);
  assert.equal(summary.activeDevices[0].senseDeviceId, 'hvac-1');
  assert.equal(summary.activeDevices[0].sharePct, 46.2);

  const residual = summary.activeDevices.find((entry) => entry.senseDeviceId === 'sense-other');
  assert.equal(residual?.synthetic, true);
  assert.equal(residual?.powerW, 979.4);
  assert.equal(residual?.sharePct, 18.8);
});

test('normalizeTrendSnapshot and buildTrendSummaryMap preserve report-ready monitor and device energy windows', () => {
  const trend = normalizeTrendSnapshot('day', {
    start: '2026-04-01T00:00:00.000Z',
    consumption: {
      usage_total_kwh: 31.8754,
      devices: [
        {
          id: 'hvac-1',
          name: 'HVAC',
          consumption: {
            usage_total_kwh: 12.4
          }
        },
        {
          device_id: 'dryer-1',
          alias: 'Dryer',
          usage_total_kwh: 6.125
        }
      ]
    }
  }, {
    total: {
      production_kwh: 10.25,
      from_grid_kwh: 22.5,
      to_grid_kwh: 1.2,
      solar_percentage: 43.2
    }
  });

  assert.equal(trend.scale, 'day');
  assert.equal(trend.startAt.toISOString(), '2026-04-01T00:00:00.000Z');
  assert.equal(trend.consumptionTotalKwh, 31.8754);
  assert.equal(trend.productionTotalKwh, 10.25);
  assert.equal(trend.productionPct, 32.16);
  assert.equal(trend.fromGridKwh, 22.5);
  assert.equal(trend.toGridKwh, 1.2);
  assert.equal(trend.solarPoweredPct, 43.2);
  assert.equal(trend.deviceBreakdown.length, 2);
  assert.deepEqual(trend.metadata, {
    usageDeviceCount: 2,
    solarPresent: true
  });
  assert.equal(trend.deviceBreakdown[0].senseDeviceId, 'hvac-1');
  assert.equal(trend.deviceBreakdown[0].sharePct, 38.9);

  const summary = buildTrendSummaryMap([trend]);
  assert.equal(summary.monitor.day.consumptionTotalKwh, 31.8754);
  assert.equal(summary.monitor.day.productionTotalKwh, 10.25);
  assert.equal(summary.devices.get('hvac-1').day.energyKwh, 12.4);
  assert.equal(summary.devices.get('dryer-1').day.sharePct, 19.22);
});

test('projectMonthlyEnergyWindow extrapolates month costs from month-to-date usage and retail rate', () => {
  const projection = projectMonthlyEnergyWindow({
    monthEnergyKwh: 121.5,
    monthStartAt: '2026-04-01T00:00:00.000Z',
    now: '2026-04-11T12:00:00.000Z'
  });

  assert.equal(projection.method, 'month-to-date');
  assert.equal(projection.monthToDateKwh, 121.5);
  assert.equal(projection.daysInMonth, 30);
  assert.equal(calculateCostUsd(projection.monthToDateKwh, 11), 13.37);
  assert.equal(calculateCostUsd(projection.projectedMonthKwh, 11), 38.19);
});

test('testConnection reuses persisted credentials when the client keeps a masked password', async () => {
  const service = new senseService.SenseService();
  let authenticateInput = null;

  service.resolvePersistedIntegration = async () => ({
    email: 'saved@example.com',
    password: 'saved-password',
    deviceId: 'device-123',
    accessToken: '',
    refreshToken: '',
    userId: '',
    monitorId: 'monitor-1',
    monitorName: 'Main Panel',
    availableMonitors: []
  });

  service.authenticate = async (integration, options = {}) => {
    authenticateInput = {
      email: integration.email,
      password: integration.password,
      monitorId: integration.monitorId,
      mfaCode: options.mfaCode,
      persist: options.persist
    };

    integration.availableMonitors = [{
      id: 'monitor-1',
      name: 'Main Panel',
      solarConfigured: true
    }];
    integration.monitorId = integration.monitorId || 'monitor-1';
  };

  service.requestApi = async (path, { integration }) => {
    assert.equal(path, 'app/monitors/monitor-1/overview');
    assert.equal(integration.email, 'saved@example.com');
    assert.equal(integration.password, 'saved-password');

    return {
      monitor: {
        id: 'monitor-1',
        name: 'Main Panel',
        solar_configured: true
      }
    };
  };

  const result = await service.testConnection({
    email: 'saved@example.com'
  });

  assert.deepEqual(authenticateInput, {
    email: 'saved@example.com',
    password: 'saved-password',
    monitorId: 'monitor-1',
    mfaCode: '',
    persist: false
  });
  assert.equal(result.success, true);
  assert.equal(result.monitors.length, 1);
  assert.equal(result.monitor.monitorId, 'monitor-1');
  assert.equal(result.monitor.name, 'Main Panel');
});

test('requestApi falls back to full Sense auth when refresh token renewal is rejected', async (t) => {
  const service = new senseService.SenseService();
  const originalAxiosGet = axios.get;
  const calls = [];
  let renewCalled = false;
  let authenticateCalled = false;

  const integration = {
    email: 'saved@example.com',
    password: 'saved-password',
    accessToken: 'expired-access-token',
    refreshToken: 'expired-refresh-token',
    userId: 'user-1',
    deviceId: 'device-123',
    monitorId: 'monitor-1'
  };

  axios.get = async (url, options = {}) => {
    calls.push({
      url,
      authorization: options.headers?.Authorization
    });

    if (calls.length === 1) {
      return {
        status: 401,
        data: {
          message: 'Failed to authenticate.'
        }
      };
    }

    return {
      status: 200,
      data: {
        monitor: {
          id: 'monitor-1',
          name: 'Main Panel'
        }
      }
    };
  };

  service.renewAuth = async () => {
    renewCalled = true;
    throw new Error('Failed to authenticate.');
  };

  service.authenticate = async (targetIntegration) => {
    authenticateCalled = true;
    assert.equal(targetIntegration.email, 'saved@example.com');
    assert.equal(targetIntegration.password, 'saved-password');
    targetIntegration.accessToken = 'fresh-access-token';
  };

  t.after(() => {
    axios.get = originalAxiosGet;
  });

  const result = await service.requestApi('app/monitors/monitor-1/overview', { integration });

  assert.equal(renewCalled, true);
  assert.equal(authenticateCalled, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, 'bearer expired-access-token');
  assert.equal(calls[1].authorization, 'bearer fresh-access-token');
  assert.equal(result.monitor.id, 'monitor-1');
});

test('updateRealtimeState throttles websocket heartbeat persistence to avoid save storms', async () => {
  const service = new senseService.SenseService();
  const originalUpdateOne = SenseIntegration.updateOne;
  const updates = [];
  let saveCalled = false;

  SenseIntegration.updateOne = async (query, update) => {
    updates.push({ query, update });
  };

  try {
    service.lastRealtimeStatePersistAt = Date.now();

    await service.updateRealtimeState({
      _id: 'integration-1',
      websocket: {
        connected: true,
        reconnectCount: 0,
        lastConnectedAt: new Date('2026-04-11T12:00:00.000Z')
      },
      lastError: '',
      lastRealtimeAt: null,
      lastSyncAt: null,
      save: async () => {
        saveCalled = true;
      }
    }, {
      websocket: {
        connected: true,
        lastMessageAt: new Date('2026-04-11T12:01:00.000Z')
      },
      lastError: ''
    }, {
      throttlePersist: true
    });

    assert.equal(updates.length, 0);
    assert.equal(saveCalled, false);
  } finally {
    SenseIntegration.updateOne = originalUpdateOne;
  }
});

test('updateRealtimeState persists important websocket state transitions with updateOne', async () => {
  const service = new senseService.SenseService();
  const originalUpdateOne = SenseIntegration.updateOne;
  const updates = [];

  SenseIntegration.updateOne = async (query, update) => {
    updates.push({ query, update });
  };

  try {
    service.lastRealtimeStatePersistAt = Date.now();

    await service.updateRealtimeState({
      _id: 'integration-1',
      websocket: {
        connected: true,
        reconnectCount: 0,
        lastConnectedAt: new Date('2026-04-11T12:00:00.000Z')
      },
      lastError: '',
      lastRealtimeAt: null,
      lastSyncAt: null
    }, {
      websocket: {
        connected: false
      },
      lastError: 'socket down'
    }, {
      throttlePersist: true
    });

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].query, { _id: 'integration-1' });
    assert.equal(updates[0].update.$set.websocket.connected, false);
    assert.equal(updates[0].update.$set.lastError, 'socket down');
  } finally {
    SenseIntegration.updateOne = originalUpdateOne;
  }
});

test('ingestRealtimePayload suppresses overlapping websocket persistence', async () => {
  const service = new senseService.SenseService();
  let persistCalls = 0;
  let releasePersistence;
  let markPersistenceStarted;
  const persistenceStarted = new Promise((resolve) => {
    markPersistenceStarted = resolve;
  });
  const persistenceReleased = new Promise((resolve) => {
    releasePersistence = resolve;
  });

  service.fetchAlwaysOnInfo = async () => null;
  service.persistRealtimeSummary = async () => {
    persistCalls += 1;
    markPersistenceStarted();
    await persistenceReleased;
  };

  const integration = {
    monitorId: 'monitor-1',
    monitorName: 'Main Panel',
    pollIntervalSeconds: 5
  };
  const firstIngest = service.ingestRealtimePayload(integration, {
    time: '2026-08-10T13:00:00.000Z',
    w: 1200,
    devices: []
  }, { source: 'ws' });

  await persistenceStarted;

  const secondSummary = await service.ingestRealtimePayload(integration, {
    time: '2026-08-10T13:00:01.000Z',
    w: 1210,
    devices: []
  }, { source: 'ws' });

  assert.equal(persistCalls, 1);
  assert.equal(secondSummary.powerW, 1210);

  releasePersistence();
  await firstIngest;
  assert.equal(service.realtimePersistPromise, null);
});

const buildSenseTestDevice = ({
  id,
  name,
  entityType,
  senseDeviceId = null,
  isOnline = false,
  status = false,
  currentPowerW = 0,
  currentSharePct = 0,
  lastSnapshotAt = '2026-06-17T19:34:11.427Z'
}) => ({
  _id: id,
  name,
  type: 'sensor',
  room: 'Electrical Panel',
  status,
  isOnline,
  brand: 'Sense',
  model: entityType === 'monitor' ? 'Home Energy Monitor' : 'Detected Load',
  lastSeen: new Date(lastSnapshotAt),
  properties: {
    source: 'sense',
    sense: {
      entityType,
      monitorId: 'monitor-1',
      ...(senseDeviceId ? { senseDeviceId } : {}),
      currentPowerW,
      currentSharePct,
      lastSnapshotAt
    }
  },
  saveCount: 0,
  async save() {
    this.saveCount += 1;
    return this;
  }
});

const installSenseDeviceFindStub = ({ monitorDevice, loadDevice }, t) => {
  const originalFind = Device.find;
  const originalDeleteMany = Device.deleteMany;

  Device.find = async (query = {}) => {
    const entityType = query['properties.sense.entityType'];
    if (entityType === 'monitor') {
      return [monitorDevice];
    }

    if (
      entityType === 'device'
      && query['properties.sense.senseDeviceId'] === loadDevice.properties.sense.senseDeviceId
    ) {
      return [loadDevice];
    }

    return [];
  };
  Device.deleteMany = async () => ({ deletedCount: 0 });

  t.after(() => {
    Device.find = originalFind;
    Device.deleteMany = originalDeleteMany;
  });
};

test('upsertSenseDevices marks stale Sense telemetry without taking every detected load offline', async (t) => {
  const service = new senseService.SenseService();
  const staleRealtimeAt = '2026-06-17T19:34:11.427Z';
  const monitorDevice = buildSenseTestDevice({
    id: 'monitor-device',
    name: 'Main Panel Whole Home',
    entityType: 'monitor',
    isOnline: true,
    status: true,
    currentPowerW: 2810.6,
    lastSnapshotAt: staleRealtimeAt
  });
  const loadDevice = buildSenseTestDevice({
    id: 'load-device',
    name: 'Dryer',
    entityType: 'device',
    senseDeviceId: 'load-1',
    isOnline: false,
    status: false,
    currentPowerW: 42.5,
    currentSharePct: 10.2,
    lastSnapshotAt: staleRealtimeAt
  });

  installSenseDeviceFindStub({ monitorDevice, loadDevice }, t);
  service.deviceCatalog = new Map([
    ['load-1', {
      senseDeviceId: 'load-1',
      name: 'Dryer',
      icon: 'dryer',
      room: 'Electrical Panel',
      model: 'Detected Load'
    }]
  ]);

  await service.upsertSenseDevices({
    integration: {
      monitorId: 'monitor-1',
      monitorName: 'Main Panel',
      room: 'Electrical Panel',
      enabled: true,
      isConnected: false,
      lastRealtimeAt: new Date(staleRealtimeAt),
      snapshot: {
        live: {
          observedAt: staleRealtimeAt,
          powerW: 2810.6,
          solarW: 0,
          netW: 2810.6,
          alwaysOnW: 350,
          otherW: 120,
          activeDeviceCount: 3
        }
      },
      electricityRateCentsPerKwh: 11
    },
    summary: null,
    emitUpdates: false,
    realtimeConnected: false
  });

  assert.equal(monitorDevice.isOnline, false);
  assert.equal(monitorDevice.properties.sense.feedConnected, false);
  assert.equal(monitorDevice.properties.sense.dataStale, true);
  assert.equal(monitorDevice.properties.sense.currentPowerW, 2810.6);
  assert.equal(monitorDevice.lastSeen.toISOString(), staleRealtimeAt);

  assert.equal(loadDevice.isOnline, true);
  assert.equal(loadDevice.status, true);
  assert.equal(loadDevice.properties.sense.feedConnected, false);
  assert.equal(loadDevice.properties.sense.dataStale, true);
  assert.equal(loadDevice.properties.sense.currentPowerW, 42.5);
  assert.equal(loadDevice.properties.sense.currentSharePct, 10.2);
  assert.equal(loadDevice.properties.sense.lastSnapshotAt, staleRealtimeAt);
  assert.equal(loadDevice.lastSeen.toISOString(), staleRealtimeAt);
});

test('upsertSenseDevices treats a fresh Sense realtime payload as connected even before integration save', async (t) => {
  const service = new senseService.SenseService();
  const monitorDevice = buildSenseTestDevice({
    id: 'monitor-device',
    name: 'Main Panel Whole Home',
    entityType: 'monitor',
    isOnline: false
  });
  const loadDevice = buildSenseTestDevice({
    id: 'load-device',
    name: 'Dryer',
    entityType: 'device',
    senseDeviceId: 'load-1',
    isOnline: false
  });

  installSenseDeviceFindStub({ monitorDevice, loadDevice }, t);
  service.deviceCatalog = new Map([
    ['load-1', {
      senseDeviceId: 'load-1',
      name: 'Dryer',
      icon: 'dryer',
      room: 'Electrical Panel',
      model: 'Detected Load'
    }]
  ]);

  await service.upsertSenseDevices({
    integration: {
      monitorId: 'monitor-1',
      monitorName: 'Main Panel',
      room: 'Electrical Panel',
      enabled: true,
      isConnected: false,
      electricityRateCentsPerKwh: 11
    },
    summary: {
      observedAt: '2026-06-21T12:00:00.000Z',
      powerW: 100,
      solarW: 0,
      netW: 100,
      alwaysOnW: 0,
      otherW: 55,
      untrackedW: 0,
      activeDeviceCount: 1,
      voltage: [121.1, 120.9],
      frequencyHz: 60,
      activeDevices: [{
        senseDeviceId: 'load-1',
        powerW: 45,
        sharePct: 45
      }]
    },
    emitUpdates: false,
    realtimeConnected: true
  });

  assert.equal(monitorDevice.isOnline, true);
  assert.equal(monitorDevice.properties.sense.feedConnected, true);
  assert.equal(monitorDevice.properties.sense.dataStale, false);
  assert.equal(monitorDevice.properties.sense.currentPowerW, 100);
  assert.equal(monitorDevice.lastSeen.toISOString(), '2026-06-21T12:00:00.000Z');

  assert.equal(loadDevice.isOnline, true);
  assert.equal(loadDevice.status, true);
  assert.equal(loadDevice.properties.sense.feedConnected, true);
  assert.equal(loadDevice.properties.sense.dataStale, false);
  assert.equal(loadDevice.properties.sense.currentPowerW, 45);
  assert.equal(loadDevice.properties.sense.currentSharePct, 45);
  assert.equal(loadDevice.properties.sense.lastSnapshotAt, '2026-06-21T12:00:00.000Z');
});

test('Sense refresh failures back off scheduled polling without disabling the integration', async (t) => {
  const service = new senseService.SenseService();
  service.backgroundEnabled = true;
  const originalGetIntegration = SenseIntegration.getIntegration;

  SenseIntegration.getIntegration = async () => ({
    enabled: true,
    pollIntervalSeconds: 10
  });

  t.after(async () => {
    SenseIntegration.getIntegration = originalGetIntegration;
    await service.shutdown();
  });

  const appliedBackoffMs = service.noteRefreshFailure(new Error('HTTP 504 Gateway Timeout'));
  await service.ensurePollTimer();

  const expectedBackoffBaseMs = Math.max(
    30_000,
    Number(process.env.SENSE_FAILURE_BACKOFF_BASE_MS || 60_000)
  );

  assert.equal(service.consecutiveRefreshFailures, 1);
  assert.equal(appliedBackoffMs, expectedBackoffBaseMs);
  assert.equal(service.failureBackoffMs, expectedBackoffBaseMs);
  assert.equal(service.pollIntervalMs <= expectedBackoffBaseMs, true);
  assert.equal(service.pollIntervalMs >= expectedBackoffBaseMs - 1000, true);
  assert.equal(service.pollIntervalMs > 10_000, true);

  service.resetRefreshFailureBackoff();
  await service.ensurePollTimer();

  assert.equal(service.consecutiveRefreshFailures, 0);
  assert.equal(service.pollIntervalMs, 10_000);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const axios = require('axios');

const rainMachineService = require('../services/rainMachineService');
const RainMachineIntegration = require('../models/RainMachineIntegration');

const {
  buildRequestPayload,
  certificateFingerprintSha256,
  certificateFingerprintsMatch,
  compactRainMachineSnapshot,
  createPinnedHttpsAgent,
  normalizeDailyStats,
  normalizeWateringLogDays,
  parseDiscoveryResponse,
  snapshotShowsActiveZone,
  summarizeRainMachineDailyStat,
  summarizeRainMachineWateringDay
} = rainMachineService.__private__;

test('self-signed RainMachine trust pins the exact certificate with validation enabled', () => {
  const leaf = Buffer.from('test-rainmachine-leaf-certificate', 'utf8');
  const issuer = Buffer.from('test-rainmachine-issuer-certificate', 'utf8');
  const peerCertificate = {
    raw: leaf,
    issuerCertificate: {
      raw: issuer
    }
  };
  const expectedFingerprint = certificateFingerprintSha256(leaf);
  const trust = createPinnedHttpsAgent(
    peerCertificate,
    expectedFingerprint.toUpperCase().match(/.{1,2}/g).join(':')
  );

  assert.equal(trust.fingerprintSha256, expectedFingerprint);
  assert.equal(trust.agent.options.rejectUnauthorized, true);
  assert.equal(
    trust.agent.options.checkServerIdentity('rainmachine.local', { raw: leaf }),
    undefined
  );
  assert.match(
    trust.agent.options.checkServerIdentity('rainmachine.local', { raw: Buffer.from('different') }).message,
    /did not match/
  );
  assert.equal(certificateFingerprintsMatch(expectedFingerprint, expectedFingerprint.toUpperCase()), true);
  assert.throws(
    () => createPinnedHttpsAgent(peerCertificate, 'f'.repeat(64)),
    /certificate changed/
  );
});

test('self-signed endpoint enrollment persists trust only after a validated probe', async () => {
  const service = new rainMachineService.RainMachineService();
  const originalGet = axios.get;
  const originalUpdateOne = RainMachineIntegration.updateOne;
  const safeAgent = new https.Agent({ rejectUnauthorized: true });
  const fingerprint = 'a'.repeat(64);
  const calls = [];
  let persistedUpdate = null;

  axios.get = async (_url, options) => {
    calls.push(options);
    if (calls.length === 1) {
      const error = new Error('self signed');
      error.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
      throw error;
    }
    return {
      status: 200,
      data: { statusCode: 0, apiVer: '4.6.1' }
    };
  };
  RainMachineIntegration.updateOne = async (query, update) => {
    persistedUpdate = { query, update };
  };
  service.buildSelfSignedHttpsTrust = async () => ({
    agent: safeAgent,
    fingerprintSha256: fingerprint
  });

  try {
    const endpoint = {
      host: 'rainmachine.local',
      port: 8080,
      protocol: 'https',
      baseUrl: 'https://rainmachine.local:8080/api/4'
    };
    const integration = { _id: 'rainmachine-integration' };
    const apiVersion = await service.probeEndpoint(endpoint, integration);

    assert.equal(apiVersion.apiVer, '4.6.1');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].httpsAgent, safeAgent);
    assert.equal(endpoint.httpsAgent, safeAgent);
    assert.equal(integration.tlsCertificateFingerprintSha256, fingerprint);
    assert.deepEqual(persistedUpdate.query, { _id: 'rainmachine-integration' });
    assert.equal(persistedUpdate.update.$set.tlsCertificateFingerprintSha256, fingerprint);
  } finally {
    axios.get = originalGet;
    RainMachineIntegration.updateOne = originalUpdateOne;
  }
});

test('endpoint probing never silently downgrades HTTPS configurations to HTTP', async () => {
  const service = new rainMachineService.RainMachineService();
  const candidates = [];
  service.probeEndpoint = async (endpoint) => {
    candidates.push(endpoint);
    throw new Error('unavailable');
  };

  await assert.rejects(
    () => service.resolveEndpoint({
      host: 'rainmachine.local',
      protocol: 'https',
      port: 8443
    }),
    /unavailable/
  );
  assert.ok(candidates.length > 0);
  assert.equal(candidates.every((candidate) => candidate.protocol === 'https'), true);
});

test('parseDiscoveryResponse extracts controller discovery details from broadcast payloads', () => {
  const parsed = parseDiscoveryResponse(
    Buffer.from('rainmachine||AA:BB:CC:DD:EE:FF||Front Yard||http://192.168.1.25||1', 'utf8'),
    { address: '192.168.1.25' }
  );

  assert.deepEqual(parsed, {
    name: 'Front Yard',
    host: '192.168.1.25',
    protocol: 'http',
    port: 8080,
    macAddress: 'AA:BB:CC:DD:EE:FF',
    configured: true,
    address: '192.168.1.25'
  });
});

test('normalizeDailyStats merges per-day details into reporting metrics', () => {
  const stats = normalizeDailyStats(
    {
      dailyStats: [
        {
          day: '2026-04-10',
          minTemp: 4.2,
          maxTemp: 18.9
        }
      ]
    },
    {
      DailyStatsDetails: [
        {
          day: '2026-04-10',
          programs: [
            {
              id: 1,
              zones: [
                {
                  uid: 2,
                  scheduledWateringTime: 600,
                  computedWateringTime: 420,
                  wateringFlag: 0
                },
                {
                  uid: 3,
                  scheduledWateringTime: 300,
                  computedWateringTime: 240,
                  wateringFlag: 0
                }
              ]
            }
          ]
        }
      ]
    },
    {
      id: 'AA:BB:CC',
      name: 'Back Yard'
    }
  );

  assert.equal(stats.length, 1);
  assert.equal(stats[0].controllerId, 'AA:BB:CC');
  assert.equal(stats[0].metrics.program_count, 1);
  assert.equal(stats[0].metrics.zone_count, 2);
  assert.equal(stats[0].metrics.scheduled_duration_sec, 900);
  assert.equal(stats[0].metrics.machine_duration_sec, 660);
  assert.equal(stats[0].metrics.adjustment_pct, 73.3);
  assert.equal(stats[0].metrics.water_saved_pct, 26.7);
  assert.equal(stats[0].metrics.min_temp_c, 4.2);
  assert.equal(stats[0].metrics.max_temp_c, 18.9);
});

test('normalizeWateringLogDays summarizes durations and saved percentage from watering cycles', () => {
  const days = normalizeWateringLogDays(
    {
      waterLog: {
        days: [
          {
            date: '2026-04-09',
            programs: [
              {
                id: 5,
                zones: [
                  {
                    uid: 1,
                    flag: 0,
                    cycles: [
                      {
                        startTime: '2026-04-09 05:00:00',
                        userDuration: 600,
                        realDuration: 420,
                        machineDuration: 420
                      }
                    ]
                  },
                  {
                    uid: 2,
                    flag: 0,
                    cycles: [
                      {
                        startTime: '2026-04-09 05:10:00',
                        userDuration: 300,
                        realDuration: 300,
                        machineDuration: 300
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    },
    {
      id: 'AA:BB:CC',
      name: 'Back Yard'
    }
  );

  assert.equal(days.length, 1);
  assert.equal(days[0].summary.program_count, 1);
  assert.equal(days[0].summary.zone_count, 2);
  assert.equal(days[0].summary.cycle_count, 2);
  assert.equal(days[0].summary.scheduled_duration_sec, 900);
  assert.equal(days[0].summary.watered_duration_sec, 720);
  assert.equal(days[0].summary.machine_duration_sec, 720);
  assert.equal(days[0].summary.water_saved_pct, 20);
});

test('compactRainMachineSnapshot removes verbose zone payload fragments before dashboard serialization', () => {
  const compact = compactRainMachineSnapshot({
    controller: {
      id: 'AA:BB:CC',
      name: 'Back Yard'
    },
    runtime: {
      queueLength: 1
    },
    zones: [
      {
        uid: 7,
        valveId: 7,
        name: 'Front Lawn',
        active: true,
        state: 1,
        stateLabel: 'running',
        remainingSeconds: 420,
        raw: {
          zone: { some: 'large-value' },
          properties: { another: 'large-value' }
        },
        waterSense: {
          enabled: true
        },
        type: 3
      }
    ],
    programs: [
      {
        uid: 1,
        name: 'Morning',
        statusLabel: 'idle',
        totalConfiguredDurationSeconds: 600,
        zoneIds: [7],
        wateringTimes: [
          { id: 7, active: true, order: 1, durationSeconds: 600, debug: 'ignore-me' }
        ]
      }
    ],
    restrictions: {
      currently: {
        activeCount: 0
      }
    }
  });

  assert.deepEqual(compact.zones, [
    {
      uid: 7,
      valveId: 7,
      name: 'Front Lawn',
      active: true,
      master: false,
      state: 1,
      stateLabel: 'running',
      restriction: false,
      userDurationSeconds: 0,
      machineDurationSeconds: 0,
      remainingSeconds: 420,
      cycle: 0,
      cycleCount: 0,
      internet: false,
      history: false,
      soil: null,
      slope: null,
      sun: null,
      sprinkler: null,
      savings: null,
      nextRun: null,
      nextRunProgramId: null,
      nextRunProgramName: '',
      nextRunDurationSeconds: null
    }
  ]);
  assert.deepEqual(compact.programs[0].wateringTimes, [
    {
      id: 7,
      active: true,
      order: 1,
      durationSeconds: 600
    }
  ]);
});

test('dashboard summary helpers keep RainMachine report history lightweight', () => {
  const dailySummary = summarizeRainMachineDailyStat({
    controllerId: 'AA:BB:CC',
    controllerName: 'Back Yard',
    day: '2026-04-10',
    dayDate: '2026-04-10T00:00:00.000Z',
    metrics: {
      water_saved_pct: 26.7
    },
    details: {
      programs: [{ id: 1 }]
    }
  });
  const wateringSummary = summarizeRainMachineWateringDay({
    controllerId: 'AA:BB:CC',
    controllerName: 'Back Yard',
    day: '2026-04-09',
    dayDate: '2026-04-09T00:00:00.000Z',
    simulated: false,
    summary: {
      program_count: 1,
      cycle_count: 2
    },
    programs: [
      {
        id: 5,
        zones: [{ uid: 1 }]
      }
    ],
    raw: {
      giant: true
    }
  });

  assert.deepEqual(dailySummary, {
    controllerId: 'AA:BB:CC',
    controllerName: 'Back Yard',
    day: '2026-04-10',
    dayDate: '2026-04-10T00:00:00.000Z',
    metrics: {
      water_saved_pct: 26.7
    }
  });
  assert.deepEqual(wateringSummary, {
    controllerId: 'AA:BB:CC',
    controllerName: 'Back Yard',
    day: '2026-04-09',
    dayDate: '2026-04-09T00:00:00.000Z',
    simulated: false,
    summary: {
      program_count: 1,
      cycle_count: 2
    }
  });
});

test('buildRequestPayload uses JSON bodies for RainMachine POST objects', () => {
  const payload = buildRequestPayload({ time: 600 });

  assert.equal(payload.payload, JSON.stringify({ time: 600 }));
  assert.deepEqual(payload.headers, {
    'Content-Type': 'application/json'
  });
});

test('startZone still returns dashboard when post-start refresh fails after the command succeeds', async () => {
  const service = new rainMachineService.RainMachineService();
  const originalGetIntegration = RainMachineIntegration.getIntegration;

  RainMachineIntegration.getIntegration = async () => ({
    defaultZoneDurationSeconds: 600
  });

  service.resolveEndpoint = async () => ({
    baseUrl: 'http://rainmachine.local:8081/api/4',
    host: 'rainmachine.local',
    port: 8081,
    protocol: 'http'
  });

  const requestCalls = [];
  service.request = async (_endpoint, options) => {
    requestCalls.push(options);
    return {};
  };
  service.refreshRuntime = async () => {
    throw new Error('sync failed');
  };
  service.getDashboard = async () => ({
    ok: true
  });

  try {
    const dashboard = await service.startZone(7, 600);

    assert.deepEqual(dashboard, { ok: true });
    assert.equal(requestCalls.length, 1);
    assert.equal(requestCalls[0].path, 'zone/7/start');
    assert.deepEqual(requestCalls[0].data, { time: 600 });
  } finally {
    RainMachineIntegration.getIntegration = originalGetIntegration;
  }
});

test('snapshotShowsActiveZone identifies a running zone from the cached snapshot', () => {
  assert.equal(
    snapshotShowsActiveZone(
      {
        runtime: {
          activeZone: {
            uid: 7,
            stateLabel: 'running'
          }
        },
        zones: [
          {
            uid: 7,
            stateLabel: 'running'
          }
        ]
      },
      7
    ),
    true
  );
});

test('stopZone falls back to stop-all when direct stop fails for the active zone', async () => {
  const service = new rainMachineService.RainMachineService();
  const originalGetIntegration = RainMachineIntegration.getIntegration;

  RainMachineIntegration.getIntegration = async () => ({
    snapshot: {
      runtime: {
        activeZone: {
          uid: 7,
          stateLabel: 'running'
        }
      },
      zones: [
        {
          uid: 7,
          stateLabel: 'running'
        }
      ]
    }
  });

  service.resolveEndpoint = async () => ({
    baseUrl: 'http://rainmachine.local:8081/api/4',
    host: 'rainmachine.local',
    port: 8081,
    protocol: 'http'
  });

  const requestPaths = [];
  service.request = async (_endpoint, options) => {
    requestPaths.push(options.path);
    if (options.path === 'zone/7/stop') {
      throw new Error('unsupported stop path');
    }
    return {};
  };
  service.refreshRuntime = async () => ({});
  service.getDashboard = async () => ({ ok: true });

  try {
    const dashboard = await service.stopZone(7);

    assert.deepEqual(dashboard, { ok: true });
    assert.deepEqual(requestPaths, ['zone/7/stop', 'watering/stopall']);
  } finally {
    RainMachineIntegration.getIntegration = originalGetIntegration;
  }
});

test('getDashboardSafe returns cached dashboard payload when dashboard assembly fails', async () => {
  const service = new rainMachineService.RainMachineService();

  service.getDashboard = async () => {
    throw new Error('dashboard assembly failed');
  };
  service.getDailyStatsSummaryForIntegration = async () => [];
  service.getWateringHistorySummaryForIntegration = async () => [];

  const dashboard = await service.getDashboardSafe({
    integration: {
      enabled: true,
      isConnected: true,
      lastError: '',
      lastSyncAt: '2026-04-11T18:00:00.000Z',
      lastReportSyncAt: null,
      controllerId: 'AA:BB:CC',
      snapshot: {
        controller: {
          id: 'AA:BB:CC',
          name: 'Back Yard'
        },
        runtime: {
          queueLength: 0
        },
        zones: [],
        programs: [],
        restrictions: null
      }
    }
  });

  assert.equal(dashboard.integration.enabled, true);
  assert.equal(dashboard.controller?.id, 'AA:BB:CC');
  assert.equal(dashboard.runtime?.queueLength, 0);
  assert.deepEqual(dashboard.dailyStats, []);
});

test('performSync restores connectivity before synchronizing recovered RainMachine devices', async (t) => {
  const service = new rainMachineService.RainMachineService();
  const originalGetIntegration = RainMachineIntegration.getIntegration;
  let saved = false;
  const integration = {
    _id: 'rainmachine-integration',
    enabled: true,
    host: 'rainmachine.local',
    protocol: 'http',
    port: 8081,
    password: 'configured',
    room: 'Irrigation',
    controllerId: 'AA:BB:CC',
    controllerName: 'Back Yard',
    isConnected: false,
    snapshot: {},
    async save() {
      saved = true;
    }
  };

  RainMachineIntegration.getIntegration = async () => integration;
  t.after(() => {
    RainMachineIntegration.getIntegration = originalGetIntegration;
  });

  service.resolveEndpoint = async () => ({
    host: 'rainmachine.local',
    protocol: 'http',
    port: 8081,
    baseUrl: 'http://rainmachine.local:8081/api/4'
  });
  service.request = async (_endpoint, options) => {
    if (options.path === 'apiVer') {
      return { apiVer: '4.6.1', hwVer: 3, swVer: '4.0.1144' };
    }
    if (options.path === 'provision') {
      return { system: { netName: 'Back Yard' } };
    }
    if (options.path === 'zone') {
      return { zones: [] };
    }
    if (options.path === 'program') {
      return { programs: [] };
    }
    return {};
  };
  service.requestSafe = async (_endpoint, _options, fallback) => fallback;
  service.syncReports = async () => ({
    synced: false,
    dailyStatsCount: 0,
    wateringDayCount: 0,
    simulatedWateringDayCount: 0
  });

  let connectedDuringDeviceSync = null;
  service.syncDevices = async (_snapshot, syncIntegration) => {
    connectedDuringDeviceSync = syncIntegration.isConnected;
    return {
      controllerDeviceId: 'controller-device',
      zoneDeviceCount: 0,
      deduped: 0
    };
  };

  const result = await service.performSync({ reason: 'scheduled-sync' });

  assert.equal(result.success, true);
  assert.equal(connectedDuringDeviceSync, true);
  assert.equal(integration.isConnected, true);
  assert.equal(saved, true);
});

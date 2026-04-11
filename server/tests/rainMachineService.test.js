const test = require('node:test');
const assert = require('node:assert/strict');

const rainMachineService = require('../services/rainMachineService');

const {
  normalizeDailyStats,
  normalizeWateringLogDays,
  parseDiscoveryResponse
} = rainMachineService.__private__;

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

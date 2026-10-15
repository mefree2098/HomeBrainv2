const test = require('node:test');
const assert = require('node:assert/strict');
const Device = require('../models/Device');
const TempestObservation = require('../models/TempestObservation');
const { TelemetryService, __private__: helpers } = require('../services/telemetryService');

const rainfallKey = 'cumulative_rainfall_in';
const station = helpers.buildSourceSummaryFromSnapshot({
  sourceKey: 'tempest_station:station-1', sourceType: 'tempest_station', sourceId: 'station-1',
  sourceName: 'Lehi', metricKeys: ['temperature_f', 'rain_today_in', 'rain_rate_in_hr', 'rain_last_minute_in']
});
const thermostat = {
  sourceKey: 'device:thermostat', sourceType: 'device', name: 'Thermostat',
  availableMetrics: helpers.buildMetricDescriptors(['temperature', 'humidity_pct', ...Array.from({ length: 30 }, (_, i) => `smart_things_had_the_last_${i}`)]),
  featuredMetricKeys: ['temperature', 'humidity_pct']
};

test('the production rainfall prompt selects Tempest cumulative rainfall even with a preferred thermostat and failed AI', async () => {
  const service = new TelemetryService({ planChart: async () => { throw new Error('AI unavailable'); } });
  service.listSourceSummaries = async () => [thermostat, station];
  for (const prompt of [
    'Show me how much cumulative rainfall we’ve had in the last 30 days.',
    'Show total precipitation in the past month',
    'How much rain have we had in the last 30d?'
  ]) {
    const result = await service.buildChartFromPrompt({ prompt, preferredSourceKey: thermostat.sourceKey });
    assert.equal(result.chart.sourceKey, station.sourceKey);
    assert.deepEqual(result.chart.metricKeys, [rainfallKey]);
    assert.equal(result.chart.hours, 720);
  }
});

test('rain rate is distinct from cumulative rainfall and missing weather sources produce a useful error', async () => {
  const service = new TelemetryService();
  service.listSourceSummaries = async () => [station, thermostat];
  const result = await service.buildChartFromPrompt({ prompt: 'Show rainfall rate for the last two weeks' });
  assert.deepEqual(result.chart.metricKeys, ['rain_rate_in_hr']);
  assert.equal(result.chart.hours, 336);
  service.listSourceSummaries = async () => [thermostat];
  await assert.rejects(service.buildChartFromPrompt({ prompt: 'Cumulative rain for 30 days' }), /No Tempest/);
});

test('common prompt words and duplicated internal metric names cannot inflate source relevance', () => {
  const prompt = 'Show me how much cumulative rainfall we’ve had in the last 30 days.';
  const keywords = helpers.extractPromptKeywords(prompt);
  assert.deepEqual(keywords, ['rainfall']);
  assert.ok(helpers.scoreSourceForPrompt(station, prompt, keywords) > helpers.scoreSourceForPrompt(thermostat, prompt, keywords));
});

test('a failed or invalid AI plan falls back to metrics belonging to the matching source', async () => {
  const fan = { sourceKey: 'device:fan', sourceType: 'device', name: 'Master Toilet Fan', availableMetrics: helpers.buildMetricDescriptors(['status']), featuredMetricKeys: ['status'] };
  for (const response of [null, '{"sourceKey":"device:fan","metricKeys":["rain_today_in"]}', '{"sourceKey":"made-up","metricKeys":["status"]}']) {
    const service = new TelemetryService({ planChart: async () => {
      if (response == null) throw new Error('provider failed');
      return response;
    } });
    service.listSourceSummaries = async () => [thermostat, fan];
    const result = await service.buildChartFromPrompt({ prompt: 'Show Master Toilet Fan on/off history for the last week', preferredSourceKey: thermostat.sourceKey });
    assert.equal(result.chart.sourceKey, fan.sourceKey);
    assert.deepEqual(result.chart.metricKeys, ['status']);
    assert.equal(result.chart.hours, 168);
  }
});

test('energy and irrigation source requests override an unrelated preferred source', async () => {
  const sense = { sourceKey: 'sense_monitor:sense', sourceType: 'sense_monitor', name: 'Sense', availableMetrics: helpers.buildMetricDescriptors(['power_w', 'always_on_w']), featuredMetricKeys: ['power_w'] };
  const irrigation = { sourceKey: 'rainmachine_report:rain', sourceType: 'rainmachine_report', name: 'RainMachine', availableMetrics: helpers.buildMetricDescriptors(['water_saved_pct']), featuredMetricKeys: ['water_saved_pct'] };
  const service = new TelemetryService({ planChart: async () => { throw new Error('provider failed'); } });
  service.listSourceSummaries = async () => [thermostat, station, sense, irrigation];
  const result = await service.buildChartFromPrompt({ prompt: 'Compare Sense Always On vs total load for the last 24 hours', preferredSourceKey: thermostat.sourceKey });
  assert.equal(result.chart.sourceKey, sense.sourceKey);
  assert.deepEqual(result.chart.metricKeys, ['always_on_w', 'power_w']);
  const water = await service.buildChartFromPrompt({ prompt: 'Graph RainMachine water saved percent for the last two weeks', preferredSourceKey: thermostat.sourceKey });
  assert.equal(water.chart.sourceKey, irrigation.sourceKey);
  assert.deepEqual(water.chart.metricKeys, ['water_saved_pct']);
  assert.equal(water.chart.hours, 336);
});

test('cumulative rainfall sums unrounded increments across midnight and preserves the final total at reduced resolution', () => {
  const startAt = new Date('2026-10-01T23:58:00Z');
  const endAt = new Date('2026-10-03T00:00:00Z');
  const buckets = [
    { rainMm: 0.01, observationCount: 1, firstObservedAt: new Date('2026-10-01T23:59:00Z'), lastObservedAt: new Date('2026-10-01T23:59:00Z') },
    { rainMm: 25.39, observationCount: 1000, firstObservedAt: new Date('2026-10-02T00:00:00Z'), lastObservedAt: new Date('2026-10-02T23:59:00Z') }
  ];
  const result = helpers.buildRainfallSeries(station, buckets, { hours: 25, startAt, endAt, maxPoints: 240 });
  assert.equal(result.rainfall.totalIn, 1);
  assert.equal(result.rainfall.observationCount, 1001);
  assert.equal(result.points.at(-1).values[rainfallKey], 1);
  assert.ok(result.points[1].values[rainfallKey] > 0, 'Small intervals must not round to zero before summing');
  assert.equal(result.points[0].values[rainfallKey], 0);
  assert.equal(helpers.downsamplePoints(result.points, 2).at(-1).values[rainfallKey], 1);
  const shorter = helpers.buildRainfallSeries(station, buckets.slice(1), { hours: 24, startAt: new Date('2026-10-02T00:00:00Z'), endAt, maxPoints: 240 });
  assert.equal(shorter.rainfall.totalIn, 0.999606);
});

test('missing rainfall observations are distinct from observed dry weather, and partial history has no invented baseline', () => {
  const options = { hours: 720, startAt: new Date('2026-09-01T00:00:00Z'), endAt: new Date('2026-10-01T00:00:00Z'), maxPoints: 240 };
  const empty = helpers.buildRainfallSeries(station, [], options);
  assert.equal(empty.rainfall.totalIn, null);
  assert.deepEqual(empty.points, []);
  const dry = helpers.buildRainfallSeries(station, [{ rainMm: 0, observationCount: 30, firstObservedAt: new Date('2026-09-30T00:00:00Z'), lastObservedAt: new Date('2026-09-30T23:00:00Z') }], options);
  assert.equal(dry.rainfall.totalIn, 0);
  assert.equal(dry.points.length, 1);
  assert.equal(dry.points[0].observedAt, '2026-09-30T23:00:00.000Z');
});

test('rainfall API queries canonical observations for the selected station and excludes state samples', async (t) => {
  const service = new TelemetryService();
  service.resolveSourceSummary = async () => station;
  t.mock.method(Device, 'findById', () => ({ lean: async () => ({ properties: { tempest: { stationId: 123, primaryDeviceId: 456 } } }) }));
  const queries = [];
  t.mock.method(TempestObservation, 'aggregate', (pipeline) => ({ option: async () => { queries.push(pipeline); return []; } }));
  const result = await service.getSeries({ sourceKey: station.sourceKey, metricKeys: [rainfallKey], hours: 720, maxPoints: 60 });
  assert.deepEqual(result.metrics.map((metric) => metric.key), [rainfallKey]);
  assert.equal(result.rainfall.totalIn, null);
  assert.equal(queries.length, 1);
  assert.equal(queries[0][0].$match.stationId, 123);
  assert.equal(queries[0][0].$match.deviceId, 456);
  assert.deepEqual(queries[0][0].$match.observationType.$in, ['obs_st', 'obs_sky']);
  assert.equal(queries[0][0].$match.observedAt.$lte - queries[0][0].$match.observedAt.$gte, 720 * 3600000);
});

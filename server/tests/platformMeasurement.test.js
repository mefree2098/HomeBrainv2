const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PlatformMeasurementService, BOUNDS } = require('../services/platformMeasurementService');
const Model = require('../models/PlatformMeasurement');
const summarize = require('../services/platformMeasurementSummary');

test('HTTP accounting excludes streams and counts failed or interrupted requests once', () => {
  const service = new PlatformMeasurementService();
  for (const [type, code, finished] of [['application/json', 200, true], ['', 503, true], ['', 503, false], ['text/event-stream', 200, false]]) {
    const res = Object.assign(new EventEmitter(), { statusCode: code, writableFinished: finished, getHeader: () => type });
    service.observe({}, res, () => {});
    res.emit('close');
    res.emit('close');
  }
  assert.equal(service.counts.latency.reduce((a, b) => a + b), 3);
  assert.equal(service.counts.serverErrors, 1);
  assert.equal(service.counts.aborted, 1);
});

test('five-minute intervals retain restart gaps, counts, overflow latency and missing I/O', async () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const period = 300000;
  const row = n => ({
    recordedAt: new Date(+start + n * period), coveredMs: period, bootedAt: new Date(+start + (n - 1) * period),
    latency: BOUNDS.map((_, i) => i === 0 ? 19 : 0).concat(1), serverErrors: 1, aborted: 0,
    cpuCoresUsed: 0.5, rssBytes: 128 * 1024 ** 2, processWriteBytes: 1024 ** 2, volumeWriteBytes: null,
    health: { degraded: ['devices'], staleFeeds: ['RainMachine'], offlineDevices: 13, failedAutomations24h: 1 }
  });
  const { totals } = await summarize([row(1), row(3)], start, new Date(+start + 3 * period), BOUNDS);
  assert.equal(totals.coveragePercent, 66.667);
  assert.equal(totals.requests, 40);
  assert.equal(totals.p95MsUpperBound, 25);
  assert.equal(totals.p99MsUpperBound, '>15000');
  assert.equal(totals.failurePercent, 5);
  assert.equal(totals.meanProcessCpuCores, 0.5);
  assert.equal(totals.medianRssMiB, 128);
  assert.equal(totals.processWrites.mibPerHour, 12);
  assert.equal(totals.volumeWrites.mibPerHour, null);
  assert.equal(totals.bootTimes.length, 2);
  assert.equal(totals.degradedSamples.devices, 2);
  assert.equal(totals.peakHealthCounts.failedAutomations24h, 1);
  const empty = (await summarize([], start, new Date(+start + period), BOUNDS)).totals;
  assert.equal(empty.p95MsUpperBound, null);
  assert.equal(empty.coveragePercent, 0);
});

test('collector retries the same document IDs on a failed acknowledgment and bounds its backlog', async (t) => {
  let success = false, original, operations, indexChecks = 0;
  class Store {
    constructor(row) { return new Model(row); }
    static async createIndexes() { indexChecks++; }
    static async bulkWrite(ops) {
      operations = ops;
      if (!success) throw Error('connection lost');
    }
  }
  const service = new PlatformMeasurementService({ store: Store, io: async () => ({}), health: async () => null });
  await service.start({ loadedShortCommit: 'abc', bootedAt: new Date() });
  t.after(() => service.stop());
  await assert.rejects(service.capture(), /connection lost/);
  original = String(operations[0].updateOne.filter._id);
  success = true;
  await service.capture();
  assert.equal(String(operations[0].updateOne.filter._id), original);
  assert.equal(operations.length, 2);
  assert.equal(indexChecks, 1);
  assert.equal(service.pending.length, 0);
  success = false;
  for (let i = 0; i < 13; i++) await assert.rejects(service.capture(), /connection lost/);
  assert.equal(service.pending.length, 12);
  assert.equal(service.droppedSamples, 1);
  success = true;
  await service.capture();
  assert.equal(service.pending.length, 0);
});

const fs = require('node:fs/promises');
const { performance } = require('node:perf_hooks');
const PlatformMeasurement = require('../models/PlatformMeasurement');
const resources = require('./resourceMonitorService');
const { getOperationalHealth } = require('./operationalHealthService');

const PERIOD = 5 * 60_000;
const DAY = 86400_000;
const BOUNDS = [25, 50, 100, 250, 500, 1000, 2000, 5000, 15000];
const emptyCounts = () => ({ latency: Array(BOUNDS.length + 1).fill(0), serverErrors: 0, aborted: 0 });

function recordRequest(counts, duration, status, aborted) {
  const bin = BOUNDS.findIndex(limit => duration <= limit);
  counts.latency[bin < 0 ? BOUNDS.length : bin]++;
  if (aborted) counts.aborted++;
  else if (status >= 500) counts.serverErrors++;
}

function delta(current, previous) {
  return Number.isFinite(current) && Number.isFinite(previous) && current >= previous ? current - previous : null;
}

function parseServiceWriteCounters(text) {
  const counters = new Map();
  for (const line of text.trim().split('\n')) {
    const device = /^(\d+:\d+)\s/.exec(line);
    const written = /(?:^|\s)wbytes=(\d+)(?:\s|$)/.exec(line);
    if (device && written) counters.set(device[1], Number(written[1]));
  }
  return counters.size ? counters : null;
}

async function readServiceWrites() {
  const groups = await fs.readFile('/proc/self/cgroup', 'utf8');
  const group = /^0::(\/[^\n]+)$/m.exec(groups)?.[1];
  if (!group || group.split('/').includes('..')) return null;
  const text = await fs.readFile('/sys/fs/cgroup' + group + '/io.stat', 'utf8');
  const counters = parseServiceWriteCounters(text);
  return counters ? { group, counters } : null;
}

function serviceWriteDelta(current, previous) {
  if (!current || !previous || current.group !== previous.group) return null;
  for (const device of previous.counters.keys()) {
    if (!current.counters.has(device)) return null;
  }
  let total = 0;
  for (const [device, bytes] of current.counters) {
    const difference = delta(bytes, previous.counters.get(device) ?? 0);
    if (difference === null) return null;
    total += difference;
  }
  return total;
}

async function readWriteCounters() {
  if (process.platform !== 'linux') return {};
  const [processBytes, service, volume] = await Promise.all([
    fs.readFile('/proc/self/io', 'utf8').then(text => {
      const value = /^write_bytes:\s*(\d+)$/m.exec(text);
      return value ? Number(value[1]) : null;
    }).catch(() => null),
    readServiceWrites().catch(() => null),
    (async () => {
      const path = await resources.resolveDiskUsageTargetPath();
      const { dev } = await fs.stat(path, { bigint: true });
      const major = ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n);
      const minor = (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n);
      const device = major + ':' + minor;
      const stat = await fs.readFile('/sys/dev/block/' + device + '/stat', 'utf8');
      return { device, bytes: Number(stat.trim().split(/\s+/)[6]) * 512 };
    })().catch(() => null)
  ]);
  return { processBytes, service, volume };
}

async function readHealth() {
  const [operational, paired, broker] = await Promise.all([
    getOperationalHealth(),
    require('../models/AlexaBrokerRegistration').exists({ status: 'paired' }),
    require('../models/AlexaBrokerConfig').findOne({ isInstalled: true }).select('bindHost servicePort').lean()
  ]);
  let alexa = paired ? 'external' : 'unpaired';
  if (paired && broker) {
    const probe = await require('./alexaBrokerService').probeHealth(broker);
    alexa = probe.available ? 'healthy' : 'degraded';
  }
  const health = { ...operational, ...require('./platformDeployService').getDirectRadioHealth() };
  if (alexa === 'degraded') health.alexaBroker = { status: 'degraded' };
  return {
    alexa,
    degraded: Object.keys(health).filter(key => health[key].status !== 'healthy'),
    offlineDevices: health.devices.offlineCount,
    unenrolled: health.enrollment.affectedDevices.length,
    staleControls: health.cachedState.affectedDevices.length,
    failedAutomations24h: health.automations.failedExecutions,
    staleFeeds: health.sensorReadings.staleFeeds.map(feed => feed.name),
    failedModules: health.sensorReadings.failedModules.length
  };
}

class PlatformMeasurementService {
  constructor({ store = PlatformMeasurement, io = readWriteCounters, health = readHealth } = {}) {
    this.store = store;
    this.io = io;
    this.health = health;
    this.counts = emptyCounts();
    this.pending = [];
    this.droppedSamples = 0;
    this.lastPersistedAt = null;
  }

  observe(req, res, next) {
    const start = performance.now();
    // Server-sent events represent an open stream, not an API response time.
    res.once('close', () => {
      if (!String(res.getHeader('Content-Type') || '').startsWith('text/event-stream')) {
        recordRequest(this.counts, performance.now() - start, res.statusCode, !res.writableFinished);
      }
    });
    next();
  }

  async start(runtime) {
    if (this.started || this.stopped) return;
    this.started = true;
    this.runtime = runtime;
    this.previousIO = await this.io();
    if (this.stopped) return;
    this.lastTime = performance.now();
    this.lastCPU = process.cpuUsage();
    this.firstTimer = setTimeout(() => this.capture().catch(console.error), 15_000);
    this.firstTimer.unref();
    this.timer = setInterval(() => this.capture().catch(console.error), PERIOD);
    this.timer.unref();
  }

  capture() {
    if (!this.inFlight) {
      this.inFlight = this.takeSample().finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  async takeSample() {
    const now = performance.now();
    const recordedAt = new Date();
    const elapsed = now - this.lastTime;
    const cpu = process.cpuUsage();
    const counts = this.counts;
    this.counts = emptyCounts();
    this.lastTime = now;
    const cpuCoresUsed = ((cpu.user - this.lastCPU.user) + (cpu.system - this.lastCPU.system)) / (1000 * Math.max(1, elapsed));
    this.lastCPU = cpu;
    const mem = process.memoryUsage();
    const system = resources.getMemoryUsage();
    const [io, health] = await Promise.all([this.io(), this.health().catch(() => null)]);
    const previous = this.previousIO;
    this.previousIO = io;
    const timely = elapsed <= PERIOD * 1.5;
    const sample = new this.store({
      ...counts, recordedAt, commit: this.runtime.loadedShortCommit, bootedAt: this.runtime.bootedAt,
      coveredMs: Math.round(Math.min(elapsed, PERIOD)), cpuCoresUsed,
      rssBytes: mem.rss, heapUsedBytes: mem.heapUsed,
      availableMemoryPercent: system.total ? 100 * system.available / system.total : null,
      serviceWriteBytes: timely ? serviceWriteDelta(io.service, previous.service) : null,
      processWriteBytes: timely ? delta(io.processBytes, previous.processBytes) : null,
      volumeWriteBytes: timely && io.volume && io.volume.device === previous.volume?.device
        ? delta(io.volume.bytes, previous.volume.bytes) : null,
      health
    }).toObject();
    this.pending.push(sample);
    if (this.pending.length > 12) {
      this.pending.shift();
      this.droppedSamples++;
    }
    // Stable document IDs make retries safe even if the write succeeded but its acknowledgment was lost.
    if (!this.indexesReady) {
      await this.store.createIndexes();
      this.indexesReady = true;
    }
    await this.store.bulkWrite(this.pending.map(row => ({ updateOne: {
      filter: { _id: row._id }, update: { $setOnInsert: row }, upsert: true
    } })), { ordered: false });
    this.lastPersistedAt = recordedAt;
    this.pending.length = 0;
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.firstTimer);
    if (this.inFlight) await this.inFlight.catch(() => {});
    if (this.lastTime !== undefined && performance.now() - this.lastTime >= 1000) await this.capture();
  }

  async report(start, end = new Date()) {
    const rows = this.store.find({ recordedAt: { $gt: start, $lte: end } }).sort({ recordedAt: 1 }).lean().cursor({ batchSize: 128 });
    const summarize = require('./platformMeasurementSummary');
    return {
      ...await summarize(rows, start, end, BOUNDS), cadenceSeconds: PERIOD / 1000, retentionDays: 35,
      collector: { running: Boolean(this.timer) && !this.stopped, lastPersistedAt: this.lastPersistedAt,
        pendingSamples: this.pending.length, droppedSinceBoot: this.droppedSamples }
    };
  }
}

module.exports = new PlatformMeasurementService();
module.exports.PlatformMeasurementService = PlatformMeasurementService;
module.exports.recordRequest = recordRequest;
module.exports.BOUNDS = BOUNDS;
module.exports.DAY = DAY;
module.exports.parseServiceWriteCounters = parseServiceWriteCounters;
module.exports.serviceWriteDelta = serviceWriteDelta;

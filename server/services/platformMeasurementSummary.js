const DAY = 86400_000;
const MIB = 1024 ** 2;
const round = n => Math.round(n * 1000) / 1000;

function percentileBound(bins, bounds, count, fraction) {
  if (!count) return null;
  let rank = Math.ceil(count * fraction);
  for (let i = 0; i < bins.length; i++) {
    rank -= bins[i];
    if (rank <= 0) return bounds[i] ?? ('>' + bounds.at(-1));
  }
  return null;
}

function windowStats(start, end, bounds) {
  return {
    start, end, samples: 0, bins: Array(bounds.length + 1).fill(0), covered: 0, cpuMs: 0, cpuCoverage: 0,
    errors: 0, aborted: 0, healthChecks: 0, minMemory: null, rss: [], degraded: {}, healthMax: {}, alexaSamples: {},
    staleFeeds: new Set(), bootTimes: new Set(), commits: new Set(),
    io: { processWriteBytes: { bytes: 0, ms: 0 }, serviceWriteBytes: { bytes: 0, ms: 0 }, volumeWriteBytes: { bytes: 0, ms: 0 } }
  };
}

function addObservation(stats, row) {
  stats.samples++;
  row.latency.forEach((n, i) => { stats.bins[i] += n; });
  stats.errors += row.serverErrors;
  stats.aborted += row.aborted;
  if (row.bootedAt) stats.bootTimes.add(new Date(row.bootedAt).toISOString());
  if (row.commit) stats.commits.add(row.commit);
  if (Number.isFinite(row.rssBytes)) stats.rss.push(row.rssBytes / MIB);
  if (Number.isFinite(row.availableMemoryPercent)) {
    stats.minMemory = Math.min(stats.minMemory ?? Infinity, row.availableMemoryPercent);
  }
  if (row.health) {
    stats.healthChecks++;
    const { alexa, degraded, staleFeeds } = row.health;
    if (alexa) stats.alexaSamples[alexa] = (stats.alexaSamples[alexa] || 0) + 1;
    for (const key of degraded) stats.degraded[key] = (stats.degraded[key] || 0) + 1;
    for (const name of staleFeeds) stats.staleFeeds.add(name);
    for (const key of ['offlineDevices', 'unenrolled', 'staleControls', 'failedAutomations24h', 'failedModules']) {
      if (Number.isFinite(row.health[key])) stats.healthMax[key] = Math.max(stats.healthMax[key] || 0, row.health[key]);
    }
  }
}

function addInterval(stats, row, elapsed) {
  stats.covered += elapsed;
  if (Number.isFinite(row.cpuCoresUsed)) {
    stats.cpuMs += row.cpuCoresUsed * elapsed;
    stats.cpuCoverage += elapsed;
  }
  for (const [key, meter] of Object.entries(stats.io)) {
    if (Number.isFinite(row[key]) && row.coveredMs > 0) {
      meter.bytes += row[key] * elapsed / row.coveredMs;
      meter.ms += elapsed;
    }
  }
}

function finish(stats, bounds) {
  const { start, end, bins, rss, errors, aborted } = stats;
  rss.sort((a, b) => a - b);
  const requests = bins.reduce((a, b) => a + b, 0);
  const writes = meter => ({
    mibPerHour: meter.ms ? round(meter.bytes / MIB * 3600000 / meter.ms) : null,
    coveragePercent: round(100 * meter.ms / (end - start))
  });
  return {
    samples: stats.samples, coveragePercent: round(100 * stats.covered / (end - start)),
    requests, serverErrors: errors, aborted, failurePercent: requests ? round(100 * (errors + aborted) / requests) : null,
    p95MsUpperBound: percentileBound(bins, bounds, requests, .95),
    p99MsUpperBound: percentileBound(bins, bounds, requests, .99),
    meanProcessCpuCores: stats.cpuCoverage ? round(stats.cpuMs / stats.cpuCoverage) : null,
    medianRssMiB: rss.length ? round((rss[(rss.length - 1) >> 1] + rss[rss.length >> 1]) / 2) : null,
    minAvailableMemoryPercent: stats.minMemory === null ? null : round(stats.minMemory),
    processWrites: writes(stats.io.processWriteBytes), serviceWrites: writes(stats.io.serviceWriteBytes), volumeWrites: writes(stats.io.volumeWriteBytes),
    bootTimes: [...stats.bootTimes], commits: [...stats.commits], healthChecks: stats.healthChecks,
    alexaSamples: stats.alexaSamples, degradedSamples: stats.degraded, peakHealthCounts: stats.healthMax, staleFeeds: [...stats.staleFeeds]
  };
}

module.exports = async function summarize(rows, start, end, bounds) {
  const totals = windowStats(+start, +end, bounds);
  const daily = [];
  const firstDay = Math.floor(+start / DAY);
  for (let lower = +start; lower < +end;) {
    const upper = Math.min((Math.floor(lower / DAY) + 1) * DAY, +end);
    daily.push(windowStats(lower, upper, bounds));
    lower = upper;
  }
  let previousEnd = +start, firstSampleAt = null, lastSampleAt = null;
  // The indexed cursor is chronological. Keep only numeric RSS observations for the exact median.
  for await (const row of rows) {
    firstSampleAt ??= row.recordedAt;
    lastSampleAt = row.recordedAt;
    const time = +row.recordedAt;
    const dayOf = ms => Math.floor(ms / DAY) - firstDay;
    const from = Math.max(previousEnd, time - row.coveredMs);
    previousEnd = time;
    addObservation(totals, row);
    addObservation(daily[dayOf(time - 1)], row);
    addInterval(totals, row, time - from);
    for (let cursor = from; cursor < time;) {
      const day = daily[dayOf(cursor)];
      const until = Math.min(day.end, time);
      addInterval(day, row, until - cursor);
      cursor = until;
    }
  }
  return { start, end, firstSampleAt, lastSampleAt, totals: finish(totals, bounds),
    daily: daily.map(day => ({ start: new Date(day.start), end: new Date(day.end), ...finish(day, bounds) })) };
};

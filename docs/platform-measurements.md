# Production performance and reliability

Each HomeBrain server writes one MongoDB measurement every five minutes, plus short startup and graceful shutdown intervals. The database expires measurements after 35 days. During temporary write failures the server retains up to 12 intervals in memory and retries them with the same document IDs. Missing periods remain visible as gaps.

Admins can read `GET /api/resources/measurements?days=7` or set `since` and `until` to UTC timestamps for an exact window up to 28 days. The response contains interval totals and UTC daily summaries. Report requests, ordinary API requests, server errors and aborted responses are counted in memory. Long-lived event streams are excluded. No request paths, headers, payloads or user identifiers are recorded. The percentiles are histogram upper bounds. Coverage measures time observed inside the server. An external reachability check complements it.

CPU is expressed in cores consumed by the HomeBrain backend. RSS measures its resident memory. Linux process, service and platform-volume write rates use counter deltas over the intervals with evidence. Service writes come from cgroup v2 and include HomeBrain child processes. The Jetson kernel can expose service writes even when per-process I/O accounting is unavailable. Volume traffic includes MongoDB and other applications writing to the same volume. An unavailable counter yields null. Health samples include configured sensor feeds, reported sensor module failures, radio controllers, offline devices, IAS enrollment, stale control state, backups, integrations and the rolling 24-hour failed workflow count. Repeated samples of a rolling failure are counted once per sample in degraded-sample totals. Use execution history to count distinct incidents. Paired installations with a local Alexa broker also receive a local health probe. An unpaired installation is recorded as unpaired.

## Three-week acceptance criteria

Evaluate each home separately. Use the first seven complete days after rollout as the reference and the final seven complete days as the comparison. Use exact timestamps for the full 21 days. The short pre-release desktop probe provides a separate outside-in reference and includes connection and client startup time.

| Area | Evidence required for 9/10 |
| --- | --- |
| Performance | For each seven-day window, at least 1,000 ordinary API responses, p95 at or below 500 ms and p99 at or below 2 s. Report outside-in timings separately. |
| Stability | At least 99.5% measurement coverage across 21 days, errors plus aborted responses at or below 0.1%, no unexplained restarts and no unresolved critical failures in enabled sensors, radios or automations. Check backup recency and independent reachability. |
| Efficiency | At comparable load, final-week median RSS, mean backend CPU and platform-volume MiB/hour each at most 10% above the reference, at least 10% available host memory, and at least 99% coverage for both the service and volume write counters. Report actual increases or reductions. |

Compare requests per hour and operational workload. If traffic or other host workloads materially differ, explain the difference and leave the efficiency comparison inconclusive. Report failed thresholds as failed and missing evidence as pending. Reduced latency, CPU, memory or disk writes can be called a gain only when the corresponding comparable observations support it. The first post-release week cannot establish historic disk-write or RSS rates.

For the November 2026 release, keep Freestone’s deferred RainMachine connectivity issue visible with its dependent devices. Investigate other failures independently. Selene’s planned future Alexa pairing is outside the enabled-service criteria.

# INSTEON Service

This note documents how HomeBrain's INSTEON PLM integration works today.

It is intentionally focused on the current implementation in `server/services/insteonService.js`, especially the runtime state pipeline that was corrected on April 2, 2026.

## Main Files

- `server/services/insteonService.js`
- `server/services/insteonEngineLogService.js`
- `server/routes/insteonRoutes.js`
- `server/scripts/insteon_serial_bridge.py`
- `server/tests/insteonService.test.js`
- `server/tests/insteonEngineLogService.test.js`

## Core Rules

- The PLM is the source of truth for linked INSTEON inventory.
- Runtime command traffic is the primary source of truth for live ON/OFF state.
- `19` level queries are best-effort confirmation, not the only truth source.
- If a command-inferred ON state is applied, it must include a non-zero `brightness` and `level`.
- Background runtime poll timeouts must not mark a device offline just because `light.level()` returned no usable state.
- Device names are not authoritative. A dimmer stays on the dimmer/fader path even if its name contains `fan`.

## Connection Model

HomeBrain supports two PLM connection styles:

- Direct local serial access
- Serial-to-TCP bridging

Relevant defaults:

- Serial baud: `19200`
- Default TCP port: `9761`
- Default local bridge host: `127.0.0.1`

The runtime listeners are attached to the `home-controller` hub once the PLM connection is established. The service listens for:

- `error`
- `close`
- `command`

The `command` event is the important one for runtime device state.

## PLM Queue

All PLM work is serialized through the internal operation queue. This prevents overlapping PLM work from stepping on each other.

Priority order:

- `control` / `high` = `0`
- `confirm` = `1`
- `query` / `normal` = `2`
- `poll` / `low` = `3`
- `maintenance` = `4`

Practical meaning:

- Explicit user commands beat confirmations.
- Confirmations beat ad hoc queries.
- Runtime polling is deliberately low priority.
- Maintenance work such as link-table reads is lowest priority.

If a higher-priority PLM operation is queued, background runtime polling defers.

## Runtime State Architecture

There are two distinct live-state paths:

1. Runtime command path
2. Background runtime polling path

The runtime command path is more important.

### 1. Runtime Command Path

Inbound PLM traffic arrives through `hub.on('command')` and is handled by `_handleRuntimeCommand()`.

The flow is:

1. Parse the raw command with `_parseRuntimeCommand()`
2. Classify message type and semantic command
3. Derive any immediately observable state
4. Persist command-inferred state immediately when appropriate
5. Queue responder refreshes for linked scene members
6. Queue a best-effort verification refresh

Important message classes:

- Direct command
- Direct ACK
- All-link cleanup
- All-link cleanup ACK
- All-link broadcast

Important stateful commands:

- `11` = on
- `12` = fast on
- `13` = off
- `14` = fast off
- `15` / `16` / `17` / `18` are dimmer-related commands and are treated as stateful runtime traffic, but they do not inherently provide a trustworthy final level
- `19` ACK is authoritative because command 2 carries the current on-level

### Immediate Persistence Rule

For actionable runtime commands, HomeBrain now persists a command-inferred fallback state immediately.

Examples:

- A direct `11` to a dimmer target immediately persists ON with non-zero brightness/level
- A cleanup `11` for a responder immediately persists ON on the cleanup target
- Linked responders discovered from scene/controller link data also get immediate inferred state

This is the behavior that fixed the stale dimmer UI issue.

### Why Immediate Persistence Is Required

In the live PLM environment, `home-controller` can resolve `light.level()` with `null` when the follow-up standard response never lands in `status.response.standard`.

That failure mode looks like this:

- `PLM command callback received: querying level for ...`
- `PLM level query returned no usable state for ...`
- `rawResult: null`

That means:

- the PLM callback fired
- the status query did not produce a usable standard response
- waiting for `19` level confirmation alone will leave the UI stale

Because of that, runtime command traffic must update the device immediately, and verification queries must be treated as best-effort confirmation only.

### Runtime Refresh Follow-Up

After immediate state persistence, HomeBrain still schedules `_scheduleRuntimeStateRefresh()`.

That refresh:

- waits a short delay before querying
- tries `_confirmDeviceStateByAddress()`
- persists confirmed state if the query succeeds
- falls back to the already-inferred command state if verification times out

Default timing:

- runtime refresh delay: `450ms`
- runtime refresh timeout: `1800ms`

### Linked Scene Responders

When controller scene traffic is observed:

- HomeBrain resolves linked responders from link tables
- applies command-inferred fallback state to those responders immediately
- also schedules best-effort refreshes for them

This matters for:

- all-link scene broadcasts
- cleanup-group traffic when the original broadcast is missed by monitor mode

If a regression causes only the directly addressed responder to move and not the other linked scene members, the scene-responder refresh path is the first place to inspect.

## Background Runtime Polling

Background runtime polling exists to keep tracked devices reasonably fresh when there has been no recent runtime traffic.

Important defaults:

- monitor interval: `30000ms`
- stale-after window: `60000ms`
- offline stale-after window for already-offline devices: `15000ms`
- configured batch size: `4`
- dynamic max batch size: `50`
- poll timeout: `2500ms`
- pause between poll queries: `50ms`

Background polling is intentionally secondary to command traffic.

### Critical Polling Rule

If `_queryDeviceLevelByAddress()` throws `INSTEON_LEVEL_TIMEOUT` because the PLM returned no usable state, `_pollTrackedDeviceStates()` must not mark the device offline.

Reason:

- the live system can produce broad `rawResult:null` level-query failures across many healthy devices
- marking those devices offline poisons the UI and hides the fact that the real problem is level-query reliability

Background polling still logs the failure, but it no longer treats that specific timeout as proof that the device is offline.

## Explicit Status Queries

Explicit status operations such as `getDeviceStatus()` still use `_queryDeviceLevelByAddress()` and expect a usable answer.

That is different from background runtime polling:

- explicit status queries are diagnostic/user-requested
- background poll failures are not authoritative for online/offline state

If you need a stricter status read for troubleshooting, use the explicit status path, not the assumptions from runtime polling.

## Command Execution

`turnOn()`, `turnOff()`, and `setBrightness()` are built around:

- queued PLM control execution
- immediate optimistic persistence only after a real device response
- configurable verification mode
- optional timeout recovery only when explicitly requested

Default command settings:

- command attempts: `1` for normal direct control
- retry pause: `0ms` for normal direct control
- command timeout: `1500ms`
- default verification mode: `ack`
- post-command settle window: `700ms`
- full ON / OFF defaults to fast direct opcodes when the device supports them:
  `12` for full ON, `14` for OFF
- partial brightness changes still use standard/ramped direct commands:
  `11` with a level byte

Important distinction:

- A bare PLM serial ACK is not treated as a successful device command.
- Direct ON/OFF now requires a target-device response, not just modem acceptance.
- If logs show `acknowledged:true` but `success:false` and `hasResponse:false`, HomeBrain now fails the command as `target device did not respond after PLM ACK`.
- Before failing a modem-acknowledged direct ON/OFF, HomeBrain now pre-registers a matching runtime
  `direct_ack` waiter and keeps it open for up to `30000ms` by default. This covers real delayed device ACKs
  that arrive during the command window or after the `home-controller` callback has already timed out.
- While that late-ACK window is open, HomeBrain also suppresses background runtime polling for the same PLM so
  the modem is not immediately reused for status queries while a delayed device acknowledgement may still be
  inbound.

### Verification Modes

HomeBrain supports two broad patterns:

- synchronous verification
- acknowledgment-first / async verification

`fast` mode currently means:

- `2` attempts
- `1200ms` per verification read
- `100ms` pause between reads
- `700ms` initial settle delay
- `1` matching read required

Async/ack-style modes skip synchronous verification and instead queue a runtime refresh after the command is acknowledged.

### Control Defaults Vs. Explicit Overrides

Normal UI/device control is intentionally conservative now:

- one direct command attempt
- no automatic retry loop
- no automatic state-recovery loop after timeout
- ack-first verification by default
- binary ON/OFF prefers fast direct commands by default unless explicitly disabled

Workflows or debug paths can still opt into:

- multiple command attempts
- synchronous stable verification
- timeout recovery after command failure

Those are explicit per-call choices now, not the default behavior.

### Optimistic State

After a successful `turnOn()` or `turnOff()` command, the service immediately persists an optimistic state before verification.

That optimistic state must include:

- `status`
- `brightness`
- `level`
- `isOnline`
- `lastSeen`

This avoids stale UI even when the follow-up status query is inconclusive.

If the command only reaches modem-acknowledged / no-device-response state, HomeBrain does not persist optimistic success anymore.

## PLM Maintenance Controls

HomeBrain now exposes explicit PLM maintenance actions for the cases where the USB PLM transport gets wedged and admins need a clean software-side reset without restarting the whole backend.

API routes:

- `POST /api/insteon/maintenance/cancel-active`
- `POST /api/insteon/maintenance/clear-queue`
- `POST /api/insteon/maintenance/runtime-monitoring/stop`
- `POST /api/insteon/maintenance/runtime-monitoring/start`
- `POST /api/insteon/maintenance/soft-reset`

What each one does:

- `cancel-active`: asks `home-controller` to cancel the in-progress PLM command if possible
- `clear-queue`: drops queued PLM work and clears pending runtime refresh timers
- `runtime-monitoring/stop`: pauses background runtime polling
- `runtime-monitoring/start`: resumes background runtime polling
- `soft-reset`: clears HomeBrain's local PLM queues/caches, disconnects the PLM transport, reconnects it, and resumes runtime polling if it was already running

Important limitation:

- These are HomeBrain-side software maintenance actions.
- They do not power-cycle the physical USB PLM hardware.
- If a true hardware power cycle is needed, that still has to happen outside HomeBrain.

## PLM Sync and Device Rows

`syncDevicesFromPLM()` is the authoritative import/sync path for PLM-linked INSTEON devices.

It does all of the following:

- connects to the PLM if needed
- reads PLM metadata
- reads the PLM link database
- normalizes linked device addresses
- upserts database rows by INSTEON address
- dedupes duplicate HomeBrain rows for the same physical INSTEON address
- returns a summary including `deduped`

Current expected summary shape:

- linked device count
- created count
- updated count
- duplicate rows removed
- failed count

### Duplicate Rows

INSTEON addresses are unique on the wire. Duplicate rows are a HomeBrain database problem, not an INSTEON protocol problem.

Current rule:

- PLM sync is allowed to reconcile and delete duplicate HomeBrain rows for the same INSTEON address

Runtime state persistence still applies updates by address to every matching row as a safety net, but the intended steady state is one HomeBrain row per physical INSTEON address.

## Monitoring and Logging

The engine log stream is useful for understanding exactly which path updated or failed to update state.

Important log families:

- queue logs
- command logs
- runtime command logs
- runtime poll logs
- runtime state refresh logs

### Healthy Runtime Sequence

For a normal dimmer event, you should expect something like:

1. `Inbound runtime command ...`
2. immediate runtime-state persistence for the target or linked responders
3. optional queued linked responder refresh logs
4. optional `Runtime state refresh (...) observed ON/OFF ...`

### Known Failure Signature

If you see:

- `PLM command callback received: querying level for ...`
- `PLM level query returned no usable state for ...`
- `rawResult: null`

that means the status query path did not obtain a usable standard response. Do not immediately assume:

- bad scene parsing
- duplicate rows
- device offline

The first question should be:

- did runtime command traffic already infer and persist the correct state?

## Regression Checklist

If INSTEON live state regresses again, check these invariants in order:

1. Runtime command traffic is still reaching `_handleRuntimeCommand()`
2. Direct/cleanup/scene paths still persist command-inferred fallback state immediately
3. ON fallback patches still include non-zero `brightness` and `level`
4. Linked responder refresh logic still handles scene broadcasts and cleanup-group recovery
5. Runtime poll `INSTEON_LEVEL_TIMEOUT` still does not mark devices offline
6. PLM sync still dedupes HomeBrain rows by INSTEON address

If runtime state looks stale in the UI but queue/poll logs are active, do not start by changing poll intervals. First inspect whether the runtime command path is still persisting inferred state before verification.

## Tests To Keep Green

These tests cover the most important behavior:

- `server/tests/insteonService.test.js`
  - runtime command parsing
  - immediate responder persistence
  - scene-linked responder refreshes
  - cleanup-group responder recovery
  - fallback state application on verification timeout
  - runtime poll timeout not marking devices offline
  - PLM sync duplicate-row cleanup
- `server/tests/insteonEngineLogService.test.js`
  - runtime command logging

If any of those tests fail after future refactors, treat that as a serious warning that live INSTEON state may regress.

## Practical Summary

The short version is:

- commands and inbound runtime traffic drive live dimmer state
- polling confirms when possible
- `null` level reads are not authoritative truth
- PLM sync owns linked-device inventory cleanup

That ordering is deliberate, and changing it is likely to reintroduce the stale-state regression.

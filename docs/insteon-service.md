# INSTEON Service

This note documents how HomeBrain's INSTEON PLM integration works today.

It is intentionally focused on the current implementation in `server/services/insteonService.js`, especially the runtime state pipeline and managed device-group broadcast support that were corrected on April 2-3, 2026.

## Main Files

- `server/services/insteonService.js`
- `server/services/insteonEngineLogService.js`
- `server/services/workflowExecutionService.js`
- `server/services/deviceGroupService.js`
- `server/routes/insteonRoutes.js`
- `server/scripts/insteon_serial_bridge.py`
- `server/models/DeviceGroup.js`
- `server/tests/insteonService.test.js`
- `server/tests/insteonEngineLogService.test.js`

## Core Rules

- The PLM is the source of truth for linked INSTEON inventory.
- Runtime command traffic is the primary source of truth for live ON/OFF state.
- `19` level queries are best-effort confirmation, not the only truth source.
- If a command-inferred ON state is applied, it must include a non-zero `brightness` and `level`.
- Background runtime poll timeouts must not mark a device offline just because `light.level()` returned no usable state.
- Device names are not authoritative. A dimmer stays on the dimmer/fader path even if its name contains `fan`.
- A HomeBrain device group is not automatically an INSTEON group. Simultaneous all-device broadcast only exists after a real PLM ALL-Link group has been created and synchronized for that HomeBrain group.

## Stabilization Findings

This section captures the concrete findings from the April 2-3, 2026 stabilization work that made HomeBrain's
INSTEON behavior match the reliability expectations set by the ISY.

### What Turned Out To Be Wrong

The final working behavior did not come from one fix. It came from removing several HomeBrain-specific failure
paths that were stacking together:

1. HomeBrain was treating bare PLM acceptance as almost-good-enough command success even when the actual device had
   not replied yet.
2. Real delayed device acknowledgements were arriving after the `home-controller` callback window, but HomeBrain was
   declaring failure before those runtime ACKs arrived.
3. After a delayed runtime ACK finally showed up, HomeBrain was still sending redundant `19` verification reads that
   often returned `rawResult:null`.
4. Background runtime polling was continuing to hammer the PLM with failing `19` reads even when batches were clearly
   producing no usable state.
5. Manual switch traffic aimed at the PLM was initially being resolved onto the PLM target instead of the real source
   switch row.
6. Manual switch traffic that arrived as group `1` all-link broadcast / cleanup scene messages was being treated like
   linked-scene discovery work instead of a local-load state change.
7. Cleanup traffic could drive follow-up state refreshes against the PLM address instead of the source/controller
   device.
8. Duplicate HomeBrain rows for the same INSTEON address could make state persistence look inconsistent even when the
   runtime event handling was correct.
9. HomeBrain device groups were originally just database metadata, not real PLM ALL-Link groups, so large group ON/OFF
   actions were still falling back to per-device control instead of one protocol-level broadcast.

### What Was Not The Root Cause

Several things looked suspicious in the logs but were not the root cause by themselves:

- `rawResult:null` on a `19` level query does not prove the device is offline.
- A PLM callback with `acknowledged:true` does not prove the target device accepted the command.
- Missing UI updates do not automatically mean the PLM failed to receive unsolicited traffic.
- Repeated runtime poll failures do not automatically mean scene parsing is broken.

The raw transport tracing added on April 2, 2026 proved that unsolicited manual-switch packets were reaching
HomeBrain. The bug was then narrowed to how HomeBrain classified and applied those packets after parse.

### What Actually Fixed Command Reliability

Command control became reliable after these rules were enforced together:

- Full binary ON / OFF prefers fast direct opcodes by default:
  `12` for full ON and `14` for OFF.
- A bare PLM ACK is not accepted as device success.
- Direct ON / OFF requires either:
  - a usable device response in the command callback, or
  - a matching delayed runtime `direct_ack`
- The delayed runtime `direct_ack` waiter is registered before dispatch and kept open for up to `30000ms`.
- If that delayed runtime ACK arrives, HomeBrain treats it as the terminal success instead of immediately issuing
  another `19` verification query.
- While that delayed-ACK window is open, background runtime polling is suppressed so the PLM is not reused for noisy
  status reads during the period when a real device ACK may still be inbound.
- Normal UI control defaults to one low-level command attempt with no implicit recovery loop. Retries remain an
  explicit opt-in for workflow/debug cases.

### What Actually Fixed Large Group ON / OFF

ISY-style simultaneous group control required a different correction than single-device reliability.

The important finding was:

- a HomeBrain device group name by itself is only application metadata
- an actual INSTEON simultaneous group command requires a real PLM controller group plus responder links in the PLM
  ALL-Link database

HomeBrain now handles that by managing PLM-backed groups for eligible device groups:

- Binary `turn_on` / `turn_off` on an eligible HomeBrain device group now uses a managed PLM ALL-Link group.
- The managed PLM group number is lazily allocated from `2..255`.
- Group `1` is intentionally not used for managed HomeBrain groups because HomeBrain now treats group `1`
  all-link traffic as local-load/manual-switch traffic from the originating device.
- Before broadcasting, HomeBrain reconciles the PLM scene membership so the HomeBrain device group and the PLM
  responder list match.
- After sync, HomeBrain sends one PLM all-link command for the whole group instead of walking each member one by one.
- Full binary ON / OFF prefers the fast broadcast variants when the transport supports them.
- If the group is not fully eligible, HomeBrain falls back to the existing per-device control path instead of forcing
  partial or unsafe PLM-group behavior.

This matches the INSTEON developer-guide model:

- an ALL-Link Group is a controller plus one-or-more responders
- lighting responders can execute group-wide ON / OFF / fast ON / fast OFF alias commands
- a controller group broadcast is the protocol-level way to make many responders move at the same time

### What Actually Fixed Manual Status Updates

Manual switch updates became reliable after these runtime-path rules were enforced together:

- HomeBrain listens to both `command` and `recvCommand`.
- Lower-level runtime transport tracing confirmed whether a raw `0250` / `0251` frame reached HomeBrain before
  dispatcher parsing.
- Direct manual commands aimed at the PLM are applied to the source device, not the PLM target.
- Group `1` all-link broadcast / cleanup traffic is treated as a local-load state change for the source switch.
- Those group `1` local-load events do not queue scene-link lookup work.
- Those group `1` local-load events do not queue PLM self-refreshes such as `querying level for 71.B6.78`.
- Cleanup traffic that is not a local-load case refreshes the controller/source device when the cleanup target is not
  an actual HomeBrain device row.

### Polling Findings

Background polling is useful, but it is deliberately not the primary live-state mechanism.

Important findings:

- Runtime command traffic is the first-class live-state path.
- `19` level polling is only best-effort confirmation.
- Repeated `INSTEON_LEVEL_TIMEOUT` / `rawResult:null` poll batches should trigger polling backoff, not more PLM spam.
- Poll failures must not mark devices offline when no usable level state was returned.
- If manual/runtime command traffic is already applying correct inferred state, poll tuning is not the first thing to
  change.

### Scene And Local-Load Findings

The trickiest part of the stabilization work was separating true scene-responder refresh behavior from local-load
traffic that only looked scene-shaped on the wire.

Current rule:

- Group `1` scene traffic from a known source switch is treated as local-load state for that source device first.

That means HomeBrain only falls back to scene-responder refresh logic when the event is actually about linked scene
members, not when it is the originating local switch press for the controller itself.

### Diagnostic Order That Worked

When a regression appeared, this order was the most effective way to narrow it:

1. Confirm whether raw inbound PLM traffic reached HomeBrain at all.
2. Confirm whether the runtime command envelope parsed into `Inbound runtime command ...`.
3. Confirm whether HomeBrain persisted immediate command-inferred state for the correct device row.
4. Confirm that HomeBrain did not immediately sabotage itself with redundant `19` reads, runtime polling, or scene-link
   lookups.
5. Only after that, inspect link topology or higher-level scene membership assumptions.

That diagnostic order mattered because several earlier-looking failures were actually downstream symptoms of a correct
packet arriving and then being handled incorrectly inside HomeBrain.

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
- `recvCommand`

`recvCommand` is important because `home-controller` emits it for every inbound standard message, while `command` is only emitted when the packet is not being matched as a response to an in-flight command.

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
- If that delayed runtime `direct_ack` arrives, HomeBrain now treats it as the terminal ON/OFF confirmation
  instead of immediately following it with another PLM `19` status read.
- While that late-ACK window is open, HomeBrain also suppresses background runtime polling for the same PLM so
  the modem is not immediately reused for status queries while a delayed device acknowledgement may still be
  inbound.
- Manual switch presses that arrive as direct runtime commands aimed at the PLM now resolve to the source device,
  so HomeBrain updates the actual switch row instead of treating the PLM target as the changed device.
- Manual switch presses that arrive as group `1` all-link broadcast / cleanup scene traffic are now treated as
  local-load state changes for the source device. HomeBrain updates the source switch immediately and skips the
  old scene-link lookup / PLM self-refresh path that could otherwise queue `runtime_scene_link_lookup` work and
  bogus `state_confirm` reads against the PLM address.
- If a whole runtime-poll batch comes back as nothing but `INSTEON_LEVEL_TIMEOUT` / `rawResult:null`, HomeBrain
  now backs runtime polling off for a while instead of continuing to hammer the PLM with more useless `19` reads.
- If direct control works but physical/manual updates never appear as `Inbound runtime command ...` logs, inspect the
  HomeBrain PLM link topology before blaming the device network. A missing device-to-PLM controller link will allow
  direct control to work while preventing unsolicited manual updates from ever reaching HomeBrain.

## Managed Device-Group Broadcasts

HomeBrain now has two distinct ways to control a user-defined device group:

1. Managed INSTEON PLM all-link broadcast
2. Per-device fallback control

### When Managed PLM Group Broadcast Is Used

`tryControlDeviceGroup()` will only use a managed PLM all-link broadcast when all of these are true:

- the requested action is binary `turn_on` or `turn_off`
- any requested ON level is effectively `100%`
- the group has at least two unique INSTEON members
- every member has a valid INSTEON address
- every member is linked to the current HomeBrain PLM

If any of those conditions fail, HomeBrain keeps the previous behavior and executes the device group with normal
per-device control so existing automations do not break.

### How Managed PLM Groups Are Created

HomeBrain device groups are still the user-facing grouping concept, but they can now be backed by a real managed PLM
group when the group is eligible for INSTEON broadcast.

The sync flow is:

1. Load the HomeBrain `DeviceGroup` record.
2. Normalize the current INSTEON member set for that HomeBrain group.
3. Allocate a PLM group number if one has not already been assigned.
4. Read the PLM controller links for that group.
5. Remove stale responders that are no longer members of the HomeBrain group.
6. Reapply the desired responder set to the PLM group.
7. Persist the HomeBrain-side metadata used to track that managed PLM group.

Persisted metadata:

- `insteonPlmGroup`
- `insteonMemberSignature`
- `insteonLastSyncedAt`

### Broadcast Commands Used

Once the managed PLM group is synchronized, HomeBrain issues one group command through the PLM:

- `sceneOn()` or `sceneOnFast()` for group ON
- `sceneOff()` or `sceneOffFast()` for group OFF

In `home-controller`, these methods wrap the PLM's ALL-Link command path. That is the key difference from the older
HomeBrain behavior where a "device group" action was just many individual direct commands happening in software.

### Safety Rules

The managed PLM group path was intentionally built to preserve working behavior instead of replacing it blindly.

Safety rules:

- HomeBrain only uses the broadcast path for fully eligible INSTEON groups.
- Mixed groups continue to use the old per-device path.
- Partial-dimmer level requests continue to use the old per-device path.
- A failure while synchronizing or broadcasting a managed PLM group causes HomeBrain to fall back to normal
  per-device execution instead of failing the whole group action immediately.

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
The exception is when a real runtime device acknowledgement already confirmed the command; in that case HomeBrain
trusts the device ACK and does not enqueue a redundant `19` verification query.

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
- `POST /api/insteon/maintenance/runtime-links/audit`
- `POST /api/insteon/maintenance/soft-reset`

What each one does:

- `cancel-active`: asks `home-controller` to cancel the in-progress PLM command if possible
- `clear-queue`: drops queued PLM work and clears pending runtime refresh timers
- `runtime-monitoring/stop`: pauses background runtime polling
- `runtime-monitoring/start`: resumes background runtime polling
- `runtime-links/audit`: checks whether the current PLM has both responder and controller links needed for unsolicited runtime updates from the specified devices
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

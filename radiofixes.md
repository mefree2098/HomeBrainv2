# Radio Stack Logic Audit & Fixes — June 10, 2026

Investigation into Zigbee door/window sensors (Back Door, Front Door, Garage Entry — SNZB-04PR2;
plus the MCT-340 E sensors) randomly reporting **open** and tripping the security alarm, followed
by claims that "the Zigbee network is not working."

**Bottom line: the Zigbee radio network was never broken.** The coordinator is started
(`lastStartResult: "resumed"`), all 10 devices are paired, and live messages are flowing.
Both problems were software logic flaws in HomeBrain's direct-radio stack.

---

## Finding 1 (root cause of the false "open" alarms): cached IAS `zoneStatus` was replayed as live state

**File:** `server/services/directRadioHelpers.js` → `readZigbeeEndpointSensorAttributes()`

Every time a Zigbee device record was normalized — at **server startup sync**, on **re-interview**,
on **deviceJoined/deviceAnnounce**, and on **any unrelated radio message** (battery report,
poll-control check-in, temperature report) — the code read the `ssIasZone.zoneStatus` attribute
from zigbee-herdsman's **endpoint attribute cache** and converted its alarm bits into
`contactOpen / contact: 'open'`, which then flowed into the top-level `device.status` and from
there into the security alarm evaluation.

The problem: zigbee-herdsman **persists that attribute cache in `database.db`**. The cached
`zoneStatus` is a stale snapshot — often the value captured while the door happened to be open, or
captured during enrollment. It survives restarts indefinitely. So a door that was last *cached*
as open would be re-reported as "open" out of nowhere whenever the server restarted, a
re-interview ran, or the sensor sent a battery report — with the alarm armed, that set it off.

**Proof from production** (engine log, server boot at 14:34:44 on 2026-06-10):

```
14:34:55  Zigbee device state normalized  reason: "sync"  ieeeAddr: 0xa4c13812d1d4ffff (Back Door)
          liveZoneStatus: null   observedStatus: true   ← "open" from cache, no radio traffic
14:35:29  Zigbee device state normalized  reason: "reinterview"  same device
          liveZoneStatus: null   observedStatus: true   ← cached "open" re-applied again
```

The coordinator had not heard from that sensor since 00:15 — the device was asleep. There was no
radio evidence of an open door; the "open" came purely from the persisted cache.

**Fix:** `readZigbeeEndpointSensorAttributes()` no longer applies `zoneStatus` from the attribute
cache, ever. IAS alarm state (contact / motion / water / tamper / battery-low bits) can now only
come from:

1. a **live IAS message** (zone status change notification or attribute report), or
2. a **live endpoint read** (`readZigbeeLiveSensorState`, used during sleepy-sensor check-ins).

Cached environment telemetry (battery %, temperature, humidity, power metering, etc.) is still
read from the cache — it is harmless and useful. Because updates without live zone evidence no
longer contain any contact keys, the device's previously stored (live-derived) state is preserved
untouched across restarts, re-interviews, and unrelated messages.

## Finding 2 (root cause of the "Zigbee network not working" misdiagnosis): zigbee-herdsman v10 removed `Device.interviewCompleted`

**Files:** `server/services/directRadioCore.js`, `server/services/directRadioZigbee.js`

The project depends on `zigbee-herdsman ^10.0.7`, which replaced the boolean
`Device.interviewCompleted` with `Device.interviewState`
(`'PENDING' | 'IN_PROGRESS' | 'SUCCESSFUL' | 'FAILED'`). HomeBrain still read the old property,
which is now always `undefined`:

- `getStatus()` reported `interviewCompleted: (undefined === true) → false` for **every paired
  Zigbee device**, making a perfectly healthy network look like nothing was interviewed/working.
  This is what fed the "the Zigbee network itself is broken" conclusion.
- `normalizeZigbeeDevice()` used `interviewCompleted !== false` (always true), silently masking
  genuinely failed interviews.

**Fix:** added `getZigbeeInterviewState()` / `isZigbeeInterviewSuccessful()` /
`isZigbeeInterviewUsable()` helpers in `directRadioHelpers.js` that understand both the new
`interviewState` API and the legacy boolean. The status API now reports the real
`interviewState` alongside an accurate `interviewCompleted`. Runtime availability treats only a
known-`FAILED` interview as degraded (sleepy sensors legitimately sit at `PENDING` while working).

## Finding 3: the "Unverified" guard masked the symptom and created new noise

**File:** `server/services/securityAlarmService.js`

The earlier remediation attempt (commits `05694f49`, `8c56837c`) didn't remove the cache poisoning
at the source — it added `isUnverifiedDirectZigbeeSensorState()`, which marked any Zigbee security
sensor whose last update reason was `sync` / `refresh` / `reinterview` / `deviceAnnounce` /
non-IAS `message` as **"Unverified"** with `requiresAttention: true`.

Consequence: after **every server restart** (which always runs `sync`), every door/window sensor
showed up as Unverified/needs-attention until someone physically opened and closed the door. That
made the security dashboard look like the whole Zigbee network was down — it wasn't.

**Fix:** removed the Unverified layer entirely. With Finding 1 fixed, the stored sensor state can
only ever be last-known **live** state, so the security summary trusts it directly again
(`isActive = Boolean(device.status)`), exactly like the months when this all worked fine.

## Finding 4: live zone reads were excluded from alarm evaluation on some paths

**File:** `server/services/directRadioCore.js` → `hasLiveZigbeeSecuritySensorEvidence()`

The hardened alarm gate (commit `8cf7a014`, kept as good defense-in-depth) only accepted live
evidence for `message` and `deviceAnnounce` reasons. A *successful live read* of `zoneStatus`
during `refresh`, `deviceInterview`, or `reinterview` — genuine radio evidence — was discarded,
so a real "door open" observed during one of those paths would not have been evaluated for the
alarm.

**Fix:** a stamped `lastLiveZoneStatus` (only ever set from a live IAS report or a successful live
endpoint read) now counts as live evidence regardless of the update reason. The gate still blocks
cache-only updates (sync, reinterview without a live read, unrelated clusters) from alarm
evaluation — defense-in-depth on top of Finding 1's fix.

---

## Finding 5 (follow-up, June 10 afternoon): Zigbee RF reception dead — OTBR/Thread radio brought up next to the coordinator

After the Finding 1–4 fixes deployed, physically opening the Back Door, Front Door, and Garage
Entry produced **no events at all**. Investigation showed:

- The coordinator process/serial link is healthy (ZNP handshake works, `lastStartResult: "resumed"`),
  but **zero radio frames were received from any device after 06:51 UTC** — including from
  always-powered routers. Live ZDO probes (re-interview) of the range extender, the smart plug,
  and a smart light all timed out ("can not get active endpoints"). The radio went deaf, not the
  devices.
- Timeline: `otbr-agent` (OpenThread Border Router) was installed/enabled during the morning's
  platform work and became **active at 06:06 UTC** as Thread **leader** on the SONOFF MG24 stick —
  plugged in next to the Zigbee coordinator. The last Zigbee reception was 06:51 UTC, ~45 minutes
  later, during a window with **no deploys or restarts** (06:47→14:04). A continuously
  transmitting 802.15.4 radio centimeters from the CC2652P coordinator (Thread MLE advertisements,
  multi-channel announces; Thread dataset shows channel 23) desensitizes or wedges the
  coordinator's receiver.
- This is the *real* "Zigbee network not working" condition — it post-dates the false-open bug
  and was introduced by the OTBR rollout, not by anything on the Zigbee mesh itself.

**Fixes shipped for diagnosis/remediation:**

- `GET /api/direct-radios/status` now reports the live Zigbee network parameters
  (channel / panID / extendedPanID) so channel overlap with Thread is visible.
- `POST /api/matter/thread/otbr/stop` (confirmation phrase `STOP THREAD BORDER ROUTER`) stops and
  disables `otbr-agent`; the privileged helper gained a matching `stop` action.
- `POST /api/direct-radios/restart` restarts the direct-radio runtime in place (Zigbee controller
  stop → chip reset → start) without redeploying.

**Operational guidance:** keep `otbr-agent` stopped until the Thread stick is physically separated
from the Zigbee coordinator (USB extension cable, different hub) and the Thread channel is planned
away from the Zigbee channel; then re-enable via the OTBR start flow.

## Z-Wave, Thread/Matter, INSTEON review

- **Z-Wave** (`directRadioZwave.js`): no equivalent flaw. State comes from the zwave-js `valueDB`,
  which is authoritative and only changes when a node actually reports. `directRadioState` for
  sensors carries only battery data; contact/lock state comes from current values. The alarm gate
  for Z-Wave (`reason === 'node value updated'`) matches the real event name emitted by the
  driver. One pre-existing, correctly-reported condition: node 23 (Aeotec DSD37 range extender)
  shows an incomplete interview — cosmetic, not security-related.
- **Thread/Matter** (`matterService.js`): contact state is read from `booleanState.stateValue`
  via live subscription reports; no persisted-cache replay path exists.
- **INSTEON** (`insteonService.js`): the only caches are a runtime scene-responder cache with a
  TTL, unrelated to sensor state. No IAS-style cached alarm state.

## What was deployed

| Change | File(s) |
| --- | --- |
| Never derive IAS alarm state from the persisted attribute cache | `server/services/directRadioHelpers.js` |
| Support herdsman v10 `interviewState`, report accurate interview health | `server/services/directRadioHelpers.js`, `directRadioCore.js`, `directRadioZigbee.js` |
| Remove the "Unverified" sensor layer | `server/services/securityAlarmService.js` |
| Accept live zone reads as alarm evidence on all update paths | `server/services/directRadioCore.js` |
| Tests updated to enshrine the new contract (cached zoneStatus must never set contact state) | `server/tests/directRadioMigrationVerification.test.js`, `server/tests/securityAlarmService.test.js` |

### Note on the stuck "Back Door: open" record

The production DB had Back Door stuck at `contact: open` from the cached replay at 14:35. After
this deploy, stale state can no longer be re-created; the record was corrected and the next real
open/close event re-confirms it live. (The IAS zone-status bit mapping — alarm1|alarm2 → active —
was left as-is; it matches the live reports these sensors send and was not the source of the
false opens.)

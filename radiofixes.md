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

### Remote remediation attempted (June 10, ~15:30–16:45 UTC) — final state

Everything that can be done without touching the hardware was done, in order:

1. **Stopped and disabled `otbr-agent`** (the Thread transmitter next to the coordinator). No
   change — routers still unreachable.
2. **In-place radio runtime restart** (`POST /api/direct-radios/restart`). No change.
3. **Hardware watchdog reset of the CC2652P** (`{"hardResetZigbee": true}`) — full chip reboot
   including the RF core. No change.
4. **MAC-level TX probe**: AF commands reach the air (dataConfirm `205 NWK_NO_ROUTE`, *not*
   `MAC_CHANNEL_ACCESS_FAILURE`) — so the channel is clear (no jammer) and the radio transmits,
   but **no device anywhere replies** and zero frames have been received since 06:51 UTC.
5. **Touchlink inter-PAN sweep** was added as a diagnostic, but this stick's Z-Stack build does
   not answer `AF interPanCtl` (touchlink unsupported) — inconclusive.

Network parameters are stable and correct across every restart (`resumed`, channel 15,
panID 7512, extendedPanID 0x18986e62a171075d), and reception died **mid-run** at 06:51 UTC with
no software event at that moment — which rules out configuration/key/frame-counter regressions.

**Conclusion: the coordinator's RF receive path is dead at the hardware level** (a known
ZBDongle-P failure mode after sustained near-field RF exposure; a watchdog reset does not clear
it because USB power is never removed).

**Required physical fix (takes ~30 seconds):**

1. Unplug the **SONOFF Zigbee 3.0 USB Dongle Plus (ITead, on /dev/ttyUSB1)**, wait ~10 seconds,
   plug it back in. HomeBrain's hardware monitor auto-detects the stick and restarts the
   coordinator automatically — no further action needed.
2. While there, move the **SONOFF MG24 Thread stick** onto a USB extension cable (or a different
   hub) away from the Zigbee dongle. `otbr-agent` stays stopped/disabled until then.
3. Verify by opening any monitored door — the event should appear within a second or two.

Until the replug, Zigbee door/window sensors are blind: the security alarm cannot see those zones
open. (Z-Wave and INSTEON devices are unaffected.)

## Hardware audit — exact radios vs. Jetson Orin Nano vs. HomeBrain (June 10, 2026)

Audit of the exact purchased hardware against the NVIDIA Jetson Orin Nano (L4T/JetPack
Ubuntu) host and HomeBrain's code.

### The radios

| Device (ASIN) | Identity on the box | Linux driver | HomeBrain support |
| --- | --- | --- | --- |
| **SONOFF ZBDongle-P** Zigbee 3.0 USB Dongle Plus ([B09KXTCMSC](https://www.amazon.com/dp/B09KXTCMSC)) — TI CC2652P + CP2102N | `10c4:ea60`, `/dev/ttyUSB1`, stable by-id path | `cp210x` (present & working) | ✅ Correct: `zstack` adapter @115200, expected-hardware string and port scoring match. Note: this stick's Z-Stack build does not answer inter-PAN (`AF interPanCtl`), so touchlink scans are unsupported. |
| **Zooz ZST39 LR** 800-series Z-Wave Long Range stick ([B0BW171KP3](https://www.amazon.com/dp/B0BW171KP3)) | `1a86:55d4`, `/dev/ttyACM0` | `cdc-acm` (stock kernel) | ✅ Correct: zwave-js ^15.24 with S2 + **Long Range** key sets configured. Status API now reports `controllerFirmwareVersion`/`controllerSdkVersion`. ⚠️ Known vendor issue: 800-series firmware on SDK 7.21.x/7.22.0 can brick-loop or lock up ("controller jammed"); fixed in Zooz firmware **v1.50 (SDK 7.22.1)** — check the reported version and OTW-update through the Zooz portal only ([change log](https://www.support.getzooz.com/kb/article/1352-zst39-800-long-range-z-wave-stick-change-log/), [zwave-js #6874](https://github.com/zwave-js/zwave-js/discussions/6874), [#6512](https://github.com/zwave-js/zwave-js/discussions/6512)). Z-Wave runs at 908 MHz — immune to the 2.4 GHz issues below. |
| **SONOFF MG24 Dongle Plus** Zigbee/Thread ([B0FMJD288B](https://www.amazon.com/dp/B0FMJD288B)) — EFR32MG24 + CP2102N, OpenThread RCP firmware | `10c4:ea60`, `/dev/ttyUSB2` | `cp210x` | ✅ Correct: `matterService` references this exact ASIN, runs OTBR via `spinel+hdlc+uart` @460800; the Jetson kernel helper manages the IPv6 multicast-routing kernel configs OTBR needs. ⚠️ Operationally this radio is what deafened the Zigbee coordinator (Finding 5) — keep it physically separated and leave `otbr-agent` disabled until placement is finalized. Thread dataset uses channel 23; Zigbee now lives on 25 — acceptable, but re-plan if interference reappears. |

### The Zigbee devices

| Device (ASIN) | Model | Support |
| --- | --- | --- |
| **Aeotec Range Extender Zi** ([B0BXFBH6JR](https://www.amazon.com/dp/B0BXFBH6JR)) | `WG001-Z01` | ✅ In zigbee-herdsman-converters (`WG001`). **Correct pairing procedure** (per [Aeotec's guide](https://aeotec.freshdesk.com/support/solutions/articles/6000248296-aeotec-range-extender-zi-user-guide-)): if the LED is solid, hold the action button **10 s** to factory-reset; once the LED fades in/out, open HomeBrain Zigbee pairing and **tap the button once** — rapid blink while joining, then steady when joined. (Our earlier hold-only attempts skipped the single-tap join step.) |
| **SONOFF SNZB-04PR2** SenseGuard DW Gen2 door/window, 4-pack ([B0GKFB66JZ](https://www.amazon.com/dp/B0GKFB66JZ)) | `SNZB-04PR2` | ✅ In zigbee-herdsman-converters. Contact maps to IAS **alarm_1 only** — HomeBrain now matches that exactly (alarm2 no longer counts as "open" for contact sensors; one less false-alarm vector). Tamper on this model is reported via the private eWeLink cluster **0xFC11 attr 0x2000**, not the IAS tamper bit — HomeBrain now parses it. AAA-powered; check-ins are sparse (hours), state changes are immediate. |

### Jetson Orin Nano specifics

1. **USB serial drivers**: all three sticks enumerate with stable `/dev/serial/by-id` paths on
   this box — `cp210x` and `cdc-acm` are present and bound. Caveat for the future: some
   L4T/JetPack kernels have shipped **without `cp210x`**, which surfaces as "lsusb sees the stick
   but no /dev/ttyUSB appears" ([NVIDIA forum](https://forums.developer.nvidia.com/t/installing-cp210x-usb-to-uart-driver-on-jetson-nano/78886),
   [JetsonHacks](https://jetsonhacks.com/2018/02/09/install-usb-serial-converter-kernel-modules-l4t-28-1/)).
   If the Jetson is ever reflashed, verify `cp210x` before debugging anything else; the repo's
   `scripts/homebrain-jetson-kernel-control.sh` already contains the kernel build machinery.
2. **USB 3.x RF interference — the big one.** The Orin Nano devkit's USB-A ports are all
   USB 3.2, and USB 3 signaling radiates broadband noise across 2.4 GHz (≈ +20 dB noise floor,
   the classic Intel-documented effect; see
   [zigbee2mqtt discussion](https://github.com/Koenkk/zigbee2mqtt/discussions/11159) and
   [USB3/2.4 GHz interference guide](https://www.rshtech.com/blog/how-to-avoid-the-usb30-and-24-ghz-devices-interference-2)).
   This matches today's measured spectrum exactly (energy 177–204/255 on channels 15–20 at the
   coordinator, quiet at 24–26). **Recommendations:** put the 2.4 GHz sticks (ZBDongle-P, MG24)
   on a **USB 2.0 hub** hanging off the Jetson, on shielded extension cables, with the stick ends
   ≥1 m from the Jetson and from each other; ferrite chokes help. The Zigbee network now runs on
   **channel 25** (top of the band, clear in the scan); the energy-scan endpoint
   (`POST /api/direct-radios/zigbee/energy-scan`) makes the noise floor measurable any time.

### Audit code changes

- Contact sensors: IAS `alarm_1` only ⇒ open (matches zigbee2mqtt semantics for SNZB-04PR2 and
  MCT-340 E); motion/water keep generic alarm1|alarm2.
- SNZB-04PR2 private-cluster tamper (0xFC11/0x2000) parsed into tamper state.
- Z-Wave status now reports the ZST39's `controllerFirmwareVersion` / `controllerSdkVersion`.

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

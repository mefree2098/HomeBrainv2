# HomeBrain — Native Zigbee/Z-Wave Engine Overhaul & Follow-ups

**Author:** Claude (Anthropic) working with Matt Freestone
**Date:** 2026-05-30
**Scope:** Reliability overhaul of the native Zigbee/Z-Wave engine, supporting UI on web + iOS, structural decomposition, the post-deploy regression fixes, the Z-Wave siren on/off fix, and the INSTEON "re-link all devices" feature.

> **Status:** Everything below is merged to `main` and pushed. It has **not** yet been
> validated on the physical Jetson + radios — deploy and hardware testing are still required.

---

## 0. TL;DR

The native radio engine (`server/services/directRadioService.js`) is built on the right
libraries — **`zigbee-herdsman`** (Zigbee2MQTT's core), **`zwave-js`** (Home Assistant's
Z-Wave engine). The failures you were hitting were **integration and data-model bugs, not
protocol bugs**, so this was a targeted overhaul, not a rewrite.

Delivered across five pull requests, all merged to `main`:

| PR | Merge commit | What |
|----|--------------|------|
| **#223** | `32fe6e4e` | Phases 0–5: reliability fixes, decomposition, web + iOS UI, DB indexes |
| **#224** | `6fba7508` | Auto-recover from stale code-split chunks after deploy (the "loading error" screen) |
| **#225** | `cde20e94` | Recovery fix: un-hide migrated devices + restore INSTEON (revert serialport to v8) |
| **#226** | `bc890771` | Z-Wave siren on/off fix: detect the trigger from interviewed CCs + add Basic CC |
| **#227** | `d73f4c2f` | INSTEON "Re-link all devices": rebuild the emptied PLM all-link database |

Base before this work: `c8a587c7` ("Fix iOS security action refresh").

---

## 1. Hardware context

- **Zigbee coordinator:** SONOFF ZBDongle-**P** (TI CC2652P) → herdsman `adapter: 'zstack'` (correct in code).
- **Z-Wave controller:** Zooz **ZST39** 800-series Long Range USB stick (`zwave-js`).
- **Thread/Matter:** SONOFF MG24 (EFR32MG24).
- Runs on an NVIDIA Jetson; radio state lives under `server/data/direct-radios/`.

---

## 2. Repository housekeeping (done first)

- Collapsed all work onto `main` and deleted every other branch (local **and** remote),
  removed 8 stray git worktrees, and confirmed `main` is the single source of truth.
- During the overhaul, work was staged on short-lived branches and merged via PR
  (because `main` is protected: PR + 9 required status checks). After each merge the
  branch was deleted and the repo returned to **only `main`**.

---

## 3. Root-cause diagnosis (what was actually wrong)

Investigated with parallel research/diagnosis agents + the installed library source. The
four reported symptoms mapped to concrete causes:

| Symptom | Root cause |
|---|---|
| Contact sensors "regressed to SmartThings" | Migration changed a device's `source` to `homebrain-*` but **left `properties.smartThingsDeviceId` in place**, so the SmartThings full-sync/webhook re-matched it and overwrote `source` back to `smartthings` (or deleted the native row as a "duplicate"). |
| Migration flow "never worked" | Inclusion was gated on `migration.exclusionVerifiedAt`, which depended on a SmartThings **cloud-API exclusion that cannot actually drive Z-Wave exclusion** — so the flow stalled forever at the exclusion step. |
| Siren wouldn't sound | The siren was only triggered via **Binary Switch CC**; a Sound-Switch-only siren threw "no support" on turn-on. |
| Contact sensors silently stop reporting / won't pair | No explicit **IAS Zone** enrollment/repair path; sleepy sensors whose interview didn't complete never report, and there was no Zigbee re-interview action (only Z-Wave had one). |
| General flakiness / silent loss | Every radio event handler was fire-and-forget with **no error boundary** (a thrown error silently dropped the update); `ensureControllerConfig` could **regenerate a random Zigbee network key**, which would unpair every device. |

---

## 4. The overhaul — Phases 0–5 (PR #223)

### Phase 0 — Safety net & observability
*Defensive/observability only; no behavior change to pairing/control.*

- **0a — Error boundaries.** Added `dispatchHandler()`; every Zigbee/Z-Wave event listener
  (`deviceJoined`, `deviceInterview`, `message`, `node added/ready/value updated`, node sync)
  now routes through it, catching sync throws **and** async rejections and logging them
  instead of silently dropping the device update (or crashing via unhandled rejection).
- **0b — Network-reset detection.** After `controller.start()`, a `lastStartResult === 'reset'`
  (herdsman re-formed the network and removed all devices) now emits a **CRITICAL** log and
  sets a `zigbee.networkReset` flag.
- **0c — Anti-wipe guard.** `ensureControllerConfig()` no longer mints a random Zigbee network
  key when the saved config is missing. It **recovers the real credentials from
  `coordinator-backup.json`**, and if a prior network exists but is unrecoverable it
  **refuses to start Zigbee** (rather than forming a brand-new network and unpairing
  everything). Pure helpers added: `parseHexBytes`, `isCompleteZigbeeNetwork`,
  `deriveZigbeeNetworkFromBackup`, plus `recoverZigbeeNetworkFromBackup` /
  `detectExistingZigbeeNetwork`; `startZigbee` aborts on the reset-risk condition.
- **0d — Backups.** Verified the radio state dir is already captured by the existing
  `server/data` backup target — no change needed.
- Tests: `directRadioErrorBoundary`, `directRadioNetworkConfig`.

### Phase 1 — Stop devices regressing to SmartThings
- `severMigratedSmartThingsIdentity()` — on migration, relocates `smartThingsDeviceId` under
  `smartThingsMigration` and **removes the top-level hook** (applied in `completeMigration`
  and `finalizeDeviceMigration`).
- `repairMigratedSmartThingsIdentities()` — idempotent startup repair that heals
  already-regressed devices.
- `forceSmartThingsSync` (maintenanceService) — **skips re-importing** migrated-away ST
  devices and **never overwrites/deletes** a `homebrain-*` sourced device.
- `smartThingsWebhookService` — excludes migrated/native devices from the tracked-device query.
- `Device` model — added identity/source indexes.
- Tests: `smartThingsRegressionGuard`; updated the `maintenanceService` dedup test.

> ⚠️ This phase later caused a regression (see §8) that was fixed in PR #225.

### Phase 2 — Native Z-Wave exclusion + unblock the migration deadlock
*Opt-in; default behavior unchanged.*

- `startExclusion({ useNativeExclusion })` — run a real **Z-Wave general exclusion** on
  HomeBrain's own Zooz controller (works on a device still "owned" by SmartThings) instead of
  the impossible cloud-API exclusion.
- `startMigration({ exclusionConfirmed })` — proceed to native inclusion after a manual/native
  exclusion, bypassing the unreliable verification gate (clearer 409 + `ZWAVE_EXCLUSION_NOT_VERIFIED`).
- Routes thread `useNativeExclusion` / `exclusionConfirmed` from the request body.
- Tests: `directRadioExclusionGate`.

### Phase 3 — Contact-sensor / IAS Zone reliability
- `reinterviewZigbeeDevice(ieeeAddr)` — forces a full herdsman `device.interview(true)`, which
  **re-runs IAS Zone enrollment** (CIE write + enroll response) so a contact/motion sensor
  reports open/closed again. Wake-the-sensor guidance on failure for sleepy devices.
- `readZigbeeIasEnrollment(device)` — best-effort enrollment status (zoneState, CIE vs coordinator).
- New route: **`POST /api/direct-radios/zigbee/devices/:ieeeAddr/reinterview`**.
- Tests: `directRadioZigbeeReinterview`.

### Phase 4 — Siren reliability (pair + sound)
- `controlZWaveSiren(node, on)` — triggers a siren via **Binary Switch → Sound Switch tone
  play (`toneId` 255 = play / 0 = stop) → Multilevel Switch → Basic**, choosing the trigger
  from the node's **interviewed command classes** (`getDefinedValueIDs()`), with a try-each
  fallback and a clear error only if none are supported. Siren on/off routes through it.
- Tightened the `alarm` feature: a Sound-Switch device is alarm-capable only when it exposes
  `toneId` (volume alone can't sound it).
- **Sound & volume** are catalog-driven (`setsirensound` / `setsirenvolume` →
  `setZWaveSirenSound` / `setZWaveSirenVolume`): config parameters whose labels match
  `sound`/`tone` and `volume` are written as partial parameters (bitmask preserved). Verified
  against the zwave-js device DB that the Aeotec **ZW080 Gen5** maps correctly — Sound 1–5 on
  param `37[0xff00]` and Low/Medium/High volume on `37[0xff]`.
- Note: siren pairing already uses the secure `default` inclusion strategy (S2/S0 negotiated)
  via `shouldUseSecureZWaveMigration` — no change needed there.
- Tests: `directRadioSirenTrigger` (incl. freshly-included, Basic-only/ZW080, and fallback cases).

> ⚠️ The original Phase 4 cut later caused a regression (see §8, item 3) that this update fixes.

### Phase 5a — serialport bump (⚠️ later REVERTED)
- Bumped `serialport` ^8.0.8 → ^13 and made consumers version-agnostic.
- **This broke INSTEON** (see §8) and was **reverted to `^8.0.8` in PR #225.** Current
  dependency: **`serialport ^8.0.8`**. (Zigbee/Z-Wave were never affected — `zwave-js` and
  `zigbee-herdsman` bundle their own serialport v13.) The version-agnostic consumer shims remain.

### Phase 5b — Decompose the monolith
- The 8,088-line `directRadioService.js` was split via an **`acorn` AST codemod**
  (exact-offset extraction, so strings/regex/template literals are byte-identical). The 132
  instance methods became 6 prototype mixins composed with `Object.assign`, and the 161
  module-level helpers moved to a helpers module.

**Resulting module layout (`server/services/`):**

| File | Lines | Contents |
|---|---|---|
| `directRadioService.js` | 291 | requires + constructor + `Object.assign` of mixins + exports |
| `directRadioCore.js` | 937 | lifecycle/start/status/serial detection |
| `directRadioZwave.js` | 1,486 | Z-Wave inclusion/exclusion/control/siren |
| `directRadioMigration.js` | 1,908 | SmartThings migration + sever/repair |
| `directRadioZigbee.js` | 854 | Zigbee join/interview/normalize/reinterview |
| `directRadioPairing.js` | 726 | pairing windows |
| `directRadioLocks.js` | 626 | Z-Wave lock codes |
| `directRadioHelpers.js` | 2,966 | all module-level pure helpers + constants |
| `directRadio/serialPorts.js` | 287 | serial-port discovery + adapter scoring |
| `directRadio/conversions.js` | 118 | battery/color/temperature conversions |

---

## 5. Client (web + iOS) UI work — PR #223

All three features were wired on **both** web (`client/src/components/devices/DeviceDetailsDialog.tsx`,
`client/src/api/directRadios.ts`) and iOS (`HomeBrainApp/.../Features/DevicesView.swift`).

- **Re-interview / repair button** — in the device detail view for Zigbee devices; calls the
  Phase 3 endpoint and reports the result (incl. IAS enrollment status).
- **Phase 2 exclusion escape hatches** — a "Stuck on exclusion?" section in the migration flow
  with **"Exclude with HomeBrain radio"** (`useNativeExclusion`) and **"I already excluded it —
  open pairing"** (`exclusionConfirmed`).
- **IAS enrollment status** — persisted on the device during sync
  (`properties.homebrainDirect.iasZone`) and shown next to the re-interview button:
  *"Not enrolled — won't report until re-interviewed"* vs *"Enrolled — reporting open/closed."*

Verification: web `eslint` clean + `vite build` passes; iOS `swiftc -parse` clean (full Xcode
build still requires the project + SDK, i.e. needs to be built on your Mac).

---

## 6. Database indexes (item "C") — PR #223

Added **partial-unique** indexes (built guarded in `server/models/init.js`, `try/catch` so a
pre-existing duplicate can't crash startup) on the two genuinely-global identity fields:
`properties.smartThingsDeviceId` and `properties.homebrainDirect.ieeeAddr`
(`partialFilterExpression: { $type: 'string' }`).

Deliberately **not** made unique: `smartThingsMigration.smartThingsDeviceId` (intentionally
shared by a retired-source tombstone and its migrated device) and `homebrainDirect.nodeId`
(only unique per controller, reassigned on re-pair). Tests: `deviceIdentityIndexes`.

---

## 7. Stale code-split chunk auto-recovery — PR #224

After a deploy, an already-open browser tab fails to lazy-load route chunks whose
content-hashed names changed ("Failed to fetch dynamically imported module" → the
"Route Recovery / loading error" screen). Added a `vite:preloadError` handler in
`client/src/main.tsx` that **reloads once** to pick up the fresh build, with a 10-second
timestamp guard against reload loops. Takes effect once deployed; future deploys self-recover.

---

## 8. Regressions I introduced — and fixed (honest record)

Three bugs from this work reached you. **No device data was ever lost** in any case. Items 1–2
were fixed in **PR #225 (`cde20e94`)**; item 3 is fixed in the follow-up siren change.

1. **All migrated devices disappeared from the device list.**
   - *Cause:* `severMigratedSmartThingsIdentity` (Phase 1) set `smartThingsMigration.retiredSource: true`
     on the **live native device**, and the startup repair applied it to every migrated device.
     The device list filters out `retiredSource` records (`deviceService` `RETIRED_SMARTTHINGS_MIGRATION_SOURCE_QUERY`),
     so all migrated Zigbee/Z-Wave devices were **hidden** (not deleted). The Z-Wave controller
     still showed because it was never a migration.
   - *Fix:* `sever` no longer sets `retiredSource` and now **clears** any wrongly-set
     `retiredSource`/`finalized_source` on a native record; the repair query was broadened to
     find and **un-hide** already-flagged `homebrain-*` devices; and the retired-source filter
     now always keeps `homebrain-*` (native) devices visible. The sync/webhook guards still work —
     they key on the `homebrain-*` *source*, not this flag.

2. **INSTEON broke (`"path" is not defined`).**
   - *Cause:* the Phase 5a `serialport` v8→v13 bump broke `home-controller`'s positional
     `new SerialPort(path, …)` constructor (v13 expects an options object).
   - *Fix:* reverted the top-level `serialport` dependency to **`^8.0.8`**. Zigbee/Z-Wave are
     unaffected (bundled v13). This was a non-essential change I flagged as risky and should not
     have shipped without hardware to validate it on.

3. **Z-Wave siren on/off stopped working (Aeotec ZW080 Gen5).**
   - *Symptom:* web showed *"This Z-Wave siren does not expose a supported trigger…"*; on iOS the
     device detail sheet vanished (the error alert popped over the sheet, dismissing it). On/off
     used to work on this siren before the overhaul.
   - *Cause:* the Phase 4 `controlZWaveSiren` gated each trigger on `hasZWaveValue()`, which tests
     whether a value is **currently cached**, not whether the device **supports** the command
     class. A freshly-included siren has not cached a `targetValue` yet, so every check returned
     false and it threw — even though the ZW080 supports Binary Switch (which the old blind
     `setValue` had used successfully).
   - *Fix:* detect the trigger from the node's **interviewed command classes**
     (`getDefinedValueIDs()`) instead of cached values, add **Basic CC** for simple/legacy sirens,
     and add a try-each fallback for an incomplete interview. Verified by tests modelling a
     freshly-included device (nothing cached). The vanishing iOS sheet is a downstream effect of
     the server error and is resolved once on/off succeeds.

---

## 9. New / changed API surface

- `POST /api/direct-radios/zigbee/devices/:ieeeAddr/reinterview` — re-interview a Zigbee device.
- `POST /api/direct-radios/exclusion/start` — now accepts `useNativeExclusion: true`.
- `POST /api/direct-radios/migrations` — now accepts `exclusionConfirmed: true`.
- Device records gained `properties.homebrainDirect.iasZone` (Zigbee enrollment status).

---

## 10. Tests added (Node built-in test runner)

`directRadioErrorBoundary`, `directRadioNetworkConfig`, `smartThingsRegressionGuard`,
`directRadioExclusionGate`, `directRadioZigbeeReinterview`, `directRadioSirenTrigger`,
`deviceIdentityIndexes`. Full server suite at last run: **718 pass / 0 fail** (the lone
`insteonService.test.js` cancellation is a pre-existing sandbox hang that needs serial/network,
unchanged by this work).

---

## 11. How to deploy & recover

1. **Run a FULL deploy** of `main` to the Jetson (the one that runs dependency install + build),
   **not** the "fast pull/build/restart" mode — the INSTEON/serialport fix is a dependency
   downgrade and only applies if `npm install` runs.
2. On startup you should see:
   - **Zigbee + Z-Wave devices reappear** (the repair un-hides them; no re-pairing).
   - **INSTEON reconnects** (serialport back on v8; ~77 devices).
3. To recover a silent contact sensor: wake it, then use the **Re-interview / Repair** button
   (or `POST …/reinterview`).
4. To migrate a Z-Wave device when the SmartThings exclusion stalls: use **"Exclude with
   HomeBrain radio"** or **"I already excluded it — open pairing"** in the migration flow.

---

## 12. Known limitations & follow-ups

**Needs your hardware/environment (cannot be done remotely):**
- Deploy + physically validate pairing, exclusion, siren, and contact-sensor reporting on the Jetson.
- Confirm the Zigbee stick is the ZBDongle-**P** (`zstack`, as configured) vs -E (`ember`).
- Validate the wall-panel serial transport under the current serialport version.

**Deliberate engineering choices left open:**
- `directRadioHelpers.js` (~2,960 lines) is one module; splitting it further risks circular
  `require`s, so it was left whole. Can be layered later.
- Cosmetic: the Z-Wave **controller node** (ZST39 LR) shows in the device list as a "sensor"
  with 0% battery. Harmless; can be filtered out of the device list on request.

**Verification gauntlet (done where possible):**
- `security-review` skill: no findings. `code-review` skill: 2 findings, both fixed.
- `npm audit` (server, prod): 0 vulnerabilities. Web lint + build clean. iOS `swiftc -parse` clean.

---

## 13. INSTEON control — diagnosis & "Re-link all devices"

After the serialport revert restored the PLM connection, INSTEON commands still didn't
turn devices on (the app reported success). A guided, on-device diagnosis isolated it:

- **serialport is fine.** `serialport@8.0.8` loads on the Jetson's Node 22 and HomeBrain
  read `PLM ID 71B678 / firmware 9e` over native serial — full bidirectional I/O. `main`'s
  INSTEON code + serialport version are **identical to the last-known-working baseline**
  (only one equivalent `SerialPort`-assignment line differs), so there was no code regression.
- **Root cause: the PLM's all-link database is empty.** A raw `Get First All-Link Record`
  (`0269`) returned a NAK (`15`) — confirmed, not a read bug. Modern **i2cs** devices reject
  direct commands from a PLM that isn't in their database, so they never act and never ACK;
  the empty callback was then misreported as success (the `:10840` footgun). The PLM was not
  reset/replaced by the user, and HomeBrain has no "Reset IM" code — the links were simply lost.

**Fix — bulk re-link feature** (rebuilds the PLM ↔ device links for all tracked devices):
- `server/services/insteonService.js`: `relinkAllTrackedDevices(request, {onProgress, shouldCancel})`
  iterates every tracked INSTEON device and calls the proven `_linkDeviceRemote` (responder +
  controller links, by address, with retries); `startRelinkRun` wraps it as an async, pollable
  run reusing the existing run infrastructure; `_normalizeRelinkRunRequest` validates input.
  Reports per-device `linked` / `responder-only` / `failed`.
- Routes: `POST /api/insteon/maintenance/relink/start`, `GET …/relink/runs/:runId`,
  `POST …/relink/runs/:runId/cancel`.
- Web (`Settings → INSTEON`): "Re-link All Devices" + "Cancel Re-link" buttons and a live
  progress/log panel.
- iOS (`SettingsView`): "Re-link All Devices to PLM" action button + explainer.
- Tests: `insteonRelink.test.js` (9 cases — iteration, de-dup, retries, responder-only,
  manual mode, cancellation, empty-set, summary accounting).

> Remote (no-touch) linking works for most i2cs devices; a few battery/sleeping devices may
> report `failed` and need a manual set-button tap. Still requires hardware validation.

**Still a known footgun (follow-up):** `insteonService.js:10840` treats an `undefined`
command callback as success, so a non-responding device can show as "on." Worth hardening so
control reports "device did not respond" — deferred (it's pre-existing baseline behavior and
changing success semantics needs care across all callers).

---

## 14. Commit reference (on `main`)

```
d73f4c2f  feat: INSTEON "Re-link all devices" — rebuild empty PLM all-link database (#227)
bc890771  fix: restore Z-Wave siren on/off by detecting trigger from interviewed CCs (#226)
cde20e94  fix: un-hide migrated devices + restore INSTEON (revert serialport to v8) (#225)
6fba7508  client: auto-recover from stale code-split chunks after deploy (#224)
32fe6e4e  Native Zigbee/Z-Wave engine reliability overhaul (Phases 0–5) (#223)
c8a587c7  Fix iOS security action refresh        <-- base before this work
```

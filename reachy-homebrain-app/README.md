---
title: HomeBrain for Reachy Mini Wireless
description: Secure voice, motion, perception, and managed-update bridge between Reachy Mini Wireless and HomeBrain.
tags:
  - reachy_mini
  - reachy_mini_python_app
---

# HomeBrain for Reachy Mini Wireless

`reachy-homebrain-app` turns a Reachy Mini Wireless into a managed HomeBrain endpoint. The
app runs on the Wireless model's CM4 under the official Reachy Mini app daemon, uses the
auto-detected daemon-owned local camera/audio backend, and maintains one authenticated WebSocket to
HomeBrain. It does not expose an additional web server.

## What the companion implements

- Authenticated voice-device WebSocket with reconnect, heartbeat, status, state, and
  capability reports.
- Local wake-word detection using checksum-verified HomeBrain assets. OpenWakeWord is an
  optional dependency; health reports `unavailable` instead of silently claiming support.
- Reachy microphone audio converted to 16 kHz mono PCM16 with a bounded pre-roll buffer.
- HomeBrain TTS downloaded with the robot device token and played through Reachy's public
  media API. Stop commands invalidate queued or in-flight TTS.
- Allowlisted semantic robot commands: wake, sleep, neutral, stop, look, antennas, body
  yaw, motor mode, emotions, deterministic gestures, face tracking, volume, snapshot, and
  app release. Values are clamped and command IDs are idempotent.
- Camera snapshots captured as transient SDK JPEGs and uploaded directly to HomeBrain
  (maximum 2 MiB). No snapshot is retained locally.
- Debounced presence detection using one low-weight tracker owner. A shared coordinator
  arbitrates presence, configured default tracking, and explicit face tracking.
- Immutable source-only companion updates with content-addressed releases, one-shot boot,
  correlated confirmation, automatic fallback, and durable last-known-good state.

## Security and privacy defaults

Configuration is stored at `~/.config/homebrain-reachy/config.json`. The directory is mode
`0700` and the file is mode `0600`. A registration code or claim token is exchanged once at
`POST /api/reachy-mini/activate`; only the resulting device ID/token are retained. Activation,
package, model, TTS, and snapshot requests reject redirects where credentials or payloads
could be forwarded.

The app also reads Reachy's opaque 16-hex-character hardware ID only from the official
loopback daemon endpoint (`GET /api/daemon/hardware-id`). Activation and every authenticated
session bind to that `unitId`. A stored ID mismatch fails closed, preventing a copied config
and device token from silently controlling a different robot.

Status reports also sample the official loopback `GET /api/daemon/status` endpoint without
redirects. Only bounded `daemonVersion`, `wireless`, `simulation`, and `state` fields leave
the robot; local names, IP addresses, daemon errors, and the duplicate hardware ID do not.

Microphone, wake word, camera, snapshots, presence, speech direction, and face tracking are
fail-closed until authenticated HomeBrain settings arrive. Turning the microphone off stops
capture and clears pre-roll. Turning the camera off clears every integration-owned tracker.
Snapshots are rejected before `get_frame_jpeg()` unless both `cameraEnabled` and
`snapshotEnabled` are true. Explicit face tracking requires `cameraEnabled`; stop always
remains available. A physical privacy-disable error latches a reported `privacyFault`, clears
all software capture gates, disconnects without acknowledging the failed config, and rejects
every operation except stop until a later physical OFF retry succeeds.

## Install on Reachy Mini Wireless

Prerequisites:

- Reachy Mini SDK/app runtime 1.9.x.
- The official shared app interpreter at `/venvs/apps_venv/bin/python3` (the default).
- A reachable HTTPS HomeBrain URL and one temporary registration or claim credential.

From a checked-out release on Reachy:

```bash
./install.sh \
  --hub-url https://homebrain.example.com \
  --device-id YOUR_DEVICE_ID \
  --claim-token YOUR_ONE_TIME_CLAIM
```

For registration-code onboarding, use `--registration-code` instead of `--claim-token`.
The script is noninteractive and idempotent. It installs the base app first, then attempts
the optional `wakeword` extra; a wake-word dependency failure is reported without removing
the working base integration. Credentials are never printed. Use `./install.sh --help` for
developer `--python`/`--venv`, insecure-development, and update-only options.

The managed app entry-point key is exactly `reachy-homebrain-app`. Start and stop it with the
official Reachy Mini app manager. For a local configuration check that does not contact the
robot:

```bash
/venvs/apps_venv/bin/homebrain-reachy --check-config
```

## Configuration

See `config.example.json`. Required fields are `hub_url` and either a persisted
`device_id`/`device_token` pair or one short-lived bootstrap credential. Plain HTTP/WS is
rejected unless `allow_insecure_http` is explicitly enabled for a trusted development LAN.
`unit_id` is discovered from the loopback Reachy daemon and persisted automatically; do not
copy or hand-edit it.

HomeBrain sends saved robot settings on every authentication and later changes through
`robot_config_update`. The companion applies microphone/camera gates immediately, applies
speaker and microphone volume locally, honors the telemetry interval, stores the configured
default emotion/vision mode, and enables or disables idle wobbling.

## Wire protocol

The app connects to `/ws/voice-device?deviceId=<id>` and authenticates with its device token.
Canonical robot commands use a nested version-1 envelope:

```json
{
  "type": "robot_command",
  "protocolVersion": 1,
  "command": {
    "id": "command-id",
    "action": "look",
    "parameters": { "direction": "left", "durationMs": 400 },
    "issuedAt": "2026-07-17T12:00:00Z",
    "ttlMs": 5000
  }
}
```

The result has one terminal status (`completed`, `failed`, `cancelled`, or `rejected`). Motion
events are `motion_completed`, `motion_failed`, or `motion_stopped`; non-motion commands do
not emit misleading motion events. Voice and presence events use unprefixed snake case.

A local wake detection does not itself authorize room-audio upload. HomeBrain returns a
short-lived unguessable `captureGrantId` in `wake_word_ack`; the companion uses that exact
value as the audio `sessionId`, echoes it on the start frame, and consumes it once. Missing,
mismatched, replayed, expired, cancelled, or cross-connection grants cannot start capture.

Emergency stop is dispatched independently of long operations. Every HomeBrain motion uses
the official daemon task API (`/api/move/*`), retains its UUID, and is cancelled through
`POST /api/move/stop`; the app waits for daemon confirmation before reporting stop success.
It also calls Reachy's `cancel_move()` for uploaded SDK moves and public
`media.stop_playing()`, cancels queued motions from an older generation, and prevents
downloaded/queued TTS from beginning afterward. Any WebSocket/event failure after a daemon
motion is admitted triggers exact-UUID cancellation; an unconfirmed cancellation preserves
the UUID for another emergency-stop attempt.

## Managed source updates and recovery

The stable launcher is installed through the official app environment. HomeBrain-delivered
updates are source-only and must declare exact compatibility with launcher API 1 and the
stable dependency and launcher-file fingerprints. The launcher fingerprint is derived from
the actual installed stable-file inventory—including the package initializer Python executes
before entry-point selection—so those files cannot be source-updated. Runtime
updates cannot add Python dependencies; such a release reports
`manual_reinstall_required` and must be installed while the app is stopped.

1. `package_stage` downloads an authenticated manifest and every allowlisted file, rejects
   redirects, verifies file size/SHA-256 and the aggregate digest, and commits an immutable
   release under `~/.local/share/homebrain-reachy/releases/<aggregate-sha256>`.
2. Staging records the request but does not change active or pending boot state.
3. `prepare_update` must repeat the same request ID, version, and digest. It durably records a
   pending but not-yet-launchable release, quiesces the robot off the WebSocket event loop,
   and acknowledges only after the configured physical safe policy completes.
4. A separate correlated `release` repeats the prepared identity. The launcher durably marks
   it launchable, acknowledges release, and only then exits for the daemon restart. An abort
   sends exact, idempotent `rollback`/disarm; an expired unreleased prepare is garbage-collected.
5. The launcher marks the attempt before importing any new source, isolates the package
   import path to that release, and re-verifies its complete inventory and owner-only modes.
6. After HomeBrain observes the expected authenticated version/digest, it sends the exact
   correlated `confirm_update`. Only then is the release promoted. Confirmation is
   idempotent so a lost acknowledgement can be retried.
7. A second launch before confirmation automatically abandons pending and returns to the
   last-known-good release (or bundled runtime). `rollback` also clears pending or swaps to
   the previous confirmed release. The verified install receipt represents the bundled
   runtime explicitly, so even the first external update can roll back to the bundle.

Release state changes and commits use an exclusive lock, fsync, and same-filesystem atomic
rename. Stages may reside on another filesystem because they are copied and verified inside
the release filesystem before the final rename. Extra files, symlinks, unsafe modes, altered
files, and incomplete manifests are rejected at every launch.

Every package/status report includes bounded durable reconciliation receipts: the latest
confirmed identity, latest authorized identity and current `launchReady` truth, latest staged
identity, and at most 64 staged request identities. HomeBrain can therefore reconcile lost
stage, release, or confirmation acknowledgements after either side restarts.

## Development and verification

```bash
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -e '.[test]'
.venv/bin/ruff format --check src tests
.venv/bin/ruff check src tests
.venv/bin/pytest --cov=reachy_homebrain --cov-branch
.venv/bin/python -m build
.venv/bin/reachy-mini-app-assistant check .
```

The unit suite uses SDK-shaped fakes for audio, TTS, camera, tracking, motion cancellation,
update crashes, corruption, concurrency, and import isolation. Hardware acceptance testing
still requires the physical Reachy Mini Wireless: verify microphone channel layout, acoustic
wake thresholds, camera latency, movement limits, speaker volume, and safe stop behavior in
clear space before unattended use.

## Troubleshooting

- **App cannot start:** verify the SDK is 1.9.x, the official app environment exists, and
  `homebrain-reachy --check-config` succeeds.
- **Authentication fails:** reissue onboarding in HomeBrain and rerun `install.sh` with the
  new one-time credential. Never place a device token on the command line.
- **Wake word unavailable:** inspect the reported wake-detector health. Reinstall the
  `wakeword` extra and confirm HomeBrain asset URLs/checksums are valid.
- **No microphone/camera activity:** check the saved robot privacy switches in HomeBrain;
  disabled capture is intentional and local.
- **Update falls back:** inspect HomeBrain update status and the owner-only
  `~/.local/share/homebrain-reachy/release-state.json`; do not edit immutable release files.
  Dependency fingerprint changes require a stopped/manual reinstall.

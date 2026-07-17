# Reachy Mini Wireless Integration

## Document Status

- Product: HomeBrain
- Hardware: Reachy Mini Wireless
- Research and implementation baseline: 2026-07-17
- Verified SDK baseline: `reachy-mini` 1.9.0 (released 2026-07-09)
- Integration role: first-class HomeBrain voice, perception, expression, and automation surface
- Runtime topology: Reachy Mini CM4 companion app plus HomeBrain Jetson services
- Production principle: Reachy supplies the body and local sensors; HomeBrain supplies intelligence, policy, home state, workflows, speech services, and administration
- Hardware validation status: deferred until the purchased Reachy Mini Wireless arrives

This document is the architecture, implementation, validation, rollout, and
operations contract for the Reachy Mini Wireless integration. A change is not
complete merely because it can make the robot move. It is complete only when
the authentication lifecycle, voice path, semantic motion controls, workflow
surface, failure handling, privacy defaults, UI, automated tests, deployment,
and production observability described here are present and verified.

## Goals

1. Make Reachy Mini a natural physical extension of HomeBrain.
2. Let Reachy use HomeBrain's wake words, speech-to-text, conversational and
   control intent processing, devices, scenes, workflows, text-to-speech, and
   event stream.
3. Let HomeBrain safely control Reachy's speech, expression, gaze, posture,
   antennas, body rotation, motor mode, and managed-app handoff.
4. Let Reachy provide useful, privacy-conscious signals to HomeBrain, including
   online state, motor/app state, direction of speech, transient presence, and
   explicit snapshots.
5. Keep the default interaction local-first. The CM4 performs hardware-local
   work, while compute-intensive AI remains on the HomeBrain Jetson.
6. Reuse HomeBrain's established remote voice-device credential lifecycle and
   audio pipeline instead of inventing a parallel trust system.
7. Support development and regression testing before hardware arrival through
   pure unit tests, mocked SDK objects, and the Reachy MuJoCo simulator.
8. Fail safe during network loss, HomeBrain restart, malformed commands,
   duplicate delivery, stale delivery, or companion-app shutdown.
9. Treat the companion as a versioned HomeBrain-managed external package, with
   the same visible inventory, update policy, audit, and operator controls used
   for packages such as the Codex CLI rather than as a one-time install script.

## Non-Goals

- Exposing the Reachy daemon on the public internet.
- Sending arbitrary Python, shell commands, joint trajectories, or raw motor
  registers from HomeBrain to the robot.
- Treating a voice, face, camera image, or presence detection as a trusted
  identity factor for unlocking, disarming, deployment, or administration.
- Continuously storing or transmitting camera or microphone data.
- Running a second large LLM, speech recognizer, or general vision model on the
  Reachy CM4.
- Making multiple Reachy managed apps control the robot concurrently.
- Reporting a fabricated battery percentage when the daemon or SDK cannot
  provide a reliable reading.

## External Platform Facts

The design is based on the current official Reachy Mini interfaces:

- Reachy Mini Wireless contains a Raspberry Pi CM4, battery and Wi-Fi, a
  four-microphone array, speaker, wide-angle camera, six-degree-of-freedom head,
  rotating body, and two animated antennas.
- The Reachy daemon owns hardware I/O and safety checks and exposes REST and
  WebSocket APIs. The Python SDK is a client of that daemon.
- The daemon owns camera and audio hardware. A managed local app receives the
  efficient local media path; a remote client uses WebRTC.
- Only one managed Reachy app runs at a time. Starting the HomeBrain app is an
  explicit ownership decision and stopping it hands control back to the Reachy
  app ecosystem.
- SDK safety constraints clamp unsafe poses, but HomeBrain still must apply its
  own semantic allowlist, parameter bounds, cancellation, and expiry.
- Reachy advertises `_reachy-mini._tcp.local.` with a stable unit identifier and
  capability metadata.

References:

- [Reachy Mini hardware](https://huggingface.co/docs/reachy_mini/main/platforms/reachy_mini/hardware)
- [Core architecture and safety](https://huggingface.co/docs/reachy_mini/main/SDK/core-concept)
- [Media architecture](https://huggingface.co/docs/reachy_mini/en/SDK/media-architecture)
- [Managed apps](https://huggingface.co/docs/reachy_mini/SDK/apps)
- [REST API](https://huggingface.co/docs/reachy_mini/API/rest-api)
- [Python SDK](https://huggingface.co/docs/reachy_mini/main/SDK/python-sdk)
- [`reachy-mini` 1.9.0 release metadata](https://pypi.org/project/reachy-mini/)
- [MuJoCo simulation](https://huggingface.co/docs/reachy_mini/en/platforms/simulation/get_started)
- [Discovery contract](https://huggingface.co/docs/reachy_mini/en/integrations/home_assistant)

## System Architecture

```text
Reachy Mini Wireless (CM4)
  Reachy daemon
    - motor safety and state
    - local GStreamer media ownership
    - app lifecycle and app lock
  HomeBrain Reachy app
    - HomeBrain credential/bootstrap storage
    - outbound authenticated WSS client
    - local wake-word/VAD orchestration
    - audio conversion and bounded buffering
    - semantic motion executor
    - speech playback and speech-reactive motion
    - state/event/capability reporting
    - reconnect, expiry, idempotency and safe shutdown
                |
                | outbound TLS/WSS and authenticated HTTPS
                v
HomeBrain Jetson
  Reachy integration service and routes
    - pairing and credential lifecycle
    - connected-session registry
    - semantic command validation/dispatch
    - state persistence and event publication
    - workflow action execution
    - operator diagnostics
  Existing HomeBrain voice stack
    - wake-word assets
    - streaming audio ingestion
    - Whisper/STT
    - intent and permission processing
    - devices, scenes and workflows
    - TTS provider selection and audio rendering
  React administration surface
    - onboarding
    - connection and capability status
    - safe controls
    - privacy and permission settings
    - app release/handoff
```

### Ownership Boundaries

The companion app owns real-time robot behavior while it is the active Reachy
managed app. HomeBrain sends semantic requests; it does not stream raw joint
targets. Examples of semantic requests are `look`, `play_emotion`,
`set_motor_mode`, `speak`, and `stop`.

High-frequency loops stay local to Reachy:

- SDK trajectory interpolation
- speech-reactive wobble
- face/head tracking
- microphone capture and audio playback
- hardware state sampling
- motion cancellation

HomeBrain owns:

- whether a user or workflow may request an action
- resolving voice commands against HomeBrain entities
- scene and workflow execution
- security-sensitive confirmations
- long-lived history and audit events
- TTS and STT provider selection
- configuration, diagnostics, and integration health

## Identity and Credential Lifecycle

Reachy is represented as a HomeBrain voice device whose `deviceType` is
`robot`. The existing lifecycle is retained:

1. An administrator creates a Reachy device in HomeBrain.
2. HomeBrain returns one-time onboarding material containing the device ID,
   short-lived registration or claim credential, HomeBrain HTTPS origin, and
   WebSocket origin.
3. The companion app activates once and receives a long random device token.
4. HomeBrain stores only the token hash and clears short-lived onboarding
   credentials after activation.
5. The companion app stores the token in a user-only-readable configuration
   file on the CM4.
6. Steady-state WebSocket and TTS requests use the device token.
7. Reissuing onboarding invalidates the previous device token, marks the device
   offline, preserves its identity/history, and creates new short-lived
   credentials.
8. Deletion removes the HomeBrain record only after an explicit administrator
   operation. It does not remotely wipe or execute shell commands on Reachy.

Reachy never receives a HomeBrain browser session, user bearer token, admin
token, Codex token, database credential, MQTT credential, or cloud-provider
credential.

## Transport and Protocol

### Network Direction

The companion app initiates the connection to HomeBrain. No inbound public
route to the Reachy daemon is required. The daemon's port 8000 remains LAN-only
and must never be added to Caddy's public reverse-proxy configuration.

The sole exception to outbound-only runtime control is an explicit,
administrator-initiated managed-package operation. HomeBrain may then contact
the registered robot's Reachy daemon on fixed port 8000 over the private LAN to
stop and restart the already-installed companion through Reachy's official app
API. A HomeBrain-bundled runtime update is activated by the stable launcher;
the daemon's local-package install route is not used because SDK 1.9 does not
support one.
That path is not used for motion or media, accepts only a previously registered
private/link-local host, revalidates DNS results before every connection,
blocks redirects and public/loopback/metadata destinations, limits response
size and duration, and never accepts an arbitrary URL from a browser request.

### WebSocket

The first implementation extends HomeBrain's authenticated voice-device
WebSocket. This preserves onboarding, wake-word delivery, audio ingestion,
command processing, TTS response, heartbeat monitoring, update state, and room
context. Reachy-specific messages are capability-gated and ignored for
non-robot voice devices.

Robot commands use this versioned envelope:

```json
{
  "type": "robot_command",
  "protocolVersion": 1,
  "command": {
    "id": "uuid",
    "action": "look",
    "parameters": { "direction": "left" },
    "issuedAt": "ISO-8601",
    "ttlMs": 15000
  }
}
```

Rules:

- Unknown message types receive a bounded error and never crash a session.
- Payload size, string length, array length, and numeric ranges are validated.
- Incoming robot state is sanitized before persistence or event publication.
- Command messages include `commandId`, `issuedAt`, and `expiresAt`.
- A stale command is rejected even if it arrives after reconnection.
- Completed command IDs are retained in a bounded local idempotency cache.
- Duplicate commands return the previous terminal result without repeating
  motion.
- Commands may produce `accepted` or `started`, followed by exactly one
  terminal `completed`, `rejected`, `expired`, `cancelled`, or `failed`
  result. HomeBrain correlates every result by command UUID.
- Heartbeat loss marks the device offline; it does not trigger unbounded retry
  logs or automatic unsafe movement.

The authenticated robot identity is also bound to Reachy's daemon-reported
hardware unit ID. The first successful claim atomically binds that ID to the
HomeBrain device. A missing, changed, or already-bound-to-another-device ID
fails authentication before `auth_success`, audio admission, state updates, or
command delivery. The unit ID is treated as an identity binding, not as a
secret, and diagnostics expose only a bounded fingerprint where the raw value
is unnecessary.

Authorization is bound to the exact WebSocket object, not merely to the device
ID in a replaceable connection map. A pre-authentication or superseded socket
cannot inherit a newer socket's authenticated state and cannot submit robot,
audio, update, or status messages after replacement.

### Core Client-to-HomeBrain Messages

- `authenticate`
- `heartbeat`
- `wake_word_detected`
- `audio_data`
- `status_update`
- `robot_capabilities`
- `robot_state`
- `robot_event`
- `robot_command_result`
- `error`

### Core HomeBrain-to-Client Messages

- `auth_success`
- `auth_failed`
- `config_update`
- `heartbeat_ack`
- `wake_word_ack`
- `command_processing`
- `tts_response`
- `robot_command`
- `robot_config`
- `command_error`

### HTTPS

Device-token-authenticated HTTPS is used for:

- activation/bootstrap
- wake-word assets
- rendered TTS audio
- companion package/version metadata where applicable
- a bounded package manifest and allowlisted package source files used to stage
  a managed update on the robot
- one-shot JPEG snapshot upload and read-once administrator retrieval

The robot does not call general `/api/devices`, `/api/scenes`, `/api/workflows`,
or administrator endpoints. Spoken HomeBrain requests are executed server-side
through the established voice command service.

## Companion App Design

### Package Layout

The repository contains a separately installable Python project:

```text
reachy-homebrain-app/
  pyproject.toml
  README.md
  install.sh
  artifact-manifest.json
  src/reachy_homebrain/
    __init__.py
    __main__.py
    app.py
    audio.py
    bootstrap.py
    client.py
    config.py
    http_security.py
    identity.py
    launcher_constants.py
    main.py
    metadata.py
    motion.py
    package_stage.py
    perception.py
    protocol.py
    releases.py
    robot.py
    sdk_compat.py
    tts.py
    version.py
    wakeword.py
  tests/
```

The package registers a `reachy_mini_apps` entry point and subclasses
`ReachyMiniApp`. It can also be imported without the Reachy SDK for unit tests.
SDK and hardware calls are behind a small adapter that accepts mock objects.

### Configuration

Required values:

- HomeBrain HTTPS origin
- voice device ID
- one bootstrap credential or activated device token
- room/name metadata

Optional values:

- preferred wake-word threshold
- reconnect bounds
- state-report cadence
- enabled perception signals
- local log level

Secrets are never committed, logged, included in diagnostic state, or returned
after activation. The app writes configuration atomically with restrictive
permissions to `~/.config/homebrain-reachy/config.json`.

### Audio Path

1. Reachy's media manager owns the microphone and speaker.
2. The companion consumes the SDK's 16 kHz float audio samples.
3. Stereo input is averaged or otherwise safely downmixed to mono.
4. Values are clipped to `[-1.0, 1.0]` and encoded as signed little-endian
   PCM16.
5. Bounded chunks are sent using the existing HomeBrain audio session fields.
6. HomeBrain performs STT and intent processing.
7. A `tts_response` supplies text and voice choice.
8. The companion fetches rendered audio from the device-authenticated TTS route
   with `POST` JSON `{ "text": "...", "voiceId": "..." }` and feeds decoded
   samples to Reachy's media playback interface. Speech text is never placed in
   a URL, query string, access log, or redirect, and `GET`/query variants are
   rejected.
9. `stop` and barge-in clear both local and daemon-side queued playback where
   supported.

Audio queues are bounded. When the network cannot drain them, the oldest
nonessential audio is discarded and the session fails cleanly rather than
exhausting CM4 memory.

Reachy audio is admitted only after an authenticated `wake_word_detected`
message creates a short-lived, one-use capture grant for that exact WebSocket.
HomeBrain returns an unguessable bounded session ID in `wake_word_ack`; the
companion must use that exact ID for start, chunks, and final. The first valid
capture start consumes the grant. Replays, a different
session ID, expiry, reconnect, cancellation, or a second capture are rejected.
Every chunk must also satisfy the fixed 16 kHz, mono, signed little-endian
PCM16 contract plus bounded Base64 size, sequence, total duration, and session
length. Enabling the microphone or wake-word setting alone never authorizes
continuous room-audio upload.

### Wake Word and Conversation State

HomeBrain remains the source of enabled wake words and wake-word assets. Wake
detection runs locally so continuous room audio is not sent to the hub. The
state machine is:

```text
idle -> wake-detected -> listening -> uploading -> processing -> speaking -> idle
                   \-> cancelled/error ------------------------------/
```

Only one voice capture session is active at a time. Timeouts, shutdown, loss of
authentication, or explicit stop cancel the session and return to idle.

The repository intentionally does not invent or silently download an
unlicensed default wake model. Before Reachy voice capture can work, an
administrator must train or install the configured OpenWakeWord model in
HomeBrain's Wake Word Manager and broadcast it to listeners. A configured
phrase such as `Anna` is not treated as a working detector by itself. Until the
companion verifies a model and reports detector state `ready`, the `wake_word`
capability stays absent, no capture grant is issued, and the Reachy page shows a
model-required diagnostic with a link to the manager.

### Robot Command Executor

Allowed commands are semantic and enumerated:

- `wake`
- `sleep`
- `neutral`
- `stop`
- `look`
- `set_antennas`
- `set_body_yaw`
- `set_motor_mode`
- `play_emotion`
- `play_move`
- `start_face_tracking`
- `stop_face_tracking`
- `set_volume`
- `set_microphone_volume`
- `snapshot`
- `release_app`

Initial aliases such as `look_left` are normalized to an action plus bounded
parameters. Raw motor IDs, arbitrary filesystem paths, arbitrary dataset names,
URLs, Python expressions, and shell fragments are rejected.

Bounds are stricter than or equal to the SDK limits. Durations have minimum and
maximum values and are rejected above the shared five-second protocol maximum;
they are never silently clamped to a value different from HomeBrain's command
expiry. Body and head yaw preserve the safe relative delta.

Motion is executed through the loopback-only Reachy daemon task API rather
than assuming that the SDK's general cancellation method can stop every kind
of move. The companion subscribes to the daemon move-update WebSocket before
posting a move, correlates the returned task UUID, and reports success only
after the daemon emits the matching terminal `completed` event. `failed` and
`cancelled` remain failures. One generation/admission lock covers a complete
semantic command, including multi-step gestures. `stop`, shutdown, and safety
errors invalidate queued generations and call the daemon's UUID-specific stop
route for every admitted task. A stop result is successful only after those
physical cancellations are confirmed within a bound; audio/TTS cleanup is
best-effort and can never prevent the physical stop path. Emergency stop also
disables expressive idle/audio-reactive wobble and latches unresolved daemon
task UUIDs so no later motion can overwrite an unconfirmed physical stop.

### Safe Shutdown and Link Loss

On managed stop or process shutdown, the app:

1. stops accepting new commands
2. cancels recording and playback
3. cancels active motion
4. reports a best-effort final state
5. moves to neutral only when the SDK reports that doing so is safe
6. releases resources and exits so the daemon can reset its managed app

On HomeBrain link loss, the app does not disable motors automatically, execute
queued commands, or repeatedly move. Active short motion may finish; all
network-sourced queued commands expire. The app reconnects with capped
exponential backoff and jitter.

### Managed Package Lifecycle

`reachy-homebrain-app` is a normal versioned Python distribution, not an
unversioned copy of source files. Its package name, semantic version, protocol
version, Reachy SDK version, Python version, app entry point, and release
fingerprint are reported during authentication and in periodic status.

HomeBrain exposes the companion under the stable managed-service ID
`reachy-homebrain-app` in its external-package inventory. The
inventory aggregates all registered Reachy units and shows:

- bundled/available HomeBrain companion version
- installed version and release fingerprint per robot
- Reachy SDK/daemon compatibility plus stable-launcher API, exact launcher-code
  fingerprint, and dependency fingerprint
- connected, installed, update-available, staged, updating, succeeded, failed,
  and rollback-required states
- last check, last update, bounded error, and update-policy timestamps

Initial onboarding downloads the package through a one-time credential and
installs its `reachy_mini_apps` entry point into Reachy's official managed-app
environment. That installed entry point is a deliberately small, stable
launcher. The HomeBrain runtime is loaded from a versioned, owner-only release
directory, with the initially installed runtime as its fallback. Subsequent
updates use a device-authenticated manifest. Every
manifest has `schemaVersion: 1`, the stable artifact identity
`reachy-homebrain-app`, a semantic version, an aggregate SHA-256, and an
allowlisted file list. Every file has a relative path, exact byte size,
SHA-256, and same-origin download URL. The companion stages files into a new owner-only
temporary directory, refuses traversal, links, unknown files, redirects,
cross-origin URLs, oversize files, checksum mismatches, and partial manifests,
and deletes the directory on failure. Staging never executes code.

The aggregate digest is computed over the exact same UTF-8 bytewise path order
on HomeBrain and Reachy. Runtime manifests deliberately exclude the complete
stable pre-runtime boundary: `__init__.py`, `__main__.py`, `main.py`,
`releases.py`, `launcher_constants.py`, and `sdk_compat.py`. Changing one of
those files or the dependency fingerprint is surfaced as
`manual_reinstall_required`; a source update cannot quietly replace code that
runs before release selection or code responsible for authenticating and
rolling back that update.
Initial installation records an exact manifest receipt. An older installation
without that receipt is shown as provenance/integrity `unknown`, never as
verified merely because its version string matches.

Reachy SDK 1.9's app-install REST route accepts Hugging Face Space sources; it
does not accept a local staged directory. HomeBrain therefore never sends an
unsupported local-install request and never performs SSH or remote shell
installation. Applying a bundled update is an administrator-only orchestration:

1. HomeBrain checks compatibility and confirms the robot is connected.
2. HomeBrain durably creates a fleet batch and every intended per-robot target
   before dispatch, then records each accepted request immediately so a later
   target failure cannot leave an untracked update running. Batch admission is
   an atomic database compare-and-set, so concurrent operator or automatic
   requests cannot overwrite the active batch or dispatch twice. If HomeBrain
   crashes after Reachy persists staging but before the accepted correlation is
   saved, reconciliation recovers only a request whose persisted timestamp and
   state belong to that planned batch.
3. The companion downloads and verifies the new package into staging, and the
   stable launcher commits it to an immutable versioned release directory
   without making it executable.
4. An exact request/version/digest prepare handshake creates a non-launchable
   pending record. HomeBrain retries a lost acknowledgement idempotently or
   sends and awaits a correlated disarm; unlaunchable pending records also
   expire defensively.
5. Immediately before the controlled restart, HomeBrain sends an exact
   authorization that flips only that pending release to launchable. The
   companion applies safe shutdown and acknowledges readiness.
6. HomeBrain uses the private-LAN Reachy daemon API to stop the active app and
   starts the same installed `reachy-homebrain-app` entry point.
7. The launcher attempts the pending runtime once; the new process reconnects
   and must
   report the expected version and aggregate fingerprint before it is marked
   healthy.
8. HomeBrain sends an idempotent correlated confirmation and reconciles a lost
   acknowledgement from fresh release metadata. Only then does the launcher
   promote the candidate and retain the old release as last-known-good.
9. A mismatch, timeout, crash during the post-confirmation soak, server restart,
   or other failure is reconciled from durable request metadata. HomeBrain
   sends an exact idempotent rollback/disarm, awaits the correlated result, and
   performs at most one bounded restart into the previous healthy runtime. It
   never loops restarts or swaps active/previous again on a duplicate rollback.

The operation is single-flight per robot, has timeouts at every phase, and is
audited. Automatic updates remain off by default and honor the managed-package
stability window. A failed install is never represented as current. If the app
does not reconnect with the expected version, HomeBrain reports a recovery
state and directs the operator to Reachy's dashboard; it does not loop restart
or installation indefinitely. Reachy's native Hugging Face app-update path can
also be used after the package is published as a Space, but it is not required
for HomeBrain-managed runtime releases.

## HomeBrain Backend Design

### Device Model

The existing voice-device schema adds `robot` to `deviceType`. Reachy-specific
data lives in a sanitized `settings.reachy` object so the established voice
device, onboarding, update, diagnostics, room, and connection surfaces remain
usable.

Persisted fields may include:

- provider and model
- stable Reachy unit ID
- protocol version
- capability flags
- last safe robot state
- daemon/SDK/app version
- motor mode
- active managed app name/state
- connection/session timestamps
- enabled privacy and perception settings
- last bounded error summary

Never persist raw microphone buffers, continuous video, device tokens, arbitrary
robot messages, or unbounded error/log data.

### Service Responsibilities

The Reachy service:

- identifies robot voice devices
- creates onboarding records with safe defaults
- sanitizes and stores capabilities/state
- tracks connected authenticated sessions
- validates and sends semantic commands
- correlates command results
- times out pending commands
- publishes event-stream records
- exposes diagnostics without secrets
- presents workflow actions through one execution path

Routes must never directly reach `reachy-mini.local:8000` on behalf of an
untrusted request. The managed companion session remains the control path.

### API Surface

Authenticated users can read status. Administrator permission is required to
create, reissue, update privacy/permissions, delete, change motor mode, or
release the managed app. Normal permitted users may request low-risk controls
and speech subject to HomeBrain policy.

The API base is `/api/reachy-mini`. The implementation keeps compatibility
aliases where useful, while these are the canonical operator and device
routes:

- `GET /status`
- `GET /devices`
- `GET /:deviceId`
- `POST /devices`
- `POST /:deviceId/reissue`
- `PATCH /:deviceId/settings`
- `POST /:deviceId/commands`
- `GET /:deviceId/commands/:commandId`
- `POST /:deviceId/speak`
- `POST /:deviceId/stop`
- `POST /:deviceId/release`
- `POST /:deviceId/snapshots/:snapshotId` (device-token JPEG upload)
- `GET /:deviceId/snapshots/:snapshotId` (administrator, read once)
- `GET /:deviceId/companion/manifest` (device token)
- `GET /:deviceId/companion/files` (device token)
- `GET|POST /:deviceId/companion/status|check|update`
- `DELETE /:deviceId`

All mutation routes are rate-limited, schema-validated, audited through the
event stream, and return bounded errors.

### Event Types

- `reachy.device.created`
- `reachy.device.updated`
- `reachy.device.deleted`
- `reachy.connected`
- `reachy.disconnected`
- `reachy.state.updated`
- `reachy.motion.started`
- `reachy.motion.completed`
- `reachy.motion.cancelled`
- `reachy.command.rejected`
- `reachy.person.present`
- `reachy.person.cleared`
- `reachy.speech.detected`
- `reachy.voice.session.started`
- `reachy.voice.session.completed`
- `reachy.app.released`
- `reachy.error`

High-frequency state updates are coalesced. Direction-of-arrival updates and
pose samples do not create an unbounded event stream.

## Voice and Permission Model

Reachy's microphone is another HomeBrain room voice surface. A spoken request
uses Reachy's configured room and existing HomeBrain entity resolution. General
questions, direct device controls, scene execution, and permitted existing
workflow execution use the same voice service as other listeners.

Robot-directed voice commands are explicit, for example:

- "Reachy, look left"
- "Reachy, go to sleep"
- "Reachy, play a happy expression"
- "Reachy, stop moving"

The interpreter must not turn conversational text into robot motion without an
explicit Reachy target or an already-active, bounded robot interaction context.

Default voice denials:

- unlock a lock
- open a garage or secured entry
- disarm security
- create, edit, enable, or delete workflows
- manage users, credentials, integrations, deployment, or services
- change Reachy privacy settings or motor safety policy

High-risk actions require an authenticated HomeBrain UI interaction or a
separate confirmation factor. Face detection, face recognition, speaker
recognition, and camera presence are not authorization factors.

This denial is semantic, not just phrase-based. Direct HTTP/network-resource
actions, direct release/snapshot/face-tracking/privacy operations, nested
workflow variants, and scene/workflow target aliases are normalized and
checked before execution. A carefully worded utterance cannot bypass the
policy by avoiding a particular keyword.

## Workflow Integration

The integration registers the capabilities `voice_assistant`, `device_control`,
`workflow_actions`, `workflow_conditions`, `telemetry_source`, and
`alerts_source`.

### Action

A new `reachy_action` workflow action accepts:

```json
{
  "type": "reachy_action",
  "target": { "deviceId": "..." },
  "parameters": {
    "action": "play_emotion",
    "emotion": "happy",
    "duration": 2
  }
}
```

Workflow execution calls the same service validator used by the UI. It never
bypasses permissions, allowlists, range checks, connection checks, correlation,
or expiry.

### Conditions and Triggers

Reachy state is exposed through bounded nested properties compatible with
HomeBrain's existing `device_state` trigger, including:

- `reachy.online`
- `reachy.personPresent`
- `reachy.speechDetected`
- `reachy.motorMode`
- `reachy.activeApp`
- `reachy.isMoving`

Presence and speech signals use debounce, minimum duration, cooldown, and clear
events so transient model noise does not repeatedly execute a workflow.

### Recommended Initial Automations

- Security alarm triggered -> Reachy stops normal motion, plays an alert
  expression, and speaks a configured warning.
- Front door opens while disarmed -> optional glance toward the configured
  direction, with cooldown.
- Person present in Reachy's room -> optional greeting during allowed hours.
- HomeBrain enters night profile -> Reachy sleeps.
- HomeBrain enters morning profile -> Reachy wakes and optionally reports
  weather or calendar through a user-created workflow.

No event-to-motion behavior is enabled by default.

## Perception and Privacy

Default configuration:

- local wake-word detection enabled
- continuous audio upload disabled
- speaker-direction telemetry disabled until explicitly enabled
- expressive idle/audio-reactive motion disabled until explicitly enabled
- person-presence detection disabled
- face tracking disabled
- face identity disabled and unsupported as authorization
- continuous video upload disabled
- image storage disabled
- on-demand snapshot requires explicit authenticated action
- event-driven speech disabled until configured

If presence is enabled, the preferred implementation emits only a transient
boolean and confidence band. If HomeBrain performs an explicit vision request,
the companion captures one frame, applies size and rate bounds, sends it for
processing, and discards local and remote temporary data according to the
request lifecycle.

The UI must clearly show when camera-dependent or microphone-dependent features
are enabled.

Turning off microphone, camera, snapshot, presence, or face-tracking permission
updates both persistence and the live session cache. It immediately revokes
capture grants, clears active audio sessions and transient presence/camera
state, deletes unconsumed temporary snapshots, clears the browser preview,
sends the new configuration to the companion, and prevents a stale in-memory
permission from admitting another sample. Ordered configuration revisions
prevent an earlier slow enable from completing after a later disable. If the
companion cannot physically apply a disable, it latches a degraded fail-closed
state, refuses the affected capture/control path, retries cleanup, and reports a
bounded diagnostic rather than claiming the privacy change succeeded.

## React Administration Experience

The Reachy page provides:

- empty state explaining Wireless onboarding
- create device form with name and room
- one-time bootstrap/install information
- online/offline/authentication/app state
- Reachy daemon, SDK, companion app/protocol, and capabilities
- last heartbeat and last interaction
- motor mode and motion status
- speaker and microphone controls
- semantic wake/sleep/neutral/stop/look controls
- expression and bounded movement controls
- speech test
- privacy/perception toggles
- independent local-wake, speaker-direction, default face-tracking, and
  expressive-idle-motion opt-ins
- safe app release/handoff
- onboarding reissue and deletion behind confirmation
- bounded error and diagnostics information

Controls are disabled when the robot is offline, unauthenticated, or lacks the
advertised capability. Ordinary controls may serialize while an operation is
pending, but Emergency Stop remains independently available so it can preempt
movement. The UI never
optimistically reports that physical motion succeeded; it waits for the
correlated command result or displays a pending/timeout state.

If Reachy reports that its physical microphone/camera privacy state could not
be confirmed, the page shows a prominent safety-latch alert and blocks every
robot command and settings delivery except Emergency Stop. Credential rotation,
package recovery, and device removal remain available to the administrator.

## Discovery

Discovery is advisory, not trusted pairing. HomeBrain may browse mDNS records
for `_reachy-mini._tcp.local.` and show candidate units, but the administrator
still creates/approves the HomeBrain device and installs the companion with
one-time credentials. A matching mDNS record does not grant access.

The stable unit ID is recorded after the authenticated companion reports it.
Subsequent conflicting unit IDs raise an explicit diagnostic instead of
silently moving the integration to another robot.

## Failure Modes

### HomeBrain Unavailable

- companion remains safe and locally idle
- no queued HomeBrain command executes after its expiry
- reconnection uses bounded exponential backoff
- wake detection may remain local, but captures fail with a short local cue
- no credential is regenerated automatically

### Reachy App Stops or Crashes

- daemon managed-app cleanup releases hardware
- HomeBrain session closes and marks the device offline
- pending commands fail with a disconnect result
- no automatic restart loop is initiated by HomeBrain without explicit policy

### Authentication Failure

- connection closes after a bounded error
- token is never logged
- repeated failure backs off
- administrator reissues onboarding from HomeBrain

### Invalid or Unsafe Command

- companion and server both reject it
- no partial motion occurs
- a sanitized audit event identifies the action and reason
- repeated invalid commands are rate-limited

### TTS or STT Failure

- robot returns to idle
- queued speech-reactive motion is cancelled
- a short nonverbal/error cue may play locally
- no cloud fallback occurs unless HomeBrain's existing provider policy permits it

### Motor or SDK Error

- active and queued motion stops
- error state is reported once with bounded detail
- HomeBrain does not retry the same movement automatically
- recovery requires a safe explicit command or operator intervention

## Observability

HomeBrain diagnostics include:

- enrollment state
- token/authentication state without token material
- connected and authenticated WebSocket state
- heartbeat age
- companion, SDK, daemon, hardware and protocol versions
- capabilities
- current app and motor mode
- pending command count and oldest age
- last terminal command summary
- last bounded robot error
- privacy configuration

Metrics and event output are rate-limited and avoid high-cardinality message IDs
except where a short-lived correlation is necessary.

## Testing Strategy

### Companion Unit Tests

- float stereo to mono PCM16 conversion, clipping, empty and malformed samples
- configuration validation, atomic persistence and redaction
- bootstrap activation and token replacement
- authentication payloads and config updates
- reconnect backoff and shutdown cancellation
- command allowlist, aliases, ranges, expiry and duplicate idempotency
- motion serialization and stop preemption
- daemon task WebSocket correlation, terminal-result truth, stop-before/during-
  post races, multi-step generation invalidation, and stop fault isolation
- safe SDK exception handling
- TTS authentication and audio playback adapter behavior
- capability and state sanitization
- wake-word asset download, checksums, local detection, debounce and re-arming
- missing/unready wake-model reporting and fail-closed capture admission
- package manifest/path/size/checksum validation and failure cleanup
- UTF-8 bytewise cross-language aggregate identity and stable-launcher exclusion
- prepare/authorize/confirm acknowledgement loss, unlaunchable-pending expiry,
  correlated idempotent rollback, restart reconciliation, and crash-soak failure
- app-management request/result correlation without in-process installation
- operation without the Reachy SDK installed

### Server Unit and Integration Tests

- robot voice-device schema support
- onboarding, activation, hash-only token storage and reissue invalidation
- atomic daemon hardware-ID binding, duplicate rejection, mismatch rejection,
  and authentication failure before session admission
- robot-only WebSocket message acceptance
- non-robot rejection of Reachy messages
- state/capability sanitization and bounded persistence
- connected-session and offline handling
- command validation, authorization, correlation, timeout and result handling
- API authentication, admin requirements and rate limits
- a reserved emergency-stop limiter that remains available after ordinary
  command quota exhaustion
- event publication and coalescing
- `reachy_action` schema, validation, execution and history
- explicit robot voice intent and unsafe-control rejection
- one-shot session-bound wake capture grants, strict PCM framing, replay,
  expiry, sequence, duration, and reconnect rejection
- integration catalog and registry state
- account/device deletion cleanup
- server shutdown cleanup
- managed-package inventory, stability policy and multi-robot aggregation
- durable fleet batches, partial dispatch, accepted-target tracking, process
  restart reconciliation, and bounded per-device diagnostics
- package manifest/file authentication and traversal rejection
- private-LAN daemon destination validation, redirect blocking, timeouts and
  mocked stop/start orchestration
- immutable release commit, atomic pointer switch, expected-version reconnect,
  bounded rollback and recovery-required behavior
- failed update, reconnect mismatch, single-flight and recovery behavior

### Client Validation

- TypeScript production build
- ESLint
- loading, empty, onboarding, online, offline, pending, success and error states
- permission-sensitive controls
- safe confirmation flows
- responsive desktop/tablet/mobile layout
- no secrets in DOM persistence or browser storage
- managed-package current/update/staged/failure states and confirmation flows

### Repository Regression Gates

- complete server test suite
- client production build
- client lint, with pre-existing failures distinguished from new failures
- companion test suite
- secret scan of working tree and history
- dependency lock consistency
- route registration and server startup smoke test
- git diff review for generated or unrelated files

### Simulation Validation

When the Reachy SDK and MuJoCo environment are available:

- install the companion package
- launch `reachy-mini-daemon --sim`
- start the managed HomeBrain app
- authenticate to a test HomeBrain instance
- execute wake, sleep, neutral, gaze, antenna and stop requests
- verify command results and link-loss behavior
- verify the app exits and releases ownership cleanly

Simulation does not validate microphone-array hardware, acoustic echo
cancellation, physical motor calibration, real camera focus, Wi-Fi roaming, CM4
thermal behavior, or battery behavior.

### Hardware Acceptance Tests After Arrival

- assembly and official Reachy diagnostics pass
- daemon and SDK versions match the tested compatibility range
- mDNS discovery and Wi-Fi stability
- one-time activation and reboot persistence
- provision a verified, appropriately licensed wake-word model in HomeBrain,
  broadcast it, and confirm Reachy reports the detector `ready`
- wake-word accuracy at multiple distances and noise levels
- direction-of-arrival behavior
- STT/TTS end-to-end latency and acoustic echo cancellation
- barge-in and stop behavior
- every semantic motion at physical limits and normal positions
- motor error and emergency stop behavior
- app handoff to and from another managed Reachy app
- HomeBrain restart, router restart and robot restart recovery
- camera privacy indicator and snapshot deletion behavior
- sustained runtime and CM4 temperature/memory observation

## Performance Targets

- authenticated reconnect after a routine network interruption: within 15
  seconds under normal LAN conditions
- heartbeat offline classification: within 90 seconds
- UI command accepted/rejected response: within 500 ms on LAN
- terminal result for short semantic motion: duration plus 1 second
- first spoken acknowledgment after command upload: target under 2.5 seconds,
  dependent on configured HomeBrain STT/LLM/TTS providers
- bounded companion memory during repeated audio sessions
- no unbounded event, audio, command-result, or idempotency collection

Targets are measured, not guaranteed by optimistic UI state.

## Implemented Release and Validation Record

This section records the software state that was completed and independently
audited on 2026-07-17. It is intentionally separate from the hardware
acceptance checklist: every item below can be verified without possessing the
physical robot, while the remaining hardware-only checks are listed later in
this document.

### Delivered Surfaces

- `reachy-homebrain-app` 0.1.0, packaged as an official Reachy managed app with
  the `reachy_mini_apps` entry point, installer, configuration bootstrap,
  Apache-2.0 licensing, web card assets, runtime receipt, and bounded durable
  release history
- authenticated one-time enrollment with a claim-token exchange, credential
  rotation, revocation, stable hardware identity binding, reconnect generation
  guards, and no reusable credential in a URL or shell-history argument
- outbound robot-to-HomeBrain WebSocket transport with schema validation,
  correlation IDs, deadlines, idempotency, bounded collections, heartbeats,
  command cancellation, and stale-session rejection
- HomeBrain voice-device integration for granted utterance audio, HomeBrain
  STT/intent/TTS, local wake-word readiness, direction metadata, and replay-safe
  audio session grants
- semantic robot operations for wake, sleep, neutral, emergency stop, gaze,
  speaker-directed gaze, motor mode, body rotation, antenna position, allowlisted
  movement, expression, face tracking, app ownership release, audio levels, and
  speech
- privacy-default camera, snapshot, presence, face-tracking, microphone, and
  wake-word controls, including a fail-closed `privacyFault` latch when physical
  microphone shutdown cannot be confirmed
- epoch-bound snapshot upload and retrieval so privacy disable, credential
  rotation, runtime fault, expiry, or command mismatch invalidates and removes
  in-flight data rather than adopting it into a newer permission generation
- `reachy_action` support in workflows, automations, validation, execution,
  integration capabilities, source catalogs, and the workflow builder
- robot-aware voice authorization that recursively inspects scenes, device
  groups, nested workflows, repeats, conditions, graph references, and fallback
  intents; locks, garage doors, alarms, credentials, package management, and
  administration remain blocked from Reachy voice execution
- a first-class Reachy Mini administration page with enrollment, offline and
  online states, runtime telemetry, safe controls, settings, snapshot retrieval,
  privacy latch visibility, recovery, removal, and responsive mobile layout
- managed external-package inventory beside Codex CLI, Caddy, Mosquitto, and
  Pi-hole, including version discovery, check cadence, stability window,
  automatic-check and automatic-deploy policy, install/update controls,
  per-device state, compatibility, immutable digest, stable-launcher identity,
  dependency status, receipts, single-flight fleet admission, rollback, and
  crash recovery

### Immutable Runtime Contract

- managed package ID: `reachy-homebrain-app`
- package version: `0.1.0`
- managed service ID: `reachy-homebrain-app`
- runtime file count: 18
- runtime aggregate SHA-256:
  `dd8c00acd68e39158b56861f4be8dac863da07f88847717dfdd0322bb989d99c`
- stable launcher SHA-256:
  `2f4e8e2e928ae60b3fe199250546e917ab04bf3735b5fe3db262ecc49ee8d9b3`

The stable launcher is deliberately outside the mutable runtime release. A
release cannot replace its own recovery boundary, and both Python and Node
contract tests must agree on the file inventory and hashes before an update is
admitted.

### Automated and Simulated Results

- complete HomeBrain server test suite: 1,200 passed, 0 failed, across all 115
  server test files
- independently focused Reachy, voice, WebSocket, platform-package, TTS,
  automation, privacy, snapshot, request-boundary, and package-download
  regression matrices: 104 passed, 0 failed, with no remaining audit finding
- companion package: 142 passed, 0 failed, with 69% branch coverage
- Ruff format and lint: passed
- client ESLint: passed
- client production build: passed, 3,152 modules transformed
- Reachy-specific and directly integrated client files: no strict TypeScript
  diagnostics; the repository-wide strict TypeScript command is not currently a
  release gate and continues to expose unrelated pre-existing typing debt
- dependency audits for root, server, client, broker, Lambda, and remote-device
  workspaces: 0 known vulnerabilities
- current-tree, tracked-path, embedded-default, and complete 1,297-revision git
  history secret-safety scan: passed
- Node module-load smoke, shell syntax/help, Python package metadata, wheel and
  sdist contents, entry point, fresh install/uninstall, and `pip check`: passed
- official `reachy-mini` 1.9.0 plus MuJoCo 3.3.0 simulation: daemon startup,
  bounded semantic gaze, correlated cancellation of the exact active motion,
  cancelled terminal status, neutral return, and clean daemon shutdown passed
- isolated production-mode HomeBrain startup against a disposable MongoDB,
  authenticated desktop/mobile browser flow, enrollment, one-time credential
  disappearance after reload, offline-safe controls, managed-package update
  check, persisted update policy, fleet telemetry, removal/revocation, and
  post-login console-error check: passed
- `git diff --check`: passed

The browser test created only a disposable `QA Reachy` identity in the isolated
database and removed it at the end. No Reachy record, enrollment secret, or
package operation was created against the production HomeBrain instance.

### Independent Safety Audit Result

The final independent review returned **GO** after re-auditing snapshot epoch
ordering, privacy-fault persistence and purge ordering, credential reissue,
connection-generation guards, emergency-stop quota independence, updater
single-flight admission, staged-release reconciliation, rollback, and durable
receipt behavior. There is no remaining software blocker. Physical Wireless
acceptance remains mandatory after the purchased unit arrives and is not
represented as completed by simulation.

## Implementation Sequence

### Phase 0: Contract and Test Harness

- land this architecture contract
- create companion package and SDK adapter
- define and test protocol validation
- build mocked robot/media fixtures
- document simulation setup

### Phase 1: Secure Voice Extension

- add robot voice-device type
- create and activate Reachy onboarding
- authenticate the companion
- deliver wake-word configuration
- stream bounded audio to HomeBrain
- return HomeBrain TTS to Reachy's speaker
- report heartbeat, capability and app state

### Phase 2: Safe Robot Control

- add server-side Reachy service and routes
- implement semantic executor and correlated results
- add HomeBrain Reachy UI
- support wake, sleep, neutral, stop, look, antenna, body, motor mode,
  expressions, volume and speech
- implement app release/handoff

### Phase 3: Automation and Events

- register integration capabilities
- add `reachy_action` workflow support
- expose bounded device-state properties
- publish connection, motion, voice and error events
- add explicit voice robot controls

### Phase 4: Perception

- add direction-of-arrival and speech signals
- add opt-in debounced person presence
- add explicit on-demand snapshots
- add optional local face tracking without identity authorization

### Phase 5: Hardening and Production

- run every automated gate
- fix regressions
- update operator documentation
- commit and push through the production branch workflow
- run the HomeBrain safe deployment
- verify runtime commit, API, database, WebSocket, MQTT, reverse proxy,
  resources and deploy events
- leave hardware-only acceptance items explicitly pending

## Production Rollout and Rollback

The server and UI can be deployed before the robot arrives because no Reachy
device record or active session is created automatically. New schemas are
additive. Existing voice devices must continue to behave exactly as before.

Deployment gates:

1. clean git worktree
2. pushed production commit
3. complete automated test matrix green
4. no detected secrets
5. production branch contains the reviewed commit
6. HomeBrain safe deploy completes
7. runtime commit equals repository commit
8. API, database, voice WebSocket, reverse proxy and MQTT checks healthy
9. resource pressure remains acceptable
10. Reachy routes return an authenticated empty state without errors

Rollback is a normal repository revert and safe HomeBrain deploy. Because the
feature is additive and inactive until onboarding, rollback must not require a
database destructive migration. A future paired device may remain as an unused
voice-device record if code is rolled back; no credentials are exposed by that
record.

## Definition of Done

Before hardware arrival, the integration is complete when:

- this document matches the implemented behavior
- the companion package is installable and testable without hardware
- HomeBrain can securely onboard a Reachy robot voice device
- authenticated robot messages are validated and reflected in status
- HomeBrain can send only bounded semantic robot commands
- command outcomes are correlated, timed out, and audited
- Reachy can use the existing HomeBrain voice and TTS paths
- Reachy appears in the managed external-package inventory with version,
  check, policy and update controls
- package staging, atomic runtime activation and daemon restart orchestration
  are authenticated, bounded, integrity checked and fully exercised with mocks
- the UI supports onboarding, status, safe control, privacy and handoff
- workflows can execute validated `reachy_action` steps
- integration capabilities and events are registered
- all new tests and the complete existing server suite pass
- client build and applicable lint checks pass
- the secret scan passes
- the production deployment is healthy and runs the new commit

The only permitted incomplete items are tests that intrinsically require the
physical Reachy Mini Wireless hardware. Those tests are listed in the Hardware
Acceptance Tests section and must be performed when the unit arrives.

# HomeBrain Configuration Guide

Use this after the hub is installed and reachable in a browser.

## 1. First Login

Open:

```text
http://<hub-ip>:3000
```

Create the first account, then sign in.

HomeBrain browser sessions are stored in `HttpOnly` cookies set by the server. If login behaves strangely after an upgrade from an older build, sign out once and sign back in so the browser drops any legacy local token state. The native iOS app remains a bearer-token client and keeps its 365-day refresh-session default.

## 2. General Settings

Open `Settings -> General`.

Use this tab for the main system behavior and defaults. Save once after reviewing the screen so the database stores your baseline configuration.

## 3. Voice And Audio

Open `Settings -> Voice & Audio`.

This is where you configure:

- local or cloud speech-to-text
- cloud text-to-speech providers
- wake-word sensitivity
- wake-word models and Piper voices

Recommended beginner path:

1. Leave advanced values alone at first
2. Add optional cloud API keys only if you want them
3. Use the default wake-word tooling in the UI

If you want local speech-to-text:

- install Whisper models from the `Whisper` page
- Jetson is the best-tested hardware for that

## 4. Integrations

Open `Settings -> Integrations`.

Current integration areas in the UI:

- SmartThings
- Ecobee
- Logitech Harmony Hub
- INSTEON / ISY

Practical guidance:

- SmartThings: use OAuth, not a short-lived PAT
- Ecobee: configure OAuth and test before syncing devices
- Harmony: discover hubs, then sync activities to devices
- INSTEON: use a real serial path or a serial-to-TCP bridge; the PLM is not an Ethernet device
- ISY: use the built-in test, extract, preview, and sync tools from the same settings area

## 5. User Profiles

Open `User Profiles`.

Each profile can hold:

- name
- prompt / personality
- voice
- wake words

Profiles are what let HomeBrain answer like different family members or assistants.

## 6. Remote Voice Devices

Open `Voice Devices`.

To add a listener:

1. Click `Add Remote Device`
2. Enter the name and room
3. Copy the generated one-command installer
4. Run it on the listener device

The current system supports Raspberry Pi best, but other Debian/Ubuntu-based Linux listeners can also be used.

## 7. Remote Wall Panels

Wall panels are now a separate hardware path from Linux voice listeners.

Current support targets the ELECROW `2.1"` round ESP32-S3 rotary display first. The panel talks to HomeBrain over `Wi-Fi` using the dedicated `/api/panels` API.

Current setup flow:

1. Open `Settings -> Hardware Orbs`
2. Create the orb and reveal its setup packet
3. Flash the firmware in [`../embedded/elecrow-wall-panel`](../embedded/elecrow-wall-panel)
4. Finish thermostat, scene, device, security, and Harmony mappings back in the same tab

Use the full runbook here:

- [`elecrow-wall-panel.md`](elecrow-wall-panel.md)

Current note:

- provisioning and room bindings now live in the dedicated `Hardware Orbs` Settings tab

## 8. Scenes And Workflows

Current structure:

- `Scenes`: reusable grouped device actions
- `Workflows`: the primary builder for triggers, schedules, logic, visual editing, and AI generation
- `Automations`: internal runtime records generated from workflows for scheduling and execution

Recommended order:

1. Create devices and profiles first
2. Build scenes second
3. Build routines in `Workflows`
4. Treat `Automations` as runtime internals rather than a separate user-facing editor

Runtime behavior:

- `device_state` and `sensor` workflows run on the false-to-true trigger edge so they do not repeat every scheduler tick.
- If a running workflow was started by a state trigger and that trigger stops matching before the workflow finishes, HomeBrain records a stop request and cancels the workflow. This is what keeps countdown routines, such as bathroom fan auto-off timers, from completing after the switch has already been turned back off.
- The native iOS workflow editor can create countdown workflows with a hold time, delay, triggering-device target, cooldown, and full raw trigger/action JSON for workflows originally built in the web editor.

## 9. Operations And Deploy

Open:

- `Operations` for event monitoring and health visibility
- `Platform Deploy` for git pull/build/restart jobs

Use `Platform Deploy` only after the host itself is already stable and working.

## 10. SSL

Open `SSL` if you want HomeBrain reachable at a public HTTPS domain.

You only need this if:

- you want internet-reachable access
- or an external integration requires a public HTTPS endpoint

If you only use HomeBrain inside your LAN, plain `http://<hub-ip>:3000` is enough.

## 11. Security Baseline

For public deployments:

- set `HOMEBRAIN_PUBLIC_BASE_URL`
- set `COOKIE_SECURE=true`
- set `CORS_ALLOWED_ORIGINS` to the exact HTTPS origins that should use browser credentials
- keep `AUTH_SESSION_MAX_AGE_DAYS=30` for browsers and `AUTH_IOS_SESSION_MAX_AGE_DAYS=365` for the native iOS app unless you intentionally want a different policy
- keep real secrets only in `server/.env`
- run `bash scripts/check-secrets.sh --history` before pushing

Full checklist:

- [`security.md`](security.md)

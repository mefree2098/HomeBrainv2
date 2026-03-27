# HomeBrain Configuration Guide

Use this after the hub is installed and reachable in a browser.

## 1. First Login

Open:

```text
http://<hub-ip>:3000
```

Create the first account, then sign in.

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

## 7. Scenes And Workflows

Current structure:

- `Scenes`: reusable grouped device actions
- `Workflows`: the primary builder for triggers, schedules, logic, visual editing, and AI generation
- `Automations`: internal runtime records generated from workflows for scheduling and execution

Recommended order:

1. Create devices and profiles first
2. Build scenes second
3. Build routines in `Workflows`
4. Treat `Automations` as runtime internals rather than a separate user-facing editor

## 8. Operations And Deploy

Open:

- `Operations` for event monitoring and health visibility
- `Platform Deploy` for git pull/build/restart jobs

Use `Platform Deploy` only after the host itself is already stable and working.

## 9. SSL

Open `SSL` if you want HomeBrain reachable at a public HTTPS domain.

You only need this if:

- you want internet-reachable access
- or an external integration requires a public HTTPS endpoint

If you only use HomeBrain inside your LAN, plain `http://<hub-ip>:3000` is enough.

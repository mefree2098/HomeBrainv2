# HomeBrain Configuration Guide

This guide covers what to configure in the UI after initial install.

## 1. First Login

1. Open `http://<hub-ip>:5173`
2. Register your first account
3. Sign in

Expected result: you land on `Dashboard`.

## 2. Core Voice Settings

Open `Settings -> Voice & Audio`.

Configure:
- LLM provider/model
- STT provider/model
- TTS provider and API key (if using ElevenLabs)

Recommended initial setup:
- STT: `On-device Whisper` with model `small` or `small.en`
- Voice response volume: start around mid-range

## 3. Integrations

Open `Settings -> Integrations`.

### SmartThings

1. Enter `SmartThings Client ID` and `SmartThings Client Secret` in `Settings -> Integrations`.
2. Click `Configure OAuth`.
3. Click `Connect SmartThings` and complete SmartThings authorization.
4. Test connection and sync devices.

#### SmartThings Home Monitor (Security Alarm bridge)

HomeBrain mirrors SmartThings Home Monitor (STHM) through virtual switches.

1. In SmartThings, create three virtual switches (Disarm, Arm Stay, Arm Away).
2. Create routines that keep these three switches one-hot:
   - When STHM mode changes, turn on the matching switch and turn the other two off.
   - When one bridge switch turns on, set STHM to the matching mode.
3. In `Settings -> Integrations -> SmartThings Home Monitor Bridge`, map each switch and save.
4. Use `Refresh Devices` after creating switches/routines if they are not listed yet.

Notes:
- New SmartThings PATs expire after 24 hours; prefer OAuth.
- SmartThings currently exposes security arm-state as an event subscription source, so HomeBrain relies on virtual-switch + webhook/event sync for control/state mirroring.

### INSTEON

The 2413S PLM RJ45 jack is a serial interface, not Ethernet networking.

Use one of these supported endpoint formats in `Settings -> Integrations -> INSTEON PLM Endpoint`:

1. Direct local serial:
`/dev/serial/by-id/usb-...` (recommended) or `/dev/ttyUSB0`
2. Serial-over-TCP bridge:
`tcp://<bridge-host>:<port>` (for example `tcp://192.168.1.50:9761`)

USB PLM note:
- 2413U USB PLMs often enumerate as `/dev/ttyUSB*` or `/dev/ttyACM*`.
- Prefer `/dev/serial/by-id/...` in HomeBrain settings so the path stays stable across reboots/USB reorder.

Recommended setup for "Ethernet cable" operation:

1. PLM -> RS-232 serial bridge device (or PLM WiFi/Ethernet adapter that exposes raw PLM TCP).
2. Jetson -> same network (built-in NIC or USB Ethernet adapter).
3. Set endpoint to `tcp://...` in HomeBrain settings.
4. Test connection from the INSTEON page.

#### Import devices from ISY and write links to a new USB PLM

Use this when ISY + old PLM stays in place and HomeBrain + new PLM is added as a second controller.

1. Copy device IDs from ISY Admin Console.
2. Ensure HomeBrain is connected to the new USB PLM (`POST /api/insteon/connect`).
3. Call:

```bash
curl -s -X POST http://127.0.0.1:3000/api/insteon/devices/import/isy \
  -H "Content-Type: application/json" \
  -d '{
    "deviceIds": ["AA.BB.CC", "11.22.33"],
    "group": 1,
    "linkMode": "remote",
    "retries": 1
  }'
```

Notes:
- `linkMode: "remote"` is the fastest option for known IDs.
- `linkMode: "manual"` supports set-button linking (one device at a time).
- Existing links are detected and skipped by default.

#### Full ISY scene/link clone (topology replay)

If you want the new PLM to mirror ISY scene behavior (controller/responder topology), replay scene topology:

1. Export/build an ISY topology payload (`scenes` or `linkRecords`).
2. Run dry-run first:

```bash
curl -s -X POST http://127.0.0.1:3000/api/insteon/devices/import/isy/topology \
  -H "Content-Type: application/json" \
  -d '{
    "dryRun": true,
    "scenes": [
      {
        "name": "Movie Lights",
        "group": 3,
        "controller": "gw",
        "responders": [
          {"id":"AA.BB.CC","level":20,"ramp":2000},
          {"id":"11.22.33","level":0}
        ]
      }
    ]
  }'
```

3. Apply for real by setting `"dryRun": false`.

#### Automatic extraction directly from ISY (devices + scenes + program stubs)

You can now pull metadata from ISY automatically, then import it into HomeBrain.

1. Configure ISY settings in `Settings` API fields:
   - `isyHost`, `isyPort`, `isyUsername`, `isyPassword`, `isyUseHttps`, `isyIgnoreTlsErrors`
2. Test ISY connectivity:

```bash
curl -s -X POST http://127.0.0.1:3000/api/insteon/isy/test -H "Content-Type: application/json" -d '{}'
```

3. Run dry-run sync (recommended first):

```bash
curl -s -X POST http://127.0.0.1:3000/api/insteon/isy/sync \
  -H "Content-Type: application/json" \
  -d '{"dryRun":true}'
```

4. Apply:

```bash
curl -s -X POST http://127.0.0.1:3000/api/insteon/isy/sync \
  -H "Content-Type: application/json" \
  -d '{"dryRun":false,"importDevices":true,"importTopology":true,"importPrograms":true}'
```

Notes:
- Program import translates ISY IF/THEN/ELSE into executable HomeBrain workflows with unified condition branching.
- Variable operations (`=`, `+=`, `-=`, `*=`, `/=`, `%=` and bitwise ops), `Wait`, and `Repeat` actions are translated into runtime-executable workflow actions.
- Program control actions (`Run/Stop/Enable/Disable`, `Set Program ... Run At Startup`) are translated into executable workflow-control actions.
- ISY `Network Resource` / `Resource` statements are translated into executable actions. HTTP/HTTPS resources become native HomeBrain `http_request` actions; non-HTTP resources use ISY passthrough execution by id/name.
- Any statements that still cannot be mapped are preserved as explicit notification steps for manual follow-up.
- Topology replay uses scene membership/controllers available via ISY REST metadata.
- Detailed parity matrix: [isy-program-capability-matrix.md](isy-program-capability-matrix.md)

### Logitech Harmony Hub

Open the `Logitech Harmony Hub Integration` card in `Settings -> Integrations`.

1. (Optional) Add known hub IPs/hosts in `Configured Harmony Hub IPs/Hosts`.
2. Click `Discover Hubs` to find hubs on your LAN.
3. Click `Sync Activities to Devices` to create Harmony Hub activity devices in HomeBrain.
4. Use those devices in automations and workflows.

Behavior notes:
- Harmony Hub activity devices support `turn_on`, `turn_off`, and `toggle`.
- `turn_on` starts that activity, `turn_off` powers the hub activity off.
- Discovered hubs stay listed in `Settings -> Integrations` with last device-sync and activity-state-sync status.

## 4. User Profiles (Voices + Personalities)

Open `User Profiles`.

For each profile:
- Name (for example Anna or Henry)
- Personality/system prompt
- Voice ID
- Wake words (comma-separated)

Expected result: profile appears as active and can be used by listeners.

## 5. Wake Word Models

Open `Settings -> Voice & Audio -> Wake Word Models`.

Before first training on a clean hub, run once:

```bash
cd ~/HomeBrainv2/server
PYTHON_BIN=python3 scripts/install-openwakeword-deps.sh
```

1. Download at least one Piper voice.
2. Create wake word phrase(s).
3. Wait for each model status to become `ready`.
4. Assign those phrases in `User Profiles`.

Detailed instructions: [wake-word-setup.md](wake-word-setup.md)

## 6. Add Listener Devices (Raspberry Pi)

Open `Voice Devices`.

1. Click `Add Remote Device`.
2. Enter name + room.
3. Copy one-command installer.
4. Run on the Pi.

Expected result: device comes online and appears in the table.

## 7. Fleet Update Management

Still in `Voice Devices`, use the `Remote Fleet Updates` card:
- `Update + Verify Outdated Devices`
- `Verify Versions`

Expected result: online devices show latest version.

## 8. Hub Deployment from UI

Open `Platform Deploy`.

Use:
- `Pull + Deploy Latest` to update from GitHub
- `Restart Services` when needed

Expected result: job status is `completed` and logs show no failing steps.

## 9. SSL (Optional)

Open `SSL Certificates` for certificate setup and renewal management if using HTTPS on LAN/WAN.

## 10. Save/Backup Critical Config

Back up:
- `server/.env`
- MongoDB data
- `server/data`
- `server/public/wake-words`

## 11. Operations Monitoring

Open `Operations` (admin users).

Use it to:
- watch live events (workflows, deploys, fleet updates, voice commands),
- filter by source/type,
- confirm platform health checks remain `healthy`.

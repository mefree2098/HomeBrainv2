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

1. Create a SmartThings Personal Access Token.
2. Paste token in HomeBrain integration settings.
3. Test connection.
4. Sync devices.

### INSTEON

1. Connect the PLM via USB to the hub.
2. Set serial port (for example `/dev/ttyUSB0`) in integration settings.
3. Test connection.

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

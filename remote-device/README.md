# HomeBrain Remote Listener (Raspberry Pi)

This package runs a HomeBrain room listener on Raspberry Pi.

Recommended hardware:
- Raspberry Pi 5 or Pi 4
- Raspberry Pi OS Lite 64-bit (Bookworm recommended)
- USB microphone + speaker

## Fastest Setup (Recommended)

Do this from the HomeBrain UI:
1. Open `Voice Devices`.
2. Click `Add Remote Device`.
3. Copy the generated one-command installer.
4. Run it on the Pi terminal.

Example command format:

```bash
curl -fsSL "http://<HUB_IP>:3000/api/remote-devices/<DEVICE_ID>/bootstrap.sh?code=<REGISTRATION_CODE>" | bash
```

Expected result:
- Pi installs dependencies
- Device registers automatically
- `homebrain-remote` service starts
- Device appears online in UI

## Verify Listener Service

On the Pi:

```bash
sudo systemctl status homebrain-remote --no-pager
sudo journalctl -u homebrain-remote -f
```

## Manual Install (Fallback)

Use this only if bootstrap is unavailable.

1. Copy this `remote-device` folder to the Pi.
2. Run installer:

```bash
cd ~/remote-device
bash install.sh
```

3. Register device:

```bash
cd ~/homebrain-remote
./register.sh <REGISTRATION_CODE> http://<HUB_IP>:3000
```

4. Start and enable service:

```bash
sudo systemctl enable --now homebrain-remote
```

## Audio Test

```bash
cd ~/homebrain-remote
./test-audio.sh
```

## Update Listener Code

Preferred: use HomeBrain UI `Voice Devices -> Remote Fleet Updates`.

Manual fallback:

```bash
cd ~/homebrain-remote
npm install
sudo systemctl restart homebrain-remote
```

## Wake Word Notes

- Wake word models are generated on the hub and synced to listeners automatically.
- If wake word updates do not apply, restart listener service and check logs.


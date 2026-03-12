# HomeBrain Remote Listener

This package runs a HomeBrain room listener on a Linux device with a microphone and speaker.

Best-tested hardware:

- Raspberry Pi 4 or 5
- Raspberry Pi OS Lite 64-bit

Also supported:

- other Debian/Ubuntu-based `amd64` or `arm64` Linux devices

If you are not using a Raspberry Pi, use a Debian/Ubuntu-based Linux system with a working microphone, speaker, and network connection.

## Recommended Setup

Do this from the HomeBrain UI:

1. Open `Voice Devices`
2. Click `Add Remote Device`
3. Copy the generated one-command installer
4. Run it on the listener device

Example:

```bash
curl -fsSL "http://<HUB_IP>:3000/api/remote-devices/<DEVICE_ID>/bootstrap.sh?code=<REGISTRATION_CODE>" | bash
```

## Verify The Service

```bash
sudo systemctl status homebrain-remote --no-pager
sudo journalctl -u homebrain-remote -f
```

## Manual Install

If you want to install from a copied checkout instead:

```bash
cd remote-device
bash install.sh
```

Then register it:

```bash
cd ~/homebrain-remote
./register.sh <REGISTRATION_CODE> http://<HUB_IP>:3000
```

## Audio Test

```bash
cd ~/homebrain-remote
./test-audio.sh
```

## Updates

Preferred:

- use `Voice Devices -> Remote Fleet Updates` in the HomeBrain UI

Fallback:

```bash
cd ~/homebrain-remote
npm install --no-audit --no-fund
sudo systemctl restart homebrain-remote
```

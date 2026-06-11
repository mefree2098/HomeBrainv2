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
curl -fsSL "http://<HUB_IP>:3000/api/remote-devices/<DEVICE_ID>/bootstrap.sh?claim=<CLAIM_TOKEN>" | bash
```

The generated installer activates the listener, stores the hub URL, and saves a device token used for authenticated device-side APIs.

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

Then activate it with a generated registration code or claim token:

```bash
cd ~/homebrain-remote
./register.sh --registration-code <REGISTRATION_CODE> --hub http://<HUB_IP>:3000
./register.sh --claim-token <CLAIM_TOKEN> --device-id <DEVICE_ID> --hub http://<HUB_IP>:3000
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
npm ci --no-audit --no-fund
sudo systemctl restart homebrain-remote
```

If the listener was installed before HomeBrain added device-token authentication, rerun the one-command installer from `Voice Devices` so `config.json` receives a `deviceToken`.

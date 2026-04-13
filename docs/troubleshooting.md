# HomeBrain Troubleshooting

## First Checks

```bash
bash scripts/setup-services.sh status
bash scripts/setup-services.sh health
```

If HomeBrain is healthy:

- `mongod` is running
- `homebrain` is running
- `http://localhost:3000/ping` responds

## HomeBrain Does Not Open In The Browser

Check:

```bash
sudo journalctl -u homebrain -n 120 --no-pager
sudo ss -lntup | grep -E '(:3000|:443|:80)\b'
```

Fix:

```bash
bash scripts/setup-services.sh restart
```

If the app still fails, confirm [`server/.env`](../server/.env) exists and the database URL is valid.

## Login Problems

Make sure `JWT_SECRET` and `REFRESH_TOKEN_SECRET` exist in `server/.env`, then restart HomeBrain.

## Platform Deploy Fails

Common reasons:

- the git checkout has local changes
- the server cannot reach git remotes
- the service cannot be restarted

Check:

```bash
git status --short
git remote -v
```

If the repo is dirty, commit or stash your work first.

## Remote Listener Will Not Come Online

On the listener:

```bash
sudo systemctl status homebrain-remote --no-pager
sudo journalctl -u homebrain-remote -n 120 --no-pager
```

Typical fixes:

- rerun the one-command installer from `Voice Devices`
- confirm the listener can reach `http://<hub-ip>:3000`
- confirm the registration code or claim token is current

## ELECROW Wall Panel Will Not Come Online

On the machine you use to flash the device:

```bash
cd embedded/elecrow-wall-panel
pio device monitor -b 115200
```

Typical fixes:

- if `pio run` fails after an older attempt, remove `embedded/elecrow-wall-panel/.pio`, pull the latest repo changes, and rebuild so PlatformIO picks up the bundled `HomeBrainArduinoGFXCompat` display library
- if upload fails right after the ESP32-S3 stub starts, pull the latest repo changes before retrying; the checked-in `platformio.ini` now pins a slower `115200` upload speed and `--no-stub` for this board family
- if `Push Code Update` is unavailable or OTA updates fail immediately, make sure the panel has been flashed once with the newer OTA-capable partition layout from the latest repo checkout
- confirm the values in [`../embedded/elecrow-wall-panel/include/HomeBrainPanelConfig.h`](../embedded/elecrow-wall-panel/include/HomeBrainPanelConfig.h) are correct, especially `Wi-Fi`, hub URL, panel ID, and registration code
- confirm the panel can reach the hub URL you compiled into the firmware
- confirm the panel record still exists by calling `GET /api/panels` as an admin
- confirm the registration code still works with `GET /api/panels/:id/state`
- if the panel shows `Building` or `Ready for Orb` in `Settings -> Hardware Orbs` but never installs the update, confirm the orb is online and check that the HomeBrain host can still build `embedded/elecrow-wall-panel` locally with `pio run`
- if the device is wall-mounted, verify the USB-C power source is stable and not browning out the board during `Wi-Fi` activity
- if you bought the smaller `1.28"` board, do not flash the `2.1"` board profile unchanged

Useful check:

```bash
curl -sS "$HUB_URL/api/panels/$PANEL_ID/state" \
  -H "X-HomeBrain-Panel-Code: $PANEL_CODE" \
  | python3 -m json.tool
```

More detail:

- [`elecrow-wall-panel.md`](elecrow-wall-panel.md)

## Wake Word Is Not Triggering

Check in the UI:

- `Voice Devices`: the listener is online
- `User Profiles`: the wake word is assigned
- `Settings -> Voice & Audio`: the wake word model is ready

If wake-word training dependencies are missing on the hub:

```bash
cd server
PYTHON_BIN=python3 scripts/install-openwakeword-deps.sh
sudo systemctl restart homebrain
```

## Local Whisper Problems

Open the `Whisper` page and look at:

- installed models
- active model
- logs

On non-Jetson hosts, local Whisper may run on CPU and be slower. That is expected.

## Ollama Problems

Open the `Ollama` page and verify:

- Ollama is installed
- the service is running
- a model is available locally

If the UI cannot install, update, or stop Ollama on Linux/Jetson, repair the host helper and restart HomeBrain:

```bash
cd ~/HomeBrainv2
bash scripts/setup-services.sh refresh-privileges
sudo systemctl restart homebrain
```

Optional checks:

```bash
sudo -n /usr/local/lib/homebrain/ollama-host-control.sh probe && echo helper-ok
systemctl show homebrain -p NoNewPrivileges
```

Expected results:

- `helper-ok`
- `NoNewPrivileges=no`

More detail:

- [`ollama-management.md`](ollama-management.md)

## INSTEON / PLM Problems

Important:

- the PLM is serial hardware, not Ethernet hardware
- a direct hub Ethernet cable to the PLM will not work

Supported connection styles:

- local serial path
- serial-to-TCP bridge

Detailed service behavior and regression notes:

- [`insteon-service.md`](insteon-service.md)

If serial access fails, confirm the host can see the serial device and that the HomeBrain user has permission to use it.

## MongoDB Problems

Check:

```bash
sudo systemctl status mongod --no-pager
mongosh --quiet "mongodb://localhost/HomeBrain" --eval "db.runCommand({ ping: 1 })"
```

If MongoDB is down, start it:

```bash
sudo systemctl restart mongod
```

## Need More Detail

Use the live event feed in `Operations` plus:

```bash
bash scripts/setup-services.sh logs follow
```

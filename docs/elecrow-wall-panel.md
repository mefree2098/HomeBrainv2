# HomeBrain ELECROW Wall Panel Guide

This guide covers the new HomeBrain wall-panel path for ELECROW round ESP32-S3 rotary displays.

The panel talks directly to the HomeBrain hub over `Wi-Fi`. It does not run the Linux `remote-device` listener stack. Instead, it uses the compact `/api/panels` endpoints added for dedicated room control surfaces.

## Recommended Hardware

Primary firmware target in this repo:

- ELECROW CrowPanel `2.1"` round ESP32-S3 rotary display product page: [elecrow.com](https://www.elecrow.com/crowpanel-2-1inch-hmi-esp32-rotary-display-480-480-ips-round-touch-knob-screen.html)
- Official `2.1"` hardware wiki / pinout / flashing notes: [elecrow.com wiki](https://www.elecrow.com/wiki/CrowPanel_2.1inch-HMI_ESP32_Rotary_Display_480_IPS_Round_Touch_Knob_Screen.html)
- Official vendor firmware/examples: [GitHub](https://github.com/Elecrow-RD/CrowPanel-2.1inch-HMI-ESP32-Rotary-Display-480-480-IPS-Round-Touch-Knob-Screen)

Smaller sibling in the same hardware family:

- Amazon listing for the `1.28"` round board family: [amazon.com](https://www.amazon.com/dp/B0G3TZGRC4)
- Official `1.28"` wiki: [elecrow.com wiki](https://www.elecrow.com/wiki/CrowPanel_1.28inch-HMI_ESP32_Rotary_Display.html)

Important scope note:

- The firmware currently checked into this repository targets the ELECROW `2.1"` rotary CrowPanel first.
- The `1.28"` board uses the same HomeBrain backend flow, but it still needs its own board profile, pin map, and UI scaling pass before you should flash this exact firmware onto it unchanged.

## What HomeBrain Supports On This Device

The current firmware and backend support five swipeable modes:

- `Thermostat`: room temperature, setpoint adjustment from the knob, touchable HVAC mode actions, and optional long-press `Bedtime`
- `Room`: quick control tiles for lights, switches, speakers, locks, garage devices, and scenes
- `Home`: whole-home security state, alerts, and quick actions
- `Media`: Harmony activities plus knob-based volume and button transport commands
- `Quiet`: bedtime, morning, white-noise, lock-up, and night-light shortcuts

Visual direction:

- dark glass cockpit background
- cyan/blue/purple neon accents
- swipeable pages instead of nested menus
- compact payloads so the ESP32 does not need the full web app schema

## Before You Start

You need:

- a working HomeBrain hub already installed
- an admin account that can call the HomeBrain API
- reachable `Wi-Fi` for the panel and the hub on the same LAN or otherwise routable network
- a USB-C cable and a stable `5V` USB power supply
- `PlatformIO` on the machine you will use to build and flash the firmware

If the hub is not installed yet, start here:

- Full hub deployment: [../DEPLOYMENT.md](../DEPLOYMENT.md)
- Post-install configuration: [configuration.md](configuration.md)

For `PlatformIO`, use the official docs:

- PlatformIO Core install docs: [docs.platformio.org](https://docs.platformio.org/en/stable/core/installation/index.html)
- macOS Homebrew install: [docs.platformio.org](https://docs.platformio.org/en/stable/core/installation/methods/brew.html)

## 1. Install And Start HomeBrain

Get the hub running first, then create your first account in the browser.

Typical local URL:

```text
http://<hub-ip>:3000
```

The wall panel must use a hub URL that is reachable from the panel itself. Do not use `localhost` in the firmware header.

## 2. Get An Admin API Token

Set your hub URL and admin credentials:

```bash
export HUB_URL="http://<hub-ip>:3000"
export ADMIN_EMAIL="you@example.com"
export ADMIN_PASSWORD="your-password"
```

Log in and extract the `accessToken`:

```bash
export ADMIN_TOKEN="$(
  curl -sS -X POST "$HUB_URL/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['accessToken'])"
)"
```

If that prints nothing, verify the account by logging into the web UI first.

## 3. Register The Panel In HomeBrain

Create a panel record:

```bash
export PANEL_JSON="$(
  curl -sS -X POST "$HUB_URL/api/panels/register" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "name": "Master Bedroom Orb",
      "room": "Master Bedroom",
      "hardwareProfile": "elecrow-crowpanel-2.1-rotary"
    }'
)"
```

Extract the values the firmware needs:

```bash
export PANEL_ID="$(printf '%s' "$PANEL_JSON" | python3 -c "import sys, json; print(json.load(sys.stdin)['panel']['id'])")"
export PANEL_CODE="$(printf '%s' "$PANEL_JSON" | python3 -c "import sys, json; print(json.load(sys.stdin)['panel']['settings']['registrationCode'])")"
printf 'Panel ID: %s\nRegistration code: %s\n' "$PANEL_ID" "$PANEL_CODE"
```

Optional: fetch the compact bootstrap payload that mirrors the firmware header values:

```bash
curl -sS "$HUB_URL/api/panels/$PANEL_ID/bootstrap" \
  -H "X-HomeBrain-Panel-Code: $PANEL_CODE" \
  | python3 -m json.tool
```

## 4. Configure The Firmware Header

Edit [HomeBrainPanelConfig.h](~/HomeBrainv2/embedded/elecrow-wall-panel/include/HomeBrainPanelConfig.h) and replace the placeholder values:

- `HOMEBRAIN_PANEL_WIFI_SSID`
- `HOMEBRAIN_PANEL_WIFI_PASSWORD`
- `HOMEBRAIN_PANEL_HUB_URL`
- `HOMEBRAIN_PANEL_ID`
- `HOMEBRAIN_PANEL_REGISTRATION_CODE`
- `HOMEBRAIN_PANEL_HOSTNAME`

Use a hub URL the panel can actually reach, for example:

- `http://192.168.1.50:3000`
- `http://homebrain.local:3000` if your LAN resolves mDNS properly
- your internal DNS name if you already run one

## 5. Install PlatformIO

On macOS, the fastest path is:

```bash
brew install platformio
```

If you prefer another OS-specific method, use the official PlatformIO docs linked above.

## 6. Build And Flash The Firmware

From the repo root:

```bash
cd embedded/elecrow-wall-panel
pio run
pio run -t upload
```

If you have more than one serial device attached, specify the upload port explicitly:

```bash
pio run -t upload --upload-port /dev/tty.usbmodemXXXX
```

Open a serial monitor while it boots:

```bash
pio device monitor -b 115200
```

The firmware will:

- join `Wi-Fi`
- call `POST /api/panels/:id/activate`
- poll `GET /api/panels/:id/state`
- send touch/knob actions to `POST /api/panels/:id/actions`

## 7. Verify The Panel Is Reaching HomeBrain

You can check the current state payload manually:

```bash
curl -sS "$HUB_URL/api/panels/$PANEL_ID/state" \
  -H "X-HomeBrain-Panel-Code: $PANEL_CODE" \
  | python3 -m json.tool
```

List all registered panels:

```bash
curl -sS "$HUB_URL/api/panels" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python3 -m json.tool
```

At this point, the display should stop showing the boot placeholder and start rendering HomeBrain state.

## 8. Find Device And Scene IDs

Panel bindings are API-driven right now.

Useful discovery calls:

```bash
curl -sS "$HUB_URL/api/devices?room=Master%20Bedroom" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python3 -m json.tool
```

```bash
curl -sS "$HUB_URL/api/scenes" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python3 -m json.tool
```

Use those responses to collect the device IDs and scene IDs you want on the panel.

## 9. Bind Thermostat, Room, Home, Media, And Quiet Actions

Update the panel settings with the entities you want the room control to drive:

```bash
curl -sS -X PUT "$HUB_URL/api/panels/$PANEL_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "settings": {
      "thermostat": {
        "deviceId": "THERMOSTAT_DEVICE_ID",
        "sensorDeviceId": "BEDROOM_SENSOR_DEVICE_ID",
        "bedtimeSceneId": "SCENE_ID_BEDTIME"
      },
      "roomControl": {
        "favoriteDeviceIds": ["BEDROOM_LIGHT_ID", "BEDROOM_FAN_ID"],
        "sceneIds": ["SCENE_ID_GOOD_MORNING"]
      },
      "harmony": {
        "hubIp": "192.168.1.99",
        "activityIds": ["WATCH_TV_ACTIVITY_ID", "APPLE_TV_ACTIVITY_ID"],
        "commandDeviceId": "HARMONY_COMMAND_DEVICE_ID"
      },
      "quietHouse": {
        "bedtimeSceneId": "SCENE_ID_BEDTIME",
        "morningSceneId": "SCENE_ID_GOOD_MORNING",
        "whiteNoiseSceneId": "SCENE_ID_WHITE_NOISE",
        "lockUpSceneId": "SCENE_ID_LOCK_UP",
        "nightLightDeviceId": "NIGHT_LIGHT_DEVICE_ID"
      }
    }
  }' \
  | python3 -m json.tool
```

Practical defaults:

- map the thermostat page to the actual bedroom thermostat device if you have one
- use a dedicated bedroom temperature sensor if the thermostat hardware is elsewhere
- keep room-control favorites to only the most important two to four devices
- treat `Quiet` as the "one tap before sleep" surface

## 10. Day-To-Day Use

The default interaction model is:

- swipe left or right to move between `Thermostat`, `Room`, `Home`, `Media`, and `Quiet`
- rotate the knob on `Thermostat` to change setpoint
- rotate the knob on `Media` to send volume up and down
- short press the knob on `Media` for `PlayPause`
- long press the knob on `Thermostat` to trigger `Bedtime` if you bound it
- tap the quick tiles to change HVAC mode, run scenes, control devices, or trigger whole-home actions

## Power And Wall Mounting

This device should be powered from regulated `5V` USB power, not from raw thermostat wiring.

Recommended bedroom wall-mount approach:

1. Mount the panel near a recessed outlet, low-voltage box, or hidden cable path.
2. Use a compact, always-on USB power adapter or a listed in-wall USB power module.
3. Run a short USB-C cable to the panel.
4. If you want the panel where a thermostat used to be, convert that location to clean `5V DC` first with an appropriate listed converter. Do not land `24VAC` thermostat wires directly on the board.

Practical guidance:

- a right-angle USB-C cable usually makes the cleanest flush mount
- test `Wi-Fi` signal strength at the exact wall location before final mounting
- if you need a truly invisible install, plan the power path before printing or fabricating the wall bracket

The `2.1"` CrowPanel family is a much better candidate for a bedside thermostat puck or scene controller than a Linux voice listener, because it is small, silent, touch-first, and already has the rotary control we need.

## Current Limitations

- current repo firmware targets the ELECROW `2.1"` rotary board first
- the `1.28"` board family still needs its own board profile before flashing this exact firmware
- `Wi-Fi` credentials are compiled into the firmware header today
- there is not yet a dedicated wall-panel management page in the HomeBrain web UI
- the panel currently polls for state rather than using a live push channel

## Related Docs

- Top-level project README: [../README.md](../README.md)
- Hub deployment: [../DEPLOYMENT.md](../DEPLOYMENT.md)
- HomeBrain configuration: [configuration.md](configuration.md)
- Admin guide: [admin-guide.md](admin-guide.md)
- Troubleshooting: [troubleshooting.md](troubleshooting.md)
- Firmware folder README: [../embedded/elecrow-wall-panel/README.md](../embedded/elecrow-wall-panel/README.md)

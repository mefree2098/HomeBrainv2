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

The orb also appends one local on-device surface:

- `Settings`: persistent brightness control plus local orb utilities such as restart

The orb now also supports:

- full `Settings -> Hardware Orbs` provisioning and room binding in the UI
- searchable, filterable supported-device selection for the room surface
- HomeBrain-managed `OTA` firmware updates after the first USB flash of the OTA-capable firmware

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

## 2. Create The Orb In Settings

Open:

`Settings -> Hardware Orbs`

From there:

1. Click `New Orb`
2. Enter the orb name and room
3. Choose the hardware profile
4. Click `Generate Setup Token`
5. Open the orb’s `Setup Packet`

The setup packet gives you:

- the current orb setup token
- the HomeBrain panel ID
- a copyable firmware header snippet
- the hub URL HomeBrain expects the orb to use

## 3. Configure The Firmware Header

Open [HomeBrainPanelConfig.h](../embedded/elecrow-wall-panel/include/HomeBrainPanelConfig.h) and replace the placeholder values.

You provide these local network values yourself:

- `HOMEBRAIN_PANEL_WIFI_SSID`
- `HOMEBRAIN_PANEL_WIFI_PASSWORD`
- `HOMEBRAIN_PANEL_HOSTNAME`

The `Hardware Orbs` setup packet in the UI gives you the HomeBrain values for:

- `HOMEBRAIN_PANEL_HUB_URL`
- `HOMEBRAIN_PANEL_ID`
- `HOMEBRAIN_PANEL_REGISTRATION_CODE`

Use a hub URL the panel can actually reach, for example:

- `http://192.168.1.50:3000`
- `http://homebrain.local:3000` if your LAN resolves mDNS properly
- your internal DNS name if you already run one

Tip:

- if your HomeBrain web app is opened at a public domain, the setup packet will default to that URL
- for in-home wall panels, you may prefer replacing it with a LAN-local URL before flashing

## 4. Install PlatformIO

On macOS, the fastest path is:

```bash
brew install platformio
```

If you prefer another OS-specific method, use the official PlatformIO docs linked above.

## 5. Build And Flash The Firmware

From the repo root:

```bash
cd embedded/elecrow-wall-panel
pio run
pio run -t upload
```

Build note:

- this firmware now ships with a bundled ELECROW-compatible Arduino-GFX subset in `embedded/elecrow-wall-panel/lib/HomeBrainArduinoGFXCompat`
- if you previously tried building an older checkout and `pio run` failed with graphics-library errors, delete `embedded/elecrow-wall-panel/.pio` after pulling the latest repo changes and then run `pio run` again
- the checked-in `platformio.ini` now uses a conservative `115200` upload speed plus `--no-stub`, because that is the most reliable flash path on the CrowPanel USB serial interface

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

Important OTA note:

- this build now uses an OTA-capable partition layout
- you must flash this newer firmware over USB at least once before future `Push Code Update` actions in the UI can work over `Wi-Fi`

## 6. Verify The Panel Is Reaching HomeBrain

Go back to:

`Settings -> Hardware Orbs`

Use the orb card and detail view to verify:

- the orb moved from `Waiting for first activation` to a provisioned state
- the status is `Online`
- the orb reports an IP address and firmware version

At this point, the display should stop showing the boot placeholder and start rendering HomeBrain state.

## 7. Bind Thermostat, Room, Home, Media, And Quiet Actions

Stay in:

`Settings -> Hardware Orbs`

Select the orb and configure:

- `Thermostat Surface`: thermostat device, temperature sensor, and bedtime long-press scene
- `Room Surface`: room scenes plus up to four pinned device controls chosen from a searchable, filterable full-home supported-device list
- `Media Surface`: Harmony hub, activity shortcuts, and command device for the knob
- `Quiet Surface`: bedtime, morning, white-noise, lock-up, and night-light targets

Save the orb when you are happy with the mappings.

Practical defaults:

- map the thermostat page to the actual bedroom thermostat device if you have one
- use a dedicated bedroom temperature sensor if the thermostat hardware is elsewhere
- keep room-control favorites to only the most important two to four devices
- treat `Quiet` as the "one tap before sleep" surface

## 8. OTA Firmware Updates From The UI

After the orb has been flashed once with the current OTA-capable firmware and has come online:

1. Open `Settings -> Hardware Orbs`
2. Select the orb
3. Open the `Firmware Updates` card
4. Click `Push Code Update`

HomeBrain will:

- build the latest checked-in firmware on the HomeBrain host
- stage an authenticated OTA package for that orb
- let the orb download the update over `Wi-Fi`
- show build/download/install/reboot progress back in the `Hardware Orbs` UI
- mark the orb online again after it reboots and reports the new firmware version

Operational notes:

- the orb must already be provisioned and able to reach the hub over `Wi-Fi`
- OTA updates depend on the new OTA partition table, so older pre-OTA USB flashes need one manual refresh first
- if the orb is offline when you queue an update, HomeBrain can build the package, but the install will wait until the orb reconnects
## 9. Advanced Manual API Fallback

If you are troubleshooting or automating this flow outside the UI, the backend still exposes `/api/panels` for manual registration, provisioning, and updates. The intended day-to-day operator path is now the `Hardware Orbs` Settings tab.

## 10. Day-To-Day Use

The default interaction model is:

- swipe left or right to move between `Thermostat`, `Room`, `Home`, `Media`, and `Quiet`
- keep swiping to reach the local `Settings` page for on-device options such as brightness
- rotate the knob on `Thermostat` to change setpoint
- rotate the knob on `Media` to send volume up and down
- rotate the knob on `Settings` to dim or brighten the orb and save that preference on the device
- short press the knob on `Media` for `PlayPause`
- long press the knob on `Thermostat` to trigger `Bedtime` if you bound it
- tap the quick tiles to change HVAC mode, run scenes, control devices, or trigger whole-home actions

## 11. Power And Wall Mounting

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

## 12. Current Limitations

- current repo firmware targets the ELECROW `2.1"` rotary board first
- the `1.28"` board family still needs its own board profile before flashing this exact firmware
- `Wi-Fi` credentials are compiled into the firmware header today
- the panel currently polls for state rather than using a live push channel

## Related Docs

- Top-level project README: [../README.md](../README.md)
- Hub deployment: [../DEPLOYMENT.md](../DEPLOYMENT.md)
- HomeBrain configuration: [configuration.md](configuration.md)
- Admin guide: [admin-guide.md](admin-guide.md)
- Troubleshooting: [troubleshooting.md](troubleshooting.md)
- Firmware folder README: [../embedded/elecrow-wall-panel/README.md](../embedded/elecrow-wall-panel/README.md)

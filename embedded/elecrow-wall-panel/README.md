# HomeBrain ELECROW Wall Panel

This firmware targets the ELECROW `2.1"` round ESP32-S3 rotary display as a dedicated HomeBrain wall panel.

Canonical deployment guide:

- [`../../docs/elecrow-wall-panel.md`](../../docs/elecrow-wall-panel.md)

Hardware links:

- Buy the primary `2.1"` target board: [elecrow.com](https://www.elecrow.com/crowpanel-2-1inch-hmi-esp32-rotary-display-480-480-ips-round-touch-knob-screen.html)
- `2.1"` official wiki and board details: [elecrow.com wiki](https://www.elecrow.com/wiki/CrowPanel_2.1inch-HMI_ESP32_Rotary_Display_480_IPS_Round_Touch_Knob_Screen.html)
- Vendor examples and reference code: [GitHub](https://github.com/Elecrow-RD/CrowPanel-2.1inch-HMI-ESP32-Rotary-Display-480-480-IPS-Round-Touch-Knob-Screen)
- Smaller `1.28"` sibling family on Amazon: [amazon.com](https://www.amazon.com/dp/B0G3TZGRC4)
- `1.28"` official wiki: [elecrow.com wiki](https://www.elecrow.com/wiki/CrowPanel_1.28inch-HMI_ESP32_Rotary_Display.html)

Important:

- The repo firmware currently targets the `2.1"` board first.
- The `1.28"` board uses the same HomeBrain backend path but still needs its own board profile before flashing this exact firmware unchanged.

The firmware talks to HomeBrain over `Wi-Fi` and uses the new `/api/panels` backend endpoints to fetch:

- a compact five-mode state payload
- thermostat details and setpoint control
- room control tiles
- whole-home security and garage status
- Harmony activity and transport controls
- quiet-house / bedtime shortcuts

## Visual Direction

The UI intentionally mirrors the HomeBrain iOS app:

- dark cockpit background
- cyan/blue glass panels
- soft neon accents
- swipeable surfaces instead of nested menus

## Current Interaction Model

- Swipe left/right: move between `Thermostat`, `Room`, `Home`, `Media`, and `Quiet`
- Rotate knob:
  - `Thermostat`: change setpoint
  - `Media`: send `VolumeUp` / `VolumeDown`
- Short press:
  - `Media`: `PlayPause`
- Long press:
  - `Thermostat`: trigger `Bedtime` when configured

## Setup

1. Follow the full deployment guide in [`../../docs/elecrow-wall-panel.md`](../../docs/elecrow-wall-panel.md) for hub install, admin login, token creation, and panel registration.

2. Register a panel in HomeBrain as an admin:

```bash
curl -X POST "$HUB_URL/api/panels/register" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Master Bedroom Orb",
    "room": "Master Bedroom",
    "hardwareProfile": "elecrow-crowpanel-2.1-rotary"
  }'
```

3. Copy the returned `panel.id` and `panel.settings.registrationCode` into [HomeBrainPanelConfig.h](~/HomeBrainv2/embedded/elecrow-wall-panel/include/HomeBrainPanelConfig.h).

4. Build and flash:

```bash
cd embedded/elecrow-wall-panel
pio run
pio run -t upload
```

5. After the panel boots, bind its HomeBrain targets:

```bash
curl -X PUT "$HUB_URL/api/panels/$PANEL_ID" \
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
        "sceneIds": ["GOOD_MORNING_SCENE_ID"]
      },
      "harmony": {
        "hubIp": "192.168.1.99",
        "activityIds": ["ACTIVITY_WATCH_TV_ID", "ACTIVITY_APPLE_TV_ID"],
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
  }'
```

## Notes

- The backend panel API is intentionally compact so the ESP32 does not need to understand the full HomeBrain web schema.
- The first pass assumes a fixed Wi-Fi SSID/password in firmware. A captive portal can be layered on later.
- `PlatformIO` is not bundled in this repo. Install it locally before building.
- For wall mounting, power the board from regulated `5V` USB-C. Do not connect raw thermostat `24VAC` directly to the board.

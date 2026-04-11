# HomeBrain ELECROW Wall Panel

This project targets the ELECROW `2.1"` round ESP32-S3 rotary display as a dedicated HomeBrain bedroom wall panel.

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

1. Register a panel in HomeBrain as an admin:

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

2. Copy the returned `panel.id` and `panel.settings.registrationCode` into [HomeBrainPanelConfig.h](~/HomeBrainv2/embedded/elecrow-wall-panel/include/HomeBrainPanelConfig.h).

3. Build and flash:

```bash
cd embedded/elecrow-wall-panel
pio run
pio run -t upload
```

4. After the panel boots, bind its HomeBrain targets:

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

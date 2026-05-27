# SmartThings Physical Device Migration Plan

Last updated: 2026-05-26

This plan is based on the live HomeBrain inventory from `/api/devices`, the live SmartThings device list from `/api/smartthings/devices`, and the direct-radio status endpoint on 2026-05-26. It intentionally excludes virtual switches/helpers.

## Current Inventory

| Item | Count |
| --- | ---: |
| HomeBrain devices total | 273 |
| SmartThings-backed HomeBrain records | 147 |
| Direct Zigbee/Z-Wave migration candidates | 82 |
| Zigbee candidates | 57 |
| Z-Wave candidates | 25 |
| Physical but not direct-radio candidates | 30 |
| SmartThings hub or child endpoint records | 2 |
| Virtual switches/helpers skipped | 33 |

## Radio Readiness

- Zigbee controller is online: `/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_2275350e6ca4ef119f8aaf8086a24396-if00-port0` (SONOFF ZBDongle-P / TI CC2652P Z-Stack coordinator).
- Z-Wave controller is online: `/dev/serial/by-id/usb-Zooz_800_Z-Wave_Stick_533D004242-if00` (Zooz ZST39 LR / 800-series Z-Wave SerialAPI USB stick).
- Keep the SmartThings route alive for every device until HomeBrain-native state and controls are verified. Do not delete the SmartThings record first.
- Before starting in production, deploy the migration classifier update and run a SmartThings sync so HomeBrain has `smartThingsDeviceNetworkType` populated on existing records.

## Per-Device Execution Loop

Use this same loop for each device in the order below:

1. Open the device in HomeBrain and choose `Migrate to HomeBrain`.
2. Confirm the radio shown in the migration plan. Use Zigbee for `ZIGBEE`; use Z-Wave for `ZWAVE`.
3. For Z-Wave devices, start exclusion first from HomeBrain, trigger the device exclusion action, then start inclusion.
4. For Zigbee devices, start HomeBrain pairing, then reset or pair the physical device using the on-screen device profile instructions.
5. Wait for HomeBrain to create or update the native record, then verify state, control, battery/power data, room, groups, favorites, and automations.
6. Only after verification, hide or retire the old SmartThings-backed record. Keep rollback simple: if native pairing is bad, leave the SmartThings record active and try again later.

## Migration Order

### 1. Pilot pass

Do these first as a confidence-building pass. They exercise Zigbee outlet/power, Zigbee battery sensor, and Z-Wave switch flows without touching locks or core security.

| Device | Room | Radio | SmartThings type | Native features to verify |
| --- | --- | --- | --- | --- |
| Comms Closet | Downstairs | ZIGBEE | ZIGBEE | battery, contact, firmware, temperature |
| Christmas Tree | Energy Monitoring | ZIGBEE | ZIGBEE | firmware, power, switch |
| Air Purifier | Living Room | ZWAVE | ZWAVE | switch |

### 2. Powered mesh and controls

Build the mesh before moving lots of battery devices. Powered Zigbee repeaters and Z-Wave mains devices give the rest of the migration better routing.

| Device | Room | Radio | SmartThings type | Native features to verify |
| --- | --- | --- | --- | --- |
| Laundry Washer | Energy Monitoring | ZIGBEE | ZIGBEE | switch |
| Inside Theater Outlet Repeater | Janisary | ZIGBEE | ZIGBEE | firmware, switch |
| Outside Vault Outlet Repeater | Janisary | ZIGBEE | ZIGBEE | firmware, switch |
| Backyard Zigbee Repeater | Outside | ZIGBEE | ZIGBEE | firmware, power, switch |
| Garage Zigbee Repeater | Outside | ZIGBEE | ZIGBEE | firmware, power, switch |
| ISY | Downstairs | ZWAVE | ZWAVE | switch |
| Cold Storage Switch | Physical Switches | ZWAVE | ZWAVE | switch |
| Dishwasher Energy Monitor | Energy Monitoring | ZWAVE | ZWAVE | energy, power, switch |
| Dryer Energy Monitor | Energy Monitoring | ZWAVE | ZWAVE | energy, power, switch |
| Home AC Energy Monitor | Energy Monitoring | ZWAVE | ZWAVE | brightness, switch |
| Panel A Energy Monitor | Energy Monitoring | ZWAVE | ZWAVE | energy, power, switch |
| Panel B Energy Meter | Energy Monitoring | ZWAVE | ZWAVE | energy, power, switch |
| Washing Machine Outlet | Energy Monitoring | ZWAVE | ZWAVE | brightness, energy, power, switch |
| Living Room Fireplace | Living Room | ZWAVE | ZWAVE | switch |
| Master Bedroom Fireplace | Master Bedroom | ZWAVE | ZWAVE | switch |
| Back Extender | Upstairs | ZWAVE | ZWAVE | brightness, switch |
| Front Extender | Upstairs | ZWAVE | ZWAVE | brightness, switch |
| Upstairs AV Extender | Upstairs | ZWAVE | ZWAVE | brightness, switch |
| Vault Light Switch | Vault | ZWAVE | ZWAVE | brightness, switch |

### 3. Battery sensors and buttons

Move battery devices after the mesh exists. Wake each device repeatedly until HomeBrain captures battery and sensor metadata.

| Device | Room | Radio | SmartThings type | Native features to verify |
| --- | --- | --- | --- | --- |
| Downstairs Motion Sensor | Downstairs | ZIGBEE | ZIGBEE | battery, firmware, motion, temperature |
| Girl's Room Window | Downstairs | ZIGBEE | ZIGBEE | battery, contact, firmware, temperature |
| Heather FOB | Janisary | ZIGBEE | ZIGBEE | battery, button, firmware, switch |
| Matt FOB | Janisary | ZIGBEE | ZIGBEE | battery, button, firmware, switch |
| Multipurpose Sensor | Janisary | ZIGBEE | ZIGBEE | acceleration, axis, battery, contact, firmware, temperature |
| Double Gate | Outside | ZIGBEE | ZIGBEE | battery, contact, firmware, temperature |
| Garden Sensor | Outside | ZIGBEE | ZIGBEE | battery, firmware, humidity, switch, temperature |
| Lainey House | Outside | ZIGBEE | ZIGBEE | battery, firmware, humidity, switch, temperature |
| Single Gate | Outside | ZIGBEE | ZIGBEE | battery, contact, firmware, temperature |
| Theater Door | Theater | ZIGBEE | ZIGBEE | battery, contact, firmware, temperature |
| Back Door | Upstairs | ZIGBEE | ZIGBEE | acceleration, axis, battery, contact, firmware, temperature |
| Claire's Room Window | Upstairs | ZIGBEE | ZIGBEE | battery, contact, firmware, temperature |
| Front Door | Upstairs | ZIGBEE | ZIGBEE | acceleration, axis, battery, contact, firmware, temperature |
| Garage Entry | Upstairs | ZIGBEE | ZIGBEE | battery, contact, firmware, temperature |
| Upstairs Motion | Upstairs | ZIGBEE | ZIGBEE | battery, firmware, motion, temperature |
| Vault Door | Vault | ZIGBEE | ZIGBEE | battery, contact, firmware, temperature |
| Garage Tilt Sensor | Upstairs | ZWAVE | ZWAVE | battery, contact, tamper |

### 4. Room lights and scenes

Move lights room-by-room so scenes and voice names can be tested in small batches. Theater and Vault should be done as dedicated sessions.

| Device | Room | Radio | SmartThings type | Native features to verify |
| --- | --- | --- | --- | --- |
| Master Bathtub Light 1 | Janisary | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Master Bathtub Light 2 | Janisary | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Master Sink Light 1 | Janisary | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Master Sink Light 2 | Janisary | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Shower light 1 | Janisary | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Shower light 2 | Janisary | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Master Shower | Master Bedroom | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Master Sink Atmospheric Light | Master Bedroom | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Master Tub Atmospheric Lights | Master Bedroom | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Driveway Lights | Outside | ZIGBEE | ZIGBEE | brightness, color, firmware, switch |
| Flower Bed Lights | Outside | ZIGBEE | ZIGBEE | brightness, color, firmware, switch |
| Music Room Garden Spot | Outside | ZIGBEE | ZIGBEE | brightness, color, firmware, switch |
| AV Cabinet Lower Shelf | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| AV Cabinet Upper Shelf Light | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Island Left LED Strip | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Island Right LED Strip | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Poster Left | Theater | ZIGBEE | ZIGBEE | brightness, colorTemperature, firmware, switch |
| Poster Right | Theater | ZIGBEE | ZIGBEE | brightness, colorTemperature, firmware, switch |
| Theater Back Wall LED Strip | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Theater Cabinet Lights | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Theater Ceiling Left LED Strip | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Theater Ceiling Right LED Strip | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Theater Left Wall LED Strip | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Theater Right Wall LED Strip | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Theater Screen LED | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Theater Stage Lights | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Under AV Cabinet Light | Theater | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Vault Bench Light | Vault | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Vault LED Strip | Vault | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Vault Overhead Lights | Vault | ZIGBEE | ZIGBEE | firmware, switch |
| Vault Spotlight 1 | Vault | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Vault Spotlight 2 | Vault | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Vault Spotlight 3 | Vault | ZIGBEE | ZIGBEE | brightness, color, colorTemperature, firmware, switch |
| Vault Under Shelf Lights | Vault | ZIGBEE | ZIGBEE | firmware, switch |

### 5. Security outputs and sensors

Do these after ordinary controls are stable. Test alarm/siren behavior and Security Center state before retiring SmartThings for each one.

| Device | Room | Radio | SmartThings type | Native features to verify |
| --- | --- | --- | --- | --- |
| Greenhouse | Outside | ZWAVE | ZWAVE | battery, contact, tamper, temperature |
| Aeotec Siren | Upstairs | ZWAVE | ZWAVE | alarm, switch |
| Master Bedroom Siren | Upstairs | ZWAVE | ZWAVE | alarm, chime, switch, tamper |
| Siren | Upstairs | ZWAVE | ZWAVE | alarm, switch |
| Utilitech Front Glass Break Sensor | Upstairs | ZWAVE | ZWAVE | battery, contact, energy, humidity, illuminance, motion, power, smoke, tamper, temperature, voltage, water |

### 6. Locks last

Locks go last. Pair them close to the Zooz stick when possible, use S2 security, and verify lock/unlock, battery, lock-code metadata, and Security Center behavior.

| Device | Room | Radio | SmartThings type | Native features to verify |
| --- | --- | --- | --- | --- |
| Attic Lock | Outside | ZWAVE | ZWAVE | battery, lock, lockCodes |
| Back Deadbolt | Outside | ZWAVE | ZWAVE | battery, lock, lockCodes |
| Front Deadbolt | Outside | ZWAVE | ZWAVE | battery, lock, lockCodes |
| Garage Deadbolt | Outside | ZWAVE | ZWAVE | battery, lock, lockCodes |

## Physical Devices Not Migrated By Direct Radio

These are physical, but the live SmartThings metadata says they are LAN, OCF, VIPER, camera/media, cloud, or bridge-backed rather than direct Zigbee/Z-Wave radio devices. Keep them on SmartThings until HomeBrain has a native integration path, replace them with Zigbee/Z-Wave/Matter hardware, or migrate them through a future dedicated connector.

| Device | Room | SmartThings type | HomeBrain type | Features seen |
| --- | --- | --- | --- | --- |
| Back Porch Camera | Cameras | LAN | switch | switch |
| BBQ Camera | Cameras | LAN | switch | switch |
| Cul de Sac Camera | Cameras | LAN | switch | switch |
| Downstairs Camera | Cameras | LAN | switch | switch |
| Front Lawn Camera | Cameras | LAN | switch | switch |
| Front Porch | Cameras | LAN | switch | switch |
| Side Yard Camera | Cameras | LAN | switch | switch |
| Upstairs Camera | Cameras | LAN | switch | switch |
| Basement Sensor | Downstairs | VIPER | sensor | health, motion, presence, temperature |
| Girls Room Sensor | Downstairs | VIPER | sensor | health, motion, presence, temperature |
| Office TV | Downstairs | OCF | switch | switch |
| Play Room Speaker | Downstairs | LAN | switch | switch |
| Dishwasher Monitor | Energy Monitoring | LAN | switch | switch |
| Dryer Monitor | Energy Monitoring | LAN | switch | switch |
| Backporch Mister | Janisary | LAN | switch | switch |
| Front Door | Janisary | VIPER | camera | battery, button, health, motion |
| Front Door | Janisary | VIPER | camera | battery, button, health, motion |
| Harmony Bridge Simple | Janisary | LAN | switch | switch |
| Harmony Bridge Simple - 1 | Janisary | LAN | switch | switch |
| Theater Active | Janisary | LAN | switch | switch |
| Web Req Multi #2 | Janisary | LAN | switch | switch |
| Web Req Multi Master | Janisary | LAN | switch | switch |
| Living Room TV | Living Room | OCF | switch | switch |
| Master Bedroom Sensor | Master Bedroom | VIPER | sensor | health, motion, presence, temperature |
| Master Bedroom Speaker | Master Bedroom | LAN | switch | switch |
| Garage Door Opener | Outside | LAN | switch | switch |
| Video Doorbell | Outside | VIPER | camera | battery, health, motion, switch |
| Mustang | Presence | LAN | switch | switch |
| Kitchen Speaker | Upstairs | LAN | switch | switch |
| Thermostat | Upstairs | VIPER | thermostat | fan, health, humidity, temperature, thermostat |

## SmartThings Hub Or Child Endpoint Records

These are not standalone devices to pair one-by-one. The parent device or platform should be migrated instead.

| Device | Room | SmartThings type | HomeBrain type | Features seen |
| --- | --- | --- | --- | --- |
| Home AC Energy Monitor 1 | Janisary | EDGE_CHILD | switch | humidity, illuminance, switch, temperature |
| Janisary Hub | Janisary | HUB | switch | switch |

## Virtual Records Intentionally Skipped

These are SmartThings virtual switches/helpers, STHM helpers, theater triggers, notification contacts, or other logical records. They should be recreated as HomeBrain automations/scenes only when their behavior is still needed.

| Device | Room | SmartThings type | HomeBrain type | Features seen |
| --- | --- | --- | --- | --- |
| STHM Arm Away | Home Monitor Switches | VIRTUAL | switch | switch |
| STHM Arm Stay | Home Monitor Switches | VIRTUAL | switch | switch |
| STHM Disarm | Home Monitor Switches | VIRTUAL | switch | switch |
| 0DishwasherNotification | Janisary | VIRTUAL | sensor | contact |
| 0DryerNotification | Janisary | VIRTUAL | sensor | contact |
| 0WashingMachineNotification | Janisary | VIRTUAL | sensor | contact |
| Alexa Theater Entry Alert | Janisary | VIRTUAL | sensor | contact |
| Alexa Theater Exit Alert | Janisary | VIRTUAL | sensor | contact |
| Alexa Theater Shutdown Alert | Janisary | VIRTUAL | sensor | contact |
| Theater Alexa Reset | Janisary | VIRTUAL | switch | switch |
| Theater Eating Lights | Janisary | VIRTUAL | switch | switch |
| Theater Manual Block | Janisary | VIRTUAL | switch | switch |
| Theater Movies Activation | Janisary | VIRTUAL | switch | switch |
| Theater Off | Janisary | VIRTUAL | switch | switch |
| Theater PC Activation | Janisary | VIRTUAL | switch | switch |
| Theater Viewing Lights | Janisary | VIRTUAL | switch | switch |
| Theater Xbox Activation | Janisary | VIRTUAL | switch | switch |
| Theater OnOff Virtual Switch | Vault | VIRTUAL | switch | switch |
| Ask Alexa Weather | Virtual Switches | LAN | switch | switch |
| Cave Trigger | Virtual Switches | LAN | switch | switch |
| Comms Closet Leak Sensor | Virtual Switches | VIRTUAL | switch | switch |
| Fight Night Lights Trigger | Virtual Switches | VIRTUAL | switch | brightness, colorTemperature, switch |
| Guest Bathroom Leak Sensor | Virtual Switches | VIRTUAL | switch | switch |
| HBO Lights Trigger | Virtual Switches | VIRTUAL | switch | brightness, colorTemperature, switch |
| Home Air Monitor | Virtual Switches | LAN | switch | switch |
| Jack and Jill Leak Sensor | Virtual Switches | VIRTUAL | switch | switch |
| Kodi Lights Trigger | Virtual Switches | VIRTUAL | switch | brightness, colorTemperature, switch |
| Master Bathroom Leak Sensor | Virtual Switches | VIRTUAL | switch | switch |
| Netflix Lights Trigger | Virtual Switches | VIRTUAL | switch | brightness, colorTemperature, switch |
| Prime Lights Trigger | Virtual Switches | VIRTUAL | switch | brightness, colorTemperature, switch |
| Theater Entry Trigger | Virtual Switches | VIRTUAL | sensor | contact |
| Theater Shutdown | Virtual Switches | VIRTUAL | switch | switch |
| Xbox Lights Trigger | Virtual Switches | VIRTUAL | switch | brightness, colorTemperature, switch |

## Stop Conditions

- Stop after any pairing that creates duplicate records or fails to update state reliably.
- Stop before locks if any Z-Wave powered device has unreliable routing.
- Stop before sirens if Security Center cannot see native alarm state.
- Stop before retiring SmartThings if voice controls, automations, or grouped actions still target the old record.

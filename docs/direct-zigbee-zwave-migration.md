# Direct Zigbee/Z-Wave Migration Tracker

Last updated: 2026-05-07

## Hardware Reality Check

- [x] Amazon ASIN `B0BW171KP3` researched: Zooz ZST39 LR, 800-series Z-Wave Long Range S2 USB stick.
- [x] Amazon ASIN `B09KXTCMSC` researched: SONOFF ZBDongle-P, Zigbee 3.0 USB coordinator.
- [x] Note the protocol labels in the original request are reversed. HomeBrain support is implemented by actual detected hardware identity.
- [ ] Verify physical USB detection on the Jetson after deployment with real sticks inserted.

References:

- Zooz ZST39 specs: https://www.support.getzooz.com/kb/article/1377-zst39-800-long-range-z-wave-stick-specs/
- Zooz ZST39 product page/manual: https://www.getzooz.com/zooz-zst39-z-wave-long-range-usb-stick/
- SONOFF ZBDongle-P product page: https://sonoff.tech/product/gateway-and-sensors/sonoff-zigbee-3-0-usb-dongle-plus-p/
- SONOFF ZBDongle-P hardware specification: https://dongle.sonoff.tech/guide/zbdongle-p/hardware_specification-2/

## Controller Support

- [x] Linux/Jetson serial autodiscovery for SONOFF ZBDongle-P.
- [x] Linux/Jetson serial autodiscovery for Zooz ZST39 LR.
- [x] Runtime status API for adapter presence, driver health, and paired-node counts.
- [x] Permit-join / inclusion and exclusion / leave APIs.
- [x] Device event normalization into HomeBrain device records.
- [x] Command routing for direct HomeBrain Zigbee and Z-Wave devices.
- [x] Safe behavior when hardware or optional driver packages are missing.

## Live SmartThings Inventory Covered

Live query: `/api/devices?source=smartthings&includeRaw=1` on 2026-05-07 found 147 SmartThings-backed HomeBrain devices across 39 capability groups.

The native catalog maps these categories to direct Zigbee/Z-Wave feature support and migration plans. Individual devices still need to be excluded/reset and paired once the radios are installed.

### Security-Critical

- [x] Contact sensors with temperature, battery, firmware status: Comms Closet, Girl's Room Window, Double Gate, Single Gate, Theater Door, Claire's Room Window, Garage Entry, Vault Door.
- [x] Multipurpose contact/temperature/axis/acceleration/battery sensors: Multipurpose Sensor, Back Door, Front Door.
- [x] Contact sensor with tamper and temperature alarm: Greenhouse.
- [x] Tilt/contact sensor with battery and tamper: Garage Tilt Sensor.
- [x] Motion sensors with temperature and battery/firmware status: Downstairs Motion Sensor, Upstairs Motion.
- [x] Motion/presence/temperature/health sensors: Basement Sensor, Girls Room Sensor, Master Bedroom Sensor.
- [x] Generic security sensor with contact/motion/smoke/water/tamper/pressure/weight/illuminance/humidity/temp/voltage/energy/power/battery: Utilitech Front Glass Break Sensor.
- [x] Z-Wave door locks with lock, lock codes, battery: Attic Lock, Back Deadbolt, Front Deadbolt, Garage Deadbolt.
- [x] Sirens with alarm/switch and siren with alarm/chime/switch/tamper: Aeotec Siren, Siren, Master Bedroom Siren.
- [x] Key fobs/buttons with battery/firmware: Heather FOB, Matt FOB.

### Automation/Comfort/Energy

- [x] Color temperature/RGB lights with level and firmware status.
- [x] Outdoor color lights with level/RGB and firmware status.
- [x] Dimmers and extenders with switch level.
- [x] Smart plugs/repeaters with switch, power meter, firmware status.
- [x] Switch/repeater outlets with switch and firmware status.
- [x] Whole-home and appliance power/energy meters.
- [x] Temperature/humidity/battery sensors.
- [x] Thermostat with temp, humidity, heating/cooling setpoints, operating state, mode, fan mode, health.
- [x] Speakers and Samsung/Ring/Arlo cloud devices remain SmartThings/cloud unless manually migrated to another native integration.
- [x] Virtual switches and Home Monitor switches should not be required by HomeBrain-native security.

## Migration UX

- [x] Web device detail action: "Migrate to HomeBrain".
- [x] iOS device detail action: "Migrate to HomeBrain".
- [x] Migration plan API explains protocol, supported features, and manual intervention.
- [x] Pairing workflow guides user through exclusion/reset/pairing steps when automation cannot do it.
- [x] Existing HomeBrain device keeps name, room, groups, favorites/Alexa exposure where possible.
- [x] SmartThings integration remains installed; migrated device source becomes `homebrain-zigbee` or `homebrain-zwave`.
- [x] Post-migration validation compares core state and battery/support data.

## HomeBrain Security Center

- [x] Security platforms can be enabled/disabled independently: HomeBrain-native and SmartThings.
- [x] Arm away supports configurable exit delay, default 30 seconds.
- [x] Arm stay and disarm announcements are available to clients.
- [x] Triggered alarm dismiss supports reason: false alarm or custom.
- [x] Dismiss turns off HomeBrain-native sirens and still attempts SmartThings siren cleanup if that platform is enabled.
- [x] Security status includes platform states, countdowns, siren cleanup result, and dismissal audit.

## Audio Prompts

- [x] Generate Hannah: "Arming away in 30 seconds. Please leave the premises now."
- [x] Generate Hannah: armed stay confirmation.
- [x] Generate Hannah: disarmed confirmation.
- [x] Generate Hannah: alarm triggered.
- [x] Generate Hannah: alarm dismissed / false alarm confirmation.
- [x] Wire prompt metadata into web and iOS clients.

## Verification/Ship

- [x] Server tests.
- [x] Client lint/build.
- [x] iOS generic build.
- [x] npm audit/security check.
- [ ] Commit/push through protected-main flow.
- [ ] Safe deploy via HomeBrain live skill.
- [ ] Post-deploy live health and adapter status verification.

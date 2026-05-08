# Direct Zigbee/Z-Wave/Matter Migration Tracker

Last updated: 2026-05-07

## Hardware Reality Check

- [x] Amazon ASIN `B0BW171KP3` researched: Zooz ZST39 LR, 800-series Z-Wave Long Range S2 USB stick.
- [x] Amazon ASIN `B09KXTCMSC` researched: SONOFF ZBDongle-P, Zigbee 3.0 USB coordinator.
- [x] Amazon ASIN `B0FMJD288B` researched: SONOFF Zigbee/Thread USB Dongle Plus MG24 / Dongle-PMG24 class device using Silicon Labs EFR32MG24 with CP210x USB serial bridge.
- [x] Note the protocol labels in the original request are reversed. HomeBrain support is implemented by actual detected hardware identity.
- [x] Matter hardware note: sticks have not arrived yet, so local and production behavior must be safe when no USB radio is present.
- [ ] Verify physical USB detection on the Jetson after deployment with real Zigbee/Z-Wave/MG24 sticks inserted.

References:

- Zooz ZST39 specs: https://www.support.getzooz.com/kb/article/1377-zst39-800-long-range-z-wave-stick-specs/
- Zooz ZST39 product page/manual: https://www.getzooz.com/zooz-zst39-z-wave-long-range-usb-stick/
- SONOFF ZBDongle-P product page: https://sonoff.tech/product/gateway-and-sensors/sonoff-zigbee-3-0-usb-dongle-plus-p/
- SONOFF ZBDongle-P hardware specification: https://dongle.sonoff.tech/guide/zbdongle-p/hardware_specification-2/
- SONOFF MG24 product page: https://sonoff.tech/en-us/products/sonoff-zigbee-thread-usb-dongle-dongle-plus-mg24/58
- CSA Matter 1.5.1 release: https://csa-iot.org/newsroom/matter-1-5-1-enhancing-camera-performance-and-expanding-device-flexibility/
- OpenThread Border Router setup: https://openthread.io/guides/border-router/prepare
- matter.js controller reference: https://github.com/matter-js/matter

## Controller Support

- [x] Linux/Jetson serial autodiscovery for SONOFF ZBDongle-P.
- [x] Linux/Jetson serial autodiscovery for Zooz ZST39 LR.
- [x] Runtime status API for adapter presence, driver health, and paired-node counts.
- [x] Web admin radio diagnostics/logging panel for Zigbee and Z-Wave with live SSE log replay, adapter health, serial-port scoring, pairing controls, and actionable USB visibility diagnostics.
- [x] iPhone/iPad native radio diagnostics/logging parity: Settings exposes Zigbee/Z-Wave controller health, scored serial ports, replay/live-updating logs, pairing/inclusion/exclusion controls, stop controls, and log clearing.
- [x] Permit-join / inclusion and exclusion / leave APIs.
- [x] Device event normalization into HomeBrain device records.
- [x] Command routing for direct HomeBrain Zigbee and Z-Wave devices.
- [x] Safe behavior when hardware or optional driver packages are missing.

## Matter / Thread Support

- [x] Add native Matter source `homebrain-matter`.
- [x] Add Matter status/config API: controller status, commissioned nodes, sessions, capabilities.
- [x] Add Thread status API for SONOFF MG24 detection, OTBR REST reachability, active dataset availability, and setup guidance.
- [x] Add Linux/Jetson serial autodiscovery for SONOFF MG24/EFR32MG24/CP210x without confusing it with Zooz Z-Wave.
- [x] Add Matter commissioning API for QR/manual setup codes, known IP address, IP auto-discovery, Thread, Wi-Fi, Ethernet, and BLE-capable flows.
- [x] Use OpenThread Border Router dataset when available, with manual dataset override for Thread commissioning.
- [x] Add Matter device catalog mapping for lights, plugs, dimmers, color/color temperature, contact/motion/temp/humidity/illuminance sensors, batteries, locks, closures/shades/garage, thermostats, fans, power/energy, smoke/CO/water, valves, cameras/doorbells, speakers/chimes, health/firmware.
- [x] Normalize Matter endpoints into HomeBrain `Device` records with source, node/endpoint identity, feature labels, state cache, battery, energy/power hooks, and command support.
- [x] Route HomeBrain device commands to Matter On/Off, level, color temperature, lock/unlock, closure open/close, and alarm/silence when exposed.
- [x] Safe startup when Matter runtime, OTBR, BLE, or USB hardware is missing.
- [ ] Verify Matter commissioning against real devices once the MG24 stick and target Matter devices are physically present.

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
- [x] iOS migration cards show the same migration plan details as web: recommended radio, native support count, warnings, and manual reset/inclusion steps.
- [x] iOS device/workflow/dashboard source filters include Zigbee, Z-Wave, Thread, and Matter even before devices exist.
- [x] Pairing workflow guides user through exclusion/reset/pairing steps when automation cannot do it.
- [x] Migration plans now expose a step-by-step guided workflow: HomeBrain opens Z-Wave exclusion, waits for the device-specific physical exclusion action, opens HomeBrain inclusion, then waits for the device-specific inclusion/pairing action.
- [x] Device-specific instruction profiles are included for Z-Wave locks (Schlage, Kwikset/Weiser, Yale, generic secure locks), Z-Wave sirens, garage controllers, Z-Wave switches/dimmers/outlets/meters, SmartThings/Aeotec Zigbee contact and multipurpose sensors, Zigbee motion sensors, buttons/fobs, plugs/repeaters, and lights.
- [x] Web and iOS migration UX no longer tells the user to search manufacturer instructions; it displays the matched instruction profile, concrete physical action, and a touch/click confirmation to advance to the next automated step.
- [x] Existing HomeBrain device keeps name, room, groups, favorites/Alexa exposure where possible.
- [x] SmartThings integration remains installed; migrated device source becomes `homebrain-zigbee` or `homebrain-zwave`.
- [x] Post-migration validation compares core state and battery/support data.
- [x] Matter web onboarding panel supports setup code, transport, known IP, room/name, Wi-Fi credentials, and Thread dataset override.
- [x] Matter iOS onboarding panel mirrors web controls and status.

## HomeBrain Security Center

- [x] Security platforms can be enabled/disabled independently: HomeBrain-native and SmartThings.
- [x] Arm away supports configurable exit delay, default 30 seconds.
- [x] Arm stay and disarm announcements are available to clients.
- [x] Triggered alarm dismiss supports reason: false alarm or custom.
- [x] Dismiss turns off HomeBrain-native sirens and still attempts SmartThings siren cleanup if that platform is enabled.
- [x] Security status includes platform states, countdowns, siren cleanup result, and dismissal audit.
- [x] HomeBrain-native security sensors are source-agnostic: Matter, Zigbee, Z-Wave, INSTEON, weather/platform sensors, and explicit `includeInSecurityCenter` sensors can participate.
- [x] Matter locks, closures, contact/motion/smoke/CO/water/battery sensors flow into the Security Center.
- [x] Security settings support named, hashed PINs with independent require-to-arm and require-to-disarm policies; web and iOS prompt for PINs and record the matching PIN name for arm/disarm/dismiss attribution.

## Audio Prompts

- [x] Generate Hannah: "Arming away in 30 seconds. Please leave the premises now."
- [x] Generate Hannah: armed stay confirmation.
- [x] Generate Hannah: disarmed confirmation.
- [x] Generate Hannah: alarm triggered.
- [x] Generate Hannah: alarm dismissed / false alarm confirmation.
- [x] Wire prompt metadata into web and iOS clients.
- [x] Generate ElevenLabs SFX: countdown beep.
- [x] Generate ElevenLabs SFX: final arming beeps.
- [x] Generate ElevenLabs SFX: confirmation chime.
- [x] Generate ElevenLabs SFX: restrained alert pulse.
- [x] Web countdown and triggered-state SFX playback.
- [x] iOS countdown and triggered-state SFX playback.

## Verification/Ship

- [x] Server tests.
- [x] Client lint/build.
- [x] iOS generic build.
- [x] npm audit/security check.
- [x] Commit/push through protected-main flow: PR #63 merged to `main` at `7019231`.
- [x] Safe deploy via HomeBrain live skill: job `1f5d3775-d027-4e4c-8462-5932403afb1b` completed on 2026-05-07.
- [x] Post-deploy live health and adapter status verification: production health is green, Matter controller starts, and MG24/Thread status safely reports no stick present yet.

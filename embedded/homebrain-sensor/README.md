# HomeBrain XIAO ESP32-C6 Sensor Firmware

One firmware image supports the HomeBrain Atmosphere Air Station, Presence Pod, and Climate Pod. The active profile and runtime calibration are delivered by HomeBrain after one-time provisioning.

See the complete [assembly, wiring, power, flashing, and commissioning guide](../../docs/homebrain-sensors/README.md).

## Build

```bash
pio run
```

Verified build target: Seeed Studio XIAO ESP32-C6 using the Seeed platform pinned in `platformio.ini` (Arduino-ESP32 3.3.7).

Current release build:

- Firmware: 1.2.0 (Bluetooth setup and full-profile health telemetry)
- Flash: approximately 1.62 MB of a 1.81 MB OTA slot
- Static RAM: approximately 46 KB of 320 KB
- Reading schema: `homebrain.sensor.reading.v1`
- Config schema: `homebrain.sensor.config.v1`

No Wi-Fi password, setup code, node token, or HomeBrain URL is compiled into the image. Wi-Fi and application provisioning are stored in ESP32 NVS after app-driven Bluetooth setup. A normal USB firmware upload preserves that NVS registration; do not erase flash.

## Bluetooth onboarding (all three device types)

1. Flash this image, power on the unclaimed sensor, and open **Devices → Add Device → HomeBrain** in the native iOS app, or **Add Native Device → HomeBrain sensor · Bluetooth** in desktop Chrome/Edge over HTTPS. The web Settings → Sensor Fleet page also has the same setup flow.
2. Choose **Find nearby sensor**, select the device, then select its 2.4 GHz Wi-Fi and enter the Wi-Fi password. Name, room and profile are optional; the sensor reports its detected profile. No setup code, node ID or hub URL needs to be typed.
3. The authenticated app prepares the registration and transfers it over encrypted Bluetooth. The sensor verifies both Wi-Fi and HTTPS HomeBrain activation before saving the network. The app waits for a new reading, not just a Wi-Fi connection.
4. Open the device's telemetry section for all current measurements, module health and diagnostics. Tap a numeric reading for its graph, or open all history. Missing modules are marked unavailable and their readings are not invented.

New sensors advertise for 10 minutes after startup. A claimed device advertises only after the local USB `setup` command; normal Wi-Fi failures do not reopen pairing. This command preserves registration and permits changing Wi-Fi. `cancel` over the BLE command characteristic closes setup without changing credentials. Factory reset through D1 remains a separate, destructive recovery action.

Security: standard LE Secure Connections with encrypted GATT writes/reads and Just Works (no display/PIN). This protects against passive interception, but does **not** authenticate against an active nearby man-in-the-middle. Set up in a trusted physical environment. Device tokens are not exposed over BLE; the app receives only a one-time activation credential. API activation and reporting verify TLS certificates. Bluetooth onboarding requires HTTPS.

Protocol v1: service `9c2f0001-7d1b-4a2f-9d3b-0f91e6a3b805`; info/command/response characteristics replace `0001` with `0002`/`0003`/`0004`. Commands are newline-terminated UTF-8 JSON, at most 1536 bytes before newline, written in 20-byte chunks with response. Operations: `scan`, `networks` (offset pagination), `configure`, `cancel`. Replies echo numeric `id` and `state`; clients poll the encrypted response. Wi-Fi passwords never go to HomeBrain's backend or logs.

## Built-in USB bench diagnostic

The production image also contains the USB diagnostic console; there is no separate test firmware to install or remove. On an unprovisioned board, reset opens a 12-second serial window for `diag air-station`, then Bluetooth setup starts. USB diagnostics also work during the setup window. Once a node is provisioned, type `diag` at 115200 baud to test its configured profile without removing HomeBrain connectivity. Manual reset runs diagnostics; battery timer wakes skip that extra bench test to conserve power.

For the Atmosphere station, the checked-in runner resets the board, requests the diagnostic, validates the structured report, and exits nonzero unless all modules pass:

```bash
python3 ../../scripts/bench-test-homebrain-sensor.py \
  --port /dev/cu.usbmodem2101 \
  --profile air-station
```

The test requires valid BME680, SCD41, and VEML7700 I²C acknowledgements and plausible readings. It also requires a checksum-valid PMS5003 sample and performs an active/passive/request/active exchange to exercise both UART wires. Add `--flash` when the production image itself needs updating first.

The same runner accepts `--profile presence` (DHT11, light and radar) and `--profile climate` (DHT11). These tests verify communication and plausible readings, not calibrated accuracy. Climate battery voltage requires the fitted divider; battery percentage is an estimate, and the board has no VBUS/charging sense line, so Climate does not claim a measured USB/charging state.

The September 23 Atmosphere prototype still has its known BME680 footprint/wiring fault. Software does not repair it: CO₂, light and particulate modules may report while BME pressure/gas remain unavailable. Do not interpret overall device connectivity as an all-module test pass.

HTTPS requests validate certificates using the ESP32 root CA bundle. Private certificate authorities require `HOMEBRAIN_SENSOR_CA_CERT` at build time. Firmware builds do not flash connected hardware automatically.

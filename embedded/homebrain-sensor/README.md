# HomeBrain XIAO ESP32-C6 Sensor Firmware

One firmware image supports the HomeBrain Atmosphere Air Station, Presence Pod, and Climate Pod. The active profile and runtime calibration are delivered by HomeBrain after one-time provisioning.

See the complete [assembly, wiring, power, flashing, and commissioning guide](../../docs/homebrain-sensors/README.md).

## Build

```bash
pio run
```

Verified build target: Seeed Studio XIAO ESP32-C6 using the Seeed platform pinned in `platformio.ini` (Arduino-ESP32 3.3.7).

Current release build:

- Firmware: 1.3.8 (wireless updates with boot confirmation/rollback, native ESP-IDF download transport, Wi-Fi compatibility mode, Bluetooth recovery, full-profile telemetry)
- Application: approximately 1.74 MiB of a 1.81 MiB OTA slot, including the image headers
- Static RAM: approximately 46 KB of 320 KB
- Reading schema: `homebrain.sensor.reading.v1`
- Config schema: `homebrain.sensor.config.v1`

No Wi-Fi password, setup code, node token, or HomeBrain URL is compiled into the image. Wi-Fi and application provisioning are stored in ESP32 NVS after app-driven Bluetooth setup. A normal USB firmware upload preserves that NVS registration; do not erase flash.

Firmware 1.2.1 and later use the XIAO's full six-byte Wi-Fi MAC in its hardware ID. Deploy the OTA backend before installing 1.3.0: an authenticated 1.2.0 sensor's first OTA-capable reading migrates its matching legacy ID while preserving the node, token, settings and history. Unrelated hardware IDs remain rejected. An unclaimed sensor is ready for first-time registration after flashing.

## Wireless firmware updates

All three profiles use the same application image. Use 1.3.8 or newer for USB bootstrap, including the pinned bootloader and partition table. Firmware older than 1.3.0 needs this one-time USB installation to enable OTA. Preserve NVS; do not erase flash. Future application updates use Wi-Fi.

1. Build with `pio run -d embedded/homebrain-sensor` from the repository root. Increment `HOMEBRAIN_SENSOR_FIRMWARE_VERSION` for each changed release.
2. Publish `.pio/build/seeed-xiao-esp32-c6/firmware.bin` in **Settings → Sensor Fleet → Wireless firmware updates**. Upload the application binary, not a merged flash image or bootloader. The backend validates its ESP32-C6 header, segment checksum, appended SHA-256 and compiled HomeBrain board/version marker. Releases are immutable and stored with their artifact in MongoDB; keep the exact published binary for USB bootstrap.
3. Choose **Update** on the sensor in Sensor Fleet or open the device's **Firmware updates** section in iOS. **Reinstall** allows a same-version recovery/OTA verification; downgrades are rejected.
4. Wired devices receive the command on their next reading. Climate receives it when it wakes (normally within five minutes), stays awake throughout installation and confirmation, then resumes its configured sleep interval. Climate needs a measured battery voltage of at least 3.6 V; charge and retry if it refuses an update.

The sensor downloads from its configured HTTPS hub using its own device token. Certificates and hostname are verified, redirects are disabled, and arbitrary manifest URLs are never followed. Download size and SHA-256 must match before the inactive slot is selected. Wi-Fi/registration/calibration in NVS are preserved.

The radio uses 2.4 GHz 802.11b/g/n with 20 MHz channels for compatibility with the house access points. OTA temporarily disables modem power saving, prepares the inactive flash slot before opening the download, and uses the native ESP-IDF streaming client. Interrupted downloads reconnect up to eight times and request the remaining byte range, keeping the existing hash and flash position. Every response must match the expected range, length and release hash; the full image is still verified before selecting it. If recovery fails, connections close safely and ordinary sensor reporting resumes; serial logs include Wi-Fi disconnect reasons for diagnosis.

The pinned ESP32-C6 SDK enables `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`. `verifyRollbackLater()` overrides Arduino's automatic early acceptance. The new image is accepted only after a normal measurement reaches HomeBrain; a two-minute deadline or an unconfirmed reset triggers rollback. The previous image records an interrupted/rolled-back job on its next report. A failed job is not retried automatically; retry from the app creates a new job ID. Download time is bounded to ten minutes, with a 15-second idle timeout that excludes time spent sending progress. Progress reports require at least ten percentage points of advancement and fifteen seconds between reports, so their separate TLS connections do not continually interrupt a slow download. Status is persisted across reboot, including the target partition so a failed same-version reinstall cannot be mistaken for success.

### API contract

- Admin `GET/POST /api/sensor-nodes/firmware/releases`: list manifests or upload a raw `application/octet-stream` image. Optional `X-Firmware-Notes` header (2,000 characters max).
- Admin `GET /api/sensor-nodes/:nodeId/firmware`: installed/latest version, OTA support and current job.
- Admin `POST /api/sensor-nodes/:nodeId/firmware` with `{ "releaseId": "…" }`: queue an update, including for sleeping/offline nodes. Old firmware returns a bootstrap-required error.
- Device config/reading responses include `config.firmware_update` with job ID, version, hardware, protocol, byte count, full-file digest and embedded image digest.
- Device `GET /api/sensor-nodes/:nodeId/firmware/download/:jobId`: current job's binary only, authorized with `Authorization: Sensor …`.
- Device `POST /api/sensor-nodes/:nodeId/firmware/status`: `{id, phase, progress, version, imageSha256, error}`. Phases: downloading/installing/rebooting/succeeded/failed. Success requires the exact target version and running image digest. Stale jobs return 410; concurrent status changes return 409 and can be retried.

Queued jobs wait for the next check-in. Active jobs with no progress for 30 minutes become failed when their status is checked. Admin, read-only-account and review-sandbox restrictions apply to publication and update requests; device credentials cannot publish or schedule firmware.

Run contract and HTTP-flow tests with `NODE_ENV=test node --test server/tests/sensorFirmwareService.test.js server/tests/sensorNodeService.test.js server/tests/sensorNodeRoutes.test.js`. A real transfer, boot confirmation, and power-loss rollback require the one-time hardware bootstrap and a subsequent OTA test; successful builds and a simulated device are not hardware verification.

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

The same runner accepts `--profile presence` (DHT11, light and radar) and `--profile climate` (DHT11 and battery-divider voltage). These tests verify communication and plausible readings, not calibrated accuracy. Climate battery voltage requires the fitted divider; battery percentage is an estimate, and the board has no VBUS/charging sense line, so Climate does not claim a measured USB/charging state. A plausible voltage while USB is connected does not by itself prove that the cell can power the board after USB is removed.

The September 23 Atmosphere prototype still has its known BME680 footprint/wiring fault. Software does not repair it: CO₂, light and particulate modules may report while BME pressure/gas remain unavailable. Do not interpret overall device connectivity as an all-module test pass.

HTTPS requests validate certificates using the ESP32 root CA bundle. Private certificate authorities require `HOMEBRAIN_SENSOR_CA_CERT` at build time. Firmware builds do not flash connected hardware automatically.

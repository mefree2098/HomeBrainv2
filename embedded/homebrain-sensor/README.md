# HomeBrain XIAO ESP32-C6 Sensor Firmware

One firmware image supports the HomeBrain Atmosphere Air Station, Presence Pod, and Climate Pod. The active profile and runtime calibration are delivered by HomeBrain after one-time provisioning.

See the complete [assembly, wiring, power, flashing, and commissioning guide](../../docs/homebrain-sensors/README.md).

## Build

```bash
pio run
```

Verified build target: Seeed Studio XIAO ESP32-C6 using the Seeed platform pinned in `platformio.ini` with matched Arduino-ESP32 3.3.11 core and ESP-IDF library packages.

Current release build:

- Flash: 1,427,688 bytes of a 1,900,544-byte OTA slot (75.1%)
- Static RAM: 46,396 bytes of 327,680 bytes (14.2%)
- Reading schema: `homebrain.sensor.reading.v1`
- Config schema: `homebrain.sensor.config.v1`

No Wi-Fi password, setup code, node token, or HomeBrain URL is compiled into the image. Wi-Fi and application provisioning are stored in ESP32 NVS after captive-portal setup.

## Built-in USB bench diagnostic

The production image also contains the USB diagnostic console; there is no separate test firmware to install or remove. On an unprovisioned board, reset opens a 12-second serial window for `diag air-station`, then the normal HomeBrain captive portal starts. Once a node is provisioned, type `diag` at 115200 baud to test its configured profile without removing HomeBrain connectivity.

For the Atmosphere station, the checked-in runner resets the board, requests the diagnostic, validates the structured report, and exits nonzero unless all modules pass:

```bash
python3 ../../scripts/bench-test-homebrain-sensor.py \
  --port /dev/cu.usbmodem1301 \
  --profile air-station
```

The test requires valid BME680, SCD41, and VEML7700 I²C acknowledgements and plausible readings. It also requires a checksum-valid PMS5003 sample and performs an active/passive/request/active exchange to exercise both UART wires. Add `--flash` when the production image itself needs updating first.

HTTPS requests validate certificates using the ESP32 root CA bundle. Private certificate authorities require `HOMEBRAIN_SENSOR_CA_CERT` at build time. Firmware builds do not flash connected hardware automatically.

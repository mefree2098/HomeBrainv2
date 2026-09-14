# HomeBrain USB bench diagnostic

The production HomeBrain sensor firmware contains its USB diagnostic console; there is no separate test image. On an unprovisioned board, this runner resets the XIAO, waits for the startup command window, requests `diag air-station`, parses the single-line `homebrain.usb-diagnostic.v1` report, and exits nonzero unless all four Atmosphere modules pass.

```bash
python3 scripts/bench-test-homebrain-sensor.py \
  --port /dev/cu.usbmodem1301 \
  --profile air-station
```

Add `--flash` to build and install the current production image first. The runner automatically re-executes under PlatformIO's Python when the invoking Python does not provide `pyserial`.

The Atmosphere contract requires BME680, SCD41, and VEML7700 I²C acknowledgements plus plausible readings, a checksum-valid PMS5003 data frame, and a successful active → passive → requested-frame → active exchange that exercises both UART conductors.

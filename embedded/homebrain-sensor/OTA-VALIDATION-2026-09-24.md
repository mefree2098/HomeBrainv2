# OTA hardware validation — 2026-09-24

## Presence validation on 1.3.6

- Version: 1.3.6
- Board: Seeed XIAO ESP32-C6
- Tested profile: Presence
- Image length: 1,825,744 bytes
- File SHA-256: `f9c21a737c24f287cab87e7b3a7b77986dba63f15facac295d379da97ce4a85a`
- Embedded image SHA-256: `a84fe2465b450b33b8af6163bcb1e48c291c05c646bf10a5008081a0cc8e8392`

After normal USB bootstrap preserving NVS, a same-version reinstall was queued through the production firmware API. The device downloaded all 1,825,744 bytes over authenticated HTTPS in 145,018 ms, verified the image, selected the inactive slot, and rebooted. USB supplied power and console output during this OTA test.

Production reported `succeeded`, 100%, with an empty error at 02:55:14 UTC. Subsequent presence, DHT11 and VEML7700 readings were accepted. The existing registration, 15-second reporting interval and calibration settings were preserved.

## Faults found during commissioning

- The initial Arduino HTTP downloader freed its client before `HTTPClient` destruction on an interrupted connection. The crash was symbolicated to `HTTPClient::~HTTPClient()` dereferencing the released client. The final downloader uses one owned native ESP-IDF client and releases it once.
- Failed download attempts preserved the running image and registration; after the cleanup correction, ordinary readings resumed without a panic.
- Wi-Fi disconnect reason 34 identified missing acknowledgements during transfer. The successful build uses 20 MHz 802.11b/g/n, keeps the modem awake during OTA, and restores its previous power policy on failure.
- Native streaming tolerates temporary read delays, checks the byte count and SHA-256 before selecting the new image, and retains the existing boot-confirmation/rollback rules.
- The loop task has 12 KiB of stack. Earlier diagnostics showed only about 1.2 KiB remaining in a nested TLS failure path with the default 8 KiB stack.

## Checks and limits

The pinned PlatformIO build passed, the production binary validator accepted the image, and a real Wi-Fi transfer plus reboot confirmation passed. This session did not inject a power cut or deliberately trigger boot rollback. Atmosphere and Climate still need their final release installation and profile-specific verification; this report does not claim those tests passed.

## Atmosphere commissioning

The Atmosphere node retained its registration and migrated from its legacy ID to `XIAO-C6-A0F262878CF4`. SCD41, VEML7700 and PMS5003 diagnostics passed; the existing BME680 I2C fault remained.

Its 1.3.6 wireless test received 413,696 bytes in 186,796 ms before the three-minute limit expired. Version 1.3.7 reduced progress POST overhead and extended the total deadline, but an idle connection stalled after 68,434 bytes. Both failures preserved the running image and resumed readings.

Version 1.3.8 adds authenticated byte-range resume with up to eight reconnections. The server rejects invalid/multiple ranges, and the firmware checks the resumed response's offset, total length and release hash before continuing the original full-image checksum. A newer USB installation also retires an obsolete queued job instead of downloading older firmware.

The pinned 1.3.8 build and all 24 targeted sensor service/HTTP tests passed, including suffix reconstruction after a simulated interruption, invalid ranges, unauthorized resume requests and obsolete queued jobs. Physical 1.3.8 validation is pending.

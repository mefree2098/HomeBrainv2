# OTA hardware validation — 2026-09-24

## Verified release

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

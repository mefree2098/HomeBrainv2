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

The pinned PlatformIO build passed, the production binary validator accepted the image, and a real Wi-Fi transfer plus reboot confirmation passed. This session did not inject a power cut or deliberately trigger boot rollback. The later profile-specific outcomes are recorded below.

## Atmosphere commissioning

The Atmosphere node retained its registration and migrated from its legacy ID to `XIAO-C6-A0F262878CF4`. SCD41, VEML7700 and PMS5003 diagnostics passed; the existing BME680 I2C fault remained.

Its 1.3.6 wireless test received 413,696 bytes in 186,796 ms before the three-minute limit expired. Version 1.3.7 reduced progress POST overhead and extended the total deadline, but an idle connection stalled after 68,434 bytes. Both failures preserved the running image and resumed readings.

Version 1.3.8 adds authenticated byte-range resume with up to eight reconnections. The server rejects invalid/multiple ranges, and the firmware checks the resumed response's offset, total length and release hash before continuing the original full-image checksum. A newer USB installation also retires an obsolete queued job instead of downloading older firmware.

The pinned 1.3.8 build and all 24 targeted sensor service/HTTP tests passed, including suffix reconstruction after a simulated interruption, invalid ranges, unauthorized resume requests and obsolete queued jobs. All three profiles subsequently completed real 1.3.8 wireless installs and post-boot confirmation as recorded below.

## Atmosphere validation on 1.3.8

After USB bootstrap, Atmosphere was powered by a wall adapter for the final same-version reinstall. Production job `6566f695-4753-4741-9c03-6ec0fd497e72` downloaded the published 1.3.8 image over Wi-Fi, reached `rebooting` at 03:57:08 UTC, and reported `succeeded`, 100%, with no error at 03:57:31 UTC. Its next captured reading arrived at 03:58:09 UTC with sequence 2 and 56,763 ms uptime, confirming the reboot and resumed reporting. The version and image digest matched the release below.

This isolated transfer took roughly ten minutes on the existing wireless link. Post-boot signal was −78 dBm. CO₂, particulate, light and SCD41 temperature/humidity readings resumed; the BME680 remained unavailable. Registration and the 30-second reporting interval were preserved. An earlier concurrent download timed out without replacing the working image.

## Climate validation on 1.3.8

- Build source: `9ded90b7000e77e56732fd4002622103608e2829`, merged as `270eebf02fe5ee47b087a260846076221e0fce12` (PR #721, deployed and healthy on Freestone).
- Image length: 1,826,896 bytes.
- File SHA-256: `c6414ed1f7aff929bbed8103b68850680c814f48b0476039742dc93987e2dead`.
- Embedded image SHA-256: `374dd15054eceae591701209b8517f62b3daf14169b46caca0880f95a8e877fd`.
- Production job: `8f88f236-040c-49f0-9f56-0962a190f86f`.

The full image downloaded over Wi-Fi in 63,125 ms, verified, and rebooted into the inactive slot. Production confirmed `succeeded`, 100%, with no error at 03:45:44 UTC. A fresh post-boot DHT11 reading was accepted at 03:45:41 UTC (7,233 ms uptime), followed by another normal reading. Signal during this successful transfer was approximately −64 dBm. USB supplied power and console capture, not the firmware image.

The original 300-second reporting interval and enabled deep sleep were restored. The device accepted the setting and entered sleep; no extra five-minute wake cycle was needed for verification.

An earlier attempt at roughly −72 to −79 dBm timed out after 609,402 ms and 1,414,085 bytes. Its serial log confirmed byte-range recovery at offsets 166,716, 1,136,190, 1,286,465 and 1,344,453. The running image and registration remained usable. The successful retry used the same published binary and backend.

## Observed interruption recovery

Moving Atmosphere from laptop USB to a power adapter interrupted its first 1.3.8 test. Its next authenticated report marked that job failed and retained the working image and registration. This exercised power interruption during download, not rollback of a newly booted invalid image.

Reopening a macOS USB serial log reader restarted Climate during another transfer, which had reached 65%. That attempt is excluded from transfer reliability results. The subsequent successful test kept the console connection open throughout. Do not open, close or restart a USB monitor during an OTA transfer; observe production status and fresh readings instead. Stop capture after a Climate device has entered sleep, before its next wake.

## Presence validation on 1.3.8

Presence previously passed the 1.3.6 OTA test. Its initial 1.3.8 upgrade timed out at 8%; an isolated retry (`561a9eea-c0c4-4b1c-9fea-2ee4e506de07`) timed out at 36% at 04:01:37 UTC. That 1.3.6 downloader had a three-minute deadline and predated byte-range recovery. A subsequent reading arrived at 04:02:00 UTC with valid radar, DHT11 and light diagnostics and −73 dBm signal, confirming that the existing firmware and registration remained usable.

After the pod was moved closer to the IoT access point, its reported signal improved to −59 dBm. Production job `445328e0-95e0-4dcc-b703-1ad39eb66b40` was queued at 05:04:49 UTC and confirmed `succeeded`, 100%, with no error at 05:05:39 UTC: 50 seconds from queueing to confirmation. This was an actual wireless upgrade from 1.3.6 to the exact published 1.3.8 image, with the same file and embedded-image digests recorded above. No USB flash or serial connection was used for this retry.

A fresh reading captured at 05:06:15 UTC reported firmware 1.3.8, sequence 3 and 45,091 ms uptime. Radar, DHT11 and VEML7700 diagnostics passed, and presence, temperature, humidity and light readings resumed. Registration, calibration and the 15-second reporting interval were preserved.

Climate, Atmosphere and Presence have now all passed a real Wi-Fi installation of 1.3.8 followed by authenticated post-boot reporting. The existing Atmosphere BME680 fault remains separate from this OTA validation.

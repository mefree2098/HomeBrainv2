# HomeBrain photo frames

HomeBrain photo frames combine a local photo library with configurable information overlays. Administrators manage frames in **Photo Frames** in the web and iOS apps. The display runtime is a fullscreen Android app, with the same HTML/CSS/JavaScript renderer used in both app previews.

## Hardware status

The initial target is the Humblestead frame purchased under [ASIN B0GHR65YYX](https://www.amazon.com/dp/B0GHR65YYX): advertised 10.1-inch, 1280 × 800, 32 GB. The owner confirmed **PF1007L**, **AiMOR 6.0.78**, firmware **`YHK.F-null-A33-1001-D1024-PF1007L-321-OS-AIMOR.0.20260113`**, and the name **HomeBrainScreen** on October 13, 2026. The reported Wi-Fi address during setup was `192.168.2.20`; it may change after reboot.

Authenticated inspection confirmed Android **6.0.1 / SDK 23**, **armeabi-v7a**, model `AEEZO`, the January `astar_m86_8723cs` fingerprint, a **1280 × 800** display, and stock WebView **44.0.2403.119**. The kernel reports 15,758,000,128 bytes of eMMC, approximately 16 GB rather than the advertised 32 GB. The owner selected **Freestone (`https://freestonefamily.com`)** as this frame's hub. Freestone deployment and private HTTPS pairing were verified on October 13.

On October 13, the owner's authorized 128 GB SD card was formatted with an MBR, a 16 MiB boot-area gap, and a 31 GB FAT32 `FRAMEBOOT` partition. A locally built, pinned A33 U-Boot and dump script were written and verified with two full boot-area readbacks. The backup completed: all 32 independently checked 64 MiB chunks passed their frame and Mac SHA-256 checks. Copies remain on the SD card and Mac. This first-2-GiB capture covers the boot/system/recovery areas; it is **not** a full-device or user-photo backup. The original SD boot-area backup, card identity, and preparation log are private under the ignored `tmp/photo-frame-recovery/diagnostics` directory.

A guarded access patch and matching restore image were built from this unit's backup. The original boot image hashes to `d71c313ddaa4693948acb20af7740ccb56c88bf9376746a47fce2d00c14fc6a4`; the patch retains the kernel and adds authenticated ADB using the owner's Mac public key. The SD apply pass completed with `OK_WRITTEN_AND_VERIFIED`: it matched the original boot image, wrote the patch, and verified the readback by SHA-256 and byte comparison. The patched digest is `34ea7d219767d7f2e8b4262afac8277f975ef66bdb53e5a2e690669cdda1d371`. Normal Android boot and key-authenticated root access were verified at `192.168.2.48:5555`; DHCP changed the earlier address. The entire live 32 MiB boot partition also matched the prepared patch plus its untouched original remainder. Keep the original boot image and prepared restore artifacts with the private backup.

The original WebView tree was extracted from the verified raw system image and matched against two independent live SHA-256 passes. WebView **106.0.5249.126** and all three ARM native libraries, the official ISRG Root X1 certificate for Freestone HTTPS, and the signed **1.0.0** HomeBrain APK were then staged and verified by size, ownership, permissions, and SHA-256. The original WebView tree is retained at `/system/homebrain-stock-webview`. The base HomeBrain APK is under `/system/priv-app/HomeBrainFrame/`, and `/system` was returned to read-only before reboot. After reboot, PackageManager confirmed WebView 106, the privileged HomeBrain package, and granted `INSTALL_PACKAGES`; the installed files matched their prepared digests. The manufacturer's AiMOR, OTA, and test applications were disabled, and HomeBrain resolved directly as the Home launcher.

Physical acceptance used an isolated hub with the production frame routes and MongoDB, two synthetic photos, and all six overlay positions. Both photos rendered and cycled online and offline. An offline cold restart restored the photo cache and saved layout; reopening the same native pairing link preserves that cache. Killing the display process left the separate updater running. The hub delivered signed **1.0.0 → 1.0.1 → 1.0.2** APK updates without interaction on the frame. Each restarted runtime confirmed the exact installed APK digest and retained silent-install permission. Version 1.0.2 added the Settings return button: both entry paths returned to HomeBrain and removed the overlay, including after termination of the background display process. Freestone subsequently delivered a real 1.0.2 → 1.0.3/build 4 update over HTTPS. Its completed report matched the installed APK digest, an independent device readback matched too, and the live web editor rendered the actual photo and all six positions. The temporary local hub was then removed; Freestone remained healthy and the frame stayed online.

Research found a firsthand [PF1007L identification and access guide](https://github.com/wesbos/photo-frame-dashboard/blob/main/docs/pf1007l-start-here.md). Its relevant observations:

- Prefer a **USB-A-to-USB-C data cable**, through a powered USB-A hub if necessary. Several PF1007L units did not enumerate or receive power through C-to-C. This is a starting point, not a verified electrical diagnosis of this unit.
- Some units have a DC power input plus a data port; other units have a power-only USB-C port. An AC adapter may therefore still be needed.
- The documented [Allwinner PF1007L](https://github.com/wesbos/photo-frame-dashboard/blob/main/docs/allwinner-a33-pf1007l.md) also had AiMOR 6.0.78. The Test App password dialog did not provide working ADB access. No verified universal password was found.
- The long **Firmware version** field is separate from the AiMOR app version. January, April, and May firmware need different checks. Model/app-version equality alone is insufficient evidence for flashing.
- The tested stock WebView was Chromium 44. This player requires a modern WebView; Chromium 106 or newer is the compatibility target. A working APK build does not establish stock-WebView compatibility.

Before installing, read the exact firmware/USB identity and confirm Android SDK, ABI, WebView version, and recovery. Preserve and verify the existing boot/system images before any OS or boot change. Replacing the launcher with the HomeBrain app can provide the requested display experience while retaining the board's display, touch, and Wi-Fi drivers; it is distinct from replacing the entire OS.

## Layout

| Position | Maximum lines |
| --- | ---: |
| Top left | 2 |
| Top center | 1 |
| Top right | 2 |
| Bottom left | 2 |
| Bottom center | 1 |
| Bottom right | 2 |

Every position is optional. Each line selects one information item, with an optional label prefix. Custom text is also supported. Each position has its own font, size, text color, text opacity, and black background opacity. Space Grotesk and Orbitron are bundled with their existing OFL licenses; monospace uses the device's monospace font.

The preview uses the real renderer at a fixed 1280 × 800 or 800 × 1280 logical size, scaled to the available space. Lines never wrap, and overflow truncates with an ellipsis. Reducing font size or shortening labels helps long forecasts fit. The preview ignores the sleep schedule to keep editing possible.

Information choices are time, date, time/date, outside/inside temperature, outside/inside US AQI, alarm status, today's forecast, recorded rainfall over the last 24 hours, lightning over the last 24 hours, outside/inside humidity, indoor CO₂ and PM2.5, wind, UV, sunrise, sunset, and custom text. Climate readings use HomeBrain's existing weather/indoor-air source selections.

Unavailable values display a dash rather than a fabricated zero. Offline or old measurements are marked stale. Alarm status becomes unavailable after the player loses current hub data; an old disarmed/armed state is not presented as current. The rain item uses the rolling observation window, never the calendar-day rain total. It is labeled **Rain recorded (24h)** because incomplete station history may cover less than a full day. An absent weather station does not imply zero lightning or rain.

## Photos and slideshow

The web app accepts browser-decodable images; iOS uses the system Photos picker, including conversion from HEIC. Both resize to a maximum of 2560 pixels on the longest side and upload JPEG bytes, without the original EXIF metadata. The API accepts JPEG and PNG up to 5 MB, 8192 pixels per side, and 40 megapixels. The per-frame library limit is 500 photos or 1 GB.

Users can upload, remove, reorder, and preview individual photos. Settings include sequential/shuffled playback, a 5-second to 24-hour interval, pause, crossfade/slide/instant transitions, transition duration, fit/fill, portrait/landscape, image dimming, edge margin, time zone, 12/24-hour clock, and a daily sleep schedule. Image brightness uses compositor dimming; sleep draws a black screen rather than powering off the panel/backlight.

Photos live under `server/data/photo-frames/<frame-id>/`, with metadata in MongoDB. This directory is ignored by Git and included in the existing default system backup's `server/data` target. If `HOMEBRAIN_PHOTO_FRAME_STORAGE` is overridden, arrange backup coverage for that external directory too.

The player stores its latest manifest locally and caches photo blobs in IndexedDB. Cache capacity depends on the device/browser; uncached photos require the hub. A bounded background batch warms the library, and unavailable photos are skipped so cached photos can continue cycling. The Android APK bundles player assets to allow startup without hub connectivity. Changes are polled every 15 seconds while online.

## Pairing and Android runtime

1. Add a frame in the web or iOS app, upload photos, arrange overlays, and save.
2. Create its private pairing link. The token is returned only at creation, and only a SHA-256 hash is stored by the hub. Replacing the link revokes the previous credential.
3. Install the built APK on an identified, accessible Android device and paste the pairing link into its setup screen. A valid TLS certificate and HTTPS hub URL are preferred; local HTTP is supported.
4. Confirm photos, data, touch/settings access, rotation, offline playback, and relaunch after a power cycle on the actual hardware.
5. Choose HomeBrain Frame as the Home launcher if automatic startup is wanted and the device permits it. Long-press or Back opens connection/Android settings.

The setup screen shows the current IPv4 address. The PF1007L ROM has no SystemUI application or navigation buttons, so it cannot provide a notification drawer or normal Back/Home controls in Settings. Provision the HomeBrain package's `SYSTEM_ALERT_WINDOW` app-op during the initial authenticated setup. The native service then displays a small **Return to HomeBrain** button while Android settings is open and removes it when the display resumes. Settings opens only after that return control is successfully created. The control belongs to the separate updater process, rather than the WebView activity. A return notification is also available on Android systems that provide a notification drawer.

The pairing token is in the URL fragment so it does not enter HTTP request URLs. Device requests carry it in `X-HomeBrain-Frame-Token`. It grants access to that frame's selected display values, photos, assigned software update, and update-status reports, with no general home-control authority. Online players clear displayed content and credentials when a token is rejected. An offline device retains cached photos until it reconnects or its application data is cleared. New pairing links also contain the SHA-256 fingerprint of the hub's OTA public key; the native installer pins this identity before trusting release metadata.

Build the runtime with JDK 17+ and Android SDK 36:

```sh
cd embedded/photo-frame-android
./gradlew :app:assembleDebug :app:lintDebug
```

The APK is `app/build/outputs/apk/debug/app-debug.apk`. A debug APK is for local validation; retain a private release signing key for durable production updates. No signing secrets belong in Git.

After identifying a frame, installation can use `adb -s <verified-device-id> install -r <apk-path>`. Keep the manufacturer's launcher available until HomeBrain is confirmed working. Do not use a guessed serial or an unrelated network ADB advertisement.

## HomeBrain-managed OTA

The initial frame setup must include the HomeBrain runtime as a **privileged system app** under `/system/priv-app/HomeBrainFrame/`, signed with a retained private Android release key. It requests `android.permission.INSTALL_PACKAGES`; on the target Android 6 system this allows the native `PackageInstaller` to replace its own APK without visiting the frame. Verify the permission is actually granted after reboot, rather than assuming that copying an APK succeeded. On newer Android versions additional privileged-permission allowlists and startup behavior must be validated separately. An ordinary `adb install` is sufficient to try the display, but it does **not** provision unattended OTA.

The web app uploads immutable APK releases and queues one on a selected frame. Both web and iOS apps show the installed version, installer readiness, progress, and final result, and can send an existing release. A queued update can be canceled before the frame claims it. The native agent polls every 30 seconds in a foreground service under a separate `:updates` process. A failed WebView/display process can therefore still receive a repair update. Boot and package-replacement receivers reconnect that service and return the Android 6 frame to its display. The UI and updater use separate preference files; connection changes cross the explicit, non-exported service intent so cached cross-process preferences cannot lose update recovery state.

The hub signs an exact UTF-8 metadata payload with RSA/SHA-256. Before installation the native updater verifies the pinned hub key, metadata signature, artifact SHA-256 and byte count, package name, hardware profile, declared APK version, matching Android APK signing certificate, required installer permission, and restart callbacks. Only increasing version codes are accepted. No arbitrary download URL, shell command, or partition write is accepted. Installation uses Android's package session API and preserves app data. The hub marks success only after the restarted app reports the assigned installed version **and the SHA-256 of its actual installed APK**. Interrupted downloads are retried; rejected APKs and installation timeouts are reported as failures. An offline frame retains its assignment for its next connection.

These updates include the photo player, display shell, and native updater. They do **not** replace Android boot/system partitions. Whole-OS images require a separately verified device-specific recovery installer; the release API accepts only the `runtime-apk` kind. The physical PF1007L passed silent installation, package-replacement restart, installer-permission retention, actual installed-artifact confirmation, and independent updater/display-process checks through real 1.0.0 → 1.0.1 → 1.0.2 updates. Offline photo playback and cold startup also passed; updates require connectivity to download and report completion.

The hub's signing key and releases live in `server/data/photo-frame-ota/` (private, ignored by Git, covered by the default `server/data` backup target). Override with `HOMEBRAIN_PHOTO_FRAME_OTA_STORAGE` only with equivalent backup coverage. Restore this key when restoring a hub; replacing it requires pairing frames again. The Android APK key is a separate identity: losing it prevents future APK replacement under the same package. The local initial release key and password are under the private, ignored `embedded/photo-frame-android/.signing/` directory. A byte-verified private backup also exists outside the repository at `~/.codex/credentials/homebrain-frame-android/`, protecting it from checkout cleanup. Both copies are on the Mac; include the private backup in regular encrypted backups. Never copy signing secrets into a deployment archive or publish them with APKs.

For a signed release, supply the existing keystore and password-file paths and increment both version fields:

```sh
cd embedded/photo-frame-android
HOMEBRAIN_FRAME_KEYSTORE="$PWD/.signing/release.p12" \
HOMEBRAIN_FRAME_PASSWORD_FILE="$PWD/.signing/password.txt" \
./gradlew :app:assembleRelease :app:lintRelease \
  -PframeVersionCode=3 -PframeVersionName=1.0.2
```

Without signing variables the release build is unsigned. Verify a signed output with Android SDK `apksigner verify --verbose --min-sdk-version 23 app-release.apk`; Android 6 requires v1/JAR signing. The local signed 1.0.0/build 1, 1.0.1/build 2, and 1.0.2/build 3 acceptance artifacts are under ignored `tmp/photo-frame-releases/`, with their hashes in `releases.json`. Their certificates match and all pass Android-23 signature verification. To roll back behavior, rebuild the desired source with the same signing key and a **higher** version code; validate its data compatibility first.

## API and validation

Management endpoints require a HomeBrain administrator:

- `GET /api/photo-frames` and `/catalog`
- `POST /api/photo-frames` to create a frame
- `PUT /api/photo-frames/:id` to save name, room, and complete configuration
- `POST /api/photo-frames/preview` for formatted live information (also permitted for read-only admins)
- `POST /api/photo-frames/:id/photos` with `{name, data}` (raw base64)
- `DELETE /api/photo-frames/:id/photos/:photoId`
- `PUT /api/photo-frames/:id/photo-order` with `{ids}` containing every photo exactly once
- `POST /api/photo-frames/:id/pair` to issue/rotate credentials
- `GET /api/photo-frames/:id/manifest` and `/photos/:photoId`
- `GET /api/photo-frames/releases` and `POST /api/photo-frames/releases` (raw `application/vnd.android.package-archive`, at most 16 MiB, `X-Frame-Version-Name` and `X-Frame-Version-Code` headers)
- `POST /api/photo-frames/:id/updates` with `{releaseId}`; `DELETE /api/photo-frames/:id/updates` cancels only an unclaimed queued update

The public player assets contain no credentials. Device endpoints are `GET /api/photo-frames/:id/device/manifest` and `/device/photos/:photoId`, authenticated with the frame header. Device tokens are not accepted as administrator sessions. Heartbeats update connection state without replacing concurrent layout/photo edits.

OTA device endpoints, with the same frame credential, are `GET /api/photo-frames/:id/device/updates`, `POST /device/updates/report`, and `GET /device/updates/:jobId/apk`. Artifact access requires that exact frame's current active assignment. Read-only administrators can inspect releases/status but cannot upload, queue, or cancel updates.

Focused server checks:

```sh
node scripts/run-with-modern-node.js node --test server/tests/photoFrame.test.js server/tests/photoFramePlayer.test.js server/tests/weatherService.test.js server/tests/weatherRoutes.test.js server/tests/wallPanelService.test.js
```

Local validation on October 13 included 19 frame/cache server tests, 66 weather/panel tests, 23 client tests, client lint/build, an iOS simulator build, and Android APK compilation. OTA tests cover signed artifact bytes, persisted hub identity, altered files, device scoping, management roles, concurrent assignment reservation, version/phase checks, cancellation, and installed-version confirmation. Host JVM checks exercise the native signature/pinning/package/version trust boundary against tampering and downgrades. A real Chromium session exercised the web editor and saved a layout, checked all six positions and line caps, checked solar-time formatting and invalid draft time zones, verified cached slideshow playback after network failure and full native pairing-link reload, and verified token revocation clears displayed photos and overlays. The physical frame also passed the rendering, cached-image cycling, offline cold-start, and signed OTA checks described above. The iOS source builds; these changes have not yet been distributed to installed iOS clients. Its preview decodes authenticated inline JPEG/PNG bytes locally into a blob, avoiding a data-URL fetch that the hub’s strict `connect-src` policy blocks. A renderer regression check verifies the decoded bytes and visible photo without network access; a real browser check uses the production security policy.

Android lint also passes. An additional full-project TypeScript check reports existing errors across unrelated client modules; it reports no errors in the added photo-frame modules. The normal client build and lint commands succeed.

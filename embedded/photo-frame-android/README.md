# HomeBrain Frame Android runtime

This app presents the HomeBrain photo-frame player fullscreen and can be selected as the Android Home launcher. Its assets come directly from `server/assets/photo-frame-player`, the same renderer used by the web and iOS previews. It supports Android API 23+ with a modern WebView (Chromium 106+ compatibility target).

See [the photo-frame guide](../../docs/photo-frames.md) for pairing, hardware identification, limits, offline behavior, and validation. A compiled APK is not a replacement OS image and does not establish compatibility with the PF1007L's stock WebView.

With JDK 17+ and Android SDK 36 configured:

```sh
./gradlew :app:assembleDebug :app:lintDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`.

Paste a private pairing link from HomeBrain into the app. For an already identified device, a host can also launch `.MainActivity` with a `player_url` string intent extra containing that link. Avoid putting real credentials in shell history, logs, or screenshots.

The shell intercepts only its fixed player asset paths at the configured hub origin. It has no JavaScript/native bridge, cannot load file/content URLs, and does not bypass TLS validation. Local HTTP hubs are supported. The native updater is independent of the page. Boot/system modifications require separate hardware identification and recovery verification.

Unattended OTA requires the initial Android 6 setup to install the **release-signed** APK as a privileged system app with `INSTALL_PACKAGES` actually granted. An ordinary debug/data-app installation reports the installer as not ready. New pairing links pin the hub signing key. The updater checks signed release metadata, APK digest, the installed app's Android signing certificate, strictly newer version code, installer permission and restart receivers before using a `PackageInstaller` session. It confirms the installed version after replacement/restart; it never flashes Android partitions. See the main guide for release signing, server management endpoints, and pending physical acceptance checks.

Preserve `.signing/release.p12` and its private password file. To sign an update with that identity:

```sh
HOMEBRAIN_FRAME_KEYSTORE="$PWD/.signing/release.p12" \
HOMEBRAIN_FRAME_PASSWORD_FILE="$PWD/.signing/password.txt" \
./gradlew :app:assembleRelease :app:lintRelease \
  -PframeVersionCode=2 -PframeVersionName=1.0.1
```

The platform-independent native trust check needs only a JDK:

```sh
mkdir -p /tmp/homebrain-frame-trust
javac -d /tmp/homebrain-frame-trust \
  app/src/main/java/com/homebrain/photoframe/UpdateTrust.java tests/UpdateTrustCheck.java
java -cp /tmp/homebrain-frame-trust com.homebrain.photoframe.UpdateTrustCheck
```

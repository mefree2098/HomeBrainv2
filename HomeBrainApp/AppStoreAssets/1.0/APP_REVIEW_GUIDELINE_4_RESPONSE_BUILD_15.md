# App Review Guideline 4 response — build 15

Prepared August 20, 2026 for HomeBrain **1.0 (build 15)** in response to Apple's August 20 review of build 14.

## Paste this into the App Review message

```text
Hello App Review,

Thank you for identifying the Apple Watch app icon issue. We corrected it in HomeBrain 1.0 (build 15).

The Watch-specific app icon now uses a lighter cyan-to-indigo background instead of a black background. The artwork is full-bleed and opaque, and watchOS applies the circular mask. We verified the resulting icon against a black background at Apple Watch launcher sizes, where the circular silhouette is clearly visible. The iPhone and iPad icon and all app functionality are unchanged.

Please review version 1.0, build 15 rather than rejected build 14.

Thank you.
```

## Exact resubmission sequence

Validated local handoff artifacts have already been created:

- Archive: `HomeBrainApp/AppStoreAssets/1.0/build/HomeBrain-1.0-15.xcarchive`
- App Store export: `HomeBrainApp/AppStoreAssets/1.0/build/HomeBrain-1.0-15-AppStore/HomeBrainApp.ipa`

1. In Finder, double-click `HomeBrain-1.0-15.xcarchive`. Xcode Organizer should open with the `HomeBrain 1.0 (15)` archive selected.
2. Choose **Distribute App > App Store Connect > Upload**, then complete Xcode's validation and upload. The exported IPA above is also ready for Transporter if Transporter is installed later.
3. Wait until build 15 finishes processing in App Store Connect. Complete the export-compliance prompt if it appears.
4. Open **Apps > HomeBrain > iOS App 1.0**, scroll to **Build**, remove build 14 if it is still selected, click **+**, select build 15, click **Done**, and click **Save**.
5. Keep the existing public-audience description, Marketing URL, Support URL, privacy details, review endpoint, and persistent App Review credentials in place.
6. Open the unresolved App Review issue and paste the response above.
7. Confirm the Build section displays `1.0 (15)`, choose **Add for Review**, open the draft submission, and choose **Submit for Review**.

No server or production deployment is required for this fix because the change is contained entirely in the iPhone/Apple Watch application bundle.

## Verification record

- Watch source icon: opaque RGB PNG, 1024 × 1024.
- Background: medium cyan-to-indigo, with no black edge or corner pixels.
- Circular-mask QA: checked on black at 720 px, 196 px, and 98 px; the silhouette remains clearly circular.
- Both the iOS app and embedded Watch app use build number 15.
- Release archive must pass `scripts/validate-ios-app-store-archive.py` before upload.

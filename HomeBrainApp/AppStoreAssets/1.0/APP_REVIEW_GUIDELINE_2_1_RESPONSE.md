# HomeBrain App Review response — Guideline 2.1

Originally prepared July 15, 2026 and updated August 17, 2026 for HomeBrain **1.0 (build 14)**.

This document contains two paste-ready versions:

- **Resolution Center reply** — answers each of Apple's seven questions.
- **App Review Information Notes** — persists the same information for future submissions.

Replace every bracketed value only after verifying it. Do not paste passwords into public App Store metadata; put them in App Store Connect's Sign-in Information fields.

## What changed through build 14

- The iOS app supports both existing-account sign-in and **Set Up New Hub**, which lets any individual create the first household-owner account on a fresh HomeBrain installation. After setup, that owner can add family members or other trusted household users.
- A dedicated Apple App Review account is restricted to a per-user virtual sandbox. Its rooms, devices, groups, scenes, workflows, notifications, weather, security state, voice results, and Watch data are synthetic. Sandbox requests cannot fall through to household devices, integrations, credentials, or global settings.
- The review account can change virtual state—such as toggling a demo light, running a scene, or executing a workflow—without controlling a real residence.
- **Settings → Account → Delete Account** provides in-app account deletion. The user must enter the current password and type `DELETE`. Successful deletion removes the account, sessions, push registrations, isolated sandbox data, and other account-linked data, then returns the app to the signed-out screen. Older unattributable operational records and backups may remain under the hub operator's configured retention practices; they are not available through the deleted account.
- The unauthenticated developer UI Preview and launch override are disabled in Release builds.
- Location, Camera, Local Network, Microphone, and Speech Recognition purpose strings now state when the capability is used and include a concrete example.
- Coordinates sent for optional local weather are rounded to two decimal places and are disclosed as **Coarse Location**.
- Public help and privacy pages are available at `https://freestonefamily.com/support` and `https://freestonefamily.com/privacy`.

The backend still protects the final active HomeBrain administrator from deletion until another administrator exists. This protection does not affect the standard non-admin review accounts.

Official guidance: [Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app).

## Recording attachment

Apple requested a recording captured on a physical device running the latest operating system. Attach the verified physical-device recording before replying.

**Attachment:** `[HomeBrain-1.0-build-14-App-Review-DEVICE-OS.mov]`

A simulator capture may be used internally as a rehearsal, but it does **not** satisfy Apple's request and should not be described as the required attachment. Until the physical-device capture is produced and checked against the submitted build, leave the attachment filename, device, OS, and test-date fields below unresolved.

The recording should begin with launching HomeBrain and show this flow:

1. Launch HomeBrain on the physical device.
2. Show the **Hub Endpoint** field, the public-audience disclosure, and both **Sign In** and **Set Up New Hub**. State that any individual can install HomeBrain and create the first household-owner account.
3. Enter the public HTTPS review endpoint and sign in with the persistent App Review credential from App Store Connect.
4. Respond to the Notifications prompt. HomeBrain requests this after authentication when security notifications are enabled.
5. Show the Settings **Review Sandbox** disclosure. It identifies the data as synthetic and isolated from the owner's household.
6. Show Dashboard, including demo status, favorite devices, scenes, weather, and security.
7. Open Devices and toggle a virtual light or change its virtual brightness.
8. Open Rooms, Scenes, and Workflows; activate one virtual scene and execute one virtual workflow.
9. Open Weather, choose **Use Device Location**, and respond to the Location prompt. Explain that location is optional and used for local weather.
10. Enable Voice Commands and respond to the Microphone and Speech Recognition prompts. Say “Hey HomeBrain, turn on the living room light”; the result changes only the virtual sandbox.
11. Show Notifications and the Apple Watch configuration/companion screen. If a paired Watch is available, show its Overview, Security, Lights, and Weather sections.
12. Sign out of the persistent review account.
13. Sign in with the separate disposable deletion-test credential from the Notes field.
14. Open **Settings → Account → Delete Account**, enter that account's password, type `DELETE`, confirm, and show the automatic return to the signed-out screen.

Do **not** delete the persistent App Review credential. Reset or recreate the disposable deletion-test account before every submission if Apple may repeat the flow.

The review endpoint is public HTTPS, so it does not trigger Local Network permission. That permission is used only when a user enters a LAN hub such as `homebrain.local`. Camera access is limited to the household-owner **Add Z-Wave Device** QR-pairing flow; the read-only reviewer accounts cannot open that flow and therefore will not receive a Camera prompt. State both facts in the recording narration and Notes rather than exposing an owner credential.

HomeBrain has no StoreKit purchase, subscription, paid-content, advertising, or App Tracking Transparency flow. It has no public social feed or publicly shared user-generated content, so purchase and UGC reporting/blocking flows do not apply. User-created room names, scenes, and workflows are private to an authorized HomeBrain hub.

## Device and operating-system test matrix

Apple asked for devices actually tested before submission. Do not claim availability as completed testing. Enter only successful end-to-end runs of the submitted Release/TestFlight build.

| Device model | Operating system | Verification | Result/date |
| --- | --- | --- | --- |
| `[PHYSICAL IPHONE MODEL]` | `[iOS VERSION]` | Fresh install; launch; endpoint; login; permission prompts; Dashboard; virtual device action; scene/workflow; Weather; Voice; Watch screen; deletion with disposable account; sign-out | `[PASS DATE, or omit]` |
| `[SECOND PHYSICAL IPHONE MODEL, if tested]` | `[iOS VERSION]` | Login; primary navigation; virtual device action; background/foreground; sign-out | `[PASS DATE, or omit]` |
| `[PHYSICAL IPAD MODEL, if tested]` | `[iPadOS VERSION]` | Login; portrait and landscape layouts; Dashboard; Devices; Rooms; scene/workflow; sign-out | `[PASS DATE, or omit]` |
| `[PHYSICAL APPLE WATCH MODEL, if tested]` | `[watchOS VERSION]` | Companion session; Overview; Security; Lights; Weather; sign-out/session expiry | `[PASS DATE, or omit]` |

Simulator coverage can be listed separately as supplemental testing, but it does not replace the physical-device recording Apple requested:

- `[Simulator device / OS / test date / result]`

## Answers to Apple's seven questions

### 1. Physical-device recording

Attach `[FILENAME]`, captured on `[PHYSICAL DEVICE MODEL]` running `[OS VERSION]`. Confirm that it begins with app launch and includes sign-in, all permission prompts encountered, representative sandbox control, the iPhone Apple Watch companion/configuration screen, and deletion of the disposable account. Mention paired-Watch screens only if they are actually present in the attachment.

### 2. Devices and operating systems tested

Paste only completed rows from the matrix above:

- `[PHYSICAL DEVICE MODEL] — [OS VERSION] — tested [DATE]`
- `[PHYSICAL DEVICE MODEL] — [OS VERSION] — tested [DATE]`
- `[PHYSICAL iPAD MODEL] — [iPadOS VERSION] — tested [DATE]`
- `[PHYSICAL WATCH MODEL] — [watchOS VERSION] — tested [DATE]`

### 3. Purpose, target audience, problem, and value

HomeBrain is a public consumer companion app for individuals who run their own HomeBrain hub and for other trusted members of their household. It provides one private control surface for compatible smart-home devices, rooms, scenes, workflows, security state, weather, notifications, energy information, optional voice commands, and an Apple Watch companion.

It solves the fragmentation of operating a connected home through separate vendor apps. The HomeBrain backend normalizes authorized devices and services, and the iPhone, iPad, and Watch apps present them through one consistent interface. Any individual can install the publicly available HomeBrain software and create the first household-owner account; the product is not restricted to a business, client, partner, or organization.

### 4. Setup, access, credentials, and sample data

Use two non-personal credentials:

- **Persistent App Review account:** place its email and password in App Store Connect's Username and Password fields. Apple should use this for ordinary review and must not delete it.
- **Disposable deletion-test account:** identify its email and password in the private Notes field. It exists only so Apple can complete the deletion flow without removing persistent access. Reset or recreate it before resubmission.

Setup:

1. Install the submitted build on iPhone or iPad.
2. In **Hub Endpoint**, enter `https://freestonefamily.com` and tap **Save**.
3. Enter the persistent demo email and password from App Store Connect, then tap **Sign In**.
4. No VPN, private DNS, local-network access, sample file, purchase, subscription, or physical smart-home accessory is required.
5. The preconfigured synthetic demo home loads. Its review-only navigation includes Dashboard, Weather, Watch App, Devices, Rooms, Scenes, Workflows, Notifications, and Settings.
6. The sandbox contains nine virtual devices, six named rooms, two groups, three scenes, three workflows, two notifications, synthetic weather, a virtual security state, and Watch configuration. These examples persist for that review account and can be changed safely.
7. Location is requested only when **Use Device Location** is selected. Microphone and Speech Recognition are requested only when Voice Commands are enabled. Notification permission is requested after sign-in when security notifications are enabled. Local Network is used only for a user-entered LAN hub, and Camera is used only by a household owner who chooses **Add Z-Wave Device** and scans its QR code; neither capability is required by the public read-only review environment.
8. The Watch companion uses the same authorized HomeBrain session transferred from its paired iPhone.
9. To test deletion, sign out of the persistent account, sign in with the disposable account, then open **Settings → Account → Delete Account**, enter its password, type `DELETE`, and confirm.

- Support: `https://freestonefamily.com/support`
- Privacy policy: `https://freestonefamily.com/privacy`

Immediately before replying, verify the public endpoint over cellular internet, both credentials, the reset sandbox contents, and the complete deletion flow.

### 5. External services, tools, and platforms

Services used by the submitted app:

- **HomeBrain backend/hub:** account authentication, session handling, normalized home data, commands, rooms, scenes, workflows, notifications, Watch data, and the isolated App Review sandbox.
- **Apple Push Notification service (APNs):** optional HomeBrain notifications on configured household hubs. The App Review sandbox serves synthetic in-app notification records and does not require live push delivery to demonstrate core functionality.
- **Apple Speech Recognition and the device microphone:** optional conversion of a spoken command to text when the user enables Voice Commands.
- **Apple Core Location:** optional device location when the user explicitly chooses automatic local weather.
- **Device camera:** household-owner scanning of a Z-Wave device QR code when that owner explicitly starts the add-device flow.
- **Local Network:** direct connection to a user-entered HomeBrain hub on the same LAN, such as `homebrain.local`; this is not required by the public App Review endpoint.
- **WatchConnectivity and watchOS:** session transfer and companion features on Apple Watch.
- **Open-Meteo:** forecast, geocoding, and air-quality data for configured household weather dashboards. The App Review sandbox can display synthetic weather without depending on this service.

Depending on the household's hub configuration, HomeBrain can integrate with WeatherFlow Tempest, Govee, Ecobee, Sense Energy, RainMachine, HomeBrain-managed Zigbee/Z-Wave/Thread/Matter/Insteon devices, Samsung SmartThings, Amazon Alexa, Logitech Harmony, and other owner-configured home platforms. Optional hub-side voice/AI providers include local Ollama and Whisper, OpenAI, Anthropic, ElevenLabs, and local text-to-speech. None of these optional providers, integrations, or physical accessories is required to review the isolated demo environment.

There is no payment processor because the iOS app has no purchases or subscriptions. There is no advertising or tracking SDK in the submitted iOS app.

For App Privacy, optional weather coordinates are rounded to two decimal places before transmission and should be declared as **Coarse Location**, linked to the user, used for App Functionality, and not used for tracking. Voice-command text is sent to the HomeBrain backend to interpret the requested action. Account-attributable voice history is deleted with the account in the current implementation; older records that cannot be reliably attributed and backups may remain under the hub operator's configured retention practices.

### 6. Regional differences

HomeBrain uses the same app binary, review environment, and feature behavior in every App Store region. It has no region-gated app content. Availability of an optional third-party integration can vary with the provider's service area and the household's compatible hardware. Weather results vary with the location selected by the user. These are provider/data differences, not region-specific versions of HomeBrain.

### 7. Regulated industry or protected third-party material

HomeBrain is a consumer smart-home control product. It is not a medical, financial, legal, gambling, cryptocurrency, transportation, or other highly regulated service. It does not distribute protected entertainment media or third-party editorial content. Provider names and device data are displayed only for hardware and services connected by the HomeBrain hub owner. No regulatory credential or protected-content authorization document is applicable.

## Paste-ready Resolution Center reply

Replace all bracketed values and attach the verified physical-device recording before sending.

```text
Hello App Review,

We attached [FILENAME], recorded on a physical [DEVICE MODEL] running [OS VERSION] on [DATE]. It begins at app launch and shows the requested core, permission, Watch companion, and deletion flows.

1. RECORDING
Build 1.0 (14) has no purchases, subscriptions, paid content, ads, ATT, or public UGC. Notifications prompt after sign-in; Location after Use Device Location; and Microphone/Speech after Voice Commands. Local Network is only for a user-owned LAN hub. Camera is a household-owner Z-Wave QR scanner unavailable to the read-only review accounts.

2. DEVICES AND OPERATING SYSTEMS TESTED
- [PHYSICAL DEVICE MODEL] - [OS VERSION] - tested [DATE]
- [PHYSICAL DEVICE MODEL] - [OS VERSION] - tested [DATE]
- [PHYSICAL IPAD MODEL] - [iPadOS VERSION] - tested [DATE]
- [PHYSICAL WATCH MODEL] - [watchOS VERSION] - tested [DATE]

3. PURPOSE AND TARGET AUDIENCE
HomeBrain gives individuals and trusted household users one private interface for compatible devices, rooms, scenes, workflows, security, weather, notifications, energy, optional voice, and Apple Watch instead of separate vendor apps. Any person can install HomeBrain and create the first household-owner account with Set Up New Hub.

4. SETUP AND ACCESS
Endpoint: https://freestonefamily.com
Use the persistent review username/password in the App Review Sign-in Information fields. Enter the endpoint, save it, and sign in. No VPN, LAN, private DNS, sample file, purchase, subscription, or physical accessory is required.

The persistent account is limited to a per-user sandbox with nine virtual devices plus synthetic rooms, groups, scenes, workflows, notifications, weather, security, and Watch data. Actions cannot reach the owner's household devices, integrations, credentials, or settings.

Notes identifies a disposable deletion-test account. Use Settings > Account > Delete Account, enter its password, type DELETE, and confirm. This removes the account, sessions, push registrations, sandbox, and linked data, then returns to sign-in. Older unattributable logs and backups may remain under configured retention. Do not delete the persistent account.

Support: https://freestonefamily.com/support
Privacy: https://freestonefamily.com/privacy

5. EXTERNAL SERVICES AND PLATFORMS
Core services: HomeBrain backend/hub; Apple APNs, Speech, microphone, Core Location, WatchConnectivity/watchOS; household-owner-started camera QR pairing; Local Network for user-owned LAN hubs; Open-Meteo. Optional integrations: Tempest, Govee, Ecobee, Sense, RainMachine, Zigbee/Z-Wave/Thread/Matter/Insteon, SmartThings, Alexa, Harmony, Ollama/Whisper, OpenAI, Anthropic, and ElevenLabs. Optional services/hardware are not required for review. No payment processor is used.

6. REGIONAL DIFFERENCES
The same binary, review sandbox, and features operate in every App Store region; no content is region-gated. Optional provider/hardware availability and weather results can vary by provider and selected location.

7. REGULATED INDUSTRIES OR PROTECTED MATERIAL
HomeBrain is a consumer smart-home app, not a highly regulated service, and distributes no protected third-party media/editorial content. Provider/device information comes only from hub-owner-authorized integrations; no credential or protected-content authorization document applies.

This information is also in App Review Information Notes. We verified the endpoint and both accounts immediately before replying.

Thank you.
```

## Paste-ready App Review Information Notes

Replace all bracketed values. Put the persistent review email/password in the dedicated Sign-in Information fields. Because Notes is private to App Review, place the disposable credential here only after it has been created and verified.

```text
PURPOSE
HomeBrain gives individuals and trusted household users one private interface for compatible devices, rooms, scenes, workflows, security, weather, notifications, energy, optional voice, and Apple Watch instead of separate vendor apps. Any person can install the public HomeBrain software and create the first household-owner account in the iPhone, iPad, or web app.

REVIEW ACCESS
Endpoint: https://freestonefamily.com
Persistent account: use the Username/Password in the Sign-in Information fields.
Disposable deletion-test email: [EMAIL]
Disposable deletion-test password: [PASSWORD]
Support: https://freestonefamily.com/support
Privacy: https://freestonefamily.com/privacy

No VPN, LAN, private DNS, sample file, purchase, subscription, or accessory is required. Enter the endpoint and sign in; the synthetic demo home loads with Dashboard, Weather, Watch App, Devices, Rooms, Scenes, Workflows, Notifications, and Settings.

SANDBOX ISOLATION
The persistent account has a per-user sandbox with nine devices, six rooms, two groups, three scenes, three workflows, two notifications, synthetic weather/security, and Watch data. It cannot reach household devices, integrations, credentials, or settings.

ACCOUNT DELETION
Use only the disposable account. Open Settings > Account > Delete Account, enter its password, type DELETE, and confirm. The account, sessions, push registrations, sandbox, and linked data are removed; the app returns to sign-in. Older unattributable logs/backups may remain under configured retention. Do not delete the persistent credential. We reset the disposable account before submission.

PERMISSIONS
Notifications prompt after sign-in. Optional Location prompts only after Use Device Location; coordinates are rounded to two decimals and disclosed as Coarse Location. Optional Microphone/Speech prompt after enabling Voice Commands; HomeBrain receives command text. Local Network is only for a user-owned LAN hub such as homebrain.local. Camera is only for the household-owner Add Z-Wave Device QR flow, unavailable to read-only reviewers.

PHYSICAL TESTING
[DEVICE / OS / test date]
[DEVICE / OS / test date]
[IPAD / iPadOS / test date]
[WATCH / watchOS / test date]
Physical-device recording attached: [FILENAME]
Any simulator capture is an internal rehearsal only and is not the recording requested by Apple.

SERVICES
Core: HomeBrain backend/hub; Apple APNs, Speech, microphone, Core Location, WatchConnectivity/watchOS; household-owner camera QR pairing; Local Network for user-owned LAN hubs; Open-Meteo. Optional: Tempest, Govee, Ecobee, Sense, RainMachine, Zigbee/Z-Wave/Thread/Matter/Insteon, SmartThings, Alexa, Harmony, Ollama/Whisper, OpenAI, Anthropic, ElevenLabs. None is required for review. No payments/subscriptions, ads, ATT, or public UGC.

REGIONS AND REGULATION
The same binary/review environment works in all regions; optional providers, hardware, and weather vary. HomeBrain is a consumer smart-home app, not a regulated service, and distributes no protected third-party media/editorial content.
```

## Purpose strings in build 14

- Location: `HomeBrain uses your approximate location only when you choose Use Device Location, for example to show the local forecast on your Weather dashboard.`
- Camera: `HomeBrain uses the camera only when a hub administrator chooses Add Z-Wave Device and scans a device QR code, for example to securely pair a lock or sensor.`
- Local Network: `HomeBrain uses your local network to connect to the HomeBrain hub address you enter, for example homebrain.local, and to display and control devices on that hub.`
- Microphone: `HomeBrain uses the microphone only when you enable Voice Commands, for example when you say “turn on the patio lights.”`
- Speech Recognition: `HomeBrain uses Apple Speech Recognition to turn an optional spoken home-control command into text, for example “set the thermostat to 70.”`

## Pre-reply verification checklist

- `[ ]` Build **1.0 (14)** is selected in the App Store Connect version.
- `[ ]` Production runs the backend revision containing `/api/auth/account` and the review-sandbox gate.
- `[ ]` Persistent review account is active, non-admin, reviewer-only, and can log in from a clean install over cellular internet.
- `[ ]` Persistent account shows only synthetic sandbox content and can safely change virtual state.
- `[ ]` Disposable deletion-test account is active, its password is current, and its sandbox is reset.
- `[ ]` Disposable account deletion succeeds and returns the app to sign-in.
- `[ ]` Physical-device recording is attached and matches the selected build.
- `[ ]` Every device/OS row sent to Apple represents an actual completed test.
- `[ ]` App Review Notes contain the endpoint, setup instructions, disposable credential, services, regions, and regulated-content statement.
- `[ ]` Persistent Username and Password fields are current.

## Apple references

- [App Review preparation and demo-access requirements](https://developer.apple.com/app-store/review/)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app)
- [App Store review details and attachments](https://developer.apple.com/documentation/appstoreconnectapi/app-store-review-details)
- [Record the screen on iPhone](https://support.apple.com/en-ie/102653)

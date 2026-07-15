# HomeBrain App Review response — Guideline 2.1

Prepared July 15, 2026 for HomeBrain **1.0 (build 6)**.

This document contains two paste-ready versions:

- **Resolution Center reply** — answers each of Apple's seven questions.
- **App Review Information Notes** — persists the same information for future submissions.

Replace every bracketed value only after verifying it. Do not paste passwords into public App Store metadata; put them in App Store Connect's Sign-in Information fields.

## What changed in build 6

- The iOS app is **sign-in only**. It has no Register or Create Account option. HomeBrain accounts are created on the HomeBrain backend by an administrator and then supplied to authorized household users.
- A dedicated Apple App Review account is restricted to a per-user virtual sandbox. Its rooms, devices, groups, scenes, workflows, notifications, weather, security state, voice results, and Watch data are synthetic. Sandbox requests cannot fall through to household devices, integrations, credentials, or global settings.
- The review account can change virtual state—such as toggling a demo light, running a scene, or executing a workflow—without controlling a real residence.
- **Settings → Account → Delete Account** provides in-app account deletion. The user must enter the current password and type `DELETE`. Successful deletion removes the account and associated personal data, invalidates its sessions, and returns the app to the signed-out screen.
- The unauthenticated developer UI Preview and launch override are disabled in Release builds.
- Location, Microphone, and Speech Recognition purpose strings now state when the capability is requested and include a concrete example.

The backend still protects the final active HomeBrain administrator from deletion until another administrator exists. This protection does not affect the standard non-admin review accounts.

Official guidance: [Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app).

## Recording attachment

Apple requested a recording captured on a physical device running the latest operating system. Attach the verified physical-device recording before replying.

**Attachment:** `[HomeBrain-1.0-build-6-App-Review-DEVICE-OS.mov]`

The recording should begin with launching HomeBrain and show this flow:

1. Launch HomeBrain on the physical device.
2. Show the **Hub Endpoint** field and the sign-in-only screen. State that accounts are provisioned by a HomeBrain administrator; the iOS app has no public or in-app registration.
3. Enter the public HTTPS review endpoint and sign in with the persistent App Review credential from App Store Connect.
4. Respond to the Notifications prompt. HomeBrain requests this after authentication when security notifications are enabled.
5. Show the Settings **Review Sandbox** disclosure. It identifies the data as synthetic and isolated from the owner's household.
6. Show Dashboard, including demo status, favorite devices, scenes, weather, and security.
7. Open Devices and toggle a virtual light or change its virtual brightness.
8. Open Rooms, Scenes, and Workflows; activate one virtual scene and execute one virtual workflow.
9. Open Weather, choose **Use Device Location**, and respond to the Location prompt. Explain that location is optional and used for local weather.
10. Enable Voice Commands and respond to the Microphone and Speech Recognition prompts. Use a harmless command such as “turn on the living room light”; the result changes only the virtual sandbox.
11. Show Notifications and the Apple Watch configuration/companion screen. If a paired Watch is available, show its Overview, Security, Lights, and Weather sections.
12. Sign out of the persistent review account.
13. Sign in with the separate disposable deletion-test credential from the Notes field.
14. Open **Settings → Account → Delete Account**, enter that account's password, type `DELETE`, confirm, and show the automatic return to the signed-out screen.

Do **not** delete the persistent App Review credential. Reset or recreate the disposable deletion-test account before every submission if Apple may repeat the flow.

HomeBrain has no StoreKit purchase, subscription, paid-content, advertising, or App Tracking Transparency flow. It has no public social feed or publicly shared user-generated content, so purchase and UGC reporting/blocking flows do not apply. User-created room names, scenes, and workflows are private to an authorized HomeBrain hub.

## Device and operating-system test matrix

Apple asked for devices actually tested before submission. Do not claim availability as completed testing. Enter only successful end-to-end runs of the submitted Release/TestFlight build.

| Device model | Operating system | Verification | Result/date |
| --- | --- | --- | --- |
| iPhone Air | iOS 27.0 | Fresh install; launch; endpoint; login; Notifications, Location, Microphone, and Speech prompts; Dashboard; virtual device action; scene/workflow; Weather; Voice; Watch screen; deletion with disposable account; sign-out | `[PASS and date, or omit]` |
| iPhone 16 Pro Max | iOS 26.5.2 | Login; primary navigation; virtual device action; background/foreground; sign-out | `[PASS and date, or omit]` |
| iPad (9th generation) | iPadOS 26.4 | Login; portrait and landscape layouts; Dashboard; Devices; Rooms; scene/workflow; sign-out | `[PASS and date, or omit]` |
| Apple Watch `[model]` | watchOS `[version]` | Companion session; Overview; Security; Lights; Weather; sign-out/session expiry | `[PASS and date, or omit]` |

Simulator coverage can be listed separately as supplemental testing, but it does not replace the physical-device recording Apple requested:

- `[Simulator device / OS / test date / result]`

## Answers to Apple's seven questions

### 1. Physical-device recording

Attach `[FILENAME]`, captured on `[PHYSICAL DEVICE MODEL]` running `[OS VERSION]`. Confirm that it begins with app launch and includes sign-in, all permission prompts encountered, representative sandbox control, the Watch experience, and deletion of the disposable account.

### 2. Devices and operating systems tested

Paste only completed rows from the matrix above:

- `[PHYSICAL DEVICE MODEL] — [OS VERSION] — tested [DATE]`
- `[PHYSICAL DEVICE MODEL] — [OS VERSION] — tested [DATE]`
- `[PHYSICAL iPAD MODEL] — [iPadOS VERSION] — tested [DATE]`
- `[PHYSICAL WATCH MODEL] — [watchOS VERSION] — tested [DATE]`

### 3. Purpose, target audience, problem, and value

HomeBrain is a companion app for people who own a HomeBrain hub and for household members authorized by that hub's administrator. It provides one private control surface for compatible smart-home devices, rooms, scenes, workflows, security state, weather, notifications, energy information, optional voice commands, and an Apple Watch companion.

It solves the fragmentation of operating a connected home through separate vendor apps. The HomeBrain backend normalizes authorized devices and services, and the iPhone, iPad, and Watch apps present them through one consistent interface. The app requires a configured HomeBrain hub and an administrator-provisioned account; it is not a public account or social-content service.

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
7. Location is requested only when **Use Device Location** is selected. Microphone and Speech Recognition are requested only when Voice Commands are enabled. Notification permission is requested after sign-in when security notifications are enabled.
8. The Watch companion uses the same authorized HomeBrain session transferred from its paired iPhone.
9. To test deletion, sign out of the persistent account, sign in with the disposable account, then open **Settings → Account → Delete Account**, enter its password, type `DELETE`, and confirm.

Immediately before replying, verify the public endpoint over cellular internet, both credentials, the reset sandbox contents, and the complete deletion flow.

### 5. External services, tools, and platforms

Services used by the submitted app:

- **HomeBrain backend/hub:** account authentication, session handling, normalized home data, commands, rooms, scenes, workflows, notifications, Watch data, and the isolated App Review sandbox.
- **Apple Push Notification service (APNs):** optional HomeBrain notifications on configured customer hubs. The App Review sandbox serves synthetic in-app notification records and does not require live push delivery to demonstrate core functionality.
- **Apple Speech Recognition and the device microphone:** optional conversion of a spoken command to text when the user enables Voice Commands.
- **Apple Core Location:** optional device location when the user explicitly chooses automatic local weather.
- **WatchConnectivity and watchOS:** session transfer and companion features on Apple Watch.
- **Open-Meteo:** forecast, geocoding, and air-quality data for configured customer weather dashboards. The App Review sandbox can display synthetic weather without depending on this service.

Depending on the customer's hub configuration, HomeBrain can integrate with WeatherFlow Tempest, Govee, Ecobee, Sense Energy, RainMachine, HomeBrain-managed Zigbee/Z-Wave/Thread/Matter/Insteon devices, Samsung SmartThings, Amazon Alexa, Logitech Harmony, and other administrator-configured home platforms. Optional hub-side voice/AI providers include local Ollama and Whisper, OpenAI, Anthropic, ElevenLabs, and local text-to-speech. None of these optional providers, integrations, or physical accessories is required to review the isolated demo environment.

There is no payment processor because the iOS app has no purchases or subscriptions. There is no advertising or tracking SDK in the submitted iOS app.

### 6. Regional differences

HomeBrain uses the same app binary, review environment, and feature behavior in every App Store region. It has no region-gated app content. Availability of an optional third-party integration can vary with the provider's service area and the customer's compatible hardware. Weather results vary with the location selected by the user. These are provider/data differences, not region-specific versions of HomeBrain.

### 7. Regulated industry or protected third-party material

HomeBrain is a consumer smart-home control product. It is not a medical, financial, legal, gambling, cryptocurrency, transportation, or other highly regulated service. It does not distribute protected entertainment media or third-party editorial content. Provider names and device data are displayed only for hardware and services connected by the HomeBrain hub owner. No regulatory credential or protected-content authorization document is applicable.

## Paste-ready Resolution Center reply

Replace all bracketed values and attach the verified physical-device recording before sending.

```text
Hello App Review,

Thank you for the request. We have attached “[FILENAME],” captured on a physical [DEVICE MODEL] running [OS VERSION]. The recording begins with launching HomeBrain and demonstrates the sign-in-only flow, all permission prompts encountered, Dashboard, a virtual device action, Rooms, Scenes, Workflows, Weather, Voice Commands, the Watch experience, account deletion with a disposable account, and return to the signed-out screen.

Replacement build 1.0 (6) removes the in-app Register option, provides isolated interactive review data, adds in-app account deletion, clarifies the Location/Microphone/Speech purpose strings, and excludes the developer UI Preview from Release builds.

1. RECORDING
The attached physical-device recording shows the typical user flow. HomeBrain has no purchases, subscriptions, paid content, advertising, ATT flow, or public UGC feed. Notifications are requested after sign-in when enabled. Location is requested only when Use Device Location is selected. Microphone and Speech Recognition are requested only when Voice Commands are enabled.

2. DEVICES TESTED
- [DEVICE / OS / test date]
- [DEVICE / OS / test date]
- [IPAD / iPadOS / test date]
- [APPLE WATCH / watchOS / test date]

3. PURPOSE AND AUDIENCE
HomeBrain is a companion for owners and authorized household users of a HomeBrain hub. It provides one private interface for compatible devices, rooms, scenes, workflows, security state, weather, notifications, energy information, optional voice commands, and Apple Watch. It reduces the need to operate a connected home through separate vendor apps. The app requires an administrator-provisioned HomeBrain account and has no public or in-app registration.

4. SETUP AND ACCESS
Review endpoint: https://freestonefamily.com
Use the persistent demo username and password in the App Review Sign-in Information fields. No VPN, LAN, private DNS, sample file, purchase, subscription, or physical accessory is required. Enter the endpoint, sign in, and the synthetic demo Dashboard loads. The review account can access Dashboard, Weather, Watch App, Devices, Rooms, Scenes, Workflows, Notifications, and Settings.

The demo account is restricted to a per-user App Review sandbox containing nine virtual devices, six named rooms, two groups, three scenes, three workflows, two notifications, synthetic weather, virtual security state, and Watch configuration. Actions persist only in that account's sandbox and cannot read or control the owner's household devices, integrations, credentials, or settings.

ACCOUNT DELETION
The private Notes field includes a separate disposable deletion-test credential. Sign in with it, then open Settings > Account > Delete Account, enter its password, type DELETE, and confirm. The account, sessions, push registrations, notifications, voice-command history, security PIN references, and isolated sandbox state are removed, and the app returns to sign-in. Please do not delete the persistent demo credential.

5. SERVICES AND PLATFORMS
HomeBrain uses its backend/hub, Apple Push Notification service, Apple Speech Recognition, the device microphone, Core Location, WatchConnectivity/watchOS, and Open-Meteo. Optional hub integrations include WeatherFlow Tempest, Govee, Ecobee, Sense Energy, RainMachine, Zigbee/Z-Wave/Thread/Matter/Insteon, SmartThings, Alexa, Harmony, local Ollama/Whisper, and optional OpenAI/Anthropic/ElevenLabs providers. Optional providers and physical accessories are not required in the isolated review environment. No payment processor is used.

6. REGIONS
The same binary, review environment, and app features operate in every App Store region. There is no region-gated content. Optional provider/hardware availability and weather results can vary by provider and selected location.

7. REGULATION AND PROTECTED MATERIAL
HomeBrain is a consumer smart-home app, not a highly regulated service. It does not distribute protected third-party media or editorial content. Device/provider information is displayed only for integrations authorized by the hub owner, so no regulatory credential or protected-content authorization document is applicable.

We have copied this information into App Review Information Notes and verified the endpoint and both credentials immediately before replying.

Thank you.
```

## Paste-ready App Review Information Notes

Replace all bracketed values. Put the persistent review email/password in the dedicated Sign-in Information fields. Because Notes is private to App Review, place the disposable credential here only after it has been created and verified.

```text
PURPOSE
HomeBrain is a companion for owners and authorized household users of a HomeBrain hub. It provides one private interface for compatible devices, rooms, scenes, workflows, security state, weather, notifications, energy information, optional voice commands, and Apple Watch. The iOS app is sign-in only: accounts are provisioned by a HomeBrain administrator; public and in-app registration are not supported.

REVIEW ACCESS
Endpoint: https://freestonefamily.com
Persistent account: use the Username/Password in the Sign-in Information fields.
Disposable deletion-test email: [EMAIL]
Disposable deletion-test password: [PASSWORD]

No VPN, LAN, private DNS, sample file, purchase, subscription, or physical accessory is required. Enter the endpoint, sign in, and the synthetic demo home loads. The review-only navigation contains Dashboard, Weather, Watch App, Devices, Rooms, Scenes, Workflows, Notifications, and Settings.

SANDBOX ISOLATION
The persistent account is restricted to a per-user virtual sandbox with nine devices, six named rooms, two groups, three scenes, three workflows, two notifications, synthetic weather, virtual security, and Watch data. Its actions cannot read or control the owner's household devices, integrations, credentials, or global settings.

ACCOUNT DELETION
Use only the disposable account for this test. Open Settings > Account > Delete Account, enter its current password, type DELETE, and confirm. The account and associated personal data are deleted and the app returns to sign-in. Please do not delete the persistent review credential. The disposable account is reset before each submission.

PERMISSIONS
Notifications are requested after sign-in when security notifications are enabled. Location is optional and requested only after choosing Use Device Location for weather. Microphone and Apple Speech Recognition are optional and requested only after enabling Voice Commands.

PHYSICAL TESTING
[DEVICE / OS / test date]
[DEVICE / OS / test date]
[IPAD / iPadOS / test date]
[WATCH / watchOS / test date]
Physical-device recording attached: [FILENAME]

SERVICES
HomeBrain backend/hub; Apple APNs, Speech Recognition, device microphone, Core Location, WatchConnectivity/watchOS; Open-Meteo. Optional hub integrations include Tempest, Govee, Ecobee, Sense, RainMachine, Zigbee/Z-Wave/Thread/Matter/Insteon, SmartThings, Alexa, Harmony, local Ollama/Whisper, and optional OpenAI/Anthropic/ElevenLabs providers. Optional integrations and hardware are not required for review. There are no payments/subscriptions, ads, ATT, or public UGC.

REGIONS AND REGULATION
The same binary, review environment, and features operate in all App Store regions; optional provider/hardware availability and weather data can vary. HomeBrain is a consumer smart-home app, not a highly regulated service, and distributes no protected third-party media or editorial content.
```

## Purpose strings in build 6

- Location: `HomeBrain uses your approximate location only when you choose Use Device Location, for example to show the local forecast on your Weather dashboard.`
- Microphone: `HomeBrain uses the microphone only when you enable Voice Commands, for example when you say “turn on the patio lights.”`
- Speech Recognition: `HomeBrain uses Apple Speech Recognition to turn an optional spoken home-control command into text, for example “set the thermostat to 70.”`

## Pre-reply verification checklist

- `[ ]` Build **1.0 (6)** is selected in the App Store Connect version.
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

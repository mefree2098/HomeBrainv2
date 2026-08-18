# HomeBrain — App Store Connect submission packet

Prepared for version **1.0 (build 14)** of bundle ID `NTechR.HomeBrainApp`. The app's project declares **Utilities** as its category and includes an Apple Watch companion (`NTechR.HomeBrainApp.watchkitapp`). Build 14 adds public first-owner setup, retains self-service account deletion, and recognizes the dedicated Apple reviewer account as an isolated virtual sandbox.

> **App Review follow-up:** Apple requested additional Guideline 2.1 information on July 15, 2026. Use [`APP_REVIEW_GUIDELINE_2_1_RESPONSE.md`](./APP_REVIEW_GUIDELINE_2_1_RESPONSE.md) before replying or resubmitting.

## 1. Upload these screenshots

Upload the numbered PNGs in the shown order only after they have been recaptured from the current Release build and visually checked. Screenshots may be captured in Simulator, but they must show the actual app in use with the isolated reviewer sandbox—not a title card, splash screen, login-only view, developer preview, or outdated household/admin data.

| App Store Connect tab | Folder | Files | Exact pixel size |
| --- | --- | --- | --- |
| iPhone — 6.5-inch Display | `iphone-6.5/` | `01-dashboard.png`, `02-devices.png`, `03-scenes.png`, `04-workflows.png` | 1284 × 2778 |
| iPad — 13-inch Display | `ipad-13/` | `01-dashboard.png`, `02-devices.png`, `03-scenes.png`, `04-workflows.png` | 2064 × 2752 |
| Apple Watch — Series 11 | `watch-series-11/` | `01-overview.png`, `02-security.png` | 416 × 496 |

The first three iPhone images are deliberately ordered as Dashboard, Devices, and Scenes because App Store Connect uses the first three on installation sheets. The two Watch images use one consistent 416 × 496 size; keep that size for every localization.

The stored files were captured from build 7 against the nine-device reviewer sandbox and validated as opaque PNGs at the listed dimensions. Recheck them visually immediately before upload. Recapture them from build 14 if any submitted image or caption discusses onboarding or account availability.

## 2. Ready-to-paste store listing copy

| Field | Value |
| --- | --- |
| Name | `HomeBrain` |
| Subtitle | `Your home, in one place` |
| Primary category | `Utilities` |
| Secondary category | `Lifestyle` |
| Keywords (93 characters) | `smart home,home automation,lights,thermostat,scenes,voice control,energy,security,Apple Watch` |
| Promotional text (123 characters) | `See your home at a glance, run favorite scenes, and manage compatible rooms and devices from iPhone, iPad, and Apple Watch.` |
| Version | `1.0` |
| Build to select | `14` |
| Copyright — confirm the legal owner first | `2026 [CONFIRMED LEGAL OWNER]` |
| SKU | Use the SKU already shown in this App Store Connect app record. It is account-specific and cannot be changed after the app record is created. |

### Description

```text
HomeBrain brings your connected home into one calm, private control center. See what’s happening across rooms, manage compatible lights, thermostats, locks, cameras, scenes, and automations, and keep daily routines moving with natural voice commands.

• Control compatible devices from one dashboard
• Organize devices by room and favorites
• Run scenes and workflows for everyday routines
• Monitor home status, security, weather, and energy at a glance
• Use Apple Watch for quick lights, security, power, and weather checks
• Designed for your HomeBrain hub and your connected home

HomeBrain is available to any individual or household and is not limited to a company, client, partner, or organization. It requires a user-owned HomeBrain hub. Any person can install the publicly available HomeBrain software and create the first household-owner account from the iPhone, iPad, or web app. Device availability varies with the compatible services and hardware each household chooses.
```

App Store Connect does not require **What's New in This Version** for the first version of an app. Do not invent or paste release notes for version 1.0 unless the field is unexpectedly presented and required for this existing record.

## 3. Values you must supply or confirm

These values are factual, legal, or account-specific, so they should not be invented.

| App Store Connect field | What to enter or decide |
| --- | --- |
| Support URL | `https://freestonefamily.com/support` — the deployed page must load without authentication and its no-login support request form must submit successfully before resubmission. |
| Privacy Policy URL | `https://freestonefamily.com/privacy` — use only after confirming it loads without authentication and matches the released behavior and retention. |
| Marketing URL | `https://freestonefamily.com/getting-started` — public audience, installation, account-creation, and pricing information. |
| Pricing and availability | Choose Free or a paid tier and the exact countries/regions. The iOS source has no StoreKit purchase implementation, so do not advertise in-app purchases unless another release component adds them. This remains an App Store Connect account decision. |
| Copyright owner | Confirm the legal individual or company and enter `2026 [CONFIRMED LEGAL OWNER]`; Apple supplies the copyright symbol. Do not use `NTechR` unless it is the confirmed owner. |
| Content rights | Likely confirm that you have rights to the HomeBrain product, branding, device integrations, and any displayed third-party content. Choose the answer that reflects the actual integrations and licenses. |
| License agreement | Use Apple’s standard EULA unless counsel has supplied a custom EULA. |
| Age rating questionnaire | Expected outcome is **4+** if the product has no mature, gambling, violent, or open social/user-generated content. Complete the questionnaire from the released product, not this estimate. |
| App Review contact | Confirm a real name, monitored email, and phone number for someone reachable during review. These have not been supplied and must not be invented. |
| Demo access | A public HTTPS endpoint; a persistent reviewer-only account and password; an isolated virtual sandbox; and a separate disposable account for Apple to test deletion. Keep the persistent account live through review and reset the disposable account before each submission. |
| Release method | Recommended for 1.0: manually release after approval, so the listing and support materials can be checked one final time. |
| Export compliance | Complete the encryption questionnaire for the archived binary. HTTPS/TLS normally means the app uses encryption; determine whether the applicable exemption applies before answering. |
| Digital Services Act trader status | Confirm the legal/account status and complete any required trader contact verification in App Store Connect. This cannot be inferred from the codebase. |
| SKU | Read the existing value from the app record. It is immutable; do not replace it with a suggested value. |

## 4. App Review Information

Set **Sign-in required** to **Yes** for App Review and provide the non-personal persistent review account. Build 14 also offers **Set Up New Hub** so any individual can create the first household-owner account on a fresh HomeBrain installation. After initial setup, the household owner can add family members or other trusted users.

The complete paste-ready response and Notes-field copy are in [`APP_REVIEW_GUIDELINE_2_1_RESPONSE.md`](./APP_REVIEW_GUIDELINE_2_1_RESPONSE.md). The condensed Notes below still requires a verified endpoint, two verified credentials, actual physical test results, and the final recording filename.

```text
PURPOSE
HomeBrain is a public consumer companion for individuals and households that run their own HomeBrain hub. It is not restricted to a business, client, employer, partner, or invited organization. Any person can download the publicly available Apache-2.0 HomeBrain software, install a hub, and use Set Up New Hub in the iPhone or iPad app to create the first household-owner account. It provides one private interface for compatible devices, rooms, scenes, workflows, security state, weather, notifications, energy information, optional voice commands, and Apple Watch.

REVIEW ACCESS
Endpoint: https://freestonefamily.com
Persistent account: use the Username/Password in App Store Connect's Sign-in Information fields.
Disposable deletion-test email: [EMAIL]
Disposable deletion-test password: [PASSWORD]
Support: https://freestonefamily.com/support
Privacy: https://freestonefamily.com/privacy

No VPN, LAN, private DNS, sample file, purchase, subscription, or physical accessory is required. Enter the endpoint and sign in. The persistent account is restricted to a per-user sandbox with nine virtual devices, six named rooms, two groups, three scenes, three workflows, two notifications, synthetic weather, virtual security, and Watch data. Actions cannot read or control the owner's household devices, integrations, credentials, or settings.

The reviewer can use Dashboard, Weather, Watch App, Devices, Rooms, Scenes, Workflows, Notifications, and Settings. Notifications are requested after sign-in when enabled. Location is requested only after choosing Use Device Location; coordinates are rounded to two decimal places and disclosed as Coarse Location. Microphone and Apple Speech Recognition are requested only after enabling Voice Commands; the resulting command text is sent to HomeBrain for interpretation. Local Network is used only for a user-entered LAN hub. Camera is limited to the household-owner Add Z-Wave Device QR scanner and is unavailable to the read-only review accounts. The Watch companion uses the same authorized session from its paired iPhone.

ACCOUNT DELETION
Use only the disposable account. Open Settings > Account > Delete Account, enter its password, type DELETE, and confirm. Its account, sessions, push registrations, isolated sandbox, and account-linked data are removed, and the app returns to sign-in. Older unattributable operational records and backups may remain under the hub operator's configured retention practices. Please do not delete the persistent review credential.

PHYSICAL TESTING
[DEVICE / OS / date]
[DEVICE / OS / date]
[IPAD / iPadOS / date]
[WATCH / watchOS / date]
Recording attached: [FILENAME]
The physical-device recording is required. Any simulator capture is an internal rehearsal only.

SERVICES/REGIONS/REGULATION
HomeBrain uses its backend/hub, Apple APNs, Speech Recognition, the device microphone, Core Location, the device camera for household-owner-started Z-Wave QR pairing, Local Network for user-entered LAN hubs, WatchConnectivity/watchOS, and Open-Meteo. Optional hub integrations and AI/voice providers are listed in the attached Guideline 2.1 response and are not required for review. There are no paid accounts, in-app purchases, subscriptions, ads, ATT, or public UGC. The same binary and features operate in all App Store regions. HomeBrain is a consumer smart-home app, not a highly regulated service, and distributes no protected third-party media or editorial content.
```

Do not submit until the public endpoint works over cellular internet, the persistent account reaches only the virtual sandbox, the disposable deletion account has been reset, and both credentials have been verified from a clean install. The reviewer must not need local-network access or physical smart-home hardware.

## 5. App Privacy — implementation-based draft

This is a conservative technical draft, not a privacy-law determination. Apple’s form must cover data collected by the app **and** its third-party partners, including the HomeBrain backend and enabled integrations. Confirm it against production configuration and the owner of the privacy policy before saving. Public policy URL: `https://freestonefamily.com/privacy`.

For the audited build, use **Linked to the User: Yes**, **Used for Tracking: No**, and **Purpose: App Functionality** for the following categories unless production behavior differs:

| Apple data type | What HomeBrain uses |
| --- | --- |
| Contact Info — Name | Account profile/display name and an optional name submitted through the no-login support form. |
| Contact Info — Email Address | Authentication/account identity and the reply address required by the no-login support form. |
| Identifiers — User ID | Backend account and authorized-hub identity. |
| Identifiers — Device ID | Installation identifier and APNs registration/token metadata. |
| Location — Coarse Location | Optional weather coordinates, rounded to two decimal places before transmission, only after the user chooses **Use Device Location**. Do not declare Precise Location if every transmitted coordinate follows this rounding behavior. |
| User Content — Other User Content | Voice-command text; private device, room, group, scene, and workflow names/configuration; and support subject/message. HomeBrain receives command text, not a stored microphone recording, in the audited flow. |
| Usage Data — Product Interaction | Device actions, scene/workflow executions, and associated history needed to operate and show the home. |
| Other Data — Other Data Types | Authorized home state plus technical/session/device metadata used to provide the service. |

Additional decisions that must be verified before saving:

1. If a typed full street address or custom-location search is sent or retained, also declare **Contact Info — Physical Address** and/or **Search History** as appropriate. Restricting input and storage to city/postal-level data may change that answer, but do not assume it.
2. Do not select **Audio Data** merely because `SFSpeechRecognizer` is used if HomeBrain and its non-Apple partners receive only the transcript and no microphone recording. Re-check this if audio is sent to or retained by HomeBrain, Whisper, another voice provider, or any third party.
3. Voice-command text is sent to HomeBrain to interpret actions. Account-attributable voice history is removed with account deletion in the current implementation. Legacy records that cannot reliably be attributed and backups may remain under the hub operator's configured retention practices.
4. No analytics, advertising, or tracking SDK was found in the audited iOS source. Confirm production backend logging and every optional integration before marking Diagnostics or any additional category as not collected.
5. Confirm that HomeBrain does not sell data, combine it with third-party data for advertising, or track people across other companies’ apps or websites. If that changes, the Tracking answer must change.

The policy and labels must plainly cover Location, Camera, Local Network, Microphone, Speech Recognition, command transcripts, home configuration/state, account and device identifiers, APNs registrations, public support requests and their 90-day retention, deletion, and any customer-enabled provider that collects additional data.

## 6. Final App Store Connect sequence

1. Open the existing app record for bundle ID `NTechR.HomeBrainApp`; read and preserve its existing immutable SKU.
2. Complete App Information: name, subtitle, categories, content rights, age rating, verified support URL, verified privacy-policy URL, and `2026 [CONFIRMED LEGAL OWNER]`. Do not add What's New text for this first version.
3. Complete App Privacy with the verified answers above; add the public privacy-policy URL.
4. Under version 1.0, paste the listing copy, upload the four iPhone images, four iPad images, and two Watch images in the folders above.
5. Choose build 14 after it has finished processing, complete export compliance, and check the embedded iOS and Watch app icons on the processed build.
6. Enter real App Review contact details, the public endpoint, the persistent credential, the disposable deletion-test credential, verified device/OS results, and the review notes above. Attach the physical-device recording requested under Guideline 2.1; a simulator rehearsal does not satisfy this request.
7. Choose pricing, territories, Digital Services Act trader status, and a release method; ensure Agreements, Tax, Banking, and any trader-contact verification are complete where required.
8. Save, use **Add for Review**, then submit when every required field shows complete.

## Official Apple references

- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [App information fields](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information)
- [App privacy details](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy)
- [Submitting an app for review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app)
- [App Review guidelines and preparation](https://developer.apple.com/app-store/review/)

## Remaining manual/account decisions

The following cannot be derived safely from the repository and remain unresolved until the account owner confirms them:

- `[CONFIRMED LEGAL OWNER]` for copyright and any seller/legal-name fields.
- The App Review contact name, monitored email, and phone. The public Support URL provides a no-login request form, but App Review still requires direct private contact details in App Store Connect.
- The existing immutable SKU shown in App Store Connect.
- App price, exact countries/regions, release method, and Digital Services Act trader status/contact verification.
- Content-rights, age-rating, license-agreement, and export-compliance answers made by the legal/account owner.
- Actual physical device/OS test results and dates from the submitted Release/TestFlight build.
- The final physical-device recording filename after it is captured and reviewed; the simulator video is rehearsal material only.
- Final confirmation that both reviewer accounts work, the disposable account has been reset, and the deployed support/privacy pages match the submitted build and policy.

# HomeBrain — App Store Connect submission packet

Prepared for version **1.0 (build 6)** of bundle ID `NTechR.HomeBrainApp`. The app's project declares **Utilities** as its category and includes an Apple Watch companion (`NTechR.HomeBrainApp.watchkitapp`). Build 6 is sign-in only, adds self-service account deletion, and recognizes the dedicated Apple reviewer account as an isolated virtual sandbox.

> **App Review follow-up:** Apple requested additional Guideline 2.1 information on July 15, 2026. Use [`APP_REVIEW_GUIDELINE_2_1_RESPONSE.md`](./APP_REVIEW_GUIDELINE_2_1_RESPONSE.md) before replying or resubmitting.

## 1. Upload these screenshots

Upload the numbered PNGs in the shown order. They are native simulator captures using HomeBrain's safe preview data.

| App Store Connect tab | Folder | Files | Exact pixel size |
| --- | --- | --- | --- |
| iPhone — 6.5-inch Display | `iphone-6.5/` | `01-dashboard.png`, `02-devices.png`, `03-rooms.png` | 1284 × 2778 |
| iPad — 13-inch Display | `ipad-13/` | `01-dashboard.png`, `02-devices.png`, `03-rooms.png` | 2064 × 2752 |
| Apple Watch — Series 11 | `watch-series-11/` | `01-overview.png`, `02-security.png` | 416 × 496 |

The first three iPhone images are deliberately ordered as Dashboard, Devices, and Rooms because App Store Connect uses the first three on installation sheets. The two Watch images use one consistent 416 × 496 size; keep that size for every localization.

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
| Build to select | `6` |
| Copyright — confirm the legal owner first | `© 2026 NTechR. All rights reserved.` |
| Recommended SKU — must be unique in your App Store Connect account | `homebrain-ios-001` |

### Description

```text
HomeBrain brings your connected home into one calm, private control center. See what’s happening across rooms, manage compatible lights, thermostats, locks, cameras, scenes, and automations, and keep daily routines moving with natural voice commands.

• Control compatible devices from one dashboard
• Organize devices by room and favorites
• Run scenes and workflows for everyday routines
• Monitor home status, security, weather, and energy at a glance
• Use Apple Watch for quick lights, security, power, and weather checks
• Designed for your HomeBrain hub and your connected home

HomeBrain requires a HomeBrain hub and an account provisioned by its administrator. Device availability varies with your connected services and hardware.
```

### What's New for 1.0

```text
Welcome to HomeBrain. This first release brings your dashboard, rooms, devices, scenes, automations, voice controls, and Apple Watch companion together in one place.
```

## 3. Values you must supply or confirm

These values are factual, legal, or account-specific, so they should not be invented.

| App Store Connect field | What to enter or decide |
| --- | --- |
| Support URL | A public HTTPS support page or support portal for HomeBrain. This is required for an iOS app listing. |
| Privacy Policy URL | A public HTTPS policy that accurately covers HomeBrain, its server, push notifications, Apple Speech Recognition, and every third-party integration. This is required. |
| Marketing URL | Optional public product page; omit if none exists. |
| Pricing and availability | Choose Free or a paid tier, countries/regions, and whether to make the app available globally. The iOS source has no StoreKit purchase implementation, so do not advertise in-app purchases unless another release component adds them. |
| Copyright owner | Confirm the legal individual or company. Replace `NTechR` above if it is not the owner. |
| Content rights | Likely confirm that you have rights to the HomeBrain product, branding, device integrations, and any displayed third-party content. Choose the answer that reflects the actual integrations and licenses. |
| License agreement | Use Apple’s standard EULA unless counsel has supplied a custom EULA. |
| Age rating questionnaire | Expected outcome is **4+** if the product has no mature, gambling, violent, or open social/user-generated content. Complete the questionnaire from the released product, not this estimate. |
| App Review contact | Name, email, and phone for someone reachable during review. |
| Demo access | A public HTTPS endpoint; a persistent reviewer-only account and password; an isolated virtual sandbox; and a separate disposable account for Apple to test deletion. Keep the persistent account live through review and reset the disposable account before each submission. |
| Release method | Recommended for 1.0: manually release after approval, so the listing and support materials can be checked one final time. |
| Export compliance | Complete the encryption questionnaire for the archived binary. HTTPS/TLS normally means the app uses encryption; determine whether the applicable exemption applies before answering. |

## 4. App Review Information

Set **Sign-in required** to **Yes**. Give Apple credentials for a non-personal persistent review account, not an administrator's account. The iOS app has no Register/Create Account option: accounts are provisioned on the HomeBrain backend by an administrator.

The complete paste-ready response and Notes-field copy are in [`APP_REVIEW_GUIDELINE_2_1_RESPONSE.md`](./APP_REVIEW_GUIDELINE_2_1_RESPONSE.md). The condensed Notes below still requires a verified endpoint, two verified credentials, actual physical test results, and the final recording filename.

```text
PURPOSE
HomeBrain is a companion for owners and authorized household users of a HomeBrain hub. It provides one private interface for compatible devices, rooms, scenes, workflows, security state, weather, notifications, energy information, optional voice commands, and Apple Watch. The iOS app is sign-in only; accounts are provisioned by a HomeBrain administrator.

REVIEW ACCESS
Endpoint: https://freestonefamily.com
Persistent account: use the Username/Password in App Store Connect's Sign-in Information fields.
Disposable deletion-test email: [EMAIL]
Disposable deletion-test password: [PASSWORD]

No VPN, LAN, private DNS, sample file, purchase, subscription, or physical accessory is required. Enter the endpoint and sign in. The persistent account is restricted to a per-user sandbox with nine virtual devices, six named rooms, two groups, three scenes, three workflows, two notifications, synthetic weather, virtual security, and Watch data. Actions cannot read or control the owner's household devices, integrations, credentials, or settings.

The reviewer can use Dashboard, Weather, Watch App, Devices, Rooms, Scenes, Workflows, Notifications, and Settings. Notifications are requested after sign-in when enabled. Location is requested only after choosing Use Device Location. Microphone and Apple Speech Recognition are requested only after enabling Voice Commands. The Watch companion uses the same authorized session from its paired iPhone.

ACCOUNT DELETION
Use only the disposable account. Open Settings > Account > Delete Account, enter its password, type DELETE, and confirm. Its account and associated personal data are removed and the app returns to sign-in. Please do not delete the persistent review credential.

PHYSICAL TESTING
[DEVICE / OS / date]
[DEVICE / OS / date]
[IPAD / iPadOS / date]
[WATCH / watchOS / date]
Recording attached: [FILENAME]

SERVICES/REGIONS/REGULATION
HomeBrain uses its backend/hub, Apple APNs, Speech Recognition, the device microphone, Core Location, WatchConnectivity/watchOS, and Open-Meteo. Optional hub integrations and AI/voice providers are listed in the attached Guideline 2.1 response and are not required for review. There are no payments/subscriptions, ads, ATT, or public UGC. The same binary and features operate in all App Store regions. HomeBrain is a consumer smart-home app, not a highly regulated service, and distributes no protected third-party media or editorial content.
```

Do not submit until the public endpoint works over cellular internet, the persistent account reaches only the virtual sandbox, the disposable deletion account has been reset, and both credentials have been verified from a clean install. The reviewer must not need local-network access or physical smart-home hardware.

## 5. App Privacy — implementation-based draft

This is a technical audit aid, not a privacy-law determination. Apple’s form must cover data collected by the app **and** its third-party partners, including HomeBrain’s backend and any enabled integrations. Verify retention, sharing, and linkage with the privacy-policy owner before publishing.

| Apple data type / form area | Evidence in the app | Likely declaration if the data leaves the device or is stored | Purpose / tracking |
| --- | --- | --- | --- |
| Contact info: Name and Email Address | Account sign-in and current user profile | Collected; linked to the user | App functionality; not tracking unless combined with third-party tracking data |
| Identifiers: User ID and Device ID | The app generates a persistent installation UUID and sends it with API/push registration; APNs device token is registered to the HomeBrain service | Collected; linked to the user/device | App functionality and notifications; not tracking unless used across companies’ apps/sites |
| Location: Coarse or Precise Location | Weather can request device location and sends latitude/longitude to the weather endpoint | Collected when the user chooses automatic weather; select the most accurate category actually transmitted | App functionality; not tracking |
| User content / Other data: voice-command transcript | iOS Speech Recognition creates a transcript; the app sends command text and speech metadata to `/api/voice/commands/interpret` | Collected; normally linked to the user | App functionality; not tracking |
| Audio Data | Microphone audio is supplied to `SFSpeechRecognizer`; confirm with Apple Speech/your policy whether any audio is transmitted or retained by a partner | Declare if it is collected off-device by HomeBrain or a partner | App functionality; not tracking unless actual use differs |
| Other user content / smart-home data | HomeBrain displays and controls devices, rooms, scenes, workflows, weather, energy, and notification state through its service | Declare the applicable Apple category (often Other User Content or Other Data) if HomeBrain stores or transmits it | App functionality; not tracking |
| Diagnostics | No analytics or advertising SDK was found in the iOS source audit | Mark not collected only after confirming the backend and all SDKs do not collect diagnostics | — |

Before saving the privacy label, specifically confirm these statements:

1. HomeBrain does not sell data or use it to track people across apps or websites.
2. Whether Apple Speech Recognition may process microphone audio off-device for this build and whether it should be reported as Audio Data.
3. The exact precision and retention of weather coordinates, custom addresses, voice transcripts, device names, home state, and push tokens.
4. Every optional integration that can be enabled in a customer account (for example, smart-home platforms and cloud services).

The code requests Location, Microphone, and Speech Recognition permissions, sends command transcripts to the HomeBrain service, and registers device/APNs tokens for notifications. The privacy disclosure and policy need to say so plainly.

## 6. Final App Store Connect sequence

1. Create or open the app record; use bundle ID `NTechR.HomeBrainApp` and a unique SKU.
2. Complete App Information: name, subtitle, categories, content rights, age rating, support URL, privacy-policy URL, and copyright.
3. Complete App Privacy with the verified answers above; add the public privacy-policy URL.
4. Under version 1.0, paste the listing copy, upload the three iPhone images, three iPad images, and two Watch images in the folders above.
5. Choose build 6 after it has finished processing, complete export compliance, and check the embedded iOS and Watch app icons on the processed build.
6. Enter App Review contact details, the public endpoint, the persistent credential, the disposable deletion-test credential, verified device/OS results, and the review notes above. Attach the physical-device recording requested under Guideline 2.1.
7. Choose pricing, territories, and a release method; ensure Agreements, Tax, and Banking are active if required by your account.
8. Save, use **Add for Review**, then submit when every required field shows complete.

## Official Apple references

- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)
- [App information fields](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information)
- [App privacy details](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy)
- [Submitting an app for review](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app)
- [App Review guidelines and preparation](https://developer.apple.com/app-store/review/)

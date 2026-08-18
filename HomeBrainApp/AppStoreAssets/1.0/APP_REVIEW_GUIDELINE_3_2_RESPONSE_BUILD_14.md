# HomeBrain App Review response — Guideline 3.2

Prepared August 17, 2026 for HomeBrain **1.0 (build 14)** in response to the August 18 review of build 13.

## What caused the misunderstanding

Build 13 described accounts as being supplied by a HomeBrain “administrator” and said the native app did not offer registration. That language accurately described additional accounts on an initialized household hub, but it omitted HomeBrain's public first-owner setup path. It made a consumer, self-hosted smart-home product look like a private client or employee app.

HomeBrain is not built for, restricted to, or customized for a specific business or organization. The platform source is publicly available at `https://github.com/mefree2098/HomeBrainv2` under the Apache License 2.0. Any individual can install a HomeBrain hub on a compatible user-owned Linux computer and create the first household-owner account. No invitation, pre-approval, employment, contract, client relationship, or organization membership is required.

Build 14 makes those facts visible and actionable:

- the sign-in screen expressly identifies HomeBrain as available to any individual or household;
- the app includes **Set Up New Hub**, allowing a person to create the first owner account on a fresh HomeBrain installation;
- a public **How to Get and Set Up HomeBrain** link explains installation, account creation, audience, and pricing;
- organization/client/administrator-only wording has been removed from consumer onboarding and support materials; and
- the persistent App Review account still opens the complete isolated demo hub without hardware, a VPN, or another organization.

## Paste-ready Resolution Center reply

```text
Hello App Review,

Thank you for the opportunity to clarify. HomeBrain is intended for public App Store distribution as a consumer, self-hosted smart-home app. It is not restricted to or customized for a specific company, client, partner, employer, or organization.

Build 13 used “administrator” wording that described account management inside an already initialized household hub, but it did not explain the public first-owner setup path. We corrected that presentation in version 1.0, build 14. The app now states that HomeBrain is available to any individual or household, links to public setup instructions, and includes a native “Set Up New Hub” flow that creates the first household-owner account on a fresh HomeBrain installation.

1. Is the app restricted to users who are part of a single company or organization?

No. HomeBrain is not restricted to any company, employer, partner, employee, contractor, client, or organization. It is designed for individuals and households managing their own smart home.

2. Is the app designed for a limited or specific group of companies or organizations?

No. No company or organization is required or designated. Any member of the public can download the Apache-2.0 HomeBrain software from https://github.com/mefree2098/HomeBrainv2, install it on a compatible computer they own, create the first household-owner account, and use the same App Store binary. A company could independently use that same publicly available product, but it does not need to apply, become our client, or receive a customized app. There is no client approval, invitation, pre-approved registration, or organizational affiliation.

3. What features are intended for the general public?

The complete product is intended for individual smart-home users: household dashboard and status, compatible device and room control, favorites, scenes, workflows and schedules, security state, weather, notifications, energy information, optional voice commands, multiple personal hubs, and Apple Watch controls. The app connects to the user’s own HomeBrain hub, like other consumer smart-home companion apps. The App Review credential opens an isolated virtual home so every feature can be reviewed without purchasing hardware.

4. How do users obtain an account?

Any individual can install HomeBrain by following the public instructions at https://freestonefamily.com/getting-started. On a fresh hub, the person chooses “Set Up New Hub” in the iPhone or iPad app and creates the first household-owner account; the same first-account option is available in the web interface. After initial setup, that household owner may add family members or other trusted household users. Closing open registration after the first owner exists protects that private household and is not company or client approval.

5. Is there paid content, and who pays for it?

No. HomeBrain has no paid account, paid digital content, in-app purchase, subscription, advertising, or fee to unlock app features. The HomeBrain server software is publicly available under the Apache License 2.0. A user may separately own compatible computer or smart-home hardware or choose optional third-party services, but those products are not purchased through HomeBrain and do not represent paid app content.

Review access remains unchanged: use the Sign-in Information already provided in App Store Connect. The reviewer account automatically selects https://freestonefamily.com and opens a complete isolated virtual household. No VPN, local network, invitation, organization membership, purchase, subscription, or physical accessory is required.

Please review version 1.0, build 14 rather than build 13.

Thank you.
```

## App Store Connect changes required before resubmission

1. Upload and select **1.0 (14)**. Do not resubmit build 13.
2. Set the optional Marketing URL to `https://freestonefamily.com/getting-started`.
3. Replace the final paragraph of the description with the updated public-audience copy in `APP_STORE_CONNECT_SUBMISSION.md`.
4. Keep **Sign-in required** enabled and retain the existing persistent review credential.
5. Paste the complete numbered response above in Resolution Center and the substantive audience/account summary into Review Notes.

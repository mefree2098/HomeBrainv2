# HomeBrain App Review response — unresponsive Sign In

Prepared August 6, 2026 for HomeBrain **1.0 (build 8)** in response to the August 3 review of obsolete build 4.

## Root cause and correction

App Review tested version 1.0 (4). Build 4 predates the isolated App Review sandbox, sign-in-only release flow, account deletion, reviewer navigation, and public review endpoint support added in builds 6 and 7.

Build 4 could also make **Sign In** appear unresponsive: the button was disabled when any required field was empty, but tapping it displayed no validation message. If the reviewer entered only the username and password from App Store Connect, the clean-install default still pointed at a LAN-only HomeBrain address rather than the public review endpoint.

Build 8 corrects both behaviors:

- **Sign In** remains tappable and reports the exact missing or invalid field.
- Entering either App Review username automatically selects `https://freestonefamily.com`.
- The screen visibly confirms **Public App Review demo server selected**.
- Login displays a progress state and has a 15-second request timeout, so an unreachable endpoint cannot look like an ignored tap.
- The dedicated reviewer accounts remain isolated from production household devices and data.

## Required App Store Connect configuration

Select **version 1.0, build 8** for the new submission. Do not resubmit build 4.

Set **Sign-in required** to **Yes** and use the persistent reviewer credential already stored in App Store Connect. Keep the public endpoint and the separate disposable deletion-test credential in the private App Review Notes.

## Paste-ready Resolution Center reply

```text
Hello App Review,

Thank you for identifying the Sign In issue. We reproduced the failure mode and corrected it in version 1.0, build 8.

The August 3 review tested build 4, which predates the dedicated App Review sandbox and current public review sign-in flow. Build 8 keeps the Sign In control responsive, displays a specific validation message when a required value is missing, automatically selects the public review endpoint when the App Review username is entered, visibly confirms that selection, and places a timeout on login requests so an unreachable endpoint cannot appear as an ignored tap.

Please review version 1.0, build 8—not build 4.

On a clean install:
1. Enter the demo username and password from the App Review Sign-in Information fields.
2. HomeBrain automatically selects https://freestonefamily.com and displays “Public App Review demo server selected.”
3. Tap Sign In. No VPN, LAN access, private DNS, physical HomeBrain hub, purchase, subscription, sample file, or smart-home accessory is required.

The account opens an isolated synthetic home with virtual devices, rooms, groups, scenes, workflows, notifications, weather, security, voice, energy, and Apple Watch functionality. The private App Review Notes include a separate disposable credential for testing account deletion. Please do not delete the persistent review account.

We verified both reviewer accounts against the public production endpoint and tested the Release build before resubmission.

Thank you.
```

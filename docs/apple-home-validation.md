# Apple Home validation

PR #680 contains the user-approved one-time Apple Home pairing integration. Setup and supported device/workflow boundaries are in `apple-home-integration.md`.

## Repeatable gates

- `npm --prefix server test`: complete server regression, including Apple Home catalog safety, actual HAP characteristic callbacks and authenticated HTTP/JWT routes.
- `node --test server/tests/appleHome*.test.js server/tests/runWithModernNode.test.js`: bridge and supported runtime checks.
- `.github/workflows/siri-native.yml`: Swift transport and synchronization policy cases with warnings as errors; Debug/Release iOS, embedded Watch and standalone Watch builds; compiled App Intents metadata and public HomeKit entitlement checks.
- The Debug native job also launches a real iOS simulator, navigates the stackless Settings screen, taps the Apple Home button, verifies the presented screen and dismisses it. A screenshot and xcresult are retained with the run.
- Existing regression, dependency review, all-severity dependency audit policy, secret scanning and CodeQL remain enabled. The prior remote-device advisory tracked in #677 is unchanged; no new exception is introduced.

The new HomeKit dependency is pinned to `@homebridge/hap-nodejs` 2.2.3. The isolated dependency install passed a raw server npm audit with zero advisories. Server support is Node 22.13+, 24 or 26, matching the pinned bridge dependency. Native HomeKit uses public APIs and no restricted setup-payload entitlement.

## Acceptance boundary

No test pairs with a production Apple Home or operates physical household devices. Simulator builds do not prove signed distribution, LAN/mDNS reachability, Apple Home scene synchronization on an actual account, remote Home hub routing or exact spoken-Siri recognition. Deploy the updated backend and install newly signed iOS/Watch builds, then perform the one-time connection and the voice acceptance checks in the setup guide. Individual personal Shortcuts are not part of this connection flow.

The PR conversation records exact final-head and post-merge workflow results, including any failures and corrections. A passing compile alone is not sufficient for this feature.

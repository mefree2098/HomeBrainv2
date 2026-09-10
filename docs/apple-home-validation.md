# Apple Home validation

PR #680 contains the user-approved one-time Apple Home pairing integration. Setup and supported device/workflow boundaries are in `apple-home-integration.md`.

## Repeatable gates

- `npm --prefix server test`: complete server regression, including Apple Home catalog safety, actual HAP characteristic callbacks and authenticated HTTP/JWT routes.
- `node --test server/tests/appleHome*.test.js server/tests/runWithModernNode.test.js`: bridge and supported runtime checks. The publisher suite includes a real HAP TCP bind to an intentionally occupied test port: the error must be handled without terminating HomeBrain. It also verifies readiness waits for advertisement, discovery timeout, runtime failure, teardown and version-contract failure.
- `.github/workflows/siri-native.yml`: 27 shared Swift transport/identity cases and 19 Apple Home synchronization-policy cases with warnings as errors; Debug/Release iOS, embedded Watch and standalone Watch builds; compiled App Intents metadata and public HomeKit entitlement checks.
- The Debug native job also launches a real iOS simulator, navigates the stackless Settings screen, taps the Apple Home button, verifies the presented screen and dismisses it. A screenshot and xcresult are retained with the run.
- Existing regression, dependency review, all-severity dependency audit policy, secret scanning and CodeQL remain enabled. The prior remote-device advisory tracked in #677 is unchanged; no new exception is introduced.

## Evidence and corrections

Native workflow **34541165241**, for candidate `6402b41e7a6b6f3073a20547ec963fdfb4f718ef`, passed both Debug and Release builds, metadata/entitlement checks and the actual Settings tap/dismiss UI test. The Release artifact **10177478581** was downloaded and inspected: no compiler warning/error diagnostics. Subsequent publisher changes affect backend code and tests only; final-head and post-merge gates must still pass and are recorded in the PR.

The initial native failure used the old HomeKit SerialNumber characteristic that iOS no longer exposes. The bridge now places the same opaque hub-scoped identity in the public accessory Model property and iOS matches that identity, not a display name. Transport tests also found and fixed an API path allowlist that initially rejected the new Apple Home endpoints. Workflow safety tests cover condition false branches and hidden group members. These failures were fixed, not suppressed.

The new HomeKit dependency is pinned to `@homebridge/hap-nodejs` 2.2.3. Its isolated required-dependency install passed a raw server npm audit with zero advisories and no install warnings. It is required rather than optional because this repository deliberately omits optional server packages. Server support is Node 22.13+, 24 or 26, matching the pinned bridge dependency. Native HomeKit uses public APIs and no restricted setup-payload entitlement.

HAP resolves its publish call before TCP/mDNS readiness and does not forward its TCP bind error to the accessory. A small version-pinned, regression-tested adapter attaches the socket error handler synchronously and waits for the actual advertised event. A changed dependency transport contract fails closed; startup errors do not become uncaught exceptions or a false running status.

## Acceptance boundary

No test pairs with a production Apple Home or operates physical household devices. Simulator builds do not prove signed distribution, LAN/mDNS reachability, Apple Home scene synchronization on an actual account, remote Home hub routing or exact spoken-Siri recognition. Deploy the updated backend and install newly signed iOS/Watch builds, then perform the one-time connection and voice acceptance checks in the setup guide. Individual personal Shortcuts are not part of this connection flow.

The PR conversation records exact final-head and post-merge workflow results, including any failures and corrections. A passing compile alone is not sufficient for this feature.

# Apple Home and Siri — one-time pairing, automatic discovery

This is the primary integration for commands without “in HomeBrain” and without personal Shortcuts. The older App Intents remain available as an optional alternative. The new Settings entry is **HomeBrain → Settings → Siri & Apple Home**. It opens a sheet with its own navigation stack; it does not depend on the custom shell supplying one.

## What is exported

The hub publishes supported lights/dimmers, switches and media-activity devices as HomeKit accessories. It publishes eligible enabled workflows and scenes as momentary trigger switches. The iOS app assigns the paired accessories to rooms and creates native Apple Home scenes for workflow/scene names and workflow voice aliases. These are Apple Home scenes, not Shortcuts.

For a device named **Theater Cans**, an Apple Home room **Master Bedroom**, and an eligible workflow named **Night TV** with alias **Stars Only**, the intended voice commands are:

- “Siri, turn off Theater Cans.”
- “Siri, turn on the master bedroom lights.”
- “Siri, turn on Night TV.”
- “Siri, Stars Only.” (or “Siri, activate Stars Only.” when recognition needs disambiguation)

Siri's voice interpretation and conflicts with existing Home scenes/media commands are Apple's responsibility. Confirm the actual names with a real-device acceptance test; a successful native build is not a spoken-command test.

Security devices and security-related commands are **not** represented as unrestricted switches. Workflows with unknown, opaque HTTP/ISY-network/robot/variable operations, unresolved targets, or reachable security actions are excluded. Nested repeats, workflow references, scene/group membership (including hidden devices) and condition false branches are checked. Excluded entries and reasons appear in the setup screen; ordinary HomeBrain controls remain unchanged. This release does not claim thermostat, lock, alarm, camera, or every possible workflow operation support.

## Deploy and pair

1. Update the backend and install its locked server dependencies (`npm ci` in `server`, not `npm audit fix --force`). Use Node **22.13 or newer in the 22 line, Node 24, or Node 26**. The maintained `@homebridge/hap-nodejs` 2.2.3 runtime requires supported even-numbered Node releases; the project's Node selector enforces that floor. Restart through the normal HomeBrain deployment process. A source pull alone does not restart a running server.
2. Build/install the new iOS and Watch applications. Enable the ordinary **HomeKit** capability for the existing iOS signing identifier and regenerate the provisioning profile when Xcode asks. The project includes `com.apple.developer.homekit` and `NSHomeKitUsageDescription`. No restricted setup-payload entitlement or MFi access is required by this app's pairing chooser.
3. On the home LAN, sign in to HomeBrain as a controlling administrator. Open **Settings → Siri & Apple Home → Connect HomeBrain to Apple Home**. Confirm that Apple Home members will receive control over the published accessories and workflows. Allow Home permission when iOS prompts.
4. Select the intended Apple Home. Create a home in Apple's Home app first when none exists. Tap **Pair HomeBrain…**, choose **More Options** in Apple's system screen, select the nearby HomeBrain bridge and enter the displayed pairing code. The QR is also available for scanning from another display. The public setup request deliberately leaves its payload unset because prefilling it would require Apple's restricted entitlement.
5. Return to HomeBrain. Automatic synchronization assigns rooms and creates workflow scenes. The connection screen reports counts, missing pairings, unsupported entries and collisions. No manual per-device or per-workflow Shortcuts are required.
6. Siri on the Watch uses that Apple Home through Apple's normal Home/Siri infrastructure. It does not need personal shortcuts or the “Show on Apple Watch” setting. Sign the Watch into the same Apple account/home as appropriate; remote operation requires an Apple TV or HomePod home hub.

The HAP software bridge is **not Apple/MFi certified**; Apple can display its standard uncertified-accessory notice. This is not an App Store review or certification guarantee.

## Automatic updates and identity

The backend reconciles discovery every 30 seconds and after device-update notifications. Stable namespace-derived accessory identities survive ordinary name changes and restarts. Supported devices appear automatically in paired bridges. The iOS app reconciles room assignments and workflow scenes while active, and on its next foreground opening. Apple does not provide an unlimited background execution promise: a new workflow created while the iPhone app is terminated gets its scene on the next synchronization. Existing accessories/scenes continue working without keeping HomeBrain open.

Each bridge supports up to 149 bridged accessories. Larger homes automatically get stable additional bridges, each requiring one initial pairing, not individual accessory pairing. Previously allocated empty bridges remain published across restarts so existing pairings do not disappear as device counts change. Apple also imposes Home resource/scene limits; any refusal is surfaced rather than silently claiming every scene was installed.

The app scopes synchronization records to the backend, account, bridge namespace and selected Apple Home. It does not overwrite name/room changes made by users after the last managed value. It does not overwrite conflicting or customized scenes. Only scenes it created, still matching their original single trigger action, are eligible for obsolete-resource cleanup. It does not delete manually created rooms. Duplicate identities/names and quota/permission errors need review in the status screen.

## Execution and access control

HAP pairing authenticates and encrypts Apple Home control. The administrator explicitly delegates control to members/controllers of the selected Apple Home. HAP calls are **not** separately authenticated as each member's HomeBrain account: they use the bridge owner's currently valid HomeBrain control permission. An inactive, deleted, read-only, non-HomeBrain, sandbox, or no-longer-admin owner cannot execute commands. Review Apple Home membership accordingly.

Direct device commands go through the existing device engine and configurable voice priority, including security priority and post-action verification. Workflow triggers use the existing persisted Siri invocation service. Concurrent writes to the same active workflow coalesce; writing OFF to its trigger does nothing. A workflow switch is not its enabled flag. Apple's successful trigger acknowledgment means execution was accepted, not that a long/delayed workflow completed. Actual results remain in HomeBrain history; a failed or unknown result is not silently retried as a new physical workflow.

Administrative JSON endpoints are authenticated, rate-limited and `private, no-store`:

- `GET /api/apple-home/status`: status, supported targets and exclusion reasons; never the PIN.
- `PUT /api/apple-home/configuration`: enable/disable; enabling requires explicit confirmation.
- `POST /api/apple-home/pairing`: owner-only pairing code/QR payload.
- `POST /api/apple-home/sync`: refresh the backend manifest.

There is no new unauthenticated HTTP control endpoint. The bridge defaults **off**. Pairing codes are not logged or stored in Shortcut identifiers. Disabling unpublishes bridges without erasing their long-term pairing identity.

## LAN, storage and operations

The backend must have direct access to the home LAN, mDNS and Home hub. A cloud-only HTTPS deployment is not sufficient to advertise local accessories. Defaults are TCP **51826** plus one port for each extra bridge, with mDNS UDP **5353** on the LAN. Configure LAN firewall access as needed. **Never forward those ports from the internet.** HAP's interface binding selects mDNS interfaces; its TCP listener can use a wildcard socket, so the host firewall remains responsible for network exposure.

`HOMEBRAIN_HOMEKIT_INTERFACE` restricts advertisement to a chosen private LAN interface when the hub has multiple adapters. `HOMEBRAIN_HOMEKIT_DATA_DIR` overrides the default `server/data/apple-home` persistent directory. Keep it writable only by the service user, exclude it from public downloads/source control, and back up the entire directory securely. It contains long-term pairing keys and `bridge.json`. Corrupt identity files fail closed instead of silently issuing a replacement bridge.

Only one publisher process may use the same pairing directory. Do not run clustered copies against one store, reset pairings during ordinary deployments, or put this directory on ephemeral container storage. A stale lock on a different host requires operator inspection. To retire the bridge, disable it in HomeBrain and remove its accessories from Apple Home as appropriate; this release intentionally has no casual “wipe pairing keys” API.

## Validation and remaining acceptance steps

CI runs backend bridge/security/HTTP tests, full existing regression suites, dependency review/auditing, native Debug and Release iOS/Watch builds, shared Swift transport/synchronization tests, compiled Siri metadata validation, public HomeKit capability checks, and a simulator UI test that opens and dismisses the Apple Home screen from the actual custom Settings shell.

Tests use virtual fixtures and do not operate a real home. Before treating this as a production rollout, pair on the actual LAN, verify the expected devices/workflows are listed, inspect any exclusions, run Theater Cans on/off and brightness, run Night TV/Stars Only repeatedly, test room targeting, compare actual device state and workflow history, and test iPhone/Watch remote operation through the home hub. Existing audit findings #677 and #678 remain separate from this feature.

Primary implementation references:
- https://github.com/homebridge/HAP-NodeJS
- https://developer.apple.com/documentation/homekit/hmaccessorysetuprequest
- https://developer.apple.com/documentation/homekit/hmhome
- https://support.apple.com/en-us/102313

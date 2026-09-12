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
2. Build/install the new iOS and Watch applications. Enable the ordinary **HomeKit** capability for the existing iOS signing identifier and regenerate the provisioning profile when Xcode asks. The project includes `com.apple.developer.homekit` and `NSHomeKitUsageDescription`. No restricted setup-payload entitlement or MFi access is required by this app's pairing flow.
3. On the home LAN, sign in to HomeBrain as a controlling administrator. Open **Settings → Siri & Apple Home → Connect HomeBrain to Apple Home**. Confirm that Apple Home members will receive control over the published accessories and workflows. Allow Home permission when iOS prompts.
4. Select the intended Apple Home. Create a home in Apple's Home app first when none exists. Tap **Set Up Bridge Pairing**, then **Pair HomeBrain…**. The app discovers the named bridge on the LAN through `HMAccessoryBrowser` and adds it to the selected home with `HMHome.addAccessory`. Enter the displayed pairing code when Apple requests it. This keeps HomeKit's pairing authentication while leaving device organization to HomeBrain. **Creating/selecting a home and tapping Synchronize do not pair the bridge or add accessories.**
5. After pairing, HomeBrain synchronizes accessory and service names, assigns rooms that are configured in HomeBrain, and creates workflow scenes. The connection screen reports counts, missing pairings, missing room assignments, unsupported entries and collisions. If accessory discovery is still in progress, leave the app open for its next sync or refresh. No manual per-device or per-workflow Shortcuts are required.
6. Siri on the Watch uses that Apple Home through Apple's normal Home/Siri infrastructure. It does not need personal shortcuts or the “Show on Apple Watch” setting. Sign the Watch into the same Apple account/home as appropriate; remote operation requires an Apple TV or HomePod home hub.

The HAP software bridge is **not Apple/MFi certified**; Apple can display its standard uncertified-accessory notice. This is not an App Store review or certification guarantee.

Earlier builds used `HMAccessorySetupManager.performAccessorySetup` with every accessory already on the bridge. That API opens Apple's full per-accessory room/name wizard and does not return to HomeBrain's synchronization until the wizard is finished. The updated app uses the supported direct-add API instead. Scanning the optional QR from Apple's Home app still uses Apple's own setup wizard; it is an alternative, not the recommended HomeBrain import path. Physical-device acceptance must verify the direct pairing flow on the installed iOS version; simulator compilation does not establish its on-device behavior.

### Repair names and rooms after an earlier import

Keep the existing pairing. In the updated iPhone app, select the correct Apple Home and choose **Restore HomeBrain Names & Rooms**. Confirm the named home. The app restores names for both accessories and their light/switch services and assigns known source rooms in one pass. This explicit repair can replace previous Apple Home name/room edits; normal periodic synchronization continues preserving them. It matches accessories by the hub-scoped identity, not by a generic display name, and does not change device state or overwrite customized scenes.

`Unassigned`, empty source rooms, and generated fallback rooms are not actual room assignments. They are reported, and the app retains those accessories' current Apple Home rooms even during repair. Update missing rooms in HomeBrain to make subsequent automatic room synchronization possible. The backend publishes `roomAssigned` to distinguish an explicit room named HomeBrain from the fallback; older backend responses are handled conservatively. Pairing or repairing cannot reliably infer rooms from device names alone.

### If sync finishes but Apple's Home app is empty

Check the bridge's pairing status in HomeBrain. **Bridge running** and **Published by hub** mean the hub is offering accessories on the LAN; they do not mean Apple Home has added them. A bridge marked **Not paired — setup required** still needs step 4 above. Earlier iPhone builds could report “Synced 0 HomeBrain accessories” at this point, even though setup was incomplete. Siri then correctly reports that Apple Home has no accessories.

After pairing, return to HomeBrain and refresh. **Found in selected Apple Home** should match the published count. If the bridge has a pairing but no accessories are found, verify you selected the Apple Home used during pairing and allow discovery to finish. A backend pairing flag cannot identify which Apple Home holds that pairing. Pair each bridge if more than one is listed.

## Automatic updates and identity

The backend reconciles discovery every 30 seconds and after device-update notifications. Stable namespace-derived accessory identities survive ordinary name changes and restarts. Supported devices appear automatically in paired bridges. The iOS app reconciles room assignments and workflow scenes while active, and on its next foreground opening. Apple does not provide an unlimited background execution promise: a new workflow created while the iPhone app is terminated gets its scene on the next synchronization. Existing accessories/scenes continue working without keeping HomeBrain open.

Each bridge supports up to 149 bridged accessories. Larger homes automatically get stable additional bridges, each requiring one initial pairing, not individual accessory pairing. Previously allocated empty bridges remain published across restarts so existing pairings do not disappear as device counts change. Apple also imposes Home resource/scene limits; any refusal is surfaced rather than silently claiming every scene was installed.

The app scopes synchronization records to the backend, account, bridge namespace and selected Apple Home. Normal synchronization does not overwrite name/room changes made by users after the last managed value; the explicit bulk repair restores source names and known rooms. Accessory and service names are tracked separately, and a failure updating a name does not prevent independent room or scene work. It does not overwrite conflicting or customized scenes. Only scenes it created, still matching their original single trigger action, are eligible for obsolete-resource cleanup. It does not delete manually created rooms. Duplicate identities/names and quota/permission errors need review in the status screen.

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
- https://developer.apple.com/documentation/homekit/hmaccessorybrowser
- https://developer.apple.com/documentation/homekit/hmhome/addaccessory(_:completionhandler:)
- https://developer.apple.com/documentation/homekit/hmhome
- https://support.apple.com/en-us/102313

# Siri and Shortcuts: iPhone and Apple Watch

## What is supported

Both native apps compile the same App Intents implementation from `shared/apple`:

- Turn On Lights and Turn Off Lights: select an individual light or a room's lights.
- Set Light Brightness: an individual light or room, from 0 through 100 percent.
- Run Workflow: execute an enabled HomeBrain workflow, including its configured actions.
- Activate Scene: execute a configured HomeBrain scene and check its result.

Targets come from the signed-in home at runtime, not a hard-coded list. Workflow voice aliases participate in discovery. Duplicate names or aliases remain separate candidates for Siri's disambiguation; the backend accepts selected IDs, not a fuzzy best guess. A saved selection is bound to its server and user account. Changing homes or accounts requires selecting that action again; an old shortcut cannot silently control a different home.

No new Siri/Apple Intelligence release is required. These are ordinary App Intents and App Shortcuts. The existing project deployment targets remain unchanged (iOS/watchOS 26).

## Install and connect

1. Deploy the backend containing `/api/siri` using the normal HomeBrain deployment procedure. Install the newly built iOS and Watch apps; pulling source alone does not update installed apps or a running backend.
2. Sign in on iPhone. Open the Watch app and confirm its existing companion sign-in sync, or sign in on the Watch directly. Each device executes over its own authenticated HTTPS/local-network connection; the iPhone does not have to be reachable for a signed-in Watch with backend connectivity.
3. Open **Siri & Shortcuts** in iPhone Settings or the Watch overview. Confirm that the connected home lists the expected rooms and workflows. Refresh this catalog after changing names or aliases.
4. Ensure the actual lights have `type: light` and the correct room assignment (for example `Master Bedroom`), and that `Night TV` is an enabled workflow. These commands use the same integration/control engines as HomeBrain's normal controls; underlying device connectivity and workflow correctness still matter.

## Automatic phrases (no manually named shortcut)

Say:

- “Hey Siri, turn on Master Bedroom lights in HomeBrain.”
- “Hey Siri, turn off Master Bedroom lights in HomeBrain.”
- “Hey Siri, set Master Bedroom lights brightness in HomeBrain.” Siri asks for the percentage.
- “Hey Siri, run Night TV in HomeBrain.”
- “Hey Siri, turn on Night TV in HomeBrain.”
- “Hey Siri, activate Movie Time in HomeBrain.” (for a scene with that name)

Each automatically registered App Shortcut phrase includes the app name, as required by Apple. Both app display names are HomeBrain. Generic versions ask which lights, workflow, or scene to use.

## Exact shorter phrases requested: one-time setup

Apple lets users run a shortcut by its name. To use a phrase without “in HomeBrain,” create a named shortcut on the iPhone:

**“Hey Siri, turn on the master bedroom lights”**

1. Open Shortcuts, create a shortcut, and add **HomeBrain → Turn On Lights**.
2. Select **Master Bedroom lights**, not an individual light unless that is intended.
3. Name the shortcut **Turn on the master bedroom lights**.
4. Open the shortcut's Details and enable **Show on Apple Watch**.

**“Hey Siri, turn on night tv”**

1. Create another shortcut with **HomeBrain → Run Workflow**.
2. Select **Night TV**. This runs the workflow; it does not merely enable the workflow.
3. Name the shortcut **Turn on night tv**.
4. Enable **Show on Apple Watch** in its Details.

Wait for normal Shortcuts/iCloud synchronization and test from both devices. If Apple Home or another shortcut intercepts a generic phrase, use the app-qualified phrase or choose a unique shortcut name. The app cannot override Apple's global Siri routing or silently create arbitrary personal shortcut names.

Commands require the device's authentication policy and a valid HomeBrain session; Siri may request unlock. Read-only and inactive accounts do not gain control through Siri.

## Backend contract and execution guarantees

All endpoints use existing HomeBrain JWT/OIDC authentication and account/platform permissions, with no tokens in URLs or shortcut IDs:

- `GET /api/siri/catalog`: live accessible light/room/workflow/scene targets and authenticated account ID.
- `POST /api/siri/commands`: typed action, target ID, account ID, UUID invocation ID, and brightness when applicable.
- `GET /api/siri/commands/:requestId`: retained status scoped to the authenticated account.

A POST records its invocation in MongoDB before physical effects. An explicitly created unique `(userId, requestId)` index prevents duplicate execution of that invocation within the retention window, including racing retries and process restarts. The same ID with different command content is rejected. Records expire after seven days. Index creation failure fails closed, even when Mongoose `autoIndex` is disabled.

Commands run through the existing device, scene, and workflow engines, with Siri source/actor metadata. Rooms issue at most four concurrent device controls. Read-only access and account/target mismatches are rejected before execution; disabled workflows are not force-enabled.

Long workflows return `202 running`; the apps poll the authenticated result endpoint briefly. Completed/failed state comes from the control engine, not merely HTTP acceptance. A still-running command is described as **started**, never **finished**. Partial room/scene failures are reported. Lost worker heartbeats become **unknown**; this is not an instruction to re-run a possibly completed physical action. Restarting the backend does not resume a partially executed workflow automatically.

The apps refresh credentials once on 401, never on permission-denied 403. Network timeouts do not trigger blind POST retries. Credential-bearing Siri HTTP requests reject redirects, preserve reverse-proxy URL prefixes, use no cookie/cache storage, and recheck the active home after asynchronous responses. Watch UI and Siri share a single-flight token refresh path.

The `SiriCommand` collection and indexes are created on first use. No new application dependency or manual schema migration is added. The existing unresolved remote-device dependency advisory and strict TypeScript debt documented by the earlier security audit are unaffected.

## Validation

The permanent **Siri native** workflow runs shared Swift transport/identity tests with warnings treated as errors, builds iOS plus embedded Watch and the standalone Watch scheme in Debug and Release, and verifies all five intent identifiers in compiled application App Intents metadata. Existing regression/security workflows continue to run server, client, broker, Lambda, remote-device, Python, dependency, secret and CodeQL checks.

Focused reproducible tests:

```sh
cd server && node --test tests/siriCommandService.test.js tests/siriRoutes.test.js
```

```sh
swiftc -warnings-as-errors -default-isolation MainActor -parse-as-library shared/apple/HomeBrainSiriModels.swift shared/apple/HomeBrainSiriClient.swift scripts/tests/siri-core-tests.swift -o /tmp/homebrain-siri-tests && /tmp/homebrain-siri-tests
```

Automated tests use fake device/workflow adapters and HTTP fixtures, not live home-control actions. Native simulator compilation and metadata checks do not establish physical Siri recognition, personal shortcut synchronization, actual light changes, signed distribution, or successful production deployment. Verify these on the installed apps and deployed backend before relying on voice control.

## Apple references

- App Intents/App Shortcuts design and the app-name requirement: https://developer.apple.com/videos/play/wwdc2025/244/
- Run a shortcut by name with Siri: https://support.apple.com/en-us/102579
- Show shortcuts on Apple Watch: https://support.apple.com/guide/shortcuts/run-shortcuts-on-apple-watch-apd5888b0858/ios
- App Intent authentication policy: https://developer.apple.com/documentation/appintents/intentauthenticationpolicy

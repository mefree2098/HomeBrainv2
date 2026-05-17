# Native Control QA Tracker - 2026-05-17

## Goal

Run an end-to-end QA pass for HomeBrain native Zigbee, Z-Wave, Thread, and Matter control surfaces across backend services, production hardware visibility, onboarding/offboarding flows, SmartThings transition support, automation execution, web UI, Chrome UI, iOS UI, deployment, and final production health.

## Safety Boundaries

- [x] Identify current live devices and controller state before triggering inclusion, exclusion, pairing, commissioning, or delete actions.
- [x] Prefer dedicated test devices or reversible controller windows for destructive live flows.
- [x] Do not remove or exclude real production devices unless they are clearly selected for migration or the action is explicitly confirmed during the pass.
- [x] Record every live action, result, and limitation in this tracker.

## Baseline And Inventory

- [x] Confirm git branch, cleanliness, and current deployed commit.
- [x] Capture HomeBrain live overview and deploy health.
- [x] Capture direct radio status for Zigbee and Z-Wave adapters.
- [x] Capture Matter and Thread status.
- [x] Capture live device inventory grouped by provider/protocol.
- [x] Identify SmartThings devices that appear eligible for native transition testing.
- [x] Identify or create test/admin credentials for UI QA without exposing secrets.

## Backend And Service Tests

- [x] Map native-control APIs, routes, services, and tests.
- [x] Run existing server test suite.
- [x] Run targeted Zigbee/Z-Wave/direct-radio tests.
- [x] Run targeted Matter/Thread tests.
- [x] Run targeted SmartThings transition/exclusion tests.
- [x] Run targeted workflow execution tests for native-control devices.
- [x] Add or repair tests for uncovered risky flows.

## Live Native-Control Flows

- [x] Verify Zigbee controller health and device discovery readiness.
- [x] Verify Z-Wave controller health and node inventory.
- [x] Test Zigbee inclusion/onboarding path as far as safely possible.
- [x] Test Zigbee offboarding/remove path as far as safely possible.
- [x] Test Z-Wave inclusion/onboarding path as far as safely possible.
- [x] Test Z-Wave exclusion/offboarding path as far as safely possible.
- [x] Test SmartThings transition/exclude initiation flow as far as safely possible.
- [x] Verify Matter controller health.
- [x] Verify Thread border router health.
- [x] Test Matter commissioning/onboarding path as far as safely possible.
- [x] Test Matter offboarding/remove path as far as safely possible.

## Automation Execution

- [x] Identify live or simulated native-control command targets.
- [x] Execute Zigbee command path through HomeBrain device APIs or safe dry-run substitute.
- [x] Execute Z-Wave command path through HomeBrain device APIs or safe dry-run substitute.
- [x] Execute Matter command path through HomeBrain device APIs or safe dry-run substitute.
- [x] Execute workflow automation path for native-control targets.
- [x] Verify workflow logs/events accurately represent native-control execution outcomes.

## UI/UX QA

- [x] Inspect web Devices UI for native-control discovery, onboarding, offboarding, status, and errors.
- [x] Inspect web Workflows UI for native-control device targeting and execution clarity.
- [x] Inspect Chrome/extension path for login, Devices UI, and Workflows UI.
- [x] Inspect iOS simulator UI for login, Devices UI, and Workflows UI.
- [x] Record UX cleanup opportunities with file references.
- [x] Implement scoped UX improvements that make devices/workflows cleaner and more intuitive.

## Production Efficiency And Stability

- [ ] Check production process list and service status for duplicate HomeBrain processes.
- [ ] Check production resource usage.
- [ ] Check recent logs for native-control errors, repeated retries, or noisy loops.
- [ ] Confirm no duplicate controller processes or competing serial-port owners.
- [ ] Fix any efficiency/stability issues found during QA.

## Ship And Verify

- [x] Review changed files and make sure the tracker reflects completed evidence.
- [x] Run full relevant local test battery.
- [ ] Commit all code and documentation changes.
- [ ] Push to GitHub.
- [ ] Deploy production using the HomeBrain live skill.
- [ ] Verify production commit, health, logs, native-control status, and process efficiency after deploy.

## Evidence Log

| Time | Area | Evidence | Result | Follow-up |
| --- | --- | --- | --- | --- |
| 2026-05-17 10:01 MDT | Baseline | Local checkout `main...origin/main`, clean except this tracker after creation. Production deploy status reports `main` commit `8d80c9d5aaea3e37cb38381757dfd01e0de079b8`, runtime pid `112385`, repo/runtime match. | Pass | Re-check after final deploy. |
| 2026-05-17 10:01 MDT | Production health | `deploy-health` overall `healthy`; API, WebSocket, MongoDB, wake-word worker, Caddy, and deployment checks healthy. | Pass | Re-check after final deploy. |
| 2026-05-17 10:01 MDT | Direct radios | Zigbee SONOFF/ITead stick selected at `/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_2275350e6ca4ef119f8aaf8086a24396-if00-port0`, controller started, paired device count `0`. Z-Wave Zooz 800 stick selected at `/dev/serial/by-id/usb-Zooz_800_Z-Wave_Stick_533D004242-if00`, controller started, paired node count `1`. | Pass | Live onboarding/offboarding windows still pending. |
| 2026-05-17 10:01 MDT | Matter/Thread | Matter enabled/started/controller started. SONOFF MG24 Thread stick detected. OTBR REST online, Thread state `leader`, active dataset readable, ready for Thread commissioning. Commissioned Matter node count `0`. | Pass with no commissioned nodes | Commissioning UI/API can be validated; real device commissioning requires a Matter device in pairing mode. |
| 2026-05-17 10:02 MDT | Device inventory | 272 devices total: SmartThings `147`, Insteon `77`, Sense `22`, RainMachine `13`, Harmony `11`, Tempest `1`, HomeBrain Z-Wave `1`. Native record is `ZST39 LR` controller node `1`; no Zigbee/Matter end devices yet. | Pass | Use SmartThings candidates for migration-plan validation, not destructive removal. |
| 2026-05-17 10:02 MDT | Direct radio logs | `/api/direct-radios/logs/latest?limit=80` returned 15 clean entries: runtime start, serial scan, Zigbee coordinator started/resumed, Z-Wave controller/driver ready, node `1` normalized and synced. | Pass | Check again after inclusion/exclusion windows. |
| 2026-05-17 10:03 MDT | SmartThings transition plans | Migration-plan API tested against `Back Door` Zigbee multipurpose sensor, `Front Deadbolt` Z-Wave lock, and `Video Doorbell` cloud/unsupported device. Zigbee/Z-Wave candidates returned guided workflows; cloud helper was blocked. | Pass | Tightened unsupported plan behavior so blocked cloud/virtual devices return no executable radio steps. |
| 2026-05-17 10:04 MDT | Controller windows | Opened and closed short safe Zigbee permit-join, Z-Wave inclusion, Z-Wave exclusion, Zigbee migration, and Z-Wave migration windows. Final direct-radio status showed all windows closed and no active migrations. | Pass | Physical device onboarding/offboarding still requires a real device button/reset action; no production device was removed. |
| 2026-05-17 10:04 MDT | Matter commissioning | `/api/matter/commissioning/start` with Thread transport and no setup code returned `action_required` with `Matter setup code or passcode is required`; Matter controller and OTBR remained healthy. | Pass | Real Matter onboarding needs a setup code and device in commissioning mode. No Matter end devices exist to remove. |
| 2026-05-17 10:05 MDT | Direct radio logs after live flows | `/api/direct-radios/logs/latest?limit=120` showed expected open/close and migration-window entries only; no errors or warnings. | Pass | Re-check after production deploy. |
| 2026-05-17 10:08 MDT | Backend coverage | Added tests that verify cloud-only SmartThings devices have no executable migration workflow, HomeBrain Zigbee commands route through `directRadioService`, Matter commands route through `matterService`, and workflow `device_control` sends Zigbee/Z-Wave/Matter commands without cloud post-action verification. | Pass | Run full server suite again before ship. |
| 2026-05-17 10:09 MDT | Targeted tests | `NODE_ENV=test node --test server/tests/directRadioDeviceCatalog.test.js server/tests/deviceService.test.js server/tests/workflowExecutionService.test.js` passed `47/47`. | Pass | Full suite still pending after UI/native-app changes. |
| 2026-05-17 10:17 MDT | Web build | `node scripts/run-with-modern-node.js npm --prefix client run build` completed successfully after the Devices grid polish. | Pass | Re-check production after deploy. |
| 2026-05-17 10:17 MDT | iOS build | `xcodebuild -project HomeBrainApp/HomeBrainApp.xcodeproj -scheme HomeBrainApp -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.5' build` completed successfully after splitting the native migration button helper into smaller SwiftUI expressions. | Pass | Simulator QA still pending at this point. |
| 2026-05-17 10:18 MDT | Web visual QA | Logged into production Devices in the in-app browser with the temporary QA admin. Desktop 1280-ish viewport showed device cards too narrow, with long names wrapping one word per line. | Issue found/fixed | Updated `client/src/pages/Devices.tsx` to use responsive minmax card columns instead of fixed 4-column desktop layout. |
| 2026-05-17 10:19 MDT | Chrome visual QA | Codex Chrome Extension connection worked; logged into `https://freestonefamily.com/devices` with the temporary QA admin and verified the Devices page loads in Chrome. Wider Chrome viewport did not show the severe wrapping, but the same grid fix benefits narrower desktop widths. | Pass | Re-check production after deploy. |
| 2026-05-17 10:20 MDT | iOS auth QA | Installed the built app on iPhone 17 and iPad Pro 13-inch simulators, seeded a short-lived QA session, and verified HomeBrain opened authenticated. | Pass | Temporary QA admin must be removed after final UI/deploy checks. |
| 2026-05-17 10:28 MDT | iOS Devices QA | iPhone simulator real Devices navigation loaded live HomeBrain. Device dashboard cards, sensor grid, filters, and Devices module were visually usable on compact layout after dismissing the simulator location prompt. | Pass | No code change needed beyond existing migration-copy polish. |
| 2026-05-17 10:44 MDT | iOS Workflows QA | iPhone simulator real Workflows navigation loaded live HomeBrain. Workflow Studio overview, counts, templates, AI creation, and command entry were visible and usable on compact layout. | Pass | No additional iOS workflow code change needed. |
| 2026-05-17 10:49 MDT | Full server tests | `node scripts/run-with-modern-node.js npm --prefix server test` passed `606/606`. | Pass | Ready for git review and deploy path. |
| 2026-05-17 11:00 MDT | Final local builds | Re-ran `node scripts/run-with-modern-node.js npm --prefix client run build` and `xcodebuild -project HomeBrainApp/HomeBrainApp.xcodeproj -scheme HomeBrainApp -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.5' build` after final UX copy/grid polish. | Pass | Ready for git review and deploy path. |

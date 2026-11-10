# Live review remediation

This release follows the November 9, 2026 HomeBrain application and production review. The review correctly identified application security and recovery defects; service health alone did not establish device or alarm readiness.

## Application changes

| Finding | Change |
| --- | --- |
| Public proxy made loopback-only Axiom sync reachable | Caddy blocks `/internal` paths; internal sync independently requires an administrator credential. After successful startup discovery, HomeBrain watches the local Axiom manifest for actual hostname/redirect changes once a minute, preserving automatic reconciliation without the old unauthenticated trigger. Unchanged manifests do not apply saved proxy edits. |
| Workflow definitions could disclose credentials | HTTP headers, request bodies, query values and authentication are stored as encrypted credential references. Reads, historical execution records, event payloads and MCP output redact secrets. Existing workflow and automation definitions migrate before background runtime starts. Existing raw editing remains administrator-only. |
| Completed actions could replay after restart | Empty checkpoints complete without rerunning the action list. Missing checkpoints fail closed for manual reconciliation. |
| Relative commands could execute twice after uncertain timeouts | Relative device/IR commands and non-idempotent HTTP requests cannot opt into automatic workflow retries. Uncertain device outcomes explicitly require reconciliation. |
| Password resets and open streams could retain access | Password changes rotate the authentication version and legacy refresh credential, revoke stored sessions, and invalidate older access/refresh tokens. Device WebSockets and event/log streams expire at token expiry and recheck account/session access every 15 seconds. |
| Event reconnects could skip or duplicate events | Persisted publication is ordered; streams honor `Last-Event-ID`, subscribe before replay, drain all replay pages, and deduplicate replay/live overlap. Slow consumers disconnect with their durable cursor intact. |
| Failed MCP actions could look successful | Tool results and mutation audits distinguish success, partial failure and failure. |
| Green health hid operational failures | Health includes cached device availability, Zigbee IAS enrollment, recent automation failures, appliance integration readiness and backup recency. |
| Stalled remote voice handshake did not retry | Timed-out sockets are terminated, reconnect scheduling is deduplicated, and superseded sockets cannot change the current connection. |
| Client builds omitted typechecking | Builds run a shrinking TypeScript baseline gate. Current main had 1,020 diagnostics; this release has 1,016. New signatures or increased counts fail. CI also prevents increasing the accepted baseline. |
| Temporary network errors logged users out; status refresh lost edits | Only terminal authorization failures clear browser authentication. DNS maintenance updates only status fields and preserves unsaved form values. |
| Repeated appliance alerts remained unresolved | Stable active alert keys deduplicate notifications. Recovery resolves old daily alerts and superseded conditions. |
| Unconfigured INSTEON initialization produced errors | An explicit controller enable flag stops disabled connection/sync work and reports disabled state. |
| Backup and TLS maintenance gaps | Scheduled backups support retained local storage as well as SMB. Backups include `server/.env` and the workflow credential key under `server/data`; backup files are excluded from recursive backups. Public certificate status reads the certificate actually served by Caddy. |

The TypeScript gate is registered as an experimental project machine. Its tests exercise real compiler diagnostics, duplicate errors, shrinking behavior and stability across line movement. It is a regression barrier, not a claim that the existing TypeScript backlog is resolved.

## Production operations and remaining physical verification

- Freestone's saved daily SMB schedule is retained; increase its retention to 14 copies. Selene uses 14 retained local daily copies as requested. Local backups do not replace an external backup against disk failure.
- A pre-release Selene archive was downloaded to the administrator's Mac. Its database restored into an isolated MongoDB container with networking disabled: 53 collections, including six devices and three users. This rehearses archive/database recovery; it does not simulate replacing the Nano hardware.
- Selene's Caddy, Pi-hole, `linux-firmware` and `fwupd` packages were updated through the administrator's terminal. Jetson core/bootloader 36.4.7 already matched the configured NVIDIA repository, and the firmware manager reported no applicable device firmware update. Keep the Jetson bootloader and OS release aligned; no speculative bootloader flash is needed.
- Software cannot establish that a sleeping motion sensor reports a physical alarm event. Both reviewed motion sensors had `zoneState=0` despite matching coordinator addresses. Repair attempts now serialize and back off; someone at each house must wake the sensor and physically verify its intended alarm path.
- Freestone still needs on-site power/link/communications checks for offline INSTEON devices. TheaterAC has not reported since October 6. Its saved/last-observed IP difference does not establish the cause; confirm power and network reachability before changing its configuration.
- A cached siren state is not a physical siren test. No sirens, locks, alarm modes, heater settings or AC power states are actuated as verification for this release.

## Release checks and recovery

Server, client, remote-device, broker and Lambda regression suites; client lint/build/typecheck; repository host-control checks; and native Siri/Apple Home checks are required evidence for release. The native workflow explicitly boots its simulator before testing. Branch protection should require the regression and native job results before merge.

Before rolling back a release that migrates workflow credentials, preserve both the database and `server/data/workflow-credentials/credentials.key`. A database restored without its original key fails closed. Restore filesystem configuration and the database together; `SystemBackupService` and the administrator-owned restore helper provide that path.

Production verification must inspect the loaded runtime commit, core service readiness, new operational warnings, deployment events, scheduled backup target/retention, and current TLS expiry. An operational `degraded` result caused by unresolved physical devices must remain visible.

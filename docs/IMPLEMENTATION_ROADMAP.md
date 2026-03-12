# HomeBrain Implementation Roadmap (Historical)

Historical note:

This file is kept as a record of earlier implementation work. It is not the main operational documentation for the current HomeBrain platform.

Last updated: 2026-02-24

This file tracks execution status for the selected feature set so work can resume cleanly after interruptions.

## Selected Items

User-selected backlog items: `#1, #5, #6, #7, #8, #9, #11, #12`

## Status Snapshot

| Item | Scope | Status | Notes |
|---|---|---|---|
| #1 | Zero-touch Raspberry Pi onboarding | Completed | Claim token + cloud-init URL flow implemented in remote device setup/backend. |
| #5 | Persistent event stream backbone | Completed | Added event model/service/routes, replay API, summary API, and live SSE stream. |
| #6 | Admin operations visibility in UI | Completed | Added `Operations` page with live stream, filters, event severity counters, and health cards. |
| #7 | Workflow UX power-ups | Completed | Added quick templates plus clone/export/import workflow actions in Workflow Studio. |
| #8 | Easier remote fleet rollout UX | Completed | Updated fleet rollout to explicit update+verify flow in Voice Devices UI. |
| #9 | Observable critical actions | Completed | Emitted events for deploy, workflow, remote-device lifecycle, remote updates, and voice command processing. |
| #11 | OpenAI latest model compatibility | Completed (code path) | Defaults and compatibility path updated for GPT-5.2-codex and latest GPT-5 family IDs; requires runtime API-key validation in target env. |
| #12 | Open-source docs clarity | Completed | Updated README/docs/admin/configuration and added this implementation roadmap file. |

## Completed Since This Pass Started

1. Added stronger remote device bootstrap security and onboarding:
   - Claim token issuance and rotation.
   - Cloud-init endpoint for zero-touch Pi setup.
   - Bootstrap/cloud-init rate limiting and credential validation improvements.
2. Added event stream foundation + integration:
   - `server/models/EventStreamEvent.js`
   - `server/services/eventStreamService.js`
   - `server/routes/eventStreamRoutes.js`
   - `client/src/pages/Operations.tsx`
3. Added event publishers in:
   - remote device registration/activation/deletion flows
   - remote update package/init/status flows
   - workflow create/update/execute/delete/toggle flows
   - platform deploy start/complete/fail/restart flows
   - voice command processing HTTP pipeline
4. Added workflow operator tools:
   - quick template creation
   - workflow clone/export/import JSON
5. Updated docs for operations center and updated fleet rollout wording.

## Next Suggested Execution Order (Optional Follow-up)

1. Add role-based event stream filters/audiences if non-admin users should see reduced data.
2. Add event retention policy controls in Settings (TTL window, prune schedule).
3. Add automated runtime OpenAI compatibility smoke test in CI when API key is available.

## Resume Checklist (If Interrupted)

1. Run `git status --short` and review in-progress files.
2. Run:
   - `node --check server/routes/*.js`
   - `npm run lint --prefix client`
   - `node scripts/run-with-modern-node.js npm run build --prefix client`
3. Continue from first `In Progress`/`Pending` item in the table above.
4. Update this roadmap file after each completed item.

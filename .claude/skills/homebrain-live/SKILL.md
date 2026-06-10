---
name: homebrain-live
description: Use this skill when working on the HomeBrain codebase and you need live visibility into the running production HomeBrain instance. It uses a HomeBrain-generated skill URL and token to inspect live state, stream recent events, check resources and deploy health, trigger deploys, and verify changes against the real platform.
---

# HomeBrain Live

Use the bundled `scripts/homebrain-live.js` helper as the default way to inspect and operate the running HomeBrain platform.

## Inputs

- Prefer the environment variables `HOMEBRAIN_CODEX_URL` and `HOMEBRAIN_CODEX_TOKEN`.
- If the environment variables are missing, use the persistent helper config at `~/.claude/homebrain-live.json` (falls back to `$CODEX_HOME/homebrain-live.json` or `~/.codex/homebrain-live.json`).
- Only ask the user for the HomeBrain URL and the skill token if neither the environment nor the helper config provides them.
- Do not guess the URL or token.

## Working loop

1. Read current live state first.
2. Make the smallest code or deploy action needed.
3. Verify through live HomeBrain APIs after the change.
4. Report what changed and what the live platform showed.

## Safety rules

- Ask for confirmation before disruptive live actions (deploys, service restarts, settings changes, deleting entities or revoking access) unless the user has already authorized them.
- Prefer read-only inspection until the user clearly wants a live mutation.
- Use normal git or GitHub workflows for code publishing, then use the HomeBrain helper to deploy and verify.

## Default commands

- `node .claude/skills/homebrain-live/scripts/homebrain-live.js overview`
  Reads the current user, deploy status, deploy health, resource utilization, and recent event summary.

- `node .claude/skills/homebrain-live/scripts/homebrain-live.js events-tail --category deploy`
  Streams live HomeBrain events for verification after a deploy or admin action.

- `node .claude/skills/homebrain-live/scripts/homebrain-live.js deploy-run --preset safe`
  Starts a HomeBrain-managed deploy using the existing platform deploy flow.

- `node .claude/skills/homebrain-live/scripts/homebrain-live.js request /api/devices`
  Calls any authenticated HomeBrain API when a dedicated helper command does not fit.

## When to use which command

- Use `overview` at the start of live investigation or right after a deploy.
- Use `events-latest` or `events-tail` to verify behavior in real time.
- Use `deploy-status`, `deploy-health`, and `deploy-run` around release work.
- Use `request` for focused reads or targeted POST requests to authenticated HomeBrain APIs.

## Verification guidance

- After deploying, check `deploy-status`, `deploy-health`, and `events-tail`.
- After runtime-sensitive changes, also check `overview` so resource pressure or restart drift is visible.
- If a request fails, surface the exact HomeBrain error instead of inferring hidden causes.

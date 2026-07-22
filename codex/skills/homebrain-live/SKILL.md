---
name: homebrain-live
description: Use this skill when working on the HomeBrain codebase and you need live visibility into one or more running HomeBrain instances. It uses named HomeBrain-generated Codex URL/token targets to inspect live state, stream recent events, check resources and deploy health, trigger deploys, troubleshoot a specific house such as Freestone or Selene, and verify changes against the correct real platform.
---

# HomeBrain Live

Use the bundled `scripts/homebrain-live.js` helper as the default way to inspect and operate a running HomeBrain platform.

## Inputs

- When the user names a house or instance, select its saved target explicitly with `--target <name>` or `HOMEBRAIN_CODEX_TARGET`. Never substitute another HomeBrain instance.
- List sanitized target names and URLs with `node scripts/homebrain-live.js target-list`.
- Add a target with `node scripts/homebrain-live.js target-set <name> --url <url> --token-stdin`; pass the token on standard input so it does not enter shell history.
- Prefer the environment variables `HOMEBRAIN_CODEX_URL` and `HOMEBRAIN_CODEX_TOKEN` for a one-off direct connection.
- If environment variables are missing, use named targets or the legacy default connection in `$CODEX_HOME/homebrain-live.json` when `CODEX_HOME` is set, or `~/.codex/homebrain-live.json` as the fallback.
- Only ask the user for the HomeBrain URL and the Codex skill token if neither the environment nor the helper config provides them.
- Do not guess the URL or token.

## Working loop

1. Read current live state first.
2. Verify the reported connection target and base URL match the requested house.
3. Make the smallest code or deploy action needed.
4. Verify through live HomeBrain APIs after the change.
5. Report what changed and what the live platform showed.

## Safety rules

- Ask for confirmation before disruptive live actions:
  - triggering a deploy
  - restarting HomeBrain services
  - changing platform settings
  - deleting entities or revoking access
- Prefer read-only inspection until the user clearly wants a live mutation.
- Use normal git or GitHub workflows for code publishing, then use the HomeBrain helper to deploy and verify.
- For every deploy, restart, settings mutation, or destructive request in a multi-target setup, pass the explicit `--target` named by the user even when a default exists.

## Default commands

- `node scripts/homebrain-live.js overview --target <name>`
  Reads the current user, deploy status, deploy health, resource utilization, and recent event summary.

- `node scripts/homebrain-live.js events-tail --target <name> --category deploy`
  Streams live HomeBrain events for verification after a deploy or admin action.

- `node scripts/homebrain-live.js deploy-run --target <name> --preset safe`
  Starts a HomeBrain-managed deploy using the existing platform deploy flow.

- `node scripts/homebrain-live.js request /api/devices --target <name>`
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

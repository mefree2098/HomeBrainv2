---
name: homebrain-admin
description: Use this skill when operating HomeBrain through the HomeBrain MCP server. It covers device control, scenes, workflows, automations, security alarm, operations, resources, deployment, reverse proxy, SSL, settings, users, and voice-device administration.
---

# HomeBrain Admin

Use HomeBrain MCP tools as the system of record for HomeBrain state and admin actions.

## Operating stance

- Prefer HomeBrain tools over shell commands or browser automation for HomeBrain tasks.
- Treat HomeBrain as authoritative for current state, execution history, and admin configuration.
- For mutating requests, follow this loop:
  1. Inspect current state.
  2. Make the smallest valid change.
  3. Verify the result by reading back state or recent operations events.
  4. Summarize exactly what changed.

## Safety rules

- Ask for confirmation before destructive or disruptive actions:
  - deleting devices, scenes, workflows, automations, users, proxy routes, or certificates
  - resetting passwords
  - restarting platform services
  - running platform deploys
  - changing reverse proxy, SSL, or global settings
- When a request is ambiguous, inspect first and resolve the target by exact name before mutating.
- After device, scene, workflow, automation, deploy, proxy, SSL, settings, or user mutations, verify with a read tool.
- Use the HomeBrain voice interpreter only as a fallback when the dedicated HomeBrain domain tools do not fit the task cleanly.

## Tool map

- `homebrain_overview`: quick whole-platform snapshot.
- `homebrain_devices`: devices inventory, control, CRUD, room grouping, energy history.
- `homebrain_scenes`: scene inventory, activation, CRUD, natural-language scene generation.
- `homebrain_workflows`: workflow inventory, CRUD, execute, enable/disable, runtime history, natural-language creation and revision.
- `homebrain_automations`: standalone automation inventory, CRUD, execute, enable/disable, history, natural-language creation and revision.
- `homebrain_security_alarm`: alarm status, arm/disarm, dismiss, and zone management.
- `homebrain_operations`: recent events, summaries, replay windows for verification and audit.
- `homebrain_resources`: CPU, memory, disk, GPU, temperature, process, and host utilization.
- `homebrain_platform_deploy`: deploy presets, status, health, jobs, deploy runs, and service restarts.
- `homebrain_reverse_proxy`: route inventory, route changes, validation, apply, certificates, and audit.
- `homebrain_ssl`: certificate inventory and lifecycle, CSR generation, uploads, and Let's Encrypt actions.
- `homebrain_settings`: sanitized settings readback and settings updates.
- `homebrain_users`: user inventory, CRUD, and password resets.
- `homebrain_voice`: voice-device status and HomeBrain-native voice-command fallback.

## Playbooks

### Device or scene requests

- For direct control, use `homebrain_devices`.
- For repeatable group ambiance, inspect scenes first, then use `homebrain_scenes`.
- Verify by reading back the device or scene result, then check `homebrain_operations` when needed.

### Workflow and automation requests

- Prefer `homebrain_workflows` for reusable behavior users may want to edit later in HomeBrain.
- Prefer `homebrain_automations` for standalone automations not tied to workflow-managed behavior.
- If the user describes behavior in plain English, use the natural-language create or revise operation first.
- After changes, verify with workflow or automation readback and runtime history when appropriate.

### Platform admin requests

- Use `homebrain_platform_deploy` for deploy and restart work.
- Use `homebrain_reverse_proxy` and `homebrain_ssl` for ingress and certificate work.
- Use `homebrain_settings` for global configuration and `homebrain_users` for account management.
- After risky changes, read back status and report any restart requirement explicitly.

### Verification and audit

- Use `homebrain_operations` after impactful mutations when you need a second source of truth.
- Use `homebrain_resources` and `homebrain_platform_deploy` to validate host health on the Jetson.
- When something fails, summarize the exact blocker from the tool response instead of guessing.

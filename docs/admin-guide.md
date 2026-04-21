# HomeBrain Admin Guide

This guide is for the person running the HomeBrain hub.

## Daily Tasks

Check these pages first:

- `Dashboard`
- `Voice Devices`
- `Operations`

Watch for:

- offline listener devices
- offline wall panels
- failed updates
- degraded health checks
- repeated errors in the live event feed

## Adding A New Listener

Open `Voice Devices`.

1. Click `Add Remote Device`
2. Enter name and room
3. Copy the one-command installer
4. Run it on the target listener

Use Raspberry Pi if you want the most tested path. Other Debian/Ubuntu-based listeners are also possible now.

## Adding A Wall Panel

HomeBrain now has a separate wall-panel path for ELECROW round ESP32-S3 rotary displays.

Current deployment model:

1. Open `Settings -> Hardware Orbs`
2. Create the orb and copy its setup packet
3. Flash the firmware in [`../embedded/elecrow-wall-panel`](../embedded/elecrow-wall-panel)
4. Return to the same tab to bind the thermostat, room scenes, searchable pinned device controls, security actions, and Harmony activities you want on that orb

Use the full runbook here:

- [`elecrow-wall-panel.md`](elecrow-wall-panel.md)

Important:

- wall panels are `Wi-Fi` room controllers, not Linux voice listeners
- the current repo firmware targets the ELECROW `2.1"` rotary CrowPanel first

## Managing Profiles

Open `User Profiles`.

Set:

- display name
- prompt / behavior
- voice
- wake words

## Managing Smart Home Integrations

Open `Settings -> Integrations`.

Typical order:

1. SmartThings or Ecobee
2. Harmony
3. INSTEON / ISY

Only add one integration at a time and test after each save.

## Workflows And Scenes

Use:

- `Scenes` for grouped device states
- `Workflows` for routine triggers, schedules, visual editing, and AI-assisted generation
- `Automations` as internal runtime records generated from workflows

If something is complicated, build it in `Workflows` first. In normal use, treat `Workflows` as the source of truth.

For state-triggered workflows, HomeBrain now also treats the original trigger state as the cancellation guard. If a running workflow was started because a device or sensor matched a condition, and that condition stops matching during a delay or later step, the scheduler requests cancellation for the running workflow execution. This is designed for countdown automations such as bathroom fans, appliance-finished monitors, and similar stateful timers.

The iOS app can manage the same workflow shape: state trigger fields, hold time, cooldown, delay-then-action flows, triggering-device targets, and raw trigger/action JSON for web-authored workflows are available in Workflow Studio. Settings also links through to the platform administration surfaces that exist as first-class iOS screens.

## Updating HomeBrain

Two supported paths:

1. `Platform Deploy` in the UI
2. `bash scripts/setup-services.sh update` in the terminal

If the repo has uncommitted local changes, fix that first before updating from git.

## Health And Logs

```bash
bash scripts/setup-services.sh status
bash scripts/setup-services.sh logs follow
bash scripts/setup-services.sh health
```

## Security Baseline

- Keep the host OS updated
- Keep secrets only in `server/.env`
- Do not commit `server/.env`
- Use strong passwords for admin accounts
- Prefer LAN-only access unless you really need public HTTPS
- Use `COOKIE_SECURE=true` and exact `CORS_ALLOWED_ORIGINS` values for public HTTPS deployments
- Keep browser and native iOS session policies separate with `AUTH_SESSION_MAX_AGE_DAYS` and `AUTH_IOS_SESSION_MAX_AGE_DAYS`
- Run `bash scripts/check-secrets.sh --history` before pushing or publishing

## Weekly Checklist

- verify HomeBrain still opens on `http://<hub-ip>:3000`
- check that listener devices are online
- verify any wall panels still return healthy state from `/api/panels`
- confirm at least one successful recent backup of MongoDB and `server/.env`
- verify integrations still connect
- review recent errors in `Operations`

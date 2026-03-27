# HomeBrain Admin Guide

This guide is for the person running the HomeBrain hub.

## Daily Tasks

Check these pages first:

- `Dashboard`
- `Voice Devices`
- `Operations`

Watch for:

- offline listener devices
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

## Weekly Checklist

- verify HomeBrain still opens on `http://<hub-ip>:3000`
- check that listener devices are online
- confirm at least one successful recent backup of MongoDB and `server/.env`
- verify integrations still connect
- review recent errors in `Operations`

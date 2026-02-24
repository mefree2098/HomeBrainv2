# HomeBrain Admin Guide

This guide is for the person who manages the HomeBrain system.

## Daily Admin Workflow

### 1. Check System Health

Open `Dashboard` and `Voice Devices`.

Look for:
- Offline devices
- Update failures
- Low battery warnings

### 2. Manage Listener Devices (Raspberry Pi)

Open `Voice Devices`.

To add a new room:
1. Click `Add Remote Device`.
2. Enter device name and room.
3. Copy the generated one-command installer.
4. Run it on the Pi.

To update your full fleet:
1. In `Remote Fleet Updates`, click `Update All Outdated Devices`.
2. Click `Verify Versions`.

### 3. Manage Users and Voice Profiles

Open `User Profiles`.

For each profile:
- Set display name/personality
- Set voice (for TTS)
- Set wake words (for example, Anna, Hey Anna)

### 4. Build and Manage Workflows

Open `Workflows`.

You can:
1. Create visual workflows with trigger + action steps.
2. Generate workflows from plain-English text.
3. Run/enable/disable workflows immediately.
4. Add voice aliases (for example, `bedtime workflow`) so household users can trigger them naturally.

Recommended pattern:
- Start with AI generation.
- Open the visual builder to fine-tune trigger/action details.
- Test with `Run Now`.

### 5. Manage Wake Words

Open `Settings -> Voice & Audio -> Wake Word Models`.

1. Download Piper voices once.
2. Create or retrain wake words.
3. Wait until status is `ready`.
4. Confirm remote devices sync automatically.

### 6. Deploy Latest GitHub Changes

Open `Platform Deploy`.

1. Confirm repo status is healthy.
2. Click `Pull + Deploy Latest`.
3. Monitor job log tail in the same page.

If restart fails with permissions, configure sudoers:

```bash
echo "<JETSON_USER> ALL=(ALL) NOPASSWD:/usr/bin/systemctl,/bin/systemctl" | \
  sudo tee /etc/sudoers.d/homebrain-deploy
sudo chmod 0440 /etc/sudoers.d/homebrain-deploy
```

## Weekly Checklist

1. Verify backups exist for:
   - `server/.env`
   - MongoDB data
   - `server/data`
   - `server/public/wake-words`
2. Run one full remote fleet version verification.
3. Confirm SmartThings/INSTEON integrations are still healthy.
4. Review `Platform Deploy` status for last successful update.

## Security Baseline

1. Keep Jetson OS and npm dependencies updated.
2. Use strong admin passwords.
3. Keep API keys only in environment/config (never in client code).
4. Keep HomeBrain on trusted local networks or behind VPN/reverse proxy.

## If Something Breaks

Go to [Troubleshooting](troubleshooting.md) first.

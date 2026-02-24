# HomeBrain Troubleshooting

Use this page for fast diagnosis of common issues.

## Quick Health Check

Run on the hub:

```bash
sudo systemctl status homebrain mongod --no-pager
curl -s http://localhost:3000/api/ping || true
df -h
free -h
```

If HomeBrain is running correctly:
- `homebrain` service is `active (running)`
- API ping returns a response

## Common Problems

### UI does not load

Check:

```bash
sudo journalctl -u homebrain -n 120 --no-pager
sudo lsof -i :5173 -i :3000
```

Fix:
1. Restart service: `sudo systemctl restart homebrain`
2. Confirm `.env` exists: `ls -la server/.env`
3. Rebuild client if needed: `npm run build --prefix client`

### Cannot login / auth errors

Check:

```bash
sudo journalctl -u homebrain -n 200 --no-pager | grep -i auth
```

Fix:
1. Confirm `JWT_SECRET` and `REFRESH_TOKEN_SECRET` are set in `server/.env`.
2. Restart service after env changes.

### Remote device will not come online

On Pi:

```bash
sudo systemctl status homebrain-remote --no-pager
sudo journalctl -u homebrain-remote -n 120 --no-pager
```

Fix:
1. Re-run one-command installer from UI.
2. Confirm Pi can reach hub (`ping <hub-ip>`).
3. Confirm registration code is current (registration codes expire).

### Wake word not triggering

Check in UI:
1. `Settings -> Voice & Audio -> Wake Word Models`: model status is `ready`
2. `User Profiles`: wake word is assigned to an active profile
3. `Voice Devices`: listener is online and updated

On Pi:

```bash
sudo journalctl -u homebrain-remote -f
```

### Fleet updates not finishing

In UI:
1. `Voice Devices -> Remote Fleet Updates`
2. Click `Verify Versions`

If devices remain behind:
1. Make sure those devices are online.
2. Retry `Update All Outdated Devices`.
3. Check listener logs for download/install failures.

### Platform Deploy fails

Common causes:
- Dirty git worktree
- Missing GitHub credentials
- Restart command permission issue

Fix checks:

```bash
cd ~/homebrain/HomeBrainv2
git status --short
git remote -v
```

If restart permission fails, configure sudoers as documented in [DEPLOYMENT.md](../DEPLOYMENT.md).

### Whisper STT issues

In UI:
1. Open `Whisper STT` page.
2. Verify dependencies installed.
3. Verify selected model is downloaded and active.

If needed, restart HomeBrain:

```bash
sudo systemctl restart homebrain
```

### SmartThings integration fails

Check:
1. Token still valid.
2. Required permissions were granted when creating token.
3. Hub has internet connectivity.

Test connectivity from hub:

```bash
curl -I https://api.smartthings.com/v1/devices
```

## Still Stuck?

Collect these before asking for help:
1. Hub logs: `sudo journalctl -u homebrain -n 300 --no-pager`
2. Listener logs (if applicable): `sudo journalctl -u homebrain-remote -n 300 --no-pager`
3. What page/action failed and exact timestamp
4. Screenshot of UI error message

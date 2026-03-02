# HomeBrain Troubleshooting

Use this page for fast diagnosis of common issues.

## Quick Health Check

Run on the hub:

```bash
sudo systemctl status homebrain mongod --no-pager
curl -s http://localhost:3000/ping || true
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
3. Rebuild client if needed: `node scripts/run-with-modern-node.js npm run build --prefix client`

### Cannot login / auth errors

Check:

```bash
sudo journalctl -u homebrain -n 200 --no-pager | grep -i auth
```

Fix:
1. Confirm `JWT_SECRET` and `REFRESH_TOKEN_SECRET` are set in `server/.env`.
2. Restart service after env changes.

### INSTEON PLM will not connect

Important:
- The 2413S PLM RJ45 jack is serial, not Ethernet networking.
- A direct Jetson Ethernet NIC -> PLM cable will not work.

Use one of these endpoint formats in `Settings -> Integrations`:
- Local serial: `/dev/serial/by-id/usb-...` (preferred) or `/dev/ttyUSB0`
- Serial-over-TCP bridge: `tcp://<bridge-host>:<port>`

Checks:

```bash
# HomeBrain status
curl -s http://127.0.0.1:3000/api/insteon/status

# List serial ports HomeBrain can see
curl -s http://127.0.0.1:3000/api/insteon/serial-ports

# If using local serial
ls -l /dev/ttyUSB* /dev/ttyACM* /dev/serial/by-id/* 2>/dev/null

# Confirm service user has serial permissions
id $(whoami) | tr ' ' '\n' | grep dialout || true

# If using TCP bridge
nc -vz <bridge-host> <port>
```

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

### Wake-word worker health is degraded (executable missing)

Symptom in `Platform Deploy -> Post-Deploy Health Check`:
- `Wake-word worker executable is missing`

Fix on hub:

```bash
cd ~/HomeBrainv2/server
PYTHON_BIN=python3 scripts/install-openwakeword-deps.sh
test -x .wakeword-venv/bin/python && .wakeword-venv/bin/python --version
sudo systemctl restart homebrain homebrain-discovery
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
cd ~/HomeBrainv2
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
1. OAuth app is configured (`Client ID` + `Client Secret`) in `Settings -> Integrations`.
2. SmartThings account is connected (not just configured).
3. Hub has internet connectivity.

Test connectivity from hub:

```bash
curl -I https://api.smartthings.com/v1/devices
```

### Security alarm does not arm/disarm in SmartThings

Check:
1. `Settings -> Integrations -> SmartThings Home Monitor Bridge` has all three switches mapped (`Disarm`, `Arm Stay`, `Arm Away`).
2. Those mapped devices are virtual switches that accept `on/off` (or `momentary` push).
3. SmartThings routines enforce one-hot state:
   - STHM mode change turns on one switch and turns the other two off.
   - Turning on each bridge switch sets the matching STHM mode.
4. SmartThings account is connected via OAuth (new PATs expire after 24 hours).
5. HomeBrain service can reach your MongoDB and SmartThings API (if DB is down, alarm sync/status will fail).

In UI:
1. Open `Settings -> Integrations -> SmartThings Home Monitor Bridge`.
2. Click `Run Diagnostics`.
3. Review:
   - Last command result/error
   - Resolved security state source
   - Per-switch on/off/error status

Quick checks:

```bash
# Verify backend can start and reach DB
sudo journalctl -u homebrain -n 200 --no-pager | rg -n "Mongo|SmartThings|security|alarm"
```

If the alarm still appears stale/offline, run a SmartThings webhook/activity check and confirm event delivery is current.

### Logitech Harmony Hubs are not discovered or won’t sync

Check:
1. Hubs are on the same LAN/subnet as HomeBrain, or manually listed in `Configured Harmony Hub IPs/Hosts`.
2. Harmony app has XMPP/local control enabled if required by your hub firmware.
3. No firewall/VLAN rule is blocking UDP discovery or local hub WebSocket access.

Recovery steps in UI:
1. Open the `Logitech Harmony Hub Integration` card in `Settings -> Integrations`.
2. Add hub IPs manually (if discovery is blocked).
3. Click `Discover Hubs`.
4. Click `Sync Activities to Devices`.

## Still Stuck?

Collect these before asking for help:
1. Hub logs: `sudo journalctl -u homebrain -n 300 --no-pager`
2. Listener logs (if applicable): `sudo journalctl -u homebrain-remote -n 300 --no-pager`
3. What page/action failed and exact timestamp
4. Screenshot of UI error message

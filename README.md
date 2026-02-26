# HomeBrain v2

HomeBrain is a local-first AI home automation platform designed to run on a Jetson hub and connect room listeners (Raspberry Pi devices) across your home.

It combines:
- Smart home control (SmartThings, INSTEON, and Logitech Harmony Hub)
- Voice profiles (for example, Anna and Henry)
- Wake-word training with OpenWakeWord
- Local/on-device STT with Whisper (or cloud STT)
- TTS responses with ElevenLabs
- UI-based remote fleet updates and hub deployment

## Start Here (Non-Technical Path)

If this is your first time, follow these in order:
1. [Jetson Setup Guide](docs/jetson-setup.md)
2. [Admin Guide](docs/admin-guide.md)
3. [User Guide](docs/user-guide.md)

## 15-Minute Quick Start (Hub)

These steps install and run HomeBrain on a Jetson Orin Nano (Ubuntu/JetPack based).

### 1. Install base system packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl gnupg build-essential python3 python3-pip python3-venv pkg-config libcap2-bin
```

Expected result: command completes without errors.

### 2. Install Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Expected result: `node -v` prints `v22.x` (or newer).

### 3. Install MongoDB and start it

```bash
curl -fsSL https://pgp.mongodb.com/server-6.0.asc | \
  sudo gpg --dearmor -o /usr/share/keyrings/mongodb-server-6.0.gpg
echo "deb [ arch=arm64,amd64 signed-by=/usr/share/keyrings/mongodb-server-6.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/6.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
sudo systemctl status mongod --no-pager
```

Expected result: status shows `active (running)`.

### 4. Clone and install HomeBrain

```bash
git clone https://github.com/mefree2098/HomeBrainv2.git
cd HomeBrainv2
npm install
```

Expected result: installs finish without fatal errors.

Note: server dependencies include a local compatibility override for legacy `spark` optional code paths so security audits stay clean without changing INSTEON PLM behavior.

### 5. Configure environment

```bash
cp server/.env.example server/.env
```

Edit `server/.env` and set:
- `DATABASE_URL` (default local value usually works)
- `JWT_SECRET`
- `REFRESH_TOKEN_SECRET`
- optional API keys (`ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, etc.)

Generate secure values:

```bash
openssl rand -hex 32
```

### 6. Start HomeBrain

```bash
npm start
```

Expected result:
- Server on `http://<hub-ip>:3000`
- UI on `http://<hub-ip>:5173`

Open the UI and create your first account.

### 7. Bootstrap wake-word worker (recommended)

```bash
cd server
PYTHON_BIN=python3 scripts/install-openwakeword-deps.sh
cd ..
```

Expected result: `server/.wakeword-venv/bin/python` exists and wake-word health check can become `healthy`.

### 8. Allow Node to bind ports 80/443 (required for HTTPS + ACME)

```bash
NODE_BIN="$(cd ~/HomeBrainv2 && node scripts/run-with-modern-node.js node -p 'process.execPath')"
sudo setcap 'cap_net_bind_service=+ep' "$NODE_BIN"
getcap "$NODE_BIN"
```

Expected result: output includes `cap_net_bind_service=ep`.

## Raspberry Pi Onboarding (Insanely Simple)

From the HomeBrain UI:
1. Open `Voice Devices`.
2. Click `Add Remote Device`.
3. Fill name and room.
4. Copy the generated one-command installer.
5. Run that command on the Raspberry Pi.

Expected result:
- Pi installs, registers, and starts `homebrain-remote`.
- Device appears as `Online` in `Voice Devices`.

Manual fallback instructions: [remote-device/README.md](remote-device/README.md)

## Remote Fleet Updates (From UI)

Open `Voice Devices` and use the `Remote Fleet Updates` card:
- `Update + Verify Outdated Devices` pushes updates and runs automatic version verification.
- `Verify Versions` confirms fleet version state.

Expected result: online devices converge to the latest package version.

## Workflow Studio (Voice + Chat + Visual Builder)

Open `Workflows` in the sidebar.

You can build workflows three ways:
1. `Visual Builder`: click `New Workflow`, choose trigger, add step-by-step actions, save.
2. `AI Generate`: describe the routine in plain language and click `Generate Workflow`.
3. `Chat/Voice Command`: send commands like:
   - `"create a workflow that turns off all lights at 11 PM"`
   - `"create a workflow that starts the living room movie activity at 7 PM"`
   - `"run bedtime workflow"`
   - `"disable weekday morning workflow"`

What this gives you:
- Scheduled execution (`time` and `cron` triggers)
- Manual run-from-UI controls
- Voice/chat workflow create + control
- Linked execution history through the automation engine

## Logitech Harmony Hub Integration

Open `Settings -> Integrations`, then use the `Logitech Harmony Hub Integration` card.

1. (Optional) Enter known hub IPs/hosts in `Configured Harmony Hub IPs/Hosts`.
2. Click `Discover Hubs`.
3. Click `Sync Activities to Devices`.
4. Use the generated Harmony Hub activity devices in automations and workflows just like other devices.

Notes:
- Harmony Hub activity devices support `turn_on`, `turn_off`, and `toggle`.
- HomeBrain keeps activity state refreshed so manual Harmony remote changes are reflected in device status.

## Hub Deploy From UI (Pull Latest GitHub + Restart)

Open `Platform Deploy`:
- Review repo status (branch, commit, dirty state)
- Choose a deploy preset (`Safe`, `Minimal`, or `Full`)
- Click `Pull + Deploy Latest`
- Watch step-by-step logs in the page
- Run the built-in post-deploy health check card (API, websocket, DB, wake-word worker)

If service restart needs elevated permission, configure sudoers for the service user:

```bash
echo "<JETSON_USER> ALL=(ALL) NOPASSWD:/usr/bin/systemctl,/bin/systemctl" | \
  sudo tee /etc/sudoers.d/homebrain-deploy
sudo chmod 0440 /etc/sudoers.d/homebrain-deploy
```

If you only run a single `homebrain` service, override restart command in the service environment:

```bash
sudo systemctl edit homebrain
```

Add:

```ini
[Service]
Environment=HOMEBRAIN_DEPLOY_RESTART_CMD=sudo systemctl restart homebrain
```

Then run:

```bash
sudo systemctl daemon-reload
sudo systemctl restart homebrain
```

## Operations Center (Live Events + Health)

Open `Operations` in the sidebar (admin):
- View live event stream for workflow, voice, fleet update, and deploy activity.
- Filter events by source/type.
- See rolling event counts and severity totals.
- Review API/WebSocket/DB/wake-word worker health in one panel.

Expected result: admins can diagnose most issues from UI without shell access.

## Wake Words (Anna/Henry/Custom)

Open `Settings -> Voice & Audio -> Wake Word Models`:
1. Download one or more Piper voices.
2. Create a wake word phrase.
3. Wait for status to reach `ready`.
4. Assign phrase(s) in `User Profiles`.

When a profile voice is set, HomeBrain pre-generates quick acknowledgment lines and plays one at random while the full AI response is generated.

Full guide: [docs/wake-word-setup.md](docs/wake-word-setup.md)

## Documentation

- [Docs Index](docs/README.md)
- [Jetson Setup](docs/jetson-setup.md)
- [Admin Guide](docs/admin-guide.md)
- [User Guide](docs/user-guide.md)
- [Configuration Guide](docs/configuration.md)
- [Deployment Runbook](DEPLOYMENT.md)
- [Active Implementation Roadmap](docs/IMPLEMENTATION_ROADMAP.md)
- [Troubleshooting](docs/troubleshooting.md)

## Contributor Quick Start

```bash
git clone https://github.com/mefree2098/HomeBrainv2.git
cd HomeBrainv2
npm install
npm install --prefix server
npm install --prefix client
npm test --prefix server
npm run lint --prefix client
npm audit --prefix server --omit=dev
```

For feature work, keep changes UI-first where possible so admins can manage the platform without terminal access.

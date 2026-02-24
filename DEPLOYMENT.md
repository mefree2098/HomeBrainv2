# HomeBrain Deployment Runbook (Production)

Use this guide when you want HomeBrain to run continuously on a Jetson hub with minimal manual work.

## Deployment Goal

After this runbook:
- HomeBrain starts automatically on boot.
- MongoDB starts automatically on boot.
- Remote devices can onboard from the UI.
- You can deploy updates from the `Platform Deploy` page.

## 1. Host Prerequisites

- Jetson Orin Nano with Ubuntu/JetPack (Jammy-based recommended)
- Stable LAN connection
- GitHub access to this repository

Install core dependencies:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl gnupg build-essential python3 python3-pip python3-venv pkg-config libcap2-bin
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Install MongoDB:

```bash
curl -fsSL https://pgp.mongodb.com/server-6.0.asc | \
  sudo gpg --dearmor -o /usr/share/keyrings/mongodb-server-6.0.gpg
echo "deb [ arch=arm64,amd64 signed-by=/usr/share/keyrings/mongodb-server-6.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/6.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
```

Expected result:
- `node -v` prints `v22.x` (or newer)
- `sudo systemctl status mongod --no-pager` shows `active (running)`

## 2. Install HomeBrain

```bash
mkdir -p ~/homebrain
cd ~/homebrain
git clone https://github.com/mefree2098/HomeBrainv2.git
cd HomeBrainv2
npm install
npm install --prefix server
npm install --prefix client
```

## 3. Configure Environment

```bash
cp server/.env.example server/.env
nano server/.env
```

Minimum required variables:
- `PORT=3000`
- `DATABASE_URL=mongodb://localhost/HomeBrain`
- `JWT_SECRET=<secure-random>`
- `REFRESH_TOKEN_SECRET=<secure-random>`

Generate secrets:

```bash
openssl rand -hex 32
```

Optional but common:
- `ELEVENLABS_API_KEY`
- `OPENAI_API_KEY`
- `SMARTTHINGS_PAT`

## 4. Build Frontend

```bash
npm run build --prefix client
```

Expected result: `client/dist` is created.

## 5. Create Systemd Service

Create `/etc/systemd/system/homebrain.service`:

```ini
[Unit]
Description=HomeBrain Smart Home Hub
After=network.target mongod.service
Requires=mongod.service

[Service]
Type=simple
User=<JETSON_USER>
WorkingDirectory=/home/<JETSON_USER>/homebrain/HomeBrainv2
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now homebrain
sudo systemctl status homebrain --no-pager
```

Expected result: `homebrain` status is `active (running)`.

## 6. Allow Platform Deploy to Restart Services

The UI `Platform Deploy` feature uses a restart command after deployment.

Allow controlled passwordless restart:

```bash
echo "<JETSON_USER> ALL=(ALL) NOPASSWD:/usr/bin/systemctl,/bin/systemctl" | \
  sudo tee /etc/sudoers.d/homebrain-deploy
sudo chmod 0440 /etc/sudoers.d/homebrain-deploy
```

Optional: customize restart command with environment variable.
This is useful if you only run one service (`homebrain`) and do not have `homebrain-discovery`.

```bash
sudo systemctl edit homebrain
```

Add:

```ini
[Service]
Environment=HOMEBRAIN_DEPLOY_RESTART_CMD=sudo systemctl restart homebrain
```

Apply:

```bash
sudo systemctl daemon-reload
sudo systemctl restart homebrain
```

## 7. First Login and Admin Setup

1. Open `http://<hub-ip>:5173`
2. Create the first account
3. Configure integrations and voice settings
4. Add first remote listener from `Voice Devices -> Add Remote Device`

## 8. Operational Commands

Service status:

```bash
sudo systemctl status homebrain --no-pager
```

Live logs:

```bash
sudo journalctl -u homebrain -f
```

Restart:

```bash
sudo systemctl restart homebrain
```

## 9. Upgrade Process (Recommended)

Preferred:
1. Use UI `Platform Deploy -> Pull + Deploy Latest`.
2. Review job log and completion state in UI.

Fallback (terminal):

```bash
cd ~/homebrain/HomeBrainv2
git pull --ff-only
npm install
npm install --prefix server
npm install --prefix client
npm run build --prefix client
npm test --prefix server
sudo systemctl restart homebrain
```

## 10. Backup Essentials

Back up:
- `server/.env`
- MongoDB data directory
- `server/data`
- `server/public/wake-words`

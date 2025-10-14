# HomeBrain Jetson Orin Nano Deployment Guide

This document walks through deploying the HomeBrain platform from this repository onto an NVIDIA Jetson Orin Nano that is starting from a clean JetPack installation. Every command is included so you can follow along even if you have never managed a Linux system before.

---

## What You Will Set Up
- Node.js backend (`server/server.js`) with REST APIs, WebSockets, auto-discovery, and automation services.
- Vite/React front-end (`client/`) served on your network.
- MongoDB database running locally on the Jetson.
- Optional HTTPS (self-managed certificates) and remote voice device packages.

HomeBrain uses these default ports:
- `3000/tcp` - API and WebSocket traffic
- `443/tcp` - optional HTTPS API (if certificates are configured)
- `5173/tcp` - front-end UI (Vite preview or dev server)
- `12345/udp` - device discovery broadcast channel

---

## Before You Begin
- Hardware: Jetson Orin Nano Developer Kit (8 GB recommended), at least 64 GB of storage, reliable power supply.
- Network: Wired Ethernet is easiest. Wi-Fi works but keep the Jetson and control devices on the same LAN.
- Accounts: NVIDIA developer account for JetPack downloads and, if using Git, access to the remote repository.
- Conventions in this guide:
  - Commands that start with `sudo` will prompt for your password.
  - Replace placeholders like `<your-jetson-user>` or `<YOUR_REPO_URL>` with values that match your setup.
  - The project folder on the Jetson will be `/home/<your-jetson-user>/homebrain/HomeBrainv2` unless you choose another path.

---

## Step 0 - Flash JetPack on the Jetson (skip if JetPack 5.1+ is already installed)
1. On another computer download the latest JetPack image (5.1.2 or newer) from https://developer.nvidia.com/jetpack.
2. Flash the image to your microSD card or NVMe drive using NVIDIA SDK Manager or BalenaEtcher.
3. Insert the storage in the Jetson, connect monitor, keyboard, mouse, and power.
4. Complete the Ubuntu first boot wizard. Create a user such as `homebrain` and note the password.

---

## Step 1 - First boot housekeeping
Open a terminal on the Jetson (Ctrl+Alt+T) and run:
```bash
sudo apt update
sudo apt upgrade -y
```

Set the timezone (replace with your region):
```bash
sudo timedatectl set-timezone America/New_York
```

If you use Wi-Fi:
```bash
nmcli device wifi list
nmcli device wifi connect "YOUR_WIFI_NAME" password "YOUR_WIFI_PASSWORD"
```

---

## Step 2 - Install base packages
```bash
sudo apt install -y git build-essential curl wget nano htop pkg-config python3 make g++ net-tools ufw libcap2-bin
```

These packages provide compilers, editors, network tools, and the `setcap` utility used to grant Node.js permission to bind privileged ports.

---

## Step 3 - Install Node.js 18 LTS
HomeBrain server code targets Node 18.
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

node -v
npm -v
```
You should see versions that start with `v18.` and `9.` or later.

---

## Step 4 - Install MongoDB 6.0
MongoDB stores HomeBrain data.

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-6.0.asc | sudo tee /usr/share/keyrings/mongodb-server-6.0.gpg > /dev/null
echo "deb [ arch=arm64,amd64 signed-by=/usr/share/keyrings/mongodb-server-6.0.gpg ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/6.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list

sudo apt update
sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
sudo systemctl status mongod
```

`systemctl status` should report `active (running)`. Press `q` to exit.

---

## Step 5 - Create a workspace
```bash
mkdir -p ~/homebrain
cd ~/homebrain
```

### Option A - clone from Git
```bash
git clone https://github.com/mefree2098/HomeBrainv2.git
cd HomeBrainv2
```

### Option B - copy from your development machine
On the computer that already has this folder:
```bash
cd path/to/HomeBrainv2
tar -czf HomeBrainv2.tar.gz .
scp HomeBrainv2.tar.gz <your-jetson-user>@<jetson-ip>:/home/<your-jetson-user>/homebrain/
```

Back on the Jetson:
```bash
cd ~/homebrain
mkdir HomeBrainv2
tar -xzf HomeBrainv2.tar.gz -C HomeBrainv2
cd HomeBrainv2
```

Find the Jetson IP with `hostname -I` if needed.

---

## Step 6 - Install project dependencies
The project has separate npm workspace

```bash
cd ~/homebrain/HomeBrainv2
npm install

cd server
npm install

cd ../client
npm install
```

Each command can take several minutes on ARM hardware. Wait for each to finish.

---

## Step 7 - Configure the server environment
Copy the sample file and edit it.

```bash
cd ~/homebrain/HomeBrainv2/server
cp .env.example .env
nano .env
```

Set the following values:
```
PORT=3000
DATABASE_URL=mongodb://localhost/HomeBrain
JWT_SECRET=<paste output from openssl rand -hex 32>
REFRESH_TOKEN_SECRET=<paste another value>
ELEVENLABS_API_KEY=   # leave blank unless you have a key
HTTPS_PORT=443
ACME_CHALLENGE_PORT=80
# CLIENT_URL=https://your-domain.com   # optional override for frontend redirects
```

Port 80 must be available so the built-in ACME challenge listener can respond to Let's Encrypt HTTP-01 checks. Ensure port 443 is also free if you keep the default HTTPS listener; stop or reconfigure any conflicting service before requesting certificates.

Grant the Node.js binary permission to bind privileged ports (80/443) once after installation:
```bash
sudo setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))
```
The capability survives reboots, but rerun the command whenever Node.js is upgraded or reinstalled because the binary path may change.

Generate secrets whenever you need them:
```bash
openssl rand -hex 32
```

Save (`Ctrl+O`, Enter) and exit (`Ctrl+X`).

---

## Step 8 - Install OpenWakeWord training dependencies (and Piper)
The hub now generates datasets, augments them, and trains wake-word models locally using PyTorch and Piper.
Run the helper script once (and again after future upgrades) to provision the Python toolchain (PyTorch + torchaudio/torchmetrics/torchinfo, soundfile, librosa, pronouncing, audiomentations + torch-audiomentations, webrtcvad, speechbrain, mutagen, acoustics, onnxruntime/onnx-tf, TensorFlow Lite converters, openwakeword, and Piper CLI):

```bash
cd ~/homebrain/HomeBrainv2/server
scripts/install-openwakeword-deps.sh
```

Set `PYTHON_BIN=/usr/bin/python3.10` if you need to target a specific interpreter.
The training service automatically prefers `server/.wakeword-venv/bin/python` on restart. The script also installs `piper-tts` into this venv so the Piper CLI is available at `server/.wakeword-venv/bin/piper`.
If you need TensorFlow Lite exports, install the Jetson-specific TensorFlow wheel manually after the script finishes (see NVIDIA's matrix), then re-run the script; otherwise the pipeline will produce ONNX artifacts and the Pi will fall back to ONNX Runtime.
After installing the dependencies restart the HomeBrain server process (`sudo systemctl restart homebrain`) so the training worker reloads the new virtualenv. Manage wake words from the UI under **Settings -> Voice & Audio -> Wake Word Models**.

If your Piper binary is installed elsewhere, set `WAKEWORD_PIPER_EXEC=/full/path/to/piper` in the HomeBrain service environment. The training service will auto-detect common paths but an explicit env var is the most reliable.


---



## Step 9 - Seed the database (optional)
HomeBrain ships with seeding scripts.

```bash
cd ~/homebrain/HomeBrainv2/server
node scripts/seedDatabase.js
```

To seed only a specific area:
```bash
node scripts/seedDatabase.js devices
node scripts/seedDatabase.js scenes
```

---

## Step 10 - Create your first admin account
```bash
cd ~/homebrain/HomeBrainv2/server/scripts
node createAdminUser.js --email you@example.com --password 'Str0ngPassw0rd!'
```

The script enforces a strong password. Use `--force` if you need to replace an existing admin.

---

## Step 11 - Build the client UI (optional but recommended)
This generates `client/dist` so you can serve static files or use `vite preview`.

```bash
cd ~/homebrain/HomeBrainv2/client
npm run build
```

---

## Step 12 - Manual smoke test
Verify everything before enabling the service.

### Single command that runs both client and server
```bash
cd ~/homebrain/HomeBrainv2
NODE_ENV=production npm start
```

### Separate terminals (alternative)
```bash
# Terminal 1
cd ~/homebrain/HomeBrainv2/server
NODE_ENV=production npm run dev

# Terminal 2
cd ~/homebrain/HomeBrainv2/client
npm run dev -- --host 0.0.0.0 --port 5173
```

Browse to `http://<jetson-ip>:5173` and sign in with the admin credentials. Stop the processes with `Ctrl+C` when you are satisfied.

---

## Step 12 - Configure a systemd service
Create a service so HomeBrain starts on boot.

```bash
sudo nano /etc/systemd/system/homebrain.service
```

Paste the contents below (adjust the username and path if yours differ):

```
[Unit]
Description=HomeBrain Smart Home Hub
After=network.target mongod.service
Requires=mongod.service

[Service]
Type=simple
User=<your-jetson-user>
WorkingDirectory=/home/<your-jetson-user>/homebrain/HomeBrainv2
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Save and exit, then enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now homebrain
sudo systemctl status homebrain
```

`status` should show `active (running)`. Use `journalctl -u homebrain -f` to tail live logs. Restart after updates with `sudo systemctl restart homebrain`.

---

## Step 13 - Configure the firewall
If you plan to use UFW:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 3000/tcp
sudo ufw allow 5173/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Discovery uses UDP 12345; most setups do not require extra firewall rules for outbound UDP.

---

## Step 14 - Allow HomeBrain to install Ollama (optional)
The *Ollama Management* page can install and update Ollama for you, but the backend needs passwordless sudo to run the installer. You have two choices:

1. **Let HomeBrain manage the install** - grant the service the minimum commands it needs (edit the file with `visudo -f` if it already exists):
   ```bash
   echo 'matt ALL=(ALL) NOPASSWD:/usr/bin/apt,/usr/bin/systemctl,/usr/bin/curl,/usr/bin/tar,/usr/bin/tee,/usr/bin/ollama,/usr/bin/true,/usr/bin/sh' | sudo tee /etc/sudoers.d/homebrain-ollama
   sudo chmod 0440 /etc/sudoers.d/homebrain-ollama
   sudo visudo -c    # optional sanity check
   sudo systemctl restart homebrain
   ```
   Replace `matt` with the account that runs HomeBrain if yours is different.

2. **Install Ollama yourself once** – skip the sudoers rule and pre-install directly:
   ```bash
   curl -fsSL https://ollama.com/install.sh | sudo sh
   sudo systemctl enable --now ollama
   ```
   After this, click **Check Status** in the UI instead of **Install**.

Pick only one path; you do not need both.

---

## Step 15 - Deploy a remote voice device (Raspberry Pi 4B)
1. **Prepare the Pi**
   - Flash Raspberry Pi OS Lite (64-bit) and enable SSH (using Raspberry Pi Imager “Advanced options”).
   - Boot, connect to your network, and update packages:
     ```bash
     sudo apt update && sudo apt upgrade -y
     ```

2. **Pull the latest HomeBrain code on the Jetson**
   ```bash
   cd ~/homebrain/HomeBrainv2
   git pull
   ```

3. **Copy the remote device folder to the Pi**
   ```bash
   scp -r remote-device pi@<pi-ip>:/home/pi/
   ```
   Replace `<pi-ip>` with the Pi’s address; the default username is `pi` unless you customised it.

4. **Run the installer on the Pi (handles dependencies automatically)**
   ```bash
   ssh pi@<pi-ip>
   cd ~/remote-device
   bash install.sh
   ```
   The script installs ALSA/SOX utilities, Node.js 18, auto-detects matching capture/playback ALSA cards (favoring USB devices), and creates `/home/pi/homebrain-remote` with helper scripts. To override the defaults later, edit `/etc/asound.conf` on the Pi.

5. **Verify audio and register the device**
   ```bash
   cd ~/homebrain-remote
   ./test-audio.sh                           # optional sanity check
   ./register.sh YOUR_CODE http://<hub-ip>:3000
   ```
   Obtain the registration code from the HomeBrain UI -> Remote Devices -> Add Remote Device. `<hub-ip>` is your Jetson address.

6. **Start the service and enable auto-start**
   ```bash
   sudo systemctl enable homebrain-remote
   sudo systemctl start homebrain-remote
   sudo systemctl status homebrain-remote    # expect “active (running)”
   ```
   Check logs any time with `sudo journalctl -u homebrain-remote -f`.

7. **Confirm from the hub**
   Refresh the Remote Devices page; the Pi should display as “Online”. Repeat the copy/install steps for additional rooms, generating a new registration code each time.

8. **Verify on-device wake-word detection (OpenWakeWord)**
   - Update the remote device workspace to capture the latest dependencies (notably `node-webrtcvad` for voice activity detection). For best compatibility with hub‑trained models, install TFLite runtime so the remote prefers `.tflite` models and only falls back to ONNX when necessary:
   ```bash
   cd ~/homebrain-remote
   npm install
   npm install tflite-node --no-optional
   ```
   - Restart the remote service to load the OpenWakeWord engine and the new wake-word metadata:
     ```bash
     sudo systemctl restart homebrain-remote
     journalctl -u homebrain-remote -n 20
     ```
   - Custom wake words are generated on the hub after you submit them in the HomeBrain UI. The Raspberry Pi will download the trained model (preferring `.tflite` with automatic ONNX fallback) moments later—no Picovoice AccessKey required. If you see an ONNX error like “Invalid rank for input: audio”, ensure `tflite-node` is installed on the remote.

9. **Manual broadcast / testing tools**
   - Use “Push to devices” in Wake Word Manager to re-broadcast wake‑word config.
   - On the Voice Devices page, use “Push Config” per device to send the latest config to a single device, and “Play Ping” to send a test TTS message.
   - Follow the logs live with `journalctl -u homebrain-remote -f`, speak your wake word, and confirm `wake_word_detected` events appear. You should also see VAD (voice activity detection) messages showing when the listener is active.

---

---

## Step 16 - Configure SmartThings OAuth redirect (optional)
SmartThings now requires OAuth settings to be managed with the SmartThings CLI. Use the CLI to aim the HomeBrain automation app back at your HTTPS domain.

1. **Install or update the SmartThings CLI** (Node.js is already a prerequisite for HomeBrain):
   ```powershell
   npm install -g @smartthings/cli
   ```
   If the `smartthings` command is not on your `PATH`, prefix commands with `npx smartthings ...`.

2. **Create a SmartThings personal access token** with `apps:read` and `apps:write` scopes at <https://account.smartthings.com/tokens>. Copy the token—you will paste it into the PowerShell session in the next step.

3. **Run the following PowerShell script** (update `$appId` to your Automation App ID and `$redirect` to your HomeBrain domain). The script builds the JSON payload, updates the app via the CLI, and prints the new settings. Adjust `$scopes` if you want to limit access beyond the default superset.
   ```powershell
   # === EDIT THESE TWO ONLY ===
   $appId    = "YOUR-SMARTTHINGS-APP-ID"
   $redirect = "https://your-domain.com/api/smartthings/callback"

   # === Known-valid scope superset (matches current SmartThings behaviour) ===
   $scopes = @(
     "r:devices:$",
     "r:devices:*",
     "r:hubs:*",
     "r:installedapps",
     "r:locations:*",
     "r:rules:*",
     "r:scenes:*",
     "w:devices:$",
     "w:devices:*",
     "w:installedapps",
     "w:locations:*",
     "w:rules:*",
     "x:devices:$",
     "x:devices:*",
     "x:locations:*",
     "x:scenes:*",
     "r:security:locations:*:armstate"
   )

   # Set your SmartThings PAT for this session
   $env:SMARTTHINGS_AUTH_TOKEN = "PASTE-YOUR-PAT-HERE"

   # Build payload as JSON
   $payload = @{
     clientName   = "HomeBrain OAuth"
     scope        = $scopes
     redirectUris = @($redirect)
   }
   $outFile = "oauth-update-all.json"
   $payload | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $outFile

   Write-Host ">>> Sending this payload to SmartThings:"
   Get-Content $outFile | Write-Host

   # Update OAuth settings
   npx smartthings apps:oauth:update $appId --input $outFile --json

   # Verify the redirect URI and scopes
   npx smartthings apps:oauth $appId --json
   ```

4. After the redirect URI is updated, rerun **Connect to SmartThings** inside HomeBrain. The SmartThings authorization page should accept the redirect and return you to `/settings?smartthings=success` on your domain.
5. In HomeBrain, go to **Settings → Maintenance** and click **Force SmartThings Sync** to import devices. They will now appear on the Devices page grouped by their SmartThings rooms.

The scope list above enables HomeBrain to read (`r:security:locations:*:armstate`) and control (`x:locations:*`) the SmartThings Home Monitor arm state (`location.security.armState`) without creating virtual switch devices. `w:rules:*` is required so HomeBrain can create short-lived automation rules when the location security endpoint does not accept direct updates. SmartThings currently rejects the `x:security:locations:*:armstate` scope, so leave it out of the payload.

When you are finished, close the PowerShell session or run `Remove-Item Env:\SMARTTHINGS_AUTH_TOKEN` so the token is not left in memory.

---

## Step 17 - Ongoing maintenance
- Update code:
  ```bash
  cd ~/homebrain/HomeBrainv2
  git pull
  npm install

  cd server
  npm install
  cd ../client
  npm install
  npm run build    # skip if you only use the dev server
  cd ..
  sudo systemctl restart homebrain
  ```
- Check service status: `systemctl status homebrain`
- Tail logs: `journalctl -u homebrain -f`
- Backup MongoDB:
  ```bash
  mongodump --db HomeBrain --out ~/homebrain/backups/$(date +%Y%m%d)
  ```

---

## Troubleshooting quick checks
- API not responding: `sudo systemctl status homebrain`
- Detailed logs: `journalctl -u homebrain -n 100`
- MongoDB errors: `sudo tail -n 100 /var/log/mongodb/mongod.log`
- Port conflicts: `sudo netstat -tulpn | grep -E '3000|5173|443|12345'`
- Discovery diagnostics: `sudo tcpdump -i any udp port 12345`
- Reset admin: rerun `node server/scripts/createAdminUser.js --force --email ...`

---

## Useful repository paths
- Backend entry point: `server/server.js`
- Environment sample: `server/.env.example`
- Seed scripts and utilities: `server/scripts/`
- Client source: `client/src/`
- Client build artifacts: `client/dist/`
- Remote installer assets: `server/public/downloads/`
- Systemd unit created in this guide: `/etc/systemd/system/homebrain.service`

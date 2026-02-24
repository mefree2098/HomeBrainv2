# Jetson Setup Guide (Beginner Friendly)

This guide gets HomeBrain running on a Jetson Orin Nano from a fresh OS install.

## Before You Start

You need:
- Jetson Orin Nano with JetPack/Ubuntu installed
- Internet access on the Jetson
- A second device on the same network with a web browser

## Step 1: Update the Jetson

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl gnupg build-essential python3 python3-pip python3-venv pkg-config libcap2-bin
```

Expected result: command completes with no fatal errors.

## Step 2: Install Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Expected result: Node reports `v22.x` (or newer).

## Step 3: Install and Start MongoDB

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

Expected result: MongoDB status is `active (running)`.

## Step 4: Download HomeBrain

```bash
mkdir -p ~/homebrain
cd ~/homebrain
git clone https://github.com/mefree2098/HomeBrainv2.git
cd HomeBrainv2
```

## Step 5: Install HomeBrain Dependencies

```bash
npm install
npm install --prefix server
npm install --prefix client
```

Expected result: installs complete without fatal errors.

## Step 6: Configure Environment

```bash
cp server/.env.example server/.env
nano server/.env
```

Set these values:
- `DATABASE_URL=mongodb://localhost/HomeBrain`
- `JWT_SECRET=<random value>`
- `REFRESH_TOKEN_SECRET=<random value>`

Generate random values:

```bash
openssl rand -hex 32
```

## Step 7: Start HomeBrain

```bash
npm start
```

Expected result:
- API is on port `3000`
- UI is on port `5173`

Find your Jetson LAN IP:

```bash
hostname -I
```

Open:
- `http://<jetson-ip>:5173`

Create your first account when prompted.

## Step 8: Optional Production Auto-Start

If you want HomeBrain to run at boot, follow:
- [Deployment Runbook](../DEPLOYMENT.md)

## Next Step

After this guide, continue with:
- [Admin Guide](admin-guide.md)

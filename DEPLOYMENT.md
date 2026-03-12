# HomeBrain Deployment Guide

This is the production deployment guide for a HomeBrain hub.

## Choose Your Path

Jetson Orin Nano:

```bash
git clone <your-public-repo-url> HomeBrain
cd HomeBrain
bash scripts/install-jetson.sh
```

Other Ubuntu/Debian Linux host:

```bash
git clone <your-public-repo-url> HomeBrain
cd HomeBrain
bash scripts/install-linux.sh
```

That is the recommended path for almost everyone.

## What The Installer Does

The installer:

- installs system packages
- installs Node.js `22.x`
- installs MongoDB `6.0`
- creates `server/.env` from `server/.env.example`
- generates fresh local JWT secrets
- installs npm dependencies
- builds the production web app
- optionally bootstraps wake-word training dependencies
- creates and enables one systemd service: `homebrain`
- configures sudo so the HomeBrain UI can restart its own service during platform deploys

## First Login

After installation:

1. Find the hub IP address

```bash
hostname -I
```

2. Open HomeBrain:

```text
http://<hub-ip>:3000
```

3. Create the first account
4. Continue with [`docs/configuration.md`](docs/configuration.md)

## Ports

Production:

- `3000/tcp`: HomeBrain UI and API
- `12345/udp`: listener auto-discovery

Optional:

- `80/tcp`: ACME HTTP challenge or nginx reverse proxy
- `443/tcp`: built-in HTTPS or reverse proxy TLS

Development only:

- `5173/tcp`: Vite frontend dev server

## Service Management

Check status:

```bash
bash scripts/setup-services.sh status
```

Follow logs:

```bash
bash scripts/setup-services.sh logs follow
```

Restart:

```bash
bash scripts/setup-services.sh restart
```

Health check:

```bash
bash scripts/setup-services.sh health
```

## Updating HomeBrain Later

Recommended terminal path:

```bash
bash scripts/setup-services.sh update
```

Recommended UI path:

1. Open `Platform Deploy`
2. Choose a preset
3. Start the deploy job
4. Review the job log and health cards

## Environment File

The installer creates:

[`server/.env`](server/.env)

At minimum, verify:

- `DATABASE_URL`
- `JWT_SECRET`
- `REFRESH_TOKEN_SECRET`

Optional provider keys:

- `ELEVENLABS_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `STT_OPENAI_API_KEY`
- SmartThings / Ecobee OAuth values

Template file:

[`server/.env.example`](server/.env.example)

## HTTPS / Public Access

Simplest local deployment:

- use `http://<hub-ip>:3000` on your LAN

If you want a public domain and TLS:

1. Point DNS at the HomeBrain host
2. Ensure ports `80` and `443` are reachable
3. Either:
   use the HomeBrain `SSL` page
4. Or:
   run `bash scripts/setup-services.sh setup-nginx`
5. Then:
   run `bash scripts/setup-services.sh setup-ssl`

If you do not need public internet access, skip this.

## Hardware Notes

HomeBrain runs beyond Jetson now.

- Jetson is best when you want local Whisper and Ollama with GPU help
- Generic `amd64` and `arm64` Ubuntu/Debian hosts work for the main platform
- Remote listener devices are still best-tested on Raspberry Pi, but they are not hard-locked to it

## Beginner Checklist

If you know almost nothing about Linux, this is the shortest safe checklist:

1. Clone the repo
2. Run the correct install script
3. Open `http://<hub-ip>:3000`
4. Create an account
5. Add optional API keys in `Settings`
6. Add remote listener devices from `Voice Devices`
7. Use `Platform Deploy` or `scripts/setup-services.sh update` for future upgrades

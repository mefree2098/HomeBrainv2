# HomeBrain

HomeBrain is a local-first home automation and voice-assistant platform. It combines a Node/Express backend, a React web app, optional local AI services, remote room listeners, and an optional iOS companion app into one self-hosted system.

## What HomeBrain Includes

- A web dashboard for devices, scenes, automations, workflows, voice devices, profiles, settings, operations, SSL, Whisper, Ollama, and platform deploy
- Smart home integrations for SmartThings, Ecobee, INSTEON/ISY, and Logitech Harmony Hub
- Remote listener onboarding and fleet updates for room devices
- Wake-word training and distribution using OpenWakeWord plus Piper-generated training data
- Optional local speech-to-text with Whisper
- Optional local LLM support with Ollama
- An optional iOS app in [`HomeBrainApp`](HomeBrainApp)

## Supported Hardware

HomeBrain is no longer Jetson-only.

- Best-tested hub: Jetson Orin Nano
- Also supported as a hub: other always-on Ubuntu/Debian `amd64` or `arm64` machines
- Best-tested listener: Raspberry Pi 4/5
- Also supported as a listener: other Debian/Ubuntu-based Linux mini PCs or SBCs with a microphone and speaker

What changes by hardware:

- Core web app, automations, integrations, and remote listeners work on generic Linux hardware.
- Jetson is still the best target for local GPU workloads such as Whisper and Ollama.
- Non-Jetson hosts can still run HomeBrain; local AI workloads may simply run slower or fall back to CPU.

## Fastest Install

1. Clone your public repo to the hub machine.
2. Run one installer script.
3. Open HomeBrain in a browser on port `3000`.

Jetson hub:

```bash
git clone <your-public-repo-url> HomeBrain
cd HomeBrain
bash scripts/install-jetson.sh
```

Other Ubuntu/Debian Linux hub:

```bash
git clone <your-public-repo-url> HomeBrain
cd HomeBrain
bash scripts/install-linux.sh
```

After the installer finishes:

- Open `http://<hub-ip>:3000`
- Create your first account
- Continue with [`docs/configuration.md`](docs/configuration.md)

Important:

- Production HomeBrain serves both the UI and API from port `3000`
- Port `5173` is only used by the Vite dev server during local frontend development
- Ports `80` and `443` are only needed if you enable public HTTPS / ACME

## Documentation

- Beginner Jetson guide: [`docs/jetson-setup.md`](docs/jetson-setup.md)
- Full deployment guide: [`DEPLOYMENT.md`](DEPLOYMENT.md)
- Post-install configuration: [`docs/configuration.md`](docs/configuration.md)
- Admin workflow: [`docs/admin-guide.md`](docs/admin-guide.md)
- End-user voice usage: [`docs/user-guide.md`](docs/user-guide.md)
- Troubleshooting: [`docs/troubleshooting.md`](docs/troubleshooting.md)
- Wake-word setup: [`docs/wake-word-setup.md`](docs/wake-word-setup.md)
- Remote listener guide: [`remote-device/README.md`](remote-device/README.md)
- Docs index: [`docs/README.md`](docs/README.md)

## Remote Listener Flow

From the HomeBrain UI:

1. Open `Voice Devices`
2. Click `Add Remote Device`
3. Enter the room/device details
4. Copy the generated one-command installer
5. Run that command on the listener device

Raspberry Pi cloud-init onboarding is also available from the same dialog.

## Production Service Management

The installer writes one systemd service:

- `homebrain`

Useful commands:

```bash
bash scripts/setup-services.sh status
bash scripts/setup-services.sh logs follow
bash scripts/setup-services.sh health
bash scripts/setup-services.sh update
```

## Development

Install dependencies:

```bash
npm install
```

Run the backend:

```bash
npm run server
```

Run the frontend dev server:

```bash
npm run client
```

Development ports:

- API/backend: `http://localhost:3000`
- Vite frontend dev server: `http://localhost:5173`

## Public Repo Notes

This repository is set up so secrets should stay local:

- real runtime secrets belong in `server/.env`
- `server/.env` is gitignored
- build output and generated download packages are gitignored

One thing git itself can still expose is commit author metadata. If you want to hide older author email addresses before publishing the full history, that requires a separate git history rewrite.

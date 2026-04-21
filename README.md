![HomeBrain logo](client/public/homebrain-brand-64.png)

# HomeBrain

HomeBrain is a local-first home automation and voice-assistant platform. It combines a Node/Express backend, a React web app, optional local AI services, remote room listeners, and an optional iOS companion app into one self-hosted system.

## What HomeBrain Includes

- A web dashboard for devices, scenes, workflows, voice devices, profiles, settings, reverse proxy/domains, operations, SSL inventory, Whisper, Ollama, and platform deploy
- Smart home integrations for SmartThings, Ecobee, INSTEON/ISY, and Logitech Harmony Hub
- Remote listener onboarding and fleet updates for room devices
- Dedicated ESP32 wall panel APIs and firmware for rotary touchscreen room controllers
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
- Best-tested wall panel: ELECROW CrowPanel `2.1"` ESP32-S3 rotary display
- Same panel family, smaller sibling: ELECROW `1.28"` round rotary display using the same HomeBrain backend flow but requiring its own board profile

What changes by hardware:

- Core web app, workflow runtime, integrations, and remote listeners work on generic Linux hardware.
- Jetson is still the best target for local GPU workloads such as Whisper and Ollama.
- Non-Jetson hosts can still run HomeBrain; local AI workloads may simply run slower or fall back to CPU.
- Remote voice listeners are still Linux-based room devices.
- ESP32 wall panels connect over `Wi-Fi` to the HomeBrain `/api/panels` endpoints and use the firmware in [`embedded/elecrow-wall-panel`](embedded/elecrow-wall-panel).

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

- Production HomeBrain serves the UI/API on internal port `3000`
- Caddy is now the intended public edge on `80/443`
- Port `5173` is only used by the Vite dev server during local frontend development
- The installer uses committed npm lockfiles for deterministic clean deployments
- Browser sessions use `HttpOnly` cookies; tokens are not stored in browser `localStorage`
- The native iOS app remains a bearer-token client with a 365-day refresh-session lifetime

## Documentation

- Beginner Jetson guide: [`docs/jetson-setup.md`](docs/jetson-setup.md)
- Full deployment guide: [`DEPLOYMENT.md`](DEPLOYMENT.md)
- Post-install configuration: [`docs/configuration.md`](docs/configuration.md)
- ELECROW wall panel guide: [`docs/elecrow-wall-panel.md`](docs/elecrow-wall-panel.md)
- Ollama management: [`docs/ollama-management.md`](docs/ollama-management.md)
- Alexa setup guide: [`docs/alexa-admin-setup.md`](docs/alexa-admin-setup.md)
- Alexa integration overview: [`docs/alexa-integration.md`](docs/alexa-integration.md)
- Admin workflow: [`docs/admin-guide.md`](docs/admin-guide.md)
- End-user voice usage: [`docs/user-guide.md`](docs/user-guide.md)
- Troubleshooting: [`docs/troubleshooting.md`](docs/troubleshooting.md)
- Security checklist: [`docs/security.md`](docs/security.md)
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
After activation, listeners use a generated device token for config, heartbeat, wake-word asset, and TTS requests.

## Wall Panel Flow

The new wall panel path is separate from Linux listeners:

1. Install the hub and create the first admin account
2. Open `Settings -> Hardware Orbs` and create the orb
3. Flash [`embedded/elecrow-wall-panel`](embedded/elecrow-wall-panel)
4. Return to `Settings -> Hardware Orbs` and bind thermostat, searchable room-surface devices/scenes, media, and quiet actions

Full guide:

- [`docs/elecrow-wall-panel.md`](docs/elecrow-wall-panel.md)

## Production Service Management

The installer writes and enables:

- `homebrain`
- `caddy-api`

Useful commands:

```bash
bash scripts/setup-services.sh status
bash scripts/setup-services.sh logs follow
bash scripts/setup-services.sh health
bash scripts/setup-services.sh update
bash scripts/setup-services.sh refresh-privileges
```

Public HTTPS routing is managed from `Reverse Proxy / Domains` in the HomeBrain UI. The built-in `Platform Deploy` flow still deploys HomeBrain in place and keeps working behind Caddy because Caddy stays up while only the `homebrain` app service restarts.

## Ollama Runtime Ownership

On Linux and Jetson hosts, HomeBrain manages the Ollama runtime itself and uses a narrow privileged helper for install, update, and forced-stop operations. If an older host needs its Ollama helper or sudoers entry repaired, run:

```bash
bash scripts/setup-services.sh refresh-privileges
```

Details:

- [`docs/ollama-management.md`](docs/ollama-management.md)

## Development

Install dependencies:

```bash
npm ci
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
- local Codex/tool state, SQLite databases, certificates, and private keys are gitignored
- firmware defaults in `embedded/elecrow-wall-panel/include/HomeBrainPanelConfig.h` must remain placeholders in git

Before publishing or opening a pull request, run:

```bash
bash scripts/check-secrets.sh --history
```

GitHub Actions also runs the same check against the full checked-out history, plus dependency review, npm audit, and CodeQL. Enable GitHub secret scanning, push protection, Dependabot alerts/security updates, and code scanning in the repository settings before opening the repo.

If old commits contain unsafe local state such as `.codex-home`, clean it with the coordinated history rewrite in [`docs/security.md`](docs/security.md) before publishing. One thing git itself can still expose is commit author metadata; hiding older author email addresses also requires a separate git history rewrite.

## License

HomeBrain is licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).

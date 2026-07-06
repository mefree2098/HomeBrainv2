![HomeBrain logo](client/public/homebrain-brand-64.png)

# HomeBrain

HomeBrain is a local-first home automation and voice-assistant platform for a
self-hosted home hub. It combines a Node/Express backend, React dashboard,
local AI services, native iPhone and Apple Watch apps, remote room listeners,
direct-radio device control, and hardware wall-panel APIs.

The production target is a Linux or Jetson hub that serves the UI/API on port
`3000`, keeps Caddy on `80/443` for public HTTPS, and manages most operational
work from inside the HomeBrain admin UI.

## Latest Additions

The README was last refreshed before a large run of platform work. Current
HomeBrain now includes:

- Apple Watch companion app embedded in the iOS project, with iPhone session
  sync, configurable Security/Lights/Power/Weather sections, quick arm/disarm,
  room light control, and watchOS APNs registration for critical alerts.
- HomeBrain notifications across the web app, iOS, and watchOS: notification
  history, unread counts, normal/critical filters, clear/resolve flows,
  scrollable trays, badge fixes, and APNs push delivery for security-critical
  events.
- HomeBrain-to-HomeBrain notification forwarding for remote homes, including
  inbound receivers, outbound targets, token rotation, connection tests, and
  security-critical alert relay between trusted HomeBrain instances.
- Dynamic DNS management in Settings, currently backed by Azure DNS A-record
  updates with public-IP polling, configurable hostname, interval and TTL,
  manual "push now", last-check/last-push status, and visible error reporting.
- Expanded Security Center and alarm handling: per-mode sensor monitoring,
  native security actions, native siren selection, iOS siren picker, siren
  sound/volume controls, contact debounce, alarm trigger ordering, mute/audible
  recovery, and stronger Z-Wave siren fallback paths.
- Direct radio growth for Z-Wave, Zigbee, Matter, and Thread: native device
  onboarding, guided SmartThings migration, protocol-specific settings,
  device-catalog support, S2/DSK and legacy S0 pairing, failed-node cleanup,
  route recovery, interview repair, stronger shutdown durability, and updated
  `zwave-js`.
- Alexa improvements: managed device-provider configuration, a native HomeBrain
  command bridge, workflow announcement actions, command testing, session
  capture helper flow, CSP hardening, and route rate limiting.
- Integration and telemetry improvements for Ecobee account login, Govee indoor
  air sensors, RainMachine controls, Sense energy data, Tempest/weather data,
  SmartThings migration/category handling, and shared telemetry charting.
- iOS and dashboard polish: native typography parity with the web app, launch
  settings stability, iPhone dashboard sizing fixes, device-management polish,
  notification tray fixes, and restored compact HomeBrain header branding.
- Hub operations improvements: Platform Deploy, managed Caddy reverse
  proxy/domain controls, SSL inventory, Dynamic DNS, nightly SMB backups,
  managed Ollama repair flows, service singleton/restart hardening, Thread/OTBR
  preflight and flash status, and safer deployment/test isolation.
- Hardware and voice improvements: realtime hardware Orb state, OTA cancellation
  fixes, ELECROW rotary wall-panel APIs, remote voice listener provisioning,
  wake-word asset delivery, Whisper speech-to-text, Piper training audio, and
  Ollama-backed local LLM flows.

## Core Capabilities

- Web dashboard for devices, scenes, profiles, workflows, security, climate,
  telemetry, voice devices, notifications, deploys, domains, SSL, Ollama, and
  platform settings.
- Local-first automation with device/sensor triggers, workflow countdowns,
  manual triggers, profile-aware dashboard layouts, and native security actions.
- Direct device control through native Zigbee, Z-Wave, Matter/Thread, INSTEON,
  ISY, SmartThings, Ecobee, Harmony, RainMachine, Govee, Sense, and weather
  integrations.
- Local AI and voice stack with OpenWakeWord, Whisper, Piper, ElevenLabs voice
  options, Ollama model management, browser voice commands, and remote listener
  room devices.
- Native iPhone and Apple Watch companions for dashboard access, security,
  lights, weather/power summaries, push notifications, and long-lived mobile
  sessions.
- Hardware surfaces for ELECROW rotary wall panels and hardware Orbs through
  `/api/panels` plus firmware in
  [`embedded/elecrow-wall-panel`](embedded/elecrow-wall-panel).

## Supported Surfaces

- React web app for desktop, tablet, and mobile browsers.
- iOS app in [`HomeBrainApp`](HomeBrainApp).
- Apple Watch app source in [`HomeBrainWatch`](HomeBrainWatch), built as the
  embedded watch target inside the iOS app project.
- Remote voice listeners in [`remote-device`](remote-device).
- ELECROW wall-panel firmware in
  [`embedded/elecrow-wall-panel`](embedded/elecrow-wall-panel).
- Alexa broker and session-capture helper assets under the server assets and
  Alexa admin flows.

## Fastest Install

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

Then open `http://<hub-ip>:3000`, create the first admin account, and continue
with [`docs/configuration.md`](docs/configuration.md).

## Runtime Notes

- Production HomeBrain serves UI/API on internal port `3000`.
- Caddy is the intended public edge on `80/443`.
- Port `5173` is only for the Vite frontend development server.
- Browser sessions use `HttpOnly` cookies; tokens are not stored in browser
  `localStorage`.
- iOS and watchOS use bearer-token client sessions with a 365-day default
  refresh-session lifetime.
- Stateful workflow countdowns auto-cancel when the device or sensor trigger
  condition stops.
- Public HTTPS routing, SSL inventory, Dynamic DNS, and deploy actions are
  managed from the HomeBrain UI.

## Admin Flows

### Remote Listener Flow

1. Open `Voice Devices`.
2. Click `Add Remote Device`.
3. Enter room/device details.
4. Copy the generated one-command installer.
5. Run it on the Raspberry Pi or Linux listener host.

Listeners use generated device tokens for config, heartbeat, wake-word assets,
and TTS requests.

### Wall Panel Flow

1. Install the hub and create the first admin account.
2. Open `Settings -> Hardware Orbs`.
3. Flash [`embedded/elecrow-wall-panel`](embedded/elecrow-wall-panel).
4. Return to `Settings -> Hardware Orbs` to bind thermostats, searchable room
   devices, scenes, and actions.

See [`docs/elecrow-wall-panel.md`](docs/elecrow-wall-panel.md).

### Apple Watch Flow

1. Build and install the iOS app from `HomeBrainApp`.
2. Keep the watch app as the embedded watch target in the iOS project.
3. Sign in on iPhone, then use the watch app to sync the HomeBrain session.
4. Configure watch sections and light devices from the web app Watch settings.

See [`HomeBrainWatch/README.md`](HomeBrainWatch/README.md).

## Production Service Management

The installer creates managed services for HomeBrain, its public edge, the local
MQTT broker, and Pi-hole. Use the setup helper for day-to-day operations:

```bash
bash scripts/setup-services.sh status
bash scripts/setup-services.sh logs follow
bash scripts/setup-services.sh health
bash scripts/setup-services.sh update
bash scripts/setup-services.sh refresh-privileges
bash scripts/setup-services.sh setup-platform-services
```

Public HTTPS routing is managed from `Reverse Proxy / Domains` in the HomeBrain
UI. The built-in `Platform Deploy` flow deploys HomeBrain while keeping Caddy
up, so public routing can survive an app service restart.

The MQTT broker is loopback-only by default. HomeBrain publishes platform events,
device update batches, retained per-device state, and availability messages when
the broker is reachable. Caddy, Mosquitto, and Pi-hole can be checked and updated
from Platform Deploy with an opt-in delayed auto-update policy.

## Ollama Runtime Ownership

On Linux and Jetson hosts, HomeBrain manages the Ollama runtime and uses a
narrow privileged helper for install, update, and forced-stop operations. If an
older host needs its Ollama helper or sudoers entry repaired, run:

```bash
bash scripts/setup-services.sh refresh-privileges
```

Details: [`docs/ollama-management.md`](docs/ollama-management.md).

## Documentation

- Beginner Jetson setup: [`docs/jetson-setup.md`](docs/jetson-setup.md)
- Full deployment: [`DEPLOYMENT.md`](DEPLOYMENT.md)
- Configuration: [`docs/configuration.md`](docs/configuration.md)
- Admin workflow: [`docs/admin-guide.md`](docs/admin-guide.md)
- End-user voice: [`docs/user-guide.md`](docs/user-guide.md)
- Alexa setup: [`docs/alexa-admin-setup.md`](docs/alexa-admin-setup.md)
- Alexa integration: [`docs/alexa-integration.md`](docs/alexa-integration.md)
- Direct Zigbee/Z-Wave migration:
  [`docs/direct-zigbee-zwave-migration.md`](docs/direct-zigbee-zwave-migration.md)
- ELECROW wall panel: [`docs/elecrow-wall-panel.md`](docs/elecrow-wall-panel.md)
- Ollama: [`docs/ollama-management.md`](docs/ollama-management.md)
- Wake word setup: [`docs/wake-word-setup.md`](docs/wake-word-setup.md)
- Troubleshooting: [`docs/troubleshooting.md`](docs/troubleshooting.md)
- Security checklist: [`docs/security.md`](docs/security.md)

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

Before publishing or opening a pull request, run:

```bash
bash scripts/check-secrets.sh --history
```

## Public Repo Notes

- Real runtime secrets belong in `server/.env`.
- `server/.env` is gitignored.
- Build output and generated download packages are gitignored.
- Local Codex/tool state, SQLite databases, certificates, and private keys are
  gitignored.
- Firmware defaults in
  `embedded/elecrow-wall-panel/include/HomeBrainPanelConfig.h` must remain
  placeholders in git.

GitHub Actions runs the same secret-history check against full checked-out
history, plus dependency review, npm audit, and CodeQL. Enable GitHub secret
scanning, push protection, Dependabot alerts/security updates, and code scanning
in repository settings before opening the repo.

If old commits contain unsafe local state such as `.codex-home`, clean it with a
coordinated history rewrite in [`docs/security.md`](docs/security.md) before
publishing. Git commit author metadata can also expose email addresses; hiding
older author email addresses requires a separate git history rewrite.

## License

HomeBrain is licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).

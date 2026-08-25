![HomeBrain logo](client/public/homebrain-brand-64.png)

# HomeBrain

HomeBrain is a local-first home automation, voice, AI, telemetry, and hub-operations platform. It combines a React web app, a Node/Express API, MongoDB, native device radios, local AI services, iPhone and Apple Watch apps, remote room listeners, wall panels, robotics, and managed infrastructure in one self-hosted system.

The primary production target is a Jetson Orin Nano Super running Ubuntu through JetPack. The same installer also supports apt-based Ubuntu/Debian hosts on ARM64 and x86_64, while Jetson remains the best-tested choice for local GPU workloads such as Whisper and Ollama.

## What HomeBrain Includes

| Area | Current capabilities |
| --- | --- |
| Home control | Devices, rooms, device groups, scenes, favorites, dashboard views, realtime state, color and color-temperature control, locks, sensors, sirens, thermostats, media activities, and irrigation |
| Automation | Visual Workflow Studio, AI-assisted generation, schedules, device and sensor triggers, hold times, cooldowns, delays, multi-target actions, announcements, execution history, cancellation guards, and manual runs |
| Security | Per-mode sensor monitoring, arm/disarm actions, siren selection, sound and volume controls, contact debounce, native alarm triggers, critical notifications, and remote-home alert forwarding |
| Voice and AI | OpenWakeWord, local or LAN Whisper STT, Piper, ElevenLabs, S2 Pro/local TTS providers, browser voice commands, remote listeners, Ollama model/chat management, OpenAI, Anthropic, and Codex-backed LLM routing |
| Device integrations | Native Zigbee, Z-Wave, Matter/Thread, SmartThings, Ecobee, INSTEON/ISY, Logitech Harmony, Alexa, Tempest, Govee indoor air, Sense Energy, and RainMachine |
| Data | Weather and indoor-air history, Sense power telemetry, irrigation history, a unified Data Platform, time-scale controls, event feeds, resource monitoring, and retained MQTT device state |
| People and clients | First-user admin bootstrap, admin/standard/read-only accounts, per-user platform access, Voice Profiles, iPhone, Apple Watch, browser, API, and OIDC clients |
| Physical surfaces | Raspberry Pi/Linux voice listeners, ELECROW ESP32-S3 rotary wall panels, hardware Orbs, and Reachy Mini Wireless companion integration |
| Operations | systemd service management, Caddy domains, TLS inventory, Azure Dynamic DNS, Platform Deploy, managed service updates, Pi-hole, Mosquitto, disaster-recovery backups, SMB scheduling, restore jobs, health checks, and live logs |
| Agent integrations | OpenAI WebMCP site tools for the live signed-in web app, downloadable HomeBrain Codex live skill, managed Codex CLI, model-aware Codex reasoning levels, OpenClaw MCP/skill bundle, mutation audit events, and HomeBrain OIDC identity services |

## Current Highlights

- **OpenAI WebMCP site tools:** ChatGPT Work and Codex can use the signed-in HomeBrain page directly for typed overview, device, room, scene, workflow, weather, notification, security-status, navigation, and safe control actions. Tools follow the active account's HomeBrain access, admin routes, and read-only policy, return verification data, and do not expose direct unlock or disarm tools.
- **Reachy Mini Wireless:** first-class enrollment, authenticated voice transport, semantic motion and expression controls, privacy switches, snapshots, workflow actions, managed companion-package updates, safe stop/rollback behavior, and simulator-backed tests. Physical hardware acceptance testing is still required before unattended use.
- **Managed Platform Services:** install, repair, inspect, and update Caddy, Mosquitto, Pi-hole, the Codex CLI, and Reachy companion packages. Each service has visible status, update checks, manual actions, and optional delayed auto-update policy.
- **Rooms and account permissions:** dedicated room management, room-aware device assignment, admin/standard/read-only users, HomeBrain/Axiom platform access, session management, and admin-created accounts after initial registration closes.
- **Direct-radio administration:** Zigbee energy/channel diagnostics, coordinator recovery, pairing windows with live device assignment, sleepy-device interview repair, Z-Wave S2/DSK and S0 support, lock PINs, route recovery, failed-node cleanup, repeaters, siren controls, and device catalogs.
- **Remote voice lifecycle:** one-time onboarding, durable device identities, token rotation, heartbeat and update status, audio-device probing, wake-word asset delivery, command pre-roll, Whisper/TTS routing, and Raspberry Pi-friendly installation.
- **Alexa control plane:** native command bridge, account linking, device/scene/workflow exposure, custom skill support, session capture helper, command tests, proactive state events, broker recovery, and state-sync load protection.
- **Telemetry and climate:** Tempest forecast fusion, Govee indoor-air history, Sense realtime and cost data, RainMachine programs/zones/restrictions, shared charts, configurable time ranges, and the unified Data Platform.
- **Maintenance and recovery:** reproducible lockfile installs, Node runtime compatibility checks, ARM64 MongoDB and Ollama memory guards, nightly SMB backups with retention, downloadable disaster-recovery archives, restore helpers, service recovery, and deployment audit logs.
- **LAN and HTTPS browser support:** production assets and authentication work from direct LAN addresses such as `http://192.168.1.41:3000`, while proxied HTTPS requests continue to receive secure session cookies.

## Supported Surfaces

- React web app for desktop, tablet, and mobile browsers
- OpenAI WebMCP site tools in ChatGPT's built-in browser, using the same live page and signed-in session
- Native iPhone app in [`HomeBrainApp`](HomeBrainApp)
- Embedded Apple Watch companion in [`HomeBrainWatch`](HomeBrainWatch)
- Linux/Raspberry Pi remote listeners in [`remote-device`](remote-device)
- ELECROW rotary wall-panel firmware in [`embedded/elecrow-wall-panel`](embedded/elecrow-wall-panel)
- Reachy Mini Wireless companion package in [`reachy-homebrain-app`](reachy-homebrain-app)
- Alexa broker and Lambda handlers in [`broker`](broker) and [`lambda`](lambda)
- Codex live-integration skill in [`codex/skills/homebrain-live`](codex/skills/homebrain-live)

## Production Requirements

Before installing, have:

- a Jetson Orin Nano Super with a supported Ubuntu-based JetPack release, or another apt-based Ubuntu/Debian ARM64/x86_64 host
- a regular user account with working `sudo` access; do not run the installer as `root`
- working internet and DNS access
- enough free storage for MongoDB, npm dependencies, speech models, Ollama models, logs, and backups
- a browser on the same LAN for first-time setup

The production installer supplies Node.js 22, MongoDB 6.0, application dependencies, and system services. The repository also supports Node `^20.19.0` or `>=22.13.0` for development; Node 22 is the intended production runtime.

## Quick Install

### Jetson Orin Nano Super

Run these commands as your normal sudo-capable user:

```bash
git clone https://github.com/mefree2098/HomeBrainv2.git
cd HomeBrainv2
bash scripts/install-jetson.sh
```

### Other Ubuntu/Debian Hosts

```bash
git clone https://github.com/mefree2098/HomeBrainv2.git
cd HomeBrainv2
bash scripts/install-linux.sh
```

The installation can take a while on a new system. It installs OS packages, Node, MongoDB, npm dependencies, native modules, the production web build, voice dependencies, and several managed services before starting HomeBrain.

### What the Installer Configures

The installer:

- validates that it is running on an apt-based host as a non-root sudo user
- installs Node.js 22.x and MongoDB 6.0
- creates `server/.env` and generates unique JWT/session secrets
- installs dependencies from committed lockfiles and rebuilds native modules when needed
- creates the production React build
- installs OpenWakeWord/Piper training dependencies unless explicitly disabled
- grants the HomeBrain service account `dialout` serial access and available `plugdev` USB access for Zigbee, Z-Wave, and Thread adapters
- leaves INSTEON unconfigured so an unused integration cannot claim a Zigbee adapter that Linux assigned to `/dev/ttyUSB0`
- creates and enables the `homebrain` systemd service
- installs Caddy as the `caddy-api` public edge on ports `80/443`
- installs a loopback-only Mosquitto broker as `homebrain-mqtt`
- installs Pi-hole and moves its web interface to `8081/8444` so it can coexist with Caddy
- writes narrow privileged helpers for deploys, restore operations, Ollama, OTBR, and Jetson Thread/kernel management
- writes ARM64 resource guards for Ollama and MongoDB
- bootstraps reverse-proxy, OIDC client, and optional default-admin database state
- starts HomeBrain and checks `http://localhost:3000/ping`

Pi-hole downloads use the official installer endpoint with an official GitHub fallback. If both sources are unreachable, the installer stops instead of executing an incomplete download.

## First Login

At the end of installation, use the exact URL printed by the installer. You can also find the current address with:

```bash
hostname -I
```

Open:

```text
http://<hub-ip>:3000
```

There is **no default username or password**.

1. Choose **Create account** on a new installation.
2. The first successfully registered account becomes an active administrator.
3. Public registration closes as soon as that first account exists.
4. Sign in with the exact email and password you just created.
5. Additional accounts must be created by an administrator from **Users**.

The login-page note saying that new accounts are created by an administrator describes additional accounts; it does not mean the first account failed. If the installer was given `HOMEBRAIN_DEFAULT_ADMIN_PASSWORD`, use the configured bootstrap email/password instead of registering another account.

Browser authentication uses `HttpOnly` cookies. Cookie security follows the request protocol automatically: direct LAN HTTP remains usable, and HTTPS through a trusted proxy receives `Secure` cookies. `COOKIE_SECURE=true` or `false` can explicitly override that behavior when required by a custom proxy.

## Recommended First-Run Checklist

1. Open `http://<hub-ip>:3000/ping` and confirm it returns a healthy response.
2. Create the first administrator and save the credentials in a password manager.
3. Review **Settings → General** and **Settings → System Resources**.
4. Open **Platform Services** and confirm Caddy, MQTT, and Pi-hole status.
5. Configure only the integrations you intend to use under **Settings → Integrations**.
6. Add rooms before assigning large numbers of devices, listeners, or panels.
7. Create a downloadable disaster-recovery backup under **Settings → Maintenance**.
8. Configure and test an SMB target before enabling automatic nightly backups.
9. Keep the hub LAN-only until local login, devices, backups, and updates are stable.
10. If public access is required, follow [`DEPLOYMENT.md`](DEPLOYMENT.md) and validate Caddy in staging before production ACME.

## Day-to-Day Service Management

Run service commands from the repository directory:

```bash
cd /home/<user>/HomeBrainv2
```

| Task | Command |
| --- | --- |
| Show all primary service status | `bash scripts/setup-services.sh status` |
| Run local port, service, disk, memory, and MongoDB checks | `bash scripts/setup-services.sh health` |
| Follow HomeBrain logs | `bash scripts/setup-services.sh logs follow` |
| Show HomeBrain, MongoDB, Caddy, MQTT, or Pi-hole logs | `bash scripts/setup-services.sh logs homebrain` (replace target as needed) |
| Start HomeBrain and MongoDB | `bash scripts/setup-services.sh start` |
| Stop HomeBrain | `bash scripts/setup-services.sh stop` |
| Restart HomeBrain | `bash scripts/setup-services.sh restart` |
| Pull, install, build, restart, verify, and re-bootstrap state | `bash scripts/setup-services.sh update` |
| Repair hardware groups, privileged helpers, and sudoers | `bash scripts/setup-services.sh refresh-privileges` |
| Install/refresh Caddy, MQTT, and Pi-hole | `bash scripts/setup-services.sh setup-platform-services` |
| Install/repair the global Codex CLI | `bash scripts/setup-services.sh setup-codex` |
| Check a managed-service update | `bash scripts/setup-services.sh check-platform-service-updates caddy` |
| Apply a managed-service update | `bash scripts/setup-services.sh update-platform-service caddy` |

The managed-service update target can be `caddy`, `mqtt`, `pihole`, or `codex`.

The UI provides the same operational areas:

- **Platform Deploy** for repository pull/build/restart jobs and deploy logs
- **Platform Services** for service inventory, repair, update policies, MQTT, Pi-hole, Codex, and Reachy companion status
- **Operations** for event rates, errors, warnings, live events, and engine logs
- **Reverse Proxy** for Caddy route validation and application
- **SSL Certificates** for inventory, Let's Encrypt, uploads, and CSR generation
- **Settings → Maintenance** for configuration export, full backups, SMB scheduling, and disaster-recovery restore

## Networking and Ports

| Port | Purpose | Default exposure |
| --- | --- | --- |
| `3000/tcp` | HomeBrain production web UI and API | LAN/all interfaces unless `HOMEBRAIN_BIND_HOST` changes it |
| `80/tcp` | Caddy public HTTP ingress | Host network |
| `443/tcp` | Caddy public HTTPS ingress | Host network |
| `53/tcp`, `53/udp` | Pi-hole DNS | Host network |
| `1883/tcp` | HomeBrain Mosquitto broker | Loopback only (`127.0.0.1`) |
| `8081/tcp`, `8444/tcp` | Pi-hole web/API | Host network |
| `12345/udp` | Remote-listener discovery | LAN |
| `5173/tcp` | Vite development server | Development only |

The MQTT bridge defaults to `auto`: when the broker is reachable, HomeBrain publishes platform events, device-update batches, retained per-device state, and availability. If MQTT is unavailable, the main API continues to operate.

### LAN-Only Operation

For a private deployment, use:

```text
http://<hub-ip>:3000
```

No public domain or certificate is required. Leave `HOMEBRAIN_BIND_HOST` unset or set it to `0.0.0.0` if direct LAN access should remain available.

### Public HTTPS Operation

Caddy is the supported public edge. HomeBrain itself remains the internal upstream on port `3000`.

At minimum, configure `server/.env` with real values:

```dotenv
HOMEBRAIN_PUBLIC_BASE_URL=https://homebrain.example.com
HOMEBRAIN_EXPECTED_PUBLIC_IP=<your-public-ip>
COOKIE_SECURE=true
CORS_ALLOWED_ORIGINS=https://homebrain.example.com
```

Then restart HomeBrain, point DNS at the hub, forward `80/443`, and configure the actual hostnames under **Reverse Proxy**. Any `example.com` routes created during bootstrap are templates and must be replaced or disabled unless they are truly your domains.

Use ACME staging first, run route validation, apply Caddy, and switch to production only after DNS and upstream checks pass. See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the complete flow.

Azure-backed Dynamic DNS is available under **Settings → Dynamic DNS**, including polling, hostname/TTL configuration, manual push, and last-check/last-push status.

## Configuration

The installer creates the private runtime file:

```text
server/.env
```

It is gitignored. Use [`server/.env.example`](server/.env.example) as the reference for:

- database and authentication secrets
- browser/native session lifetimes
- public URL, CORS, bind host, and cookie behavior
- MongoDB and MQTT resource controls
- cloud API keys and local provider endpoints
- APNs, SmartThings, Ecobee, Caddy, Pi-hole, and public-IP settings
- optional default-admin bootstrap

Most day-to-day settings live in the web UI:

- **General** — platform behavior and defaults
- **Voice & Audio** — STT, TTS, wake words, voices, and sensitivity
- **Integrations** — modules, Alexa, Codex Skill, OpenClaw, Sense, Tempest, Govee, RainMachine, device integrations, Ecobee, keys, and LLM routing
- **Hardware Orbs** — wall-panel provisioning and room bindings
- **Command Control** — serialized device-command coordination and safety
- **Security** — alarm modes, sensors, sirens, and notifications
- **System Resources** — host resource monitoring and controls
- **Dynamic DNS** — Azure DNS-backed public address updates
- **Maintenance** — integration maintenance, exports, backups, SMB scheduling, and restore

Read [`docs/configuration.md`](docs/configuration.md) for the guided post-install sequence.

## Feature Guide

### Devices, Rooms, Scenes, and Workflows

- **Devices** provides realtime control, details, source/capability metadata, room views, Alexa exposure, batteries, and native-radio diagnostics.
- **Rooms** centralizes room identity and device assignment across web, iOS, Watch, listeners, and panels.
- **Device Groups** creates controllable logical groups.
- **Scenes** stores reusable grouped device states with fast activation and independent on/off behavior.
- **Workflow Studio** is the source of truth for automations. It supports schedules, manual/voice triggers, device/sensor/security conditions, hold times, cooldowns, delays, scenes, announcements, Reachy actions, and execution logs.
- State-triggered workflows use false-to-true edges and cancellation guards so delayed routines stop when the original condition no longer matches.

### Native Radios and Device Integrations

HomeBrain supports native Zigbee and Z-Wave onboarding plus Matter/Thread management. Current administration includes pairing, interview state, migrations from SmartThings, network diagnostics, route recovery, failed-node removal, security classes, lock codes, sirens, sensors, repeaters, catalog metadata, and protocol-specific repair tools.

Cloud and local integrations include SmartThings, Ecobee, INSTEON/ISY, Harmony, Alexa, Tempest, Govee Indoor Air, Sense Energy, and RainMachine. The integration-module catalog shows each provider's device, telemetry, workflow, alert, and control capabilities.

### Voice, Speech, and LLMs

- Remote Linux listeners handle room microphones, speakers, wake-word detection, streaming command audio, and TTS playback.
- OpenWakeWord assets and Piper training tools are managed by the hub.
- Whisper can run locally on the Jetson or through an allowed private-network provider.
- TTS can use Piper/local services, ElevenLabs, or S2 Pro-compatible private-network endpoints.
- Ollama Management installs/updates the host binary, owns one managed runtime, downloads models, provides chat, shows logs, and exposes resource use.
- LLM routing supports local providers, OpenAI, Anthropic, and Codex with configurable priority/fallback and model-aware reasoning effort.
- Voice Profiles attach personalities, prompts, voices, and wake words to different assistants or family contexts.

### Weather, Energy, Irrigation, and Data

- **Weather** fuses forecast data with Tempest station state and Govee indoor-air history.
- **Sense Energy** shows realtime whole-home/device load, solar/net/always-on data, cost estimates, and timelines.
- **RainMachine** manages programs, zones, restrictions, runtime queues, daily statistics, and watering history.
- **Data Platform** inventories telemetry sources, samples, storage, retention, health, and query/chart activity across integrations.

### Notifications and Remote Homes

Notifications are shared across web, iPhone, and Apple Watch with history, unread counts, severity filters, clear/resolve actions, and APNs delivery. Security-critical events can be forwarded between trusted HomeBrain instances using dedicated inbound/outbound tokens and visible connection tests.

### Users, Sessions, and Identity

Administrators can create admin, standard, or read-only users; enable HomeBrain/Axiom platform access; activate/deactivate accounts; and manage sessions. Browser sessions use cookies, while native/API clients can use long-lived bearer sessions according to client policy.

HomeBrain also acts as an OIDC provider with discovery, JWKS, authorization, token, and user-info endpoints. Managed bootstrap state registers the built-in Axiom and AgentOps clients plus an inert, optional S2 Voice Studio public client.

### Codex and OpenClaw

- The React app registers role-aware [WebMCP site tools](https://learn.chatgpt.com/docs/webmcp) through the current `document.modelContext` browser API. No separate MCP server, API key, plugin, or HomeBrain token is required for in-page use.
- **Settings → Integrations → Codex Skill** rotates a dedicated HomeBrain token and downloads a ready-to-install [`homebrain-live`](codex/skills/homebrain-live) skill bundle for live health, events, resources, and deploy operations.
- **Platform Services** can install or update the official global `@openai/codex` CLI.
- **Settings → Integrations → OpenClaw** publishes a protected streamable-HTTP MCP endpoint, rotates an admin-grade integration token, and downloads a HomeBrain skill/config bundle.
- OpenClaw mutations are attributed and recorded in **Operations**.

#### WebMCP Site Tools

Open HomeBrain in ChatGPT's built-in browser, sign in normally, and enable **Site tools** in the browser permissions. ChatGPT Work or Codex can then discover the tools registered by that page:

| Tools | Capability |
| --- | --- |
| `homebrain_get_overview`, `homebrain_list_devices`, `homebrain_get_device`, `homebrain_list_rooms` | Inspect live household and device state without exposing raw integration payloads |
| `homebrain_list_scenes`, `homebrain_list_workflows`, `homebrain_get_weather` | Inspect saved routines, forecast, Tempest, and indoor-air state |
| `homebrain_list_notifications`, `homebrain_get_security_status` | Inspect alerts and security state without clearing, arming, disarming, unlocking, or bypassing |
| `homebrain_open_page` | Move the current tab to a role-appropriate HomeBrain page so the person and agent see the same interface |
| `homebrain_control_device` | Run a narrow device command and read the device back for verification; direct unlock and other safety-sensitive controls are rejected |
| `homebrain_activate_scene`, `homebrain_deactivate_scene`, `homebrain_run_workflow` | Run exact saved scene/workflow IDs after the browser's normal action review |

Tools exist only while an authenticated HomeBrain page is open. Logging out, losing HomeBrain platform access, or closing the page unregisters them. Read-only accounts receive read and navigation tools but no backend mutation tools; the server still authenticates and authorizes every request. Device, scene, and workflow actions are attributed to `webmcp` in HomeBrain command/runtime telemetry. Browsers without WebMCP continue to use the normal HomeBrain interface with no extra setup.

The implementation follows OpenAI's site-tools guidance and the current [WebMCP proposal](https://webmachinelearning.github.io/webmcp/): narrow closed schemas, explicit side-effect descriptions, signed-in application logic, abort-driven registration cleanup, safe output projections, and post-action verification.

See [`docs/openclaw/jetson-setup.md`](docs/openclaw/jetson-setup.md) for deployment details.

## Companion and Room Hardware

### Remote Voice Listener

1. Open **Voice Devices**.
2. Select **Add Remote Device** and assign its room.
3. Copy the generated one-command installer.
4. Run it on the Raspberry Pi or Debian/Ubuntu listener.
5. Verify audio devices, wake-word status, heartbeat, and update state in HomeBrain.

Full guide: [`remote-device/README.md`](remote-device/README.md).

### ELECROW Rotary Wall Panel

1. Open **Settings → Hardware Orbs**.
2. Create the Orb and save its setup packet.
3. Flash [`embedded/elecrow-wall-panel`](embedded/elecrow-wall-panel).
4. Return to Hardware Orbs to bind room devices, thermostat, scenes, security actions, and Harmony activities.

Full guide: [`docs/elecrow-wall-panel.md`](docs/elecrow-wall-panel.md).

### Reachy Mini Wireless

1. Open **Reachy Mini** and create an enrollment.
2. Install the companion package from [`reachy-homebrain-app`](reachy-homebrain-app) on the Reachy CM4.
3. Activate the one-time credential and confirm the authenticated connection.
4. Configure wake word, audio, perception, privacy, motion permissions, and app ownership.
5. Test emergency stop and safe motion in a clear area before enabling workflows.

Implementation and safety contract: [`docs/reachy-mini-wireless-integration.md`](docs/reachy-mini-wireless-integration.md). Companion guide: [`reachy-homebrain-app/README.md`](reachy-homebrain-app/README.md).

### iPhone and Apple Watch

Build and install the iOS project from [`HomeBrainApp`](HomeBrainApp). Sign in on iPhone, allow the embedded Watch app to sync the session, then configure Watch Security, Lights, Power, and Weather sections from HomeBrain.

Watch guide: [`HomeBrainWatch/README.md`](HomeBrainWatch/README.md).

## Backup and Recovery

**Settings → Maintenance** provides:

- JSON configuration export
- downloadable full disaster-recovery archives
- SMB connection testing and manual backup upload
- optional automatic nightly SMB backups with retention
- backup job status and interrupted-job recovery
- archive upload, validation, restore helper execution, and HomeBrain restart after restore

A full backup includes MongoDB data and persisted HomeBrain files required for recovery. Keep at least one recent copy outside the HomeBrain host and test the SMB destination before relying on scheduled backups.

## Troubleshooting Quick Checks

### Blank page or asset `403`

Update to the current `main` build and hard-refresh the browser:

```bash
bash scripts/setup-services.sh update
```

Then use `Ctrl+F5` or clear only the cached files for the HomeBrain origin.

### Signup worked but login returns to the login page

The first user is already the admin. Update the server so direct LAN HTTP uses request-aware cookies, hard-refresh, and sign in with the original signup email/password. Do not try to register a second first user.

### Pi-hole installer cannot resolve its host

Check the host's DNS and retry the isolated service setup:

```bash
getent hosts install.pi-hole.net
getent hosts raw.githubusercontent.com
bash scripts/setup-services.sh setup-pihole
```

### Service is running but the UI is unavailable

```bash
bash scripts/setup-services.sh status
bash scripts/setup-services.sh health
bash scripts/setup-services.sh logs follow
curl -i http://localhost:3000/ping
```

More cases: [`docs/troubleshooting.md`](docs/troubleshooting.md).

## Development

Install the root toolchain and the main JavaScript workspaces:

```bash
npm ci
npm run install:all
```

Run the backend and frontend in separate terminals:

```bash
npm run server
```

```bash
npm run client
```

Development URLs:

- backend/API: `http://localhost:3000`
- Vite frontend: `http://localhost:5173`

Useful verification commands:

```bash
npm --prefix client run lint
npm --prefix client run build
npm --prefix server test
npm --prefix broker test
npm --prefix lambda test
bash scripts/check-secrets.sh --history
```

The root `npm test` script is intentionally not the aggregate suite; run the workspace commands above. Reachy companion development has its own Python/ruff/pytest workflow in [`reachy-homebrain-app/README.md`](reachy-homebrain-app/README.md).

## Repository Layout

| Path | Purpose |
| --- | --- |
| [`client`](client) | React/Vite web application |
| [`server`](server) | Express API, MongoDB models, integrations, services, WebSockets, and production UI host |
| [`broker`](broker) | Managed Alexa broker and event gateway |
| [`lambda`](lambda) | Alexa Lambda handlers and tests |
| [`remote-device`](remote-device) | Linux/Raspberry Pi room-listener runtime and installer |
| [`HomeBrainApp`](HomeBrainApp) | Native iPhone application and embedded Watch target |
| [`HomeBrainWatch`](HomeBrainWatch) | Apple Watch source and documentation |
| [`embedded/elecrow-wall-panel`](embedded/elecrow-wall-panel) | ESP32-S3 rotary wall-panel firmware |
| [`reachy-homebrain-app`](reachy-homebrain-app) | Reachy Mini Wireless Python companion app |
| [`codex/skills/homebrain-live`](codex/skills/homebrain-live) | Downloadable Codex live-operations skill |
| [`scripts`](scripts) | Install, update, service, privilege, restore, Ollama, OTBR, and Jetson helpers |
| [`docs`](docs) | Deployment, configuration, integration, security, and troubleshooting guides |

## Documentation Index

- Documentation home: [`docs/README.md`](docs/README.md)
- Full production deployment and Caddy: [`DEPLOYMENT.md`](DEPLOYMENT.md)
- Beginner Jetson setup: [`docs/jetson-setup.md`](docs/jetson-setup.md)
- Post-install configuration: [`docs/configuration.md`](docs/configuration.md)
- Admin/operator guide: [`docs/admin-guide.md`](docs/admin-guide.md)
- User/voice guide: [`docs/user-guide.md`](docs/user-guide.md)
- Troubleshooting: [`docs/troubleshooting.md`](docs/troubleshooting.md)
- Security checklist: [`docs/security.md`](docs/security.md)
- Alexa administration: [`docs/alexa-admin-setup.md`](docs/alexa-admin-setup.md)
- Alexa architecture/integration: [`docs/alexa-integration.md`](docs/alexa-integration.md)
- Direct Zigbee/Z-Wave migration: [`docs/direct-zigbee-zwave-migration.md`](docs/direct-zigbee-zwave-migration.md)
- ELECROW wall panel: [`docs/elecrow-wall-panel.md`](docs/elecrow-wall-panel.md)
- Reachy Mini Wireless: [`docs/reachy-mini-wireless-integration.md`](docs/reachy-mini-wireless-integration.md)
- Ollama management: [`docs/ollama-management.md`](docs/ollama-management.md)
- Wake-word setup: [`docs/wake-word-setup.md`](docs/wake-word-setup.md)
- INSTEON service: [`docs/insteon-service.md`](docs/insteon-service.md)
- OpenClaw on Jetson: [`docs/openclaw/jetson-setup.md`](docs/openclaw/jetson-setup.md)

## Security and Public Repository Hygiene

- Keep real secrets only in `server/.env` or the appropriate host secret store.
- Never commit browser/admin tokens, cloud keys, APNs keys, certificates, MongoDB exports, backup archives, generated listener credentials, or Reachy device tokens.
- Use strong unique passwords and keep at least one active administrator.
- Prefer LAN-only access unless public HTTPS is necessary.
- For public deployment, use exact CORS origins, secure cookies, Caddy validation, production certificates, and restricted router/firewall rules.
- Run `bash scripts/check-secrets.sh --history` before every public push.
- Enable GitHub secret scanning, push protection, Dependabot, dependency review, npm audit, and CodeQL.

The CI workflows run secret-history scanning, dependency review, npm audits for each JavaScript workspace, and CodeQL. See [`docs/security.md`](docs/security.md) for the complete checklist and history-cleanup guidance.

## License

HomeBrain is licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).

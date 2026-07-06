# HomeBrain Deployment Guide

This is the production deployment guide for a HomeBrain hub with Caddy as the public edge.

## Choose Your Path

These instructions are valid for a Jetson Orin Nano Super running a supported Ubuntu-based JetPack release. The Jetson path is just the Linux installer with `HOMEBRAIN_HOST_PROFILE=jetson`, so the same Caddy/MongoDB/systemd flow applies on ARM64.

Jetson Orin Nano:

```bash
git clone <your-public-repo-url> HomeBrain
cd HomeBrain
bash scripts/install-jetson.sh
```

Other Ubuntu/Debian host:

```bash
git clone <your-public-repo-url> HomeBrain
cd HomeBrain
bash scripts/install-linux.sh
```

## What The Installer Does

The installer now:

- installs system packages
- installs Node.js `22.x`
- installs MongoDB `6.0`
- creates `server/.env` from `server/.env.example`
- backfills required keys into an existing `server/.env` on upgrade installs
- generates fresh local JWT secrets
- defaults web auth to HttpOnly cookies with 1-hour access cookies and 30-day session cookies
- keeps native iOS app refresh sessions at 365 days by default
- backfills deterministic npm lockfile installs with `npm ci`
- sets `CADDY_ADMIN_URL=http://127.0.0.1:2019`
- defaults `ACME_ENV` to `production` for already-public deployments and to `staging` for first-time local/testing installs
- stops `homebrain` first if it is already running on the host
- installs npm dependencies
- ensures native server modules are rebuilt for the active Node.js runtime after a Node major-version change
- repairs `client/dist` ownership before the production build if an earlier deploy left it root-owned
- builds the production web app
- optionally bootstraps wake-word training dependencies
- creates and enables `homebrain`
- installs and enables `caddy-api`
- installs and enables the loopback-only `homebrain-mqtt` Mosquitto broker
- installs and configures Pi-hole with its web UI moved away from Caddy-owned `80/443`
- seeds the reverse-proxy database state for Caddy management
- seeds the HomeBrain OIDC identity state for the default Axiom SSO client
- configures the HomeBrain Ollama helper, sudoers entry, and service override so the UI can manage Ollama updates and host-side service restarts safely

HomeBrain no longer owns public `80/443`. Caddy is the intended public ingress.

## First Login

After installation:

1. Find the hub IP address.

```bash
hostname -I
```

2. Open HomeBrain locally.

```text
http://<hub-ip>:3000
```

3. Create the first account.
4. Continue with [`docs/configuration.md`](docs/configuration.md).

## Optional Room Hardware After Hub Install

Once the hub is live, the two main room-hardware paths are:

- Linux voice listeners: [`remote-device/README.md`](remote-device/README.md)
- ELECROW ESP32 wall panels: [`docs/elecrow-wall-panel.md`](docs/elecrow-wall-panel.md)

Use the Linux listener path for microphones, speakers, and wake-word audio. Use the ELECROW wall panel path for always-on touch and rotary room control over `Wi-Fi`.

## Ports

Production:

- `3000/tcp`: internal HomeBrain UI/API upstream
- `53/tcp` and `53/udp`: Pi-hole DNS when installed
- `1883/tcp`: local MQTT broker on `127.0.0.1` by default
- `8081/tcp` and `8444/tcp`: Pi-hole web/API ports by default
- `80/tcp`: Caddy public HTTP ingress
- `443/tcp`: Caddy public HTTPS ingress
- `12345/udp`: listener auto-discovery

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

Show Caddy logs only:

```bash
bash scripts/setup-services.sh logs caddy
```

Show MQTT broker logs only:

```bash
bash scripts/setup-services.sh logs mqtt
```

Show Pi-hole logs only:

```bash
bash scripts/setup-services.sh logs pihole
```

Restart HomeBrain:

```bash
bash scripts/setup-services.sh restart
```

Re-run Caddy bootstrap if needed:

```bash
bash scripts/setup-services.sh setup-caddy
```

Install or refresh platform services:

```bash
bash scripts/setup-services.sh setup-platform-services
```

Health check:

```bash
bash scripts/setup-services.sh health
```

Repair HomeBrain's privileged helper access for Ollama management:

```bash
bash scripts/setup-services.sh refresh-privileges
```

## MQTT Platform Broker

HomeBrain can run a local Mosquitto broker as `homebrain-mqtt`. The default listener is `127.0.0.1:1883`, which is meant for HomeBrain itself and hub-side helpers, not unauthenticated LAN clients.

The backend MQTT bridge runs in `auto` mode by default. When the broker is reachable, HomeBrain publishes platform events to `homebrain/events/{category}/{type}`, device update batches to `homebrain/devices/update`, retained per-device state to `homebrain/devices/{id}/state`, and availability to `homebrain/status`. When the broker is absent, the bridge stays idle and the API continues normally.

To expose MQTT beyond loopback, set `HOMEBRAIN_MQTT_BIND_ADDRESS` and provide `HOMEBRAIN_MQTT_PASSWORD_FILE` before running `setup-mqtt`; the setup script refuses anonymous non-loopback listeners.

## Managed Third-Party Services

HomeBrain manages Caddy, Mosquitto, and Pi-hole as first-class platform services. A normal Platform Deploy now runs `setup-platform-services` before the backend restart, so production pushes refresh the host service definitions and install missing platform dependencies.

The Platform Deploy page exposes install/repair, update checks, manual updates, and policy automation for each service. The default policy checks weekly and treats an update as eligible for automatic deployment only after it has been visible for 30 days. Automatic deployment is opt-in per service.

Pi-hole is installed through the official Pi-hole installer and updated with `pihole -up`. Caddy and Mosquitto are updated through the host package manager. The setup script keeps Pi-hole's web server on `8081/8444` by default so Caddy continues to own public `80/443`.

## Ollama Management

On Linux and Jetson hosts, HomeBrain treats Ollama as a host-level dependency with a HomeBrain-managed runtime. The UI uses a narrow privileged helper to install, update, and stop Ollama when needed, then starts a single managed `ollama serve` process again.

HomeBrain deploys restart the HomeBrain service only. They do not restart the host `ollama.service` by default, because doing so hands runtime ownership back to systemd. The generated `homebrain.service` uses `KillMode=process`, and backend startup recovers managed Ollama when the persisted state says it was running before HomeBrain restarted.

Important paths:

- helper: `/usr/local/lib/homebrain/ollama-host-control.sh`
- sudoers: `/etc/sudoers.d/homebrain-deploy`
- systemd override: `/etc/systemd/system/homebrain.service.d/99-ollama-helper.conf`

If a host was installed before this flow existed, run `bash scripts/setup-services.sh refresh-privileges` once, then restart `homebrain`.

More detail:

- [`docs/ollama-management.md`](docs/ollama-management.md)

## Environment File

The installer creates:

[`server/.env`](server/.env)

At minimum, verify:

- `DATABASE_URL`
- `JWT_SECRET`
- `REFRESH_TOKEN_SECRET`
- `AUTH_ACCESS_TOKEN_TTL`
- `AUTH_REFRESH_TOKEN_TTL`
- `AUTH_SESSION_MAX_AGE_DAYS`
- `AUTH_IOS_SESSION_MAX_AGE_DAYS`
- `CADDY_ADMIN_URL`
- `ACME_ENV`

Recommended additions for public deployment:

```dotenv
HOMEBRAIN_PUBLIC_BASE_URL=https://example.com
HOMEBRAIN_EXPECTED_PUBLIC_IP=<your-public-ip>
COOKIE_SECURE=true
CORS_ALLOWED_ORIGINS=https://example.com,https://www.example.com
```

Optional if you want HomeBrain accessible only through Caddy:

```dotenv
HOMEBRAIN_BIND_HOST=127.0.0.1
```

If you still want direct LAN access on `:3000`, leave `HOMEBRAIN_BIND_HOST` unset or `0.0.0.0`.

Template file:

[`server/.env.example`](server/.env.example)

Security checklist:

[`docs/security.md`](docs/security.md)

The repository now also advertises its runtime preference directly:

- [`.nvmrc`](.nvmrc) prefers Node `22`
- root, server, and client `package.json` files declare `^20.19.0 || >=22.12.0`

For Jetson deployment, Node `22.x` is the intended production runtime.

If a Node `22` upgrade leaves `serialport` unable to load, HomeBrain will now warn but continue. That module is only needed for Node-side direct serial access; the Insteon service can still use its local Python serial-bridge fallback when configured.

## Public Domain Deployment

This is the recommended production path for the current HomeBrain domain set and future Axiom routing.

### 1. Confirm the services

On the hub:

```bash
bash scripts/setup-services.sh status
```

You want both `homebrain` and `caddy-api` running.

### 2. Set the public origin and expected public IP

Edit [`server/.env`](server/.env):

```dotenv
HOMEBRAIN_PUBLIC_BASE_URL=https://example.com
HOMEBRAIN_EXPECTED_PUBLIC_IP=<your-public-ip>
```

Then restart HomeBrain:

```bash
bash scripts/setup-services.sh restart
```

### 3. Point DNS at the hub

Create or update DNS records so they resolve to the same public IP:

- `example.com`
- `www.example.com`
- `mail.example.com`

That `mail.example.com` record is the future Axiom hostname. It can exist now even before the Axiom service is live.

### 4. Forward the router

Forward public `80` and `443` from your router/firewall to the HomeBrain host.

### 5. Open the reverse-proxy control plane

Open HomeBrain locally at `http://<hub-ip>:3000`, then go to:

`Reverse Proxy / Domains`

In the settings card:

- leave `Caddy Admin URL` as `http://127.0.0.1:2019`
- keep `ACME mode` at `staging` first
- set `Expected Public IPv4` to your public IP
- leave `On-Demand TLS` disabled unless you explicitly need it

Save the settings.

### 6. Review the seeded public routes

The installer and deploy paths now seed these routes automatically if they do not already exist. In `Reverse Proxy / Domains`, confirm these records are present and enabled:

1. `example.com`
   - Platform: `HomeBrain`
   - Upstream: `http://127.0.0.1:3000`
   - Health check: `/ping`
   - TLS mode: `automatic`
   - Enabled: `true`

2. `www.example.com`
   - Platform: `HomeBrain`
   - Upstream: `http://127.0.0.1:3000`
   - Health check: `/ping`
   - TLS mode: `automatic`
   - Enabled: `true`

Run `Validate`.

If validation reports DNS or upstream issues, fix those first.

### 7. Apply the Caddy config in staging

Still in `Reverse Proxy / Domains`:

- click `Apply Caddy Config`
- wait for the Caddy status to remain reachable
- browse to `https://example.com`

Because `ACME_ENV=staging`, you should expect staging certificates during this test phase.
Browsers will typically show a certificate warning or a `Not Secure` label in this mode. That is expected until you switch to production ACME.

### 8. Switch to production ACME

When staging validation looks correct:

- change `ACME mode` to `production`
- confirm the mode switch
- save settings
- click `Validate`
- click `Apply Caddy Config` again

After that, `https://example.com` and `https://www.example.com` should serve through Caddy with production certificates. HomeBrain now pins production ACME issuance to the Let's Encrypt production directory explicitly.

## Adding Axiom Later

HomeBrain is now ready for Axiom routing even though the Axiom app is not part of this repository.

When the Axiom service exists, run it on an internal upstream such as:

```text
127.0.0.1:3001
```

Then create or enable this route in `Reverse Proxy / Domains`:

- Hostname: `mail.example.com`
- Platform: `Axiom`
- Upstream: `http://127.0.0.1:3001`
- Health check: `/`
- TLS mode: `automatic`
- Enabled: `true`

Run `Validate`, then `Apply Caddy Config`.

At that point:

- `https://example.com` routes to HomeBrain
- `https://mail.example.com` routes to Axiom

Both can share the same public IP because Caddy routes by hostname.

## Axiom SSO Through HomeBrain

HomeBrain now acts as an OIDC provider for Axiom. The installer, `setup-services.sh update`, and `Platform Deploy` all seed the default Axiom client automatically.

Use these Axiom OIDC settings:

- Issuer: `https://example.com`
- Discovery document: `https://example.com/.well-known/openid-configuration`
- Client ID: `homebrain-axiom`
- Redirect URI: `https://mail.example.com/api/identity/homebrain/callback`
- Grant type: `authorization_code`
- Client auth: public client with PKCE
- PKCE: required
- Requested scopes: `openid profile email`

What this gives you:

- if you are already signed into HomeBrain in the browser, Axiom can bounce through HomeBrain and come back authenticated without a second password prompt
- if you go directly to Axiom while signed out, HomeBrain will send you to its login page, then resume the authorization request automatically after sign-in

HomeBrain exposes these OIDC endpoints:

- `/.well-known/openid-configuration`
- `/.well-known/jwks.json`
- `/oauth/authorize`
- `/oauth/token`
- `/oauth/userinfo`

## Updating HomeBrain Later

Terminal path:

```bash
bash scripts/setup-services.sh update
```

That update path now waits for HomeBrain to come back and re-seeds both reverse-proxy state and OIDC identity state if new managed fields or clients were added by the release.
It also uses the committed npm lockfiles through `npm ci`, so dependency resolution stays reproducible across clean Jetson, Raspberry Pi, generic Linux, and cloud deployments.

UI path:

1. Open `Platform Deploy`
2. Choose a preset
3. Start the deploy job
4. Review the job log and health cards

`Platform Deploy` still works after these Caddy changes because it still restarts only the `homebrain` app service. During the deploy job it now bootstraps both reverse-proxy state and OIDC identity state before the final restart, while Caddy remains in front and keeps owning public ingress.

## Beginner Checklist

1. Run the installer.
2. Confirm `homebrain` and `caddy-api` are running.
3. Open `http://<hub-ip>:3000`.
4. Create an account.
5. Set `HOMEBRAIN_PUBLIC_BASE_URL` and your expected public IP.
6. Point DNS for `example.com`, `www.example.com`, and `mail.example.com`.
7. Forward router ports `80` and `443`.
8. Configure routes from `Reverse Proxy / Domains`.
9. Validate and apply in `staging`.
10. Switch ACME to `production`, re-apply, and verify HTTPS.

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
- seeds the reverse-proxy database state for Caddy management
- seeds the HomeBrain OIDC identity state for the default Axiom SSO client
- configures sudo so the HomeBrain UI can restart `homebrain` during Platform Deploy

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

## Ports

Production:

- `3000/tcp`: internal HomeBrain UI/API upstream
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

Restart HomeBrain:

```bash
bash scripts/setup-services.sh restart
```

Re-run Caddy bootstrap if needed:

```bash
bash scripts/setup-services.sh setup-caddy
```

Health check:

```bash
bash scripts/setup-services.sh health
```

## Environment File

The installer creates:

[`server/.env`](server/.env)

At minimum, verify:

- `DATABASE_URL`
- `JWT_SECRET`
- `REFRESH_TOKEN_SECRET`
- `CADDY_ADMIN_URL`
- `ACME_ENV`

Recommended additions for public deployment:

```dotenv
HOMEBRAIN_PUBLIC_BASE_URL=https://freestonefamily.com
HOMEBRAIN_EXPECTED_PUBLIC_IP=<your-public-ip>
```

Optional if you want HomeBrain accessible only through Caddy:

```dotenv
HOMEBRAIN_BIND_HOST=127.0.0.1
```

If you still want direct LAN access on `:3000`, leave `HOMEBRAIN_BIND_HOST` unset or `0.0.0.0`.

Template file:

[`server/.env.example`](server/.env.example)

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
HOMEBRAIN_PUBLIC_BASE_URL=https://freestonefamily.com
HOMEBRAIN_EXPECTED_PUBLIC_IP=<your-public-ip>
```

Then restart HomeBrain:

```bash
bash scripts/setup-services.sh restart
```

### 3. Point DNS at the hub

Create or update DNS records so they resolve to the same public IP:

- `freestonefamily.com`
- `www.freestonefamily.com`
- `mail.freestonefamily.com`

That `mail.freestonefamily.com` record is the future Axiom hostname. It can exist now even before the Axiom service is live.

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

1. `freestonefamily.com`
   - Platform: `HomeBrain`
   - Upstream: `http://127.0.0.1:3000`
   - Health check: `/ping`
   - TLS mode: `automatic`
   - Enabled: `true`

2. `www.freestonefamily.com`
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
- browse to `https://freestonefamily.com`

Because `ACME_ENV=staging`, you should expect staging certificates during this test phase.
Browsers will typically show a certificate warning or a `Not Secure` label in this mode. That is expected until you switch to production ACME.

### 8. Switch to production ACME

When staging validation looks correct:

- change `ACME mode` to `production`
- confirm the mode switch
- save settings
- click `Validate`
- click `Apply Caddy Config` again

After that, `https://freestonefamily.com` and `https://www.freestonefamily.com` should serve through Caddy with production certificates. HomeBrain now pins production ACME issuance to the Let's Encrypt production directory explicitly.

## Adding Axiom Later

HomeBrain is now ready for Axiom routing even though the Axiom app is not part of this repository.

When the Axiom service exists, run it on an internal upstream such as:

```text
127.0.0.1:3001
```

Then create or enable this route in `Reverse Proxy / Domains`:

- Hostname: `mail.freestonefamily.com`
- Platform: `Axiom`
- Upstream: `http://127.0.0.1:3001`
- Health check: `/`
- TLS mode: `automatic`
- Enabled: `true`

Run `Validate`, then `Apply Caddy Config`.

At that point:

- `https://freestonefamily.com` routes to HomeBrain
- `https://mail.freestonefamily.com` routes to Axiom

Both can share the same public IP because Caddy routes by hostname.

## Axiom SSO Through HomeBrain

HomeBrain now acts as an OIDC provider for Axiom. The installer, `setup-services.sh update`, and `Platform Deploy` all seed the default Axiom client automatically.

Use these Axiom OIDC settings:

- Issuer: `https://freestonefamily.com`
- Discovery document: `https://freestonefamily.com/.well-known/openid-configuration`
- Client ID: `homebrain-axiom`
- Redirect URI: `https://mail.freestonefamily.com/api/identity/homebrain/callback`
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
6. Point DNS for `freestonefamily.com`, `www.freestonefamily.com`, and `mail.freestonefamily.com`.
7. Forward router ports `80` and `443`.
8. Configure routes from `Reverse Proxy / Domains`.
9. Validate and apply in `staging`.
10. Switch ACME to `production`, re-apply, and verify HTTPS.

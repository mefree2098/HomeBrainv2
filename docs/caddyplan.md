HomeBrain Reverse Proxy + Caddy Management Implementation Brief
Service-Agnostic, Non-Docker-Required Architecture

Implementation Tracker

Status: Implemented in repo
Started: 2026-03-12
Last updated: 2026-03-12

Current implementation status

- [x] Baseline reviewed against the current codebase.
- [x] Reverse-proxy persistence model and audit trail implemented.
- [x] Caddy admin API integration and config apply flow implemented.
- [x] Route validation and certificate policy endpoints implemented.
- [x] Reverse-proxy admin UI implemented.
- [x] HomeBrain runtime moved fully behind Caddy-managed public ingress.
- [x] Native-service deployment/install flow updated for Caddy.
- [x] Installer/update/deploy paths now bootstrap reverse-proxy database state automatically.
- [x] Tests, lint, and deployment documentation completed.

Known constraints / assumptions

- Axiom is not present in this repository. This implementation will make HomeBrain platform-ready for Axiom by supporting a managed route for `mail.freestonefamily.com` and a generic upstream target such as `127.0.0.1:3001`, but it cannot validate a real Axiom process from this repo alone.
- Existing HomeBrain code still owns public `80/443` today via the ACME helper and optional built-in HTTPS listener. Those code paths must be removed or disabled as part of this work so Caddy becomes the only public ingress.
- Existing SSL management remains in the product today; the reverse-proxy implementation will preserve manual certificate visibility where practical, but Caddy automatic TLS becomes the primary production path.

Progress log

- 2026-03-12: Reviewed the current runtime, deploy scripts, SSL handling, and plan requirements. Confirmed the current blockers are built-in `:80/:443` ownership, lack of persisted reverse-proxy route state, lack of Caddy admin integration, and missing admin UI for route management.
- 2026-03-12: Added reverse-proxy persistence models (`ReverseProxyRoute`, `ReverseProxySettings`, `ReverseProxyAuditLog`), Caddy admin integration, route validation, certificate status probing, audit logging, and the internal on-demand TLS ask endpoint.
- 2026-03-12: Added the admin UI at `Reverse Proxy / Domains` for route CRUD, validation, config apply, ACME mode control, certificate status, and on-demand approval visibility.
- 2026-03-12: Removed HomeBrain ownership of public `80/443` from the runtime, updated listener/bootstrap URL generation for proxy-aware `https`/`wss`, and added Caddy-native install/service management to the deployment scripts.
- 2026-03-12: Updated deployment/runtime docs and verified the repo with `server` tests, client build, and client lint.
- 2026-03-12: Updated the Linux installer to stop an already-running `homebrain` service before install/update work, added automatic reverse-proxy database bootstrap/seeding for installer, `setup-services.sh update`, and `Platform Deploy`, and kept the default HomeBrain/Axiom route seeds idempotent so existing settings are preserved.
- 2026-03-12: Hardened the installer after a real Jetson run exposed a root-owned `client/dist` build failure. The installer now normalizes `client/dist` ownership before the Vite build, and the systemd service installer now prefers the system Node binary path so a stale user-level Node in `PATH` does not leak into production service configuration.
- 2026-03-12: Hardened the installer again after a Jetson restart exposed an upgrade-path `.env` gap. Existing `server/.env` files are now backfilled with required keys such as `DATABASE_URL`, `CADDY_ADMIN_URL`, and `ACME_ENV`, and failed service starts now print recent `journalctl` output for faster diagnosis.
- 2026-03-12: Removed the duplicate `ReverseProxyRoute.hostname` index warning and hardened the service/install scripts against stale legacy HomeBrain Node listeners. Health checks now flag when public `80/443` are owned by `node` instead of Caddy, and install/update/stop flows now kill orphaned HomeBrain processes discovered outside systemd.
- 2026-03-12: Clarified the staging certificate experience in both the reverse-proxy UI and the deployment guide. HomeBrain now warns directly that browser SSL errors are expected while `ACME_ENV` remains `staging`, which removes ambiguity during the final production cutover step.
- 2026-03-12: Corrected the upgrade-path ACME defaulting behavior so already-public deployments no longer silently fall back to staging when `ACME_ENV` is absent. Reverse-proxy settings now infer `production` when a real public base URL is present, while first-time local/test installs still default to staging.

Implemented artifacts

1. Backend
   - New models for managed routes, reverse-proxy settings, and audit logs.
   - New reverse-proxy admin routes under `/api/admin/reverse-proxy/*`.
   - New internal Caddy policy endpoint at `/internal/caddy/can-issue-cert`.
   - Caddyfile generation plus `/adapt` and `/load` admin API integration.
   - DNS, public-IP, edge-port, upstream, and served-certificate validation snapshots.
2. Runtime / deploy
   - HomeBrain no longer starts its own ACME helper or HTTPS listener.
   - `scripts/setup-services.sh setup-caddy` installs and runs Caddy as the native edge service with `--resume`.
   - Install scripts now stop a running `homebrain` service before deployment work, bootstrap Caddy automatically, seed reverse-proxy database state automatically, and no longer require HomeBrain to hold privileged bind capability.
3. UI
   - New `Reverse Proxy / Domains` page for route management and config apply.
   - `Platform Deploy` health now includes reverse-proxy/Caddy admin reachability.
   - SSL management text now clearly marks the old certificate page as legacy inventory.

Next steps

1. Apply the documented deployment steps on the actual Jetson or Linux host with live DNS and router forwarding.
2. Keep `mail.freestonefamily.com` in DNS now; the route will already be seeded disabled, so only enable it once the Axiom service is actually present on its internal upstream.

Objective

Refactor the current HomeBrain deployment model so that:

HomeBrain no longer binds directly to public ports 80/443

Caddy becomes the single public ingress layer on the Jetson Orin Nano Super

HomeBrain manages Caddy from its own UI/API

Let’s Encrypt works automatically for:

freestonefamily.com / HomeBrain

mail.freestonefamily.com / Axiom

any additional platforms added later

The architecture must be deployment-method agnostic

supported upstreams may be:

native systemd services

standalone processes

Docker containers

internal services on another private host

Docker support is allowed, but must not be required

The key point is that HomeBrain should manage routing definitions, not container infrastructure. We are building a control plane, not a shrine to whichever deployment religion won the internet that week.

Core Architectural Decision
Caddy is the only public edge service

Caddy should:

bind to public 80/443

terminate TLS

automatically obtain and renew certificates

reverse proxy traffic based on hostname

expose its admin API only on localhost or another protected local-only interface

be managed programmatically by HomeBrain

HomeBrain becomes the control plane

HomeBrain should manage:

domains / hostnames

route definitions

upstream host and port

upstream protocol

route enable/disable state

certificate eligibility

route health / validation status

future dynamic domain support

Applications become internal upstreams

Examples:

HomeBrain → 127.0.0.1:3000

Axiom → 127.0.0.1:3001

or

HomeBrain → 192.168.1.10:3000

Axiom → 127.0.0.1:3001

or

HomeBrain → Docker service name if Docker is used later

The reverse proxy layer must treat all of these the same way: as upstream targets.

End State
Public request flow

https://freestonefamily.com → Caddy → HomeBrain

https://mail.freestonefamily.com → Caddy → Axiom

https://whatever.freestonefamily.com → Caddy → future platform

All of these may share the same public IP because Caddy routes using the request hostname.

Hard Requirements
1. HomeBrain must stop owning 80/443
Current problem

HomeBrain currently owns public ports 80/443 directly.

Required change

HomeBrain must be reconfigured to bind only to an internal upstream port, for example:

127.0.0.1:3000

Axiom should also bind only to an internal port, for example:

127.0.0.1:3001

Rules

only Caddy binds public 80/443

no app should publicly bind 80/443 except Caddy

app services should prefer loopback/private binding

deployment method must not matter

2. Caddy must be installable as a native service
Preferred default

Install and run Caddy as a native systemd service on the Jetson.

Optional later

Caddy may also be supported in Docker, but that must be optional.

Why

You explicitly do not want Docker to be a hard requirement. Good. That way the proxy layer doesn’t force every future service into a container just because someone got overexcited after discovering docker ps.

3. HomeBrain must manage Caddy via the Caddy admin API
Do not implement this by:

rewriting arbitrary files manually

shelling out to ad hoc scripts for every change

restarting Caddy as the normal workflow

Implement this by:

using Caddy’s admin API from the HomeBrain backend

generating desired config from database state

validating before apply

applying config changes programmatically

logging and auditing all changes

Required HomeBrain backend modules

Suggested service/modules:

reverseProxyService

caddyAdminService

domainRoutingService

certificatePolicyService

Suggested routes:

GET /api/admin/reverse-proxy/routes

POST /api/admin/reverse-proxy/routes

PUT /api/admin/reverse-proxy/routes/:id

DELETE /api/admin/reverse-proxy/routes/:id

POST /api/admin/reverse-proxy/apply

GET /api/admin/reverse-proxy/status

GET /api/admin/reverse-proxy/certificates

GET /internal/caddy/can-issue-cert?domain=...

Service-Agnostic Data Model

HomeBrain must store route definitions generically.

Suggested table: managed_routes

Fields:

id

hostname

platform_key

display_name

upstream_protocol (http / https)

upstream_host

upstream_port

enabled

tls_mode (automatic, internal, manual, on_demand)

allow_on_demand_tls

health_check_path

websocket_support

strip_prefix

created_by

updated_by

created_at

updated_at

last_apply_status

last_apply_error

certificate_status

notes

Constraints

hostname must be unique

hostnames must validate as legal DNS names

no route may point to public 80/443 as its upstream unless explicitly allowed

no duplicate hostname collisions

no wildcard or catch-all behavior without explicit admin approval

What HomeBrain UI Must Manage
New admin section

Infrastructure → Reverse Proxy / Domains

Required views
1. Route List

Columns:

hostname

platform

upstream

TLS mode

enabled

certificate status

last applied status

2. Create / Edit Route

Fields:

hostname

display name

platform key

upstream protocol

upstream host

upstream port

websocket support

TLS mode

enable route

notes

3. Config Apply / Sync Screen

preview desired config

preview diff if possible

validate

apply

show errors if failed

4. Certificate Status View

hostname

automatic TLS eligible

DNS ready

cert status

renewal state

last error

5. Future Dynamic Domain Approval View

approved domains

pending domains

ownership verified

on-demand TLS allowed yes/no

Caddy Config Strategy
Source of truth

HomeBrain database is the source of truth.

Derived artifact

Caddy config is generated from HomeBrain route records.

Management model

HomeBrain renders a full desired config payload and applies it through the Caddy admin API.

This means:

DB is authoritative

Caddy is execution layer

UI changes update DB

apply action regenerates Caddy config

Base Caddy config requirements

Must include:

global options

local-only admin API

persistent certificate/state storage

logging

automatic HTTPS

HTTP to HTTPS redirect

reverse proxy site definitions

optional future on-demand TLS support

Upstream Design Rules

HomeBrain must support upstreams in a generic way.

Valid upstream examples
Native service

http://127.0.0.1:3000

Another local app

http://127.0.0.1:3001

Another private host on LAN

http://192.168.1.50:8080

Optional container target

http://axiom-web:3000

The system must not assume containers exist.

Required upstream behavior

preserve host headers where appropriate

support websocket proxying when enabled

support health-check validation

support future upstream auth or header injection if needed later

Let’s Encrypt / TLS Design
Known domains

For domains already known and stored in HomeBrain, such as:

freestonefamily.com

www.freestonefamily.com

mail.freestonefamily.com

use normal automatic HTTPS site config in Caddy.

Future dynamic domains

If later you want customer-managed or dynamically added custom domains, support On-Demand TLS, but only behind a HomeBrain approval check.

Required ask endpoint

Implement:

GET /internal/caddy/can-issue-cert?domain=example.com

Must return success only if:

the domain exists in approved route records

the route is enabled

the domain passed ownership validation or was admin-approved

the hostname is not blocked

TLS issuance is allowed by policy

Otherwise

Return non-success so Caddy refuses certificate issuance.

Important

On-demand TLS must be:

disabled by default

only enabled when the approval system is fully implemented

Because “let’s automatically issue certs for whatever hostname shows up” is the sort of sentence that sounds efficient right up until it becomes evidence.

DNS / Validation Requirements

Before automatic TLS is enabled for a route, HomeBrain should validate:

hostname resolves in DNS

hostname points to expected public IP

router is forwarding 80/443 to the Jetson

Caddy is reachable on those ports

route is enabled

upstream is reachable internally

Add UI validation checks

Before allowing “Apply” or “Enable TLS”:

show DNS status

show public IP match status

show upstream connectivity result

show any blocking errors

Let’s Encrypt Environment Support

Add environment/config support for:

ACME_ENV=staging|production

Requirements

staging must be usable for testing

production must be explicit

UI should display current ACME mode

production mode should require confirmation if switching from staging

Native-Service-First Deployment Design
Preferred deployment model
Caddy

installed directly on host

managed by systemd

owns public 80/443

HomeBrain

native service under systemd, or current existing method

binds to localhost/private port only

Axiom

native service under systemd or equivalent

binds to localhost/private port only

Optional later

Any of the above may be Dockerized later, but the routing layer must not depend on that.

Suggested systemd Model
Example services

caddy.service

homebrain.service

axiom.service

Binding model

Caddy → :80, :443

HomeBrain → 127.0.0.1:3000

Axiom → 127.0.0.1:3001

This should be the primary documented architecture.

Required Security Controls
Caddy admin API

bind to localhost only

never expose publicly

only HomeBrain backend may call it

HomeBrain admin UI

Only privileged admins can:

add routes

edit routes

remove routes

enable TLS

approve future custom domains

Audit requirements

Every route change must log:

who changed it

what changed

when it changed

whether apply succeeded

whether certificate issuance status changed

Safe defaults

routes disabled until validated

HTTPS redirect enabled by default

no public admin API exposure

on-demand TLS disabled by default

no catch-all wildcard behavior by default

Required HomeBrain Backend Behavior
Route lifecycle
Create route

validate hostname

validate upstream

store record disabled by default or with validation status

allow admin to enable only after checks pass

Apply config

read current DB state

render desired Caddy config

validate config payload

apply through Caddy admin API

record success/failure

expose result to UI

Delete route

soft-delete or confirm delete

remove from desired config

apply safely

keep audit trail

Required Acceptance Criteria

This work is complete only when:

HomeBrain no longer binds public 80/443

Caddy is the only public ingress service

HomeBrain runs successfully on an internal upstream port

Axiom runs successfully on an internal upstream port

freestonefamily.com routes correctly to HomeBrain over HTTPS

mail.freestonefamily.com routes correctly to Axiom over HTTPS

HomeBrain admins can manage routes from UI

HomeBrain manages Caddy through its API rather than by brittle manual file hacks

The system works whether the upstream app is:

a native systemd service

a standalone process

a Docker container

Automatic HTTPS works for known domains

On-demand TLS is not enabled without approval logic

Route changes are audited

The Caddy admin API is not publicly reachable

Config and certificate state persist across reboot/restart

Implementation Phases
Phase 1 — Put Caddy in front of HomeBrain

install Caddy as native service

move HomeBrain off 80/443

configure Caddy route for:

freestonefamily.com

www.freestonefamily.com

Phase 2 — Add HomeBrain reverse proxy control plane

add DB model

add backend service for Caddy API

add admin UI for route management

add config apply flow

Phase 3 — Add Axiom

run Axiom on internal port

add mail.freestonefamily.com

validate HTTPS and routing

Phase 4 — Add advanced TLS/domain features

staging vs production ACME control

DNS validation helpers

certificate status UI

optional approved-domain ask endpoint for future on-demand TLS

Final Directive for the AI Coder

Implement the reverse proxy management layer in a service-agnostic way.
Do not assume Docker.
Do not couple routing management to container orchestration.
HomeBrain must manage hostnames and upstream services generically, regardless of whether those services are native processes, systemd services, Docker containers, or other private HTTP services.

The architecture must treat Docker as optional convenience, not foundational truth.

Because once infrastructure starts assuming every future problem is a container problem, you wake up one day with seventeen layers of indirection and no one remembers which port belongs to reality.

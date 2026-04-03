# Alexa Integration

If you need a step-by-step admin deployment guide, use [alexa-admin-setup.md](alexa-admin-setup.md). This document is the architecture and rollout note.

HomeBrain now supports a two-layer Alexa architecture:

- Alexa Smart Home for no-keyword control of HomeBrain devices, groups, scenes, and safe manual workflows
- Alexa Custom Skill scaffolding for later speaker-aware personalization and richer workflow verbs

This document covers the deployment model, required environment variables, and the production-readiness checklist.

## Architecture

The Alexa stack is split across four pieces:

1. HomeBrain hub bridge
   - Exposes the local Alexa catalog, state, execute, health, account-link, and exposure-management APIs
   - Owns the Alexa exposure registry and translates HomeBrain entities into Alexa endpoints
2. HomeBrain Alexa broker
   - Handles Alexa OAuth/account linking
   - Stores paired hubs, linked households, tokens, grants, queued proactive events, metrics, and audit data
   - Relays Alexa directives to the correct HomeBrain hub
3. Alexa Smart Home Lambda
   - Handles `AcceptGrant`, `Discover`, `ReportState`, controller directives, and scene activation
   - Resolves Alexa bearer tokens through the broker before relaying any request
4. Alexa Custom Skill Lambda
   - Handles richer workflow/task intents and recognized-speaker personalization
   - Resolves Alexa `personId` and household metadata against HomeBrain voice profiles

## Hub Prerequisites

Before pairing Alexa publicly, the HomeBrain hub should have:

- `HOMEBRAIN_PUBLIC_BASE_URL` set to the public HTTPS origin for the hub
- a working reverse-proxy route for that hostname
- a valid TLS certificate being served for that hostname

HomeBrain surfaces these checks in `Settings > Integrations > Alexa`.

## Broker Environment

The broker supports both private/dev and public modes. At minimum, set:

```dotenv
HOMEBRAIN_BROKER_PUBLIC_BASE_URL=https://broker.example.com
HOMEBRAIN_ALEXA_OAUTH_CLIENT_ID=homebrain-alexa-skill
HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET=<shared-or-managed-secret>
HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS=homebrain-alexa-skill
HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS=https://pitangui.amazon.com/api/skill/link/...,https://layla.amazon.com/api/skill/link/...
HOMEBRAIN_ALEXA_EVENT_CLIENT_ID=<lwa-client-id>
HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET=<lwa-client-secret>
```

Useful optional overrides:

```dotenv
HOMEBRAIN_BROKER_STORE_FILE=/var/lib/homebrain-alexa/store.json
HOMEBRAIN_ALEXA_AUTH_CODE_TTL_MS=300000
HOMEBRAIN_ALEXA_ACCESS_TOKEN_TTL_SECONDS=3600
HOMEBRAIN_ALEXA_REFRESH_TOKEN_TTL_SECONDS=15552000
HOMEBRAIN_ALEXA_LWA_TOKEN_URL=https://api.amazon.com/auth/o2/token
HOMEBRAIN_ALEXA_EVENT_GATEWAY_URL=https://api.amazonalexa.com/v3/events
```

For production, keep Alexa account-linking refresh tokens long-lived and leave the Alexa console PKCE toggle off until the broker OAuth flow is upgraded to support it.

## Smart Home Lambda Environment

The Smart Home Lambda needs:

```dotenv
HOMEBRAIN_BROKER_BASE_URL=https://broker.example.com
HOMEBRAIN_BROKER_HUB_ID=<optional-default-hub-id-for-dev>
HOMEBRAIN_ALEXA_EVENT_REGION=NA
```

## Custom Skill Lambda Environment

The current custom-skill Lambda only requires the broker base URL:

```dotenv
HOMEBRAIN_BROKER_BASE_URL=https://broker.example.com
```

## Setup Flow

1. Configure the HomeBrain public origin and reverse proxy.
2. Open `Settings > Integrations > Alexa`.
3. Generate a private or public pairing code.
4. Pair the HomeBrain hub with the Alexa broker.
5. Link the Alexa skill through Amazon account linking.
6. Accept the Alexa proactive-events grant.
7. Force discovery sync if needed.
8. Expose devices, groups, scenes, and eligible workflows to Alexa.

## What Smart Home Supports

Current Alexa Smart Home exposure types:

- devices
- device groups with safe capability intersections
- scenes
- safe manual workflows projected as scene/activity triggers

Current interfaces:

- `Alexa.PowerController`
- `Alexa.BrightnessController`
- `Alexa.ColorController`
- `Alexa.ColorTemperatureController`
- `Alexa.ThermostatController`
- `Alexa.TemperatureSensor`
- `Alexa.LockController`
- `Alexa.SceneController`
- `Alexa.EndpointHealth`

Restricted scene/workflow content remains blocked from Alexa scene projection:

- cameras
- cooking appliances
- door locks
- garage doors
- security sensors
- security systems

## Custom Skill / Personalization Model

The custom-skill layer is where HomeBrain maps recognized Alexa speakers to HomeBrain voice profiles.

Recommended flow:

1. Capture Alexa `personId`, `alexaUserId`, and `alexaHouseholdId` from custom-skill requests.
2. Map those identities to a HomeBrain voice profile.
3. Use the matched profile for:
   - personalized workflow/task routing
   - user-specific wording
   - preferred HomeBrain voice selection for follow-up prompts on HomeBrain-managed voice devices

Important:

- Echo-spoken ElevenLabs output is still not part of the Smart Home response path.
- If Echo-side custom voice playback is pursued later, it should remain isolated to the custom-skill side and validated against Alexa platform limits first.

## Public Release Checklist

HomeBrain now treats these items as release gates:

- Public origin is configured
- Public origin uses HTTPS
- Broker is paired
- Broker is in public mode
- Reverse-proxy route exists and validates cleanly
- TLS certificate is issued for the HomeBrain public hostname
- Proactive event delivery is enabled
- At least one Alexa household is linked for live end-to-end validation

## Operational Surfaces

Use the Alexa settings page to inspect:

- broker queue depth
- event-gateway grant health
- recent Alexa activity
- linked households
- public-release readiness checks

The broker also exposes metrics and audit surfaces for deeper troubleshooting.

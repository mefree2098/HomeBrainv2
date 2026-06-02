# Alexa Integration

If you need a step-by-step admin deployment guide, use [alexa-admin-setup.md](alexa-admin-setup.md). This document is the architecture and rollout note.

Last verified: 2026-05-29

HomeBrain now supports a two-layer Alexa architecture:

- Alexa Smart Home for no-keyword control of HomeBrain devices, groups, scenes, and safe manual workflows
- Alexa Custom Skill scaffolding for later speaker-aware personalization and richer workflow verbs
- Workflow-side Alexa announcements through the HomeBrain-native Alexa command bridge

This document covers the deployment model, managed broker settings, and the production-readiness checklist.

## Architecture

The Alexa stack is split across four pieces:

1. HomeBrain hub bridge
   - Exposes the local Alexa catalog, state, execute, health, account-link, and exposure-management APIs
   - Owns the Alexa exposure registry and translates HomeBrain entities into Alexa endpoints
2. HomeBrain Alexa broker
   - Handles Alexa OAuth/account linking
   - Stores paired hubs, linked households, tokens, grants, queued proactive events, metrics, and audit data
   - Relays Alexa directives to the correct HomeBrain hub
   - Queries configured Alexa announcement targets and relays workflow speech requests through the HomeBrain-native Alexa command bridge
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

HomeBrain surfaces these checks in `Alexa Broker`.

Current UI naming:

- `Alexa Broker` is the broker/service/readiness page
- entity exposure is configured from the `Alexa` tab inside device, group, scene, and workflow detail views

## Broker Configuration

The managed broker supports both private/dev and public modes. Configure broker settings from the HomeBrain `Alexa Broker` admin page so they are stored with the managed broker configuration in the database. The HomeBrain service passes those database-backed values into the broker process at runtime; production operators should not create `.env`-only settings for this capability.

At minimum, configure these UI fields:

- Broker public base URL
- OAuth client ID and shared client secret
- Allowed Alexa client IDs
- Allowed Alexa redirect URIs
- LWA event client ID and secret

Useful optional UI fields include:

- Broker store file
- Authorization-code, access-token, and refresh-token lifetimes
- LWA token URL
- Alexa event-gateway URL

## HomeBrain Alexa Command Bridge

Outbound workflow speech is configured from the `Alexa Broker` page and stored in the database. The default provider is `disabled`. For the current consumer-Echo deployment, choose `HomeBrain Native`.

HomeBrain Native stores:

- Alexa session cookie or session-data JSON
- Amazon page and Alexa service host, normally `amazon.com` and `pitangui.amazon.com` for the US
- default command type, normally `announce`
- target mappings such as `kitchen = G090XXXXXXXXXXXX | Kitchen Alexa | Kitchen`
- command timeout and locale

The managed broker injects those DB-backed settings into its runtime when HomeBrain starts or deploys the broker. Operators should not create shell-only `.env` settings for this path.

The preferred refresh path is the `Capture Alexa Session` button on the `Alexa Broker` page. It creates a short-lived HomeBrain capture session, opens a dedicated capture window, and uses the HomeBrain Alexa Session Helper browser extension to read the protected Amazon/Alexa cookies after the operator signs in. The helper posts the cookie directly to HomeBrain with the short-lived capture token; HomeBrain stores the session in the database and restarts the managed broker runtime. This avoids DevTools and manual copy/paste. The raw cookie field remains available only as a fallback.

The broker exposes `GET /api/alexa/devices` to the HomeBrain hub for workflow target selection and `POST /api/alexa/devices/:alexaDeviceId/speak` for workflow announcements. HomeBrain Native uses the stored Alexa session to enumerate Echo devices and send announce/speak/SSML commands directly from the broker. Responses are normalized into `{ id, name, room, type, brokerAccountId, online }` records for the visual workflow builder.

Important platform boundary: Smart Home account linking and `AcceptGrant` credentials are for Alexa event-gateway work such as discovery updates and change reports. Consumer Echo enumeration and announcements are not the same official Smart Home surface. HomeBrain Native is the practical personal-deployment path and may require re-authentication if Amazon invalidates the stored session. [Alexa Smart Properties](https://developer.amazon.com/en-US/docs/alexa/alexa-smart-properties/about-asp-core.html) remains the future enterprise route. For the Smart Home side, Amazon documents the event-gateway grant flow separately in the [`Alexa.Authorization` interface](https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-authorization.html).

For production, keep Alexa account-linking refresh tokens long-lived and leave the Alexa console PKCE toggle off until the broker OAuth flow is upgraded to support it.

HomeBrain manages these broker values through the `Alexa Broker` admin page. The preferred deploy flow there also creates or updates the broker reverse-proxy route and applies the managed Caddy config before restarting the broker.

Operational notes from the validated setup:

- `Deploy Broker` already includes the install step.
- A broker deploy can fail if any enabled reverse-proxy route in HomeBrain is invalid, because HomeBrain will not apply Caddy while invalid enabled routes exist.
- The broker public hostname must resolve in public DNS before Alexa mobile account linking can load.
- For the managed broker, Alexa uses the public broker origin, but HomeBrain pairing and internal catalog/state/execute sync should use the local managed broker control URL, normally `http://127.0.0.1:4301`.

## Smart Home Lambda Deployment Values

The Smart Home Lambda is outside the managed HomeBrain service, so these values are set in the Lambda deployment configuration or IaC template:

```dotenv
HOMEBRAIN_BROKER_BASE_URL=https://broker.example.com
HOMEBRAIN_BROKER_HUB_ID=<optional-default-hub-id-for-dev>
HOMEBRAIN_ALEXA_EVENT_REGION=NA
```

## Custom Skill Lambda Deployment Values

The current custom-skill Lambda only requires the broker base URL in the Lambda deployment configuration:

```dotenv
HOMEBRAIN_BROKER_BASE_URL=https://broker.example.com
```

## Setup Flow

1. Configure the HomeBrain public origin and reverse proxy.
2. Open `Alexa Broker`.
3. Configure and `Deploy Broker`.
4. Build and upload the Smart Home Lambda with handler `lambda/src/handler.handler`.
5. Add the Alexa Smart Home trigger/permission to the Lambda.
6. Configure Alexa account linking and copy the full Alexa redirect URLs into HomeBrain.
7. Pair the HomeBrain hub to the managed broker using the local broker control URL.
8. Link the Alexa skill through Amazon account linking.
9. Accept the Alexa proactive-events grant.
10. Expose devices, groups, scenes, and eligible workflows to Alexa.
11. Force discovery sync if needed.

Pairing and household linking each consume their own one-time public `HBAX-...` code.

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

## Workflow Alexa Announcements

Workflows support a first-class `alexa_speak` action. The action target is an Alexa device ID from the broker device list, and the parameters include:

```json
{
  "message": "Front Door has opened",
  "brokerAccountId": "optional linked account id",
  "deviceName": "Kitchen Alexa"
}
```

Example workflow shape:

```json
{
  "trigger": {
    "type": "device_state",
    "conditions": {
      "deviceId": "<front-door-contact-id>",
      "property": "directRadioState.contactOpen",
      "operator": "eq",
      "value": true
    }
  },
  "actions": [
    {
      "type": "alexa_speak",
      "target": {
        "kind": "alexa_device",
        "alexaDeviceId": "kitchen-echo",
        "name": "Kitchen Alexa"
      },
      "parameters": {
        "message": "Front Door has opened"
      }
    }
  ]
}
```

The visual workflow builder loads Alexa announcement targets from the broker. If the provider is not configured, normal workflow loading still works and the Alexa-device selector is empty.

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

If Smart Home discovery succeeds but control fails, inspect components in this order:

1. Lambda CloudWatch logs
2. broker `Recent Alexa activity`
3. HomeBrain service logs for `/api/alexa/broker/execute`
4. the exposed entity's Alexa configuration

Two especially useful failure signatures from the validated rollout are:

- `Cannot find module 'index'`
  - Lambda handler is wrong or the ZIP was uploaded with the wrong layout
- `POST /api/alexa/broker/execute - Error: Alexa directive endpoint ID is required`
  - broker/HomeBrain are on an older execute payload shape and need the current code

Current code also uses a fast Harmony control response path for Alexa power directives so Harmony-backed activity devices do not fail voice control while waiting on an immediate post-command re-poll.

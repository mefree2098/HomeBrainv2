# Alexa Admin Setup Guide

Last verified: 2026-04-02

This guide is the step-by-step runbook for getting Alexa working with HomeBrain from scratch.

It assumes the admin knows nothing yet and covers:

- what parts of the system exist
- what to deploy
- which environment variables matter
- how to configure the Alexa developer console
- how to pair HomeBrain with the broker
- how to link a real Alexa household
- how to expose HomeBrain entities to Alexa
- how to test and troubleshoot the integration

This guide is for the current code in this repository. For the architecture and code map, also see [alexa-integration.md](alexa-integration.md).

## 1. Understand the HomeBrain Alexa architecture

HomeBrain's Alexa integration is split into four pieces:

1. HomeBrain server
   - exposes the local Alexa bridge APIs
   - owns the exposure registry for devices, groups, scenes, and workflows
   - executes directives and produces endpoint state
2. Alexa broker
   - acts as the OAuth/account-linking server for Alexa
   - stores paired hubs, linked households, access tokens, refresh tokens, event-gateway grants, queued events, and audit logs
3. Smart Home Lambda
   - is the Alexa Smart Home skill endpoint
   - receives `Discover`, `ReportState`, control directives, and `AcceptGrant`
   - relays them to the broker
4. Optional Custom Skill Lambda
   - is the endpoint for a separate Alexa custom skill
   - lets HomeBrain map Alexa speaker identities to HomeBrain user profiles
   - is optional and not required for basic smart-home control

The code lives here:

- HomeBrain bridge: [`../server/services/alexaBridgeService.js`](../server/services/alexaBridgeService.js)
- HomeBrain projections: [`../server/services/alexaProjectionService.js`](../server/services/alexaProjectionService.js)
- HomeBrain routes: [`../server/routes/alexaRoutes.js`](../server/routes/alexaRoutes.js)
- Custom skill service: [`../server/services/alexaCustomSkillService.js`](../server/services/alexaCustomSkillService.js)
- Broker: [`../broker/src/app.js`](../broker/src/app.js)
- Broker store: [`../broker/src/store.js`](../broker/src/store.js)
- Broker event gateway service: [`../broker/src/eventGatewayService.js`](../broker/src/eventGatewayService.js)
- Smart Home Lambda: [`../lambda/src/handler.js`](../lambda/src/handler.js)
- Custom Skill Lambda: [`../lambda/src/customSkillHandler.js`](../lambda/src/customSkillHandler.js)

## 2. What Alexa can control in HomeBrain right now

HomeBrain can project these entity types into Alexa:

- devices
- device groups
- scenes
- eligible manual workflows, exposed as scene/activity triggers

Current Alexa interfaces used by HomeBrain:

- `Alexa.PowerController`
- `Alexa.BrightnessController`
- `Alexa.ColorController`
- `Alexa.ColorTemperatureController`
- `Alexa.ThermostatController`
- `Alexa.TemperatureSensor`
- `Alexa.LockController`
- `Alexa.SceneController`
- `Alexa.EndpointHealth`

Important restrictions:

- cameras are not projected as scenes or workflows
- locks are not projected as scenes or workflows
- garage doors are not projected as scenes or workflows
- sensors and security entities are not projected as scenes or workflows
- mixed-capability groups may fall back to simpler Alexa capability sets

## 3. Important implementation facts before you start

These details matter and are easy to miss:

1. The HomeBrain hub and the Alexa broker must have separate public origins.
   - Use something like `https://homebrain.example.com` for the hub.
   - Use something like `https://alexa-broker.example.com` for the broker.
   - Do not try to host the broker under a path such as `https://homebrain.example.com/broker`.
   - The current broker code normalizes to the origin only, not a path prefix.

2. The broker's public OAuth URLs must be HTTPS on port `443`.
   - Amazon's current account-linking requirements say both the authorization URI and token URI must be HTTPS on port `443`.
   - Internally the broker listens on port `4301` by default, so front it with a reverse proxy.

3. HomeBrain uses two different credential sets for Alexa.
   - Broker OAuth client ID and secret:
     - you define these
     - Alexa uses them when exchanging the user authorization code for a HomeBrain access token
   - Alexa event-gateway client ID and secret:
     - Amazon generates these when you enable `Send Alexa Events`
     - the broker uses them with Login with Amazon to process `AcceptGrant`

4. Pairing the broker and linking an Alexa household are not the same step.
   - Broker pairing connects the HomeBrain hub to the broker.
   - Household linking connects an Alexa user/household to the broker and therefore to the hub.
   - Both steps consume a one-time `HBAX-...` code from HomeBrain.

5. The current broker does not implement PKCE verification.
   - Amazon's current account-linking docs support a PKCE toggle.
   - Leave `PKCE Authorization` disabled in the Alexa developer console for HomeBrain right now.
   - If PKCE is turned on, the current broker will not verify `code_verifier` and can break account linking.

6. The broker's default refresh-token TTL is too short for a strong production setup.
   - The code default is 30 days.
   - Amazon currently recommends a refresh-token TTL of at least 180 days or no expiration.
   - Set `HOMEBRAIN_ALEXA_REFRESH_TOKEN_TTL_SECONDS` explicitly in production.

## 4. What you need before you touch Alexa

You need all of this first:

- a working HomeBrain deployment
- HomeBrain admin access
- an Amazon developer account
- an AWS account with permission to create Lambda functions
- a public HTTPS hostname for the HomeBrain hub
- a public HTTPS hostname for the Alexa broker
- DNS pointing both hostnames to reachable infrastructure
- valid TLS certificates for both origins
- Node.js compatible with this repo on the machine where you package the Lambda code

For a simple first deployment, use:

- HomeBrain public origin: `https://homebrain.example.com`
- Broker public origin: `https://alexa-broker.example.com`
- Smart Home Lambda region: `us-east-1`
- Alexa locale: `en-US`

## 5. Configure the HomeBrain hub first

HomeBrain must know its own public origin before Alexa pairing will work.

### Required HomeBrain environment

At minimum, set this for the HomeBrain server:

```dotenv
HOMEBRAIN_PUBLIC_BASE_URL=https://homebrain.example.com
```

If you also want the optional custom skill to serve ElevenLabs-hosted audio clips through HomeBrain, set one of these:

```dotenv
HOMEBRAIN_ALEXA_AUDIO_SIGNING_SECRET=replace-with-a-long-random-secret
```

or rely on:

```dotenv
JWT_SECRET=existing-homebrain-jwt-secret
```

### HomeBrain readiness expectations

HomeBrain's Alexa readiness checks expect:

- `HOMEBRAIN_PUBLIC_BASE_URL` to be set
- that public origin to use HTTPS
- a reverse-proxy route to exist for that hostname
- the route to validate cleanly
- a certificate to be issued and served for that hostname

In the HomeBrain UI, check:

`Settings > Integrations > Alexa`

The important cards are:

- `Hub Status`
- `Certification Readiness`
- `TLS Certificate`
- `Reverse Proxy Route`

Do not move on until HomeBrain has a valid public origin and TLS.

## 6. Deploy the Alexa broker

The broker is the OAuth server and event-dispatch layer. It lives in [`../broker`](../broker).

### Broker install

From the repo root:

```bash
cd /Users/matt/Documents/HomeBrainv2
npm run broker-install
```

### Minimum production broker environment

```dotenv
PORT=4301
HOMEBRAIN_BROKER_PUBLIC_BASE_URL=https://alexa-broker.example.com

HOMEBRAIN_ALEXA_OAUTH_CLIENT_ID=homebrain-alexa-skill
HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET=replace-with-a-long-random-secret
HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS=homebrain-alexa-skill

# Fill this in after the Alexa skill shows you the generated redirect URLs.
HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS=https://pitangui.amazon.com/api/skill/link/...,https://layla.amazon.com/api/skill/link/...,https://alexa.amazon.co.jp/api/skill/link/...

# Amazon generates these later when you enable "Send Alexa Events".
HOMEBRAIN_ALEXA_EVENT_CLIENT_ID=
HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET=

# Put the broker state on persistent storage, not inside the repo.
HOMEBRAIN_BROKER_STORE_FILE=/var/lib/homebrain-alexa/store.json

# Use a production-grade refresh token lifetime.
HOMEBRAIN_ALEXA_ACCESS_TOKEN_TTL_SECONDS=3600
HOMEBRAIN_ALEXA_REFRESH_TOKEN_TTL_SECONDS=15552000
HOMEBRAIN_ALEXA_AUTH_CODE_TTL_MS=300000
```

### What the broker stores

The broker store file contains:

- paired hub registrations
- linked Alexa households
- authorization codes
- access tokens
- refresh tokens
- proactive-event permission grants
- queued Alexa events
- broker audit log

Back up this file. If you lose it, users will need to relink Alexa.

### Run the broker

Example local start:

```bash
cd /Users/matt/Documents/HomeBrainv2
PORT=4301 \
HOMEBRAIN_BROKER_PUBLIC_BASE_URL=https://alexa-broker.example.com \
HOMEBRAIN_ALEXA_OAUTH_CLIENT_ID=homebrain-alexa-skill \
HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET=replace-with-a-long-random-secret \
HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS=homebrain-alexa-skill \
HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS=https://pitangui.amazon.com/api/skill/link/... \
HOMEBRAIN_ALEXA_EVENT_CLIENT_ID= \
HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET= \
HOMEBRAIN_BROKER_STORE_FILE=/var/lib/homebrain-alexa/store.json \
HOMEBRAIN_ALEXA_REFRESH_TOKEN_TTL_SECONDS=15552000 \
npm run broker
```

In production, run it under your normal service manager.

### Broker health check

The broker exposes:

```text
GET /health
```

It should return JSON with queue and grant counts.

## 7. Package the Lambda artifact correctly

This repo's Lambda code imports shared files from `shared/alexa`, so the artifact must preserve the repo-relative layout.

Do not zip only the contents of the `lambda/` directory.

### Install Lambda dependencies

```bash
cd /Users/matt/Documents/HomeBrainv2
npm run lambda-install
```

### Build the Lambda ZIP from the repo root

```bash
cd /Users/matt/Documents/HomeBrainv2
rm -f /tmp/homebrain-alexa-lambda.zip
zip -r /tmp/homebrain-alexa-lambda.zip \
  lambda/package.json \
  lambda/package-lock.json \
  lambda/node_modules \
  lambda/src \
  shared/alexa
```

Use that same ZIP for both Lambda functions.

### Handler names

- Smart Home Lambda handler: `lambda/src/handler.handler`
- Optional Custom Skill Lambda handler: `lambda/src/customSkillHandler.handler`

### Lambda runtime

Use a current supported Node.js runtime in AWS Lambda.

This repo itself supports:

- Node `20.19+`
- Node `22.12+`

Node.js `22.x` is the most natural fit for new Lambda deployments if it's available in your AWS account.

## 8. Create the Smart Home Lambda in AWS

Create an AWS Lambda function for the Smart Home skill.

Recommended first deployment:

- Runtime: Node.js `22.x`
- Architecture: `x86_64` or `arm64`
- Region: `us-east-1` for `en-US`

After creating the function:

1. Upload `/tmp/homebrain-alexa-lambda.zip`.
2. Set the handler to `lambda/src/handler.handler`.
3. Add environment variables:

```dotenv
HOMEBRAIN_BROKER_BASE_URL=https://alexa-broker.example.com
```

Optional only for single-hub development:

```dotenv
HOMEBRAIN_BROKER_HUB_ID=<your-homebrain-hub-id>
```

Usually leave that unset in production.

Optional override:

```dotenv
HOMEBRAIN_ALEXA_EVENT_REGION=NA
```

You usually do not need to set this if the function is deployed in the correct AWS region, because the code falls back to `AWS_REGION`.

## 9. Create the Alexa Smart Home skill

In the Alexa developer console:

1. Sign in.
2. Create a new skill.
3. Name it.
4. Choose your primary locale.
5. Choose `Smart Home`.
6. Choose `Provision your own`.
7. Create the skill.

Amazon's current Smart Home tutorial still describes this flow.

## 10. Configure the Smart Home endpoint

On the Smart Home skill's build page:

1. Go to the `Smart Home service endpoint` section.
2. Paste the Lambda ARN into `Default endpoint`.
3. Save.

If you support multiple locales/regions, deploy the same code to the required regional Lambda regions and enter every region-specific ARN.

Current Amazon locale-to-region guidance:

- North America locales use `us-east-1`
- Europe and India locales use `eu-west-1`
- Far East and Australia locales use `us-west-2`

If you add locales later:

- add the locale in the Alexa developer console
- deploy the Lambda to the matching AWS region
- add the regional ARN
- add all newly generated Alexa redirect URLs to the broker allowlist

## 11. Configure Smart Home account linking in Alexa

This is the part that usually causes the most confusion.

### Use these exact HomeBrain values

On the Alexa developer console Account Linking page:

- Authorization Grant Type:
  - `Auth Code Grant`
- PKCE Authorization:
  - `Disabled`
- Your Web Authorization URI:
  - `https://alexa-broker.example.com/api/oauth/alexa/authorize`
- Access Token URI:
  - `https://alexa-broker.example.com/api/oauth/alexa/token`
- Your Client ID:
  - the value of `HOMEBRAIN_ALEXA_OAUTH_CLIENT_ID`
  - for example `homebrain-alexa-skill`
- Your Secret:
  - the value of `HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET`
- Your Authentication Scheme:
  - `HTTP Basic (Recommended)`
- Scope:
  - `smart_home`
- Domain List:
  - usually leave empty for HomeBrain, because the broker login page is self-contained
  - add extra domains only if you customize the page to pull assets from other domains
- Default Access Token Expiration Time:
  - `3600`

### Important settings guidance

- Smart home skills require account linking.
- Do not enable mobile-app account linking unless you also build app-to-app authorization URIs.
- Do not enable voice-forward account linking unless you explicitly implement it.
- Do not enable PKCE for HomeBrain's current broker.

### Alexa-generated redirect URLs

Once account linking is enabled, the console will show `Alexa Redirect URLs`.

You must copy every redirect URL shown there into the broker allowlist:

```dotenv
HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS=https://pitangui.amazon.com/api/skill/link/...,https://layla.amazon.com/api/skill/link/...,https://alexa.amazon.co.jp/api/skill/link/...
```

If you add more locales later, revisit this page and update the allowlist with every newly shown redirect URL.

For quick internal development only, the broker can be run without an explicit redirect allowlist. Do not leave it that way for a real public rollout.

## 12. Enable proactive events

If you want Alexa discovery/state to stay fresh and you want `AcceptGrant` to work end to end, enable `Send Alexa Events`.

In the Alexa developer console:

1. Open the skill.
2. Go to `PERMISSIONS`.
3. Toggle `Send Alexa Events` on.
4. Under `Alexa Skill Messaging`, click `SHOW`.
5. Copy the `Alexa Client Id` and `Alexa Client Secret`.
6. Put those values into the broker environment:

```dotenv
HOMEBRAIN_ALEXA_EVENT_CLIENT_ID=<value copied from Alexa developer console>
HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET=<value copied from Alexa developer console>
```

These are not the same as `HOMEBRAIN_ALEXA_OAUTH_CLIENT_ID` and `HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET`.

After updating the broker env, restart the broker.

## 13. Pair the HomeBrain hub with the broker

This is done from HomeBrain, not from Alexa.

In HomeBrain:

1. Go to `Settings > Integrations > Alexa`.
2. Click `Generate Public Link Code`.
3. Copy the `HBAX-...` code.
4. Enter the broker base URL, for example `https://alexa-broker.example.com`.
5. Paste the code into `Pairing Code`.
6. Click `Pair Broker`.

What should happen:

- HomeBrain calls the broker `/api/alexa/hubs/register`
- the broker calls HomeBrain back at `/api/alexa/broker/register`
- HomeBrain stores the broker registration
- the broker stores the hub registration and relay token

After pairing, the HomeBrain Alexa page should show:

- `Hub Status: Paired (public)` for production
- broker base URL populated
- no pairing errors in recent activity

If it does not show as paired, do not move on.

## 14. Expose HomeBrain entities to Alexa

Pairing alone does not mean every HomeBrain entity is exposed.

Use the Alexa exposure controls in:

- Devices
- Device Groups
- Scenes
- Workflows

Each entity can be configured with:

- `Expose in Alexa`
- friendly name
- aliases
- room hint

Use the exposure controls to keep names simple and natural for voice control.

Examples:

- friendly name: `Kitchen Lights`
- alias: `Main kitchen lights`
- room hint: `Kitchen`

After exposing entities, run:

`Settings > Integrations > Alexa > Force Discovery Sync`

That pushes the current HomeBrain catalog to the broker.

## 15. Link the first Alexa household

This is the step that actually connects an Alexa user/household to HomeBrain.

### Very important

Generate a new public HomeBrain link code before doing this.

Do not reuse the code that was already consumed during broker pairing.

### Household-linking flow

1. In HomeBrain, go to `Settings > Integrations > Alexa`.
2. Click `Generate Public Link Code`.
3. Keep that `HBAX-...` code ready.
4. In the Alexa app, enable the Smart Home skill.
5. Alexa opens the broker's account-linking page.
6. On that page, enter:
   - the HomeBrain hub ID or HomeBrain public origin
   - the one-time HomeBrain link code
   - locale if needed
7. Submit the form.

What should happen:

- the broker consumes the one-time HomeBrain link code
- the broker creates an account link
- Alexa exchanges the authorization code for a HomeBrain access token and refresh token
- Alexa sends `Discover`
- if `Send Alexa Events` is enabled, Alexa sends `AcceptGrant`
- the broker stores the permission grant for proactive events

### How to verify success

Back in HomeBrain `Settings > Integrations > Alexa`, confirm:

- `Linked Households` is greater than `0`
- `Permission Grants` shows at least `1 active`
- the household appears under `Linked Alexa Households`
- broker queue is not filling with failures

If account linking succeeds but `Permission Grants` stays at `0 active`, the usual problem is `AcceptGrant` handling or missing `HOMEBRAIN_ALEXA_EVENT_CLIENT_ID` / `HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET`.

## 16. Test the Smart Home skill

Amazon's current test flow is:

1. Enable the skill in development.
2. Link the account.
3. Let Alexa run discovery.
4. Verify the device appears in the Alexa app.
5. Test voice control.

Basic test commands:

- `Alexa, turn on <friendly name>`
- `Alexa, turn off <friendly name>`
- `Alexa, set <friendly name> to 50 percent`

Use the Alexa app or developer console test tools to verify:

- the skill links successfully
- the device appears
- state changes flow back

If discovery or control fails, check:

- Lambda CloudWatch logs
- HomeBrain `Recent Alexa activity`
- HomeBrain `Broker Queue`
- HomeBrain `Linked Households`
- HomeBrain `Permission Grants`
- broker `/health`

## 17. Optional: set up the HomeBrain Alexa custom skill

The custom skill is optional.

You only need it if you want:

- speaker-aware HomeBrain profile mapping
- custom skill intents/workflows
- optional HomeBrain-served audio responses

### Deploy the custom skill Lambda

Create a second Lambda function:

- upload the same ZIP artifact
- set handler to `lambda/src/customSkillHandler.handler`
- set environment:

```dotenv
HOMEBRAIN_BROKER_BASE_URL=https://alexa-broker.example.com
```

That is the only required environment variable for the current custom-skill Lambda code.

### Create the custom skill in Alexa

In the Alexa developer console:

1. Create a new `Custom` skill.
2. Choose `Provision your own`.
3. Set the endpoint to the custom skill Lambda ARN.
4. Enable account linking.
5. Use the same broker OAuth settings as the Smart Home skill.
6. For a simple setup, reuse:
   - the same broker OAuth client ID and secret
   - the same authorization URI
   - the same access token URI

### Custom skill notes

- The custom skill returns a link-account response if no access token is present.
- Voice users only appear in HomeBrain after someone actually uses the custom skill.
- After a voice is discovered, map it in `Settings > Integrations > Alexa`.
- If you want HomeBrain-served audio clips, configure `HOMEBRAIN_ALEXA_AUDIO_SIGNING_SECRET` or `JWT_SECRET` on the HomeBrain server and keep `HOMEBRAIN_PUBLIC_BASE_URL` valid.

## 18. Recommended production settings

For a real deployment, use at least these values:

### HomeBrain server

```dotenv
HOMEBRAIN_PUBLIC_BASE_URL=https://homebrain.example.com
HOMEBRAIN_ALEXA_AUDIO_SIGNING_SECRET=replace-with-a-long-random-secret
```

### Broker

```dotenv
PORT=4301
HOMEBRAIN_BROKER_PUBLIC_BASE_URL=https://alexa-broker.example.com
HOMEBRAIN_ALEXA_OAUTH_CLIENT_ID=homebrain-alexa-skill
HOMEBRAIN_ALEXA_OAUTH_CLIENT_SECRET=replace-with-a-long-random-secret
HOMEBRAIN_ALEXA_ALLOWED_CLIENT_IDS=homebrain-alexa-skill
HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS=<all Alexa redirect URLs from the console>
HOMEBRAIN_ALEXA_EVENT_CLIENT_ID=<copied from Send Alexa Events>
HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET=<copied from Send Alexa Events>
HOMEBRAIN_BROKER_STORE_FILE=/var/lib/homebrain-alexa/store.json
HOMEBRAIN_ALEXA_ACCESS_TOKEN_TTL_SECONDS=3600
HOMEBRAIN_ALEXA_REFRESH_TOKEN_TTL_SECONDS=15552000
HOMEBRAIN_ALEXA_AUTH_CODE_TTL_MS=300000
```

### Smart Home Lambda

```dotenv
HOMEBRAIN_BROKER_BASE_URL=https://alexa-broker.example.com
```

### Optional custom skill Lambda

```dotenv
HOMEBRAIN_BROKER_BASE_URL=https://alexa-broker.example.com
```

## 19. Troubleshooting checklist

### Problem: HomeBrain will not pair with the broker

Check:

- `HOMEBRAIN_PUBLIC_BASE_URL` is set
- HomeBrain public origin is HTTPS
- the broker base URL is correct
- the link code is fresh and not already consumed
- the broker is publicly reachable
- HomeBrain can reach the broker
- the broker can call HomeBrain back on `/api/alexa/broker/register`

### Problem: Alexa app account linking fails immediately

Check:

- authorization URI is `https://alexa-broker.example.com/api/oauth/alexa/authorize`
- token URI is `https://alexa-broker.example.com/api/oauth/alexa/token`
- both are HTTPS on port `443`
- broker OAuth client ID and secret match the values saved in the Alexa console
- every Alexa redirect URL shown in the console is present in `HOMEBRAIN_ALEXA_ALLOWED_REDIRECT_URIS`
- `PKCE Authorization` is disabled
- the broker login page is reachable on mobile

### Problem: account linking works only when Send Alexa Events is off

Check:

- Smart Home Lambda handles `AcceptGrant`
- broker has `HOMEBRAIN_ALEXA_EVENT_CLIENT_ID`
- broker has `HOMEBRAIN_ALEXA_EVENT_CLIENT_SECRET`
- broker can reach `https://api.amazon.com/auth/o2/token`
- linked household shows an active permission grant after linking

### Problem: devices do not appear in Alexa

Check:

- the entity is exposed in HomeBrain
- the exposure has no blocking validation errors
- the entity type is supported
- the device/group/scene/workflow name is valid
- `Force Discovery Sync` was run after exposure changes
- the skill was disabled and re-enabled if the discovery shape changed materially
- Lambda CloudWatch logs show `Discover` being received

### Problem: device state changes do not stay in sync

Check:

- `Permission Grants` is active
- broker queue is not backing up
- there are no failed broker events
- HomeBrain state is being updated locally
- the projected properties are marked proactive in the discovery response
- the broker is sending `Alexa.ChangeReport` events

HomeBrain's broker already knows the correct event gateway URLs:

- `https://api.amazonalexa.com/v3/events`
- `https://api.eu.amazonalexa.com/v3/events`
- `https://api.fe.amazonalexa.com/v3/events`

### Problem: custom skill says to link account

Check:

- the custom skill has account linking enabled
- the custom skill uses the broker authorization URI and token URI
- the custom skill Lambda is using `HOMEBRAIN_BROKER_BASE_URL`
- the household is actually linked

### Problem: linked users keep having to relink

Check:

- `HOMEBRAIN_ALEXA_REFRESH_TOKEN_TTL_SECONDS` is long enough
- refresh tokens are not being expired too aggressively
- the broker store file is persistent and not being wiped
- the broker secret has not changed without updating the Alexa console

## 20. Known current limitations

These are current implementation realities, not guesswork:

1. PKCE is not implemented in the HomeBrain broker.
   - Leave the Alexa console PKCE toggle off.

2. The broker and hub expect separate origins.
   - Do not deploy the broker under a subpath of the HomeBrain origin.

3. The custom skill Lambda only requires `HOMEBRAIN_BROKER_BASE_URL`.
   - Older internal notes that mention `HOMEBRAIN_ALEXA_CUSTOM_DEFAULT_LOCALE` are stale.

4. The broker default refresh-token TTL is not ideal for production.
   - Override it explicitly.

5. Amazon's account-linking requirements page currently includes certificate-authority restrictions for OAuth providers.
   - Validate your broker certificate chain against Amazon's current requirements before public rollout.

## 21. Fast recovery path if something regresses

If Alexa breaks in the future, inspect components in this order:

1. HomeBrain UI:
   - `Settings > Integrations > Alexa`
   - check pairing, linked households, grants, queue, readiness, and recent activity
2. Broker health:
   - `GET /health`
3. Smart Home Lambda CloudWatch logs:
   - confirm `Discover`, `ReportState`, control directives, and `AcceptGrant`
4. Broker audit and queue:
   - use the HomeBrain Alexa page to inspect broker audit and queue state
5. Exposure configuration:
   - confirm the entity is still enabled for Alexa and valid

If the issue is:

- pairing or OAuth:
  - start in [`../broker/src/app.js`](../broker/src/app.js)
- discovery/state/control:
  - start in [`../server/services/alexaBridgeService.js`](../server/services/alexaBridgeService.js)
  - then [`../server/services/alexaProjectionService.js`](../server/services/alexaProjectionService.js)
- proactive events:
  - start in [`../broker/src/eventGatewayService.js`](../broker/src/eventGatewayService.js)
  - then [`../lambda/src/handler.js`](../lambda/src/handler.js)
- custom skill speaker mapping:
  - start in [`../lambda/src/customSkillHandler.js`](../lambda/src/customSkillHandler.js)
  - then [`../server/services/alexaCustomSkillService.js`](../server/services/alexaCustomSkillService.js)

## 22. Official references used for this guide

These were checked on 2026-04-02:

- Amazon: [Account Linking for Smart Home and Other Domains](https://developer.amazon.com/en-US/docs/alexa/account-linking/account-linking-for-sh-and-other.html)
- Amazon: [Configure an Authorization Code Grant](https://developer.amazon.com/en-US/docs/alexa/account-linking/configure-authorization-code-grant.html)
- Amazon: [Requirements for Account Linking for Alexa Skills](https://developer.amazon.com/en-US/docs/alexa/account-linking/requirements-account-linking.html)
- Amazon: [Step 1: Create a Smart Home Skill](https://developer.amazon.com/en-US/docs/alexa/smarthome/create-skill-tutorial.html)
- Amazon: [Step 3: Configure the Service Endpoint](https://developer.amazon.com/en-US/docs/alexa/smarthome/configure-endpoint-tutorial.html)
- Amazon: [Step 5: Test the Skill](https://developer.amazon.com/en-US/docs/alexa/smarthome/test-the-skill-tutorial.html)
- Amazon: [Configure Permissions to Send Events](https://developer.amazon.com/en-US/docs/alexa/smarthome/configure-permissions-events.html)
- Amazon: [Send Events to the Alexa Event Gateway](https://developer.amazon.com/en-US/docs/alexa/smarthome/send-events-to-the-alexa-event-gateway.html)
- Amazon: [Alexa.Authorization Interface 3](https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-authorization.html)
- Amazon: [Understand State and Change Reporting](https://developer.amazon.com/en-US/docs/alexa/smarthome/state-reporting-for-a-smart-home-skill.html)
- Amazon: [Develop Smart Home Skills for Multiple Languages](https://developer.amazon.com/en-US/docs/alexa/smarthome/develop-smart-home-skills-in-multiple-languages.html)
- Amazon: [Troubleshooting Account Linking](https://developer.amazon.com/en-US/docs/alexa/account-linking/troubleshooting-account-linking.html)
- AWS: [Lambda runtimes](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html)

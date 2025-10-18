# SmartThings Event Subscription Webhook Plan

This document captures the end-to-end plan for adding SmartThings push-based status updates to HomeBrain. The goal is to replace (or significantly reduce) the current polling cadence by registering a SmartApp that pushes events to our existing HTTPS endpoint. The plan assumes the current OAuth integration is working and we already have a public HTTPS URL with a trusted certificate (the same origin SmartThings uses for OAuth redirects).

---

## 1. Objectives

1. Receive real-time device state changes from SmartThings via their Event API.
2. Eliminate redundant polling (keep a slower fallback for resiliency).
3. Maintain secure, authenticated communication with SmartThings.
4. Integrate pushed events into `deviceUpdateEmitter` so browser clients continue to receive updates via WebSocket/SSE.

---

## 2. Prerequisites & Existing Assets

- **Public HTTPS endpoint**: already configured for OAuth (`https://<public-domain>/api/smartthings/oauth/callback` or similar).
- **Trusted certificates**: managed through `sslService` and the existing HTTPS server.
- **SmartThings OAuth credentials**: Client ID/Secret saved in `SmartThingsIntegration`.
- **Persistent storage**: MongoDB, already storing integration tokens and device metadata.
- **Event broadcasting**: `deviceUpdateEmitter` used by WebSocket/SSE layers on the backend.
- **Server runtime**: Node.js/Express app running both HTTP and HTTPS servers (see `server/server.js`).

---

## 3. High-Level Architecture

1. **SmartApp registration**: Extend the existing SmartApp definition to declare EVENT permissions and set our webhook URL.
2. **Webhook lifecycle handler**: Implement POST endpoint that handles SmartThings lifecycle requests (`PING`, `CONFIGURATION`, `INSTALL`, `UPDATE`, `EVENT`, etc.).
3. **Subscription management**: During `INSTALL/UPDATE`, subscribe to the desired device capabilities/events. Persist subscription identifiers.
4. **Event processing**: On `EVENT` lifecycle payloads, normalize device data and feed it into `deviceUpdateEmitter`.
5. **Fallback polling**: Keep existing polling at a much lower cadence (e.g., 60 s) for redundancy.
6. **Observability**: Add logging/metrics for subscription status and event throughput.

---

## 4. Detailed Implementation Steps

### 4.1 Define Webhook Endpoint

- **Route**: `POST /api/smartthings/webhook`
- **Express middleware**: ensure body parser accepts raw JSON (don't rely on URL-encoded body).
- **Signature validation**:
  - SmartThings includes `x-st-signature` header with HMAC-SHA256 (Docs: SmartThings Webhook v1).
  - Use the integration’s `clientSecret` to compute and verify the signature; reject if invalid.

### 4.2 Handle Lifecycle Payloads

SmartThings wraps all requests in a `lifecycle` field. We must support at least the following:

| Lifecycle       | Purpose                                    | Response Requirements                                  |
|-----------------|---------------------------------------------|--------------------------------------------------------|
| `PING`          | Connectivity check                          | Echo back `challenge` string.                          |
| `CONFIGURATION` | Metadata for SmartApp settings UI           | Provide page definitions (can keep minimal if headless)|
| `INSTALL`       | SmartApp installation                       | Capture auth tokens (already handled) + subscribe      |
| `UPDATE`        | Reconfiguration                             | Refresh subscriptions                                  |
| `UNINSTALL`     | Cleanup                                     | Delete stored tokens/subscription IDs                  |
| `EVENT`         | Device events                               | Process events, respond with 200 quickly               |

Implementation notes:
- Wrap handler in try/catch to respond within the 10‑second SmartThings SLA.
- For `CONFIGURATION`, we can return a simple page with no options to keep UX simple if we only need device access granted during OAuth.
- For `INSTALL`/`UPDATE`, call `POST /installedapps/{installedAppId}/subscriptions` to register capability/device events.

### 4.3 Subscription Strategy

- **Scope**: Subscribe to capability events that map to our device types, e.g.:
  - `capability.switch`
  - `capability.switchLevel`
  - `capability.thermostatOperatingState`
  - `capability.lock`
  - `capability.temperatureMeasurement`
  - Add more as needed (motion, contact, etc.).
- **Device set**: Use our stored SmartThings devices to build the subscription list. Option: subscribe to “all devices with capability X” or per device.
- **Persistence**: Store subscription IDs alongside device metadata to facilitate unsubscribe operations during updates/uninstalls.
- **Renewal**: Subscriptions expire (typically after 24h). Implement a daily job that reaffirms or re-subscribes using stored credentials.

### 4.4 Event Handling Flow

1. Verify signature.
2. Iterate over `eventData.events`.
3. For each event:
   - Identify HomeBrain device via SmartThings `deviceId`.
   - Map capability/attribute values to our schema.
   - Build partial update object (similar to `buildSmartThingsDeviceUpdate`).
   - Upsert changes in MongoDB to keep authoritative state.
   - Normalize and emit via `deviceUpdateEmitter`.
4. Respond with `{ status: "CONFIRMED" }` or `200 OK` per API expectations.
5. Handle errors gracefully without blocking other events (log and continue).

### 4.5 Security Considerations

- Enforce HTTPS only.
- Validate signatures for every request.
- Rate-limit by IP (SmartThings uses known AWS ranges; consider moderate limits).
- Monitor for repeated signature failures (potential malicious attempts).
- Store SmartThings tokens encrypted (already managed via existing integration service).

### 4.6 Fallback Polling Adjustment

Once events are flowing, reduce polling frequency to minimize API load:

- Set `SMARTTHINGS_DEVICE_SYNC_INTERVAL_MS` and `SMARTTHINGS_DEVICE_REFRESH_MS` defaults to 60 s (or even longer).
- Keep fallback to handle missed events or offline webhook scenarios.
- Provide admin toggle to temporarily revert to high-frequency polling if needed.

### 4.7 Configuration & Deployment

1. **Environment Variables** (new):
   - `SMARTTHINGS_WEBHOOK_PATH=/api/smartthings/webhook` (optional convenience).
   - `SMARTTHINGS_APP_ID` / `SMARTTHINGS_APP_SECRET` already stored; ensure accessible.
2. **SmartThings Developer Workspace**:
   - Update app settings to mark it as “webhook” (if not already).
   - Ensure OAuth redirect URL and webhook target domain match the SSL certificate.
3. **Secrets rotation**: Document steps to re-run the SmartApp setup if credentials change.
4. **Deployment**:
   - Deploy backend with new endpoint.
   - Redeploy SmartApp (install/update) to trigger subscription creation.
   - Monitor logs for initial events/pings.

### 4.8 Testing Plan

1. **Local Simulation**:
   - Use SmartThings CLI (`smartthings events`) or Postman with sample payloads to test signature validation and lifecycle responses.
2. **Integration Sandbox**:
   - Install the SmartApp in a SmartThings test location.
   - Trigger device actions (turn lights on/off) and confirm events appear in logs and UI.
3. **Regression**:
   - Verify WebSocket/SSE clients receive updates without page refresh.
   - Ensure fallback polling still works by disabling webhook temporarily.

### 4.9 Monitoring & Alerting

- Log levels:
  - Info-level logs when subscriptions (re)created or expired.
  - Debug-level logs for event payloads (guard behind opt-in to avoid noise).
  - Warning on signature failures or repeated HTTP errors.
- Metrics (future):
  - Count of events processed per capability.
  - Latency from event receipt to emitter broadcast.
- Alerts:
  - No events received within X minutes (possible webhook disruption).
  - Subscription renewal failures.

---

## 5. Timeline Proposal (Rough)

| Phase | Tasks | Est. Effort |
|-------|-------|-------------|
| 1 | Implement webhook endpoint + signature verification + lifecycle scaffolding | 1–2 days |
| 2 | Subscription management (install/update/uninstall flows) | 2–3 days |
| 3 | Event normalization + DB update + emitter integration | 1–2 days |
| 4 | Testing (sandbox install, regression), fallback tuning | 1–2 days |
| 5 | Monitoring, documentation, rollout checklist | 1 day |

---

## 6. Open Questions / Decisions

1. **Subscription granularity**: Subscribe per capability (broader) vs per device (more control, more API calls).
2. **Event store**: Do we need to persist raw events for auditing? Currently plan is stateless aside from state updates.
3. **Schema drift**: Ensure future device types/capabilities can plug into the mapping pipeline easily.
4. **Multi-location support**: If we add multiple SmartThings locations, confirm webhook can differentiate by `locationId`.
5. **Rollback plan**: Document how to revert to pure polling if event pipeline fails (e.g., toggle via environment variable).

---

## 7. Deliverables

- Updated backend with webhook endpoint and subscription logic.
- Documentation for configuring SmartThings developer workspace.
- Migration script (if needed) to store subscription metadata.
- Tests covering lifecycle handlers and event processing.
- Monitoring dashboards/alerts (or at least logging guidance).

---

## 8. Next Steps

1. Schedule SmartThings sandbox validation and coordinate deployment window (app update requires user interaction/approval).
2. Document deployment, alerting runbooks, and rollback procedures now that webhook path is implemented.
3. Implement subscription renewal job / monitoring hook to keep SmartThings subscriptions fresh once sandbox validation passes.
4. Integrate the webhook metrics endpoint into admin dashboards/alerts so operators can visualize the new counters.

---

## 9. Progress Log

- **2025-10-18** - Audited current server implementation: identified `server/services/smartThingsService.js` as the central integration module, `server/routes/smartThingsRoutes.js` for REST endpoints, and confirmed SSE push path via `deviceUpdateEmitter`. Updated next steps to focus on webhook scaffolding and subscription workflows. **Immediate next work (completed same day):** implement `/api/smartthings/webhook` endpoint with signature verification and lifecycle routing.
- **2025-10-18** - Added `/api/smartthings/webhook` route using dedicated webhook service. Implemented HMAC signature verification, lifecycle scaffolding (`PING`, `CONFIGURATION`, `INSTALL`, `UPDATE`, `UNINSTALL`, `EVENT`), and JSON raw-body retention. **Immediate next work:** persist subscription metadata during `INSTALL/UPDATE` and call SmartThings subscription APIs.
- **2025-10-18** - Completed webhook lifecycle persistence: SmartApp `INSTALL`/`UPDATE` now creates capability subscriptions via SmartThings API, stores subscription metadata under `SmartThingsIntegration.webhook`, and `UNINSTALL` clears remote subscriptions plus local state. **Immediate next work:** implement EVENT payload normalization and push updates into `deviceUpdateEmitter`.
- **2025-10-18** - Implemented `EVENT` lifecycle processing: aggregate SmartThings device events, reuse existing normalization to update MongoDB, and emit live updates through `deviceUpdateEmitter`. Adjusted SmartThings polling fallbacks to 60?s intervals for lower churn. **Immediate next work:** layer in webhook observability and comprehensive testing before sandbox validation.
- **2025-10-18** - Added structured webhook observability (JSON logs, metrics counters, stall/signature alerts) and introduced Node-based unit tests for signature verification and event ingestion via `node --test`. Updated `npm test` to execute the suite. **Immediate next work:** run SmartThings sandbox validation and finalize deployment/rollback documentation.
- **2025-10-18** - Exposed authenticated `GET /api/smartthings/webhook/metrics` endpoint to surface webhook counters for operators, building on the new observability plumbing. **Immediate next work:** wire these metrics into dashboards/alerting during rollout prep.

With these steps, HomeBrain can move from a polling-based SmartThings integration to a push-driven model, reducing latency while maintaining resiliency.

# WeatherFlow Tempest support for HomeBrainv2

## Executive summary

This document specifies how to add full entity["company","WeatherFlow-Tempest, Inc.","tempest weather brand"] **Tempest** device support to the **HomeBrainv2** platform (repo: `mefree2098/HomeBrainv2`) with an implementation approach that is reliable, testable, and maintainable (because “easy” is how you end up debugging UDP packets at 2 a.m.).  

**Enabled connectors used for this research:** entity["company","GitHub","code hosting platform"] (only).  

The Tempest ecosystem provides three materially different ingestion paths, each with different fidelity and failure modes:

- **Cloud WebSocket (push, near real-time)**: `wss://ws.weatherflow.com/swd/data?token=...` with message types like `obs_st`, `evt_strike`, and `evt_precip` (recommended primary for real-time ingestion). citeturn1view1turn12search1  
- **Local UDP broadcast (push, LAN-only)**: Hub broadcasts JSON over UDP port `50222` on the local network, with observation/event/status messages including `device_status` and `hub_status` (recommended fallback and/or “local-only mode”). citeturn7view0turn0search0  
- **Cloud REST (pull, metadata + historical)**: endpoints such as `/swd/rest/stations?token=...` (device discovery + firmware), and observation/stat endpoints for backfill and historical storage. citeturn1view0turn13search0  

**Important policy/expectation note:** WeatherFlow explicitly recommends using remote interfaces (REST + WebSocket) as the primary data source; local UDP is presented as an option mainly for off-grid or backup needs. citeturn1view0turn12search2  

### Goals

Build a first-class Tempest integration for HomeBrainv2 that supports:

- **Device discovery** (stations + hub + Tempest device IDs + metadata, including firmware/hardware). citeturn13search0  
- **Real-time ingestion** (observations + rain start + lightning strike events). citeturn1view1turn7view0  
- **Historical storage** (time-series persistence + query APIs + backfill strategy). citeturn14view0turn1view0  
- **Full sensor coverage**: rain, wind, pressure, UV, light (lux + solar radiation), temperature, humidity, lightning events, battery/status, firmware/version. citeturn1view1turn7view0turn13search0  
- **Calibration** (offsets/scaling) implemented in HomeBrain, with documented assumptions (Tempest may apply QC/calibration in their pipeline; HomeBrain-side calibration should be explicit and reversible). citeturn20search5turn1view0  

### Success criteria

A release is “done” when:

- A user can **connect a Tempest account token** (Personal Access Token) and HomeBrain will auto-discover stations/devices and begin ingesting observations within 60 seconds. citeturn1view0turn13search0  
- HomeBrain stores and serves:
  - **Latest readings** for all required measures (with units clearly defined, defaulting to metric from the API). citeturn14view0turn1view1  
  - **Lightning/rain events** as explicit event records, not just counters. citeturn1view1turn7view0  
  - **Historical time-series** queryable by station/device and time range.
- Integration survives common failure modes:
  - Cloud WS disconnects (idle timeout, network flap) and reconnects with backoff. citeturn1view1  
  - REST 4xx/5xx and transient timeouts with safe retry policies.
  - Local UDP packet loss without corrupting state.
- The integration includes a unit + integration test suite and can run in CI.

## HomeBrainv2 architecture baseline and assumptions

### Observed platform patterns in the repo

From repository inspection (via the GitHub connector), HomeBrainv2’s server side follows a familiar structure:

- **Express routes** under `server/routes/*`, mounted in `server/server.js`.
- **Service modules** under `server/services/*` that encapsulate third-party integrations and background sync behavior.
- **MongoDB models** via **Mongoose** (`server/models/*`).
- Real-time-ish updates to clients via an in-process `deviceUpdateEmitter` that emits `devices:update` events when device state changes (used heavily by existing integrations).

A useful reference pattern is the SmartThings integration: it uses a dedicated integration model, a service to encapsulate API interactions + sync logic, and routes for config/test/status and OAuth callback handling.

### Key implementation assumptions to confirm

Because you want this handoff to be executable even if we don’t have perfect internal context, the AI coder should confirm these items before locking code:

- **How the UI consumes devices:** Are “sensor” devices rendered generically, or do we need frontend work to expose new weather metrics in dashboards?  
- **Automations trigger evaluation:** The repo defines automation trigger types including `sensor` and `weather`, but the runtime engine for evaluating those triggers is not fully identified here. Confirm how sensor values are referenced (top-level `Device.temperature` vs `Device.properties.*`).  
- **Preferred time-series storage pattern:** If HomeBrain already has a pattern for time-series (not found during the limited repo exploration here), reuse it rather than creating a new collection.

## Tempest capabilities and required feature coverage

### What data is available and how it’s shaped

Tempest uses **compact array-based observation records** where the `type` determines the meaning/order of array elements. citeturn1view1turn7view0  

For Tempest devices (`obs_st`) via WebSocket, the observation array includes (among others): time epoch, wind lull/avg/gust, wind direction, station pressure, air temperature, relative humidity, illuminance (lux), UV index, solar radiation, rain accumulation, precipitation type, lightning distance/count, battery volts, and local daily rain accumulation. citeturn1view1turn12search1  

Tempest also emits discrete events:

- **Rain start** (`evt_precip`) citeturn7view0turn1view1  
- **Lightning strike** (`evt_strike`) with `[timestamp, distance_km, energy]` payload citeturn7view0turn1view1  

Local UDP additionally provides richer diagnostics:

- `device_status` includes uptime, voltage, firmware revision, RSSI, hub RSSI, and a `sensor_status` bitmask describing sensor faults. citeturn7view0  
- `hub_status` includes firmware revision, uptime, RSSI, and reset flags. citeturn7view0  

### Units and “why your numbers won’t match the app”

- WebSocket reference defines units explicitly (m/s, mb, °C, lux, W/m², mm, km, volts). citeturn1view1turn12search1  
- Community guidance indicates the **`obs` array is always metric**, while “selected units” elsewhere may reflect UI preferences. citeturn14view0  
- entity["organization","Home Assistant","open source home automation"] notes you may see slight deviations vs the WeatherFlow app because the app blends forecasts/neighbor station modeling, while local integrations typically use raw/local data only. citeturn16view0  

HomeBrain should therefore:
- Store raw values in **canonical units** (recommend: metric as provided).
- Convert for UI at display-time if desired.

## Integration design for authentication, ingestion, and transport choices

### Authentication options

Tempest supports two broad approaches for cloud access:

#### Personal Access Token

Best for “single owner / home setup” and fastest to implement.

- Getting Started docs describe generating a token in the Tempest web app (Settings → Data Authorizations → Create Token). citeturn1view0turn12search2  

**Node example (REST call using axios):**
```js
import axios from "axios";

const token = process.env.TEMPEST_TOKEN;
const url = `https://swd.weatherflow.com/swd/rest/stations?token=${encodeURIComponent(token)}`;

const { data } = await axios.get(url, { timeout: 10000 });
console.log(data);
```

#### OAuth 2.0 (Authorization Code and PKCE)

Recommended if HomeBrain is intended to support multiple users or a polished “Connect Tempest” flow.

- Tempest OAuth supports Authorization Code, plus PKCE for clients that can’t protect a secret. citeturn6view0  
- Authorization request begins at `https://tempestwx.com/authorize.html`. citeturn6view0  
- Token exchange endpoint: `https://swd.weatherflow.com/id/oauth2/token`. citeturn6view0  

**Node example (token exchange):**
```js
import axios from "axios";

async function exchangeCodeForToken({ code, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const { data } = await axios.post(
    "https://swd.weatherflow.com/id/oauth2/token",
    body.toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
  );

  return data; // store access_token + refresh_token if provided
}
```

**Recommendation for HomeBrainv2 default:** Implement **Personal Access Token first**, then add OAuth as a second phase (mirrors how many home platforms ship MVP integrations). This is aligned with Tempest guidance that personal tokens are simplest to get started. citeturn1view0turn12search2  

### Polling vs push vs local UDP

HomeBrain should support all three, but choose a sane default that won’t melt either your server or your patience.

#### Cloud WebSocket push

**Pros**
- Near real-time delivery for observations and events. citeturn1view1turn12search1  
- Avoids 1-minute REST polling loops (and is recommended by community responses for efficiency). citeturn14view0  

**Cons**
- Requires reconnection logic.
- Client disconnected after ~10 minutes idle time; recommended to keep one connection and stay subscribed. citeturn1view1  

**Recommended default** for “real-time sensor ingestion.”

**Node example (ws subscription):**
```js
import WebSocket from "ws";

const token = process.env.TEMPEST_TOKEN;
const ws = new WebSocket(`wss://ws.weatherflow.com/swd/data?token=${encodeURIComponent(token)}`);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "listen_start", device_id: 62009, id: "homebrain-listen-st" }));
  ws.send(JSON.stringify({ type: "listen_rapid_start", device_id: 62009, id: "homebrain-rapid" }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  // msg.type: obs_st | rapid_wind | evt_strike | evt_precip | ack | ...
});
```

#### Cloud REST polling

**Pros**
- Simple, predictable.
- Useful for discovery and backfill; community confirms 1-minute cadence is “fine” for station endpoint use. citeturn14view0turn1view0  

**Cons**
- Increased API traffic; unknown explicit numeric rate limits for personal tier (policy describes “rate/volume limits enough for personal use” but doesn’t publish fixed numbers). citeturn12search0  
- Harder to capture sub-minute wind (rapid) data; REST historically may not expose high-resolution data. citeturn14view0  

**Recommended use**: discovery + historical backfill + periodic sanity checks (e.g., every 5–15 minutes) rather than primary real-time.

#### Local UDP broadcast

**Pros**
- Local push; works even with internet down (true local mode).
- Includes `device_status` / `hub_status` diagnostics not always available via cloud. citeturn7view0  
- Proven approach in Home Assistant’s “WeatherFlow” local integration, which relies on UDP `50222`. citeturn16view0turn15search0  

**Cons**
- Requires same subnet / routing for broadcast; VLANs can break it (Home Assistant calls this out explicitly). citeturn16view0  
- No Nearcast/QC augmentation: Tempest recommends remote interfaces as primary for “best data,” using UDP as backup. citeturn1view0turn12search2  

**Recommended use**: optional “local mode” and fallback for diagnostics + continuity.

### Recommended default strategy

HomeBrain Tempest integration should implement:

1. **REST discovery** on configuration save + daily refresh:
   - `GET /stations?token=...` to enumerate stations and devices and update firmware/hardware metadata. citeturn1view0turn13search0  
2. **Cloud WebSocket** long-lived connection for:
   - `obs_st` (minute interval),  
   - `rapid_wind` (3-second),  
   - `evt_precip`, `evt_strike`. citeturn1view1turn12search1  
3. **Historical backfill** job (REST) to cover missed windows after downtime.
4. **Optional UDP listener** (feature flag) to ingest local-only updates and diagnostics. citeturn7view0turn16view0  

## API endpoints, sample payloads, and HomeBrain data model mapping

### Tempest REST endpoints used by HomeBrain

HomeBrain should treat these as the minimum viable REST surface:

- **List stations + connected devices (discovery)**  
  `GET https://swd.weatherflow.com/swd/rest/stations?token=...` citeturn1view0turn13search0  

- **Latest station observation (federated station view)**  
  `GET https://swd.weatherflow.com/swd/rest/observations/station/{station_id}?token=...` (referenced commonly in community discussions). citeturn14view0  

- **Device observation + historical queries**  
  Community examples show `GET .../observations/device/{device_id}?day_offset=0&...&token=...`. citeturn13search0  

Because the Swagger explorer page is JS-driven and not reliably parseable here, the implementation should:
- Start with “latest” reads.
- Add backfill via `day_offset`, `time_start`, `time_end` once confirmed in the live API docs during coding (do not guess query parameters in production code).

### WebSocket message types HomeBrain must handle

Per WebSocket reference, HomeBrain must parse and route:

- `obs_st`, `obs_air`, `obs_sky` (depending on device type)  
- `rapid_wind`  
- `evt_precip`, `evt_strike`  
- `ack` citeturn1view1turn12search1  

### UDP message types HomeBrain must handle

Per UDP reference (v105 shown), HomeBrain must parse:

- `obs_air`, `obs_sky`, `rapid_wind`, `evt_precip`, `evt_strike`  
- `device_status`, `hub_status` citeturn7view0turn0search0  

### Proposed HomeBrain data model

HomeBrain’s existing `Device` collection stores “latest state.” Tempest requires both **latest state** and **history**.

#### Latest state: reuse `Device`

Create one “station device” plus optional “child metric devices,” depending on how HomeBrain UI/automations are implemented.

**Recommended MVP mapping (simplest, low UI friction):**
- Create **one `Device` record per Tempest station**:
  - `type`: `"sensor"`
  - `name`: station name (e.g., “Backyard Tempest”)
  - `room`: configurable (default “Outside”)
  - `properties.source`: `"tempest"`
  - `properties.tempest.stationId`, `properties.tempest.deviceId`, `properties.tempest.hubDeviceId`, `serial_number`, etc.
  - Store latest metrics in `properties.tempest.metrics.*`

If HomeBrain’s automation engine expects top-level fields:
- Map `temperature` to `Device.temperature` for compatibility.
- Consider adding `properties.humidity` and `properties.pressure` for triggers (confirm runtime engine requirements).

#### History: add new collections

Add two Mongo collections:

- `TempestObservation` (time-series)
  - Partition key: `{ stationId, deviceId }`
  - `observedAt` (Date derived from epoch)
  - `metrics` object (canonical, metric)
  - `source` enum: `ws|rest|udp`
  - `raw` (optional, for debugging)  

- `TempestEvent`
  - `type`: `lightning_strike|precip_start`
  - `eventAt` (Date)
  - `payload` (distance_km, energy, etc.)
  - Links to station/device

This gives clean semantics: **observations are continuous**, **events are discrete**.

### Mapping table: Tempest `obs_st` → HomeBrain fields

All fields below are from the Tempest WebSocket `obs_st` layout. citeturn1view1turn12search1  

| Tempest message | Array index | Meaning | Units | HomeBrain target (suggested) |
|---|---:|---|---|---|
| `obs_st.obs[]` | 0 | Time epoch | seconds | `TempestObservation.observedAt`, `Device.lastSeen` |
|  | 1 | Wind lull | m/s | `properties.tempest.metrics.wind_lull_mps` |
|  | 2 | Wind avg | m/s | `properties.tempest.metrics.wind_avg_mps` |
|  | 3 | Wind gust | m/s | `properties.tempest.metrics.wind_gust_mps` |
|  | 4 | Wind direction | degrees | `properties.tempest.metrics.wind_direction_deg` |
|  | 6 | Station pressure | mb | `properties.tempest.metrics.pressure_mb` |
|  | 7 | Air temperature | °C | `properties.tempest.metrics.temp_c` and `Device.temperature` (converted if HomeBrain uses °F elsewhere) |
|  | 8 | Relative humidity | % | `properties.tempest.metrics.humidity_pct` |
|  | 9 | Illuminance | lux | `properties.tempest.metrics.illuminance_lux` |
|  | 10 | UV | index | `properties.tempest.metrics.uv_index` |
|  | 11 | Solar radiation | W/m² | `properties.tempest.metrics.solar_radiation_wm2` |
|  | 12 | Rain accumulated | mm (prev minute) | `properties.tempest.metrics.rain_mm_last_minute` |
|  | 13 | Precip type | enum | `properties.tempest.metrics.precip_type` |
|  | 14 | Lightning avg distance | km | `properties.tempest.metrics.lightning_avg_distance_km` |
|  | 15 | Lightning count | count | `properties.tempest.metrics.lightning_count` |
|  | 16 | Battery | volts | `properties.tempest.metrics.battery_volts` |
|  | 17 | Report interval | minutes | `properties.tempest.metrics.report_interval_min` |
|  | 18 | Local daily rain | mm | `properties.tempest.metrics.rain_mm_today` |
|  | 19–21 | “final” + analysis type | varies | `properties.tempest.metrics.*` (store raw; interpret later) |

### Derived metrics (optional but strongly recommended)

Tempest publishes derived metric formulas including dew point, feels like, pressure trend, rain rate interpretations, etc. citeturn5view0turn12search4  

HomeBrain can compute and store these as:

- `properties.tempest.derived.dew_point_c`
- `properties.tempest.derived.feels_like_c`
- `properties.tempest.derived.pressure_trend` (steady/rising/falling)
- `properties.tempest.derived.rain_rate_mm_per_hr`

This aligns with what Home Assistant surfaces for WeatherFlow UDP integrations (dew point, feels like, precipitation intensity, vapor pressure, wet bulb, etc.). citeturn16view0turn15search0  

### Calibration design

WeatherFlow indicates they may apply QC and calibration corrections in their processing center. citeturn20search5  

HomeBrain-side calibration should therefore be implemented as **explicit user-defined offsets** (not silent “corrections”), for example:

- `temp_offset_c`
- `humidity_offset_pct`
- `pressure_offset_mb`
- `wind_speed_multiplier`
- `rain_multiplier` (dangerous; document clearly)

Calibration should be applied **after parsing** but **before persistence** (so both latest state and history reflect user-calibrated values). Persist raw payloads (or at least raw metrics) to allow reprocessing.

## Local integration design, MQTT/Home Assistant bridge patterns, SmartThings notes, and operational concerns

### Local UDP listener design

**Networking:** Hub broadcasts UDP on port `50222`. citeturn7view0turn16view0  

**Design goals**
- Non-blocking UDP listener (Node `dgram`)
- Fast parse + enqueue → do not do DB writes inside the UDP message callback (backpressure matters)
- Default to “listen on all interfaces,” with config override for bind address

**Pseudocode**
```js
import dgram from "dgram";

export function startTempestUdpListener({ port = 50222, bindAddress = "0.0.0.0", onMessage }) {
  const socket = dgram.createSocket("udp4");

  socket.on("message", (buf, rinfo) => {
    try {
      const msg = JSON.parse(buf.toString("utf8"));
      // msg.type: obs_st | obs_air | obs_sky | rapid_wind | evt_strike | evt_precip | device_status | hub_status
      onMessage(msg, { rinfo });
    } catch (e) {
      // log + metric
    }
  });

  socket.bind(port, bindAddress, () => {
    socket.setBroadcast(true);
  });

  return () => socket.close();
}
```

**Key parser requirements**
- Validate `type`
- Validate payload arrays lengths before indexing
- Normalize timestamps (epoch seconds → JS Date)
- Interpret `sensor_status` bitmask for health reporting. citeturn7view0  

### MQTT and Home Assistant bridge patterns

There are two common patterns:

#### Pattern A: HomeBrain publishes to MQTT in a stable schema

Add optional dependency `mqtt` and publish:

- `homebrain/tempest/{stationId}/state` (latest snapshot JSON)
- `homebrain/tempest/{stationId}/event/lightning`
- `homebrain/tempest/{stationId}/event/precip_start`

Optionally support retained messages for state topics.

#### Pattern B: Home Assistant MQTT Discovery

If you want Home Assistant to auto-create entities, publish discovery configs to:

- `homeassistant/sensor/{stationId}_{metric}/config`

This requires careful unique IDs, device info blocks, and unit-of-measurement definitions. (If you do this, please don’t freestyle units. Home Assistant will remember and then haunt you.)

If HomeBrain only needs to interoperate with Home Assistant, note that Home Assistant already supports WeatherFlow local UDP and cloud integrations; HomeBrain’s value-add is consolidation, history, and automations across ecosystems. citeturn16view0turn15search0  

### SmartThings compatibility notes

SmartThings support is a recurring community request; practical implementations often require a **local proxy/bridge** because SmartThings cannot freely make outbound HTTP requests, per community guidance. citeturn22search1turn22search7  

For HomeBrain specifically, there are three realistic options:

1. **Do nothing special**: Tempest data lives in HomeBrain; automations run in HomeBrain. (Fastest, lowest risk.)
2. **Bridge via MQTT → SmartThings (Edge driver)**: If the user already runs a local Edge bridge/server, HomeBrain can publish to MQTT and the Edge bridge maps MQTT topics to SmartThings capabilities. (Most maintainable long-term; still “advanced user” territory.) citeturn22search1turn22search8  
3. **SmartThings virtual device updating**: Often not feasible via pure cloud API for arbitrary sensor events unless the device/driver supports it. If you pursue this, treat it as a separate project with explicit scope.

Given HomeBrain already has a robust SmartThings integration module, the safest statement is: **Tempest integration is independent**, and SmartThings consumption should be done either via MQTT bridge or by integrating Tempest directly into SmartThings using community Edge drivers where appropriate. citeturn22search1turn22search7  

### Rate limits, retries, backoff, and security

#### Rate/volume expectations

Tempest Remote Data Access Policy describes tiered “rate/volume limits” (personal vs commercial) but does not publish fixed numeric ceilings. citeturn12search0  

Therefore:

- Prefer WebSocket streaming for real-time. citeturn1view1turn14view0  
- Keep REST polling conservative (5–15 minutes for “health check” + explicit backfill jobs after outages).

#### WebSocket reconnection

WebSocket reference notes:
- Only one WS connection should be opened.
- Client disconnected after ~10 minutes idle time. citeturn1view1turn12search1  

Implement:
- Heartbeat/keepalive behavior (or ensure subscriptions keep traffic flowing).
- Exponential backoff with jitter for reconnect.
- Resume subscriptions for all configured device IDs.

#### Error handling patterns

- **REST**:
  - Retry idempotent GETs on timeout/5xx with exponential backoff (max ~3–5 attempts).
  - Do not retry 401/403; mark integration “auth required.”
- **Parsing**:
  - Drop and log malformed messages; do not crash the worker.
- **Storage**:
  - Enforce uniqueness where appropriate (e.g., `{deviceId, observedAt}`) to prevent duplicates on reconnect.
- **Security**:
  - Store tokens encrypted-at-rest if HomeBrain has a mechanism; otherwise, at minimum mask in logs and sanitize in API responses (pattern already used widely in settings sanitization).

#### Policy compliance note

Remote Data Access Policy restricts access to Nearcast data broadly to station owners for personal use, and describes attribution/link-back expectations if rebroadcasting data. HomeBrain should treat Tempest access as “owner-authenticated personal use” and avoid exposing third-party station data. citeturn12search0  

## Testing, deployment/configuration, migration plan, and implementation tickets

### Unit and integration test plan

**Unit tests**
- Parsers:
  - `obs_st` array length validation
  - `rapid_wind` parsing
  - `evt_strike` parsing
  - `device_status` bitmask decoding citeturn7view0turn1view1  
- Calibration:
  - Offsets applied deterministically
  - Raw vs calibrated storage behavior

**Integration tests**
- Mock WebSocket server sending sample frames (obs + events) and asserting:
  - Device record updated
  - Observation inserted
  - Event inserted
- Mock UDP sender to local listener asserting same outcomes
- REST discovery mock verifying station/device creation

**CI steps**
- Add tests under `server/tests/*.test.js` consistent with existing `node --test` usage.

### Deployment and configuration

#### Environment variables (recommended)

- `TEMPEST_ENABLED=true|false`
- `TEMPEST_TOKEN=...` (Personal Access Token)
- `TEMPEST_WS_ENABLED=true|false`
- `TEMPEST_UDP_ENABLED=true|false`
- `TEMPEST_UDP_BIND=0.0.0.0`
- `TEMPEST_UDP_PORT=50222` citeturn7view0turn16view0  
- `TEMPEST_REST_BASE=https://swd.weatherflow.com/swd/rest`
- `TEMPEST_SYNC_INTERVAL_MS=...` (metadata refresh)
- `TEMPEST_BACKFILL_ENABLED=true|false`

#### Config UI fields (admin settings page)

- Enable Tempest integration
- Auth mode: Token vs OAuth (future)
- Token input (masked)
- Selected station(s) and device(s)
- Room assignment for station device
- Calibration offsets
- Enable UDP fallback (with networking warning about VLAN/subnet) citeturn16view0  

### Logging and metrics to collect

At minimum:

- `tempest.ws.connected` gauge
- `tempest.ws.reconnects_total`
- `tempest.ws.last_message_at`
- `tempest.ingest.observations_total` (by source: ws/rest/udp)
- `tempest.ingest.events_total` (by type)
- `tempest.parse.errors_total`
- `tempest.db.write.errors_total`
- `tempest.station.last_observed_epoch` (per station)

Also expose “integration health” endpoint returning:
- last successful REST discovery time
- last obs timestamp per device
- WS connection state
- UDP listener state

### Migration plan

HomeBrain currently uses a separate “dashboard weather” service (e.g., Open-Meteo) for general forecast/current conditions. Tempest integration can coexist:

- Keep Open-Meteo for **forecast** unless you explicitly want Tempest forecast endpoints (scope expansion).
- Use Tempest for **local sensor truth** and automations.
- Optionally: modify dashboard to prefer Tempest temperature/wind/rain if a Tempest station is configured, else fallback to Open-Meteo.

### Estimated implementation tasks and story-sized tickets

| Ticket ID | Title | Description | Acceptance criteria | Est. hours |
|---|---|---|---|---:|
| TST-1 | Tempest integration model | Add `TempestIntegration` model (token storage, enabled flags, station/device selections, calibration config, status fields). | Token stored safely; sanitized API view masks token; DB migration path documented. | 6 |
| TST-2 | REST discovery + device provisioning | Implement `GET /stations?token=...` sync; create/update Device records with station + device metadata including firmware/hardware fields when available. | Station appears as `Device` with `properties.source=tempest`; device IDs stored; firmware fields populated from discovery payload. citeturn13search0 | 8 |
| TST-3 | WebSocket ingestion worker | Add websocket client using existing `ws` dependency; subscribe to configured devices; parse obs/events; update latest device state; write history. | Observations update within 60s; handles `evt_precip`, `evt_strike`, `rapid_wind`; reconnect logic with backoff; single connection rule honored. citeturn1view1 | 14 |
| TST-4 | UDP listener (optional) | Implement UDP listener on port 50222; parse `obs_*`, `rapid_wind`, `evt_*`, `device_status`, `hub_status`. | When enabled, listener ingests messages; device/hub diagnostics stored; VLAN warning included in docs/UI. citeturn7view0turn16view0 | 10 |
| TST-5 | Historical storage schema | Create `TempestObservation` + `TempestEvent` collections; indexing; de-dupe strategy. | Queries by station/time range fast; duplicate inserts prevented on reconnect. | 10 |
| TST-6 | Derived metrics + calibration | Implement dew point, feels like, rain rate, pressure trend + calibration offsets. | Derived metrics match formulas; calibration is configurable and applied consistently. citeturn5view0 | 10 |
| TST-7 | Tempest API routes | Add `/api/tempest/status`, `/api/tempest/configure`, `/api/tempest/test`, `/api/tempest/observations` APIs. | Admin can configure/test; status returns last obs timestamps and health diagnostics. | 8 |
| TST-8 | Backfill job | On startup and after WS reconnect, backfill missing windows via REST device observations (params confirmed during coding). | Gaps after downtime reduced; does not exceed reasonable API call volume; robust retry/backoff. citeturn12search0turn14view0 | 12 |
| TST-9 | Tests + CI | Add unit tests for parsers/calibration; integration tests with mocked WS/UDP; run in CI. | `npm test` passes reliably; key parsing edge cases covered. | 12 |
| TST-10 | Documentation + operator notes | Add docs: setup, networking, units, privacy/policy notes, troubleshooting. | Clear setup instructions; includes policy cautions and subnet/UDP notes. citeturn12search0turn16view0 | 6 |

**Rough total:** ~96 hours (give or take the usual reality tax).

## Prioritized external sources and purchase references

### Prioritized sources

1. WeatherFlow Tempest API Getting Started (auth + REST/WS overview; remote-first recommendation). citeturn1view0turn12search2  
2. WeatherFlow Tempest WebSocket Reference (message types + obs layouts + connection behavior). citeturn1view1turn12search1  
3. WeatherFlow Tempest UDP Reference (port 50222; message types including device/hub status). citeturn7view0turn0search0  
4. Tempest Remote Data Access Policy (personal-use limits + licensing expectations). citeturn12search0  
5. Derived Metric Formulas (dew point, feels like, rain rate, pressure trend). citeturn5view0turn12search4  
6. Home Assistant WeatherFlow integration docs (real-world sensor list + UDP + networking warnings). citeturn16view0turn15search0  
7. Community thread with concrete `/stations?token=...` payload example (practical discovery schema). citeturn13search0  
8. SmartThings community notes about Tempest Edge drivers and proxy requirements (for interoperability expectations). citeturn22search1turn22search7  

### Direct links (copy/paste)

```text
Tempest API Getting Started:
https://weatherflow.github.io/Tempest/api/

Tempest WebSocket Reference:
https://weatherflow.github.io/Tempest/api/ws.html

Tempest UDP Reference (versioned list, choose your target version):
https://weatherflow.github.io/Tempest/api/udp.html
https://weatherflow.github.io/Tempest/api/udp/v105/

Remote Data Access Policy:
https://weatherflow.github.io/Tempest/api/remote-developer-policy.html

OAuth 2.0 Support:
https://weatherflow.github.io/Tempest/api/oauth.html

Derived Metrics:
https://weatherflow.github.io/Tempest/api/derived-metric-formulas.html

Home Assistant WeatherFlow integration:
https://www.home-assistant.io/integrations/weatherflow/

Tempest station purchase (official store):
https://shop.tempest.earth/products/tempest
```

### Amazon purchase link (reference only)

WeatherFlow-Tempest warns that they do **not** have authorized resellers on Amazon (as of Sept 22, 2025), and purchases there may not have warranty coverage. citeturn20search4  

If you still want an Amazon entry point for comparison only:

```text
https://www.amazon.com/s?k=WeatherFlow+Tempest
```
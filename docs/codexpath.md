# Codex Path Integration Playbook (Production Notes)

This document captures a full, working implementation pattern for adding a **Codex subscription path** (via `codex app-server`) alongside the normal **OpenAI API key path**, including a **Codex-backed model picker**.

Use this when you want an AI coder to implement the same capability quickly in another project.

Critical architecture fact:

- There is **no separate hosted "Codex backend service"** in this pattern.
- Your app backend is the Codex host and must be able to run `codex app-server` itself.

---

## 1) Target outcome

Implement two chat auth paths in the same app:

1. `apiKey` mode (existing OpenAI API key flow)
2. `codexPath` mode (Codex app-server + ChatGPT-managed login)

Both modes should:

- use the same app prompt logic/system instructions
- return the same app-level payload shape (`assistantMessage`, `actions`, etc.)
- preserve existing behavior where possible

Codex mode should additionally support:

- managed login via `account/login/start { type: "chatgpt" }`
- model discovery via `model/list` (for UI model picker)

---

## 2) Configuration contract you should store

For a persisted config object (example path: `ai.adminAssistant.openai`), add:

```json
{
  "authMode": "apiKey | codexPath",
  "apiKey": "optional-secret",
  "hasApiKey": true,
  "clearApiKey": false,
  "codexPath": "optional path to binary, fallback to bundled `@openai/codex` (then `codex`)",
  "codexHome": "optional isolated state directory",
  "codexHomeProfile": "auto | azure | aws | local | custom",
  "codexAwsVolumeRoot": "optional AWS persistent volume mount root (for aws profile, e.g. /mnt/efs)",
  "hasCodexPath": true,
  "model": "mode-specific default model"
}
```

Notes:

- Keep API key hidden/sanitized in read responses.
- Compute `hasApiKey`/`hasCodexPath` flags server-side.
- Trim incoming strings and normalize empty strings to `undefined`.
- Keep legacy API key behavior unchanged.
- If `codexHome` is blank, derive it from `codexHomeProfile` server-side (do not force end users to type filesystem paths).

---

## 3) Request payload contract for chat

Add optional fields to your chat endpoint payload:

```json
{
  "authMode": "apiKey | codexPath",
  "apiKey": "optional",
  "codexPath": "optional",
  "codexHome": "optional",
  "model": "optional",
  "messages": [{ "role": "user|assistant", "content": "..." }],
  "context": {}
}
```

Resolution order that worked well:

1. request field
2. stored config
3. env fallback
4. hard default

Example defaults:

- `authMode`: `apiKey`
- `model`: `gpt-4o-mini` (`apiKey`) / `gpt-5.1-codex` (`codexPath`)
- `codexPath`: `process.env.CODEX_PATH || "codex"` (resolved to bundled `@openai/codex` when available)

Critical implementation rule:

- In admin UIs with unsaved drafts, always send the **current draft auth settings** (`authMode`, `apiKey` when applicable, `codexPath`, `codexHome`, `model`) on each chat request.
- Do not rely only on stored config for chat calls; otherwise model-list/login checks can succeed with draft settings while chat still uses stale saved settings and fails with login-required errors.

---

## 4) Codex app-server lifecycle (exact sequence)

For each request/session:

1. Spawn child process:
   - command: `codex app-server --listen stdio://` (or bundled equivalent from `@openai/codex`)
   - stdio: piped (`stdin`, `stdout`, `stderr`)
   - set `CODEX_HOME` if provided (or derive a writable default)
2. JSONL RPC framing:
   - write one JSON object per line
   - parse stdout by `\n`
3. Handshake:
   - `initialize` request
   - `initialized` notification
4. Auth check:
   - call `account/read { refreshToken: true }`
   - if `requiresOpenaiAuth=true`, call `account/login/start { type: "chatgpt" }`
   - surface `authUrl` to UI/API caller
   - note: returned `authUrl` uses `redirect_uri=http://localhost:<port>/auth/callback` by design
   - important: for ChatGPT-managed auth, do not try to rewrite `redirect_uri` "in flight"; treat returned `authUrl` as authoritative and use callback relay completion
5. Thread + turn:
   - `thread/start` with model/cwd/etc.
   - `turn/start` with input + model + output schema (if needed)
6. Stream notifications and collect final output
7. Close process cleanly (then hard-kill timeout fallback)

---

## 5) JSON-RPC routing rules (must implement)

Your router must separate:

1. **Response**: has `id`, no `method`
2. **Notification**: has `method`, no `id`
3. **Server request**: has `id` and `method` (you must respond)

If you do not answer server requests, turns can hang.

---

## 6) Server-initiated request handling strategy

For a safe "chat-only" integration where you do not want Codex executing tools/commands/files, explicitly respond with deny/cancel shapes.

This worked reliably:

- `item/commandExecution/requestApproval` -> `{ decision: "cancel" }`
- `item/fileChange/requestApproval` -> `{ decision: "cancel" }`
- `execCommandApproval` -> `{ decision: "abort" }`
- `applyPatchApproval` -> `{ decision: "abort" }`
- `item/tool/requestUserInput` -> `{ answers: {} }`
- `item/tool/call` -> `{ success: false, contentItems: [{ type: "inputText", text: "Tool calls are disabled..." }] }`
- `account/chatgptAuthTokens/refresh` -> JSON-RPC error (unsupported for this integration)

Return `-32601` for unknown server-request methods.

---

## 7) Streaming + final answer extraction

Watch these notifications:

- `item/agentMessage/delta` -> incremental assistant text
- `item/completed` -> final item snapshots
- `turn/completed` -> terminal turn status
- `thread/tokenUsage/updated` -> usage accounting

Recommended final-text precedence:

1. `item/completed` `agentMessage` with `phase="final_answer"`
2. latest `agentMessage` text from `item/completed`
3. concatenated delta stream text

Handle terminal statuses:

- `completed` -> success
- `failed` -> surface `turn.error.message`
- `interrupted` -> treat as canceled failure

---

## 8) Important model compatibility pitfalls found in real testing

Do **not** assume all models accept all turn options.

Real failure observed:

- `summary: "concise"` rejected for `gpt-5.1-codex` in our run

Guidance:

- avoid hardcoding optional fields like `summary` and `personality` unless you verified compatibility
- start minimal (`model`, `input`, `effort`, sandbox/approval policy) and add options carefully

---

## 9) Model picker via Codex `model/list`

### 9.1 Backend

Use `model/list` with pagination:

```json
{
  "method": "model/list",
  "params": { "cursor": null, "includeHidden": false, "limit": 100 }
}
```

Response shape includes:

- `data[]` with `id`, `model`, `displayName`, `description`, `hidden`, `isDefault`, etc.
- `nextCursor` for pagination

Implement a dedicated API endpoint, for example:

- `GET /api/ai/codex-models`
- optional query params:
  - `codexPath`
  - `codexHome`
  - `includeHidden`
  - `startLogin` (explicitly starts a pending login relay session)
- `POST /api/ai/codex-login/complete` for pasted localhost callback URL relay
  - `loginId` should be optional in request payload; use it when available for in-memory relay, but support callback-only completion when missing/stale
  - in multi-worker deployments, persist ephemeral relay session/task docs in shared storage (for example Cosmos) so completion can be handed back to the owning worker
- `GET /api/ai/codex-auth-health` for auth persistence diagnostics
  - should return effective `codexPath`/`codexHome`, auth status, optional account identity fields, optional model probe count, and worker instance identifiers

Return a simple UI-ready shape:

```json
{
  "source": "codex",
  "includeHidden": false,
  "loginRequired": false,
  "authUrl": null,
  "models": []
}
```

If login is required, return:

```json
{
  "loginRequired": true,
  "authUrl": "https://..."
}
```

### 9.2 Frontend picker behavior

When `authMode === "codexPath"`:

- render a model `<select>` populated from `/api/ai/codex-models`
- show a "Refresh model list" button
- show a "Check auth persistence" button that calls `/api/ai/codex-auth-health` and displays worker/path/auth diagnostics
- if `loginRequired`, show clickable login URL
- always show an explicit primary button: **"Sign in to OpenAI"** (do not hide login behind errors)
- for "Sign in to OpenAI", always call backend with explicit `startLogin=1` first (do not rely only on an older cached login URL)
- ensure frontend cache/query keys for Codex model/login data include (`authMode`, `codexPath`, `codexHome`) to avoid stale login/model state in UI
- if browser popup is blocked, keep a plain clickable **Open login URL** link as fallback and preserve callback paste flow
- render a **deployment profile selector** for Codex home path (`auto`, `azure`, `aws`, `local`, `custom`)
- auto-populate `codexHome` from selected profile (only editable in `custom`)
- for `aws` profile, show an extra input for persistent volume root and derive `codexHome` from it
- auto-select `isDefault` model if current model is missing
- keep a fallback "custom current model" option if persisted model is not in list

When `authMode === "apiKey"`:

- keep existing free-text model input

### 9.3 Explicit login UX requirement (required)

Do not rely on users seeing a background error or implicit login prompt.

In Codex mode, the UI must include a visible login control:

- Button label: `Sign in to OpenAI`
- On click:
  1. call `/api/ai/codex-models` (or equivalent backend probe)
  2. if `loginRequired=true` and `authUrl` exists, open `authUrl` in a new browser tab/window
  3. if models are returned, show "already connected" status
  4. if neither happens, show a clear actionable error (path/home misconfig, process launch failure, etc.)

For hosted web apps, add explicit localhost-callback completion UX:

1. Start login and store a short-lived pending login session server-side (same process instance).
2. If browser lands on `http://localhost:.../auth/callback` and fails, tell the user to copy that full URL.
3. Provide a `Complete login` action that posts the pasted URL back to your backend.
4. Do not require pending login id on the client; allow callback-only completion attempts.
5. Backend should try relay completion first when pending id exists:
   - forward `code/state` to the pending session callback URL
   - wait for `account/login/completed`
   - then verify authenticated state via `account/read` before returning success (do not trust `account/updated` alone)
6. If relay completion fails, fallback to callback-only completion:
   - direct localhost callback forward + auth verification via `account/read`
   - replay fallback: start a fresh Codex login listener and replay pasted callback params into that listener
7. Keep pending session alive on recoverable callback errors (for example callback HTTP 400 or completion timeout) so users can retry without restarting login.
8. If owner matching fails for pending login lookup, allow login-key fallback lookup (UUID is unguessable and avoids false mismatches).
9. For multi-worker hosting, add cross-instance completion coordination:
   - on login start, persist a session locator doc (`loginKey -> owning instance`) in shared storage
   - if complete hits a different worker and local pending map misses, enqueue a completion task in shared storage
   - the owning instance (holding the live Codex process) polls and executes the task, then writes success/error status
   - the complete endpoint waits on task result and returns the owning-instance outcome
10. Refresh model list after completion.

Recommended copy in Codex mode:

- status line should say whether auth mode/path changes are saved yet
- show a short instruction near the button (example: "Click Sign in to OpenAI to connect Codex subscription")

---

## 10) Dual-path behavior recommendations

1. Keep API-key path untouched; only branch behavior by `authMode`.
2. Keep a common prompt builder/system instruction path for both modes.
3. Keep output parsing identical across modes.
4. Keep usage accounting if possible for both modes.
5. If your app has other AI features that still require API key (for example images), say that clearly in UI.

---

## 11) Timeouts and diagnostics that help in production

Useful env vars:

- `CODEX_PATH`
- `CODEX_HOME`
- `CODEX_RPC_TIMEOUT_MS` (request/response timeout)
- `CODEX_TURN_TIMEOUT_MS` (turn completion timeout)
- `CODEX_LOGIN_TTL_MS` (pending login relay lifetime)
- `CODEX_LOGIN_COMPLETE_TIMEOUT_MS` (wait budget for login completion relay)
- app-level override (example): `CODEX_TIMEOUT_MS`

Capture a stderr tail from Codex process and append it to errors for easier debugging.

If you deploy with multiple workers/instances, ensure the cross-instance login relay storage is available (shared DB/container). Without it, `start`/`complete` can land on different workers and fail with "No pending session".

Use `account/read { refreshToken: true }` in managed ChatGPT auth checks. Using `refreshToken: false` can create false "login required" behavior after worker recycle/restart even when refreshable login state exists.

### 11.1 Runtime packaging requirement (required)

To make this work in hosted deployments, do not rely on a global system install of `codex`.

Required approach:

1. Add `@openai/codex` as a dependency of the backend package.
2. At runtime, resolve `@openai/codex/bin/codex.js` and spawn via `node <resolved-script> app-server --listen stdio://`.
3. Keep `CODEX_PATH` override support for explicit custom binaries, but default to bundled runtime when possible.

If you skip this, hosted environments often fail with "unable to start login" because `codex` is not on server PATH.

### 11.2 `CODEX_HOME` defaulting (required)

If `CODEX_HOME`/`codexHome` is not explicitly set:

1. Pick a writable server path automatically (for Azure Linux, prefer `/home/site/.codex/...`).
2. Create the directory before spawning Codex.
3. Include resolved `CODEX_HOME` in diagnostics.

This avoids startup/auth failures caused by unwritable home directories.

Hosted deployment reminder:

- `codexPath` in the admin UI refers to the **server filesystem path** (API runtime), not the admin user's local machine.
- You must ensure the server can execute Codex (bundle/install runtime) and set `CODEX_PATH` only when overriding defaults.
- For Azure-hosted Linux apps, use a writable persistent location for `CODEX_HOME` (for example under `/home/...`), otherwise login state may not persist.
- If you implement localhost callback relay, keep the pending login process alive long enough for callback completion and use a short TTL + cleanup.
- If a completion attempt fails with callback status `400`, do not immediately destroy pending session state; this frequently represents a retryable copy/paste mismatch.

---

## 12) Security and state rules

- Do not parse or copy OAuth tokens yourself in managed ChatGPT mode.
- Let Codex own auth storage and refresh lifecycle.
- Isolate `CODEX_HOME` per user/app installation to avoid collisions with terminal Codex state.
- Sanitize secrets from config read APIs.

---

## 13) Minimal integration checklist (copy this into tickets)

1. Add config fields (`authMode`, `codexPath`, `codexHome`, flags).
2. Add Codex app-server client module (spawn + JSONL + router + handshake + auth + turn).
3. Add chat-mode switch in backend (`apiKey` vs `codexPath`).
4. Add model-list backend endpoint using `model/list` plus explicit `startLogin` support.
5. Add login completion endpoint for pasted localhost callback relay.
6. Add frontend auth-mode control + codex path/home inputs.
7. Add codex model picker + refresh + **explicit Sign in to OpenAI button** + login-required UX.
8. Add callback paste + `Complete login` UX for hosted deployments.
9. Keep API-key mode and non-Codex features intact.
10. Add build/lint + live smoke tests for:
   - chat via codex path
   - model/list via codex path

---

## 14) Smoke tests that validated this implementation

### Chat smoke test (codex path)

- invoke codex-backed chat with strict JSON output schema
- verify non-empty assistant result + usage capture

### Model-list smoke test

- call `listCodexModels({ codexPath: "codex" })`
- verify `count > 0` and expected fields

---

## 15) Known tradeoff in this implementation pattern

This pattern spawns a fresh `codex app-server` process per request/session for simplicity and isolation.

Pros:

- easy lifecycle management
- minimal cross-request state bugs

Cons:

- extra process startup overhead

For higher throughput, move to a pooled or persistent session host with stronger concurrency controls.

---

## 16) Failure mode postmortem (what failed in production and exact fix)

This section is the "do not rediscover this" list.

### 16.1 "Unable to start Codex login right now"

Observed:

- Login button did not produce usable login flow.
- Backend reported Codex start failures.

Root cause:

- Hosted backend could not execute `codex` from PATH.

Fix:

1. Add `@openai/codex` as backend dependency.
2. Resolve and spawn bundled entrypoint `@openai/codex/bin/codex.js` via Node.
3. Keep explicit `CODEX_PATH` override support, but prefer bundled launch.

### 16.2 Login redirects to localhost and browser shows connection refused

Observed:

- User successfully signs in to OpenAI, then browser lands on `http://localhost:1455/auth/callback?...` and fails.

Root cause:

- ChatGPT-managed Codex login callback is local to the server process hosting app-server, not the end-user browser machine.

Fix:

1. Keep explicit "paste localhost callback URL" input.
2. Add `POST /api/ai/codex-login/complete` to relay pasted callback params to the server-side pending login listener.
3. Support callback-only completion fallback (no pending id required).

### 16.3 "No pending Codex login session found. Start login again."

Observed:

- Completion failed even with a valid callback URL.

Root causes:

- Start and complete requests could hit different workers/instances.
- Pending login map existed only in memory of the owning worker.

Fix:

1. Persist `codex-login-session:<loginKey>` docs in shared storage.
2. Persist `codex-login-task:<loginKey>` docs for cross-instance completion requests.
3. Run remote task pump on owning worker to execute callback relay and write success/error task result.
4. Keep pending login alive for retryable errors (`status 400`, timeout, missing code/state).
5. Allow login-key fallback lookup even when strict owner match misses.

### 16.4 Login claims success, model list does not update/stays stale

Observed:

- UI showed success alert, but model list did not reflect new state.

Root cause:

- React Query cache update used a different key from the active model query.

Fix:

1. Use one shared key including `authMode`, `codexPath`, and `codexHome`.
2. Use that exact key for both query and `setQueryData`.

### 16.5 Model list works, but chat still says "Codex subscription login is required"

Observed:

- `/ai/codex-models` returned models.
- `/ai/chat` still returned login-required URL.

Root causes:

- Chat request path used stale saved settings while model/login checks used current draft settings.
- Auth checks were using `account/read { refreshToken: false }`, which can report not-authenticated after worker recycle even when refreshable session exists.

Fix:

1. In frontend chat send path, always pass live `authMode`, `codexPath`, `codexHome`, `model` (and inline API key when in API-key mode).
2. Switch managed-auth account checks to `refreshToken: true` for chat/login/probe verification paths.

### 16.6 End-user friction from manual Codex home path

Observed:

- Requiring user to understand storage paths caused setup failures.

Fix:

1. Add deployment profile selector: `auto`, `azure`, `aws`, `local`, `custom`.
2. Auto-derive `codexHome` for non-custom profiles.
3. For AWS profile, ask only for mount root and derive rest.
4. Keep custom mode for advanced overrides only.

### 16.7 Popup blocked during login

Observed:

- `window.open` blocked by browser popup settings.

Fix:

1. Keep explicit clickable login anchor ("Open login URL").
2. Keep callback paste/complete flow independent of popup success.

---

## 17) Persistence behavior across deploys/restarts

### 17.1 What persists

- Codex login state persists if `CODEX_HOME` points to persistent storage and that same path is used by subsequent workers.
- For Azure App Service Linux in this implementation, `/home/site/.codex/ntechr` is the intended persistent location.
- For AWS deployments, use a shared persistent volume path (for example EFS) and set profile/root accordingly.

### 17.2 What does not persist

- In-memory pending login sessions do not survive worker recycle or redeploy.
- Instance-local temporary directories do not provide reliable cross-deploy persistence.

### 17.3 Practical rule for CI/CD deploys (e.g., GitHub Actions -> Azure)

1. Keep `codexHomeProfile` set to a persistent profile (`azure` or `aws`) and save settings.
2. Ensure backend continues to resolve to the same effective `codexHome`.
3. Use auth health endpoint to verify active worker and resolved home path after deployment.
4. If storage path changes, login must be re-established.

---

## 18) Exact implementation map (files/endpoints/UI)

### 18.1 Backend endpoints required

- `POST /api/ai/chat`
- `GET /api/ai/codex-models`
- `POST /api/ai/codex-login/complete`
- `GET /api/ai/codex-auth-health`

### 18.2 Backend modules required

- Codex app-server runner:
  - process spawn + JSONL routing + request/notification handling
  - auth check + login start + model list + turn execution
  - callback relay completion and callback-only fallback completion
  - cross-instance relay coordination (session/task docs in shared storage)
- Codex home profile resolver:
  - `auto/azure/aws/local/custom` -> effective codex home path

### 18.3 Frontend behaviors required

- Auth mode switch (`apiKey` vs `codexPath`)
- Codex model picker + refresh
- Explicit `Sign in to OpenAI` action
- Fallback `Open login URL` anchor
- Callback URL paste + `Complete login`
- Auth persistence check button (health endpoint)
- Deployment profile selector with auto-populated codex home
- Chat send path that includes live auth settings in payload

### 18.4 Validation checklist before shipping

1. Switch to Codex mode and confirm model list loads.
2. Trigger login from UI and complete callback flow.
3. Refresh model list and confirm non-empty models.
4. Send chat request and confirm no login-required error.
5. Run auth health and confirm:
   - authenticated=true
   - expected codexHome
   - expected worker instance details
6. Redeploy and re-test chat without re-login to verify persistence.

### 18.5 File map from this implementation

- Backend:
  - `api/src/codex/appServer.ts`
  - `api/src/codex/homeProfile.ts`
  - `api/src/http/ai-chat.ts`
  - `api/src/http/ai-codex-models.ts`
  - `api/src/http/ai-codex-login-complete.ts`
  - `api/src/http/ai-codex-auth-health.ts`
  - `api/src/http/config-upsert.ts`
  - `api/src/types/content.ts`
  - `api/src/index.ts`
- Frontend:
  - `src/pages/AdminAiAssistant.tsx`
  - `src/lib/api.ts`
  - `src/types/content.ts`

---

## 19) API contracts that should exist (copy/paste reference)

### 19.1 `GET /api/ai/codex-models`

Success:

```json
{
  "source": "codex",
  "includeHidden": false,
  "loginRequired": false,
  "models": [
    {
      "id": "gpt-5.1-codex",
      "model": "gpt-5.1-codex",
      "displayName": "GPT-5.1 Codex",
      "description": "",
      "hidden": false,
      "isDefault": true,
      "supportsPersonality": true,
      "inputModalities": ["text", "image"],
      "supportedReasoningEfforts": []
    }
  ]
}
```

Login required:

```json
{
  "source": "codex",
  "includeHidden": false,
  "loginRequired": true,
  "authUrl": "https://auth.openai.com/oauth/authorize?...redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback...",
  "pendingLoginId": "uuid-when-startLogin-true",
  "callbackHint": "If login lands on localhost and fails, paste that full URL into Complete login.",
  "models": []
}
```

### 19.2 `POST /api/ai/codex-login/complete`

Request:

```json
{
  "loginId": "optional-pending-login-id",
  "callbackUrl": "http://localhost:1455/auth/callback?code=...&state=...",
  "codexPath": "optional",
  "codexHome": "optional"
}
```

Success response:

```json
{ "success": true, "mode": "relay|fallback" }
```

Behavior requirements:

- Try relay completion first when `loginId` is present.
- If relay fails or `loginId` is absent, try callback-only fallback completion.
- Return detailed combined errors when both attempts fail.

### 19.3 `GET /api/ai/codex-auth-health`

Response:

```json
{
  "source": "codex",
  "timestamp": "2026-03-03T00:00:00.000Z",
  "codexPath": "codex",
  "codexHome": "/home/site/.codex/ntechr",
  "authenticated": true,
  "requiresOpenaiAuth": true,
  "loginRequired": false,
  "accountType": "chatgpt",
  "accountEmail": "user@example.com",
  "planType": "pro",
  "modelCount": 6,
  "sampleModels": ["gpt-5.1-codex"],
  "instance": {
    "siteName": "your-site",
    "instanceId": "instance-id",
    "hostname": "hostname",
    "pid": 1234
  }
}
```

---

## 20) Non-negotiable rules (summary)

1. Do not build a separate Codex service; your backend process is the Codex host.
2. Bundle `@openai/codex` in backend runtime; do not depend on global PATH in hosted environments.
3. Use persistent `codexHome` and make profile-based auto defaults.
4. Always provide explicit "Sign in to OpenAI" UX in Codex mode.
5. Expect localhost callback URL and implement callback relay completion.
6. Treat login completion as successful only after account verification, not notification alone.
7. Use `account/read { refreshToken: true }` for managed ChatGPT auth checks.
8. Include live draft auth settings in chat requests.
9. Keep query keys and cache updates consistent for model/login state.
10. Add auth health diagnostics endpoint and expose it in admin UI.

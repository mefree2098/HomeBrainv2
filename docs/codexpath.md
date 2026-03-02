# Codex Path Integration Playbook (Production Notes)

This document captures a full, working implementation pattern for adding a **Codex subscription path** (via `codex app-server`) alongside the normal **OpenAI API key path**, including a **Codex-backed model picker**.

Use this when you want an AI coder to implement the same capability quickly in another project.

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
  "codexPath": "optional path to binary, fallback to `codex`",
  "codexHome": "optional isolated state directory",
  "hasCodexPath": true,
  "model": "mode-specific default model"
}
```

Notes:

- Keep API key hidden/sanitized in read responses.
- Compute `hasApiKey`/`hasCodexPath` flags server-side.
- Trim incoming strings and normalize empty strings to `undefined`.
- Keep legacy API key behavior unchanged.

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
- `codexPath`: `process.env.CODEX_PATH || "codex"`

---

## 4) Codex app-server lifecycle (exact sequence)

For each request/session:

1. Spawn child process:
   - command: `codex app-server --listen stdio://`
   - stdio: piped (`stdin`, `stdout`, `stderr`)
   - set `CODEX_HOME` if provided
2. JSONL RPC framing:
   - write one JSON object per line
   - parse stdout by `\n`
3. Handshake:
   - `initialize` request
   - `initialized` notification
4. Auth check:
   - call `account/read { refreshToken: false }`
   - if `requiresOpenaiAuth=true`, call `account/login/start { type: "chatgpt" }`
   - surface `authUrl` to UI/API caller
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
- if `loginRequired`, show clickable login URL
- always show an explicit primary button: **"Sign in to OpenAI"** (do not hide login behind errors)
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
- app-level override (example): `CODEX_TIMEOUT_MS`

Capture a stderr tail from Codex process and append it to errors for easier debugging.

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
4. Add model-list backend endpoint using `model/list`.
5. Add frontend auth-mode control + codex path/home inputs.
6. Add codex model picker + refresh + **explicit Sign in to OpenAI button** + login-required UX.
7. Keep API-key mode and non-Codex features intact.
8. Add build/lint + live smoke tests for:
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

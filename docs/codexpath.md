0) What you’re building

Your app will:

ship or fetch a platform-specific codex binary (pinned)

launch codex app-server as a long-running child process (stdio transport default)

speak JSON-RPC 2.0 shapes, but “lite”: messages omit "jsonrpc":"2.0" and are framed as newline-delimited JSON (JSONL)

run the ChatGPT-managed login via JSON-RPC (account/login/start type chatgpt) and open the returned authUrl in the user’s browser

create/resume threads (thread/start, thread/resume) and run turns (turn/start) while streaming events (thread/*, turn/*, item/*)

handle server-initiated approval requests (shell commands, file changes, tool calls) by responding with accept/decline/etc

1) Acquire + pin the Codex binary
1.1 Install (dev) / ship (prod)

For development, use the documented Codex CLI install method(s) (npm/Homebrew/etc.) on the Codex CLI page.

For production, do what OpenAI’s own clients do:

bundle the exact platform binary inside your app, OR

download it on first run and pin to a tested version (recommended if you can update server bits independently).

1.2 Decide where codex lives

Pick one canonical location per OS, e.g.:

macOS: your app support dir

Windows: %LOCALAPPDATA%/<YourApp>/codex/

Linux: ~/.local/share/<YourApp>/codex/

Then your launcher always starts that exact binary.

2) Understand state + where credentials live

Codex stores its state under CODEX_HOME (default ~/.codex), including config.toml and auth state (either auth.json or OS keychain/keyring).

What you should do in your app:

set CODEX_HOME explicitly when launching the child process so your app has an isolated Codex state directory per user (and so you don’t collide with the user’s terminal Codex setup).

Example: CODEX_HOME=<app data dir>/codex_home

do not parse or copy tokens yourself in “managed ChatGPT” mode — Codex owns that lifecycle.

3) Generate protocol schemas (so you don’t hand-write the API)

Run these using the same pinned codex binary you will ship:

codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas

This generates artifacts matched to that Codex version.

Why you care: your AI coder can use the JSON schema to generate strongly typed bindings for whichever language your platforms use, instead of guessing method names and payloads.

4) Launch the App Server as a child process (stdio JSONL)
4.1 Start command

The server supports:

stdio:// (default) = newline-delimited JSON messages over stdin/stdout

websocket (experimental)

Use stdio first. Start it like:

codex app-server --listen stdio://

(You can omit --listen because stdio is default.)

4.2 Process management requirements (non-negotiable)

Your app must:

open the child process with piped stdin + stdout (and ideally stderr)

write one JSON object per line to stdin

read stdout as a stream, splitting on \n into JSON objects

Also:

handle restart if the process exits

handle backpressure (stdout can be chatty)

5) Implement the required handshake: initialize → initialized

You cannot call anything else until you initialize. Requests before that get Not initialized.

5.1 Send initialize

Example:

{ "method": "initialize", "id": 0, "params": {
  "clientInfo": { "name": "my_client", "title": "My Client", "version": "1.0.0" },
  "capabilities": { "experimentalApi": false }
}}

clientInfo.name is important for compliance logs identification

you may opt-in to experimental fields by setting experimentalApi: true

you can also suppress noisy notifications per connection using optOutNotificationMethods

5.2 Expect response, then send initialized notification

Flow:

you send request with id

server responds with { "id": 0, "result": ... }

you send notification (no id): { "method": "initialized", "params": {} }

This sequence is explicitly required.

6) Authentication: ChatGPT-managed OAuth via JSON-RPC

You have two routes:

Managed ChatGPT (type:"chatgpt") = Codex runs browser OAuth, stores tokens, refreshes automatically

External tokens (type:"chatgptAuthTokens") = your host app supplies tokens and must refresh them when asked

For what you asked, use managed.

6.1 Check whether login is needed

Send:

{ "method": "account/read", "id": 1, "params": { "refreshToken": false } }

If response shows account: null and requiresOpenaiAuth: true, you need login.

6.2 Start ChatGPT browser login

Send:

{ "method": "account/login/start", "id": 3, "params": { "type": "chatgpt" } }

Server responds with:

loginId

authUrl (open it in the user’s browser; app-server hosts local callback)

6.3 Open the returned authUrl

Your app should:

open system browser to authUrl

show “Waiting for login…” UI state

keep reading stdout events

6.4 Wait for login completion notifications

You’ll receive:

account/login/completed (success/error)

then account/updated with authMode:"chatgpt"

6.5 Optional: device code login (CLI-side)

If you want a headless fallback, Codex supports device code login via CLI (codex login --device-auth) and it requires enabling device code login in ChatGPT security/workspace settings.
(If you’re integrating via app-server, prefer the JSON-RPC login flow above; device code is more of a CLI-first pattern.)

7) Create or resume a thread
7.1 Start a new thread

Send thread/start:

{ "method": "thread/start", "id": 10, "params": {
  "model": "gpt-5.1-codex",
  "cwd": "/path/to/workspace",
  "approvalPolicy": "unlessTrusted",
  "sandbox": "workspaceWrite",
  "personality": "friendly"
}}

Server responds with { thread: { id: "thr_..." } } and emits thread/started.

7.2 Resume an existing thread

Store thread IDs in your app. To resume:

{ "method": "thread/resume", "id": 11, "params": { "threadId": "thr_123" } }

8) Start a turn (send user input) and stream events
8.1 Start a turn

Send:

{ "method": "turn/start", "id": 30, "params": {
  "threadId": "thr_123",
  "input": [ { "type": "text", "text": "Run tests and summarize failures." } ],
  "cwd": "/path/to/workspace",
  "approvalPolicy": "unlessTrusted",
  "sandboxPolicy": { "type": "workspaceWrite", "writableRoots": ["/path/to/workspace"], "networkAccess": true },
  "model": "gpt-5.1-codex",
  "effort": "medium",
  "summary": "concise"
}}

The server responds immediately with the initial turn object, then streams notifications.

8.2 Read streaming notifications (this is the whole point)

After turn/start, keep reading stdout JSONL for:

thread/status/changed

turn/* updates

item/started, item/*/delta, item/completed for message text, tool output, file changes, etc.

Example: text streaming comes through item/agentMessage/delta.

8.3 Steer / interrupt

turn/steer appends user input to the currently running turn

turn/interrupt requests cancellation; turn ends with status interrupted

9) Handle approvals (commands, file changes, tool calls)

Codex may pause mid-turn and send server-initiated JSON-RPC requests to your client to approve an action.

9.1 Detect “waiting on approval”

You may receive:

{ "method": "thread/status/changed", "params": {
  "threadId": "thr_123",
  "status": { "type": "active", "activeFlags": ["waitingOnApproval"] }
}}

9.2 Command execution approval flow

Order: item/started → item/commandExecution/requestApproval → (your decision response) → item/completed.

Valid decision payloads include:

accept

acceptForSession

decline

cancel

or an exec-policy amendment payload

9.3 File change approvals

Order: item/started (fileChange) → item/fileChange/requestApproval → your decision → item/completed.

10) Build your client correctly (message routing rules)

Your JSONL reader must distinguish:

A) Responses to your requests

They contain an id you sent:

{ "id": 30, "result": {...} }
B) Notifications

They have method + params, no id:

{ "method": "item/agentMessage/delta", "params": {...} }
C) Server-initiated requests (IMPORTANT)

They have a method and an id (so you must respond):

{ "method": "item/commandExecution/requestApproval", "id": 9001, "params": {...} }

You must reply:

{ "id": 9001, "result": "accept" }

(Exact shapes are in the generated schemas; don’t freestyle.)

11) Minimal end-to-end “happy path” sequence

Launch codex app-server child process (stdio JSONL)

Send initialize (id=0)

Receive initialize response, send initialized notification

account/read → if needs auth, account/login/start {type:"chatgpt"}

Open authUrl, wait for account/login/completed and account/updated

thread/start (store threadId)

turn/start with text input

Stream item/* notifications and render UI live

If approval request arrives, prompt user → respond with accept/decline

12) What to hand your AI coder (deliverables checklist)

Have them implement these modules:

CodexBinaryManager

resolve pinned version

install/download/bundle logic

CodexProcessHost

spawn process

JSONL writer

JSONL reader (robust framing, buffering, backpressure)

restart + crash handling

JsonRpcRouter

pending requests map (id -> promise)

notification handlers registry (method -> handler)

server-request handlers (method -> handler returns result)

HandshakeManager

initialize + initialized gating

AuthManager

account/read

account/login/start chatgpt

open browser for authUrl

wait for account/login/completed

surface account/rateLimits/read UI optionally

ThreadManager

start/resume/list/read/archive as needed

TurnRunner

start/steer/interrupt

build message timeline from item/started, deltas, item/completed

ApprovalUI + ApprovalResponder

handle item/*/requestApproval server requests and return decision payloads
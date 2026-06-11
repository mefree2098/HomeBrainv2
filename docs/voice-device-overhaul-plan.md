# Voice Device Overhaul Plan

## Goals

- Treat registration codes and claim tokens as short-lived onboarding credentials only.
- Use device tokens for all steady-state device API and websocket authentication.
- Provide a safe redeploy path for stale Raspberry Pi listeners without deleting device history.
- Replace simulated device tests with diagnostics based on hub state, websocket state, heartbeat freshness, onboarding state, update state, and configured capabilities.
- Prefer local AI providers on the LAN for latency and cost, with cloud fallbacks still available.

## Lifecycle

1. Admin creates or reissues a remote listener.
2. HomeBrain generates a registration code plus a claim token with expirations.
3. The generated installer should prefer the claim-token bootstrap URL.
4. The listener activates once and receives a device token.
5. HomeBrain clears registration code and claim-token material after activation.
6. Websocket and device APIs accept device tokens for activated devices.
7. Registration code or claim token credentials are accepted only while the device is unregistered and the credential has not expired.

## Redeploying The Pi5

Use the admin endpoint:

```text
POST /api/remote-devices/:deviceId/onboarding/reissue
```

That endpoint clears the previous device token, marks the listener offline, creates fresh onboarding credentials, and preserves the existing device record. After reissue, run the generated claim-token installer on the Pi.

## Diagnostics

Use either endpoint:

```text
POST /api/voice/test
POST /api/voice/devices/:id/diagnostics
```

The diagnostics response should explain:

- whether the device is activated with a device token
- whether onboarding credentials are active or expired
- whether a websocket is connected and authenticated
- heartbeat age and freshness
- wake-word configuration
- update state and recent update errors

## Local AI Provider Plan

### Speech To Text

Current: `speechService` supports OpenAI transcription and HomeBrain-hosted local Whisper.

Target order:

1. LAN Whisper server on the RTX 2060 host for normal remote-device transcription.
2. HomeBrain-hosted local Whisper as an emergency local fallback.
3. OpenAI transcription when local STT is unavailable or explicitly selected.

Preferred interface: OpenAI-compatible `/v1/audio/transcriptions` on the LAN Whisper host. If the Whisper host exposes a custom API, add a thin adapter in `speechService` instead of coupling voice devices to that host directly.

### Command LLM

Current: `voiceCommandService` already calls `llmService.sendLLMRequestWithFallbackDetailed`, and `Settings` already supports a local LLM endpoint and local-first priority.

Target order:

1. LAN Gemma 4 endpoint through Ollama-compatible or OpenAI-compatible local HTTP.
2. Codex/OpenAI/Anthropic fallbacks based on the configured `llmPriorityList`.
3. Cloud fallback only for malformed local JSON, timeout, or explicit admin choice.

Recommended settings:

```text
localLlmEndpoint=http://<gemma-host>:11434
homebrainLocalLlmModel=gemma4:<tag>
llmPriorityList=local,codex,openai,anthropic
VOICE_COMMAND_ALLOW_CLOUD_FALLBACK=true
```

### Text To Speech

Current: device TTS pings and acknowledgments use ElevenLabs, with local device-side espeak/pico fallback and a HomeBrain Piper service available elsewhere.

Target order:

1. LAN S2 Pro service on the RTX 5090 host for high-quality local generation.
2. Piper for lightweight local fallback and wake-word training data.
3. ElevenLabs as the cloud fallback and voice-quality baseline.
4. Device-side espeak/pico only when no hub TTS provider is reachable.

Preferred interface: a hub-side TTS provider service that normalizes `text`, `voiceId`, `format`, `latencyProfile`, and `cacheKey`, then dispatches to S2 Pro, Piper, or ElevenLabs. Remote devices should keep requesting TTS from HomeBrain rather than knowing which TTS backend was selected.

## Verification

- Unit tests should cover credential expiration, activation cleanup, reissue behavior, update failure status preservation, and diagnostics classification.
- A Pi redeploy should be treated as a live operation: confirm before mutating production device state or restarting services.
- After deploy, verify production websocket connected-device count, `/api/voice/devices`, `/api/voice/status`, and diagnostics for the Pi5.

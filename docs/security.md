# HomeBrain Security Guide

Use this checklist before publishing or operating a public HomeBrain repo.

## Runtime Security Defaults

HomeBrain web sessions use server-set `HttpOnly` cookies. The browser client does not store access or refresh tokens in `localStorage`, does not mirror them into JavaScript-readable cookies, and does not put session tokens in WebSocket or SSE URLs.

The native iOS app remains a bearer-token client because it is not a browser cookie surface. It receives access/refresh tokens in auth JSON responses and uses `Authorization: Bearer ...` for API calls.

Default session lifetime:

- browser access cookie: 1 hour
- browser session/refresh cookie: 30 days
- native iOS refresh session: 365 days

Useful environment overrides in [`../server/.env.example`](../server/.env.example):

```dotenv
AUTH_ACCESS_TOKEN_TTL=1h
AUTH_REFRESH_TOKEN_TTL=30d
AUTH_SESSION_MAX_AGE_DAYS=30
AUTH_IOS_SESSION_MAX_AGE_DAYS=365
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
CORS_ALLOWED_ORIGINS=https://homebrain.example.com
CONTENT_SECURITY_POLICY=
```

For public HTTPS deployments, set `COOKIE_SECURE=true` and use Caddy as the public `80/443` edge. Keep `COOKIE_SAMESITE=lax` unless you have tested every OAuth and SSO redirect path with a stricter value.

## Remote Device Security

Remote listener bootstrap links can use a registration code or a short-lived claim token. After activation, listeners receive a device token and use it in `X-HomeBrain-Device-Token` for device-side APIs.

The following endpoints require device credentials:

- `GET /api/remote-devices/:deviceId/config`
- `POST /api/remote-devices/:deviceId/heartbeat`
- wake-word asset downloads
- remote-device TTS audio

If a listener was installed before device-token support, rerun the generated one-command installer from `Voice Devices` to refresh its config.

## Repository Safety

Before publishing:

```bash
bash scripts/check-secrets.sh --history
```

Expected result:

```text
Secret-safety checks passed.
```

The scanner rejects tracked `.env` files, local databases, private keys/certificates, `.codex-home`, and common secret token patterns. It also verifies ESP32 wall-panel firmware defaults remain placeholders.

## Required GitHub Settings

These settings must be enabled in GitHub repository settings by an owner/admin:

- Secret scanning
- Push protection
- Dependabot alerts
- Dependabot security updates
- Code scanning with CodeQL

This repo also includes:

- [`.github/dependabot.yml`](../.github/dependabot.yml)
- [`.github/workflows/secret-scan.yml`](../.github/workflows/secret-scan.yml)
- [`.github/workflows/dependency-review.yml`](../.github/workflows/dependency-review.yml)
- [`.github/workflows/npm-audit.yml`](../.github/workflows/npm-audit.yml)
- [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml)

## History Cleanup Before Open Source Publication

If old public commits contain `.codex-home` or any other sensitive local state, rewrite history from a mirror clone and coordinate a force-push.

```bash
mkdir -p ~/repo-cleanup
cd ~/repo-cleanup
git clone --mirror <repo-url> HomeBrainv2.git
cp -R HomeBrainv2.git HomeBrainv2.git.backup
cd HomeBrainv2.git

git filter-repo \
  --sensitive-data-removal \
  --invert-paths \
  --path .codex-home \
  --path-glob '.codex-home/**' \
  --path-glob '**/.codex-home/**'

git log --all -- .codex-home
git rev-list --objects --all | grep -E '(^|/)\.codex-home(/|$)' || true
git fsck --full
git push --force --mirror origin
```

After a force-push, every collaborator should reclone or hard-reset to the rewritten `origin/main`. Do not merge branches based on the old history back into the cleaned repository.

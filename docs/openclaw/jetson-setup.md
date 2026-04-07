# HomeBrain OpenClaw Jetson Setup

This guide connects an existing OpenClaw instance to HomeBrain through HomeBrain's built-in MCP endpoint.

## What this deployment does

- HomeBrain hosts a `streamable-http` MCP endpoint at `/api/openclaw/mcp`
- HomeBrain issues a dedicated long-lived integration token for OpenClaw
- HomeBrain stores the published HomeBrain URL in the OpenClaw settings UI when auto-detection is not enough
- OpenClaw loads the `homebrain-admin` skill and the HomeBrain MCP server definition
- OpenClaw can then inspect and administer HomeBrain through typed tools

## Jetson prerequisites

- HomeBrain server deployed and reachable from the OpenClaw instance
- Node.js 22.16 or newer on the OpenClaw side
- A HomeBrain admin account available to rotate the integration token in the HomeBrain UI

## HomeBrain steps

1. Open `Settings -> Integrations -> OpenClaw` in the HomeBrain admin UI.
2. Set the published HomeBrain URL if OpenClaw should use a URL different from the current browser origin.
3. Rotate the OpenClaw token.
4. Copy the generated MCP server definition or the `openclaw mcp set ...` command.
5. Download the HomeBrain OpenClaw bundle immediately after rotation to get a deployment-ready package with the current token embedded.

## OpenClaw config

Example MCP server definition:

```json
{
  "url": "https://homebrain.example.com/api/openclaw/mcp",
  "transport": "streamable-http",
  "headers": {
    "Authorization": "Bearer <paste-homebrain-openclaw-token>"
  },
  "connectionTimeoutMs": 10000
}
```

Example CLI registration:

```bash
openclaw mcp set homebrain-admin '{"url":"https://homebrain.example.com/api/openclaw/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer <paste-homebrain-openclaw-token>"},"connectionTimeoutMs":10000}'
```

## Skill install

Install or copy the HomeBrain skill folder into the shared OpenClaw skills directory so every agent on the Jetson can load it:

```text
~/.openclaw/skills/homebrain-admin/
  SKILL.md
```

Use the `SKILL.md` shipped by HomeBrain. It encodes HomeBrain-specific operating rules and tool usage patterns.

If you downloaded the HomeBrain OpenClaw bundle from the HomeBrain admin UI, you can install everything in one step:

```bash
cd /path/to/unzipped/homebrain-openclaw-bundle
chmod +x ./install-jetson.sh
./install-jetson.sh
```

## Verification checklist

1. From OpenClaw, confirm the HomeBrain MCP server is registered.
2. Ask OpenClaw for a HomeBrain overview.
3. List devices and inspect one known device.
4. Perform a safe mutation such as toggling a non-critical device or reading workflow status.
5. Verify the change in HomeBrain Operations.

## Operational notes

- The HomeBrain OpenClaw token is admin-grade. Keep it server-side inside OpenClaw config and rotate it if exposed.
- The generated bundle includes the current inline-token MCP config, the HomeBrain skill, and a Jetson installer script.
- HomeBrain logs OpenClaw mutations into Operations with `source: "openclaw"`.
- Prefer HTTPS and a stable reverse-proxied URL for the MCP endpoint.
- If HomeBrain is restarted during deployment, OpenClaw should simply reconnect on the next request.

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_SKILLS_DIR="${OPENCLAW_SKILLS_DIR:-$HOME/.openclaw/skills}"
OPENCLAW_MCP_NAME="${OPENCLAW_MCP_NAME:-homebrain-admin}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command node
require_command openclaw

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 14)) { console.error("Node.js 22.14+ is required for OpenClaw."); process.exit(1); }'

if [[ ! -d "$SCRIPT_DIR/homebrain-admin" ]]; then
  echo "Expected homebrain-admin skill folder beside this script." >&2
  exit 1
fi

if [[ ! -f "$SCRIPT_DIR/openclaw-mcp-server.json" ]]; then
  echo "Expected openclaw-mcp-server.json beside this script." >&2
  exit 1
fi

mkdir -p "$OPENCLAW_SKILLS_DIR"
rm -rf "$OPENCLAW_SKILLS_DIR/homebrain-admin"
cp -R "$SCRIPT_DIR/homebrain-admin" "$OPENCLAW_SKILLS_DIR/homebrain-admin"
openclaw mcp set "$OPENCLAW_MCP_NAME" "$(cat "$SCRIPT_DIR/openclaw-mcp-server.json")"

echo
echo "Installed HomeBrain OpenClaw skill to: $OPENCLAW_SKILLS_DIR/homebrain-admin"
echo "Registered MCP server: $OPENCLAW_MCP_NAME"
echo
echo "Suggested verification:"
echo "  openclaw mcp show $OPENCLAW_MCP_NAME"
echo "  openclaw"

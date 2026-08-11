#!/bin/sh
# Noninteractive, idempotent Reachy Wireless installer.
set -eu
umask 077

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
HUB_URL=${HOMEBRAIN_HUB_URL:-}
DEVICE_ID=${HOMEBRAIN_DEVICE_ID:-}
CLAIM_TOKEN=${HOMEBRAIN_CLAIM_TOKEN:-}
REGISTRATION_CODE=${HOMEBRAIN_REGISTRATION_CODE:-}
CONFIG_PATH=${HOMEBRAIN_REACHY_CONFIG:-"$HOME/.config/homebrain-reachy/config.json"}
PYTHON_BIN=${HOMEBRAIN_REACHY_PYTHON:-}
VENV_PATH=${HOMEBRAIN_REACHY_VENV:-}
ALLOW_INSECURE=${HOMEBRAIN_ALLOW_INSECURE_HTTP:-false}
ACTIVATE=true
UPDATE_ONLY=false

usage() {
  command cat <<'EOF'
Usage: install.sh [options]
  --hub-url URL              HomeBrain HTTPS base URL
  --device-id ID             Pre-created Reachy voice-device id
  --claim-token TOKEN        Short-lived claim (prefer HOMEBRAIN_CLAIM_TOKEN)
  --registration-code CODE   Short-lived registration code
  --config PATH              Config path (default ~/.config/homebrain-reachy/config.json)
  --python PATH              Existing Python interpreter to install into
  --venv PATH                Venv to create/use if managed apps venv is unavailable
  --allow-insecure-http      Permit trusted-LAN HTTP for development only
  --no-activate              Persist bootstrap config; activate on first app start
  --update-only              Upgrade package only; app must already be stopped
  --help                     Show this help

Environment variables with matching HOMEBRAIN_* names are also accepted. Secrets
are never printed. The default interpreter is /venvs/apps_venv/bin/python3 on
Reachy Wireless, falling back to ~/.local/share/homebrain-reachy/venv.
EOF
}

require_value() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then
    command echo "Missing value for $1" >&2
    exit 2
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --hub-url) require_value "$@"; HUB_URL=$2; shift 2 ;;
    --device-id) require_value "$@"; DEVICE_ID=$2; shift 2 ;;
    --claim-token) require_value "$@"; CLAIM_TOKEN=$2; shift 2 ;;
    --registration-code) require_value "$@"; REGISTRATION_CODE=$2; shift 2 ;;
    --config) require_value "$@"; CONFIG_PATH=$2; shift 2 ;;
    --python) require_value "$@"; PYTHON_BIN=$2; shift 2 ;;
    --venv) require_value "$@"; VENV_PATH=$2; shift 2 ;;
    --allow-insecure-http) ALLOW_INSECURE=true; shift ;;
    --no-activate) ACTIVATE=false; shift ;;
    --update-only) UPDATE_ONLY=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) command echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "$CLAIM_TOKEN" ] && [ -n "$REGISTRATION_CODE" ]; then
  command echo "Provide only one bootstrap credential" >&2
  exit 2
fi

if [ -z "$PYTHON_BIN" ]; then
  if [ -x /venvs/apps_venv/bin/python3 ]; then
    PYTHON_BIN=/venvs/apps_venv/bin/python3
  else
    if [ -z "$VENV_PATH" ]; then
      command echo "/venvs/apps_venv/bin/python3 was not found; use --python or --venv only for developer mode" >&2
      exit 1
    fi
    if [ ! -x "$VENV_PATH/bin/python3" ]; then
      SYSTEM_PYTHON=$(command -v python3 || true)
      if [ -z "$SYSTEM_PYTHON" ]; then
        command echo "python3 is required" >&2
        exit 1
      fi
      "$SYSTEM_PYTHON" -m venv "$VENV_PATH"
    fi
    PYTHON_BIN="$VENV_PATH/bin/python3"
  fi
fi

if [ ! -x "$PYTHON_BIN" ]; then
  command echo "Python interpreter is not executable: $PYTHON_BIN" >&2
  exit 1
fi

# Package installation contains no credentials. The stable managed launcher must
# remain installable even when a native ARM wake-word wheel is temporarily absent.
"$PYTHON_BIN" -m pip install \
  --disable-pip-version-check \
  --no-input \
  --upgrade \
  "$SCRIPT_DIR"

if ! "$PYTHON_BIN" -m pip install \
  --disable-pip-version-check \
  --no-input \
  --upgrade \
  "${SCRIPT_DIR}[wakeword]"; then
  command echo "WARNING: wake-word dependencies were unavailable; app will report detector error until installed" >&2
fi

# Persist deterministic provenance for the bundled runtime. The file inventory
# exactly matches the source-only runtime boundary; stable launcher files are
# intentionally excluded because changing them requires a stopped reinstall.
RECEIPT_PATH=${HOMEBRAIN_REACHY_RECEIPT:-"$HOME/.local/share/homebrain-reachy/installed-receipt.json"}
"$PYTHON_BIN" - "$SCRIPT_DIR" "$RECEIPT_PATH" <<'PY'
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from reachy_homebrain.launcher_constants import STABLE_LAUNCHER_FILES
from reachy_homebrain.releases import manifest_aggregate_sha256

root = Path(sys.argv[1]).resolve()
receipt = Path(sys.argv[2]).expanduser()
# Must remain byte-for-byte aligned with the hub's runtime-only manifest.
root_files = {"pyproject.toml", "artifact-manifest.json"}
source_pattern = re.compile(r"^src/reachy_homebrain/[A-Za-z0-9_./-]+\.(?:py|json|txt|typed)$")
stable = set(STABLE_LAUNCHER_FILES)
entries = []
for path in root.rglob("*"):
    if not path.is_file() or path.is_symlink():
        continue
    relative = path.relative_to(root).as_posix()
    if relative in stable or (relative not in root_files and not source_pattern.fullmatch(relative)):
        continue
    data = path.read_bytes()
    entries.append((relative, len(data), hashlib.sha256(data).hexdigest()))
aggregate_sha256 = manifest_aggregate_sha256([
    {"path": relative, "size": size, "sha256": digest}
    for relative, size, digest in entries
])
metadata = json.loads((root / "artifact-manifest.json").read_text(encoding="utf-8"))
receipt.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(receipt.parent, 0o700)
descriptor, temporary = tempfile.mkstemp(prefix=".installed-receipt.", dir=receipt.parent)
with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
    json.dump({
        "version": metadata["version"],
        "aggregateSha256": aggregate_sha256,
        "fileCount": len(entries),
        "provenance": "installed-bundle",
    }, handle, sort_keys=True)
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
os.chmod(temporary, 0o600)
os.replace(temporary, receipt)
PY

if [ "$UPDATE_ONLY" = true ]; then
  command echo "Reachy HomeBrain package updated. Start it through the Reachy app manager."
  exit 0
fi

export HB_INSTALL_HUB_URL="$HUB_URL"
export HB_INSTALL_DEVICE_ID="$DEVICE_ID"
export HB_INSTALL_CLAIM_TOKEN="$CLAIM_TOKEN"
export HB_INSTALL_REGISTRATION_CODE="$REGISTRATION_CODE"
export HB_INSTALL_ALLOW_INSECURE="$ALLOW_INSECURE"
export HB_INSTALL_ACTIVATE="$ACTIVATE"

"$PYTHON_BIN" - "$CONFIG_PATH" <<'PY'
import json
import os
import sys
from pathlib import Path

from reachy_homebrain.bootstrap import activate_device
from reachy_homebrain.config import HomeBrainConfig, SecureConfigStore

path = Path(sys.argv[1]).expanduser()
raw = {}
if path.exists():
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise SystemExit("Existing config must contain a JSON object")
    raw.update(loaded)

overrides = {
    "hub_url": os.environ.get("HB_INSTALL_HUB_URL", "").strip(),
    "device_id": os.environ.get("HB_INSTALL_DEVICE_ID", "").strip(),
    "claim_token": os.environ.get("HB_INSTALL_CLAIM_TOKEN", "").strip(),
    "registration_code": os.environ.get("HB_INSTALL_REGISTRATION_CODE", "").strip(),
}
for key, value in overrides.items():
    if value:
        raw[key] = value
if os.environ.get("HB_INSTALL_ALLOW_INSECURE", "").lower() in {"1", "true", "yes"}:
    raw["allow_insecure_http"] = True

config = HomeBrainConfig.from_mapping(raw)
store = SecureConfigStore(path)
store.save(config)
if os.environ.get("HB_INSTALL_ACTIVATE", "true").lower() in {"1", "true", "yes"}:
    config = activate_device(config, store)
print(f"Reachy HomeBrain configuration ready for device {config.device_id}")
PY

unset HB_INSTALL_HUB_URL HB_INSTALL_DEVICE_ID HB_INSTALL_CLAIM_TOKEN
unset HB_INSTALL_REGISTRATION_CODE HB_INSTALL_ALLOW_INSECURE HB_INSTALL_ACTIVATE
command chmod 600 "$CONFIG_PATH"
command echo "Reachy HomeBrain app installed. Start 'reachy-homebrain-app' through the Reachy app manager."

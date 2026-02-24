#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bash homebrain-remote-setup.sh --hub-url <HUB_URL> --device-id <DEVICE_ID> --code <REGISTRATION_CODE>

Example:
  bash homebrain-remote-setup.sh \
    --hub-url http://192.168.1.50:3000 \
    --device-id 65f33d9f1b8b3e4f10e1d2c3 \
    --code A1B2C3D4
USAGE
}

HUB_URL=""
DEVICE_ID=""
REGISTRATION_CODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub-url)
      HUB_URL="${2:-}"
      shift 2
      ;;
    --device-id)
      DEVICE_ID="${2:-}"
      shift 2
      ;;
    --code)
      REGISTRATION_CODE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$HUB_URL" || -z "$DEVICE_ID" || -z "$REGISTRATION_CODE" ]]; then
  usage
  exit 1
fi

HUB_URL="${HUB_URL%/}"
BOOTSTRAP_URL="${HUB_URL}/api/remote-devices/${DEVICE_ID}/bootstrap.sh?code=${REGISTRATION_CODE}"

echo "[HomeBrain] Fetching bootstrap script from: ${BOOTSTRAP_URL}"
curl -fsSL "${BOOTSTRAP_URL}" | bash

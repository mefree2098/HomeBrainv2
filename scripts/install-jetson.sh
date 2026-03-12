#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export HOMEBRAIN_HOST_PROFILE=jetson

exec bash "${SCRIPT_DIR}/install-linux.sh" "$@"

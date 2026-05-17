#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOMEBRAIN_DIR="${HOMEBRAIN_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
BOOTSTRAP_NODE_BIN="${HOMEBRAIN_BOOTSTRAP_NODE_BIN:-$(command -v node || true)}"

if [[ -z "${BOOTSTRAP_NODE_BIN}" || ! -x "${BOOTSTRAP_NODE_BIN}" ]]; then
  echo "HomeBrain service could not find a bootstrap node binary." >&2
  exit 1
fi

cd "${HOMEBRAIN_DIR}"
SELECTED_NODE="$("${BOOTSTRAP_NODE_BIN}" scripts/run-with-modern-node.js --print-node-bin)"

if [[ -z "${SELECTED_NODE}" || ! -x "${SELECTED_NODE}" ]]; then
  echo "HomeBrain service could not resolve a supported node binary." >&2
  exit 1
fi

exec "${SELECTED_NODE}" "${HOMEBRAIN_DIR}/server/server.js"

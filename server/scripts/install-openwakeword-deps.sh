#!/usr/bin/env bash

# Installs the Python dependencies required for OpenWakeWord model training.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PYTHON_BIN="${PYTHON_BIN:-python3}"
PIP_FLAGS="${PIP_FLAGS:-}"
REQUIREMENTS=("openwakeword[train]")

echo "[wakeword] Using project root: ${PROJECT_ROOT}"
echo "[wakeword] Using Python: ${PYTHON_BIN}"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "[wakeword] ERROR: ${PYTHON_BIN} not found on PATH. Set PYTHON_BIN or install Python 3.8+." >&2
  exit 1
fi

echo "[wakeword] Upgrading pip..."
"${PYTHON_BIN}" -m pip install --upgrade pip ${PIP_FLAGS}

echo "[wakeword] Installing OpenWakeWord training dependencies..."
for requirement in "${REQUIREMENTS[@]}"; do
  "${PYTHON_BIN}" -m pip install "${requirement}" ${PIP_FLAGS}
done

echo "[wakeword] Done. Trained models will be written to server/public/wake-words/."

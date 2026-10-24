#!/usr/bin/env bash

# Installs the Python dependencies required for OpenWakeWord model training.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

VENV_DIR="${HOMEBRAIN_WAKEWORD_VENV_DIR:-${PROJECT_ROOT}/.wakeword-venv}"
if [ -x "${VENV_DIR}/bin/python" ]; then
  PYTHON_BIN="${VENV_DIR}/bin/python"
else
  PYTHON_BIN="${PYTHON_BIN:-python3.11}"
fi
read -r -a PIP_ARGS <<< "${PIP_FLAGS:-}"

echo "[wakeword] Project root: ${PROJECT_ROOT}"
echo "[wakeword] Requested Python: ${PYTHON_BIN}"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "[wakeword] ERROR: ${PYTHON_BIN} not found on PATH. Set PYTHON_BIN or install Python 3.11+." >&2
  exit 1
fi

PYTHON_VERSION="$("${PYTHON_BIN}" - <<'PYCODE'
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}")
PYCODE
)"

PYTHON_VERSION_MAJOR="$(echo "${PYTHON_VERSION}" | cut -d'.' -f1)"
PYTHON_VERSION_MINOR="$(echo "${PYTHON_VERSION}" | cut -d'.' -f2)"
if [ "${PYTHON_VERSION_MAJOR}" -lt 3 ] || { [ "${PYTHON_VERSION_MAJOR}" -eq 3 ] && [ "${PYTHON_VERSION_MINOR}" -lt 11 ]; }; then
  echo "[wakeword] ERROR: patched HomeBrain training dependencies require Python 3.11+. Detected ${PYTHON_VERSION}." >&2
  exit 1
fi

if [ ! -d "${VENV_DIR}" ]; then
  echo "[wakeword] Creating virtual environment at ${VENV_DIR}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

# Always select the managed environment, even if the caller has another active.
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

echo "[wakeword] Using Python interpreter: ${VIRTUAL_ENV}/bin/python"

# Keep the managed environment limited to the imports used by HomeBrain's
# custom DNN trainer. The upstream training extras pull an older torchaudio
# stack that pins vulnerable Torch releases and unused image parsers.
python -m pip install --upgrade "pip>=26.2.2" "setuptools>=84.1.0" wheel "${PIP_ARGS[@]}"
python -m pip install --upgrade -r "${PROJECT_ROOT}/python/wakeword-requirements.txt" "${PIP_ARGS[@]}"

if [ -n "${JETSON_TORCH_INDEX_URL:-}" ]; then
  if [ -z "${JETSON_TORCH_VERSION:-}" ]; then
    echo "[wakeword] ERROR: JETSON_TORCH_VERSION is required for a custom Jetson wheel." >&2
    exit 2
  fi
  python -m pip install --upgrade --extra-index-url "${JETSON_TORCH_INDEX_URL}" \
    "torch==${JETSON_TORCH_VERSION}" "torch>=2.13,<3" "${PIP_ARGS[@]}"
else
  # Explicit CPU build prevents a PyPI CUDA wheel from replacing a working
  # CPU runtime or pulling a CUDA toolkit incompatible with Jetson's driver.
  python -m pip install --upgrade --extra-index-url https://download.pytorch.org/whl/cpu \
    "torch==2.14.1+cpu" "${PIP_ARGS[@]}"
fi

# Quick sanity checks so runtime failures are caught at install-time.
python - <<'PYCODE'
import importlib.util
required = ["openwakeword", "onnxscript", "piper", "pathvalidate"]
missing = [name for name in required if importlib.util.find_spec(name) is None]
if missing:
    raise SystemExit(f"[wakeword] ERROR: missing required Python modules: {', '.join(missing)}")
print("[wakeword] Python module sanity check passed")
PYCODE

cat <<EOF
[wakeword] Installation complete.
[wakeword] Virtual environment: ${VENV_DIR}
[wakeword] To run manually:
  source "${VENV_DIR}/bin/activate"
  python server/scripts/train_wake_word.py --help

[wakeword] The training service will automatically use ${VENV_DIR}/bin/python if available.
[wakeword] Ensure Piper CLI is reachable by the service:
  - Preferred: ${VENV_DIR}/bin/piper should exist after install.
  - Otherwise set WAKEWORD_PIPER_EXEC to the full path to piper in the service environment.
EOF

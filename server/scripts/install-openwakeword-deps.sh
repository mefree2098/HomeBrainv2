#!/usr/bin/env bash

# Installs the Python dependencies required for OpenWakeWord model training.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PYTHON_BIN="${PYTHON_BIN:-python3}"
PIP_FLAGS="${PIP_FLAGS:-}"
VENV_DIR="${PROJECT_ROOT}/.wakeword-venv"
PYTHON_BIN_NAME="$(basename "${PYTHON_BIN}")"

echo "[wakeword] Project root: ${PROJECT_ROOT}"
echo "[wakeword] Requested Python: ${PYTHON_BIN}"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "[wakeword] ERROR: ${PYTHON_BIN} not found on PATH. Set PYTHON_BIN or install Python 3.8+." >&2
  exit 1
fi

if [ ! -d "${VENV_DIR}" ]; then
  echo "[wakeword] Creating virtual environment at ${VENV_DIR}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

if [ -z "${VIRTUAL_ENV:-}" ]; then
  # shellcheck disable=SC1091
  source "${VENV_DIR}/bin/activate"
fi

echo "[wakeword] Using Python interpreter: ${VIRTUAL_ENV}/bin/python"

python -m pip install --upgrade pip setuptools wheel ${PIP_FLAGS}

# Use versions compatible with the system SciPy/SKLearn stack.
python -m pip install "numpy<2.0" "scipy<1.11" ${PIP_FLAGS}
python -m pip install "torch" "soundfile" "librosa" ${PIP_FLAGS}
python -m pip install "onnxruntime" "onnx" "onnx-tf" "tensorflow-cpu" ${PIP_FLAGS}
python -m pip install "openwakeword[train]" ${PIP_FLAGS}

cat <<EOF
[wakeword] Installation complete.
[wakeword] Virtual environment: ${VENV_DIR}
[wakeword] To run manually:
  source "${VENV_DIR}/bin/activate"
  python server/scripts/train_wake_word.py --help

[wakeword] The training service will automatically use ${VENV_DIR}/bin/python if available.
EOF

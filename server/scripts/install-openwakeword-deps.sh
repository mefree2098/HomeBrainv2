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
  echo "[wakeword] ERROR: ${PYTHON_BIN} not found on PATH. Set PYTHON_BIN or install Python 3.10+." >&2
  exit 1
fi

PYTHON_VERSION="$(${PYTHON_BIN} - <<'PYCODE'
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}")
PYCODE
)"

PYTHON_VERSION_MAJOR="$(echo "${PYTHON_VERSION}" | cut -d'.' -f1)"
PYTHON_VERSION_MINOR="$(echo "${PYTHON_VERSION}" | cut -d'.' -f2)"
if [ "${PYTHON_VERSION_MAJOR}" -lt 3 ] || { [ "${PYTHON_VERSION_MAJOR}" -eq 3 ] && [ "${PYTHON_VERSION_MINOR}" -lt 10 ]; }; then
  echo "[wakeword] ERROR: openWakeWord now requires Python 3.10+. Detected ${PYTHON_VERSION}." >&2
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
# If JETSON_TORCH_INDEX_URL is provided, use NVIDIA's Jetson wheels for torch.*
# Example:
#   export JETSON_TORCH_INDEX_URL=https://developer.download.nvidia.com/compute/redist/jp/v62/pytorch/
#   export JETSON_TORCH_VERSION=2.7.0
#   export JETSON_TORCHVISION_VERSION=0.22.0
#   export JETSON_TORCHAUDIO_VERSION=2.7.0
TORCH_DONE=0
if [ -n "${JETSON_TORCH_INDEX_URL:-}" ]; then
  echo "[wakeword] Using NVIDIA Jetson PyTorch wheels from: ${JETSON_TORCH_INDEX_URL}"
  # Uninstall any previously installed CPU-only torch wheels
  python -m pip uninstall -y torch torchvision torchaudio || true
  if [ -z "${JETSON_TORCH_VERSION:-}" ] || [ -z "${JETSON_TORCHVISION_VERSION:-}" ] || [ -z "${JETSON_TORCHAUDIO_VERSION:-}" ]; then
    echo "[wakeword] ERROR: When JETSON_TORCH_INDEX_URL is set, you must also set JETSON_TORCH_VERSION, JETSON_TORCHVISION_VERSION, and JETSON_TORCHAUDIO_VERSION." >&2
    echo "[wakeword] Example versions for JetPack 6.2: torch=2.7.0, torchvision=0.22.0, torchaudio=2.7.0" >&2
    exit 2
  fi
  python -m pip install --no-cache-dir \
    --extra-index-url "${JETSON_TORCH_INDEX_URL}" \
    torch=="${JETSON_TORCH_VERSION}" \
    torchvision=="${JETSON_TORCHVISION_VERSION}" \
    torchaudio=="${JETSON_TORCHAUDIO_VERSION}" \
    ${PIP_FLAGS}
  TORCH_DONE=1
  echo "[wakeword] Verifying CUDA availability in torch..."
  python - <<'PYCODE'
import torch
print("[wakeword] torch:", torch.__version__)
print("[wakeword] CUDA version:", getattr(torch.version, 'cuda', None))
print("[wakeword] torch.cuda.is_available():", torch.cuda.is_available())
PYCODE
fi

# Install the rest of the dependencies. If torch was not installed via Jetson wheels, install from PyPI.
if [ "${TORCH_DONE}" -eq 1 ]; then
  python -m pip install \
    "soundfile" \
    "librosa" \
    "torchinfo" \
    "torchmetrics" \
    "pronouncing" \
    "webrtcvad" \
    "audiomentations" \
    "torch-audiomentations" \
    "speechbrain" \
    "mutagen" \
    "acoustics" \
    ${PIP_FLAGS}
else
  python -m pip install \
    "torch" \
    "torchaudio" \
    "soundfile" \
    "librosa" \
    "torchinfo" \
    "torchmetrics" \
    "pronouncing" \
    "webrtcvad" \
    "audiomentations" \
    "torch-audiomentations" \
    "speechbrain" \
    "mutagen" \
    "acoustics" \
    ${PIP_FLAGS}
fi
# TensorFlow Lite export is optional on Jetson; install the NVIDIA wheel manually if needed.
python -m pip install "onnxruntime" "onnx" "onnx-tf" ${PIP_FLAGS}
python -m pip install "openwakeword[train]" ${PIP_FLAGS}
# Install Piper CLI for local TTS synthesis during dataset generation
python -m pip install "piper-tts" ${PIP_FLAGS}

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

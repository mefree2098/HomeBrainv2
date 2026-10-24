#!/usr/bin/env bash
# Enable GPU (CUDA) for HomeBrain wake-word training on NVIDIA Jetson
# - Installs NVIDIA's Jetson-specific PyTorch wheels in server/.wakeword-venv
# - Verifies CUDA availability
# - Notes about optional TFLite/ONNX GPU
#
# Supply explicit, mutually compatible NVIDIA wheel versions. Torch must be
# a patched stable release (2.13.0 or newer); the managed CPU runtime is retained
# when these requirements cannot be met.
# Usage: ./server/scripts/enable-jetson-gpu.sh --torch VERSION --vision VERSION --audio VERSION
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENV_DIR="${SERVER_DIR}/.wakeword-venv"
PYTHON_BIN="python3"
JP_VER="62" # JetPack 6.2 default
TORCH_VER=""
VISION_VER=""
AUDIO_VER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --python)
      PYTHON_BIN="$2"; shift 2;;
    --jetpack)
      JP_VER="$2"; shift 2;;
    --torch)
      TORCH_VER="$2"; shift 2;;
    --vision|--torchvision)
      VISION_VER="$2"; shift 2;;
    --audio|--torchaudio)
      AUDIO_VER="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 2;;
  esac
done

INDEX_URL="https://developer.download.nvidia.com/compute/redist/jp/v${JP_VER}/pytorch/"

echo "[jetson] HomeBrain server dir: ${SERVER_DIR}"
if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "[jetson] ERROR: Python not found: ${PYTHON_BIN}" >&2
  exit 1
fi

# Validate before creating an environment or uninstalling the working CPU stack.
if [ -z "${TORCH_VER}" ] || [ -z "${VISION_VER}" ] || [ -z "${AUDIO_VER}" ]; then
  echo "[jetson] ERROR: explicit patched Torch (2.13.0+) and compatible vision/audio versions are required." >&2
  exit 2
fi
"${PYTHON_BIN}" - "${TORCH_VER}" <<'PYCODE'
import re
import sys
match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:\+[A-Za-z0-9_.-]+)?", sys.argv[1])
if not match or tuple(map(int, match.groups())) < (2, 13, 0):
    raise SystemExit("[jetson] ERROR: refusing a vulnerable or unreviewed Torch release; retain the managed CPU runtime.")
PYCODE

# Create venv if missing
if [ ! -d "${VENV_DIR}" ]; then
  echo "[jetson] Creating virtualenv: ${VENV_DIR}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

python -m pip install --upgrade "pip>=26.2.2" wheel "setuptools>=84.1.0"

# Uninstall any CPU-only torch
python -m pip uninstall -y torch torchvision torchaudio || true

# Install NVIDIA wheels
echo "[jetson] Installing torch==${TORCH_VER} torchvision==${VISION_VER} torchaudio==${AUDIO_VER} from ${INDEX_URL}"
# Prefer NVIDIA index first to avoid CPU-only wheels from PyPI
pip install --no-cache-dir --index-url "${INDEX_URL}" --extra-index-url https://pypi.org/simple \
  torch=="${TORCH_VER}" torchvision=="${VISION_VER}" torchaudio=="${AUDIO_VER}"

verify_cuda() {
python - <<'PYCODE'
import torch
print("[jetson] torch:", torch.__version__)
print("[jetson] CUDA version:", getattr(torch.version, 'cuda', None))
print("[jetson] cuda available:", torch.cuda.is_available())
try:
    x = torch.randn(1024, 1024, device='cuda'); y = x @ x; print('[jetson] smoke:', y[0,0].item())
except Exception as e:
    print('[jetson] GPU test failed:', e)
PYCODE
}

verify_cuda

# Never retry with the former vulnerable Torch 2.6/2.7 fallback mappings.
CPU_ONLY=$(python - <<'PYCODE'
import torch
print('yes' if (not torch.cuda.is_available() or '+cpu' in torch.__version__) else 'no')
PYCODE
)
if [ "${CPU_ONLY}" = "yes" ]; then
  echo "[jetson] ERROR: the selected patched wheels do not provide working CUDA; no older fallback will be installed." >&2
  exit 1
fi

echo "[jetson] Done. If cuda available is False, ensure JetPack matches v${JP_VER} and that the NVIDIA index hosts the requested versions."

echo "Optional: set for services if needed:"
echo "  export LD_LIBRARY_PATH=/usr/lib/aarch64-linux-gnu:\$LD_LIBRARY_PATH"

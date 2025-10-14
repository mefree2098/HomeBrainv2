#!/usr/bin/env bash
# Enable GPU (CUDA) for HomeBrain wake-word training on NVIDIA Jetson
# - Installs NVIDIA's Jetson-specific PyTorch wheels in server/.wakeword-venv
# - Verifies CUDA availability
# - Notes about optional TFLite/ONNX GPU
#
# Usage:
#   ./server/scripts/enable-jetson-gpu.sh [--python PY] [--jetpack 62] [--torch 2.7.0] [--vision 0.22.0] [--audio 2.7.0]
#
# Examples:
#   ./server/scripts/enable-jetson-gpu.sh --jetpack 62
#   ./server/scripts/enable-jetson-gpu.sh --jetpack 62 --torch 2.7.0 --vision 0.22.0 --audio 2.7.0
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

# Create venv if missing
if [ ! -d "${VENV_DIR}" ]; then
  echo "[jetson] Creating virtualenv: ${VENV_DIR}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

python -m pip install --upgrade pip wheel setuptools

# Uninstall any CPU-only torch
python -m pip uninstall -y torch torchvision torchaudio || true

# If versions not provided, pick reasonable defaults for JP 6.2
if [ -z "${TORCH_VER}" ] && [ "${JP_VER}" = "62" ]; then
  TORCH_VER="2.7.0"; VISION_VER="0.22.0"; AUDIO_VER="2.7.0"
fi
if [ -z "${TORCH_VER}" ] || [ -z "${VISION_VER}" ] || [ -z "${AUDIO_VER}" ]; then
  echo "[jetson] ERROR: Torch/vision/audio versions are required. Try: --torch 2.7.0 --vision 0.22.0 --audio 2.7.0" >&2
  exit 2
fi

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

# If still CPU-only, retry with a fallback version mapping for this JetPack
CPU_ONLY=$(python - <<'PYCODE'
import torch
print('yes' if (not torch.cuda.is_available() or '+cpu' in torch.__version__) else 'no')
PYCODE
)
if [ "$CPU_ONLY" = "yes" ]; then
  echo "[jetson] Detected CPU-only torch. Retrying with NVIDIA index only and a fallback version set..."
  python -m pip uninstall -y torch torchvision torchaudio || true
  if [ "${JP_VER}" = "62" ]; then
    # Fallback known-good mapping for JP 6.2
    TORCH_FALLBACK="2.6.0"; VISION_FALLBACK="0.21.0"; AUDIO_FALLBACK="2.6.0"
  else
    TORCH_FALLBACK="${TORCH_VER}"; VISION_FALLBACK="${VISION_VER}"; AUDIO_FALLBACK="${AUDIO_VER}"
  fi
  pip install --no-cache-dir --index-url "${INDEX_URL}" --extra-index-url https://pypi.org/simple \
    torch=="${TORCH_FALLBACK}" torchvision=="${VISION_FALLBACK}" torchaudio=="${AUDIO_FALLBACK}"
  verify_cuda
fi

echo "[jetson] Done. If cuda available is False, ensure JetPack matches v${JP_VER} and that the NVIDIA index hosts the requested versions."

echo "Optional: set for services if needed:"
echo "  export LD_LIBRARY_PATH=/usr/lib/aarch64-linux-gnu:\$LD_LIBRARY_PATH"

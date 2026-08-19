#!/usr/bin/env bash

# HomeBrain Remote Device Installation Script
# Best-tested on Raspberry Pi OS, but works on other Debian/Ubuntu-based Linux systems too.

set -euo pipefail

echo "======================================"
echo "HomeBrain Remote Device Installer"
echo "======================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   print_error "This script should not be run as root (don't use sudo)"
   exit 1
fi

# Resolve the directory containing this script before changing directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODESOURCE_SETUP_22_SHA256="575583bbac2fccc0b5edd0dbc03e222d9f9dc8d724da996d22754d6411104fd1"

# Detect system
print_status "Detecting system..."
OS=$(uname -s)
ARCH=$(uname -m)

if [[ "$OS" != "Linux" ]]; then
    print_error "This script is designed for Linux systems"
    exit 1
fi

print_success "System detected: $OS $ARCH"

# Check for Raspberry Pi
if [[ -f /proc/device-tree/model ]]; then
    PI_MODEL=$(cat /proc/device-tree/model | tr -d '\0')
    print_success "Raspberry Pi detected: $PI_MODEL"
else
    print_warning "Raspberry Pi not detected. Proceeding with the generic Linux listener install."
fi

# Update package index
print_status "Updating package index..."
sudo apt-get update -y

# Install required system packages
print_status "Installing required system packages..."
sudo apt-get install -y \
    curl \
    ca-certificates \
    git \
    build-essential \
    rsync \
    python3 \
    python3-pip \
    python3-venv \
    alsa-utils \
    pulseaudio \
    sox \
    libsox-fmt-all \
    espeak \
    libttspico-utils

run_verified_nodesource_setup() (
    local setup_script
    setup_script="$(mktemp /tmp/homebrain-nodesource-setup.XXXXXX)"
    trap 'rm -f "${setup_script}"' EXIT

    curl \
        --proto '=https' \
        --tlsv1.2 \
        --fail \
        --location \
        --silent \
        --show-error \
        https://deb.nodesource.com/setup_22.x \
        --output "${setup_script}"

    if ! printf '%s  %s\n' "${NODESOURCE_SETUP_22_SHA256}" "${setup_script}" | sha256sum --check --status; then
        print_error "NodeSource setup script integrity check failed; refusing to execute it."
        exit 1
    fi

    sudo -E bash "${setup_script}"
)

# Install or upgrade Node.js
install_nodejs() {
    print_status "Installing Node.js 22..."
    run_verified_nodesource_setup
    sudo apt-get install -y nodejs
    hash -r
}

if ! command -v node &> /dev/null; then
    install_nodejs
else
    NODE_VERSION=$(node --version)
    print_success "Node.js already installed: $NODE_VERSION"
fi

# Verify Node.js version
NODE_MAJOR=$(node --version | cut -d. -f1 | sed 's/v//')
if [[ "$NODE_MAJOR" -lt 20 ]]; then
    print_warning "Node.js $(node --version) is too old; upgrading to Node.js 22..."
    install_nodejs
    NODE_MAJOR=$(node --version | cut -d. -f1 | sed 's/v//')
fi

if [[ "$NODE_MAJOR" -lt 20 ]]; then
    print_error "Node.js version 20 or higher is required after upgrade attempt (found $(node --version))"
    print_error "Remove old NodeSource entries and rerun: sudo rm -f /etc/apt/sources.list.d/nodesource*.list"
    exit 1
fi

# Create directory for HomeBrain remote device
INSTALL_DIR="$HOME/homebrain-remote"
print_status "Creating installation directory: $INSTALL_DIR"

if [[ "$SCRIPT_DIR" != "$INSTALL_DIR" ]]; then
    if [[ -d "$INSTALL_DIR" ]]; then
        print_warning "Directory already exists, backing up..."
        mv "$INSTALL_DIR" "$INSTALL_DIR.backup.$(date +%s)"
    fi

    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"

    # Copy or download the remote device files
    if [[ -f "$SCRIPT_DIR/package.json" ]]; then
        print_status "Copying application files..."
        rsync -a --delete \
            --exclude 'node_modules' \
            --exclude '.git' \
            --exclude '.DS_Store' \
            "$SCRIPT_DIR"/ "$INSTALL_DIR"/
    else
        print_status "Source files not found. Creating minimal HomeBrain Remote package..."
cat > package.json << 'EOF'
{
  "name": "homebrain-remote-device",
  "version": "1.3.0",
  "description": "HomeBrain Remote Voice Device for Linux listeners",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "test": "node test-audio.js",
    "setup-audio": "node setup-audio.js"
  },
  "dependencies": {
    "ws": "^8.21.1",
    "node-record-lpcm16": "^1.0.1",
    "yargs": "^17.7.2",
    "node-wav": "^0.0.2",
    "onnxruntime-node": "1.27.0",
    "tflite-node": "1.0.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
EOF
    fi
else
    print_status "Installer is already running from $INSTALL_DIR, using in-place files."
    cd "$INSTALL_DIR"
fi

# Install Node.js dependencies
print_status "Installing Node.js dependencies..."
if [ -d "$INSTALL_DIR/node_modules" ]; then
    print_warning "Dependencies already present (skipping dependency install)"
else
    if [ -f package-lock.json ]; then
        NPM_INSTALL_CMD=(npm ci --no-audit --no-fund)
    else
        NPM_INSTALL_CMD=(npm install --no-audit --no-fund)
    fi

    if ! "${NPM_INSTALL_CMD[@]}"; then
        print_warning "${NPM_INSTALL_CMD[*]} failed; attempting to enforce tflite-node@1.0.0 and retry"
        # Ensure tflite-node version is pinned in package.json
        if grep -q '"tflite-node"' package.json; then
            sed -i 's/"tflite-node"\s*:\s*"[^"]*"/"tflite-node": "1.0.0"/g' package.json || true
        fi
        npm install --no-audit --no-fund || true
        npm install --no-audit --no-fund tflite-node@1.0.0 || true
    fi
fi

# Prepare Python venv for sidecar automatically
print_status "Creating Python virtual environment for wake-word sidecar..."
PYTHON_BIN="${PYTHON_BIN:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    print_error "Python 3.10+ is required for OpenWakeWord but was not found ($PYTHON_BIN)."
    exit 1
fi

PYTHON_VERSION="$("$PYTHON_BIN" - <<'PYCODE'
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}")
PYCODE
)"
PYTHON_VERSION_MAJOR="$(echo "$PYTHON_VERSION" | cut -d'.' -f1)"
PYTHON_VERSION_MINOR="$(echo "$PYTHON_VERSION" | cut -d'.' -f2)"
if [ "$PYTHON_VERSION_MAJOR" -lt 3 ] || { [ "$PYTHON_VERSION_MAJOR" -eq 3 ] && [ "$PYTHON_VERSION_MINOR" -lt 10 ]; }; then
    print_error "OpenWakeWord requires Python 3.10+ (detected $PYTHON_VERSION)."
    exit 1
fi

if [ ! -d "$INSTALL_DIR/.venv" ]; then
    "$PYTHON_BIN" -m venv "$INSTALL_DIR/.venv" || true
fi
if [ -x "$INSTALL_DIR/.venv/bin/python" ]; then
    "$INSTALL_DIR/.venv/bin/python" -m pip install --upgrade pip setuptools wheel
    if ! "$INSTALL_DIR/.venv/bin/python" -m pip install "numpy<2" "onnxruntime<2" "openwakeword==0.6.0"; then
        print_error "Failed to install wake-word dependencies in the venv."
        print_error "Re-run once networking is stable, or install manually with the venv's pip."
        exit 1
    fi
    print_success "Python sidecar environment prepared"
else
    print_warning "Python venv not available; sidecar will attempt system python3"
fi

# Configure audio
print_status "Configuring audio system..."

# Detect suitable ALSA cards (prefer a device that supports both playback and capture)
print_status "Detecting audio devices..."
DEFAULT_PLAYBACK_CARD=
DEFAULT_CAPTURE_CARD=

readarray -t CAPTURE_CARDS < <(arecord -l 2>/dev/null | awk '/^card [0-9]+:/ {gsub(":","",$2); print $2}' | sort -n | uniq)
readarray -t PLAYBACK_CARDS < <(aplay -l 2>/dev/null | awk '/^card [0-9]+:/ {gsub(":","",$2); print $2}' | sort -n | uniq)

for card in "${CAPTURE_CARDS[@]}"; do
    if printf '%s\n' "${PLAYBACK_CARDS[@]}" | grep -qx "$card"; then
        DEFAULT_CAPTURE_CARD="$card"
        DEFAULT_PLAYBACK_CARD="$card"
        break
    fi
done

# Fallback to first detected capture/playback cards if no shared device exists
if [[ -z "$DEFAULT_CAPTURE_CARD" && ${#CAPTURE_CARDS[@]} -gt 0 ]]; then
    DEFAULT_CAPTURE_CARD="${CAPTURE_CARDS[0]}"
fi

if [[ -z "$DEFAULT_PLAYBACK_CARD" && ${#PLAYBACK_CARDS[@]} -gt 0 ]]; then
    DEFAULT_PLAYBACK_CARD="${PLAYBACK_CARDS[0]}"
fi

# Final fallback if detection failed
DEFAULT_CAPTURE_CARD="${DEFAULT_CAPTURE_CARD:-0}"
DEFAULT_PLAYBACK_CARD="${DEFAULT_PLAYBACK_CARD:-0}"

print_status "Using ALSA playback card ${DEFAULT_PLAYBACK_CARD}, capture card ${DEFAULT_CAPTURE_CARD}"

# Create ALSA configuration
sudo tee /etc/asound.conf > /dev/null << EOF
# HomeBrain Remote Device Audio Configuration
pcm.!default {
    type asym
    playback.pcm "plughw:${DEFAULT_PLAYBACK_CARD},0"
    capture.pcm "plughw:${DEFAULT_CAPTURE_CARD},0"
}

ctl.!default {
    type hw
    card ${DEFAULT_PLAYBACK_CARD}
}
EOF

# Add user to audio group
sudo usermod -a -G audio "$USER"

# Create systemd service
print_status "Creating systemd service..."
NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" ]]; then
    print_error "Unable to locate node on PATH."
    exit 1
fi

sudo tee /etc/systemd/system/homebrain-remote.service > /dev/null << EOF
[Unit]
Description=HomeBrain Remote Voice Device
After=network.target sound.target
Wants=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd
sudo systemctl daemon-reload

# Create default configuration (only if absent)
print_status "Creating default configuration..."
if [ ! -f config.json ]; then
cat > config.json << 'EOF'
{
  "audio": {
    "sampleRate": 16000,
    "channels": 1,
    "recordingDevice": "default",
    "playbackDevice": "default"
  },
  "wakeWords": ["anna", "henry", "home brain"],
  "hubUrl": null,
  "deviceId": null,
  "deviceToken": null,
  "registrationCode": null,
  "claimToken": null,
  "voice": {
    "captureMode": "none"
  }
}
EOF
else
  print_warning "config.json exists; preserving existing configuration"
fi

# Create convenience scripts
print_status "Creating convenience scripts..."

# Start script
cat > start.sh << 'EOF'
#!/bin/bash
export HB_CAPTURE_MODE=none
echo "Starting HomeBrain Remote Device..."
node index.js "$@"
EOF

chmod +x start.sh

# Register script
cat > register.sh << 'EOF'
#!/bin/bash
set -euo pipefail

REGISTRATION_CODE=""
CLAIM_TOKEN=""
DEVICE_ID=""
HUB_URL="${HUB_URL:-http://localhost:3000}"

usage() {
    echo "Usage: $0 (--registration-code CODE | --claim-token TOKEN --device-id DEVICE_ID) [--hub HUB_URL]"
    echo "Legacy: $0 <registration_code> [hub_url]"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --registration-code|--code)
            REGISTRATION_CODE="${2:-}"
            shift 2
            ;;
        --claim-token|--claim)
            CLAIM_TOKEN="${2:-}"
            shift 2
            ;;
        --device-id)
            DEVICE_ID="${2:-}"
            shift 2
            ;;
        --hub|--hub-url)
            HUB_URL="${2:-}"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            if [[ -z "$REGISTRATION_CODE" && -z "$CLAIM_TOKEN" ]]; then
                REGISTRATION_CODE="$1"
            else
                HUB_URL="$1"
            fi
            shift
            ;;
    esac
done

if [[ -z "$REGISTRATION_CODE" && -z "$CLAIM_TOKEN" ]]; then
    usage
    exit 1
fi

if [[ -n "$CLAIM_TOKEN" && -z "$DEVICE_ID" ]]; then
    echo "A device ID is required when using --claim-token"
    exit 1
fi

echo "Registering device with HomeBrain hub..."
if [[ -n "$CLAIM_TOKEN" ]]; then
    echo "Claim Token: [redacted]"
    echo "Device ID: $DEVICE_ID"
else
    echo "Registration Code: $REGISTRATION_CODE"
fi
echo "Hub URL: $HUB_URL"

ARGS=(--hub "$HUB_URL" --register-only)
if [[ -n "$REGISTRATION_CODE" ]]; then
    ARGS+=(--register "$REGISTRATION_CODE")
fi
if [[ -n "$CLAIM_TOKEN" ]]; then
    ARGS+=(--claim-token "$CLAIM_TOKEN" --device-id "$DEVICE_ID")
fi

node index.js "${ARGS[@]}"
EOF

chmod +x register.sh

# Test audio script
cat > test-audio.sh << 'EOF'
#!/bin/bash
echo "Testing audio configuration..."
echo ""

echo "1. Testing recording devices:"
arecord -l

echo ""
echo "2. Testing playback devices:"
aplay -l

echo ""
echo "3. Testing microphone (5 seconds):"
echo "Speak into your microphone..."
timeout 5s arecord -f cd test-recording.wav 2>/dev/null || true

if [ -f "test-recording.wav" ]; then
    echo "Recording successful! Playing back..."
    aplay test-recording.wav 2>/dev/null || true
    rm test-recording.wav
    echo "Audio test completed successfully!"
else
    echo "Recording failed. Please check your microphone configuration."
fi
EOF

chmod +x test-audio.sh

# Create README
print_status "Creating README..."
cat > README.md << 'EOF'
# HomeBrain Remote Device

This is a HomeBrain remote voice device for Debian/Ubuntu-based Linux systems.

Raspberry Pi is the best-tested target, but other Linux mini PCs and SBCs also work.

## Quick Start

1. **Activate your device** with the HomeBrain hub:
   ```bash
   ./register.sh --registration-code YOUR_REGISTRATION_CODE --hub http://YOUR_HUB:3000
   ./register.sh --claim-token YOUR_CLAIM_TOKEN --device-id YOUR_DEVICE_ID --hub http://YOUR_HUB:3000
   ```

2. **Start the device**:
   ```bash
   ./start.sh
   ```

3. **Test audio** (optional):
   ```bash
   ./test-audio.sh
   ```

## Service Management

Enable automatic startup:
```bash
sudo systemctl enable homebrain-remote
sudo systemctl start homebrain-remote
```

Check service status:
```bash
sudo systemctl status homebrain-remote
```

View logs:
```bash
sudo journalctl -u homebrain-remote -f
```

## Configuration

Edit `config.json` to customize audio settings and other options.

## Troubleshooting

- **Audio issues**: Run `./test-audio.sh` to verify microphone and speaker
- **Connection issues**: Check network connectivity and hub URL
- **Service issues**: Check logs with `sudo journalctl -u homebrain-remote`
EOF

print_success "Installation completed successfully!"
echo ""
print_status "Next steps:"
echo "1. Test your audio setup: ./test-audio.sh"
echo "2. Get onboarding credentials from your HomeBrain hub"
echo "3. Activate your device: ./register.sh --registration-code YOUR_CODE --hub HUB_URL"
echo "4. Start the device: ./start.sh"
echo ""
print_status "Optional - Enable automatic startup:"
echo "sudo systemctl enable homebrain-remote"
echo "sudo systemctl start homebrain-remote"
echo ""
print_warning "Please reboot or log out/in for audio group changes to take effect"

# Show installation summary
echo ""
echo "======================================"
echo "Installation Summary"
echo "======================================"
echo "Installation directory: $INSTALL_DIR"
echo "Service file: /etc/systemd/system/homebrain-remote.service"
echo "Audio config: /etc/asound.conf"
echo "User added to audio group: $USER"
echo ""
print_success "HomeBrain Remote Device is ready!"

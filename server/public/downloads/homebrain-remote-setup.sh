#!/bin/bash
# HomeBrain Remote Device Quick Setup
# This script downloads and installs the HomeBrain remote device

set -e

echo "========================================"
echo "HomeBrain Remote Device Quick Setup"
echo "========================================"
echo ""

# Create installation directory
INSTALL_DIR="$HOME/homebrain-remote"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Extract files (this would be replaced with actual download in production)
echo "Setting up HomeBrain Remote Device..."

# In production, this would download the package:
# curl -L -o homebrain-remote-setup.tar.gz "https://your-hub/downloads/homebrain-remote-setup.tar.gz"
# tar -xzf homebrain-remote-setup.tar.gz

echo "Installation files ready. Now running installer..."
chmod +x install.sh
./install.sh

echo ""
echo "Setup complete! Follow the instructions above to register and start your device."

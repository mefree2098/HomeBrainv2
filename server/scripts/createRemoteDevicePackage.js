#!/usr/bin/env node

/**
 * Script to create a downloadable package for HomeBrain Remote Device
 * This creates a .tar.gz file with all necessary files for Raspberry Pi setup
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('Creating HomeBrain Remote Device Package...');

const projectRoot = path.join(__dirname, '../..');
const remoteDeviceDir = path.join(projectRoot, 'remote-device');
const outputDir = path.join(projectRoot, 'server/public/downloads');
const packageName = 'homebrain-remote-setup';

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
  console.log('Created downloads directory:', outputDir);
}

try {
  // Check if remote-device directory exists
  if (!fs.existsSync(remoteDeviceDir)) {
    console.error('Remote device directory not found:', remoteDeviceDir);
    process.exit(1);
  }

  // Create temporary package directory
  const tempDir = path.join('/tmp', `${packageName}-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  console.log('Copying files to temporary directory...');

  // Files to include in the package
  const filesToInclude = [
    'package.json',
    'index.js',
    'install.sh',
    'README.md'
  ];

  // Copy files
  for (const file of filesToInclude) {
    const srcPath = path.join(remoteDeviceDir, file);
    const destPath = path.join(tempDir, file);

    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
      console.log(`Copied: ${file}`);
    } else {
      console.warn(`Warning: File not found: ${file}`);
    }
  }

  // Create setup script that users can run directly
  const setupScript = `#!/bin/bash
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
`;

  fs.writeFileSync(path.join(tempDir, 'setup.sh'), setupScript);
  fs.chmodSync(path.join(tempDir, 'setup.sh'), '755');

  console.log('Creating package archive...');

  // Create tar.gz archive
  const archivePath = path.join(outputDir, `${packageName}.tar.gz`);

  try {
    execSync(`tar -czf "${archivePath}" -C "${path.dirname(tempDir)}" "${path.basename(tempDir)}"`, {
      stdio: 'inherit'
    });
  } catch (error) {
    console.error('Failed to create archive with tar, trying alternative method...');

    // Alternative method using Node.js
    const archiver = require('archiver');
    const output = fs.createWriteStream(archivePath);
    const archive = archiver('tar', { gzip: true });

    output.on('close', () => {
      console.log(`Package created: ${archivePath} (${archive.pointer()} bytes)`);
    });

    archive.on('error', (err) => {
      throw err;
    });

    archive.pipe(output);
    archive.directory(tempDir, false);
    archive.finalize();
  }

  // Create setup script for direct download
  const directSetupPath = path.join(outputDir, 'homebrain-remote-setup.sh');
  fs.writeFileSync(directSetupPath, setupScript);
  fs.chmodSync(directSetupPath, '755');

  // Clean up temporary directory
  fs.rmSync(tempDir, { recursive: true });

  console.log('');
  console.log('Package creation completed successfully!');
  console.log('');
  console.log('Files created:');
  console.log(`- Archive: ${archivePath}`);
  console.log(`- Setup script: ${directSetupPath}`);
  console.log('');
  console.log('Users can download and run:');
  console.log(`curl -L -o setup.sh "http://your-hub/downloads/homebrain-remote-setup.sh" && bash setup.sh`);

} catch (error) {
  console.error('Error creating package:', error.message);
  process.exit(1);
}
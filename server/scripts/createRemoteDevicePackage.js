#!/usr/bin/env node

/**
 * Build the downloadable HomeBrain Linux remote-device package.
 * Produces:
 * - server/public/downloads/homebrain-remote-setup.tar.gz
 * - server/public/downloads/homebrain-remote-setup.sh
 */

const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const projectRoot = path.join(__dirname, '..', '..');
const remoteDeviceDir = path.join(projectRoot, 'remote-device');
const downloadsDir = path.join(projectRoot, 'server', 'public', 'downloads');
const packageName = 'homebrain-remote-setup.tar.gz';
const packagePath = path.join(downloadsDir, packageName);
const helperScriptPath = path.join(downloadsDir, 'homebrain-remote-setup.sh');

const filesToInclude = [
  'index.js',
  'package.json',
  'install.sh',
  'README.md',
  'updater.js',
  'feature_infer.py'
];

const helperScript = `#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bash homebrain-remote-setup.sh --hub-url <HUB_URL> --device-id <DEVICE_ID> --code <REGISTRATION_CODE>

Example:
  bash homebrain-remote-setup.sh \\
    --hub-url http://192.168.1.50:3000 \\
    --device-id 65f33d9f1b8b3e4f10e1d2c3 \\
    --code A1B2C3D4
USAGE
}

HUB_URL=""
DEVICE_ID=""
REGISTRATION_CODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub-url)
      HUB_URL="\${2:-}"
      shift 2
      ;;
    --device-id)
      DEVICE_ID="\${2:-}"
      shift 2
      ;;
    --code)
      REGISTRATION_CODE="\${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$HUB_URL" || -z "$DEVICE_ID" || -z "$REGISTRATION_CODE" ]]; then
  usage
  exit 1
fi

HUB_URL="\${HUB_URL%/}"
BOOTSTRAP_URL="\${HUB_URL}/api/remote-devices/\${DEVICE_ID}/bootstrap.sh?code=\${REGISTRATION_CODE}"

echo "[HomeBrain] Fetching bootstrap script from: \${BOOTSTRAP_URL}"
curl -fsSL "\${BOOTSTRAP_URL}" | bash
`;

async function main() {
  console.log('Building HomeBrain remote setup package...');

  await fs.mkdir(downloadsDir, { recursive: true });

  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-remote-package-'));
  const stagingDir = path.join(stagingRoot, 'homebrain-remote');

  try {
    await fs.mkdir(stagingDir, { recursive: true });

    for (const file of filesToInclude) {
      const src = path.join(remoteDeviceDir, file);
      const dst = path.join(stagingDir, file);
      await fs.copyFile(src, dst);
      console.log(`Included: ${file}`);
    }

    await execFileAsync('tar', [
      '-czf',
      packagePath,
      '-C',
      stagingRoot,
      'homebrain-remote'
    ]);

    await fs.writeFile(helperScriptPath, helperScript, 'utf8');
    await fs.chmod(helperScriptPath, 0o755);

    const stats = await fs.stat(packagePath);
    console.log(`Package created: ${packagePath} (${stats.size} bytes)`);
    console.log(`Helper script created: ${helperScriptPath}`);
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Failed to create remote device package:', error.message);
  process.exit(1);
});

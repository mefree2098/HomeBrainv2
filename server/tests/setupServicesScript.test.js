const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');

test('hardened HomeBrain unit starts from the repo root with the explicit environment', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts/harden-homebrain-service.sh'), 'utf8');
  assert.match(script, /WorkingDirectory=\$REPO/);
  assert.doesNotMatch(script, /WorkingDirectory=\$REPO\/server/);
  assert.match(script, /EnvironmentFile=-\$REPO\/server\/\.env/);
  assert.match(script, /Environment=HOMEBRAIN_BOOTSTRAP_NODE_BIN=\/usr\/bin\/node/);
  assert.match(script, /ExecStart=\$REPO\/scripts\/run-homebrain-server-with-modern-node\.sh/);
});

test('HomeBrain server loads server/.env independently of the process cwd', () => {
  const server = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');

  assert.match(server, /require\("dotenv"\)\.config\(\{ path: path\.join\(__dirname, "\.env"\) \}\)/);
});

test('hardened service waits for its app mount and limits crash loops', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts/harden-homebrain-service.sh'), 'utf8');
  assert.match(script, /After=local-fs\.target network-online\.target mongod\.service/);
  assert.match(script, /RequiresMountsFor=\$REPO/);
  assert.match(script, /StartLimitIntervalSec=300/);
  assert.match(script, /StartLimitBurst=30/);
  assert.match(script, /RestartSec=10/);
});

test('dedicated service account retains hardware groups without administrative groups', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts/harden-homebrain-service.sh'), 'utf8');
  const groups = script.match(/for group in ([^;]+);/)[1].split(' ');
  assert.ok(groups.includes('dialout'));
  assert.ok(groups.includes('plugdev'));
  assert.equal(groups.some((group) => ['sudo', 'adm', 'docker'].includes(group)), false);
  assert.match(script, /usermod -G/);
  assert.match(script, /User=homebrain/);
});

test('privileged Thread installation is absent from runtime service-control grants', () => {
  const setup = fs.readFileSync(path.join(repoRoot, 'scripts/setup-services.sh'), 'utf8');
  const control = fs.readFileSync(path.join(repoRoot, 'scripts/homebrain-host-control.py'), 'utf8');
  assert.doesNotMatch(setup, /NOPASSWD:/);
  assert.doesNotMatch(control, /homebrain-jetson-kernel-control|homebrain-otbr-control|shell=True/);
});

test('setup-services neutralizes legacy standalone discovery units', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');

  assert.match(script, /LEGACY_DISCOVERY_SERVICE_NAME="\$\{HOMEBRAIN_LEGACY_DISCOVERY_SERVICE_NAME:-homebrain-discovery\}"/);
  assert.match(script, /legacy_discovery_service_exists/);
  assert.match(script, /neutralize_legacy_discovery_backend_service/);
  assert.doesNotMatch(script, /ExecStart=\/bin\/true/);
  assert.match(script, /systemctl stop "\$\{LEGACY_DISCOVERY_SERVICE_NAME\}\.service"/);
  assert.match(script, /rm -f "\$\{LEGACY_DISCOVERY_SERVICE_PATH\}"/);
});

test('setup-services removes the legacy direct server start drop-in', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');

  assert.match(script, /LEGACY_DIRECT_SERVER_START_DROPIN_PATH="\$\{SERVICE_DROPIN_DIR\}\/98-direct-server-start\.conf"/);
  assert.match(script, /neutralize_legacy_direct_server_start_dropin/);
  assert.match(script, /rm -f "\$\{LEGACY_DIRECT_SERVER_START_DROPIN_PATH\}"/);
});

test('install and update paths apply Caddy config after bootstrapping reverse proxy state', () => {
  const setupScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');
  const installScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'install-linux.sh'), 'utf8');
  const bootstrapScript = fs.readFileSync(path.join(repoRoot, 'server', 'scripts', 'bootstrapReverseProxyState.js'), 'utf8');

  assert.match(setupScript, /bootstrapReverseProxyState\.js --actor system:update --apply/);
  assert.match(installScript, /bootstrapReverseProxyState\.js --actor system:install --apply/);
  assert.match(bootstrapScript, /argv\.includes\('--apply'\)/);
  assert.match(bootstrapScript, /reverseProxyService\.applyConfig\(actor\)/);
});

test('reverse proxy bootstrap can apply only when generated Caddy config changed', () => {
  const bootstrapScriptPath = path.join(repoRoot, 'server', 'scripts', 'bootstrapReverseProxyState.js');
  const { parseOptions, shouldApplyConfig } = require(bootstrapScriptPath);
  const bootstrapScript = fs.readFileSync(bootstrapScriptPath, 'utf8');

  assert.deepEqual(parseOptions([
    '--actor',
    'platform-deploy:admin@example.com',
    '--apply-if-changed'
  ]), {
    actor: 'platform-deploy:admin@example.com',
    apply: false,
    applyIfChanged: true
  });
  assert.equal(shouldApplyConfig({ apply: false, applyIfChanged: false }), false);
  assert.equal(shouldApplyConfig({ apply: true, applyIfChanged: false }), true);
  assert.equal(shouldApplyConfig({ apply: false, applyIfChanged: true }, {
    config: { changed: false }
  }), false);
  assert.equal(shouldApplyConfig({ apply: false, applyIfChanged: true }, {
    config: { changed: true }
  }), true);
  assert.equal(shouldApplyConfig({ apply: false, applyIfChanged: true }), true);
  assert.match(bootstrapScript, /Caddy config unchanged/);
  assert.match(bootstrapScript, /Unable to compare Caddy config before apply; applying normally/);
});

test('Pi-hole installer download retries transient failures and uses the official GitHub fallback', (t) => {
  const setupScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-pihole-download-test-'));
  const binDir = path.join(tempDir, 'bin');
  const installerPath = path.join(tempDir, 'pihole-install.sh');
  const curlLogPath = path.join(tempDir, 'curl.log');
  const primaryUrl = 'https://primary.invalid/install.sh';
  const fallbackUrl = 'https://fallback.invalid/basic-install.sh';

  assert.match(setupScript, /https:\/\/install\.pi-hole\.net/);
  assert.match(setupScript, /https:\/\/raw\.githubusercontent\.com\/pi-hole\/pi-hole\/master\/automated%20install\/basic-install\.sh/);

  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'curl'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${curlLogPath}"
output_path=""
source_url=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o) output_path="$2"; shift 2 ;;
    http*) source_url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "\${source_url}" == "${primaryUrl}" ]]; then
  exit 6
fi
printf '%s\\n' '#!/usr/bin/env bash' '# Official Pi-hole installer' > "\${output_path}"
`,
    { mode: 0o755 }
  );

  const result = spawnSync(
    'bash',
    ['-c', 'source "$1"; download_pihole_installer "$2"', 'bash', path.join(repoRoot, 'scripts', 'setup-services.sh'), installerPath],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOMEBRAIN_PIHOLE_INSTALLER_URL: primaryUrl,
        HOMEBRAIN_PIHOLE_INSTALLER_FALLBACK_URL: fallbackUrl,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`
      }
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(fs.readFileSync(installerPath, 'utf8'), /Official Pi-hole installer/);
  const curlCalls = fs.readFileSync(curlLogPath, 'utf8').trim().split('\n');
  assert.equal(curlCalls.length, 2);
  assert.match(curlCalls[0], /--retry 5 --retry-all-errors --retry-delay 3/);
  assert.ok(curlCalls[0].includes(primaryUrl));
  assert.ok(curlCalls[1].includes(fallbackUrl));
});

test('restart helper stops legacy standalone discovery before starting HomeBrain', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'restart-homebrain-service.sh'), 'utf8');

  assert.match(script, /LEGACY_DISCOVERY_SERVICE_NAME="\$\{HOMEBRAIN_LEGACY_DISCOVERY_SERVICE_NAME:-homebrain-discovery\}"/);
  assert.match(script, /stop_legacy_discovery_service/);
  assert.match(script, /"\$\{SYSTEMCTL_BIN\}" stop "\$\{LEGACY_DISCOVERY_SERVICE_NAME\}\.service"/);
  assert.match(script, /stop_legacy_discovery_service\s*\nstop_homebrain_service/);
});

test('service helpers allow Z-Wave cache shutdown to finish before forced restart', () => {
  const setupScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');
  const unitInstaller = fs.readFileSync(path.join(repoRoot, 'scripts/harden-homebrain-service.sh'), 'utf8');
  const restartHelper = fs.readFileSync(path.join(repoRoot, 'scripts', 'restart-homebrain-service.sh'), 'utf8');

  assert.match(setupScript, /local wait_seconds="\$\{2:-90\}"/);
  assert.match(unitInstaller, /TimeoutStopSec=90/);
  assert.match(unitInstaller, /KillMode=control-group/);
  assert.match(restartHelper, /WAIT_SECONDS="\$\{HOMEBRAIN_RESTART_WAIT_SECONDS:-90\}"/);
});

test('setup-services installs smbclient for SMB disaster recovery backups', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');

  assert.match(script, /install_backup_smb_tools/);
  assert.match(script, /apt-get install -y smbclient/);
});

test('setup-services checks systemd units without grep short-circuit pipelines', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');

  assert.match(script, /awk -v unit="\$\{unit_name\}\.service"/);
  assert.doesNotMatch(script, /list-unit-files \| grep -q/);
});

test('service helpers do a post-stop HomeBrain process sweep', () => {
  const setupScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');
  const restartHelper = fs.readFileSync(path.join(repoRoot, 'scripts', 'restart-homebrain-service.sh'), 'utf8');
  const restoreHelper = fs.readFileSync(path.join(repoRoot, 'scripts', 'restore-homebrain-backup.sh'), 'utf8');

  for (const script of [setupScript, restartHelper, restoreHelper]) {
    assert.match(script, /local include_service_pid="\$\{1:-false\}"/);
    assert.match(script, /cleanup_orphaned_homebrain_processes true/);
  }
});

test('HomeBrain systemd launcher execs into the selected Node server process', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-homebrain-server-with-modern-node.sh'), 'utf8');

  assert.match(script, /run-with-modern-node\.js --print-node-bin/);
  assert.match(script, /cleanup_blocking_homebrain_port_listener/);
  assert.match(script, /exec "\$\{SELECTED_NODE\}" "\$\{HOMEBRAIN_DIR\}\/server\/server\.js"/);
});

test('HomeBrain systemd launcher reclaims an existing HomeBrain port listener before exec', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-launcher-test-'));
  const binDir = path.join(tempDir, 'bin');
  const scriptsDir = path.join(tempDir, 'scripts');
  const serverDir = path.join(tempDir, 'server');
  const selectedNodePath = path.join(binDir, 'selected-node');
  const launchedArgsPath = path.join(tempDir, 'launched-args.txt');

  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  fs.writeFileSync(
    path.join(scriptsDir, 'run-with-modern-node.js'),
    `if (process.argv[2] === '--print-node-bin') { console.log(${JSON.stringify(selectedNodePath)}); process.exit(0); }\nprocess.exit(1);\n`,
    'utf8'
  );
  fs.writeFileSync(
    selectedNodePath,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "${LAUNCHED_ARGS_PATH}"\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(binDir, 'ss'),
    '#!/usr/bin/env bash\nprintf "%s\\n" "LISTEN 0 511 0.0.0.0:31337 0.0.0.0:* users:((\\"node\\",pid=4242,fd=20))"\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(binDir, 'ps'),
    '#!/usr/bin/env bash\nprintf "/usr/bin/node %s/server/server.js\\n" "${HOMEBRAIN_DIR}"\n',
    { mode: 0o755 }
  );

  const result = spawnSync('bash', [path.join(repoRoot, 'scripts', 'run-homebrain-server-with-modern-node.sh')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOMEBRAIN_DIR: tempDir,
      HOMEBRAIN_PORT: '31337',
      HOMEBRAIN_BOOTSTRAP_NODE_BIN: process.execPath,
      LAUNCHED_ARGS_PATH: launchedArgsPath,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Stopping existing HomeBrain listener\(s\) on port 31337: 4242/);
  assert.equal(fs.readFileSync(launchedArgsPath, 'utf8').trim(), path.join(tempDir, 'server', 'server.js'));
});

test('Thread kernel helper validates the custom kernel before scheduling reboot', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'homebrain-jetson-kernel-control.sh'), 'utf8');

  assert.match(script, /CONFIG_IP_ADVANCED_ROUTER/);
  assert.match(script, /--job-id/);
  assert.match(script, /"jobId"/);
  assert.match(script, /"logFile"/);
  assert.match(script, /run_preflight_validation/);
  assert.match(script, /restore_extlinux_backup_after_failed_validation/);
  assert.match(script, /custom kernel config enables Thread multicast routing/);
  assert.match(script, /matching modules directory exists/);
  assert.match(script, /stock boot fallback label remains available/);
  assert.match(script, /json_file_or_null/);
  assert.match(script, /preflight helper returned validation details/);
  assert.match(script, /validate\|preflight/);
  assert.match(script, /run_preflight_validation[\s\S]+mark_pending_reboot/);
  assert.doesNotMatch(script, /^\s+path\.write_text/m);
});

test('Thread kernel helper validate emits parseable JSON on failed preflight', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-thread-kernel-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const result = spawnSync('bash', [path.join(repoRoot, 'scripts', 'homebrain-jetson-kernel-control.sh'), 'validate'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOMEBRAIN_THREAD_KERNEL_STATE_DIR: tempDir,
      HOMEBRAIN_THREAD_KERNEL_EXTLINUX_CONF: path.join(tempDir, 'extlinux.conf'),
      HOMEBRAIN_THREAD_KERNEL_IMAGE: path.join(tempDir, 'Image.homebrain-thread'),
      HOMEBRAIN_THREAD_KERNEL_INITRD: path.join(tempDir, 'initrd.homebrain-thread'),
      HOMEBRAIN_THREAD_KERNEL_CONFIG: path.join(tempDir, 'config.homebrain-thread'),
      HOMEBRAIN_THREAD_KERNEL_SOURCE_DIR: path.join(tempDir, 'kernel-src')
    }
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.checks[0].name, 'custom kernel image exists');
});

test('platform service update checks use the package cache and parse Pi-hole latest versions cleanly', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');

  const check = script.split('check_apt_service_update() {')[1].split('check_pihole_update() {')[0];
  assert.doesNotMatch(check, /sudo|apt-get update/);
  assert.match(script, /awk '\/Candidate:\/ \{candidate=\$2\} END \{print candidate\}'/);
  assert.match(script, /version_output="\$\(pihole version 2>\/dev\/null \|\| true\)"/);
  assert.match(script, /latest_version="\$\(printf '%s\\n' "\$\{version_output\}"[\s\S]+sed 's\/,\/, \/g'\)"/);
  assert.match(script, /current="\$\{version_pair%%\|\*\}"/);
  assert.match(script, /latest="\$\{version_pair#\*\|\}"/);
});

test('platform service setup migrates legacy MongoDB apt trust before refreshing packages', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');

  assert.match(script, /migrate_legacy_mongodb_apt_sources\(\)/);
  assert.match(script, /https:\/\/pgp[.]mongodb[.]com\/server-\$\{version\}[.]asc/);
  assert.match(script, /signed-by=" keyring/);
  assert.match(script, /setup_platform_services\(\) \{\s+migrate_legacy_mongodb_apt_sources\s+setup_caddy/);
});

test('MongoDB apt source migration preserves repository details and adds exact keyring trust', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-mongodb-source-'));
  const sourcePath = path.join(tempDir, 'mongodb.list');
  const scriptPath = path.join(repoRoot, 'scripts', 'setup-services.sh');
  const keyring = '/usr/share/keyrings/mongodb-server-6.0.gpg';
  fs.writeFileSync(sourcePath, [
    '# MongoDB repository',
    'deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/6.0 multiverse',
    'deb https://example.com/ubuntu jammy main'
  ].join('\n'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const result = spawnSync('bash', [
    '-c',
    'source "$1"; rewrite_mongodb_apt_source "$2" "$3"',
    'bash',
    scriptPath,
    sourcePath,
    keyring
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    '# MongoDB repository',
    `deb [ arch=amd64,arm64 signed-by=${keyring} ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/6.0 multiverse`,
    'deb https://example.com/ubuntu jammy main',
    ''
  ].join('\n'));
});

test('setup-services manages Codex CLI installation and npm update discovery', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');

  assert.match(script, /setup_codex_cli\(\)/);
  assert.match(script, /install --global @openai\/codex@latest/);
  assert.match(script, /view @openai\/codex version/);
  assert.match(script, /codex --version/);
  assert.match(script, /codex\) check_codex_cli_update/);
  assert.match(script, /codex\)\s+setup_codex_cli/);
});

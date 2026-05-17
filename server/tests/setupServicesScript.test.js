const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');

test('setup-services writes a HomeBrain unit that starts from the repo root', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');

  assert.match(script, /WorkingDirectory=\$\{HOMEBRAIN_DIR\}/);
  assert.doesNotMatch(script, /WorkingDirectory=\$\{HOMEBRAIN_DIR\}\/server/);
  assert.match(script, /ExecStart=\$\{node_bin\} scripts\/run-with-modern-node\.js node server\/server\.js/);
});

test('setup-services waits for the app mount and avoids tight reboot crash loops', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');

  assert.match(script, /After=local-fs\.target network-online\.target mongod\.service/);
  assert.match(script, /RequiresMountsFor=\$\{HOMEBRAIN_DIR\}/);
  assert.match(script, /StartLimitIntervalSec=300/);
  assert.match(script, /StartLimitBurst=30/);
  assert.match(script, /RestartSec=10/);
});

test('setup-services installs privileged Thread helpers and grants sudoers access', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');

  assert.match(script, /homebrain-otbr-control\.sh/);
  assert.match(script, /homebrain-jetson-kernel-control\.sh/);
  assert.match(script, /install_thread_kernel_privileged_helper/);
  assert.match(script, /\$\{THREAD_KERNEL_HELPER_INSTALL_PATH\} \*/);
});

test('setup-services installs smbclient for SMB disaster recovery backups', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'setup-services.sh'), 'utf8');

  assert.match(script, /install_backup_smb_tools/);
  assert.match(script, /apt-get install -y smbclient/);
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

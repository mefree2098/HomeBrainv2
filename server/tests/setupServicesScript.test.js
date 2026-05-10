const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

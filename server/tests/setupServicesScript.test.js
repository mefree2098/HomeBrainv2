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

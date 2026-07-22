const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helperPath = path.resolve(__dirname, '..', '..', 'codex', 'skills', 'homebrain-live', 'scripts', 'homebrain-live.js');

test('homebrain-live stores and selects named targets without exposing tokens', (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-live-targets-'));
  const configPath = path.join(codexHome, 'homebrain-live.json');
  const legacyToken = 'hbcdx_live_freestone-test-token';
  const seleneToken = 'hbcdx_live_selene-test-token';
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    HOMEBRAIN_CODEX_URL: '',
    HOMEBRAIN_CODEX_TOKEN: '',
    HOMEBRAIN_CODEX_TARGET: ''
  };

  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  fs.writeFileSync(configPath, JSON.stringify({
    baseUrl: 'https://freestonefamily.com',
    token: legacyToken
  }), { mode: 0o600 });

  const setResult = spawnSync(process.execPath, [
    helperPath,
    'target-set',
    'selene',
    '--url',
    'https://selene.ntechr.com',
    '--token-stdin',
    '--default',
    'true'
  ], {
    env,
    input: seleneToken,
    encoding: 'utf8'
  });

  assert.equal(setResult.status, 0, setResult.stderr);
  assert.doesNotMatch(setResult.stdout, /selene-test-token/);

  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.baseUrl, 'https://freestonefamily.com');
  assert.equal(saved.token, legacyToken);
  assert.deepEqual(saved.targets.selene, {
    baseUrl: 'https://selene.ntechr.com',
    token: seleneToken
  });
  assert.equal(saved.defaultTarget, 'selene');
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);

  const listResult = spawnSync(process.execPath, [helperPath, 'target-list'], {
    env,
    encoding: 'utf8'
  });

  assert.equal(listResult.status, 0, listResult.stderr);
  assert.doesNotMatch(listResult.stdout, /test-token/);
  const listed = JSON.parse(listResult.stdout);
  assert.equal(listed.defaultTarget, 'selene');
  assert.equal(listed.legacyDefault.default, false);
  assert.equal(listed.targets[0].name, 'selene');
  assert.equal(listed.targets[0].baseUrl, 'https://selene.ntechr.com');
  assert.equal(listed.targets[0].default, true);

  const probe = spawnSync(process.execPath, [helperPath, 'request', '/ping', '--target', 'missing'], {
    env,
    encoding: 'utf8'
  });
  assert.equal(probe.status, 1);
  assert.match(probe.stderr, /Available targets: selene/);
});

test('dashboard gives first-run users a direct Voice Profile recovery action', () => {
  const dashboardSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'client', 'src', 'pages', 'Dashboard.tsx'),
    'utf8'
  );

  assert.match(dashboardSource, /Dashboard editing needs an active Voice Profile\./);
  assert.match(dashboardSource, /<Link to="\/voice-profiles">Create Voice Profile<\/Link>/);
});

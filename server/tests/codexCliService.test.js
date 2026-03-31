const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('path');

const {
  buildCodexOutputSchema,
  extractCodexTurnText,
  pickCodexModel,
  resolveCodexLaunchSpec,
  resolveDraftCodexHome,
  resolveLocalCodexHomeCandidates,
  resolveSessionOptions
} = require('../services/codexCliService');

test('resolveDraftCodexHome maps supported profiles to the expected paths', () => {
  assert.equal(resolveDraftCodexHome('local', '', '/mnt/efs'), path.join(os.homedir(), '.codex', 'homebrain'));
  assert.equal(resolveDraftCodexHome('custom', '/srv/codex-home', '/mnt/efs'), '/srv/codex-home');
  assert.equal(resolveDraftCodexHome('aws', '', '/mnt/shared'), '/mnt/shared/.codex/homebrain');
  assert.equal(resolveDraftCodexHome('azure', '', '/mnt/efs'), '/home/site/.codex/homebrain');
});

test('resolveCodexLaunchSpec uses node for explicit JavaScript entrypoints', () => {
  const spec = resolveCodexLaunchSpec('/opt/tools/codex-wrapper.js');

  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args, ['/opt/tools/codex-wrapper.js', 'app-server', '--listen', 'stdio://']);
  assert.equal(spec.source, 'script');
});

test('pickCodexModel prefers an exact match and otherwise falls back to the default model', () => {
  const models = [
    { id: 'gpt-5.4-mini', model: 'gpt-5.4-mini', isDefault: false },
    { id: 'gpt-5.4', model: 'gpt-5.4', isDefault: true }
  ];

  assert.equal(pickCodexModel('gpt-5.4-mini', models), 'gpt-5.4-mini');
  assert.equal(pickCodexModel('missing-model', models), 'gpt-5.4');
});

test('extractCodexTurnText prioritizes final answers over later fallbacks', () => {
  assert.equal(
    extractCodexTurnText({
      finalAnswerText: '{"ok":true}',
      lastCompletedMessageText: '{"fallback":true}',
      deltaText: '{"delta":true}'
    }),
    '{"ok":true}'
  );

  assert.equal(
    extractCodexTurnText({
      finalAnswerText: '',
      lastCompletedMessageText: '{"fallback":true}',
      deltaText: '{"delta":true}'
    }),
    '{"fallback":true}'
  );
});

test('buildCodexOutputSchema reuses explicit Codex or Ollama JSON schema payloads', () => {
  const explicitSchema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  assert.deepEqual(buildCodexOutputSchema({ codexOutputSchema: explicitSchema }), explicitSchema);

  const ollamaSchema = { type: 'object', properties: { value: { type: 'string' } } };
  assert.deepEqual(buildCodexOutputSchema({ ollamaFormat: ollamaSchema }), ollamaSchema);
  assert.equal(buildCodexOutputSchema({ ollamaFormat: 'json' }), null);
});

test('resolveLocalCodexHomeCandidates prefers the shared Codex home when it already has auth', async (t) => {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-codex-home-pref-'));
  const sharedHome = path.join(fakeHome, '.codex');
  const isolatedHome = path.join(sharedHome, 'homebrain');

  await fs.mkdir(sharedHome, { recursive: true });
  await fs.mkdir(isolatedHome, { recursive: true });
  await fs.writeFile(path.join(sharedHome, 'auth.json'), '{"token":"present"}', 'utf8');
  await fs.writeFile(path.join(isolatedHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n', 'utf8');

  t.after(async () => {
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  assert.deepEqual(resolveLocalCodexHomeCandidates(fakeHome), [sharedHome, isolatedHome]);
});

test('resolveSessionOptions ignores non-custom codexHome overrides and resolves local homes outside the repo by default', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-codex-test-'));
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-codex-user-home-'));
  t.after(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  const options = await resolveSessionOptions({
    settings: {
      codexHomeProfile: 'local',
      codexHome: '/should/not/be/used',
      codexAwsVolumeRoot: '/mnt/efs'
    },
    overrides: {
      codexHome: '/also/ignored',
      codexHomeProfile: 'local'
    },
    cwd,
    homeDir: fakeHome
  });

  assert.equal(options.codexHome, '');
  assert.equal(options.codexHomeProfile, 'local');
  assert.equal(options.effectiveCodexHome, path.join(fakeHome, '.codex', 'homebrain'));
});

test('resolveSessionOptions reuses an authenticated shared Codex home before the isolated default', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-codex-test-'));
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-codex-user-home-'));
  const sharedHome = path.join(fakeHome, '.codex');

  await fs.mkdir(sharedHome, { recursive: true });
  await fs.writeFile(path.join(sharedHome, 'auth.json'), '{"token":"present"}', 'utf8');

  t.after(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(fakeHome, { recursive: true, force: true });
  });

  const options = await resolveSessionOptions({
    settings: {
      codexHomeProfile: 'local',
      codexAwsVolumeRoot: '/mnt/efs'
    },
    cwd,
    homeDir: fakeHome
  });

  assert.equal(options.codexHome, '');
  assert.equal(options.codexHomeProfile, 'local');
  assert.equal(options.effectiveCodexHome, sharedHome);
});

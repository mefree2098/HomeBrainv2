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
  resolveSessionOptions
} = require('../services/codexCliService');

test('resolveDraftCodexHome maps supported profiles to the expected paths', () => {
  assert.equal(resolveDraftCodexHome('local', '', '/mnt/efs'), path.resolve(process.cwd(), '.codex-home'));
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

test('resolveSessionOptions ignores non-custom codexHome overrides and resolves local homes from cwd', async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-codex-test-'));
  t.after(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
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
    cwd
  });

  assert.equal(options.codexHome, '');
  assert.equal(options.codexHomeProfile, 'local');
  assert.equal(options.effectiveCodexHome, path.resolve(cwd, '.codex-home'));
});

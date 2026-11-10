const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const apiSourcePath = path.join(repoRoot, 'client', 'src', 'api', 'api.ts');
const settingsSourcePath = path.join(repoRoot, 'client', 'src', 'pages', 'Settings.tsx');

test('Dynamic DNS push refreshes status without replacing unsaved settings or reloading the page', () => {
  const apiSource = fs.readFileSync(apiSourcePath, 'utf8');
  const settingsSource = fs.readFileSync(settingsSourcePath, 'utf8');

  assert.match(settingsSource, /applyDynamicDnsStatus\(settingsResponse\.settings/);
  assert.doesNotMatch(apiSource, /globalThis\.loadSettings|window\.location\.reload\(\)/);
});

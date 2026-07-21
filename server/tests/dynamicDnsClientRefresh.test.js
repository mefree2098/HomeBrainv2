const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const apiSourcePath = path.join(repoRoot, 'client', 'src', 'api', 'api.ts');
const settingsSourcePath = path.join(repoRoot, 'client', 'src', 'pages', 'Settings.tsx');

test('Dynamic DNS push has a defined settings refresh fallback', () => {
  const apiSource = fs.readFileSync(apiSourcePath, 'utf8');
  const settingsSource = fs.readFileSync(settingsSourcePath, 'utf8');

  assert.match(settingsSource, /await\s+loadSettings\(\)/);
  assert.match(apiSource, /globalThis\.loadSettings\s*=\s*async\s*\(\)\s*=>/);
  assert.match(apiSource, /window\.location\.reload\(\)/);
});

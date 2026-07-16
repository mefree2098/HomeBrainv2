const test = require('node:test');
const assert = require('node:assert/strict');

const Settings = require('../models/Settings');

test('Settings persists normalized Codex thinking levels including newer advertised values', () => {
  const settings = new Settings({ codexEffort: 'ULTRA' });

  assert.equal(settings.codexEffort, 'ultra');
  assert.equal(settings.validateSync(), undefined);
});

test('Settings rejects malformed Codex thinking level values', () => {
  const settings = new Settings({ codexEffort: 'not a valid level' });
  const validationError = settings.validateSync();

  assert.ok(validationError?.errors?.codexEffort);
});

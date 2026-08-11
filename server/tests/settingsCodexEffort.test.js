const test = require('node:test');
const assert = require('node:assert/strict');

const Settings = require('../models/Settings');

test('Settings persists normalized Codex thinking levels including newer advertised values', async () => {
  const settings = new Settings({ codexEffort: 'ULTRA' });

  assert.equal(settings.codexEffort, 'ultra');
  await assert.doesNotReject(settings.validate());
});

test('Settings rejects malformed Codex thinking level values', async () => {
  const settings = new Settings({ codexEffort: 'not a valid level' });

  await assert.rejects(
    settings.validate(),
    (validationError) => Boolean(validationError?.errors?.codexEffort)
  );
});

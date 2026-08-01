const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

test('Sense initialization waits for the database connection', () => {
  const serverScript = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');
  const senseStartupBlock = serverScript.match(
    /\/\/ Initialize Sense energy integration([\s\S]*?)async function gracefulShutdown/
  );

  assert.ok(senseStartupBlock, 'Sense startup block is present');
  assert.match(
    senseStartupBlock[1],
    /await dbReady;\s+await senseService\.initialize\(\);/
  );
});

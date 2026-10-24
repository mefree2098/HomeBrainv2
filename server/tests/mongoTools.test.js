const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { withMongoToolsConfig } = require('../utils/mongoTools');

test('Mongo tools receive only a private config path and credentials are removed after success', async () => {
  const url = new URL('mongodb://127.0.0.1/HomeBrain');
  url.username = 'fixture';
  url.password = 'isolated-fixture-value';
  let configPath;
  const result = await withMongoToolsConfig(url.href, async (arg) => {
    assert.ok(arg.startsWith('--config='));
    assert.equal(arg.includes(url.password), false);
    configPath = arg.slice('--config='.length);
    assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), { uri: url.href });
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(configPath))).mode & 0o777, 0o700);
    return 'completed';
  });
  assert.equal(result, 'completed');
  await assert.rejects(fs.stat(configPath), { code: 'ENOENT' });
});

test('Mongo tools remove the private config when the command fails', async () => {
  let configPath;
  await assert.rejects(withMongoToolsConfig('mongodb://127.0.0.1/HomeBrain', async (arg) => {
    configPath = arg.slice('--config='.length);
    throw new Error('Fixture command failed');
  }), /Fixture command failed/);
  await assert.rejects(fs.stat(path.dirname(configPath)), { code: 'ENOENT' });
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const generalDownloadStorage = require('../services/generalDownloadStorage');

test('normalizeDownloadPath accepts nested public download paths', () => {
  assert.equal(
    generalDownloadStorage.normalizeDownloadPath('public-domain/PreprocessedPublicDomainLibrary.scoreflowseed'),
    'public-domain/PreprocessedPublicDomainLibrary.scoreflowseed'
  );
});

test('normalizeDownloadPath rejects traversal outside the downloads root', () => {
  assert.throws(
    () => generalDownloadStorage.normalizeDownloadPath('../../etc/passwd'),
    /inside the downloads folder/
  );
});

test('writeDownloadStream stores files under the configured general downloads root', async (t) => {
  const originalRoot = process.env.GENERAL_DOWNLOADS_ROOT;
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'homebrain-downloads-'));
  t.after(async () => {
    if (originalRoot === undefined) {
      delete process.env.GENERAL_DOWNLOADS_ROOT;
    } else {
      process.env.GENERAL_DOWNLOADS_ROOT = originalRoot;
    }
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  process.env.GENERAL_DOWNLOADS_ROOT = tempRoot;
  const result = await generalDownloadStorage.writeDownloadStream(
    'public-domain/example.scoreflowseed',
    Readable.from([Buffer.from('scoreflow')])
  );

  assert.equal(result.relativePath, 'public-domain/example.scoreflowseed');
  assert.equal(result.bytes, 9);
  assert.equal(await fs.promises.readFile(result.absolutePath, 'utf8'), 'scoreflow');
});

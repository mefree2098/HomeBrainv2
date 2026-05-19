const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const generalDownloadStorage = require('../services/generalDownloadStorage');

async function withTempDownloadsRoot(t) {
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
  return tempRoot;
}

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
  await withTempDownloadsRoot(t);
  const result = await generalDownloadStorage.writeDownloadStream(
    'public-domain/example.scoreflowseed',
    Readable.from([Buffer.from('scoreflow')])
  );

  assert.equal(result.relativePath, 'public-domain/example.scoreflowseed');
  assert.equal(result.bytes, 9);
  assert.equal(await fs.promises.readFile(result.absolutePath, 'utf8'), 'scoreflow');
});

test('writeDownloadChunk resumes chunks and finalizes with a SHA-256 digest', async (t) => {
  await withTempDownloadsRoot(t);
  const first = await generalDownloadStorage.writeDownloadChunk(
    'public-domain/example.scoreflowseed',
    Readable.from([Buffer.from('score')]),
    {
      offset: 0,
      totalBytes: 9,
      expectedBytes: 5
    }
  );

  assert.equal(first.complete, false);
  assert.equal(first.nextOffset, 5);

  const uploadInfo = await generalDownloadStorage.getDownloadUploadInfo('public-domain/example.scoreflowseed');
  assert.equal(uploadInfo.file.exists, false);
  assert.equal(uploadInfo.staging.exists, true);
  assert.equal(uploadInfo.staging.size, 5);

  const second = await generalDownloadStorage.writeDownloadChunk(
    'public-domain/example.scoreflowseed',
    Readable.from([Buffer.from('flow')]),
    {
      offset: 5,
      totalBytes: 9,
      expectedBytes: 4,
      complete: true
    }
  );

  assert.equal(second.complete, true);
  assert.equal(second.nextOffset, 9);
  assert.equal(second.sha256, '8a64c099404d141e3cc882d08fdb6ca131bed21f665d0a28832d1e0a222e16ae');
  assert.equal(await fs.promises.readFile(second.absolutePath, 'utf8'), 'scoreflow');

  const finalInfo = await generalDownloadStorage.getDownloadUploadInfo('public-domain/example.scoreflowseed');
  assert.equal(finalInfo.file.exists, true);
  assert.equal(finalInfo.file.size, 9);
  assert.equal(finalInfo.staging.exists, false);
});

test('writeDownloadChunk rejects mismatched offsets so resumable uploads stay consistent', async (t) => {
  await withTempDownloadsRoot(t);
  await generalDownloadStorage.writeDownloadChunk(
    'public-domain/example.scoreflowseed',
    Readable.from([Buffer.from('score')]),
    {
      offset: 0,
      totalBytes: 9,
      expectedBytes: 5
    }
  );

  await assert.rejects(
    () => generalDownloadStorage.writeDownloadChunk(
      'public-domain/example.scoreflowseed',
      Readable.from([Buffer.from('flow')]),
      {
        offset: 4,
        totalBytes: 9,
        expectedBytes: 4
      }
    ),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.expectedOffset, 5);
      return true;
    }
  );
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-zip-security-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, 'extract');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(destination);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'runtime.bin'), 'original');
  const zip = new AdmZip();
  zip.addFile('bin/runtime.bin', Buffer.from('replacement'));
  return { destination, outside, zip };
}

const extractors = {
  all: (zip, destination) => zip.extractAllTo(destination, true),
  async: (zip, destination) => zip.extractAllToAsync(destination, true),
  entry: (zip, destination) => zip.extractEntryTo('bin/runtime.bin', destination, true, true)
};

for (const [name, extract] of Object.entries(extractors)) {
  for (const link of ['directory', 'file']) {
    test(`${name} extraction refuses a pre-existing ${link} symlink outside its destination`, async (t) => {
      const { destination, outside, zip } = fixture(t);
      if (link === 'directory') {
        fs.symlinkSync(outside, path.join(destination, 'bin'), 'dir');
      } else {
        fs.mkdirSync(path.join(destination, 'bin'));
        fs.symlinkSync(path.join(outside, 'runtime.bin'), path.join(destination, 'bin/runtime.bin'));
      }
      await assert.rejects(async () => extract(zip, destination), /file in the way|Unable to extract/i);
      assert.equal(fs.readFileSync(path.join(outside, 'runtime.bin'), 'utf8'), 'original');
    });
  }

  test(`${name} extraction preserves ordinary nested runtime files`, async (t) => {
    const { destination, zip } = fixture(t);
    await extract(new AdmZip(zip.toBuffer()), destination);
    assert.equal(fs.readFileSync(path.join(destination, 'bin/runtime.bin'), 'utf8'), 'replacement');
  });
}

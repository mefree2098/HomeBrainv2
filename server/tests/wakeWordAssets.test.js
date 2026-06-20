const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const wakeWordAssets = require('../utils/wakeWordAssets');

test('getAssetForWakeWord includes adjacent ONNX external data files', (t) => {
  const slug = `codex-sidecar-${Date.now()}`;
  const modelPath = path.join(wakeWordAssets.WAKE_WORD_ROOT, `${slug}.onnx`);
  const dataPath = path.join(wakeWordAssets.WAKE_WORD_ROOT, `${slug}.onnx.data`);

  fs.mkdirSync(wakeWordAssets.WAKE_WORD_ROOT, { recursive: true });
  fs.writeFileSync(modelPath, 'model');
  fs.writeFileSync(dataPath, 'external-data');
  t.after(() => {
    fs.rmSync(modelPath, { force: true });
    fs.rmSync(dataPath, { force: true });
  });

  const asset = wakeWordAssets.getAssetForWakeWord('Codex Sidecar', {
    slug,
    allowGeneric: true
  });

  assert.equal(asset.fileName, `${slug}.onnx`);
  assert.equal(asset.dependencies.length, 1);
  assert.equal(asset.dependencies[0].fileName, `${slug}.onnx.data`);
  assert.equal(asset.dependencies[0].size, Buffer.byteLength('external-data'));
  assert.match(asset.dependencies[0].checksum, /^[a-f0-9]{64}$/);
});

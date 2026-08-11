const assert = require('node:assert/strict');
const test = require('node:test');

const certificateValidator = require('../utils/certificateValidator');
const { extractCertificateBlocks, validatePemSize } = certificateValidator.__private__;

const BLOCK = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n';

test('certificate chain parsing is bounded and rejects incomplete PEM blocks', () => {
  assert.deepEqual(extractCertificateBlocks(`${BLOCK}\n${BLOCK}`), [BLOCK, BLOCK]);
  assert.throws(
    () => extractCertificateBlocks('-----BEGIN CERTIFICATE-----\nmissing end'),
    /incomplete PEM block/
  );
  assert.throws(() => extractCertificateBlocks(BLOCK.repeat(11)), /exceeds 10 certificates/);
});

test('PEM inputs have an explicit size limit', () => {
  assert.doesNotThrow(() => validatePemSize(BLOCK, 'Certificate'));
  assert.throws(() => validatePemSize('x'.repeat(512 * 1024 + 1), 'Certificate'), /too large/);
});

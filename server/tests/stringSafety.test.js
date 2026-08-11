const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collapseWhitespace,
  isSafeObjectKey,
  toAsciiSlug,
  trimTrailingCharacter
} = require('../utils/stringSafety');

test('ASCII slugs are produced without unbounded regular expressions', () => {
  assert.equal(toAsciiSlug('  Hey, HomeBrain!  '), 'hey-homebrain');
  assert.equal(toAsciiSlug('___', { fallback: 'custom' }), 'custom');
  assert.equal(toAsciiSlug('my_platform', { allowUnderscore: true }), 'my_platform');
  assert.equal(toAsciiSlug('a'.repeat(500)).length, 100);
  assert.equal(toAsciiSlug('long slug value', { maxLength: 8 }), 'long-slu');
});

test('string normalization is bounded and deterministic', () => {
  assert.equal(collapseWhitespace('  one\n\t two   three  '), 'one two three');
  assert.equal(collapseWhitespace('abcdef', 3), 'abc');
  assert.equal(trimTrailingCharacter('host.example...', '.'), 'host.example');
});

test('object key validation rejects prototype mutation segments', () => {
  assert.equal(isSafeObjectKey('brightness'), true);
  assert.equal(isSafeObjectKey('__proto__'), false);
  assert.equal(isSafeObjectKey('constructor'), false);
  assert.equal(isSafeObjectKey('prototype'), false);
  assert.equal(isSafeObjectKey('a'.repeat(257)), false);
});

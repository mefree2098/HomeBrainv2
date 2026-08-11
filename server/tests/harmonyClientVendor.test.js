const assert = require('node:assert/strict');
const test = require('node:test');

const { __private__ } = require('../vendor/harmony-client-ws');

test('Harmony client accepts only local, credential-free hub addresses', () => {
  assert.equal(__private__.normalizeHost('http://192.168.1.20:8088'), '192.168.1.20');
  assert.equal(__private__.normalizeHost('[fd00::20]:8088'), 'fd00::20');
  assert.equal(__private__.normalizeHost('http://user:secret@192.168.1.20'), '');
  assert.equal(__private__.normalizeHost('http://192.168.1.20/path'), '');
  assert.equal(__private__.isAllowedHubHost('192.168.1.20'), true);
  assert.equal(__private__.isAllowedHubHost('8.8.8.8'), false);
  assert.equal(__private__.isAllowedHubHost('public.example'), false);
});

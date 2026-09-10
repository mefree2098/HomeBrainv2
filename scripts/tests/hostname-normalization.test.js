const test = require('node:test');
const assert = require('node:assert/strict');
const server = require('../../server/utils/networkSafety');
const broker = require('../../broker/src/outboundNetworkSafety');

for (const [name, { normalizeHostname }] of Object.entries({ server, broker })) {
  test(`${name}: hostname normalization preserves aliases and strips only suffixes`, () => {
    assert.equal(normalizeHostname(' HUB.Local... '), 'hub.local');
    assert.equal(normalizeHostname(' Metadata.Google.Internal... '), 'metadata.google.internal');
    assert.equal(normalizeHostname('[FE80::1%eth0]'), 'fe80::1');
    assert.equal(normalizeHostname('[::FFFF:A9FE:A9FE]'), '::ffff:a9fe:a9fe');
    assert.equal(normalizeHostname(null), '');
    assert.equal(normalizeHostname('...'), '');
    assert.equal(normalizeHostname('a...b...'), 'a...b');
    const dottedLabel = '.'.repeat(2_048);
    assert.equal(normalizeHostname(dottedLabel + 'end'), dottedLabel + 'end');
    assert.equal(normalizeHostname('hub.local' + dottedLabel), 'hub.local');
  });
}

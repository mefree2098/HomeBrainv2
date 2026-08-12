const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createOutboundAgents,
  createValidatedLookup,
  isCloudMetadataHostname,
  isPermittedAddress,
  isPublicAddress,
  normalizeHostname
} = require('../src/outboundNetworkSafety');

function runLookup(lookup, hostname, options = {}) {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ address, family });
    });
  });
}

test('normalizes hostnames and recognizes cloud metadata targets', () => {
  assert.equal(normalizeHostname('[::1]'), '::1');
  assert.equal(normalizeHostname('Metadata.Google.Internal.'), 'metadata.google.internal');
  assert.equal(isCloudMetadataHostname('169.254.169.254'), true);
  assert.equal(isCloudMetadataHostname('instance-data.ec2.internal'), true);
  assert.equal(isCloudMetadataHostname('example.com'), false);
});

test('only permits globally routable addresses by default', () => {
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicAddress('127.0.0.1'), false);
  assert.equal(isPublicAddress('10.0.0.1'), false);
  assert.equal(isPublicAddress('2001:db8::1'), false);
  assert.equal(isPermittedAddress('10.0.0.1'), false);
  assert.equal(isPermittedAddress('10.0.0.1', { allowPrivate: true }), true);
  assert.equal(isPermittedAddress('169.254.169.254', { allowPrivate: true }), false);
  assert.equal(isPermittedAddress('fd00:ec2::254', { allowPrivate: true }), false);
});

test('validated lookup pins the expected hostname to validated public DNS answers', async () => {
  const lookup = createValidatedLookup('hub.example.com', {
    lookup: (_hostname, options, callback) => {
      assert.deepEqual(options, { all: true, verbatim: true });
      callback(null, [{ address: '203.0.113.20', family: 4 }]);
    }
  });

  await assert.rejects(
    runLookup(lookup, 'other.example.com'),
    /hostname changed/
  );
  await assert.rejects(
    runLookup(lookup, 'hub.example.com'),
    /outside the permitted network/
  );
});

test('validated lookup returns a public address and rejects mixed private DNS answers', async () => {
  const publicLookup = createValidatedLookup('hub.example.com', {
    lookup: (_hostname, _options, callback) => callback(null, [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 }
    ])
  });
  assert.deepEqual(
    await runLookup(publicLookup, 'hub.example.com', { family: 4 }),
    { address: '8.8.8.8', family: 4 }
  );

  const reboundLookup = createValidatedLookup('hub.example.com', {
    lookup: (_hostname, _options, callback) => callback(null, [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ])
  });
  await assert.rejects(
    runLookup(reboundLookup, 'hub.example.com'),
    /outside the permitted network/
  );
});

test('private addresses require opt-in and metadata remains blocked', async () => {
  assert.throws(
    () => createOutboundAgents('http://127.0.0.1:4301'),
    /outside the permitted network/
  );
  assert.ok(createOutboundAgents('http://127.0.0.1:4301', { allowPrivate: true }).httpAgent);
  await assert.rejects(
    runLookup(createValidatedLookup('127.0.0.1'), '127.0.0.1'),
    /outside the permitted network/
  );
  assert.deepEqual(
    await runLookup(createValidatedLookup('127.0.0.1', { allowPrivate: true }), '127.0.0.1'),
    { address: '127.0.0.1', family: 4 }
  );
  assert.throws(
    () => createValidatedLookup('metadata.google.internal', { allowPrivate: true }),
    /cloud metadata service/
  );
});

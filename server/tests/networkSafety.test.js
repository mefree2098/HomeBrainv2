const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appendUrlPath,
  buildSameOriginUrl,
  createLocalAddressLookup,
  createLocalHttpAgents,
  isAllowedLocalHostname,
  isAllowedResolvedAddress,
  parseHttpUrl,
  parseLocalHttpUrl,
  parseServiceOrigin,
  trimLeadingSlashes,
  trimTrailingSlashes
} = require('../utils/networkSafety');

test('slash trimming helpers are linear and preserve non-slash content', () => {
  assert.equal(trimLeadingSlashes('///api/test'), 'api/test');
  assert.equal(trimTrailingSlashes('https://example.test///'), 'https://example.test');
  assert.equal(trimTrailingSlashes('/'), '');
});

test('local host checks allow LAN names and private addresses', () => {
  for (const hostname of ['localhost', 'ollama.local', 'ollama', '127.0.0.1', '10.0.0.2', '172.16.1.2', '192.168.1.2', '::1', 'fd00::2']) {
    assert.equal(isAllowedLocalHostname(hostname), true, hostname);
  }
  for (const hostname of ['example.com', '8.8.8.8', '172.32.0.1']) {
    assert.equal(isAllowedLocalHostname(hostname), false, hostname);
  }
});

test('HTTP URL parsing rejects non-HTTP protocols and embedded credentials', () => {
  assert.throws(() => parseHttpUrl('file:///etc/passwd'), /http or https/);
  assert.throws(() => parseHttpUrl('https://user:secret@example.test'), /credentials/);
  assert.equal(parseHttpUrl('https://example.test/path#fragment').toString(), 'https://example.test/path');
});

test('local HTTP URL parsing supplies a protocol and rejects public hosts', () => {
  assert.equal(parseLocalHttpUrl('ollama.local:11434').origin, 'http://ollama.local:11434');
  assert.throws(() => parseLocalHttpUrl('https://example.com'), /local or private/);
  assert.throws(() => parseLocalHttpUrl('http://169.254.169.254/latest/meta-data'), /metadata service/);
});

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

test('local request lookup pins private DNS results and rejects rebinding targets', async () => {
  const privateLookup = createLocalAddressLookup('ollama.local', {
    lookup: (_hostname, _options, callback) => callback(null, [
      { address: '192.168.1.25', family: 4 }
    ])
  });
  assert.deepEqual(await runLookup(privateLookup, 'ollama.local'), {
    address: '192.168.1.25',
    family: 4
  });

  const publicLookup = createLocalAddressLookup('ollama.local', {
    lookup: (_hostname, _options, callback) => callback(null, [
      { address: '203.0.113.10', family: 4 }
    ])
  });
  await assert.rejects(() => runLookup(publicLookup, 'ollama.local'), /outside the permitted network/);

  const metadataLookup = createLocalAddressLookup('ollama.local', {
    lookup: (_hostname, _options, callback) => callback(null, [
      { address: '169.254.169.254', family: 4 }
    ])
  });
  await assert.rejects(() => runLookup(metadataLookup, 'ollama.local'), /outside the permitted network/);
  await assert.rejects(() => runLookup(privateLookup, 'different.local'), /hostname changed/);
});

test('local HTTP agents enforce certificate validation and restricted address resolution', () => {
  const agents = createLocalHttpAgents(new URL('https://ollama.local:11434'));
  assert.equal(agents.httpsAgent.options.rejectUnauthorized, true);
  assert.equal(typeof agents.httpsAgent.options.lookup, 'function');
  assert.equal(isAllowedResolvedAddress('192.168.1.25'), true);
  assert.equal(isAllowedResolvedAddress('203.0.113.10'), false);
  assert.equal(isAllowedResolvedAddress('169.254.169.254'), false);
});

test('URL paths are appended without changing the configured base path', () => {
  assert.equal(
    appendUrlPath('http://ollama.local:11434/v1/', '/health').toString(),
    'http://ollama.local:11434/v1/health'
  );
});

test('service origins require TLS away from the local network', () => {
  assert.equal(parseServiceOrigin('https://broker.example.test/path'), 'https://broker.example.test');
  assert.equal(parseServiceOrigin('http://127.0.0.1:4301'), 'http://127.0.0.1:4301');
  assert.throws(() => parseServiceOrigin('http://broker.example.test'), /must use https/);
});

test('same-origin URL resolution rejects absolute URLs for another service', () => {
  assert.equal(
    buildSameOriginUrl('/api/assets/model.bin', 'https://hub.example.test').toString(),
    'https://hub.example.test/api/assets/model.bin'
  );
  assert.throws(
    () => buildSameOriginUrl('https://attacker.example/model.bin', 'https://hub.example.test'),
    /configured service origin/
  );
});

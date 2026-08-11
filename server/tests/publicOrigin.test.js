const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildClientRedirectUrl,
  getRequestOrigin,
  normalizeOrigin,
  toWebSocketOrigin
} = require('../utils/publicOrigin');

function request(host, protocol = 'https') {
  return {
    protocol,
    secure: protocol === 'https',
    get(name) {
      return String(name).toLowerCase() === 'host' ? host : '';
    }
  };
}

test('public origins only accept credential-free HTTP URLs', () => {
  assert.equal(normalizeOrigin('https://homebrain.example/path/'), 'https://homebrain.example');
  assert.equal(normalizeOrigin('file:///tmp/test'), '');
  assert.equal(normalizeOrigin('https://user:secret@homebrain.example'), '');
});

test('production does not trust an unconfigured public Host header for redirects', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousClientUrl = process.env.CLIENT_URL;
  const previousPublicBaseUrl = process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  const previousFallbackBaseUrl = process.env.PUBLIC_BASE_URL;
  process.env.NODE_ENV = 'production';
  delete process.env.CLIENT_URL;
  delete process.env.HOMEBRAIN_PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  try {
    assert.equal(getRequestOrigin(request('attacker.example')), '');
    assert.equal(getRequestOrigin(request('192.168.1.50:3000', 'http')), 'http://192.168.1.50:3000');
    assert.equal(
      buildClientRedirectUrl(request('attacker.example'), '/settings', { status: 'error' }),
      '/settings?status=error'
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousClientUrl === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = previousClientUrl;
    if (previousPublicBaseUrl === undefined) delete process.env.HOMEBRAIN_PUBLIC_BASE_URL;
    else process.env.HOMEBRAIN_PUBLIC_BASE_URL = previousPublicBaseUrl;
    if (previousFallbackBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousFallbackBaseUrl;
  }
});

test('configured client origins produce encoded absolute redirect URLs', () => {
  const previousClientUrl = process.env.CLIENT_URL;
  process.env.CLIENT_URL = 'https://app.example.test/base';
  try {
    assert.equal(
      buildClientRedirectUrl(request('ignored.example'), '/settings', {
        integration: 'error',
        message: 'bad & worse'
      }),
      'https://app.example.test/settings?integration=error&message=bad+%26+worse'
    );
  } finally {
    if (previousClientUrl === undefined) delete process.env.CLIENT_URL;
    else process.env.CLIENT_URL = previousClientUrl;
  }
});

test('websocket origins preserve host and choose the matching secure scheme', () => {
  assert.equal(toWebSocketOrigin('https://homebrain.example'), 'wss://homebrain.example');
  assert.equal(toWebSocketOrigin('http://127.0.0.1:3000'), 'ws://127.0.0.1:3000');
});

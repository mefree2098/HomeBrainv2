const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildMetricsRequest,
  parseArgs
} = require('../scripts/checkSmartThingsWebhookHealth');

test('health checker parses standalone flags without looping or skipping following options', () => {
  const options = parseArgs([
    'node',
    'checkSmartThingsWebhookHealth.js',
    '--insecure',
    '--url',
    'https://localhost:3000/metrics',
    '--help'
  ]);

  assert.equal(options.insecure, true);
  assert.equal(options.url, 'https://localhost:3000/metrics');
  assert.equal(options.help, true);
});

test('metrics health requests require TLS for public hosts', () => {
  assert.throws(() => buildMetricsRequest({
    url: 'http://example.com/api/smartthings/webhook/metrics'
  }), /must use https/);
});

test('metrics health requests never disable TLS verification for public hosts', () => {
  assert.throws(() => buildMetricsRequest({
    url: 'https://example.com/api/smartthings/webhook/metrics',
    insecure: true
  }), /only allowed for local or private metrics targets/);
});

test('local metrics health requests scope custom TLS behavior to one pinned agent', () => {
  const previousGlobalTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const { requestConfig } = buildMetricsRequest({
    url: 'https://127.0.0.1:3000/api/smartthings/webhook/metrics',
    insecure: true,
    token: 'test-token'
  });

  assert.equal(requestConfig.maxRedirects, 0);
  assert.equal(requestConfig.httpsAgent.options.rejectUnauthorized, false);
  assert.equal(typeof requestConfig.httpsAgent.options.lookup, 'function');
  assert.equal(requestConfig.headers.Authorization, 'Bearer test-token');
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, previousGlobalTlsSetting);
});

test('local metrics health requests verify certificates by default', () => {
  const { requestConfig } = buildMetricsRequest({
    url: 'https://localhost:3000/api/smartthings/webhook/metrics'
  });

  assert.equal(requestConfig.httpsAgent.options.rejectUnauthorized, true);
});

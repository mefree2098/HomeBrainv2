const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBrokerClient,
  getBrokerBaseUrl,
  getBrokerTimeoutMs
} = require('../src/brokerClient');

function withEnvironment(t, values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test('broker configuration requires an HTTPS origin while allowing loopback tests', (t) => {
  withEnvironment(t, {
    HOMEBRAIN_BROKER_BASE_URL: 'https://alexa-broker.example.com/'
  });
  assert.equal(getBrokerBaseUrl(), 'https://alexa-broker.example.com');

  process.env.HOMEBRAIN_BROKER_BASE_URL = 'http://127.0.0.1:4301';
  assert.equal(getBrokerBaseUrl(), 'http://127.0.0.1:4301');

  process.env.HOMEBRAIN_BROKER_BASE_URL = 'http://alexa-broker.example.com';
  assert.throws(() => getBrokerBaseUrl(), /must use HTTPS/);

  process.env.HOMEBRAIN_BROKER_BASE_URL = 'https://alexa-broker.example.com/api';
  assert.throws(() => createBrokerClient(), /only the broker origin/);
});

test('broker timeouts preserve room for an Alexa response before the Lambda deadline', (t) => {
  withEnvironment(t, {
    HOMEBRAIN_BROKER_TIMEOUT_MS: '7000'
  });

  assert.equal(getBrokerTimeoutMs(), 7000);
  assert.equal(getBrokerTimeoutMs({ getRemainingTimeInMillis: () => 2000 }), 1250);
  assert.throws(
    () => getBrokerTimeoutMs({ getRemainingTimeInMillis: () => 900 }),
    (error) => error.code === 'HOMEBRAIN_LAMBDA_DEADLINE'
  );

  process.env.HOMEBRAIN_BROKER_TIMEOUT_MS = '12000';
  assert.equal(getBrokerTimeoutMs(), 7500);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const http2 = require('http2');
const jwt = require('jsonwebtoken');
const apnsService = require('../services/apnsService');

function withEnv(overrides, fn) {
  const original = {};
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(overrides)) {
        if (original[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = original[key];
        }
      }
      apnsService._resetProviderTokenForTests();
    });
}

function installApnsStubs(t) {
  const originalConnect = http2.connect;
  const originalSign = jwt.sign;
  const requests = [];

  jwt.sign = () => 'provider-token';
  http2.connect = (host) => {
    const client = new EventEmitter();
    client.close = () => {};
    client.request = (headers) => {
      const request = new EventEmitter();
      request.setEncoding = () => {};
      request.end = (payload) => {
        requests.push({ host, headers, payload: JSON.parse(payload) });
        setImmediate(() => {
          request.emit('response', { ':status': 200, 'apns-id': headers['apns-id'] });
          request.emit('end');
        });
      };
      return request;
    };
    return client;
  };

  t.after(() => {
    http2.connect = originalConnect;
    jwt.sign = originalSign;
    apnsService._resetProviderTokenForTests();
  });

  return requests;
}

test('sendAlertToToken routes watchOS pushes to the watch APNs topic and requested environment', async (t) => {
  const requests = installApnsStubs(t);

  await withEnv({
    HOMEBRAIN_APNS_TEAM_ID: 'TEAM123',
    HOMEBRAIN_APNS_KEY_ID: 'KEY123',
    HOMEBRAIN_APNS_PRIVATE_KEY: 'fake-private-key',
    HOMEBRAIN_APNS_ENVIRONMENT: 'production',
    HOMEBRAIN_APNS_BUNDLE_ID: 'com.example.HomeBrain',
    HOMEBRAIN_APNS_WATCH_BUNDLE_ID: 'com.example.HomeBrain.watchkitapp'
  }, async () => {
    const result = await apnsService.sendAlertToToken('watch-token', {
      title: 'Alarm',
      body: 'Alarm has gone off.',
      deviceFamily: 'watchOS',
      environment: 'development',
      notificationId: 'notification-1',
      eventType: 'security.alarm.triggered',
      eventKey: 'alarm-1',
      deviceId: 'siren-1',
      ttlSeconds: 60
    });

    assert.equal(result.success, true);
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].host, 'https://api.sandbox.push.apple.com');
  assert.equal(requests[0].headers['apns-topic'], 'com.example.HomeBrain.watchkitapp');
  assert.equal(requests[0].headers['apns-push-type'], 'alert');
  assert.equal(requests[0].headers['apns-priority'], '10');
  assert.equal(requests[0].payload.aps['interruption-level'], 'time-sensitive');
  assert.equal(requests[0].payload.homebrain.channel, 'securityCritical');
  assert.equal(requests[0].payload.homebrain.deviceId, 'siren-1');
});

test('sendAlertToToken keeps iOS pushes on the iOS topic and supports production override', async (t) => {
  const requests = installApnsStubs(t);

  await withEnv({
    HOMEBRAIN_APNS_TEAM_ID: 'TEAM123',
    HOMEBRAIN_APNS_KEY_ID: 'KEY123',
    HOMEBRAIN_APNS_PRIVATE_KEY: 'fake-private-key',
    HOMEBRAIN_APNS_ENVIRONMENT: 'development',
    HOMEBRAIN_APNS_BUNDLE_ID: 'com.example.HomeBrain',
    HOMEBRAIN_APNS_WATCH_BUNDLE_ID: 'com.example.HomeBrain.watchkitapp'
  }, async () => {
    const result = await apnsService.sendAlertToToken('iphone-token', {
      title: 'Alarm',
      body: 'Alarm has gone off.',
      deviceFamily: 'iPhone',
      environment: 'production'
    });

    assert.equal(result.success, true);
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].host, 'https://api.push.apple.com');
  assert.equal(requests[0].headers['apns-topic'], 'com.example.HomeBrain');
});

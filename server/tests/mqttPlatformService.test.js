const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  MqttPlatformService,
  normalizeTopicPrefix,
  redactBrokerUrl
} = require('../services/mqttPlatformService');

function createLogger() {
  return {
    log() {},
    warn() {},
    error() {}
  };
}

function createFakeMqttClient(published) {
  const client = new EventEmitter();
  client.connected = true;
  client.publish = (topic, message, options, callback) => {
    published.push({ topic, message, options });
    callback?.(null);
  };
  client.end = (_force, options, callback) => {
    client.connected = false;
    if (typeof options === 'function') {
      options();
      return;
    }
    callback?.();
  };
  return client;
}

test('MQTT bridge is disabled by default in tests', async () => {
  const service = new MqttPlatformService({
    env: { NODE_ENV: 'test' },
    logger: createLogger(),
    mqttFactory: () => {
      throw new Error('should not load mqtt client');
    }
  });

  const status = await service.getStatus({ probe: true });
  const result = await service.publishEvent({ type: 'test.event', category: 'test' });

  assert.equal(status.enabled, false);
  assert.equal(status.status, 'healthy');
  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'disabled');
});

test('MQTT bridge publishes HomeBrain events to stable JSON topics', async (t) => {
  const published = [];
  const client = createFakeMqttClient(published);
  const eventStreamService = new EventEmitter();
  const service = new MqttPlatformService({
    env: {
      NODE_ENV: 'test',
      HOMEBRAIN_MQTT_ENABLED: 'true',
      HOMEBRAIN_MQTT_URL: 'mqtt://user:secret@127.0.0.1:1883',
      HOMEBRAIN_MQTT_TOPIC_PREFIX: 'homebrain/test hub'
    },
    logger: createLogger(),
    mqttFactory: () => ({
      connect: () => client
    })
  });

  t.after(async () => {
    await service.shutdown();
  });

  await service.initialize({ eventStreamService });
  eventStreamService.emit('event', {
    id: 'event-1',
    type: 'deploy.completed',
    category: 'deployment',
    severity: 'info',
    payload: { ok: true }
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(published.length, 1);
  assert.equal(published[0].topic, 'homebrain/test-hub/events/deployment/deploy.completed');
  assert.deepEqual(published[0].options, { qos: 0, retain: false });

  const payload = JSON.parse(published[0].message);
  assert.equal(payload.schema, 'homebrain.event.v1');
  assert.equal(payload.event.id, 'event-1');
  assert.equal(payload.event.payload.ok, true);

  const status = await service.getStatus();
  assert.equal(status.brokerUrl, 'mqtt://***:***@127.0.0.1:1883');
});

test('MQTT bridge publishes retained per-device state topics', async (t) => {
  const published = [];
  const client = createFakeMqttClient(published);
  const service = new MqttPlatformService({
    env: {
      NODE_ENV: 'test',
      HOMEBRAIN_MQTT_ENABLED: 'true',
      HOMEBRAIN_MQTT_TOPIC_PREFIX: 'homebrain'
    },
    logger: createLogger(),
    mqttFactory: () => ({
      connect: () => client
    })
  });

  t.after(async () => {
    await service.shutdown();
  });

  await service.initialize();
  await service.publishDeviceUpdate([
    { _id: 'device/one', name: 'Kitchen Light', state: { power: 'on' } }
  ]);

  assert.equal(published.length, 2);
  assert.equal(published[0].topic, 'homebrain/devices/update');
  assert.equal(published[1].topic, 'homebrain/devices/device-one/state');
  assert.deepEqual(published[1].options, { qos: 1, retain: true });

  const payload = JSON.parse(published[1].message);
  assert.equal(payload.schema, 'homebrain.device.state.v1');
  assert.equal(payload.device.name, 'Kitchen Light');
});

test('MQTT bridge uses platform-managed broker configuration overrides', async (t) => {
  const published = [];
  const client = createFakeMqttClient(published);
  let connectArgs = null;
  const service = new MqttPlatformService({
    env: {
      NODE_ENV: 'test',
      HOMEBRAIN_MQTT_ENABLED: 'false',
      HOMEBRAIN_MQTT_URL: 'mqtt://ignored.example.test:1883'
    },
    configOverride: {
      mode: 'enabled',
      protocol: 'mqtts',
      host: 'broker.homebrain.test',
      port: 8883,
      topicPrefix: 'homebrain/live',
      clientId: 'homebrain-managed-client',
      username: 'homebrain',
      password: 'secret'
    },
    logger: createLogger(),
    mqttFactory: () => ({
      connect: (url, options) => {
        connectArgs = { url, options };
        return client;
      }
    })
  });

  t.after(async () => {
    await service.shutdown();
  });

  await service.publishEvent({ type: 'test.event', category: 'test' });

  assert.equal(connectArgs.url, 'mqtts://broker.homebrain.test:8883');
  assert.equal(connectArgs.options.clientId, 'homebrain-managed-client');
  assert.equal(connectArgs.options.username, 'homebrain');
  assert.equal(connectArgs.options.password, 'secret');
  assert.equal(published[0].topic, 'homebrain/live/events/test/test.event');
});

test('MQTT bridge auto mode skips publishing when the broker is unavailable', async () => {
  let mqttConnectAttempted = false;
  let probeCount = 0;
  const service = new MqttPlatformService({
    env: {
      NODE_ENV: 'production',
      HOMEBRAIN_MQTT_ENABLED: 'auto',
      HOMEBRAIN_MQTT_URL: 'mqtt://127.0.0.1:1883'
    },
    logger: createLogger(),
    mqttFactory: () => {
      mqttConnectAttempted = true;
      return {
        connect: () => {
          throw new Error('should not connect after failed probe');
        }
      };
    },
    netConnect: () => {
      probeCount += 1;
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      process.nextTick(() => socket.emit('error', new Error('connect ECONNREFUSED')));
      return socket;
    },
    connectBackoffMs: 60_000
  });

  const result = await service.publishEvent({
    type: 'test.event',
    category: 'test'
  });
  const secondResult = await service.publishEvent({
    type: 'test.event',
    category: 'test'
  });
  const status = await service.getStatus();

  assert.equal(result.success, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'not_connected');
  assert.equal(secondResult.success, false);
  assert.equal(secondResult.reason, 'not_connected');
  assert.equal(mqttConnectAttempted, false);
  assert.equal(probeCount, 1);
  assert.equal(status.status, 'healthy');
  assert.equal(status.message, 'MQTT broker is not detected; bridge is idle in auto mode.');
});

test('MQTT topic prefix normalization and URL redaction are stable', () => {
  assert.equal(normalizeTopicPrefix(' homebrain / bad/#/name '), 'homebrain/bad/name');
  assert.equal(redactBrokerUrl('mqtt://alice:hunter2@example.test:1883'), 'mqtt://***:***@example.test:1883');
});

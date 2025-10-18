const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const smartThingsWebhookService = require('../services/smartThingsWebhookService');
const SmartThingsIntegration = require('../models/SmartThingsIntegration');
const smartThingsService = require('../services/smartThingsService');
const Device = require('../models/Device');
const deviceUpdateEmitter = require('../services/deviceUpdateEmitter');

test('verifyRequestSignature accepts valid signature and resets failure counters', async (t) => {
  smartThingsWebhookService.resetMetrics();

  const originalGetIntegration = SmartThingsIntegration.getIntegration;
  t.after(() => {
    SmartThingsIntegration.getIntegration = originalGetIntegration;
  });

  SmartThingsIntegration.getIntegration = async () => ({
    clientSecret: 'super-secret'
  });

  const payload = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');
  const signature = crypto.createHmac('sha256', 'super-secret').update(payload).digest('base64');

  await smartThingsWebhookService.verifyRequestSignature(payload, { 'x-st-signature': signature });

  const metrics = smartThingsWebhookService.getMetricsSnapshot();
  assert.equal(metrics.received.total, 1);
  assert.equal(metrics.signature.failures, 0);
  assert.equal(metrics.signature.consecutiveFailures, 0);
  assert.ok(metrics.signature.lastSuccessAt);
});

test('verifyRequestSignature rejects invalid signature and records failure', async (t) => {
  smartThingsWebhookService.resetMetrics();

  const originalGetIntegration = SmartThingsIntegration.getIntegration;
  t.after(() => {
    SmartThingsIntegration.getIntegration = originalGetIntegration;
  });

  SmartThingsIntegration.getIntegration = async () => ({
    clientSecret: 'super-secret'
  });

  const payload = Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8');

  await assert.rejects(
    smartThingsWebhookService.verifyRequestSignature(payload, { 'x-st-signature': 'invalid' }),
    /Signature mismatch|Invalid SmartThings signature|Missing x-st-signature/
  );

  const metrics = smartThingsWebhookService.getMetricsSnapshot();
  assert.equal(metrics.received.total, 1);
  assert.equal(metrics.signature.failures, 1);
  assert.equal(metrics.signature.consecutiveFailures, 1);
  assert.ok(metrics.signature.lastFailureAt);
});

test('handleEvent updates devices, emits updates, and records metrics', async (t) => {
  smartThingsWebhookService.resetMetrics();

  const originalGetIntegration = SmartThingsIntegration.getIntegration;
  const integrationState = {
    webhook: { locationId: 'location-1' },
    async updateWebhookState(update) {
      this.lastUpdatePayload = update;
    }
  };

  SmartThingsIntegration.getIntegration = async () => integrationState;
  t.after(() => {
    SmartThingsIntegration.getIntegration = originalGetIntegration;
  });

  const originalBuildUpdate = smartThingsService.buildSmartThingsDeviceUpdate;
  smartThingsService.buildSmartThingsDeviceUpdate = async () => ({ status: true });
  t.after(() => {
    smartThingsService.buildSmartThingsDeviceUpdate = originalBuildUpdate;
  });

  const trackedDevice = {
    _id: 'mongo-id-1',
    name: 'Test Lamp',
    status: false,
    properties: {
      smartThingsDeviceId: 'device-1',
      smartThingsCapabilities: ['switch'],
      smartThingsLocationId: 'location-1'
    }
  };

  const refreshedDevice = {
    _id: 'mongo-id-1',
    status: true,
    properties: {
      smartThingsDeviceId: 'device-1'
    }
  };

  const originalDeviceFind = Device.find;
  const originalBulkWrite = Device.bulkWrite;
  let capturedBulkOps = null;

  Device.find = (query) => {
    if (query && query._id && query._id.$in) {
      return {
        lean: async () => [refreshedDevice]
      };
    }
    return {
      lean: async () => [trackedDevice]
    };
  };

  Device.bulkWrite = async (ops) => {
    capturedBulkOps = ops;
  };

  t.after(() => {
    Device.find = originalDeviceFind;
    Device.bulkWrite = originalBulkWrite;
  });

  const originalEmit = deviceUpdateEmitter.emit;
  const emittedUpdates = [];
  deviceUpdateEmitter.emit = (eventName, payload) => {
    emittedUpdates.push({ eventName, payload });
  };
  t.after(() => {
    deviceUpdateEmitter.emit = originalEmit;
  });

  const nowIso = new Date().toISOString();
  const response = await smartThingsWebhookService.handleEvent({
    lifecycle: 'EVENT',
    eventData: {
      events: [
        {
          eventId: 'evt-1',
          deviceId: 'device-1',
          componentId: 'main',
          capability: 'switch',
          attribute: 'switch',
          value: 'on',
          eventTime: nowIso
        }
      ]
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.eventData.status, 'PROCESSED');
  assert.ok(Array.isArray(capturedBulkOps));
  assert.equal(capturedBulkOps.length, 1);
  assert.equal(emittedUpdates.length, 1);
  assert.equal(emittedUpdates[0].eventName, 'devices:update');
  assert.equal(Array.isArray(emittedUpdates[0].payload), true);

  const metrics = smartThingsWebhookService.getMetricsSnapshot();
  assert.equal(metrics.events.received, 1);
  assert.equal(metrics.events.processedDevices, 1);
  assert.equal(metrics.events.ignoredDevices, 0);
  assert.equal(metrics.events.perCapability.switch, 1);
  assert.ok(metrics.events.lastAt);

  assert.ok(integrationState.lastUpdatePayload);
  assert.ok(integrationState.lastUpdatePayload.lastEventReceivedAt);
});

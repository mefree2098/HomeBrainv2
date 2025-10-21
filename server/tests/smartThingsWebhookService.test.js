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

test('refreshWebhookSubscriptions renews capability subscriptions and updates state', async (t) => {
  smartThingsService.stopSubscriptionRenewalTask?.();

  const originalGetIntegration = SmartThingsIntegration.getIntegration;
  const integrationState = {
    webhook: {
      installedAppId: 'installed-app-1',
      locationId: 'location-1'
    },
    async updateWebhookState(update) {
      this.lastUpdatePayload = update;
    }
  };

  SmartThingsIntegration.getIntegration = async () => integrationState;

  const originalReplace = smartThingsService.replaceCapabilitySubscriptions;
  const originalList = smartThingsService.listSubscriptions;
  const replaceCalls = [];

  smartThingsService.replaceCapabilitySubscriptions = async (installedAppId, locationId, descriptors) => {
    replaceCalls.push({ installedAppId, locationId, descriptors });
    return [];
  };

  const sampleSubscription = {
    id: 'subscription-1',
    capability: {
      capability: 'switch',
      attribute: 'switch',
      componentId: 'main',
      stateChangeOnly: true
    },
    createdDate: new Date().toISOString()
  };

  smartThingsService.listSubscriptions = async () => [sampleSubscription];

  smartThingsService.subscriptionRefreshInProgress = false;

  t.after(() => {
    SmartThingsIntegration.getIntegration = originalGetIntegration;
    smartThingsService.replaceCapabilitySubscriptions = originalReplace;
    smartThingsService.listSubscriptions = originalList;
    smartThingsService.stopSubscriptionRenewalTask?.();
  });

  await smartThingsService.refreshWebhookSubscriptions();

  assert.equal(replaceCalls.length, 1);
  assert.ok(integrationState.lastUpdatePayload);
  assert.ok(Array.isArray(integrationState.lastUpdatePayload.subscriptions));
  assert.equal(integrationState.lastUpdatePayload.subscriptions.length, 1);
  assert.equal(integrationState.lastUpdatePayload.subscriptions[0].capability, 'switch');
  assert.ok(integrationState.lastUpdatePayload.lastSubscriptionSync);
});

test('getPrometheusMetrics exposes counters and gauges', async (t) => {
  smartThingsWebhookService.resetMetrics();

  const fixedNow = new Date('2025-10-18T12:00:00.000Z');
  smartThingsWebhookService.recordRequestReceipt();
  smartThingsWebhookService.recordLifecycle('PING');
  smartThingsWebhookService.recordSignatureFailure('signature mismatch');
  smartThingsWebhookService.recordSignatureSuccess();
  smartThingsWebhookService.incrementCapabilityMetric('switch');
  smartThingsWebhookService.incrementCapabilityMetric('switch');

  smartThingsWebhookService.metrics.events.received = 3;
  smartThingsWebhookService.metrics.events.processedDevices = 2;
  smartThingsWebhookService.metrics.events.ignoredDevices = 1;
  smartThingsWebhookService.metrics.events.lastAt = fixedNow;
  smartThingsWebhookService.metrics.received.lastRequestAt = new Date(fixedNow.getTime() - 5000);
  smartThingsWebhookService.metrics.lifecycle.lastAt = new Date(fixedNow.getTime() - 2000);
  smartThingsWebhookService.metrics.signature.lastFailureAt = new Date(fixedNow.getTime() - 10000);
  smartThingsWebhookService.metrics.signature.lastSuccessAt = new Date(fixedNow.getTime() - 1000);

  const body = smartThingsWebhookService.getPrometheusMetrics();

  assert.match(body, /smartthings_webhook_requests_total 1/);
  assert.match(body, /smartthings_webhook_requests_by_lifecycle_total{lifecycle="ping"} 1/);
  assert.match(body, /smartthings_webhook_signature_failures_total 1/);
  assert.match(body, /smartthings_webhook_events_total 3/);
  assert.match(body, /smartthings_webhook_events_by_capability_total{capability="switch"} 2/);
  assert.match(body, /smartthings_webhook_events_processed_devices_total 2/);
  assert.match(body, /smartthings_webhook_events_ignored_devices_total 1/);
  assert.match(body, /smartthings_webhook_last_event_timestamp \d+/);

  smartThingsWebhookService.resetMetrics();
});

test('metrics history captures bounded snapshots', async (t) => {
  smartThingsWebhookService.resetMetrics();
  smartThingsWebhookService.stopMetricsSampler?.();

  const originalHistorySize = smartThingsWebhookService.metricsHistorySize;
  const shouldRestartSampler = smartThingsWebhookService.metricsSnapshotIntervalMs > 0;

  t.after(() => {
    smartThingsWebhookService.metricsHistorySize = originalHistorySize;
    smartThingsWebhookService.metricsHistory = [];
    if (shouldRestartSampler) {
      smartThingsWebhookService.startMetricsSampler();
    }
  });

  smartThingsWebhookService.metricsHistorySize = 2;

  smartThingsWebhookService.captureMetricsSnapshot('first');
  smartThingsWebhookService.captureMetricsSnapshot('second');
  smartThingsWebhookService.captureMetricsSnapshot('third');

  const fullHistory = smartThingsWebhookService.getMetricsHistory();
  assert.equal(fullHistory.length, 2);
  assert.equal(fullHistory[0].reason, 'second');
  assert.equal(fullHistory[1].reason, 'third');

  const limitedHistory = smartThingsWebhookService.getMetricsHistory(1);
  assert.equal(limitedHistory.length, 1);
  assert.equal(limitedHistory[0].reason, 'third');
});

test('updateMetricsConfig validates and applies production cadence', async (t) => {
  smartThingsWebhookService.resetMetrics();
  smartThingsWebhookService.stopMetricsSampler?.();

  const originalInterval = smartThingsWebhookService.metricsSnapshotIntervalMs;
  const originalHistory = smartThingsWebhookService.metricsHistorySize;

  t.after(() => {
    smartThingsWebhookService.updateMetricsConfig({
      intervalMs: originalInterval,
      historySize: originalHistory
    });
  });

  const newConfig = smartThingsWebhookService.updateMetricsConfig({
    intervalMs: 300000,
    historySize: 288
  });

  assert.equal(newConfig.intervalMs, 300000);
  assert.equal(newConfig.historySize, 288);

  smartThingsWebhookService.captureMetricsSnapshot('post-update');
  const history = smartThingsWebhookService.getMetricsHistory();
  assert.ok(history.length >= 1);
  assert.equal(history[history.length - 1].reason, 'post-update');

  assert.throws(() => smartThingsWebhookService.updateMetricsConfig({ intervalMs: -1 }), /metrics interval must be a non-negative number/);
  assert.throws(() => smartThingsWebhookService.updateMetricsConfig({ historySize: 0 }), /metrics history size must be a positive number/);
});


const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const jwt = require('jsonwebtoken');
const express = require('express');

const ReviewSandboxState = require('../models/ReviewSandboxState');
const HomeBrainNotification = require('../models/HomeBrainNotification');
const PushSubscription = require('../models/PushSubscription');
const UserSession = require('../models/UserSession');
const UserService = require('../services/userService');
const reviewSandboxService = require('../services/reviewSandboxService');
const { reviewSandboxGate } = require('../routes/reviewSandboxRoutes');
const userRoutes = require('../routes/userRoutes');

function executable(value) {
  return { exec: async () => value };
}

function installInMemorySandboxModel(t) {
  const store = new Map();
  const originals = {
    findOne: ReviewSandboxState.findOne,
    findOneAndUpdate: ReviewSandboxState.findOneAndUpdate,
    create: ReviewSandboxState.create,
    deleteOne: ReviewSandboxState.deleteOne,
  };

  function createDocument(input) {
    const id = String(input.userId);
    return {
      userId: id,
      schemaVersion: input.schemaVersion,
      state: structuredClone(input.state),
      modifiedPaths: [],
      markModified(path) {
        this.modifiedPaths.push(path);
      },
      async save() {
        store.set(id, this);
        return this;
      },
    };
  }

  ReviewSandboxState.findOne = (query) => executable(store.get(String(query.userId)) || null);
  ReviewSandboxState.findOneAndUpdate = (query, update) => executable((() => {
    const id = String(query.userId);
    const existing = store.get(id);
    const document = existing || createDocument({ userId: id, ...update.$set });
    document.schemaVersion = update.$set.schemaVersion;
    document.state = structuredClone(update.$set.state);
    store.set(id, document);
    return document;
  })());
  ReviewSandboxState.create = async (input) => {
    const document = createDocument(input);
    store.set(String(input.userId), document);
    return document;
  };
  ReviewSandboxState.deleteOne = (query) => executable({
    acknowledged: true,
    deletedCount: store.delete(String(query.userId)) ? 1 : 0,
  });

  t.after(() => {
    ReviewSandboxState.findOne = originals.findOne;
    ReviewSandboxState.findOneAndUpdate = originals.findOneAndUpdate;
    ReviewSandboxState.create = originals.create;
    ReviewSandboxState.deleteOne = originals.deleteOne;
  });

  return store;
}

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function makeRequest(user, method, originalUrl, body = {}, query = {}) {
  return {
    user,
    method,
    originalUrl,
    url: originalUrl,
    path: originalUrl.split('?', 1)[0],
    body,
    query,
  };
}

test('review sandbox fixtures and mutations remain isolated per user', async (t) => {
  const store = installInMemorySandboxModel(t);
  const userA = { _id: '507f1f77bcf86cd799439011', isReviewSandbox: true };
  const userB = { _id: '507f1f77bcf86cd799439012', isReviewSandbox: true };

  const summaryA = await reviewSandboxService.provisionForUser(userA, { reset: true });
  const summaryB = await reviewSandboxService.provisionForUser(userB, { reset: true });
  assert.equal(summaryA.counts.devices, 9);
  assert.deepEqual(summaryA.counts, summaryB.counts);
  assert.equal(store.get(String(userA._id)).state.createdFor, String(userA._id));
  assert.equal(store.get(String(userB._id)).state.createdFor, String(userB._id));

  const controlResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(userA, 'POST', '/api/devices/control', {
      deviceId: reviewSandboxService.IDS.devices.patioLights,
      action: 'turn_on',
    }),
    controlResponse
  );
  assert.equal(controlResponse.statusCode, 200);
  assert.equal(controlResponse.body.data.device.status, true);

  const favoriteResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(userA, 'POST', `/api/profiles/${reviewSandboxService.IDS.profile}/favorites/scenes`, {
      sceneId: reviewSandboxService.IDS.scenes.energySaver,
    }),
    favoriteResponse
  );
  assert.equal(favoriteResponse.statusCode, 200);
  assert.equal(
    favoriteResponse.body.profile.favorites.scenes.includes(reviewSandboxService.IDS.scenes.energySaver),
    true
  );

  const watchDashboardResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(userA, 'GET', '/api/watch/dashboard'),
    watchDashboardResponse
  );
  assert.equal(watchDashboardResponse.statusCode, 200);
  assert.equal(watchDashboardResponse.body.dashboard.user.id, String(userA._id));
  assert.ok(Array.isArray(watchDashboardResponse.body.dashboard.availableRooms));
  assert.equal(watchDashboardResponse.body.dashboard.sections.security.available, true);
  assert.equal(watchDashboardResponse.body.dashboard.sections.lights.available, true);

  const watchLightsResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(userA, 'POST', '/api/watch/lights', { action: 'turn_on' }),
    watchLightsResponse
  );
  assert.equal(watchLightsResponse.statusCode, 200);
  assert.equal(watchLightsResponse.body.partialFailure, false);
  assert.equal(watchLightsResponse.body.lights.available, true);
  assert.ok(Array.isArray(watchLightsResponse.body.lights.devices));

  const responseA = makeResponse();
  const responseB = makeResponse();
  await reviewSandboxService.handleRequest(makeRequest(userA, 'GET', '/api/devices'), responseA);
  await reviewSandboxService.handleRequest(makeRequest(userB, 'GET', '/api/devices'), responseB);
  const patioA = responseA.body.data.devices.find((device) => device._id === reviewSandboxService.IDS.devices.patioLights);
  const patioB = responseB.body.data.devices.find((device) => device._id === reviewSandboxService.IDS.devices.patioLights);
  assert.equal(patioA.status, true);
  assert.equal(patioB.status, false);
  assert.equal(
    store.get(String(userB._id)).state.profile.favorites.scenes.includes(reviewSandboxService.IDS.scenes.energySaver),
    false
  );
  assert.ok(store.get(String(userA._id)).modifiedPaths.includes('state'));
  assert.equal(store.get(String(userB._id)).modifiedPaths.length, 0);
});

test('review sandbox response contracts match the iOS dashboard, notifications, workflows, and Watch clients', async (t) => {
  const store = installInMemorySandboxModel(t);
  const user = {
    _id: '507f1f77bcf86cd799439013',
    name: 'Apple App Review',
    email: 'reviewer@example.test',
    isReviewSandbox: true,
  };
  await reviewSandboxService.provisionForUser(user, { reset: true });

  const energyResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(
      user,
      'GET',
      `/api/devices/${reviewSandboxService.IDS.devices.energy}/energy-history`,
      {},
      { hours: '6', limit: '3' }
    ),
    energyResponse
  );
  assert.equal(energyResponse.statusCode, 200);
  assert.deepEqual(Object.keys(energyResponse.body).sort(), ['data', 'success']);
  assert.equal(energyResponse.body.data.deviceId, reviewSandboxService.IDS.devices.energy);
  assert.equal(energyResponse.body.data.hours, 6);
  assert.equal(energyResponse.body.data.count, 3);
  assert.equal(energyResponse.body.data.samples.length, 3);
  assert.ok(
    Date.parse(energyResponse.body.data.samples[0].recordedAt)
      < Date.parse(energyResponse.body.data.samples[2].recordedAt)
  );
  energyResponse.body.data.samples.forEach((sample) => {
    assert.deepEqual(Object.keys(sample).sort(), ['energy', 'power', 'recordedAt', 'source']);
    assert.equal(sample.source, 'review-sandbox');
    assert.ok(Number.isFinite(Date.parse(sample.recordedAt)));
    assert.deepEqual(Object.keys(sample.power).sort(), ['timestamp', 'unit', 'value']);
    assert.deepEqual(Object.keys(sample.energy).sort(), ['timestamp', 'unit', 'value']);
    assert.equal(sample.power.unit, 'W');
    assert.equal(sample.energy.unit, 'kWh');
    assert.equal(typeof sample.power.value, 'number');
    assert.equal(typeof sample.energy.value, 'number');
  });

  const normalNotificationsResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(user, 'GET', '/api/notifications', {}, { channel: 'normal', limit: '100' }),
    normalNotificationsResponse
  );
  assert.equal(normalNotificationsResponse.statusCode, 200);
  assert.equal(normalNotificationsResponse.body.notifications.length, 2);
  assert.equal(
    normalNotificationsResponse.body.notifications.every((notification) => notification.channel === 'normal'),
    true
  );
  assert.deepEqual(normalNotificationsResponse.body.counts, { normal: 2, securityCritical: 0 });

  const criticalNotificationsResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(user, 'GET', '/api/notifications', {}, { channel: 'securityCritical' }),
    criticalNotificationsResponse
  );
  assert.deepEqual(criticalNotificationsResponse.body.notifications, []);

  store.get(String(user._id)).state.notifications[0].resolvedAt = new Date().toISOString();
  const activeNotificationsResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(user, 'GET', '/api/notifications', {}, { includeCleared: 'false', includeResolved: 'false' }),
    activeNotificationsResponse
  );
  assert.equal(activeNotificationsResponse.body.notifications.length, 1);

  const notificationHistoryResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(user, 'GET', '/api/notifications', {}, { includeCleared: 'true', includeResolved: 'true' }),
    notificationHistoryResponse
  );
  assert.equal(notificationHistoryResponse.body.notifications.length, 2);

  const clearActiveResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(user, 'POST', '/api/notifications/clear', { channel: 'normal' }),
    clearActiveResponse
  );
  assert.equal(clearActiveResponse.body.clearedCount, 1);
  assert.equal(clearActiveResponse.body.channel, 'normal');
  assert.equal(clearActiveResponse.body.includeResolved, false);
  assert.ok(Number.isFinite(Date.parse(clearActiveResponse.body.clearedAt)));
  assert.deepEqual(clearActiveResponse.body.counts, { normal: 0, securityCritical: 0 });

  const clearHistoryResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(user, 'POST', '/api/notifications/clear', { channel: 'normal', includeHistory: true }),
    clearHistoryResponse
  );
  assert.equal(clearHistoryResponse.body.clearedCount, 1);
  assert.equal(clearHistoryResponse.body.includeResolved, true);

  const workflowResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(user, 'POST', `/api/workflows/${reviewSandboxService.IDS.workflows.sunset}/execute`, { context: {} }),
    workflowResponse
  );
  assert.equal(workflowResponse.statusCode, 200);
  assert.equal(workflowResponse.body.status, 'success');
  assert.equal(workflowResponse.body.executionId, workflowResponse.body.history.id);
  assert.equal(workflowResponse.body.history.automationId, reviewSandboxService.IDS.workflows.sunset);
  assert.equal(workflowResponse.body.history.automationName, workflowResponse.body.history.workflowName);
  assert.equal(workflowResponse.body.history.workflowId, reviewSandboxService.IDS.workflows.sunset);
  assert.equal(workflowResponse.body.history.correlationId, workflowResponse.body.executionId);
  assert.equal(workflowResponse.body.history.totalActions, workflowResponse.body.history.actionResults.length);
  assert.equal(workflowResponse.body.history.successfulActions, workflowResponse.body.history.totalActions);
  assert.equal(workflowResponse.body.history.failedActions, 0);
  assert.equal(workflowResponse.body.history.runtimeEvents.length, 1);
  assert.equal(workflowResponse.body.history.lastEvent.type, 'automation.completed');
  assert.deepEqual(workflowResponse.body.history.error, {});

  const runtimeHistoryResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(user, 'GET', '/api/workflows/runtime-history', {}, { limit: '1', page: '1', hours: '6' }),
    runtimeHistoryResponse
  );
  assert.equal(runtimeHistoryResponse.body.count, 1);
  assert.deepEqual(runtimeHistoryResponse.body.pagination, {
    page: 1,
    limit: 1,
    total: 1,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  });
  assert.deepEqual(runtimeHistoryResponse.body.timeRange, { hours: 6 });
  assert.equal(runtimeHistoryResponse.body.history[0].correlationId, workflowResponse.body.executionId);

  const telemetryResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(user, 'GET', '/api/workflows/runtime-telemetry', {}, { hours: '6' }),
    telemetryResponse
  );
  assert.equal(telemetryResponse.body.telemetry.executionCount, 1);
  assert.equal(telemetryResponse.body.telemetry.successCount, 1);
  assert.equal(telemetryResponse.body.telemetry.totalActions, workflowResponse.body.history.totalActions);
  assert.equal(telemetryResponse.body.telemetry.successfulActions, workflowResponse.body.history.totalActions);
  assert.equal(telemetryResponse.body.telemetry.failedActions, 0);
  assert.deepEqual(telemetryResponse.body.telemetry.timeRange, { hours: 6 });

  const correlatedEventsResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(user, 'GET', '/api/events/latest', {}, {
      category: 'automation',
      correlationId: workflowResponse.body.executionId,
      limit: '200',
    }),
    correlatedEventsResponse
  );
  assert.equal(correlatedEventsResponse.body.count, 1);
  assert.equal(correlatedEventsResponse.body.events[0].correlationId, workflowResponse.body.executionId);
  assert.equal(correlatedEventsResponse.body.events[0].payload.workflowId, reviewSandboxService.IDS.workflows.sunset);

  const unrelatedEventsResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(user, 'GET', '/api/events/latest', {}, { category: 'automation', correlationId: 'not-this-run' }),
    unrelatedEventsResponse
  );
  assert.deepEqual(unrelatedEventsResponse.body.events, []);

  const dashboardResponse = makeResponse();
  await reviewSandboxService.handleRequest(makeRequest(user, 'GET', '/api/watch/dashboard'), dashboardResponse);
  const dashboard = dashboardResponse.body.dashboard;
  assert.deepEqual(Object.keys(dashboard).sort(), ['availableRooms', 'config', 'generatedAt', 'sections', 'user']);
  assert.ok(Number.isFinite(Date.parse(dashboard.generatedAt)));
  assert.deepEqual(dashboard.user, {
    id: String(user._id),
    name: user.name,
    email: user.email,
  });
  assert.deepEqual(Object.keys(dashboard.sections).sort(), ['lights', 'power', 'security', 'weather']);
  assert.deepEqual(Object.keys(dashboard.config).sort(), [
    'defaultLightBrightness',
    'lightDeviceIds',
    'primaryRoom',
    'sections',
  ]);
  assert.ok(dashboard.availableRooms.length > 0);
  dashboard.availableRooms.forEach((room) => {
    assert.deepEqual(Object.keys(room).sort(), ['dimmableCount', 'lightCount', 'name', 'onCount', 'onlineCount']);
  });
  assert.equal(typeof dashboard.sections.security.available, 'boolean');
  assert.equal(typeof dashboard.sections.lights.available, 'boolean');
  assert.ok(Array.isArray(dashboard.sections.lights.devices));
  assert.ok(Array.isArray(dashboard.sections.lights.rooms));
  dashboard.sections.lights.devices.forEach((device) => {
    assert.deepEqual(Object.keys(device).sort(), [
      'brightness',
      'dimmable',
      'id',
      'isOn',
      'isOnline',
      'name',
      'room',
      'type',
    ]);
  });

  const watchLightsResponse = makeResponse();
  await reviewSandboxService.handleRequest(
    makeRequest(user, 'POST', '/api/watch/lights', { room: 'Back Patio', action: 'turn_on', brightness: 55 }),
    watchLightsResponse
  );
  assert.equal(watchLightsResponse.body.success, true);
  assert.equal(watchLightsResponse.body.partialFailure, false);
  assert.ok(Array.isArray(watchLightsResponse.body.results));
  assert.equal(watchLightsResponse.body.results.length, 1);
  assert.equal(watchLightsResponse.body.results[0].device.room, 'Back Patio');
  assert.equal(watchLightsResponse.body.results[0].device.isOn, true);
  assert.equal(typeof watchLightsResponse.body.lights.available, 'boolean');
  assert.ok(Array.isArray(watchLightsResponse.body.lights.devices));
  assert.ok(Array.isArray(watchLightsResponse.body.lights.rooms));
});

test('review sandbox gate handles known paths, denies unknown GETs, and passes normal users through', async (t) => {
  installInMemorySandboxModel(t);
  const originalGet = UserService.get;
  const originalJwtSecret = process.env.JWT_SECRET;
  const sandboxUser = {
    _id: '507f1f77bcf86cd799439021',
    role: 'user',
    isActive: true,
    isReadOnly: true,
    isReviewSandbox: true,
    platforms: { homebrain: true, axiom: false },
  };
  const normalUser = {
    _id: '507f1f77bcf86cd799439022',
    role: 'user',
    isActive: true,
    isReadOnly: false,
    isReviewSandbox: false,
    platforms: { homebrain: true, axiom: false },
  };
  process.env.JWT_SECRET = 'review-sandbox-gate-test-secret';
  UserService.get = async (id) => String(id) === String(sandboxUser._id) ? sandboxUser : normalUser;
  t.after(() => {
    UserService.get = originalGet;
    process.env.JWT_SECRET = originalJwtSecret;
  });

  function authenticatedRequest(user, path) {
    const token = jwt.sign({ sub: String(user._id) }, process.env.JWT_SECRET, { expiresIn: '1h' });
    return {
      method: 'GET',
      originalUrl: path,
      url: path.replace(/^\/api/, '') || '/',
      path: path.replace(/^\/api/, '') || '/',
      headers: { authorization: `Bearer ${token}` },
      get() { return undefined; },
      protocol: 'https',
      secure: true,
      query: {},
    };
  }

  const knownResponse = makeResponse();
  let knownNext = false;
  await reviewSandboxGate(authenticatedRequest(sandboxUser, '/api/devices'), knownResponse, () => { knownNext = true; });
  assert.equal(knownNext, false);
  assert.equal(knownResponse.statusCode, 200);
  assert.equal(knownResponse.body.data.devices.every((device) => device.properties.source === 'review-sandbox'), true);

  const unknownResponse = makeResponse();
  let productionHandlerHits = 0;
  await reviewSandboxGate(authenticatedRequest(sandboxUser, '/api/settings'), unknownResponse, () => { productionHandlerHits += 1; });
  assert.equal(unknownResponse.statusCode, 403);
  assert.match(unknownResponse.body.error, /isolated App Review sandbox/);
  assert.equal(productionHandlerHits, 0);

  const normalResponse = makeResponse();
  await reviewSandboxGate(authenticatedRequest(normalUser, '/api/settings'), normalResponse, () => { productionHandlerHits += 1; });
  assert.equal(productionHandlerHits, 1);
});

test('review sandbox SSE sends only the matching user virtual-device updates', async (t) => {
  installInMemorySandboxModel(t);
  const userA = { _id: '507f1f77bcf86cd799439031', isReviewSandbox: true };
  const userB = { _id: '507f1f77bcf86cd799439032', isReviewSandbox: true };
  await reviewSandboxService.provisionForUser(userA, { reset: true });
  await reviewSandboxService.provisionForUser(userB, { reset: true });

  class StreamResponse extends EventEmitter {
    constructor() {
      super();
      this.headers = {};
      this.output = '';
      this.statusCode = 200;
    }
    setHeader(name, value) { this.headers[name] = value; }
    flushHeaders() {}
    write(value) { this.output += value; }
    end() { this.ended = true; }
    status(code) { this.statusCode = code; return this; }
    json(payload) { this.body = payload; return this; }
  }

  const reqA = new EventEmitter();
  const reqB = new EventEmitter();
  const resA = new StreamResponse();
  const resB = new StreamResponse();
  t.after(() => {
    reqA.emit('close');
    reqB.emit('close');
  });

  await reviewSandboxService.handleDeviceStream(userA, reqA, resA);
  await reviewSandboxService.handleDeviceStream(userB, reqB, resB);
  const beforeA = resA.output.length;
  const beforeB = resB.output.length;

  await reviewSandboxService.handleRequest(
    makeRequest(userA, 'POST', '/api/devices/control', {
      deviceId: reviewSandboxService.IDS.devices.patioLights,
      action: 'turn_on',
    }),
    makeResponse()
  );

  assert.ok(resA.output.length > beforeA);
  assert.equal(resB.output.length, beforeB);
  assert.match(resA.output.slice(beforeA), /review-device-patio-lights/);
  assert.doesNotMatch(resA.output, /production-device/);
});

test('admin reset route hardens the target account and purges production notification records', async (t) => {
  const originalGet = UserService.get;
  const originalNotificationDeleteMany = HomeBrainNotification.deleteMany;
  const originalPushDeleteMany = PushSubscription.deleteMany;
  const originalSessionDeleteMany = UserSession.deleteMany;
  const originalProvision = reviewSandboxService.provisionForUser;
  const originalDeleteForUser = reviewSandboxService.deleteForUser;
  const originalJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'review-sandbox-admin-route-test-secret';

  const admin = {
    _id: '507f1f77bcf86cd799439041',
    email: 'admin@example.test',
    role: 'admin',
    isActive: true,
    isReadOnly: false,
    isReviewSandbox: false,
    platforms: { homebrain: true, axiom: false },
  };
  const target = {
    _id: '507f1f77bcf86cd799439042',
    email: 'review@example.test',
    role: 'user',
    isActive: false,
    isReadOnly: false,
    isReviewSandbox: false,
    platforms: { homebrain: false, axiom: true },
    saveCount: 0,
    async save() {
      this.saveCount += 1;
      return this;
    },
  };
  const deleted = [];
  let provisionOptions = null;

  UserService.get = async (id) => String(id) === String(admin._id) ? admin : target;
  HomeBrainNotification.deleteMany = (query) => {
    deleted.push(['notifications', String(query.userId)]);
    return executable({ deletedCount: 2 });
  };
  PushSubscription.deleteMany = (query) => {
    deleted.push(['push', String(query.userId)]);
    return executable({ deletedCount: 1 });
  };
  UserSession.deleteMany = (query) => {
    deleted.push(['sessions', String(query.userId)]);
    return executable({ deletedCount: 1 });
  };
  reviewSandboxService.provisionForUser = async (_user, options) => {
    provisionOptions = options;
    return { counts: { devices: 9 } };
  };
  reviewSandboxService.deleteForUser = async (id) => {
    deleted.push(['sandbox', String(id)]);
    return { deletedCount: 1 };
  };

  const app = express();
  app.use(express.json());
  app.use('/api/users', userRoutes);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    UserService.get = originalGet;
    HomeBrainNotification.deleteMany = originalNotificationDeleteMany;
    PushSubscription.deleteMany = originalPushDeleteMany;
    UserSession.deleteMany = originalSessionDeleteMany;
    reviewSandboxService.provisionForUser = originalProvision;
    reviewSandboxService.deleteForUser = originalDeleteForUser;
    process.env.JWT_SECRET = originalJwtSecret;
    await new Promise((resolve) => server.close(resolve));
  });

  const token = jwt.sign({ sub: String(admin._id) }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/users/${target._id}/review-sandbox/reset`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(target.role, 'user');
  assert.equal(target.isActive, true);
  assert.equal(target.isReadOnly, true);
  assert.equal(target.isReviewSandbox, true);
  assert.deepEqual(target.platforms.toObject ? target.platforms.toObject() : target.platforms, { homebrain: true, axiom: false });
  assert.equal(target.saveCount, 2);
  assert.deepEqual(deleted.sort(), [
    ['notifications', String(target._id)],
    ['push', String(target._id)],
    ['sessions', String(target._id)],
  ]);
  assert.deepEqual(provisionOptions, { reset: true });

  deleted.length = 0;
  const disableResponse = await fetch(`http://127.0.0.1:${address.port}/api/users/${target._id}/review-sandbox`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  const disablePayload = await disableResponse.json();
  assert.equal(disableResponse.status, 200);
  assert.equal(disablePayload.success, true);
  assert.equal(target.isReviewSandbox, false);
  assert.equal(target.isActive, false);
  assert.equal(target.isReadOnly, true);
  assert.deepEqual(target.platforms.toObject ? target.platforms.toObject() : target.platforms, { homebrain: false, axiom: false });
  assert.deepEqual(deleted.sort(), [
    ['notifications', String(target._id)],
    ['push', String(target._id)],
    ['sandbox', String(target._id)],
    ['sessions', String(target._id)],
  ]);
});

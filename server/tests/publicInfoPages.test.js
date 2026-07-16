const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const PublicSupportRequest = require('../models/PublicSupportRequest');
const UserService = require('../services/userService');
const notificationService = require('../services/notificationService');
const publicInfoRoutes = require('../routes/publicInfoRoutes');

async function withServer(run) {
  const app = express();
  app.enable('strict routing');
  app.use(publicInfoRoutes);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('public privacy and support pages are available without authentication', async () => {
  await withServer(async (origin) => {
    for (const [pathname, requiredText] of [
      ['/privacy', 'HomeBrain Privacy Policy'],
      ['/support', 'HomeBrain Support']
    ]) {
      const response = await fetch(`${origin}${pathname}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /^text\/html/);
      const body = await response.text();
      assert.match(body, new RegExp(requiredText));
      assert.doesNotMatch(body, /\{\{|TODO|REPLACE_ME|example\.com/i);

      const headResponse = await fetch(`${origin}${pathname}`, { method: 'HEAD' });
      assert.equal(headResponse.status, 200);
      assert.match(headResponse.headers.get('content-type') || '', /^text\/html/);
    }
  });
});

test('public pages disclose support, privacy choices, and account deletion', async () => {
  await withServer(async (origin) => {
    const privacy = await (await fetch(`${origin}/privacy`)).text();
    assert.match(privacy, /does not sell personal information/i);
    assert.match(privacy, /Settings → Account → Delete Account/);
    assert.match(privacy, /Apple Push Notification service/);
    assert.match(privacy, /Speech Recognition/);
    assert.match(privacy, /Open-Meteo/);
    assert.match(privacy, /older operational logs that cannot be attributed/i);
    assert.match(privacy, /support form is available without signing in/i);
    assert.match(privacy, /stored in a private support record/i);
    assert.match(privacy, /automatically expire 90 days after submission/i);

    const support = await (await fetch(`${origin}/support`)).text();
    assert.match(support, /does not offer public or in-app account registration/i);
    assert.match(support, /do not need a HomeBrain or third-party account/i);
    assert.match(support, /Settings → Account → Delete Account/);
    assert.match(support, /older operational logs that cannot be attributed/i);
    assert.match(support, /id="support-request-form"/);
    assert.match(support, /maxlength="1400"/);
    assert.doesNotMatch(support, /github\.com|mailto:/i);
  });
});

test('public support requests validate input and notify only eligible admins', async (t) => {
  const originalFind = User.find;
  const originalCreate = PublicSupportRequest.create;
  const originalDeleteOne = PublicSupportRequest.deleteOne;
  const originalCreateSystemNotification = notificationService.createSystemNotification;
  t.after(() => {
    User.find = originalFind;
    PublicSupportRequest.create = originalCreate;
    PublicSupportRequest.deleteOne = originalDeleteOne;
    notificationService.createSystemNotification = originalCreateSystemNotification;
  });

  let adminQuery;
  let notificationInput;
  let findCalls = 0;
  let createCalls = 0;
  let createdSupportRequest;
  let notificationCalls = 0;
  let admins = [{ _id: 'admin-1' }, { _id: 'admin-2' }];

  User.find = (query) => {
    findCalls += 1;
    adminQuery = query;
    return {
      select(selection) {
        assert.equal(selection, '_id');
        return this;
      },
      async lean() {
        return admins;
      }
    };
  };
  PublicSupportRequest.create = async (input) => {
    createCalls += 1;
    createdSupportRequest = input;
    return input;
  };
  PublicSupportRequest.deleteOne = async () => ({ deletedCount: 1 });
  notificationService.createSystemNotification = async (input) => {
    notificationCalls += 1;
    notificationInput = input;
    return input.userIds.map((userId) => ({ userId }));
  };

  await withServer(async (origin) => {
    const validPayload = {
      name: 'Apple Reviewer',
      email: 'REVIEWER@example.com',
      subject: 'Watch controls do not refresh',
      message: 'The Watch dashboard does not refresh after I run a scene.',
      appVersion: '1.0 (42)',
      device: 'Apple Watch Series 11, watchOS 26.0',
      website: ''
    };
    const successResponse = await fetch(`${origin}/api/public/support-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload)
    });
    assert.equal(successResponse.status, 201);
    assert.deepEqual(await successResponse.json(), {
      success: true,
      message: 'Your support request was sent.'
    });
    assert.deepEqual(adminQuery, {
      role: 'admin',
      isActive: true,
      isReviewSandbox: { $ne: true }
    });
    assert.deepEqual(notificationInput.userIds, ['admin-1', 'admin-2']);
    assert.equal(notificationInput.channel, 'normal');
    assert.equal(notificationInput.severity, 'info');
    assert.equal(notificationInput.category, 'system');
    assert.equal(notificationInput.eventType, 'support.request.created');
    assert.equal(notificationInput.source, 'public-support');
    assert.match(notificationInput.eventKey, /^support-request:[0-9a-f-]{36}$/);
    assert.equal(notificationInput.title, 'New private support request');
    assert.match(notificationInput.message, /authenticated administrator can retrieve it/i);
    assert.match(notificationInput.metadata.supportRequestPath, /^\/api\/public\/support-requests\/[0-9a-f-]{36}$/);
    assert.equal(notificationInput.metadata.requestId, createdSupportRequest.requestId);
    const serializedNotification = JSON.stringify(notificationInput);
    assert.doesNotMatch(serializedNotification, /reviewer@example\.com/i);
    assert.doesNotMatch(serializedNotification, /Watch controls do not refresh/i);
    assert.doesNotMatch(serializedNotification, /Watch dashboard does not refresh/i);
    assert.equal(createCalls, 1);
    assert.equal(createdSupportRequest.email, 'reviewer@example.com');
    assert.equal(createdSupportRequest.subject, validPayload.subject);
    assert.equal(createdSupportRequest.message, validPayload.message);

    const invalidResponse = await fetch(`${origin}/api/public/support-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'not-an-email',
        subject: 'Help',
        message: 'This message has enough characters.',
        website: ''
      })
    });
    assert.equal(invalidResponse.status, 400);
    assert.match((await invalidResponse.json()).message, /valid email address/i);
    assert.equal(findCalls, 1);
    assert.equal(createCalls, 1);
    assert.equal(notificationCalls, 1);

    const honeypotResponse = await fetch(`${origin}/api/public/support-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ website: 'https://spam.invalid' })
    });
    assert.equal(honeypotResponse.status, 202);
    assert.equal((await honeypotResponse.json()).success, true);
    assert.equal(findCalls, 1);
    assert.equal(createCalls, 1);
    assert.equal(notificationCalls, 1);

    admins = [];
    const unavailableResponse = await fetch(`${origin}/api/public/support-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload)
    });
    assert.equal(unavailableResponse.status, 503);
    assert.match((await unavailableResponse.json()).message, /temporarily unavailable/i);
    assert.equal(findCalls, 2);
    assert.equal(createCalls, 1);
    assert.equal(notificationCalls, 1);

    const mediaTypeResponse = await fetch(`${origin}/api/public/support-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not json'
    });
    assert.equal(mediaTypeResponse.status, 415);
    assert.match((await mediaTypeResponse.json()).message, /must be sent as JSON/i);
  });
});

test('support request records require a real admin and support list, detail, and update flows', async (t) => {
  const originalGet = UserService.get;
  const originalFind = PublicSupportRequest.find;
  const originalFindOne = PublicSupportRequest.findOne;
  const originalFindOneAndUpdate = PublicSupportRequest.findOneAndUpdate;
  const originalJwtSecret = process.env.JWT_SECRET;
  t.after(() => {
    UserService.get = originalGet;
    PublicSupportRequest.find = originalFind;
    PublicSupportRequest.findOne = originalFindOne;
    PublicSupportRequest.findOneAndUpdate = originalFindOneAndUpdate;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  process.env.JWT_SECRET = 'public-info-test-secret-with-enough-entropy';
  const requestId = 'd3195997-9374-4a0d-aa10-67be3fbfb3cd';
  const submittedAt = '2026-07-15T14:00:00.000Z';
  const expiresAt = '2026-10-13T14:00:00.000Z';
  let authenticatedUser = {
    _id: 'admin-1',
    id: 'admin-1',
    role: 'admin',
    isActive: true,
    isReviewSandbox: false,
    platforms: { homebrain: true }
  };
  UserService.get = async () => authenticatedUser;
  const token = jwt.sign({ sub: 'admin-1' }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '5m'
  });
  const authHeaders = { Authorization: `Bearer ${token}` };

  const supportRequest = {
    requestId,
    name: 'Customer',
    email: 'customer@example.com',
    subject: 'Scene did not run',
    message: 'The evening scene did not run from my Watch.',
    appVersion: '1.0 (42)',
    device: 'Apple Watch Series 11, watchOS 26.0',
    status: 'open',
    internalNote: '',
    submittedAt,
    expiresAt,
    handledAt: null,
    resolvedAt: null
  };
  let listQuery;
  let listLimit;
  PublicSupportRequest.find = (query) => {
    listQuery = query;
    return {
      select(selection) {
        assert.equal(selection, 'requestId subject status submittedAt expiresAt handledAt');
        return this;
      },
      sort(sort) {
        assert.deepEqual(sort, { submittedAt: -1 });
        return this;
      },
      limit(limit) {
        listLimit = limit;
        return this;
      },
      async lean() {
        return [supportRequest];
      }
    };
  };
  PublicSupportRequest.findOne = (query) => ({
    async lean() {
      assert.deepEqual(query, { requestId });
      return supportRequest;
    }
  });
  let updateCall;
  PublicSupportRequest.findOneAndUpdate = (query, update, options) => {
    updateCall = { query, update, options };
    return {
      async lean() {
        return {
          ...supportRequest,
          ...update.$set,
          status: 'resolved',
          internalNote: 'Reproduced and sent to engineering.'
        };
      }
    };
  };

  await withServer(async (origin) => {
    const unauthenticated = await fetch(`${origin}/api/public/support-requests`);
    assert.equal(unauthenticated.status, 401);

    authenticatedUser = { ...authenticatedUser, isReviewSandbox: true };
    const sandboxResponse = await fetch(`${origin}/api/public/support-requests`, { headers: authHeaders });
    assert.equal(sandboxResponse.status, 403);
    assert.match((await sandboxResponse.json()).message, /sandbox accounts cannot access/i);

    authenticatedUser = { ...authenticatedUser, isReviewSandbox: false };
    const listResponse = await fetch(`${origin}/api/public/support-requests?status=open&limit=25`, {
      headers: authHeaders
    });
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.count, 1);
    assert.equal(listBody.supportRequests[0].requestId, requestId);
    assert.equal(listBody.supportRequests[0].subject, supportRequest.subject);
    assert.equal(Object.hasOwn(listBody.supportRequests[0], 'email'), false);
    assert.deepEqual(listQuery, { status: 'open' });
    assert.equal(listLimit, 25);

    const detailResponse = await fetch(`${origin}/api/public/support-requests/${requestId}`, {
      headers: authHeaders
    });
    assert.equal(detailResponse.status, 200);
    const detailBody = await detailResponse.json();
    assert.equal(detailBody.supportRequest.email, supportRequest.email);
    assert.equal(detailBody.supportRequest.message, supportRequest.message);

    const updateResponse = await fetch(`${origin}/api/public/support-requests/${requestId}`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'resolved',
        internalNote: 'Reproduced and sent to engineering.'
      })
    });
    assert.equal(updateResponse.status, 200);
    const updateBody = await updateResponse.json();
    assert.equal(updateBody.supportRequest.status, 'resolved');
    assert.equal(updateBody.supportRequest.internalNote, 'Reproduced and sent to engineering.');
    assert.deepEqual(updateCall.query, { requestId });
    assert.equal(updateCall.options.new, true);
    assert.equal(updateCall.options.runValidators, true);
    assert.equal(updateCall.update.$set.status, 'resolved');
    assert.equal(updateCall.update.$set.lastHandledBy, 'admin-1');
    assert.ok(updateCall.update.$set.handledAt instanceof Date);
    assert.ok(updateCall.update.$set.resolvedAt instanceof Date);

    const invalidUpdate = await fetch(`${origin}/api/public/support-requests/${requestId}`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'deleted' })
    });
    assert.equal(invalidUpdate.status, 400);
    assert.match((await invalidUpdate.json()).message, /open, in_progress, or resolved/i);
  });
});

test('private support requests have bounded fields and automatic TTL retention', () => {
  assert.equal(PublicSupportRequest.schema.path('email').options.maxlength, 254);
  assert.equal(PublicSupportRequest.schema.path('message').options.maxlength, 1400);
  assert.equal(PublicSupportRequest.schema.path('internalNote').options.maxlength, 1000);
  const ttlIndex = PublicSupportRequest.schema.indexes().find(([fields, options]) => (
    fields.expiresAt === 1 && options.expireAfterSeconds === 0
  ));
  assert.ok(ttlIndex, 'expected an expiresAt TTL index');
});

test('public page canonical URLs and stylesheet are served directly', async () => {
  await withServer(async (origin) => {
    for (const pathname of ['/privacy/', '/support/']) {
      const response = await fetch(`${origin}${pathname}`, { redirect: 'manual' });
      assert.equal(response.status, 308);
      assert.equal(response.headers.get('location'), pathname.slice(0, -1));
    }

    const stylesheet = await fetch(`${origin}/app-info/public-info.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type') || '', /^text\/css/);
    assert.match(await stylesheet.text(), /color-scheme/);

    const supportScript = await fetch(`${origin}/app-info/support.js`);
    assert.equal(supportScript.status, 200);
    assert.match(supportScript.headers.get('content-type') || '', /javascript/);
    assert.match(await supportScript.text(), /api\/public\/support-requests/);
  });
});

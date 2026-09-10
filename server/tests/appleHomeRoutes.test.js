'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const users = require('../services/userService');
const oidc = require('../services/oidcService');
const { createAppleHomeRouter } = require('../routes/appleHomeRoutes');

test('Apple Home HTTP access uses existing account, platform, sandbox, and administration boundaries', async (t) => {
  const oldGet = users.get, oldOidc = oidc.verifyIssuedAccessToken, oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  const user = { _id: '507f1f77bcf86cd799439011', role: 'admin', isActive: true, isReadOnly: false, isReviewSandbox: false, platforms: { homebrain: true } };
  users.get = async () => user;
  oidc.verifyIssuedAccessToken = async () => { throw Object.assign(new Error('Invalid token'), { status: 401 }); };
  let calls = [], failure;
  const invoke = (name, actor, body) => {
    calls.push({ name, actor, body });
    if (failure) throw failure;
    return { success: true, running: true, targets: [] };
  };
  const service = { initialize: async () => {}, status: (actor) => invoke('status', actor),
    configure: (actor, body) => invoke('configure', actor, body), pairing: (actor) => invoke('pair', actor), refresh: async () => {} };
  const app = express(); app.use(express.json({ limit: '16kb' })); app.use('/api/apple-home', createAppleHomeRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    users.get = oldGet; oidc.verifyIssuedAccessToken = oldOidc;
    if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
  });
  const base = `http://127.0.0.1:${server.address().port}/api/apple-home`;
  const token = jwt.sign({ sub: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const send = (route, method = 'GET', body) => fetch(base + route, { method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await t.test('anonymous and URL token credentials are denied', async () => {
    for (const route of ['/status', `/status?token=${token}`, '/pairing']) {
      const response = await fetch(base + route); assert.equal(response.status, 401);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
    assert.equal(calls.length, 0);
  });
  await t.test('status is private and does not expose pairing material', async () => {
    const response = await send('/status'); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.json()).pin, undefined);
  });
  await t.test('non-admin cannot pair, configure or request privileged refresh', async () => {
    user.role = 'user'; const before = calls.length;
    for (const [route, method] of [['/pairing', 'POST'], ['/configuration', 'PUT'], ['/sync', 'POST']]) {
      assert.equal((await send(route, method, {})).status, 403);
    }
    assert.equal(calls.length, before); user.role = 'admin';
  });
  await t.test('read-only admin cannot configure or get a pairing code', async () => {
    user.isReadOnly = true; const before = calls.length;
    assert.equal((await send('/configuration', 'PUT', { enabled: true })).status, 403);
    assert.equal((await send('/pairing', 'POST', {})).status, 403);
    assert.equal(calls.length, before); user.isReadOnly = false;
  });
  await t.test('inactive, wrong-platform and review-sandbox users cannot read home catalog', async () => {
    user.isActive = false; assert.equal((await send('/status')).status, 403); user.isActive = true;
    user.platforms.homebrain = false; assert.equal((await send('/status')).status, 403); user.platforms.homebrain = true;
    user.isReviewSandbox = true; assert.equal((await send('/status')).status, 403); user.isReviewSandbox = false;
  });
  await t.test('configuration and pairing preserve resolved identity, not posted actor', async () => {
    const response = await send('/configuration', 'PUT', { enabled: true, ownerId: 'attacker' });
    assert.equal(response.status, 200); assert.equal(calls.at(-1).actor, user);
    assert.equal((await send('/pairing', 'POST', {})).status, 200);
    assert.equal(calls.at(-1).actor, user);
  });
  await t.test('errors from private storage cannot escape HTTP response', async () => {
    failure = new Error('private PIN and secret path'); const response = await send('/status');
    assert.equal(response.status, 500); assert.equal((await response.text()).includes('private PIN'), false);
    failure = undefined;
  });
  await t.test('there is no unauthenticated HTTP mutation proxy', async () => {
    assert.equal((await send('/commands', 'POST', { action: 'turn_on' })).status, 404);
    assert.equal((await send('/pairing')).status, 404);
  });
});

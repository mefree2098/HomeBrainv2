const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const UserService = require('../services/userService');
const oidcService = require('../services/oidcService');
const { createSiriRouter } = require('../routes/siriRoutes');

// Exercise the real HTTP router and JWT/permission middleware without live home devices.
test('Siri HTTP boundary authenticates and preserves command/result semantics', async (t) => {
  const originalGet = UserService.get;
  const originalOidc = oidcService.verifyIssuedAccessToken;
  const originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  const user = { _id: '507f1f77bcf86cd799439011', role: 'user', isActive: true,
    isReadOnly: false, platforms: { homebrain: true, axiom: false } };
  let calls = [];
  let failure = null;
  UserService.get = async () => user;
  oidcService.verifyIssuedAccessToken = async () => { const error = new Error('Invalid token'); error.status = 401; throw error; };
  const service = {
    catalog: async (actor) => { calls.push(['catalog', actor]); if (failure) throw failure; return { success: true, accountId: String(actor._id), targets: [] }; },
    start: async (actor, command) => { calls.push(['start', actor, command]); return { success: true, state: 'running', requestId: command.requestId, message: 'Started Night TV.' }; },
    get: async (actor, requestId) => { calls.push(['get', actor, requestId]); if (failure) throw failure; return { success: false, state: 'failed', requestId, message: 'The workflow failed.' }; }
  };
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use('/api/siri', createSiriRouter(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    UserService.get = originalGet;
    oidcService.verifyIssuedAccessToken = originalOidc;
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
  });
  const base = `http://127.0.0.1:${server.address().port}/api/siri`;
  const token = jwt.sign({ sub: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const send = (path, options = {}) => fetch(base + path, { ...options, headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...options.headers
  } });

  await t.test('missing and URL-query credentials cannot access catalog', async () => {
    for (const path of ['/catalog', `/catalog?token=${encodeURIComponent(token)}`]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 401);
    }
    assert.equal(calls.length, 0);
  });
  await t.test('signed-in catalog is private and uses the resolved user', async () => {
    const response = await send('/catalog');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.json()).accountId, user._id);
    assert.equal(calls.at(-1)[1], user);
  });
  await t.test('read-only users can read but cannot run Siri actions', async () => {
    user.isReadOnly = true;
    const before = calls.length;
    const response = await send('/commands', { method: 'POST', body: JSON.stringify({ requestId: randomUUID() }) });
    assert.equal(response.status, 403);
    assert.equal(calls.length, before);
    assert.equal((await send('/catalog')).status, 200);
    user.isReadOnly = false;
  });
  await t.test('inactive users and accounts without HomeBrain access are denied', async () => {
    user.isActive = false;
    assert.equal((await send('/catalog')).status, 403);
    user.isActive = true;
    user.platforms.homebrain = false;
    assert.equal((await send('/catalog')).status, 403);
    user.platforms.homebrain = true;
  });
  await t.test('expired access credentials return 401 instead of running a command', async () => {
    const expired = jwt.sign({ sub: user._id }, process.env.JWT_SECRET, { expiresIn: -1 });
    const before = calls.length;
    assert.equal((await send('/commands', { method: 'POST', body: '{}', headers: { Authorization: `Bearer ${expired}` } })).status, 401);
    assert.equal(calls.length, before);
  });
  await t.test('accepted workflow is 202 and body cannot replace authenticated actor', async () => {
    const command = { requestId: randomUUID(), accountId: user._id, kind: 'workflow', targetId: 'night-tv', action: 'run', user: { _id: 'attacker' } };
    const response = await send('/commands', { method: 'POST', body: JSON.stringify(command) });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).state, 'running');
    assert.equal(calls.at(-1)[1], user);
    assert.deepEqual(calls.at(-1)[2], command);
  });
  await t.test('failed completion remains failed and status lookup is user-scoped', async () => {
    const requestId = randomUUID();
    const response = await send(`/commands/${requestId}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.success, false);
    assert.equal(result.state, 'failed');
    assert.deepEqual(calls.at(-1), ['get', user, requestId]);
    failure = Object.assign(new Error('Command not found for this account.'), { status: 404 });
    assert.equal((await send(`/commands/${requestId}`)).status, 404);
    failure = null;
  });
  await t.test('internal failures do not expose database details', async () => {
    failure = new Error('mongodb private credentials must not leave the server');
    const response = await send('/catalog');
    assert.equal(response.status, 500);
    const result = await response.json();
    assert.equal(result.success, false);
    assert.equal(result.message, 'HomeBrain could not process this Siri request.');
    failure = null;
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const { WorkflowCredentialService } = require('../services/workflowCredentialService');
const { redactSecrets } = require('../utils/redactSecrets');
const auth = require('../routes/middlewares/auth');
const UserService = require('../services/userService');

test('HTTP workflow credentials are encrypted, referenced, reusable and fail closed without their restore key', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homebrain-vault-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const records = new Map();
  const model = {
    async create(doc) { const _id = String(records.size + 1).padStart(24, '0'); records.set(_id, doc); return { _id }; },
    findById(id) { return { select: () => ({ lean: async () => records.get(id) }) }; }
  };
  const service = new WorkflowCredentialService({ model, keyPath: path.join(dir, 'key') });
  const raw = { actions: [{ type: 'repeat', parameters: { actions: [{ type: 'http_request', parameters: {
    url: 'https://example.test/hook', headers: { Authorization: 'Bearer private-value' }, basicAuth: { password: 'secret-password' }, body: { arbitraryField: 'private-body' }
  } }] } }] };
  const protectedValue = await service.protect(raw);
  assert.doesNotMatch(JSON.stringify(protectedValue), /private-value|secret-password|private-body/);
  assert.doesNotMatch(JSON.stringify([...records.values()]), /private-value|secret-password|private-body/);
  const params = protectedValue.actions[0].parameters.actions[0].parameters;
  assert.equal((await service.resolveParameters(params)).headers.Authorization, 'Bearer private-value');
  assert.deepEqual(await service.protect(protectedValue), protectedValue);
  assert.equal(records.size, 1);
  assert.equal((await fs.stat(path.join(dir, 'key'))).mode & 0o777, 0o600);
  await fs.unlink(path.join(dir, 'key'));
  await assert.rejects(service.resolveParameters(params), { code: 'ENOENT' });
  assert.match(raw.actions[0].parameters.actions[0].parameters.headers.Authorization, /private-value/);
});

test('workflow and history redaction covers headers, arbitrary HTTP bodies, URLs and nested action records', () => {
  const value = redactSecrets({ actions: [{ type: 'http_request', parameters: { headers: { Custom: 'hidden' }, body: { arbitrary: 'hidden' } } }], history: [{ actionType: 'http_request', parameters: { auth: { password: 'hidden' } } }], message: 'https://user:secret@example.test/?api_key=hidden', token: 'hidden' });
  assert.doesNotMatch(JSON.stringify(value), /hidden|user:secret/);
});

test('loopback and spoofed forwarding headers cannot invoke internal Axiom sync without credentials', async (t) => {
  const sync = require('../services/axiomIngressSyncService');
  let called = false;
  t.mock.method(sync, 'sync', async () => { called = true; return {}; });
  const app = express();
  app.use(express.json());
  app.use('/internal/axiom', require('../routes/internalAxiomRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/internal/axiom/sync`, { method: 'POST', headers: { 'X-Forwarded-For': '127.0.0.1' } });
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test('password version changes invalidate legacy and sessionless access tokens', async (t) => {
  const old = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-review-session-secret';
  t.after(() => { if (old === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = old; });
  t.mock.method(UserService, 'get', async () => ({ _id: 'user', role: 'admin', isActive: true, authVersion: 1 }));
  await assert.rejects(auth.verifyAccessToken(jwt.sign({ sub: 'user' }, process.env.JWT_SECRET)), { status: 401 });
  const current = await auth.verifyAccessToken(jwt.sign({ sub: 'user', av: 1 }, process.env.JWT_SECRET));
  assert.equal(current._id, 'user');
});

test('open transport authorization is rechecked and closed after access is revoked', async (t) => {
  const { watchAuthorization } = require('../utils/watchAuthorization');
  let permitted = true;
  t.mock.method(auth, 'verifyAccessToken', async () => { if (!permitted) throw new Error('revoked'); return {}; });
  const closed = new Promise((resolve) => {
    const stop = watchAuthorization({ headers: { authorization: 'Bearer token' } }, resolve, { intervalMs: 5 });
    t.after(stop);
  });
  permitted = false;
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('stream was not closed')), 250))]);
});

test('event reconnect honors Last-Event-ID, drains all replay pages and deduplicates replay/live races', async (t) => {
  const events = require('../services/eventStreamService');
  const router = require('../routes/eventStreamRoutes');
  let calls = 0;
  t.mock.method(events, 'replay', async ({ sinceSequence }) => {
    calls += 1;
    if (calls === 1) {
      assert.equal(sinceSequence, 10);
      events.emit('event', { sequence: 12, type: 'test' });
      events.emit('event', { sequence: 13, type: 'test' });
      return { events: [{ sequence: 11 }, { sequence: 12 }] };
    }
    return { events: [{ sequence: 13 }] };
  });
  const req = Object.assign(new EventEmitter(), { query: { sinceSequence: '1', limit: '2' }, headers: {}, get: () => '10' });
  const chunks = [];
  const res = Object.assign(new EventEmitter(), { setHeader() {}, flushHeaders() {}, write(value) { chunks.push(value); }, end() {} });
  const route = router.stack.find((layer) => layer.route?.path === '/stream');
  await route.route.stack[0].handle(req, res);
  res.emit('close');
  assert.equal(calls, 2);
  assert.deepEqual([...chunks.join('').matchAll(/^id: (\d+)/gm)].map((match) => Number(match[1])), [11, 12, 13]);
  assert.equal(events.listenerCount('event'), 0);
});

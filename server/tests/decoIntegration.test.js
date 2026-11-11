const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DecoClient, normalizeHost, normalizeMac, normalizeClients } = require('../services/decoClient');
const { DecoService, fresh } = require('../services/decoService');

function rsaPair(bits) {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return { ...pair, wire: [Buffer.from(jwk.n, 'base64url').toString('hex'), '010001'], size: bits / 8 };
}

// Test-only decoding avoids the disabled privateDecrypt PKCS#1 padding mode in
// current Node releases while checking the router's actual 512-bit wire format.
function rsaDecode(hex, pair) {
  const data = Buffer.from(hex, 'hex'); const chunks = [];
  for (let i = 0; i < data.length; i += pair.size) {
    const block = crypto.privateDecrypt({ key: pair.privateKey, padding: crypto.constants.RSA_NO_PADDING }, data.subarray(i, i + pair.size));
    assert.equal(block[0], 0); assert.equal(block[1], 2);
    chunks.push(block.subarray(block.indexOf(0, 2) + 1));
  }
  return Buffer.concat(chunks).toString('utf8');
}

test('BE63 encrypted handshake and client reads use the cookie, sequence signature and immutable read endpoints', async () => {
  const pwd = rsaPair(1024); const sign = rsaPair(512); const seen = [];
  let aesKey; let aesIv; let logins = 0;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url); seen.push(parsed.pathname + parsed.search);
    assert.equal(parsed.hostname, '192.168.1.1'); assert.equal(options.redirect, 'error');
    if (parsed.searchParams.get('form') === 'keys') return Response.json({ error_code: 0, result: { password: pwd.wire } });
    if (parsed.searchParams.get('form') === 'auth') return Response.json({ error_code: 0, result: { key: sign.wire, seq: 123456 } });
    const wire = new URLSearchParams(options.body);
    const signature = rsaDecode(wire.get('sign'), sign);
    const signatureParams = new URLSearchParams(signature);
    if (parsed.searchParams.get('form') === 'login') {
      logins++; aesKey = Buffer.from(signatureParams.get('k')); aesIv = Buffer.from(signatureParams.get('i'));
    } else {
      assert.equal(options.headers.Cookie, 'sysauth=cookie-for-test');
      assert.match(parsed.pathname, /;stok=test-session\/admin\/(client|device)$/);
    }
    assert.equal(signatureParams.get('h'), crypto.createHash('md5').update('adminowner-secret').digest('hex'));
    assert.equal(Number(signatureParams.get('s')), 123456 + wire.get('data').length);
    const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey, aesIv);
    const payload = JSON.parse(Buffer.concat([decipher.update(wire.get('data'), 'base64'), decipher.final()]));
    let result;
    if (payload.operation === 'login') {
      assert.equal(rsaDecode(payload.params.password, pwd), 'owner-secret');
      result = { stok: 'test-session' };
    } else {
      assert.equal(payload.operation, 'read');
      if (parsed.searchParams.get('form') === 'client_list') {
        assert.deepEqual(payload.params, { device_mac: 'default' });
        result = { client_list: [{ name: Buffer.from('Theater AC').toString('base64'), mac: 'aa-bb-cc-dd-ee-ff', ip: '192.168.2.99', online: true, connection_type: 'band2_4', password: 'must-not-leak' }] };
      } else result = { device_list: [{ device_model: 'BE63', software_ver: '1.3.5 Build 26071712', mac: '11-22-33-44-55-66', device_ip: '192.168.1.1' }] };
    }
    const cipher = crypto.createCipheriv('aes-128-cbc', aesKey, aesIv);
    return Response.json({ data: Buffer.concat([cipher.update(JSON.stringify({ error_code: 0, result })), cipher.final()]).toString('base64') }, { headers: { 'set-cookie': 'sysauth=cookie-for-test; Path=/' } });
  };
  const client = new DecoClient('192.168.1.1', 'owner-secret', { fetchImpl });
  const snapshot = await client.snapshot();
  assert.deepEqual(snapshot.clients, [{ name: 'Theater AC', mac: 'AA:BB:CC:DD:EE:FF', ip: '192.168.2.99', online: true, connection: 'band2_4' }]);
  assert.equal(snapshot.nodes[0].firmware, '1.3.5 Build 26071712');
  await client.snapshot(); assert.equal(logins, 1);
  assert.ok(seen.every((path) => /form=(keys|auth|login|client_list|device_list)(?:&|$)/.test(path)));
  assert.doesNotMatch(JSON.stringify(snapshot), /owner-secret|must-not-leak|sysauth|stok/);
});

test('router and candidate normalization rejects public, metadata, injection and unknown online states', () => {
  for (const host of ['8.8.8.8', '127.0.0.1', '169.254.169.254', '192.168.1.1:80', '192.168.1.1/path', 'localhost']) assert.throws(() => normalizeHost(host));
  assert.equal(normalizeHost('192.168.1.1'), '192.168.1.1');
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(normalizeMac('not-a-mac'), '');
  assert.deepEqual(normalizeClients([{ mac: 'aa:bb:cc:dd:ee:ff', ip: '8.8.8.8', online: 'true', name: 'AC' }]), [{ mac: 'AA:BB:CC:DD:EE:FF', ip: '', online: null, name: 'AC', connection: '' }]);
  assert.throws(() => normalizeClients({ clients: [] }), /invalid client list/);
});

test('failed authentication and malformed responses never leak response bodies or passwords', async () => {
  const client = new DecoClient('192.168.1.1', 'owner-secret', { fetchImpl: async () => Response.json({ data: 'owner-secret' }) });
  client.aesKey = Buffer.alloc(16); client.aesIv = Buffer.alloc(16); client.seq = 1; client.signKey = { size: 64, key: rsaPair(512).publicKey };
  await assert.rejects(client.encrypted('login?form=login', {}, true), (error) => {
    assert.match(error.message, /check the network owner password/);
    assert.doesNotMatch(error.message, /owner-secret|data=/); return true;
  });
});

function memoryModel(initial) {
  let stored = { ...initial };
  class Model {
    constructor(value) { Object.assign(this, { host: '192.168.1.1', clients: [], nodes: [], ...value }); }
    async save() { stored = { ...this }; }
    static findOne() {
      const document = Object.assign(new Model({}), stored);
      return { select: async () => document, lean: async () => ({ ...stored }) };
    }
  }
  return Model;
}

test('Deco settings encrypt credentials, omit them from status and isolate changed router identities', async () => {
  const model = memoryModel({ key: 'default', host: '192.168.1.1', enabled: false });
  let encrypted = '';
  const service = new DecoService({ model, vault: { encrypt: async (password) => { encrypted = password; return 'ciphertext'; }, decrypt: async () => '' } });
  await service.configure({ host: '192.168.1.1', enabled: true, password: 'private-owner' });
  assert.equal(encrypted, 'private-owner');
  const status = await service.getStatus();
  assert.equal(status.integration.configured, true);
  assert.doesNotMatch(JSON.stringify(status), /private-owner|ciphertext|secrets/);
  await assert.rejects(service.configure({ host: '192.168.1.2' }), /password when changing/);
  await service.configure({ enabled: false });
  assert.equal((await service.getStatus()).integration.enabled, false);
});

test('router failure preserves last inventory as stale and prevents repeated automatic login attempts', async () => {
  const model = memoryModel({ host: '192.168.1.1', enabled: true, configured: true, secrets: 'encrypted', connected: true, lastSyncAt: new Date(Date.now() - 61000), clients: [{ name: 'Old AC' }] });
  let attempts = 0;
  const service = new DecoService({ model, vault: { decrypt: async () => 'secret' }, clientFactory: () => ({ snapshot: async () => { attempts++; throw new Error('Deco login failed; check the network owner password'); } }) });
  await service.sync(); await service.sync();
  assert.equal(attempts, 1);
  const status = await service.getStatus();
  assert.equal(status.integration.stale, true); assert.equal(status.integration.connected, false);
  assert.equal(status.integration.clients[0].name, 'Old AC');
  assert.deepEqual(await service.addressHints([{ id: '123' }]), {});
});

test('DHCP hints prefer the verified MAC, rotate bounded candidates, and never bind by router name or stale data', async () => {
  const clients = Array.from({ length: 50 }, (_, index) => ({ mac: `AA:BB:CC:DD:EE:${index.toString(16).padStart(2, '0').toUpperCase()}`, ip: `192.168.2.${index + 1}`, name: index === 0 ? 'TheaterAC' : 'Client', online: true }));
  const service = new DecoService({ model: memoryModel({ enabled: true, configured: true, connected: true, lastSyncAt: new Date(), clients }) });
  const first = await service.addressHints([{ id: '123', networkMac: clients[49].mac }]);
  assert.equal(first['123'][0], clients[49].ip); assert.equal(first['123'].length, 32);
  const second = await service.addressHints([{ id: '123' }]);
  assert.ok(second['123'].includes(clients[49].ip));
  const connection = { id: '123', ip: clients[0].ip };
  assert.deepEqual(await service.confirmedMacs([connection], [{ id: '123', online: false }]), {});
  assert.equal((await service.appliancePresence([connection]))[0].routerOnline, null);
  assert.deepEqual(await service.confirmedMacs([connection], [{ id: '123', online: true }]), { '123': clients[0].mac });
  const presence = await service.appliancePresence([{ ...connection, networkMac: clients[0].mac }]);
  assert.equal(presence[0].routerOnline, true);
  assert.equal(fresh({ enabled: true, connected: true, lastSyncAt: new Date(Date.now() - 181000) }), false);
});

test('Deco HTTP inventory and setup enforce admin, read-only and review-sandbox boundaries', async (t) => {
  const express = require('express'); const jwt = require('jsonwebtoken');
  const users = require('../services/userService');
  const { createDecoRouter } = require('../routes/decoRoutes');
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  t.after(() => { if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret; });
  const user = { _id: '507f1f77bcf86cd799439011', role: 'admin', isActive: true, platforms: { homebrain: true } };
  t.mock.method(users, 'get', async () => user);
  const calls = []; let fail = false;
  const record = (name) => async () => { calls.push(name); if (fail) throw new Error('private credentials.key content'); return { success: true }; };
  const router = createDecoRouter({ getStatus: record('status'), configure: record('configure'), sync: record('sync') }, record('ac-read'));
  const app = express(); app.use(express.json()); app.use('/api/deco', router);
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/deco`;
  const token = jwt.sign({ sub: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const send = (route, method = 'GET') => fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
  assert.equal((await fetch(base + '/status')).status, 401); assert.equal(calls.length, 0);
  user.role = 'user'; assert.equal((await send('/status')).status, 403);
  user.role = 'admin'; user.isReadOnly = true;
  assert.equal((await send('/configure', 'POST')).status, 403);
  user.isReadOnly = false; user.isReviewSandbox = true;
  assert.equal((await send('/status')).status, 403); user.isReviewSandbox = false;
  const status = await send('/status'); assert.equal(status.status, 200); assert.equal(status.headers.get('cache-control'), 'private, no-store');
  assert.equal((await send('/check-appliances', 'POST')).status, 200);
  assert.deepEqual(calls, ['status', 'sync', 'ac-read']);
  for (const route of ['/block', '/reboot', '/commands', '/reservations']) assert.equal((await send(route, 'POST')).status, 404);
  fail = true;
  const error = await send('/status'); assert.equal(error.status, 400); assert.doesNotMatch(await error.text(), /credentials.key/);
});

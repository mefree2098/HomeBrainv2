const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { BrokerStore } = require('../src/store');
const { AlexaEventGatewayService } = require('../src/eventGatewayService');

async function openLegacyFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alexa-queue-'));
  const filePath = path.join(dir, 'store.sqlite');
  const now = new Date().toISOString();
  const state = {
    version: 3, hubs: { h: { hubId: 'h', catalog: { endpoints: [] }, state: {}, registration: { relayToken: 'fixture' } } },
    accountLinks: { a: { brokerAccountId: 'a', hubId: 'h', status: 'linked' } },
    refreshTokens: { r: { brokerAccountId: 'a' } }, accessTokens: {}, authCodes: {},
    permissionGrants: { g: { permissionGrantId: 'g', status: 'active', accessToken: 'fixture',
      tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(), acceptedAt: '2020-01-01T00:00:00Z' } },
    eventQueue: Array.from({ length: 25 }, (_, i) => ({ eventId: 'e' + i, hubId: 'h', permissionGrantId: 'g',
      kind: 'change_report', status: 'queued', createdAt: now, nextAttemptAt: now, payload: { event: { endpoint: {} } } })),
    auditLog: [{ auditId: 'a1', type: 'fixture' }], futureField: { retained: true }
  };
  await fs.writeFile(path.join(dir, 'store.json.bak'), JSON.stringify(state));
  const stores = [];
  t.after(async () => {
    for (const s of stores) if (s.sqlite.db?.isOpen) s.sqlite.db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function open() {
    const store = new BrokerStore({ filePath });
    stores.push(store);
    await store.init();
    return store;
  }
  return { state, filePath, open, store: await open() };
}

test('imports the legacy backup, drains its queue using row updates, and performs no write on an empty poll', async (t) => {
  const { state, filePath, store, open } = await openLegacyFixture(t);
  assert.deepEqual(store.state, state);
  const revisions = [];
  for (const file of [filePath, filePath + '.bak']) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const check = new DatabaseSync(file);
    // Fail the test if a delivery rewrites cold data, even when its value stays identical.
    check.exec(`CREATE TRIGGER protect_cold BEFORE UPDATE ON records
      WHEN old.section NOT IN ('eventQueue','permissionGrants')
      BEGIN SELECT RAISE(ABORT,'rewrote a cold record'); END`);
    check.close();
  }
  const realSave = store.sqlite.save.bind(store.sqlite);
  store.sqlite.save = (next) => { realSave(next); revisions.push(store.sqlite.revision); };
  const gateway = new AlexaEventGatewayService({ store, httpClient: { post: async () => ({ status: 202 }) } });
  const result = await gateway.flush();
  assert.equal(result.processed, 25);
  assert.ok(result.results.every((r) => r.status === 'delivered'));
  assert.equal(new Set(revisions).size, 26); // one claim, one commit per delivery including its grant
  const before = await Promise.all([filePath, filePath + '.bak'].map((f) => fs.stat(f, { bigint: true })));
  assert.equal((await gateway.flush()).processed, 0);
  assert.equal(revisions.length, 26);
  const after = await Promise.all([filePath, filePath + '.bak'].map((f) => fs.stat(f, { bigint: true })));
  assert.deepEqual(after.map((s) => s.mtimeNs), before.map((s) => s.mtimeNs));
  assert.ok(store.state.permissionGrants.g.lastUsedAt);
  store.sqlite.db.close();
  await fs.unlink(filePath);
  const restored = await open();
  assert.equal(restored.state.eventQueue.filter((e) => e.status === 'delivered').length, 25);
  assert.deepEqual(restored.state.permissionGrants, store.state.permissionGrants);
  assert.deepEqual(restored.state.hubs, state.hubs);
  assert.deepEqual(restored.state.refreshTokens, state.refreshTokens);
  assert.deepEqual(restored.state.futureField, state.futureField);
});

test('a failed mirror write rolls back both the event and grant and leaves their lease recoverable', async (t) => {
  const { filePath, store, open } = await openLegacyFixture(t);
  await store.reserveQueuedEvents({ limit: 1 });
  const revision = store.sqlite.revision;
  const mirror = new DatabaseSync(filePath + '.bak');
  mirror.exec("CREATE TRIGGER fail_commit BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT,'simulated failure'); END");
  await assert.rejects(() => store.finalizeQueuedEvent('e0', { status: 'delivered' }), /simulated failure/);
  assert.equal(store.sqlite.revision, revision);
  assert.equal(store.state.eventQueue[0].status, 'processing');
  assert.equal(store.state.permissionGrants.g.lastUsedAt, undefined);
  mirror.exec('DROP TRIGGER fail_commit');
  mirror.close();
  const restarted = await open();
  assert.equal(restarted.state.eventQueue[0].status, 'processing');
  assert.equal(restarted.state.permissionGrants.g.lastUsedAt, undefined);
  await restarted.finalizeQueuedEvent('e0', { status: 'delivered' });
  await assert.rejects(() => store.finalizeQueuedEvent('e0', { status: 'failed' }), /another writer/);
});

test('losing both databases after cutover cannot replay stale JSON credentials', async (t) => {
  const { filePath, store, open } = await openLegacyFixture(t);
  store.sqlite.db.close();
  await fs.unlink(filePath);
  await fs.unlink(filePath + '.bak');
  await assert.rejects(open(), /Both initialized broker databases are missing/);
});

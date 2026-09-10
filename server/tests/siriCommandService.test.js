const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SiriCommandService, normalizeCommand } = require('../services/siriCommandService');

const user = { _id: '507f1f77bcf86cd799439011', isReadOnly: false };
function fixture(options = {}) {
  const records = new Map();
  const calls = [];
  const lightList = [
    { _id: 'light1', name: 'Bed Lamp', room: 'Master Bedroom', type: 'light' },
    { _id: 'light2', name: 'Ceiling', room: 'Master Bedroom', type: 'light' },
    { _id: 'light3', name: 'Kitchen', room: 'Kitchen', type: 'light' },
    { _id: 'lock1', name: 'Door Lock', room: 'Master Bedroom', type: 'lock' }
  ];
  const workflowList = [{ _id: 'workflow1', name: 'Night TV', enabled: true, voiceAliases: ['turn on night tv', 'Movie time'] },
    { _id: 'disabled1', name: 'Disabled', enabled: false }];
  const sceneList = [{ _id: 'scene1', name: 'Relax' }];
  const key = (uid, rid) => `${uid}:${rid}`;
  const store = {
    async create(record) {
      const k = key(record.userId, record.requestId);
      if (records.has(k)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      records.set(k, structuredClone(record));
    },
    async get(uid, rid) { const record = records.get(key(uid, rid)); return record ? structuredClone(record) : null; },
    async update(uid, rid, changes) { Object.assign(records.get(key(uid, rid)), changes); }
  };
  const service = new SiriCommandService({ store,
    devices: { list: async () => lightList, control: async (...args) => { calls.push(['light', ...args]); if (options.control) return options.control(...args); return {}; } },
    workflows: { list: async () => workflowList, run: async (...args) => { calls.push(['workflow', ...args]); return options.workflowResult ?? { success: true }; } },
    scenes: { list: async () => sceneList, run: async (...args) => { calls.push(['scene', ...args]); return options.sceneResult ?? { status: 'success', actionResults: [{ success: true }] }; } },
    ...(options.now ? { now: options.now } : {})
  });
  const command = (overrides = {}) => ({ accountId: user._id, requestId: randomUUID(), kind: 'room', targetId: 'Master Bedroom', action: 'turn_on', ...overrides });
  async function completed(input) {
    await service.start(user, input);
    for (let i = 0; i < 100; i++) {
      const result = await service.get(user, input.requestId);
      if (result.state !== 'running') return result;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('Command did not complete');
  }
  return { service, records, calls, lightList, workflowList, store, command, completed };
}

test('Siri catalog includes real rooms, individual lights, workflows and aliases; excludes locks and disabled workflows', async () => {
  const f = fixture(); const catalog = await f.service.catalog(user);
  assert.equal(catalog.accountId, user._id);
  assert.equal(catalog.canExecute, true);
  assert.equal(catalog.targets.filter((t) => t.kind === 'room').length, 2);
  assert.equal(catalog.targets.filter((t) => t.kind === 'light').length, 3);
  assert.ok(catalog.targets.some((t) => t.name === 'Master Bedroom lights'));
  assert.deepEqual(catalog.targets.find((t) => t.name === 'Night TV').aliases, ['turn on night tv', 'Movie time']);
  assert.ok(!catalog.targets.some((t) => ['lock1', 'disabled1'].includes(t.id)));
});
test('turn on Master Bedroom lights controls only the selected room through the existing engine', async () => {
  const f = fixture(); const result = await f.completed(f.command());
  assert.equal(result.state, 'completed'); assert.equal(result.success, true);
  assert.equal(result.message, 'Turned on Master Bedroom lights.');
  assert.deepEqual(f.calls.map((c) => c[1]).sort(), ['light1', 'light2']);
  assert.ok(f.calls.every((c) => c[2] === 'turn_on' && c[4].command.source === 'siri' && c[4].command.actor === user._id));
});
test('turn off and brightness 0/100 use explicit actions and preserve zero', async () => {
  for (const payload of [{ action: 'turn_off' }, { action: 'set_brightness', brightness: 0 }, { action: 'set_brightness', brightness: 100 }]) {
    const f = fixture(); const result = await f.completed(f.command(payload));
    assert.equal(result.state, 'completed'); assert.ok(f.calls.every((c) => c[2] === payload.action && c[3] === payload.brightness));
  }
});
test('single-light commands never expand to its entire room', async () => {
  const f = fixture(); await f.completed(f.command({ kind: 'light', targetId: 'light1' }));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], 'light1');
});
test('Night TV executes the workflow engine with Siri actor/audit context, not a toggle or enable operation', async () => {
  const f = fixture(); const command = f.command({ kind: 'workflow', targetId: 'workflow1', action: 'run' });
  const result = await f.completed(command);
  assert.equal(result.state, 'completed'); assert.equal(result.message, 'Finished Night TV.');
  assert.equal(f.calls.length, 1);
  const [, target, options] = f.calls[0];
  assert.equal(target, 'workflow1'); assert.equal(options.triggerSource, 'siri');
  assert.equal(options.context.siriRequestId, command.requestId);
  assert.equal(options.context.commandContext.actor, user._id); assert.equal(options.force, undefined);
});
test('workflow failure is not spoken as success', async () => {
  const f = fixture({ workflowResult: { success: false, status: 'partial_success' } });
  const result = await f.completed(f.command({ kind: 'workflow', targetId: 'workflow1', action: 'run' }));
  assert.equal(result.state, 'failed'); assert.equal(result.success, false);
});
test('scene waits for completion; partial and unknown results fail closed', async () => {
  for (const sceneResult of [{ status: 'success', actionResults: [{ success: true }] }, { status: 'partial_success' }, { status: 'success', actionResults: [{ success: false }] }, {}]) {
    const f = fixture({ sceneResult });
    const result = await f.completed(f.command({ kind: 'scene', targetId: 'scene1', action: 'activate' }));
    assert.equal(f.calls[0][2].waitForCompletion, true);
    assert.equal(result.success, sceneResult.status === 'success' && sceneResult.actionResults[0].success);
  }
});
test('partial room failures are counted, retained, and reported honestly', async () => {
  const f = fixture({ control: async (id) => { if (id === 'light2') throw new Error('offline'); } });
  const result = await f.completed(f.command());
  assert.equal(result.success, false); assert.match(result.message, /Only 1 of 2 lights/);
  assert.equal(result.results.filter((r) => !r.success).length, 1);
});
test('room execution bounds concurrent device commands to four', async () => {
  let active = 0; let max = 0;
  const f = fixture({ control: async () => { max = Math.max(max, ++active); await new Promise((r) => setTimeout(r, 4)); active--; } });
  for (let i = 0; i < 15; i++) f.lightList.push({ _id: `extra${i}`, name: `Light ${i}`, type: 'light', room: 'Master Bedroom' });
  await f.completed(f.command()); assert.equal(max, 4);
});
test('replayed invocation returns stored result without repeating effects', async () => {
  const f = fixture(); const c = f.command(); const done = await f.completed(c);
  assert.deepEqual(await f.service.start(user, c), done); assert.equal(f.calls.length, 2);
});
test('racing duplicate invocation IDs execute only once', async () => {
  const f = fixture(); const c = f.command({ kind: 'workflow', targetId: 'workflow1', action: 'run' });
  await Promise.all(Array.from({ length: 12 }, () => f.service.start(user, c)));
  await f.completed(c); assert.equal(f.calls.length, 1);
});
test('same invocation ID with different content is rejected', async () => {
  const f = fixture(); const c = f.command(); await f.completed(c);
  await assert.rejects(f.service.start(user, { ...c, action: 'turn_off' }), { status: 409 });
});
test('unknown, disabled, and removed targets never execute', async () => {
  for (const change of [{ targetId: 'master bedroom' }, { targetId: '' }, { kind: 'light', targetId: 'lock1' }, { kind: 'workflow', targetId: 'disabled1', action: 'run', force: true }]) {
    const f = fixture(); await assert.rejects(f.service.start(user, f.command(change))); assert.equal(f.calls.length, 0);
  }
});
test('wrong account, signed-out and read-only callers are denied before any command', async () => {
  const f = fixture(); const c = f.command();
  await assert.rejects(f.service.start(user, { ...c, accountId: 'other' }), { status: 409 });
  await assert.rejects(f.service.start({ ...user, isReadOnly: true }, c), { status: 403 });
  await assert.rejects(f.service.start({}, c), { status: 401 });
  assert.equal((await f.service.catalog({ ...user, isReadOnly: true })).canExecute, false);
  assert.equal(f.calls.length, 0);
});
test('status lookup is account-scoped', async () => {
  const f = fixture(); const c = f.command(); await f.completed(c);
  await assert.rejects(f.service.get({ _id: 'other' }, c.requestId), { status: 404 });
});
test('stale in-progress work becomes unknown and is never automatically repeated', async () => {
  let now = 0; const f = fixture({ now: () => now }); const c = f.command();
  const normalized = normalizeCommand(user, c);
  const { fingerprint } = require('../services/siriCommandService');
  await f.store.create({ userId: user._id, requestId: c.requestId, state: 'running', heartbeatAt: new Date(0), message: 'Started', fingerprint: fingerprint(normalized) });
  now = 61_000;
  const result = await f.service.start(user, c);
  assert.equal(result.state, 'unknown'); assert.equal(result.success, false); assert.equal(f.calls.length, 0);
});
test('persistence errors fail closed before executing devices', async () => {
  const f = fixture(); f.store.create = async () => { throw new Error('database offline'); };
  await assert.rejects(f.service.start(user, f.command()), /database offline/); assert.equal(f.calls.length, 0);
});
test('invalid brightness types, unsupported actions and invalid UUIDs are rejected', () => {
  const f = fixture();
  for (const brightness of [-1, 101, 0.5, '50', null, {}, NaN, Infinity]) {
    assert.throws(() => normalizeCommand(user, f.command({ action: 'set_brightness', brightness })), { status: 400 });
  }
  for (const change of [{ kind: '__proto__' }, { kind: 'constructor' }, { kind: 'security', action: 'disarm' }, { action: 'toggle' }, { requestId: 'x' }, { targetId: {} }, { targetId: 'x'.repeat(513) }]) {
    assert.throws(() => normalizeCommand(user, f.command(change)), { status: 400 });
  }
});
test('UUID normalization is stable, irrelevant user-controlled options are discarded', () => {
  const f = fixture(); const c = f.command({ source: 'admin', actor: 'other', force: true });
  assert.deepEqual(normalizeCommand(user, { ...c, requestId: c.requestId.toUpperCase() }), normalizeCommand(user, c));
  assert.equal(normalizeCommand(user, c).source, undefined);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const hap = require('@homebridge/hap-nodejs');
const { catalog, assignBridges, createSafetyPolicy } = require('../services/appleHome/catalog');
const { BridgeStorage } = require('../services/appleHome/storage');
const { AppleHomeBridge, assertOwner, lanInterfaces } = require('../services/appleHome/bridge');

const admin = { _id: 'admin', role: 'admin', isActive: true, platforms: { homebrain: true } };
const fixtures = () => ({ devices: [
  { _id: 'lamp', name: 'Theater Cans', room: 'Theater', type: 'light', status: true, brightness: 50, isOnline: true, groups: ['Theater Lights'] },
  { _id: 'bedroom', name: 'Ceiling', room: 'Master Bedroom', type: 'light', status: false, isOnline: true },
  { _id: 'tv', name: 'TV', room: 'Theater', type: 'media_activity', status: false, isOnline: true },
  { _id: 'lock', name: 'Front Door', room: 'Entry', type: 'lock', isOnline: true }
], workflows: [
  { _id: 'night', name: 'Night TV', enabled: true, voiceAliases: ['Stars Only'], actions: [{ type: 'device_control', target: 'lamp', parameters: { action: 'turn_off' } }] },
  { _id: 'disabled', name: 'Disabled', enabled: false, actions: [] },
  { _id: 'unsafe', name: 'Unlock', enabled: true, actions: [{ type: 'device_control', target: 'lock', parameters: { action: 'unlock' } }] }
], scenes: [{ _id: 'movie', name: 'Movie Time', deviceActions: [{ deviceId: 'lamp', action: 'turn_on' }] }],
  groups: [{ _id: 'group', name: 'Theater Lights' }] });

test('catalog automatically discovers device names, rooms and workflow scene aliases without shortcuts', () => {
  const result = catalog(fixtures(), 'hub');
  assert.deepEqual(result.targets.map((x) => x.key), ['light:bedroom', 'light:lamp', 'scene:movie', 'switch:tv', 'workflow:night']);
  assert.deepEqual(result.targets.find((x) => x.key === 'workflow:night').sceneNames, ['Night TV', 'Stars Only']);
  assert.equal(result.targets.find((x) => x.id === 'bedroom').room, 'Master Bedroom');
  assert.ok(result.skipped.some((x) => x.id === 'workflow:unsafe'));
});
test('security and opaque workflows never become ordinary Home switches', () => {
  const f = fixtures();
  for (const type of ['http_request', 'isy_network_resource', 'reachy_action', 'not_an_action']) {
    f.workflows[0].actions = [{ type }]; assert.equal(createSafetyPolicy(f).workflowSafe('night'), false);
  }
  f.workflows[0].actions = [{ type: 'repeat', parameters: { actions: [{ type: 'device_control', target: 'lock', parameters: { action: 'unlock' } }] } }];
  assert.equal(createSafetyPolicy(f).workflowSafe('night'), false);
});
test('nested scene security, group security and recursive workflow cycles fail closed', () => {
  const f = fixtures();
  f.workflows[0].actions = [{ type: 'scene_activate', target: 'movie' }];
  assert.equal(createSafetyPolicy(f).workflowSafe('night'), true);
  f.scenes[0].deviceActions[0] = { deviceId: 'lock', action: 'unlock' };
  assert.equal(createSafetyPolicy(f).workflowSafe('night'), false);
  f.workflows[0].actions = [{ type: 'device_control', target: { kind: 'device_group', group: 'Theater Lights' }, parameters: { action: 'turn_off' } }];
  assert.equal(createSafetyPolicy(f).workflowSafe('night'), true);
  f.devices[3].groups = ['Theater Lights'];
  assert.equal(createSafetyPolicy(f).workflowSafe('night'), false);
  f.workflows[0].actions = [{ type: 'workflow_control', parameters: { workflowId: 'night', operation: 'run' } }];
  assert.equal(createSafetyPolicy(f).workflowSafe('night'), false);
});
test('stable identities survive rename; different hubs cannot collide', () => {
  const f = fixtures(), first = catalog(f, 'hub').targets;
  f.devices[0].name = 'Theater Downlights'; f.devices[0].room = 'Cinema';
  const renamed = catalog(f, 'hub').targets;
  assert.equal(first.find((x) => x.id === 'lamp').serial, renamed.find((x) => x.id === 'lamp').serial);
  assert.notEqual(first[0].serial, catalog(f, 'other-hub').targets[0].serial);
});
test('HAP bridge capacity is sharded without migrating paired accessories', () => {
  const targets = Array.from({ length: 301 }, (_, n) => ({ key: `light:${n}` }));
  const first = assignBridges(targets);
  assert.equal(Object.values(first).filter((x) => x === 0).length, 149);
  assert.equal(Object.values(first).filter((x) => x === 1).length, 149);
  const second = assignBridges([...targets.slice(1), { key: 'new' }], first);
  for (const t of targets.slice(1)) assert.equal(second[t.key], first[t.key]);
});
test('duplicate device names get stable disambiguation rather than a random target', () => {
  const f = fixtures(); f.devices[1].name = f.devices[0].name;
  const names = catalog(f, 'hub').targets.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});
test('bridge ownership requires active non-sandbox controlling administrator', () => {
  for (const user of [null, { ...admin, isActive: false }, { ...admin, isReadOnly: true }, { ...admin, role: 'user' },
    { ...admin, isReviewSandbox: true }, { ...admin, platforms: { homebrain: false } }]) assert.throws(() => assertOwner(user));
  assert.equal(assertOwner(admin), admin);
});
test('advertisements select real private LAN interfaces; not public or loopback-only hosts', () => {
  assert.deepEqual(lanInterfaces({ en0: [{ address: '192.168.1.2', internal: false }], lo: [{ address: '127.0.0.1', internal: true }] }, ''), ['en0']);
  assert.throws(() => lanInterfaces({ en0: [{ address: '8.8.8.8', internal: false }] }, ''));
  assert.throws(() => lanInterfaces({ en0: [{ address: '192.168.1.2', internal: false }] }, 'typo'));
});
test('pairing storage is private, stable, exclusive and corruption is not silently replaced', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-homekit-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new BridgeStorage(dir), config = store.create('admin');
  assert.equal(await store.read(), null); await store.write(config);
  assert.deepEqual(await store.read(), config);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dir, 'bridge.json'))).mode & 0o777, 0o600);
  await store.acquire(); await assert.rejects(new BridgeStorage(dir).acquire()); await store.release();
  await fs.writeFile(path.join(dir, 'bridge.json'), '{bad'); await assert.rejects(store.read());
});

// Real HAP services/characteristics, with only LAN publication replaced. No live home devices are touched.
test('real HAP accessory engine, lifecycle and authorization integration', async (t) => {
  const f = fixtures(), events = new EventEmitter(), calls = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-hap-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let owner = admin, result = { state: 'running' }, catalogFailure = false;
  class TestBridge extends hap.Bridge {
    async publish(info, insecure) { this.info = info; this.insecure = insecure; this._accessoryInfo = { paired: () => false }; }
    async unpublish() { this.unpublished = true; }
    setupURI() { return 'X-HM://TEST'; }
  }
  const bridge = new AppleHomeBridge({ storage: new BridgeStorage(dir), events,
    load: async () => { if (catalogFailure) throw new Error('database unavailable'); return f; }, getUser: async () => owner,
    readDevice: async (deviceId) => f.devices.find((d) => d._id === deviceId),
    controlDevice: async (...args) => { calls.push(args); },
    runTarget: async (...args) => { calls.push(args); await new Promise((r) => setTimeout(r, 10)); return { success: true, state: 'running' }; },
    commandStatus: async () => result,
    interfaces: () => ['private-test-interface'], loadHap: () => ({ ...hap, Bridge: TestBridge }) });
  t.after(() => bridge.shutdown());
  await bridge.initialize();
  await t.test('default off: no listener, pairing material or device effects', async () => {
    assert.equal(bridge.status(admin).running, false); assert.equal(bridge.bridges.size, 0); assert.equal(calls.length, 0);
    await assert.rejects(bridge.pairing(admin)); await assert.rejects(bridge.configure(admin, { enabled: true }));
  });
  await bridge.configure(admin, { enabled: true, confirm: 'SHARE WITH APPLE HOME' });
  await t.test('published HAP uses secure pairing, exact stable services and no credential status leakage', async () => {
    const publisher = bridge.bridges.get(0);
    assert.equal(publisher.insecure, false); assert.equal(publisher.info.port, 51826);
    assert.equal(publisher.bridgedAccessories.length, 5);
    const lamp = bridge.accessories.get('light:lamp');
    assert.ok(lamp.getService(hap.Service.Lightbulb));
    assert.equal(lamp.getService(hap.Service.AccessoryInformation).getCharacteristic(hap.Characteristic.Model).value, bridge.targets.find((target) => target.id === 'lamp').serial);
    assert.ok(lamp.homebrainService.getCharacteristic(hap.Characteristic.Brightness));
    assert.equal(JSON.stringify(bridge.status(admin)).includes(bridge.config.pin), false);
    assert.equal((await bridge.pairing(admin)).pin, bridge.config.pin);
    await assert.rejects(bridge.pairing({ ...admin, _id: 'other' }));
  });
  await t.test('Theater Cans OFF controls only that device with the real voice policy metadata', async () => {
    await bridge.write('light:lamp', 'on', false);
    assert.deepEqual(calls.at(-1).slice(0, 3), ['lamp', 'turn_off', undefined]);
    assert.equal(calls.at(-1)[3].command.source, 'siri');
    assert.equal(calls.at(-1)[3].command.actor, 'admin');
  });
  await t.test('brightness 0 and 100 preserved; malformed values refused', async () => {
    for (const value of [0, 100]) { await bridge.write('light:lamp', 'brightness', value); assert.equal(calls.at(-1)[2], value); }
    for (const value of [-1, 101, '40', NaN]) await assert.rejects(bridge.write('light:lamp', 'brightness', value));
  });
  await t.test('live state, including offline failure, is read from HomeBrain', async () => {
    assert.equal(await bridge.read('light:lamp', 'brightness'), 50);
    f.devices[0].isOnline = false; await assert.rejects(bridge.read('light:lamp', 'on')); await assert.rejects(bridge.write('light:lamp', 'on', true));
    f.devices[0].isOnline = true;
  });
  await t.test('Night TV and Stars Only share a workflow trigger; simultaneous writes run it once', async () => {
    const before = calls.length;
    await Promise.all([bridge.write('workflow:night', 'on', true), bridge.write('workflow:night', 'on', true)]);
    assert.equal(calls.length - before, 1); assert.equal(calls.at(-1)[1].id, 'night');
    assert.equal(await bridge.read('workflow:night', 'on'), true);
    await bridge.write('workflow:night', 'on', false); assert.equal(calls.length - before, 1);
    result = { state: 'completed' };
  });
  await t.test('edited unsafe or disabled workflows are refused before any effect, even before periodic sync', async () => {
    f.workflows[0].enabled = false; await assert.rejects(bridge.write('workflow:night', 'on', true)); f.workflows[0].enabled = true;
  });
  await t.test('renaming does not replace an accessory; removals and additions reconcile automatically', async () => {
    const original = bridge.accessories.get('light:lamp'); f.devices[0].name = 'Theater Lights';
    f.devices = f.devices.filter((d) => d._id !== 'bedroom');
    await bridge.refresh();
    assert.equal(bridge.accessories.get('light:lamp'), original); assert.equal(original.displayName, 'Theater Lights');
    assert.equal(bridge.accessories.has('light:bedroom'), false);
  });
  await t.test('revoked owner authorization refuses HAP commands and unpublishes', async () => {
    owner = { ...admin, isActive: false }; const before = calls.length;
    await assert.rejects(bridge.write('light:lamp', 'on', true)); assert.equal(calls.length, before);
    await assert.rejects(bridge.refresh()); assert.equal(bridge.bridges.size, 0); owner = admin;
  });
  await bridge.refresh();
  await t.test('failed catalog unpublishes instead of retaining stale permission-sensitive targets', async () => {
    catalogFailure = true; await assert.rejects(bridge.refresh()); assert.equal(bridge.bridges.size, 0); catalogFailure = false;
  });
  await t.test('disable persists without deleting pairing identity, enabling restores same accessory IDs', async () => {
    const namespace = bridge.config.namespace;
    await bridge.configure(admin, { enabled: false }); assert.equal(bridge.status(admin).enabled, false);
    await bridge.configure(admin, { enabled: true, confirm: 'SHARE WITH APPLE HOME' }); assert.equal(bridge.config.namespace, namespace);
    await bridge.shutdown(); assert.equal(events.listenerCount('devices:update'), 0);
  });
});

test('actual workflow onFalseActions are security checked, including deeply nested repeats', () => {
  const f = fixtures();
  const unsafe = { type: 'device_control', target: 'lock', parameters: { action: 'unlock' } };
  f.workflows[0].actions = [{ type: 'condition', parameters: { onFalseActions: [unsafe] } }];
  assert.equal(createSafetyPolicy(f).workflowSafe('night'), false);
  let action = { type: 'delay', parameters: { seconds: 1 } };
  for (let n = 0; n < 20; n++) action = { type: 'repeat', parameters: { actions: [action] } };
  f.workflows[0].actions = [action];
  assert.equal(createSafetyPolicy(f).workflowSafe('night'), false);
});
test('nested workflow target precedence exactly follows the real execution engine', () => {
  const f = fixtures();
  const child = { _id: 'safeChild', enabled: true, name: 'Child', actions: f.workflows[0].actions };
  f.workflows.push(child);
  f.workflows[0].actions = [{ type: 'workflow_control', target: 'safeChild', parameters: { target: 'unsafe', operation: 'run' } }];
  assert.equal(createSafetyPolicy(f).workflowSafe('night'), false);
  f.workflows[0].actions = [{ type: 'workflow_control', parameters: { target: 'safeChild' } }];
  assert.equal(createSafetyPolicy(f).workflowSafe('night'), true);
});
test('invalid pairing identity fields fail closed instead of changing established identities', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-homekit-corrupt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new BridgeStorage(dir), good = store.create('admin');
  for (const update of [{ setupSeed: null }, { enabled: 'true' }, { assignments: [] }, { highestShard: 999 }]) {
    await fs.writeFile(path.join(dir, 'bridge.json'), JSON.stringify({ ...good, ...update }));
    await assert.rejects(store.read());
  }
});

test('hidden security members cannot escape group safety checks through UI discovery filtering', () => {
  const f = fixtures();
  const hidden = { _id: 'hiddenAlarm', name: 'Alarm', type: 'switch', groups: ['Theater Lights'], properties: { securityZoneId: 'entry' } };
  f.safetyDevices = [...f.devices, hidden];
  f.workflows[0].actions = [{ type: 'device_control', target: { kind: 'group', group: 'Theater Lights' }, parameters: { action: 'turn_on' } }];
  assert.equal(createSafetyPolicy(f).workflowSafe('night'), false);
  assert.equal(catalog(f, 'hub').targets.some((x) => x.id === 'hiddenAlarm'), false);
});

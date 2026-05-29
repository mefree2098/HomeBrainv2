'use strict';

// Coverage for the INSTEON bulk re-link orchestration (relinkAllTrackedDevices).
//
// When the PLM's all-link database is emptied (lost/reset), modern i2cs devices reject
// direct commands from the now-unknown PLM, so control silently fails. relinkAllTrackedDevices
// rebuilds those links for every tracked device using the proven per-device link primitives.
// These tests drive the orchestration with stubbed link calls (no PLM/serial hardware): they
// verify iteration, de-duplication, retries, responder-only detection, manual mode, cancellation,
// and summary accounting.

const test = require('node:test');
const assert = require('node:assert/strict');

const insteonSingleton = require('../services/insteonService');
const proto = Object.getPrototypeOf(insteonSingleton);
const Device = require('../models/Device');

const originalFind = Device.find;
function stubDevices(devices) {
  Device.find = () => ({ select: () => ({ lean: async () => devices }) });
}
test.afterEach(() => { Device.find = originalFind; });

// Build a minimal service bound to the real prototype (so real helpers like
// _normalizePossibleInsteonAddress / _formatInsteonAddress / _buildTrackedInsteonDeviceQuery
// run), but with the hardware-touching bits stubbed.
function makeService(overrides = {}) {
  const svc = Object.create(proto);
  svc.isConnected = true;
  svc.hub = {};
  svc._sleep = async () => {};
  svc._logEngineInfo = () => {};
  svc.getPLMInfo = async () => ({ deviceId: '112233' });
  return Object.assign(svc, overrides);
}

const remoteOk = () => ({ responderLink: {}, controllerLink: {}, controllerLinkError: null });

test('_normalizeRelinkRunRequest clamps and defaults', () => {
  const svc = makeService();
  const norm = svc._normalizeRelinkRunRequest({ group: 999, retries: 99, perDeviceTimeoutMs: 1, linkMode: 'MANUAL' });
  assert.equal(norm.group, 255);
  assert.equal(norm.retries, 5);
  assert.equal(norm.perDeviceTimeoutMs, 3000);
  assert.equal(norm.linkMode, 'manual');

  const def = svc._normalizeRelinkRunRequest({});
  assert.equal(def.linkMode, 'remote');
  assert.equal(def.group, 1);
  assert.equal(def.retries, 1);
});

test('links every tracked device and summarizes', async () => {
  const calls = [];
  const svc = makeService({ _linkDeviceRemote: async (addr, opts) => { calls.push({ addr, opts }); return remoteOk(); } });
  stubDevices([
    { _id: 'a', name: 'Lamp', properties: { insteonAddress: '1A.2B.3C' } },
    { _id: 'b', name: 'Fan', properties: { insteonAddress: '4D.5E.6F' } }
  ]);

  const progress = [];
  const result = await svc.relinkAllTrackedDevices({}, { onProgress: (e) => progress.push(e) });

  assert.equal(result.success, true);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.linked, 2);
  assert.equal(result.summary.failed, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.ensureControllerLinks, true, 'creates both responder + controller links');
  assert.ok(progress.some((p) => p.stage === 'complete' && p.progress === 100), 'emits a completion progress event');
});

test('de-duplicates the same address in different formats', async () => {
  let count = 0;
  const svc = makeService({ _linkDeviceRemote: async () => { count += 1; return remoteOk(); } });
  stubDevices([
    { _id: 'a', name: 'A', properties: { insteonAddress: '1A.2B.3C' } },
    { _id: 'b', name: 'B', properties: { insteonAddress: '1a2b3c' } }
  ]);

  const result = await svc.relinkAllTrackedDevices({}, {});
  assert.equal(result.summary.total, 1);
  assert.equal(count, 1);
});

test('retries failures the configured number of times, then records failed', async () => {
  const attempts = [];
  const svc = makeService({ _linkDeviceRemote: async (addr) => { attempts.push(addr); throw new Error('no response'); } });
  stubDevices([{ _id: 'a', name: 'A', properties: { insteonAddress: '1A.2B.3C' } }]);

  const result = await svc.relinkAllTrackedDevices({ retries: 2 }, {});
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.linked, 0);
  assert.equal(attempts.length, 3, '1 initial attempt + 2 retries');
  assert.equal(result.devices[0].status, 'failed');
  assert.match(result.devices[0].error, /no response/);
});

test('a controller-link error is reported as responder-only (not a full success)', async () => {
  const svc = makeService({
    _linkDeviceRemote: async () => ({ responderLink: {}, controllerLink: null, controllerLinkError: new Error('controller link failed') })
  });
  stubDevices([{ _id: 'a', name: 'A', properties: { insteonAddress: '1A.2B.3C' } }]);

  const result = await svc.relinkAllTrackedDevices({}, {});
  assert.equal(result.summary.responderOnly, 1);
  assert.equal(result.summary.linked, 0);
  assert.equal(result.devices[0].status, 'responder-only');
});

test('manual mode uses the manual link primitive', async () => {
  const manual = [];
  const svc = makeService({
    _linkDeviceManual: async (addr) => { manual.push(addr); },
    _linkDeviceRemote: async () => { throw new Error('remote should not be used in manual mode'); }
  });
  stubDevices([{ _id: 'a', name: 'A', properties: { insteonAddress: '1A.2B.3C' } }]);

  const result = await svc.relinkAllTrackedDevices({ linkMode: 'manual' }, {});
  assert.equal(manual.length, 1);
  assert.equal(result.summary.linked, 1);
});

test('honors cancellation between devices', async () => {
  let cancel = false;
  const svc = makeService({ _linkDeviceRemote: async () => { cancel = true; return remoteOk(); } });
  stubDevices([
    { _id: 'a', name: 'A', properties: { insteonAddress: '1A.2B.3C' } },
    { _id: 'b', name: 'B', properties: { insteonAddress: '4D.5E.6F' } }
  ]);

  await assert.rejects(
    () => svc.relinkAllTrackedDevices({}, { shouldCancel: () => cancel }),
    (error) => error && error.code === 'RELINK_CANCELLED'
  );
});

test('throws when there are no tracked INSTEON devices', async () => {
  const svc = makeService();
  stubDevices([]);
  await assert.rejects(() => svc.relinkAllTrackedDevices({}, {}), /No tracked INSTEON devices/);
});

test('skips entries without a valid INSTEON address', async () => {
  let count = 0;
  const svc = makeService({ _linkDeviceRemote: async () => { count += 1; return remoteOk(); } });
  stubDevices([
    { _id: 'a', name: 'A', properties: { insteonAddress: '1A.2B.3C' } },
    { _id: 'b', name: 'NoAddr', properties: {} }
  ]);

  const result = await svc.relinkAllTrackedDevices({}, {});
  assert.equal(result.summary.total, 1);
  assert.equal(count, 1);
});

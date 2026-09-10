'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const hap = require('@homebridge/hap-nodejs');
const { publishBridge } = require('../services/appleHome/publisher');

function fake(publish = () => {}) {
  const bridge = new EventEmitter();
  bridge._server = { httpServer: { tcpServer: new EventEmitter() } };
  bridge.publish = (info, insecure) => { assert.equal(insecure, false); return publish(bridge, info); };
  return bridge;
}
const info = { advertiser: 'ciao' };
test('publisher waits for discovery readiness, not just successful publish() resolution', async () => {
  const bridge = fake(); let ready = false;
  const result = publishBridge(bridge, info, assert.fail).then(() => { ready = true; });
  await Promise.resolve(); assert.equal(ready, false);
  bridge.emit('advertised'); await result; assert.equal(ready, true);
  bridge.homebrainStopPublicationMonitor();
});
test('publisher catches next-tick bind errors before they can become uncaught exceptions', async () => {
  const error = Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
  const bridge = fake((b) => { process.nextTick(() => b._server.httpServer.tcpServer.emit('error', error)); });
  await assert.rejects(publishBridge(bridge, info, assert.fail), { code: 'EADDRINUSE' });
  bridge.homebrainStopPublicationMonitor();
});
test('publisher times out when mDNS never advertises; unsupported ABI fails closed', async () => {
  const bridge = fake();
  await assert.rejects(publishBridge(bridge, info, assert.fail, 10), /startup deadline/);
  assert.equal(bridge.homebrainPublished, false); bridge.homebrainStopPublicationMonitor();
  const changed = fake(); delete changed._server;
  await assert.rejects(publishBridge(changed, info, assert.fail), /transport contract/);
  changed.homebrainStopPublicationMonitor();
});
test('post-start failure marks publisher unavailable and teardown consumes queued socket errors', async () => {
  const failures = [], bridge = fake((b) => { queueMicrotask(() => b.emit('advertised')); });
  await publishBridge(bridge, info, (error) => failures.push(error));
  bridge.homebrainPublished = true;
  const tcp = bridge._server.httpServer.tcpServer;
  tcp.emit('error', new Error('listener failed'));
  assert.equal(bridge.homebrainPublished, false); assert.equal(failures.length, 1);
  bridge.homebrainStopPublicationMonitor(); tcp.emit('error', new Error('queued during close'));
  assert.equal(failures.length, 1); tcp.emit('close'); assert.equal(tcp.listenerCount('error'), 0);
});
test('publisher refuses unvalidated advertisers without calling dependency', async () => {
  const bridge = fake(() => assert.fail('must not publish'));
  await assert.rejects(publishBridge(bridge, { advertiser: 'avahi' }, assert.fail), /validated ciao/);
});
test('actual HAP TCP listener returns occupied-port failure without crashing the process', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-hap-port-test-'));
  const occupied = net.createServer();
  occupied.listen(0, '0.0.0.0'); await once(occupied, 'listening');
  const bridge = new hap.Bridge('HomeBrain Port Test', hap.uuid.generate('homebrain-publisher-port-test'));
  hap.HAPStorage.setCustomStoragePath(directory);
  t.after(async () => {
    bridge.homebrainStopPublicationMonitor?.();
    await bridge.unpublish();
    await new Promise((resolve) => occupied.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const publication = { advertiser: 'ciao', username: '02:00:00:00:00:31', pincode: '482-51-673',
    port: occupied.address().port, bind: ['127.0.0.1'], category: hap.Categories.BRIDGE, addIdentifyingMaterial: false };
  // No pairing or device traffic: TCP bind fails before advertising can start.
  await assert.rejects(publishBridge(bridge, publication, assert.fail, 3000), { code: 'EADDRINUSE' });
  assert.equal(bridge.homebrainPublished, false);
  assert.equal(bridge._server.allowInsecureRequest, false);
});

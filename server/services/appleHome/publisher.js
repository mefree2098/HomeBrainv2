'use strict';

/**
 * HAP 2.2.3 resolves publish() after requesting listen(), before its TCP socket
 * or mDNS advertisement is ready. It does not forward the TCP server's error
 * event to the accessory. Keep this small, version-pinned adapter covered by a
 * real occupied-port test: a HomeKit port conflict must never kill HomeBrain.
 */
function publishBridge(bridge, info, onRuntimeFailure, timeoutMs = 10_000) {
  if (info.advertiser !== 'ciao') return Promise.reject(new Error('Apple Home requires the validated ciao publisher.'));
  return new Promise((resolve, reject) => {
    let settled = false, advertised = false, initialized = false, stopped = false;
    const timer = setTimeout(() => fail(new Error('Apple Home did not become discoverable before the startup deadline.')), timeoutMs);
    const cleanStartup = () => { clearTimeout(timer); bridge.off('advertised', ready); };
    const fail = (error) => {
      bridge.homebrainPublished = false;
      if (stopped) return;
      if (!settled) { settled = true; cleanStartup(); reject(error); }
      else { onRuntimeFailure(error); }
    };
    const finish = () => {
      if (!settled && initialized && advertised) { settled = true; cleanStartup(); resolve(); }
    };
    const ready = () => { advertised = true; finish(); };
    bridge.once('advertised', ready);
    bridge.on('error', fail);
    bridge.homebrainStopPublicationMonitor = () => {
      stopped = true; cleanStartup(); bridge.off('error', fail);
      // Keep the socket error handler until close: queued errors during teardown
      // must still be consumed. The closed socket and closure are then collectible.
    };
    try {
      // With the explicit ciao advertiser this pinned library constructs its
      // socket synchronously. Attach before the next event-loop tick, not after
      // awaiting publish(), when a bind error could already have been emitted.
      const pending = bridge.publish(info, false);
      Promise.resolve(pending).then(() => { initialized = true; finish(); }, fail);
      const tcp = bridge._server?.httpServer?.tcpServer;
      if (!tcp || typeof tcp.on !== 'function') {
        fail(new Error('The installed HomeKit publisher does not match the validated transport contract.'));
        return;
      }
      tcp.on('error', fail);
      tcp.once('close', () => tcp.off('error', fail));
    } catch (error) { fail(error); }
  });
}
module.exports = { publishBridge };

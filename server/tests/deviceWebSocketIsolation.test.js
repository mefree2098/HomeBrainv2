const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const deviceWebSocket = require('../websocket/deviceWebSocket');

test('device websocket broadcasts exclude unauthenticated and review-sandbox clients', (t) => {
  const originalServer = deviceWebSocket.wss;
  const deliveries = {
    production: [],
    review: [],
    pending: [],
  };

  const client = (kind, authenticated, user) => ({
    readyState: WebSocket.OPEN,
    authenticated,
    user,
    send(message) {
      deliveries[kind].push(JSON.parse(message));
    },
  });

  deviceWebSocket.wss = {
    clients: new Set([
      client('production', true, { isReviewSandbox: false }),
      client('review', true, { isReviewSandbox: true }),
      client('pending', false, null),
    ]),
  };

  t.after(() => {
    deviceWebSocket.wss = originalServer;
  });

  deviceWebSocket.broadcast({ type: 'devices:update', devices: [{ id: 'production-device' }] });

  assert.equal(deliveries.production.length, 1);
  assert.equal(deliveries.production[0].devices[0].id, 'production-device');
  assert.deepEqual(deliveries.review, []);
  assert.deepEqual(deliveries.pending, []);
});

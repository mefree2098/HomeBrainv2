const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const auth = require('../routes/middlewares/auth');
const emitter = require('../services/deviceUpdateEmitter');
const DeviceWebSocket = require('../websocket/deviceWebSocket').constructor;
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('initialization is idempotent and stop releases emitter and HTTP handlers', () => {
  const stream = new DeviceWebSocket();
  const server = new EventEmitter();
  const before = emitter.listenerCount('devices:update');
  stream.initialize(server);
  stream.initialize(server);
  assert.equal(server.listenerCount('upgrade'), 1);
  assert.equal(emitter.listenerCount('devices:update'), before + 1);
  assert.equal(stream.wss.options.maxPayload, 16 * 1024);
  stream.stop();
  assert.equal(server.listenerCount('upgrade'), 0);
  assert.equal(emitter.listenerCount('devices:update'), before);
  stream.initialize(server);
  assert.equal(emitter.listenerCount('devices:update'), before + 1);
  stream.stop();
});
test('slow consumers are disconnected without queuing further updates', () => {
  const stream = new DeviceWebSocket();
  let terminated = 0;
  const socket = {
    readyState: WebSocket.OPEN, authenticated: true, bufferedAmount: 2 * 1024 * 1024,
    terminate() { terminated += 1; },
    send() { assert.fail('must not add to an overfull outbound queue'); }
  };
  stream.wss = { clients: new Set([socket]) };
  stream.broadcast({ type: 'devices:update', devices: [] });
  assert.equal(terminated, 1);
});
test('transport errors are handled while authentication is pending and closed sockets stay unauthenticated', async (t) => {
  const stream = new DeviceWebSocket();
  t.after(() => stream.stop());
  let finishAuth;
  t.mock.method(auth, 'verifyAccessToken', () => new Promise((resolve) => { finishAuth = resolve; }));
  const socket = new EventEmitter();
  Object.assign(socket, { readyState: WebSocket.OPEN, close() {}, send() { assert.fail('closed socket must not receive status'); } });
  stream.ensureServer();
  stream.wss.emit('connection', socket, { headers: {} });
  assert.equal(socket.listenerCount('error'), 1);
  socket.emit('error', new Error('simulated pre-auth transport error'));
  socket.readyState = WebSocket.CLOSED;
  finishAuth({ isReviewSandbox: false });
  await tick();
  assert.equal(socket.authenticated, false);
});
test('text ping Buffers receive pong after successful authentication', async (t) => {
  const stream = new DeviceWebSocket();
  t.after(() => stream.stop());
  t.mock.method(auth, 'verifyAccessToken', async () => ({ isReviewSandbox: false }));
  const delivered = [];
  const socket = new EventEmitter();
  Object.assign(socket, { readyState: WebSocket.OPEN, bufferedAmount: 0, close() {}, send(value) { delivered.push(JSON.parse(value)); } });
  stream.ensureServer();
  stream.wss.emit('connection', socket, { headers: {} });
  await tick();
  socket.emit('message', Buffer.from('{"type":"ping"}'), false);
  assert.deepEqual(delivered.map((message) => message.type), ['status', 'pong']);
});

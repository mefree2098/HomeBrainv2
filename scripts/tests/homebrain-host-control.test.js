const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { requestHostControl } = require('../homebrain-host-control');

async function server(t, handler) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-control-'));
  const socketPath = path.join(dir, 'host.sock');
  const instance = net.createServer(handler);
  await new Promise((resolve, reject) => instance.listen(socketPath, resolve).once('error', reject));
  t.after(async () => {
    await new Promise((resolve) => instance.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return socketPath;
}

test('client sends one action and receives a successful socket response', async (t) => {
  let request;
  const socketPath = await server(t, (client) => client.once('data', (chunk) => {
    request = JSON.parse(chunk);
    client.end(`${JSON.stringify({ ok: true, code: 0, stdout: 'ready', stderr: '' })}\n`);
  }));
  const result = await requestHostControl('probe', { socketPath });
  assert.deepEqual(request, { action: 'probe' });
  assert.equal(result.stdout, 'ready');
});

test('client rejects unsupported host actions before connecting', async () => {
  for (const action of ['reboot', 'exec', 'restart;sh', 'kernel-apply', '../probe']) {
    await assert.rejects(requestHostControl(action), /not permitted/);
  }
});

test('client treats denied, malformed, oversized and incomplete replies as failures', async (t) => {
  for (const response of ['{"ok":false,"code":64,"stderr":"denied"}\n', 'not-json\n', `${'x'.repeat(17000)}\n`, '']) {
    const socketPath = await server(t, (client) => client.once('data', () => client.end(response)));
    await assert.rejects(requestHostControl('probe', { socketPath }));
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

test('server shutdown bounds HTTP drain and force closes lingering connections', () => {
  const serverScript = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');

  assert.match(serverScript, /function closeServer\(server, name\)/);
  assert.match(serverScript, /server\.closeIdleConnections\(\)/);
  assert.match(serverScript, /server\.closeAllConnections\(\)/);
  assert.match(serverScript, /Timed out waiting \$\{HTTP_CLOSE_TIMEOUT_MS\}ms for \$\{name\} to stop/);
  assert.match(serverScript, /await runShutdownStep\('HTTP server'/);
});

test('server shutdown explicitly stops both websocket servers before HTTP close', () => {
  const serverScript = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');
  const voiceWebSocket = fs.readFileSync(path.join(repoRoot, 'server', 'websocket', 'voiceWebSocket.js'), 'utf8');
  const deviceWebSocket = fs.readFileSync(path.join(repoRoot, 'server', 'websocket', 'deviceWebSocket.js'), 'utf8');

  assert.match(serverScript, /await runShutdownStep\('voice websocket server', \(\) => voiceWsServer\.stop\(\)\)/);
  assert.match(serverScript, /await runShutdownStep\('device websocket server', \(\) => deviceWebSocket\.stop\(\)\)/);
  assert.match(voiceWebSocket, /socket\.close\(1001, 'HomeBrain is shutting down'\)/);
  assert.match(voiceWebSocket, /socket\.terminate\(\)/);
  assert.match(deviceWebSocket, /stop\(\) \{/);
  assert.match(deviceWebSocket, /socket\.close\(1001, 'HomeBrain is shutting down'\)/);
  assert.match(deviceWebSocket, /socket\.terminate\(\)/);
});

test('direct radio shutdown has its own larger budget inside the graceful stop path', () => {
  const serverScript = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');

  assert.match(
    serverScript,
    /clampDurationMs\(process\.env\.HOMEBRAIN_DIRECT_RADIO_SHUTDOWN_TIMEOUT_MS, 70_000, 5000, 5 \* 60_000\)/
  );
  assert.match(serverScript, /directRadioService\.shutdown\(\), DIRECT_RADIO_SHUTDOWN_TIMEOUT_MS/);
});

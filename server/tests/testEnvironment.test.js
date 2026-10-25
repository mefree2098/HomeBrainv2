const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('unit tests isolate database and service control inherited from a production deploy', () => {
  const output = execFileSync(process.execPath, [
    '--require', path.join(__dirname, 'isolateTestEnvironment.cjs'),
    '-e', 'process.stdout.write(JSON.stringify({database:process.env.DATABASE_URL,hardened:process.env.HOMEBRAIN_HARDENED_SERVICE,socket:process.env.HOMEBRAIN_HOST_CONTROL_SOCKET}))'
  ], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'mongodb://production.invalid/HomeBrain', HOMEBRAIN_HARDENED_SERVICE: '1', HOMEBRAIN_HOST_CONTROL_SOCKET: '/run/homebrain-control/host.sock' }
  });
  const environment = JSON.parse(output);
  assert.equal(environment.database, 'mongodb://127.0.0.1:1/homebrain_unit_tests');
  assert.equal(environment.hardened, '0');
  assert.notEqual(environment.socket, '/run/homebrain-control/host.sock');
  assert.match(environment.socket, /homebrain-unit-tests-/);
});

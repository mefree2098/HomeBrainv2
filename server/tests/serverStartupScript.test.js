const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..', '..');

test('Sense initialization waits for the database connection', () => {
  const serverScript = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');
  const senseStartupBlock = serverScript.match(
    /\/\/ Initialize Sense energy integration([\s\S]*?)async function gracefulShutdown/
  );

  assert.ok(senseStartupBlock, 'Sense startup block is present');
  assert.match(
    senseStartupBlock[1],
    /await dbReady;\s+await senseService\.initialize\(\);/
  );
});

test('Alexa startup waits for the database and initializes after it is ready', async () => {
  const script = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');
  const block = script.match(/\/\/ Initialize managed Alexa broker service\s+([\s\S]*?)\/\/ Initialize MQTT platform bridge/);
  assert.ok(block);
  let ready;
  const dbReady = new Promise((resolve) => { ready = resolve; });
  let initialized = 0;
  const startup = vm.runInNewContext(block[1], {
    dbReady,
    alexaBrokerService: { initialize: async () => { initialized += 1; } },
    console: { log() {}, error() {} }
  });
  await new Promise(setImmediate);
  assert.equal(initialized, 0);
  ready();
  await startup;
  assert.equal(initialized, 1);
});

test('Alexa startup reports database failure without starting the broker', async () => {
  const script = fs.readFileSync(path.join(repoRoot, 'server', 'server.js'), 'utf8');
  const block = script.match(/\/\/ Initialize managed Alexa broker service\s+([\s\S]*?)\/\/ Initialize MQTT platform bridge/);
  let initialized = 0;
  const errors = [];
  await vm.runInNewContext(block[1], {
    dbReady: Promise.reject(new Error('test database unavailable')),
    alexaBrokerService: { initialize: async () => { initialized += 1; } },
    console: { log() {}, error: (...args) => { errors.push(args.join(' ')); } }
  });
  assert.equal(initialized, 0);
  assert.match(errors[0], /test database unavailable/);
});

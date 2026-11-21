const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { digestFiles, prepareWebBuild } = require('../../scripts/verified-client-build');

test('managed web builds reuse only complete matching inputs and assets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function put(name, value) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  }
  const jobId = '03117611-ee8e-49fc-9aa3-b43aede241cb';
  const state = 'server/data/platform-deploy/';
  const job = { id: jobId, currentStep: 'Build client', status: 'running',
    options: { preset: 'safe', allowDirty: false, installDependencies: false } };
  put(state + 'latest-job.txt', jobId);
  const saveJob = () => put(state + 'jobs/' + jobId + '.json', JSON.stringify(job));
  saveJob();
  for (const name of ['package.json', 'package-lock.json', 'client/package-lock.json',
    'client/node_modules/.package-lock.json', 'client/index.html', 'shared/user.ts']) put(name, name);
  const installed = { packages: { 'node_modules/example': { version: '1', integrity: 'sha512-known' } } };
  put('client/package-lock.json', JSON.stringify(installed));
  put('client/node_modules/.package-lock.json', JSON.stringify(installed));
  const environment = { HOMEBRAIN_PLATFORM_CLIENT_BUILD: '1' };
  const prepare = (env = environment) => prepareWebBuild('22.23.4', root, env);
  assert.equal(prepare({}), null);
  assert.equal(prepare({ ...environment, CI: 'true' }), null);
  assert.equal(prepare({ ...environment, VITE_API_URL: 'custom' }), null);
  assert.equal(prepare().reusable, false);
  put('client/dist/index.html', 'verified html');
  put('client/dist/assets/route.js', 'verified javascript');
  prepare().record();
  assert.equal(prepare().reusable, true);
  assert.equal(prepare({ INVOCATION_ID: 'a'.repeat(32) }).reusable, true);
  put('client/node_modules/.package-lock.json', 'different deps');
  assert.equal(prepare().reusable, false);
  const inputs = digestFiles(root, ['client','shared','package.json','package-lock.json'], new Set(['client/node_modules','client/dist']));
  const output = digestFiles(root, ['client/dist']);
  put('scripts/verified-client-build.json', JSON.stringify({ inputs, output }));
  assert.equal(prepare().reusable, false);
  put('client/node_modules/.package-lock.json', JSON.stringify({ ...installed, lockfileVersion: 3 }));
  assert.equal(prepare().reusable, true);
  put('client/dist/assets/route.js', 'broken');
  assert.equal(prepare().reusable, false);
  fs.unlinkSync(path.join(root, 'client/dist/assets/route.js'));
  assert.equal(prepare().reusable, false);
  put('client/dist/assets/route.js', 'verified javascript');
  put('shared/user.ts', 'changed type');
  assert.equal(prepare().reusable, false);
  put('shared/user.ts', 'shared/user.ts');
  put('client/.env.production.local', 'VITE_API_URL=custom');
  assert.equal(prepare().reusable, false);
  job.options.installDependencies = true;
  saveJob();
  assert.equal(prepare(), null);
  job.status = 'completed';
  job.options.installDependencies = false;
  saveJob();
  assert.equal(prepare(), null);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const runnerPath = path.join(repoRoot, 'scripts', 'run-with-modern-node.js');

function waitForFile(filePath, timeoutMs = 5000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(filePath)) {
        resolve();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${filePath}`));
        return;
      }

      setTimeout(check, 25);
    };

    check();
  });
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out waiting for child exit'));
    }, timeoutMs);

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('run-with-modern-node forwards termination signals to the spawned command', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-modern-node-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const readyPath = path.join(tempDir, 'ready');
  const signalPath = path.join(tempDir, 'signal');
  const childScriptPath = path.join(tempDir, 'child.js');
  fs.writeFileSync(childScriptPath, `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');
    process.on('SIGTERM', () => {
      fs.writeFileSync(${JSON.stringify(signalPath)}, 'SIGTERM');
      setTimeout(() => process.exit(0), 20);
    });
    setInterval(() => {}, 1000);
  `);

  const child = spawn(process.execPath, [runnerPath, 'node', childScriptPath], {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      HOMEBRAIN_PREFERRED_NODE_MAJOR: process.versions.node.split('.')[0]
    }
  });
  t.after(() => child.kill('SIGKILL'));

  await waitForFile(readyPath);
  child.kill('SIGTERM');
  const result = await waitForExit(child);

  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.equal(fs.readFileSync(signalPath, 'utf8'), 'SIGTERM');
});

test('run-with-modern-node can print the selected Node binary for exec launchers', () => {
  const result = require('node:child_process').spawnSync(process.execPath, [runnerPath, '--print-node-bin'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOMEBRAIN_PREFERRED_NODE_MAJOR: process.versions.node.split('.')[0]
    }
  });

  assert.equal(result.status, 0);
  assert.ok(result.stdout.trim());
  assert.equal(fs.existsSync(result.stdout.trim()), true);
});

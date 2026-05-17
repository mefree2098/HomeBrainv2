const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  acquireSingletonProcessLock,
  buildLockPath,
  removeStaleLock
} = require('../utils/singletonProcessLock');

test('acquireSingletonProcessLock blocks a duplicate live owner and releases cleanly', (t) => {
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-lock-test-'));
  t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));

  const first = acquireSingletonProcessLock({
    lockDir,
    name: 'homebrain-test',
    port: 31337
  });
  assert.equal(first.acquired, true);

  const duplicate = acquireSingletonProcessLock({
    lockDir,
    name: 'homebrain-test',
    port: 31337
  });
  assert.equal(duplicate.acquired, false);
  assert.equal(duplicate.owner.pid, process.pid);

  first.release();

  const reacquired = acquireSingletonProcessLock({
    lockDir,
    name: 'homebrain-test',
    port: 31337
  });
  assert.equal(reacquired.acquired, true);
  reacquired.release();
});

test('acquireSingletonProcessLock removes stale lock files before acquiring', (t) => {
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-stale-lock-test-'));
  t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));

  const lockPath = buildLockPath({
    lockDir,
    name: 'homebrain-test',
    port: 31338
  });
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: 99999999 })}\n`, 'utf8');

  const acquired = acquireSingletonProcessLock({
    lockDir,
    name: 'homebrain-test',
    port: 31338
  });

  assert.equal(acquired.acquired, true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
  acquired.release();
});

test('removeStaleLock preserves a lock owned by another pid', (t) => {
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-preserve-lock-test-'));
  t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));

  const lockPath = buildLockPath({
    lockDir,
    name: 'homebrain-test',
    port: 31339
  });
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid + 1 })}\n`, 'utf8');

  assert.equal(removeStaleLock(lockPath, process.pid), false);
  assert.equal(fs.existsSync(lockPath), true);
});

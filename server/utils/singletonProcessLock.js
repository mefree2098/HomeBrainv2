const fs = require('fs');
const os = require('os');
const path = require('path');

function sanitizeLockName(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9_.-]+/g, '-');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function pidIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }

  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLinuxCommandLine(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

function lockOwnerStillLooksValid(lockData) {
  const pid = Number(lockData?.pid);
  if (!pidIsAlive(pid)) {
    return false;
  }

  if (pid === process.pid) {
    return true;
  }

  const commandLine = readLinuxCommandLine(pid);
  if (!commandLine) {
    return true;
  }

  return /(?:^|\s)server\.js(?:\s|$)/.test(commandLine) || /HomeBrainv2/.test(commandLine);
}

function removeStaleLock(lockPath, expectedPid = null) {
  if (expectedPid !== null) {
    const current = readJsonFile(lockPath);
    if (Number(current?.pid) !== Number(expectedPid)) {
      return false;
    }
  }

  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

function buildLockPath(options = {}) {
  const lockDir = options.lockDir
    || process.env.HOMEBRAIN_SERVER_LOCK_DIR
    || process.env.HOMEBRAIN_RUNTIME_DIR
    || os.tmpdir();
  const name = sanitizeLockName(options.name || 'homebrain-server');
  const port = sanitizeLockName(options.port || process.env.PORT || '3000');
  return path.join(lockDir, `${name}-${port}.lock`);
}

function acquireSingletonProcessLock(options = {}) {
  if (String(options.enabled ?? process.env.HOMEBRAIN_SERVER_SINGLETON_LOCK ?? 'true').toLowerCase() === 'false') {
    return {
      acquired: true,
      disabled: true,
      lockPath: null,
      release() {}
    };
  }

  const lockPath = buildLockPath(options);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      const payload = {
        pid: process.pid,
        cwd: process.cwd(),
        argv: process.argv,
        createdAt: new Date().toISOString()
      };
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
      fs.closeSync(fd);

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        removeStaleLock(lockPath, process.pid);
      };
      process.once('exit', release);

      return {
        acquired: true,
        lockPath,
        owner: payload,
        release
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const owner = readJsonFile(lockPath);
      if (!lockOwnerStillLooksValid(owner)) {
        removeStaleLock(lockPath);
        continue;
      }

      return {
        acquired: false,
        lockPath,
        owner,
        release() {}
      };
    }
  }

  return {
    acquired: false,
    lockPath,
    owner: readJsonFile(lockPath),
    release() {}
  };
}

module.exports = {
  acquireSingletonProcessLock,
  buildLockPath,
  lockOwnerStillLooksValid,
  pidIsAlive,
  removeStaleLock
};

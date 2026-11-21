const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const sourcePaths = ['client', 'shared', 'package.json', 'package-lock.json'];
const skip = new Set(['client/node_modules', 'client/dist']);

// Frame filenames and per-file hashes so changes in names, content or boundaries differ.
function digestFiles(root, names, exclude = new Set()) {
  const result = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  function visit(relative) {
    if (exclude.has(relative)) return;
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(relative + '/' + name);
    } else if (stat.isFile()) {
      const content = createHash('sha256');
      const fd = fs.openSync(file, 'r');
      try {
        let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          content.update(buffer.subarray(0, count));
        }
      } finally { fs.closeSync(fd); }
      result.update(relative + '\0').update(content.digest());
    } else {
      throw new Error('Web build verification requires regular files');
    }
  }
  for (const name of names) visit(name);
  return result.digest('hex');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function installedFromLock(installed, expected) {
  if (!installed?.packages || !expected?.packages) return false;
  return Object.entries(installed.packages).every(([name, entry]) => {
    if (!name) return true;
    const locked = expected.packages[name];
    return locked && entry.version === locked.version && entry.integrity === locked.integrity;
  });
}

function matches(record, inputs, output) {
  return Boolean(record && output && record.inputs === inputs && record.output === output);
}

function prepareWebBuild(version, root = ROOT, env = process.env) {
  // Older Linux deploy runners also execute this freshly pulled launcher.
  if (env.HOMEBRAIN_PLATFORM_CLIENT_BUILD !== '1' && !/^[a-f0-9]{32}$/i.test(env.INVOCATION_ID || '')) return null;
  if (env.CI || env.HOMEBRAIN_TYPE_BASELINE_REF) return null;

  // A full install, a manual build and a customized Vite environment keep their normal build path.
  const data = path.join(root, 'server/data/platform-deploy');
  try {
    const id = fs.readFileSync(path.join(data, 'latest-job.txt'), 'utf8').trim();
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    const job = readJson(path.join(data, 'jobs', id + '.json'));
    if (job?.id !== id || job.status !== 'running' || job.currentStep !== 'Build client'
      || job.options?.installDependencies !== false || job.options.allowDirty !== false
      || job.options.preset === 'full') return null;
    if (Object.keys(env).some(key => /^(VITE_|BROWSERSLIST|TS_NODE_)/.test(key))
      || (env.NODE_ENV && env.NODE_ENV !== 'production')
      || (env.NODE_OPTIONS && !/^--max-old-space-size=\d+$/.test(env.NODE_OPTIONS))) return null;

    const inputs = digestFiles(root, sourcePaths, skip);
    const installLock = path.join(root, 'client/node_modules/.package-lock.json');
    const dependencies = createHash('sha256').update(fs.readFileSync(installLock)).digest('hex');
    const toolchain = [version, process.platform, process.arch, dependencies, env.NODE_OPTIONS || ''].join('/');
    const stampPath = path.join(data, 'verified-client-build.json');
    const local = readJson(stampPath);
    const published = readJson(path.join(root, 'scripts/verified-client-build.json'));
    let output = null;
    const digestOutput = () => {
      if (!fs.statSync(path.join(root, 'client/dist/index.html')).size) throw new Error('Missing web entry point');
      return digestFiles(root, ['client/dist']);
    };
    try { output = digestOutput(); } catch { /* A missing or partial build is rebuilt below. */ }
    const reusable = (local?.toolchain === toolchain && matches(local, inputs, output))
      || (matches(published, inputs, output) && installedFromLock(readJson(installLock), readJson(path.join(root, 'client/package-lock.json'))));
    return {
      reusable,
      record() {
        try {
          if (inputs !== digestFiles(root, sourcePaths, skip)) return;
          const stamp = { inputs, output: digestOutput(), toolchain };
          const temp = stampPath + '.' + process.pid + '.tmp';
          fs.writeFileSync(temp, JSON.stringify(stamp), { mode: 0o600 });
          fs.renameSync(temp, stampPath);
        } catch (error) { console.warn('Could not record the verified web build:', error.message); }
      }
    };
  } catch { return null; }
}

module.exports = { digestFiles, prepareWebBuild };

if (require.main === module) {
  const reference = { inputs: digestFiles(ROOT, sourcePaths, skip), output: digestFiles(ROOT, ['client/dist']) };
  process.stdout.write(JSON.stringify(reference, null, 2) + '\n');
}

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const packageService = require('../services/reachyMiniPackageService');
const {
  SOURCE_ROOT,
  isSafeRelativePath,
  dependencyFingerprintFromPyproject,
  launcherFingerprintFromSource,
  STABLE_LAUNCHER_FILES,
  normalizeCompatibility
} = packageService;

function resolveContractTestPython() {
  const candidates = [
    process.env.HOMEBRAIN_REACHY_PYTHON,
    path.join(__dirname, '..', '.wakeword-venv', 'bin', 'python'),
    'python3.12',
    'python3.11',
    'python3.10',
    'python3'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      // These tests exercise launcher metadata and receipt parsing only. The package
      // installer independently enforces the declared Python >=3.11 runtime floor.
      execFileSync(candidate, ['-c', 'import sys; raise SystemExit(sys.version_info < (3, 10))'], {
        stdio: 'ignore'
      });
      return candidate;
    } catch (_error) {
      // Keep looking for a Python version supported by the Reachy package.
    }
  }
  throw new Error('Reachy package contract tests require Python 3.10 or newer');
}

test('Reachy runtime manifest includes exact launcher compatibility and bytewise aggregate', async () => {
  const manifest = await packageService.buildManifest({ force: true, runtimeOnly: true });
  const artifact = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'artifact-manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.artifact, 'reachy-homebrain-app');
  assert.equal(manifest.version, artifact.version);
  assert.deepEqual(manifest.compatibility, artifact.compatibility);
  assert.match(manifest.aggregateSha256, /^[a-f0-9]{64}$/);

  const aggregate = crypto.createHash('sha256');
  for (const file of [...manifest.files].sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8')
  ))) {
    aggregate.update(file.path);
    aggregate.update('\0');
    aggregate.update(String(file.size));
    aggregate.update('\0');
    aggregate.update(file.sha256);
    aggregate.update('\n');
  }
  assert.equal(aggregate.digest('hex'), manifest.aggregateSha256);
  assert.equal(manifest.files.some((file) => file.path === 'src/reachy_homebrain/__init__.py'), false);
  assert.equal(manifest.files.every((file, index, files) => (
    index === 0 || Buffer.compare(Buffer.from(files[index - 1].path), Buffer.from(file.path)) < 0
  )), true);
});

test('bootstrap inventory includes stable launcher while runtime update inventory excludes it', async () => {
  const bootstrap = await packageService.buildManifest({ force: true });
  const runtime = await packageService.buildManifest({ force: true, runtimeOnly: true });
  assert.equal(bootstrap.files.some((file) => file.path === 'install.sh'), true);
  assert.equal(bootstrap.files.some((file) => file.path === 'LICENSE'), true);
  assert.equal(bootstrap.files.some((file) => file.path === 'src/reachy_homebrain/__init__.py'), true);
  assert.equal(bootstrap.files.some((file) => file.path === 'src/reachy_homebrain/main.py'), true);
  assert.equal(runtime.files.some((file) => file.path === 'install.sh'), false);
  assert.equal(runtime.files.some((file) => file.path === 'src/reachy_homebrain/main.py'), false);
  assert.equal(runtime.files.some((file) => file.path === 'src/reachy_homebrain/__init__.py'), false);
  await assert.rejects(
    packageService.resolveFile('src/reachy_homebrain/main.py', { runtimeOnly: true }),
    (error) => error.status === 400
  );
  await assert.rejects(
    packageService.resolveFile('src/reachy_homebrain/__init__.py', { runtimeOnly: true }),
    (error) => error.status === 400
  );
});

test('server-generated bootstrap archive contains the declared license file', async (t) => {
  const { createReachyPackage } = require('../routes/reachyMiniRoutes');
  const generated = await createReachyPackage();
  t.after(() => fs.rmSync(generated.temporaryRoot, { recursive: true, force: true }));
  const entries = execFileSync('tar', ['-tzf', generated.archivePath], { encoding: 'utf8' })
    .split('\n')
    .map((entry) => entry.replace(/^\.\//, ''));
  assert.equal(entries.includes('LICENSE'), true);
  assert.equal(entries.includes('pyproject.toml'), true);
});

test('fresh bootstrap receipt aggregate exactly matches the server runtime manifest', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'reachy-bootstrap-digest-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const realPython = resolveContractTestPython();
  const pythonWrapper = path.join(temporary, 'python-wrapper');
  const receiptPath = path.join(temporary, 'installed-receipt.json');
  fs.writeFileSync(pythonWrapper, [
    '#!/bin/sh',
    'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then exit 0; fi',
    `exec "${realPython}" "$@"`,
    ''
  ].join('\n'), { mode: 0o700 });

  execFileSync('sh', [path.join(SOURCE_ROOT, 'install.sh'), '--python', pythonWrapper, '--update-only'], {
    env: {
      ...process.env,
      HOMEBRAIN_REACHY_RECEIPT: receiptPath,
      PYTHONPATH: path.join(SOURCE_ROOT, 'src')
    },
    stdio: 'pipe'
  });
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const manifest = await packageService.buildManifest({ force: true, runtimeOnly: true });
  assert.equal(receipt.version, manifest.version);
  assert.equal(receipt.aggregateSha256, manifest.aggregateSha256);
  assert.equal(receipt.fileCount, manifest.fileCount);
});

test('dependency fingerprint is derived from source declarations, not trusted metadata', () => {
  const pyproject = fs.readFileSync(path.join(SOURCE_ROOT, 'pyproject.toml'), 'utf8');
  const metadata = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'artifact-manifest.json'), 'utf8'));
  assert.equal(dependencyFingerprintFromPyproject(pyproject), metadata.compatibility.dependencyFingerprint);
  const changed = pyproject.replace('websockets>=12,<17', 'websockets>=13,<17');
  assert.throws(() => normalizeCompatibility(metadata, changed), /requires a manual reinstall/);
});

test('stable launcher fingerprint hashes exact file bytes while runtime-only changes do not affect it', (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'reachy-launcher-fingerprint-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const metadata = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'artifact-manifest.json'), 'utf8'));
  for (const relativePath of STABLE_LAUNCHER_FILES) {
    const target = path.join(temporary, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(SOURCE_ROOT, relativePath), target);
  }
  const original = launcherFingerprintFromSource(metadata, temporary);
  assert.equal(original, metadata.compatibility.launcherFingerprint);

  const runtimePath = path.join(temporary, 'src/reachy_homebrain/app.py');
  fs.writeFileSync(runtimePath, '# changed runtime only\n');
  assert.equal(launcherFingerprintFromSource(metadata, temporary), original);

  const stablePath = path.join(temporary, 'src/reachy_homebrain/main.py');
  fs.appendFileSync(stablePath, '\n# stable launcher mutation\n');
  const changed = launcherFingerprintFromSource(metadata, temporary);
  assert.notEqual(changed, original);
  const pyproject = fs.readFileSync(path.join(SOURCE_ROOT, 'pyproject.toml'), 'utf8');
  assert.throws(
    () => normalizeCompatibility(metadata, pyproject, changed),
    /stable launcher files changed and require a manual reinstall/
  );
});

test('server-built runtime manifest is accepted by the real Python PackageStager contract', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'reachy-python-manifest-contract-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const manifest = await packageService.buildManifest({ force: true, runtimeOnly: true });
  manifest.files = manifest.files.map((file) => ({ ...file, downloadUrl: `/files?path=${file.path}` }));
  const manifestPath = path.join(temporary, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const script = [
    'import json, sys',
    'from reachy_homebrain.package_stage import PackageStager',
    'manifest = json.load(open(sys.argv[1], encoding="utf-8"))',
    'stager = PackageStager.__new__(PackageStager)',
    'version, digest, entries = stager._validate_manifest(manifest)',
    'print(version, digest, len(entries))'
  ].join('\n');
  const output = execFileSync(resolveContractTestPython(), ['-c', script, manifestPath], {
    cwd: SOURCE_ROOT,
    env: {
      ...process.env,
      PYTHONPATH: path.join(SOURCE_ROOT, 'src')
    },
    encoding: 'utf8'
  }).trim();
  assert.equal(output, `${manifest.version} ${manifest.aggregateSha256} ${manifest.files.length}`);
});

test('package files are explicit allowlist entries and resolved with post-read digest verification', async () => {
  const manifest = await packageService.buildManifest({ force: true, runtimeOnly: true });
  assert.equal(manifest.files.every((file) => isSafeRelativePath(file.path)), true);
  assert.equal(manifest.files.some((file) => /(?:__pycache__|\.pytest_cache|\.git)/.test(file.path)), false);
  const source = await packageService.resolveFile('src/reachy_homebrain/app.py', { runtimeOnly: true });
  assert.equal(source.buffer.length, source.size);
  assert.equal(crypto.createHash('sha256').update(source.buffer).digest('hex'), source.sha256);
  await assert.rejects(packageService.resolveFile('../server/server.js'), (error) => error.status === 400);
  await assert.rejects(packageService.resolveFile('package-lock.json'), (error) => error.status === 400);
});

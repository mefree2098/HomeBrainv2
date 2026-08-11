const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const pythonExecutable = process.env.PYTHON_BIN || 'python3';
const pythonProbe = spawnSync(pythonExecutable, ['--version'], {
  encoding: 'utf8',
  timeout: 5000
});
const pythonAvailable = pythonProbe.status === 0;

const runPython = (script, args = [], options = {}) => spawnSync(
  pythonExecutable,
  [script, ...args],
  {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 1024 * 1024,
    timeout: 5000,
    ...options
  }
);

test('Insteon serial bridge refuses non-loopback listeners', { skip: !pythonAvailable }, () => {
  const script = path.join(repositoryRoot, 'server', 'scripts', 'insteon_serial_bridge.py');
  const result = runPython(script, ['--serial', '/dev/null', '--host', '0.0.0.0']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString(), /loopback/i);
});

test('Insteon serial bridge refuses paths outside /dev', { skip: !pythonAvailable }, () => {
  const script = path.join(repositoryRoot, 'server', 'scripts', 'insteon_serial_bridge.py');
  const result = runPython(script, ['--serial', '/tmp/not-a-serial-device']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString(), /beneath \/dev/i);
});

const createFeatureSidecarStubs = () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'homebrain-feature-sidecar-test-'));
  const packageRoot = path.join(fixtureRoot, 'openwakeword');
  fs.mkdirSync(packageRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(fixtureRoot, 'numpy.py'), [
    'class ndarray: pass',
    'class integer(int): pass',
    'float32 = object()',
    ''
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(fixtureRoot, 'onnxruntime.py'), [
    'class InferenceSession: pass',
    ''
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(packageRoot, '__init__.py'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(packageRoot, 'utils.py'), [
    'class AudioFeatures:',
    '    def __init__(self, device="cpu"): self.device = device',
    ''
  ].join('\n'), { mode: 0o600 });
  return fixtureRoot;
};

test('feature sidecar rejects oversized frame declarations before reading a body', { skip: !pythonAvailable }, (t) => {
  const fixtureRoot = createFeatureSidecarStubs();
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const script = path.join(repositoryRoot, 'remote-device', 'feature_infer.py');
  const config = Buffer.from(`${JSON.stringify({
    type: 'config',
    models: [],
    sampleRate: 999999,
    frameSamples: 999999,
    cooldownMs: 999999999
  })}\n`);
  const header = Buffer.alloc(8);
  header.write('AUD0', 0, 'ascii');
  header.writeUInt32LE(0xffffffff, 4);
  const result = runPython(script, [], {
    env: { ...process.env, PYTHONPATH: fixtureRoot },
    input: Buffer.concat([config, header])
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout.toString(), /"type": "ready"/);
  assert.match(result.stderr.toString(), /Audio frame length is invalid/);
});

test('feature sidecar bounds control-message size', { skip: !pythonAvailable }, (t) => {
  const fixtureRoot = createFeatureSidecarStubs();
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const script = path.join(repositoryRoot, 'remote-device', 'feature_infer.py');
  const result = runPython(script, [], {
    env: { ...process.env, PYTHONPATH: fixtureRoot },
    input: Buffer.from(`${'x'.repeat((64 * 1024) + 1)}\n`)
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.length, 0);
  assert.match(result.stderr.toString(), /Control message exceeds size limit/);
});

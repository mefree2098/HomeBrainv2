const test = require('node:test');
const assert = require('node:assert/strict');

const whisperService = require('../services/whisperService');

function snapshotMethods(service, names) {
  return Object.fromEntries(names.map((name) => [name, service[name]]));
}

function restoreMethods(service, snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    service[name] = value;
  }
}

function createConfig(overrides = {}) {
  const config = {
    activeModel: 'small',
    modelDirectory: '/tmp/homebrain-whisper-test-models',
    autoStart: true,
    serviceStatus: 'stopped',
    servicePid: null,
    serviceOwner: null,
    activeDevice: null,
    activeComputeType: null,
    lastError: null,
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
    },
    async setError(message) {
      this.lastError = { message, timestamp: new Date() };
    },
    ...overrides
  };
  return config;
}

test('Whisper CPU auto mode prefers int8 for realtime latency', (t) => {
  const originalIsJetson = whisperService._isJetson;
  t.after(() => { whisperService._isJetson = originalIsJetson; });
  whisperService._isJetson = () => false;
  assert.deepEqual(
    whisperService._resolveComputeCandidates('auto', 'cpu').slice(0, 2),
    ['int8', 'float32']
  );
});

test('Whisper Jetson CPU auto mode avoids a known-failing int8 startup attempt', (t) => {
  const originalIsJetson = whisperService._isJetson;
  t.after(() => { whisperService._isJetson = originalIsJetson; });
  whisperService._isJetson = () => true;
  assert.deepEqual(
    whisperService._resolveComputeCandidates('auto', 'cpu').slice(0, 2),
    ['float32', 'int8']
  );
});

test('Whisper start waits for readiness and falls back after CUDA preload failure', async (t) => {
  const originals = snapshotMethods(whisperService, [
    '_ensureInstalled',
    '_getConfig',
    '_resolveDeviceCandidates',
    '_resolveComputeCandidates',
    '_createRuntime'
  ]);
  t.after(() => {
    restoreMethods(whisperService, originals);
    whisperService.runtime = null;
  });

  const config = createConfig();
  const attempts = [];

  whisperService.runtime = null;
  whisperService._ensureInstalled = async () => {};
  whisperService._getConfig = async () => config;
  whisperService._resolveDeviceCandidates = () => ['cuda', 'cpu'];
  whisperService._resolveComputeCandidates = (_preference, device) => (
    device === 'cuda' ? ['float16'] : ['float32']
  );
  whisperService._createRuntime = (options) => {
    const runtime = {
      ...options,
      child: { pid: options.device === 'cpu' ? 4321 : 1234 },
      logBuffer: [],
      stoppedWith: null,
      async start() {
        attempts.push(`${options.device}:${options.computeType}`);
      },
      async waitUntilReady() {
        if (options.device === 'cuda') {
          this.logBuffer.push('Unable to load model: CUDA failed with error out of memory');
          throw new Error('Whisper runtime exited before reporting ready');
        }
        return {
          running: true,
          device: options.device,
          computeType: options.computeType,
          model: options.modelName
        };
      },
      async stop(signal) {
        this.stoppedWith = signal;
      }
    };
    return runtime;
  };

  const result = await whisperService.startService();

  assert.deepEqual(attempts, ['cuda:float16', 'cpu:float32']);
  assert.equal(result.device, 'cpu');
  assert.equal(result.computeType, 'float32');
  assert.equal(config.serviceStatus, 'running');
  assert.equal(config.servicePid, 4321);
  assert.equal(config.activeDevice, 'cpu');
  assert.equal(config.activeComputeType, 'float32');
});

test('Whisper runtime readiness clears stale runtime before auto-starting', async (t) => {
  const originals = snapshotMethods(whisperService, ['startService', '_getConfig']);
  t.after(() => {
    restoreMethods(whisperService, originals);
    whisperService.runtime = null;
  });

  const config = createConfig({
    serviceStatus: 'running',
    servicePid: 9999,
    serviceOwner: 'root',
    activeDevice: 'cuda',
    activeComputeType: 'float16'
  });
  let startedModel = null;

  whisperService.runtime = {
    async status() {
      return { running: false };
    }
  };
  whisperService.startService = async (modelName) => {
    startedModel = modelName;
    whisperService.runtime = {
      async status() {
        return { running: true, device: 'cpu', computeType: 'float32' };
      }
    };
    return { success: true };
  };
  whisperService._getConfig = async () => config;

  const resolvedConfig = await whisperService._ensureRuntimeReady(config);

  assert.equal(startedModel, 'small');
  assert.equal(resolvedConfig, config);
  assert.equal(config.serviceStatus, 'stopped');
  assert.equal(config.servicePid, null);
  assert.equal(config.serviceOwner, null);
  assert.equal(config.activeDevice, null);
  assert.equal(config.activeComputeType, null);
  assert.equal(config.saveCalls, 1);
});

test('Whisper CUDA failure detection includes out-of-memory startup logs', () => {
  assert.equal(
    whisperService._isCudaExecutionFailure(
      new Error('Whisper runtime is not running'),
      'Unable to load model: CUDA failed with error out of memory'
    ),
    true
  );
});

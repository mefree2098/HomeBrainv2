const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const axios = require('axios');

const ollamaServiceModule = require('../services/ollamaService');
const OllamaConfig = require('../models/OllamaConfig');
const Settings = require('../models/Settings');

const { OllamaService, _private } = ollamaServiceModule;

test('buildInstallScriptCommand disables Ollama auto-start when requested', () => {
  const service = new OllamaService();

  const command = service.buildInstallScriptCommand({ disableAutoStart: true });

  assert.equal(command.includes('export OLLAMA_NO_START=1'), true);
  assert.equal(command.endsWith('curl -fsSL https://ollama.com/install.sh | sh'), true);
});

test('privileged helper candidates prefer the installed system helper path', () => {
  const service = new OllamaService();

  const candidates = service.getOllamaPrivilegedHelperCandidates();
  const systemIndex = candidates.indexOf('/usr/local/lib/homebrain/ollama-host-control.sh');
  const repoIndex = candidates.findIndex((candidate) => candidate.endsWith('/scripts/ollama-host-control.sh'));

  assert.notEqual(systemIndex, -1);
  assert.notEqual(repoIndex, -1);
  assert.equal(systemIndex < repoIndex, true);
});

test('listOllamaProcesses detects HomeBrain-managed serve processes and macOS app processes', async () => {
  const service = new OllamaService();
  service.runShellCommand = async () => ({
    stdout: [
      '101 matt /usr/local/bin/ollama serve',
      '102 matt /Applications/Ollama.app/Contents/MacOS/Ollama',
      '103 matt node server.js'
    ].join('\n')
  });

  const processes = await service.listOllamaProcesses();

  assert.deepEqual(
    processes.map((processInfo) => processInfo.pid),
    process.platform === 'darwin' ? [101, 102] : [101]
  );
});

test('startService does not spawn a second process when an owned Ollama process already exists', async (t) => {
  const service = new OllamaService();
  const originalGetConfig = OllamaConfig.getConfig;
  const config = {
    servicePid: null,
    serviceOwner: null,
    serviceStatus: 'stopped',
    lastError: null,
    save: async () => {},
    setError: async () => {}
  };

  OllamaConfig.getConfig = async () => config;
  t.after(() => {
    OllamaConfig.getConfig = originalGetConfig;
  });

  service.syncApiUrl = () => {};
  service.resolveOllamaBinary = async () => '/usr/local/bin/ollama';
  service.checkServiceStatus = async () => ({ running: false, error: null });
  service.listOllamaProcesses = async () => [
    { pid: 4242, user: 'matt', command: '/usr/local/bin/ollama serve' }
  ];
  service.getCurrentUser = () => 'matt';
  service.waitForServiceReady = async () => true;

  let spawnCalled = false;
  service.spawnChildProcess = () => {
    spawnCalled = true;
    throw new Error('should not spawn a new process');
  };

  const result = await service.startService();

  assert.equal(result.success, true);
  assert.equal(spawnCalled, false);
  assert.equal(config.servicePid, 4242);
  assert.equal(config.serviceOwner, 'matt');
  assert.equal(config.serviceStatus, 'running');
});

test('install prefers the privileged helper flow when it is available', async (t) => {
  const service = new OllamaService();
  const originalGetConfig = OllamaConfig.getConfig;
  const config = {
    serviceStatus: 'stopped',
    save: async () => {},
    setError: async () => {},
    updateInstallation: async () => {}
  };

  OllamaConfig.getConfig = async () => config;
  t.after(() => {
    OllamaConfig.getConfig = originalGetConfig;
  });

  service.syncApiUrl = () => {};
  service.detectPrivilegeContext = async () => ({
    currentUser: 'homebrain',
    isRoot: false,
    hasSudoBinary: true,
    hasPasswordlessSudo: true,
    privilegedHelperPath: '/usr/local/lib/homebrain/ollama-host-control.sh'
  });
  service.runNonInteractiveSudoShellCommand = async () => {
    throw new Error('should not use shell sudo when helper exists');
  };
  service.runSudoShellCommandWithPassword = async () => {
    throw new Error('should not prompt for a password when helper sudo works');
  };
  service.checkInstallation = async () => ({ isInstalled: true, version: '0.7.5' });
  service.startService = async () => ({ success: true });

  let usedHelperCommand = null;
  service.runNonInteractiveSudoCommand = async (command) => {
    usedHelperCommand = command;
    return { stdout: 'ok', stderr: '' };
  };

  const result = await service.install();

  assert.equal(result.success, true);
  assert.equal(
    usedHelperCommand,
    service.buildPrivilegedHelperCommand('/usr/local/lib/homebrain/ollama-host-control.sh', 'install')
  );
});

test('stopSystemService prefers the privileged helper command when it is available', async () => {
  const service = new OllamaService();
  const commands = [];

  service.getCurrentUser = () => 'homebrain';
  service.resolveOllamaPrivilegedHelper = async () => '/usr/local/lib/homebrain/ollama-host-control.sh';
  service.runShellCommand = async (command) => {
    commands.push(command);
    if (command === "sudo -n '/usr/local/lib/homebrain/ollama-host-control.sh' 'stop-system'") {
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command: ${command}`);
  };

  const result = await service.stopSystemService();

  assert.equal(result.success, true);
  assert.equal(commands[0], "sudo -n '/usr/local/lib/homebrain/ollama-host-control.sh' 'stop-system'");
});

test('stopService falls back to the external system stop when the tracked pid is stale', async (t) => {
  const service = new OllamaService();
  const originalGetConfig = OllamaConfig.getConfig;
  const config = {
    servicePid: 1111,
    serviceOwner: 'matt',
    serviceStatus: 'running',
    lastError: null,
    save: async () => {},
    setError: async () => {}
  };

  OllamaConfig.getConfig = async () => config;
  t.after(() => {
    OllamaConfig.getConfig = originalGetConfig;
  });

  service.syncApiUrl = () => {};
  service.getCurrentUser = () => 'matt';
  service.listOllamaProcesses = async () => [
    { pid: 2222, user: 'ollama', command: '/usr/local/bin/ollama serve' }
  ];
  service.delay = async () => {};

  let terminateCalled = false;
  service.terminateManagedProcess = async () => {
    terminateCalled = true;
    return { success: true };
  };

  let stopSystemCalled = false;
  service.stopSystemService = async () => {
    stopSystemCalled = true;
    return { success: true, message: 'Service stopped using helper' };
  };

  service.finalizeStoppedState = async () => ({ success: true, message: 'Service stopped via system service' });

  const result = await service.stopService();

  assert.equal(result.success, true);
  assert.equal(stopSystemCalled, true);
  assert.equal(terminateCalled, false);
});

test('runNonInteractiveSudoCommand reports NoNewPrivileges with a repair hint', async () => {
  const service = new OllamaService();
  service.runShellCommand = async () => {
    const error = new Error('sudo failed');
    error.code = 1;
    error.stderr = 'sudo: The "no new privileges" flag is set, which prevents sudo from running as root.';
    throw error;
  };

  await assert.rejects(
    () => service.runNonInteractiveSudoCommand("'/usr/local/lib/homebrain/ollama-host-control.sh' 'probe'", 'test', 1000),
    /NoNewPrivileges=true/
  );
});

test('manual stop hint uses macOS-friendly guidance on Darwin', () => {
  const hint = _private.getManualOllamaStopHint('darwin');

  assert.equal(hint, 'pkill -x Ollama');
});

test('consumePullProgressStream tracks download percent from Ollama streaming events', async () => {
  const service = new OllamaService();

  service.beginModelPullStatus('qwen2.5:latest', { wasInstalled: false });

  const stream = Readable.from([
    '{"status":"pulling manifest"}\n',
    '{"status":"downloading","completed":50,"total":200,"digest":"sha256:test"}\n'
  ]);

  const finalEvent = await service.consumePullProgressStream('qwen2.5:latest', stream);
  const status = service.getModelPullStatus();

  assert.equal(finalEvent.status, 'downloading');
  assert.equal(status.active, true);
  assert.equal(status.modelName, 'qwen2.5:latest');
  assert.equal(status.phase, 'downloading');
  assert.equal(status.percent, 25);
  assert.equal(status.completed, 50);
  assert.equal(status.total, 200);
  assert.equal(status.digest, 'sha256:test');
});

test('buildAvailableModelVariantEntries expands multi-size model families into explicit tags', () => {
  const variants = _private.buildAvailableModelVariantEntries({
    name: 'gemma4',
    description: 'Gemma 4 family',
    parameterSizes: ['e2b', 'e4b', '26b', '31b'],
    parameterSize: 'e2b, e4b, 26b, 31b',
    size: 'e2b, e4b, 26b, 31b',
    capabilities: ['vision', 'tools'],
    nanoFit: true,
    smallestParameterB: 2
  });

  assert.deepEqual(
    variants.map((variant) => variant.name),
    ['gemma4:e2b', 'gemma4:e4b', 'gemma4:26b', 'gemma4:31b']
  );
  assert.deepEqual(
    variants.map((variant) => variant.parameterSize),
    ['e2b', 'e4b', '26b', '31b']
  );
  assert.deepEqual(
    variants.map((variant) => variant.nanoFit),
    [true, true, false, false]
  );
});

test('deleteModel starts Ollama and uses the API delete endpoint before falling back to CLI', async (t) => {
  const service = new OllamaService();
  const originalGetConfig = OllamaConfig.getConfig;
  const originalGetSettings = Settings.getSettings;
  const originalAxiosDelete = axios.delete;

  const config = {
    activeModel: 'gemma4:e2b',
    save: async () => {}
  };

  OllamaConfig.getConfig = async () => config;
  Settings.getSettings = async () => ({
    localLlmModel: '',
    homebrainLocalLlmModel: '',
    spamFilterLocalLlmModel: '',
    save: async () => {}
  });

  t.after(() => {
    OllamaConfig.getConfig = originalGetConfig;
    Settings.getSettings = originalGetSettings;
    axios.delete = originalAxiosDelete;
  });

  service.syncApiUrl = () => {};
  service.checkServiceStatus = async () => ({ running: false });

  let started = false;
  service.startService = async () => {
    started = true;
    return { success: true };
  };

  let deletedUrl = null;
  let deletedPayload = null;
  axios.delete = async (url, options = {}) => {
    deletedUrl = url;
    deletedPayload = options?.data || null;
    return { data: { status: 'success' } };
  };

  let listModelsCalled = false;
  service.listModels = async () => {
    listModelsCalled = true;
    return [];
  };

  const result = await service.deleteModel('gemma4:e2b');

  assert.equal(result.success, true);
  assert.equal(started, true);
  assert.equal(listModelsCalled, true);
  assert.equal(deletedUrl, `${service.apiUrl}/api/delete`);
  assert.deepEqual(deletedPayload, { model: 'gemma4:e2b' });
  assert.equal(config.activeModel, null);
});

test('chat starts Ollama before sending a request when the service is down', async (t) => {
  const service = new OllamaService();
  const originalGetConfig = OllamaConfig.getConfig;
  const originalAxiosPost = axios.post;

  const config = {
    addChatMessage: async () => {}
  };

  OllamaConfig.getConfig = async () => config;
  t.after(() => {
    OllamaConfig.getConfig = originalGetConfig;
    axios.post = originalAxiosPost;
  });

  service.syncApiUrl = () => {};
  service.checkServiceStatus = async () => ({ running: false, error: 'Service not running' });

  let started = false;
  service.startService = async () => {
    started = true;
    return { success: true };
  };

  axios.post = async () => ({
    data: {
      message: { content: 'Hello from Gemma' },
      done: true,
      total_duration: 1,
      load_duration: 2,
      prompt_eval_duration: 3,
      eval_duration: 4
    }
  });

  const result = await service.chat('gemma4:e4b', [{ role: 'user', content: 'Hi' }]);

  assert.equal(started, true);
  assert.equal(result.message, 'Hello from Gemma');
});

test('chat turns a generic 503 into an actionable Ollama diagnostic', async (t) => {
  const service = new OllamaService();
  const originalGetConfig = OllamaConfig.getConfig;
  const originalAxiosPost = axios.post;

  const config = {
    addChatMessage: async () => {}
  };

  OllamaConfig.getConfig = async () => config;
  t.after(() => {
    OllamaConfig.getConfig = originalGetConfig;
    axios.post = originalAxiosPost;
  });

  service.syncApiUrl = () => {};
  service.checkServiceStatus = async () => ({ running: true, error: null });
  service.getServiceLogs = async () => ({
    lines: [
      'Apr 04 12:00:00 annaai ollama[1234]: llama runner process has terminated: signal: killed'
    ]
  });

  axios.post = async () => {
    const error = new Error('Request failed with status code 503');
    error.response = {
      status: 503,
      data: {}
    };
    throw error;
  };

  await assert.rejects(
    () => service.chat('gemma4:e4b', [{ role: 'user', content: 'Hi' }]),
    (error) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /llama runner process has terminated: signal: killed/i);
      return true;
    }
  );
});

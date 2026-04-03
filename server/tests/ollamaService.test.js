const test = require('node:test');
const assert = require('node:assert/strict');

const ollamaServiceModule = require('../services/ollamaService');
const OllamaConfig = require('../models/OllamaConfig');

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

test('manual stop hint uses macOS-friendly guidance on Darwin', () => {
  const hint = _private.getManualOllamaStopHint('darwin');

  assert.equal(hint, 'pkill -x Ollama');
});

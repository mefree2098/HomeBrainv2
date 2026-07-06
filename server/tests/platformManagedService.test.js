const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { PlatformManagedServiceManager } = require('../services/platformManagedService');

function createSpawnStub(calls, handlers = {}) {
  return (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      const key = [command, ...args].join(' ');
      const handler = handlers[key] || handlers.default || (() => ({ code: 0, stdout: '', stderr: '' }));
      const result = handler(command, args);
      if (result.stdout) {
        child.stdout.emit('data', Buffer.from(result.stdout));
      }
      if (result.stderr) {
        child.stderr.emit('data', Buffer.from(result.stderr));
      }
      child.emit('close', result.code ?? 0);
    });
    return child;
  };
}

test('runSetupCommand uses the managed setup-services helper with sudo', async () => {
  const calls = [];
  const manager = new PlatformManagedServiceManager({
    projectRoot: '/Users/matt/Documents/HomeBrainv2',
    spawnProcess: createSpawnStub(calls)
  });

  await manager.runSetupCommand('update-platform-service', 'mqtt');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'sudo');
  assert.deepEqual(calls[0].args.slice(-2), ['update-platform-service', 'mqtt']);
  assert.equal(calls[0].args[0], '-n');
});

test('isDueForCheck honors weekly policy intervals', () => {
  const manager = new PlatformManagedServiceManager();
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  assert.equal(manager.isDueForCheck({
    lastCheckedAt: eightDaysAgo,
    policy: { autoCheckEnabled: true, checkIntervalDays: 7 }
  }), true);
  assert.equal(manager.isDueForCheck({
    lastCheckedAt: yesterday,
    policy: { autoCheckEnabled: true, checkIntervalDays: 7 }
  }), false);
  assert.equal(manager.isDueForCheck({
    lastCheckedAt: eightDaysAgo,
    policy: { autoCheckEnabled: false, checkIntervalDays: 7 }
  }), false);
});

test('normalizeRecord marks auto updates eligible only after the stability delay', () => {
  const manager = new PlatformManagedServiceManager();
  const definition = manager.getDefinitions().find((entry) => entry.serviceId === 'mqtt');
  const eligibleRecord = {
    serviceId: 'mqtt',
    updateAvailable: true,
    eligibleForAutoUpdateAt: new Date(Date.now() - 1000),
    policy: { autoUpdateEnabled: true, autoCheckEnabled: true, checkIntervalDays: 7, stabilityDelayDays: 30 }
  };
  const waitingRecord = {
    serviceId: 'mqtt',
    updateAvailable: true,
    eligibleForAutoUpdateAt: new Date(Date.now() + 1000),
    policy: { autoUpdateEnabled: true, autoCheckEnabled: true, checkIntervalDays: 7, stabilityDelayDays: 30 }
  };

  assert.equal(manager.normalizeRecord(eligibleRecord, definition).autoUpdateEligible, true);
  assert.equal(manager.normalizeRecord(waitingRecord, definition).autoUpdateEligible, false);
});

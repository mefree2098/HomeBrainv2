const test = require('node:test');
const assert = require('node:assert/strict');

const automationSchedulerService = require('../services/automationSchedulerService');
const deviceUpdateEmitter = require('../services/deviceUpdateEmitter');
const harmonyService = require('../services/harmonyService');
const insteonService = require('../services/insteonService');
const { PlatformUpdateMonitorService } = require('../services/platformUpdateMonitorService');

test('platform update monitor starts platform listeners and schedules automation evaluation from device updates', async (t) => {
  const service = new PlatformUpdateMonitorService();
  const originalTick = automationSchedulerService.tick;
  const originalStartInsteonMonitoring = insteonService.startRuntimeMonitoring;
  const originalStopInsteonMonitoring = insteonService.stopRuntimeMonitoring;
  const originalStartHarmonyMonitoring = harmonyService.startBackgroundMonitoring;
  const originalStopHarmonyMonitoring = harmonyService.stopBackgroundMonitoring;

  const observedTicks = [];
  let insteonStarted = 0;
  let insteonStopped = 0;
  let harmonyStarted = 0;
  let harmonyStopped = 0;

  t.after(async () => {
    automationSchedulerService.tick = originalTick;
    insteonService.startRuntimeMonitoring = originalStartInsteonMonitoring;
    insteonService.stopRuntimeMonitoring = originalStopInsteonMonitoring;
    harmonyService.startBackgroundMonitoring = originalStartHarmonyMonitoring;
    harmonyService.stopBackgroundMonitoring = originalStopHarmonyMonitoring;
    await service.stop();
  });

  automationSchedulerService.tick = async (context) => {
    observedTicks.push(context);
  };
  insteonService.startRuntimeMonitoring = () => {
    insteonStarted += 1;
  };
  insteonService.stopRuntimeMonitoring = () => {
    insteonStopped += 1;
  };
  harmonyService.startBackgroundMonitoring = () => {
    harmonyStarted += 1;
  };
  harmonyService.stopBackgroundMonitoring = () => {
    harmonyStopped += 1;
  };

  service.automationDebounceMs = 5;
  service.start();

  deviceUpdateEmitter.emit('devices:update', [
    { _id: 'device-1' },
    { id: 'device-2' }
  ]);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await service.stop();

  assert.equal(insteonStarted, 1);
  assert.equal(insteonStopped, 1);
  assert.equal(harmonyStarted, 1);
  assert.equal(harmonyStopped, 1);
  assert.equal(observedTicks.length, 1);
  assert.deepEqual(observedTicks[0], {
    source: 'device_update',
    reason: 'realtime-device-update',
    deviceIds: ['device-1', 'device-2']
  });
});

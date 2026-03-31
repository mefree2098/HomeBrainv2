const test = require('node:test');
const assert = require('node:assert/strict');

const SecurityAlarm = require('../models/SecurityAlarm');
const automationSchedulerService = require('../services/automationSchedulerService');

test('shouldRunAutomation triggers on security alarm state changes that match configured states', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  let alarmState = 'disarmed';

  SecurityAlarm.getMainAlarm = async () => ({ alarmState });
  automationSchedulerService.triggerStateCache.clear();

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    automationSchedulerService.triggerStateCache.clear();
  });

  const automation = {
    _id: { toString: () => 'automation-1' },
    enabled: true,
    cooldown: 0,
    trigger: {
      type: 'security_alarm_status',
      conditions: {
        states: ['armedStay', 'armedAway']
      }
    }
  };

  assert.equal(await automationSchedulerService.shouldRunAutomation(automation, new Date()), false);

  alarmState = 'armedStay';
  assert.equal(await automationSchedulerService.shouldRunAutomation(automation, new Date()), true);
  assert.equal(await automationSchedulerService.shouldRunAutomation(automation, new Date()), false);

  alarmState = 'armedAway';
  assert.equal(await automationSchedulerService.shouldRunAutomation(automation, new Date()), true);

  alarmState = 'disarmed';
  assert.equal(await automationSchedulerService.shouldRunAutomation(automation, new Date()), false);
});

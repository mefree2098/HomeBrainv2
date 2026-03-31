const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Device = require('../models/Device');
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

test('device_state triggers capture the triggering device context for later actions', async (t) => {
  const automationId = new mongoose.Types.ObjectId().toString();
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  let deviceStatus = false;

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Guest Bathroom Fan',
      room: 'Guest Bathroom',
      status: deviceStatus
    })
  });

  automationSchedulerService.triggerStateCache.clear();
  automationSchedulerService.pendingTriggerContexts.clear();

  t.after(() => {
    Device.findById = originalFindById;
    automationSchedulerService.triggerStateCache.clear();
    automationSchedulerService.pendingTriggerContexts.clear();
  });

  const automation = {
    _id: { toString: () => automationId },
    enabled: true,
    cooldown: 0,
    trigger: {
      type: 'device_state',
      conditions: {
        deviceId,
        property: 'status',
        operator: 'eq',
        value: true,
        state: 'on'
      }
    }
  };

  assert.equal(await automationSchedulerService.shouldRunAutomation(automation, new Date()), false);

  deviceStatus = true;
  assert.equal(await automationSchedulerService.shouldRunAutomation(automation, new Date()), true);

  const context = automationSchedulerService.consumePendingTriggerContext(automationId);
  assert.deepEqual(context, {
    triggeringDeviceId: deviceId,
    triggeringDeviceName: 'Guest Bathroom Fan',
    triggeringDeviceRoom: 'Guest Bathroom',
    triggerProperty: 'status',
    triggerValue: true
  });
});

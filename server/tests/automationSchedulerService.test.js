const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Device = require('../models/Device');
const SecurityAlarm = require('../models/SecurityAlarm');
const automationSchedulerService = require('../services/automationSchedulerService');
const deviceService = require('../services/deviceService');
const weatherService = require('../services/weatherService');

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

test('device_state triggers can evaluate SmartThings power thresholds with hold times', async (t) => {
  const automationId = new mongoose.Types.ObjectId().toString();
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalIsSmartThingsDevice = deviceService.isSmartThingsDevice;
  const originalPollSmartThingsState = deviceService.pollSmartThingsState;
  let currentPower = 18;

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Dryer Monitor',
      room: 'Laundry',
      status: true,
      properties: {
        source: 'smartthings',
        smartThingsDeviceId: 'st-dryer-1',
        smartThingsAttributeValues: {
          powerMeter: {
            power: currentPower
          }
        }
      }
    })
  });

  deviceService.isSmartThingsDevice = () => true;
  deviceService.pollSmartThingsState = async () => ({
    'properties.smartThingsAttributeValues.powerMeter.power': currentPower
  });

  automationSchedulerService.triggerStateCache.clear();
  automationSchedulerService.pendingTriggerContexts.clear();

  t.after(() => {
    Device.findById = originalFindById;
    deviceService.isSmartThingsDevice = originalIsSmartThingsDevice;
    deviceService.pollSmartThingsState = originalPollSmartThingsState;
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
        property: 'smartThingsAttributeValues.powerMeter.power',
        operator: 'lt',
        value: 5,
        forSeconds: 120
      }
    }
  };

  assert.equal(await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-03-31T10:00:00.000Z')), false);

  currentPower = 3;
  assert.equal(await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-03-31T10:01:00.000Z')), false);
  assert.equal(await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-03-31T10:03:01.000Z')), true);

  const context = automationSchedulerService.consumePendingTriggerContext(automationId);
  assert.deepEqual(context, {
    triggeringDeviceId: deviceId,
    triggeringDeviceName: 'Dryer Monitor',
    triggeringDeviceRoom: 'Laundry',
    triggerProperty: 'smartThingsAttributeValues.powerMeter.power',
    triggerValue: 3,
    triggerHoldSeconds: 120
  });
});

test('schedule triggers can fire at sunset using weather-derived solar time', async (t) => {
  const originalFetchDashboardWeather = weatherService.fetchDashboardWeather;
  const automationId = new mongoose.Types.ObjectId().toString();

  weatherService.fetchDashboardWeather = async () => ({
    location: {
      timezone: 'UTC'
    },
    today: {
      sunrise: '2026-03-31T06:14',
      sunset: '2026-03-31T18:40'
    }
  });

  automationSchedulerService.pendingTriggerContexts.clear();
  automationSchedulerService.solarContextCache = {
    key: null,
    value: null,
    promise: null
  };
  automationSchedulerService.lastSolarWarningAt = 0;

  t.after(() => {
    weatherService.fetchDashboardWeather = originalFetchDashboardWeather;
    automationSchedulerService.pendingTriggerContexts.clear();
    automationSchedulerService.solarContextCache = {
      key: null,
      value: null,
      promise: null
    };
    automationSchedulerService.lastSolarWarningAt = 0;
  });

  const automation = {
    _id: { toString: () => automationId },
    name: 'Exterior lights at sunset',
    enabled: true,
    cooldown: 0,
    trigger: {
      type: 'schedule',
      conditions: {
        event: 'sunset',
        offset: 15
      }
    }
  };

  assert.equal(await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-03-31T18:54:00Z')), false);
  assert.equal(await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-03-31T18:55:00Z')), true);

  const context = automationSchedulerService.consumePendingTriggerContext(automationId);
  assert.equal(context.triggeringScheduleEvent, 'sunset');
  assert.equal(context.triggeringScheduleOffsetMinutes, 15);
  assert.match(context.triggeringScheduleTime, /^2026-03-31T18:55:00\.000Z$/);
});

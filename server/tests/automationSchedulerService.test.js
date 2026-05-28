const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Automation = require('../models/Automation');
const AutomationHistory = require('../models/AutomationHistory');
const Device = require('../models/Device');
const SecurityAlarm = require('../models/SecurityAlarm');
const automationSchedulerService = require('../services/automationSchedulerService');
const automationRuntimeService = require('../services/automationRuntimeService');
const automationService = require('../services/automationService');
const deviceService = require('../services/deviceService');
const weatherService = require('../services/weatherService');
const {
  clearWorkflowStopRequest,
  resolveWorkflowStopRequest
} = require('../services/workflowExecutionService');

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

test('security alarm trigger evaluation publishes runtime activity when invoked from an alarm update', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalRecordEvaluation = automationRuntimeService.recordSchedulerSecurityAlarmEvaluation;
  const evaluations = [];

  SecurityAlarm.getMainAlarm = async () => ({ alarmState: 'armedStay' });
  automationRuntimeService.recordSchedulerSecurityAlarmEvaluation = async (payload) => {
    evaluations.push(payload);
  };
  automationSchedulerService.triggerStateCache.clear();

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    automationRuntimeService.recordSchedulerSecurityAlarmEvaluation = originalRecordEvaluation;
    automationSchedulerService.triggerStateCache.clear();
  });

  const automation = {
    _id: { toString: () => 'automation-2' },
    name: 'Arm Stay Shutdown',
    workflowId: { toString: () => 'workflow-1' },
    enabled: true,
    cooldown: 0,
    trigger: {
      type: 'security_alarm_status',
      conditions: {
        states: ['armedStay']
      }
    }
  };

  const shouldRun = await automationSchedulerService.shouldRunAutomation(
    automation,
    new Date(),
    { source: 'security_alarm', reason: 'alarm state changed' }
  );

  assert.equal(shouldRun, true);
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].automationName, 'Arm Stay Shutdown');
  assert.equal(evaluations[0].currentState, 'armedStay');
  assert.equal(evaluations[0].matchedState, 'armedStay');
  assert.equal(evaluations[0].willRun, true);
  assert.equal(evaluations[0].reason, 'alarm state changed');
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

test('device_state triggers prime current truthy state on scheduler startup without firing immediately', async (t) => {
  const automationId = new mongoose.Types.ObjectId().toString();
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  let deviceStatus = true;

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Theater Bathroom Fan',
      room: 'Theater Bathroom',
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
        value: true
      }
    }
  };

  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-03-31T23:10:00.000Z'), { source: 'scheduler_startup' }),
    false
  );
  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-03-31T23:11:00.000Z'), { source: 'scheduler_interval' }),
    false
  );

  deviceStatus = false;
  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-03-31T23:12:00.000Z'), { source: 'scheduler_interval' }),
    false
  );

  deviceStatus = true;
  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-03-31T23:13:00.000Z'), { source: 'scheduler_interval' }),
    true
  );
});

test('device_state trigger reset auto-cancels running workflow executions even during cooldown', async (t) => {
  const automationId = new mongoose.Types.ObjectId();
  const workflowId = new mongoose.Types.ObjectId();
  const historyId = new mongoose.Types.ObjectId();
  const deviceId = new mongoose.Types.ObjectId().toString();
  const correlationId = 'auto-cancel-reset-correlation';

  const originalFindById = Device.findById;
  const originalAutomationHistoryFind = AutomationHistory.find;
  const originalAutomationHistoryFindById = AutomationHistory.findById;
  const originalIsExecutionActive = automationService.isExecutionActive;
  const originalRecordExecutionStopRequested = automationRuntimeService.recordExecutionStopRequested;
  const originalRecordExecutionCompleted = automationRuntimeService.recordExecutionCompleted;

  let deviceStatus = false;
  let historyQuery = null;
  const stopRequests = [];

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Guest Bathroom Fan',
      room: 'Guest Bathroom',
      status: deviceStatus
    })
  });
  AutomationHistory.find = async (query) => {
    historyQuery = query;
    return [{
      _id: historyId,
      automationId,
      automationName: 'Guest Bathroom Fan Countdown',
      workflowId,
      workflowName: 'Guest Bathroom Fan Countdown',
      triggerType: 'device_state',
      triggerSource: 'scheduler',
      triggerContext: {
        triggeringDeviceId: deviceId
      },
      status: 'running',
      correlationId,
      totalActions: 2,
      successfulActions: 0,
      failedActions: 0
    }];
  };
  AutomationHistory.findById = async () => {
    throw new Error('findById should not be needed for active in-memory executions');
  };
  automationService.isExecutionActive = () => true;
  automationRuntimeService.recordExecutionStopRequested = async (context, payload) => {
    stopRequests.push({ context, payload });
  };
  automationRuntimeService.recordExecutionCompleted = async () => {
    throw new Error('active executions should stop themselves through the stop request');
  };

  automationSchedulerService.triggerStateCache.clear();
  automationSchedulerService.pendingTriggerContexts.clear();

  t.after(() => {
    Device.findById = originalFindById;
    AutomationHistory.find = originalAutomationHistoryFind;
    AutomationHistory.findById = originalAutomationHistoryFindById;
    automationService.isExecutionActive = originalIsExecutionActive;
    automationRuntimeService.recordExecutionStopRequested = originalRecordExecutionStopRequested;
    automationRuntimeService.recordExecutionCompleted = originalRecordExecutionCompleted;
    clearWorkflowStopRequest({
      historyId: historyId.toString(),
      correlationId,
      workflowId: workflowId.toString()
    });
    automationSchedulerService.triggerStateCache.clear();
    automationSchedulerService.pendingTriggerContexts.clear();
  });

  const automation = {
    _id: automationId,
    name: 'Guest Bathroom Fan Countdown',
    workflowId,
    enabled: true,
    cooldown: 30,
    trigger: {
      type: 'device_state',
      conditions: {
        deviceId,
        property: 'status',
        operator: 'eq',
        value: true
      }
    }
  };

  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-04-21T10:00:00.000Z')),
    false
  );

  deviceStatus = true;
  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-04-21T10:01:00.000Z')),
    true
  );

  automation.lastRun = new Date('2026-04-21T10:01:01.000Z');
  deviceStatus = false;
  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-04-21T10:01:30.000Z')),
    false
  );

  assert.equal(stopRequests.length, 1);
  assert.deepEqual(historyQuery, {
    automationId,
    workflowId,
    status: 'running'
  });
  assert.equal(stopRequests[0].context.historyId, historyId.toString());
  assert.equal(stopRequests[0].context.workflowId, workflowId.toString());
  assert.equal(stopRequests[0].context.triggerContext.triggeringDeviceId, deviceId);
  assert.equal(stopRequests[0].context.triggerContext.triggerValue, false);
  assert.equal(stopRequests[0].context.triggerContext.triggerPreviousValue, true);
  assert.equal(stopRequests[0].payload.requestedBy, 'automation scheduler');
  assert.equal(stopRequests[0].payload.reason, 'trigger_state_changed');
  assert.equal(
    resolveWorkflowStopRequest({
      historyId: historyId.toString(),
      correlationId,
      workflowId: workflowId.toString()
    }),
    true
  );
});

test('device_state cooldown does not consume a true edge before it can run', async (t) => {
  const automationId = new mongoose.Types.ObjectId().toString();
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  let deviceStatus = false;

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Garage Fan',
      room: 'Garage',
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
    name: 'Garage Fan Countdown',
    enabled: true,
    cooldown: 30,
    lastRun: new Date('2026-04-21T10:00:00.000Z'),
    trigger: {
      type: 'device_state',
      conditions: {
        deviceId,
        property: 'status',
        operator: 'eq',
        value: true
      }
    }
  };

  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-04-21T10:00:30.000Z')),
    false
  );

  deviceStatus = true;
  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-04-21T10:01:00.000Z')),
    false
  );
  assert.deepEqual(automationSchedulerService.consumePendingTriggerContext(automationId), {});

  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date('2026-04-21T10:31:00.000Z')),
    true
  );
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

test('device_state triggers evaluate direct-radio sensor and battery feature paths', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  let currentDevice = {
    _id: deviceId,
    name: 'Vault Door Sensor',
    room: 'Vault',
    status: false,
    properties: {
      source: 'homebrain-zigbee',
      supportsBattery: true,
      supportsContactSensor: true,
      supportsTemperatureSensor: true,
      directRadioState: {
        batteryLevel: 7,
        contactOpen: true,
        temperatureF: 82.4
      }
    }
  };

  Device.findById = () => ({
    lean: async () => currentDevice
  });

  automationSchedulerService.triggerStateCache.clear();
  automationSchedulerService.pendingTriggerContexts.clear();

  t.after(() => {
    Device.findById = originalFindById;
    automationSchedulerService.triggerStateCache.clear();
    automationSchedulerService.pendingTriggerContexts.clear();
  });

  const buildAutomation = (id, property, operator, value) => ({
    _id: { toString: () => id },
    enabled: true,
    cooldown: 0,
    trigger: {
      type: 'device_state',
      conditions: {
        deviceId,
        property,
        operator,
        value
      }
    }
  });

  assert.equal(
    await automationSchedulerService.shouldRunAutomation(
      buildAutomation('battery-low', 'directRadioState.batteryLevel', 'lt', 10),
      new Date('2026-04-02T10:00:00.000Z')
    ),
    true
  );
  assert.deepEqual(automationSchedulerService.consumePendingTriggerContext('battery-low'), {
    triggeringDeviceId: deviceId,
    triggeringDeviceName: 'Vault Door Sensor',
    triggeringDeviceRoom: 'Vault',
    triggerProperty: 'directRadioState.batteryLevel',
    triggerValue: 7
  });

  assert.equal(
    await automationSchedulerService.shouldRunAutomation(
      buildAutomation('temperature-high', 'directRadioState.temperatureF', 'gt', 80),
      new Date('2026-04-02T10:00:01.000Z')
    ),
    true
  );

  assert.equal(
    await automationSchedulerService.shouldRunAutomation(
      buildAutomation('contact-open', 'directRadioState.contactOpen', 'eq', true),
      new Date('2026-04-02T10:00:02.000Z')
    ),
    true
  );

  currentDevice = {
    ...currentDevice,
    properties: {
      ...currentDevice.properties,
      directRadioState: {
        contactOpen: false
      }
    }
  };

  assert.equal(
    await automationSchedulerService.shouldRunAutomation(
      buildAutomation('missing-battery', 'directRadioState.batteryLevel', 'lt', 10),
      new Date('2026-04-02T10:00:03.000Z')
    ),
    false
  );
  assert.deepEqual(automationSchedulerService.consumePendingTriggerContext('missing-battery'), {});
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

test('solar schedule triggers catch up within the scheduler grace window and dedupe the target minute', async (t) => {
  const originalFetchDashboardWeather = weatherService.fetchDashboardWeather;
  const originalScheduleGraceMs = automationSchedulerService.scheduleGraceMs;
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
  automationSchedulerService.recentRuns.clear();
  automationSchedulerService.scheduleGraceMs = 5 * 60 * 1000;
  automationSchedulerService.solarContextCache = {
    key: null,
    value: null,
    promise: null
  };

  t.after(() => {
    weatherService.fetchDashboardWeather = originalFetchDashboardWeather;
    automationSchedulerService.pendingTriggerContexts.clear();
    automationSchedulerService.recentRuns.clear();
    automationSchedulerService.scheduleGraceMs = originalScheduleGraceMs;
    automationSchedulerService.solarContextCache = {
      key: null,
      value: null,
      promise: null
    };
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

  assert.equal(await automationSchedulerService.shouldRunAutomation(
    automation,
    new Date('2026-03-31T18:56:30Z')
  ), true);

  const context = automationSchedulerService.consumePendingTriggerContext(automationId);
  assert.match(context.triggeringScheduleTime, /^2026-03-31T18:55:00\.000Z$/);
  assert.equal(context.triggeringScheduleLatenessMs, 90000);
  assert.equal(
    automationSchedulerService.isAlreadyExecutedForCurrentMinute(
      automationId,
      'schedule',
      new Date('2026-03-31T18:56:30Z'),
      context
    ),
    false
  );
  assert.equal(
    automationSchedulerService.isAlreadyExecutedForCurrentMinute(
      automationId,
      'schedule',
      new Date('2026-03-31T18:57:00Z'),
      context
    ),
    true
  );

  automation.lastRun = new Date('2026-03-31T18:56:45Z');
  assert.equal(await automationSchedulerService.shouldRunAutomation(
    automation,
    new Date('2026-03-31T18:57:30Z')
  ), false);
});

test('security alarm triggers prime matched startup state without rerunning until the state changes again', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  let alarmState = 'armedStay';

  SecurityAlarm.getMainAlarm = async () => ({ alarmState });
  automationSchedulerService.triggerStateCache.clear();

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    automationSchedulerService.triggerStateCache.clear();
  });

  const automation = {
    _id: { toString: () => 'automation-startup-prime' },
    enabled: true,
    cooldown: 0,
    trigger: {
      type: 'security_alarm_status',
      conditions: {
        states: ['armedStay']
      }
    }
  };

  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date(), { source: 'scheduler_startup' }),
    false
  );
  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date(), { source: 'scheduler_interval' }),
    false
  );

  alarmState = 'disarmed';
  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date(), { source: 'scheduler_interval' }),
    false
  );

  alarmState = 'armedStay';
  assert.equal(
    await automationSchedulerService.shouldRunAutomation(automation, new Date(), { source: 'scheduler_interval' }),
    true
  );
});

test('tick queues a highest-priority follow-up when an evaluation is already running', async (t) => {
  const originalRunning = automationSchedulerService.running;
  const originalPendingTickContext = automationSchedulerService.pendingTickContext;

  automationSchedulerService.running = true;
  automationSchedulerService.pendingTickContext = null;

  t.after(() => {
    automationSchedulerService.running = originalRunning;
    automationSchedulerService.pendingTickContext = originalPendingTickContext;
  });

  await automationSchedulerService.tick({ source: 'scheduler_interval' });
  assert.equal(automationSchedulerService.pendingTickContext.source, 'scheduler_interval');

  await automationSchedulerService.tick({ source: 'device_update', reason: 'realtime-device-update' });
  assert.equal(automationSchedulerService.pendingTickContext.source, 'device_update');

  await automationSchedulerService.tick({ source: 'security_alarm', reason: 'alarm-state-change' });
  assert.equal(automationSchedulerService.pendingTickContext.source, 'security_alarm');

  await automationSchedulerService.tick({ source: 'scheduler_interval' });
  assert.equal(automationSchedulerService.pendingTickContext.source, 'security_alarm');
});

test('tick launches matching automations without waiting for long-running executions to finish', async (t) => {
  const originalFind = Automation.find;
  const originalShouldRunAutomation = automationSchedulerService.shouldRunAutomation;
  const originalConsumePendingTriggerContext = automationSchedulerService.consumePendingTriggerContext;
  const originalIsAlreadyExecutedForCurrentMinute = automationSchedulerService.isAlreadyExecutedForCurrentMinute;
  const originalExecuteAutomation = automationService.executeAutomation;
  const originalResumeRunningExecutions = automationService.resumeRunningExecutions;
  const originalLastResumeWatchdogAt = automationSchedulerService.lastResumeWatchdogAt;

  const launched = [];
  const pendingResolves = [];
  const resumeCalls = [];

  Automation.find = () => ({
    lean: async () => ([
      {
        _id: { toString: () => 'automation-1' },
        name: 'Bathroom fan auto off',
        enabled: true,
        trigger: { type: 'device_state' }
      },
      {
        _id: { toString: () => 'automation-2' },
        name: 'Arm stay shutdown',
        enabled: true,
        trigger: { type: 'security_alarm_status' }
      }
    ])
  });

  automationSchedulerService.shouldRunAutomation = async () => true;
  automationSchedulerService.consumePendingTriggerContext = () => ({});
  automationSchedulerService.isAlreadyExecutedForCurrentMinute = () => false;
  automationSchedulerService.lastResumeWatchdogAt = 0;
  automationService.resumeRunningExecutions = async (options = {}) => {
    resumeCalls.push(options);
    return { launchedCount: 0 };
  };
  automationService.executeAutomation = async (id) => {
    launched.push(id);
    return new Promise((resolve) => {
      pendingResolves.push(resolve);
    });
  };

  t.after(() => {
    Automation.find = originalFind;
    automationSchedulerService.shouldRunAutomation = originalShouldRunAutomation;
    automationSchedulerService.consumePendingTriggerContext = originalConsumePendingTriggerContext;
    automationSchedulerService.isAlreadyExecutedForCurrentMinute = originalIsAlreadyExecutedForCurrentMinute;
    automationService.executeAutomation = originalExecuteAutomation;
    automationService.resumeRunningExecutions = originalResumeRunningExecutions;
    automationSchedulerService.lastResumeWatchdogAt = originalLastResumeWatchdogAt;
    pendingResolves.splice(0).forEach((resolve) => resolve({ success: true }));
  });

  await automationSchedulerService.tick({ source: 'security_alarm', reason: 'test' });

  assert.equal(resumeCalls.length, 1);
  assert.equal(resumeCalls[0].reason, 'scheduler_watchdog');
  assert.deepEqual(launched, ['automation-1', 'automation-2']);
});

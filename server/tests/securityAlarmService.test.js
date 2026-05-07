const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
const SecurityAlarm = require('../models/SecurityAlarm');
const deviceService = require('../services/deviceService');
const deviceUpdateEmitter = require('../services/deviceUpdateEmitter');
const securityAlarmService = require('../services/securityAlarmService');
const smartThingsService = require('../services/smartThingsService');

test('getAlarmStatus returns security sensors and door lock summaries', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalEnsureSmartThingsState = deviceService.ensureSmartThingsState;
  const originalIsSmartThingsConfiguredForSthm = securityAlarmService.isSmartThingsConfiguredForSthm;

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    Device.find = originalDeviceFind;
    deviceService.ensureSmartThingsState = originalEnsureSmartThingsState;
    securityAlarmService.isSmartThingsConfiguredForSthm = originalIsSmartThingsConfiguredForSthm;
  });

  const now = new Date('2026-03-30T12:00:00.000Z');
  const alarm = {
    alarmState: 'disarmed',
    lastArmed: null,
    lastDisarmed: now,
    lastTriggered: null,
    armedBy: null,
    disarmedBy: 'user-1',
    zones: [
      {
        name: 'Front Door',
        deviceId: 'device-1',
        deviceType: 'doorWindow',
        enabled: true,
        bypassed: false
      },
      {
        name: 'Hall Motion',
        deviceId: 'device-2',
        deviceType: 'motion',
        enabled: true,
        bypassed: true
      }
    ],
    isOnline: true,
    lastSyncWithSmartThings: now,
    batteryLevel: null,
    signalStrength: null,
    save: async function save() {
      return this;
    }
  };

  SecurityAlarm.getMainAlarm = async () => alarm;
  securityAlarmService.isSmartThingsConfiguredForSthm = async () => false;
  deviceService.ensureSmartThingsState = async () => {};
  Device.find = () => ({
    lean: async () => ([
      {
        _id: 'device-1',
        name: 'Front Door Sensor',
        type: 'sensor',
        room: 'Entry',
        status: true,
        isOnline: true,
        lastSeen: now,
        properties: {
          smartThingsCapabilities: ['contactSensor'],
          smartThingsBatteryLevel: 12
        }
      },
      {
        _id: 'device-2',
        name: 'Hall Motion Sensor',
        type: 'sensor',
        room: 'Hallway',
        status: false,
        isOnline: false,
        lastSeen: now,
        properties: {
          smartThingsCapabilities: ['motionSensor'],
          smartThingsBatteryLevel: 78
        }
      },
      {
        _id: 'device-3',
        name: 'Basement Leak Sensor',
        type: 'sensor',
        room: 'Basement',
        status: false,
        isOnline: true,
        lastSeen: now,
        properties: {
          smartThingsCapabilities: ['waterSensor'],
          smartThingsBatteryLevel: 55
        }
      },
      {
        _id: 'device-4',
        name: 'Front Door Lock',
        type: 'lock',
        room: 'Entry',
        status: false,
        isOnline: true,
        lastSeen: now,
        properties: {
          smartThingsDeviceId: 'smartthings-lock-1'
        }
      },
      {
        _id: 'device-5',
        name: 'Garage Entry Lock',
        type: 'lock',
        room: 'Garage',
        status: true,
        isOnline: true,
        lastSeen: now,
        properties: {
          smartThingsDeviceId: 'smartthings-lock-2'
        }
      }
    ])
  });

  const status = await securityAlarmService.getAlarmStatus();

  assert.equal(status.zoneCount, 2);
  assert.equal(status.activeZones, 1);
  assert.equal(status.sensorCount, 3);
  assert.equal(status.activeSensorCount, 1);
  assert.equal(status.monitoredSensorCount, 1);
  assert.equal(status.offlineSensorCount, 1);
  assert.equal(status.lowBatterySensorCount, 1);
  assert.equal(status.attentionSensorCount, 2);
  assert.equal(status.doorLockCount, 2);
  assert.equal(status.lockedDoorCount, 1);
  assert.equal(status.unlockedDoorCount, 1);

  const frontDoor = status.sensors.find((sensor) => sensor.deviceId === 'device-1');
  assert.ok(frontDoor);
  assert.equal(frontDoor.sensorType, 'doorWindow');
  assert.equal(frontDoor.stateLabel, 'Open');
  assert.equal(frontDoor.monitorState, 'Monitored');
  assert.equal(frontDoor.batteryState, 'low');

  const hallMotion = status.sensors.find((sensor) => sensor.deviceId === 'device-2');
  assert.ok(hallMotion);
  assert.equal(hallMotion.monitorState, 'Bypassed');
  assert.equal(hallMotion.isOnline, false);

  const leakSensor = status.sensors.find((sensor) => sensor.deviceId === 'device-3');
  assert.ok(leakSensor);
  assert.equal(leakSensor.monitorState, 'Available');
  assert.equal(leakSensor.sensorType, 'flood');

  const frontDoorLock = status.doorLocks.find((lock) => lock.deviceId === 'device-4');
  assert.ok(frontDoorLock);
  assert.equal(frontDoorLock.stateLabel, 'Unlocked');
  assert.equal(frontDoorLock.isLocked, false);
  assert.equal(frontDoorLock.smartThingsDeviceId, 'smartthings-lock-1');

  const garageLock = status.doorLocks.find((lock) => lock.deviceId === 'device-5');
  assert.ok(garageLock);
  assert.equal(garageLock.stateLabel, 'Locked');
  assert.equal(garageLock.isLocked, true);
  assert.equal(garageLock.smartThingsDeviceId, 'smartthings-lock-2');
});

test('getAlarmStatus includes Matter and source-agnostic sensors in HomeBrain security routines', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalEnsureSmartThingsState = deviceService.ensureSmartThingsState;
  const originalIsSmartThingsConfiguredForSthm = securityAlarmService.isSmartThingsConfiguredForSthm;

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    Device.find = originalDeviceFind;
    deviceService.ensureSmartThingsState = originalEnsureSmartThingsState;
    securityAlarmService.isSmartThingsConfiguredForSthm = originalIsSmartThingsConfiguredForSthm;
  });

  const now = new Date('2026-05-07T12:00:00.000Z');
  const alarm = {
    alarmState: 'armedStay',
    enabledPlatforms: {
      homebrain: true,
      smartthings: false
    },
    lastArmed: now,
    lastDisarmed: null,
    lastTriggered: null,
    zones: [],
    isOnline: true,
    lastSyncWithSmartThings: null,
    batteryLevel: null,
    signalStrength: null,
    save: async function save() {
      return this;
    }
  };

  SecurityAlarm.getMainAlarm = async () => alarm;
  securityAlarmService.isSmartThingsConfiguredForSthm = async () => false;
  deviceService.ensureSmartThingsState = async () => {};
  Device.find = () => ({
    lean: async () => ([
      {
        _id: 'matter-contact',
        name: 'Matter Patio Contact',
        type: 'sensor',
        room: 'Patio',
        status: true,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'homebrain-matter',
          matterFeatures: ['contact', 'battery'],
          matterBatteryLevel: 97,
          matter: {
            nodeId: '1234',
            endpointId: 1,
            deviceTypeNames: ['Contact Sensor']
          }
        }
      },
      {
        _id: 'tempest-lightning',
        name: 'Tempest Lightning Alert',
        type: 'sensor',
        room: 'Outside',
        status: false,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'tempest',
          includeInSecurityCenter: true
        }
      }
    ])
  });

  const status = await securityAlarmService.getAlarmStatus();

  assert.equal(status.enabledPlatforms.homebrain, true);
  assert.equal(status.enabledPlatforms.smartthings, false);
  assert.equal(status.sensorCount, 2);
  assert.equal(status.activeSensorCount, 1);
  assert.equal(status.sensors.some((sensor) => sensor.sourceLabel === 'HomeBrain Matter'), true);
  assert.equal(status.sensors.some((sensor) => sensor.deviceId === 'tempest-lightning'), true);
});

test('getAlarmStatus can force-refresh SmartThings door locks for dashboard consumers', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalBulkWrite = Device.bulkWrite;
  const originalEnsureSmartThingsState = deviceService.ensureSmartThingsState;
  const originalIsSmartThingsConfiguredForSthm = securityAlarmService.isSmartThingsConfiguredForSthm;
  const originalGetDevice = smartThingsService.getDevice;
  const originalGetDeviceStatus = smartThingsService.getDeviceStatus;
  const originalBuildUpdate = smartThingsService.buildSmartThingsDeviceUpdate;
  const originalEmit = deviceUpdateEmitter.emit;

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    Device.find = originalDeviceFind;
    Device.bulkWrite = originalBulkWrite;
    deviceService.ensureSmartThingsState = originalEnsureSmartThingsState;
    securityAlarmService.isSmartThingsConfiguredForSthm = originalIsSmartThingsConfiguredForSthm;
    smartThingsService.getDevice = originalGetDevice;
    smartThingsService.getDeviceStatus = originalGetDeviceStatus;
    smartThingsService.buildSmartThingsDeviceUpdate = originalBuildUpdate;
    deviceUpdateEmitter.emit = originalEmit;
  });

  const now = new Date('2026-03-30T12:00:00.000Z');
  const refreshedAt = new Date('2026-03-30T12:05:00.000Z');
  const alarm = {
    alarmState: 'disarmed',
    lastArmed: null,
    lastDisarmed: now,
    lastTriggered: null,
    armedBy: null,
    disarmedBy: 'user-1',
    zones: [],
    isOnline: true,
    lastSyncWithSmartThings: now,
    batteryLevel: null,
    signalStrength: null,
    save: async function save() {
      return this;
    }
  };

  const initialDevices = [
    {
      _id: 'device-4',
      name: 'Front Door Lock',
      type: 'lock',
      room: 'Entry',
      status: true,
      isOnline: true,
      lastSeen: now,
      properties: {
        smartThingsDeviceId: 'smartthings-lock-1'
      }
    }
  ];

  const refreshedDevices = [
    {
      _id: 'device-4',
      name: 'Front Door Lock',
      type: 'lock',
      room: 'Entry',
      status: false,
      isOnline: true,
      lastSeen: refreshedAt,
      properties: {
        smartThingsDeviceId: 'smartthings-lock-1'
      }
    }
  ];

  let capturedBulkOps = null;
  const emittedUpdates = [];

  SecurityAlarm.getMainAlarm = async () => alarm;
  securityAlarmService.isSmartThingsConfiguredForSthm = async () => false;
  deviceService.ensureSmartThingsState = async () => {};
  smartThingsService.getDevice = async () => ({
    deviceId: 'smartthings-lock-1',
    healthState: {
      state: 'ONLINE',
      lastUpdatedDate: refreshedAt.toISOString()
    }
  });
  smartThingsService.getDeviceStatus = async () => ({
    components: {
      main: {
        lock: {
          value: 'unlocked',
          lock: {
            value: 'unlocked'
          }
        }
      }
    }
  });
  smartThingsService.buildSmartThingsDeviceUpdate = async () => ({
    status: false,
    isOnline: true,
    lastSeen: refreshedAt,
    updatedAt: refreshedAt
  });
  Device.bulkWrite = async (ops) => {
    capturedBulkOps = ops;
  };
  Device.find = (query) => {
    if (query && query._id && query._id.$in) {
      return {
        lean: async () => refreshedDevices
      };
    }

    return {
      lean: async () => initialDevices
    };
  };
  deviceUpdateEmitter.emit = (eventName, payload) => {
    emittedUpdates.push({ eventName, payload });
  };

  const status = await securityAlarmService.getAlarmStatus({ refreshDoorLocks: true });

  assert.ok(Array.isArray(capturedBulkOps));
  assert.equal(capturedBulkOps.length, 1);
  assert.equal(emittedUpdates.length, 1);
  assert.equal(emittedUpdates[0].eventName, 'devices:update');

  assert.equal(status.doorLockCount, 1);
  assert.equal(status.lockedDoorCount, 0);
  assert.equal(status.unlockedDoorCount, 1);
  assert.equal(status.doorLocks[0].deviceId, 'device-4');
  assert.equal(status.doorLocks[0].smartThingsDeviceId, 'smartthings-lock-1');
  assert.equal(status.doorLocks[0].isLocked, false);
  assert.equal(status.doorLocks[0].stateLabel, 'Unlocked');
});

test('dismissAlarm clears the triggered alarm and silences SmartThings alarm outputs', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalIsSmartThingsConfiguredForSthm = securityAlarmService.isSmartThingsConfiguredForSthm;
  const originalSetSecurityArmState = smartThingsService.setSecurityArmState;
  const originalTriggerSthmSilenceSwitch = smartThingsService.triggerSthmSilenceSwitch;
  const originalSilenceAlarmDevice = smartThingsService.silenceAlarmDevice;

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    Device.find = originalDeviceFind;
    securityAlarmService.isSmartThingsConfiguredForSthm = originalIsSmartThingsConfiguredForSthm;
    smartThingsService.setSecurityArmState = originalSetSecurityArmState;
    smartThingsService.triggerSthmSilenceSwitch = originalTriggerSthmSilenceSwitch;
    smartThingsService.silenceAlarmDevice = originalSilenceAlarmDevice;
  });

  const captured = {
    states: [],
    silenceTriggers: 0,
    silenced: []
  };

  const alarm = {
    alarmState: 'triggered',
    disarmedBy: null,
    disarm: async function disarm(userId) {
      this.alarmState = 'disarmed';
      this.disarmedBy = userId;
      return this;
    }
  };

  SecurityAlarm.getMainAlarm = async () => alarm;
  Device.find = () => ({
    lean: async () => ([
      {
        _id: 'siren-1',
        name: 'Hall Siren',
        properties: {
          smartThingsDeviceId: 'smartthings-siren-1',
          smartThingsCapabilities: ['alarm', 'switch'],
          smartThingsCategories: ['siren']
        }
      },
      {
        _id: 'lock-1',
        name: 'Front Door Lock',
        properties: {
          smartThingsDeviceId: 'smartthings-lock-1',
          smartThingsCapabilities: ['lock']
        }
      }
    ])
  });
  securityAlarmService.isSmartThingsConfiguredForSthm = async (options = {}) => (
    options.requireAllMappings === false
      || (Array.isArray(options.requiredMappings) && options.requiredMappings.includes('silence'))
  );
  smartThingsService.setSecurityArmState = async (state) => {
    captured.states.push(state);
    return { armState: state };
  };
  smartThingsService.triggerSthmSilenceSwitch = async () => {
    captured.silenceTriggers += 1;
    return { silenced: true };
  };
  smartThingsService.silenceAlarmDevice = async (deviceId, options = {}) => {
    captured.silenced.push({
      deviceId,
      capabilities: options.capabilities,
      categories: options.categories
    });
    return { deviceId, via: 'alarm.off' };
  };

  const result = await securityAlarmService.dismissAlarm('user-dismiss');

  assert.equal(result.alarmState, 'disarmed');
  assert.equal(result.disarmedBy, 'user-dismiss');
  assert.deepEqual(captured.states, ['Disarmed']);
  assert.equal(captured.silenceTriggers, 1);
  assert.deepEqual(captured.silenced, [{
    deviceId: 'smartthings-siren-1',
    capabilities: ['alarm', 'switch'],
    categories: ['siren']
  }]);
});

test('disarmAlarm also triggers silence automations and silences SmartThings alarm outputs when the alarm is triggered', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalIsSmartThingsConfiguredForSthm = securityAlarmService.isSmartThingsConfiguredForSthm;
  const originalSetSecurityArmState = smartThingsService.setSecurityArmState;
  const originalTriggerSthmSilenceSwitch = smartThingsService.triggerSthmSilenceSwitch;
  const originalSilenceAlarmDevice = smartThingsService.silenceAlarmDevice;

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    Device.find = originalDeviceFind;
    securityAlarmService.isSmartThingsConfiguredForSthm = originalIsSmartThingsConfiguredForSthm;
    smartThingsService.setSecurityArmState = originalSetSecurityArmState;
    smartThingsService.triggerSthmSilenceSwitch = originalTriggerSthmSilenceSwitch;
    smartThingsService.silenceAlarmDevice = originalSilenceAlarmDevice;
  });

  const captured = {
    states: [],
    silenceTriggers: 0,
    silenced: []
  };

  const alarm = {
    alarmState: 'triggered',
    disarmedBy: null,
    disarm: async function disarm(userId) {
      this.alarmState = 'disarmed';
      this.disarmedBy = userId;
      return this;
    }
  };

  SecurityAlarm.getMainAlarm = async () => alarm;
  Device.find = () => ({
    lean: async () => ([
      {
        _id: 'siren-2',
        name: 'Garage Siren',
        properties: {
          smartThingsDeviceId: 'smartthings-siren-2',
          smartThingsCapabilities: ['alarm']
        }
      }
    ])
  });
  securityAlarmService.isSmartThingsConfiguredForSthm = async (options = {}) => (
    options.requireAllMappings === false
      || (Array.isArray(options.requiredMappings) && options.requiredMappings.includes('silence'))
  );
  smartThingsService.setSecurityArmState = async (state) => {
    captured.states.push(state);
    return { armState: state };
  };
  smartThingsService.triggerSthmSilenceSwitch = async () => {
    captured.silenceTriggers += 1;
    return { silenced: true };
  };
  smartThingsService.silenceAlarmDevice = async (deviceId) => {
    captured.silenced.push(deviceId);
    return { deviceId, via: 'alarm.off' };
  };

  const result = await securityAlarmService.disarmAlarm('user-disarm');

  assert.equal(result.alarmState, 'disarmed');
  assert.equal(result.disarmedBy, 'user-disarm');
  assert.deepEqual(captured.states, ['Disarmed']);
  assert.equal(captured.silenceTriggers, 1);
  assert.deepEqual(captured.silenced, ['smartthings-siren-2']);
});

test('armAlarm starts an away exit-delay countdown before final arming', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalIsSmartThingsConfiguredForSthm = securityAlarmService.isSmartThingsConfiguredForSthm;

  const alarm = {
    _id: 'alarm-away-test',
    alarmState: 'disarmed',
    exitDelay: 30,
    enabledPlatforms: {
      homebrain: true,
      smartthings: false
    },
    pendingArmMode: null,
    pendingArmReadyAt: null,
    pendingArmStartedAt: null,
    zones: [],
    saveCount: 0,
    save: async function save() {
      this.saveCount += 1;
      return this;
    },
    arm: async function arm(mode, userId) {
      this.alarmState = mode === 'away' ? 'armedAway' : 'armedStay';
      this.armedBy = userId;
      return this;
    }
  };

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    securityAlarmService.isSmartThingsConfiguredForSthm = originalIsSmartThingsConfiguredForSthm;
    securityAlarmService.clearPendingArmTimer(alarm);
  });

  SecurityAlarm.getMainAlarm = async () => alarm;
  securityAlarmService.isSmartThingsConfiguredForSthm = async () => false;

  const result = await securityAlarmService.armAlarm('away', 'user-arm', { exitDelaySeconds: 45 });

  assert.equal(result.alarmState, 'arming');
  assert.equal(result.exitDelay, 45);
  assert.equal(result.pendingArmMode, 'away');
  assert.equal(result.armedBy, 'user-arm');
  assert.ok(result.pendingArmStartedAt instanceof Date);
  assert.ok(result.pendingArmReadyAt instanceof Date);
  assert.ok(result.pendingArmReadyAt.getTime() > result.pendingArmStartedAt.getTime());
  assert.equal(result.saveCount, 1);
});

test('updateSecuritySettings stores platform selection and default exit delay', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;

  const alarm = {
    alarmState: 'disarmed',
    exitDelay: 30,
    entryDelay: 30,
    enabledPlatforms: {
      homebrain: true,
      smartthings: true
    },
    zones: [],
    saveCount: 0,
    save: async function save() {
      this.saveCount += 1;
      return this;
    }
  };

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
  });

  SecurityAlarm.getMainAlarm = async () => alarm;

  const result = await securityAlarmService.updateSecuritySettings({
    enabledPlatforms: {
      homebrain: true,
      smartthings: false
    },
    exitDelaySeconds: 65
  });

  assert.equal(result.alarm.enabledPlatforms.homebrain, true);
  assert.equal(result.alarm.enabledPlatforms.smartthings, false);
  assert.equal(result.alarm.exitDelay, 65);
  assert.equal(result.settings.exitDelaySeconds, 65);
  assert.equal(result.settings.enabledPlatforms.homebrain, true);
  assert.equal(result.settings.enabledPlatforms.smartthings, false);
  assert.equal(alarm.saveCount, 1);
});

test('updateSecuritySettings keeps one security platform enabled and clamps timing defaults', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;

  const alarm = {
    alarmState: 'disarmed',
    exitDelay: 30,
    entryDelay: 30,
    enabledPlatforms: {
      homebrain: true,
      smartthings: false
    },
    zones: [],
    save: async function save() {
      return this;
    }
  };

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
  });

  SecurityAlarm.getMainAlarm = async () => alarm;

  await assert.rejects(
    () => securityAlarmService.updateSecuritySettings({
      enabledPlatforms: {
        homebrain: false,
        smartthings: false
      }
    }),
    /At least one security platform must remain enabled/
  );

  const result = await securityAlarmService.updateSecuritySettings({
    exitDelaySeconds: 999,
    entryDelaySeconds: -10
  });

  assert.equal(result.settings.enabledPlatforms.homebrain, true);
  assert.equal(result.settings.enabledPlatforms.smartthings, false);
  assert.equal(result.settings.exitDelaySeconds, 300);
  assert.equal(result.settings.entryDelaySeconds, 0);
});

test('dismissAlarm records a reason and silences HomeBrain-native alarm outputs', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalControlDevice = deviceService.controlDevice;

  const alarm = {
    alarmState: 'triggered',
    enabledPlatforms: {
      homebrain: true,
      smartthings: false
    },
    zones: [],
    saveCount: 0,
    disarm: async function disarm(userId) {
      this.alarmState = 'disarmed';
      this.disarmedBy = userId;
      return this;
    },
    save: async function save() {
      this.saveCount += 1;
      return this;
    }
  };
  const capturedControls = [];

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    Device.find = originalDeviceFind;
    deviceService.controlDevice = originalControlDevice;
  });

  SecurityAlarm.getMainAlarm = async () => alarm;
  Device.find = () => ({
    lean: async () => ([
      {
        _id: 'siren-direct-1',
        name: 'HomeBrain Siren',
        type: 'switch',
        properties: {
          source: 'homebrain-zwave',
          homebrainDirect: { protocol: 'zwave', nodeId: 12 },
          directRadioFeatures: ['alarm', 'switch'],
          supportsAlarm: true
        }
      }
    ])
  });
  deviceService.controlDevice = async (deviceId, action, value, options = {}) => {
    capturedControls.push({ deviceId, action, value, reason: options.command?.reason });
    return { _id: deviceId, name: 'HomeBrain Siren' };
  };

  const result = await securityAlarmService.dismissAlarm('user-dismiss', {
    reason: 'custom',
    customReason: 'Smoke machine test'
  });

  assert.equal(result.alarmState, 'disarmed');
  assert.equal(result.dismissalReason, 'custom');
  assert.equal(result.dismissalReasonText, 'Smoke machine test');
  assert.equal(result.disarmedBy, 'user-dismiss');
  assert.equal(result.dismissedBy, 'user-dismiss');
  assert.equal(result.saveCount, 1);
  assert.deepEqual(capturedControls, [{
    deviceId: 'siren-direct-1',
    action: 'alarm_off',
    value: null,
    reason: 'dismiss_triggered_alarm'
  }]);
  assert.equal(result.lastSirenSilenceResult.homebrain.silencedOutputs.length, 1);
  assert.equal(result.lastSirenSilenceResult.smartthings.attempted, false);
});

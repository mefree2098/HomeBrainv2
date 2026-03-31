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
  const originalSilenceAlarmDevice = smartThingsService.silenceAlarmDevice;

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    Device.find = originalDeviceFind;
    securityAlarmService.isSmartThingsConfiguredForSthm = originalIsSmartThingsConfiguredForSthm;
    smartThingsService.setSecurityArmState = originalSetSecurityArmState;
    smartThingsService.silenceAlarmDevice = originalSilenceAlarmDevice;
  });

  const captured = {
    states: [],
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
  securityAlarmService.isSmartThingsConfiguredForSthm = async (options = {}) => options.requireAllMappings === false;
  smartThingsService.setSecurityArmState = async (state) => {
    captured.states.push(state);
    return { armState: state };
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
  assert.deepEqual(captured.silenced, [{
    deviceId: 'smartthings-siren-1',
    capabilities: ['alarm', 'switch'],
    categories: ['siren']
  }]);
});

test('disarmAlarm also silences SmartThings alarm outputs when the alarm is triggered', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalIsSmartThingsConfiguredForSthm = securityAlarmService.isSmartThingsConfiguredForSthm;
  const originalSetSecurityArmState = smartThingsService.setSecurityArmState;
  const originalSilenceAlarmDevice = smartThingsService.silenceAlarmDevice;

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    Device.find = originalDeviceFind;
    securityAlarmService.isSmartThingsConfiguredForSthm = originalIsSmartThingsConfiguredForSthm;
    smartThingsService.setSecurityArmState = originalSetSecurityArmState;
    smartThingsService.silenceAlarmDevice = originalSilenceAlarmDevice;
  });

  const captured = {
    states: [],
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
  securityAlarmService.isSmartThingsConfiguredForSthm = async (options = {}) => options.requireAllMappings === false;
  smartThingsService.setSecurityArmState = async (state) => {
    captured.states.push(state);
    return { armState: state };
  };
  smartThingsService.silenceAlarmDevice = async (deviceId) => {
    captured.silenced.push(deviceId);
    return { deviceId, via: 'alarm.off' };
  };

  const result = await securityAlarmService.disarmAlarm('user-disarm');

  assert.equal(result.alarmState, 'disarmed');
  assert.equal(result.disarmedBy, 'user-disarm');
  assert.deepEqual(captured.states, ['Disarmed']);
  assert.deepEqual(captured.silenced, ['smartthings-siren-2']);
});

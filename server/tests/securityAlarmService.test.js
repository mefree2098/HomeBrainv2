const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
const SecurityAlarm = require('../models/SecurityAlarm');
const deviceService = require('../services/deviceService');
const deviceUpdateEmitter = require('../services/deviceUpdateEmitter');
const securityAlarmService = require('../services/securityAlarmService');
const smartThingsService = require('../services/smartThingsService');
const automationSchedulerService = require('../services/automationSchedulerService');

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
  assert.equal(frontDoor.monitorState, 'Stay + Away');
  assert.equal(frontDoor.armedStayEnabled, true);
  assert.equal(frontDoor.armedAwayEnabled, true);
  assert.deepEqual(frontDoor.monitoredModes, ['armedStay', 'armedAway']);
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

test('getAlarmStatus scopes sensors and locks to the enabled HomeBrain security platform', async (t) => {
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
        _id: 'native-contact',
        name: 'Native Patio Contact',
        type: 'sensor',
        room: 'Patio',
        status: true,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'homebrain-zigbee',
          directRadioFeatures: ['contact', 'battery'],
          homeBrainBatteryLevel: 97,
          homebrainDirect: {
            protocol: 'zigbee',
            ieeeAddr: '0x00124b0025aa55cc'
          }
        }
      },
      {
        _id: 'native-lock',
        name: 'Native Entry Lock',
        type: 'lock',
        room: 'Entry',
        status: true,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'homebrain-zwave',
          homebrainDirect: {
            protocol: 'zwave',
            nodeId: 7
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
      },
      {
        _id: 'smartthings-contact',
        name: 'SmartThings Patio Contact',
        type: 'sensor',
        room: 'Patio',
        status: false,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'smartthings',
          smartThingsDeviceId: 'smartthings-contact-1',
          smartThingsCapabilities: ['contactSensor']
        }
      },
      {
        _id: 'smartthings-lock',
        name: 'SmartThings Entry Lock',
        type: 'lock',
        room: 'Entry',
        status: false,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'smartthings',
          smartThingsDeviceId: 'smartthings-lock-1'
        }
      }
    ])
  });

  const status = await securityAlarmService.getAlarmStatus();

  assert.equal(status.enabledPlatforms.homebrain, true);
  assert.equal(status.enabledPlatforms.smartthings, false);
  assert.equal(status.sensorCount, 1);
  assert.equal(status.activeSensorCount, 1);
  assert.equal(status.sensors[0].deviceId, 'native-contact');
  assert.equal(status.sensors[0].sourceLabel, 'HomeBrain Zigbee');
  assert.equal(status.sensors.some((sensor) => sensor.deviceId === 'tempest-lightning'), false);
  assert.equal(status.sensors.some((sensor) => sensor.deviceId === 'smartthings-contact'), false);
  assert.equal(status.doorLockCount, 1);
  assert.equal(status.doorLocks[0].deviceId, 'native-lock');
  assert.equal(status.doorLocks[0].sourceLabel, 'HomeBrain Z-Wave');
});

test('getAlarmStatus resolves retired SmartThings security zones to native HomeBrain replacements', async (t) => {
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

  const now = new Date('2026-05-07T12:15:00.000Z');
  const alarm = {
    alarmState: 'armedStay',
    enabledPlatforms: {
      homebrain: true,
      smartthings: false
    },
    lastArmed: now,
    lastDisarmed: null,
    lastTriggered: null,
    zones: [
      {
        name: 'Garage Entry',
        deviceId: 'smartthings-garage-source',
        deviceType: 'doorWindow',
        enabled: true,
        bypassed: false
      }
    ],
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
        _id: 'native-garage-contact',
        name: 'Garage Entry Contact',
        type: 'sensor',
        room: 'Garage',
        status: true,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'homebrain-zigbee',
          directRadioFeatures: ['contact', 'battery'],
          smartThingsDeviceId: 'smartthings-garage-device',
          smartThingsMigration: {
            sourceDeviceId: 'smartthings-garage-source',
            smartThingsDeviceId: 'smartthings-garage-device'
          }
        }
      },
      {
        _id: 'smartthings-garage-source',
        name: 'Garage Entry SmartThings',
        type: 'sensor',
        room: 'Garage',
        status: false,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'smartthings',
          smartThingsDeviceId: 'smartthings-garage-device',
          smartThingsCapabilities: ['contactSensor'],
          smartThingsMigration: {
            directDeviceId: 'native-garage-contact',
            replacementDeviceId: 'native-garage-contact',
            retiredSource: true,
            status: 'finalized_source'
          }
        }
      }
    ])
  });

  const status = await securityAlarmService.getAlarmStatus();

  assert.equal(status.zoneCount, 1);
  assert.equal(status.sensorCount, 1);
  assert.equal(status.monitoredSensorCount, 1);
  assert.equal(status.activeSensorCount, 1);
  assert.equal(status.sensors[0].deviceId, 'native-garage-contact');
  assert.equal(status.sensors[0].zoneDeviceId, 'smartthings-garage-source');
  assert.equal(status.sensors[0].sourceLabel, 'HomeBrain Zigbee');
  assert.equal(status.sensors[0].monitorState, 'Stay + Away');
  assert.equal(status.sensors[0].armedStayEnabled, true);
  assert.equal(status.sensors[0].armedAwayEnabled, true);
  assert.equal(status.sensors[0].stateLabel, 'Open');
});

test('getAlarmStatus scopes sensors and locks to the enabled SmartThings security platform', async (t) => {
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

  const now = new Date('2026-05-07T12:30:00.000Z');
  const alarm = {
    alarmState: 'disarmed',
    enabledPlatforms: {
      homebrain: false,
      smartthings: true
    },
    lastArmed: null,
    lastDisarmed: now,
    lastTriggered: null,
    zones: [],
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
        _id: 'smartthings-contact',
        name: 'SmartThings Door Contact',
        type: 'sensor',
        room: 'Entry',
        status: false,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'smartthings',
          smartThingsDeviceId: 'smartthings-contact-1',
          smartThingsCapabilities: ['contactSensor']
        }
      },
      {
        _id: 'smartthings-lock',
        name: 'SmartThings Entry Lock',
        type: 'lock',
        room: 'Entry',
        status: false,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'smartthings',
          smartThingsDeviceId: 'smartthings-lock-1'
        }
      },
      {
        _id: 'native-contact',
        name: 'Native Door Contact',
        type: 'sensor',
        room: 'Entry',
        status: true,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'homebrain-zigbee',
          directRadioFeatures: ['contact']
        }
      },
      {
        _id: 'native-lock',
        name: 'Native Entry Lock',
        type: 'lock',
        room: 'Entry',
        status: true,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'homebrain-zwave'
        }
      }
    ])
  });

  const status = await securityAlarmService.getAlarmStatus();

  assert.equal(status.enabledPlatforms.homebrain, false);
  assert.equal(status.enabledPlatforms.smartthings, true);
  assert.equal(status.sensorCount, 1);
  assert.equal(status.sensors[0].deviceId, 'smartthings-contact');
  assert.equal(status.sensors[0].sourceLabel, 'SmartThings');
  assert.equal(status.doorLockCount, 1);
  assert.equal(status.doorLocks[0].deviceId, 'smartthings-lock');
  assert.equal(status.doorLocks[0].sourceLabel, 'SmartThings');
});

test('getAlarmStatus returns platform-scoped siren outputs with selected state', async (t) => {
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

  const now = new Date('2026-05-07T13:00:00.000Z');
  const alarm = {
    alarmState: 'armedStay',
    enabledPlatforms: {
      homebrain: true,
      smartthings: false
    },
    sirenOutputs: [
      { deviceId: 'native-siren', name: 'Main Siren', enabled: true },
      { deviceId: 'smartthings-siren-id', name: 'Old Siren', enabled: true }
    ],
    lastArmed: now,
    lastDisarmed: null,
    lastTriggered: null,
    zones: [],
    isOnline: true,
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
        _id: 'native-siren',
        name: 'Kitchen Siren',
        type: 'siren',
        room: 'Kitchen',
        status: false,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'homebrain-zwave',
          supportsAlarm: true,
          homebrainDirect: {
            protocol: 'zwave',
            nodeId: 8,
            ready: false,
            status: 3
          }
        }
      },
      {
        _id: 'native-spare-siren',
        name: 'Hall Siren',
        type: 'switch',
        room: 'Hall',
        status: true,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'homebrain-zigbee',
          directRadioFeatures: ['alarm', 'switch']
        }
      },
      {
        _id: 'smartthings-siren',
        name: 'SmartThings Siren',
        type: 'siren',
        room: 'Entry',
        status: false,
        isOnline: true,
        lastSeen: now,
        properties: {
          source: 'smartthings',
          smartThingsDeviceId: 'smartthings-siren-id',
          smartThingsCapabilities: ['alarm']
        }
      }
    ])
  });

  const status = await securityAlarmService.getAlarmStatus();

  assert.equal(status.enabledPlatforms.homebrain, true);
  assert.equal(status.enabledPlatforms.smartthings, false);
  assert.equal(status.sirenOutputCount, 2);
  assert.equal(status.selectedSirenOutputCount, 1);
  assert.equal(status.onlineSirenOutputCount, 1);
  assert.deepEqual(status.sirenOutputs.map((output) => output.deviceId), [
    'native-siren',
    'native-spare-siren'
  ]);
  assert.equal(status.sirenOutputs[0].isSelected, true);
  assert.equal(status.sirenOutputs[0].isOnline, false);
  assert.equal(status.sirenOutputs[0].name, 'Kitchen Siren');
  assert.equal(status.sirenOutputs[0].platform, 'homebrain');
  assert.equal(status.sirenOutputs[1].isSelected, false);
  assert.equal(status.sirenOutputs[1].isOnline, true);
  assert.equal(status.sirenOutputs[1].platform, 'homebrain');
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

test('updateSecuritySettings stores selected siren outputs without exposing unavailable devices in status', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalEnsureSmartThingsState = deviceService.ensureSmartThingsState;
  const originalIsSmartThingsConfiguredForSthm = securityAlarmService.isSmartThingsConfiguredForSthm;

  const alarm = {
    alarmState: 'disarmed',
    exitDelay: 30,
    entryDelay: 30,
    enabledPlatforms: {
      homebrain: true,
      smartthings: false
    },
    zones: [],
    sirenOutputs: [],
    isOnline: true,
    save: async function save() {
      return this;
    }
  };

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    Device.find = originalDeviceFind;
    deviceService.ensureSmartThingsState = originalEnsureSmartThingsState;
    securityAlarmService.isSmartThingsConfiguredForSthm = originalIsSmartThingsConfiguredForSthm;
  });

  SecurityAlarm.getMainAlarm = async () => alarm;
  securityAlarmService.isSmartThingsConfiguredForSthm = async () => false;
  deviceService.ensureSmartThingsState = async () => {};
  Device.find = () => ({
    lean: async () => ([
      {
        _id: 'native-siren',
        name: 'Kitchen Siren',
        type: 'siren',
        isOnline: true,
        properties: {
          source: 'homebrain-zwave',
          supportsAlarm: true
        }
      }
    ])
  });

  const result = await securityAlarmService.updateSecuritySettings({
    sirenOutputs: [
      { deviceId: 'native-siren', name: 'Kitchen Siren', enabled: true },
      { deviceId: 'native-siren', name: 'Duplicate', enabled: true },
      { deviceId: 'smartthings-siren-id', name: 'Old SmartThings Siren', enabled: true }
    ]
  });

  assert.deepEqual(result.settings.sirenOutputs, [
    { deviceId: 'native-siren', name: 'Kitchen Siren', enabled: true },
    { deviceId: 'smartthings-siren-id', name: 'Old SmartThings Siren', enabled: true }
  ]);

  const status = await securityAlarmService.getAlarmStatus();
  assert.deepEqual(status.sirenOutputs.map((output) => output.deviceId), ['native-siren']);
  assert.equal(status.selectedSirenOutputCount, 1);
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

test('updateSecuritySettings stores named hashed security PINs without exposing codes', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;

  const alarm = {
    alarmState: 'disarmed',
    exitDelay: 30,
    entryDelay: 30,
    enabledPlatforms: {
      homebrain: true,
      smartthings: false
    },
    pinSettings: {
      requireForArm: false,
      requireForDisarm: false
    },
    userCodes: [],
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
      pinSettings: {
        requireForDisarm: true
      },
      pins: []
    }),
    /At least one enabled security PIN is required/
  );

  const result = await securityAlarmService.updateSecuritySettings({
    pinSettings: {
      requireForArm: true,
      requireForDisarm: true
    },
    pins: [
      { name: 'Matt', pin: '1234', enabled: true },
      { name: 'Guest', pin: '9876', enabled: false }
    ]
  });

  assert.equal(result.settings.pinSettings.requireForArm, true);
  assert.equal(result.settings.pinSettings.requireForDisarm, true);
  assert.deepEqual(result.settings.pins.map((pin) => ({
    name: pin.name,
    enabled: pin.enabled,
    code: pin.code
  })), [
    { name: 'Matt', enabled: true, code: undefined },
    { name: 'Guest', enabled: false, code: undefined }
  ]);
  assert.equal(alarm.userCodes.length, 2);
  assert.match(alarm.userCodes[0].code, /^\$2/);
  assert.notEqual(alarm.userCodes[0].code, '1234');
});

test('armAlarm requires a valid PIN when arm PIN enforcement is enabled and records the PIN name', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;

  const alarm = {
    alarmState: 'disarmed',
    exitDelay: 30,
    entryDelay: 30,
    enabledPlatforms: {
      homebrain: true,
      smartthings: false
    },
    pinSettings: {
      requireForArm: false,
      requireForDisarm: false
    },
    userCodes: [],
    zones: [],
    save: async function save() {
      return this;
    },
    arm: async function arm(mode, actor) {
      this.alarmState = mode === 'away' ? 'armedAway' : 'armedStay';
      this.armedBy = actor;
      this.lastArmed = new Date();
      return this;
    }
  };

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
  });

  SecurityAlarm.getMainAlarm = async () => alarm;

  await securityAlarmService.updateSecuritySettings({
    pinSettings: {
      requireForArm: true
    },
    pins: [
      { name: 'Anna', pin: '2468', enabled: true }
    ]
  });

  await assert.rejects(
    () => securityAlarmService.armAlarm('stay', 'api-user'),
    /Security PIN is required/
  );

  await assert.rejects(
    () => securityAlarmService.armAlarm('stay', 'api-user', { pin: '1111' }),
    /Invalid security PIN/
  );

  const result = await securityAlarmService.armAlarm('stay', 'api-user', { pin: '2468' });

  assert.equal(result.alarmState, 'armedStay');
  assert.equal(result.armedBy, 'Anna');
});

test('disarmAlarm and dismissAlarm require valid disarm PINs and preserve named attribution', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalClearTriggeredAlarm = securityAlarmService.clearTriggeredAlarm;

  const alarm = {
    alarmState: 'armedStay',
    exitDelay: 30,
    entryDelay: 30,
    enabledPlatforms: {
      homebrain: true,
      smartthings: false
    },
    pinSettings: {
      requireForArm: false,
      requireForDisarm: false
    },
    userCodes: [],
    zones: [],
    save: async function save() {
      return this;
    },
    disarm: async function disarm(actor) {
      this.alarmState = 'disarmed';
      this.disarmedBy = actor;
      this.lastDisarmed = new Date();
      return this;
    }
  };

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    securityAlarmService.clearTriggeredAlarm = originalClearTriggeredAlarm;
  });

  SecurityAlarm.getMainAlarm = async () => alarm;
  securityAlarmService.clearTriggeredAlarm = async () => ({
    smartthings: { attempted: false },
    homebrain: { attempted: false },
    silencedOutputs: [],
    failedOutputs: []
  });

  await securityAlarmService.updateSecuritySettings({
    pinSettings: {
      requireForDisarm: true
    },
    pins: [
      { name: 'Parent', pin: '1357', enabled: true }
    ]
  });

  await assert.rejects(
    () => securityAlarmService.disarmAlarm('api-user', { pin: '2468' }),
    /Invalid security PIN/
  );

  let result = await securityAlarmService.disarmAlarm('api-user', { pin: '1357' });
  assert.equal(result.alarmState, 'disarmed');
  assert.equal(result.disarmedBy, 'Parent');

  alarm.alarmState = 'triggered';
  result = await securityAlarmService.dismissAlarm('api-user', {
    pin: '1357',
    reason: 'false_alarm'
  });

  assert.equal(result.alarmState, 'disarmed');
  assert.equal(result.disarmedBy, 'Parent');
  assert.equal(result.dismissedBy, 'Parent');
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
    sirenOutputs: [
      { deviceId: 'siren-direct-1', enabled: true }
    ],
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
      },
      {
        _id: 'siren-direct-2',
        name: 'Spare HomeBrain Siren',
        type: 'siren',
        properties: {
          source: 'homebrain-zwave',
          homebrainDirect: { protocol: 'zwave', nodeId: 13 },
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

test('triggerAlarm sounds selected HomeBrain siren outputs only', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalControlDevice = deviceService.controlDevice;

  const alarm = {
    alarmState: 'armedStay',
    enabledPlatforms: {
      homebrain: true,
      smartthings: false
    },
    sirenOutputs: [
      { deviceId: 'selected-siren', enabled: true }
    ],
    zones: [],
    lastSirenTriggerResult: null,
    saveCount: 0,
    trigger: async function trigger(triggeredZone) {
      this.alarmState = 'triggered';
      this.lastTriggered = new Date('2026-05-07T14:00:00.000Z');
      this.triggeredZone = triggeredZone;
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
        _id: 'selected-siren',
        name: 'Selected HomeBrain Siren',
        type: 'siren',
        properties: {
          source: 'homebrain-zwave',
          homebrainDirect: { protocol: 'zwave', nodeId: 8 },
          supportsAlarm: true,
          supportsSirenSound: true,
          sirenSound: 9
        }
      },
      {
        _id: 'spare-siren',
        name: 'Spare HomeBrain Siren',
        type: 'siren',
        properties: {
          source: 'homebrain-zwave',
          homebrainDirect: { protocol: 'zwave', nodeId: 9 },
          supportsAlarm: true
        }
      }
    ])
  });
  deviceService.controlDevice = async (deviceId, action, value, options = {}) => {
    capturedControls.push({
      deviceId,
      action,
      value,
      reason: options.command?.reason,
      releaseCommandClaimOnSuccess: options.releaseCommandClaimOnSuccess
    });
    return { _id: deviceId };
  };

  const result = await securityAlarmService.triggerAlarm(null, { triggeredZoneName: 'Front Door' });

  assert.equal(result.alarmState, 'triggered');
  assert.equal(result.triggeredZone, 'Front Door');
  assert.equal(result.saveCount, 2);
  assert.deepEqual(capturedControls, [{
    deviceId: 'selected-siren',
    action: 'alarm_on',
    value: null,
    reason: 'trigger_alarm',
    releaseCommandClaimOnSuccess: true
  }]);
  assert.equal(result.lastSirenTriggerResult.homebrain.soundedOutputs.length, 1);
  assert.equal(result.lastSirenTriggerResult.homebrain.soundedOutputs[0].deviceId, 'selected-siren');
  assert.equal(result.lastSirenTriggerResult.failedOutputs.length, 0);
});

test('triggerAlarm publishes triggered state before delayed siren output completes', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalControlDevice = deviceService.controlDevice;
  const originalTick = automationSchedulerService.tick;
  const events = [];
  let resolveControlStarted;
  let finishControl;
  const controlStarted = new Promise((resolve) => {
    resolveControlStarted = resolve;
  });
  const controlCanFinish = new Promise((resolve) => {
    finishControl = resolve;
  });

  const alarm = {
    alarmState: 'armedStay',
    enabledPlatforms: { homebrain: true, smartthings: false },
    sirenOutputs: [{ deviceId: 'slow-siren', enabled: true }],
    zones: [],
    lastSirenTriggerResult: null,
    saveCount: 0,
    trigger: async function trigger(triggeredZone) {
      this.alarmState = 'triggered';
      this.triggeredZone = triggeredZone;
    },
    save: async function save() {
      this.saveCount += 1;
      events.push(this.lastSirenTriggerResult ? 'save:with-siren-result' : 'save:triggered-state');
      return this;
    }
  };

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    Device.find = originalDeviceFind;
    deviceService.controlDevice = originalControlDevice;
    automationSchedulerService.tick = originalTick;
  });

  SecurityAlarm.getMainAlarm = async () => alarm;
  Device.find = () => ({
    lean: async () => ([{
      _id: 'slow-siren',
      name: 'Slow HomeBrain Siren',
      type: 'siren',
      properties: {
        source: 'homebrain-zwave',
        homebrainDirect: { protocol: 'zwave', nodeId: 8 },
        supportsAlarm: true
      }
    }])
  });
  deviceService.controlDevice = async (deviceId, action) => {
    events.push(`control:${deviceId}:${action}:start`);
    resolveControlStarted();
    await controlCanFinish;
    events.push(`control:${deviceId}:${action}:finish`);
    return { _id: deviceId };
  };
  automationSchedulerService.tick = (context = {}) => {
    events.push(`automation:${context.reason || ''}`);
    return Promise.resolve();
  };

  const triggerPromise = securityAlarmService.triggerAlarm(null, { triggeredZoneName: 'Front Door' });
  await controlStarted;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(alarm.saveCount, 1);
  assert.equal(alarm.lastSirenTriggerResult, null);
  assert.ok(events.includes('save:triggered-state'));
  assert.ok(events.includes('automation:triggered by Front Door'));
  assert.ok(events.includes('control:slow-siren:alarm_on:start'));
  assert.equal(events.includes('control:slow-siren:alarm_on:finish'), false);
  assert.ok(
    events.indexOf('automation:triggered by Front Door') < events.indexOf('control:slow-siren:alarm_on:finish')
      || !events.includes('control:slow-siren:alarm_on:finish')
  );

  finishControl();
  const result = await triggerPromise;

  assert.equal(result.saveCount, 2);
  assert.equal(result.lastSirenTriggerResult.homebrain.soundedOutputs[0].deviceId, 'slow-siren');
  assert.ok(events.indexOf('automation:triggered by Front Door') < events.indexOf('control:slow-siren:alarm_on:finish'));
  assert.ok(events.includes('save:with-siren-result'));
});

test('triggerAlarm falls back to turn_on when alarm_on command fails', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalControlDevice = deviceService.controlDevice;
  const alarm = {
    alarmState: 'armedStay',
    enabledPlatforms: { homebrain: true, smartthings: false },
    sirenOutputs: [{ deviceId: 'fallback-siren', enabled: true }],
    saveCount: 0,
    trigger: function trigger(triggeredZone) {
      this.alarmState = 'triggered';
      this.lastTriggered = new Date('2026-05-07T14:00:00.000Z');
      this.triggeredZone = triggeredZone;
    },
    save: async function save() {
      this.saveCount += 1;
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
    lean: async () => [{
      _id: 'fallback-siren',
      name: 'Fallback HomeBrain Siren',
      type: 'siren',
      properties: {
        source: 'homebrain-zwave',
        homebrainDirect: { protocol: 'zwave', nodeId: 8 },
        supportsAlarm: true,
        supportsSirenSound: true,
        sirenSound: 9
      }
    }]
  });
  deviceService.controlDevice = async (deviceId, action, value, options = {}) => {
    capturedControls.push({
      deviceId,
      action,
      value,
      reason: options.command?.reason,
      fallbackFrom: options.command?.fallbackFrom
    });
    if (action === 'alarm_on') {
      throw new Error('Siren alarm-on command unavailable');
    }
    return { _id: deviceId };
  };

  const result = await securityAlarmService.triggerAlarm(null, { triggeredZoneName: 'Front Door' });

  assert.deepEqual(capturedControls, [
    {
      deviceId: 'fallback-siren',
      action: 'alarm_on',
      value: null,
      reason: 'trigger_alarm',
      fallbackFrom: undefined
    },
    {
      deviceId: 'fallback-siren',
      action: 'turn_on',
      value: true,
      reason: 'trigger_alarm',
      fallbackFrom: 'alarm_on'
    }
  ]);
  assert.equal(result.lastSirenTriggerResult.homebrain.soundedOutputs.length, 1);
  assert.equal(result.lastSirenTriggerResult.homebrain.soundedOutputs[0].via, 'homebrain.turn_on');
  assert.equal(result.lastSirenTriggerResult.failedOutputs.length, 0);
});

test('evaluateNativeSecuritySensorUpdate triggers monitored contact sensor while armed stay', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalTriggerAlarm = securityAlarmService.triggerAlarm;
  const alarm = {
    alarmState: 'armedStay',
    zones: [{
      name: 'Back Door',
      deviceId: 'back-door-sensor',
      deviceType: 'doorWindow',
      enabled: true,
      bypassed: false
    }]
  };
  const capturedTriggers = [];

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    securityAlarmService.triggerAlarm = originalTriggerAlarm;
  });

  SecurityAlarm.getMainAlarm = async () => alarm;
  securityAlarmService.triggerAlarm = async (zone, options = {}) => {
    capturedTriggers.push({ zone, options });
    return { alarmState: 'triggered' };
  };

  const result = await securityAlarmService.evaluateNativeSecuritySensorUpdate({
    _id: 'back-door-sensor',
    name: 'Back Door',
    type: 'sensor',
    status: true,
    isOnline: true,
    properties: { source: 'homebrain-zigbee' }
  }, {
    previousDevice: {
      _id: 'back-door-sensor',
      name: 'Back Door',
      type: 'sensor',
      status: false,
      isOnline: true,
      properties: { source: 'homebrain-zigbee' }
    }
  });

  assert.equal(result.triggered, true);
  assert.equal(result.zoneName, 'Back Door');
  assert.equal(result.sensorType, 'doorWindow');
  assert.equal(capturedTriggers.length, 1);
  assert.equal(capturedTriggers[0].zone.name, 'Back Door');
  assert.equal(capturedTriggers[0].options.triggeredZoneName, 'Back Door');
});

test('evaluateNativeSecuritySensorUpdate respects per-mode monitored zone flags', async (t) => {
  const originalGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalTriggerAlarm = securityAlarmService.triggerAlarm;
  const alarm = {
    alarmState: 'armedStay',
    zones: [{
      name: 'Back Door',
      deviceId: 'back-door-sensor',
      deviceType: 'doorWindow',
      enabled: true,
      armedStayEnabled: false,
      armedAwayEnabled: true,
      bypassed: false
    }]
  };
  const capturedTriggers = [];

  t.after(() => {
    SecurityAlarm.getMainAlarm = originalGetMainAlarm;
    securityAlarmService.triggerAlarm = originalTriggerAlarm;
  });

  SecurityAlarm.getMainAlarm = async () => alarm;
  securityAlarmService.triggerAlarm = async (zone, options) => {
    capturedTriggers.push({ zone, options });
    return { alarmState: 'triggered' };
  };

  const activeDoor = {
    _id: 'back-door-sensor',
    name: 'Back Door',
    type: 'sensor',
    status: true,
    isOnline: true,
    properties: { source: 'homebrain-zigbee' }
  };
  const previousDoor = {
    ...activeDoor,
    status: false
  };

  const stayResult = await securityAlarmService.evaluateNativeSecuritySensorUpdate(activeDoor, {
    previousDevice: previousDoor
  });

  assert.equal(stayResult.triggered, false);
  assert.equal(stayResult.reason, 'sensor_type_not_monitored_for_mode');
  assert.equal(capturedTriggers.length, 0);

  alarm.alarmState = 'armedAway';
  const awayResult = await securityAlarmService.evaluateNativeSecuritySensorUpdate(activeDoor, {
    previousDevice: previousDoor
  });

  assert.equal(awayResult.triggered, true);
  assert.equal(awayResult.zoneName, 'Back Door');
  assert.equal(capturedTriggers.length, 1);
});

test('shouldMonitorSensorTypeForAlarmState preserves legacy motion fallback and explicit mode flags', () => {
  assert.equal(
    securityAlarmService.shouldMonitorSensorTypeForAlarmState('armedStay', 'motion', { enabled: true }),
    false
  );
  assert.equal(
    securityAlarmService.shouldMonitorSensorTypeForAlarmState('armedAway', 'motion', { enabled: true }),
    true
  );
  assert.equal(
    securityAlarmService.shouldMonitorSensorTypeForAlarmState('armedStay', 'motion', {
      enabled: true,
      armedStayEnabled: true,
      armedAwayEnabled: false
    }),
    true
  );
  assert.equal(
    securityAlarmService.shouldMonitorSensorTypeForAlarmState('armedAway', 'motion', {
      enabled: true,
      armedStayEnabled: true,
      armedAwayEnabled: false
    }),
    false
  );
});

test('silenceHomeBrainAlarmOutputDevice falls back to mute after off actions fail', async (t) => {
  const originalControlDevice = deviceService.controlDevice;
  const capturedControls = [];

  t.after(() => {
    deviceService.controlDevice = originalControlDevice;
  });

  deviceService.controlDevice = async (deviceId, action, value, options = {}) => {
    capturedControls.push({
      deviceId,
      action,
      value,
      fallbackFrom: options.command?.fallbackFrom
    });

    if (action !== 'mute') {
      throw new Error(`${action} unsupported`);
    }

    return { _id: deviceId };
  };

  const result = await securityAlarmService.silenceHomeBrainAlarmOutputDevice({
    _id: 'zse50-siren',
    name: 'Siren',
    type: 'siren'
  });

  assert.equal(result.deviceId, 'zse50-siren');
  assert.equal(result.via, 'homebrain.mute');
  assert.deepEqual(capturedControls, [
    { deviceId: 'zse50-siren', action: 'alarm_off', value: null, fallbackFrom: undefined },
    { deviceId: 'zse50-siren', action: 'turn_off', value: false, fallbackFrom: 'alarm_off' },
    { deviceId: 'zse50-siren', action: 'mute', value: true, fallbackFrom: 'turn_off' }
  ]);
});

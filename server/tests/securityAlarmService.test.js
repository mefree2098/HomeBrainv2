const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
const SecurityAlarm = require('../models/SecurityAlarm');
const deviceService = require('../services/deviceService');
const securityAlarmService = require('../services/securityAlarmService');

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
        properties: {}
      },
      {
        _id: 'device-5',
        name: 'Garage Entry Lock',
        type: 'lock',
        room: 'Garage',
        status: true,
        isOnline: true,
        lastSeen: now,
        properties: {}
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

  const garageLock = status.doorLocks.find((lock) => lock.deviceId === 'device-5');
  assert.ok(garageLock);
  assert.equal(garageLock.stateLabel, 'Locked');
  assert.equal(garageLock.isLocked, true);
});

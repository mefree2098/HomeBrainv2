const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
const deviceService = require('../services/deviceService');
const deviceEnergySampleService = require('../services/deviceEnergySampleService');
const deviceUpdateEmitter = require('../services/deviceUpdateEmitter');
const insteonService = require('../services/insteonService');

test('controlDevice routes Insteon turn_on through insteon service and skips generic DB write path', async (t) => {
  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalTurnOn = insteonService.turnOn;

  t.after(() => {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    insteonService.turnOn = originalTurnOn;
  });

  const baseDevice = {
    _id: 'device-1',
    name: 'Kitchen Light',
    type: 'light',
    status: false,
    brightness: 67,
    isOnline: true,
    properties: {
      source: 'insteon',
      insteonAddress: '11.22.33',
      supportsBrightness: true
    }
  };

  let findByIdCalls = 0;
  Device.findById = async () => {
    findByIdCalls += 1;
    if (findByIdCalls === 1) {
      return { ...baseDevice };
    }
    return { ...baseDevice, status: true, brightness: 67 };
  };
  Device.findByIdAndUpdate = async () => {
    throw new Error('Device.findByIdAndUpdate should not be called for Insteon control path');
  };

  let receivedArgs = null;
  insteonService.turnOn = async (deviceId, brightness) => {
    receivedArgs = { deviceId, brightness };
    return { success: true, status: true, brightness, confirmed: true };
  };

  const updated = await deviceService.controlDevice('device-1', 'turn_on');
  assert.deepEqual(receivedArgs, { deviceId: 'device-1', brightness: 100 });
  assert.equal(updated.status, true);
  assert.equal(updated.brightness, 67);
});

test('controlDevice routes Insteon toggle to turnOff when current status is on', async (t) => {
  const originalFindById = Device.findById;
  const originalTurnOff = insteonService.turnOff;

  t.after(() => {
    Device.findById = originalFindById;
    insteonService.turnOff = originalTurnOff;
  });

  let findByIdCalls = 0;
  Device.findById = async () => {
    findByIdCalls += 1;
    if (findByIdCalls === 1) {
      return {
        _id: 'device-2',
        name: 'Hall Light',
        type: 'light',
        status: true,
        brightness: 100,
        isOnline: true,
        properties: {
          source: 'insteon',
          insteonAddress: 'AA.BB.CC'
        }
      };
    }
    return {
      _id: 'device-2',
      name: 'Hall Light',
      type: 'light',
      status: false,
      brightness: 0,
      isOnline: true,
      properties: {
        source: 'insteon',
        insteonAddress: 'AA.BB.CC'
      }
    };
  };

  let receivedDeviceId = null;
  insteonService.turnOff = async (deviceId) => {
    receivedDeviceId = deviceId;
    return { success: true, status: false, brightness: 0, confirmed: true };
  };

  const updated = await deviceService.controlDevice('device-2', 'toggle');
  assert.equal(receivedDeviceId, 'device-2');
  assert.equal(updated.status, false);
  assert.equal(updated.brightness, 0);
});

test('getAllDevices can force-refresh SmartThings lock devices before returning them', async (t) => {
  const originalFind = Device.find;
  const originalBulkWrite = Device.bulkWrite;
  const originalPollSmartThingsState = deviceService.pollSmartThingsState;
  const originalRecordSamplesForDevices = deviceEnergySampleService.recordSamplesForDevices;
  const originalEmit = deviceUpdateEmitter.emit;

  t.after(() => {
    Device.find = originalFind;
    Device.bulkWrite = originalBulkWrite;
    deviceService.pollSmartThingsState = originalPollSmartThingsState;
    deviceEnergySampleService.recordSamplesForDevices = originalRecordSamplesForDevices;
    deviceUpdateEmitter.emit = originalEmit;
  });

  const staleLock = {
    _id: 'device-3',
    name: 'Front Door Lock',
    type: 'lock',
    room: 'Entry',
    status: true,
    isOnline: true,
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-lock-1'
    }
  };

  const refreshedLock = {
    ...staleLock,
    status: false,
    lastSeen: new Date('2026-03-30T12:05:00.000Z')
  };

  const queries = [];
  let bulkOps = null;
  const emitted = [];
  let recordedSamples = null;

  Device.find = (query = {}) => {
    queries.push(query);
    if (query && query._id && query._id.$in) {
      const result = [refreshedLock];
      return Promise.resolve(result);
    }

    return {
      sort: async () => [queries.length === 1 ? staleLock : refreshedLock]
    };
  };
  Device.bulkWrite = async (ops) => {
    bulkOps = ops;
  };
  deviceService.pollSmartThingsState = async () => ({
    status: false,
    lastSeen: refreshedLock.lastSeen
  });
  deviceEnergySampleService.recordSamplesForDevices = async (devices) => {
    recordedSamples = devices;
    return { insertedCount: 1, skippedCount: 0 };
  };
  deviceUpdateEmitter.emit = (eventName, payload) => {
    emitted.push({ eventName, payload });
  };

  const devices = await deviceService.getAllDevices({ type: 'lock' }, { refreshSmartThings: true });

  assert.equal(queries.length, 3);
  assert.equal(queries[0].type, 'lock');
  assert.equal(queries[1]._id.$in[0], 'device-3');
  assert.equal(queries[2].type, 'lock');
  assert.ok(Array.isArray(bulkOps));
  assert.equal(bulkOps.length, 1);
  assert.equal(Array.isArray(recordedSamples), true);
  assert.equal(recordedSamples.length, 1);
  assert.equal(recordedSamples[0]._id, 'device-3');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].eventName, 'devices:update');
  assert.equal(devices.length, 1);
  assert.equal(devices[0].status, false);
});

test('updateDevice normalizes and deduplicates device groups', async (t) => {
  const originalFindById = Device.findById;
  const originalFindOne = Device.findOne;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalEmit = deviceUpdateEmitter.emit;

  t.after(() => {
    Device.findById = originalFindById;
    Device.findOne = originalFindOne;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    deviceUpdateEmitter.emit = originalEmit;
  });

  const existingDevice = {
    _id: 'device-4',
    name: 'Office Lamp',
    room: 'Office',
    isOnline: true
  };

  let persistedUpdate = null;
  Device.findById = async () => existingDevice;
  Device.findOne = async () => null;
  Device.findByIdAndUpdate = async (_deviceId, update) => {
    persistedUpdate = update;
    return {
      ...existingDevice,
      ...update
    };
  };
  deviceUpdateEmitter.emit = () => {};

  const updated = await deviceService.updateDevice('device-4', {
    groups: [' Interior Lights ', 'alarm shutdown', 'interior lights', '', 'Alarm Shutdown']
  });

  assert.deepEqual(persistedUpdate.groups, ['Interior Lights', 'alarm shutdown']);
  assert.deepEqual(updated.groups, ['Interior Lights', 'alarm shutdown']);
});

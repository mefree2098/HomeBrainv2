const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
const deviceService = require('../services/deviceService');
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

const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
const DeviceGroup = require('../models/DeviceGroup');
const deviceService = require('../services/deviceService');
const deviceEnergySampleService = require('../services/deviceEnergySampleService');
const deviceUpdateEmitter = require('../services/deviceUpdateEmitter');
const insteonService = require('../services/insteonService');
const harmonyService = require('../services/harmonyService');
const rainMachineService = require('../services/rainMachineService');
const directRadioService = require('../services/directRadioService');
const matterService = require('../services/matterService');

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

test('controlDevice skips Harmony refresh and verification when fast control options are set', async (t) => {
  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalEnsureHarmonyState = deviceService.ensureHarmonyState;
  const originalRefreshHarmonyOnlineStatus = deviceService.refreshHarmonyOnlineStatus;
  const originalControlHarmonyDevice = deviceService.controlHarmonyDevice;
  const originalPollHarmonyState = deviceService.pollHarmonyState;
  const originalEmit = deviceUpdateEmitter.emit;

  t.after(() => {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    deviceService.ensureHarmonyState = originalEnsureHarmonyState;
    deviceService.refreshHarmonyOnlineStatus = originalRefreshHarmonyOnlineStatus;
    deviceService.controlHarmonyDevice = originalControlHarmonyDevice;
    deviceService.pollHarmonyState = originalPollHarmonyState;
    deviceUpdateEmitter.emit = originalEmit;
  });

  const harmonyDevice = {
    _id: 'device-harmony-1',
    name: 'Master Bedroom TV',
    type: 'switch',
    status: false,
    isOnline: true,
    properties: {
      source: 'harmony',
      harmonyHubIp: '192.168.1.50',
      harmonyActivityId: '123456'
    }
  };

  let ensureHarmonyCalls = 0;
  let pollHarmonyCalls = 0;
  let controlHarmonyCalls = 0;
  const emitted = [];
  let persistedUpdate = null;

  Device.findById = async () => ({ ...harmonyDevice });
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdate = update;
    return {
      ...harmonyDevice,
      ...update,
      status: update.status,
      isOnline: update.isOnline
    };
  };
  deviceService.ensureHarmonyState = async () => {
    ensureHarmonyCalls += 1;
  };
  deviceService.refreshHarmonyOnlineStatus = async () => true;
  deviceService.controlHarmonyDevice = async (_device, _action, _value, updateData) => {
    controlHarmonyCalls += 1;
    updateData.isOnline = true;
  };
  deviceService.pollHarmonyState = async () => {
    pollHarmonyCalls += 1;
    return {
      status: false,
      isOnline: true
    };
  };
  deviceUpdateEmitter.emit = (eventName, payload) => {
    emitted.push({ eventName, payload });
  };

  const updated = await deviceService.controlDevice('device-harmony-1', 'turn_on', undefined, {
    skipIntegrationRefresh: true,
    skipPostActionVerification: true
  });

  assert.equal(ensureHarmonyCalls, 0);
  assert.equal(controlHarmonyCalls, 1);
  assert.equal(pollHarmonyCalls, 0);
  assert.equal(updated.status, true);
  assert.equal(updated.isOnline, true);
  assert.equal(persistedUpdate.status, true);
  assert.equal(persistedUpdate.isOnline, true);
  assert.equal(emitted.length >= 1, true);
});

test('controlDevice can require Harmony activity post-action verification', async (t) => {
  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalEnsureHarmonyState = deviceService.ensureHarmonyState;
  const originalRefreshHarmonyOnlineStatus = deviceService.refreshHarmonyOnlineStatus;
  const originalControlHarmonyDevice = deviceService.controlHarmonyDevice;
  const originalPollHarmonyState = deviceService.pollHarmonyState;
  const originalEmit = deviceUpdateEmitter.emit;

  t.after(() => {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    deviceService.ensureHarmonyState = originalEnsureHarmonyState;
    deviceService.refreshHarmonyOnlineStatus = originalRefreshHarmonyOnlineStatus;
    deviceService.controlHarmonyDevice = originalControlHarmonyDevice;
    deviceService.pollHarmonyState = originalPollHarmonyState;
    deviceUpdateEmitter.emit = originalEmit;
  });

  const harmonyDevice = {
    _id: 'device-harmony-verify',
    name: 'Bedroom Fire TV',
    type: 'switch',
    status: false,
    isOnline: true,
    properties: {
      source: 'harmony',
      harmonyHubIp: '192.168.1.50',
      harmonyActivityId: '987654'
    }
  };

  let persisted = false;
  Device.findById = async () => ({ ...harmonyDevice });
  Device.findByIdAndUpdate = async () => {
    persisted = true;
    return { ...harmonyDevice, status: true };
  };
  deviceService.ensureHarmonyState = async () => {};
  deviceService.refreshHarmonyOnlineStatus = async () => true;
  deviceService.controlHarmonyDevice = async (_device, _action, _value, updateData) => {
    updateData.isOnline = true;
  };
  deviceService.pollHarmonyState = async () => ({
    status: false,
    isOnline: true
  });
  deviceUpdateEmitter.emit = () => {};

  await assert.rejects(
    () => deviceService.controlDevice('device-harmony-verify', 'turn_on', undefined, {
      requirePostActionVerification: true,
      harmonyVerificationTimeoutMs: 0
    }),
    /Harmony activity verification failed/
  );
  assert.equal(persisted, false);
});

test('controlDevice waits for Harmony activity verification to settle when required', async (t) => {
  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalEnsureHarmonyState = deviceService.ensureHarmonyState;
  const originalRefreshHarmonyOnlineStatus = deviceService.refreshHarmonyOnlineStatus;
  const originalControlHarmonyDevice = deviceService.controlHarmonyDevice;
  const originalPollHarmonyState = deviceService.pollHarmonyState;
  const originalEmit = deviceUpdateEmitter.emit;
  const originalSetTimeout = global.setTimeout;

  t.after(() => {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    deviceService.ensureHarmonyState = originalEnsureHarmonyState;
    deviceService.refreshHarmonyOnlineStatus = originalRefreshHarmonyOnlineStatus;
    deviceService.controlHarmonyDevice = originalControlHarmonyDevice;
    deviceService.pollHarmonyState = originalPollHarmonyState;
    deviceUpdateEmitter.emit = originalEmit;
    global.setTimeout = originalSetTimeout;
  });

  const harmonyDevice = {
    _id: 'device-harmony-delayed-verify',
    name: 'Bedroom Fire TV',
    type: 'switch',
    status: false,
    isOnline: true,
    properties: {
      source: 'harmony',
      harmonyHubIp: '192.168.1.50',
      harmonyActivityId: '987654'
    }
  };

  let pollCalls = 0;
  const timeoutDelays = [];
  let persistedUpdate = null;

  Device.findById = async () => ({ ...harmonyDevice });
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdate = update;
    return { ...harmonyDevice, ...update };
  };
  deviceService.ensureHarmonyState = async () => {};
  deviceService.refreshHarmonyOnlineStatus = async () => true;
  deviceService.controlHarmonyDevice = async (_device, _action, _value, updateData) => {
    updateData.isOnline = true;
  };
  deviceService.pollHarmonyState = async () => {
    pollCalls += 1;
    return {
      status: pollCalls >= 2,
      isOnline: true
    };
  };
  deviceUpdateEmitter.emit = () => {};
  global.setTimeout = (handler, delay, ...args) => {
    timeoutDelays.push(delay);
    if (typeof handler === 'function') {
      handler(...args);
    }
    return 0;
  };

  const updated = await deviceService.controlDevice('device-harmony-delayed-verify', 'turn_on', undefined, {
    requirePostActionVerification: true,
    harmonyVerificationTimeoutMs: 10_000,
    harmonyVerificationIntervalMs: 2_500
  });

  assert.equal(pollCalls, 2);
  assert.deepEqual(timeoutDelays, [2_500]);
  assert.equal(updated.status, true);
  assert.equal(persistedUpdate.status, true);
});

test('controlDevice rejects stale SmartThings post-action verification when required', async (t) => {
  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalEnsureSmartThingsState = deviceService.ensureSmartThingsState;
  const originalRefreshSmartThingsOnlineStatus = deviceService.refreshSmartThingsOnlineStatus;
  const originalControlSmartThingsDevice = deviceService.controlSmartThingsDevice;
  const originalPollSmartThingsState = deviceService.pollSmartThingsState;
  const originalEmit = deviceUpdateEmitter.emit;

  t.after(() => {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    deviceService.ensureSmartThingsState = originalEnsureSmartThingsState;
    deviceService.refreshSmartThingsOnlineStatus = originalRefreshSmartThingsOnlineStatus;
    deviceService.controlSmartThingsDevice = originalControlSmartThingsDevice;
    deviceService.pollSmartThingsState = originalPollSmartThingsState;
    deviceUpdateEmitter.emit = originalEmit;
  });

  const smartThingsDevice = {
    _id: 'device-smartthings-stale',
    name: 'Driveway Lights',
    type: 'light',
    status: false,
    brightness: 0,
    isOnline: true,
    properties: {
      source: 'smartthings',
      smartThingsDeviceId: 'smartthings-driveway',
      smartThingsCapabilities: ['switch']
    }
  };

  let persisted = false;
  Device.findById = async () => ({ ...smartThingsDevice });
  Device.findByIdAndUpdate = async () => {
    persisted = true;
    return { ...smartThingsDevice, status: true };
  };
  deviceService.ensureSmartThingsState = async () => {};
  deviceService.refreshSmartThingsOnlineStatus = async () => true;
  deviceService.controlSmartThingsDevice = async (_device, _action, _value, updateData) => {
    updateData.status = true;
  };
  deviceService.pollSmartThingsState = async () => ({
    status: true,
    isOnline: true,
    lastSeen: new Date('2025-12-08T03:48:58.309Z'),
    'properties.smartThingsAttributeMetadata': {
      byComponent: {
        main: {
          switch: {
            switch: {
              value: 'on',
              timestamp: '2025-12-08T03:48:58.309Z'
            }
          }
        }
      }
    },
    'properties.smartThingsHealthState': {
      state: 'ONLINE',
      lastUpdatedDate: '2025-12-08T03:48:58.309Z'
    }
  });
  deviceUpdateEmitter.emit = () => {};

  await assert.rejects(
    () => deviceService.controlDevice('device-smartthings-stale', 'turn_on', undefined, {
      requirePostActionVerification: true
    }),
    /SmartThings verification returned stale state/
  );
  assert.equal(persisted, false);
});

test('controlDevice routes HomeBrain Zigbee commands through the direct radio service', async (t) => {
  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalControlDevice = directRadioService.controlDevice;
  const originalRefreshDirectDeviceState = directRadioService.refreshDirectDeviceState;
  const originalRecordSamplesForDevices = deviceEnergySampleService.recordSamplesForDevices;
  const originalEmit = deviceUpdateEmitter.emit;
  const originalEnsureSmartThingsState = deviceService.ensureSmartThingsState;
  const originalControlSmartThingsDevice = deviceService.controlSmartThingsDevice;

  t.after(() => {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    directRadioService.controlDevice = originalControlDevice;
    directRadioService.refreshDirectDeviceState = originalRefreshDirectDeviceState;
    deviceEnergySampleService.recordSamplesForDevices = originalRecordSamplesForDevices;
    deviceUpdateEmitter.emit = originalEmit;
    deviceService.ensureSmartThingsState = originalEnsureSmartThingsState;
    deviceService.controlSmartThingsDevice = originalControlSmartThingsDevice;
  });

  const nativeDevice = {
    _id: 'device-zigbee-switch',
    name: 'Native Zigbee Plug',
    type: 'switch',
    status: false,
    isOnline: true,
    properties: {
      source: 'homebrain-zigbee',
      homebrainDirect: {
        protocol: 'zigbee',
        ieeeAddr: '0x00124b0025aa55cc'
      },
      directRadioFeatures: ['switch', 'power'],
      smartThingsDeviceId: 'old-smartthings-id',
      smartThingsCapabilities: ['switch']
    }
  };

  let receivedCommand = null;
  let refreshOptions = null;
  let persistedUpdate = null;
  let sampledDeviceCount = 0;

  Device.findById = async () => ({ ...nativeDevice });
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdate = update;
    return { ...nativeDevice, ...update };
  };
  deviceService.ensureSmartThingsState = async () => {
    throw new Error('SmartThings refresh should not run for native direct-radio devices');
  };
  deviceService.controlSmartThingsDevice = async () => {
    throw new Error('SmartThings control should not run for native direct-radio devices');
  };
  directRadioService.controlDevice = async (device, action, commandValue, updateData) => {
    receivedCommand = {
      device,
      action,
      commandValue,
      updateData
    };
    updateData.status = true;
  };
  directRadioService.refreshDirectDeviceState = async (_device, options) => {
    refreshOptions = options;
    return {
      status: true,
      isOnline: true,
      power: 8.5
    };
  };
  deviceEnergySampleService.recordSamplesForDevices = async (devices) => {
    sampledDeviceCount = devices.length;
  };
  deviceUpdateEmitter.emit = () => {};

  const updated = await deviceService.controlDevice('device-zigbee-switch', 'turn_on');

  assert.equal(receivedCommand.device.name, 'Native Zigbee Plug');
  assert.equal(receivedCommand.action, 'turnon');
  assert.equal(receivedCommand.commandValue, true);
  assert.equal(refreshOptions.preserveCommandState.status, true);
  assert.equal(persistedUpdate.status, true);
  assert.equal(persistedUpdate.isOnline, true);
  assert.equal(persistedUpdate.power, 8.5);
  assert.equal(sampledDeviceCount, 1);
  assert.equal(updated.status, true);
});

test('controlDevice routes Matter commands through the Matter service and refreshes state', async (t) => {
  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalControlDevice = matterService.controlDevice;
  const originalRefreshMatterDeviceState = matterService.refreshMatterDeviceState;
  const originalRecordSamplesForDevices = deviceEnergySampleService.recordSamplesForDevices;
  const originalEmit = deviceUpdateEmitter.emit;

  t.after(() => {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    matterService.controlDevice = originalControlDevice;
    matterService.refreshMatterDeviceState = originalRefreshMatterDeviceState;
    deviceEnergySampleService.recordSamplesForDevices = originalRecordSamplesForDevices;
    deviceUpdateEmitter.emit = originalEmit;
  });

  const matterDevice = {
    _id: 'device-matter-light',
    name: 'Native Matter Light',
    type: 'light',
    status: false,
    brightness: 0,
    isOnline: true,
    properties: {
      source: 'homebrain-matter',
      matter: {
        nodeId: '44',
        endpointId: 1
      },
      matterFeatures: ['switch', 'brightness']
    }
  };

  let receivedCommand = null;
  let persistedUpdate = null;
  let sampledDeviceCount = 0;

  Device.findById = async () => ({ ...matterDevice });
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdate = update;
    return { ...matterDevice, ...update };
  };
  matterService.controlDevice = async (device, action, commandValue, updateData) => {
    receivedCommand = {
      device,
      action,
      commandValue,
      updateData
    };
    updateData.brightness = commandValue;
    updateData.status = commandValue > 0;
  };
  matterService.refreshMatterDeviceState = async () => ({
    status: true,
    brightness: 42,
    isOnline: true
  });
  deviceEnergySampleService.recordSamplesForDevices = async (devices) => {
    sampledDeviceCount = devices.length;
  };
  deviceUpdateEmitter.emit = () => {};

  const updated = await deviceService.controlDevice('device-matter-light', 'set_brightness', 42);

  assert.equal(receivedCommand.device.name, 'Native Matter Light');
  assert.equal(receivedCommand.action, 'setbrightness');
  assert.equal(receivedCommand.commandValue, 42);
  assert.equal(persistedUpdate.status, true);
  assert.equal(persistedUpdate.brightness, 42);
  assert.equal(persistedUpdate.isOnline, true);
  assert.equal(sampledDeviceCount, 1);
  assert.equal(updated.brightness, 42);
});

test('controlDevice routes RainMachine zone start actions through the RainMachine service', async (t) => {
  const originalFindById = Device.findById;
  const originalEnsureRainMachineState = deviceService.ensureRainMachineState;
  const originalStartZone = rainMachineService.startZone;

  t.after(() => {
    Device.findById = originalFindById;
    deviceService.ensureRainMachineState = originalEnsureRainMachineState;
    rainMachineService.startZone = originalStartZone;
  });

  let findByIdCalls = 0;
  Device.findById = async () => {
    findByIdCalls += 1;

    if (findByIdCalls === 1) {
      return {
        _id: 'rain-zone-1',
        name: 'Front Lawn',
        type: 'switch',
        status: false,
        isOnline: true,
        properties: {
          source: 'rainmachine',
          rainmachine: {
            entityType: 'zone',
            controllerId: 'AA:BB:CC',
            zoneId: 4
          }
        }
      };
    }

    return {
      _id: 'rain-zone-1',
      name: 'Front Lawn',
      type: 'switch',
      status: true,
      isOnline: true,
      properties: {
        source: 'rainmachine',
        rainmachine: {
          entityType: 'zone',
          controllerId: 'AA:BB:CC',
          zoneId: 4
        }
      }
    };
  };

  let startZoneArgs = null;
  deviceService.ensureRainMachineState = async () => {};
  rainMachineService.startZone = async (zoneId, durationSeconds) => {
    startZoneArgs = { zoneId, durationSeconds };
    return {
      dashboard: {}
    };
  };

  const updated = await deviceService.controlDevice('rain-zone-1', 'rainmachine_start_zone', {
    durationSeconds: 900
  });

  assert.deepEqual(startZoneArgs, {
    zoneId: 4,
    durationSeconds: 900
  });
  assert.equal(updated.status, true);
});

test('controlDevice routes Harmony raw devices through direct power commands and honors repeat-power settings', async (t) => {
  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalEnsureHarmonyState = deviceService.ensureHarmonyState;
  const originalSendPowerCommand = harmonyService.sendPowerCommand;
  const originalPollHarmonyState = deviceService.pollHarmonyState;
  const originalEmit = deviceUpdateEmitter.emit;

  t.after(() => {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    deviceService.ensureHarmonyState = originalEnsureHarmonyState;
    harmonyService.sendPowerCommand = originalSendPowerCommand;
    deviceService.pollHarmonyState = originalPollHarmonyState;
    deviceUpdateEmitter.emit = originalEmit;
  });

  const harmonyDevice = {
    _id: 'device-harmony-projector',
    name: 'Projector',
    type: 'switch',
    status: true,
    isOnline: true,
    properties: {
      source: 'harmony',
      harmonyEntityType: 'device',
      harmonyHubIp: '192.168.1.50',
      harmonyDeviceId: '55',
      harmonyRepeatPowerCommands: true
    }
  };

  let persistedUpdate = null;
  let sendPowerCommandArgs = null;
  let pollHarmonyCalls = 0;

  Device.findById = async () => ({ ...harmonyDevice });
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdate = update;
    return {
      ...harmonyDevice,
      ...update
    };
  };
  deviceService.ensureHarmonyState = async () => {};
  harmonyService.sendPowerCommand = async (hubIp, deviceId, desiredState, options) => {
    sendPowerCommandArgs = { hubIp, deviceId, desiredState, options };
    return { success: true };
  };
  deviceService.pollHarmonyState = async () => {
    pollHarmonyCalls += 1;
    return {
      status: true,
      isOnline: true
    };
  };
  deviceUpdateEmitter.emit = () => {};

  const updated = await deviceService.controlDevice('device-harmony-projector', 'turn_off');

  assert.deepEqual(sendPowerCommandArgs, {
    hubIp: '192.168.1.50',
    deviceId: '55',
    desiredState: 'off',
    options: {
      repeatCount: 2,
      allowToggleFallback: false
    }
  });
  assert.equal(pollHarmonyCalls, 0);
  assert.equal(updated.status, false);
  assert.equal(updated.isOnline, true);
  assert.equal(persistedUpdate.status, false);
  assert.equal(persistedUpdate.isOnline, true);
});

test('controlDevice routes Harmony raw device commands through sendDeviceCommand', async (t) => {
  const originalFindById = Device.findById;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalEnsureHarmonyState = deviceService.ensureHarmonyState;
  const originalSendDeviceCommand = harmonyService.sendDeviceCommand;
  const originalEmit = deviceUpdateEmitter.emit;

  t.after(() => {
    Device.findById = originalFindById;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    deviceService.ensureHarmonyState = originalEnsureHarmonyState;
    harmonyService.sendDeviceCommand = originalSendDeviceCommand;
    deviceUpdateEmitter.emit = originalEmit;
  });

  const harmonyDevice = {
    _id: 'device-harmony-receiver',
    name: 'Receiver',
    type: 'switch',
    status: true,
    isOnline: true,
    properties: {
      source: 'harmony',
      harmonyEntityType: 'device',
      harmonyHubIp: '192.168.1.50',
      harmonyDeviceId: '91'
    }
  };

  let persistedUpdate = null;
  let sendDeviceCommandArgs = null;

  Device.findById = async () => ({ ...harmonyDevice });
  Device.findByIdAndUpdate = async (_id, update) => {
    persistedUpdate = update;
    return {
      ...harmonyDevice,
      ...update
    };
  };
  deviceService.ensureHarmonyState = async () => {};
  harmonyService.sendDeviceCommand = async (hubIp, deviceId, command, holdMs) => {
    sendDeviceCommandArgs = { hubIp, deviceId, command, holdMs };
    return { success: true };
  };
  deviceUpdateEmitter.emit = () => {};

  const updated = await deviceService.controlDevice('device-harmony-receiver', 'harmony_command', {
    command: 'VolumeUp',
    holdMs: 250
  });

  assert.deepEqual(sendDeviceCommandArgs, {
    hubIp: '192.168.1.50',
    deviceId: '91',
    command: 'VolumeUp',
    holdMs: 250
  });
  assert.equal(updated.status, true);
  assert.equal(updated.isOnline, true);
  assert.equal(Object.prototype.hasOwnProperty.call(persistedUpdate, 'status'), false);
  assert.equal(persistedUpdate.isOnline, true);
});

test('supportsBrightnessControl treats fan-labeled Insteon devices like fader switches', () => {
  const supportsBrightness = deviceService.supportsBrightnessControl({
    _id: 'device-fan',
    name: 'Master Toilet Fan',
    type: 'switch',
    properties: {
      source: 'insteon',
      insteonAddress: '38.8A.57',
      deviceCategory: 2,
      supportsBrightness: false
    }
  });

  assert.equal(supportsBrightness, true);
});

test('createDevice rejects a duplicate INSTEON address even when the formatting differs', async (t) => {
  const originalFindOne = Device.findOne;

  t.after(() => {
    Device.findOne = originalFindOne;
  });

  const queries = [];
  Device.findOne = async (query) => {
    queries.push(query);
    if (query.name && query.room) {
      return null;
    }

    return {
      _id: 'device-existing',
      name: 'Master Toilet Fan',
      properties: {
        source: 'insteon',
        insteonAddress: '388A57'
      }
    };
  };

  await assert.rejects(
    () => deviceService.createDevice({
      name: 'Manual Fan Duplicate',
      type: 'light',
      room: 'Primary Bath',
      properties: {
        source: 'insteon',
        insteonAddress: '38.8A.57'
      }
    }),
    /INSTEON address already exists/i
  );

  assert.equal(queries.length, 2);
});

test('createDevice rejects a duplicate SmartThings device ID', async (t) => {
  const originalFindOne = Device.findOne;

  t.after(() => {
    Device.findOne = originalFindOne;
  });

  Device.findOne = async (query) => {
    if (query.name && query.room) {
      return null;
    }

    assert.equal(query['properties.smartThingsDeviceId'], 'smartthings-device-1');
    return {
      _id: 'device-existing',
      name: 'Front Porch Light',
      properties: {
        smartThingsDeviceId: 'smartthings-device-1'
      }
    };
  };

  await assert.rejects(
    () => deviceService.createDevice({
      name: 'Manual SmartThings Duplicate',
      type: 'light',
      room: 'Porch',
      properties: {
        source: 'SmartThings',
        smartThingsDeviceId: ' smartthings-device-1 '
      }
    }),
    /SmartThings device ID already exists/i
  );
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
  assert.equal(queries[0].$and[0].type, 'lock');
  assert.match(JSON.stringify(queries[0]), /harmonyExcludeFromHomeBrain/);
  assert.equal(queries[1]._id.$in[0], 'device-3');
  assert.equal(queries[2].$and[0].type, 'lock');
  assert.match(JSON.stringify(queries[2]), /harmonyExcludeFromHomeBrain/);
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

test('getAllDevices hides Harmony devices excluded from HomeBrain unless explicitly requested', async (t) => {
  const originalFind = Device.find;

  t.after(() => {
    Device.find = originalFind;
  });

  const queries = [];

  Device.find = (query = {}) => {
    queries.push(query);
    return {
      sort: async () => []
    };
  };

  await deviceService.getAllDevices({ source: 'harmony' });
  await deviceService.getAllDevices({ source: 'harmony' }, { includeExcludedHarmony: true });

  assert.equal(queries.length, 2);
  assert.match(JSON.stringify(queries[0]), /harmonyExcludeFromHomeBrain/);
  assert.doesNotMatch(JSON.stringify(queries[1]), /harmonyExcludeFromHomeBrain/);
});

test('scheduleIntegrationRefresh coalesces concurrent background refreshes', async (t) => {
  const originalEnsureIntegrationState = deviceService.ensureIntegrationState;
  const originalIntegrationRefreshPromise = deviceService.integrationRefreshPromise;
  const originalLastIntegrationRefreshScheduledAt = deviceService.lastIntegrationRefreshScheduledAt;
  const originalIntegrationRefreshDebounceMs = deviceService.integrationRefreshDebounceMs;
  let refreshCalls = 0;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });

  t.after(() => {
    deviceService.ensureIntegrationState = originalEnsureIntegrationState;
    deviceService.integrationRefreshPromise = originalIntegrationRefreshPromise;
    deviceService.lastIntegrationRefreshScheduledAt = originalLastIntegrationRefreshScheduledAt;
    deviceService.integrationRefreshDebounceMs = originalIntegrationRefreshDebounceMs;
  });

  deviceService.integrationRefreshPromise = null;
  deviceService.lastIntegrationRefreshScheduledAt = 0;
  deviceService.integrationRefreshDebounceMs = 1000;
  deviceService.ensureIntegrationState = async () => {
    refreshCalls += 1;
    await refreshGate;
  };

  const firstRefresh = deviceService.scheduleIntegrationRefresh({ reason: 'test-first' });
  const secondRefresh = deviceService.scheduleIntegrationRefresh({ reason: 'test-second' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstRefresh, secondRefresh);
  assert.equal(refreshCalls, 1);

  releaseRefresh();
  await Promise.all([firstRefresh, secondRefresh]);

  assert.equal(deviceService.integrationRefreshPromise, null);
});

test('updateDevice normalizes and deduplicates device groups', async (t) => {
  const originalFindById = Device.findById;
  const originalFindOne = Device.findOne;
  const originalFindByIdAndUpdate = Device.findByIdAndUpdate;
  const originalDeviceGroupFind = DeviceGroup.find;
  const originalEmit = deviceUpdateEmitter.emit;

  t.after(() => {
    Device.findById = originalFindById;
    Device.findOne = originalFindOne;
    Device.findByIdAndUpdate = originalFindByIdAndUpdate;
    DeviceGroup.find = originalDeviceGroupFind;
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
  DeviceGroup.find = () => ({
    lean: async () => [
      { normalizedName: 'interior lights' },
      { normalizedName: 'alarm shutdown' }
    ]
  });
  deviceUpdateEmitter.emit = () => {};

  const updated = await deviceService.updateDevice('device-4', {
    groups: [' Interior Lights ', 'alarm shutdown', 'interior lights', '', 'Alarm Shutdown']
  });

  assert.deepEqual(persistedUpdate.groups, ['Interior Lights', 'alarm shutdown']);
  assert.deepEqual(updated.groups, ['Interior Lights', 'alarm shutdown']);
});

test('updateDevice rejects a duplicate Tempest station identity', async (t) => {
  const originalFindById = Device.findById;
  const originalFindOne = Device.findOne;

  t.after(() => {
    Device.findById = originalFindById;
    Device.findOne = originalFindOne;
  });

  Device.findById = async () => ({
    _id: 'device-5',
    name: 'Backyard Weather',
    room: 'Outside',
    properties: {}
  });

  Device.findOne = async (query) => {
    assert.equal(Array.isArray(query['properties.tempest.stationId'].$in), true);
    assert.equal(query['properties.tempest.stationId'].$in.includes(42), true);
    assert.equal(query._id.$ne, 'device-5');

    return {
      _id: 'tempest-existing',
      name: 'Existing Tempest Station'
    };
  };

  await assert.rejects(
    () => deviceService.updateDevice('device-5', {
      properties: {
        source: 'tempest',
        tempest: {
          stationId: '42'
        }
      }
    }),
    /Tempest station ID already exists/i
  );
});

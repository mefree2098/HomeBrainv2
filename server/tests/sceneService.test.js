const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const Scene = require('../models/Scene');
const Device = require('../models/Device');
const DeviceGroup = require('../models/DeviceGroup');
const sceneService = require('../services/sceneService');
const workflowExecutionService = require('../services/workflowExecutionService');

test('createScene accepts validated device and group actions', async (t) => {
  const originalDeviceFindById = Device.findById;
  const originalDeviceGroupFindById = DeviceGroup.findById;
  const originalSave = Scene.prototype.save;
  const originalPopulate = Scene.prototype.populate;

  t.after(() => {
    Device.findById = originalDeviceFindById;
    DeviceGroup.findById = originalDeviceGroupFindById;
    Scene.prototype.save = originalSave;
    Scene.prototype.populate = originalPopulate;
  });

  const deviceId = new mongoose.Types.ObjectId().toString();
  const groupId = new mongoose.Types.ObjectId().toString();

  Device.findById = async (id) => (id === deviceId ? { _id: deviceId, name: 'Lamp' } : null);
  DeviceGroup.findById = async (id) => (id === groupId ? { _id: groupId, name: 'Whole Home Lights' } : null);
  Scene.prototype.save = async function save() {
    return this;
  };
  Scene.prototype.populate = async function populate() {
    return this;
  };

  const result = await sceneService.createScene({
    name: 'Movie Night',
    description: 'Dim the house',
    deviceActions: [
      {
        deviceId,
        action: 'set_brightness',
        brightness: 42
      }
    ],
    groupActions: [
      {
        groupId,
        action: 'turn_on'
      }
    ]
  });

  assert.equal(result.name, 'Movie Night');
  assert.equal(result.deviceActions.length, 1);
  assert.equal(result.deviceActions[0].value, 42);
  assert.equal(result.groupActions.length, 1);
  assert.equal(result.groupActions[0].groupId.toString(), groupId);
});

test('activateScene executes device and group actions through workflow execution', async (t) => {
  const originalUpdateMany = Scene.updateMany;
  const originalFindById = Scene.findById;
  const originalExecuteActionSequence = workflowExecutionService.executeActionSequence;

  t.after(() => {
    Scene.updateMany = originalUpdateMany;
    Scene.findById = originalFindById;
    workflowExecutionService.executeActionSequence = originalExecuteActionSequence;
  });

  const sceneId = new mongoose.Types.ObjectId().toString();
  const deviceId = new mongoose.Types.ObjectId().toString();
  const groupId = new mongoose.Types.ObjectId().toString();
  let receivedActions = null;
  let updateManyCalled = false;

  const sceneDoc = {
    _id: sceneId,
    name: 'Evening Shutdown',
    active: false,
    activationCount: 0,
    lastActivated: null,
    deviceActions: [
      {
        deviceId,
        action: 'set_brightness',
        value: 37
      }
    ],
    groupActions: [
      {
        groupId,
        action: 'turn_off',
        value: null
      }
    ],
    async save() {
      return this;
    },
    async populate(path) {
      if (String(path).startsWith('deviceActions')) {
        this.deviceActions = [
          {
            deviceId: {
              _id: deviceId,
              name: 'Hall Lamp'
            },
            action: 'set_brightness',
            value: 37
          }
        ];
      }

      if (String(path).startsWith('groupActions')) {
        this.groupActions = [
          {
            groupId: {
              _id: groupId,
              name: 'Whole Home Lights'
            },
            action: 'turn_off',
            value: null
          }
        ];
      }

      return this;
    }
  };

  Scene.updateMany = async () => {
    updateManyCalled = true;
    throw new Error('activateScene should not deactivate other scenes');
  };
  Scene.findById = async () => sceneDoc;
  workflowExecutionService.executeActionSequence = async (actions) => {
    receivedActions = actions;
    return {
      status: 'success',
      successfulActions: 2,
      failedActions: 0,
      actionResults: [
        {
          actionIndex: 0,
          success: true,
          target: deviceId,
          message: 'Device action executed'
        },
        {
          actionIndex: 1,
          success: true,
          target: {
            kind: 'device_group',
            group: 'Whole Home Lights'
          },
          message: 'Group action executed',
          details: {
            group: 'Whole Home Lights',
            executionMode: 'nested_group_plan'
          }
        }
      ]
    };
  };

  const result = await sceneService.activateScene(sceneId);

  assert.ok(Array.isArray(receivedActions));
  assert.equal(receivedActions.length, 2);
  assert.equal(receivedActions[0].target, deviceId);
  assert.equal(receivedActions[0].parameters.action, 'set_brightness');
  assert.equal(receivedActions[0].parameters.value, 37);
  assert.equal(receivedActions[0].parameters.brightness, 37);
  assert.equal(receivedActions[1].target.kind, 'device_group');
  assert.equal(receivedActions[1].target.group, groupId);
  assert.equal(updateManyCalled, false);
  assert.equal(sceneDoc.active, true);
  assert.equal(sceneDoc.activationCount, 1);
  assert.equal(result.deviceActions.length, 1);
  assert.equal(result.deviceActions[0].deviceName, 'Hall Lamp');
  assert.equal(result.deviceActions[0].value, 37);
  assert.equal(result.groupActions.length, 1);
  assert.equal(result.groupActions[0].groupName, 'Whole Home Lights');
  assert.equal(result.status, 'success');
});

test('deactivateScene turns off safe scene actions without reversing already-off or locked actions', async (t) => {
  const originalFindById = Scene.findById;
  const originalExecuteActionSequence = workflowExecutionService.executeActionSequence;

  t.after(() => {
    Scene.findById = originalFindById;
    workflowExecutionService.executeActionSequence = originalExecuteActionSequence;
  });

  const sceneId = new mongoose.Types.ObjectId().toString();
  const dimmerId = new mongoose.Types.ObjectId().toString();
  const switchId = new mongoose.Types.ObjectId().toString();
  const shadesGroupId = new mongoose.Types.ObjectId().toString();
  const doorsGroupId = new mongoose.Types.ObjectId().toString();
  let receivedActions = null;

  const sceneDoc = {
    _id: sceneId,
    name: 'Evening',
    active: true,
    activationCount: 5,
    deviceActions: [
      {
        deviceId: dimmerId,
        action: 'set_brightness',
        value: 37
      },
      {
        deviceId: switchId,
        action: 'turn_off',
        value: null
      }
    ],
    groupActions: [
      {
        groupId: shadesGroupId,
        action: 'open',
        value: null
      },
      {
        groupId: doorsGroupId,
        action: 'lock',
        value: null
      }
    ],
    async save() {
      return this;
    },
    async populate(path) {
      if (String(path).startsWith('deviceActions')) {
        this.deviceActions = [
          {
            deviceId: {
              _id: dimmerId,
              name: 'Living Room Dimmer'
            },
            action: 'set_brightness',
            value: 37
          },
          {
            deviceId: {
              _id: switchId,
              name: 'Porch Switch'
            },
            action: 'turn_off',
            value: null
          }
        ];
      }

      if (String(path).startsWith('groupActions')) {
        this.groupActions = [
          {
            groupId: {
              _id: shadesGroupId,
              name: 'Main Shades'
            },
            action: 'open',
            value: null
          },
          {
            groupId: {
              _id: doorsGroupId,
              name: 'Door Locks'
            },
            action: 'lock',
            value: null
          }
        ];
      }

      return this;
    }
  };

  Scene.findById = async () => sceneDoc;
  workflowExecutionService.executeActionSequence = async (actions) => {
    receivedActions = actions;
    return {
      status: 'success',
      successfulActions: 2,
      failedActions: 0,
      actionResults: [
        {
          actionIndex: 0,
          success: true,
          target: dimmerId,
          message: 'Device action executed'
        },
        {
          actionIndex: 1,
          success: true,
          target: {
            kind: 'device_group',
            group: 'Main Shades'
          },
          message: 'Group action executed',
          details: {
            group: 'Main Shades'
          }
        }
      ]
    };
  };

  const result = await sceneService.deactivateScene(sceneId);

  assert.equal(sceneDoc.active, false);
  assert.equal(sceneDoc.activationCount, 5);
  assert.equal(receivedActions.length, 2);
  assert.equal(receivedActions[0].target, dimmerId);
  assert.equal(receivedActions[0].parameters.action, 'turn_off');
  assert.equal(receivedActions[0].parameters.value, null);
  assert.equal(receivedActions[1].target.kind, 'device_group');
  assert.equal(receivedActions[1].target.group, shadesGroupId);
  assert.equal(receivedActions[1].parameters.action, 'close');
  assert.equal(result.deviceActions.length, 1);
  assert.equal(result.deviceActions[0].deviceName, 'Living Room Dimmer');
  assert.equal(result.groupActions.length, 1);
  assert.equal(result.groupActions[0].groupName, 'Main Shades');
  assert.equal(result.status, 'success');
});

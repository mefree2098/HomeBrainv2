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
        action: 'turn_off'
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

  const sceneDoc = {
    _id: sceneId,
    name: 'Evening Shutdown',
    active: false,
    activationCount: 0,
    lastActivated: null,
    deviceActions: [
      {
        deviceId,
        action: 'turn_off',
        value: null
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
            action: 'turn_off',
            value: null
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

  Scene.updateMany = async () => ({ acknowledged: true });
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
  assert.equal(receivedActions[1].target.kind, 'device_group');
  assert.equal(receivedActions[1].target.group, groupId);
  assert.equal(result.deviceActions.length, 1);
  assert.equal(result.deviceActions[0].deviceName, 'Hall Lamp');
  assert.equal(result.groupActions.length, 1);
  assert.equal(result.groupActions[0].groupName, 'Whole Home Lights');
  assert.equal(result.status, 'success');
});

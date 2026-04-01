const test = require('node:test');
const assert = require('node:assert/strict');

const Device = require('../models/Device');
const DeviceGroup = require('../models/DeviceGroup');
const Workflow = require('../models/Workflow');
const Automation = require('../models/Automation');
const deviceGroupService = require('../services/deviceGroupService');
const deviceUpdateEmitter = require('../services/deviceUpdateEmitter');

const GROUP_ID = '507f191e810c19729de860ac';
const EMPTY_GROUP_ID = '507f191e810c19729de860ad';
const DEVICE_ID = '507f191e810c19729de860aa';

test('listGroups returns persisted groups with membership and workflow usage details', async (t) => {
  const originalDeviceFind = Device.find;
  const originalDeviceGroupFind = DeviceGroup.find;
  const originalWorkflowFind = Workflow.find;
  const originalAutomationFind = Automation.find;

  t.after(() => {
    Device.find = originalDeviceFind;
    DeviceGroup.find = originalDeviceGroupFind;
    Workflow.find = originalWorkflowFind;
    Automation.find = originalAutomationFind;
  });

  const devices = [
    {
      _id: DEVICE_ID,
      name: 'Hall Light',
      room: 'Hall',
      type: 'light',
      groups: ['Interior Lights'],
      properties: { source: 'insteon' }
    },
    {
      _id: '507f191e810c19729de860ab',
      name: 'Kitchen Light',
      room: 'Kitchen',
      type: 'light',
      groups: ['Interior Lights'],
      properties: { source: 'smartthings' }
    }
  ];
  const groups = [
    {
      _id: GROUP_ID,
      name: 'Interior Lights',
      normalizedName: 'interior lights',
      description: 'Lights that should be controlled together',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-01T00:05:00.000Z')
    },
    {
      _id: EMPTY_GROUP_ID,
      name: 'Empty Group',
      normalizedName: 'empty group',
      description: '',
      createdAt: new Date('2026-04-01T00:10:00.000Z'),
      updatedAt: new Date('2026-04-01T00:10:00.000Z')
    }
  ];

  Device.find = () => ({
    lean: async () => devices
  });
  DeviceGroup.find = () => ({
    lean: async () => groups,
    sort() {
      return {
        lean: async () => groups
      };
    }
  });
  Workflow.find = () => ({
    select() {
      return {
        lean: async () => [
          {
            _id: '507f191e810c19729de860ba',
            name: 'Alarm Armed Lights Off',
            actions: [
              {
                type: 'device_control',
                target: { kind: 'device_group', group: 'Interior Lights' }
              }
            ],
            graph: null
          }
        ]
      };
    }
  });
  Automation.find = () => ({
    select() {
      return {
        lean: async () => [
          {
            _id: '507f191e810c19729de860bb',
            name: 'Standalone Interior Lights Off',
            actions: [
              {
                type: 'device_control',
                target: { kind: 'device_group', group: 'Interior Lights' }
              }
            ],
            workflowGraph: null
          }
        ]
      };
    }
  });

  const result = await deviceGroupService.listGroups();
  assert.equal(result.length, 2);

  const interiorLights = result.find((group) => group._id === GROUP_ID);
  assert.ok(interiorLights);
  assert.equal(interiorLights.description, 'Lights that should be controlled together');
  assert.equal(interiorLights.deviceCount, 2);
  assert.deepEqual(interiorLights.deviceIds, [DEVICE_ID, '507f191e810c19729de860ab']);
  assert.deepEqual(interiorLights.rooms, ['Hall', 'Kitchen']);
  assert.deepEqual(interiorLights.sources, ['insteon', 'smartthings']);
  assert.equal(interiorLights.workflowUsageCount, 1);
  assert.equal(interiorLights.automationUsageCount, 1);
  assert.deepEqual(interiorLights.workflowNames, ['Alarm Armed Lights Off']);
  assert.deepEqual(interiorLights.automationNames, ['Standalone Interior Lights Off']);

  const emptyGroup = result.find((group) => group._id === EMPTY_GROUP_ID);
  assert.ok(emptyGroup);
  assert.equal(emptyGroup.deviceCount, 0);
  assert.deepEqual(emptyGroup.deviceIds, []);
});

test('DeviceGroup model normalizes the name during validation', async () => {
  const group = new DeviceGroup({
    name: '  Interior Lights  ',
    description: 'Lights that should be controlled together'
  });

  await group.validate();

  assert.equal(group.name, 'Interior Lights');
  assert.equal(group.normalizedName, 'interior lights');
});

test('updateGroup renames the group across devices, workflows, and standalone automations', async (t) => {
  const originalDeviceFind = Device.find;
  const originalDeviceBulkWrite = Device.bulkWrite;
  const originalDeviceGroupFindById = DeviceGroup.findById;
  const originalDeviceGroupFindOne = DeviceGroup.findOne;
  const originalWorkflowFind = Workflow.find;
  const originalWorkflowFindByIdAndUpdate = Workflow.findByIdAndUpdate;
  const originalAutomationFind = Automation.find;
  const originalAutomationFindByIdAndUpdate = Automation.findByIdAndUpdate;
  const originalNormalizeDevices = deviceUpdateEmitter.normalizeDevices;
  const originalEmit = deviceUpdateEmitter.emit;
  const originalGetGroupById = deviceGroupService.getGroupById;

  t.after(() => {
    Device.find = originalDeviceFind;
    Device.bulkWrite = originalDeviceBulkWrite;
    DeviceGroup.findById = originalDeviceGroupFindById;
    DeviceGroup.findOne = originalDeviceGroupFindOne;
    Workflow.find = originalWorkflowFind;
    Workflow.findByIdAndUpdate = originalWorkflowFindByIdAndUpdate;
    Automation.find = originalAutomationFind;
    Automation.findByIdAndUpdate = originalAutomationFindByIdAndUpdate;
    deviceUpdateEmitter.normalizeDevices = originalNormalizeDevices;
    deviceUpdateEmitter.emit = originalEmit;
    deviceGroupService.getGroupById = originalGetGroupById;
  });

  let savedName = null;
  let savedDescription = null;
  let deviceBulkOps = null;
  let workflowUpdate = null;
  let automationUpdate = null;
  const emittedEvents = [];

  DeviceGroup.findById = async () => ({
    _id: GROUP_ID,
    name: 'Interior Lights',
    normalizedName: 'interior lights',
    description: 'Original description',
    async save() {
      savedName = this.name;
      savedDescription = this.description;
    }
  });
  DeviceGroup.findOne = async () => null;
  Device.find = (query = {}) => {
    if (query && query.groups) {
      return {
        lean: async () => [
          {
            _id: DEVICE_ID,
            name: 'Hall Light',
            groups: ['Interior Lights', 'Security'],
            updatedAt: new Date('2026-04-01T00:00:00.000Z')
          }
        ]
      };
    }

    if (query && query._id && query._id.$in) {
      return Promise.resolve([
        {
          _id: DEVICE_ID,
          name: 'Hall Light',
          groups: ['Whole Home Lights', 'Security']
        }
      ]);
    }

    return {
      lean: async () => []
    };
  };
  Device.bulkWrite = async (ops) => {
    deviceBulkOps = ops;
  };
  Workflow.find = () => ({
    lean: async () => [
      {
        _id: '507f191e810c19729de860ca',
        actions: [
          {
            type: 'device_control',
            target: { kind: 'device_group', group: 'Interior Lights' }
          }
        ],
        graph: {
          nodes: [
            {
              id: 'action-1',
              data: {
                target: { kind: 'device_group', group: 'Interior Lights' }
              }
            }
          ]
        }
      }
    ]
  });
  Workflow.findByIdAndUpdate = async (_id, update) => {
    workflowUpdate = update;
  };
  Automation.find = () => ({
    lean: async () => [
      {
        _id: '507f191e810c19729de860cb',
        actions: [
          {
            type: 'device_control',
            target: { kind: 'device_group', group: 'Interior Lights' }
          }
        ],
        workflowGraph: {
          nodes: [
            {
              id: 'action-1',
              data: {
                target: { kind: 'device_group', group: 'Interior Lights' }
              }
            }
          ]
        }
      }
    ]
  });
  Automation.findByIdAndUpdate = async (_id, update) => {
    automationUpdate = update;
  };
  deviceUpdateEmitter.normalizeDevices = (devices) => devices;
  deviceUpdateEmitter.emit = (eventName, payload) => {
    emittedEvents.push({ eventName, payload });
  };
  deviceGroupService.getGroupById = async () => ({
    _id: GROUP_ID,
    name: 'Whole Home Lights',
    normalizedName: 'whole home lights',
    description: 'All interior and accent lights',
    deviceCount: 1,
    deviceIds: [DEVICE_ID],
    workflowUsageCount: 1,
    automationUsageCount: 1,
    workflowNames: ['Alarm Armed Lights Off'],
    automationNames: ['Standalone Interior Lights Off']
  });

  const result = await deviceGroupService.updateGroup(GROUP_ID, {
    name: 'Whole Home Lights',
    description: 'All interior and accent lights'
  });

  assert.equal(savedName, 'Whole Home Lights');
  assert.equal(savedDescription, 'All interior and accent lights');
  assert.ok(Array.isArray(deviceBulkOps));
  assert.equal(deviceBulkOps.length, 1);
  assert.deepEqual(deviceBulkOps[0].updateOne.update.$set.groups, ['Whole Home Lights', 'Security']);
  assert.equal(workflowUpdate.actions[0].target.group, 'Whole Home Lights');
  assert.equal(workflowUpdate.graph.nodes[0].data.target.group, 'Whole Home Lights');
  assert.equal(automationUpdate.actions[0].target.group, 'Whole Home Lights');
  assert.equal(automationUpdate.workflowGraph.nodes[0].data.target.group, 'Whole Home Lights');
  assert.equal(emittedEvents.length, 1);
  assert.equal(emittedEvents[0].eventName, 'devices:update');
  assert.equal(result.name, 'Whole Home Lights');
});

test('deleteGroup rejects removing a group that is still referenced by workflows or automations', async (t) => {
  const originalGetGroupById = deviceGroupService.getGroupById;

  t.after(() => {
    deviceGroupService.getGroupById = originalGetGroupById;
  });

  deviceGroupService.getGroupById = async () => ({
    _id: GROUP_ID,
    name: 'Interior Lights',
    workflowUsageCount: 2,
    automationUsageCount: 1
  });

  await assert.rejects(
    deviceGroupService.deleteGroup(GROUP_ID),
    /Cannot delete device group "Interior Lights" because it is used by 2 workflow\(s\) and 1 standalone automation\(s\)/
  );
});

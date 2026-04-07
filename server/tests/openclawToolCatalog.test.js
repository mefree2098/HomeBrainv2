const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOpenClawToolCatalog } = require('../services/openclawToolCatalog');
const deviceService = require('../services/deviceService');
const workflowService = require('../services/workflowService');
const eventStreamService = require('../services/eventStreamService');

function findTool(name) {
  return buildOpenClawToolCatalog({
    actor: 'openclaw:Test Integration',
    integrationName: 'Test Integration',
    app: null
  }).find((tool) => tool.name === name);
}

test('homebrain_devices get resolves a device by name', async (t) => {
  const originalGetAllDevices = deviceService.getAllDevices;

  t.after(() => {
    deviceService.getAllDevices = originalGetAllDevices;
  });

  deviceService.getAllDevices = async () => ([
    {
      _id: '507f1f77bcf86cd799439011',
      name: 'Kitchen Lamp',
      status: false,
      isOnline: true
    }
  ]);

  const tool = findTool('homebrain_devices');
  const result = await tool.handler({
    op: 'get',
    deviceName: 'kitchen lamp'
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.success, true);
  assert.equal(result.structuredContent.data.device.name, 'Kitchen Lamp');
});

test('homebrain_devices control audits and invokes device control', async (t) => {
  const originalGetAllDevices = deviceService.getAllDevices;
  const originalControlDevice = deviceService.controlDevice;
  const originalPublishSafe = eventStreamService.publishSafe;

  t.after(() => {
    deviceService.getAllDevices = originalGetAllDevices;
    deviceService.controlDevice = originalControlDevice;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  const publishedEvents = [];
  let controlCall = null;

  deviceService.getAllDevices = async () => ([
    {
      _id: '507f1f77bcf86cd799439011',
      name: 'Kitchen Lamp',
      status: false,
      isOnline: true
    }
  ]);
  deviceService.controlDevice = async (deviceId, action, value) => {
    controlCall = { deviceId, action, value };
    return {
      _id: deviceId,
      name: 'Kitchen Lamp',
      status: true,
      isOnline: true
    };
  };
  eventStreamService.publishSafe = async (payload) => {
    publishedEvents.push(payload);
    return payload;
  };

  const tool = findTool('homebrain_devices');
  const result = await tool.handler({
    op: 'control',
    deviceName: 'Kitchen Lamp',
    action: 'turn_on'
  });

  assert.equal(controlCall.deviceId, '507f1f77bcf86cd799439011');
  assert.equal(controlCall.action, 'turn_on');
  assert.equal(controlCall.value, undefined);
  assert.equal(result.structuredContent.success, true);
  assert.equal(result.structuredContent.data.device.status, true);
  assert.equal(publishedEvents.length, 2);
  assert.equal(publishedEvents[0].type, 'openclaw.mutation.requested');
  assert.equal(publishedEvents[1].type, 'openclaw.mutation.succeeded');
});

test('homebrain_workflows create_from_text uses openclaw as the source', async (t) => {
  const originalCreateWorkflowFromText = workflowService.createWorkflowFromText;

  t.after(() => {
    workflowService.createWorkflowFromText = originalCreateWorkflowFromText;
  });

  let capturedCall = null;
  workflowService.createWorkflowFromText = async (text, roomContext, source) => {
    capturedCall = { text, roomContext, source };
    return {
      success: true,
      message: 'Workflow created successfully from natural language',
      workflow: {
        _id: '507f1f77bcf86cd799439012',
        name: 'Evening Shutdown'
      }
    };
  };

  const tool = findTool('homebrain_workflows');
  const result = await tool.handler({
    op: 'create_from_text',
    text: 'Create a workflow that shuts everything down at bedtime'
  });

  assert.deepEqual(capturedCall, {
    text: 'Create a workflow that shuts everything down at bedtime',
    roomContext: null,
    source: 'openclaw'
  });
  assert.equal(result.structuredContent.success, true);
  assert.equal(result.structuredContent.data.workflow.name, 'Evening Shutdown');
});

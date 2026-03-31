const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const mongoose = require('mongoose');

const { executeActionSequence } = require('../services/workflowExecutionService');
const Device = require('../models/Device');
const insteonService = require('../services/insteonService');
const Automation = require('../models/Automation');

test('condition edge=change executes onFalseActions when condition transitions to false', async () => {
  const stateKey = `test-condition-false-${Date.now()}`;
  const actions = [
    {
      type: 'condition',
      parameters: {
        contextKey: 'flag',
        operator: 'eq',
        value: true,
        edge: 'change',
        stateKey,
        onFalseActions: [
          {
            type: 'notification',
            parameters: { message: 'else branch fired' }
          }
        ]
      }
    },
    {
      type: 'notification',
      parameters: { message: 'then branch fired' }
    }
  ];

  const first = await executeActionSequence(actions, { context: { flag: true } });
  assert.equal(first.actionResults.length, 1);
  assert.equal(first.actionResults[0].message, 'Condition unchanged');

  const second = await executeActionSequence(actions, { context: { flag: false } });
  assert.equal(second.actionResults.length, 2);
  assert.equal(second.actionResults[0].message, 'Condition not met');
  assert.equal(second.actionResults[1].message, 'else branch fired');
  assert.equal(second.actionResults[1].parentActionIndex, 0);
});

test('condition edge=change allows THEN actions when condition transitions to true', async () => {
  const stateKey = `test-condition-true-${Date.now()}`;
  const actions = [
    {
      type: 'condition',
      parameters: {
        contextKey: 'flag',
        operator: 'eq',
        value: true,
        edge: 'change',
        stateKey
      }
    },
    {
      type: 'notification',
      parameters: { message: 'then branch fired' }
    }
  ];

  const first = await executeActionSequence(actions, { context: { flag: false } });
  assert.equal(first.actionResults.length, 1);
  assert.equal(first.actionResults[0].message, 'Condition unchanged');

  const second = await executeActionSequence(actions, { context: { flag: true } });
  assert.equal(second.actionResults.length, 2);
  assert.equal(second.actionResults[0].message, 'Condition met');
  assert.equal(second.actionResults[1].message, 'then branch fired');
});

test('variable_control supports arithmetic and IF expressions can read variables', async () => {
  const actions = [
    {
      type: 'variable_control',
      parameters: {
        operation: 'assign',
        variable: 'counter',
        value: { kind: 'literal', value: 1 }
      }
    },
    {
      type: 'variable_control',
      parameters: {
        operation: 'add',
        variable: 'counter',
        value: { kind: 'literal', value: 2 }
      }
    },
    {
      type: 'condition',
      parameters: {
        evaluator: 'isy_program_if',
        expression: {
          kind: 'isy_variable',
          name: 'counter',
          operator: 'eq',
          value: { kind: 'literal', value: 3 }
        }
      }
    },
    {
      type: 'notification',
      parameters: { message: 'counter reached 3' }
    }
  ];

  const result = await executeActionSequence(actions, { context: {} });
  assert.equal(result.actionResults.length, 4);
  assert.equal(result.actionResults[2].message, 'Condition met');
  assert.equal(result.actionResults[3].message, 'counter reached 3');
});

test('repeat action executes nested actions expected number of times', async () => {
  const actions = [
    {
      type: 'repeat',
      parameters: {
        mode: 'for',
        count: 2,
        actions: [
          {
            type: 'notification',
            parameters: { message: 'loop' }
          }
        ]
      }
    }
  ];

  const result = await executeActionSequence(actions, { context: {} });
  const loopMessages = result.actionResults.filter((entry) => entry.message === 'loop');
  assert.equal(loopMessages.length, 2);
  assert.equal(result.actionResults[0].actionType, 'repeat');
});

test('isy_network_resource action executes via insteon service', async (t) => {
  const originalExecute = insteonService.executeISYNetworkResource;
  let receivedPayload = null;

  t.after(() => {
    insteonService.executeISYNetworkResource = originalExecute;
  });

  insteonService.executeISYNetworkResource = async (payload) => {
    receivedPayload = payload;
    return {
      success: true,
      resourceId: '5',
      resourceName: 'Doorbell Notify',
      message: 'Executed ISY network resource "Doorbell Notify" (id 5)'
    };
  };

  const result = await executeActionSequence([
    {
      type: 'isy_network_resource',
      target: '5',
      parameters: {
        resourceId: '5',
        resourceName: 'Doorbell Notify'
      }
    }
  ], { context: {} });

  assert.deepEqual(receivedPayload, {
    resourceId: '5',
    resourceName: 'Doorbell Notify'
  });
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].actionType, 'isy_network_resource');
  assert.equal(result.actionResults[0].success, true);
  assert.match(result.actionResults[0].message, /Executed ISY network resource/);
});

test('http_request action executes REST call directly', async (t) => {
  const originalRequest = axios.request;
  let requestConfig = null;

  t.after(() => {
    axios.request = originalRequest;
  });

  axios.request = async (config) => {
    requestConfig = config;
    return {
      status: 201,
      data: { ok: true }
    };
  };

  const result = await executeActionSequence([
    {
      type: 'http_request',
      target: 'https://api.example.com/v1/devices',
      parameters: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: { deviceId: 'AABBCC', state: 'on' },
        expectedStatus: [200, 201],
        timeoutMs: 5000
      }
    }
  ], { context: {} });

  assert.equal(requestConfig.method, 'POST');
  assert.equal(requestConfig.url, 'https://api.example.com/v1/devices');
  assert.deepEqual(requestConfig.data, { deviceId: 'AABBCC', state: 'on' });
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].actionType, 'http_request');
  assert.equal(result.actionResults[0].success, true);
  assert.match(result.actionResults[0].message, /HTTP POST/);
});

test('device_control action can target the triggering device from execution context', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalTurnOff = insteonService.turnOff;
  let receivedTarget = null;

  t.after(() => {
    Device.findById = originalFindById;
    insteonService.turnOff = originalTurnOff;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Laundry Room Fan',
      type: 'switch',
      properties: {
        source: 'insteon'
      }
    })
  });

  insteonService.turnOff = async (target) => {
    receivedTarget = target;
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: { kind: 'context', key: 'triggeringDeviceId' },
      parameters: { action: 'turn_off' }
    }
  ], {
    context: {
      triggeringDeviceId: deviceId
    }
  });

  assert.equal(receivedTarget, deviceId);
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].success, true);
  assert.match(result.actionResults[0].message, /Laundry Room Fan/);
});

test('device_control action resolves direct targets from mongoose action subdocuments', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalTurnOff = insteonService.turnOff;
  let receivedTarget = null;

  t.after(() => {
    Device.findById = originalFindById;
    insteonService.turnOff = originalTurnOff;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Theater Bathroom Fan',
      type: 'switch',
      properties: {
        source: 'insteon'
      }
    })
  });

  insteonService.turnOff = async (target) => {
    receivedTarget = target;
  };

  const automation = new Automation({
    name: 'Theater Bathroom Fan Auto Off',
    trigger: {
      type: 'manual',
      conditions: {}
    },
    actions: [
      {
        type: 'device_control',
        target: deviceId,
        parameters: { action: 'turn_off' }
      }
    ]
  });

  const result = await executeActionSequence(automation.actions, { context: {} });

  assert.equal(receivedTarget, deviceId);
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].success, true);
  assert.equal(result.actionResults[0].target, deviceId);
});

test('condition expressions can read nested SmartThings property paths', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;

  t.after(() => {
    Device.findById = originalFindById;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Dryer Monitor',
      type: 'switch',
      status: true,
      properties: {
        source: 'smartthings',
        smartThingsAttributeValues: {
          powerMeter: {
            power: 812
          }
        }
      }
    })
  });

  const result = await executeActionSequence([
    {
      type: 'condition',
      parameters: {
        expression: {
          kind: 'device_state',
          deviceId,
          property: 'smartThingsAttributeValues.powerMeter.power',
          operator: 'gt',
          value: 100
        }
      }
    },
    {
      type: 'notification',
      parameters: { message: 'dryer is running' }
    }
  ], { context: {} });

  assert.equal(result.actionResults.length, 2);
  assert.equal(result.actionResults[0].message, 'Condition met');
  assert.equal(result.actionResults[1].message, 'dryer is running');
});

test('delay action preserves durations longer than ten minutes', async (t) => {
  const originalSetTimeout = global.setTimeout;

  t.after(() => {
    global.setTimeout = originalSetTimeout;
  });

  global.setTimeout = (handler, delay, ...args) => {
    if (typeof handler === 'function') {
      handler(...args);
    }
    return 0;
  };

  const result = await executeActionSequence([
    {
      type: 'delay',
      target: null,
      parameters: { seconds: 1800 }
    }
  ], { context: {} });

  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].success, true);
  assert.equal(result.actionResults[0].message, 'Delay complete (1800s)');
});

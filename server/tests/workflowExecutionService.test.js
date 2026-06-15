const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const mongoose = require('mongoose');

const {
  executeActionSequence,
  setWorkflowStopRequest,
  clearWorkflowStopRequest,
  isWorkflowExecutionCancelledError
} = require('../services/workflowExecutionService');
const Device = require('../models/Device');
const insteonService = require('../services/insteonService');
const Automation = require('../models/Automation');
const deviceGroupService = require('../services/deviceGroupService');
const deviceService = require('../services/deviceService');

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

test('delay action stops when cancellation is requested for the active execution', async () => {
  const executionHistoryId = new mongoose.Types.ObjectId().toString();
  const executionCorrelationId = `corr-${Date.now()}`;
  const workflowId = new mongoose.Types.ObjectId().toString();

  const actionPromise = executeActionSequence([
    {
      type: 'delay',
      parameters: { seconds: 2 }
    }
  ], {
    context: {
      workflowId,
      executionHistoryId,
      executionCorrelationId
    }
  });

  setTimeout(() => {
    setWorkflowStopRequest({
      historyId: executionHistoryId,
      correlationId: executionCorrelationId
    });
  }, 25);

  await assert.rejects(actionPromise, (error) => {
    assert.equal(isWorkflowExecutionCancelledError(error), true);
    assert.equal(error.message, 'Workflow execution cancelled by user.');
    return true;
  });

  clearWorkflowStopRequest({
    historyId: executionHistoryId,
    correlationId: executionCorrelationId
  });
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
    return {
      confirmed: true,
      message: 'Device turned off via Insteon PLM 11.22.33 (confirmed OFF with 2 reads)',
      details: {
        controlMethod: 'insteon_plm_direct',
        insteonAddress: '11.22.33',
        confirmed: true,
        confirmedLevel: 0
      }
    };
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
  assert.equal(result.actionResults[0].details.controlMethod, 'insteon_plm_direct');
  assert.equal(result.actionResults[0].details.insteonAddress, '11.22.33');
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
    return {
      confirmed: true,
      details: {
        confirmed: true
      }
    };
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

test('device_control action passes Insteon retry parameters through to command execution', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalTurnOff = insteonService.turnOff;
  let receivedOptions = null;

  t.after(() => {
    Device.findById = originalFindById;
    insteonService.turnOff = originalTurnOff;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Master Toilet Fan',
      type: 'switch',
      properties: {
        source: 'insteon'
      }
    })
  });

  insteonService.turnOff = async (_target, options) => {
    receivedOptions = options;
    return {
      confirmed: true,
      message: 'Device turned off via Insteon PLM 11.22.33 after 3 command attempts',
      details: {
        controlMethod: 'insteon_plm_direct',
        insteonAddress: '11.22.33',
        confirmed: true,
        commandAttempts: 3,
        commandRetryCount: 2
      }
    };
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: deviceId,
      parameters: {
        action: 'turn_off',
        retryCount: 2,
        retryDelayMs: 1200
      }
    }
  ], { context: {} });

  assert.equal(receivedOptions.commandAttempts, 3);
  assert.equal(receivedOptions.commandPauseBetweenMs, 1200);
  assert.equal(receivedOptions.commandTimeoutMs, 1500);
  assert.equal(receivedOptions.verificationMode, 'fast');
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].success, true);
  assert.equal(result.actionResults[0].details.commandAttempts, 3);
  assert.equal(result.actionResults[0].details.commandRetryCount, 2);
});

test('device_control action does not double-retry definitive Insteon command failures by default', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalTurnOff = insteonService.turnOff;
  let attempts = 0;

  t.after(() => {
    Device.findById = originalFindById;
    insteonService.turnOff = originalTurnOff;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Laundry Fan',
      type: 'light',
      properties: {
        source: 'insteon'
      }
    })
  });

  insteonService.turnOff = async () => {
    attempts += 1;
    const error = new Error('Timeout turning off device (target device did not respond after PLM ACK) after 3 attempts');
    error.code = 'INSTEON_DEVICE_NO_RESPONSE';
    error.details = {
      commandAttempts: 3,
      commandRetryCount: 2
    };
    throw error;
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: deviceId,
      parameters: {
        action: 'turn_off'
      }
    }
  ], { context: {} });

  assert.equal(attempts, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].success, false);
  assert.equal(result.actionResults[0].details.workflowRetry.attempts, 1);
  assert.equal(result.actionResults[0].details.workflowRetry.maxAttempts, 3);
  assert.equal(result.actionResults[0].details.workflowRetry.failures[0].willRetry, false);
});

test('device_control action still honors explicit workflow retry for Insteon command failures', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalTurnOff = insteonService.turnOff;
  let attempts = 0;

  t.after(() => {
    Device.findById = originalFindById;
    insteonService.turnOff = originalTurnOff;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Laundry Fan',
      type: 'light',
      properties: {
        source: 'insteon'
      }
    })
  });

  insteonService.turnOff = async () => {
    attempts += 1;
    const error = new Error('Timeout turning off device (target device did not respond after PLM ACK) after 3 attempts');
    error.code = 'INSTEON_DEVICE_NO_RESPONSE';
    throw error;
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: deviceId,
      parameters: {
        action: 'turn_off',
        actionRetryCount: 1,
        actionRetryDelayMs: 1
      }
    }
  ], { context: {} });

  assert.equal(attempts, 2);
  assert.equal(result.status, 'failed');
  assert.equal(result.actionResults[0].details.workflowRetry.attempts, 2);
  assert.equal(result.actionResults[0].details.workflowRetry.failures[0].willRetry, true);
});

test('device_control action gives Harmony workflow verification an extended timeout', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalControlDevice = deviceService.controlDevice;
  let receivedOptions = null;

  t.after(() => {
    Device.findById = originalFindById;
    deviceService.controlDevice = originalControlDevice;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Bedroom Fire TV',
      type: 'switch',
      status: false,
      isOnline: true,
      properties: {
        source: 'harmony',
        harmonyHubIp: '192.168.1.50',
        harmonyActivityId: '987654'
      }
    })
  });

  deviceService.controlDevice = async (_target, _action, _value, options) => {
    receivedOptions = options;
    return {
      message: 'Harmony activity started',
      details: {
        source: 'harmony'
      }
    };
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: deviceId,
      parameters: {
        action: 'turn_on'
      }
    }
  ], { context: {} });

  assert.equal(receivedOptions.requirePostActionVerification, true);
  assert.equal(receivedOptions.harmonyVerificationTimeoutMs, 45_000);
  assert.equal(receivedOptions.harmonyVerificationIntervalMs, 3_000);
  assert.equal(result.status, 'success');
});

test('device_control action requires SmartThings post-command verification in workflows', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalControlDevice = deviceService.controlDevice;
  let receivedOptions = null;

  t.after(() => {
    Device.findById = originalFindById;
    deviceService.controlDevice = originalControlDevice;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Driveway Lights',
      type: 'light',
      status: false,
      isOnline: true,
      properties: {
        source: 'smartthings',
        smartThingsDeviceId: 'smartthings-driveway'
      }
    })
  });

  deviceService.controlDevice = async (_target, _action, _value, options) => {
    receivedOptions = options;
    return {
      message: 'SmartThings command verified',
      details: {
        source: 'smartthings'
      }
    };
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: deviceId,
      parameters: {
        action: 'turn_on'
      }
    }
  ], { context: {} });

  assert.equal(receivedOptions.requirePostActionVerification, true);
  assert.equal(result.status, 'success');
});

test('device_control action preserves explicit scene brightness values', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalControlDevice = deviceService.controlDevice;
  let receivedCall = null;

  t.after(() => {
    Device.findById = originalFindById;
    deviceService.controlDevice = originalControlDevice;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Scene Dimmer',
      type: 'light',
      status: false,
      isOnline: true,
      properties: {
        source: 'local'
      }
    })
  });

  deviceService.controlDevice = async (target, action, value, options) => {
    receivedCall = { target, action, value, options };
    return {
      message: 'Brightness set'
    };
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: deviceId,
      parameters: {
        action: 'set_brightness',
        value: 37,
        brightness: 37
      }
    }
  ], { context: {} });

  assert.equal(result.status, 'success');
  assert.equal(receivedCall.target, deviceId);
  assert.equal(receivedCall.action, 'set_brightness');
  assert.equal(receivedCall.value, 37);
});

test('device_control action skips scene targets already in the requested state', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalControlDevice = deviceService.controlDevice;
  let controlCalled = false;

  t.after(() => {
    Device.findById = originalFindById;
    deviceService.controlDevice = originalControlDevice;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Scene Dimmer',
      type: 'light',
      status: true,
      brightness: 37,
      isOnline: true,
      properties: {
        source: 'local'
      }
    })
  });

  deviceService.controlDevice = async () => {
    controlCalled = true;
    throw new Error('Already-satisfied scene target should not be controlled');
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: deviceId,
      parameters: {
        action: 'set_brightness',
        value: 37,
        skipIfAlreadyInState: true
      }
    }
  ], { context: {} });

  assert.equal(controlCalled, false);
  assert.equal(result.status, 'success');
  assert.equal(result.actionResults[0].success, true);
  assert.equal(result.actionResults[0].details.skipped, true);
  assert.equal(result.actionResults[0].details.skipReason, 'already_at_brightness');
});

test('device_control action propagates release-on-success for scene commands', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalControlDevice = deviceService.controlDevice;
  let receivedOptions = null;

  t.after(() => {
    Device.findById = originalFindById;
    deviceService.controlDevice = originalControlDevice;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Scene Switch',
      type: 'switch',
      status: false,
      isOnline: true,
      properties: {
        source: 'local'
      }
    })
  });

  deviceService.controlDevice = async (_target, _action, _value, options) => {
    receivedOptions = options;
    return {
      message: 'Switch turned on'
    };
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: deviceId,
      parameters: {
        action: 'turn_on',
        releaseCommandClaimOnSuccess: true
      }
    }
  ], { context: {} });

  assert.equal(result.status, 'success');
  assert.equal(receivedOptions.releaseCommandClaimOnSuccess, true);
  assert.equal(receivedOptions.command.releaseCommandClaimOnSuccess, true);
});

test('device_control action routes native radio and Matter targets without cloud post-command verification', async (t) => {
  const originalFindById = Device.findById;
  const originalControlDevice = deviceService.controlDevice;
  const deviceIds = [
    new mongoose.Types.ObjectId().toString(),
    new mongoose.Types.ObjectId().toString(),
    new mongoose.Types.ObjectId().toString()
  ];
  const devices = new Map([
    [deviceIds[0], {
      _id: deviceIds[0],
      name: 'Native Zigbee Plug',
      type: 'switch',
      status: false,
      isOnline: true,
      properties: {
        source: 'homebrain-zigbee',
        homebrainDirect: { protocol: 'zigbee', ieeeAddr: '0x00124b0025aa55cc' }
      }
    }],
    [deviceIds[1], {
      _id: deviceIds[1],
      name: 'Native Z-Wave Lock',
      type: 'lock',
      status: false,
      isOnline: true,
      properties: {
        source: 'homebrain-zwave',
        homebrainDirect: { protocol: 'zwave', nodeId: 7 }
      }
    }],
    [deviceIds[2], {
      _id: deviceIds[2],
      name: 'Native Matter Light',
      type: 'light',
      status: false,
      isOnline: true,
      properties: {
        source: 'homebrain-matter',
        matter: { nodeId: '44', endpointId: 1 }
      }
    }]
  ]);
  const calls = [];

  t.after(() => {
    Device.findById = originalFindById;
    deviceService.controlDevice = originalControlDevice;
  });

  Device.findById = (id) => ({
    lean: async () => devices.get(String(id))
  });

  deviceService.controlDevice = async (target, action, value, options) => {
    const device = devices.get(String(target));
    calls.push({
      target,
      action,
      value,
      options,
      source: device?.properties?.source
    });
    return {
      message: 'Native command accepted',
      details: {
        source: device?.properties?.source
      }
    };
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: deviceIds[0],
      parameters: { action: 'turn_on' }
    },
    {
      type: 'device_control',
      target: deviceIds[1],
      parameters: { action: 'lock' }
    },
    {
      type: 'device_control',
      target: deviceIds[2],
      parameters: { action: 'turn_on' }
    }
  ], { context: { workflowId: 'native-workflow-1', workflowName: 'Native QA' } });

  assert.equal(result.status, 'success');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.source), [
    'homebrain-zigbee',
    'homebrain-zwave',
    'homebrain-matter'
  ]);
  calls.forEach((call) => {
    assert.equal(call.options.requirePostActionVerification, false);
    assert.equal(call.options.command.actionType, 'device_control');
    assert.equal(call.options.command.workflowId, 'native-workflow-1');
  });
  assert.deepEqual(result.actionResults.map((entry) => entry.details.source), [
    'homebrain-zigbee',
    'homebrain-zwave',
    'homebrain-matter'
  ]);
});

test('device_control action retries transient workflow failures and records attempts', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalControlDevice = deviceService.controlDevice;
  let attempts = 0;

  t.after(() => {
    Device.findById = originalFindById;
    deviceService.controlDevice = originalControlDevice;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Desk Lamp',
      type: 'light',
      status: false,
      isOnline: true,
      properties: {
        source: 'mock'
      }
    })
  });

  deviceService.controlDevice = async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('Transient command timeout');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    return {
      message: 'Device turned on',
      details: {
        controlMethod: 'mock'
      }
    };
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: deviceId,
      parameters: {
        action: 'turn_on',
        actionRetryCount: 1,
        actionRetryDelayMs: 1
      }
    }
  ], { context: {} });

  assert.equal(attempts, 2);
  assert.equal(result.status, 'success');
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].success, true);
  assert.equal(result.actionResults[0].details.workflowRetry.attempts, 2);
  assert.equal(result.actionResults[0].details.workflowRetry.failures.length, 1);
  assert.equal(result.actionResults[0].details.workflowRetry.failures[0].willRetry, true);
});

test('critical action failure stops the remaining workflow actions', async (t) => {
  const deviceId = new mongoose.Types.ObjectId().toString();
  const originalFindById = Device.findById;
  const originalControlDevice = deviceService.controlDevice;

  t.after(() => {
    Device.findById = originalFindById;
    deviceService.controlDevice = originalControlDevice;
  });

  Device.findById = () => ({
    lean: async () => ({
      _id: deviceId,
      name: 'Theater Activity',
      type: 'switch',
      status: false,
      isOnline: true,
      properties: {
        source: 'mock'
      }
    })
  });

  deviceService.controlDevice = async () => {
    const error = new Error('Transient command timeout');
    error.code = 'ETIMEDOUT';
    throw error;
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: deviceId,
      parameters: {
        action: 'turn_on',
        actionRetryCount: 0,
        critical: true
      }
    },
    {
      type: 'notification',
      parameters: { message: 'should not run' }
    }
  ], { context: {} });

  assert.equal(result.status, 'failed');
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].success, false);
  assert.equal(result.actionResults[0].details.workflowControl.stoppedAfterFailure, true);
});

test('device_control action can target a device group', async (t) => {
  const originalResolveGroupExecutionPlanByName = deviceGroupService.resolveGroupExecutionPlanByName;
  const originalTryControlDeviceGroup = insteonService.tryControlDeviceGroup;
  const originalTurnOff = insteonService.turnOff;
  const receivedTargets = [];
  const receivedOptions = [];
  let inFlight = 0;
  let maxInFlight = 0;

  t.after(() => {
    deviceGroupService.resolveGroupExecutionPlanByName = originalResolveGroupExecutionPlanByName;
    insteonService.tryControlDeviceGroup = originalTryControlDeviceGroup;
    insteonService.turnOff = originalTurnOff;
  });

  const groupDevices = [
    {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Theater Can Lights',
      type: 'light',
      room: 'Theater',
      groups: ['Interior Lights'],
      properties: {
        source: 'insteon'
      }
    },
    {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Track Lights',
      type: 'light',
      room: 'Theater',
      groups: ['Interior Lights'],
      properties: {
        source: 'insteon'
      }
    }
  ];

  deviceGroupService.resolveGroupExecutionPlanByName = async () => ({
    rootGroup: {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Interior Lights',
      normalizedName: 'interior lights'
    },
    devices: groupDevices,
    units: [
      {
        groupId: new mongoose.Types.ObjectId().toString(),
        groupName: 'Interior Lights',
        groupRecord: {
          _id: new mongoose.Types.ObjectId().toString(),
          name: 'Interior Lights',
          normalizedName: 'interior lights'
        },
        devices: groupDevices,
        allowManagedInsteonGroup: true
      }
    ],
    containsNestedGroups: false
  });
  insteonService.tryControlDeviceGroup = async () => null;

  insteonService.turnOff = async (target, options) => {
    receivedTargets.push(target);
    receivedOptions.push(options);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return {
      confirmed: true,
      message: `Device turned off via Insteon PLM ${target}`,
      details: {
        confirmed: true,
        controlMethod: 'insteon_plm_direct'
      }
    };
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: { kind: 'device_group', group: 'Interior Lights' },
      parameters: { action: 'turn_off' }
    }
  ], { context: {} });

  assert.deepEqual(receivedTargets.sort(), groupDevices.map((device) => device._id).sort());
  assert.ok(maxInFlight > 1);
  assert.deepEqual(
    receivedOptions.map((entry) => entry?.verificationMode),
    ['fast', 'fast']
  );
  assert.deepEqual(
    receivedOptions.map((entry) => entry?.commandAttempts),
    [1, 1]
  );
  assert.deepEqual(
    receivedOptions.map((entry) => entry?.commandPauseBetweenMs),
    [0, 0]
  );
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].success, true);
  assert.equal(result.actionResults[0].details.group, 'Interior Lights');
  assert.equal(result.actionResults[0].details.executionMode, 'parallel');
  assert.equal(result.actionResults[0].details.successfulTargets, 2);
});

test('device_control scene group action skips members already in the requested state', async (t) => {
  const originalResolveGroupExecutionPlanByName = deviceGroupService.resolveGroupExecutionPlanByName;
  const originalControlDevice = deviceService.controlDevice;
  const controlledTargets = [];

  t.after(() => {
    deviceGroupService.resolveGroupExecutionPlanByName = originalResolveGroupExecutionPlanByName;
    deviceService.controlDevice = originalControlDevice;
  });

  const offDeviceId = new mongoose.Types.ObjectId().toString();
  const directOffDeviceId = new mongoose.Types.ObjectId().toString();
  const onDeviceId = new mongoose.Types.ObjectId().toString();
  const groupDevices = [
    {
      _id: offDeviceId,
      name: 'Already Off Strip',
      type: 'light',
      room: 'Theater',
      status: false,
      properties: {
        source: 'mock'
      }
    },
    {
      _id: directOffDeviceId,
      name: 'Already Off Direct Strip',
      type: 'light',
      room: 'Theater',
      status: true,
      properties: {
        source: 'mock',
        directRadioState: {
          switch: false
        }
      }
    },
    {
      _id: onDeviceId,
      name: 'Still On Strip',
      type: 'light',
      room: 'Theater',
      status: true,
      properties: {
        source: 'mock'
      }
    }
  ];

  deviceGroupService.resolveGroupExecutionPlanByName = async () => ({
    rootGroup: {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Stars Only Group',
      normalizedName: 'stars only group'
    },
    devices: groupDevices,
    units: [
      {
        groupId: new mongoose.Types.ObjectId().toString(),
        groupName: 'Stars Only Group',
        groupRecord: {
          _id: new mongoose.Types.ObjectId().toString(),
          name: 'Stars Only Group',
          normalizedName: 'stars only group'
        },
        devices: groupDevices,
        allowManagedInsteonGroup: false
      }
    ],
    containsNestedGroups: false
  });

  deviceService.controlDevice = async (target, action) => {
    controlledTargets.push({ target, action });
    return {
      message: 'Device turned off',
      details: {
        source: 'mock'
      }
    };
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: { kind: 'device_group', group: 'Stars Only Group' },
      parameters: {
        action: 'turn_off',
        skipIfAlreadyInState: true
      }
    }
  ], { context: {} });

  assert.deepEqual(controlledTargets, [{ target: onDeviceId, action: 'turn_off' }]);
  assert.equal(result.status, 'success');
  assert.equal(result.actionResults[0].details.executionMode, 'parallel_with_skips');
  assert.equal(result.actionResults[0].details.totalTargets, 3);
  assert.equal(result.actionResults[0].details.successfulTargets, 3);
  assert.equal(result.actionResults[0].details.skippedTargets, 2);
  assert.deepEqual(
    result.actionResults[0].details.members
      .filter((entry) => entry.skipped)
      .map((entry) => entry.deviceId)
      .sort(),
    [directOffDeviceId, offDeviceId].sort()
  );
});

test('device_control action does not retry whole device groups by default', async (t) => {
  const originalResolveGroupExecutionPlanByName = deviceGroupService.resolveGroupExecutionPlanByName;
  const originalTryControlDeviceGroup = insteonService.tryControlDeviceGroup;
  const originalTurnOff = insteonService.turnOff;
  let turnOffCalls = 0;

  t.after(() => {
    deviceGroupService.resolveGroupExecutionPlanByName = originalResolveGroupExecutionPlanByName;
    insteonService.tryControlDeviceGroup = originalTryControlDeviceGroup;
    insteonService.turnOff = originalTurnOff;
  });

  const groupDevices = [
    {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Kitchen Cans',
      type: 'light',
      room: 'Kitchen',
      groups: ['Interior Lights'],
      properties: {
        source: 'insteon'
      }
    },
    {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Hall Lamp',
      type: 'light',
      room: 'Hall',
      groups: ['Interior Lights'],
      properties: {
        source: 'insteon'
      }
    }
  ];

  deviceGroupService.resolveGroupExecutionPlanByName = async () => ({
    rootGroup: {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Interior Lights',
      normalizedName: 'interior lights'
    },
    devices: groupDevices,
    units: [
      {
        groupId: new mongoose.Types.ObjectId().toString(),
        groupName: 'Interior Lights',
        groupRecord: {
          _id: new mongoose.Types.ObjectId().toString(),
          name: 'Interior Lights',
          normalizedName: 'interior lights'
        },
        devices: groupDevices,
        allowManagedInsteonGroup: true
      }
    ],
    containsNestedGroups: false
  });
  insteonService.tryControlDeviceGroup = async () => null;
  insteonService.turnOff = async () => {
    turnOffCalls += 1;
    throw new Error('Timeout turning off device');
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: { kind: 'device_group', group: 'Interior Lights' },
      parameters: { action: 'turn_off' }
    }
  ], { context: {} });

  assert.equal(result.status, 'failed');
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].success, false);
  assert.equal(turnOffCalls, groupDevices.length);
  assert.equal(result.actionResults[0].details.workflowRetry.attempts, 1);
  assert.equal(result.actionResults[0].details.workflowRetry.maxAttempts, 1);
  assert.equal(result.actionResults[0].details.workflowRetry.retries, 0);
  assert.equal(result.actionResults[0].details.workflowRetry.failures[0].willRetry, false);
});

test('device_control action fails grouped Insteon commands that are not confirmed', async (t) => {
  const originalResolveGroupExecutionPlanByName = deviceGroupService.resolveGroupExecutionPlanByName;
  const originalTryControlDeviceGroup = insteonService.tryControlDeviceGroup;
  const originalTurnOn = insteonService.turnOn;

  t.after(() => {
    deviceGroupService.resolveGroupExecutionPlanByName = originalResolveGroupExecutionPlanByName;
    insteonService.tryControlDeviceGroup = originalTryControlDeviceGroup;
    insteonService.turnOn = originalTurnOn;
  });

  const deviceId = new mongoose.Types.ObjectId().toString();
  const groupDevice = {
    _id: deviceId,
    name: 'Front Porch Lights',
    type: 'light',
    room: 'Outside',
    groups: ['Exterior Lights'],
    properties: {
      source: 'insteon',
      insteonAddress: '38.A6.29'
    }
  };

  deviceGroupService.resolveGroupExecutionPlanByName = async () => ({
    rootGroup: {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Exterior Lights',
      normalizedName: 'exterior lights'
    },
    devices: [groupDevice],
    units: [
      {
        groupId: new mongoose.Types.ObjectId().toString(),
        groupName: 'Exterior Lights',
        groupRecord: {
          _id: new mongoose.Types.ObjectId().toString(),
          name: 'Exterior Lights',
          normalizedName: 'exterior lights'
        },
        devices: [groupDevice],
        allowManagedInsteonGroup: true
      }
    ],
    containsNestedGroups: false
  });
  insteonService.tryControlDeviceGroup = async () => null;
  insteonService.turnOn = async () => ({
    confirmed: false,
    warning: 'state confirmation timed out',
    message: 'Device turned on via Insteon PLM 38.A6.29 (command acknowledged; status verification pending)',
    details: {
      source: 'insteon',
      confirmed: false,
      verificationMode: 'fast',
      confirmationWarning: 'state confirmation timed out'
    }
  });

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: { kind: 'device_group', group: 'Exterior Lights' },
      parameters: {
        action: 'turn_on',
        disableActionRetry: true
      }
    }
  ], { context: {} });

  assert.equal(result.status, 'failed');
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].success, false);
  assert.match(result.actionResults[0].error, /acknowledged but not confirmed/);
  assert.equal(result.actionResults[0].details.failedTargets, 1);
  assert.equal(result.actionResults[0].details.members[0].success, false);
});

test('device_control action uses managed INSTEON group broadcast when the device group has only linked INSTEON members', async (t) => {
  const originalResolveGroupExecutionPlanByName = deviceGroupService.resolveGroupExecutionPlanByName;
  const originalTryControlDeviceGroup = insteonService.tryControlDeviceGroup;
  const originalTurnOff = insteonService.turnOff;

  t.after(() => {
    deviceGroupService.resolveGroupExecutionPlanByName = originalResolveGroupExecutionPlanByName;
    insteonService.tryControlDeviceGroup = originalTryControlDeviceGroup;
    insteonService.turnOff = originalTurnOff;
  });

  const groupDevices = [
    {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Master Vanity Left',
      type: 'light',
      room: 'Primary Bath',
      groups: ['Interior Lights'],
      properties: {
        source: 'insteon',
        insteonAddress: '38.96.47',
        linkedToCurrentPlm: true
      }
    },
    {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Master Vanity Right',
      type: 'light',
      room: 'Primary Bath',
      groups: ['Interior Lights'],
      properties: {
        source: 'insteon',
        insteonAddress: '38.93.5B',
        linkedToCurrentPlm: true
      }
    }
  ];

  const rootGroup = {
    _id: new mongoose.Types.ObjectId().toString(),
    name: 'Interior Lights',
    normalizedName: 'interior lights'
  };
  deviceGroupService.resolveGroupExecutionPlanByName = async () => ({
    rootGroup,
    devices: groupDevices,
    units: [
      {
        groupId: rootGroup._id,
        groupName: rootGroup.name,
        groupRecord: rootGroup,
        devices: groupDevices,
        allowManagedInsteonGroup: true
      }
    ],
    containsNestedGroups: false
  });

  let receivedArgs = null;
  insteonService.tryControlDeviceGroup = async (groupRecord, devices, actionName, value, options) => {
    receivedArgs = { groupRecord, devices, actionName, value, options };
    return {
      message: 'Executed turn_off on device group "Interior Lights" via INSTEON PLM all-link broadcast (2 devices)',
      details: {
        controlMethod: 'insteon_plm_group_broadcast',
        verificationMode: 'broadcast_ack',
        commandVariant: 'scene_off_fast',
        insteonPlmGroup: 251,
        sceneSynchronized: true,
        targetCount: 2,
        members: groupDevices.map((device) => ({
          deviceId: device._id,
          deviceName: device.name,
          room: device.room,
          insteonAddress: device.properties.insteonAddress,
          success: true
        }))
      }
    };
  };
  insteonService.turnOff = async () => {
    throw new Error('turnOff should not be called when managed group broadcast succeeds');
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: { kind: 'device_group', group: 'Interior Lights' },
      parameters: { action: 'turn_off', verificationMode: 'ack' }
    }
  ], { context: {} });

  assert.equal(receivedArgs.groupRecord.name, 'Interior Lights');
  assert.equal(receivedArgs.actionName, 'turn_off');
  assert.equal(receivedArgs.value, undefined);
  assert.equal(receivedArgs.options.deviceGroup, 'Interior Lights');
  assert.equal(receivedArgs.options.verificationMode, 'ack');
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].success, true);
  assert.equal(result.actionResults[0].details.executionMode, 'insteon_group_broadcast');
  assert.equal(result.actionResults[0].details.successfulTargets, 2);
  assert.equal(result.actionResults[0].details.insteonPlmGroup, 251);
});

test('device_control action can execute a nested master group across subgroup units', async (t) => {
  const originalResolveGroupExecutionPlanByName = deviceGroupService.resolveGroupExecutionPlanByName;
  const originalTryControlDeviceGroup = insteonService.tryControlDeviceGroup;
  const originalTurnOff = insteonService.turnOff;
  const directTargets = [];

  t.after(() => {
    deviceGroupService.resolveGroupExecutionPlanByName = originalResolveGroupExecutionPlanByName;
    insteonService.tryControlDeviceGroup = originalTryControlDeviceGroup;
    insteonService.turnOff = originalTurnOff;
  });

  const insteonDevices = [
    {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Hall Lamp',
      room: 'Hall',
      type: 'light',
      properties: {
        source: 'insteon',
        insteonAddress: '11.22.33',
        linkedToCurrentPlm: true
      }
    },
    {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Kitchen Lamp',
      room: 'Kitchen',
      type: 'light',
      properties: {
        source: 'insteon',
        insteonAddress: '22.33.44',
        linkedToCurrentPlm: true
      }
    }
  ];
  const directFallbackDevice = {
    _id: new mongoose.Types.ObjectId().toString(),
    name: 'Porch Light',
    room: 'Porch',
    type: 'light',
    properties: {
      source: 'insteon'
    }
  };

  deviceGroupService.resolveGroupExecutionPlanByName = async () => ({
    rootGroup: {
      _id: new mongoose.Types.ObjectId().toString(),
      name: 'Whole Home Lighting',
      normalizedName: 'whole home lighting'
    },
    devices: [...insteonDevices, directFallbackDevice],
    units: [
      {
        groupId: new mongoose.Types.ObjectId().toString(),
        groupName: 'Interior Insteon',
        groupRecord: {
          _id: new mongoose.Types.ObjectId().toString(),
          name: 'Interior Insteon',
          normalizedName: 'interior insteon'
        },
        devices: insteonDevices,
        allowManagedInsteonGroup: true
      },
      {
        groupId: new mongoose.Types.ObjectId().toString(),
        groupName: 'Exterior Direct',
        groupRecord: {
          _id: new mongoose.Types.ObjectId().toString(),
          name: 'Exterior Direct',
          normalizedName: 'exterior direct'
        },
        devices: [directFallbackDevice],
        allowManagedInsteonGroup: false
      }
    ],
    containsNestedGroups: true
  });

  insteonService.tryControlDeviceGroup = async (_groupRecord, devices, actionName) => {
    if (actionName !== 'turn_off') {
      return null;
    }

    return {
      message: `Executed turn_off on device group "Interior Insteon" via INSTEON PLM all-link broadcast (${devices.length} devices)`,
      details: {
        controlMethod: 'insteon_plm_group_broadcast',
        verificationMode: 'broadcast_ack',
        commandVariant: 'scene_off_fast',
        insteonPlmGroup: 250,
        sceneSynchronized: true,
        targetCount: devices.length,
        members: devices.map((device) => ({
          deviceId: device._id,
          deviceName: device.name,
          room: device.room,
          success: true
        }))
      }
    };
  };

  insteonService.turnOff = async (target) => {
    directTargets.push(target);
    return {
      message: `Device turned off via Insteon PLM ${target}`,
      details: {
        controlMethod: 'direct_fallback'
      }
    };
  };

  const result = await executeActionSequence([
    {
      type: 'device_control',
      target: { kind: 'device_group', group: 'Whole Home Lighting' },
      parameters: { action: 'turn_off', verificationMode: 'ack' }
    }
  ], { context: {} });

  assert.deepEqual(directTargets, [directFallbackDevice._id]);
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].details.executionMode, 'nested_group_plan');
  assert.equal(result.actionResults[0].details.unitCount, 2);
  assert.equal(result.actionResults[0].details.successfulTargets, 3);
  assert.equal(result.actionResults[0].details.failedTargets, 0);
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

test('delay action runtime hook exposes timer countdown and next action metadata', async (t) => {
  const originalSetTimeout = global.setTimeout;
  const actionStarts = [];

  t.after(() => {
    global.setTimeout = originalSetTimeout;
  });

  global.setTimeout = (handler, delay, ...args) => {
    if (typeof handler === 'function') {
      handler(...args);
    }
    return 0;
  };

  await executeActionSequence([
    {
      type: 'delay',
      parameters: { seconds: 120 }
    },
    {
      type: 'notification',
      parameters: { message: 'fan is off' }
    }
  ], {
    context: {},
    runtime: {
      onActionStart: async (payload) => {
        actionStarts.push(payload);
      }
    }
  });

  assert.equal(actionStarts.length, 2);
  assert.equal(actionStarts[0].actionType, 'delay');
  assert.equal(actionStarts[0].timer.durationMs, 120_000);
  assert.equal(
    actionStarts[0].timer.endsAt.getTime() - actionStarts[0].startedAt.getTime(),
    120_000
  );
  assert.equal(actionStarts[0].nextAction.actionType, 'notification');
  assert.match(actionStarts[0].nextAction.message, /notification/i);
});

test('delay action resume state uses the remaining countdown after a restart', async (t) => {
  const originalSetTimeout = global.setTimeout;
  const realDateNow = Date.now;
  const actionStarts = [];
  const now = new Date('2026-04-05T16:00:00.000Z');

  t.after(() => {
    global.setTimeout = originalSetTimeout;
    Date.now = realDateNow;
  });

  Date.now = () => now.getTime();
  global.setTimeout = (handler, delay, ...args) => {
    if (typeof handler === 'function') {
      handler(...args);
    }
    return 0;
  };

  const result = await executeActionSequence([
    {
      type: 'delay',
      parameters: {
        seconds: 120,
        __resumeDelayState: {
          durationMs: 120_000,
          endsAt: new Date(now.getTime() + 30_000).toISOString()
        }
      }
    }
  ], {
    context: {},
    runtime: {
      onActionStart: async (payload) => {
        actionStarts.push(payload);
      }
    }
  });

  assert.equal(actionStarts.length, 1);
  assert.equal(actionStarts[0].timer.durationMs, 30_000);
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].message, 'Delay complete (30s)');
});

test('delay action resume state completes immediately when restart missed the deadline', async (t) => {
  const originalSetTimeout = global.setTimeout;
  const realDateNow = Date.now;
  const actionStarts = [];
  const now = new Date('2026-04-05T16:00:00.000Z');
  let timeoutCalls = 0;

  t.after(() => {
    global.setTimeout = originalSetTimeout;
    Date.now = realDateNow;
  });

  Date.now = () => now.getTime();
  global.setTimeout = () => {
    timeoutCalls += 1;
    return 0;
  };

  const result = await executeActionSequence([
    {
      type: 'delay',
      parameters: {
        seconds: 120,
        __resumeDelayState: {
          durationMs: 120_000,
          endsAt: new Date(now.getTime() - 60_000).toISOString()
        }
      }
    }
  ], {
    context: {},
    runtime: {
      onActionStart: async (payload) => {
        actionStarts.push(payload);
      }
    }
  });

  assert.equal(timeoutCalls, 0);
  assert.equal(actionStarts.length, 1);
  assert.equal(actionStarts[0].timer, null);
  assert.equal(result.actionResults.length, 1);
  assert.equal(result.actionResults[0].message, 'Delay complete (0s)');
});

test('alexa_speak action sends a workflow announcement through the Alexa bridge', async (t) => {
  const alexaBridgeService = require('../services/alexaBridgeService');
  const originalSendAlexaSpeech = alexaBridgeService.sendAlexaSpeech;
  let capturedCall = null;

  t.after(() => {
    alexaBridgeService.sendAlexaSpeech = originalSendAlexaSpeech;
  });

  alexaBridgeService.sendAlexaSpeech = async (target, parameters, context) => {
    capturedCall = { target, parameters, context };
    return {
      success: true,
      deviceId: 'kitchen-echo',
      deviceName: 'Kitchen Alexa',
      brokerAccountId: parameters.brokerAccountId,
      providerResponse: {
        accepted: true
      }
    };
  };

  const result = await executeActionSequence([
    {
      type: 'alexa_speak',
      target: {
        kind: 'alexa_device',
        alexaDeviceId: 'kitchen-echo',
        name: 'Kitchen Alexa',
        brokerAccountId: 'acct-1'
      },
      parameters: {
        message: 'Front Door has opened',
        brokerAccountId: 'acct-1'
      }
    }
  ], {
    context: {
      workflowId: 'workflow-1',
      triggeringDeviceId: 'front-door'
    }
  });

  assert.equal(result.status, 'success');
  assert.equal(capturedCall.target.alexaDeviceId, 'kitchen-echo');
  assert.equal(capturedCall.parameters.message, 'Front Door has opened');
  assert.equal(capturedCall.context.workflowId, 'workflow-1');
  assert.equal(result.actionResults[0].target, 'kitchen-echo');
  assert.equal(result.actionResults[0].message, 'Alexa announcement sent to Kitchen Alexa');
});

test('alexa_speak action sends workflow announcements to multiple Alexa devices', async (t) => {
  const alexaBridgeService = require('../services/alexaBridgeService');
  const originalSendAlexaSpeech = alexaBridgeService.sendAlexaSpeech;
  const capturedCalls = [];

  t.after(() => {
    alexaBridgeService.sendAlexaSpeech = originalSendAlexaSpeech;
  });

  alexaBridgeService.sendAlexaSpeech = async (target, parameters, context) => {
    capturedCalls.push({ target, parameters, context });
    return {
      success: true,
      deviceId: target.alexaDeviceId,
      deviceName: target.name,
      brokerAccountId: target.brokerAccountId,
      providerResponse: {
        accepted: true,
        target: target.alexaDeviceId
      }
    };
  };

  const result = await executeActionSequence([
    {
      type: 'alexa_speak',
      target: {
        kind: 'alexa_devices',
        devices: [
          {
            alexaDeviceId: 'kitchen-echo',
            name: 'Kitchen Alexa',
            brokerAccountId: 'acct-1'
          },
          {
            alexaDeviceId: 'office-echo',
            name: 'Office Alexa',
            brokerAccountId: 'acct-1'
          }
        ]
      },
      parameters: {
        message: 'Front Door has opened'
      }
    }
  ], {
    context: {
      workflowId: 'workflow-1',
      triggeringDeviceId: 'front-door'
    }
  });

  assert.equal(result.status, 'success');
  assert.equal(capturedCalls.length, 2);
  assert.equal(capturedCalls[0].target.alexaDeviceId, 'kitchen-echo');
  assert.equal(capturedCalls[1].target.alexaDeviceId, 'office-echo');
  assert.equal(capturedCalls[0].parameters.message, 'Front Door has opened');
  assert.equal(capturedCalls[1].parameters.message, 'Front Door has opened');
  assert.deepEqual(result.actionResults[0].target, ['kitchen-echo', 'office-echo']);
  assert.equal(result.actionResults[0].message, 'Alexa announcement sent to Kitchen Alexa and Office Alexa');
  assert.equal(result.actionResults[0].details.alexaTargets.length, 2);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const { executeActionSequence } = require('../services/workflowExecutionService');
const insteonService = require('../services/insteonService');

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

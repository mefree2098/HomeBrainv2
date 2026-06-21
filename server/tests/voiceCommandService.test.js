const test = require('node:test');
const assert = require('node:assert/strict');

test('buildPrompt includes available workflows and workflow revise guidance', async () => {
  const voiceCommandService = require('../services/voiceCommandService');

  const prompt = voiceCommandService.buildPrompt('Fix the bedtime workflow so it turns off more lights.', {
    room: 'Bedroom',
    wakeWord: 'dashboard',
    devices: [],
    scenes: [],
    workflows: [
      {
        id: 'workflow-1',
        name: 'Bedtime Routine',
        description: 'Turns off a few bedroom lights.',
        enabled: true,
        category: 'comfort',
        triggerType: 'manual'
      }
    ]
  });

  assert.match(prompt, /AVAILABLE WORKFLOWS/);
  assert.match(prompt, /ID:workflow-1 \| Name:Bedtime Routine/);
  assert.match(prompt, /workflow_revise/);
});

test('getDeviceCapabilities keeps fan-labeled Insteon devices on the dimmer path', () => {
  const voiceCommandService = require('../services/voiceCommandService');

  const capabilities = voiceCommandService.getDeviceCapabilities(
    'switch',
    'insteon',
    {
      insteonAddress: '38.8A.57',
      deviceCategory: 2,
      supportsBrightness: false
    },
    'Master Toilet Fan'
  );

  assert.deepEqual(capabilities, ['turn_on', 'turn_off', 'toggle', 'set_brightness']);
});

test('processCommand handles direct office light control without LLM interpretation', async (t) => {
  const voiceCommandService = require('../services/voiceCommandService');
  const deviceService = require('../services/deviceService');

  const originalGetContext = voiceCommandService.getContext;
  const originalInterpretCommand = voiceCommandService.interpretCommand;
  const originalControlDevice = deviceService.controlDevice;

  t.after(() => {
    voiceCommandService.getContext = originalGetContext;
    voiceCommandService.interpretCommand = originalInterpretCommand;
    deviceService.controlDevice = originalControlDevice;
  });

  const officeId = 'office-device-id';
  const officeDevice = {
    _id: { toString: () => officeId },
    name: 'Office',
    room: 'Unassigned',
    type: 'light',
    properties: { source: 'insteon' }
  };

  let llmCalled = false;
  let controlCall = null;

  voiceCommandService.getContext = async () => ({
    devices: [{
      id: officeId,
      name: 'Office',
      room: 'Unassigned',
      type: 'light',
      source: 'insteon',
      capabilities: ['turn_on', 'turn_off', 'set_brightness'],
      properties: officeDevice.properties
    }],
    scenes: [],
    workflows: [],
    raw: { devices: [officeDevice], scenes: [], workflows: [] },
    deviceMap: new Map([[officeId, officeDevice]]),
    sceneMap: new Map(),
    workflowMap: new Map()
  });
  voiceCommandService.interpretCommand = async () => {
    llmCalled = true;
    throw new Error('LLM should not be called for direct office control');
  };
  deviceService.controlDevice = async (...args) => {
    controlCall = args;
    return { success: true };
  };

  const result = await voiceCommandService.processCommand({
    commandText: 'turn on the office',
    room: 'Vault',
    wakeWord: 'anna'
  });

  assert.equal(llmCalled, false);
  assert.equal(result.intent.action, 'device_control');
  assert.equal(result.execution.status, 'success');
  assert.equal(result.execution.actions[0].deviceName, 'Office');
  assert.equal(controlCall[0], officeId);
  assert.equal(controlCall[1], 'turnOn');
});

test('immediate voice fallback prefers exact device names over longer Harmony activity matches', async (t) => {
  const voiceCommandService = require('../services/voiceCommandService');
  const deviceService = require('../services/deviceService');

  const originalGetContext = voiceCommandService.getContext;
  const originalControlDevice = deviceService.controlDevice;

  const exactDeviceId = 'exact-master-bedroom';
  const harmonyDeviceId = 'harmony-master-bedroom-satellite';
  let controlledDeviceId = null;

  t.after(() => {
    voiceCommandService.getContext = originalGetContext;
    deviceService.controlDevice = originalControlDevice;
  });

  const exactDevice = {
    _id: { toString: () => exactDeviceId },
    id: exactDeviceId,
    name: 'Master Bedroom',
    room: 'Unassigned',
    type: 'light',
    source: 'insteon',
    capabilities: ['turn_on', 'turn_off', 'set_brightness'],
    properties: { source: 'insteon' }
  };
  const harmonyActivity = {
    _id: { toString: () => harmonyDeviceId },
    id: harmonyDeviceId,
    name: 'Bedroom Hub - Master Bedroom Satellite',
    room: 'Bedroom Hub',
    type: 'switch',
    source: 'harmony',
    capabilities: ['turn_on', 'turn_off', 'toggle'],
    properties: {
      source: 'harmony',
      harmonyEntityType: 'activity',
      harmonyActivityLabel: 'Master Bedroom Satellite'
    }
  };

  voiceCommandService.getContext = async () => ({
    devices: [harmonyActivity, exactDevice],
    scenes: [],
    workflows: [],
    raw: { devices: [], scenes: [], workflows: [] },
    deviceMap: new Map([
      [exactDeviceId, exactDevice],
      [harmonyDeviceId, harmonyActivity]
    ]),
    sceneMap: new Map(),
    workflowMap: new Map()
  });

  deviceService.controlDevice = async (deviceId) => {
    controlledDeviceId = deviceId;
    return { success: true };
  };

  const result = await voiceCommandService.processCommand({
    commandText: 'turn on master bedroom',
    room: null,
    wakeWord: 'hey anna'
  });

  assert.equal(controlledDeviceId, exactDeviceId);
  assert.equal(result.execution.status, 'success');
  assert.equal(result.execution.actions[0].deviceName, 'Master Bedroom');
  assert.equal(result.execution.actions[0].deviceId, exactDeviceId);
});

test('processCommand executes workflow revisions for admin users', async (t) => {
  const voiceCommandService = require('../services/voiceCommandService');
  const workflowService = require('../services/workflowService');

  const originalGetContext = voiceCommandService.getContext;
  const originalInterpretCommand = voiceCommandService.interpretCommand;
  const originalFindWorkflowForControl = workflowService.findWorkflowForControl;
  const originalReviseWorkflowFromText = workflowService.reviseWorkflowFromText;

  t.after(() => {
    voiceCommandService.getContext = originalGetContext;
    voiceCommandService.interpretCommand = originalInterpretCommand;
    workflowService.findWorkflowForControl = originalFindWorkflowForControl;
    workflowService.reviseWorkflowFromText = originalReviseWorkflowFromText;
  });

  voiceCommandService.getContext = async () => ({
    devices: [],
    scenes: [],
    workflows: [],
    raw: { devices: [], scenes: [], workflows: [] },
    deviceMap: new Map(),
    sceneMap: new Map(),
    workflowMap: new Map()
  });

  voiceCommandService.interpretCommand = async () => ({
    interpretation: {
      intent: 'workflow_revise',
      confidence: 0.97,
      normalizedCommand: 'Fix the Bedtime Routine workflow',
      actions: [
        {
          type: 'workflow_revise',
          workflowId: 'workflow-1',
          workflowName: 'Bedtime Routine',
          description: 'Use the Interior Lights group and turn off all interior lights.'
        }
      ],
      response: 'Updating the Bedtime Routine workflow.',
      followUpQuestion: null,
      usedFallback: false
    },
    llm: {
      provider: 'local',
      model: 'test-model',
      processingTimeMs: 12
    }
  });

  workflowService.findWorkflowForControl = async () => ({
    _id: { toString: () => 'workflow-1' },
    name: 'Bedtime Routine'
  });

  workflowService.reviseWorkflowFromText = async (id, text, room, source) => ({
    success: true,
    workflow: {
      _id: 'workflow-1',
      name: 'Bedtime Routine'
    },
    message: `Workflow "Bedtime Routine" updated from ${source} in ${room || 'unknown room'} using: ${text}`
  });

  const result = await voiceCommandService.processCommand({
    commandText: 'Fix the Bedtime Routine workflow so it uses the Interior Lights group.',
    room: 'Bedroom',
    wakeWord: 'dashboard',
    userRole: 'admin'
  });

  assert.equal(result.intent.action, 'workflow_revise');
  assert.equal(result.execution.status, 'success');
  assert.equal(result.execution.actions.length, 1);
  assert.equal(result.execution.actions[0].type, 'workflow_revise');
  assert.equal(result.execution.actions[0].success, true);
});

test('workflow revisions are blocked for standard users', async () => {
  const voiceCommandService = require('../services/voiceCommandService');

  const interpretation = voiceCommandService.enforceRolePermissions({
    intent: 'workflow_revise',
    confidence: 0.88,
    normalizedCommand: 'Fix the bedtime workflow',
    actions: [
      {
        type: 'workflow_revise',
        workflowName: 'Bedtime Routine',
        description: 'Use the Interior Lights group.'
      }
    ],
    response: 'Updating the workflow.',
    followUpQuestion: null
  }, 'user');

  assert.equal(interpretation.intent, 'query');
  assert.deepEqual(interpretation.actions, []);
  assert.match(interpretation.response, /requires an admin account/i);
});

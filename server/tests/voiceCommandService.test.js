const test = require('node:test');
const assert = require('node:assert/strict');

test('extractNumber handles percentages and bounded control phrases', () => {
  const voiceCommandService = require('../services/voiceCommandService');
  assert.equal(voiceCommandService.extractNumber('set it to 42 percent'), 42);
  assert.equal(voiceCommandService.extractNumber('brightness 75'), 75);
  assert.equal(voiceCommandService.extractNumber('set to50'), 50);
  assert.equal(voiceCommandService.extractNumber(`ignore ${'x'.repeat(5000)} 99`), null);
});

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

test('Reachy-origin voice hard-denies locks, garage, and alarm controls before execution', async () => {
  const voiceCommandService = require('../services/voiceCommandService');
  for (const commandText of [
    'Reachy unlock the front door',
    'unlock the front door',
    'open the garage',
    'close my garage door',
    'disarm the security alarm'
  ]) {
    const result = await voiceCommandService.processCommand({
      commandText,
      room: 'Office',
      originDeviceType: 'robot'
    });
    assert.equal(result.intent.action, 'reachy_high_risk_denied', commandText);
    assert.equal(result.execution.status, 'failed', commandText);
    assert.deepEqual(result.execution.actions, [], commandText);
  }
});

test('Reachy-origin voice cannot execute a security-sensitive workflow', async (t) => {
  const voiceCommandService = require('../services/voiceCommandService');
  const originalGetContext = voiceCommandService.getContext;
  const originalInterpretCommand = voiceCommandService.interpretCommand;
  const originalImmediate = voiceCommandService.isImmediateControlRequest;
  const originalExecuteActions = voiceCommandService.executeActions;
  let executed = false;
  t.after(() => {
    voiceCommandService.getContext = originalGetContext;
    voiceCommandService.interpretCommand = originalInterpretCommand;
    voiceCommandService.isImmediateControlRequest = originalImmediate;
    voiceCommandService.executeActions = originalExecuteActions;
  });
  const workflow = {
    _id: { toString: () => 'workflow-security' },
    name: 'Night Watch',
    category: 'security',
    trigger: { type: 'manual' },
    actions: []
  };
  voiceCommandService.getContext = async () => ({
    devices: [],
    scenes: [],
    workflows: [],
    raw: { devices: [], scenes: [], workflows: [workflow] },
    deviceMap: new Map(),
    sceneMap: new Map(),
    workflowMap: new Map([['workflow-security', workflow]])
  });
  voiceCommandService.isImmediateControlRequest = () => false;
  voiceCommandService.interpretCommand = async () => ({
    interpretation: {
      intent: 'workflow_control',
      confidence: 1,
      normalizedCommand: 'run Night Watch',
      actions: [{ type: 'workflow_control', workflowId: 'workflow-security', operation: 'run' }],
      response: 'Running Night Watch.'
    },
    llm: { provider: 'local', model: 'test', processingTimeMs: 1 }
  });
  voiceCommandService.executeActions = async () => {
    executed = true;
    throw new Error('must not execute');
  };

  const result = await voiceCommandService.processCommand({
    commandText: 'Run Night Watch',
    room: 'Office',
    originDeviceType: 'robot'
  });
  assert.equal(executed, false);
  assert.equal(result.intent.action, 'reachy_high_risk_denied');
  assert.equal(result.execution.status, 'failed');
});

test('Reachy-origin policy denies direct network and private robot actions by semantics', () => {
  const voiceCommandService = require('../services/voiceCommandService');
  const context = { deviceMap: new Map(), sceneMap: new Map(), workflowMap: new Map() };
  for (const action of [
    { type: 'http_request', parameters: { url: 'https://example.test/hook' } },
    { type: 'isy_network_resource', parameters: { id: 'resource-1' } },
    { type: 'reachy_action', parameters: { command: 'snapshot' } },
    { type: 'reachy_action', command: 'start-face-tracking' },
    { type: 'reachy_action', action: 'release' }
  ]) {
    const result = voiceCommandService.enforceReachyOriginPolicy('do the requested action', {
      intent: action.type,
      actions: [action],
      response: 'Running.'
    }, context);
    assert.equal(result.intent, 'reachy_high_risk_denied', action.type);
    assert.deepEqual(result.actions, [], action.type);
  }
});

test('Reachy-origin scene and workflow target variants resolve fail-closed', () => {
  const voiceCommandService = require('../services/voiceCommandService');
  const securityScene = { _id: 'scene-1', category: 'security', deviceActions: [] };
  const securityWorkflow = { _id: 'workflow-1', category: 'security', actions: [] };
  const context = {
    deviceMap: new Map(),
    sceneMap: new Map([['scene-1', securityScene]]),
    workflowMap: new Map([['workflow-1', securityWorkflow]])
  };
  for (const action of [
    { type: 'scene_activate', target: { sceneId: 'scene-1' } },
    { type: 'scene_activate', target: 'missing-scene' },
    { type: 'workflow_control', target: { workflowId: 'workflow-1' } },
    { type: 'workflow_control', parameters: { workflowId: 'missing-workflow' } }
  ]) {
    const result = voiceCommandService.enforceReachyOriginPolicy('run it', {
      intent: action.type,
      actions: [action]
    }, context);
    assert.equal(result.intent, 'reachy_high_risk_denied');
  }
});

function buildReachyPolicyContext() {
  const devices = {
    lock: { _id: 'lock-1', name: 'Front Door', type: 'lock', status: true, properties: {} },
    garage: { _id: 'garage-1', name: 'Main Garage', type: 'garage', status: false, properties: {} },
    siren: {
      _id: 'siren-1',
      name: 'Security Sounder',
      type: 'switch',
      status: false,
      properties: { supportsAlarm: true }
    },
    light: { _id: 'light-1', name: 'Kitchen Light', type: 'light', status: false, properties: {} }
  };
  const deviceMap = new Map(Object.values(devices).map((device) => [device._id, device]));
  const groupMap = new Map([
    ['security-group', { _id: 'security-group', complete: true, deviceIds: ['light-1', 'lock-1'] }],
    ['garage-group', { _id: 'garage-group', complete: true, deviceIds: ['garage-1'] }],
    ['light-group', { _id: 'light-group', complete: true, deviceIds: ['light-1'] }],
    ['incomplete-group', { _id: 'incomplete-group', complete: false, deviceIds: ['light-1'] }]
  ]);
  return {
    devices,
    deviceMap,
    groupMap,
    sceneMap: new Map(),
    workflowMap: new Map()
  };
}

test('Reachy-origin policy normalizes device aliases and applies device-type semantics', () => {
  const voiceCommandService = require('../services/voiceCommandService');
  const context = buildReachyPolicyContext();
  const deniedActions = [
    { type: 'device_control', target: 'lock-1', parameters: { action: 'lock' } },
    { type: 'device_control', target: 'lock-1', parameters: { action: 'turn_off' } },
    { type: 'device_control', target: 'lock-1', parameters: { action: 'turnOff' } },
    { type: 'device_control', target: 'lock-1', parameters: { action: 'toggle' } },
    { type: 'device_control', target: 'lock-1', parameters: { action: 'un-lock' } },
    { type: 'device_control', target: 'garage-1', parameters: { action: 'turn_on' } },
    { type: 'device_control', target: 'garage-1', parameters: { action: 'turnOn' } },
    { type: 'device_control', target: 'garage-1', parameters: { action: 'toggle' } },
    { type: 'device_control', target: 'garage-1', parameters: { action: 'o-pen' } },
    { type: 'device_control', target: 'siren-1', parameters: { action: 'alarmon' } },
    { type: 'device_control', target: 'siren-1', parameters: { action: 'alarmoff' } },
    { type: 'device_control', target: 'siren-1', parameters: { action: 'turnOnAlarm' } },
    { type: 'device_control', target: 'siren-1', parameters: { action: 'turnOffAlarm' } },
    { type: 'device_control', target: 'siren-1', parameters: { action: 'soundAlarm' } },
    { type: 'device_control', target: 'siren-1', parameters: { action: 'silenceAlarm' } }
  ];

  deniedActions.forEach((action) => {
    const result = voiceCommandService.enforceReachyOriginPolicy('please do it', {
      intent: 'device_control',
      actions: [action]
    }, context);
    assert.equal(result.intent, 'reachy_high_risk_denied', JSON.stringify(action));
  });

  const safe = {
    intent: 'device_control',
    actions: [{ type: 'device_control', target: 'light-1', parameters: { action: 'turn-on' } }]
  };
  assert.equal(voiceCommandService.enforceReachyOriginPolicy('turn on the kitchen light', safe, context), safe);
});

test('Reachy-origin policy denies property and capability aliases that mutate security state', () => {
  const voiceCommandService = require('../services/voiceCommandService');
  const context = buildReachyPolicyContext();
  const mutations = [
    { property: 'lockState', value: 'unlocked' },
    { propertyName: 'state', value: 'locked' },
    { attribute: 'securityMode', value: 'disarmed' },
    { capability: 'garageDoorControl', value: 'closed' },
    { capabilityId: 'alarm', value: 'off' },
    { property: 'state', value: 'armed' }
  ];

  mutations.forEach((parameters) => {
    const action = {
      type: 'Device-Control',
      target: 'light-1',
      parameters: { action: 'setProperty', ...parameters }
    };
    const result = voiceCommandService.enforceReachyOriginPolicy('set the requested property', {
      intent: 'device_control',
      actions: [action]
    }, context);
    assert.equal(result.intent, 'reachy_high_risk_denied', JSON.stringify(parameters));
  });
});

test('Reachy-origin scene group controls resolve members and fail closed', () => {
  const voiceCommandService = require('../services/voiceCommandService');
  const context = buildReachyPolicyContext();
  const scenes = [
    {
      _id: 'lock-scene',
      category: 'custom',
      deviceActions: [{ deviceId: 'lock-1', action: 'turn_off' }],
      groupActions: []
    },
    {
      _id: 'garage-scene',
      category: 'custom',
      deviceActions: [],
      groupActions: [{ groupId: 'garage-group', action: 'turnOn' }]
    },
    {
      _id: 'missing-group-scene',
      category: 'custom',
      deviceActions: [],
      groupActions: [{ groupId: 'missing-group', action: 'turn_off' }]
    },
    {
      _id: 'incomplete-group-scene',
      category: 'custom',
      deviceActions: [],
      groupActions: [{ groupId: 'incomplete-group', action: 'turn_off' }]
    },
    {
      _id: 'safe-scene',
      category: 'custom',
      deviceActions: [],
      groupActions: [{ groupId: 'light-group', action: 'turn_off' }]
    }
  ];
  scenes.forEach((scene) => context.sceneMap.set(scene._id, scene));

  for (const sceneId of ['lock-scene', 'garage-scene', 'missing-group-scene', 'incomplete-group-scene']) {
    const result = voiceCommandService.enforceReachyOriginPolicy('run that scene', {
      intent: 'scene_activate',
      actions: [{ type: 'scene_activate', target: { sceneId } }]
    }, context);
    assert.equal(result.intent, 'reachy_high_risk_denied', sceneId);
  }

  const safe = {
    intent: 'scene_activate',
    actions: [{ type: 'scene_activate', target: { sceneId: 'safe-scene' } }]
  };
  assert.equal(voiceCommandService.enforceReachyOriginPolicy('run safe scene', safe, context), safe);
});

test('Reachy-origin workflow policy recursively inspects branches, repeats, graph nodes, and workflow references', () => {
  const voiceCommandService = require('../services/voiceCommandService');
  const context = buildReachyPolicyContext();
  const workflows = [
    {
      _id: 'repeat-lock',
      category: 'custom',
      actions: [{
        type: 'repeat',
        parameters: {
          actions: [{ type: 'DeViCe-AcTiOn', deviceId: 'lock-1', action: 'turnOff' }]
        }
      }]
    },
    {
      _id: 'false-garage',
      category: 'custom',
      actions: [{
        type: 'condition',
        parameters: {
          onFalseActions: [{ type: 'device_control', target: 'garage-1', parameters: { action: 'toggle' } }]
        }
      }]
    },
    {
      _id: 'true-property',
      category: 'custom',
      actions: [{
        type: 'condition',
        onTrueActions: [{
          type: 'device_control',
          target: 'light-1',
          parameters: { action: 'setProperty', attribute: 'alarmState', value: 'armed' }
        }]
      }]
    },
    {
      _id: 'graph-lock',
      category: 'custom',
      actions: [],
      graph: {
        nodes: [{ type: 'DEVICE_ACTION', data: { deviceId: 'lock-1', action: 'l-o-c-k' } }]
      }
    },
    {
      _id: 'safe-workflow',
      category: 'comfort',
      actions: [{ type: 'device_control', target: 'light-1', parameters: { action: 'turn_off' } }]
    }
  ];
  workflows.forEach((workflow) => context.workflowMap.set(workflow._id, workflow));
  context.workflowMap.set('nested-lock', {
    _id: 'nested-lock',
    category: 'custom',
    actions: [{ type: 'device_control', target: 'lock-1', parameters: { action: 'toggle' } }]
  });
  context.workflowMap.set('parent-nested', {
    _id: 'parent-nested',
    category: 'custom',
    actions: [{ type: 'Workflow-Control', target: { workflowId: 'nested-lock' }, operation: 'run' }]
  });

  for (const workflowId of ['repeat-lock', 'false-garage', 'true-property', 'graph-lock', 'parent-nested']) {
    assert.equal(
      voiceCommandService.isReachySensitiveWorkflow(context.workflowMap.get(workflowId), context),
      true,
      workflowId
    );
  }
  assert.equal(voiceCommandService.isReachySensitiveWorkflow(context.workflowMap.get('safe-workflow'), context), false);

  for (const workflowId of ['missing-workflow', 'nested-lock']) {
    const result = voiceCommandService.enforceReachyOriginPolicy('run the workflow', {
      intent: 'workflow_control',
      actions: [{ type: 'workflow_control', target: { workflowId }, operation: 'run' }]
    }, context);
    assert.equal(result.intent, 'reachy_high_risk_denied', workflowId);
  }
});

test('Reachy-origin utterance normalization catches lock, garage, and siren evasions', () => {
  const voiceCommandService = require('../services/voiceCommandService');
  for (const commandText of [
    'lock the front door',
    'turn off the lock',
    'toggle front lock',
    'turn on garage',
    'toggle the garage',
    'silence the siren',
    'un-lock the front door',
    'un lock the front door'
  ]) {
    assert.equal(voiceCommandService.isReachyHighRiskUtterance(commandText), true, commandText);
  }
});

test('Reachy-origin policy rechecks a sensitive action synthesized by the final fallback', async (t) => {
  const voiceCommandService = require('../services/voiceCommandService');
  const originalGetContext = voiceCommandService.getContext;
  const originalInterpretCommand = voiceCommandService.interpretCommand;
  const originalExecuteActions = voiceCommandService.executeActions;
  let executed = false;
  t.after(() => {
    voiceCommandService.getContext = originalGetContext;
    voiceCommandService.interpretCommand = originalInterpretCommand;
    voiceCommandService.executeActions = originalExecuteActions;
  });

  const lock = {
    _id: { toString: () => 'lock-1' },
    name: 'Front Door',
    room: 'Entry',
    type: 'lock',
    status: true,
    properties: {}
  };
  const context = {
    devices: [{
      id: 'lock-1',
      name: 'Front Door',
      room: 'Entry',
      type: 'lock',
      source: 'local',
      capabilities: ['lock', 'unlock', 'turn_off'],
      properties: {}
    }],
    scenes: [],
    workflows: [],
    raw: { devices: [lock], groups: [], scenes: [], workflows: [] },
    deviceMap: new Map([['lock-1', lock]]),
    groupMap: new Map(),
    sceneMap: new Map(),
    workflowMap: new Map()
  };
  voiceCommandService.getContext = async () => context;
  voiceCommandService.interpretCommand = async () => ({
    interpretation: null,
    llm: { provider: 'local', model: 'test', processingTimeMs: 1 }
  });
  voiceCommandService.executeActions = async () => {
    executed = true;
    throw new Error('must not execute');
  };

  const result = await voiceCommandService.processCommand({
    commandText: 'turn off front door routine',
    room: 'Entry',
    originDeviceType: 'robot'
  });
  assert.equal(executed, false);
  assert.equal(result.intent.action, 'reachy_high_risk_denied');
  assert.deepEqual(result.execution.actions, []);
});

test('Reachy-origin scene authorization refreshes mutable context at the execution boundary', async (t) => {
  const voiceCommandService = require('../services/voiceCommandService');
  const originalGetContext = voiceCommandService.getContext;
  const originalInterpretCommand = voiceCommandService.interpretCommand;
  const originalImmediate = voiceCommandService.isImmediateControlRequest;
  const originalRejectUnsafe = voiceCommandService.shouldRejectUnsafeControlInterpretation;
  const originalExecuteActions = voiceCommandService.executeActions;
  let contextRead = 0;
  let freshRequested = false;
  let executed = false;
  t.after(() => {
    voiceCommandService.getContext = originalGetContext;
    voiceCommandService.interpretCommand = originalInterpretCommand;
    voiceCommandService.isImmediateControlRequest = originalImmediate;
    voiceCommandService.shouldRejectUnsafeControlInterpretation = originalRejectUnsafe;
    voiceCommandService.executeActions = originalExecuteActions;
  });

  const base = buildReachyPolicyContext();
  const safeScene = {
    _id: 'mutable-scene',
    category: 'custom',
    deviceActions: [{ deviceId: 'light-1', action: 'turn_on' }],
    groupActions: []
  };
  const mutatedScene = {
    ...safeScene,
    deviceActions: [{ deviceId: 'lock-1', action: 'turn_off' }]
  };
  const makeContext = (scene) => ({
    ...base,
    devices: Object.values(base.devices),
    scenes: [{ id: 'mutable-scene', name: 'Evening', category: 'custom' }],
    workflows: [],
    raw: { devices: Object.values(base.devices), groups: [], scenes: [scene], workflows: [] },
    sceneMap: new Map([['mutable-scene', scene]])
  });
  voiceCommandService.getContext = async (options = {}) => {
    contextRead += 1;
    if (options.forceRefresh === true) freshRequested = true;
    return contextRead === 1 ? makeContext(safeScene) : makeContext(mutatedScene);
  };
  voiceCommandService.isImmediateControlRequest = () => false;
  voiceCommandService.shouldRejectUnsafeControlInterpretation = () => false;
  voiceCommandService.interpretCommand = async () => ({
    interpretation: {
      intent: 'scene_activate',
      confidence: 1,
      normalizedCommand: 'run evening',
      actions: [{ type: 'scene_activate', target: { sceneId: 'mutable-scene' } }],
      response: 'Running Evening.'
    },
    llm: { provider: 'local', model: 'test', processingTimeMs: 1 }
  });
  voiceCommandService.executeActions = async () => {
    executed = true;
    throw new Error('must not execute');
  };

  const result = await voiceCommandService.processCommand({
    commandText: 'run evening',
    room: 'Living Room',
    originDeviceType: 'robot'
  });
  assert.equal(freshRequested, true);
  assert.equal(contextRead, 2);
  assert.equal(executed, false);
  assert.equal(result.intent.action, 'reachy_high_risk_denied');
});

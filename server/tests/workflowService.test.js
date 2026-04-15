const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

test('createWorkflowFromText can reach automationService after startup dependency loading', async (t) => {
  const modulePaths = [
    '../services/automationSchedulerService',
    '../services/workflowService',
    '../services/automationService',
    '../services/workflowExecutionService',
    '../services/insteonService',
    '../services/eventStreamService'
  ].map((relativePath) => require.resolve(relativePath));

  modulePaths.forEach((modulePath) => {
    delete require.cache[modulePath];
  });

  const automationSchedulerService = require('../services/automationSchedulerService');
  const automationService = require('../services/automationService');
  const workflowService = require('../services/workflowService');

  assert.ok(automationSchedulerService);

  const originalCreateAutomationFromText = automationService.createAutomationFromText;
  automationService.createAutomationFromText = async () => ({
    success: true,
    handledDirectCommand: true,
    message: 'Handled directly for test'
  });

  t.after(() => {
    automationService.createAutomationFromText = originalCreateAutomationFromText;
    modulePaths.forEach((modulePath) => {
      delete require.cache[modulePath];
    });
  });

  const result = await workflowService.createWorkflowFromText('turn on the office lights', null, 'chat');

  assert.equal(result.success, true);
  assert.equal(result.handledDirectCommand, true);
  assert.equal(result.message, 'Handled directly for test');
});

test('createWorkflowFromText creates multiple workflows when multiple automations are returned', async (t) => {
  const Workflow = require('../models/Workflow');
  const Automation = require('../models/Automation');
  const automationService = require('../services/automationService');
  const workflowService = require('../services/workflowService');
  const eventStreamService = require('../services/eventStreamService');

  const automationIdOne = new mongoose.Types.ObjectId();
  const automationIdTwo = new mongoose.Types.ObjectId();
  const triggerDeviceOne = new mongoose.Types.ObjectId().toString();
  const triggerDeviceTwo = new mongoose.Types.ObjectId().toString();

  const originalCreateAutomationFromText = automationService.createAutomationFromText;
  const originalWorkflowSave = Workflow.prototype.save;
  const originalWorkflowFindOne = Workflow.findOne;
  const originalWorkflowFindById = Workflow.findById;
  const originalAutomationFindByIdAndUpdate = Automation.findByIdAndUpdate;
  const originalSyncWorkflowToAutomation = workflowService.syncWorkflowToAutomation;
  const originalPublishSafe = eventStreamService.publishSafe;

  const savedWorkflows = new Map();
  const linkedAutomationIds = [];

  automationService.createAutomationFromText = async () => ({
    success: true,
    automation: null,
    automations: [
      {
        _id: automationIdOne,
        name: 'Laundry Room Fan Auto Off',
        description: 'Turns off the laundry room fan after 30 minutes.',
        enabled: true,
        category: 'energy',
        priority: 5,
        cooldown: 0,
        trigger: {
          type: 'device_state',
          conditions: {
            deviceId: triggerDeviceOne,
            property: 'status',
            operator: 'eq',
            value: true
          }
        },
        actions: [
          { type: 'delay', target: null, parameters: { seconds: 1800 } },
          { type: 'device_control', target: { kind: 'context', key: 'triggeringDeviceId' }, parameters: { action: 'turn_off' } }
        ]
      },
      {
        _id: automationIdTwo,
        name: 'Guest Bathroom Fan Auto Off',
        description: 'Turns off the guest bathroom fan after 30 minutes.',
        enabled: true,
        category: 'energy',
        priority: 5,
        cooldown: 0,
        trigger: {
          type: 'device_state',
          conditions: {
            deviceId: triggerDeviceTwo,
            property: 'status',
            operator: 'eq',
            value: true
          }
        },
        actions: [
          { type: 'delay', target: null, parameters: { seconds: 1800 } },
          { type: 'device_control', target: { kind: 'context', key: 'triggeringDeviceId' }, parameters: { action: 'turn_off' } }
        ]
      }
    ]
  });

  Workflow.findOne = () => ({
    select: async () => null
  });

  Workflow.prototype.save = async function saveWorkflow() {
    const objectId = this._id || new mongoose.Types.ObjectId();
    this._id = objectId;

    const workflowRecord = {
      _id: objectId,
      name: this.name,
      description: this.description,
      source: this.source,
      enabled: this.enabled,
      category: this.category,
      priority: this.priority,
      cooldown: this.cooldown,
      trigger: this.trigger,
      actions: this.actions,
      graph: this.graph,
      linkedAutomationId: this.linkedAutomationId,
      voiceAliases: this.voiceAliases || []
    };
    savedWorkflows.set(objectId.toString(), workflowRecord);
    return this;
  };

  Workflow.findById = (id) => ({
    lean: async () => savedWorkflows.get(id.toString()) || null
  });

  Automation.findByIdAndUpdate = async (automationId, update) => {
    linkedAutomationIds.push({ automationId: automationId.toString(), update });
    return {
      _id: automationId,
      ...update
    };
  };

  workflowService.syncWorkflowToAutomation = async () => ({ success: true });
  eventStreamService.publishSafe = async () => ({ success: true });

  t.after(() => {
    automationService.createAutomationFromText = originalCreateAutomationFromText;
    Workflow.prototype.save = originalWorkflowSave;
    Workflow.findOne = originalWorkflowFindOne;
    Workflow.findById = originalWorkflowFindById;
    Automation.findByIdAndUpdate = originalAutomationFindByIdAndUpdate;
    workflowService.syncWorkflowToAutomation = originalSyncWorkflowToAutomation;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  const result = await workflowService.createWorkflowFromText('Create fan auto-off workflows', null, 'chat');

  assert.equal(result.success, true);
  assert.equal(result.createdCount, 2);
  assert.equal(result.workflows.length, 2);
  assert.equal(result.automations.length, 2);
  assert.equal(result.workflow.name, 'Laundry Room Fan Auto Off');
  assert.equal(result.workflows[1].name, 'Guest Bathroom Fan Auto Off');
  assert.equal(linkedAutomationIds.length, 2);
});

test('reviseWorkflowFromText updates an existing workflow from natural language', async (t) => {
  const workflowService = require('../services/workflowService');
  const automationService = require('../services/automationService');
  const eventStreamService = require('../services/eventStreamService');

  const workflowId = new mongoose.Types.ObjectId().toString();
  const existingWorkflow = {
    _id: workflowId,
    name: 'Alarm Armed: Turn Off Insteon Interior',
    description: 'Turns off selected interior lights when the alarm is armed stay.',
    enabled: true,
    category: 'security',
    priority: 5,
    trigger: {
      type: 'security_alarm_status',
      conditions: {
        states: ['armedStay']
      }
    },
    actions: [
      {
        type: 'device_control',
        target: 'device-1',
        parameters: { action: 'turn_off' }
      }
    ]
  };

  const revisedWorkflow = {
    ...existingWorkflow,
    actions: [
      {
        type: 'device_control',
        target: { kind: 'device_group', group: 'Interior Lights' },
        parameters: { action: 'turn_off' }
      }
    ]
  };

  const originalGetWorkflowById = workflowService.getWorkflowById;
  const originalUpdateWorkflow = workflowService.updateWorkflow;
  const originalReviseAutomationFromText = automationService.reviseAutomationFromText;
  const originalPublishSafe = eventStreamService.publishSafe;
  let receivedExistingAutomation = null;
  let receivedUpdatePayload = null;

  t.after(() => {
    workflowService.getWorkflowById = originalGetWorkflowById;
    workflowService.updateWorkflow = originalUpdateWorkflow;
    automationService.reviseAutomationFromText = originalReviseAutomationFromText;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  workflowService.getWorkflowById = async () => existingWorkflow;
  automationService.reviseAutomationFromText = async (_text, existingAutomation) => {
    receivedExistingAutomation = existingAutomation;
    return {
      success: true,
      automation: {
        name: existingWorkflow.name,
        description: existingWorkflow.description,
        enabled: true,
        category: 'security',
        priority: 5,
        trigger: existingWorkflow.trigger,
        actions: revisedWorkflow.actions
      }
    };
  };
  workflowService.updateWorkflow = async (_id, payload) => {
    receivedUpdatePayload = payload;
    return revisedWorkflow;
  };
  eventStreamService.publishSafe = async () => ({ success: true });

  const result = await workflowService.reviseWorkflowFromText(
    workflowId,
    'Fix this workflow so it turns off all interior lights using the Interior Lights group.',
    null,
    'chat'
  );

  assert.equal(result.success, true);
  assert.equal(result.workflow._id, workflowId);
  assert.equal(receivedExistingAutomation.name, existingWorkflow.name);
  assert.deepEqual(receivedUpdatePayload.actions, revisedWorkflow.actions);
  assert.deepEqual(receivedUpdatePayload.trigger, existingWorkflow.trigger);
});

test('stopRunningWorkflowExecution closes stale running executions and records stop logs', async (t) => {
  const workflowService = require('../services/workflowService');
  const automationService = require('../services/automationService');
  const automationRuntimeService = require('../services/automationRuntimeService');
  const AutomationHistory = require('../models/AutomationHistory');

  const historyId = new mongoose.Types.ObjectId();
  const workflowId = new mongoose.Types.ObjectId();
  const correlationId = `corr-${Date.now()}`;
  const historyRecord = {
    _id: historyId,
    workflowId,
    workflowName: 'Laundry Room Fan Auto Off',
    automationName: 'Laundry Room Fan Auto Off',
    correlationId,
    status: 'running',
    successfulActions: 1,
    failedActions: 0,
    durationMs: null,
    error: null,
    toObject() {
      return {
        _id: this._id.toString(),
        workflowId: this.workflowId.toString(),
        workflowName: this.workflowName,
        automationName: this.automationName,
        correlationId: this.correlationId,
        status: this.status,
        successfulActions: this.successfulActions,
        failedActions: this.failedActions,
        durationMs: this.durationMs,
        error: this.error
      };
    },
    async markCompleted(status, error = null) {
      this.status = status;
      this.durationMs = 1250;
      this.error = error ? { message: error.message } : null;
      return this;
    }
  };

  const originalFindById = AutomationHistory.findById;
  const originalIsExecutionActive = automationService.isExecutionActive;
  const originalBuildExecutionContextFromHistory = automationRuntimeService.buildExecutionContextFromHistory;
  const originalRecordExecutionStopRequested = automationRuntimeService.recordExecutionStopRequested;
  const originalRecordExecutionCompleted = automationRuntimeService.recordExecutionCompleted;
  let stopRequestPayload = null;
  let completionPayload = null;

  t.after(() => {
    AutomationHistory.findById = originalFindById;
    automationService.isExecutionActive = originalIsExecutionActive;
    automationRuntimeService.buildExecutionContextFromHistory = originalBuildExecutionContextFromHistory;
    automationRuntimeService.recordExecutionStopRequested = originalRecordExecutionStopRequested;
    automationRuntimeService.recordExecutionCompleted = originalRecordExecutionCompleted;
  });

  AutomationHistory.findById = async (id) => {
    if (id?.toString?.() !== historyId.toString()) {
      return null;
    }
    return historyRecord;
  };
  automationService.isExecutionActive = () => false;
  automationRuntimeService.buildExecutionContextFromHistory = () => ({
    historyId: historyId.toString(),
    workflowId: workflowId.toString(),
    workflowName: historyRecord.workflowName,
    automationName: historyRecord.automationName,
    correlationId
  });
  automationRuntimeService.recordExecutionStopRequested = async (_context, payload) => {
    stopRequestPayload = payload;
  };
  automationRuntimeService.recordExecutionCompleted = async (_context, payload) => {
    completionPayload = payload;
  };

  const result = await workflowService.stopRunningWorkflowExecution(historyId.toString(), {
    requestedBy: 'qa@example.com',
    reason: 'manual stop request'
  });

  assert.equal(result.success, true);
  assert.equal(result.active, false);
  assert.equal(result.execution.status, 'cancelled');
  assert.equal(stopRequestPayload.requestedBy, 'qa@example.com');
  assert.equal(stopRequestPayload.reason, 'manual stop request');
  assert.equal(completionPayload.status, 'cancelled');
  assert.equal(completionPayload.message, 'Workflow execution cancelled by user.');
});

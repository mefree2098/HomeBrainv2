const test = require('node:test');
const assert = require('node:assert/strict');

const AutomationHistory = require('../models/AutomationHistory');
const automationRuntimeService = require('../services/automationRuntimeService');
const eventStreamService = require('../services/eventStreamService');
const telemetryService = require('../services/telemetryService');

test('reconcileRunningExecutions cancels stale running histories', async (t) => {
  const originalFind = AutomationHistory.find;
  const originalUpdateOne = AutomationHistory.updateOne;
  const originalPublishSafe = eventStreamService.publishSafe;
  const originalRecordWorkflowExecution = telemetryService.recordWorkflowExecution;

  const now = new Date('2026-03-31T23:40:00.000Z');
  const realDateNow = Date.now;
  Date.now = () => now.getTime();

  const histories = [
    {
      _id: 'history-1',
      automationId: 'automation-1',
      automationName: 'Theater Bathroom Fan Auto Off',
      workflowId: 'workflow-1',
      workflowName: 'Theater Bathroom Fan Auto Off',
      correlationId: 'corr-1',
      triggerType: 'device_state',
      triggerSource: 'scheduler',
      triggerContext: { triggeringDeviceId: 'device-1' },
      totalActions: 2,
      status: 'running',
      startedAt: new Date('2026-03-31T23:20:00.000Z'),
      actionResults: [
        { success: true },
        { success: false }
      ],
      async markCompleted(status, error) {
        this.status = status;
        this.completedAt = now;
        this.durationMs = this.completedAt - this.startedAt;
        this.currentAction = null;
        this.error = {
          message: error.message,
          failedAt: now
        };
        this.successfulActions = this.actionResults.filter((entry) => entry.success).length;
        this.failedActions = this.actionResults.filter((entry) => !entry.success).length;
        return this;
      }
    }
  ];

  const updates = [];
  const published = [];

  AutomationHistory.find = async () => histories;
  AutomationHistory.updateOne = async (query, update) => {
    updates.push({ query, update });
    return { acknowledged: true };
  };
  eventStreamService.publishSafe = async (payload) => {
    published.push(payload);
    return payload;
  };
  telemetryService.recordWorkflowExecution = async () => ({ inserted: true });

  t.after(() => {
    AutomationHistory.find = originalFind;
    AutomationHistory.updateOne = originalUpdateOne;
    eventStreamService.publishSafe = originalPublishSafe;
    telemetryService.recordWorkflowExecution = originalRecordWorkflowExecution;
    Date.now = realDateNow;
  });

  const result = await automationRuntimeService.reconcileRunningExecutions({ reason: 'server_restart' });

  assert.equal(result.cancelledCount, 1);
  assert.equal(histories[0].status, 'cancelled');
  assert.equal(histories[0].successfulActions, 1);
  assert.equal(histories[0].failedActions, 1);
  assert.match(histories[0].error.message, /server restart/i);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].query._id, 'history-1');
  assert.equal(updates[0].update.$set.currentAction, null);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'automation.execution.completed');
  assert.equal(published[0].payload.status, 'cancelled');
});

test('recordActionStarted persists delay timer metadata for running executions', async (t) => {
  const originalUpdateOne = AutomationHistory.updateOne;
  const originalPublishSafe = eventStreamService.publishSafe;
  const originalRecordWorkflowExecution = telemetryService.recordWorkflowExecution;
  const updates = [];
  const published = [];
  const startedAt = new Date('2026-04-02T18:00:00.000Z');
  const endsAt = new Date('2026-04-02T18:01:30.000Z');

  AutomationHistory.updateOne = async (query, update) => {
    updates.push({ query, update });
    return { acknowledged: true };
  };
  eventStreamService.publishSafe = async (payload) => {
    published.push(payload);
    return payload;
  };
  telemetryService.recordWorkflowExecution = async () => ({ inserted: true });

  t.after(() => {
    AutomationHistory.updateOne = originalUpdateOne;
    eventStreamService.publishSafe = originalPublishSafe;
    telemetryService.recordWorkflowExecution = originalRecordWorkflowExecution;
  });

  await automationRuntimeService.recordActionStarted({
    automationId: 'automation-1',
    automationName: 'Theater Bathroom Fan Auto Off',
    workflowId: 'workflow-1',
    workflowName: 'Theater Bathroom Fan Auto Off',
    historyId: 'history-1',
    correlationId: 'corr-1',
    triggerType: 'manual',
    triggerSource: 'manual'
  }, {
    actionIndex: 0,
    parentActionIndex: null,
    actionType: 'delay',
    target: null,
    startedAt,
    timer: {
      durationMs: 90_000,
      endsAt
    },
    nextAction: {
      actionIndex: 1,
      parentActionIndex: null,
      actionType: 'device_control',
      target: 'device-1',
      message: 'Turn off device-1'
    }
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].query._id, 'history-1');
  assert.equal(updates[0].update.$set.currentAction.actionType, 'delay');
  assert.equal(updates[0].update.$set.currentAction.timer.durationMs, 90_000);
  assert.equal(updates[0].update.$set.currentAction.timer.endsAt.toISOString(), endsAt.toISOString());
  assert.equal(updates[0].update.$set.currentAction.nextAction.actionType, 'device_control');
  assert.equal(updates[0].update.$push.runtimeEvents.$each[0].details.nextAction.message, 'Turn off device-1');
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'automation.action.started');
  assert.equal(published[0].payload.timer.durationMs, 90_000);
  assert.equal(published[0].payload.nextAction.actionType, 'device_control');
  assert.equal(published[0].payload.startedAt.toISOString(), startedAt.toISOString());
});

test('getWorkflowExecutionHistory returns paginated workflow runtime history for a time window', async (t) => {
  const originalCountDocuments = AutomationHistory.countDocuments;
  const originalFind = AutomationHistory.find;
  const now = new Date('2026-04-02T18:00:00.000Z');
  const realDateNow = Date.now;
  Date.now = () => now.getTime();

  let capturedQuery = null;
  let capturedSkip = null;
  let capturedLimit = null;

  AutomationHistory.countDocuments = async (query) => {
    capturedQuery = query;
    return 12;
  };
  AutomationHistory.find = (query) => {
    capturedQuery = query;
    return {
      sort() {
        return this;
      },
      skip(value) {
        capturedSkip = value;
        return this;
      },
      limit(value) {
        capturedLimit = value;
        return this;
      },
      lean: async () => ([
        { _id: 'history-9', workflowId: 'workflow-1', status: 'failed' },
        { _id: 'history-8', workflowId: 'workflow-1', status: 'success' }
      ])
    };
  };

  t.after(() => {
    AutomationHistory.countDocuments = originalCountDocuments;
    AutomationHistory.find = originalFind;
    Date.now = realDateNow;
  });

  const result = await automationRuntimeService.getWorkflowExecutionHistory({
    workflowId: 'workflow-1',
    limit: 5,
    page: 2,
    hours: 24
  });

  assert.equal(result.history.length, 2);
  assert.equal(result.pagination.page, 2);
  assert.equal(result.pagination.limit, 5);
  assert.equal(result.pagination.total, 12);
  assert.equal(result.pagination.totalPages, 3);
  assert.equal(result.pagination.hasPreviousPage, true);
  assert.equal(result.pagination.hasNextPage, true);
  assert.equal(capturedSkip, 5);
  assert.equal(capturedLimit, 5);
  assert.equal(capturedQuery.workflowId, 'workflow-1');
  assert.ok(capturedQuery.startedAt.$gte instanceof Date);
  assert.equal(capturedQuery.startedAt.$gte.toISOString(), '2026-04-01T18:00:00.000Z');
});

test('getWorkflowRuntimeTelemetry summarizes workflow runtime outcomes for the selected window', async (t) => {
  const originalCountDocuments = AutomationHistory.countDocuments;
  const originalAggregate = AutomationHistory.aggregate;
  const now = new Date('2026-04-02T18:00:00.000Z');
  const realDateNow = Date.now;
  Date.now = () => now.getTime();

  let runningQuery = null;
  let aggregatePipeline = null;

  AutomationHistory.countDocuments = async (query) => {
    runningQuery = query;
    return 3;
  };
  AutomationHistory.aggregate = async (pipeline) => {
    aggregatePipeline = pipeline;
    return [{
      executionCount: 20,
      successCount: 12,
      partialSuccessCount: 3,
      failedCount: 4,
      cancelledCount: 1,
      runningCountInRange: 2,
      totalActions: 90,
      successfulActions: 72,
      failedActions: 8,
      averageDurationMs: 42000,
      lastStartedAt: new Date('2026-04-02T17:55:00.000Z'),
      lastCompletedAt: new Date('2026-04-02T17:57:00.000Z')
    }];
  };

  t.after(() => {
    AutomationHistory.countDocuments = originalCountDocuments;
    AutomationHistory.aggregate = originalAggregate;
    Date.now = realDateNow;
  });

  const result = await automationRuntimeService.getWorkflowRuntimeTelemetry({
    workflowId: 'workflow-1',
    hours: 24 * 7
  });

  assert.equal(result.runningNow, 3);
  assert.equal(result.executionCount, 20);
  assert.equal(result.successCount, 12);
  assert.equal(result.partialSuccessCount, 3);
  assert.equal(result.failedCount, 4);
  assert.equal(result.cancelledCount, 1);
  assert.equal(result.runningCountInRange, 2);
  assert.equal(result.averageDurationMs, 42000);
  assert.equal(result.failureRatePct, 20);
  assert.equal(result.timeRange.hours, 168);
  assert.equal(runningQuery.workflowId, 'workflow-1');
  assert.equal(runningQuery.status, 'running');
  assert.equal(aggregatePipeline[0].$match.workflowId, 'workflow-1');
  assert.ok(aggregatePipeline[0].$match.startedAt.$gte instanceof Date);
  assert.equal(aggregatePipeline[0].$match.startedAt.$gte.toISOString(), '2026-03-26T18:00:00.000Z');
});

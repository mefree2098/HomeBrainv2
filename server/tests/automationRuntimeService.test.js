const test = require('node:test');
const assert = require('node:assert/strict');

const AutomationHistory = require('../models/AutomationHistory');
const automationRuntimeService = require('../services/automationRuntimeService');
const eventStreamService = require('../services/eventStreamService');

test('reconcileRunningExecutions cancels stale running histories', async (t) => {
  const originalFind = AutomationHistory.find;
  const originalUpdateOne = AutomationHistory.updateOne;
  const originalPublishSafe = eventStreamService.publishSafe;

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

  t.after(() => {
    AutomationHistory.find = originalFind;
    AutomationHistory.updateOne = originalUpdateOne;
    eventStreamService.publishSafe = originalPublishSafe;
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

  t.after(() => {
    AutomationHistory.updateOne = originalUpdateOne;
    eventStreamService.publishSafe = originalPublishSafe;
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

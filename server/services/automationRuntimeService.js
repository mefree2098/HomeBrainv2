const AutomationHistory = require('../models/AutomationHistory');
const eventStreamService = require('./eventStreamService');

const MAX_RUNTIME_EVENTS = Math.max(
  50,
  Number(process.env.AUTOMATION_RUNTIME_EVENT_LIMIT || 250)
);

function toObjectIdString(value) {
  return value?._id?.toString?.() || value?.toString?.() || null;
}

function sanitizeLevel(level) {
  return ['info', 'warn', 'error'].includes(level) ? level : 'info';
}

function humanizeToken(value = '') {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function capitalizeMessage(value = '') {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatRuntimeDuration(durationMs) {
  const normalized = Math.max(0, Number(durationMs) || 0);
  if (normalized < 1000) {
    return `${Math.round(normalized)} ms`;
  }

  const totalSeconds = Math.max(0, Math.round(normalized / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatInterruptionReason(reason = '') {
  const normalized = String(reason || '').trim().replace(/[_-]+/g, ' ');
  return normalized || 'server restart';
}

function buildExecutionPayload(context = {}, extra = {}) {
  return {
    automationId: context.automationId || null,
    automationName: context.automationName || null,
    workflowId: context.workflowId || null,
    workflowName: context.workflowName || null,
    historyId: context.historyId || null,
    correlationId: context.correlationId || null,
    triggerType: context.triggerType || null,
    triggerSource: context.triggerSource || null,
    triggerContext: context.triggerContext || {},
    totalActions: context.totalActions ?? null,
    ...extra
  };
}

function createRuntimeEvent(type, message, details = {}, level = 'info') {
  return {
    type: String(type || 'automation.runtime'),
    level: sanitizeLevel(level),
    message: String(message || 'Automation runtime update'),
    details: details && typeof details === 'object' ? details : {},
    createdAt: new Date()
  };
}

function sanitizeActionTimer(timer, startedAt = null) {
  if (!timer || typeof timer !== 'object') {
    return null;
  }

  const durationMs = Number(timer.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }

  const endsAt = timer.endsAt
    ? new Date(timer.endsAt)
    : (startedAt instanceof Date && Number.isFinite(startedAt.getTime())
      ? new Date(startedAt.getTime() + Math.round(durationMs))
      : null);

  return {
    durationMs: Math.round(durationMs),
    endsAt: endsAt instanceof Date && Number.isFinite(endsAt.getTime()) ? endsAt : null
  };
}

function sanitizeNextAction(nextAction) {
  if (!nextAction || typeof nextAction !== 'object') {
    return null;
  }

  const actionType = humanizeToken(nextAction.actionType || 'unknown');
  const message = typeof nextAction.message === 'string' && nextAction.message.trim()
    ? nextAction.message.trim()
    : (actionType ? capitalizeMessage(actionType) : 'Next action');

  return {
    actionIndex: Number.isInteger(nextAction.actionIndex) ? nextAction.actionIndex : null,
    parentActionIndex: Number.isInteger(nextAction.parentActionIndex) ? nextAction.parentActionIndex : null,
    actionType: String(nextAction.actionType || 'unknown'),
    target: Object.prototype.hasOwnProperty.call(nextAction, 'target') ? nextAction.target : null,
    message
  };
}

function formatActionStartMessage(actionType, timer = null) {
  if (timer?.durationMs) {
    return `Waiting ${formatRuntimeDuration(timer.durationMs)}`;
  }

  const normalizedType = humanizeToken(actionType || 'action');
  return normalizedType
    ? `Running ${normalizedType}`
    : 'Running action';
}

async function appendRuntimeEvent(historyId, event, currentAction = undefined) {
  if (!historyId || !event) {
    return;
  }

  const update = {
    $set: {
      lastEvent: event
    },
    $push: {
      runtimeEvents: {
        $each: [event],
        $slice: -MAX_RUNTIME_EVENTS
      }
    }
  };

  if (currentAction !== undefined) {
    update.$set.currentAction = currentAction;
  }

  await AutomationHistory.updateOne({ _id: historyId }, update);
}

async function publishAutomationEvent(type, context = {}, options = {}) {
  const payload = buildExecutionPayload(context, options.payload || {});
  return eventStreamService.publishSafe({
    type,
    source: options.source || 'automation',
    category: 'automation',
    severity: sanitizeLevel(options.severity || 'info'),
    payload,
    correlationId: context.correlationId || null,
    tags: Array.isArray(options.tags) ? options.tags : ['automation', 'runtime']
  });
}

function buildExecutionContext({
  automation,
  history,
  workflowId = null,
  workflowName = null,
  correlationId = null,
  triggerType = null,
  triggerSource = null,
  triggerContext = {},
  totalActions = 0
}) {
  return {
    automationId: toObjectIdString(automation?._id || history?.automationId),
    automationName: automation?.name || history?.automationName || null,
    workflowId: workflowId || toObjectIdString(history?.workflowId),
    workflowName: workflowName || history?.workflowName || null,
    historyId: toObjectIdString(history?._id),
    correlationId: correlationId || history?.correlationId || null,
    triggerType: triggerType || history?.triggerType || null,
    triggerSource: triggerSource || history?.triggerSource || null,
    triggerContext: triggerContext || history?.triggerContext || {},
    totalActions: totalActions ?? history?.totalActions ?? 0
  };
}

function buildExecutionContextFromHistory(history, overrides = {}) {
  return buildExecutionContext({
    automation: {
      _id: history?.automationId,
      name: history?.automationName
    },
    history,
    workflowId: overrides.workflowId || toObjectIdString(history?.workflowId),
    workflowName: overrides.workflowName || history?.workflowName || null,
    correlationId: overrides.correlationId || history?.correlationId || null,
    triggerType: overrides.triggerType || history?.triggerType || null,
    triggerSource: overrides.triggerSource || history?.triggerSource || null,
    triggerContext: overrides.triggerContext || history?.triggerContext || {},
    totalActions: overrides.totalActions ?? history?.totalActions ?? 0
  });
}

async function recordTriggerMatched(context, details = {}) {
  const event = createRuntimeEvent(
    'automation.trigger.matched',
    details.message || 'Automation trigger matched',
    details,
    'info'
  );
  await appendRuntimeEvent(context.historyId, event);
  await publishAutomationEvent('automation.trigger.matched', context, {
    payload: details,
    tags: ['automation', 'trigger', 'matched']
  });
}

async function recordExecutionStarted(context) {
  const event = createRuntimeEvent(
    'automation.execution.started',
    'Automation execution started',
    {
      totalActions: context.totalActions
    },
    'info'
  );
  await appendRuntimeEvent(context.historyId, event, null);
  await publishAutomationEvent('automation.execution.started', context, {
    payload: {
      status: 'running'
    },
    tags: ['automation', 'execution', 'started']
  });
}

async function recordActionStarted(context, details = {}) {
  const startedAt = details.startedAt ? new Date(details.startedAt) : new Date();
  const timer = sanitizeActionTimer(details.timer, startedAt);
  const nextAction = sanitizeNextAction(details.nextAction);
  const currentAction = {
    actionIndex: details.actionIndex,
    parentActionIndex: details.parentActionIndex ?? null,
    actionType: details.actionType || 'unknown',
    target: details.target ?? null,
    startedAt,
    updatedAt: startedAt,
    message: details.message || formatActionStartMessage(details.actionType, timer),
    timer,
    nextAction
  };

  const event = createRuntimeEvent(
    'automation.action.started',
    currentAction.message,
    {
      actionIndex: currentAction.actionIndex,
      parentActionIndex: currentAction.parentActionIndex,
      actionType: currentAction.actionType,
      target: currentAction.target,
      startedAt: currentAction.startedAt,
      timer: currentAction.timer,
      nextAction: currentAction.nextAction
    },
    'info'
  );

  await appendRuntimeEvent(context.historyId, event, currentAction);
  await publishAutomationEvent('automation.action.started', context, {
    payload: {
      actionIndex: currentAction.actionIndex,
      parentActionIndex: currentAction.parentActionIndex,
      actionType: currentAction.actionType,
      target: currentAction.target,
      startedAt: currentAction.startedAt,
      timer: currentAction.timer,
      nextAction: currentAction.nextAction,
      status: 'running',
      message: currentAction.message
    },
    tags: ['automation', 'action', 'started']
  });
}

async function recordActionCompleted(context, details = {}) {
  const level = details.success === false ? 'error' : 'info';
  const eventType = details.success === false ? 'automation.action.failed' : 'automation.action.completed';
  const message = details.message
    || (details.success === false
      ? `Action ${details.actionType || 'unknown'} failed`
      : `Action ${details.actionType || 'unknown'} completed`);
  const event = createRuntimeEvent(
    eventType,
    message,
    {
      actionIndex: details.actionIndex,
      parentActionIndex: details.parentActionIndex ?? null,
      actionType: details.actionType || 'unknown',
      target: details.target ?? null,
      durationMs: details.durationMs ?? null,
      error: details.error || null
    },
    level
  );

  const currentAction = details.success === false
    ? {
        actionIndex: details.actionIndex,
        parentActionIndex: details.parentActionIndex ?? null,
        actionType: details.actionType || 'unknown',
        target: details.target ?? null,
        startedAt: details.startedAt || new Date(),
        updatedAt: new Date(),
        message
      }
    : null;

  await appendRuntimeEvent(context.historyId, event, currentAction);
  await publishAutomationEvent(eventType, context, {
    severity: level,
    payload: {
      actionIndex: details.actionIndex,
      parentActionIndex: details.parentActionIndex ?? null,
      actionType: details.actionType || 'unknown',
      target: details.target ?? null,
      durationMs: details.durationMs ?? null,
      status: details.success === false ? 'failed' : 'success',
      error: details.error || null,
      message
    },
    tags: ['automation', 'action', details.success === false ? 'failed' : 'completed']
  });
}

async function recordExecutionCompleted(context, details = {}) {
  const status = details.status || 'success';
  const isFailure = status === 'failed';
  const isPartial = status === 'partial_success';
  const severity = isFailure ? 'error' : isPartial ? 'warn' : 'info';
  const message = details.message || (
    isFailure
      ? 'Automation execution failed'
      : isPartial
        ? 'Automation execution completed with issues'
        : 'Automation execution completed successfully'
  );
  const event = createRuntimeEvent(
    'automation.execution.completed',
    message,
    {
      status,
      successfulActions: details.successfulActions ?? 0,
      failedActions: details.failedActions ?? 0,
      durationMs: details.durationMs ?? null
    },
    severity
  );

  await appendRuntimeEvent(context.historyId, event, null);
  await publishAutomationEvent('automation.execution.completed', context, {
    severity,
    payload: {
      status,
      successfulActions: details.successfulActions ?? 0,
      failedActions: details.failedActions ?? 0,
      durationMs: details.durationMs ?? null,
      success: status === 'success',
      message
    },
    tags: ['automation', 'execution', status]
  });
}

async function recordSchedulerSecurityAlarmEvaluation(details = {}) {
  await eventStreamService.publishSafe({
    type: 'automation.trigger.security_alarm_evaluated',
    source: 'automation_scheduler',
    category: 'automation',
    severity: details.willRun ? 'info' : 'warn',
    payload: {
      automationId: details.automationId || null,
      automationName: details.automationName || null,
      workflowId: details.workflowId || null,
      workflowName: details.workflowName || null,
      currentState: details.currentState || null,
      configuredStates: Array.isArray(details.configuredStates) ? details.configuredStates : [],
      matchedState: details.matchedState || null,
      previousMatchedState: details.previousMatchedState || null,
      willRun: Boolean(details.willRun),
      reason: details.reason || null
    },
    tags: ['automation', 'trigger', 'security_alarm']
  });
}

async function getWorkflowExecutionHistory(workflowId = null, limit = 50) {
  const query = workflowId
    ? { workflowId }
    : { workflowId: { $ne: null } };

  return AutomationHistory.find(query)
    .sort({ startedAt: -1 })
    .limit(Math.max(1, Number(limit) || 50))
    .lean();
}

async function getRunningWorkflowExecutions(limit = 25) {
  return AutomationHistory.find({
    workflowId: { $ne: null },
    status: 'running'
  })
    .sort({ startedAt: -1 })
    .limit(Math.max(1, Number(limit) || 25))
    .lean();
}

async function reconcileRunningExecutions({ reason = 'server_restart' } = {}) {
  const running = await AutomationHistory.find({ status: 'running' });
  if (!Array.isArray(running) || running.length === 0) {
    return {
      cancelledCount: 0,
      histories: []
    };
  }

  const interruptionReason = formatInterruptionReason(reason);
  const message = `Automation execution cancelled after ${interruptionReason}`;
  const histories = [];

  for (const history of running) {
    // Preserve any existing action results while closing out the stale execution.
    if (!Array.isArray(history.actionResults)) {
      history.actionResults = [];
    }

    // eslint-disable-next-line no-await-in-loop
    await history.markCompleted('cancelled', new Error(message));

    const context = buildExecutionContextFromHistory(history);
    // eslint-disable-next-line no-await-in-loop
    await recordExecutionCompleted(context, {
      status: 'cancelled',
      successfulActions: history.successfulActions ?? 0,
      failedActions: history.failedActions ?? 0,
      durationMs: history.durationMs ?? null,
      message
    });

    histories.push({
      historyId: toObjectIdString(history?._id),
      automationId: toObjectIdString(history?.automationId),
      workflowId: toObjectIdString(history?.workflowId),
      automationName: history?.automationName || null,
      workflowName: history?.workflowName || null
    });
  }

  return {
    cancelledCount: histories.length,
    histories
  };
}

module.exports = {
  buildExecutionContext,
  buildExecutionContextFromHistory,
  publishAutomationEvent,
  recordTriggerMatched,
  recordExecutionStarted,
  recordActionStarted,
  recordActionCompleted,
  recordExecutionCompleted,
  recordSchedulerSecurityAlarmEvaluation,
  getWorkflowExecutionHistory,
  getRunningWorkflowExecutions,
  reconcileRunningExecutions
};

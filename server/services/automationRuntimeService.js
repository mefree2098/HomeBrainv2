const AutomationHistory = require('../models/AutomationHistory');
const eventStreamService = require('./eventStreamService');
const telemetryService = require('./telemetryService');

const MAX_RUNTIME_EVENTS = Math.max(
  50,
  Number(process.env.AUTOMATION_RUNTIME_EVENT_LIMIT || 250)
);
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;
const DEFAULT_HISTORY_PAGE = 1;
const MAX_HISTORY_HOURS = 24 * 365;

function clampInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.round(numeric)));
}

function normalizeHistoryOptions(options = {}) {
  if (typeof options === 'number') {
    return {
      limit: clampInteger(options, DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT),
      page: DEFAULT_HISTORY_PAGE,
      hours: null
    };
  }

  return {
    limit: clampInteger(options?.limit, DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT),
    page: clampInteger(options?.page, DEFAULT_HISTORY_PAGE, 1, Number.MAX_SAFE_INTEGER),
    hours: options?.hours == null
      ? null
      : clampInteger(options.hours, 24, 1, MAX_HISTORY_HOURS)
  };
}

function buildWorkflowHistoryQuery({ workflowId = null, hours = null } = {}) {
  const query = workflowId
    ? { workflowId }
    : { workflowId: { $ne: null } };

  if (hours != null) {
    query.startedAt = {
      $gte: new Date(Date.now() - hours * 60 * 60 * 1000)
    };
  }

  return query;
}

function buildHistoryPagination({ page, limit, total }) {
  const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
  const safePage = Math.min(page, totalPages);

  return {
    page: safePage,
    limit,
    total,
    totalPages,
    hasPreviousPage: safePage > 1,
    hasNextPage: safePage < totalPages
  };
}

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

async function persistWorkflowTelemetry(context = {}, details = {}) {
  try {
    await telemetryService.recordWorkflowExecution(context, details);
  } catch (error) {
    console.warn(`AutomationRuntimeService: failed to persist workflow telemetry: ${error.message}`);
  }
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
  const recordedAt = new Date();
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
  await persistWorkflowTelemetry(context, {
    phase: 'started',
    status: 'running',
    startedAt: recordedAt,
    recordedAt,
    totalActions: context.totalActions,
    message: event.message
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
  const recordedAt = new Date();
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
  await persistWorkflowTelemetry(context, {
    phase: 'completed',
    status,
    completedAt: recordedAt,
    recordedAt,
    totalActions: details.totalActions ?? context.totalActions,
    successfulActions: details.successfulActions ?? 0,
    failedActions: details.failedActions ?? 0,
    durationMs: details.durationMs ?? null,
    message
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

async function getWorkflowExecutionHistory(options = {}) {
  const normalized = normalizeHistoryOptions(options);
  const workflowId = options?.workflowId || null;
  const { limit, page, hours } = normalized;
  const query = buildWorkflowHistoryQuery({ workflowId, hours });
  const total = await AutomationHistory.countDocuments(query);
  const pagination = buildHistoryPagination({ page, limit, total });
  const skip = (pagination.page - 1) * pagination.limit;

  const history = await AutomationHistory.find(query)
    .sort({ startedAt: -1 })
    .skip(skip)
    .limit(pagination.limit)
    .lean();

  return {
    history,
    pagination,
    timeRange: {
      hours,
      startAt: hours == null ? null : new Date(Date.now() - hours * 60 * 60 * 1000),
      endAt: new Date()
    }
  };
}

async function getWorkflowRuntimeTelemetry(options = {}) {
  const normalized = normalizeHistoryOptions(options);
  const query = buildWorkflowHistoryQuery({
    workflowId: options?.workflowId || null,
    hours: normalized.hours
  });

  const [runningNow, aggregates] = await Promise.all([
    AutomationHistory.countDocuments({
      ...(options?.workflowId ? { workflowId: options.workflowId } : { workflowId: { $ne: null } }),
      status: 'running'
    }),
    AutomationHistory.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          executionCount: { $sum: 1 },
          successCount: {
            $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] }
          },
          partialSuccessCount: {
            $sum: { $cond: [{ $eq: ['$status', 'partial_success'] }, 1, 0] }
          },
          failedCount: {
            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] }
          },
          cancelledCount: {
            $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] }
          },
          runningCountInRange: {
            $sum: { $cond: [{ $eq: ['$status', 'running'] }, 1, 0] }
          },
          totalActions: { $sum: '$totalActions' },
          successfulActions: { $sum: '$successfulActions' },
          failedActions: { $sum: '$failedActions' },
          averageDurationMs: { $avg: '$durationMs' },
          lastStartedAt: { $max: '$startedAt' },
          lastCompletedAt: { $max: '$completedAt' }
        }
      }
    ])
  ]);

  const aggregate = aggregates[0] || {};
  const executionCount = Number(aggregate.executionCount || 0);
  const failedCount = Number(aggregate.failedCount || 0);

  return {
    runningNow: Number(runningNow || 0),
    executionCount,
    successCount: Number(aggregate.successCount || 0),
    partialSuccessCount: Number(aggregate.partialSuccessCount || 0),
    failedCount,
    cancelledCount: Number(aggregate.cancelledCount || 0),
    runningCountInRange: Number(aggregate.runningCountInRange || 0),
    totalActions: Number(aggregate.totalActions || 0),
    successfulActions: Number(aggregate.successfulActions || 0),
    failedActions: Number(aggregate.failedActions || 0),
    averageDurationMs: Number.isFinite(Number(aggregate.averageDurationMs)) ? Number(aggregate.averageDurationMs) : null,
    failureRatePct: executionCount > 0 ? Number(((failedCount / executionCount) * 100).toFixed(1)) : 0,
    lastStartedAt: aggregate.lastStartedAt || null,
    lastCompletedAt: aggregate.lastCompletedAt || null,
    timeRange: {
      hours: normalized.hours,
      startAt: normalized.hours == null ? null : new Date(Date.now() - normalized.hours * 60 * 60 * 1000),
      endAt: new Date()
    }
  };
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
  getWorkflowRuntimeTelemetry,
  getRunningWorkflowExecutions,
  reconcileRunningExecutions
};

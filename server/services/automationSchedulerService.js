const Automation = require('../models/Automation');
const AutomationHistory = require('../models/AutomationHistory');
const Device = require('../models/Device');
const SecurityAlarm = require('../models/SecurityAlarm');
const automationService = require('./automationService');
const automationRuntimeService = require('./automationRuntimeService');
const deviceService = require('./deviceService');
const weatherService = require('./weatherService');
const { applyFlattenedUpdates, resolveDeviceProperty } = require('../utils/devicePropertyResolver');
const { setWorkflowStopRequest } = require('./workflowExecutionService');

const WEEKDAY_TO_NUMBER = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6
};
const DEFAULT_SCHEDULE_GRACE_MS = Math.max(
  60 * 1000,
  Number(process.env.AUTOMATION_SCHEDULER_SCHEDULE_GRACE_MS) || 5 * 60 * 1000
);

function normalizeMinuteKey(date) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}

function normalizeSolarEvent(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'sunrise') {
    return 'sunrise';
  }
  if (normalized === 'sunset') {
    return 'sunset';
  }
  return null;
}

function parseLocalDateTimeString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return null;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0)
  };
}

function extractDatePartsForTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  });

  const collected = {};
  formatter.formatToParts(date).forEach((part) => {
    if (part.type !== 'literal') {
      collected[part.type] = part.value;
    }
  });

  return {
    year: Number(collected.year),
    month: Number(collected.month),
    day: Number(collected.day),
    hour: Number(collected.hour),
    minute: Number(collected.minute),
    second: Number(collected.second),
    weekday: normalizeDays([collected.weekday])?.values()?.next()?.value ?? null
  };
}

function buildDateFromTimeZoneParts(parts, timeZone) {
  let candidate = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0
  ));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = extractDatePartsForTimeZone(candidate, timeZone);
    const desiredUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second || 0
    );
    const actualUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second || 0
    );
    const diffMs = desiredUtc - actualUtc;
    if (diffMs === 0) {
      return candidate;
    }
    candidate = new Date(candidate.getTime() + diffMs);
  }

  return candidate;
}

function parseTimeCondition(conditions = {}) {
  if (typeof conditions.hour === 'number' && typeof conditions.minute === 'number') {
    return {
      hour: Math.max(0, Math.min(23, Math.round(conditions.hour))),
      minute: Math.max(0, Math.min(59, Math.round(conditions.minute)))
    };
  }

  if (typeof conditions.time === 'string') {
    const match = conditions.time.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
      return {
        hour: Math.max(0, Math.min(23, Number(match[1]))),
        minute: Math.max(0, Math.min(59, Number(match[2])))
      };
    }
  }

  return null;
}

function normalizeDays(days) {
  if (!Array.isArray(days) || !days.length) {
    return null;
  }
  const values = new Set();
  days.forEach((entry) => {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 6) {
      values.add(entry);
      return;
    }
    if (typeof entry === 'string') {
      const normalized = entry.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(WEEKDAY_TO_NUMBER, normalized)) {
        values.add(WEEKDAY_TO_NUMBER[normalized]);
      }
    }
  });
  return values.size ? values : null;
}

function parseCronField(field, min, max) {
  const value = (field || '').trim();
  if (!value || value === '*') {
    return { any: true };
  }

  if (value.startsWith('*/')) {
    const step = Number(value.slice(2));
    if (Number.isFinite(step) && step > 0) {
      return { step };
    }
  }

  const allowed = new Set();
  value.split(',').forEach((part) => {
    const token = part.trim();
    if (!token) return;
    if (token.includes('-')) {
      const [startRaw, endRaw] = token.split('-');
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const from = Math.max(min, Math.min(max, start));
        const to = Math.max(min, Math.min(max, end));
        for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) {
          allowed.add(i);
        }
      }
      return;
    }
    const numeric = Number(token);
    if (Number.isFinite(numeric)) {
      allowed.add(Math.max(min, Math.min(max, numeric)));
    }
  });

  return { allowed };
}

function matchesCronField(value, parsed) {
  if (parsed.any) return true;
  if (parsed.step) return value % parsed.step === 0;
  if (parsed.allowed) return parsed.allowed.has(value);
  return false;
}

function matchesCronExpression(cronExpression, date) {
  if (typeof cronExpression !== 'string' || !cronExpression.trim()) {
    return false;
  }
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length < 5) {
    return false;
  }

  const [minuteExpr, hourExpr, dayExpr, monthExpr, weekdayExpr] = fields;
  const minute = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const weekday = date.getDay();

  return (
    matchesCronField(minute, parseCronField(minuteExpr, 0, 59)) &&
    matchesCronField(hour, parseCronField(hourExpr, 0, 23)) &&
    matchesCronField(day, parseCronField(dayExpr, 1, 31)) &&
    matchesCronField(month, parseCronField(monthExpr, 1, 12)) &&
    matchesCronField(weekday, parseCronField(weekdayExpr, 0, 6))
  );
}

class AutomationSchedulerService {
  constructor() {
    this.intervalMs = Number(process.env.AUTOMATION_SCHEDULER_INTERVAL_MS || 30000);
    this.timer = null;
    this.running = false;
    this.recentRuns = new Map();
    this.triggerStateCache = new Map();
    this.pendingTriggerContexts = new Map();
    this.solarContextCache = {
      key: null,
      value: null,
      promise: null
    };
    this.lastSolarWarningAt = 0;
    this.scheduleGraceMs = DEFAULT_SCHEDULE_GRACE_MS;
    this.pendingTickContext = null;
    const resumeWatchdogIntervalMs = Number(
      process.env.AUTOMATION_RUNTIME_RESUME_WATCHDOG_INTERVAL_MS || 60 * 1000
    );
    this.resumeWatchdogIntervalMs = Number.isFinite(resumeWatchdogIntervalMs)
      ? Math.max(30 * 1000, resumeWatchdogIntervalMs)
      : 60 * 1000;
    this.lastResumeWatchdogAt = 0;
  }

  shouldLogSecurityAlarmEvaluation(runtimeContext = {}) {
    const source = typeof runtimeContext?.source === 'string'
      ? runtimeContext.source.trim().toLowerCase()
      : '';

    return [
      'security_alarm',
      'smartthings_alarm_webhook',
      'security_alarm_sync'
    ].includes(source);
  }

  isStartupPrimeSource(runtimeContext = {}) {
    const source = typeof runtimeContext?.source === 'string'
      ? runtimeContext.source.trim().toLowerCase()
      : '';

    return source === 'scheduler_startup';
  }

  launchAutomationExecution(automation, triggerContext = {}) {
    void automationService.executeAutomation(automation._id.toString(), {
      triggerType: automation.trigger.type,
      triggerSource: 'scheduler',
      context: triggerContext
    })
      .then(() => {
        console.log(`AutomationSchedulerService: executed automation ${automation.name} (${automation._id})`);
      })
      .catch((error) => {
        console.error(`AutomationSchedulerService: failed executing ${automation._id}:`, error.message);
      });
  }

  getTickPriority(executionContext = {}) {
    const source = typeof executionContext?.source === 'string'
      ? executionContext.source.trim().toLowerCase()
      : '';

    if (source.includes('security_alarm') || source.includes('alarm')) {
      return 3;
    }
    if (source.includes('webhook')) {
      return 2;
    }
    if (source.includes('device_update')) {
      return 1;
    }
    return 0;
  }

  queuePendingTick(executionContext = {}) {
    const nextContext = executionContext && typeof executionContext === 'object'
      ? { ...executionContext }
      : {};
    const nextPriority = this.getTickPriority(nextContext);
    const currentPriority = this.getTickPriority(this.pendingTickContext || {});

    if (!this.pendingTickContext || nextPriority >= currentPriority) {
      this.pendingTickContext = nextContext;
    }
  }

  flushPendingTick() {
    const pendingContext = this.pendingTickContext;
    this.pendingTickContext = null;

    if (!pendingContext) {
      return;
    }

    const followUpContext = {
      ...pendingContext,
      queuedAfterBusyTick: true
    };
    const runFollowUp = () => {
      void this.tick(followUpContext);
    };

    if (typeof setImmediate === 'function') {
      setImmediate(runFollowUp);
    } else {
      setTimeout(runFollowUp, 0);
    }
  }

  async maybeResumeOrphanedExecutions(now = new Date()) {
    const nowMs = now instanceof Date && Number.isFinite(now.getTime())
      ? now.getTime()
      : Date.now();

    if (
      this.lastResumeWatchdogAt > 0
      && nowMs - this.lastResumeWatchdogAt < this.resumeWatchdogIntervalMs
    ) {
      return {
        skipped: true,
        reason: 'watchdog_interval'
      };
    }

    this.lastResumeWatchdogAt = nowMs;

    try {
      const result = await automationService.resumeRunningExecutions({ reason: 'scheduler_watchdog' });
      if (result?.launchedCount > 0) {
        console.log(
          `AutomationSchedulerService: resume watchdog relaunched ${result.launchedCount} orphaned execution(s)`
        );
      }
      return result;
    } catch (error) {
      console.warn(`AutomationSchedulerService: resume watchdog failed: ${error.message}`);
      return {
        error: error.message
      };
    }
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick({ source: 'scheduler_interval' });
    }, this.intervalMs);
    console.log(`AutomationSchedulerService: started (interval ${this.intervalMs}ms)`);
    void this.tick({ source: 'scheduler_startup' });
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('AutomationSchedulerService: stopped');
    }
  }

  cleanupRecentRuns(now = Date.now()) {
    const ttl = 2 * 60 * 60 * 1000;
    for (const [key, timestamp] of this.recentRuns.entries()) {
      if (now - timestamp > ttl) {
        this.recentRuns.delete(key);
      }
    }
  }

  setPendingTriggerContext(automationId, context = {}) {
    if (!automationId || !context || typeof context !== 'object') {
      return;
    }
    this.pendingTriggerContexts.set(String(automationId), { ...context });
  }

  consumePendingTriggerContext(automationId) {
    if (!automationId) {
      return {};
    }
    const key = String(automationId);
    const context = this.pendingTriggerContexts.get(key) || {};
    this.pendingTriggerContexts.delete(key);
    return context;
  }

  shouldSkipForCooldown(automation, now) {
    const cooldownMinutes = Number(automation.cooldown || 0);
    if (!cooldownMinutes || cooldownMinutes <= 0) {
      return false;
    }
    if (!automation.lastRun) {
      return false;
    }
    const lastRunMs = new Date(automation.lastRun).getTime();
    if (!Number.isFinite(lastRunMs)) {
      return false;
    }
    return (now.getTime() - lastRunMs) < (cooldownMinutes * 60 * 1000);
  }

  isAlreadyExecutedForCurrentMinute(automationId, triggerType, now, triggerContext = {}) {
    let keyDate = now;
    if (triggerContext?.triggeringScheduleTime) {
      const scheduleDate = new Date(triggerContext.triggeringScheduleTime);
      if (!Number.isNaN(scheduleDate.getTime())) {
        keyDate = scheduleDate;
      }
    }

    const key = `${automationId}:${triggerType}:${normalizeMinuteKey(keyDate)}`;
    if (this.recentRuns.has(key)) {
      return true;
    }
    this.recentRuns.set(key, Date.now());
    return false;
  }

  isWithinScheduleGraceWindow(targetDate, now) {
    const targetMs = targetDate instanceof Date ? targetDate.getTime() : Number.NaN;
    const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isFinite(targetMs) || !Number.isFinite(nowMs)) {
      return false;
    }

    const ageMs = nowMs - targetMs;
    return ageMs >= 0 && ageMs < this.scheduleGraceMs;
  }

  hasRunForScheduleTarget(automation, targetDate) {
    const lastRunMs = automation?.lastRun ? new Date(automation.lastRun).getTime() : Number.NaN;
    const targetMs = targetDate instanceof Date ? targetDate.getTime() : Number.NaN;
    if (!Number.isFinite(lastRunMs) || !Number.isFinite(targetMs)) {
      return false;
    }

    const replayWindowMs = Math.max(this.scheduleGraceMs + this.intervalMs, 60 * 1000);
    return lastRunMs >= targetMs && lastRunMs < (targetMs + replayWindowMs);
  }

  shouldRunTimeTrigger(automation, now) {
    const parsedTime = parseTimeCondition(automation?.trigger?.conditions || {});
    if (!parsedTime) {
      return false;
    }

    if (parsedTime.hour !== now.getHours() || parsedTime.minute !== now.getMinutes()) {
      return false;
    }

    const daySet = normalizeDays(automation?.trigger?.conditions?.days);
    if (daySet && !daySet.has(now.getDay())) {
      return false;
    }

    return true;
  }

  shouldRunScheduleTrigger(automation, now) {
    const cronExpr = automation?.trigger?.conditions?.cron;
    if (!cronExpr) {
      return false;
    }
    return matchesCronExpression(cronExpr, now);
  }

  warnSolarTriggerIssue(message) {
    const now = Date.now();
    if ((now - this.lastSolarWarningAt) < 5 * 60 * 1000) {
      return;
    }

    this.lastSolarWarningAt = now;
    console.warn(`AutomationSchedulerService: ${message}`);
  }

  async getSolarContext(now) {
    const cacheKey = normalizeMinuteKey(now);
    if (this.solarContextCache.key === cacheKey) {
      if (this.solarContextCache.promise) {
        return this.solarContextCache.promise;
      }
      return this.solarContextCache.value;
    }

    const promise = weatherService.fetchDashboardWeather().catch((error) => {
      this.warnSolarTriggerIssue(`Unable to load weather data for sunrise/sunset triggers: ${error.message}`);
      return null;
    });

    this.solarContextCache = {
      key: cacheKey,
      value: null,
      promise
    };

    const value = await promise;
    this.solarContextCache = {
      key: cacheKey,
      value,
      promise: null
    };
    return value;
  }

  async evaluateSolarScheduleTrigger(automation, now) {
    const conditions = automation?.trigger?.conditions || {};
    const event = normalizeSolarEvent(conditions.event || conditions.sunEvent);
    if (!event) {
      return false;
    }

    const weather = await this.getSolarContext(now);
    if (!weather?.today?.[event]) {
      this.warnSolarTriggerIssue(`No ${event} time is available for schedule trigger evaluation.`);
      return false;
    }

    const timeZone = typeof weather.location?.timezone === 'string' && weather.location.timezone.trim()
      ? weather.location.timezone.trim()
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const solarParts = parseLocalDateTimeString(weather.today[event]);
    if (!solarParts) {
      this.warnSolarTriggerIssue(`Could not parse ${event} time "${weather.today[event]}" for solar schedule triggers.`);
      return false;
    }

    const offsetMinutes = Number.isFinite(Number(conditions.offset))
      ? Math.round(Number(conditions.offset))
      : 0;
    const solarDate = buildDateFromTimeZoneParts(solarParts, timeZone);
    const targetDate = new Date(solarDate.getTime() + (offsetMinutes * 60 * 1000));
    const nowParts = extractDatePartsForTimeZone(now, timeZone);

    if (!this.isWithinScheduleGraceWindow(targetDate, now)) {
      return false;
    }

    const daySet = normalizeDays(conditions.days);
    if (daySet && nowParts.weekday !== null && !daySet.has(nowParts.weekday)) {
      return false;
    }

    if (this.hasRunForScheduleTarget(automation, targetDate)) {
      return false;
    }

    this.setPendingTriggerContext(automation._id.toString(), {
      triggeringScheduleEvent: event,
      triggeringScheduleTime: targetDate.toISOString(),
      triggeringScheduleOffsetMinutes: offsetMinutes,
      triggeringScheduleLatenessMs: Math.max(0, now.getTime() - targetDate.getTime())
    });
    console.log(
      `AutomationSchedulerService: solar schedule matched ${event}${offsetMinutes ? ` (${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes}m)` : ''} for automation ${automation.name || automation._id}`
    );
    return true;
  }

  normalizeDeviceValue(value) {
    if (value == null) {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'on' || normalized === 'true') {
        return true;
      }
      if (normalized === 'off' || normalized === 'false') {
        return false;
      }
      const numeric = Number(normalized);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
      return normalized;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    return value;
  }

  normalizeHoldDurationSeconds(conditions = {}) {
    const candidates = [
      conditions.forSeconds,
      conditions.durationSeconds,
      conditions.holdSeconds
    ];

    for (const candidate of candidates) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric > 0) {
        return Math.max(0, Math.round(numeric));
      }
    }

    const minutes = Number(conditions.forMinutes ?? conditions.durationMinutes ?? conditions.holdMinutes);
    if (Number.isFinite(minutes) && minutes > 0) {
      return Math.max(0, Math.round(minutes * 60));
    }

    return 0;
  }

  async refreshTriggerDeviceSnapshot(device) {
    if (!device || !deviceService.isSmartThingsDevice(device)) {
      return device;
    }

    try {
      const updates = await deviceService.pollSmartThingsState(device, undefined);
      if (!updates || Object.keys(updates).length === 0) {
        return device;
      }
      return applyFlattenedUpdates(device, updates);
    } catch (error) {
      console.warn(`AutomationSchedulerService: Failed to refresh SmartThings trigger device ${device?._id || 'unknown'}: ${error.message}`);
      return device;
    }
  }

  compareDeviceValues(left, operator, right) {
    const lhs = this.normalizeDeviceValue(left);
    const rhs = this.normalizeDeviceValue(right);

    switch ((operator || 'eq').toString().toLowerCase()) {
      case 'eq':
      case '==':
        return lhs === rhs;
      case 'neq':
      case '!=':
        return lhs !== rhs;
      case 'gt':
      case '>':
        return Number(lhs) > Number(rhs);
      case 'gte':
      case '>=':
        return Number(lhs) >= Number(rhs);
      case 'lt':
      case '<':
        return Number(lhs) < Number(rhs);
      case 'lte':
      case '<=':
        return Number(lhs) <= Number(rhs);
      case 'contains':
        return typeof lhs === 'string' && typeof rhs === 'string' ? lhs.includes(rhs) : false;
      default:
        return Boolean(lhs);
    }
  }

  async autoCancelWorkflowExecutionsForTriggerReset(automation, triggerContext = {}) {
    if (!automation?.workflowId) {
      return 0;
    }

    const runningExecutions = await AutomationHistory.find({
      automationId: automation._id,
      workflowId: automation.workflowId,
      status: 'running'
    });

    let cancelledCount = 0;
    for (const history of runningExecutions) {
      const historyId = history?._id?.toString?.();
      if (!historyId) {
        continue;
      }

      const workflowId = history?.workflowId?.toString?.() || automation.workflowId?.toString?.() || null;
      const context = automationRuntimeService.buildExecutionContextFromHistory(history, {
        triggerContext: {
          ...(history.triggerContext || {}),
          ...triggerContext
        }
      });
      const message = 'Workflow auto-cancelled because its trigger state changed before it completed.';

      await automationRuntimeService.recordExecutionStopRequested(context, {
        requestedBy: 'automation scheduler',
        reason: 'trigger_state_changed',
        message
      });

      setWorkflowStopRequest({
        historyId,
        correlationId: history.correlationId || null,
        workflowId
      });
      cancelledCount += 1;

      if (!automationService.isExecutionActive(historyId)) {
        const refreshedHistory = await AutomationHistory.findById(history._id);
        if (refreshedHistory && refreshedHistory.status === 'running') {
          const cancellationError = new Error(message);
          cancellationError.code = 'WORKFLOW_EXECUTION_CANCELLED';
          cancellationError.isCancelled = true;
          await refreshedHistory.markCompleted('cancelled', cancellationError);
          await automationRuntimeService.recordExecutionCompleted(context, {
            status: 'cancelled',
            successfulActions: refreshedHistory.successfulActions || 0,
            failedActions: refreshedHistory.failedActions || 0,
            durationMs: refreshedHistory.durationMs || null,
            message
          });
        }
      }
    }

    if (cancelledCount > 0) {
      console.log(
        `AutomationSchedulerService: auto-cancelled ${cancelledCount} running workflow execution(s) for automation ${automation.name || automation._id}`
      );
    }

    return cancelledCount;
  }

  async evaluateDeviceStateTrigger(automation, now = new Date(), runtimeContext = {}) {
    const conditions = automation?.trigger?.conditions || {};
    const deviceId = conditions.deviceId;
    if (!deviceId) {
      return false;
    }

    const device = await Device.findById(deviceId).lean();
    if (!device) {
      return false;
    }

    const refreshedDevice = await this.refreshTriggerDeviceSnapshot(device);
    const propertyKey = typeof conditions.property === 'string' && conditions.property.trim()
      ? conditions.property.trim()
      : 'status';
    const leftValue = resolveDeviceProperty(refreshedDevice, propertyKey, refreshedDevice.status);

    const operator = conditions.operator || (conditions.condition === 'above'
      ? '>'
      : conditions.condition === 'below'
        ? '<'
        : 'eq');
    const expected = Object.prototype.hasOwnProperty.call(conditions, 'value')
      ? conditions.value
      : Object.prototype.hasOwnProperty.call(conditions, 'state')
        ? conditions.state
        : true;
    const met = this.compareDeviceValues(leftValue, operator, expected);

    const cacheKey = `${automation._id.toString()}:trigger-state`;
    const previousState = this.triggerStateCache.get(cacheKey);
    const previous = previousState && typeof previousState === 'object'
      ? previousState
      : {
          met: previousState === true,
          eligible: previousState === true,
          matchedSince: previousState === true ? now.getTime() : null,
          value: null
        };

    const holdSeconds = this.normalizeHoldDurationSeconds(conditions);
    const nowMs = now.getTime();
    let matchedSince = previous.matchedSince ?? null;
    if (met) {
      if (!previous.met) {
        matchedSince = nowMs;
      }
    } else {
      matchedSince = null;
    }

    const eligible = holdSeconds > 0
      ? Boolean(met && matchedSince !== null && (nowMs - matchedSince) >= (holdSeconds * 1000))
      : met;

    const shouldRun = eligible && previous.eligible !== true;
    const suppressRunForCooldown = runtimeContext?.suppressRunForCooldown === true;
    const preservePreCooldownEdge = suppressRunForCooldown && previous.eligible !== true && met === true;
    const nextState = preservePreCooldownEdge
      ? {
          met: previous.met === true,
          eligible: previous.eligible === true,
          matchedSince: previous.matchedSince ?? null,
          value: leftValue
        }
      : {
          met,
          eligible,
          matchedSince,
          value: leftValue
        };

    this.triggerStateCache.set(cacheKey, nextState);

    if (this.isStartupPrimeSource(runtimeContext)) {
      return false;
    }

    const triggerContext = {
      triggeringDeviceId: refreshedDevice._id?.toString?.() || deviceId.toString(),
      triggeringDeviceName: refreshedDevice.name || '',
      triggeringDeviceRoom: refreshedDevice.room || '',
      triggerProperty: propertyKey,
      triggerValue: leftValue
    };

    if (holdSeconds > 0) {
      triggerContext.triggerHoldSeconds = holdSeconds;
    }

    if (previous.eligible === true && met === false) {
      await this.autoCancelWorkflowExecutionsForTriggerReset(automation, {
        ...triggerContext,
        triggerPreviousValue: previous.value ?? null,
        autoCancelReason: 'trigger_state_changed'
      });
    }

    if (suppressRunForCooldown) {
      return false;
    }

    // Run on edge transition false -> true so we don't fire repeatedly every tick.
    if (shouldRun) {
      this.setPendingTriggerContext(automation._id.toString(), triggerContext);
    }

    return shouldRun;
  }

  normalizeSecurityAlarmState(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    switch (normalized) {
      case 'disarm':
      case 'disarmed':
        return 'disarmed';
      case 'stay':
      case 'armedstay':
      case 'armed_stay':
      case 'armed stay':
        return 'armedStay';
      case 'away':
      case 'armedaway':
      case 'armed_away':
      case 'armed away':
        return 'armedAway';
      case 'trigger':
      case 'triggered':
        return 'triggered';
      case 'arming':
        return 'arming';
      case 'disarming':
        return 'disarming';
      default:
        return null;
    }
  }

  async evaluateSecurityAlarmTrigger(automation, runtimeContext = {}) {
    const conditions = automation?.trigger?.conditions || {};
    const rawStates = Array.isArray(conditions.states)
      ? conditions.states
      : [conditions.state, conditions.status, conditions.value].filter((value) => value != null);
    const states = Array.from(new Set(rawStates
      .map((value) => this.normalizeSecurityAlarmState(String(value)))
      .filter(Boolean)));

    if (!states.length) {
      return false;
    }

    const alarm = await SecurityAlarm.getMainAlarm();
    const currentState = this.normalizeSecurityAlarmState(alarm?.alarmState || '');
    const matchedState = currentState && states.includes(currentState) ? currentState : null;

    const cacheKey = `${automation._id.toString()}:security-alarm-trigger`;
    const lastMatchedState = this.triggerStateCache.get(cacheKey) || null;
    this.triggerStateCache.set(cacheKey, matchedState);

    if (this.isStartupPrimeSource(runtimeContext)) {
      if (this.shouldLogSecurityAlarmEvaluation(runtimeContext)) {
        await automationRuntimeService.recordSchedulerSecurityAlarmEvaluation({
          automationId: automation?._id?.toString?.() || null,
          automationName: automation?.name || null,
          workflowId: automation?.workflowId?.toString?.() || null,
          workflowName: automation?.name || null,
          currentState,
          configuredStates: states,
          matchedState,
          previousMatchedState: lastMatchedState,
          willRun: false,
          reason: runtimeContext.reason || 'startup_prime'
        });
      }
      return false;
    }

    const shouldRun = Boolean(matchedState && lastMatchedState !== matchedState);
    if (this.shouldLogSecurityAlarmEvaluation(runtimeContext)) {
      await automationRuntimeService.recordSchedulerSecurityAlarmEvaluation({
        automationId: automation?._id?.toString?.() || null,
        automationName: automation?.name || null,
        workflowId: automation?.workflowId?.toString?.() || null,
        workflowName: automation?.name || null,
        currentState,
        configuredStates: states,
        matchedState,
        previousMatchedState: lastMatchedState,
        willRun: shouldRun,
        reason: runtimeContext.reason || null
      });
    }

    if (shouldRun) {
      this.setPendingTriggerContext(automation._id.toString(), {
        triggeringAlarmState: matchedState
      });
      console.log(
        `AutomationSchedulerService: security alarm trigger matched ${matchedState} for automation ${automation.name || automation._id}`
      );
    }

    return shouldRun;
  }

  async shouldRunAutomation(automation, now, runtimeContext = {}) {
    if (!automation?.enabled) {
      return false;
    }

    const triggerType = automation?.trigger?.type;
    const isResetAwareStateTrigger = triggerType === 'device_state' || triggerType === 'sensor';
    if (!isResetAwareStateTrigger && this.shouldSkipForCooldown(automation, now)) {
      return false;
    }

    if (triggerType === 'time') {
      return this.shouldRunTimeTrigger(automation, now);
    }
    if (triggerType === 'schedule') {
      if (normalizeSolarEvent(automation?.trigger?.conditions?.event || automation?.trigger?.conditions?.sunEvent)) {
        return this.evaluateSolarScheduleTrigger(automation, now);
      }
      return this.shouldRunScheduleTrigger(automation, now);
    }
    if (triggerType === 'device_state' || triggerType === 'sensor') {
      return this.evaluateDeviceStateTrigger(automation, now, {
        ...runtimeContext,
        suppressRunForCooldown: this.shouldSkipForCooldown(automation, now)
      });
    }
    if (triggerType === 'security_alarm_status') {
      return this.evaluateSecurityAlarmTrigger(automation, runtimeContext);
    }
    return false;
  }

  async tick(executionContext = {}) {
    if (this.running) {
      this.queuePendingTick(executionContext);
      return;
    }

    this.running = true;
    const now = new Date();

    try {
      this.cleanupRecentRuns(now.getTime());
      await this.maybeResumeOrphanedExecutions(now);
      const automations = await Automation.find({
        enabled: true,
        'trigger.type': { $in: ['time', 'schedule', 'device_state', 'sensor', 'security_alarm_status'] }
      }).lean();

      for (const automation of automations) {
        if (!await this.shouldRunAutomation(automation, now, executionContext)) {
          continue;
        }

        const triggerContext = {
          ...this.consumePendingTriggerContext(automation._id.toString()),
          ...(executionContext?.source ? { schedulerSource: executionContext.source } : {}),
          ...(executionContext?.reason ? { schedulerReason: executionContext.reason } : {})
        };

        if (this.isAlreadyExecutedForCurrentMinute(automation._id.toString(), automation.trigger.type, now, triggerContext)) {
          if (automation?.trigger?.type === 'security_alarm_status' || executionContext?.source === 'security_alarm') {
            await automationRuntimeService.publishAutomationEvent('automation.trigger.skipped', {
              automationId: automation?._id?.toString?.() || null,
              automationName: automation?.name || null,
              workflowId: automation?.workflowId?.toString?.() || null,
              workflowName: automation?.name || null,
              triggerType: automation?.trigger?.type || null,
              triggerSource: 'scheduler',
              triggerContext
            }, {
              source: 'automation_scheduler',
              severity: 'warn',
              payload: {
                reason: 'already_executed_current_minute'
              },
              tags: ['automation', 'trigger', 'skipped']
            });
          }
          continue;
        }

        this.launchAutomationExecution(automation, triggerContext);
      }
    } catch (error) {
      console.error('AutomationSchedulerService: tick failed:', error.message);
    } finally {
      this.running = false;
      this.flushPendingTick();
    }
  }
}

module.exports = new AutomationSchedulerService();

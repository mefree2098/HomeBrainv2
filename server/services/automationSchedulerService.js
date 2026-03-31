const Automation = require('../models/Automation');
const Device = require('../models/Device');
const SecurityAlarm = require('../models/SecurityAlarm');
const automationService = require('./automationService');
const automationRuntimeService = require('./automationRuntimeService');
const deviceService = require('./deviceService');
const weatherService = require('./weatherService');
const { applyFlattenedUpdates, resolveDeviceProperty } = require('../utils/devicePropertyResolver');

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

  isAlreadyExecutedForCurrentMinute(automationId, triggerType, now) {
    const key = `${automationId}:${triggerType}:${normalizeMinuteKey(now)}`;
    if (this.recentRuns.has(key)) {
      return true;
    }
    this.recentRuns.set(key, Date.now());
    return false;
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
    const targetParts = extractDatePartsForTimeZone(targetDate, timeZone);
    const nowParts = extractDatePartsForTimeZone(now, timeZone);

    if (
      targetParts.year !== nowParts.year
      || targetParts.month !== nowParts.month
      || targetParts.day !== nowParts.day
      || targetParts.hour !== nowParts.hour
      || targetParts.minute !== nowParts.minute
    ) {
      return false;
    }

    const daySet = normalizeDays(conditions.days);
    if (daySet && nowParts.weekday !== null && !daySet.has(nowParts.weekday)) {
      return false;
    }

    this.setPendingTriggerContext(automation._id.toString(), {
      triggeringScheduleEvent: event,
      triggeringScheduleTime: targetDate.toISOString(),
      triggeringScheduleOffsetMinutes: offsetMinutes
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

  async evaluateDeviceStateTrigger(automation, now = new Date()) {
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
          matchedSince: previousState === true ? now.getTime() : null
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

    this.triggerStateCache.set(cacheKey, {
      met,
      eligible,
      matchedSince
    });

    // Run on edge transition false -> true so we don't fire repeatedly every tick.
    const shouldRun = eligible && previous.eligible !== true;
    if (shouldRun) {
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
    if (this.shouldSkipForCooldown(automation, now)) {
      return false;
    }

    const triggerType = automation?.trigger?.type;
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
      return this.evaluateDeviceStateTrigger(automation, now);
    }
    if (triggerType === 'security_alarm_status') {
      return this.evaluateSecurityAlarmTrigger(automation, runtimeContext);
    }
    return false;
  }

  async tick(executionContext = {}) {
    if (this.running) {
      return;
    }

    this.running = true;
    const now = new Date();

    try {
      this.cleanupRecentRuns(now.getTime());
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

        if (this.isAlreadyExecutedForCurrentMinute(automation._id.toString(), automation.trigger.type, now)) {
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
    }
  }
}

module.exports = new AutomationSchedulerService();

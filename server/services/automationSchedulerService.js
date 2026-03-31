const Automation = require('../models/Automation');
const Device = require('../models/Device');
const SecurityAlarm = require('../models/SecurityAlarm');
const automationService = require('./automationService');

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
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    console.log(`AutomationSchedulerService: started (interval ${this.intervalMs}ms)`);
    void this.tick();
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
      default:
        return Boolean(lhs);
    }
  }

  async evaluateDeviceStateTrigger(automation) {
    const conditions = automation?.trigger?.conditions || {};
    const deviceId = conditions.deviceId;
    if (!deviceId) {
      return false;
    }

    const device = await Device.findById(deviceId).lean();
    if (!device) {
      return false;
    }

    let leftValue = null;
    if (conditions.property === 'status' || conditions.state) {
      leftValue = device.status;
    } else if (conditions.property === 'isOnline') {
      leftValue = device.isOnline;
    } else if (conditions.property && Object.prototype.hasOwnProperty.call(device, conditions.property)) {
      leftValue = device[conditions.property];
    } else if (conditions.property && device.properties && Object.prototype.hasOwnProperty.call(device.properties, conditions.property)) {
      leftValue = device.properties[conditions.property];
    } else {
      leftValue = device.status;
    }

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
    const lastState = this.triggerStateCache.get(cacheKey);
    this.triggerStateCache.set(cacheKey, met);

    // Run on edge transition false -> true so we don't fire repeatedly every tick.
    const shouldRun = met && lastState !== true;
    if (shouldRun) {
      this.setPendingTriggerContext(automation._id.toString(), {
        triggeringDeviceId: device._id?.toString?.() || deviceId.toString(),
        triggeringDeviceName: device.name || '',
        triggeringDeviceRoom: device.room || '',
        triggerProperty: typeof conditions.property === 'string' && conditions.property.trim()
          ? conditions.property.trim()
          : 'status',
        triggerValue: leftValue
      });
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

  async evaluateSecurityAlarmTrigger(automation) {
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

  async shouldRunAutomation(automation, now) {
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
      return this.shouldRunScheduleTrigger(automation, now);
    }
    if (triggerType === 'device_state' || triggerType === 'sensor') {
      return this.evaluateDeviceStateTrigger(automation);
    }
    if (triggerType === 'security_alarm_status') {
      return this.evaluateSecurityAlarmTrigger(automation);
    }
    return false;
  }

  async tick() {
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
        if (!await this.shouldRunAutomation(automation, now)) {
          continue;
        }

        const triggerContext = this.consumePendingTriggerContext(automation._id.toString());

        if (this.isAlreadyExecutedForCurrentMinute(automation._id.toString(), automation.trigger.type, now)) {
          continue;
        }

        try {
          await automationService.executeAutomation(automation._id.toString(), {
            triggerType: automation.trigger.type,
            triggerSource: 'scheduler',
            context: triggerContext
          });
          console.log(`AutomationSchedulerService: executed automation ${automation.name} (${automation._id})`);
        } catch (error) {
          console.error(`AutomationSchedulerService: failed executing ${automation._id}:`, error.message);
        }
      }
    } catch (error) {
      console.error('AutomationSchedulerService: tick failed:', error.message);
    } finally {
      this.running = false;
    }
  }
}

module.exports = new AutomationSchedulerService();

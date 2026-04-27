const fs = require('fs');
const { spawn } = require('child_process');
const Settings = require('../models/Settings');

const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;
const TIMER_DUE_TOLERANCE_MS = 1000;
const DEFAULT_TIMEZONE = 'America/New_York';
const DEFAULT_RESTART_TIME = '03:00';
const DEFAULT_FREQUENCY = 'weekly';
const VALID_FREQUENCIES = new Set(['daily', 'weekly', 'biweekly']);
const WEEKDAY_SHORT_TO_INDEX = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
});
const REBOOT_BINARY_CANDIDATES = Object.freeze([
  '/usr/sbin/reboot',
  '/sbin/reboot',
  '/usr/bin/reboot',
  '/bin/reboot'
]);

function parseScheduleTime(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return { value: DEFAULT_RESTART_TIME, hour: 3, minute: 0 };
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { value: DEFAULT_RESTART_TIME, hour: 3, minute: 0 };
  }

  return {
    value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    hour,
    minute
  };
}

function normalizeFrequency(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return VALID_FREQUENCIES.has(normalized) ? normalized : DEFAULT_FREQUENCY;
}

function normalizeDayOfWeek(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.min(6, Math.max(0, Math.trunc(numeric)));
}

function normalizeTimeZone(value) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch (_error) {
    return DEFAULT_TIMEZONE;
  }
}

function getDateOrNull(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const values = {};
  formatter.formatToParts(date).forEach((part) => {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  });

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: WEEKDAY_SHORT_TO_INDEX[values.weekday] ?? 0
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  const zonedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return zonedAsUtc - date.getTime();
}

function localDateTimeToUtcDate(timeZone, year, month, day, hour, minute) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const firstOffset = getTimeZoneOffsetMs(utcGuess, timeZone);
  let result = new Date(utcGuess.getTime() - firstOffset);
  const secondOffset = getTimeZoneOffsetMs(result, timeZone);
  if (secondOffset !== firstOffset) {
    result = new Date(utcGuess.getTime() - secondOffset);
  }
  return result;
}

function addLocalDays(localDate, days) {
  const result = new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day + days, 12, 0, 0));
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate()
  };
}

function localWeekday(localDate) {
  return new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day, 12, 0, 0)).getUTCDay();
}

function normalizeRestartSchedule(settings = {}) {
  const parsedTime = parseScheduleTime(settings.deviceRestartScheduleTime);
  const frequency = normalizeFrequency(settings.deviceRestartScheduleFrequency);
  const dayOfWeek = normalizeDayOfWeek(settings.deviceRestartScheduleDayOfWeek);
  const timeZone = normalizeTimeZone(settings.timezone);
  const lastTriggeredAt = getDateOrNull(settings.deviceRestartScheduleLastTriggeredAt);
  const nextRunAt = getDateOrNull(settings.deviceRestartScheduleNextRunAt);

  return {
    enabled: settings.deviceRestartScheduleEnabled === true,
    frequency,
    dayOfWeek,
    time: parsedTime.value,
    hour: parsedTime.hour,
    minute: parsedTime.minute,
    timeZone,
    lastTriggeredAt,
    nextRunAt
  };
}

function buildCandidateForLocalDate(schedule, localDate) {
  return localDateTimeToUtcDate(
    schedule.timeZone,
    localDate.year,
    localDate.month,
    localDate.day,
    schedule.hour,
    schedule.minute
  );
}

function computeNextRestartRunAt(settings = {}, fromDate = new Date()) {
  const schedule = normalizeRestartSchedule(settings);
  if (!schedule.enabled) {
    return null;
  }

  const now = fromDate instanceof Date ? fromDate : new Date(fromDate);
  if (Number.isNaN(now.getTime())) {
    return null;
  }

  const nowParts = getZonedParts(now, schedule.timeZone);
  const today = { year: nowParts.year, month: nowParts.month, day: nowParts.day };

  if (schedule.frequency === 'daily') {
    let candidateDate = today;
    let candidate = buildCandidateForLocalDate(schedule, candidateDate);
    if (candidate.getTime() <= now.getTime() + TIMER_DUE_TOLERANCE_MS) {
      candidateDate = addLocalDays(candidateDate, 1);
      candidate = buildCandidateForLocalDate(schedule, candidateDate);
    }
    return candidate;
  }

  if (schedule.frequency === 'biweekly' && schedule.lastTriggeredAt) {
    const lastRunParts = getZonedParts(schedule.lastTriggeredAt, schedule.timeZone);
    let candidateDate = addLocalDays({
      year: lastRunParts.year,
      month: lastRunParts.month,
      day: lastRunParts.day
    }, 14);
    const weekdayOffset = (schedule.dayOfWeek - localWeekday(candidateDate) + 7) % 7;
    if (weekdayOffset > 0) {
      candidateDate = addLocalDays(candidateDate, weekdayOffset);
    }

    let candidate = buildCandidateForLocalDate(schedule, candidateDate);
    while (candidate.getTime() <= now.getTime() + TIMER_DUE_TOLERANCE_MS) {
      candidateDate = addLocalDays(candidateDate, 14);
      candidate = buildCandidateForLocalDate(schedule, candidateDate);
    }
    return candidate;
  }

  const intervalDays = schedule.frequency === 'biweekly' ? 14 : 7;
  const todayWeekday = localWeekday(today);
  let daysUntil = (schedule.dayOfWeek - todayWeekday + 7) % 7;
  let candidateDate = addLocalDays(today, daysUntil);
  let candidate = buildCandidateForLocalDate(schedule, candidateDate);

  if (candidate.getTime() <= now.getTime() + TIMER_DUE_TOLERANCE_MS) {
    candidateDate = addLocalDays(candidateDate, intervalDays);
    candidate = buildCandidateForLocalDate(schedule, candidateDate);
  }

  return candidate;
}

function dateToIso(value) {
  const date = getDateOrNull(value);
  return date ? date.toISOString() : null;
}

class DeviceRestartService {
  constructor(options = {}) {
    this.settingsModel = options.settingsModel || Settings;
    this.spawnProcess = options.spawnProcess || spawn;
    this.rebootBinary = options.rebootBinary || '';
    this.rebootBinaryCandidates = options.rebootBinaryCandidates || REBOOT_BINARY_CANDIDATES;
    this.timer = null;
    this.currentSchedule = normalizeRestartSchedule({});
    this.initialized = false;
  }

  async initialize() {
    const settings = await this.settingsModel.getSettings();
    await this.configureFromSettings(settings);
    this.initialized = true;
  }

  stop() {
    this.clearTimer();
  }

  clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async configureFromSettings(settings) {
    this.clearTimer();

    const schedule = normalizeRestartSchedule(settings || {});
    const nextRunAt = computeNextRestartRunAt(settings || {});
    schedule.nextRunAt = nextRunAt;
    this.currentSchedule = schedule;

    if (settings && typeof settings.save === 'function') {
      const previousNextRunAt = dateToIso(settings.deviceRestartScheduleNextRunAt);
      const nextRunIso = dateToIso(nextRunAt);
      if (previousNextRunAt !== nextRunIso) {
        settings.deviceRestartScheduleNextRunAt = nextRunAt;
        await settings.save();
      }
    }

    if (schedule.enabled && nextRunAt) {
      this.scheduleTimer(nextRunAt);
    }

    return this.getStatus();
  }

  scheduleTimer(nextRunAt) {
    const target = getDateOrNull(nextRunAt);
    if (!target) {
      return;
    }

    const remainingMs = target.getTime() - Date.now();
    const delayMs = Math.max(1000, Math.min(MAX_TIMER_DELAY_MS, remainingMs));
    this.timer = setTimeout(() => {
      this.timer = null;
      const stillRemainingMs = target.getTime() - Date.now();
      if (stillRemainingMs > TIMER_DUE_TOLERANCE_MS) {
        this.scheduleTimer(target);
        return;
      }

      this.handleScheduledReboot(target).catch((error) => {
        console.error(`DeviceRestartService: scheduled reboot failed: ${error.message}`);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  async handleScheduledReboot(targetRunAt) {
    const settings = await this.settingsModel.getSettings();
    if (settings.deviceRestartScheduleEnabled !== true) {
      await this.configureFromSettings(settings);
      return null;
    }

    const requestedAt = new Date();
    settings.deviceRestartScheduleLastTriggeredAt = requestedAt;
    settings.deviceRestartScheduleNextRunAt = null;
    settings.deviceRestartLastRequestedAt = requestedAt;
    settings.deviceRestartLastRequestedBy = 'system:scheduler';
    settings.deviceRestartLastRequestSource = 'scheduled';
    await settings.save();
    await this.configureFromSettings(settings);

    return this.dispatchRebootCommand({
      actor: 'system:scheduler',
      source: 'scheduled',
      requestedAt,
      targetRunAt
    });
  }

  async requestManualReboot(options = {}) {
    const requestedAt = new Date();
    const actor = typeof options.actor === 'string' && options.actor.trim()
      ? options.actor.trim()
      : 'unknown-admin';

    const settings = await this.settingsModel.getSettings().catch(() => null);
    if (settings && typeof settings.save === 'function') {
      settings.deviceRestartLastRequestedAt = requestedAt;
      settings.deviceRestartLastRequestedBy = actor;
      settings.deviceRestartLastRequestSource = 'manual';
      await settings.save();
    }

    return this.dispatchRebootCommand({
      actor,
      source: 'manual',
      requestedAt
    });
  }

  resolveRebootBinary() {
    if (this.rebootBinary) {
      return this.rebootBinary;
    }

    const found = this.rebootBinaryCandidates.find((candidate) => fs.existsSync(candidate));
    return found || 'reboot';
  }

  dispatchRebootCommand(options = {}) {
    const rebootBinary = this.resolveRebootBinary();
    const command = 'sudo';
    const args = ['-n', rebootBinary];
    const requestedAt = options.requestedAt instanceof Date ? options.requestedAt : new Date();

    let child;
    try {
      child = this.spawnProcess(command, args, {
        detached: true,
        stdio: 'ignore'
      });
    } catch (error) {
      const message = error?.message || 'Unable to dispatch device reboot command.';
      throw new Error(`Unable to dispatch device reboot command: ${message}`);
    }

    child?.unref?.();

    return {
      success: true,
      message: 'Whole-device reboot command dispatched.',
      command: `${command} -n ${rebootBinary}`,
      source: options.source || 'manual',
      requestedAt: requestedAt.toISOString()
    };
  }

  getStatus() {
    return {
      success: true,
      schedule: {
        enabled: this.currentSchedule.enabled,
        frequency: this.currentSchedule.frequency,
        dayOfWeek: this.currentSchedule.dayOfWeek,
        time: this.currentSchedule.time,
        timeZone: this.currentSchedule.timeZone,
        nextRunAt: dateToIso(this.currentSchedule.nextRunAt),
        lastTriggeredAt: dateToIso(this.currentSchedule.lastTriggeredAt)
      }
    };
  }
}

const deviceRestartService = new DeviceRestartService();

module.exports = deviceRestartService;
module.exports.DeviceRestartService = DeviceRestartService;
module.exports.computeNextRestartRunAt = computeNextRestartRunAt;
module.exports.normalizeRestartSchedule = normalizeRestartSchedule;

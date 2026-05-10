const Settings = require('../models/Settings');
const defaultSystemBackupService = require('./systemBackupService');
const defaultEventStreamService = require('./eventStreamService');

const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;
const TIMER_DUE_TOLERANCE_MS = 1000;
const DEFAULT_TIMEZONE = 'America/New_York';
const DEFAULT_BACKUP_TIME = '02:30';
const DEFAULT_RETENTION_COUNT = 3;
const WEEKDAY_SHORT_TO_INDEX = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
});

function parseScheduleTime(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return { value: DEFAULT_BACKUP_TIME, hour: 2, minute: 30 };
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { value: DEFAULT_BACKUP_TIME, hour: 2, minute: 30 };
  }

  return {
    value: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    hour,
    minute
  };
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

function normalizeRetentionCount(value, fallback = DEFAULT_RETENTION_COUNT) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(30, Math.max(1, Math.trunc(numeric)));
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

function dateToIso(value) {
  const date = getDateOrNull(value);
  return date ? date.toISOString() : null;
}

function normalizeSmbBackupSchedule(settings = {}) {
  const parsedTime = parseScheduleTime(settings.smbBackupScheduleTime);
  const timeZone = normalizeTimeZone(settings.timezone);
  const shareUrl = typeof settings.smbBackupShareUrl === 'string'
    ? settings.smbBackupShareUrl.trim()
    : '';

  return {
    enabled: settings.smbBackupScheduleEnabled === true,
    time: parsedTime.value,
    hour: parsedTime.hour,
    minute: parsedTime.minute,
    timeZone,
    shareUrlConfigured: Boolean(shareUrl),
    remoteDirectory: typeof settings.smbBackupRemoteDirectory === 'string'
      ? settings.smbBackupRemoteDirectory.trim()
      : '',
    usernameConfigured: Boolean(String(settings.smbBackupUsername || '').trim()),
    passwordConfigured: Boolean(String(settings.smbBackupPassword || '').trim()),
    domainConfigured: Boolean(String(settings.smbBackupDomain || '').trim()),
    retentionCount: normalizeRetentionCount(settings.smbBackupRetentionCount),
    nextRunAt: getDateOrNull(settings.smbBackupScheduleNextRunAt),
    lastTriggeredAt: getDateOrNull(settings.smbBackupScheduleLastTriggeredAt),
    lastCompletedAt: getDateOrNull(settings.smbBackupScheduleLastCompletedAt),
    lastStatus: typeof settings.smbBackupScheduleLastStatus === 'string'
      ? settings.smbBackupScheduleLastStatus.trim()
      : '',
    lastError: typeof settings.smbBackupScheduleLastError === 'string'
      ? settings.smbBackupScheduleLastError.trim()
      : ''
  };
}

function computeNextSmbBackupRunAt(settings = {}, fromDate = new Date()) {
  const schedule = normalizeSmbBackupSchedule(settings);
  if (!schedule.enabled || !schedule.shareUrlConfigured) {
    return null;
  }

  const now = fromDate instanceof Date ? fromDate : new Date(fromDate);
  if (Number.isNaN(now.getTime())) {
    return null;
  }

  const nowParts = getZonedParts(now, schedule.timeZone);
  let candidateDate = { year: nowParts.year, month: nowParts.month, day: nowParts.day };
  let candidate = localDateTimeToUtcDate(
    schedule.timeZone,
    candidateDate.year,
    candidateDate.month,
    candidateDate.day,
    schedule.hour,
    schedule.minute
  );

  if (candidate.getTime() <= now.getTime() + TIMER_DUE_TOLERANCE_MS) {
    candidateDate = addLocalDays(candidateDate, 1);
    candidate = localDateTimeToUtcDate(
      schedule.timeZone,
      candidateDate.year,
      candidateDate.month,
      candidateDate.day,
      schedule.hour,
      schedule.minute
    );
  }

  return candidate;
}

class SmbBackupSchedulerService {
  constructor(options = {}) {
    this.settingsModel = options.settingsModel || Settings;
    this.backupService = options.backupService || defaultSystemBackupService;
    this.eventStreamService = Object.prototype.hasOwnProperty.call(options, 'eventStreamService')
      ? options.eventStreamService
      : defaultEventStreamService;
    this.now = options.now || (() => new Date());
    this.timer = null;
    this.currentSchedule = normalizeSmbBackupSchedule({});
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

    const schedule = normalizeSmbBackupSchedule(settings || {});
    const nextRunAt = computeNextSmbBackupRunAt(settings || {}, this.now());
    schedule.nextRunAt = nextRunAt;
    this.currentSchedule = schedule;

    if (settings && typeof settings.save === 'function') {
      const previousNextRunAt = dateToIso(settings.smbBackupScheduleNextRunAt);
      const nextRunIso = dateToIso(nextRunAt);
      if (previousNextRunAt !== nextRunIso) {
        settings.smbBackupScheduleNextRunAt = nextRunAt;
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

      this.handleScheduledBackup(target).catch((error) => {
        console.error(`SmbBackupSchedulerService: scheduled backup failed: ${error.message}`);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  async publishBackupEvent(status, payload = {}) {
    if (!this.eventStreamService || typeof this.eventStreamService.publishSafe !== 'function') {
      return null;
    }

    return this.eventStreamService.publishSafe({
      type: `system.smb_backup.${status}`,
      source: 'smb_backup_scheduler',
      category: 'maintenance',
      severity: status === 'failed' ? 'error' : 'info',
      payload: {
        status,
        actor: payload.actor || 'system:scheduler',
        requestSource: payload.source || 'scheduled',
        targetRunAt: dateToIso(payload.targetRunAt),
        requestedAt: dateToIso(payload.requestedAt),
        job: payload.job || null,
        error: payload.error || null
      },
      tags: ['maintenance', 'backup', 'smb']
    });
  }

  async handleScheduledBackup(targetRunAt) {
    const settings = await this.settingsModel.getSettings();
    const schedule = normalizeSmbBackupSchedule(settings);
    if (!schedule.enabled || !schedule.shareUrlConfigured) {
      await this.configureFromSettings(settings);
      return null;
    }

    const requestedAt = this.now();
    settings.smbBackupScheduleLastTriggeredAt = requestedAt;
    settings.smbBackupScheduleNextRunAt = null;
    settings.smbBackupScheduleLastStatus = 'queued';
    settings.smbBackupScheduleLastError = '';
    await settings.save();
    await this.configureFromSettings(settings);

    try {
      const job = await this.backupService.startScheduledSmbBackupJobFromSettings(settings, {
        actor: 'system:scheduler',
        targetRunAt,
        onComplete: async (completedJob) => {
          await this.handleBackupCompleted(completedJob, targetRunAt);
        }
      });

      await this.publishBackupEvent('queued', {
        requestedAt,
        targetRunAt,
        job
      });

      return job;
    } catch (error) {
      settings.smbBackupScheduleLastStatus = 'failed';
      settings.smbBackupScheduleLastError = error.message || 'Scheduled SMB backup failed to start.';
      await settings.save().catch(() => {});
      await this.configureFromSettings(settings).catch(() => {});
      await this.publishBackupEvent('failed', {
        requestedAt,
        targetRunAt,
        error: error.message
      });
      throw error;
    }
  }

  async handleBackupCompleted(job, targetRunAt) {
    const settings = await this.settingsModel.getSettings();
    const status = typeof job?.status === 'string' ? job.status : 'failed';
    settings.smbBackupScheduleLastStatus = status;
    settings.smbBackupScheduleLastError = job?.error || '';
    if (status === 'completed') {
      settings.smbBackupScheduleLastCompletedAt = getDateOrNull(job?.completedAt) || this.now();
    }
    await settings.save();
    await this.configureFromSettings(settings);

    await this.publishBackupEvent(status === 'completed' ? 'completed' : 'failed', {
      targetRunAt,
      requestedAt: settings.smbBackupScheduleLastTriggeredAt,
      job,
      error: job?.error || null
    });
  }

  getStatus() {
    return {
      success: true,
      schedule: {
        enabled: this.currentSchedule.enabled,
        time: this.currentSchedule.time,
        timeZone: this.currentSchedule.timeZone,
        retentionCount: this.currentSchedule.retentionCount,
        shareUrlConfigured: this.currentSchedule.shareUrlConfigured,
        remoteDirectory: this.currentSchedule.remoteDirectory,
        usernameConfigured: this.currentSchedule.usernameConfigured,
        passwordConfigured: this.currentSchedule.passwordConfigured,
        domainConfigured: this.currentSchedule.domainConfigured,
        nextRunAt: dateToIso(this.currentSchedule.nextRunAt),
        lastTriggeredAt: dateToIso(this.currentSchedule.lastTriggeredAt),
        lastCompletedAt: dateToIso(this.currentSchedule.lastCompletedAt),
        lastStatus: this.currentSchedule.lastStatus || '',
        lastError: this.currentSchedule.lastError || ''
      }
    };
  }
}

const smbBackupSchedulerService = new SmbBackupSchedulerService();

module.exports = smbBackupSchedulerService;
module.exports.SmbBackupSchedulerService = SmbBackupSchedulerService;
module.exports.computeNextSmbBackupRunAt = computeNextSmbBackupRunAt;
module.exports.normalizeSmbBackupSchedule = normalizeSmbBackupSchedule;

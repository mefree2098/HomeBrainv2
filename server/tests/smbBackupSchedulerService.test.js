const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SmbBackupSchedulerService,
  computeNextSmbBackupRunAt
} = require('../services/smbBackupSchedulerService');

test('computeNextSmbBackupRunAt schedules the next nightly backup in the configured timezone', () => {
  const sameNight = computeNextSmbBackupRunAt({
    smbBackupScheduleEnabled: true,
    smbBackupShareUrl: 'smb://nas.local/backups',
    smbBackupScheduleTime: '02:30',
    timezone: 'America/Denver'
  }, new Date('2026-05-10T07:00:00.000Z'));

  const nextNight = computeNextSmbBackupRunAt({
    smbBackupScheduleEnabled: true,
    smbBackupShareUrl: 'smb://nas.local/backups',
    smbBackupScheduleTime: '02:30',
    timezone: 'America/Denver'
  }, new Date('2026-05-10T09:00:00.000Z'));

  assert.equal(sameNight.toISOString(), '2026-05-10T08:30:00.000Z');
  assert.equal(nextNight.toISOString(), '2026-05-11T08:30:00.000Z');
});

test('computeNextSmbBackupRunAt disables scheduling until an SMB share is configured', () => {
  const nextRunAt = computeNextSmbBackupRunAt({
    smbBackupScheduleEnabled: true,
    smbBackupScheduleTime: '02:30',
    timezone: 'America/Denver'
  }, new Date('2026-05-10T07:00:00.000Z'));

  assert.equal(nextRunAt, null);
});

test('handleScheduledBackup queues a saved-settings backup and records completion status', async () => {
  const events = [];
  const settingsDoc = {
    smbBackupShareUrl: 'smb://nas.local/backups',
    smbBackupRemoteDirectory: 'HomeBrain',
    smbBackupUsername: 'matt',
    smbBackupPassword: 'super-secret',
    smbBackupScheduleEnabled: true,
    smbBackupScheduleTime: '02:30',
    smbBackupRetentionCount: 3,
    timezone: 'America/Denver',
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
    }
  };
  const backupCalls = [];
  const service = new SmbBackupSchedulerService({
    settingsModel: {
      getSettings: async () => settingsDoc
    },
    backupService: {
      startScheduledSmbBackupJobFromSettings: async (settings, options) => {
        backupCalls.push({ settings, options });
        await options.onComplete({
          id: 'job-1',
          status: 'completed',
          completedAt: '2026-05-10T08:35:00.000Z',
          source: 'scheduled'
        });
        return {
          id: 'job-1',
          status: 'queued',
          source: 'scheduled'
        };
      }
    },
    eventStreamService: {
      publishSafe: async (event) => {
        events.push(event);
        return event;
      }
    },
    now: () => new Date('2026-05-10T08:31:00.000Z')
  });

  const targetRunAt = new Date('2026-05-10T08:30:00.000Z');
  const job = await service.handleScheduledBackup(targetRunAt);
  service.stop();

  assert.equal(job.id, 'job-1');
  assert.equal(backupCalls.length, 1);
  assert.equal(backupCalls[0].options.actor, 'system:scheduler');
  assert.equal(backupCalls[0].options.targetRunAt, targetRunAt);
  assert.equal(settingsDoc.smbBackupScheduleLastStatus, 'completed');
  assert.equal(settingsDoc.smbBackupScheduleLastError, '');
  assert.equal(settingsDoc.smbBackupScheduleLastCompletedAt.toISOString(), '2026-05-10T08:35:00.000Z');
  assert.ok(settingsDoc.smbBackupScheduleNextRunAt instanceof Date);
  assert.equal(settingsDoc.smbBackupScheduleNextRunAt.toISOString(), '2026-05-11T08:30:00.000Z');
  assert.equal(settingsDoc.saveCalls >= 3, true);
  assert.deepEqual(events.map((event) => event.type), [
    'system.smb_backup.completed',
    'system.smb_backup.queued'
  ]);
});

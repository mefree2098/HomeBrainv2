const Device = require('../models/Device');
const AutomationHistory = require('../models/AutomationHistory');
const ApplianceIntegration = require('../models/ApplianceIntegration');
const Settings = require('../models/Settings');

function summarizeOperationalHealth(devices, failedExecutions, integrations, settings, now = Date.now(), latestBackup = null) {
  const offline = devices.filter((device) => device.isOnline === false);
  const unenrolled = devices.filter((device) => {
    const ias = device.properties?.homebrainDirect?.iasZone;
    return ias && !(ias.enrolled === true && ias.cieMatchesCoordinator === true);
  });
  const unavailable = integrations.filter((integration) => integration.enabled && integration.configured && !integration.connected);
  const destination = settings.backupDestination === 'local' ? 'local' : 'smb';
  const completedAt = latestBackup?.status === 'completed' && latestBackup.destination === destination
    ? latestBackup.completedAt : settings.smbBackupScheduleLastCompletedAt;
  const backupAge = completedAt ? now - new Date(completedAt).getTime() : Infinity;
  const backupReady = settings.smbBackupScheduleEnabled === true && (destination === 'local' || Boolean(settings.smbBackupShareUrl))
    && Number.isFinite(backupAge) && backupAge < 48 * 60 * 60 * 1000;
  return {
    devices: {
      status: offline.length ? 'degraded' : 'healthy',
      message: `${offline.length} offline device(s).`,
      offlineCount: offline.length,
      affectedDevices: offline.map(({ _id, name }) => ({ id: String(_id), name }))
    },
    enrollment: {
      status: unenrolled.length ? 'degraded' : 'healthy',
      message: `${unenrolled.length} Zigbee IAS device(s) need confirmed alarm enrollment.`,
      affectedDevices: unenrolled.map(({ _id, name }) => ({ id: String(_id), name }))
    },
    automations: {
      status: failedExecutions ? 'degraded' : 'healthy',
      message: `${failedExecutions} failed or partial automation execution(s) in the last 24 hours.`,
      failedExecutions, windowHours: 24
    },
    integrations: {
      status: unavailable.length ? 'degraded' : 'healthy',
      message: unavailable.length ? `Unavailable appliance integrations: ${unavailable.map((item) => item.provider).join(', ')}.` : 'Configured appliance integrations are ready.'
    },
    backups: {
      status: backupReady ? 'healthy' : 'degraded',
      message: backupReady ? `${destination === 'local' ? 'Local' : 'Network'} backup completed within 48 hours.` : 'A backup has not completed within 48 hours or its schedule is disabled.',
      destination,
      retentionCount: settings.smbBackupRetentionCount || 3,
      lastCompletedAt: completedAt || null
    }
  };
}

async function getOperationalHealth() {
  const [devices, failed, integrations, settings, latestBackup] = await Promise.all([
    Device.find({}).select('_id name isOnline properties.homebrainDirect.iasZone').lean(),
    AutomationHistory.countDocuments({ status: { $in: ['failed', 'partial_success'] }, executedAt: { $gte: new Date(Date.now() - 86400000) } }),
    ApplianceIntegration.find({ enabled: true, configured: true }).select('provider enabled configured connected').lean(),
    Settings.getSettings(),
    require('./systemBackupService').getLatestBackupJob().catch(() => null)
  ]);
  return summarizeOperationalHealth(devices, failed, integrations, settings, Date.now(), latestBackup);
}

module.exports = { getOperationalHealth, summarizeOperationalHealth };

const Device = require('../models/Device');
const AutomationHistory = require('../models/AutomationHistory');
const ApplianceIntegration = require('../models/ApplianceIntegration');
const Settings = require('../models/Settings');

const TempestIntegration = require('../models/TempestIntegration');
const GoveeIntegration = require('../models/GoveeIntegration');
const SenseIntegration = require('../models/SenseIntegration');
const RainMachineIntegration = require('../models/RainMachineIntegration');

async function getSensorFeeds() {
  const feeds = [
    { model: TempestIntegration, name: 'Tempest', timestamp: 'lastObservationAt', minimumMs: 900_000 },
    { model: GoveeIntegration, name: 'Govee', timestamp: 'lastSampleAt', interval: 'pollIntervalMs', unitMs: 1 },
    { model: SenseIntegration, name: 'Sense', timestamp: 'lastRealtimeAt', interval: 'pollIntervalSeconds', unitMs: 1000 },
    { model: RainMachineIntegration, name: 'RainMachine', timestamp: 'lastSyncAt', interval: 'pollIntervalMinutes', unitMs: 60_000 }
  ];
  return (await Promise.all(feeds.map(async ({ model, name, timestamp, interval, unitMs, minimumMs }) => {
    const row = await model.findOne({ enabled: true }).select([timestamp, interval].filter(Boolean).join(' ')).lean();
    if (!row) return null;
    return {
      name, lastReadingAt: row[timestamp] || null,
      maxAgeMs: Math.max(minimumMs || 300_000, interval ? 3 * (Number(row[interval]) || 0) * unitMs : 0)
    };
  }))).filter(Boolean);
}

function summarizeOperationalHealth(devices, failedExecutions, integrations, settings, now = Date.now(), latestBackup = null, feeds = []) {
  const offline = devices.filter((device) => device.isOnline === false);
  const unenrolled = devices.filter((device) => {
    const ias = device.properties?.homebrainDirect?.iasZone;
    return ias && !(ias.enrolled === true && ias.cieMatchesCoordinator === true);
  });
  const unavailable = integrations.filter((integration) => integration.enabled && integration.configured && !integration.connected);
  const stale = devices.filter((device) => device.properties?.homebrainDirect?.stateStale === true);
  const destination = settings.backupDestination === 'local' ? 'local' : 'smb';
  const completedAt = latestBackup?.status === 'completed' && latestBackup.destination === destination
    ? latestBackup.completedAt : settings.smbBackupScheduleLastCompletedAt;
  const backupAge = completedAt ? now - new Date(completedAt).getTime() : Infinity;
  const backupReady = settings.smbBackupScheduleEnabled === true && (destination === 'local' || Boolean(settings.smbBackupShareUrl))
    && Number.isFinite(backupAge) && backupAge < 48 * 60 * 60 * 1000;
  const staleFeeds = feeds.filter(({ lastReadingAt, maxAgeMs }) => {
    const age = lastReadingAt ? now - new Date(lastReadingAt).getTime() : NaN;
    return !Number.isFinite(age) || age < -60_000 || age > maxAgeMs;
  });
  const failedModules = devices.flatMap((device) => {
    if (!device.isOnline) return [];
    const diagnostics = device.properties?.homebrainSensor?.diagnostics || {};
    return Object.entries(diagnostics).filter(([key, value]) => key.endsWith('_available') && value === false)
      .map(([key]) => ({ name: device.name, module: key.slice(0, -'_available'.length) }));
  });
  return {
    sensorReadings: {
      status: staleFeeds.length || failedModules.length ? 'degraded' : 'healthy',
      message: [
        staleFeeds.length ? 'Overdue readings from ' + staleFeeds.map((feed) => feed.name).join(', ') : '',
        failedModules.map(({ name, module }) => name + ' reports ' + module + ' unavailable').join(', ')
      ].filter(Boolean).join('. ') || 'Configured feeds and reporting sensor modules are up to date.',
      staleFeeds, failedModules
    },
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
    cachedState: {
      status: stale.length ? 'degraded' : 'healthy',
      message: `${stale.length} device(s) have cached state that needs a live query.`,
      affectedDevices: stale.map(({ _id, name }) => ({ id: String(_id), name }))
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
  const [devices, failed, integrations, settings, latestBackup, feeds] = await Promise.all([
    Device.find({}).select('_id name isOnline properties.homebrainDirect.iasZone properties.homebrainDirect.stateStale properties.homebrainSensor.diagnostics').lean(),
    AutomationHistory.countDocuments({ status: { $in: ['failed', 'partial_success'] }, completedAt: { $gte: new Date(Date.now() - 86400000) } }),
    ApplianceIntegration.find({ enabled: true, configured: true }).select('provider enabled configured connected').lean(),
    Settings.getSettings(),
    require('./systemBackupService').getLatestBackupJob().catch(() => null),
    getSensorFeeds()
  ]);
  return summarizeOperationalHealth(devices, failed, integrations, settings, Date.now(), latestBackup, feeds);
}

module.exports = { getOperationalHealth, summarizeOperationalHealth };

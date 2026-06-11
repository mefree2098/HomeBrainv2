const HomeBrainNotification = require('../models/HomeBrainNotification');
const PushSubscription = require('../models/PushSubscription');
const User = require('../models/User');
const Device = require('../models/Device');
const SecurityAlarm = require('../models/SecurityAlarm');
const apnsService = require('./apnsService');
const eventStreamService = require('./eventStreamService');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const OFFLINE_DEVICE_EVENT_TYPES = ['device.offline', 'security.device.offline'];

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, parsed));
}

function normalizeChannel(value, fallback = 'normal') {
  const normalized = normalizeString(value);
  if (normalized === 'securityCritical') return 'securityCritical';
  if (normalized === 'normal') return 'normal';
  return fallback;
}

function normalizeClearChannel(value) {
  const normalized = normalizeString(value);
  if (!normalized || normalized === 'all') return '';
  if (normalized === 'securityCritical' || normalized === 'normal') return normalized;

  const error = new Error('Invalid notification channel.');
  error.status = 400;
  throw error;
}

function normalizeSeverity(value, fallback = 'info') {
  const normalized = normalizeString(value).toLowerCase();
  if (['info', 'warning', 'critical'].includes(normalized)) return normalized;
  return fallback;
}

function normalizeCategory(value, fallback = 'system') {
  const normalized = normalizeString(value).toLowerCase();
  if (['security', 'device', 'system', 'automation'].includes(normalized)) return normalized;
  return fallback;
}

function normalizeDeviceFamily(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'iphone' || normalized === 'phone') return 'iPhone';
  if (normalized === 'ipad' || normalized === 'tablet') return 'iPad';
  if (normalized === 'ipod') return 'iPod';
  if (normalized === 'watch' || normalized === 'applewatch' || normalized === 'watchos') return 'Watch';
  if (normalized === 'mac' || normalized === 'macos') return 'mac';
  return 'unknown';
}

function defaultSecurityCriticalPushEnabled(deviceFamily) {
  return normalizeDeviceFamily(deviceFamily) === 'iPhone';
}

function toPublicNotification(doc) {
  if (!doc) return null;
  const source = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(source._id || source.id || ''),
    channel: source.channel,
    severity: source.severity,
    category: source.category,
    eventType: source.eventType || '',
    eventKey: source.eventKey || '',
    source: source.source || 'homebrain',
    title: source.title,
    message: source.message,
    deviceId: source.deviceId || '',
    zoneDeviceId: source.zoneDeviceId || '',
    metadata: source.metadata || {},
    occurredAt: source.occurredAt,
    clearedAt: source.clearedAt || null,
    resolvedAt: source.resolvedAt || null,
    resolvedReason: source.resolvedReason || '',
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    pushDelivery: source.pushDelivery || null
  };
}

function collectSecurityDeviceIds(alarm) {
  const ids = new Set();
  const add = (value) => {
    const normalized = normalizeString(value);
    if (normalized) ids.add(normalized);
  };

  (Array.isArray(alarm?.zones) ? alarm.zones : []).forEach((zone) => {
    if (zone?.enabled === false) return;
    add(zone.deviceId);
  });

  (Array.isArray(alarm?.sirenOutputs) ? alarm.sirenOutputs : []).forEach((output) => {
    if (output?.enabled === false) return;
    add(output.deviceId);
    add(output.localDeviceId);
    add(output.smartThingsDeviceId);
  });

  return ids;
}

function isDeviceSecurityCritical(device, securityDeviceIds) {
  const candidates = [
    device?._id?.toString?.(),
    device?._id,
    device?.id,
    device?.deviceId,
    device?.properties?.smartThingsDeviceId,
    device?.properties?.homebrainDeviceId,
    device?.properties?.homebrainDirect?.ieeeAddr,
    device?.properties?.homebrainDirect?.nodeId,
    device?.properties?.matterNodeId
  ].map(normalizeString).filter(Boolean);

  if (candidates.some((candidate) => securityDeviceIds.has(candidate))) {
    return true;
  }

  const type = normalizeString(device?.type).toLowerCase();
  return type === 'siren' && candidates.some((candidate) => securityDeviceIds.has(candidate));
}

function publishEvent(type, notification, extra = {}) {
  eventStreamService.publishSafe?.({
    type,
    source: 'notifications',
    category: notification?.category || 'system',
    severity: notification?.severity || 'info',
    correlationId: notification?.eventKey || notification?.id || '',
    payload: {
      notification,
      ...extra
    }
  });
}

async function findHomeBrainUsers() {
  const query = {
    isActive: true,
    $or: [
      { 'platforms.homebrain': true },
      { platforms: { $exists: false } },
      { 'platforms.homebrain': { $exists: false } }
    ]
  };
  return User.find(query).select('_id email role platforms').lean();
}

async function upsertNotificationForUser(userId, input) {
  const now = new Date();
  const channel = normalizeChannel(input.channel, 'normal');
  const severity = normalizeSeverity(input.severity, channel === 'securityCritical' ? 'critical' : 'info');
  const category = normalizeCategory(input.category, channel === 'securityCritical' ? 'security' : 'system');
  const eventKey = normalizeString(input.eventKey);
  const title = normalizeString(input.title) || 'HomeBrain notification';
  const message = normalizeString(input.message) || title;
  const eventType = normalizeString(input.eventType);
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : now;
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};

  const filter = eventKey
    ? { userId, eventKey, clearedAt: null, resolvedAt: null }
    : { _id: undefined };

  if (!eventKey) {
    const created = await HomeBrainNotification.create({
      userId,
      channel,
      severity,
      category,
      eventType,
      eventKey,
      source: normalizeString(input.source) || 'homebrain',
      title,
      message,
      deviceId: normalizeString(input.deviceId),
      zoneDeviceId: normalizeString(input.zoneDeviceId),
      metadata,
      occurredAt,
      pushDelivery: {
        status: channel === 'securityCritical' ? 'skipped' : 'not_applicable',
        skippedReason: channel === 'securityCritical' ? 'push_delivery_pending' : ''
      }
    });
    return { notification: created, created: true };
  }

  const result = await HomeBrainNotification.findOneAndUpdate(
    filter,
    {
      $setOnInsert: {
        userId,
        channel,
        severity,
        category,
        eventType,
        eventKey,
        source: normalizeString(input.source) || 'homebrain',
        title,
        message,
        deviceId: normalizeString(input.deviceId),
        zoneDeviceId: normalizeString(input.zoneDeviceId),
        occurredAt,
        clearedAt: null,
        resolvedAt: null,
        resolvedReason: '',
        pushDelivery: {
          status: channel === 'securityCritical' ? 'skipped' : 'not_applicable',
          skippedReason: channel === 'securityCritical' ? 'push_delivery_pending' : ''
        }
      },
      $set: {
        metadata: {
          ...metadata,
          lastObservedAt: now.toISOString()
        }
      }
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      includeResultMetadata: true
    }
  );

  if (result && Object.prototype.hasOwnProperty.call(result, 'value')) {
    return {
      notification: result.value,
      created: !result.lastErrorObject?.updatedExisting
    };
  }

  return {
    notification: result,
    created: false
  };
}

async function deliverSecurityCriticalPushes(notification, input = {}) {
  const publicNotification = toPublicNotification(notification);
  if (!publicNotification || publicNotification.channel !== 'securityCritical') {
    return { status: 'not_applicable', successCount: 0, failureCount: 0, errors: [] };
  }

  const subscriptions = await PushSubscription.find({
    userId: notification.userId,
    platform: 'apns',
    pushEnabled: true,
    securityCriticalPushEnabled: true,
    disabledAt: null
  }).lean();

  if (!subscriptions.length) {
    return {
      attemptedAt: new Date(),
      status: 'skipped',
      successCount: 0,
      failureCount: 0,
      skippedReason: 'no_enabled_push_subscriptions',
      errors: []
    };
  }

  const results = await Promise.all(subscriptions.map(async (subscription) => {
    const result = await apnsService.sendAlertToToken(subscription.deviceToken, {
      title: publicNotification.title,
      body: publicNotification.message,
      notificationId: publicNotification.id,
      channel: publicNotification.channel,
      eventType: publicNotification.eventType,
      eventKey: publicNotification.eventKey,
      deviceId: publicNotification.deviceId,
      deviceFamily: subscription.deviceFamily,
      bundleId: subscription.bundleId,
      environment: subscription.environment,
      collapseId: input.collapseId,
      ttlSeconds: input.ttlSeconds ?? 10 * 60
    });

    if (!result.success && ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(result.reason)) {
      await PushSubscription.updateOne(
        { _id: subscription._id },
        {
          $set: {
            pushEnabled: false,
            disabledAt: new Date(),
            lastFailureAt: new Date(),
            lastFailureReason: result.reason
          },
          $inc: { failureCount: 1 }
        }
      );
    } else if (!result.success && !result.skipped) {
      await PushSubscription.updateOne(
        { _id: subscription._id },
        {
          $set: {
            lastFailureAt: new Date(),
            lastFailureReason: result.reason || `apns_${result.statusCode || 'failed'}`
          },
          $inc: { failureCount: 1 }
        }
      );
    }

    return result;
  }));

  const successCount = results.filter((result) => result.success).length;
  const skippedCount = results.filter((result) => result.skipped).length;
  const failureCount = results.length - successCount - skippedCount;
  const errors = results
    .filter((result) => !result.success && !result.skipped)
    .map((result) => result.reason || `apns_${result.statusCode || 'failed'}`)
    .filter(Boolean)
    .slice(0, 8);

  return {
    attemptedAt: new Date(),
    status: successCount === results.length
      ? 'sent'
      : successCount > 0
        ? 'partial_failure'
        : skippedCount === results.length
          ? 'skipped'
          : 'failed',
    successCount,
    failureCount,
    skippedReason: skippedCount === results.length ? (results[0]?.reason || 'apns_skipped') : '',
    errors
  };
}

async function updatePushDelivery(notificationId, delivery) {
  if (!notificationId) return null;
  return HomeBrainNotification.findByIdAndUpdate(
    notificationId,
    {
      $set: {
        pushDelivery: delivery
      }
    },
    { new: true }
  );
}

async function createSystemNotification(input = {}) {
  const users = Array.isArray(input.userIds) && input.userIds.length > 0
    ? input.userIds.map((userId) => ({ _id: userId }))
    : await findHomeBrainUsers();

  const notifications = [];
  let remoteForwardNotification = null;
  for (const user of users) {
    const { notification, created } = await upsertNotificationForUser(user._id, input);
    let publicNotification = toPublicNotification(notification);

    if (created && publicNotification?.channel === 'securityCritical') {
      const delivery = await deliverSecurityCriticalPushes(notification, input);
      const updated = await updatePushDelivery(notification._id, delivery);
      publicNotification = toPublicNotification(updated || notification);
      if (!remoteForwardNotification) {
        remoteForwardNotification = publicNotification;
      }
    }

    if (created) {
      publishEvent('notification.created', publicNotification);
    }
    notifications.push(publicNotification);
  }

  if (remoteForwardNotification) {
    const remoteHomeBrainNotificationService = require('./remoteHomeBrainNotificationService');
    remoteHomeBrainNotificationService
      .forwardSecurityCriticalNotification(remoteForwardNotification, input)
      .catch((error) => {
        console.warn('NotificationService: failed to forward security-critical notification:', error.message);
      });
  }

  return notifications;
}

async function resolveStaleOfflineDeviceNotifications(offlineDeviceIds) {
  const now = new Date();
  const activeOfflineDeviceIds = Array.from(offlineDeviceIds || [])
    .map(normalizeString)
    .filter(Boolean);

  const result = await HomeBrainNotification.updateMany(
    {
      eventType: { $in: OFFLINE_DEVICE_EVENT_TYPES },
      clearedAt: null,
      resolvedAt: null,
      deviceId: { $nin: activeOfflineDeviceIds }
    },
    {
      $set: {
        resolvedAt: now,
        resolvedReason: 'device_online',
        'metadata.resolvedBy': 'device-health',
        'metadata.resolvedAt': now.toISOString()
      }
    }
  );

  const resolvedCount = result.modifiedCount || 0;
  if (resolvedCount > 0) {
    publishEvent('notifications.resolved', null, {
      reason: 'device_online',
      resolvedCount
    });
  }

  return {
    resolvedCount,
    resolvedAt: now
  };
}

async function recordOfflineDeviceNotifications() {
  const [alarm, offlineDevices] = await Promise.all([
    SecurityAlarm.getMainAlarm().catch(() => null),
    Device.find({ isOnline: false })
      .select('name type room isOnline lastSeen properties')
      .lean()
  ]);

  const safeOfflineDevices = Array.isArray(offlineDevices) ? offlineDevices : [];
  const offlineDeviceIds = new Set(
    safeOfflineDevices
      .map((device) => normalizeString(device?._id?.toString?.() || device?._id || device?.id))
      .filter(Boolean)
  );

  await resolveStaleOfflineDeviceNotifications(offlineDeviceIds);

  const securityDeviceIds = collectSecurityDeviceIds(alarm);
  const results = [];

  for (const device of safeOfflineDevices) {
    const deviceId = normalizeString(device?._id?.toString?.() || device?._id || device?.id);
    if (!deviceId) continue;

    const isSecurityCritical = isDeviceSecurityCritical(device, securityDeviceIds);
    const name = normalizeString(device.name) || 'Unnamed device';
    const room = normalizeString(device.room);
    const location = room ? `${name} in ${room}` : name;
    const channel = isSecurityCritical ? 'securityCritical' : 'normal';
    const notifications = await createSystemNotification({
      channel,
      severity: isSecurityCritical ? 'critical' : 'warning',
      category: isSecurityCritical ? 'security' : 'device',
      eventType: isSecurityCritical ? 'security.device.offline' : 'device.offline',
      eventKey: `device-offline:${channel}:${deviceId}`,
      source: 'device-health',
      title: isSecurityCritical ? 'Security device offline' : 'Device offline',
      message: isSecurityCritical
        ? `${location} is part of the security system and is offline.`
        : `${location} is offline.`,
      deviceId,
      metadata: {
        type: normalizeString(device.type),
        room,
        lastSeen: device.lastSeen || null,
        isSecurityCritical
      },
      collapseId: `device-offline-${deviceId}`,
      ttlSeconds: 60 * 30
    });
    results.push(...notifications);
  }

  return results;
}

async function listNotifications(userId, options = {}) {
  await recordOfflineDeviceNotifications().catch((error) => {
    console.warn('NotificationService: failed to record offline device notifications:', error.message);
  });

  const limit = normalizeLimit(options.limit);
  const channel = normalizeString(options.channel);
  const includeCleared = normalizeBool(options.includeCleared, false);
  const includeResolved = normalizeBool(options.includeResolved, includeCleared);
  const query = { userId };
  if (channel && channel !== 'all') {
    query.channel = normalizeChannel(channel);
  }
  if (!includeCleared) {
    query.clearedAt = null;
  }
  if (!includeResolved) {
    query.resolvedAt = null;
  }

  const notifications = await HomeBrainNotification.find(query)
    .sort({ occurredAt: -1, createdAt: -1 })
    .limit(limit)
    .lean();

  return notifications.map(toPublicNotification).filter(Boolean);
}

async function getUnreadCounts(userId) {
  await recordOfflineDeviceNotifications().catch((error) => {
    console.warn('NotificationService: failed to record offline device notifications:', error.message);
  });

  const [normal, securityCritical] = await Promise.all([
    HomeBrainNotification.countDocuments({ userId, channel: 'normal', clearedAt: null, resolvedAt: null }),
    HomeBrainNotification.countDocuments({ userId, channel: 'securityCritical', clearedAt: null, resolvedAt: null })
  ]);
  return {
    normal,
    securityCritical,
    total: normal + securityCritical
  };
}

async function clearNotification(userId, notificationId) {
  const now = new Date();
  const updated = await HomeBrainNotification.findOneAndUpdate(
    { _id: notificationId, userId, clearedAt: null },
    { $set: { clearedAt: now, clearedBy: userId } },
    { new: true }
  );
  const publicNotification = toPublicNotification(updated);
  if (publicNotification) {
    publishEvent('notification.cleared', publicNotification);
    return publicNotification;
  }

  const existing = await HomeBrainNotification.findOne({ _id: notificationId, userId }).lean();
  return toPublicNotification(existing);
}

async function clearNotifications(userId, options = {}) {
  const channel = normalizeClearChannel(options.channel);
  const includeResolved = normalizeBool(options.includeResolved ?? options.includeHistory, false);
  const query = { userId, clearedAt: null };
  if (!includeResolved) {
    query.resolvedAt = null;
  }
  if (channel) {
    query.channel = channel;
  }
  const now = new Date();
  const result = await HomeBrainNotification.updateMany(
    query,
    { $set: { clearedAt: now, clearedBy: userId } }
  );
  publishEvent('notifications.cleared', null, {
    channel: channel || 'all',
    clearedCount: result.modifiedCount || 0,
    includeResolved
  });
  return {
    clearedCount: result.modifiedCount || 0,
    channel: channel || 'all',
    includeResolved,
    clearedAt: now
  };
}

async function registerPushDevice(userId, payload = {}) {
  const installationId = normalizeString(payload.installationId);
  const deviceToken = normalizeString(payload.deviceToken).replace(/\s/g, '');
  if (!installationId) {
    const error = new Error('installationId is required');
    error.status = 400;
    throw error;
  }
  if (!deviceToken) {
    const error = new Error('deviceToken is required');
    error.status = 400;
    throw error;
  }

  const deviceFamily = normalizeDeviceFamily(payload.deviceFamily);
  const securityCriticalPushEnabled = typeof payload.securityCriticalPushEnabled === 'boolean'
    ? payload.securityCriticalPushEnabled
    : defaultSecurityCriticalPushEnabled(deviceFamily);
  const now = new Date();

  const subscription = await PushSubscription.findOneAndUpdate(
    { userId, installationId, platform: 'apns' },
    {
      $set: {
        deviceToken,
        deviceFamily,
        deviceName: normalizeString(payload.deviceName),
        systemVersion: normalizeString(payload.systemVersion),
        appVersion: normalizeString(payload.appVersion),
        buildNumber: normalizeString(payload.buildNumber),
        environment: normalizeString(payload.environment) === 'production' ? 'production' : 'development',
        bundleId: normalizeString(payload.bundleId) || 'NTechR.HomeBrainApp',
        pushEnabled: normalizeBool(payload.pushEnabled, true),
        securityCriticalPushEnabled,
        authorizationStatus: normalizeString(payload.authorizationStatus) || 'authorized',
        disabledAt: null,
        lastRegisteredAt: now,
        lastSeenAt: now,
        lastFailureReason: ''
      },
      $setOnInsert: {
        userId,
        installationId,
        platform: 'apns',
        failureCount: 0
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return {
    id: String(subscription._id || ''),
    installationId: subscription.installationId,
    platform: subscription.platform,
    deviceFamily: subscription.deviceFamily,
    pushEnabled: subscription.pushEnabled,
    securityCriticalPushEnabled: subscription.securityCriticalPushEnabled,
    defaultSecurityCriticalPushEnabled: defaultSecurityCriticalPushEnabled(deviceFamily),
    lastRegisteredAt: subscription.lastRegisteredAt
  };
}

async function unregisterPushDevice(userId, installationId) {
  const normalizedInstallationId = normalizeString(installationId);
  if (!normalizedInstallationId) {
    const error = new Error('installationId is required');
    error.status = 400;
    throw error;
  }

  const result = await PushSubscription.updateMany(
    { userId, installationId: normalizedInstallationId, platform: 'apns' },
    {
      $set: {
        pushEnabled: false,
        securityCriticalPushEnabled: false,
        disabledAt: new Date()
      }
    }
  );

  return {
    disabledCount: result.modifiedCount || 0
  };
}

async function recordSecurityAlarmTriggered(alarm, input = {}) {
  const triggeredZoneName = normalizeString(input.triggeredZoneName || input.zoneName || alarm?.triggeredZone) || 'Security system';
  const occurredAt = alarm?.lastTriggered || new Date();
  const eventTimestamp = new Date(occurredAt).toISOString();
  return createSystemNotification({
    channel: 'securityCritical',
    severity: 'critical',
    category: 'security',
    eventType: 'security.alarm.triggered',
    eventKey: `security-alarm-triggered:${eventTimestamp}`,
    source: 'security-alarm',
    title: 'HomeBrain alarm triggered',
    message: triggeredZoneName === 'manual'
      ? 'The HomeBrain security alarm has gone off.'
      : `The HomeBrain security alarm has gone off: ${triggeredZoneName}.`,
    metadata: {
      alarmState: alarm?.alarmState || 'triggered',
      triggeredZoneName,
      triggeredBy: normalizeString(input.triggeredBy || input.actor || alarm?.armedBy)
    },
    occurredAt,
    ttlSeconds: 10 * 60
  });
}

async function recordSensorBatteryNotifications(sensors = []) {
  if (!Array.isArray(sensors) || sensors.length === 0) return [];
  const results = [];

  for (const sensor of sensors) {
    if (sensor?.batteryState !== 'critical') continue;
    const deviceId = normalizeString(sensor.deviceId || sensor.localDeviceId || sensor.zoneDeviceId);
    if (!deviceId) continue;

    const isSecurityCritical = Boolean(sensor.isMonitored);
    const sensorName = normalizeString(sensor.name) || 'Security sensor';
    const room = normalizeString(sensor.room);
    const messageLocation = room ? `${sensorName} in ${room}` : sensorName;
    const channel = isSecurityCritical ? 'securityCritical' : 'normal';
    const title = isSecurityCritical
      ? 'Security sensor battery dead'
      : 'Device battery dead';
    const message = isSecurityCritical
      ? `${messageLocation} is monitored by the security system and its battery is dead.`
      : `${messageLocation} has a dead battery.`;

    const notifications = await createSystemNotification({
      channel,
      severity: 'critical',
      category: isSecurityCritical ? 'security' : 'device',
      eventType: isSecurityCritical ? 'security.sensor.battery_dead' : 'device.battery_dead',
      eventKey: `battery-dead:${channel}:${deviceId}`,
      source: 'security-sensor-health',
      title,
      message,
      deviceId,
      zoneDeviceId: normalizeString(sensor.zoneDeviceId),
      metadata: {
        sensorType: sensor.sensorType || '',
        sensorTypeLabel: sensor.sensorTypeLabel || '',
        sourceLabel: sensor.sourceLabel || '',
        batteryLevel: sensor.batteryLevel ?? null,
        isMonitored: Boolean(sensor.isMonitored),
        monitoredModes: Array.isArray(sensor.monitoredModes) ? sensor.monitoredModes : []
      },
      collapseId: `battery-dead-${deviceId}`,
      ttlSeconds: 60 * 60
    });
    results.push(...notifications);
  }

  return results;
}

module.exports = {
  createSystemNotification,
  listNotifications,
  getUnreadCounts,
  clearNotification,
  clearNotifications,
  registerPushDevice,
  unregisterPushDevice,
  recordSecurityAlarmTriggered,
  recordSensorBatteryNotifications,
  recordOfflineDeviceNotifications,
  defaultSecurityCriticalPushEnabled,
  getPushStatus: apnsService.getStatus
};

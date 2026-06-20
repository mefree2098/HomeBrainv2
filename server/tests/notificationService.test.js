const test = require('node:test');
const assert = require('node:assert/strict');

const HomeBrainNotification = require('../models/HomeBrainNotification');
const PushSubscription = require('../models/PushSubscription');
const User = require('../models/User');
const Device = require('../models/Device');
const SecurityAlarm = require('../models/SecurityAlarm');
const apnsService = require('../services/apnsService');
const eventStreamService = require('../services/eventStreamService');
const notificationService = require('../services/notificationService');

function makeQueryResult(value) {
  return {
    select() {
      return this;
    },
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    lean: async () => value
  };
}

test('registerPushDevice enables security critical push by default only for iPhone', async (t) => {
  const originalFindOneAndUpdate = PushSubscription.findOneAndUpdate;
  const updates = [];

  PushSubscription.findOneAndUpdate = async (filter, update) => {
    updates.push({ filter, update });
    return {
      _id: `sub-${updates.length}`,
      installationId: filter.installationId,
      platform: 'apns',
      deviceFamily: update.$set.deviceFamily,
      pushEnabled: update.$set.pushEnabled,
      securityCriticalPushEnabled: update.$set.securityCriticalPushEnabled,
      lastRegisteredAt: update.$set.lastRegisteredAt
    };
  };

  t.after(() => {
    PushSubscription.findOneAndUpdate = originalFindOneAndUpdate;
  });

  const phone = await notificationService.registerPushDevice('507f1f77bcf86cd799439011', {
    installationId: 'phone-install',
    deviceToken: 'abc123',
    deviceFamily: 'iPhone'
  });

  const tablet = await notificationService.registerPushDevice('507f1f77bcf86cd799439011', {
    installationId: 'tablet-install',
    deviceToken: 'def456',
    deviceFamily: 'iPad'
  });
  const watch = await notificationService.registerPushDevice('507f1f77bcf86cd799439011', {
    installationId: 'watch-install',
    deviceToken: 'ghi789',
    deviceFamily: 'watchOS'
  });

  assert.equal(phone.securityCriticalPushEnabled, true);
  assert.equal(tablet.securityCriticalPushEnabled, false);
  assert.equal(watch.deviceFamily, 'Watch');
  assert.equal(watch.securityCriticalPushEnabled, false);
  assert.equal(updates[0].update.$set.securityCriticalPushEnabled, true);
  assert.equal(updates[1].update.$set.securityCriticalPushEnabled, false);
  assert.equal(updates[2].update.$set.deviceFamily, 'Watch');
  assert.equal(updates[2].update.$set.securityCriticalPushEnabled, false);
});

test('createSystemNotification sends APNs only for security critical notifications', async (t) => {
  const originalFindOneAndUpdate = HomeBrainNotification.findOneAndUpdate;
  const originalFindByIdAndUpdate = HomeBrainNotification.findByIdAndUpdate;
  const originalFind = PushSubscription.find;
  const originalUpdateOne = PushSubscription.updateOne;
  const originalSendAlertToToken = apnsService.sendAlertToToken;
  const originalPublishSafe = eventStreamService.publishSafe;

  const created = [];
  const sent = [];

  HomeBrainNotification.findOneAndUpdate = async (_filter, update) => {
    const doc = {
      _id: `notification-${created.length + 1}`,
      ...update.$setOnInsert,
      ...update.$set,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    created.push(doc);
    return { value: doc, lastErrorObject: { updatedExisting: false } };
  };
  HomeBrainNotification.findByIdAndUpdate = async (id, update) => {
    const doc = created.find((entry) => entry._id === id);
    return {
      ...doc,
      pushDelivery: update.$set.pushDelivery
    };
  };
  PushSubscription.find = () => makeQueryResult([
    {
      _id: 'sub-phone',
      deviceToken: 'phone-token',
      deviceFamily: 'iPhone',
      bundleId: 'NTechR.HomeBrainApp',
      environment: 'production',
      securityCriticalPushEnabled: true
    },
    {
      _id: 'sub-watch',
      deviceToken: 'watch-token',
      deviceFamily: 'Watch',
      bundleId: 'NTechR.HomeBrainApp.watchkitapp',
      environment: 'development',
      securityCriticalPushEnabled: true
    }
  ]);
  PushSubscription.updateOne = async () => ({ modifiedCount: 0 });
  apnsService.sendAlertToToken = async (token, payload) => {
    sent.push({ token, payload });
    return { success: true, statusCode: 200, apnsId: 'apns-id' };
  };
  eventStreamService.publishSafe = () => {};

  t.after(() => {
    HomeBrainNotification.findOneAndUpdate = originalFindOneAndUpdate;
    HomeBrainNotification.findByIdAndUpdate = originalFindByIdAndUpdate;
    PushSubscription.find = originalFind;
    PushSubscription.updateOne = originalUpdateOne;
    apnsService.sendAlertToToken = originalSendAlertToToken;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  await notificationService.createSystemNotification({
    userIds: ['507f1f77bcf86cd799439011'],
    channel: 'securityCritical',
    severity: 'critical',
    category: 'security',
    eventType: 'security.alarm.triggered',
    eventKey: 'alarm-event-1',
    title: 'Alarm triggered',
    message: 'The alarm has gone off.'
  });

  await notificationService.createSystemNotification({
    userIds: ['507f1f77bcf86cd799439011'],
    channel: 'normal',
    severity: 'critical',
    category: 'device',
    eventType: 'device.battery_dead',
    eventKey: 'battery-event-1',
    title: 'Battery dead',
    message: 'A device battery is dead.'
  });

  assert.equal(created.length, 2);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].token, 'phone-token');
  assert.equal(sent[0].payload.bundleId, 'NTechR.HomeBrainApp');
  assert.equal(sent[0].payload.environment, 'production');
  assert.equal(sent[1].token, 'watch-token');
  assert.equal(sent[1].payload.deviceFamily, 'Watch');
  assert.equal(sent[1].payload.bundleId, 'NTechR.HomeBrainApp.watchkitapp');
  assert.equal(sent[1].payload.environment, 'development');
  assert.equal(sent[0].payload.eventType, 'security.alarm.triggered');
  assert.equal(sent[0].payload.channel, 'securityCritical');
});

test('createSystemNotification does not resend APNs for an existing security event', async (t) => {
  const originalFindOneAndUpdate = HomeBrainNotification.findOneAndUpdate;
  const originalFindByIdAndUpdate = HomeBrainNotification.findByIdAndUpdate;
  const originalFind = PushSubscription.find;
  const originalUpdateOne = PushSubscription.updateOne;
  const originalSendAlertToToken = apnsService.sendAlertToToken;
  const originalPublishSafe = eventStreamService.publishSafe;

  let storedNotification = null;
  const sent = [];

  HomeBrainNotification.findOneAndUpdate = async (_filter, update) => {
    if (storedNotification) {
      storedNotification = {
        ...storedNotification,
        ...update.$set,
        updatedAt: new Date()
      };
      return { value: storedNotification, lastErrorObject: { updatedExisting: true } };
    }

    storedNotification = {
      _id: 'notification-existing-event',
      ...update.$setOnInsert,
      ...update.$set,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    return { value: storedNotification, lastErrorObject: { updatedExisting: false } };
  };
  HomeBrainNotification.findByIdAndUpdate = async (_id, update) => {
    storedNotification = {
      ...storedNotification,
      pushDelivery: update.$set.pushDelivery
    };
    return storedNotification;
  };
  PushSubscription.find = () => makeQueryResult([
    {
      _id: 'sub-phone',
      deviceToken: 'phone-token',
      deviceFamily: 'iPhone',
      securityCriticalPushEnabled: true
    }
  ]);
  PushSubscription.updateOne = async () => ({ modifiedCount: 0 });
  apnsService.sendAlertToToken = async (token, payload) => {
    sent.push({ token, payload });
    return { success: true, statusCode: 200, apnsId: 'apns-id' };
  };
  eventStreamService.publishSafe = () => {};

  t.after(() => {
    HomeBrainNotification.findOneAndUpdate = originalFindOneAndUpdate;
    HomeBrainNotification.findByIdAndUpdate = originalFindByIdAndUpdate;
    PushSubscription.find = originalFind;
    PushSubscription.updateOne = originalUpdateOne;
    apnsService.sendAlertToToken = originalSendAlertToToken;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  const input = {
    userIds: ['507f1f77bcf86cd799439011'],
    channel: 'securityCritical',
    severity: 'critical',
    category: 'security',
    eventType: 'security.device.offline',
    eventKey: 'device-offline:securityCritical:hall-siren',
    title: 'Hall Siren offline',
    message: 'Hall Siren is offline.'
  };

  await notificationService.createSystemNotification(input);
  await notificationService.createSystemNotification(input);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.eventKey, input.eventKey);
});

test('createSystemNotification serializes same-key upserts to avoid duplicate active notifications', async (t) => {
  const originalFindOneAndUpdate = HomeBrainNotification.findOneAndUpdate;
  const originalPublishSafe = eventStreamService.publishSafe;

  let storedNotification = null;
  let createCount = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const publishedEvents = [];

  HomeBrainNotification.findOneAndUpdate = async (_filter, update) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const existingAtEntry = storedNotification;
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;

    if (existingAtEntry) {
      storedNotification = {
        ...storedNotification,
        ...update.$set,
        updatedAt: new Date()
      };
      return { value: storedNotification, lastErrorObject: { updatedExisting: true } };
    }

    createCount += 1;
    storedNotification = {
      _id: `notification-${createCount}`,
      ...update.$setOnInsert,
      ...update.$set,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    return { value: storedNotification, lastErrorObject: { updatedExisting: false } };
  };
  eventStreamService.publishSafe = (event) => {
    publishedEvents.push(event);
  };

  t.after(() => {
    HomeBrainNotification.findOneAndUpdate = originalFindOneAndUpdate;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  const input = {
    userIds: ['507f1f77bcf86cd799439011'],
    channel: 'normal',
    severity: 'warning',
    category: 'device',
    eventType: 'device.offline',
    eventKey: 'device-offline:normal:irrigation-zone-12',
    source: 'device-health',
    title: 'Device offline',
    message: 'Zone 12 is offline.'
  };

  await Promise.all([
    notificationService.createSystemNotification(input),
    notificationService.createSystemNotification(input)
  ]);

  assert.equal(maxInFlight, 1);
  assert.equal(createCount, 1);
  assert.equal(publishedEvents.length, 1);
  assert.equal(publishedEvents[0].type, 'notification.created');
  assert.equal(storedNotification.eventKey, input.eventKey);
});

test('clearNotifications rejects invalid channels without clearing notifications', async (t) => {
  const originalUpdateMany = HomeBrainNotification.updateMany;
  const originalPublishSafe = eventStreamService.publishSafe;
  let updateManyCalled = false;
  let publishCalled = false;

  HomeBrainNotification.updateMany = async () => {
    updateManyCalled = true;
    return { modifiedCount: 10 };
  };
  eventStreamService.publishSafe = () => {
    publishCalled = true;
  };

  t.after(() => {
    HomeBrainNotification.updateMany = originalUpdateMany;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  await assert.rejects(
    () => notificationService.clearNotifications('507f1f77bcf86cd799439011', { channel: '__bogus__' }),
    (error) => error.message === 'Invalid notification channel.' && error.status === 400
  );
  assert.equal(updateManyCalled, false);
  assert.equal(publishCalled, false);
});

test('clearNotifications excludes resolved notifications unless history is included', async (t) => {
  const originalUpdateMany = HomeBrainNotification.updateMany;
  const originalPublishSafe = eventStreamService.publishSafe;
  const calls = [];

  HomeBrainNotification.updateMany = async (filter, update) => {
    calls.push({ filter, update });
    return { modifiedCount: calls.length };
  };
  eventStreamService.publishSafe = () => {};

  t.after(() => {
    HomeBrainNotification.updateMany = originalUpdateMany;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  await notificationService.clearNotifications('507f1f77bcf86cd799439011', { channel: 'normal' });
  await notificationService.clearNotifications('507f1f77bcf86cd799439011', {
    channel: 'normal',
    includeHistory: true
  });

  assert.equal(calls[0].filter.channel, 'normal');
  assert.equal(calls[0].filter.clearedAt, null);
  assert.equal(calls[0].filter.resolvedAt, null);
  assert.equal(calls[1].filter.channel, 'normal');
  assert.equal(calls[1].filter.clearedAt, null);
  assert.equal(Object.hasOwn(calls[1].filter, 'resolvedAt'), false);
});

test('clearNotification can clear resolved history entries', async (t) => {
  const originalFindOneAndUpdate = HomeBrainNotification.findOneAndUpdate;
  const originalFindOne = HomeBrainNotification.findOne;
  const originalPublishSafe = eventStreamService.publishSafe;
  let capturedFilter = null;
  const publishedEvents = [];

  HomeBrainNotification.findOneAndUpdate = async (filter, update) => {
    capturedFilter = filter;
    return {
      _id: filter._id,
      userId: filter.userId,
      channel: 'normal',
      severity: 'warning',
      category: 'device',
      title: 'Device offline',
      message: 'A device is offline.',
      resolvedAt: new Date('2026-06-10T12:00:00.000Z'),
      clearedAt: update.$set.clearedAt,
      createdAt: new Date('2026-06-10T12:00:00.000Z'),
      updatedAt: new Date('2026-06-10T12:00:00.000Z')
    };
  };
  HomeBrainNotification.findOne = () => {
    throw new Error('findOne should not be called when update succeeds');
  };
  eventStreamService.publishSafe = (event) => {
    publishedEvents.push(event);
  };

  t.after(() => {
    HomeBrainNotification.findOneAndUpdate = originalFindOneAndUpdate;
    HomeBrainNotification.findOne = originalFindOne;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  const result = await notificationService.clearNotification('507f1f77bcf86cd799439011', 'notification-1');

  assert.equal(capturedFilter._id, 'notification-1');
  assert.equal(capturedFilter.clearedAt, null);
  assert.equal(Object.hasOwn(capturedFilter, 'resolvedAt'), false);
  assert.equal(result.id, 'notification-1');
  assert.ok(result.clearedAt);
  assert.equal(publishedEvents[0].type, 'notification.cleared');
});

test('clearNotification is idempotent for already-cleared notifications', async (t) => {
  const originalFindOneAndUpdate = HomeBrainNotification.findOneAndUpdate;
  const originalFindOne = HomeBrainNotification.findOne;
  const originalPublishSafe = eventStreamService.publishSafe;
  let findOneFilter = null;
  let publishCalled = false;
  const clearedAt = new Date('2026-06-10T12:00:00.000Z');

  HomeBrainNotification.findOneAndUpdate = async () => null;
  HomeBrainNotification.findOne = (filter) => {
    findOneFilter = filter;
    return {
      lean: async () => ({
        _id: filter._id,
        userId: filter.userId,
        channel: 'normal',
        severity: 'warning',
        category: 'device',
        title: 'Device offline',
        message: 'A device is offline.',
        clearedAt,
        createdAt: clearedAt,
        updatedAt: clearedAt
      })
    };
  };
  eventStreamService.publishSafe = () => {
    publishCalled = true;
  };

  t.after(() => {
    HomeBrainNotification.findOneAndUpdate = originalFindOneAndUpdate;
    HomeBrainNotification.findOne = originalFindOne;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  const result = await notificationService.clearNotification('507f1f77bcf86cd799439011', 'notification-1');

  assert.deepEqual(findOneFilter, {
    _id: 'notification-1',
    userId: '507f1f77bcf86cd799439011'
  });
  assert.equal(result.id, 'notification-1');
  assert.equal(result.clearedAt, clearedAt);
  assert.equal(publishCalled, false);
});

test('recordSensorBatteryNotifications separates monitored security battery deaths from normal items', async (t) => {
  const originalUserFind = User.find;
  const originalFindOneAndUpdate = HomeBrainNotification.findOneAndUpdate;
  const originalFindByIdAndUpdate = HomeBrainNotification.findByIdAndUpdate;
  const originalUpdateMany = HomeBrainNotification.updateMany;
  const originalPushFind = PushSubscription.find;
  const originalPublishSafe = eventStreamService.publishSafe;

  const created = [];
  User.find = () => makeQueryResult([{ _id: '507f1f77bcf86cd799439011' }]);
  HomeBrainNotification.findOneAndUpdate = async (_filter, update) => {
    const doc = {
      _id: `notification-${created.length + 1}`,
      ...update.$setOnInsert,
      ...update.$set,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    created.push(doc);
    return { value: doc, lastErrorObject: { updatedExisting: false } };
  };
  HomeBrainNotification.findByIdAndUpdate = async (id, update) => ({
    ...created.find((entry) => entry._id === id),
    pushDelivery: update.$set.pushDelivery
  });
  HomeBrainNotification.updateMany = async () => ({ modifiedCount: 0 });
  PushSubscription.find = () => makeQueryResult([]);
  eventStreamService.publishSafe = () => {};

  t.after(() => {
    User.find = originalUserFind;
    HomeBrainNotification.findOneAndUpdate = originalFindOneAndUpdate;
    HomeBrainNotification.findByIdAndUpdate = originalFindByIdAndUpdate;
    HomeBrainNotification.updateMany = originalUpdateMany;
    PushSubscription.find = originalPushFind;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  await notificationService.recordSensorBatteryNotifications([
    {
      deviceId: 'front-door',
      name: 'Front Door',
      room: 'Entry',
      batteryState: 'critical',
      batteryLevel: 0,
      isMonitored: true,
      monitoredModes: ['armedStay', 'armedAway']
    },
    {
      deviceId: 'basement-leak',
      name: 'Basement Leak',
      room: 'Basement',
      batteryState: 'critical',
      batteryLevel: 0,
      isMonitored: false
    },
    {
      deviceId: 'hall-motion',
      name: 'Hall Motion',
      batteryState: 'low',
      batteryLevel: 12,
      isMonitored: true
    }
  ]);

  assert.equal(created.length, 2);
  assert.deepEqual(created.map((entry) => entry.channel), ['securityCritical', 'normal']);
  assert.equal(created[0].eventType, 'security.sensor.battery_dead');
  assert.equal(created[1].eventType, 'device.battery_dead');
});

test('recordOfflineDeviceNotifications marks configured security devices as security critical', async (t) => {
  const originalUserFind = User.find;
  const originalAlarmGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalFindOneAndUpdate = HomeBrainNotification.findOneAndUpdate;
  const originalFindByIdAndUpdate = HomeBrainNotification.findByIdAndUpdate;
  const originalUpdateMany = HomeBrainNotification.updateMany;
  const originalPushFind = PushSubscription.find;
  const originalPublishSafe = eventStreamService.publishSafe;

  const created = [];
  User.find = () => makeQueryResult([{ _id: '507f1f77bcf86cd799439011' }]);
  SecurityAlarm.getMainAlarm = async () => ({
    zones: [{ deviceId: 'front-door', enabled: true }],
    sirenOutputs: [{ deviceId: 'hall-siren', enabled: true }]
  });
  Device.find = () => ({
    select() {
      return this;
    },
    lean: async () => ([
      {
        _id: 'front-door',
        name: 'Front Door',
        type: 'sensor',
        room: 'Entry',
        isOnline: false,
        properties: {}
      },
      {
        _id: 'hall-siren',
        name: 'Hall Siren',
        type: 'siren',
        room: 'Hall',
        isOnline: false,
        properties: {}
      },
      {
        _id: 'desk-lamp',
        name: 'Desk Lamp',
        type: 'light',
        room: 'Office',
        isOnline: false,
        properties: {}
      }
    ])
  });
  HomeBrainNotification.findOneAndUpdate = async (_filter, update) => {
    const doc = {
      _id: `notification-${created.length + 1}`,
      ...update.$setOnInsert,
      ...update.$set,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    created.push(doc);
    return { value: doc, lastErrorObject: { updatedExisting: false } };
  };
  HomeBrainNotification.findByIdAndUpdate = async (id, update) => ({
    ...created.find((entry) => entry._id === id),
    pushDelivery: update.$set.pushDelivery
  });
  HomeBrainNotification.updateMany = async () => ({ modifiedCount: 0 });
  PushSubscription.find = () => makeQueryResult([]);
  eventStreamService.publishSafe = () => {};

  t.after(() => {
    User.find = originalUserFind;
    SecurityAlarm.getMainAlarm = originalAlarmGetMainAlarm;
    Device.find = originalDeviceFind;
    HomeBrainNotification.findOneAndUpdate = originalFindOneAndUpdate;
    HomeBrainNotification.findByIdAndUpdate = originalFindByIdAndUpdate;
    HomeBrainNotification.updateMany = originalUpdateMany;
    PushSubscription.find = originalPushFind;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  await notificationService.recordOfflineDeviceNotifications();

  assert.equal(created.length, 3);
  assert.deepEqual(created.map((entry) => entry.channel), ['securityCritical', 'securityCritical', 'normal']);
  assert.deepEqual(created.map((entry) => entry.eventType), [
    'security.device.offline',
    'security.device.offline',
    'device.offline'
  ]);
});

test('recordOfflineDeviceNotifications resolves stale offline notifications when devices come online', async (t) => {
  const originalUserFind = User.find;
  const originalAlarmGetMainAlarm = SecurityAlarm.getMainAlarm;
  const originalDeviceFind = Device.find;
  const originalFindOneAndUpdate = HomeBrainNotification.findOneAndUpdate;
  const originalFindByIdAndUpdate = HomeBrainNotification.findByIdAndUpdate;
  const originalUpdateMany = HomeBrainNotification.updateMany;
  const originalPushFind = PushSubscription.find;
  const originalPublishSafe = eventStreamService.publishSafe;

  const created = [];
  const updateManyCalls = [];
  const publishedEvents = [];

  User.find = () => makeQueryResult([{ _id: '507f1f77bcf86cd799439011' }]);
  SecurityAlarm.getMainAlarm = async () => ({ zones: [], sirenOutputs: [] });
  Device.find = () => ({
    select() {
      return this;
    },
    lean: async () => ([
      {
        _id: 'front-door',
        name: 'Front Door',
        type: 'lock',
        room: 'Entry',
        isOnline: false,
        properties: {}
      }
    ])
  });
  HomeBrainNotification.updateMany = async (filter, update) => {
    updateManyCalls.push({ filter, update });
    return { modifiedCount: 2 };
  };
  HomeBrainNotification.findOneAndUpdate = async (_filter, update) => {
    const doc = {
      _id: `notification-${created.length + 1}`,
      ...update.$setOnInsert,
      ...update.$set,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    created.push(doc);
    return { value: doc, lastErrorObject: { updatedExisting: false } };
  };
  HomeBrainNotification.findByIdAndUpdate = async (id, update) => ({
    ...created.find((entry) => entry._id === id),
    pushDelivery: update.$set.pushDelivery
  });
  PushSubscription.find = () => makeQueryResult([]);
  eventStreamService.publishSafe = (event) => {
    publishedEvents.push(event);
  };

  t.after(() => {
    User.find = originalUserFind;
    SecurityAlarm.getMainAlarm = originalAlarmGetMainAlarm;
    Device.find = originalDeviceFind;
    HomeBrainNotification.findOneAndUpdate = originalFindOneAndUpdate;
    HomeBrainNotification.findByIdAndUpdate = originalFindByIdAndUpdate;
    HomeBrainNotification.updateMany = originalUpdateMany;
    PushSubscription.find = originalPushFind;
    eventStreamService.publishSafe = originalPublishSafe;
  });

  await notificationService.recordOfflineDeviceNotifications();

  assert.equal(updateManyCalls.length, 1);
  assert.deepEqual(updateManyCalls[0].filter.eventType.$in, ['device.offline', 'security.device.offline']);
  assert.equal(updateManyCalls[0].filter.clearedAt, null);
  assert.equal(updateManyCalls[0].filter.resolvedAt, null);
  assert.deepEqual(updateManyCalls[0].filter.deviceId.$nin, ['front-door']);
  assert.equal(updateManyCalls[0].update.$set.resolvedReason, 'device_online');
  assert.equal(created.length, 1);
  assert.equal(created[0].deviceId, 'front-door');

  const resolvedEvent = publishedEvents.find((event) => event.type === 'notifications.resolved');
  assert.equal(resolvedEvent.payload.resolvedCount, 2);
  assert.equal(resolvedEvent.payload.reason, 'device_online');
});

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

  assert.equal(phone.securityCriticalPushEnabled, true);
  assert.equal(tablet.securityCriticalPushEnabled, false);
  assert.equal(updates[0].update.$set.securityCriticalPushEnabled, true);
  assert.equal(updates[1].update.$set.securityCriticalPushEnabled, false);
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
      metadata: update.$set.metadata,
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
  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, 'phone-token');
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
        metadata: update.$set.metadata,
        updatedAt: new Date()
      };
      return { value: storedNotification, lastErrorObject: { updatedExisting: true } };
    }

    storedNotification = {
      _id: 'notification-existing-event',
      ...update.$setOnInsert,
      metadata: update.$set.metadata,
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

test('recordSensorBatteryNotifications separates monitored security battery deaths from normal items', async (t) => {
  const originalUserFind = User.find;
  const originalFindOneAndUpdate = HomeBrainNotification.findOneAndUpdate;
  const originalFindByIdAndUpdate = HomeBrainNotification.findByIdAndUpdate;
  const originalPushFind = PushSubscription.find;
  const originalPublishSafe = eventStreamService.publishSafe;

  const created = [];
  User.find = () => makeQueryResult([{ _id: '507f1f77bcf86cd799439011' }]);
  HomeBrainNotification.findOneAndUpdate = async (_filter, update) => {
    const doc = {
      _id: `notification-${created.length + 1}`,
      ...update.$setOnInsert,
      metadata: update.$set.metadata,
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
  eventStreamService.publishSafe = () => {};

  t.after(() => {
    User.find = originalUserFind;
    HomeBrainNotification.findOneAndUpdate = originalFindOneAndUpdate;
    HomeBrainNotification.findByIdAndUpdate = originalFindByIdAndUpdate;
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
      metadata: update.$set.metadata,
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
  eventStreamService.publishSafe = () => {};

  t.after(() => {
    User.find = originalUserFind;
    SecurityAlarm.getMainAlarm = originalAlarmGetMainAlarm;
    Device.find = originalDeviceFind;
    HomeBrainNotification.findOneAndUpdate = originalFindOneAndUpdate;
    HomeBrainNotification.findByIdAndUpdate = originalFindByIdAndUpdate;
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

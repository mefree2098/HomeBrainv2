const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const RemoteHomeBrainPeer = require('../models/RemoteHomeBrainPeer');
const notificationService = require('../services/notificationService');
const remoteHomeBrainNotificationService = require('../services/remoteHomeBrainNotificationService');

function peerDocument(source) {
  return {
    ...source,
    toObject() {
      return { ...source };
    }
  };
}

test('createInboundRemote returns a one-time token and stores only its hash', async (t) => {
  const originalCreate = RemoteHomeBrainPeer.create;
  let createdPayload = null;

  RemoteHomeBrainPeer.create = async (payload) => {
    createdPayload = payload;
    return peerDocument({ _id: 'remote-1', ...payload, createdAt: new Date(), updatedAt: new Date() });
  };

  t.after(() => {
    RemoteHomeBrainPeer.create = originalCreate;
  });

  const result = await remoteHomeBrainNotificationService.createInboundRemote({
    name: 'Selene apartment'
  });

  assert.equal(result.remote.name, 'Selene apartment');
  assert.equal(result.remote.direction, 'inbound');
  assert.match(result.token, /^hbri_/);
  assert.equal(createdPayload.tokenHash, remoteHomeBrainNotificationService.hashToken(result.token));
  assert.equal(createdPayload.tokenPreview, result.remote.tokenPreview);
  assert.equal(Object.prototype.hasOwnProperty.call(result.remote, 'tokenHash'), false);
});

test('authenticateInboundRequest accepts only enabled inbound bearer tokens', async (t) => {
  const originalFindOne = RemoteHomeBrainPeer.findOne;
  const token = remoteHomeBrainNotificationService.generateToken();
  const expectedHash = remoteHomeBrainNotificationService.hashToken(token);
  const peer = peerDocument({
    _id: 'remote-2',
    direction: 'inbound',
    name: 'Selene apartment',
    enabled: true,
    tokenHash: expectedHash
  });

  RemoteHomeBrainPeer.findOne = (query) => ({
    select: async () => (
      query.direction === 'inbound'
      && query.enabled === true
      && query.tokenHash === expectedHash
        ? peer
        : null
    )
  });

  t.after(() => {
    RemoteHomeBrainPeer.findOne = originalFindOne;
  });

  const accepted = await remoteHomeBrainNotificationService.authenticateInboundRequest({
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(accepted.name, 'Selene apartment');

  await assert.rejects(
    () => remoteHomeBrainNotificationService.authenticateInboundRequest({
      headers: { authorization: 'Bearer wrong-token' }
    }),
    /not authorized/
  );
});

test('receiveSecurityAlert records a local critical notification with remote wording', async (t) => {
  const originalCreateSystemNotification = notificationService.createSystemNotification;
  const originalFindByIdAndUpdate = RemoteHomeBrainPeer.findByIdAndUpdate;
  let recordedInput = null;

  notificationService.createSystemNotification = async (input) => {
    recordedInput = input;
    return [{ id: 'notification-1', title: input.title }];
  };
  RemoteHomeBrainPeer.findByIdAndUpdate = async (_id, update) => peerDocument({
    _id,
    direction: 'inbound',
    name: 'Selene apartment',
    enabled: true,
    ...update.$set
  });

  t.after(() => {
    notificationService.createSystemNotification = originalCreateSystemNotification;
    RemoteHomeBrainPeer.findByIdAndUpdate = originalFindByIdAndUpdate;
  });

  const result = await remoteHomeBrainNotificationService.receiveSecurityAlert(
    peerDocument({ _id: 'remote-3', name: 'Selene apartment' }),
    {
      eventType: 'security.alarm.triggered',
      eventId: 'alarm-123',
      title: 'HomeBrain alarm triggered',
      message: 'Front door opened while armed.',
      sourceInstanceName: 'Selene HomeBrain'
    }
  );

  assert.equal(result.notifications.length, 1);
  assert.equal(recordedInput.channel, 'securityCritical');
  assert.equal(recordedInput.severity, 'critical');
  assert.equal(recordedInput.category, 'security');
  assert.equal(recordedInput.source, 'remote-homebrain');
  assert.equal(recordedInput.title, 'Alarm triggered at Selene apartment');
  assert.equal(recordedInput.message, 'Front door opened while armed.');
  assert.equal(recordedInput.eventKey, 'remote-homebrain:remote-3:alarm-123');
  assert.equal(recordedInput.skipRemoteForwarding, true);
});

test('forwardSecurityCriticalNotification does not re-forward inbound remote alerts', async () => {
  const result = await remoteHomeBrainNotificationService.forwardSecurityCriticalNotification({
    id: 'notification-2',
    channel: 'securityCritical',
    source: 'remote-homebrain',
    title: 'Alarm triggered at Selene apartment'
  });

  assert.deepEqual(result, []);
});

test('testOutboundTarget sends a token-authenticated handshake', async (t) => {
  const originalFindOne = RemoteHomeBrainPeer.findOne;
  const originalFindById = RemoteHomeBrainPeer.findById;
  const originalUpdateOne = RemoteHomeBrainPeer.updateOne;
  const originalPost = axios.post;
  const target = {
    _id: 'target-1',
    direction: 'outbound',
    name: 'Freestone family',
    enabled: true,
    remoteUrl: 'https://freestonefamily.com',
    outboundToken: 'hbri_target_token',
    tokenPreview: '...token'
  };
  let postCall = null;
  let deliveryUpdate = null;

  RemoteHomeBrainPeer.findOne = () => ({
    select: async () => target
  });
  RemoteHomeBrainPeer.findById = () => ({
    select: async () => target
  });
  RemoteHomeBrainPeer.updateOne = async (_filter, update) => {
    deliveryUpdate = update;
    return { modifiedCount: 1 };
  };
  axios.post = async (url, body, config) => {
    postCall = { url, body, config };
    return { data: { success: true, message: 'Connected to Dad HomeBrain' } };
  };

  t.after(() => {
    RemoteHomeBrainPeer.findOne = originalFindOne;
    RemoteHomeBrainPeer.findById = originalFindById;
    RemoteHomeBrainPeer.updateOne = originalUpdateOne;
    axios.post = originalPost;
  });

  const result = await remoteHomeBrainNotificationService.testOutboundTarget('target-1');

  assert.equal(result.success, true);
  assert.equal(postCall.url, 'https://freestonefamily.com/api/notifications/remote-homebrains/handshake');
  assert.equal(postCall.config.headers.Authorization, 'Bearer hbri_target_token');
  assert.equal(deliveryUpdate.$set.lastDeliveryStatus, 'ok');
});

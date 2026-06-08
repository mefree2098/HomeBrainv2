const crypto = require('crypto');
const axios = require('axios');
const RemoteHomeBrainPeer = require('../models/RemoteHomeBrainPeer');

const TOKEN_PREFIX = 'hbri_';
const REQUEST_TIMEOUT_MS = Math.max(2000, Number(process.env.HOMEBRAIN_REMOTE_NOTIFICATION_TIMEOUT_MS || 8000));
const MAX_MESSAGE_LENGTH = 1200;

function normalizeString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeBool(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeString(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function truncate(value, length) {
  const normalized = normalizeString(value);
  if (!normalized) return '';
  return normalized.length > length ? `${normalized.slice(0, length - 3)}...` : normalized;
}

function normalizeUrl(value) {
  const raw = normalizeString(value);
  if (!raw) {
    const error = new Error('Remote HomeBrain URL is required');
    error.status = 400;
    throw error;
  }

  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    const error = new Error('Remote HomeBrain URL must be a valid URL');
    error.status = 400;
    throw error;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    const error = new Error('Remote HomeBrain URL must use http or https');
    error.status = 400;
    throw error;
  }

  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function generateToken() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

function tokenPreview(token) {
  const normalized = normalizeString(token);
  return normalized ? `...${normalized.slice(-6)}` : '';
}

function extractBearerToken(req) {
  const authorizationHeader = normalizeString(req.headers?.authorization);
  const [scheme, token] = authorizationHeader.split(/\s+/, 2);
  return scheme?.toLowerCase() === 'bearer' ? normalizeString(token) : '';
}

function toPublicPeer(peer) {
  if (!peer) return null;
  const source = typeof peer.toObject === 'function' ? peer.toObject() : peer;
  return {
    id: source._id?.toString?.() || source.id,
    direction: source.direction,
    name: source.name,
    enabled: source.enabled !== false,
    remoteUrl: source.remoteUrl || '',
    tokenPreview: source.tokenPreview || '',
    hasToken: Boolean(source.tokenPreview || source.outboundToken),
    sourceInstanceName: source.sourceInstanceName || '',
    sourceInstanceUrl: source.sourceInstanceUrl || '',
    lastHandshakeAt: source.lastHandshakeAt || null,
    lastReceivedAt: source.lastReceivedAt || null,
    lastForwardedAt: source.lastForwardedAt || null,
    lastDeliveryAt: source.lastDeliveryAt || null,
    lastDeliveryStatus: source.lastDeliveryStatus || 'never',
    lastDeliveryMessage: source.lastDeliveryMessage || '',
    lastAlertEventType: source.lastAlertEventType || '',
    lastAlertTitle: source.lastAlertTitle || '',
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null
  };
}

function requireName(payload) {
  const name = truncate(payload?.name, 120);
  if (!name) {
    const error = new Error('Remote HomeBrain name is required');
    error.status = 400;
    throw error;
  }
  return name;
}

async function listRemoteHomeBrains() {
  const peers = await RemoteHomeBrainPeer.find({})
    .select('+outboundToken')
    .sort({ direction: 1, name: 1 })
    .lean();

  return {
    inboundRemotes: peers.filter((peer) => peer.direction === 'inbound').map(toPublicPeer),
    outboundTargets: peers.filter((peer) => peer.direction === 'outbound').map(toPublicPeer)
  };
}

async function createInboundRemote(payload = {}) {
  const token = generateToken();
  const peer = await RemoteHomeBrainPeer.create({
    direction: 'inbound',
    name: requireName(payload),
    enabled: normalizeBool(payload.enabled, true),
    tokenHash: hashToken(token),
    tokenPreview: tokenPreview(token)
  });

  return {
    remote: toPublicPeer(peer),
    token
  };
}

async function updateInboundRemote(remoteId, payload = {}) {
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(payload, 'name')) updates.name = requireName(payload);
  if (Object.prototype.hasOwnProperty.call(payload, 'enabled')) updates.enabled = normalizeBool(payload.enabled, true);

  const peer = await RemoteHomeBrainPeer.findOneAndUpdate(
    { _id: remoteId, direction: 'inbound' },
    { $set: updates },
    { new: true }
  );

  if (!peer) {
    const error = new Error('Remote HomeBrain was not found');
    error.status = 404;
    throw error;
  }

  return toPublicPeer(peer);
}

async function rotateInboundToken(remoteId) {
  const token = generateToken();
  const peer = await RemoteHomeBrainPeer.findOneAndUpdate(
    { _id: remoteId, direction: 'inbound' },
    {
      $set: {
        tokenHash: hashToken(token),
        tokenPreview: tokenPreview(token),
        lastHandshakeAt: null,
        lastDeliveryMessage: 'Token rotated'
      }
    },
    { new: true }
  );

  if (!peer) {
    const error = new Error('Remote HomeBrain was not found');
    error.status = 404;
    throw error;
  }

  return {
    remote: toPublicPeer(peer),
    token
  };
}

async function deleteInboundRemote(remoteId) {
  const result = await RemoteHomeBrainPeer.deleteOne({ _id: remoteId, direction: 'inbound' });
  return { deletedCount: result.deletedCount || 0 };
}

async function createOutboundTarget(payload = {}) {
  const token = normalizeString(payload.token);
  if (!token) {
    const error = new Error('Remote HomeBrain token is required');
    error.status = 400;
    throw error;
  }

  const peer = await RemoteHomeBrainPeer.create({
    direction: 'outbound',
    name: requireName(payload),
    enabled: normalizeBool(payload.enabled, true),
    remoteUrl: normalizeUrl(payload.remoteUrl),
    outboundToken: token,
    tokenPreview: tokenPreview(token)
  });

  return toPublicPeer(peer);
}

async function updateOutboundTarget(targetId, payload = {}) {
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(payload, 'name')) updates.name = requireName(payload);
  if (Object.prototype.hasOwnProperty.call(payload, 'enabled')) updates.enabled = normalizeBool(payload.enabled, true);
  if (Object.prototype.hasOwnProperty.call(payload, 'remoteUrl')) updates.remoteUrl = normalizeUrl(payload.remoteUrl);
  if (Object.prototype.hasOwnProperty.call(payload, 'token') && normalizeString(payload.token)) {
    updates.outboundToken = normalizeString(payload.token);
    updates.tokenPreview = tokenPreview(payload.token);
  }

  const peer = await RemoteHomeBrainPeer.findOneAndUpdate(
    { _id: targetId, direction: 'outbound' },
    { $set: updates },
    { new: true }
  ).select('+outboundToken');

  if (!peer) {
    const error = new Error('Remote HomeBrain target was not found');
    error.status = 404;
    throw error;
  }

  return toPublicPeer(peer);
}

async function deleteOutboundTarget(targetId) {
  const result = await RemoteHomeBrainPeer.deleteOne({ _id: targetId, direction: 'outbound' });
  return { deletedCount: result.deletedCount || 0 };
}

async function authenticateInboundRequest(req) {
  const token = extractBearerToken(req);
  if (!token) {
    const error = new Error('Remote HomeBrain token is required');
    error.status = 401;
    throw error;
  }

  const peer = await RemoteHomeBrainPeer.findOne({
    direction: 'inbound',
    enabled: true,
    tokenHash: hashToken(token)
  }).select('+tokenHash');

  if (!peer) {
    const error = new Error('Remote HomeBrain token is not authorized');
    error.status = 401;
    throw error;
  }

  return peer;
}

function getLocalInstanceName() {
  return normalizeString(
    process.env.HOMEBRAIN_INSTANCE_NAME
      || process.env.HOMEBRAIN_SITE_NAME
      || process.env.HOMEBRAIN_HOME_NAME,
    'HomeBrain'
  );
}

function getLocalInstanceUrl() {
  return normalizeString(
    process.env.HOMEBRAIN_PUBLIC_URL
      || process.env.PUBLIC_URL
      || process.env.APP_URL,
    ''
  );
}

async function recordInboundHandshake(peer, payload = {}) {
  const sourceInstanceName = truncate(payload.sourceInstanceName || payload.instanceName, 160);
  const sourceInstanceUrl = payload.sourceInstanceUrl || payload.instanceUrl
    ? normalizeString(payload.sourceInstanceUrl || payload.instanceUrl)
    : '';

  const updates = {
    lastHandshakeAt: new Date(),
    lastDeliveryStatus: 'ok',
    lastDeliveryMessage: sourceInstanceName
      ? `Connected to ${sourceInstanceName}`
      : 'Remote HomeBrain connection verified'
  };

  if (sourceInstanceName) updates.sourceInstanceName = sourceInstanceName;
  if (sourceInstanceUrl) updates.sourceInstanceUrl = truncate(sourceInstanceUrl, 500);

  const updated = await RemoteHomeBrainPeer.findByIdAndUpdate(peer._id, { $set: updates }, { new: true });
  return toPublicPeer(updated || peer);
}

function remoteEventKey(peer, payload, occurredAt) {
  const eventId = normalizeString(payload.eventId || payload.eventKey || payload.sourceNotificationId || payload.id);
  if (eventId) return `remote-homebrain:${peer._id}:${eventId}`;
  const eventType = normalizeString(payload.eventType, 'security.remote.alert');
  return `remote-homebrain:${peer._id}:${eventType}:${occurredAt.toISOString()}`;
}

function composeRemoteAlert(peer, payload = {}) {
  const remoteName = normalizeString(peer.name, 'Remote HomeBrain');
  const eventType = normalizeString(payload.eventType, 'security.remote.alert');
  const originalTitle = truncate(payload.title, 160);
  const originalMessage = truncate(payload.message, MAX_MESSAGE_LENGTH);
  const occurredAt = payload.occurredAt ? new Date(payload.occurredAt) : new Date();
  const safeOccurredAt = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;

  if (eventType === 'security.alarm.triggered') {
    return {
      eventType,
      occurredAt: safeOccurredAt,
      title: `Alarm triggered at ${remoteName}`,
      message: originalMessage || `The security alarm at ${remoteName} has been triggered.`
    };
  }

  return {
    eventType,
    occurredAt: safeOccurredAt,
    title: originalTitle ? `${remoteName}: ${originalTitle}` : `Security alert from ${remoteName}`,
    message: originalMessage || `A security-critical alert was reported by ${remoteName}.`
  };
}

async function receiveSecurityAlert(peer, payload = {}) {
  const notificationService = require('./notificationService');
  const alert = composeRemoteAlert(peer, payload);
  const sourceInstanceName = truncate(payload.sourceInstanceName || payload.instanceName, 160);
  const sourceInstanceUrl = truncate(payload.sourceInstanceUrl || payload.instanceUrl, 500);

  const notifications = await notificationService.createSystemNotification({
    channel: 'securityCritical',
    severity: 'critical',
    category: 'security',
    eventType: `remote.${alert.eventType}`,
    eventKey: remoteEventKey(peer, payload, alert.occurredAt),
    source: 'remote-homebrain',
    title: alert.title,
    message: alert.message,
    occurredAt: alert.occurredAt,
    metadata: {
      remoteHomeBrain: {
        inboundRemoteId: peer._id?.toString?.() || String(peer._id),
        name: peer.name,
        sourceInstanceName,
        sourceInstanceUrl,
        eventType: alert.eventType,
        eventId: normalizeString(payload.eventId || payload.eventKey || payload.sourceNotificationId || payload.id)
      }
    },
    skipRemoteForwarding: true
  });

  const updates = {
    lastReceivedAt: new Date(),
    lastAlertEventType: alert.eventType,
    lastAlertTitle: alert.title,
    lastDeliveryStatus: 'ok',
    lastDeliveryMessage: 'Security alert received'
  };
  if (sourceInstanceName) updates.sourceInstanceName = sourceInstanceName;
  if (sourceInstanceUrl) updates.sourceInstanceUrl = sourceInstanceUrl;

  const updated = await RemoteHomeBrainPeer.findByIdAndUpdate(peer._id, { $set: updates }, { new: true });

  return {
    remote: toPublicPeer(updated || peer),
    notifications
  };
}

function shouldForwardNotification(notification, input = {}) {
  if (!notification || notification.channel !== 'securityCritical') return false;
  if (input.skipRemoteForwarding === true) return false;
  if (notification.source === 'remote-homebrain' || input.source === 'remote-homebrain') return false;
  if (input.metadata?.remoteHomeBrain) return false;
  return true;
}

function notificationPayload(notification, input = {}) {
  const eventType = normalizeString(notification.eventType || input.eventType, 'security.remote.alert');
  return {
    eventType,
    eventId: normalizeString(notification.eventKey || input.eventKey || notification.id || notification._id),
    sourceNotificationId: normalizeString(notification.id || notification._id),
    sourceInstanceName: getLocalInstanceName(),
    sourceInstanceUrl: getLocalInstanceUrl(),
    title: notification.title || input.title || 'Security alert',
    message: notification.message || input.message || notification.title || 'Security alert',
    occurredAt: notification.occurredAt || input.occurredAt || new Date().toISOString(),
    severity: 'critical',
    category: 'security'
  };
}

async function postToRemote(target, path, body) {
  const url = `${target.remoteUrl}${path}`;
  return axios.post(url, body, {
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${target.outboundToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'HomeBrain-RemoteNotifications/1.0'
    },
    validateStatus: (status) => status >= 200 && status < 300
  });
}

async function markOutboundDelivery(targetId, status, message) {
  await RemoteHomeBrainPeer.updateOne(
    { _id: targetId, direction: 'outbound' },
    {
      $set: {
        lastDeliveryAt: new Date(),
        lastDeliveryStatus: status,
        lastDeliveryMessage: truncate(message, 500),
        ...(status === 'ok' ? { lastForwardedAt: new Date() } : {})
      }
    }
  );
}

function errorMessage(error) {
  return error?.response?.data?.message
    || error?.message
    || 'Remote HomeBrain request failed';
}

function isDatabaseReady() {
  return RemoteHomeBrainPeer.db?.readyState === 1;
}

async function forwardSecurityCriticalNotification(notification, input = {}) {
  if (!shouldForwardNotification(notification, input)) return [];
  if (!isDatabaseReady()) return [];

  const targets = await RemoteHomeBrainPeer.find({
    direction: 'outbound',
    enabled: true
  }).select('+outboundToken').lean();

  if (!targets.length) return [];

  const body = notificationPayload(notification, input);

  return Promise.all(targets.map(async (target) => {
    try {
      await postToRemote(target, '/api/notifications/remote-homebrains/alerts', body);
      await markOutboundDelivery(target._id, 'ok', `Forwarded ${body.eventType}`);
      return { targetId: target._id?.toString?.() || String(target._id), success: true };
    } catch (error) {
      const message = errorMessage(error);
      await markOutboundDelivery(target._id, 'failed', message);
      console.warn(`RemoteHomeBrainNotificationService: failed to forward alert to ${target.name}: ${message}`);
      return {
        targetId: target._id?.toString?.() || String(target._id),
        success: false,
        message
      };
    }
  }));
}

async function testOutboundTarget(targetId) {
  const target = await RemoteHomeBrainPeer.findOne({
    _id: targetId,
    direction: 'outbound'
  }).select('+outboundToken');

  if (!target) {
    const error = new Error('Remote HomeBrain target was not found');
    error.status = 404;
    throw error;
  }

  if (!target.outboundToken) {
    const error = new Error('Remote HomeBrain token is required');
    error.status = 400;
    throw error;
  }

  try {
    const response = await postToRemote(target, '/api/notifications/remote-homebrains/handshake', {
      sourceInstanceName: getLocalInstanceName(),
      sourceInstanceUrl: getLocalInstanceUrl()
    });
    await markOutboundDelivery(target._id, 'ok', 'Connection verified');
    return {
      success: true,
      message: response.data?.message || 'Connection verified',
      response: response.data || null,
      target: toPublicPeer(await RemoteHomeBrainPeer.findById(target._id).select('+outboundToken'))
    };
  } catch (error) {
    const message = errorMessage(error);
    await markOutboundDelivery(target._id, 'failed', message);
    const wrapped = new Error(message);
    wrapped.status = error?.response?.status || 502;
    throw wrapped;
  }
}

module.exports = {
  listRemoteHomeBrains,
  createInboundRemote,
  updateInboundRemote,
  rotateInboundToken,
  deleteInboundRemote,
  createOutboundTarget,
  updateOutboundTarget,
  deleteOutboundTarget,
  authenticateInboundRequest,
  recordInboundHandshake,
  receiveSecurityAlert,
  forwardSecurityCriticalNotification,
  testOutboundTarget,
  generateToken,
  hashToken,
  toPublicPeer
};

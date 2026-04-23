const crypto = require('crypto');
const mongoose = require('mongoose');
const Settings = require('../models/Settings');
const DeviceCommandClaim = require('../models/DeviceCommandClaim');
const eventStreamService = require('./eventStreamService');

const SOURCE_DEFINITIONS = Object.freeze([
  { id: 'security', label: 'Security', priority: 100, ttlSeconds: 900 },
  { id: 'manual', label: 'Manual', priority: 90, ttlSeconds: 120 },
  { id: 'voice', label: 'Voice', priority: 85, ttlSeconds: 120 },
  { id: 'alexa', label: 'Alexa', priority: 82, ttlSeconds: 120 },
  { id: 'openclaw', label: 'OpenClaw', priority: 80, ttlSeconds: 120 },
  { id: 'panel', label: 'Wall Panel', priority: 75, ttlSeconds: 120 },
  { id: 'scene', label: 'Scene', priority: 60, ttlSeconds: 60 },
  { id: 'workflow', label: 'Workflow', priority: 40, ttlSeconds: 45 },
  { id: 'automation', label: 'Automation', priority: 35, ttlSeconds: 45 },
  { id: 'system', label: 'System', priority: 20, ttlSeconds: 15 },
  { id: 'unknown', label: 'Unknown', priority: 10, ttlSeconds: 15 }
]);

const SOURCE_IDS = SOURCE_DEFINITIONS.map((source) => source.id);
const SOURCE_ID_SET = new Set(SOURCE_IDS);
const DEFAULT_SAME_PRIORITY_MODE = 'last_wins';
const MAX_TTL_SECONDS = 24 * 60 * 60;

function clampNumber(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

function sanitizeString(value, fallback = '') {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value == null) {
    return fallback;
  }
  return String(value).trim();
}

function normalizeSource(value) {
  const normalized = sanitizeString(value, 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  if (!normalized) {
    return 'unknown';
  }

  if (normalized === 'voice_command' || normalized === 'custom_skill') {
    return 'voice';
  }
  if (normalized === 'alexa_custom_skill' || normalized === 'alexa_bridge') {
    return 'alexa';
  }
  if (normalized === 'wall_panel' || normalized === 'hardware_orb') {
    return 'panel';
  }
  if (['chat', 'ui', 'api', 'user', 'mobile'].includes(normalized)) {
    return 'manual';
  }
  if (normalized === 'scheduler' || normalized === 'device_state' || normalized === 'schedule') {
    return 'workflow';
  }
  if (normalized === 'security_alarm' || normalized === 'security_alarm_status') {
    return 'security';
  }

  return SOURCE_ID_SET.has(normalized) ? normalized : 'unknown';
}

function buildDefaultPolicy() {
  return {
    enabled: true,
    samePriorityMode: DEFAULT_SAME_PRIORITY_MODE,
    workflowPriorityWeight: 1,
    sources: SOURCE_DEFINITIONS.reduce((acc, source) => {
      acc[source.id] = {
        id: source.id,
        label: source.label,
        priority: source.priority,
        ttlSeconds: source.ttlSeconds,
        enabled: true
      };
      return acc;
    }, {})
  };
}

function sanitizePolicy(candidate = {}) {
  const defaults = buildDefaultPolicy();
  const rawSources = candidate && typeof candidate === 'object' && candidate.sources && typeof candidate.sources === 'object'
    ? candidate.sources
    : {};
  const sources = {};

  SOURCE_DEFINITIONS.forEach((source) => {
    const raw = rawSources[source.id] && typeof rawSources[source.id] === 'object'
      ? rawSources[source.id]
      : {};
    sources[source.id] = {
      id: source.id,
      label: source.label,
      priority: clampNumber(raw.priority, defaults.sources[source.id].priority, 0, 100),
      ttlSeconds: clampNumber(raw.ttlSeconds, defaults.sources[source.id].ttlSeconds, 0, MAX_TTL_SECONDS),
      enabled: raw.enabled !== false
    };
  });

  const samePriorityMode = sanitizeString(candidate.samePriorityMode).toLowerCase() === 'block'
    ? 'block'
    : DEFAULT_SAME_PRIORITY_MODE;

  return {
    enabled: candidate.enabled !== false,
    samePriorityMode,
    workflowPriorityWeight: clampNumber(candidate.workflowPriorityWeight, defaults.workflowPriorityWeight, 0, 5),
    sources
  };
}

function toClaimPayload(claim) {
  if (!claim) {
    return null;
  }

  const payload = typeof claim.toObject === 'function' ? claim.toObject() : { ...claim };
  if (payload.deviceId && typeof payload.deviceId === 'object') {
    payload.device = {
      _id: payload.deviceId._id?.toString?.() || payload.deviceId.id || null,
      name: payload.deviceId.name || '',
      room: payload.deviceId.room || '',
      type: payload.deviceId.type || ''
    };
    payload.deviceId = payload.device._id || payload.deviceId.toString?.() || String(payload.deviceId);
  } else if (payload.deviceId) {
    payload.deviceId = payload.deviceId.toString?.() || String(payload.deviceId);
  }

  if (payload._id) {
    payload._id = payload._id.toString?.() || String(payload._id);
  }

  return payload;
}

class DeviceCommandBlockedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DeviceCommandBlockedError';
    this.code = 'DEVICE_COMMAND_BLOCKED';
    this.status = 409;
    this.details = details;
  }
}

class DeviceCommandCoordinatorService {
  constructor() {
    this.recentDecisions = [];
    this.maxRecentDecisions = 100;
  }

  get sourceDefinitions() {
    return SOURCE_DEFINITIONS;
  }

  get defaultPolicy() {
    return buildDefaultPolicy();
  }

  sanitizePolicy(policy) {
    return sanitizePolicy(policy);
  }

  async getPolicy() {
    if (mongoose.connection?.readyState !== 1) {
      return sanitizePolicy({});
    }

    const settings = await Settings.getSettings();
    const policy = sanitizePolicy(settings.deviceCommandCoordinator || {});
    const current = JSON.stringify(settings.deviceCommandCoordinator || {});
    const normalized = JSON.stringify(policy);
    if (current !== normalized) {
      settings.deviceCommandCoordinator = policy;
      await settings.save();
    }
    return policy;
  }

  async updatePolicy(updates = {}, actor = 'unknown') {
    if (mongoose.connection?.readyState !== 1) {
      return sanitizePolicy(updates);
    }

    const policy = sanitizePolicy(updates);
    const settings = await Settings.updateSettings({
      deviceCommandCoordinator: policy,
      modifiedBy: actor || 'system'
    });
    await this.publishDecision('device_command.policy_updated', {
      actor,
      policy: sanitizePolicy(settings.deviceCommandCoordinator || {})
    });
    return sanitizePolicy(settings.deviceCommandCoordinator || {});
  }

  deriveSource(metadata = {}) {
    const triggerType = sanitizeString(metadata.triggerType).toLowerCase();
    const triggerSource = sanitizeString(metadata.triggerSource || metadata.source).toLowerCase();

    if (triggerType === 'security_alarm_status' || triggerSource.includes('security')) {
      return 'security';
    }
    if (triggerSource.includes('voice')) {
      return 'voice';
    }
    if (triggerSource.includes('alexa')) {
      return 'alexa';
    }
    if (triggerSource.includes('openclaw')) {
      return 'openclaw';
    }
    if (triggerSource.includes('panel') || triggerSource.includes('wall-panel')) {
      return 'panel';
    }
    if (triggerSource === 'manual') {
      return 'manual';
    }
    if (metadata.workflowId || triggerSource === 'scheduler') {
      return 'workflow';
    }
    if (metadata.automationId) {
      return 'automation';
    }
    return normalizeSource(metadata.source || metadata.commandSource || 'unknown');
  }

  buildCommandMetadata({ device, action, value, metadata = {}, policy }) {
    const source = normalizeSource(metadata.source || metadata.commandSource || this.deriveSource(metadata));
    const sourcePolicy = policy.sources[source] || policy.sources.unknown;
    const rawPriority = metadata.priority ?? metadata.commandPriority;
    const workflowPriority = clampNumber(metadata.workflowPriority, 0, 0, 10);
    const workflowOffset = source === 'workflow' || source === 'automation'
      ? workflowPriority * policy.workflowPriorityWeight
      : 0;
    const priority = clampNumber(
      rawPriority,
      clampNumber(sourcePolicy.priority + workflowOffset, sourcePolicy.priority, 0, 100),
      0,
      100
    );
    const ttlSeconds = clampNumber(
      metadata.ttlSeconds ?? metadata.commandTtlSeconds,
      sourcePolicy.ttlSeconds,
      0,
      MAX_TTL_SECONDS
    );
    const deviceName = sanitizeString(device?.name, 'device');
    const reason = sanitizeString(
      metadata.reason || metadata.commandReason,
      `${sourcePolicy.label} ${sanitizeString(action, 'command')} command for ${deviceName}`
    ).slice(0, 500);
    const actor = sanitizeString(metadata.actor || metadata.requestedBy, '').slice(0, 200);

    return {
      commandId: metadata.commandId || crypto.randomUUID(),
      source,
      sourceLabel: sourcePolicy.label,
      priority,
      ttlSeconds,
      reason,
      actor,
      action: sanitizeString(action),
      value: value === undefined ? null : value,
      metadata: {
        workflowId: metadata.workflowId || null,
        workflowName: metadata.workflowName || null,
        automationId: metadata.automationId || null,
        automationName: metadata.automationName || null,
        sceneId: metadata.sceneId || null,
        sceneName: metadata.sceneName || null,
        triggerType: metadata.triggerType || null,
        triggerSource: metadata.triggerSource || null,
        correlationId: metadata.correlationId || metadata.executionCorrelationId || null
      }
    };
  }

  async admitCommand({ device, action, value, metadata = {} }) {
    const policy = await this.getPolicy();
    const now = new Date();
    const deviceId = device?._id?.toString?.() || sanitizeString(device?._id || metadata.deviceId);

    if (!deviceId) {
      throw new Error('Device ID is required for command coordination');
    }

    if (mongoose.connection?.readyState !== 1) {
      const command = this.buildCommandMetadata({ device, action, value, metadata, policy });
      return {
        accepted: true,
        disabled: true,
        unavailable: true,
        command,
        policy
      };
    }

    if (policy.enabled === false) {
      const command = this.buildCommandMetadata({ device, action, value, metadata, policy });
      return {
        accepted: true,
        disabled: true,
        command,
        policy
      };
    }

    const command = this.buildCommandMetadata({ device, action, value, metadata, policy });
    const sourcePolicy = policy.sources[command.source] || policy.sources.unknown;

    if (sourcePolicy.enabled === false) {
      const details = {
        deviceId,
        incoming: command,
        reason: `Command source "${command.source}" is disabled`
      };
      await this.recordDecision('blocked', details);
      throw new DeviceCommandBlockedError(details.reason, details);
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await DeviceCommandClaim.findOne({ deviceId }).lean();
      const currentActive = current && new Date(current.expiresAt).getTime() > now.getTime();
      const currentPriority = currentActive ? Number(current.priority) : null;
      const canReplace = !currentActive
        || currentPriority < command.priority
        || (currentPriority === command.priority && policy.samePriorityMode === 'last_wins');

      if (!canReplace) {
        const details = {
          deviceId,
          incoming: command,
          active: toClaimPayload(current),
          reason: `Blocked by active ${current.source} command with priority ${current.priority}`
        };
        await this.recordDecision('blocked', details);
        throw new DeviceCommandBlockedError(details.reason, details);
      }

      const expiresAt = new Date(now.getTime() + command.ttlSeconds * 1000);
      const replacementFilter = {
        deviceId,
        $or: [
          { expiresAt: { $lte: now } },
          { priority: { $lt: command.priority } },
          ...(policy.samePriorityMode === 'last_wins' ? [{ priority: command.priority }] : [])
        ]
      };
      const update = {
        $set: {
          deviceId,
          commandId: command.commandId,
          source: command.source,
          priority: command.priority,
          ttlSeconds: command.ttlSeconds,
          reason: command.reason,
          actor: command.actor,
          action: command.action,
          value: command.value,
          metadata: command.metadata,
          issuedAt: now,
          expiresAt
        }
      };

      try {
        const claim = current
          ? await DeviceCommandClaim.findOneAndUpdate(replacementFilter, update, { new: true })
          : await DeviceCommandClaim.create(update.$set);

        if (!claim) {
          continue;
        }

        const details = {
          deviceId,
          incoming: command,
          active: toClaimPayload(claim),
          replaced: currentActive ? toClaimPayload(current) : null,
          reason: currentActive
            ? `Accepted and replaced ${current.source} priority ${current.priority}`
            : 'Accepted command'
        };
        await this.recordDecision('accepted', details);
        return {
          accepted: true,
          command,
          claim: toClaimPayload(claim),
          replaced: currentActive ? toClaimPayload(current) : null,
          policy
        };
      } catch (error) {
        if (error?.code === 11000 && attempt === 0) {
          continue;
        }
        throw error;
      }
    }

    const active = await DeviceCommandClaim.findOne({ deviceId }).lean();
    const details = {
      deviceId,
      incoming: command,
      active: toClaimPayload(active),
      reason: 'Command could not acquire the device coordinator claim'
    };
    await this.recordDecision('blocked', details);
    throw new DeviceCommandBlockedError(details.reason, details);
  }

  async releaseCommand(commandId, options = {}) {
    if (!commandId) {
      return null;
    }
    const claim = await DeviceCommandClaim.findOneAndDelete({ commandId });
    if (claim) {
      await this.recordDecision('released', {
        active: toClaimPayload(claim),
        reason: options.reason || 'Command released'
      });
    }
    return toClaimPayload(claim);
  }

  async clearDeviceClaim(deviceId, actor = 'unknown') {
    const claim = await DeviceCommandClaim.findOneAndDelete({ deviceId });
    if (claim) {
      await this.recordDecision('cleared', {
        active: toClaimPayload(claim),
        actor,
        reason: 'Device command hold cleared'
      });
    }
    return toClaimPayload(claim);
  }

  async clearAllClaims(actor = 'unknown') {
    const claims = await DeviceCommandClaim.find({}).lean();
    await DeviceCommandClaim.deleteMany({});
    await this.recordDecision('cleared_all', {
      count: claims.length,
      actor,
      reason: 'All device command holds cleared'
    });
    return claims.map((claim) => toClaimPayload(claim));
  }

  async listActiveClaims() {
    const now = new Date();
    const claims = await DeviceCommandClaim.find({ expiresAt: { $gt: now } })
      .populate('deviceId', 'name room type')
      .sort({ priority: -1, expiresAt: 1 })
      .lean();
    return claims.map((claim) => toClaimPayload(claim));
  }

  getRecentDecisions(limit = 50) {
    const boundedLimit = clampNumber(limit, 50, 1, this.maxRecentDecisions);
    return this.recentDecisions.slice(0, boundedLimit);
  }

  async recordDecision(decision, details = {}) {
    const entry = {
      id: crypto.randomUUID(),
      decision,
      details,
      createdAt: new Date().toISOString()
    };
    this.recentDecisions = [entry, ...this.recentDecisions].slice(0, this.maxRecentDecisions);
    await this.publishDecision(`device_command.${decision}`, details);
    return entry;
  }

  async publishDecision(type, details = {}) {
    try {
      await eventStreamService.publishSafe({
        type,
        source: 'device_command_coordinator',
        category: 'automation',
        severity: type.includes('blocked') ? 'warn' : 'info',
        payload: details,
        correlationId: details?.incoming?.metadata?.correlationId || details?.active?.metadata?.correlationId || null,
        tags: ['device-command', 'coordinator']
      });
    } catch (error) {
      console.warn(`DeviceCommandCoordinatorService: failed to publish ${type}: ${error.message}`);
    }
  }
}

const service = new DeviceCommandCoordinatorService();
service.DeviceCommandBlockedError = DeviceCommandBlockedError;

module.exports = service;
module.exports.DeviceCommandBlockedError = DeviceCommandBlockedError;
module.exports.SOURCE_DEFINITIONS = SOURCE_DEFINITIONS;

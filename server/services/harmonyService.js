const { Explorer } = require('@harmonyhub/discover');
const { getHarmonyClient } = require('@harmonyhub/client-ws');
const Device = require('../models/Device');
const Settings = require('../models/Settings');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const eventStreamService = require('./eventStreamService');
const {
  buildHarmonyActivityIdentityQuery,
  buildHarmonyDeviceIdentityQuery,
  selectCanonicalDevice,
  mergeDuplicateDeviceGroups,
  describeDevices
} = require('./deviceIdentityService');

const DEFAULT_DISCOVERY_TIMEOUT_MS = Number(process.env.HARMONY_DISCOVERY_TIMEOUT_MS || 4500);
const DEFAULT_DISCOVERY_CACHE_MS = Number(process.env.HARMONY_DISCOVERY_CACHE_MS || 15000);
const DEFAULT_DISCOVERY_INCOMING_PORT = Number(process.env.HARMONY_DISCOVERY_INCOMING_PORT || 61991);
const DEFAULT_DISCOVERY_TARGET_PORT = Number(process.env.HARMONY_DISCOVERY_TARGET_PORT || 5224);
const DEFAULT_DISCOVERY_INTERVAL_MS = Number(process.env.HARMONY_DISCOVERY_INTERVAL_MS || 1000);
const MAX_HOLD_COMMAND_MS = 5000;
const HARMONY_ENTITY_TYPES = {
  ACTIVITY: 'activity',
  DEVICE: 'device'
};
const HARMONY_COMMAND_CATEGORY_ORDER = Object.freeze([
  'power',
  'volume',
  'channel',
  'navigation',
  'transport',
  'menu',
  'input',
  'numeric',
  'other'
]);
const HARMONY_CONTROL_MATCHERS = Object.freeze([
  {
    capability: 'volume_up',
    category: 'volume',
    exact: ['volumeup', 'volup', 'raisevolume'],
    startsWith: ['volumeup'],
    textAll: [['volume', 'up'], ['vol', 'up'], ['raise', 'volume']]
  },
  {
    capability: 'volume_down',
    category: 'volume',
    exact: ['volumedown', 'voldown', 'lowervolume'],
    startsWith: ['volumedown'],
    textAll: [['volume', 'down'], ['vol', 'down'], ['lower', 'volume']]
  },
  {
    capability: 'mute',
    category: 'volume',
    exact: ['mute', 'volumemute', 'audiomute', 'mutetoggle'],
    startsWith: ['mute'],
    textAll: [['mute']]
  },
  {
    capability: 'channel_up',
    category: 'channel',
    exact: ['channelup', 'chup', 'pageup'],
    startsWith: ['channelup'],
    textAll: [['channel', 'up'], ['channel', 'plus'], ['ch', 'up']]
  },
  {
    capability: 'channel_down',
    category: 'channel',
    exact: ['channeldown', 'chdown', 'pagedown'],
    startsWith: ['channeldown'],
    textAll: [['channel', 'down'], ['channel', 'minus'], ['ch', 'down']]
  },
  {
    capability: 'direction_up',
    category: 'navigation',
    exact: ['directionup', 'navigateup', 'navigationup', 'cursorup', 'arrowup', 'up'],
    startsWith: ['directionup', 'navigateup', 'navigationup', 'cursorup'],
    textAll: [['direction', 'up'], ['navigate', 'up'], ['navigation', 'up'], ['cursor', 'up'], ['arrow', 'up']]
  },
  {
    capability: 'direction_down',
    category: 'navigation',
    exact: ['directiondown', 'navigatedown', 'navigationdown', 'cursordown', 'arrowdown', 'down'],
    startsWith: ['directiondown', 'navigatedown', 'navigationdown', 'cursordown'],
    textAll: [['direction', 'down'], ['navigate', 'down'], ['navigation', 'down'], ['cursor', 'down'], ['arrow', 'down']]
  },
  {
    capability: 'direction_left',
    category: 'navigation',
    exact: ['directionleft', 'navigateleft', 'navigationleft', 'cursorleft', 'arrowleft', 'left'],
    startsWith: ['directionleft', 'navigateleft', 'navigationleft', 'cursorleft'],
    textAll: [['direction', 'left'], ['navigate', 'left'], ['navigation', 'left'], ['cursor', 'left'], ['arrow', 'left']]
  },
  {
    capability: 'direction_right',
    category: 'navigation',
    exact: ['directionright', 'navigateright', 'navigationright', 'cursorright', 'arrowright', 'right'],
    startsWith: ['directionright', 'navigateright', 'navigationright', 'cursorright'],
    textAll: [['direction', 'right'], ['navigate', 'right'], ['navigation', 'right'], ['cursor', 'right'], ['arrow', 'right']]
  },
  {
    capability: 'select',
    category: 'navigation',
    exact: ['select', 'ok', 'enter'],
    startsWith: ['select'],
    textAll: [['select'], [' ok '], ['enter']]
  },
  {
    capability: 'back',
    category: 'menu',
    exact: ['back', 'return'],
    startsWith: ['back'],
    textAll: [['back'], ['return']]
  },
  {
    capability: 'home',
    category: 'menu',
    exact: ['home'],
    startsWith: ['home'],
    textAll: [['home']]
  },
  {
    capability: 'menu',
    category: 'menu',
    exact: ['menu', 'options', 'popupmenu'],
    startsWith: ['menu'],
    textAll: [['menu'], ['options']]
  },
  {
    capability: 'guide',
    category: 'menu',
    exact: ['guide', 'programguide'],
    startsWith: ['guide'],
    textAll: [['guide']]
  },
  {
    capability: 'info',
    category: 'menu',
    exact: ['info', 'display'],
    startsWith: ['info'],
    textAll: [['info'], ['display']]
  },
  {
    capability: 'play',
    category: 'transport',
    exact: ['play'],
    startsWith: ['play'],
    textAll: [['play']]
  },
  {
    capability: 'pause',
    category: 'transport',
    exact: ['pause'],
    startsWith: ['pause'],
    textAll: [['pause']]
  },
  {
    capability: 'stop',
    category: 'transport',
    exact: ['stop'],
    startsWith: ['stop'],
    textAll: [['stop']]
  },
  {
    capability: 'record',
    category: 'transport',
    exact: ['record', 'rec'],
    startsWith: ['record'],
    textAll: [['record']]
  },
  {
    capability: 'rewind',
    category: 'transport',
    exact: ['rewind', 'reverse'],
    startsWith: ['rewind'],
    textAll: [['rewind'], ['reverse']]
  },
  {
    capability: 'fast_forward',
    category: 'transport',
    exact: ['fastforward', 'ffwd', 'forward'],
    startsWith: ['fastforward'],
    textAll: [['fast', 'forward']]
  },
  {
    capability: 'skip_back',
    category: 'transport',
    exact: ['skipback', 'previous', 'prev'],
    startsWith: ['skipback'],
    textAll: [['skip', 'back'], ['skip', 'previous']]
  },
  {
    capability: 'skip_forward',
    category: 'transport',
    exact: ['skipforward', 'next'],
    startsWith: ['skipforward'],
    textAll: [['skip', 'forward'], ['skip', 'next']]
  }
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHost(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  let host = value.trim();
  if (!host) {
    return '';
  }

  host = host
    .replace(/^https?:\/\//i, '')
    .replace(/^wss?:\/\//i, '');

  if (host.includes('/')) {
    [host] = host.split('/');
  }

  const bracketedIpv6 = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketedIpv6) {
    return bracketedIpv6[1].trim().toLowerCase();
  }

  const colonCount = (host.match(/:/g) || []).length;
  if (colonCount === 1) {
    const [name, port] = host.split(':');
    if (name && /^\d+$/.test(port || '')) {
      host = name;
    }
  }

  return host.trim().toLowerCase();
}

function toUniqueHostList(values = []) {
  const result = [];
  const seen = new Set();
  values.forEach((value) => {
    const normalized = normalizeHost(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

function trimHarmonyValue(value) {
  return (value || '').toString().trim();
}

function escapeRegex(value) {
  return trimHarmonyValue(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripHarmonyDuplicateSuffix(value) {
  return trimHarmonyValue(value).replace(/\s*\(\d+\)\s*$/, '');
}

function buildHarmonyDuplicateNameMatch(value) {
  const normalized = stripHarmonyDuplicateSuffix(value);
  if (!normalized) {
    return null;
  }

  return new RegExp(`^${escapeRegex(normalized)}(?: \\(\\d+\\))?$`, 'i');
}

function normalizeCommandName(value) {
  return (value || '').toString().trim().toLowerCase();
}

function normalizeHarmonyDuplicateName(value) {
  return normalizeCommandName(stripHarmonyDuplicateSuffix(value));
}

function mergeUniqueDevices(...collections) {
  const merged = new Map();

  collections
    .flat()
    .filter(Boolean)
    .forEach((device, index) => {
      const key = trimHarmonyValue(device?._id) || `fallback-${index}`;
      if (!merged.has(key)) {
        merged.set(key, device);
      }
    });

  return Array.from(merged.values());
}

function toDateOrNull(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function mergeHubSources(...sources) {
  const ordered = ['configured', 'remembered', 'discovered'];
  const parts = new Set();

  sources.forEach((source) => {
    (source || '').toString().split('+').forEach((part) => {
      const normalized = part.trim().toLowerCase();
      if (ordered.includes(normalized)) {
        parts.add(normalized);
      }
    });
  });

  if (parts.size === 0) {
    return 'unknown';
  }

  return ordered.filter((part) => parts.has(part)).join('+');
}

function normalizeHarmonyEntityType(value) {
  const normalized = (value || '').toString().trim().toLowerCase();
  if (normalized === HARMONY_ENTITY_TYPES.ACTIVITY || normalized === HARMONY_ENTITY_TYPES.DEVICE) {
    return normalized;
  }

  return '';
}

function compactHarmonyCommandKey(value) {
  return normalizeCommandName(value).replace(/[^a-z0-9]/g, '');
}

function buildHarmonyHubMatch(hubIp, remoteId = null) {
  const normalizedHubIp = normalizeHost(hubIp);
  const normalizedRemoteId = trimHarmonyValue(remoteId);

  if (normalizedRemoteId && normalizedHubIp) {
    return {
      $or: [
        { 'properties.harmonyRemoteId': normalizedRemoteId },
        { 'properties.harmonyHubIp': normalizedHubIp }
      ]
    };
  }
  if (normalizedRemoteId) {
    return { 'properties.harmonyRemoteId': normalizedRemoteId };
  }
  if (normalizedHubIp) {
    return { 'properties.harmonyHubIp': normalizedHubIp };
  }

  return null;
}

function buildHarmonyActivityMatch(hubIp, extraMatch = {}, remoteId = null) {
  const clauses = [
    { 'properties.source': 'harmony' },
    {
      $or: [
        { 'properties.harmonyEntityType': HARMONY_ENTITY_TYPES.ACTIVITY },
        {
          'properties.harmonyEntityType': { $exists: false },
          'properties.harmonyActivityId': { $exists: true }
        }
      ]
    }
  ];
  const hubMatch = buildHarmonyHubMatch(hubIp, remoteId);
  if (hubMatch) {
    clauses.push(hubMatch);
  }
  if (extraMatch && Object.keys(extraMatch).length > 0) {
    clauses.push(extraMatch);
  }

  if (clauses.length === 1) {
    return clauses[0];
  }

  return {
    $and: clauses
  };
}

function buildHarmonyDeviceMatch(hubIp, extraMatch = {}, remoteId = null) {
  const clauses = [
    { 'properties.source': 'harmony' },
    { 'properties.harmonyEntityType': HARMONY_ENTITY_TYPES.DEVICE }
  ];
  const hubMatch = buildHarmonyHubMatch(hubIp, remoteId);
  if (hubMatch) {
    clauses.push(hubMatch);
  }
  if (extraMatch && Object.keys(extraMatch).length > 0) {
    clauses.push(extraMatch);
  }

  if (clauses.length === 1) {
    return clauses[0];
  }

  return {
    $and: clauses
  };
}

class HarmonyService {
  constructor(options = {}) {
    this.ExplorerClass = options.ExplorerClass || Explorer;
    this.getHarmonyClientImpl = options.getHarmonyClient || getHarmonyClient;
    this.sleepImpl = options.sleep || sleep;
    this.discoveryCache = [];
    this.discoveryCacheAt = 0;
    this.discoveryCacheMs = Number.isFinite(DEFAULT_DISCOVERY_CACHE_MS) ? DEFAULT_DISCOVERY_CACHE_MS : 15000;
    this.hubMetadata = new Map();
    this.syncPromise = null;
    this.stateSyncPromise = null;
    this.discoveryPromise = null;
    this.backgroundMonitorTimer = null;
    this.backgroundMonitorInProgress = false;
    this.backgroundMonitoringStarted = false;
    this.backgroundMonitorIntervalMs = Math.max(
      5000,
      Number(process.env.HARMONY_BACKGROUND_MONITOR_INTERVAL_MS || 15000)
    );
  }

  parseConfiguredHubAddresses(rawInput) {
    if (Array.isArray(rawInput)) {
      return toUniqueHostList(rawInput);
    }

    if (typeof rawInput !== 'string') {
      return [];
    }

    const parts = rawInput
      .split(/[\n,;\s]+/g)
      .map((part) => part.trim())
      .filter(Boolean);

    return toUniqueHostList(parts);
  }

  createKnownHubRecord(ip) {
    return {
      ip,
      friendlyName: '',
      firstDiscoveredAt: null,
      lastDiscoveredAt: null,
      lastSeenAt: null,
      lastSnapshotAt: null,
      lastKnownActivityId: null,
      lastKnownActivityLabel: null,
      lastDeviceSyncAt: null,
      lastDeviceSyncStatus: 'unknown',
      lastDeviceSyncError: '',
      lastActivitySyncAt: null,
      lastActivitySyncStatus: 'unknown',
      lastActivitySyncError: '',
      lastUpdatedAt: null
    };
  }

  normalizeKnownHubRegistry(rawHubs = []) {
    const map = new Map();

    (Array.isArray(rawHubs) ? rawHubs : []).forEach((raw) => {
      const ip = normalizeHost(raw?.ip);
      if (!ip) {
        return;
      }

      const existing = map.get(ip) || this.createKnownHubRecord(ip);
      const next = {
        ...existing,
        ip
      };

      const friendlyName = (raw?.friendlyName || existing.friendlyName || '').toString().trim();
      if (friendlyName) {
        next.friendlyName = friendlyName;
      }

      next.firstDiscoveredAt = toDateOrNull(raw?.firstDiscoveredAt) || existing.firstDiscoveredAt;
      next.lastDiscoveredAt = toDateOrNull(raw?.lastDiscoveredAt) || existing.lastDiscoveredAt;
      next.lastSeenAt = toDateOrNull(raw?.lastSeenAt) || existing.lastSeenAt;
      next.lastSnapshotAt = toDateOrNull(raw?.lastSnapshotAt) || existing.lastSnapshotAt;

      if (raw?.lastKnownActivityId !== undefined && raw?.lastKnownActivityId !== null) {
        next.lastKnownActivityId = raw.lastKnownActivityId.toString();
      } else if (existing.lastKnownActivityId) {
        next.lastKnownActivityId = existing.lastKnownActivityId;
      }

      if (raw?.lastKnownActivityLabel !== undefined && raw?.lastKnownActivityLabel !== null) {
        const label = raw.lastKnownActivityLabel.toString().trim();
        next.lastKnownActivityLabel = label || null;
      } else if (existing.lastKnownActivityLabel) {
        next.lastKnownActivityLabel = existing.lastKnownActivityLabel;
      }

      const deviceSyncStatus = (raw?.lastDeviceSyncStatus || existing.lastDeviceSyncStatus || 'unknown').toString();
      next.lastDeviceSyncStatus = ['unknown', 'success', 'failed'].includes(deviceSyncStatus)
        ? deviceSyncStatus
        : 'unknown';
      next.lastDeviceSyncAt = toDateOrNull(raw?.lastDeviceSyncAt) || existing.lastDeviceSyncAt;
      next.lastDeviceSyncError = (raw?.lastDeviceSyncError ?? existing.lastDeviceSyncError ?? '').toString();

      const activitySyncStatus = (raw?.lastActivitySyncStatus || existing.lastActivitySyncStatus || 'unknown').toString();
      next.lastActivitySyncStatus = ['unknown', 'success', 'failed'].includes(activitySyncStatus)
        ? activitySyncStatus
        : 'unknown';
      next.lastActivitySyncAt = toDateOrNull(raw?.lastActivitySyncAt) || existing.lastActivitySyncAt;
      next.lastActivitySyncError = (raw?.lastActivitySyncError ?? existing.lastActivitySyncError ?? '').toString();
      next.lastUpdatedAt = toDateOrNull(raw?.lastUpdatedAt) || existing.lastUpdatedAt;

      map.set(ip, next);
    });

    return Array.from(map.values()).sort((left, right) => {
      const leftName = (left.friendlyName || left.ip || '').toString().toLowerCase();
      const rightName = (right.friendlyName || right.ip || '').toString().toLowerCase();
      return leftName.localeCompare(rightName);
    });
  }

  async getKnownHubRegistry() {
    const settings = await Settings.getSettings();
    const knownHubs = this.normalizeKnownHubRegistry(settings?.harmonyKnownHubs || []);

    knownHubs.forEach((hub) => {
      if (!hub.friendlyName) {
        return;
      }
      const metadata = this.hubMetadata.get(hub.ip) || {};
      this.hubMetadata.set(hub.ip, {
        ip: hub.ip,
        friendlyName: hub.friendlyName,
        remoteId: metadata.remoteId || null,
        uuid: metadata.uuid || null,
        lastSeen: metadata.lastSeen || (hub.lastSeenAt ? new Date(hub.lastSeenAt).getTime() : null)
      });
    });

    return knownHubs;
  }

  async mergeKnownHubs(updates = []) {
    const relevantUpdates = Array.isArray(updates) ? updates : [];
    if (!relevantUpdates.length) {
      return [];
    }

    const settings = await Settings.getSettings();
    const current = this.normalizeKnownHubRegistry(settings?.harmonyKnownHubs || []);
    const map = new Map(current.map((hub) => [hub.ip, { ...hub }]));
    const now = new Date();

    relevantUpdates.forEach((update) => {
      const ip = normalizeHost(update?.ip);
      if (!ip) {
        return;
      }

      const existing = map.get(ip) || this.createKnownHubRecord(ip);
      const next = {
        ...existing,
        ip
      };

      const friendlyName = (update?.friendlyName || '').toString().trim();
      if (friendlyName) {
        next.friendlyName = friendlyName;
      }

      const isDiscovered = update?.discovered === true;
      if (isDiscovered && !next.firstDiscoveredAt) {
        next.firstDiscoveredAt = toDateOrNull(update?.firstDiscoveredAt) || now;
      }
      if (isDiscovered) {
        next.lastDiscoveredAt = toDateOrNull(update?.lastDiscoveredAt || update?.lastSeenAt) || now;
      }

      const lastSeenAt = toDateOrNull(update?.lastSeenAt);
      if (lastSeenAt) {
        next.lastSeenAt = lastSeenAt;
      }

      const lastSnapshotAt = toDateOrNull(update?.lastSnapshotAt);
      if (lastSnapshotAt) {
        next.lastSnapshotAt = lastSnapshotAt;
      }

      if (update?.lastKnownActivityId !== undefined) {
        next.lastKnownActivityId = update.lastKnownActivityId == null ? null : update.lastKnownActivityId.toString();
      }
      if (update?.lastKnownActivityLabel !== undefined) {
        const label = update.lastKnownActivityLabel == null ? '' : update.lastKnownActivityLabel.toString();
        next.lastKnownActivityLabel = label.trim() || null;
      }

      if (update?.lastDeviceSyncStatus !== undefined) {
        const status = (update.lastDeviceSyncStatus || '').toString().toLowerCase();
        if (['unknown', 'success', 'failed'].includes(status)) {
          next.lastDeviceSyncStatus = status;
        }
      }
      const lastDeviceSyncAt = toDateOrNull(update?.lastDeviceSyncAt);
      if (lastDeviceSyncAt) {
        next.lastDeviceSyncAt = lastDeviceSyncAt;
      }
      if (update?.lastDeviceSyncError !== undefined) {
        next.lastDeviceSyncError = (update.lastDeviceSyncError || '').toString();
      } else if (next.lastDeviceSyncStatus === 'success') {
        next.lastDeviceSyncError = '';
      }

      if (update?.lastActivitySyncStatus !== undefined) {
        const status = (update.lastActivitySyncStatus || '').toString().toLowerCase();
        if (['unknown', 'success', 'failed'].includes(status)) {
          next.lastActivitySyncStatus = status;
        }
      }
      const lastActivitySyncAt = toDateOrNull(update?.lastActivitySyncAt);
      if (lastActivitySyncAt) {
        next.lastActivitySyncAt = lastActivitySyncAt;
      }
      if (update?.lastActivitySyncError !== undefined) {
        next.lastActivitySyncError = (update.lastActivitySyncError || '').toString();
      } else if (next.lastActivitySyncStatus === 'success') {
        next.lastActivitySyncError = '';
      }

      next.lastUpdatedAt = now;
      map.set(ip, next);

      if (next.friendlyName) {
        const metadata = this.hubMetadata.get(ip) || {};
        this.hubMetadata.set(ip, {
          ip,
          friendlyName: next.friendlyName,
          remoteId: metadata.remoteId || null,
          uuid: metadata.uuid || null,
          lastSeen: next.lastSeenAt ? new Date(next.lastSeenAt).getTime() : (metadata.lastSeen || null)
        });
      }
    });

    settings.harmonyKnownHubs = Array.from(map.values()).sort((left, right) => {
      const leftName = (left.friendlyName || left.ip || '').toString().toLowerCase();
      const rightName = (right.friendlyName || right.ip || '').toString().toLowerCase();
      return leftName.localeCompare(rightName);
    });
    await settings.save();
    return settings.harmonyKnownHubs;
  }

  async getHubDeviceStatsMap(hubIps = []) {
    const normalizedIps = toUniqueHostList(hubIps);
    const map = new Map(normalizedIps.map((ip) => [ip, {
      trackedActivityDevices: 0,
      onlineActivityDevices: 0,
      activeActivityDevices: 0,
      lastActivityDeviceSeenAt: null,
      lastActivityDeviceUpdatedAt: null
    }]));

    if (!normalizedIps.length) {
      return map;
    }

    const grouped = await Device.aggregate([
      {
        $match: buildHarmonyActivityMatch(null, {
          'properties.harmonyHubIp': { $in: normalizedIps }
        })
      },
      {
        $group: {
          _id: '$properties.harmonyHubIp',
          trackedActivityDevices: { $sum: 1 },
          onlineActivityDevices: {
            $sum: {
              $cond: [{ $eq: ['$isOnline', true] }, 1, 0]
            }
          },
          activeActivityDevices: {
            $sum: {
              $cond: [{ $eq: ['$status', true] }, 1, 0]
            }
          },
          lastActivityDeviceSeenAt: { $max: '$lastSeen' },
          lastActivityDeviceUpdatedAt: { $max: '$updatedAt' }
        }
      }
    ]);

    grouped.forEach((entry) => {
      const ip = normalizeHost(entry?._id);
      if (!ip) {
        return;
      }
      map.set(ip, {
        trackedActivityDevices: Number(entry?.trackedActivityDevices || 0),
        onlineActivityDevices: Number(entry?.onlineActivityDevices || 0),
        activeActivityDevices: Number(entry?.activeActivityDevices || 0),
        lastActivityDeviceSeenAt: toDateOrNull(entry?.lastActivityDeviceSeenAt),
        lastActivityDeviceUpdatedAt: toDateOrNull(entry?.lastActivityDeviceUpdatedAt)
      });
    });

    return map;
  }

  async getActivityLabelForHub(hubIp, activityId) {
    const normalizedHubIp = normalizeHost(hubIp);
    const normalizedActivityId = activityId != null ? activityId.toString() : null;
    if (!normalizedHubIp || !normalizedActivityId || normalizedActivityId === '-1') {
      return normalizedActivityId === '-1' ? 'Off' : null;
    }

    const device = await Device.findOne({
      ...buildHarmonyActivityMatch(normalizedHubIp),
      'properties.harmonyActivityId': normalizedActivityId
    }).select('properties.harmonyActivityLabel name');

    const label = device?.properties?.harmonyActivityLabel || device?.name || null;
    return label ? label.toString() : null;
  }

  async getConfiguredHubAddresses() {
    const settings = await Settings.getSettings();
    const fromSettings = this.parseConfiguredHubAddresses(settings?.harmonyHubAddresses || '');
    const fromEnv = this.parseConfiguredHubAddresses(process.env.HARMONY_HUB_IPS || '');
    return toUniqueHostList([...fromSettings, ...fromEnv]);
  }

  _clearBackgroundMonitorTimer() {
    if (this.backgroundMonitorTimer) {
      clearTimeout(this.backgroundMonitorTimer);
      this.backgroundMonitorTimer = null;
    }
  }

  _scheduleBackgroundMonitoringPass(delayMs = this.backgroundMonitorIntervalMs, reason = 'interval') {
    if (!this.backgroundMonitoringStarted) {
      return;
    }

    this._clearBackgroundMonitorTimer();
    const boundedDelayMs = Math.max(0, Number(delayMs) || 0);
    this.backgroundMonitorTimer = setTimeout(() => {
      this.backgroundMonitorTimer = null;
      this.runBackgroundMonitoringPass(reason).catch((error) => {
        console.warn(`HarmonyService: background monitoring pass failed (${reason}): ${error.message}`);
      });
    }, boundedDelayMs);

    if (typeof this.backgroundMonitorTimer.unref === 'function') {
      this.backgroundMonitorTimer.unref();
    }
  }

  async getMonitoringHubIps() {
    const [trackedHubIps, configuredHubIps, knownHubs] = await Promise.all([
      Device.distinct('properties.harmonyHubIp', { 'properties.source': 'harmony' }),
      this.getConfiguredHubAddresses(),
      this.getKnownHubRegistry()
    ]);

    return toUniqueHostList([
      ...trackedHubIps,
      ...configuredHubIps,
      ...knownHubs.map((hub) => hub.ip)
    ]);
  }

  async runBackgroundMonitoringPass(reason = 'interval') {
    if (!this.backgroundMonitoringStarted || this.backgroundMonitorInProgress) {
      return;
    }

    this.backgroundMonitorInProgress = true;

    try {
      const hubIps = await this.getMonitoringHubIps();
      if (hubIps.length > 0) {
        await this.syncActivityStates({ hubIps, force: true });
      }
    } catch (error) {
      console.warn(`HarmonyService: background monitoring pass failed (${reason}): ${error.message}`);
    } finally {
      this.backgroundMonitorInProgress = false;
      if (this.backgroundMonitoringStarted) {
        this._scheduleBackgroundMonitoringPass(this.backgroundMonitorIntervalMs, 'interval');
      }
    }
  }

  startBackgroundMonitoring({ immediate = true } = {}) {
    if (this.backgroundMonitoringStarted) {
      return;
    }

    this.backgroundMonitoringStarted = true;
    this._scheduleBackgroundMonitoringPass(immediate ? 0 : this.backgroundMonitorIntervalMs, 'startup');
  }

  stopBackgroundMonitoring() {
    this.backgroundMonitoringStarted = false;
    this.backgroundMonitorInProgress = false;
    this._clearBackgroundMonitorTimer();
  }

  async discoverHubs(options = {}) {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_DISCOVERY_TIMEOUT_MS);
    const force = Boolean(options.force);
    const now = Date.now();

    if (
      !force &&
      this.discoveryCache.length > 0 &&
      now - this.discoveryCacheAt < this.discoveryCacheMs
    ) {
      return this.discoveryCache.map((hub) => ({ ...hub }));
    }

    if (this.discoveryPromise) {
      const result = await this.discoveryPromise;
      return result.map((hub) => ({ ...hub }));
    }

    const discoveryTask = this.runDiscovery({ timeoutMs, force });
    this.discoveryPromise = discoveryTask;

    try {
      const result = await discoveryTask;
      return result.map((hub) => ({ ...hub }));
    } finally {
      if (this.discoveryPromise === discoveryTask) {
        this.discoveryPromise = null;
      }
    }
  }

  async runDiscovery({ timeoutMs, force }) {
    const normalizedTimeoutMs = Math.max(1500, Number(timeoutMs) || DEFAULT_DISCOVERY_TIMEOUT_MS);

    const [configuredHosts, knownHubs] = await Promise.all([
      this.getConfiguredHubAddresses(),
      this.getKnownHubRegistry()
    ]);
    const hubMap = new Map();

    knownHubs.forEach((hub) => {
      hubMap.set(hub.ip, {
        ip: hub.ip,
        friendlyName: (hub.friendlyName || this.hubMetadata.get(hub.ip)?.friendlyName || '').toString().trim(),
        discovered: false,
        source: 'remembered',
        lastSeen: toDateOrNull(hub.lastSeenAt || hub.lastDiscoveredAt)
      });
    });

    configuredHosts.forEach((host) => {
      const existing = hubMap.get(host) || {};
      hubMap.set(host, {
        ip: host,
        friendlyName: (existing.friendlyName || this.hubMetadata.get(host)?.friendlyName || '').toString().trim(),
        discovered: Boolean(existing.discovered),
        source: mergeHubSources(existing.source, 'configured'),
        lastSeen: existing.lastSeen || null
      });
    });

    const explorer = new this.ExplorerClass(
      DEFAULT_DISCOVERY_INCOMING_PORT,
      {
        address: process.env.HARMONY_DISCOVERY_ADDRESS || '255.255.255.255',
        port: DEFAULT_DISCOVERY_TARGET_PORT,
        interval: DEFAULT_DISCOVERY_INTERVAL_MS
      }
    );
    let lowLevelError = null;

    const rememberLowLevelError = (error) => {
      if (lowLevelError) {
        return;
      }

      lowLevelError = error instanceof Error ? error : new Error(String(error || 'Unknown Harmony discovery error'));
      console.warn(`HarmonyService: discovery socket error: ${lowLevelError.message}`);
    };

    const rememberHub = (hub) => {
      const ip = normalizeHost(hub?.ip);
      if (!ip) {
        return;
      }

      const existing = hubMap.get(ip) || {};
      const friendlyName = (hub?.friendlyName || existing.friendlyName || '').toString().trim();
      const lastSeen = hub?.lastSeen ? new Date(hub.lastSeen) : new Date();

      const source = mergeHubSources(existing.source, 'discovered');

      hubMap.set(ip, {
        ip,
        friendlyName,
        uuid: hub?.uuid || existing.uuid || null,
        remoteId: hub?.fullHubInfo?.remoteId || existing.remoteId || null,
        discovered: true,
        source,
        lastSeen
      });

      this.hubMetadata.set(ip, {
        ip,
        friendlyName,
        remoteId: hub?.fullHubInfo?.remoteId || null,
        uuid: hub?.uuid || null,
        lastSeen: Date.now()
      });
    };

    explorer.on('online', rememberHub);
    explorer.on('update', (hubs) => {
      if (!Array.isArray(hubs)) {
        return;
      }
      hubs.forEach(rememberHub);
    });
    explorer.on('error', rememberLowLevelError);

    try {
      explorer.start();

      // The discovery package exposes the underlying TCP/UDP handles after start().
      // Attach defensive listeners so bind/socket failures become warnings instead of process exits.
      explorer.responseCollector?.server?.on?.('error', rememberLowLevelError);
      explorer.ping?.socket?.on?.('error', rememberLowLevelError);

      let errorInterval = null;
      await Promise.race([
        this.sleepImpl(normalizedTimeoutMs),
        new Promise((resolve) => {
          errorInterval = setInterval(() => {
            if (!lowLevelError) {
              return;
            }

            clearInterval(errorInterval);
            resolve();
          }, 25);

          if (typeof errorInterval.unref === 'function') {
            errorInterval.unref();
          }
        })
      ]);

      if (errorInterval) {
        clearInterval(errorInterval);
      }
    } catch (error) {
      console.warn(`HarmonyService: discovery failed: ${error.message}`);
    } finally {
      try {
        explorer.stop();
      } catch (error) {
        console.warn(`HarmonyService: discovery stop failed: ${error.message}`);
      }
    }

    const discovered = Array.from(hubMap.values())
      .sort((left, right) => {
        const leftName = (left.friendlyName || left.ip || '').toString().toLowerCase();
        const rightName = (right.friendlyName || right.ip || '').toString().toLowerCase();
        return leftName.localeCompare(rightName);
      });

    this.discoveryCache = discovered;
    this.discoveryCacheAt = Date.now();

    await this.mergeKnownHubs(discovered.map((hub) => ({
      ip: hub.ip,
      friendlyName: hub.friendlyName,
      discovered: Boolean(hub.discovered),
      lastSeenAt: hub.lastSeen || null,
      lastDiscoveredAt: hub.discovered ? (hub.lastSeen || new Date()) : null
    })));

    return discovered.map((hub) => ({ ...hub }));
  }

  async withClient(hubIp, operation) {
    const normalizedHubIp = normalizeHost(hubIp);
    if (!normalizedHubIp) {
      throw new Error('Harmony hub IP/host is required');
    }

    const metadata = this.hubMetadata.get(normalizedHubIp);
    const options = metadata?.remoteId ? { remoteId: metadata.remoteId } : {};
    const client = await this.getHarmonyClientImpl(normalizedHubIp, options);

    try {
      return await operation(client, normalizedHubIp);
    } finally {
      try {
        client.end();
      } catch (error) {
        console.warn(`HarmonyService: failed to close client for ${normalizedHubIp}: ${error.message}`);
      }
    }
  }

  inferFriendlyName(hubIp, config = {}) {
    const fromConfig =
      config?.global?.friendlyName ||
      config?.global?.hubName ||
      config?.hubName ||
      config?.friendlyName ||
      null;

    const fromCache = this.hubMetadata.get(hubIp)?.friendlyName || null;
    return (fromConfig || fromCache || `Harmony Hub ${hubIp}`).toString().trim();
  }

  extractDeviceCommands(device = {}) {
    const commandMap = new Map();
    const controlGroups = Array.isArray(device.controlGroup) ? device.controlGroup : [];

    controlGroups.forEach((group) => {
      const functions = Array.isArray(group?.function) ? group.function : [];
      functions.forEach((fn) => {
        const commandName = (fn?.name || fn?.label || '').toString().trim();
        if (!commandName) {
          return;
        }
        const key = normalizeCommandName(commandName);
        if (commandMap.has(key)) {
          return;
        }
        commandMap.set(key, {
          name: commandName,
          label: (fn?.label || commandName).toString(),
          action: typeof fn?.action === 'string' ? fn.action : null
        });
      });
    });

    return Array.from(commandMap.values());
  }

  extractPowerCommands(commands = []) {
    const normalizedCommands = Array.isArray(commands) ? commands : [];
    const powerCommands = {
      on: null,
      off: null,
      toggle: null
    };

    const scoreCommand = (command, kind) => {
      const keys = [
        compactHarmonyCommandKey(command?.name),
        compactHarmonyCommandKey(command?.label)
      ].filter(Boolean);

      if (keys.length === 0) {
        return 0;
      }

      const exactMatches = {
        on: new Set(['poweron', 'on', 'deviceon']),
        off: new Set(['poweroff', 'off', 'deviceoff']),
        toggle: new Set(['powertoggle', 'toggle', 'power'])
      };
      const prefixMatches = {
        on: ['poweron', 'deviceon'],
        off: ['poweroff', 'deviceoff'],
        toggle: ['powertoggle']
      };

      let bestScore = 0;
      keys.forEach((key) => {
        if (exactMatches[kind].has(key)) {
          bestScore = Math.max(bestScore, 100);
        }

        if (prefixMatches[kind].some((prefix) => key.startsWith(prefix))) {
          bestScore = Math.max(bestScore, 90);
        }

        if (kind === 'toggle' && key.includes('toggle') && key.includes('power')) {
          bestScore = Math.max(bestScore, 80);
        }

        if (kind !== 'toggle' && key.includes('power') && key.endsWith(kind)) {
          bestScore = Math.max(bestScore, 75);
        }
      });

      return bestScore;
    };

    normalizedCommands.forEach((command) => {
      ['on', 'off', 'toggle'].forEach((kind) => {
        const nextScore = scoreCommand(command, kind);
        if (nextScore <= 0) {
          return;
        }

        const currentScore = scoreCommand(powerCommands[kind], kind);
        if (!powerCommands[kind] || nextScore > currentScore) {
          powerCommands[kind] = command;
        }
      });
    });

    return powerCommands;
  }

  scoreHarmonyCommandMatcher(command, matcher = {}) {
    const compactKeys = [
      compactHarmonyCommandKey(command?.name),
      compactHarmonyCommandKey(command?.label)
    ].filter(Boolean);
    const normalizedText = [
      normalizeCommandName(command?.name),
      normalizeCommandName(command?.label)
    ]
      .filter(Boolean)
      .join(' ');
    const paddedText = ` ${normalizedText} `;

    let bestScore = 0;

    compactKeys.forEach((key) => {
      if (Array.isArray(matcher.exact) && matcher.exact.includes(key)) {
        bestScore = Math.max(bestScore, 100);
      }

      if (Array.isArray(matcher.startsWith) && matcher.startsWith.some((prefix) => key.startsWith(prefix))) {
        bestScore = Math.max(bestScore, 90);
      }
    });

    if (Array.isArray(matcher.textAll)) {
      matcher.textAll.forEach((terms) => {
        if (Array.isArray(terms) && terms.every((term) => paddedText.includes(` ${normalizeCommandName(term)} `) || normalizedText.includes(normalizeCommandName(term)))) {
          bestScore = Math.max(bestScore, 80);
        }
      });
    }

    if (Array.isArray(matcher.textAny) && matcher.textAny.some((term) => normalizedText.includes(normalizeCommandName(term)))) {
      bestScore = Math.max(bestScore, 65);
    }

    return bestScore;
  }

  classifyHarmonyCommand(command = {}) {
    const compactKeys = [
      compactHarmonyCommandKey(command?.name),
      compactHarmonyCommandKey(command?.label)
    ].filter(Boolean);
    const normalizedText = [
      normalizeCommandName(command?.name),
      normalizeCommandName(command?.label)
    ]
      .filter(Boolean)
      .join(' ');

    let bestMatch = {
      category: 'other',
      capability: null,
      score: 0
    };

    compactKeys.forEach((key) => {
      const digitMatch = key.match(/^(?:number|num|digit|numpad)?([0-9])$/);
      if (digitMatch) {
        bestMatch = {
          category: 'numeric',
          capability: `digit_${digitMatch[1]}`,
          score: 100
        };
      }
    });

    if (bestMatch.score < 100) {
      HARMONY_CONTROL_MATCHERS.forEach((matcher) => {
        const score = this.scoreHarmonyCommandMatcher(command, matcher);
        if (score > bestMatch.score) {
          bestMatch = {
            category: matcher.category,
            capability: matcher.capability,
            score
          };
        }
      });
    }

    if (bestMatch.score > 0) {
      return bestMatch;
    }

    if (/(^|\s)(hdmi|input|source|tv|aux|game|blu-ray|bluray)(\s|$)/i.test(normalizedText)) {
      return {
        category: 'input',
        capability: null,
        score: 60
      };
    }

    if (normalizedText.includes('power')) {
      return {
        category: 'power',
        capability: null,
        score: 50
      };
    }

    return bestMatch;
  }

  buildHarmonyCommandCatalog(commands = []) {
    const normalizedCommands = Array.isArray(commands) ? commands : [];

    return normalizedCommands
      .map((command) => {
        const classification = this.classifyHarmonyCommand(command);
        const name = (command?.name || '').toString().trim();
        if (!name) {
          return null;
        }

        return {
          name,
          label: (command?.label || name).toString(),
          category: classification.category || 'other',
          capability: classification.capability || null
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        const leftCategoryIndex = HARMONY_COMMAND_CATEGORY_ORDER.indexOf(left.category);
        const rightCategoryIndex = HARMONY_COMMAND_CATEGORY_ORDER.indexOf(right.category);
        if (leftCategoryIndex !== rightCategoryIndex) {
          return (leftCategoryIndex === -1 ? HARMONY_COMMAND_CATEGORY_ORDER.length : leftCategoryIndex)
            - (rightCategoryIndex === -1 ? HARMONY_COMMAND_CATEGORY_ORDER.length : rightCategoryIndex);
        }

        return left.label.localeCompare(right.label);
      });
  }

  extractControlCommands(commands = []) {
    const controlCommands = {};
    const bestScores = new Map();

    (Array.isArray(commands) ? commands : []).forEach((command) => {
      const classification = this.classifyHarmonyCommand(command);
      if (!classification?.capability || classification.score <= 0) {
        return;
      }

      const existingScore = bestScores.get(classification.capability) || 0;
      if (existingScore >= classification.score) {
        return;
      }

      controlCommands[classification.capability] = command.name;
      bestScores.set(classification.capability, classification.score);
    });

    return controlCommands;
  }

  normalizeActivities(config = {}) {
    const activities = Array.isArray(config?.activity) ? config.activity : [];
    return activities
      .filter((activity) => activity && activity.id !== undefined && activity.id !== null)
      .map((activity) => ({
        id: activity.id.toString(),
        label: (activity.label || `Activity ${activity.id}`).toString(),
        isOff: activity.id.toString() === '-1',
        isAVActivity: Boolean(activity.isAVActivity),
        activityTypeDisplayName: activity.activityTypeDisplayName || null,
        icon: activity.icon || null
      }));
  }

  normalizeDevices(config = {}) {
    const devices = Array.isArray(config?.device) ? config.device : [];
    return devices.map((device) => ({
      id: (device?.id || '').toString(),
      label: (device?.label || device?.name || device?.id || 'Unknown device').toString(),
      manufacturer: (device?.manufacturer || '').toString(),
      model: (device?.model || '').toString(),
      commands: this.extractDeviceCommands(device)
    }));
  }

  buildHarmonyCommandDevice(snapshot, device, existing = null) {
    const commands = Array.isArray(device?.commands) ? device.commands : [];
    const powerCommands = this.extractPowerCommands(commands);
    const commandCatalog = this.buildHarmonyCommandCatalog(commands);
    const controlCommands = this.extractControlCommands(commands);
    const previousStatus = typeof existing?.status === 'boolean' ? existing.status : false;

    return {
      name: (device?.label || device?.id || 'Harmony Device').toString(),
      type: 'switch',
      room: snapshot.friendlyName || 'Harmony',
      status: previousStatus,
      brightness: 0,
      properties: {
        source: 'harmony',
        harmonyEntityType: HARMONY_ENTITY_TYPES.DEVICE,
        harmonyHubIp: snapshot.ip,
        harmonyHubName: snapshot.friendlyName,
        harmonyRemoteId: trimHarmonyValue(snapshot?.remoteId) || null,
        harmonyDeviceId: (device?.id || '').toString(),
        harmonyDeviceLabel: (device?.label || device?.id || 'Unknown device').toString(),
        harmonyCommandCount: commands.length,
        harmonyCommands: commandCatalog,
        harmonyControlCommands: controlCommands,
        harmonyPowerCommands: {
          on: powerCommands.on?.name || null,
          off: powerCommands.off?.name || null,
          toggle: powerCommands.toggle?.name || null
        }
      },
      brand: (device?.manufacturer || 'Logitech Harmony').toString(),
      model: (device?.model || 'Hub Device').toString(),
      isOnline: true,
      lastSeen: new Date()
    };
  }

  async findMatchingHarmonyActivityRows(snapshot, activity, identityQuery = null) {
    const exactMatches = identityQuery
      ? await Device.find(identityQuery)
      : [];
    const hubRoom = (snapshot?.friendlyName || 'Harmony').toString();
    const activityId = trimHarmonyValue(activity?.id);
    const activityLabel = trimHarmonyValue(activity?.label);
    const activityName = `${hubRoom} - ${activityLabel || activityId || 'Activity'}`;
    const activityLabelKey = normalizeHarmonyDuplicateName(activityLabel);
    const snapshotRemoteId = trimHarmonyValue(snapshot?.remoteId);
    const snapshotHubName = normalizeCommandName(snapshot?.friendlyName);
    const shouldCheckFallback = exactMatches.length === 0 || Boolean(snapshotRemoteId);

    if (!shouldCheckFallback) {
      return exactMatches;
    }

    const activityNameMatch = buildHarmonyDuplicateNameMatch(activityName);
    if (!activityNameMatch) {
      return exactMatches;
    }

    const fallbackCandidates = await Device.find({
      'properties.source': 'harmony',
      room: hubRoom,
      name: activityNameMatch,
      $or: [
        { 'properties.harmonyEntityType': HARMONY_ENTITY_TYPES.ACTIVITY },
        {
          'properties.harmonyEntityType': { $exists: false },
          'properties.harmonyDeviceId': { $exists: false }
        }
      ]
    });

    const filteredFallback = fallbackCandidates.filter((candidate) => {
      const existingProperties = candidate?.properties && typeof candidate.properties === 'object'
        ? candidate.properties
        : {};
      const existingDeviceId = trimHarmonyValue(existingProperties.harmonyDeviceId);
      const existingActivityId = trimHarmonyValue(existingProperties.harmonyActivityId);
      const existingRemoteId = trimHarmonyValue(existingProperties.harmonyRemoteId);
      const existingActivityLabel = normalizeHarmonyDuplicateName(existingProperties.harmonyActivityLabel || candidate?.name);
      const existingHubName = normalizeCommandName(existingProperties.harmonyHubName || candidate?.room);

      if (existingDeviceId) {
        return false;
      }
      if (existingActivityId && activityId && existingActivityId !== activityId) {
        return false;
      }
      if (snapshotRemoteId && existingRemoteId && existingRemoteId !== snapshotRemoteId) {
        return false;
      }
      if (activityLabelKey && existingActivityLabel && existingActivityLabel !== activityLabelKey) {
        return false;
      }
      if (snapshotHubName && existingHubName && existingHubName !== snapshotHubName) {
        return false;
      }

      return true;
    });

    return mergeUniqueDevices(exactMatches, filteredFallback);
  }

  async findMatchingHarmonyDeviceRows(snapshot, device, identityQuery = null) {
    const exactMatches = identityQuery
      ? await Device.find(identityQuery)
      : [];
    const hubRoom = (snapshot?.friendlyName || 'Harmony').toString();
    const harmonyDeviceId = trimHarmonyValue(device?.id);
    const deviceLabel = trimHarmonyValue(device?.label || harmonyDeviceId || 'Harmony Device');
    const snapshotRemoteId = trimHarmonyValue(snapshot?.remoteId);
    const snapshotHubName = normalizeCommandName(snapshot?.friendlyName);
    const deviceLabelKey = normalizeHarmonyDuplicateName(deviceLabel);
    const manufacturerKey = normalizeCommandName(device?.manufacturer);
    const modelKey = normalizeCommandName(device?.model);
    const shouldCheckFallback = exactMatches.length === 0 || Boolean(snapshotRemoteId);

    if (!shouldCheckFallback) {
      return exactMatches;
    }

    const deviceNameMatch = buildHarmonyDuplicateNameMatch(deviceLabel);
    if (!deviceNameMatch) {
      return exactMatches;
    }

    const fallbackCandidates = await Device.find({
      'properties.source': 'harmony',
      room: hubRoom,
      name: deviceNameMatch,
      $or: [
        { 'properties.harmonyEntityType': HARMONY_ENTITY_TYPES.DEVICE },
        {
          'properties.harmonyEntityType': { $exists: false },
          'properties.harmonyActivityId': { $exists: false }
        }
      ]
    });

    const hasConflictingKnownIdentity = fallbackCandidates.some((candidate) => {
      const existingDeviceId = trimHarmonyValue(candidate?.properties?.harmonyDeviceId);
      return existingDeviceId && existingDeviceId !== harmonyDeviceId;
    });

    const filteredFallback = hasConflictingKnownIdentity
      ? []
      : fallbackCandidates.filter((candidate) => {
        const existingProperties = candidate?.properties && typeof candidate.properties === 'object'
          ? candidate.properties
          : {};
        const existingActivityId = trimHarmonyValue(existingProperties.harmonyActivityId);
        const existingDeviceId = trimHarmonyValue(existingProperties.harmonyDeviceId);
        const existingRemoteId = trimHarmonyValue(existingProperties.harmonyRemoteId);
        const existingDeviceLabel = normalizeHarmonyDuplicateName(existingProperties.harmonyDeviceLabel || candidate?.name);
        const existingHubName = normalizeCommandName(existingProperties.harmonyHubName || candidate?.room);
        const candidateBrand = normalizeCommandName(candidate?.brand);
        const candidateModel = normalizeCommandName(candidate?.model);

        if (existingActivityId) {
          return false;
        }
        if (existingDeviceId && harmonyDeviceId && existingDeviceId !== harmonyDeviceId) {
          return false;
        }
        if (snapshotRemoteId && existingRemoteId && existingRemoteId !== snapshotRemoteId) {
          return false;
        }
        if (deviceLabelKey && existingDeviceLabel && existingDeviceLabel !== deviceLabelKey) {
          return false;
        }
        if (snapshotHubName && existingHubName && existingHubName !== snapshotHubName) {
          return false;
        }
        if (manufacturerKey && candidateBrand && candidateBrand !== manufacturerKey) {
          return false;
        }
        if (modelKey && candidateModel && candidateModel !== modelKey) {
          return false;
        }

        return true;
      });

    return mergeUniqueDevices(exactMatches, filteredFallback);
  }

  async upsertDiscoveredDevice({
    identityQuery,
    matchingDevices = null,
    payload,
    preserveStatus = false,
    summary,
    duplicateLabel = 'Harmony row'
  }) {
    const discoveredMatches = Array.isArray(matchingDevices)
      ? matchingDevices
      : (identityQuery ? await Device.find(identityQuery) : []);
    const existing = selectCanonicalDevice(discoveredMatches);
    const duplicateDevices = discoveredMatches.filter((candidate) => (
      String(candidate?._id || '') !== String(existing?._id || '')
    ));

    if (!existing) {
      await Device.create(payload);
      if (summary) {
        summary.created += 1;
      }
      return { created: true };
    }

    mergeDuplicateDeviceGroups(existing, duplicateDevices);
    existing.name = payload.name;
    existing.type = payload.type;
    existing.room = payload.room;
    existing.brightness = payload.brightness;
    existing.brand = payload.brand;
    existing.model = payload.model;
    existing.isOnline = payload.isOnline !== false;
    existing.lastSeen = payload.lastSeen || new Date();
    if (!preserveStatus || typeof existing.status !== 'boolean') {
      existing.status = payload.status;
    }
    existing.properties = {
      ...(existing?.properties && typeof existing.properties === 'object'
        ? existing.properties
        : {}),
      ...(payload?.properties && typeof payload.properties === 'object'
        ? payload.properties
        : {})
    };
    await existing.save();

    const duplicateIds = duplicateDevices
      .map((candidate) => String(candidate?._id || ''))
      .filter(Boolean);
    if (duplicateIds.length > 0) {
      await Device.deleteMany({ _id: { $in: duplicateIds } });
      if (summary) {
        summary.deduped += duplicateIds.length;
      }
      console.warn(
        `HarmonyService: Removed ${duplicateIds.length} duplicate HomeBrain ${duplicateLabel}(s): ${describeDevices(duplicateDevices)}`
      );
    }

    if (summary) {
      summary.updated += 1;
    }

    return { created: false, existing };
  }

  findConfigDevice(devices = [], deviceIdOrName = '') {
    const normalizedDeviceKey = normalizeCommandName(deviceIdOrName);
    if (!normalizedDeviceKey) {
      return null;
    }

    return (Array.isArray(devices) ? devices : []).find((device) => {
      const id = normalizeCommandName(device?.id);
      const label = normalizeCommandName(device?.label);
      return id === normalizedDeviceKey || label === normalizedDeviceKey;
    }) || null;
  }

  resolvePowerCommand(commands = [], desiredState = 'off', options = {}) {
    const powerCommands = this.extractPowerCommands(commands);
    const normalizedState = desiredState === 'on' ? 'on' : 'off';
    const explicitCommand = powerCommands[normalizedState];
    if (explicitCommand) {
      return {
        command: explicitCommand,
        kind: normalizedState
      };
    }

    if (options.allowToggleFallback === true && powerCommands.toggle) {
      return {
        command: powerCommands.toggle,
        kind: 'toggle'
      };
    }

    return null;
  }

  async getHubSnapshot(hubIp, options = {}) {
    return this.withClient(hubIp, async (client, normalizedHubIp) => {
      const [config, currentActivityId] = await Promise.all([
        client.getAvailableCommands(),
        client.getCurrentActivity()
      ]);

      const activities = this.normalizeActivities(config);
      const devices = this.normalizeDevices(config);
      const currentActivity = currentActivityId != null ? currentActivityId.toString() : '-1';
      const currentActivityLabel = currentActivity === '-1'
        ? 'Off'
        : (activities.find((activity) => activity.id === currentActivity)?.label || null);
      const friendlyName = this.inferFriendlyName(normalizedHubIp, config);
      const now = new Date();

      const metadata = this.hubMetadata.get(normalizedHubIp) || {};
      this.hubMetadata.set(normalizedHubIp, {
        ip: normalizedHubIp,
        friendlyName,
        remoteId: client.remoteId || metadata.remoteId || null,
        uuid: metadata.uuid || null,
        lastSeen: Date.now()
      });

      if (options.persist !== false) {
        await this.mergeKnownHubs([{
          ip: normalizedHubIp,
          friendlyName,
          lastSeenAt: now,
          lastSnapshotAt: now,
          lastKnownActivityId: currentActivity,
          lastKnownActivityLabel: currentActivityLabel
        }]);
      }

      return {
        ip: normalizedHubIp,
        friendlyName,
        remoteId: client.remoteId || metadata.remoteId || null,
        currentActivityId: currentActivity,
        currentActivityLabel,
        lastSeen: now,
        lastSnapshotAt: now,
        isOff: currentActivity === '-1',
        activities: activities.filter((activity) => !activity.isOff),
        rawActivities: activities,
        devices: options.includeCommands === false
          ? devices.map((device) => ({
            id: device.id,
            label: device.label,
            manufacturer: device.manufacturer,
            model: device.model
          }))
          : devices
      };
    });
  }

  async getHubs(options = {}) {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_DISCOVERY_TIMEOUT_MS);
    const discover = options.discover !== false;
    const includeCommands = options.includeCommands !== false;

    const [knownHubs, baseCandidates] = await Promise.all([
      this.getKnownHubRegistry(),
      discover
        ? this.discoverHubs({ timeoutMs, force: false })
        : this.getConfiguredHubAddresses().then((hosts) => hosts.map((host) => ({
          ip: host,
          source: 'configured'
        })))
    ]);

    const knownHubMap = new Map(knownHubs.map((hub) => [hub.ip, hub]));
    const candidateMap = new Map();

    knownHubs.forEach((hub) => {
      candidateMap.set(hub.ip, {
        ip: hub.ip,
        friendlyName: (hub.friendlyName || this.hubMetadata.get(hub.ip)?.friendlyName || '').toString().trim(),
        source: 'remembered',
        discovered: false,
        lastSeen: toDateOrNull(hub.lastSeenAt || hub.lastDiscoveredAt)
      });
    });

    baseCandidates.forEach((candidate) => {
      const ip = normalizeHost(candidate?.ip);
      if (!ip) {
        return;
      }
      const existing = candidateMap.get(ip) || {};
      candidateMap.set(ip, {
        ...existing,
        ip,
        friendlyName: (candidate?.friendlyName || existing.friendlyName || this.hubMetadata.get(ip)?.friendlyName || '').toString().trim(),
        source: mergeHubSources(existing.source, candidate?.source || (discover ? 'discovered' : 'configured')),
        discovered: Boolean(existing.discovered || candidate?.discovered),
        lastSeen: toDateOrNull(candidate?.lastSeen || existing.lastSeen)
      });
    });

    const candidates = Array.from(candidateMap.values());
    const hubs = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const snapshot = await this.getHubSnapshot(candidate.ip, { includeCommands, persist: false });
          return {
            success: true,
            source: candidate.source || 'unknown',
            ...snapshot
          };
        } catch (error) {
          return {
            success: false,
            source: candidate.source || 'unknown',
            ip: candidate.ip,
            friendlyName: candidate.friendlyName || `Harmony Hub ${candidate.ip}`,
            lastSeen: candidate.lastSeen || null,
            error: error.message
          };
        }
      })
    );

    const statsMap = await this.getHubDeviceStatsMap(candidates.map((candidate) => candidate.ip));
    const registryUpdates = [];

    const hydrated = hubs.map((hub) => {
      const known = knownHubMap.get(hub.ip) || null;
      const stats = statsMap.get(hub.ip) || {
        trackedActivityDevices: 0,
        onlineActivityDevices: 0,
        activeActivityDevices: 0,
        lastActivityDeviceSeenAt: null,
        lastActivityDeviceUpdatedAt: null
      };

      const friendlyName = (hub.friendlyName || known?.friendlyName || `Harmony Hub ${hub.ip}`).toString();
      const currentActivityId = hub.currentActivityId != null
        ? hub.currentActivityId.toString()
        : (known?.lastKnownActivityId || null);
      const currentActivityLabel = hub.currentActivityLabel ||
        known?.lastKnownActivityLabel ||
        (currentActivityId === '-1' ? 'Off' : null);

      registryUpdates.push({
        ip: hub.ip,
        friendlyName,
        discovered: hub.success === true,
        lastSeenAt: hub.lastSeen || null,
        lastSnapshotAt: hub.success ? (hub.lastSnapshotAt || new Date()) : null,
        lastKnownActivityId: hub.success ? currentActivityId : undefined,
        lastKnownActivityLabel: hub.success ? currentActivityLabel : undefined
      });

      return {
        ...hub,
        friendlyName,
        currentActivityId,
        currentActivityLabel,
        trackedActivityDevices: stats.trackedActivityDevices,
        onlineActivityDevices: stats.onlineActivityDevices,
        activeActivityDevices: stats.activeActivityDevices,
        lastActivityDeviceSeenAt: stats.lastActivityDeviceSeenAt,
        lastActivityDeviceUpdatedAt: stats.lastActivityDeviceUpdatedAt,
        firstDiscoveredAt: known?.firstDiscoveredAt || null,
        lastDiscoveredAt: known?.lastDiscoveredAt || null,
        lastSeenAt: hub.lastSeen || known?.lastSeenAt || null,
        lastSnapshotAt: hub.lastSnapshotAt || known?.lastSnapshotAt || null,
        lastDeviceSyncAt: known?.lastDeviceSyncAt || null,
        lastDeviceSyncStatus: known?.lastDeviceSyncStatus || 'unknown',
        lastDeviceSyncError: known?.lastDeviceSyncError || '',
        lastActivitySyncAt: known?.lastActivitySyncAt || null,
        lastActivitySyncStatus: known?.lastActivitySyncStatus || 'unknown',
        lastActivitySyncError: known?.lastActivitySyncError || '',
        remembered: Boolean(known)
      };
    });

    await this.mergeKnownHubs(registryUpdates);

    return hydrated.sort((left, right) => {
      const leftName = (left.friendlyName || left.ip || '').toString().toLowerCase();
      const rightName = (right.friendlyName || right.ip || '').toString().toLowerCase();
      return leftName.localeCompare(rightName);
    });
  }

  async getStatus(options = {}) {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_DISCOVERY_TIMEOUT_MS);
    const [configuredHubAddresses, discoveredHubs, knownHubs, trackedDevices, onlineDevices] = await Promise.all([
      this.getConfiguredHubAddresses(),
      this.discoverHubs({ timeoutMs, force: false }),
      this.getKnownHubRegistry(),
      Device.countDocuments({ 'properties.source': 'harmony' }),
      Device.countDocuments({ 'properties.source': 'harmony', isOnline: true })
    ]);

    return {
      configuredHubAddresses,
      discoveredHubs,
      discoveredCount: discoveredHubs.filter((hub) => hub.discovered).length,
      knownHubCount: knownHubs.length,
      trackedDevices,
      onlineDevices
    };
  }

  buildHarmonyActivityDevice(snapshot, activity) {
    const activityId = activity.id.toString();
    const currentActivityId = snapshot.currentActivityId != null
      ? snapshot.currentActivityId.toString()
      : '-1';

    return {
      name: `${snapshot.friendlyName} - ${activity.label}`,
      type: 'switch',
      room: snapshot.friendlyName || 'Harmony',
      status: currentActivityId === activityId,
      brightness: 0,
      properties: {
        source: 'harmony',
        harmonyEntityType: HARMONY_ENTITY_TYPES.ACTIVITY,
        harmonyHubIp: snapshot.ip,
        harmonyHubName: snapshot.friendlyName,
        harmonyRemoteId: trimHarmonyValue(snapshot?.remoteId) || null,
        harmonyActivityId: activityId,
        harmonyActivityLabel: activity.label,
        harmonyActivityType: activity.activityTypeDisplayName || null,
        harmonyActivityIsAv: Boolean(activity.isAVActivity)
      },
      brand: 'Logitech Harmony',
      model: 'Hub Activity',
      isOnline: true,
      lastSeen: new Date()
    };
  }

  async markHubDevicesOffline(hubIp) {
    const normalizedHubIp = normalizeHost(hubIp);
    if (!normalizedHubIp) {
      return 0;
    }

    const devices = await Device.find({
      ...buildHarmonyActivityMatch(normalizedHubIp)
    });

    const changed = [];
    for (const device of devices) {
      if (device.isOnline !== false) {
        device.isOnline = false;
        device.updatedAt = new Date();
        await device.save();
        changed.push(device);
      }
    }

    if (changed.length > 0) {
      const payload = deviceUpdateEmitter.normalizeDevices(changed);
      if (payload.length > 0) {
        deviceUpdateEmitter.emit('devices:update', payload);
      }
    }

    return changed.length;
  }

  async syncDevices(options = {}) {
    if (this.syncPromise) {
      return this.syncPromise;
    }

    this.syncPromise = (async () => {
      const timeoutMs = Number(options.timeoutMs || DEFAULT_DISCOVERY_TIMEOUT_MS);
      const discovered = await this.discoverHubs({ timeoutMs, force: true });
      const syncAt = new Date();
      const registryUpdates = [];

      const summary = {
        success: true,
        hubsFound: discovered.length,
        hubsSynced: 0,
        hubsFailed: 0,
        created: 0,
        updated: 0,
        deduped: 0,
        removed: 0,
        offlineMarked: 0,
        details: []
      };

      for (const hub of discovered) {
        try {
          const snapshot = await this.getHubSnapshot(hub.ip, { includeCommands: true });
          const activityIds = [];
          const deviceIds = [];

          for (const activity of snapshot.activities) {
            activityIds.push(activity.id.toString());
            const payload = this.buildHarmonyActivityDevice(snapshot, activity);
            const identityQuery = buildHarmonyActivityIdentityQuery(
              snapshot.ip,
              activity.id.toString(),
              snapshot.remoteId
            );
            const matchingDevices = await this.findMatchingHarmonyActivityRows(snapshot, activity, identityQuery);
            // Preserve any custom properties while keeping activity state authoritative.
            await this.upsertDiscoveredDevice({
              identityQuery,
              matchingDevices,
              payload,
              preserveStatus: false,
              summary,
              duplicateLabel: `activity row(s) for hub ${snapshot.ip} activity ${activity.id}`
            });
          }

          for (const device of Array.isArray(snapshot.devices) ? snapshot.devices : []) {
            const harmonyDeviceId = (device?.id || '').toString();
            if (!harmonyDeviceId) {
              continue;
            }

            deviceIds.push(harmonyDeviceId);
            const identityQuery = buildHarmonyDeviceIdentityQuery(
              snapshot.ip,
              harmonyDeviceId,
              snapshot.remoteId
            );
            const matchingDevices = await this.findMatchingHarmonyDeviceRows(snapshot, device, identityQuery);
            const existing = selectCanonicalDevice(matchingDevices);
            const payload = this.buildHarmonyCommandDevice(snapshot, device, existing);

            await this.upsertDiscoveredDevice({
              identityQuery,
              matchingDevices,
              payload,
              preserveStatus: true,
              summary,
              duplicateLabel: `device row(s) for hub ${snapshot.ip} device ${harmonyDeviceId}`
            });
          }

          const staleActivityResult = await Device.deleteMany(buildHarmonyActivityMatch(snapshot.ip, {
            'properties.harmonyActivityId': { $nin: activityIds }
          }, snapshot.remoteId));
          const staleDeviceResult = await Device.deleteMany(buildHarmonyDeviceMatch(snapshot.ip, {
            'properties.harmonyDeviceId': { $nin: deviceIds }
          }, snapshot.remoteId));
          summary.removed += (staleActivityResult.deletedCount || 0) + (staleDeviceResult.deletedCount || 0);

          summary.hubsSynced += 1;
          summary.details.push({
            hubIp: snapshot.ip,
            friendlyName: snapshot.friendlyName,
            activityCount: snapshot.activities.length,
            deviceCount: deviceIds.length,
            success: true
          });

          registryUpdates.push({
            ip: snapshot.ip,
            friendlyName: snapshot.friendlyName,
            discovered: true,
            lastSeenAt: snapshot.lastSeen || syncAt,
            lastSnapshotAt: snapshot.lastSnapshotAt || syncAt,
            lastKnownActivityId: snapshot.currentActivityId,
            lastKnownActivityLabel: snapshot.currentActivityLabel,
            lastDeviceSyncAt: syncAt,
            lastDeviceSyncStatus: 'success',
            lastDeviceSyncError: ''
          });
        } catch (error) {
          summary.hubsFailed += 1;
          const offlineCount = await this.markHubDevicesOffline(hub.ip);
          summary.offlineMarked += offlineCount;
          summary.details.push({
            hubIp: hub.ip,
            friendlyName: hub.friendlyName || `Harmony Hub ${hub.ip}`,
            success: false,
            error: error.message
          });

          registryUpdates.push({
            ip: hub.ip,
            friendlyName: hub.friendlyName || `Harmony Hub ${hub.ip}`,
            lastDeviceSyncAt: syncAt,
            lastDeviceSyncStatus: 'failed',
            lastDeviceSyncError: error.message || 'Sync failed'
          });
        }
      }

      await this.mergeKnownHubs(registryUpdates);
      await this.syncActivityStates();

      return summary;
    })();

    try {
      return await this.syncPromise;
    } finally {
      this.syncPromise = null;
    }
  }

  async updateHubActivityState(hubIp, activeActivityId, isOnline = true) {
    const normalizedHubIp = normalizeHost(hubIp);
    if (!normalizedHubIp) {
      return { updated: 0 };
    }

    const activeId = activeActivityId != null ? activeActivityId.toString() : '-1';
    const devices = await Device.find(buildHarmonyActivityMatch(normalizedHubIp));

    const changed = [];
    for (const device of devices) {
      const deviceActivityId = (device?.properties?.harmonyActivityId || '').toString();
      const shouldBeOn = activeId !== '-1' && deviceActivityId === activeId;
      const shouldBeOnline = Boolean(isOnline);

      if (device.status !== shouldBeOn || device.isOnline !== shouldBeOnline) {
        device.status = shouldBeOn;
        device.isOnline = shouldBeOnline;
        device.lastSeen = new Date();
        device.updatedAt = new Date();
        await device.save();
        changed.push(device);
      } else if (shouldBeOnline) {
        device.lastSeen = new Date();
        await device.save();
      }
    }

    if (changed.length > 0) {
      const payload = deviceUpdateEmitter.normalizeDevices(changed);
      if (payload.length > 0) {
        deviceUpdateEmitter.emit('devices:update', payload);
      }
    }

    return {
      hubIp: normalizedHubIp,
      activeActivityId: activeId,
      updated: changed.length
    };
  }

  async syncActivityStates(options = {}) {
    if (this.stateSyncPromise && !options.force) {
      return this.stateSyncPromise;
    }

    this.stateSyncPromise = (async () => {
      let hubIps = [];
      if (Array.isArray(options.hubIps) && options.hubIps.length > 0) {
        hubIps = toUniqueHostList(options.hubIps);
      } else {
        const [rawIps, configuredHosts, knownHubs] = await Promise.all([
          Device.distinct('properties.harmonyHubIp', {
            'properties.source': 'harmony'
          }),
          this.getConfiguredHubAddresses(),
          this.getKnownHubRegistry()
        ]);
        hubIps = toUniqueHostList([
          ...rawIps,
          ...configuredHosts,
          ...knownHubs.map((hub) => hub.ip)
        ]);
      }

      const summary = {
        success: true,
        hubs: hubIps.length,
        refreshed: 0,
        failed: 0,
        details: []
      };
      const syncAt = new Date();
      const registryUpdates = [];

      for (const hubIp of hubIps) {
        try {
          const currentActivityId = await this.withClient(hubIp, (client) => client.getCurrentActivity());
          const stateResult = await this.updateHubActivityState(hubIp, currentActivityId, true);
          const normalizedCurrentActivityId = currentActivityId != null ? currentActivityId.toString() : '-1';
          const activityLabel = await this.getActivityLabelForHub(hubIp, normalizedCurrentActivityId);

          summary.refreshed += 1;
          summary.details.push({
            hubIp,
            currentActivityId: normalizedCurrentActivityId,
            updatedDevices: stateResult.updated,
            success: true
          });

          registryUpdates.push({
            ip: hubIp,
            discovered: true,
            lastSeenAt: syncAt,
            lastKnownActivityId: normalizedCurrentActivityId,
            lastKnownActivityLabel: activityLabel,
            lastActivitySyncAt: syncAt,
            lastActivitySyncStatus: 'success',
            lastActivitySyncError: ''
          });
        } catch (error) {
          summary.failed += 1;
          await this.markHubDevicesOffline(hubIp);
          summary.details.push({
            hubIp,
            success: false,
            error: error.message
          });

          registryUpdates.push({
            ip: hubIp,
            lastActivitySyncAt: syncAt,
            lastActivitySyncStatus: 'failed',
            lastActivitySyncError: error.message || 'Activity state sync failed'
          });
        }
      }

      await this.mergeKnownHubs(registryUpdates);
      return summary;
    })();

    try {
      return await this.stateSyncPromise;
    } finally {
      this.stateSyncPromise = null;
    }
  }

  async startActivity(hubIp, activityId) {
    const normalizedHubIp = normalizeHost(hubIp);
    const normalizedActivityId = activityId != null ? activityId.toString() : '';

    if (!normalizedHubIp || !normalizedActivityId) {
      throw new Error('Harmony hub and activity are required');
    }

    await this.withClient(normalizedHubIp, (client) => client.startActivity(normalizedActivityId));
    await this.updateHubActivityState(normalizedHubIp, normalizedActivityId, true);
    await this.mergeKnownHubs([{
      ip: normalizedHubIp,
      discovered: true,
      lastSeenAt: new Date(),
      lastKnownActivityId: normalizedActivityId,
      lastKnownActivityLabel: await this.getActivityLabelForHub(normalizedHubIp, normalizedActivityId),
      lastActivitySyncAt: new Date(),
      lastActivitySyncStatus: 'success',
      lastActivitySyncError: ''
    }]);

    void eventStreamService.publishSafe({
      type: 'harmony.activity.start',
      source: 'harmony',
      category: 'integration',
      payload: {
        hubIp: normalizedHubIp,
        activityId: normalizedActivityId
      },
      tags: ['harmony', 'activity']
    });

    return {
      success: true,
      hubIp: normalizedHubIp,
      activityId: normalizedActivityId
    };
  }

  async turnOffHub(hubIp) {
    const normalizedHubIp = normalizeHost(hubIp);
    if (!normalizedHubIp) {
      throw new Error('Harmony hub is required');
    }

    await this.withClient(normalizedHubIp, (client) => client.turnOff());
    await this.updateHubActivityState(normalizedHubIp, '-1', true);
    await this.mergeKnownHubs([{
      ip: normalizedHubIp,
      discovered: true,
      lastSeenAt: new Date(),
      lastKnownActivityId: '-1',
      lastKnownActivityLabel: 'Off',
      lastActivitySyncAt: new Date(),
      lastActivitySyncStatus: 'success',
      lastActivitySyncError: ''
    }]);

    void eventStreamService.publishSafe({
      type: 'harmony.activity.stop',
      source: 'harmony',
      category: 'integration',
      payload: {
        hubIp: normalizedHubIp
      },
      tags: ['harmony', 'activity']
    });

    return {
      success: true,
      hubIp: normalizedHubIp,
      activityId: '-1'
    };
  }

  async sendPowerCommand(hubIp, deviceIdOrName, powerState, options = {}) {
    const normalizedHubIp = normalizeHost(hubIp);
    const normalizedDeviceKey = normalizeCommandName(deviceIdOrName);
    const desiredState = powerState === 'on' ? 'on' : 'off';
    const repeatCountRaw = Number(options.repeatCount || 1);
    const repeatCount = Number.isFinite(repeatCountRaw)
      ? Math.max(1, Math.min(4, Math.trunc(repeatCountRaw)))
      : 1;
    const allowToggleFallback = options.allowToggleFallback === true;

    if (!normalizedHubIp || !normalizedDeviceKey) {
      throw new Error('Harmony hub and device are required');
    }

    const result = await this.withClient(normalizedHubIp, async (client) => {
      const config = await client.getAvailableCommands();
      const devices = Array.isArray(config?.device) ? config.device : [];
      const targetDevice = this.findConfigDevice(devices, deviceIdOrName);

      if (!targetDevice) {
        throw new Error(`Harmony device "${deviceIdOrName}" was not found on hub ${normalizedHubIp}`);
      }

      const commands = this.extractDeviceCommands(targetDevice);
      const resolved = this.resolvePowerCommand(commands, desiredState, { allowToggleFallback });
      if (!resolved?.command?.action) {
        throw new Error(
          `No Harmony power-${desiredState} command was found on device ${targetDevice.label || targetDevice.id}`
        );
      }

      const sendCount = resolved.kind === 'toggle' ? 1 : repeatCount;
      for (let attempt = 0; attempt < sendCount; attempt += 1) {
        // Harmony expects a press/release pair for each invocation.
        // eslint-disable-next-line no-await-in-loop
        await client.send('holdAction', resolved.command.action, 0);
      }

      return {
        deviceId: targetDevice.id.toString(),
        deviceName: targetDevice.label || targetDevice.id.toString(),
        command: resolved.command.name,
        commandKind: resolved.kind,
        repeatCount: sendCount,
        desiredState
      };
    });

    void eventStreamService.publishSafe({
      type: 'harmony.command.send',
      source: 'harmony',
      category: 'integration',
      payload: {
        hubIp: normalizedHubIp,
        deviceId: result.deviceId,
        deviceName: result.deviceName,
        command: result.command,
        commandKind: result.commandKind,
        repeatCount: result.repeatCount,
        desiredState: result.desiredState
      },
      tags: ['harmony', 'command', 'power']
    });

    return {
      success: true,
      hubIp: normalizedHubIp,
      ...result
    };
  }

  async sendDeviceCommand(hubIp, deviceIdOrName, commandName, holdMs = 0) {
    const normalizedHubIp = normalizeHost(hubIp);
    const normalizedDeviceKey = normalizeCommandName(deviceIdOrName);
    const normalizedCommandKey = normalizeCommandName(commandName);

    if (!normalizedHubIp || !normalizedDeviceKey || !normalizedCommandKey) {
      throw new Error('Hub, device, and command are required');
    }

    const holdDuration = Math.max(0, Math.min(MAX_HOLD_COMMAND_MS, Number(holdMs) || 0));

    const result = await this.withClient(normalizedHubIp, async (client) => {
      const config = await client.getAvailableCommands();
      const devices = Array.isArray(config?.device) ? config.device : [];
      const targetDevice = this.findConfigDevice(devices, deviceIdOrName);

      if (!targetDevice) {
        throw new Error(`Harmony device "${deviceIdOrName}" was not found on hub ${normalizedHubIp}`);
      }

      const commands = this.extractDeviceCommands(targetDevice);
      const targetCommand = commands.find((command) => {
        const name = normalizeCommandName(command.name);
        const label = normalizeCommandName(command.label);
        return name === normalizedCommandKey || label === normalizedCommandKey;
      });

      if (!targetCommand || !targetCommand.action) {
        throw new Error(`Harmony command "${commandName}" was not found on device ${targetDevice.label || targetDevice.id}`);
      }

      await client.send('holdAction', targetCommand.action, holdDuration);

      return {
        deviceId: targetDevice.id.toString(),
        deviceName: targetDevice.label || targetDevice.id.toString(),
        command: targetCommand.name,
        holdMs: holdDuration
      };
    });

    void eventStreamService.publishSafe({
      type: 'harmony.command.send',
      source: 'harmony',
      category: 'integration',
      payload: {
        hubIp: normalizedHubIp,
        deviceId: result.deviceId,
        deviceName: result.deviceName,
        command: result.command,
        holdMs: result.holdMs
      },
      tags: ['harmony', 'command']
    });

    return {
      success: true,
      hubIp: normalizedHubIp,
      ...result
    };
  }
}

module.exports = new HarmonyService();
module.exports.HarmonyService = HarmonyService;

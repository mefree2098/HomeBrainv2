const { Explorer } = require('@harmonyhub/discover');
const { getHarmonyClient } = require('@harmonyhub/client-ws');
const Device = require('../models/Device');
const Settings = require('../models/Settings');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const eventStreamService = require('./eventStreamService');
const {
  buildHarmonyActivityIdentityQuery,
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

function normalizeCommandName(value) {
  return (value || '').toString().trim().toLowerCase();
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
        $match: {
          'properties.source': 'harmony',
          'properties.harmonyHubIp': { $in: normalizedIps }
        }
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
      'properties.source': 'harmony',
      'properties.harmonyHubIp': normalizedHubIp,
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
        harmonyHubIp: snapshot.ip,
        harmonyHubName: snapshot.friendlyName,
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
      'properties.source': 'harmony',
      'properties.harmonyHubIp': normalizedHubIp
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
          const snapshot = await this.getHubSnapshot(hub.ip, { includeCommands: false });
          const activityIds = [];

          for (const activity of snapshot.activities) {
            activityIds.push(activity.id.toString());
            const payload = this.buildHarmonyActivityDevice(snapshot, activity);
            const identityQuery = buildHarmonyActivityIdentityQuery(snapshot.ip, activity.id.toString());
            const matchingDevices = identityQuery
              ? await Device.find(identityQuery)
              : [];
            const existing = selectCanonicalDevice(matchingDevices);
            const duplicateDevices = matchingDevices.filter((candidate) => (
              String(candidate?._id || '') !== String(existing?._id || '')
            ));
            if (!existing) {
              await Device.create(payload);
              summary.created += 1;
            } else {
              mergeDuplicateDeviceGroups(existing, duplicateDevices);
              existing.name = payload.name;
              existing.type = payload.type;
              existing.room = payload.room;
              existing.status = payload.status;
              existing.properties = payload.properties;
              existing.brand = payload.brand;
              existing.model = payload.model;
              existing.isOnline = true;
              existing.lastSeen = new Date();
              await existing.save();

              const duplicateIds = duplicateDevices
                .map((candidate) => String(candidate?._id || ''))
                .filter(Boolean);
              if (duplicateIds.length > 0) {
                await Device.deleteMany({ _id: { $in: duplicateIds } });
                summary.deduped += duplicateIds.length;
                console.warn(
                  `HarmonyService: Removed ${duplicateIds.length} duplicate HomeBrain row(s) for hub ${snapshot.ip} activity ${activity.id}: ${describeDevices(duplicateDevices)}`
                );
              }

              summary.updated += 1;
            }
          }

          const staleResult = await Device.deleteMany({
            'properties.source': 'harmony',
            'properties.harmonyHubIp': snapshot.ip,
            'properties.harmonyActivityId': { $nin: activityIds }
          });
          summary.removed += staleResult.deletedCount || 0;

          summary.hubsSynced += 1;
          summary.details.push({
            hubIp: snapshot.ip,
            friendlyName: snapshot.friendlyName,
            activityCount: snapshot.activities.length,
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
    const devices = await Device.find({
      'properties.source': 'harmony',
      'properties.harmonyHubIp': normalizedHubIp
    });

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

      const targetDevice = devices.find((device) => {
        const id = normalizeCommandName(device?.id);
        const label = normalizeCommandName(device?.label);
        return id === normalizedDeviceKey || label === normalizedDeviceKey;
      });

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

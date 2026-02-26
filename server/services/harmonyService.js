const { Explorer } = require('@harmonyhub/discover');
const { getHarmonyClient } = require('@harmonyhub/client-ws');
const Device = require('../models/Device');
const Settings = require('../models/Settings');
const deviceUpdateEmitter = require('./deviceUpdateEmitter');
const eventStreamService = require('./eventStreamService');

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

class HarmonyService {
  constructor() {
    this.discoveryCache = [];
    this.discoveryCacheAt = 0;
    this.discoveryCacheMs = Number.isFinite(DEFAULT_DISCOVERY_CACHE_MS) ? DEFAULT_DISCOVERY_CACHE_MS : 15000;
    this.hubMetadata = new Map();
    this.syncPromise = null;
    this.stateSyncPromise = null;
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

  async getConfiguredHubAddresses() {
    const settings = await Settings.getSettings();
    const fromSettings = this.parseConfiguredHubAddresses(settings?.harmonyHubAddresses || '');
    const fromEnv = this.parseConfiguredHubAddresses(process.env.HARMONY_HUB_IPS || '');
    return toUniqueHostList([...fromSettings, ...fromEnv]);
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

    const configuredHosts = await this.getConfiguredHubAddresses();
    const hubMap = new Map();

    configuredHosts.forEach((host) => {
      hubMap.set(host, {
        ip: host,
        friendlyName: this.hubMetadata.get(host)?.friendlyName || '',
        discovered: false,
        source: 'configured',
        lastSeen: null
      });
    });

    const explorer = new Explorer(
      DEFAULT_DISCOVERY_INCOMING_PORT,
      {
        address: process.env.HARMONY_DISCOVERY_ADDRESS || '255.255.255.255',
        port: DEFAULT_DISCOVERY_TARGET_PORT,
        interval: DEFAULT_DISCOVERY_INTERVAL_MS
      }
    );

    const rememberHub = (hub) => {
      const ip = normalizeHost(hub?.ip);
      if (!ip) {
        return;
      }

      const existing = hubMap.get(ip) || {};
      const friendlyName = (hub?.friendlyName || existing.friendlyName || '').toString().trim();
      const lastSeen = hub?.lastSeen ? new Date(hub.lastSeen) : new Date();

      hubMap.set(ip, {
        ip,
        friendlyName,
        uuid: hub?.uuid || existing.uuid || null,
        remoteId: hub?.fullHubInfo?.remoteId || existing.remoteId || null,
        discovered: true,
        source: existing.source === 'configured' ? 'configured+discovered' : 'discovered',
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

    try {
      explorer.start();
      await sleep(Math.max(1500, timeoutMs));
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
    return discovered.map((hub) => ({ ...hub }));
  }

  async withClient(hubIp, operation) {
    const normalizedHubIp = normalizeHost(hubIp);
    if (!normalizedHubIp) {
      throw new Error('Harmony hub IP/host is required');
    }

    const metadata = this.hubMetadata.get(normalizedHubIp);
    const options = metadata?.remoteId ? { remoteId: metadata.remoteId } : {};
    const client = await getHarmonyClient(normalizedHubIp, options);

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
      const friendlyName = this.inferFriendlyName(normalizedHubIp, config);

      const metadata = this.hubMetadata.get(normalizedHubIp) || {};
      this.hubMetadata.set(normalizedHubIp, {
        ip: normalizedHubIp,
        friendlyName,
        remoteId: client.remoteId || metadata.remoteId || null,
        uuid: metadata.uuid || null,
        lastSeen: Date.now()
      });

      return {
        ip: normalizedHubIp,
        friendlyName,
        remoteId: client.remoteId || metadata.remoteId || null,
        currentActivityId: currentActivity,
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

    const candidates = discover
      ? await this.discoverHubs({ timeoutMs, force: false })
      : (await this.getConfiguredHubAddresses()).map((host) => ({ ip: host }));

    const hubs = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const snapshot = await this.getHubSnapshot(candidate.ip, { includeCommands });
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
            error: error.message
          };
        }
      })
    );

    return hubs.sort((left, right) => {
      const leftName = (left.friendlyName || left.ip || '').toString().toLowerCase();
      const rightName = (right.friendlyName || right.ip || '').toString().toLowerCase();
      return leftName.localeCompare(rightName);
    });
  }

  async getStatus(options = {}) {
    const timeoutMs = Number(options.timeoutMs || DEFAULT_DISCOVERY_TIMEOUT_MS);
    const [configuredHubAddresses, discoveredHubs, trackedDevices, onlineDevices] = await Promise.all([
      this.getConfiguredHubAddresses(),
      this.discoverHubs({ timeoutMs, force: false }),
      Device.countDocuments({ 'properties.source': 'harmony' }),
      Device.countDocuments({ 'properties.source': 'harmony', isOnline: true })
    ]);

    return {
      configuredHubAddresses,
      discoveredHubs,
      discoveredCount: discoveredHubs.length,
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

      const summary = {
        success: true,
        hubsFound: discovered.length,
        hubsSynced: 0,
        hubsFailed: 0,
        created: 0,
        updated: 0,
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
            const query = {
              'properties.source': 'harmony',
              'properties.harmonyHubIp': snapshot.ip,
              'properties.harmonyActivityId': activity.id.toString()
            };

            const existing = await Device.findOne(query);
            if (!existing) {
              await Device.create(payload);
              summary.created += 1;
            } else {
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
        }
      }

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
        const rawIps = await Device.distinct('properties.harmonyHubIp', {
          'properties.source': 'harmony'
        });
        hubIps = toUniqueHostList(rawIps);
      }

      const summary = {
        success: true,
        hubs: hubIps.length,
        refreshed: 0,
        failed: 0,
        details: []
      };

      for (const hubIp of hubIps) {
        try {
          const currentActivityId = await this.withClient(hubIp, (client) => client.getCurrentActivity());
          const stateResult = await this.updateHubActivityState(hubIp, currentActivityId, true);
          summary.refreshed += 1;
          summary.details.push({
            hubIp,
            currentActivityId: currentActivityId.toString(),
            updatedDevices: stateResult.updated,
            success: true
          });
        } catch (error) {
          summary.failed += 1;
          await this.markHubDevicesOffline(hubIp);
          summary.details.push({
            hubIp,
            success: false,
            error: error.message
          });
        }
      }

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
